// tankster-ai-review: a free, secretless pull-request reviewer.
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
// The reviewing workflow (TanksterAI/ai-review .github/workflows/review.yml)
// fetches the diff with its own GITHUB_TOKEN and posts the review; this
// Worker never holds a GitHub credential and never sees one.

import { createJwksCache, verifyGithubOidc, OidcError } from "./oidc.js";
import { buildPrompt, classifyFindings, extractText, parseAnswer, prepareFiles, renderReview } from "./review.js";
import { createLedger, estimateNeurons, neuronsFor, utcDay } from "./budget.js";

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

export async function handleReview(request, env, deps = {}) {
  const cfg = config(env);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ledger = createLedger(env.LEDGER, now);

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let claims;
  try {
    claims = await verifyGithubOidc(token, {
      audience: cfg.audience,
      ownerId: cfg.ownerId,
      workflowRefs: cfg.workflowRefs,
      jwks: deps.jwks ?? jwks,
      nowS: Math.floor(now() / 1000),
    });
  } catch (e) {
    const reason = e instanceof OidcError ? e.reason : "verification failed";
    log({ ev: "auth_failed", reason });
    return json(401, { status: "unauthorized", reason });
  }
  const repository = claims.repository;

  // Each token is good for one review: a token copied out of a job log or a
  // runner cannot be replayed. KV is eventually consistent, so this stops
  // replays after the first second or so, not a simultaneous one; the daily
  // cap bounds what any replay can cost. KV's shortest TTL is 60 s.
  if (typeof claims.jti === "string" && claims.jti) {
    const jtiKey = `jti:${claims.jti}`;
    if (await env.LEDGER.get(jtiKey)) {
      log({ ev: "auth_failed", reason: "token reused" });
      return json(401, { status: "unauthorized", reason: "token already used" });
    }
    const ttl = Math.max(60, Math.ceil(claims.exp - now() / 1000) + 120);
    await env.LEDGER.put(jtiKey, "1", { expirationTtl: ttl });
  } else {
    log({ ev: "auth_failed", reason: "no jti" });
    return json(401, { status: "unauthorized", reason: "token has no jti" });
  }

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

  const doneKey = `done:${repository}#${pr}@${headSha}`;
  if (!input.force && (await env.LEDGER.get(doneKey))) {
    return json(409, { status: "duplicate", reason: "this commit was already reviewed; pass force to review it again" });
  }

  const prepared = prepareFiles(input.files, { maxChars: cfg.maxChars });
  if (prepared.included.length === 0) {
    log({ ev: "skipped", repository, pr, omitted: prepared.omitted.length });
    return json(200, { status: "skipped", reason: "no reviewable text changes", omitted: prepared.omitted });
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
    return json(429, {
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
        return json(429, {
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
        return json(503, { status: "unavailable", reason: "Workers AI is out of capacity; try again later" });
      }
      return json(502, { status: "failed", reason: "the model call failed; try again later" });
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
    return json(502, { status: "failed", reason });
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
  return json(200, {
    status: "reviewed",
    review,
    usage: { model: cfg.model, neurons, spent_today: spent, cap: cfg.cap },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      const cfg = config(env);
      const spent = await createLedger(env.LEDGER).spent();
      return json(200, { ok: true, model: cfg.model, budget: { day: utcDay(), cap: cfg.cap, spent: Math.round(spent) } });
    }
    if (url.pathname === "/v1/review") {
      if (request.method !== "POST") return json(405, { status: "rejected", reason: "POST only" });
      return handleReview(request, env);
    }
    return json(404, { status: "not_found" });
  },
};
