// Daily neuron budget for reviews, kept in KV.
//
// Workers AI gives the account 10,000 neurons a day free; on the Workers Free
// plan it refuses work past that and never bills. This ledger keeps reviews
// to their own share (DAILY_NEURON_CAP) so other Workers on the account that
// use Workers AI still have room. KV is eventually consistent, so two
// simultaneous reviews can overshoot the cap by one review; Cloudflare's own
// hard limit is the backstop.

// Per-model rates in neurons per million tokens, from
// https://developers.cloudflare.com/workers-ai/platform/pricing/ (Oct 2026).
export const RATES = {
  "@cf/openai/gpt-oss-120b": { in: 31_818, out: 68_182 },
  "@cf/zai-org/glm-4.7-flash": { in: 5_500, out: 36_400 },
  "@cf/google/gemma-4-26b-a4b-it": { in: 9_091, out: 27_273 },
};
// An unlisted model is estimated at the dearest rate here, never the cheapest.
const FALLBACK = { in: 31_818, out: 68_182 };

export function utcDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function neuronsFor(model, inputTokens, outputTokens) {
  const r = RATES[model] ?? FALLBACK;
  return (inputTokens * r.in + outputTokens * r.out) / 1e6;
}

// Characters per token is about 3.5-4 for code; 3 errs on the side of
// reserving too much.
export function estimateNeurons(model, inputChars, outputReserveTokens) {
  return neuronsFor(model, Math.ceil(inputChars / 3), outputReserveTokens);
}

// Adds run one at a time: a read, then a write, so two adds at once (the
// verifier's batches run concurrently) would lose one. A serialiser is a
// queue for that; runReview makes one per review and hands it to every
// provider's ledger (deps.serial), so ledgers on the same day key take turns
// within the review, and nothing is shared between reviews. A ledger made
// without one gets its own. Across reviews and isolates KV stays eventually
// consistent (see README.md, "Budget accuracy").
export function createSerial() {
  let last = Promise.resolve();
  return (work) => {
    const run = last.then(work);
    last = run.catch(() => {});
    return run;
  };
}

function dailyLedger(kv, prefix, nowMs, serial) {
  const key = () => `${prefix}:${utcDay(nowMs())}`;
  const read = async (k) => {
    const v = Number(await kv.get(k));
    return Number.isFinite(v) ? v : 0;
  };
  return {
    async spent() {
      return read(key());
    },
    add(amount) {
      return serial(async () => {
        const k = key();
        if (!(amount > 0)) return read(k);
        const next = (await read(k)) + amount;
        // Kept two days so a late read near midnight still finds it.
        await kv.put(k, String(next), { expirationTtl: 2 * 24 * 3600 });
        return next;
      });
    },
  };
}

export function createLedger(kv, nowMs = () => Date.now(), serial = createSerial()) {
  return dailyLedger(kv, "spent", nowMs, serial);
}

// Dollars a day on a paid-from-credit provider (the Anthropic API), kept apart
// from neurons. The plan's monthly credit stops requests at zero and never
// bills; this cap stops any one day from spending the month.
export function createUsdLedger(kv, nowMs = () => Date.now(), serial = createSerial()) {
  return dailyLedger(kv, "usd", nowMs, serial);
}

// A provider (or one of its models) that said it is out of quota, until the
// time it resets. The value is the reset time, compared on read, so the flag
// is right whatever KV's expiry does; the TTL only cleans up.
export async function markExhausted(kv, scope, untilMs, nowMs) {
  const until = Math.max(untilMs, nowMs + 60_000);
  await kv.put(`ex:${scope}`, String(until), { expiration: Math.ceil(until / 1000) + 60 });
  return until;
}

export async function exhaustedUntil(kv, scope, nowMs) {
  const v = Number(await kv.get(`ex:${scope}`));
  return Number.isFinite(v) && v > nowMs ? v : null;
}

export function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// The next midnight in an IANA time zone (Gemini's daily quotas reset at
// midnight Pacific time), as epoch milliseconds.
export function nextMidnightIn(timeZone, nowMs) {
  const offsetMs = (ms) => {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000 : 0;
  };
  const day = 24 * 3600 * 1000;
  const local = nowMs + offsetMs(nowMs);
  const nextLocal = Math.floor(local / day) * day + day;
  // The offset at the target instant, for the nights the clocks change.
  const guess = nextLocal - offsetMs(nowMs);
  return nextLocal - offsetMs(guess);
}
