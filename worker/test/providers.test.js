import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, anthropicUsd, capacity, createProviders, draftChain, parseChain } from "../src/providers.js";
import { exhaustedUntil, markExhausted, nextMidnightIn, nextUtcMidnight } from "../src/budget.js";
import { config } from "../src/config.js";
import { memoryKv, responsesResult } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 14, 2, 30); // 18:30 Pacific on 13 Nov
const cfg = config({});

function fakeFetch(steps) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (s instanceof Error) throw s;
    return {
      ok: s.status >= 200 && s.status < 300,
      status: s.status,
      headers: { get: (h) => (s.headers ?? {})[h.toLowerCase()] ?? null },
      async json() { return s.body; },
    };
  };
  f.calls = calls;
  return f;
}
const deps = (fetch, logs = []) => ({ now: () => NOW, sleep: async () => {}, fetch, log: (e) => logs.push(e) });
const one = (env, kind, model, fetch) => createProviders(env, cfg, [{ kind, model }], deps(fetch))[0];
const req = { system: "sys", user: "diff", maxOutput: 1000 };
const reject = async (p, kind) => {
  try { await p; } catch (e) { assert.ok(e instanceof ProviderError, String(e)); assert.equal(e.kind, kind, e.reason); return e; }
  assert.fail("expected a ProviderError");
};

test("chains: parsed from DRAFT_CHAIN, or built from the keys that exist", () => {
  assert.deepEqual(parseChain(" gemini:gemini-3.5-flash-lite, workers-ai:@cf/zai-org/glm-4.7-flash,bogus:x, anthropic: ,anthropic:claude-haiku-5-5"), [
    { kind: "gemini", model: "gemini-3.5-flash-lite" },
    { kind: "workers-ai", model: "@cf/zai-org/glm-4.7-flash" },
    { kind: "anthropic", model: "claude-haiku-5-5" },
  ]);
  assert.deepEqual(draftChain({}, cfg), [{ kind: "workers-ai", model: cfg.model }]);
  assert.deepEqual(draftChain({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }, cfg).map((x) => x.kind), ["gemini", "workers-ai", "anthropic"]);
  assert.deepEqual(draftChain({ DRAFT_CHAIN: "anthropic:claude-haiku-5-5" }, cfg), [{ kind: "anthropic", model: "claude-haiku-5-5" }]);
});

test("Gemini: the key goes in a header, JSON mode except for Gemma, thoughts are left out", async () => {
  const env = { GEMINI_API_KEY: "k", LEDGER: memoryKv() };
  const ok = { status: 200, body: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "plan", thought: true }, { text: '{"summary":"s",' }, { text: '"findings":[]}' }] } }], usageMetadata: { promptTokenCount: 5 } } };
  const f = fakeFetch([ok]);
  const r = await one(env, "gemini", "gemini-3.5-flash-lite", f).complete(req);
  assert.equal(r.text, '{"summary":"s","findings":[]}');
  assert.equal(r.incomplete, false);
  assert.equal(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  assert.equal(f.calls[0].init.headers["x-goog-api-key"], "k");
  assert.ok(!f.calls[0].url.includes("key="), "never in the URL");
  assert.equal(f.calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.equal(f.calls[0].body.systemInstruction.parts[0].text, "sys");
  const g = fakeFetch([{ status: 200, body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }] } }]);
  const cut = await one(env, "gemini", "gemma-4-31b-it", g).complete(req);
  assert.equal(cut.incomplete, true);
  assert.equal(g.calls[0].body.generationConfig.responseMimeType, undefined);
  assert.equal(one({}, "gemini", "x", f).configured, false);
});

test("Gemini: a daily quota defers to midnight Pacific; a minute limit is busy; errors are typed", async () => {
  const env = { GEMINI_API_KEY: "k", LEDGER: memoryKv() };
  const day = { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } } };
  const e = await reject(one(env, "gemini", "gemini-3.5-flash-lite", fakeFetch([day])).complete(req), "deferred");
  assert.equal(e.resetAt, Date.UTC(2026, 10, 14, 8, 0));
  assert.equal(await exhaustedUntil(env.LEDGER, "gemini:gemini-3.5-flash-lite", NOW), e.resetAt);
  // Another model's quota is its own.
  assert.equal(await exhaustedUntil(env.LEDGER, "gemini:gemma-4-31b-it", NOW), null);
  const minute = { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }] } } };
  const b = await reject(one(env, "gemini", "gemma-4-31b-it", fakeFetch([minute])).complete(req), "unavailable");
  assert.equal(b.resetAt, NOW + 90_000);
  await reject(one(env, "gemini", "m", fakeFetch([{ status: 503, body: {} }])).complete(req), "unavailable");
  await reject(one(env, "gemini", "m", fakeFetch([{ status: 400, body: { error: { status: "INVALID_ARGUMENT" } } }])).complete(req), "failed");
  await reject(one(env, "gemini", "m", fakeFetch([new Error("network")])).complete(req), "unavailable");
});

test("Anthropic: cached instructions, effort not temperature, cost recorded against the daily cap", async () => {
  const env = { ANTHROPIC_API_KEY: "sk", LEDGER: memoryKv(), ANTHROPIC_DAILY_USD_CAP: "2" };
  const body = { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: '{"summary":"s"}' }], stop_reason: "end_turn", usage: { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 1_000 } };
  const f = fakeFetch([{ status: 200, body }]);
  const p = one(env, "anthropic", "claude-haiku-5-5", f);
  const r = await p.complete({ ...req, effort: "low" });
  assert.equal(r.text, '{"summary":"s"}');
  const usd = (10_000 * 0.10 + 2_000 * 0.50 + 1_000 * 0.01) / 1e6;
  assert.ok(Math.abs(r.usd - usd) < 1e-12);
  assert.ok(Math.abs(anthropicUsd("claude-haiku-5-5", body.usage) - usd) < 1e-12);
  assert.equal(env.LEDGER.map.get("usd:2026-11-14"), String(usd));
  const sent = f.calls[0];
  assert.equal(sent.init.headers["x-api-key"], "sk");
  assert.equal(sent.init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(sent.body.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(sent.body.output_config, { effort: "low" });
  assert.equal(sent.body.temperature, undefined, "Claude 5.5 models refuse temperature");
  // The cap: $2 a day. An estimate past it is refused before any call.
  assert.equal((await p.affordable(3000, 1000)).ok, true);
  env.LEDGER.map.set("usd:2026-11-14", "1.9999");
  const no = await p.affordable(60_000, 1000);
  assert.equal(no.ok, false);
  assert.equal(no.resetAt, nextUtcMidnight(NOW));
  // Longer than the cheap tier: never priced higher, just refused.
  assert.equal((await p.affordable(400_000, 10)).resetAt, null);
  // An unknown model is priced at the dearest rate.
  assert.equal(anthropicUsd("claude-x", { input_tokens: 1e6 }), 2);
});

test("Anthropic: spent credit defers and marks the provider; busy is unavailable", async () => {
  const env = { ANTHROPIC_API_KEY: "sk", LEDGER: memoryKv() };
  const credit = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };
  const e = await reject(one(env, "anthropic", "claude-haiku-5-5", fakeFetch([credit])).complete(req), "deferred");
  assert.equal(await exhaustedUntil(env.LEDGER, "anthropic", NOW), e.resetAt);
  assert.ok(e.resetAt > NOW);
  const busy = await reject(one(env, "anthropic", "claude-haiku-5-5", fakeFetch([{ status: 429, headers: { "retry-after": "30" }, body: { error: { type: "rate_limit_error" } } }])).complete(req), "unavailable");
  assert.equal(busy.resetAt, NOW + 30_000);
  await reject(one(env, "anthropic", "m", fakeFetch([{ status: 529, body: { error: { type: "overloaded_error" } } }])).complete(req), "unavailable");
  await reject(one(env, "anthropic", "m", fakeFetch([{ status: 401, body: { error: { type: "authentication_error" } } }])).complete(req), "failed");
});

test("Workers AI: chat models take messages; 3036 marks every Workers AI model out until 00:00 UTC", async () => {
  const calls = [];
  const env = { LEDGER: memoryKv(), AI: { async run(model, input) { calls.push({ model, input }); return { choices: [{ message: { content: "{}" }, finish_reason: "length" }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }; } } };
  const r = await one(env, "workers-ai", "@cf/zai-org/glm-4.7-flash", null).complete(req);
  assert.deepEqual(calls[0].input, { messages: [{ role: "system", content: "sys" }, { role: "user", content: "diff" }], max_tokens: 1000 });
  assert.equal(r.text, "{}");
  assert.equal(r.incomplete, true);
  assert.equal(r.neurons, 5_500);
  const out = { LEDGER: memoryKv(), AI: { async run() { throw new Error("AiError: 3036: daily free allocation used"); } } };
  const e = await reject(one(out, "workers-ai", "@cf/zai-org/glm-4.7-flash", null).complete(req), "deferred");
  assert.equal(e.resetAt, nextUtcMidnight(NOW));
  assert.equal(await exhaustedUntil(out.LEDGER, "workers-ai", NOW), nextUtcMidnight(NOW));
  // gpt-oss keeps the Responses-API shape.
  const g = { LEDGER: memoryKv(), AI: { async run(model, input) { calls.push({ model, input }); return responsesResult("{}"); } } };
  await one(g, "workers-ai", "@cf/openai/gpt-oss-120b", null).complete({ ...req, low: true });
  assert.deepEqual(calls.at(-1).input.reasoning, { effort: "low" });
});

test("capacity: any provider able to review now, else the earliest reset; nothing set up never holds", async () => {
  const kv = memoryKv();
  const env = { LEDGER: kv, AI: {}, GEMINI_API_KEY: "k", DRAFT_CHAIN: "gemini:a,workers-ai:@cf/zai-org/glm-4.7-flash" };
  const chain = draftChain(env, cfg);
  assert.deepEqual(await capacity(env, cfg, chain, deps(null)), { ok: true, provider: "gemini:a" });
  await markExhausted(kv, "gemini:a", NOW + 5 * 3600_000, NOW);
  assert.equal((await capacity(env, cfg, chain, deps(null))).provider, "workers-ai:@cf/zai-org/glm-4.7-flash");
  kv.map.set("spent:2026-11-14", "6000");
  assert.deepEqual(await capacity(env, cfg, chain, deps(null)), { ok: false, retryAt: NOW + 5 * 3600_000 });
  await markExhausted(kv, "gemini:a", NOW + 30 * 3600_000, NOW);
  assert.deepEqual(await capacity(env, cfg, chain, deps(null)), { ok: false, retryAt: nextUtcMidnight(NOW) });
  assert.deepEqual(await capacity({ LEDGER: kv }, cfg, [{ kind: "gemini", model: "a" }], deps(null)), { ok: true, provider: null });
});

test("next midnight in a time zone follows the clock changes", () => {
  assert.equal(nextMidnightIn("America/Los_Angeles", NOW), Date.UTC(2026, 10, 14, 8));
  assert.equal(nextMidnightIn("America/Los_Angeles", Date.UTC(2026, 2, 8, 1)), Date.UTC(2026, 2, 8, 8));
  assert.equal(nextMidnightIn("America/Los_Angeles", Date.UTC(2026, 2, 8, 12)), Date.UTC(2026, 2, 9, 7));
  assert.equal(nextMidnightIn("UTC", NOW), nextUtcMidnight(NOW));
});

test("Anthropic: a workspace spend limit and the tier's spend cap defer, and mark the provider out", async () => {
  const env = { ANTHROPIC_API_KEY: "sk", LEDGER: memoryKv() };
  const ws = { status: 400, body: { error: { type: "invalid_request_error", message: "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." } } };
  const e = await reject(one(env, "anthropic", "claude-haiku-5-5", fakeFetch([ws])).complete(req), "deferred");
  assert.equal(e.resetAt, Date.UTC(2026, 11, 1));
  assert.equal(await exhaustedUntil(env.LEDGER, "anthropic", NOW), Date.UTC(2026, 11, 1));
  const env2 = { ANTHROPIC_API_KEY: "sk", LEDGER: memoryKv() };
  const odd = { status: 400, body: { error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } } };
  const e2 = await reject(one(env2, "anthropic", "claude-haiku-5-5", fakeFetch([odd])).complete(req), "deferred");
  assert.equal(e2.resetAt, NOW + 6 * 3600_000);
  const env3 = { ANTHROPIC_API_KEY: "sk", LEDGER: memoryKv() };
  const tier = { status: 429, body: { error: { type: "rate_limit_error", message: "monthly spend" } } };
  await reject(one(env3, "anthropic", "claude-haiku-5-5", fakeFetch([tier])).complete(req), "deferred");
  assert.ok(await exhaustedUntil(env3.LEDGER, "anthropic", NOW));
  // capacity() then sees Anthropic as out.
  const cap = await capacity(env3, cfg, [{ kind: "anthropic", model: "claude-haiku-5-5" }], deps(null));
  assert.equal(cap.ok, false);
});

test("a retry after an answer cut short asks for less thinking, on every provider", async () => {
  const a = fakeFetch([{ status: 200, body: { content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", usage: {} } }]);
  const p = one({ ANTHROPIC_API_KEY: "sk", LEDGER: memoryKv() }, "anthropic", "claude-haiku-5-5", a);
  assert.equal((await p.complete(req)).incomplete, true);
  await p.complete({ ...req, low: true });
  assert.equal(a.calls[0].body.output_config.effort, cfg.effort);
  assert.equal(a.calls[1].body.output_config.effort, "low");
  const g = fakeFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: "{}" }] } }] } }]);
  const gp = one({ GEMINI_API_KEY: "k", LEDGER: memoryKv() }, "gemini", "gemini-3.5-flash-lite", g);
  await gp.complete(req);
  await gp.complete({ ...req, low: true });
  assert.equal(g.calls[0].body.generationConfig.thinkingConfig, undefined);
  assert.deepEqual(g.calls[1].body.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
  const h = fakeFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: "{}" }] } }] } }]);
  await one({ GEMINI_API_KEY: "k", LEDGER: memoryKv() }, "gemini", "gemini-3.6-flash", h).complete({ ...req, low: true });
  await one({ GEMINI_API_KEY: "k", LEDGER: memoryKv() }, "gemini", "gemini-2.5-flash", h).complete({ ...req, low: true });
  assert.deepEqual(h.calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: "low" });
  assert.equal(h.calls[1].body.generationConfig.thinkingConfig, undefined, "only Gemini 3 takes a level");
});
