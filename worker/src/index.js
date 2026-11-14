// tankster-ai-review: a free pull-request reviewer (v1 secretless; v2 the GitHub App).
//
// POST /v1/review  (Authorization: Bearer <GitHub Actions OIDC token>)
//   body: {pr, head_sha, title, body, files: [{filename, status, patch, additions, deletions}], force?}
//   200 {status: "reviewed", review: {body, comments}, usage}
//   200 {status: "skipped", reason}               nothing reviewable
//   409 {status: "duplicate"}                     this head commit was already reviewed
//   429 {status: "deferred", reason, resets_at, chars}  every model provider is out
//                                                 of quota or busy until resets_at
//   503 {status: "unavailable", reason}           a provider is busy, with no time given
//   401 / 400 / 413 / 502                         see `reason`
// GET /healthz  -> {ok, model, budget, providers}
//
// v1: the reviewing workflow (TanksterAI/ai-review .github/workflows/review.yml)
// fetches the diff with its own GITHUB_TOKEN and posts the review.
//
// v2 (the Tankster AI Review GitHub App):
//   POST /v1/github/webhook  GitHub's HMAC-signed deliveries -> the PR's Durable Object
//   POST /v1/runner/session  runner.yml (OIDC) claims its job -> read-only token for one repo
//   POST /v1/runner/review   runner.yml (OIDC) sends the diff -> the Worker reviews and posts
//   GET  /v1/setup/github-app[/callback]  one-time App creation from a manifest
// The App's private key and webhook secret come from the manifest flow and
// live in the AppSecrets Durable Object (or Worker secrets, if set); no token
// with more than read access ever leaves the Worker.

import { createJwksCache, verifyGithubOidc, OidcError } from "./oidc.js";
import { buildPrompt, classifyFindings, codeSpan, parseAnswer, prepareFiles, renderReview } from "./review.js";
import { createLedger, nextUtcMidnight, utcDay } from "./budget.js";
import { ProviderError, createProviders, draftChain } from "./providers.js";
import { config } from "./config.js";
import { DEFAULT_SLUG, normalise, prKey, verifySignature } from "./webhook.js";
import { prKeyOfJob } from "./pr-state.js";
import { createEffects } from "./effects.js";
import { appConfig, handleSetupCallback, handleSetupStart } from "./setup.js";

export { PrState } from "./pr-state.js";
export { AppSecrets } from "./setup.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3000;
const jwks = createJwksCache();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function log(event) {
  // Ids, counts and timings only: never diff text, titles or model output.
  console.log(JSON.stringify({ svc: "ai-review", ...event }));
}

function randomTag() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Verifies the GitHub Actions OIDC token on a request against the allowed
// workflow refs, and spends its jti. Returns the claims, or a 401 Response.
export async function authenticate(request, env, workflowRefs, deps = {}) {
  const cfg = config(env);
  const now = deps.now ?? (() => Date.now());
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  let claims;
  try {
    claims = await verifyGithubOidc(token, {
      audience: cfg.audience,
      ownerId: cfg.ownerId,
      workflowRefs,
      jwks: deps.jwks ?? jwks,
      nowS: Math.floor(now() / 1000),
    });
  } catch (e) {
    const reason = e instanceof OidcError ? e.reason : "verification failed";
    log({ ev: "auth_failed", reason });
    return json(401, { status: "unauthorized", reason });
  }
  // Each token is good for one request: a token copied out of a job log or a
  // runner cannot be replayed. KV is eventually consistent, so this stops
  // replays after the first second or so, not a simultaneous one; the daily
  // cap bounds what any replay can cost. KV's shortest TTL is 60 s.
  if (typeof claims.jti !== "string" || !claims.jti) {
    log({ ev: "auth_failed", reason: "no jti" });
    return json(401, { status: "unauthorized", reason: "token has no jti" });
  }
  const jtiKey = `jti:${claims.jti}`;
  if (await env.LEDGER.get(jtiKey)) {
    log({ ev: "auth_failed", reason: "token reused" });
    return json(401, { status: "unauthorized", reason: "token already used" });
  }
  const ttl = Math.max(60, Math.ceil(claims.exp - now() / 1000) + 120);
  await env.LEDGER.put(jtiKey, "1", { expirationTtl: ttl });
  return claims;
}

export async function handleReview(request, env, deps = {}) {
  const cfg = config(env);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const auth = await authenticate(request, env, cfg.workflowRefs, { ...deps, now });
  if (auth instanceof Response) return auth;
  const repository = auth.repository;

  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) return json(413, { status: "rejected", reason: "request too large" });
  let input;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { status: "rejected", reason: "request too large" });
    input = JSON.parse(text);
  } catch {
    return json(400, { status: "rejected", reason: "body is not JSON" });
  }
  const pr = Number(input?.pr);
  const headSha = String(input?.head_sha ?? "");
  if (!Number.isInteger(pr) || pr <= 0) return json(400, { status: "rejected", reason: "pr must be a positive integer" });
  if (!/^[0-9a-f]{40}$/.test(headSha)) return json(400, { status: "rejected", reason: "head_sha must be a 40-character commit id" });
  if (!Array.isArray(input.files) || input.files.length > MAX_FILES) {
    return json(400, { status: "rejected", reason: `files must be an array of at most ${MAX_FILES}` });
  }

  const out = await runReview({ cfg, env, repository, pr, headSha, input, now, sleep, fetchImpl: deps.fetch });
  return json(out.status, out.body);
}

// A comment's first line (its labels and title), for lists where the whole
// comment would not read well: suggestion and prompt blocks do not flatten.
export function titleLine(body) {
  return String(body).split("\n")[0].slice(0, 300);
}

/**
 * For an incremental review: which comments still fit the PR's own diff
 * (lines: path -> Set of RIGHT-side lines). A suggestion's range must be there
 * whole; when only its first lines left the diff, the comment stays on its
 * own line with the body renderReview made without the suggestion (never
 * edited here: a multi-line replacement must not reach a one-line comment).
 * Anything else goes in the body.
 */
export function placeComments(comments, singleLine, lines) {
  const inDiff = (c, n) => lines.get(c.path)?.has(n) === true;
  const kept = [];
  const off = [];
  for (const [i, c] of comments.entries()) {
    if (!inDiff(c, c.line)) { off.push(c); continue; }
    let whole = true;
    for (let n = c.start_line ?? c.line; n <= c.line; n++) if (!inDiff(c, n)) whole = false;
    if (whole) { kept.push(c); continue; }
    const single = singleLine?.[i];
    if (typeof single !== "string") { off.push(c); continue; }
    const { start_line: _s, start_side: _side, ...rest } = c;
    kept.push({ ...rest, body: `${single}\n\n_The suggestion was left out: some of the lines it replaces are no longer in this pull request's diff._` });
  }
  return { kept, off };
}

// The review itself, shared by the v1 endpoint (/v1/review) and the App's
// runner endpoint. Returns {status, body}; callers turn it into a Response.
// again: the review's "Review again" line, set by the Worker (never taken from
// a request body); without it the v1 line is used.
export async function runReview({ cfg, env, repository, pr, headSha, input, now, sleep, again, fetchImpl, skip = [] }) {
  const res = (status, body) => ({ status, body });
  const doneKey = `done:${repository}#${pr}@${headSha}`;
  if (!input.force && (await env.LEDGER.get(doneKey))) {
    return res(409, { status: "duplicate", reason: "this commit was already reviewed; pass force to review it again" });
  }

  const prepared = prepareFiles(input.files, { maxChars: cfg.maxChars });
  if (prepared.included.length === 0) {
    log({ ev: "skipped", repository, pr, omitted: prepared.omitted.length });
    return res(200, { status: "skipped", reason: "no reviewable text changes", omitted: prepared.omitted });
  }

  const { instructions, input: modelInput } = buildPrompt({
    repository,
    title: input.title,
    body: input.body,
    prepared,
    tag: randomTag(),
  });
  const chars = instructions.length + modelInput.length;
  const deps = { now, sleep, fetch: fetchImpl ?? ((...a) => fetch(...a)), log };
  // Providers that failed this review outright before are not asked again.
  const skipped = new Set(skip);
  const providers = createProviders(env, cfg, draftChain(env, cfg).filter((x) => !skipped.has(`${x.kind}:${x.model}`)), deps);

  // Each provider in turn, until one answers: one that is out of quota,
  // busy, or failing hands over to the next. On one provider, up to two calls:
  //   - an answer cut short (reasoning used the room): once more, with low
  //     reasoning effort, if the budget allows;
  //   - an answer that tried to be JSON but does not parse (escaping code in
  //     a suggestion is where models slip): once more, if the budget allows.
  //   Either retry asks for no suggestions, which makes the answer shorter
  //   and its JSON simpler.
  const started = now();
  const outcomes = [];
  let answer = null;
  let used = null;
  let neurons = 0;
  let usd = 0;
  let last = {};
  for (const p of providers) {
    if (!p.configured) continue;
    const until = await p.exhausted();
    if (until) { outcomes.push({ id: p.id, kind: "deferred", reason: `${p.id} is out of quota`, resetAt: until }); continue; }
    const first = await p.affordable(chars, cfg.maxOutput);
    if (!first.ok) {
      log({ ev: "deferred", repository, pr, provider: p.id, spent: first.spent, estimate: first.estimate });
      // No reset time means it can never take this review (too long for it).
      outcomes.push(first.resetAt === null
        ? { id: p.id, kind: "failed", reason: first.reason }
        : { id: p.id, kind: "deferred", reason: first.reason, resetAt: first.resetAt ?? nextUtcMidnight(now()) });
      continue;
    }
    let note = "";
    let low = false;
    let lastStatus = null;
    for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
      let r;
      try {
        r = await p.complete({ system: instructions + note, user: modelInput, maxOutput: cfg.maxOutput, low });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        outcomes.push({ id: p.id, kind: e.kind, reason: e.reason, resetAt: e.resetAt });
        lastStatus = "error";
        break;
      }
      neurons += r.neurons ?? 0;
      usd += r.usd ?? 0;
      last = r;
      answer = parseAnswer(r.text);
      if (answer) { used = p; break; }
      lastStatus = r.incomplete ? "incomplete" : "unparseable";
      log({ ev: "unparseable", repository, pr, provider: p.id, attempt, incomplete: r.incomplete });
      if ((!r.incomplete && !r.text.includes("{")) || !(await p.affordable(chars, cfg.maxOutput)).ok) break;
      if (r.incomplete) low = true;
      note = "\nYour previous answer could not be used. Answer again, shorter, and leave out every \"suggestion\" key.";
    }
    if (answer) break;
    if (lastStatus === "incomplete") outcomes.push({ id: p.id, kind: "failed", reason: "the model ran out of output room before it answered; try again, or review a smaller change" });
    else if (lastStatus === "unparseable") outcomes.push({ id: p.id, kind: "failed", reason: "the model did not return a usable answer; try again later" });
  }

  if (!answer) {
    // Any provider out of quota, or busy until a known time: wait for the
    // first of those to come back (the review is queued, not dropped), even
    // if another provider failed outright. Otherwise the most hopeful
    // failure: busy beats broken.
    const waiting = outcomes.filter((o) => o.kind === "deferred" || (o.kind === "unavailable" && o.resetAt));
    if (waiting.length) {
      const first = waiting.reduce((a, o) => ((o.resetAt ?? Infinity) < (a.resetAt ?? Infinity) ? o : a));
      const at = first.resetAt ?? nextUtcMidnight(now());
      const failedIds = outcomes.filter((o) => o.kind === "failed").map((o) => o.id);
      return res(429, { status: "deferred", reason: first.reason, resets_at: new Date(at).toISOString(), chars, failed: failedIds });
    }
    const busy = outcomes.find((o) => o.kind === "unavailable");
    if (busy) return res(503, { status: "unavailable", reason: busy.reason });
    const failed = [...outcomes].reverse().find((o) => o.kind === "failed");
    const none = skipped.size ? "every model provider failed on this review" : "no model provider is configured";
    return res(502, { status: "failed", reason: failed?.reason ?? none });
  }

  const cost = used.kind === "workers-ai"
    ? `- Cost: ${neurons.toFixed(0)} neurons; ${Math.max(0, cfg.cap - (last.spent ?? 0)).toFixed(0)} of today's ${cfg.cap} left for reviews.`
    : used.kind === "anthropic"
      ? `- Cost: $${usd.toFixed(4)} of the plan's API credit; $${Math.max(0, (last.capUsd ?? 0) - (last.spentUsd ?? 0)).toFixed(2)} of today's $${(last.capUsd ?? 0).toFixed(2)} left.`
      : "- Cost: nothing (free tier).";
  const classified = classifyFindings(answer, prepared.commentable, prepared.lineText);
  const review = renderReview({ answer, classified, prepared, meta: { model: used.model, modelLine: `- Model: ${used.label}`, costLine: cost, again, headSha } });
  await env.LEDGER.put(doneKey, utcDay(now()), { expirationTtl: 30 * 24 * 3600 });
  log({
    ev: "reviewed",
    repository,
    pr,
    provider: used.id,
    files: prepared.included.length,
    omitted: prepared.omitted.length,
    inline: classified.inline.length,
    general: classified.general.length,
    neurons: Math.round(neurons),
    usd: Number(usd.toFixed(5)),
    passed_over: outcomes.length,
    ms: now() - started,
  });
  const usage = used.kind === "workers-ai"
    ? { provider: used.kind, model: used.model, neurons, spent_today: last.spent, cap: cfg.cap }
    : { provider: used.kind, model: used.model, usd };
  return res(200, { status: "reviewed", review, usage });
}


// ---------------------------------------------------------------------------
// v2: the Tankster AI Review GitHub App.

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

function prStub(env, key) {
  return env.PR_STATE.get(env.PR_STATE.idFromName(key));
}

async function askPr(env, key, msg) {
  const res = await prStub(env, key).fetch("https://pr-state/", { method: "POST", body: JSON.stringify(msg) });
  return res.json();
}

// POST /v1/github/webhook: verify, describe, hand to the PR's Durable Object,
// acknowledge. All work happens later, in the object's alarm.
export async function handleWebhook(request, env) {
  const app = await appConfig(env);
  if (!app?.webhookSecret) return json(503, { status: "unavailable", reason: "the GitHub App is not set up yet" });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_WEBHOOK_BYTES) return json(413, { status: "rejected", reason: "payload too large" });
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_WEBHOOK_BYTES) return json(413, { status: "rejected", reason: "payload too large" });
  if (!(await verifySignature(app.webhookSecret, raw, request.headers.get("x-hub-signature-256")))) {
    log({ ev: "webhook_bad_signature" });
    return json(401, { status: "unauthorized", reason: "bad signature" });
  }
  const event = request.headers.get("x-github-event") || "";
  const delivery = request.headers.get("x-github-delivery") || "";
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { status: "rejected", reason: "body is not JSON" });
  }
  const ev = normalise(event, payload, { ownerId: env.OWNER_ID, slug: app.slug });
  if (!ev) return json(202, { status: "ignored" });
  const out = await askPr(env, prKey(ev.repo.full, ev.pr), { op: "event", delivery, ev });
  log({ ev: "webhook", event, kind: ev.kind, repository: ev.repo.full, pr: ev.pr, action: out.action });
  return json(202, { status: "accepted", action: out.action });
}

function runnerRefs(env) {
  return String(env.RUNNER_REFS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

// The runner's job: claimed by (or already claimed by) this workflow run.
async function runnerJob(request, env, deps) {
  const claims = await authenticate(request, env, runnerRefs(env), deps);
  if (claims instanceof Response) return claims;
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { status: "rejected", reason: "request too large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { status: "rejected", reason: "body is not JSON" });
  }
  const key = prKeyOfJob(body?.job);
  // Only the App's own dispatch starts a job run.
  if (!key || !claims.run_id || claims.event_name !== "workflow_dispatch") return json(403, { status: "refused", reason: "no such job" });
  const out = await askPr(env, key, { op: "claim", jobId: body.job, runId: String(claims.run_id) });
  if (!out.job) return json(403, { status: "refused", reason: out.error ?? "no such job" });
  return { claims, body, job: out.job, key };
}

// POST /v1/runner/session -> {job, token}: the job and a read-only token for
// the job's one repository.
export async function handleRunnerSession(request, env, deps = {}) {
  const r = await runnerJob(request, env, deps);
  if (r instanceof Response) return r;
  const fx = deps.effects ?? createEffects(env, { config: await appConfig(env) });
  const token = await fx.cloneToken(r.job.repo.full);
  log({ ev: "runner_session", repository: r.job.repo.full, pr: r.job.pr, run: r.claims.run_id });
  return json(200, { job: { repo: r.job.repo, pr: r.job.pr, since: r.job.since, scope: r.job.scope }, token });
}

// POST /v1/runner/review: the runner's diff in, the review posted by the App.
export async function handleRunnerReview(request, env, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  const r = await runnerJob(request, env, deps);
  if (r instanceof Response) return r;
  const { body, job, key, claims } = r;
  const headSha = String(body.head_sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(headSha)) return json(400, { status: "rejected", reason: "head_sha must be a 40-character commit id" });
  if (!Array.isArray(body.files) || body.files.length > MAX_FILES) {
    return json(400, { status: "rejected", reason: `files must be an array of at most ${MAX_FILES}` });
  }
  // Incremental only against the commit the Worker itself recorded.
  const since = job.since && body.since === job.since ? job.since : null;
  // A re-run of the runner (say, after the review failed to post) reviews again.
  const force = Boolean(job.requestedBy) || Number(claims.run_attempt) > 1;
  const slug = (await appConfig(env))?.slug ?? DEFAULT_SLUG;
  const again = `- Review again: comment \`@${slug} review\` for the commits since this review, or \`@${slug} full review\`. Pushes to this repository's branches by people with write access are also reviewed a few minutes after the last one, unless reviews are paused.`;
  const input = { title: body.title, body: body.body, files: body.files, force };
  const out = await runReview({ cfg: config(env), env, repository: job.repo.full, pr: job.pr, headSha, input, now, sleep, again, fetchImpl: deps.fetch, skip: Array.isArray(job.skip) ? job.skip : [] });
  const finish = () => askPr(env, key, { op: "complete", jobId: job.id, runId: String(claims.run_id), reviewedSha: headSha });

  if (out.status === 200 && out.body.status === "reviewed") {
    const fx = deps.effects ?? createEffects(env, { config: await appConfig(env) });
    const review = out.body.review;
    let { body: text, comments } = review;
    if (since) {
      // Inline comments may only sit on lines of the PR's own diff; findings on
      // lines a later commit undid go in the body instead.
      const lines = await fx.prLines(job.repo.full, job.pr, comments.map((c) => c.path));
      const { kept, off } = placeComments(comments, review.singleLine, lines);
      comments = kept;
      if (off.length) {
        // The path is the PR author's: through codeSpan, like every path shown.
        text += `\n\n#### Also noted (on lines no longer in this pull request's diff)\n\n${off.map((c) => `- \`${codeSpan(c.path)}:${c.line}\`: ${titleLine(c.body)}`).join("\n")}`;
      }
      text += `\n\n_Incremental review: commits after \`${since.slice(0, 7)}\`._`;
    }
    // If posting throws, the job is left open: a re-run of the runner (same
    // run id, next attempt) reviews again and posts.
    const posted = await fx.postReview(job.repo.full, job.pr, { commitId: headSha, body: text, comments });
    await finish();
    return json(200, { status: "reviewed", inline: posted.inline, usage: out.body.usage });
  }
  if (out.status === 409 || (out.status === 200 && out.body.status === "skipped")) await finish();
  if (out.status === 429 || out.status === 503 || out.status === 502) {
    // Queued, not dropped: the PR's object releases the job and dispatches it
    // again once a provider resets (429), shortly (503), or a little later
    // (502: a few tries only, so a review that always fails cannot loop).
    const at = Date.parse(out.body.resets_at);
    const retryAt = out.status === 429 ? (Number.isFinite(at) ? at : now() + 3600_000) : now() + (out.status === 503 ? 5 : 15) * 60_000;
    const why = out.status === 429 ? "quota" : out.status === 503 ? "busy" : "failed";
    await askPr(env, key, { op: "defer", jobId: job.id, runId: String(claims.run_id), retryAt, why, chars: out.body.chars, reason: out.body.reason, failed: out.body.failed });
  }
  return json(out.status, out.body);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      const cfg = config(env);
      const now = () => Date.now();
      const spent = await createLedger(env.LEDGER).spent();
      // Which providers are set up and which are out of quota; never a key.
      const providers = [];
      for (const p of createProviders(env, cfg, draftChain(env, cfg), { now, sleep: async () => {}, fetch: () => Promise.reject(new Error("no calls")), log })) {
        const until = p.configured ? await p.exhausted() : null;
        providers.push({ id: p.id, configured: p.configured, exhausted_until: until ? new Date(until).toISOString() : null });
      }
      const lead = draftChain(env, cfg).find((x) => providers.find((p) => p.id === `${x.kind}:${x.model}`)?.configured);
      return json(200, { ok: true, model: lead?.model ?? cfg.model, budget: { day: utcDay(), cap: cfg.cap, spent: Math.round(spent) }, providers });
    }
    if (url.pathname === "/v1/github/webhook" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/v1/setup/github-app" && request.method === "GET") return handleSetupStart(request, env);
    if (url.pathname === "/v1/setup/github-app/callback" && request.method === "GET") return handleSetupCallback(request, env);
    if (url.pathname === "/v1/runner/session" && request.method === "POST") return handleRunnerSession(request, env);
    if (url.pathname === "/v1/runner/review" && request.method === "POST") return handleRunnerReview(request, env);
    if (url.pathname === "/v1/review") {
      if (request.method !== "POST") return json(405, { status: "rejected", reason: "POST only" });
      return handleReview(request, env);
    }
    return json(404, { status: "not_found" });
  },
};
