import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleReview, placeComments } from "../src/index.js";
import { parseFindingsBlock } from "../src/review.js";
import { askedFindings, testSleep, makeSigner, claimsAt, staticJwks, memoryKv, responsesResult, PATCH, GROUNDED_PATCH, AUDIENCE, OWNER_ID, WORKFLOW_REFS } from "./helpers.js";

const NOW_MS = 1_794_500_000_000;
const signer = await makeSigner();
const SHA = "a".repeat(40);

function env(ai, over = {}) {
  return {
    AUDIENCE, OWNER_ID,
    WORKFLOW_REFS: WORKFLOW_REFS.join(","),
    DAILY_NEURON_CAP: "6000",
    // These tests predate the verifier (verify.test.js covers it).
    VERIFY: "off",
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
// A retry pause is recorded and passes at once; a deadline's timer (a minute
// or more) never fires unless a test makes it.
const deps = { jwks: staticJwks([signer.jwk]), now: () => NOW_MS, sleep: (ms) => (ms >= 60_000 ? new Promise(() => {}) : (sleeps.push(ms), Promise.resolve())) };
const goodBody = { pr: 39, head_sha: SHA, title: "t", body: "b", files: [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }] };
const answer = JSON.stringify({
  summary: "Adds y.",
  findings: [{ path: "src/a.js", line: 3, severity: "major", category: "bug", title: "Division by zero", evidence: "const ratio = total / 0;", body: "Guard it." }],
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
  const res = await handleReview(await req({ ...goodBody, files: [{ filename: "package-lock.json", patch: GROUNDED_PATCH }] }), env(ai), deps);
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

test("an answer that tried to be JSON but does not parse is retried once, without suggestions", async () => {
  const broken = responsesResult('{"summary": "s", "findings": [{"suggestion": "a "unescaped" quote"}]}');
  const ai = aiScript([broken, responsesResult(answer)]);
  const e = env(ai);
  const res = await handleReview(await req(goodBody), e, deps);
  assert.equal(res.status, 200);
  assert.equal(ai.calls.length, 2);
  assert.doesNotMatch(ai.calls[0].input.instructions, /could not be used/);
  assert.match(ai.calls[1].input.instructions, /leave out every "suggestion" key/);
  // Same effort: only an answer cut short lowers it.
  assert.equal(ai.calls[1].input.reasoning.effort, "medium");
  // Broken twice: one retry only.
  const twice = aiScript([broken]);
  assert.equal((await handleReview(await req(goodBody), env(twice), deps)).status, 502);
  assert.equal(twice.calls.length, 2);
  // No retry when the first answer used up the budget a second would need.
  const costly = responsesResult('{"summary": "s", "findings": [', { input_tokens: 1, output_tokens: 1, neurons: 5_990 });
  const tight = aiScript([costly, responsesResult(answer)]);
  assert.equal((await handleReview(await req(goodBody), env(tight), deps)).status, 502);
  assert.equal(tight.calls.length, 1);
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

test("placeComments keeps what fits, shrinks a range to its line, and moves the rest", () => {
  const lines = new Map([["a.js", new Set([3, 4])]]);
  const comments = [
    { path: "a.js", line: 4, start_line: 3, start_side: "RIGHT", side: "RIGHT", body: "whole" },
    { path: "a.js", line: 4, start_line: 2, start_side: "RIGHT", side: "RIGHT", body: "range with suggestion" },
    { path: "a.js", line: 4, start_line: 2, start_side: "RIGHT", side: "RIGHT", body: "no single-line body" },
    { path: "a.js", line: 9, side: "RIGHT", body: "gone" },
    { path: "b.js", line: 3, side: "RIGHT", body: "other file" },
  ];
  const { kept, off } = placeComments(comments, [null, "single", undefined], lines);
  assert.deepEqual(kept.map((c) => c.body.split("\n")[0]), ["whole", "single"]);
  assert.equal(kept[0].start_line, 3);
  assert.equal(kept[1].start_line, undefined);
  assert.equal(kept[1].start_side, undefined);
  assert.match(kept[1].body, /The suggestion was left out/);
  // Without a single-line body (an older review), the comment is not edited: it moves.
  assert.deepEqual(off.map((c) => c.body), ["no single-line body", "gone", "other file"]);
  assert.deepEqual(placeComments(comments.slice(1, 2), undefined, lines).off.length, 1);
});

// --- the provider chain -----------------------------------------------------

function geminiFetch(steps) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    return { ok: s.status === 200, status: s.status, headers: { get: () => null }, async json() { return s.body; } };
  };
  f.calls = calls;
  return f;
}
const geminiOk = (text) => ({ status: 200, body: { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] } });
const geminiDay = { status: 429, body: { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } } };

test("the chain: Gemini reviews first, for free, and Workers AI is never called", async () => {
  const ai = aiReturning(answer);
  const e = env(ai, { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const f = geminiFetch([geminiOk(answer)]);
  const res = await handleReview(await req(goodBody), e, { ...deps, fetch: f });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out.usage, { provider: "gemini", model: "gemini-3.5-flash-lite", usd: 0 });
  assert.equal(ai.calls.length, 0);
  assert.match(out.review.body, /Model: `gemini-3\.5-flash-lite` on the Gemini API free tier/);
  assert.match(out.review.body, /Cost: nothing \(free tier\)\./);
});

test("the chain: a provider out of quota hands over to the next, and stays skipped until it resets", async () => {
  const ai = aiReturning(answer);
  const e = env(ai, { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const f = geminiFetch([geminiDay]);
  const res = await handleReview(await req(goodBody), e, { ...deps, fetch: f });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).usage.model, "@cf/zai-org/glm-4.7-flash");
  assert.equal(ai.calls[0].model, "@cf/zai-org/glm-4.7-flash");
  // The next review does not ask Gemini again until midnight Pacific.
  const res2 = await handleReview(await req({ ...goodBody, head_sha: "b".repeat(40) }), e, { ...deps, fetch: f });
  assert.equal(res2.status, 200);
  assert.equal(f.calls.length, 1);
});

test("the chain: every provider out of quota defers to the earliest reset; busy beats broken", async () => {
  const e = env(aiScript([new Error("AiError: 3036: daily free allocation")]), { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const res = await handleReview(await req(goodBody), e, { ...deps, fetch: geminiFetch([geminiDay]) });
  const out = await res.json();
  assert.equal(res.status, 429);
  // Workers AI resets at 00:00 UTC; Gemini at midnight Pacific, later.
  const d = new Date(NOW_MS);
  assert.equal(out.resets_at, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString());
  const busy = env(aiScript([new Error("weird")]), { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:g,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const r2 = await handleReview(await req(goodBody), busy, { ...deps, fetch: geminiFetch([{ status: 503, body: {} }]) });
  assert.equal(r2.status, 503);
  // An unparseable answer on one provider is retried there once, then the next is tried.
  const ai = aiReturning(answer);
  const e3 = env(ai, { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:g,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const f3 = geminiFetch([geminiOk('{"summary": "s", "findings": [')]);
  const r3 = await handleReview(await req(goodBody), e3, { ...deps, fetch: f3 });
  assert.equal(r3.status, 200);
  assert.equal(f3.calls.length, 2);
  assert.match(f3.calls[1].body.systemInstruction.parts[0].text, /leave out every "suggestion" key/);
  assert.equal(ai.calls.length, 1);
});

test("the chain: Claude as a last-resort drafter shows its cost against the day's cap", async () => {
  const f = async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { return { content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage: { input_tokens: 20_000, output_tokens: 1_000 } }; } });
  const e = env(aiReturning(answer), { ANTHROPIC_API_KEY: "sk", DRAFT_CHAIN: "anthropic:claude-haiku-5-5", ANTHROPIC_DAILY_USD_CAP: "5" });
  const res = await handleReview(await req(goodBody), e, { ...deps, fetch: f });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.usage.provider, "anthropic");
  assert.match(out.review.body, /Cost: \$0\.0025 of the plan's API credit; \$5\.00 of today's \$5\.00 left\./);
});

test("healthz lists the providers and what is out of quota, never a key", async () => {
  const e = env(aiReturning(answer), { GEMINI_API_KEY: "secret-key", DRAFT_CHAIN: "gemini:g,workers-ai:@cf/zai-org/glm-4.7-flash" });
  await e.LEDGER.put("ex:gemini:g", String(Date.now() + 3600_000));
  const res = await worker.fetch(new Request("https://x/healthz"), e);
  const text = await res.text();
  assert.ok(!text.includes("secret-key"));
  const body = JSON.parse(text);
  assert.equal(body.providers.length, 2);
  assert.equal(body.providers[0].configured, true);
  assert.ok(body.providers[0].exhausted_until);
  assert.equal(body.providers[1].exhausted_until, null);
});

test("the chain: busy until a known time counts as a wait (429, queued), not a failure", async () => {
  const minute = { status: 429, body: { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerMinute-FreeTier" }] }, { retryDelay: "40s" }] } } };
  const e = env(aiScript([new Error("AiError: 3036: daily free allocation")]), { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:g,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const res = await handleReview(await req(goodBody), e, { ...deps, fetch: geminiFetch([minute]) });
  const out = await res.json();
  assert.equal(res.status, 429);
  // The earliest: Gemini's minute limit (40 s, held for KV's 60-second minimum).
  assert.equal(out.resets_at, new Date(NOW_MS + 60_000).toISOString());
  assert.match(out.reason, /rate limit/);
  assert.ok(out.chars > 1000, "the review's size, for sizing the next capacity check");
});

test("the chain: one provider failing and another only out of quota waits (429), it is not a failure", async () => {
  const cut = { status: 200, body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"summary":' }] } }] } };
  const e = env(aiScript([new Error("AiError: 3036: daily free allocation")]), { GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const res = await handleReview(await req(goodBody), e, { ...deps, fetch: geminiFetch([cut]) });
  assert.equal(res.status, 429);
  assert.match((await res.json()).reason, /Workers AI allocation/);
});

// --- verified findings, end to end: draft, ground, verify, render -----------

test("draft, ground, verify and render: only confirmed findings are shown, and the footer says so", async () => {
  const draft = JSON.stringify({ summary: "DrafterSaysAllIsWell.", findings: [
    { path: "src/a.js", line: 3, severity: "major", type: "issue", category: "bug", title: "Division by zero", evidence: "const ratio = total / 0;", claim: "y is x / 0.", symbols: ["total", "ratio"], body: "Guard it.",
      suggestion: "const y = x === 0 ? 0 : 1 / x;", agent_prompt: "UnpassedPrompt: rewrite the module." },
    // The first evidence line has no content and is ignored; the second grounds it.
    { path: "src/a.js", line: 2, severity: "minor", type: "issue", category: "bug", title: "Constant changed wrongly", evidence: "}\nconst ratio = total / 0;", claim: "x should stay 1.", body: "Hidden body one." },
    { path: "src/a.js", line: 1, severity: "minor", type: "nitpick", category: "maintainability", title: "Import style", evidence: "import { loadStore } from './store.js';", body: "Use double quotes." },
    { path: "src/a.js", line: 3, severity: "minor", type: "issue", category: "bug", title: "Calls `missingHelper`", evidence: "const ratio = total / 0;", body: "Hidden body two." },
    { path: "src/a.js", line: 5, severity: "minor", type: "issue", category: "bug", title: "Invented line", evidence: "return cache;", body: "Hidden body three." },
    { path: "src/a.js", line: 2, severity: "major", type: "issue", category: "bug", title: "Second major", evidence: ["const total = 2;", "const ratio = total / 0;"], body: "Hidden body four." },
    { path: "src/a.js", line: 4, severity: "minor", type: "issue", category: "bug", title: "Lone brace", evidence: "}", body: "Hidden body five." },
  ] });
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (status, data) => ({ ok: status === 200, status, headers: { get: () => null }, async json() { return data; } });
    if (url.includes("generativelanguage")) {
      calls.push("gemini");
      return reply(429, { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } });
    }
    const findings = askedFindings(body.messages[0].content);
    calls.push(`${body.model}:${findings.length}`);
    const say = (f) => {
      if (f.title === "Constant changed wrongly") return "refuted";
      if (f.title === "Second major" && body.model === "claude-sonnet-5-5") return "refuted";
      return "confirmed";
    };
    // Both pass the suggestion; Sonnet does not pass the prompt.
    const text = JSON.stringify({ verdicts: findings.map((f) => ({ id: f.id, verdict: say(f), severity: f.severity, suggestion_ok: true, prompt_ok: body.model !== "claude-sonnet-5-5", reason: "VerifierOwnWords" })) });
    return reply(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 200 } });
  };
  const ai = aiReturning(draft);
  const e = env(ai, {
    VERIFY: "", GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "sk", ANTHROPIC_DAILY_USD_CAP: "5",
    DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,workers-ai:@cf/zai-org/glm-4.7-flash",
  });
  const res = await handleReview(await req(goodBody), e, { ...deps, sleep: testSleep, fetch });
  assert.equal(res.status, 200);
  const out = await res.json();
  // Gemini was out for the day; Workers AI drafted; Haiku checked the four
  // findings that passed the grounding gate in one call (one file); Sonnet the
  // two majors Haiku confirmed.
  assert.deepEqual(calls, ["gemini", "claude-haiku-5-5:4", "claude-sonnet-5-5:2"]);
  assert.equal(ai.calls[0].model, "@cf/zai-org/glm-4.7-flash");
  const { body, comments } = out.review;
  assert.deepEqual(comments.map((c) => c.line), [3]);
  assert.match(comments[0].body, /Division by zero/);
  // The suggestion both verifiers passed is kept; the prompt Sonnet did not pass is gone.
  assert.match(comments[0].body, /```suggestion\nconst y = x === 0 \? 0 : 1 \/ x;\n```/);
  assert.doesNotMatch(comments[0].body, /Prompt for AI agents/);
  // The summary is the Worker's; the drafter's and the verifiers' own words are nowhere.
  assert.match(body, /### Tankster AI Review\n\nReviewed 1 file\. 1 finding confirmed: 1 major \(plus 1 nitpick\)\.\n/);
  assert.match(body, /2 findings: 1 inline, 1 below\./);
  assert.match(body, /🧹 Nitpick comments \(1\)[\s\S]*Import style/);
  assert.match(body, /\n- Verified: 2 findings confirmed by `claude-haiku-5-5` \(1 also by `claude-sonnet-5-5`\); 5 not shown \(1 refuted, 1 unconfirmed, 2 failed the evidence check, 1 named something not in the change\)\.\n/);
  // Drafting on Workers AI, verifying on the plan's credit: $0.0006 for Haiku, $0.012 for Sonnet.
  assert.match(body, /\n- Cost: 66 neurons; 5934 of today's 6000 left for reviews\. Verification: \$0\.0126 of the plan's API credit; \$4\.99 of today's \$5\.00 left\.\n/);
  for (const t of ["Constant changed wrongly", "missingHelper", "Invented line", "Second major", "Lone brace", "Hidden body", "x should stay 1", "return cache", "DrafterSaysAllIsWell", "VerifierOwnWords", "UnpassedPrompt"]) {
    assert.ok(!body.includes(t) && !comments.some((c) => c.body.includes(t)), t);
  }
  const block = parseFindingsBlock(body);
  assert.deepEqual(block.findings.map((f) => [f.title ?? null, f.status, f.reason]), [
    ["Division by zero", "confirmed", "confirmed by claude-haiku-5-5 and claude-sonnet-5-5"],
    ["Import style", "confirmed", "confirmed by claude-haiku-5-5"],
    // Hidden ones in severity order, as the drafter's findings are ranked.
    [null, "unconfirmed", "claude-haiku-5-5 confirmed it; claude-sonnet-5-5 refuted it"],
    [null, "refuted", "refuted by claude-haiku-5-5"],
    [null, "dropped", "names something not in the change"],
    [null, "dropped", "evidence not in the code"],
    [null, "dropped", "evidence too thin"],
  ]);
  assert.deepEqual(block.findings[0].verified_by, ["anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5"]);
  assert.deepEqual(out.usage.verification, { calls: 2, neurons: 0, usd: 0.0126 });
  assert.ok(e.LEDGER.map.has(`done:TanksterAI/browser-relay#39@${SHA}`));
});

test("no verifier can run: the review waits (429) and nothing is posted or marked done", async () => {
  const ai = aiReturning(answer);
  // Workers AI drafts; no Anthropic key and no fallback: nothing independent to verify with.
  const e = env(ai, { VERIFY: "", VERIFY_FALLBACK: "" });
  const res = await handleReview(await req(goodBody), e, { ...deps, sleep: testSleep });
  assert.equal(res.status, 429);
  const out = await res.json();
  assert.equal(out.status, "deferred");
  assert.match(out.reason, /no independent verifier is configured/);
  assert.equal(out.resets_at, "2026-11-13T00:00:00.000Z");
  assert.deepEqual(out.failed, []);
  assert.ok(out.chars > 1000);
  assert.equal(out.review, undefined);
  assert.ok(![...e.LEDGER.map.keys()].some((k) => k.startsWith("done:")));
  // The drafter's spend happened, and is recorded.
  assert.equal(e.LEDGER.map.get("spent:2026-11-12"), "66");
});

test("a fallback verifier of the drafter's kind is used, and the footer says the check is weaker", async () => {
  const draft = JSON.stringify({ summary: "s", findings: [{ path: "src/a.js", line: 3, severity: "minor", category: "bug", title: "Division by zero", evidence: "const ratio = total / 0;", body: "Guard it." }] });
  const calls = [];
  const ai = {
    calls,
    async run(model, input) {
      calls.push(model);
      if (model === "@cf/openai/gpt-oss-120b") return responsesResult(draft);
      const findings = askedFindings(input.messages[1].content);
      return { choices: [{ message: { content: JSON.stringify({ verdicts: findings.map((f) => ({ id: f.id, verdict: "confirmed", severity: "minor", suggestion_ok: false, prompt_ok: false, reason: "ok" })) }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    },
  };
  const res = await handleReview(await req(goodBody), env(ai, { VERIFY: "" }), { ...deps, sleep: testSleep });
  assert.equal(res.status, 200);
  const { body } = (await res.json()).review;
  assert.deepEqual(calls, ["@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"]);
  assert.match(body, /- Verified: 1 finding confirmed by `@cf\/zai-org\/glm-4\.7-flash`; nothing hidden\. Some findings were checked by a fallback model \(`@cf\/zai-org\/glm-4\.7-flash`\), because the usual verifier could not run\. Some were checked by a model of the same kind as the one that wrote them, which is a weaker check\./);
  assert.match(body, /- Cost: 66 neurons; \d+ of today's 6000 left for reviews\. Verification: 9 neurons\./);
  assert.equal(parseFindingsBlock(body).findings[0].weak, true);
});

// An Anthropic stand-in for the verifier: every finding confirmed, after
// `delay(findings)` real milliseconds.
function slowVerifier(delay) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const findings = askedFindings(body.messages[0].content);
    const ms = delay(findings);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const text = JSON.stringify({ verdicts: findings.map((f) => ({ id: f.id, verdict: "confirmed", severity: "minor", suggestion_ok: true, prompt_ok: true, reason: "r" })) });
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }; } };
  };
}
const shortTimer = { sleep: () => new Promise((r) => setTimeout(r, 30)) };

test("the verifier answering too late: 503, nothing posted, nothing marked done", async () => {
  const e = env(aiReturning(answer.replace('"major"', '"minor"')), { VERIFY: "", ANTHROPIC_API_KEY: "sk" });
  const res = await handleReview(await req(goodBody), e, { ...deps, ...shortTimer, fetch: slowVerifier(() => 200) });
  assert.equal(res.status, 503);
  const out = await res.json();
  assert.deepEqual(out, { status: "unavailable", reason: "the verifier did not answer in time" });
  assert.ok(![...e.LEDGER.map.keys()].some((k) => k.startsWith("done:")));
});

test("part of verification late: those findings are unconfirmed, and the cost says 'at least'", async () => {
  const draft = JSON.stringify({ summary: "s", findings: [
    { path: "src/a.js", line: 3, severity: "minor", category: "bug", title: "Fast one", evidence: "const ratio = total / 0;", body: "b" },
    { path: "src/a.js", line: 2, severity: "minor", category: "bug", title: "Fast two", evidence: "const total = 2;", body: "b" },
    { path: "src/b.js", line: 1, severity: "minor", category: "bug", title: "Slow one", evidence: "const discount = price / 0;", body: "b" },
  ] });
  const files = [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }, { filename: "src/b.js", status: "added", patch: "@@ -0,0 +1,1 @@\n+const discount = price / 0;" }];
  const e = env(aiReturning(draft), { VERIFY: "", ANTHROPIC_API_KEY: "sk" });
  const res = await handleReview(await req({ ...goodBody, files }), e, { ...deps, ...shortTimer, fetch: slowVerifier((f) => (f.some((x) => x.title === "Slow one") ? 200 : 0)) });
  assert.equal(res.status, 200);
  const { body, comments } = (await res.json()).review;
  assert.deepEqual(comments.map((c) => c.path), ["src/a.js", "src/a.js"]);
  assert.doesNotMatch(body, /Slow one/);
  assert.match(body, /- Verified: 2 findings confirmed by `claude-haiku-5-5`; 1 not shown \(1 unconfirmed\)\./);
  assert.match(body, /Verification: at least \$0\.\d{4} of the plan's API credit/);
});

test("drafting stops a minute before the review's deadline: no retry, no next provider, 503", async () => {
  // Each model call takes 250 s on the clock: past 270 s less a minute.
  let t = NOW_MS;
  const calls = [];
  const ai = { calls, async run(model) { calls.push(model); t += 250_000; return responsesResult('{"summary": "s", "findings": ['); } };
  const e = env(ai, { DRAFT_CHAIN: "workers-ai:@cf/openai/gpt-oss-120b,workers-ai:@cf/zai-org/glm-4.7-flash" });
  const res = await handleReview(await req(goodBody), e, { ...deps, now: () => t });
  assert.equal(res.status, 503);
  assert.match((await res.json()).reason, /ran out of time/);
  assert.deepEqual(calls, ["@cf/openai/gpt-oss-120b"], "neither the retry nor the next provider was started");
  // REVIEW_DEADLINE_MS sets it: with 20 minutes, the retry runs.
  let t2 = NOW_MS;
  const calls2 = [];
  const ai2 = { async run(model) { calls2.push(model); t2 += 250_000; return responsesResult(calls2.length === 1 ? '{"summary": "s", "findings": [' : answer); } };
  const res2 = await handleReview(await req(goodBody), env(ai2, { REVIEW_DEADLINE_MS: "1200000" }), { ...deps, now: () => t2 });
  assert.equal(res2.status, 200);
  assert.equal(calls2.length, 2);
});

test("a drafting call that has not answered by the review's deadline is given up: 503, queued, nothing done", async () => {
  // The model takes 200 ms; the deadline's timer fires after 20.
  const ai = { calls: 0, async run() { ai.calls++; await new Promise((r) => setTimeout(r, 200)); return responsesResult(answer); } };
  const e = env(ai);
  const timer = (ms) => (ms >= 60_000 ? new Promise((r) => setTimeout(r, 20)) : Promise.resolve());
  const res = await handleReview(await req(goodBody), e, { ...deps, sleep: timer });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: "unavailable", reason: "the review ran out of time before a model answered" });
  assert.equal(ai.calls, 1);
  assert.ok(![...e.LEDGER.map.keys()].some((k) => k.startsWith("done:")));
});

test("the planned drafter: when the first free drafter is the only free verifier, another drafts", async () => {
  // Gemini Flash-Lite is first in the drafting chain and the only verifier;
  // Workers AI glm is free to draft. So glm drafts and Gemini verifies.
  const ai = aiReturning(answer.replace('"major"', '"minor"'));
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const findings = askedFindings(body.contents[0].parts[0].text);
    calls.push(findings.length ? "verify" : "draft");
    const text = findings.length
      ? JSON.stringify({ verdicts: findings.map((f) => ({ id: f.id, verdict: "confirmed", severity: "minor", suggestion_ok: true, prompt_ok: true, reason: "r" })) })
      : answer;
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }; } };
  };
  const over = { VERIFY: "", GEMINI_API_KEY: "g", DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,workers-ai:@cf/zai-org/glm-4.7-flash", VERIFY_CHAIN: "", VERIFY_FALLBACK: "gemini:gemini-3.5-flash-lite" };
  const res = await handleReview(await req(goodBody), env(ai, over), { ...deps, fetch });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.usage.model, "@cf/zai-org/glm-4.7-flash");
  assert.deepEqual(ai.calls.map((c) => c.model), ["@cf/zai-org/glm-4.7-flash"]);
  assert.deepEqual(calls, ["verify"], "Gemini only verified");
  assert.match(out.review.body, /- Verified: 1 finding confirmed by `gemini-3\.5-flash-lite`/);
  // With verification off there is no plan: the chain's order stands.
  const ai2 = aiReturning(answer);
  const calls2 = [];
  const fetch2 = async (u, i) => { calls2.push("draft"); return fetch(u, i); };
  const res2 = await handleReview(await req(goodBody), env(ai2, { ...over, VERIFY: "off" }), { ...deps, fetch: fetch2 });
  assert.equal((await res2.json()).usage.model, "gemini-3.5-flash-lite");
  assert.equal(ai2.calls.length, 0);
});

test("a drafting call that never answers: the deadline's timer ends it, 503, nothing posted or marked done", async () => {
  const ai = { calls: 0, run() { ai.calls++; return new Promise(() => {}); } };
  const e = env(ai);
  // Every wait ends at once: so the deadline comes while the model is still silent.
  const atDeadline = () => Promise.resolve();
  const res = await handleReview(await req(goodBody), e, { ...deps, sleep: atDeadline });
  assert.equal(res.status, 503);
  const out = await res.json();
  assert.deepEqual(out, { status: "unavailable", reason: "the review ran out of time before a model answered" });
  assert.equal(out.review, undefined, "nothing to post");
  assert.equal(ai.calls, 1);
  assert.ok(![...e.LEDGER.map.keys()].some((k) => k.startsWith("done:")));
});
