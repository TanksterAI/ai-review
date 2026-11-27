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
// What GitHub says of the caller's token about the App's repository: "admin"
// (an administrator of the owning organisation's repository), "read", "other-org"
// (an administrator of someone else's repository), "none" (no access) or "bad" (rejected token).
const github = (who) => async (url) => {
  if (!String(url).endsWith("/repos/TanksterAI/ai-review")) return new Response("{}", { status: 404 });
  if (who === "bad") return new Response("{}", { status: 401 });
  if (who === "none") return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ owner: { id: who === "other-org" ? 1 : Number(OWNER_ID) }, permissions: { admin: who !== "read" } }), { status: 200 });
};
const deps = (who = "admin") => ({ now: () => NOW, sleep: (ms) => (ms >= 60_000 ? new Promise(() => {}) : Promise.resolve()), fetch: github(who) });
const body = { title: "t", files: [{ filename: "src/a.js", status: "modified", patch: GROUNDED_PATCH }] };
const req = (b, token = "tok", method = "POST") => new Request("https://x/v1/bench", { method, headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(b) : undefined });

test("cleanChain accepts known providers and plain model ids only", () => {
  assert.equal(cleanChain("anthropic:claude-haiku-5-5, gemini:gemini-3.5-flash-lite"), "anthropic:claude-haiku-5-5,gemini:gemini-3.5-flash-lite");
  assert.equal(cleanChain("workers-ai:@cf/openai/gpt-oss-120b"), "workers-ai:@cf/openai/gpt-oss-120b");
  assert.equal(cleanChain("anthropic:claude-opus-5-5"), null); // no listed price, would be costed as Sonnet
  for (const bad of ["", "openai:gpt", "anthropic:", "anthropic:a b", "anthropic:x;y", "anthropic:a,,", 5, null, Array(9).fill("gemini:g").join(",")]) assert.equal(cleanChain(bad), null, String(bad));
});

test("no token, a bad token and another user's token never reach a model", async () => {
  const a = ai(answer);
  assert.equal((await handleBench(req(body, ""), env(a), deps())).status, 401);
  assert.equal((await handleBench(req(body), env(a), deps("bad"))).status, 401);
  assert.equal((await handleBench(req(body), env(a), deps("none"))).status, 403);
  assert.equal((await handleBench(req(body), env(a), deps("read"))).status, 403);
  assert.equal((await handleBench(req(body), env(a), deps("other-org"))).status, 403);
  assert.equal((await handleBench(req(body), env(a, { OWNER_ID: "" }), deps())).status, 403);
  assert.equal(a.calls.length, 0);
});

test("OWNER_ID is the organisation's id: an administrator of its repository is let in, not compared by user id", async () => {
  const a = ai(answer);
  assert.equal((await handleBench(req(body), env(a), deps("admin"))).status, 200);
  // A look-alike repository setting is ignored; the default repository is asked about.
  assert.equal((await handleBench(req(body), env(a, { BENCH_REPO: "evil/x y" }), deps("admin"))).status, 200);
});

test("an oversized body is refused by the bytes that arrive, before parsing", async () => {
  const a = ai(answer);
  const big = "é".repeat(1_100_000); // 2.2 MB in UTF-8, only 1.1 M code units
  const res = await handleBench(new Request("https://x/v1/bench", { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ title: big, files: [] }) }), env(a), deps());
  assert.equal(res.status, 413);
  const declared = new Request("https://x/v1/bench", { method: "POST", headers: { authorization: "Bearer tok", "content-length": "9999999" }, body: "{}" });
  assert.equal((await handleBench(declared, env(a), deps())).status, 413);
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

test("a draft that spent tokens and gave no usable answer still reports its spend", async () => {
  const a = ai("this is not json");
  const res = await handleBench(req(body), env(a), deps());
  assert.equal(res.status, 502);
  const out = await res.json();
  assert.equal(out.usage.drafting.neurons, 66);
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
    if (String(url).endsWith("/repos/TanksterAI/ai-review")) return github("admin")(url);
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
    assert.equal(out.hidden.length, 1 - expected);
    if (!expected) assert.deepEqual([out.hidden[0].stage, out.hidden[0].path, out.hidden[0].line, out.hidden[0].status], ["verification", "src/a.js", 3, "refuted"]);
    assert.ok(out.verified.calls >= 1);
  }
});

test("a finding the grounding gate drops is returned with its stage and reason, not only counted", async () => {
  const ungrounded = JSON.stringify({ summary: "x", findings: [{ path: "src/a.js", line: 3, severity: "major", category: "bug", title: "Invented", evidence: "this text is nowhere in the diff", body: "nope" }] });
  const out = await (await handleBench(req(body), env(ai(ungrounded)), deps())).json();
  assert.equal(out.drafted.dropped_by_grounding, 1);
  assert.equal(out.dropped.length, 1);
  assert.deepEqual([out.dropped[0].stage, out.dropped[0].path, out.dropped[0].title], ["grounding", "src/a.js", "Invented"]);
  assert.ok(out.dropped[0].reason.length > 0);
  assert.deepEqual(out.shown, []);
});
