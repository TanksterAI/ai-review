// Model providers behind one interface, so a review can move to the next
// provider when one is out of quota, busy or failing.
//
// Every provider here is free to us and never trains on what we send:
//   - Cloudflare Workers AI: the account's free daily neurons; no training,
//     no retention (developers.cloudflare.com/workers-ai/platform/data-usage).
//   - The Gemini API free tier: for users in the UK, EEA and Switzerland the
//     paid-service data terms apply to the free tier too, so no training
//     (ai.google.dev/gemini-api/terms). Billing on the key's project stays off.
//   - The Anthropic API, paid from the plan's monthly API credit, which stops
//     at zero and never bills; Anthropic may not train on API content
//     (Commercial Terms, B). ANTHROPIC_DAILY_USD_CAP bounds any one day.
//
// A provider is {id, kind, model, scope, label, configured, affordable(chars,
// maxOutput), complete(req)}. complete() returns {text, incomplete, usage,
// neurons?, usd?} or throws ProviderError with a kind:
//   deferred    out of quota until resetAt (the provider is marked exhausted)
//   unavailable busy or overloaded right now
//   failed      anything else
// Secrets come only from Worker secrets (GEMINI_API_KEY, ANTHROPIC_API_KEY);
// no key, no provider.

import {
  createLedger, createUsdLedger, estimateNeurons, exhaustedUntil, markExhausted, neuronsFor,
  nextMidnightIn, nextUtcMidnight,
} from "./budget.js";
import { extractText } from "./review.js";

export class ProviderError extends Error {
  constructor(kind, reason, { resetAt = null, status = null } = {}) {
    super(reason);
    this.kind = kind;
    this.reason = reason;
    this.resetAt = resetAt;
    this.status = status;
  }
}

const CAPACITY_RETRY_MS = 3000;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Dollars per million tokens (platform.claude.com, Oct 2026), for prompts up
// to 100,000 tokens; longer prompts are refused rather than priced higher.
export const ANTHROPIC_PRICES = {
  "claude-haiku-5-5": { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { in: 2.0, out: 10.0, cacheRead: 0.10, cacheWrite: 2.5 },
};
// An unlisted model is estimated at the dearest rate listed here.
const ANTHROPIC_FALLBACK = ANTHROPIC_PRICES["claude-sonnet-5-5"];
const ANTHROPIC_MAX_PROMPT_TOKENS = 90_000;

export function anthropicUsd(model, usage = {}) {
  const p = ANTHROPIC_PRICES[model] ?? ANTHROPIC_FALLBACK;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return (n(usage.input_tokens) * p.in + n(usage.output_tokens) * p.out
    + n(usage.cache_read_input_tokens) * p.cacheRead + n(usage.cache_creation_input_tokens) * p.cacheWrite) / 1e6;
}

/**
 * Parses a chain such as "gemini:gemini-3.5-flash-lite, workers-ai:@cf/zai-org/glm-4.7-flash"
 * into [{kind, model}]. Unknown kinds and empty entries are dropped.
 */
export function parseChain(text) {
  const kinds = new Set(["workers-ai", "gemini", "anthropic"]);
  return String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(":");
    return i > 0 ? { kind: s.slice(0, i).trim(), model: s.slice(i + 1).trim() } : null;
  }).filter((x) => x && kinds.has(x.kind) && x.model);
}

// The verifiers' chains (TAN-299; see verify.js). They live here so the
// capacity check can see them without importing the verifier.
export const DEFAULT_VERIFY_CHAIN = "anthropic:claude-haiku-5-5";
export const DEFAULT_ESCALATE_CHAIN = "anthropic:claude-sonnet-5-5";
export const DEFAULT_VERIFY_FALLBACK = "gemini:gemini-3.5-flash-lite,workers-ai:@cf/openai/gpt-oss-120b,workers-ai:@cf/zai-org/glm-4.7-flash";
// Verdicts are short, but reasoning counts as output.
export const VERIFY_MAX_OUTPUT = 6000;

export function verifyOff(env) {
  return String(env.VERIFY ?? "").trim().toLowerCase() === "off";
}

// Every provider that may verify: VERIFY_CHAIN, then VERIFY_FALLBACK, once each.
export function verifierChain(env) {
  const seen = new Set();
  return [...parseChain(env.VERIFY_CHAIN ?? DEFAULT_VERIFY_CHAIN), ...parseChain(env.VERIFY_FALLBACK ?? DEFAULT_VERIFY_FALLBACK)].filter((x) => {
    const id = `${x.kind}:${x.model}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// The drafting chain: DRAFT_CHAIN when set, else the one Workers AI model
// (MODEL), with Gemini first and Claude last when their keys exist.
export function draftChain(env, cfg) {
  const set = parseChain(env.DRAFT_CHAIN);
  if (set.length) return set;
  return [
    ...(env.GEMINI_API_KEY ? [{ kind: "gemini", model: "gemini-3.5-flash-lite" }] : []),
    { kind: "workers-ai", model: cfg.model },
    ...(env.ANTHROPIC_API_KEY ? [{ kind: "anthropic", model: "claude-haiku-5-5" }] : []),
  ];
}

function retryAfterMs(value, fallback) {
  const s = Number(value);
  if (Number.isFinite(s) && s > 0) return s * 1000;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? ""));
  return m ? Number(m[1]) * 1000 : fallback;
}

// ---------------------------------------------------------------------------

function workersAi(env, cfg, model, deps) {
  const now = deps.now;
  // deps.serial: the review's queue for ledger writes (budget.js).
  const ledger = createLedger(env.LEDGER, now, deps.serial);
  const scope = "workers-ai";
  const gptOss = /gpt-oss/.test(model);
  return {
    id: `workers-ai:${model}`, kind: "workers-ai", model, scope,
    label: `\`${model}\` on Cloudflare Workers AI, free daily allocation; it never bills.`,
    configured: Boolean(env.AI),
    async exhausted() { return exhaustedUntil(env.LEDGER, scope, now()); },
    // The reserve is the whole output allowance: reasoning counts as output.
    async affordable(chars, maxOutput) {
      const estimate = estimateNeurons(model, chars, maxOutput);
      const spent = await ledger.spent();
      if (spent + estimate <= cfg.cap) return { ok: true, spent, estimate };
      return {
        ok: false, spent, estimate, resetAt: nextUtcMidnight(now()),
        reason: `today's review budget is spent (${Math.round(spent)} of ${cfg.cap} neurons; this review needs about ${Math.round(estimate)})`,
      };
    },
    async complete({ system, user, maxOutput, low }) {
      const input = gptOss
        ? { instructions: system, input: user, reasoning: { effort: low ? "low" : cfg.effort }, max_output_tokens: maxOutput }
        : { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxOutput };
      let result;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await env.AI.run(model, input);
          break;
        } catch (e) {
          const message = String(e?.message ?? e);
          deps.log({ ev: "model_error", provider: "workers-ai", model, attempt, error: message.slice(0, 200) });
          if (/\b3036\b|daily free allocation/i.test(message)) {
            // Account-wide: every Workers AI model is out until 00:00 UTC.
            const resetAt = await markExhausted(env.LEDGER, scope, nextUtcMidnight(now()), now());
            throw new ProviderError("deferred", "the account's free Workers AI allocation for today is used up", { resetAt });
          }
          if (/\b3040\b|capacity temporarily exceeded/i.test(message)) {
            // A pause, not CPU: waiting on a timer costs nothing on Workers.
            if (attempt < 2) { await deps.sleep(CAPACITY_RETRY_MS); continue; }
            throw new ProviderError("unavailable", "Workers AI is out of capacity; try again later");
          }
          throw new ProviderError("failed", "the model call failed; try again later");
        }
      }
      const usage = result?.usage ?? {};
      const neurons = Number.isFinite(usage.neurons)
        ? usage.neurons
        : neuronsFor(model, usage.input_tokens ?? usage.prompt_tokens ?? 0, usage.output_tokens ?? usage.completion_tokens ?? 0);
      const spent = await ledger.add(neurons);
      const finish = result?.choices?.[0]?.finish_reason;
      return { text: extractText(result), incomplete: result?.status === "incomplete" || finish === "length", neurons, spent, usage };
    },
  };
}

function gemini(env, model, deps) {
  const now = deps.now;
  const scope = `gemini:${model}`;
  // Gemma on the Gemini API takes no JSON mode; asked in the prompt instead.
  const jsonMode = !/^gemma/i.test(model);
  return {
    id: `gemini:${model}`, kind: "gemini", model, scope,
    label: `\`${model}\` on the Gemini API free tier (UK data terms: no training on our code; billing stays off).`,
    configured: Boolean(env.GEMINI_API_KEY),
    async exhausted() { return exhaustedUntil(env.LEDGER, scope, now()); },
    async affordable() { return { ok: true }; },
    async complete({ system, user, maxOutput, low }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxOutput,
          ...(jsonMode ? { responseMimeType: "application/json" } : {}),
          // A retry after an answer cut short: think as little as the model
          // allows, leaving room to answer. Only Gemini 3 models take a level;
          // Flash-Lite's lowest is "minimal" (its default), the others "low".
          ...(low && /^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: /flash-lite/.test(model) ? "minimal" : "low" } } : {}),
        },
      };
      let res;
      try {
        res = await deps.fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        throw new ProviderError("unavailable", "the Gemini API could not be reached");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = Array.isArray(data?.error?.details) ? data.error.details : [];
        deps.log({ ev: "model_error", provider: "gemini", model, status: res.status, error: String(data?.error?.status ?? "").slice(0, 60) });
        if (res.status === 429) {
          const ids = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations : [])).map((v) => String(v?.quotaId ?? ""));
          if (ids.some((q) => /PerDay/i.test(q))) {
            // Daily quotas reset at midnight Pacific time.
            const resetAt = await markExhausted(env.LEDGER, scope, nextMidnightIn("America/Los_Angeles", now()), now());
            throw new ProviderError("deferred", `the Gemini free tier's daily quota for ${model} is used up`, { resetAt, status: 429 });
          }
          const wait = retryAfterMs(details.find((d) => d?.retryDelay)?.retryDelay, 60_000);
          const resetAt = await markExhausted(env.LEDGER, scope, now() + wait, now());
          throw new ProviderError("unavailable", `the Gemini free tier's rate limit for ${model} was hit`, { resetAt, status: 429 });
        }
        if (res.status >= 500) throw new ProviderError("unavailable", "the Gemini API is unavailable; try again later", { status: res.status });
        throw new ProviderError("failed", "the Gemini API refused the request", { status: res.status });
      }
      const cand = data?.candidates?.[0];
      const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
      const text = parts.filter((p) => !p?.thought && typeof p?.text === "string").map((p) => p.text).join("");
      return { text, incomplete: cand?.finishReason === "MAX_TOKENS", usage: data?.usageMetadata ?? {} };
    },
  };
}

function anthropic(env, cfg, model, deps) {
  const now = deps.now;
  const scope = "anthropic";
  const usd = createUsdLedger(env.LEDGER, now, deps.serial);
  const cap = Number.isFinite(Number(env.ANTHROPIC_DAILY_USD_CAP)) && Number(env.ANTHROPIC_DAILY_USD_CAP) >= 0
    ? Number(env.ANTHROPIC_DAILY_USD_CAP) : 5;
  const price = ANTHROPIC_PRICES[model] ?? ANTHROPIC_FALLBACK;
  return {
    id: `anthropic:${model}`, kind: "anthropic", model, scope,
    label: `\`${model}\` on the Anthropic API, paid from the plan's monthly API credit (no training on our code).`,
    configured: Boolean(env.ANTHROPIC_API_KEY),
    async exhausted() { return exhaustedUntil(env.LEDGER, scope, now()); },
    async affordable(chars, maxOutput) {
      const tokens = Math.ceil(chars / 3);
      if (tokens > ANTHROPIC_MAX_PROMPT_TOKENS) return { ok: false, reason: "the prompt is too long for this provider", resetAt: null };
      const estimate = (tokens * price.in + maxOutput * price.out) / 1e6;
      const spent = await usd.spent();
      if (spent + estimate <= cap) return { ok: true, spent, estimate };
      return { ok: false, spent, estimate, resetAt: nextUtcMidnight(now()), reason: `today's Anthropic budget is spent ($${spent.toFixed(2)} of $${cap.toFixed(2)})` };
    },
    async complete({ system, user, maxOutput, low = false, effort = low ? "low" : cfg.effort, schema = null }) {
      const body = {
        model,
        max_tokens: maxOutput,
        // The instructions are the same for every review: cached, read at a tenth of the price.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { effort, ...(schema ? { format: { type: "json_schema", schema } } : {}) },
      };
      let res;
      try {
        res = await deps.fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        throw new ProviderError("unavailable", "the Anthropic API could not be reached");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const type = String(data?.error?.type ?? "");
        const message = String(data?.error?.message ?? "");
        deps.log({ ev: "model_error", provider: "anthropic", model, status: res.status, error: type.slice(0, 60) });
        if (res.status === 402 || type === "billing_error" || /credit balance/i.test(message)) {
          // The month's credit is spent: look again in six hours (it renews monthly).
          const resetAt = await markExhausted(env.LEDGER, scope, now() + 6 * 3600 * 1000, now());
          throw new ProviderError("deferred", "the plan's Anthropic API credit is used up", { resetAt, status: res.status });
        }
        if (res.status === 400 && /usage limit|spend limit|regain access/i.test(message)) {
          // A workspace or organisation spend limit (the one README.md asks
          // for): "... regain access on <date>". Out until then, or six hours.
          const named = Date.parse(String(/regain access on (.+?)(?:\.\s|\.$|$)/i.exec(message)?.[1] ?? "").replace(/ at /i, " "));
          const until = Number.isFinite(named) && named > now() ? named : now() + 6 * 3600 * 1000;
          const resetAt = await markExhausted(env.LEDGER, scope, until, now());
          throw new ProviderError("deferred", "the Anthropic workspace's spend limit is reached", { resetAt, status: res.status });
        }
        const retryAfter = res.headers?.get?.("retry-after");
        if (res.status === 429 && !retryAfter) {
          // A 429 without retry-after is the usage tier's monthly spend cap.
          const resetAt = await markExhausted(env.LEDGER, scope, now() + 6 * 3600 * 1000, now());
          throw new ProviderError("deferred", "the Anthropic API's spend cap is reached", { resetAt, status: res.status });
        }
        if (res.status === 429 || res.status === 529 || type === "rate_limit_error" || type === "overloaded_error") {
          const wait = retryAfterMs(retryAfter, 60_000);
          throw new ProviderError("unavailable", "the Anthropic API is busy; try again later", { resetAt: now() + wait, status: res.status });
        }
        if (res.status >= 500) throw new ProviderError("unavailable", "the Anthropic API is unavailable; try again later", { status: res.status });
        throw new ProviderError("failed", "the Anthropic API refused the request", { status: res.status });
      }
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
      const cost = anthropicUsd(model, data?.usage);
      const spent = await usd.add(cost);
      return { text, incomplete: data?.stop_reason === "max_tokens", usage: data?.usage ?? {}, usd: cost, spentUsd: spent, capUsd: cap };
    },
  };
}

// The deadline race: the promise's value, or LATE once `deadline` (epoch ms)
// passes. The timer is deps.sleep, so tests control it. Used for every model
// call a review makes, drafting and verifying.
export const LATE = Symbol("late");
export function beforeDeadline(promise, deadline, { now, sleep }) {
  const left = deadline - now();
  return left <= 0 ? Promise.resolve(LATE) : Promise.race([promise, sleep(left).then(() => LATE)]);
}

/** One provider object per chain entry; deps: {now, sleep, fetch, log, serial?}. */
export function createProviders(env, cfg, chain, deps) {
  return chain.map(({ kind, model }) => {
    if (kind === "workers-ai") return workersAi(env, cfg, model, deps);
    if (kind === "gemini") return gemini(env, model, deps);
    return anthropic(env, cfg, model, deps);
  });
}

// Every provider in a chain that could take the work now (ids, in order),
// and for the rest the time each resets. any: whether any is set up at all.
async function available(env, cfg, chain, deps, chars, maxOutput) {
  const ids = [];
  const resets = new Map();
  let any = false;
  for (const p of createProviders(env, cfg, chain, deps)) {
    if (!p.configured) continue;
    any = true;
    const until = await p.exhausted();
    if (until) { resets.set(p.id, until); continue; }
    const a = await p.affordable(chars, maxOutput);
    if (a.ok) ids.push(p.id);
    else if (a.resetAt) resets.set(p.id, a.resetAt);
  }
  return { ids, resets, any };
}

/**
 * Whether a review could run now: a drafter in the chain and, unless
 * VERIFY=off, a verifier that is not that same provider (no model checks its
 * own findings), since findings are never posted unverified. {ok: true,
 * provider}, or {ok: false, retryAt}: both are needed, so the later of the
 * two earliest resets. Used before a runner is dispatched, so none is spent
 * on a review that can only defer.
 */
export async function capacity(env, cfg, chain, deps, chars = 60_000, maxOutput = cfg.maxOutput) {
  const earliest = (resets, skip = new Set()) => {
    const times = [...resets].filter(([id]) => !skip.has(id)).map(([, t]) => t);
    return times.length ? Math.min(...times) : nextUtcMidnight(deps.now());
  };
  const draft = await available(env, cfg, chain, deps, chars, maxOutput);
  // Nothing set up at all is a configuration fault, not a quota: let the
  // review run and fail where it shows, rather than wait for ever.
  const draftOk = draft.ids.length > 0 || !draft.any;
  if (verifyOff(env)) return draftOk ? { ok: true, provider: draft.ids[0] ?? null } : { ok: false, retryAt: earliest(draft.resets) };
  const verify = await available(env, cfg, verifierChain(env), deps, chars, Math.min(maxOutput, VERIFY_MAX_OUTPUT));
  if (!verify.any) return draftOk ? { ok: true, provider: draft.ids[0] ?? null } : { ok: false, retryAt: earliest(draft.resets) };
  // A drafter, and a verifier with another id: two distinct providers.
  const pairs = draft.any ? draft.ids.filter((d) => verify.ids.some((v) => v !== d)) : [null];
  if (pairs.length) return { ok: true, provider: pairs[0] };
  if (!draftOk) {
    const v = verify.ids.length ? -Infinity : earliest(verify.resets);
    return { ok: false, retryAt: Math.max(earliest(draft.resets), v) };
  }
  if (!verify.ids.length) return { ok: false, retryAt: earliest(verify.resets) };
  // The one provider free could draft or verify, not both: wait for any other.
  const only = new Set([...draft.ids, ...verify.ids]);
  return { ok: false, retryAt: earliest(new Map([...draft.resets, ...verify.resets]), only) };
}
