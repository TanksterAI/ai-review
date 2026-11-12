// The v2 App endpoints: webhook in, runner session, runner review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { handleWebhook, handleRunnerSession, handleRunnerReview } from "../src/index.js";
import { PrState } from "../src/pr-state.js";
import { makeSigner, claimsAt, staticJwks, memoryKv, memoryStorage, fakeEffects, responsesResult, PATCH, AUDIENCE, OWNER_ID } from "./helpers.js";

const NOW_MS = 1_794_500_000_000;
const SECRET = "whsec";
const RUNNER = "TanksterAI/ai-review/.github/workflows/runner.yml";
const signer = await makeSigner();

function namespace(fx) {
  const objects = new Map();
  return {
    objects,
    idFromName: (n) => n,
    get(name) {
      if (!objects.has(name)) objects.set(name, new PrState({ storage: memoryStorage() }, {}, { now: () => NOW_MS, effects: fx }));
      const obj = objects.get(name);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
}

function env(over = {}) {
  const fx = fakeEffects({ writers: ["rishitank"] });
  return {
    fx,
    AUDIENCE,
    OWNER_ID,
    WORKFLOW_REFS: "TanksterAI/ai-review/.github/workflows/review.yml@refs/heads/main",
    RUNNER_REFS: `${RUNNER}@refs/heads/main`,
    DAILY_NEURON_CAP: "6000",
    GITHUB_WEBHOOK_SECRET: SECRET,
    LEDGER: memoryKv(),
    PR_STATE: namespace(fx),
    AI: { async run() { return responsesResult(JSON.stringify({ summary: "Adds y.", findings: [{ path: "src/a.js", line: 3, severity: "major", category: "bug", title: "Division by zero", body: "Guard it." }] })); } },
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

const deps = (e) => ({ jwks: staticJwks([signer.jwk]), now: () => NOW_MS, sleep: async () => {}, effects: e.fx });

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

  const files = [{ filename: "src/a.js", status: "modified", patch: PATCH }];
  const r = await handleRunnerReview(await runnerReq("/v1/runner/review", { job: jobId, head_sha: "a".repeat(40), title: "t", body: "b", files }), e, deps(e));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.status, "reviewed");
  assert.equal(out.inline, 1);
  const post = e.fx.calls.find((c) => c[0] === "postReview");
  assert.equal(post[1], "TanksterAI/browser-relay");
  assert.equal(post[3].commitId, "a".repeat(40));
  // The repository reviewed is the job's, not the runner's own.
  assert.ok(e.LEDGER.map.has(`done:TanksterAI/browser-relay#39@${"a".repeat(40)}`));

  // The job is finished: it cannot be used again, and the next push is incremental.
  const again = await handleRunnerSession(await runnerReq("/v1/runner/session", { job: jobId }), e, deps(e));
  assert.equal(again.status, 403);
  await handleWebhook(hook(prBody("synchronize")), e);
  const obj = e.PR_STATE.objects.get("TanksterAI/browser-relay#39");
  await obj.alarm();
  const next = e.fx.calls.filter((c) => c[0] === "dispatch")[1][1];
  const s2 = await (await handleRunnerSession(await runnerReq("/v1/runner/session", { job: next }, { run_id: "7000" }), e, deps(e))).json();
  assert.equal(s2.job.since, "a".repeat(40));
});

test("runner review: 'since' counts only when it is the commit the Worker recorded", async () => {
  const e = env();
  const jobId = await openPr(e);
  const files = [{ filename: "src/a.js", status: "modified", patch: PATCH }];
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
  const files = [{ filename: "src/a.js", status: "modified", patch: PATCH }];
  await handleRunnerReview(await runnerReq("/v1/runner/review", { job: first, head_sha: "a".repeat(40), files }), e, deps(e));
  await handleWebhook(hook(prBody("synchronize")), e);
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

test("a re-run of the runner reviews again after a failed post; other events cannot claim", async () => {
  const e = env();
  const jobId = await openPr(e);
  const files = [{ filename: "src/a.js", status: "modified", patch: PATCH }];
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
