// tankster-ai-review: a free pull-request reviewer (v1 secretless; v2 the GitHub App).
//
// POST /v1/review  (Authorization: Bearer <GitHub Actions OIDC token>)
//   body: {pr, head_sha, title, body, files: [{filename, status, patch, additions, deletions}], force?}
//   200 {status: "reviewed", review: {body, comments}, usage}
//   200 {status: "skipped", reason}               nothing reviewable
//   409 {status: "duplicate"}                     this head commit was already reviewed
//   429 {status: "deferred", reason, resets_at}   today's review budget is spent
//   503 {status: "unavailable", reason}           Workers AI is out of capacity
//   401 / 400 / 413 / 502                         see `reason`
// GET /healthz  -> {ok, model, budget}
//
// v1: the reviewing workflow (TanksterAI/ai-review .github/workflows/review.yml)
// fetches the diff with its own GITHUB_TOKEN and posts the review.
//
// v2 (the Tankster AI Review GitHub App):
//   POST /v1/github/webhook  GitHub's HMAC-signed deliveries -> the PR's Durable Object
//   POST /v1/runner/session  runner.yml (OIDC) claims its job -> read-only token for one repo
//   POST /v1/runner/review   runner.yml (OIDC) sends the diff -> the Worker reviews and posts
// The App's private key and webhook secret are Worker secrets; no token with
// more than read access ever leaves the Worker.

import { createJwksCache, verifyGithubOidc, OidcError } from "./oidc.js";
import { buildPrompt, classifyFindings, extractText, parseAnswer, prepareFiles, renderReview } from "./review.js";
import { createLedger, estimateNeurons, neuronsFor, utcDay } from "./budget.js";
import { normalise, prKey, verifySignature } from "./webhook.js";
import { prKeyOfJob } from "./pr-state.js";
import { createEffects } from "./effects.js";

export { PrState } from "./pr-state.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3000;
const CAPACITY_RETRY_MS = 3000;
const jwks = createJwksCache();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function config(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    model: env.MODEL || "@cf/openai/gpt-oss-120b",
    effort: ["low", "medium", "high"].includes(env.REASONING_EFFORT) ? env.REASONING_EFFORT : "medium",
    cap: num(env.DAILY_NEURON_CAP, 6000),
    maxChars: num(env.MAX_DIFF_CHARS, 90_000),
    maxOutput: num(env.MAX_OUTPUT_TOKENS, 12_000),
    audience: env.AUDIENCE,
    ownerId: env.OWNER_ID,
    // Comma-separated job_workflow_ref values; an entry ending in * is a prefix.
    workflowRefs: String(env.WORKFLOW_REFS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  };
}

function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
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

  const out = await runReview({ cfg, env, repository, pr, headSha, input, now, sleep });
  return json(out.status, out.body);
}

// The review itself, shared by the v1 endpoint (/v1/review) and the App's
// runner endpoint. Returns {status, body}; callers turn it into a Response.
export async function runReview({ cfg, env, repository, pr, headSha, input, now, sleep }) {
  const res = (status, body) => ({ status, body });
  const ledger = createLedger(env.LEDGER, now);
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
  // The reserve is the whole output allowance: reasoning counts as output.
  const estimate = estimateNeurons(cfg.model, instructions.length + modelInput.length, cfg.maxOutput);
  const spentBefore = await ledger.spent();
  if (spentBefore + estimate > cfg.cap) {
    log({ ev: "deferred", repository, pr, spent: Math.round(spentBefore), estimate: Math.round(estimate) });
    return res(429, {
      status: "deferred",
      reason: `today's review budget is spent (${Math.round(spentBefore)} of ${cfg.cap} neurons; this review needs about ${Math.round(estimate)})`,
      resets_at: nextUtcMidnight(now()),
    });
  }

  const started = now();
  // Up to two model calls:
  //   - out of capacity (3040): try once more after a 3 s pause;
  //   - an answer cut short (status "incomplete", reasoning used the room):
  //     try once more with low reasoning effort, if the budget allows.
  // The account's daily allocation used up (3036) is a deferral, like our cap.
  let effort = cfg.effort;
  let neurons = 0;
  let spent = spentBefore;
  let answer = null;
  let lastStatus;
  for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
    let result;
    try {
      result = await env.AI.run(cfg.model, {
        instructions,
        input: modelInput,
        reasoning: { effort },
        max_output_tokens: cfg.maxOutput,
      });
    } catch (e) {
      const message = String(e?.message ?? e);
      log({ ev: "model_error", repository, pr, attempt, error: message.slice(0, 200) });
      if (/\b3036\b|daily free allocation/i.test(message)) {
        return res(429, {
          status: "deferred",
          reason: "the account's free Workers AI allocation for today is used up",
          resets_at: nextUtcMidnight(now()),
        });
      }
      if (/\b3040\b|capacity temporarily exceeded/i.test(message)) {
        if (attempt < 2) {
          // A pause, not CPU: waiting on a timer costs nothing on Workers.
          await sleep(CAPACITY_RETRY_MS);
          continue;
        }
        return res(503, { status: "unavailable", reason: "Workers AI is out of capacity; try again later" });
      }
      return res(502, { status: "failed", reason: "the model call failed; try again later" });
    }
    const usage = result?.usage ?? {};
    const used = Number.isFinite(usage.neurons)
      ? usage.neurons
      : neuronsFor(cfg.model, usage.input_tokens ?? usage.prompt_tokens ?? 0, usage.output_tokens ?? usage.completion_tokens ?? 0);
    neurons += used;
    spent = await ledger.add(used);
    lastStatus = result?.status;
    answer = parseAnswer(extractText(result));
    if (!answer) {
      log({ ev: "unparseable", repository, pr, attempt, neurons: Math.round(used), status: lastStatus });
      if (lastStatus !== "incomplete" || spent + estimate > cfg.cap) break;
      effort = "low";
    }
  }
  if (!answer) {
    const reason = lastStatus === "incomplete"
      ? "the model ran out of output room before it answered; try again, or review a smaller change"
      : "the model did not return a usable answer; try again later";
    return res(502, { status: "failed", reason });
  }
  const classified = classifyFindings(answer, prepared.commentable);
  const review = renderReview({ answer, classified, prepared, meta: { model: cfg.model, neurons, spent, cap: cfg.cap } });
  await env.LEDGER.put(doneKey, utcDay(now()), { expirationTtl: 30 * 24 * 3600 });
  log({
    ev: "reviewed",
    repository,
    pr,
    files: prepared.included.length,
    omitted: prepared.omitted.length,
    inline: classified.inline.length,
    general: classified.general.length,
    neurons: Math.round(neurons),
    spent: Math.round(spent),
    ms: now() - started,
  });
  return res(200, {
    status: "reviewed",
    review,
    usage: { model: cfg.model, neurons, spent_today: spent, cap: cfg.cap },
  });
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
  if (!env.GITHUB_WEBHOOK_SECRET) return json(503, { status: "unavailable", reason: "webhook secret not configured" });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_WEBHOOK_BYTES) return json(413, { status: "rejected", reason: "payload too large" });
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_WEBHOOK_BYTES) return json(413, { status: "rejected", reason: "payload too large" });
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get("x-hub-signature-256")))) {
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
  const ev = normalise(event, payload, { ownerId: env.OWNER_ID });
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
  const fx = deps.effects ?? createEffects(env);
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
  const input = { title: body.title, body: body.body, files: body.files, force };
  const out = await runReview({ cfg: config(env), env, repository: job.repo.full, pr: job.pr, headSha, input, now, sleep });
  const finish = () => askPr(env, key, { op: "complete", jobId: job.id, runId: String(claims.run_id), reviewedSha: headSha });

  if (out.status === 200 && out.body.status === "reviewed") {
    const fx = deps.effects ?? createEffects(env);
    const review = out.body.review;
    let { body: text, comments } = review;
    if (since) {
      // Inline comments may only sit on lines of the PR's own diff; findings on
      // lines a later commit undid go in the body instead.
      const lines = await fx.prLines(job.repo.full, job.pr, comments.map((c) => c.path));
      const off = comments.filter((c) => !lines.get(c.path)?.has(c.line));
      comments = comments.filter((c) => lines.get(c.path)?.has(c.line));
      if (off.length) {
        text += `\n\n#### Also noted (on lines no longer in this pull request's diff)\n\n${off
          .map((c) => `- \`${c.path}:${c.line}\`: ${String(c.body).replace(/\n+/g, " ")}`)
          .join("\n")}`;
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
  return json(out.status, out.body);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      const cfg = config(env);
      const spent = await createLedger(env.LEDGER).spent();
      return json(200, { ok: true, model: cfg.model, budget: { day: utcDay(), cap: cfg.cap, spent: Math.round(spent) } });
    }
    if (url.pathname === "/v1/github/webhook" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/v1/runner/session" && request.method === "POST") return handleRunnerSession(request, env);
    if (url.pathname === "/v1/runner/review" && request.method === "POST") return handleRunnerReview(request, env);
    if (url.pathname === "/v1/review") {
      if (request.method !== "POST") return json(405, { status: "rejected", reason: "POST only" });
      return handleReview(request, env);
    }
    return json(404, { status: "not_found" });
  },
};
