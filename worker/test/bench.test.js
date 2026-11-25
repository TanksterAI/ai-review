import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleBench, cleanChain } from "../src/bench.js";
import { memoryKv, responsesResult, GROUNDED_PATCH, OWNER_ID } from "./helpers.js";

const NOW = 1_794_500_000_000;
const answer = JSON.stringify({
  summary: "Adds y.",
  findings: [{ path: "src/a.js", line: 3, severity: "major", category: "bug", title: "Division by zero", evidence: "const ratio = total / 0;", body: "Guard it." }],
});
const ai = (text) => { const calls = []; return { calls, async run(model, input) { calls.push({ model, input }); return responsesResult(text); } }; };
const env = (a, over = {}) => ({ OWNER_ID, DAILY_NEURON_CAP: "6000", VERIFY: "off", LEDGER: memoryKv(), AI: a, DRAFT_CHAIN: "workers-ai:@cf/openai/gpt-oss-120b", ...over });
const github = (id) => async (url) => (String(url).endsWith("/user") ? new Response(JSON.stringify({ id }), { status: id ? 200 : 401 }) : new Response("{}", { status: 404 }));
const deps = (id = Number(OWNER_ID)) => ({ now: () => NOW, sleep: (ms) => (ms >= 60_000 ? new Promise(() => {}) : Promise.resolve()), fetch: github(id) });
const body = { title: "t", files: [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }] };
const req = (b, token = "tok", method = "POST") => new Request("https://x/v1/bench", { method, headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(b) : undefined });

test("cleanChain accepts known providers and plain model ids only", () => {
  assert.equal(cleanChain("anthropic:claude-haiku-5-5, gemini:gemini-3.5-flash-lite"), "anthropic:claude-haiku-5-5,gemini:gemini-3.5-flash-lite");
  assert.equal(cleanChain("workers-ai:@cf/openai/gpt-oss-120b"), "workers-ai:@cf/openai/gpt-oss-120b");
  for (const bad of ["", "openai:gpt", "anthropic:", "anthropic:a b", "anthropic:x;y", "anthropic:a,,", 5, null, Array(9).fill("gemini:g").join(",")]) assert.equal(cleanChain(bad), null, String(bad));
});

test("no token, a bad token and another user's token never reach a model", async () => {
  const a = ai(answer);
  assert.equal((await handleBench(req(body, ""), env(a), deps())).status, 401);
  assert.equal((await handleBench(req(body), env(a), deps(0))).status, 401);
  assert.equal((await handleBench(req(body), env(a), deps(42))).status, 403);
  assert.equal((await handleBench(req(body), env(a, { OWNER_ID: "" }), deps())).status, 403);
  assert.equal(a.calls.length, 0);
});

test("only POST, and bad bodies and chains are refused", async () => {
  const a = ai(answer);
  assert.equal((await handleBench(req(null, "tok", "GET"), env(a), deps())).status, 405);
  assert.equal((await handleBench(req({ files: [] }), env(a), deps())).status, 400);
  assert.equal((await handleBench(req({ ...body, chain: "evil:model" }), env(a), deps())).status, 400);
  assert.equal((await handleBench(req({ ...body, verify_chain: "x" }), env(a), deps())).status, 400);
  const notJson = new Request("https://x/v1/bench", { method: "POST", headers: { authorization: "Bearer tok" }, body: "nope" });
  assert.equal((await handleBench(notJson, env(a), deps())).status, 400);
  assert.equal(a.calls.length, 0);
});

test("a benchmark drafts with the chosen chain, reports what each stage kept, and posts nothing", async () => {
  const a = ai(answer);
  const e = env(a, { DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite" });
  const res = await handleBench(req({ ...body, chain: "workers-ai:@cf/openai/gpt-oss-120b" }), e, deps());
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.status, "benched");
  assert.equal(out.drafter, "workers-ai:@cf/openai/gpt-oss-120b");
  assert.deepEqual(out.drafted, { raw: 1, kept_after_grounding: 1, dropped_by_grounding: 0 });
  assert.equal(out.verified, null);
  assert.deepEqual(out.shown.map((f) => [f.path, f.line, f.severity]), [["src/a.js", 3, "major"]]);
  assert.equal(a.calls.length, 1);
  // No review is marked done: only the spend ledger is written.
  assert.ok([...e.LEDGER.map.keys()].every((k) => k.startsWith("spent:")), [...e.LEDGER.map.keys()].join());
});

test("an empty answer reports zero findings; nothing reviewable is a skip", async () => {
  const out = await (await handleBench(req(body), env(ai(JSON.stringify({ summary: "ok", findings: [] }))), deps())).json();
  assert.deepEqual(out.drafted, { raw: 0, kept_after_grounding: 0, dropped_by_grounding: 0 });
  const skipped = await (await handleBench(req({ files: [{ filename: "package-lock.json", status: "modified", patch: GROUNDED_PATCH }] }), env(ai(answer)), deps())).json();
  assert.equal(skipped.status, "skipped");
});

test("no configured model is a failure with the reason, not a crash", async () => {
  const res = await handleBench(req({ ...body, chain: "gemini:gemini-3.5-flash-lite" }), env(ai(answer)), deps());
  assert.equal(res.status, 502);
  assert.equal((await res.json()).status, "failed");
});

test("the router sends /v1/bench to the benchmark", async () => {
  const res = await worker.fetch(new Request("https://x/v1/bench", { method: "GET" }), env(ai(answer)));
  assert.equal(res.status, 405);
});

test("with verification on, the verifier's verdicts decide what is shown, and its spend is reported", async () => {
  const verdict = (v) => async (url, init) => {
    if (String(url).endsWith("/user")) return new Response(JSON.stringify({ id: Number(OWNER_ID) }), { status: 200 });
    const text = JSON.parse(init.body).messages[0].content;
    const ids = [...text.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    const out = ids.map((id) => ({ id, verdict: v, severity: "major", suggestion_ok: true, prompt_ok: true, reason: "checked" }));
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return { content: [{ type: "text", text: JSON.stringify({ verdicts: out }) }], stop_reason: "end_turn", usage: { input_tokens: 4000, output_tokens: 100 } }; } };
  };
  for (const [v, expected] of [["confirmed", 1], ["refuted", 0]]) {
    const e = env(ai(answer), { VERIFY: undefined, ANTHROPIC_API_KEY: "sk", VERIFY_CHAIN: "anthropic:claude-haiku-5-5" });
    const res = await handleBench(req(body), e, { ...deps(), fetch: verdict(v) });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.shown.length, expected, v);
    assert.equal(out.verified.hidden, 1 - expected);
    assert.ok(out.verified.calls >= 1);
  }
});
