import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleReview } from "../src/index.js";
import { makeSigner, claimsAt, staticJwks, memoryKv, responsesResult, PATCH, AUDIENCE, OWNER_ID, WORKFLOW_REFS } from "./helpers.js";

const NOW_MS = 1_794_500_000_000;
const signer = await makeSigner();
const SHA = "a".repeat(40);

function env(ai, over = {}) {
  return {
    AUDIENCE, OWNER_ID,
    WORKFLOW_REFS: WORKFLOW_REFS.join(","),
    DAILY_NEURON_CAP: "6000",
    LEDGER: memoryKv(),
    AI: ai,
    ...over,
  };
}

function aiReturning(text, usage) {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); return responsesResult(text, usage); } };
}

// Scripted model: each entry is a result to return or an Error to throw.
function aiScript(steps) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const s = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    },
  };
}

async function req(body, { token, claims } = {}) {
  const t = token ?? (await signer.sign(claimsAt(Math.floor(NOW_MS / 1000), claims)));
  return new Request("https://x/v1/review", {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const sleeps = [];
const deps = { jwks: staticJwks([signer.jwk]), now: () => NOW_MS, sleep: async (ms) => { sleeps.push(ms); } };
const goodBody = { pr: 39, head_sha: SHA, title: "t", body: "b", files: [{ filename: "src/a.js", status: "modified", patch: PATCH }] };
const answer = JSON.stringify({
  summary: "Adds y.",
  findings: [{ path: "src/a.js", line: 3, severity: "major", category: "bug", title: "Division by zero", body: "Guard it." }],
});

test("reviews, records spend and marks the commit done", async () => {
  const ai = aiReturning(answer);
  const e = env(ai);
  const res = await handleReview(await req(goodBody), e, deps);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.status, "reviewed");
  assert.equal(out.review.comments.length, 1);
  assert.equal(out.review.comments[0].line, 3);
  assert.equal(out.usage.neurons, 66);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, "@cf/openai/gpt-oss-120b");
  assert.equal(ai.calls[0].input.reasoning.effort, "medium");
  assert.match(ai.calls[0].input.input, /TanksterAI\/browser-relay/);
  assert.equal(e.LEDGER.map.get("spent:2026-11-12"), "66");
  assert.ok(e.LEDGER.map.has(`done:TanksterAI/browser-relay#39@${SHA}`));

  // The same commit again is a duplicate unless forced.
  const dup = await handleReview(await req(goodBody), e, deps);
  assert.equal(dup.status, 409);
  const forced = await handleReview(await req({ ...goodBody, force: true }), e, deps);
  assert.equal(forced.status, 200);
  assert.equal(e.LEDGER.map.get("spent:2026-11-12"), "132");
});

test("the repository comes from the verified token, not the request", async () => {
  const ai = aiReturning(answer);
  const e = env(ai);
  await handleReview(await req({ ...goodBody, repository: "TanksterAI/other" }, { claims: { repository: "TanksterAI/real" } }), e, deps);
  assert.ok(e.LEDGER.map.has(`done:TanksterAI/real#39@${SHA}`));
  assert.match(ai.calls[0].input.input, /Repository: TanksterAI\/real/);
});

test("unauthenticated calls never reach the model", async () => {
  const ai = aiReturning(answer);
  for (const r of [
    await req(goodBody, { token: "nope" }),
    await req(goodBody, { claims: { repository_owner_id: "1" } }),
    await req(goodBody, { claims: { job_workflow_ref: "TanksterAI/x/.github/workflows/y.yml@main" } }),
    await req(goodBody, { claims: { job_workflow_ref: "TanksterAI/ai-review/.github/workflows/review.yml@refs/heads/feature" } }),
    await req(goodBody, { claims: { jti: undefined } }),
    new Request("https://x/v1/review", { method: "POST", body: "{}" }),
  ]) {
    const res = await handleReview(r, env(ai), deps);
    assert.equal(res.status, 401);
  }
  assert.equal(ai.calls.length, 0);
});

test("bad input is rejected", async () => {
  const ai = aiReturning(answer);
  const cases = [
    ["not json", 400],
    [{ ...goodBody, pr: 0 }, 400],
    [{ ...goodBody, pr: "39x" }, 400],
    [{ ...goodBody, head_sha: "abc" }, 400],
    [{ ...goodBody, files: "x" }, 400],
    [{ ...goodBody, files: Array.from({ length: 3001 }, () => ({})) }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await handleReview(await req(body), env(ai), deps);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(ai.calls.length, 0);
});

test("nothing reviewable is a skip, not a model call", async () => {
  const ai = aiReturning(answer);
  const res = await handleReview(await req({ ...goodBody, files: [{ filename: "package-lock.json", patch: PATCH }] }), env(ai), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "skipped");
  assert.equal(ai.calls.length, 0);
});

test("a spent budget defers without calling the model", async () => {
  const ai = aiReturning(answer);
  const e = env(ai);
  await e.LEDGER.put("spent:2026-11-12", "5990");
  const res = await handleReview(await req(goodBody), e, deps);
  assert.equal(res.status, 429);
  const out = await res.json();
  assert.equal(out.status, "deferred");
  assert.equal(out.resets_at, "2026-11-13T00:00:00.000Z");
  assert.equal(ai.calls.length, 0);
});

test("model failures and unusable answers are 502s; spend is still recorded", async () => {
  const failing = { async run() { throw new Error("5007: internal server error"); } };
  const r1 = await handleReview(await req(goodBody), env(failing), deps);
  assert.equal(r1.status, 502);

  const e = env(aiReturning("I cannot help with that"));
  const r2 = await handleReview(await req(goodBody), e, deps);
  assert.equal(r2.status, 502);
  assert.equal(e.LEDGER.map.get("spent:2026-11-12"), "66");
  assert.ok(![...e.LEDGER.map.keys()].some((k) => k.startsWith("done:")));
});

test("spend falls back to the token counts when the model reports no neurons", async () => {
  const e = env(aiReturning(answer, { input_tokens: 1_000_000, output_tokens: 0 }), { DAILY_NEURON_CAP: "1000000" });
  const res = await handleReview(await req(goodBody), e, deps);
  assert.equal((await res.json()).usage.neurons, 31_818);
});

test("router: healthz, method and 404", async () => {
  const e = env(aiReturning(answer));
  const h = await worker.fetch(new Request("https://x/healthz"), e);
  const body = await h.json();
  assert.equal(body.ok, true);
  assert.equal(body.budget.cap, 6000);
  assert.equal((await worker.fetch(new Request("https://x/v1/review"), e)).status, 405);
  assert.equal((await worker.fetch(new Request("https://x/other"), e)).status, 404);
});

test("a token is good for one review", async () => {
  const ai = aiReturning(answer);
  const e = env(ai);
  const token = await signer.sign(claimsAt(Math.floor(NOW_MS / 1000)));
  assert.equal((await handleReview(await req(goodBody, { token }), e, deps)).status, 200);
  const again = await handleReview(await req({ ...goodBody, force: true }, { token }), e, deps);
  assert.equal(again.status, 401);
  assert.equal((await again.json()).reason, "token already used");
  assert.equal(ai.calls.length, 1);
});

test("oversized bodies are refused", async () => {
  const big = await req({ ...goodBody, title: "x".repeat(2 * 1024 * 1024 + 10) });
  assert.equal((await handleReview(big, env(aiReturning(answer)), deps)).status, 413);
});

test("the account's daily allocation used up (3036) is a deferral, not a failure", async () => {
  const e = env(aiScript([new Error("AiError: 3036: Account limited: daily free allocation of 10,000 neurons used")]));
  const res = await handleReview(await req(goodBody), e, deps);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).status, "deferred");
});

test("out of capacity (3040) is retried once, then reported as unavailable", async () => {
  sleeps.length = 0;
  const ok = aiScript([new Error("AiError: 3040: Capacity temporarily exceeded"), responsesResult(answer)]);
  const r1 = await handleReview(await req(goodBody), env(ok), deps);
  assert.equal(r1.status, 200);
  assert.equal(ok.calls.length, 2);
  assert.deepEqual(sleeps, [3000]);
  const busy = aiScript([new Error("3040: out of capacity")]);
  const r2 = await handleReview(await req(goodBody), env(busy), deps);
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).status, "unavailable");
  assert.equal(busy.calls.length, 2);
  const other = aiScript([new Error("5007: internal")]);
  const r3 = await handleReview(await req(goodBody), env(other), deps);
  assert.equal(r3.status, 502);
  assert.equal(other.calls.length, 1);
  // A permanent error that merely mentions capacity is not retried.
  const ctx = aiScript([new Error("5021: input exceeds the model's context capacity")]);
  const r4 = await handleReview(await req(goodBody), env(ctx), deps);
  assert.equal(r4.status, 502);
  assert.equal(ctx.calls.length, 1);
  const lim = aiScript([new Error("4006: neurons limit for this request")]);
  assert.equal((await handleReview(await req(goodBody), env(lim), deps)).status, 502);
});

test("an answer cut short is retried once with low effort", async () => {
  const cut = { ...responsesResult(""), status: "incomplete", output: [{ type: "reasoning", content: [] }] };
  const ai = aiScript([cut, responsesResult(answer)]);
  const e = env(ai);
  const res = await handleReview(await req(goodBody), e, deps);
  assert.equal(res.status, 200);
  assert.equal(ai.calls[0].input.reasoning.effort, "medium");
  assert.equal(ai.calls[1].input.reasoning.effort, "low");
  assert.equal((await res.json()).usage.neurons, 132);
  assert.equal(e.LEDGER.map.get("spent:2026-11-12"), "132");

  // Cut short twice: a clear reason, and both calls are counted.
  const twice = aiScript([cut]);
  const e2 = env(twice);
  const r2 = await handleReview(await req(goodBody), e2, deps);
  assert.equal(r2.status, 502);
  assert.match((await r2.json()).reason, /ran out of output room/);
  assert.equal(twice.calls.length, 2);
  assert.equal(e2.LEDGER.map.get("spent:2026-11-12"), "132");

  // No retry when the budget cannot cover it: the first call spent 600, and
  // a second (about 840 reserved) would pass the 1,400 cap.
  const tight = aiScript([{ ...cut, usage: { input_tokens: 1, output_tokens: 1, neurons: 600 } }]);
  const e3 = env(tight, { DAILY_NEURON_CAP: "1400" });
  const r3 = await handleReview(await req(goodBody), e3, deps);
  assert.equal(r3.status, 502);
  assert.equal(tight.calls.length, 1);
});

test("the estimate reserves the whole output allowance", async () => {
  // About 12,000 output tokens is ~818 neurons: a 700-neuron cap defers.
  const ai = aiReturning(answer);
  const res = await handleReview(await req(goodBody), env(ai, { DAILY_NEURON_CAP: "700" }), deps);
  assert.equal(res.status, 429);
  assert.equal(ai.calls.length, 0);
});
