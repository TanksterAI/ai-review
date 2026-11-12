import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger, estimateNeurons, neuronsFor, utcDay } from "../src/budget.js";
import { memoryKv } from "./helpers.js";

test("neuron maths follows the published rates, and unknown models get the dearest", () => {
  assert.equal(neuronsFor("@cf/openai/gpt-oss-120b", 1_000_000, 0), 31_818);
  assert.equal(neuronsFor("@cf/openai/gpt-oss-120b", 0, 1_000_000), 68_182);
  assert.equal(neuronsFor("@cf/zai-org/glm-4.7-flash", 1_000_000, 1_000_000), 5_500 + 36_400);
  assert.equal(neuronsFor("@cf/unknown/model", 1_000_000, 0), 31_818);
  // 90k characters of diff and a 3k-token reserve: about 1,150 neurons.
  const e = estimateNeurons("@cf/openai/gpt-oss-120b", 90_000, 3000);
  assert.ok(e > 1100 && e < 1200, String(e));
});

test("the ledger is per UTC day", async () => {
  let t = Date.UTC(2026, 10, 12, 23, 59);
  const kv = memoryKv();
  const ledger = createLedger(kv, () => t);
  assert.equal(await ledger.spent(), 0);
  assert.equal(await ledger.add(100.5), 100.5);
  assert.equal(await ledger.add(0), 100.5);
  assert.equal(await ledger.add(-5), 100.5);
  assert.equal(await ledger.spent(), 100.5);
  t += 2 * 60 * 1000;
  assert.equal(await ledger.spent(), 0);
  assert.equal(utcDay(t), "2026-11-13");
  assert.ok(kv.map.has("spent:2026-11-12"));
});
