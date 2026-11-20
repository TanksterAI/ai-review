// tankster-ai-review: a free pull-request reviewer (v1 secretless; v2 the GitHub App).
//
// POST /v1/review  (Authorization: Bearer <GitHub Actions OIDC token>)
//   body: {pr, head_sha, title, body, files: [{filename, status, patch, additions, deletions}], force?}
//   200 {status: "reviewed", review: {body, comments}, usage}
//   200 {status: "skipped", reason}               nothing reviewable
//   409 {status: "duplicate"}                     this head commit was already reviewed
//   429 {status: "deferred", reason, resets_at, chars}  every model provider (or
//                                                 every verifier) is out of quota or busy
//                                                 until resets_at
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
import { buildPrompt, classifyFindings, codeSpan, placeComments, prepareFiles, renderReview, titleLine } from "./review.js";
import { draftWithChain } from "./draft.js";
import { createLedger, createSerial, nextUtcMidnight, utcDay } from "./budget.js";
import { capacity, createProviders, draftChain, verifyOff } from "./providers.js";
import { groundFindings } from "./grounding.js";
import { applyVerdicts, verifyFindings } from "./verify.js";
import { config } from "./config.js";
import { DEFAULT_SLUG, normalise, prKey, verifySignature } from "./webhook.js";
import { objectOfJob } from "./pr-state.js";
import { createEffects } from "./effects.js";
import { handleMcp } from "./mcp.js";
import { appConfig, handleSetupCallback, handleSetupStart } from "./setup.js";

export { PrState } from "./pr-state.js";
export { placeComments, titleLine } from "./review.js";
export { draftWithChain, STEP_RESERVE } from "./draft.js";
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
  const started = now();
  // serial: this review's queue for ledger writes, shared by its drafting
  // and verifying providers and by no other review.
  const deps = { now, sleep, fetch: fetchImpl ?? ((...a) => fetch(...a)), log, serial: createSerial() };
  // Providers that failed this review outright before are not asked again.
  const skipped = new Set(skip);
  const chain = draftChain(env, cfg).filter((x) => !skipped.has(`${x.kind}:${x.model}`));
  // The drafter the capacity check plans for goes first: the first free one,
  // unless it is the only free verifier and another drafter is free (no
  // model checks its own findings). The same rule decides the dispatch.
  if (!verifyOff(env)) {
    const plan = await capacity(env, cfg, chain, deps, chars);
    const at = plan.ok && plan.provider ? chain.findIndex((x) => `${x.kind}:${x.model}` === plan.provider) : -1;
    if (at > 0) chain.unshift(...chain.splice(at, 1));
  }
  const providers = createProviders(env, cfg, chain, deps);

  const drafted = await draftWithChain({ providers, instructions, modelInput, chars, cfg, deps, started, repository, pr });
  if (drafted.late) return res(503, { status: "unavailable", reason: "the review ran out of time before a model answered" });
  const { answer, used, neurons, usd, last, outcomes, timedOut } = drafted;

  if (!answer && timedOut) {
    // Queued and tried again shortly, like a busy provider.
    log({ ev: "draft_out_of_time", repository, pr, passed_over: outcomes.length });
    return res(503, { status: "unavailable", reason: "the review ran out of time before a model answered" });
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

  // Every finding passes the grounding gate, then an independent verifier,
  // before anything is shown (TAN-299). The drafter's spend has happened
  // either way.
  const classified = classifyFindings(answer, prepared.commentable, prepared.lineText);
  const grounded = groundFindings(classified, prepared, { title: input.title, body: input.body });
  const verified = await verifyFindings({ classified: grounded.classified, prepared, title: input.title, body: input.body, drafter: used, env, cfg, deps, started });
  if (verified.outcome.kind !== "ok") {
    // Never posted unverified: the review waits for a verifier, like a
    // drafting deferral (429), or is tried again shortly (503) or later (502).
    const o = verified.outcome;
    log({ ev: "verify_stopped", repository, pr, kind: o.kind, findings: grounded.classified.inline.length + grounded.classified.general.length });
    if (o.kind === "deferred") return res(429, { status: "deferred", reason: o.reason, resets_at: new Date(o.resetAt).toISOString(), chars, failed: [] });
    if (o.kind === "unavailable") return res(503, { status: "unavailable", reason: o.reason });
    return res(502, { status: "failed", reason: o.reason });
  }
  // Confirmed findings are shown, with only the suggestions and prompts the
  // verifiers passed; the rest are hidden. Every reason is the Worker's own.
  const { shown, hidden } = applyVerdicts(grounded.classified, grounded.dropped, verified.verdicts);

  // The cost line: drafting, then verification.
  const neuronsLeft = Math.max(0, cfg.cap - Math.max(last.spent ?? 0, verified.spentNeurons ?? 0));
  const usdSpent = Math.max(last.spentUsd ?? 0, verified.spentUsd ?? 0);
  const usdCap = last.capUsd ?? verified.capUsd ?? 0;
  let cost = used.kind === "workers-ai"
    ? `- Cost: ${neurons.toFixed(0)} neurons; ${neuronsLeft.toFixed(0)} of today's ${cfg.cap} left for reviews.`
    : used.kind === "anthropic"
      ? `- Cost: $${usd.toFixed(4)} of the plan's API credit; $${Math.max(0, usdCap - usdSpent).toFixed(2)} of today's $${usdCap.toFixed(2)} left.`
      : "- Cost: nothing (free tier).";
  if (!verified.off) {
    const parts = [];
    if (verified.neurons > 0) parts.push(`${verified.neurons.toFixed(0)} neurons`);
    if (verified.usd > 0) parts.push(`$${verified.usd.toFixed(4)} of the plan's API credit`);
    // Calls still running at the deadline are not counted here.
    cost += ` Verification: ${verified.late ? "at least " : ""}${parts.length ? parts.join(" and ") : "nothing (free tier)"}`;
    if (verified.usd > 0 && used.kind !== "anthropic" && verified.capUsd) cost += `; $${Math.max(0, verified.capUsd - (verified.spentUsd ?? 0)).toFixed(2)} of today's $${verified.capUsd.toFixed(2)} left`;
    cost += ".";
  }
  const review = renderReview({
    answer, classified: shown, hidden, prepared,
    verification: { off: verified.off, weak: verified.weak, fallback: verified.fallback, fallbackBy: verified.fallbackBy, selfExcluded: verified.selfExcluded },
    meta: { model: used.model, modelLine: `- Model: ${used.label}`, costLine: cost, again, headSha, profile: cfg.profile, advisory: true },
  });
  await env.LEDGER.put(doneKey, utcDay(now()), { expirationTtl: 30 * 24 * 3600 });
  log({
    ev: "reviewed",
    repository,
    pr,
    provider: used.id,
    files: prepared.included.length,
    omitted: prepared.omitted.length,
    inline: shown.inline.length,
    general: shown.general.length,
    hidden: hidden.length,
    dropped: grounded.dropped.length,
    stripped: grounded.stripped.length,
    verify_calls: verified.calls,
    neurons: Math.round(neurons + verified.neurons),
    usd: Number((usd + verified.usd).toFixed(5)),
    passed_over: outcomes.length,
    ms: now() - started,
  });
  const usage = used.kind === "workers-ai"
    ? { provider: used.kind, model: used.model, neurons, spent_today: last.spent, cap: cfg.cap }
    : { provider: used.kind, model: used.model, usd };
  if (!verified.off) usage.verification = { calls: verified.calls, neurons: verified.neurons, usd: verified.usd };
  return res(200, { status: "reviewed", review, usage });
}


// ---------------------------------------------------------------------------
// v2: the Tankster AI Review GitHub App.

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

function prStub(env, key) {
  return env.PR_STATE.get(env.PR_STATE.idFromName(key));
}

async function ask(stub, msg) {
  const res = await stub.fetch("https://pr-state/", { method: "POST", body: JSON.stringify(msg) });
  return res.json();
}

async function askPr(env, key, msg) {
  return ask(prStub(env, key), msg);
}

// The PR object a runner's job id names, or null. The id says which object,
// not which PR: Cloudflare refuses ids it did not mint for this namespace.
function jobStub(env, jobId) {
  const oid = objectOfJob(jobId);
  if (!oid) return null;
  try {
    return env.PR_STATE.get(env.PR_STATE.idFromString(oid));
  } catch {
    return null;
  }
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
  // Only the App's own dispatch starts a job run.
  const stub = claims.run_id && claims.event_name === "workflow_dispatch" && typeof body?.job === "string" ? jobStub(env, body.job) : null;
  if (!stub) return json(403, { status: "refused", reason: "no such job" });
  const out = await ask(stub, { op: "claim", jobId: body.job, runId: String(claims.run_id) });
  if (!out.job) return json(403, { status: "refused", reason: out.error ?? "no such job" });
  return { claims, body, job: out.job, stub };
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
  const { body, job, stub, claims } = r;
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
  const finish = () => ask(stub, { op: "complete", jobId: job.id, runId: String(claims.run_id), reviewedSha: headSha });

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
    // Runner mode stays advisory (a COMMENT review every time): it has no
    // summary comment, no thread checks and no approvals, which only the
    // Worker's own review (review-run.js) does.
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
    await ask(stub, { op: "defer", jobId: job.id, runId: String(claims.run_id), retryAt, why, chars: out.body.chars, reason: out.body.reason, failed: out.body.failed });
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
    if (url.pathname === "/mcp") {
      const app = await appConfig(env);
      return handleMcp(request, env, { fetch: (...a) => fetch(...a), slug: app?.slug, ask: (repo, pr, msg) => askPr(env, prKey(repo, pr), msg) });
    }
    if (url.pathname === "/v1/runner/session" && request.method === "POST") return handleRunnerSession(request, env);
    if (url.pathname === "/v1/runner/review" && request.method === "POST") return handleRunnerReview(request, env);
    if (url.pathname === "/v1/review") {
      if (request.method !== "POST") return json(405, { status: "rejected", reason: "POST only" });
      return handleReview(request, env);
    }
    return json(404, { status: "not_found" });
  },
};
