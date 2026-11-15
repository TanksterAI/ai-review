import { test } from "node:test";
import assert from "node:assert/strict";
import { bestOf, growth } from "./helpers.js";

// The timing checks must hold on any machine, fast or slow. So they compare
// the code with itself at two sizes rather than against a fixed number of ms.

test("bestOf warms up once, then keeps the fastest of n timed runs", () => {
  let calls = 0;
  const ms = bestOf(4, () => { calls++; });
  assert.equal(calls, 5, "one warm-up run plus four timed runs");
  assert.ok(ms >= 0 && ms < 5);
});

test("growth passes linear work and catches quadratic work", () => {
  const linear = (n) => { let s = 0; for (let i = 0; i < n * 20_000; i++) s += i; return s; };
  const quadratic = (n) => { let s = 0; for (let i = 0; i < n * 150; i++) for (let j = 0; j < n * 150; j++) s += j; return s; };
  assert.ok(growth(linear) < 8, "4 times the input costs about 4 times the time");
  assert.ok(growth(quadratic) > 8, "4 times the input costs about 16 times the time");
});
