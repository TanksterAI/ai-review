import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleReview } from "../src/index.js";
import { makeSigner, claimsAt, staticJwks, memoryKv, responsesResult, PATCH, AUDIENCE, OWNER_ID, WORKFLOW_PREFIX } from "./helpers.js";

const NOW_MS = 1_794_500_000_000;
const signer = await makeSigner();
const SHA = "a".repeat(40);

function env(ai, over = {}) {
  return {
    AUDIENCE, OWNER_ID, WORKFLOW_PREFIX,
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

async function req(body, { token, claims } = {}) {
  const t = token ?? (await signer.sign(claimsAt(Math.floor(NOW_MS / 1000), claims)));
  return new Request("https://x/v1/review", {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const deps = { jwks: staticJwks([signer.jwk]), now: () => NOW_MS };
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
  const failing = { async run() { throw new Error("3040: out of capacity"); } };
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
