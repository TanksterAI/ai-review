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

export function createLedger(kv, nowMs = () => Date.now()) {
  const key = () => `spent:${utcDay(nowMs())}`;
  return {
    async spent() {
      const v = Number(await kv.get(key()));
      return Number.isFinite(v) ? v : 0;
    },
    async add(neurons) {
      if (!(neurons > 0)) return this.spent();
      const k = key();
      const v = Number(await kv.get(k));
      const next = (Number.isFinite(v) ? v : 0) + neurons;
      // Kept two days so a late read near midnight still finds it.
      await kv.put(k, String(next), { expirationTtl: 2 * 24 * 3600 });
      return next;
    },
  };
}
