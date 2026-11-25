// The v2 App endpoints: webhook in, runner session, runner review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { handleWebhook, handleRunnerSession, handleRunnerReview } from "../src/index.js";
import { PrState } from "../src/pr-state.js";
import { makeSigner, claimsAt, staticJwks, memoryKv, memoryStorage, fakeEffects, responsesResult, testSleep, PATCH, GROUNDED_PATCH, AUDIENCE, OWNER_ID } from "./helpers.js";

// These tests cover the runner path (REVIEW_MODE=runner); review-run.test.js
// and the worker-mode tests below cover the Worker's own review.
const RUNNER_MODE = { REVIEW_MODE: "runner" };

const NOW_MS = 1_794_500_000_000;
const SECRET = "whsec";
const RUNNER = "TanksterAI/ai-review/.github/workflows/runner.yml";
const signer = await makeSigner();

// clock.t: the PR objects' time, moved forward by tests that wait out a
// push's quiet period.
// Like Cloudflare's: an object's id prints as 64 hex characters and reveals
// nothing of its name.
function namespace(fx, clock) {
  const objects = new Map();
  const names = new Map();
  const ids = new Map();
  const asId = (hex) => ({ hex, toString: () => hex });
  return {
    objects,
    idFromName(n) {
      if (!ids.has(n)) {
        const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
        ids.set(n, hex);
        names.set(hex, n);
      }
      return asId(ids.get(n));
    },
    // Cloudflare's ids carry a check: one it did not mint for this
    // namespace is refused.
    idFromString(s) {
      if (!names.has(s)) throw new TypeError("Invalid Durable Object ID");
      return asId(s);
    },
    get(id) {
      const name = names.get(id.hex);
      if (!objects.has(name)) objects.set(name, new PrState({ storage: memoryStorage(), id }, RUNNER_MODE, { now: () => clock.t, effects: fx }));
      const obj = objects.get(name);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
}

function env(over = {}) {
  const fx = fakeEffects({ writers: ["rishitank"] });
  const clock = { t: NOW_MS };
  return {
    fx,
    clock,
    AUDIENCE,
    OWNER_ID,
    WORKFLOW_REFS: "TanksterAI/ai-review/.github/workflows/review.yml@refs/heads/main",
    RUNNER_REFS: `${RUNNER}@refs/heads/main`,
    DAILY_NEURON_CAP: "6000",
    GITHUB_WEBHOOK_SECRET: SECRET,
    // Effects are faked; appConfig only needs all three to be present.
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused-in-tests",
    // These tests predate the verifier (verify.test.js covers it).
    VERIFY: "off",
    LEDGER: memoryKv(),
    PR_STATE: namespace(fx, clock),
    AI: { async run() { return responsesResult(JSON.stringify({ summary: "Adds y.", findings: [{ path: "src/a.js", line: 3, severity: "major", category: "bug", title: "Division by zero", evidence: "const ratio = total / 0;", body: "Guard it." }] })); } },
    ...over,
  };
}

const prBody = (action = "opened", over = {}) => JSON.stringify({
  action,
  repository: { full_name: "TanksterAI/browser-relay", name: "browser-relay", owner: { id: 259206056 } },
  sender: { login: "rishitank", type: "User" },
  pull_request: {
    number: 39, draft: false, user: { login: "rishitank", type: "User" }, author_association: "OWNER",
    head: { sha: "a".repeat(40), repo: { full_name: "TanksterAI/browser-relay" } }, base: { sha: "b".repeat(40) },
  },
  ...over,
});

function hook(body, { secret = SECRET, event = "pull_request", delivery = crypto.randomUUID() } = {}) {
  return new Request("https://x/v1/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

const deps = (e) => ({ jwks: staticJwks([signer.jwk]), now: () => NOW_MS, sleep: testSleep, effects: e.fx });

async function runnerReq(path, body, claims = {}) {
  const token = await signer.sign(claimsAt(Math.floor(NOW_MS / 1000), {
    repository: "TanksterAI/ai-review",
    job_workflow_ref: `${RUNNER}@refs/heads/main`,
    event_name: "workflow_dispatch",
    run_id: "5000",
    ...claims,
  }));
  return new Request(`https://x${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

async function openPr(e) {
  const res = await handleWebhook(hook(prBody()), e);
  assert.equal(res.status, 202);
  const obj = e.PR_STATE.objects.get("TanksterAI/browser-relay#39");
  await obj.alarm();
  return e.fx.calls.find((c) => c[0] === "dispatch")[1];
}

test("runner: job ids say nothing of the PR, and unroutable ones are refused, not crashed on", async () => {
  const e = env();
  const jobId = await openPr(e);
  assert.match(jobId, /^[0-9a-f]{64}\.[0-9a-f]{32}$/);
  const b64 = btoa("TanksterAI/browser-relay").replace(/=+$/, "");
  assert.ok(!jobId.includes(b64.slice(0, 12)));
  const [oid, rand] = jobId.split(".");
  const flip = (h) => h.slice(0, -1) + (h.at(-1) === "0" ? "1" : "0");
  for (const job of [
    `${flip(oid)}.${rand}`, // an id Cloudflare never minted
    `${oid}.${flip(rand)}`, // the right object, an unknown job
    `VGFua3N0ZXJBSS9icm93c2VyLXJlbGF5IzM5.${rand}`, // the old, readable form
    `${"g".repeat(64)}.${rand}`,
    "",
    [jobId], // not a string: refused rather than coerced
  ]) {
    const res = await handleRunnerSession(await runnerReq("/v1/runner/session", { job }), e, deps(e));
    assert.equal(res.status, 403, job);
    assert.equal((await res.json()).status, "refused");
  }
  assert.ok(!e.fx.calls.some((c) => c[0] === "cloneToken"), "no token for a job nobody holds");
  const ok = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, deps(e));
  assert.equal(ok.status, 200);
});

test("webhook: unsigned or wrongly signed deliveries are refused; no secret, no service", async () => {
  const e = env();
  assert.equal((await handleWebhook(hook(prBody(), { secret: "wrong" }), e)).status, 401);
  assert.equal((await handleWebhook(hook(prBody()), env({ GITHUB_WEBHOOK_SECRET: "" }))).status, 503);
  assert.equal(e.PR_STATE.objects.size, 0);
});

test("webhook: ignored events are acknowledged and touch nothing", async () => {
  const e = env();
  const res = await handleWebhook(hook(JSON.stringify({ action: "created" }), { event: "star" }), e);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).status, "ignored");
  assert.equal(e.PR_STATE.objects.size, 0);
});

test("webhook to runner to review: the whole path", async () => {
  const e = env();
  const jobId = await openPr(e);

  // A token from the v1 reusable workflow cannot claim App jobs.
  const wrongRef = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }, {
    job_workflow_ref: "TanksterAI/ai-review/.github/workflows/review.yml@refs/heads/main",
  }), e, deps(e));
  assert.equal(wrongRef.status, 401);

  const s = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, deps(e));
  assert.equal(s.status, 200);
  const session = await s.json();
  assert.equal(session.token, "ghs_clone");
  assert.deepEqual(session.job, { repo: { full: "TanksterAI/browser-relay", name: "browser-relay" }, pr: 39, since: null, scope: "review" });
  assert.deepEqual(e.fx.calls.find((c) => c[0] === "cloneToken"), ["cloneToken", "TanksterAI/browser-relay"]);

  // Another run cannot use the job.
  const other = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }, { run_id: "6000" }), e, deps(e));
  assert.equal(other.status, 403);

  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), title: "t", body: "b", files }), e, deps(e));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.status, "reviewed");
  assert.equal(out.inline, 1);
  const post = e.fx.calls.find((c) => c[0] === "postReview");
  assert.equal(post[1], "TanksterAI/browser-relay");
  assert.equal(post[3].commitId, "a".repeat(40));
  // Runner mode stays advisory: a comment, never a decision.
  assert.equal(post[3].event, undefined);
  assert.match(post[3].body, /Advisory only: it never approves or blocks\./);
  // The footer names the App's own commands, not v1's label and workflow.
  assert.match(post[3].body, /comment `@tankster-ai-review review` for the commits since this review/);
  assert.doesNotMatch(post[3].body, /ai-review` label/);
  // The repository reviewed is the job's, not the runner's own.
  assert.ok(e.LEDGER.map.has(`done:TanksterAI/browser-relay#39@${"a".repeat(40)}`));

  // The job is finished: it cannot be used again, and the next push is incremental.
  const again = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, deps(e));
  assert.equal(again.status, 403);
  await handleWebhook(hook(prBody("synchronize")), e);
  const obj = e.PR_STATE.objects.get("TanksterAI/browser-relay#39");
  // The push is reviewed once its quiet period (3 minutes) is over.
  await obj.alarm();
  assert.equal(e.fx.calls.filter((c) => c[0] === "dispatch").length, 1, "not before the quiet period");
  e.clock.t += 180_000;
  await obj.alarm();
  await obj.alarm();
  const next = e.fx.calls.filter((c) => c[0] === "dispatch")[1][1];
  const s2 = await (await handleRunnerSession(await runnerReq("/v1/runner/session", { job: next }, { run_id: "7000" }), e, deps(e))).json();
  assert.equal(s2.job.since, "a".repeat(40));
});

test("runner review: 'since' counts only when it is the commit the Worker recorded", async () => {
  const e = env();
  const jobId = await openPr(e);
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), since: "f".repeat(40), files }), e, deps(e));
  const post = e.fx.calls.find((c) => c[0] === "postReview");
  assert.doesNotMatch(post[3].body, /Incremental review/);
});

test("runner review: bad input and unknown jobs are refused before the model", async () => {
  let calls = 0;
  const e = env({ AI: { async run() { calls++; return responsesResult("{}"); } } });
  const jobId = await openPr(e);
  assert.equal((await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "abc", files: [] }), e, deps(e))).status, 400);
  assert.equal((await handleRunnerReview(await runnerReq("/v1/runner/review", { job: "x.y", head_sha: "a".repeat(40), files: [] }), e, deps(e))).status, 403);
  assert.equal(calls, 0);
});

test("router knows the v2 paths", async () => {
  const e = env();
  const res = await worker.fetch(hook(prBody(), { secret: "wrong" }), e);
  assert.equal(res.status, 401);
  assert.equal((await worker.fetch(new Request("https://x/v1/runner/session", { method: "POST", body: "{}" }), e)).status, 401);
});

test("incremental: findings off the PR's own diff move to the body", async () => {
  const e = env();
  const first = await openPr(e);
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  await handleRunnerReview(await runnerReq("/v1/runner/review", { job: first, head_sha: "a".repeat(40), files }), e, deps(e));
  await handleWebhook(hook(prBody("synchronize")), e);
  e.clock.t += 180_000;
  await e.PR_STATE.objects.get("TanksterAI/browser-relay#39").alarm();
  await e.PR_STATE.objects.get("TanksterAI/browser-relay#39").alarm();
  const next = e.fx.calls.filter((c) => c[0] === "dispatch")[1][1];
  // The PR's own diff no longer has line 3 of src/a.js (a later commit undid it).
  e.fx.prLinesMap = new Map([["src/a.js", new Set([1])]]);
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", {
    job: next, head_sha: "e".repeat(40), since: "a".repeat(40), files,
  }, { run_id: "8000" }), e, deps(e));
  assert.equal(r.status, 200);
  const post = e.fx.calls.filter((c) => c[0] === "postReview")[1][3];
  assert.equal(post.comments.length, 0);
  assert.match(post.body, /Also noted[\s\S]*`src\/a\.js:3`/);
  assert.match(post.body, /Incremental review: commits after `aaaaaaa`/);
});

test("incremental: a suggestion's whole range must still be in the PR's diff", async () => {
  const e = env({ AI: { async run() {
    return responsesResult(JSON.stringify({ summary: "s", findings: [
      { path: "src/a.js", start_line: 2, line: 3, severity: "major", category: "bug", title: "Range", evidence: "const ratio = total / 0;", body: "b\n\n```suggestion\nconst y = 9;\n```", suggestion: "const x = 3;\nconst y = 1;" },
      { path: "src/a.js", line: 3, severity: "minor", category: "bug", title: "Single", evidence: "const ratio = total / 0;", body: "b", suggestion: "const y = 1;" },
    ] }));
  } } });
  const first = await openPr(e);
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  await handleRunnerReview(await runnerReq("/v1/runner/review", { job: first, head_sha: "a".repeat(40), files }), e, deps(e));
  const full = e.fx.calls.filter((c) => c[0] === "postReview")[0][3];
  assert.deepEqual(full.comments.map((c) => [c.start_line, c.line]), [[2, 3], [undefined, 3]]);
  await handleWebhook(hook(prBody("synchronize")), e);
  e.clock.t += 180_000;
  await e.PR_STATE.objects.get("TanksterAI/browser-relay#39").alarm();
  await e.PR_STATE.objects.get("TanksterAI/browser-relay#39").alarm();
  const next = e.fx.calls.filter((c) => c[0] === "dispatch")[1][1];
  // Line 2 left the PR's diff; line 3 is still there.
  e.fx.prLinesMap = new Map([["src/a.js", new Set([3])]]);
  await handleRunnerReview(await runnerReq("/v1/runner/review", {
    job: next, head_sha: "e".repeat(40), since: "a".repeat(40), files,
  }, { run_id: "8000" }), e, deps(e));
  const post = e.fx.calls.filter((c) => c[0] === "postReview")[1][3];
  // Line 3 is still there: the range comment stays on it, without its
  // suggestion (and without a range); the single-line one is unchanged.
  assert.deepEqual(post.comments.map((c) => [c.start_line, c.start_side, c.line]), [[undefined, undefined, 3], [undefined, undefined, 3]]);
  // Neither the Worker's two-line suggestion nor a block the model wrote.
  assert.doesNotMatch(post.comments[0].body, /^`{3,}suggestion$/m);
  assert.doesNotMatch(post.comments[0].body, /const x = 3;/);
  assert.match(post.comments[0].body, /The suggestion was left out/);
  assert.match(post.comments[0].body, /Prompt for AI agents|finding `/);
  assert.match(post.comments[1].body, /```suggestion\nconst y = 1;\n```/);
  assert.doesNotMatch(post.body, /Also noted/);
  // The findings block records the commit reviewed.
  assert.match(post.body, /tankster-ai-review:findings \{"v":1,"head":"e{40}"/);

  // When the comment's own line has left the diff too, it goes in the body,
  // as its first line only.
  e.fx.prLinesMap = new Map([["src/a.js", new Set([1])]]);
  await handleWebhook(hook(prBody("synchronize")), e);
  e.clock.t += 180_000;
  await e.PR_STATE.objects.get("TanksterAI/browser-relay#39").alarm();
  await e.PR_STATE.objects.get("TanksterAI/browser-relay#39").alarm();
  const third = e.fx.calls.filter((c) => c[0] === "dispatch")[2][1];
  await handleRunnerReview(await runnerReq("/v1/runner/review", {
    job: third, head_sha: "f".repeat(40), since: "e".repeat(40), files,
  }, { run_id: "9000" }), e, deps(e));
  const last = e.fx.calls.filter((c) => c[0] === "postReview")[2][3];
  assert.equal(last.comments.length, 0);
  assert.match(last.body, /Also noted[\s\S]*- `src\/a\.js:3`: \*\*Major · Functional Correctness: Range\*\*\n/);
  assert.doesNotMatch(last.body.split("Also noted")[1], /suggestion/);
});

test("a re-run of the runner reviews again after a failed post; other events cannot claim", async () => {
  const e = env();
  const jobId = await openPr(e);
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  const real = e.fx.postReview;
  e.fx.postReview = async () => { throw new Error("GitHub 502"); };
  await assert.rejects(handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), files }), e, deps(e)));
  e.fx.postReview = real;
  // Same run, next attempt: the job is still open and the commit is reviewed again.
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), files }, { run_attempt: "2" }), e, deps(e));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "reviewed");
  // A token from any other event is refused.
  const push = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }, { event_name: "push" }), e, deps(e));
  assert.equal(push.status, 403);
});

test("runner review deferred: the job goes back to the PR's object and is dispatched again after the reset", async () => {
  const e = env({ AI: { async run() { throw new Error("AiError: 3036: daily free allocation used"); } } });
  const jobId = await openPr(e);
  await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, deps(e));
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), title: "t", body: "b", files }), e, deps(e));
  assert.equal(r.status, 429);
  assert.equal(e.fx.calls.filter((c) => c[0] === "postReview").length, 0);
  const obj = e.PR_STATE.objects.get("TanksterAI/browser-relay#39");
  const box = await obj.ctx.storage.get("outbox");
  assert.equal(box.length, 1);
  assert.equal(box[0].type, "dispatch");
  assert.equal(box[0].jobId, jobId);
  assert.ok(box[0].notBefore > NOW_MS);
  // Released: a later run of the dispatch can claim it.
  assert.equal((await obj.ctx.storage.get(`job:${jobId}`)).claimedBy, null);
  const s2 = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }, { run_id: "9000" }), e, deps(e));
  assert.equal(s2.status, 200);
});

test("runner review: a provider that failed is skipped when the deferred review runs again", async () => {
  let calls = 0;
  const e = env({
    GEMINI_API_KEY: "k",
    DRAFT_CHAIN: "workers-ai:@cf/zai-org/glm-4.7-flash,gemini:gemini-3.5-flash-lite",
    AI: { async run() { calls++; return { choices: [{ message: { content: "not json" }, finish_reason: "stop" }] }; } },
  });
  const day = { ok: false, status: 429, headers: { get: () => null }, async json() { return { error: { details: [{ violations: [{ quotaId: "PerDay" }] }] } }; } };
  const d = { ...deps(e), fetch: async () => day };
  const jobId = await openPr(e);
  await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, d);
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), files }), e, d);
  assert.equal(r.status, 429);
  assert.equal(calls, 1);
  const obj = e.PR_STATE.objects.get("TanksterAI/browser-relay#39");
  assert.deepEqual((await obj.ctx.storage.get(`job:${jobId}`)).skip, ["workers-ai:@cf/zai-org/glm-4.7-flash"]);
  e.LEDGER.map.delete("ex:gemini:gemini-3.5-flash-lite");
  await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }, { run_id: "9100" }), e, d);
  await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), files }, { run_id: "9100" }), e, d);
  assert.equal(calls, 1, "the failing provider is not asked again");
});

test("runner review: findings no verifier can check are never posted; the job waits in the PR's object", async () => {
  // Verification on, and nothing independent of the drafter to verify with.
  const e = env({ VERIFY: "", VERIFY_FALLBACK: "" });
  const jobId = await openPr(e);
  await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, deps(e));
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }];
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), title: "t", body: "b", files }), e, { ...deps(e), sleep: testSleep });
  assert.equal(r.status, 429);
  assert.match((await r.json()).reason, /no independent verifier/);
  assert.equal(e.fx.calls.filter((c) => c[0] === "postReview").length, 0);
  const obj = e.PR_STATE.objects.get("TanksterAI/browser-relay#39");
  const box = await obj.ctx.storage.get("outbox");
  assert.deepEqual(box.map((b) => [b.type, b.jobId]), [["dispatch", jobId]]);
  assert.ok(box[0].notBefore > NOW_MS);
  // The drafter is not blamed: it is not skipped next time.
  assert.deepEqual((await obj.ctx.storage.get(`job:${jobId}`)).skip ?? [], []);
});

test("webhook: a thread of the App's own resolved by hand reaches the PR's object, which decides its approval", async () => {
  const e = env();
  const body = JSON.stringify({
    action: "resolved",
    repository: { full_name: "TanksterAI/browser-relay", name: "browser-relay", owner: { id: 259206056 } },
    sender: { login: "rishitank", type: "User" },
    pull_request: { number: 39 },
    thread: { node_id: "PRRT_1", comments: [{ user: { login: "tankster-ai-review[bot]", type: "Bot" } }] },
  });
  const r = await handleWebhook(hook(body, { event: "pull_request_review_thread" }), e);
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { status: "accepted", action: "decide" });
  // CodeRabbit's thread, or the App's own resolving: ignored.
  const theirs = body.replace("tankster-ai-review[bot]", "coderabbitai[bot]");
  assert.equal((await (await handleWebhook(hook(theirs, { event: "pull_request_review_thread" }), e)).json()).status, "ignored");
});

test("webhook: a merge queue's commit passes at once, with no review and no per-PR state", async () => {
  const e = env();
  const sha = "d".repeat(40);
  const body = JSON.stringify({
    action: "checks_requested",
    repository: { full_name: "TanksterAI/browser-relay", name: "browser-relay", owner: { id: 259206056 } },
    sender: { login: "rishitank", type: "User" },
    merge_group: { head_sha: sha, base_ref: "refs/heads/main" },
  });
  const res = await handleWebhook(hook(body, { event: "merge_group" }), e, { effects: e.fx });
  assert.equal(res.status, 202);
  assert.equal(e.PR_STATE.objects.size, 0);
  const call = e.fx.calls.find((c) => c[0] === "setStatus");
  assert.deepEqual([call[1], call[2], call[3]], ["TanksterAI/browser-relay", sha, "success"]);
  assert.match(call[4], /merge queue/i);
});
