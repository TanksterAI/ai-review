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

test("adds at the same moment are not lost: one ledger, or two sharing a review's serialiser", async () => {
  const { createSerial, createUsdLedger } = await import("../src/budget.js");
  // A store slow enough that unserialised adds would all read the same total.
  const kv = memoryKv();
  const get = kv.get;
  // The read happens first and its answer arrives later, as over a network.
  kv.get = async (k) => { const v = await get(k); await new Promise((r) => setTimeout(r, 2)); return v; };
  const now = () => Date.UTC(2026, 10, 14, 12);
  const one = createLedger(kv, now);
  await Promise.all(Array.from({ length: 10 }, () => one.add(5)));
  assert.equal(await one.spent(), 50);
  // Two ledger objects for the same day key (Haiku's and Sonnet's, say), one review's serialiser.
  const serial = createSerial();
  const a = createUsdLedger(kv, now, serial);
  const b = createUsdLedger(kv, now, serial);
  await Promise.all([a.add(0.25), b.add(0.5), a.add(0.125), b.add(0.125)]);
  assert.equal(await a.spent(), 1);
  // An add of nothing writes nothing, and reads the current total in turn.
  assert.equal(await one.add(0), 50);
});

test("two reviews do not share a serialiser: one review's slow write never holds up another's", async () => {
  const { createSerial, createUsdLedger } = await import("../src/budget.js");
  const kv = memoryKv();
  const get = kv.get;
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  // The first read (review A's) waits until released; the rest answer at once.
  kv.get = async (k) => { const v = await get(k); if (first) { first = false; await held; } return v; };
  const now = () => Date.UTC(2026, 10, 14, 12);
  const reviewA = createUsdLedger(kv, now, createSerial());
  const reviewB = createUsdLedger(kv, now, createSerial());
  let aDone = false;
  const a = reviewA.add(1).then(() => { aDone = true; });
  // B finishes while A is still waiting: they are not on one chain.
  assert.equal(await reviewB.add(2), 2);
  assert.equal(aDone, false);
  // Within one review, the second add waits for the first.
  const serial = createSerial();
  const order = [];
  let releaseC;
  const heldC = new Promise((r) => { releaseC = r; });
  const kv2 = memoryKv();
  const get2 = kv2.get;
  let firstC = true;
  kv2.get = async (k) => { const v = await get2(k); if (firstC) { firstC = false; await heldC; } return v; };
  const c1 = createUsdLedger(kv2, now, serial).add(1).then(() => order.push("c1"));
  const c2 = createUsdLedger(kv2, now, serial).add(1).then(() => order.push("c2"));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, [], "the second add is queued behind the first");
  releaseC();
  await Promise.all([c1, c2]);
  assert.deepEqual(order, ["c1", "c2"]);
  assert.equal(kv2.map.get("usd:2026-11-14"), "2");
  release();
  await a;
});
