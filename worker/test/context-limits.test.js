import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GUIDE_BLOB_BYTES, MAX_TEST_BLOB_BYTES, batchContext, changedSymbols, excerpt, indexTests, pickGuidelines, redact, testsFor } from "../src/context.js";
import { buildPrompt } from "../src/review.js";
import { verifierPrompt } from "../src/verify.js";

const blob = (path, size = 100, c = "1") => ({ type: "blob", path, sha: String(c).repeat(40).slice(0, 40), size });

test("a blanked private key keeps its line breaks, so the lines after it are numbered truly", () => {
  const text = ["a", "-----BEGIN PRIVATE KEY-----", "AAAA", "BBBB", "-----END PRIVATE KEY-----", "const z = 1;"].join("\n");
  const out = redact(text);
  assert.equal(out.split("\n").length, text.split("\n").length);
  assert.equal(out.split("\n")[5], "const z = 1;");
  assert.match(excerpt(out, [6], 1000).text, /6\| const z = 1;/);
});

test("excerpt never returns a cut marker that does not fit, and the batch stays within its cap", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  for (const cap of [0, 1, 10, 36, 37, 60]) assert.ok(excerpt(text, [25], cap).text.length <= cap, `cap ${cap}`);
  assert.equal(excerpt("x", [1], 0).text, "");
  const data = { files: new Map([["src/a.js", "const a = 1;\nconst b = 2;\nconst c = 3;"]]), tests: new Map(), callers: new Map() };
  const prepared = { included: ["src/a.js"], shown: new Map([["src/a.js", new Set([2])]]) };
  for (const cap of [1, 50, 200]) assert.ok(batchContext(data, prepared, cap).text.length <= cap, `batch cap ${cap}`);
});

test("guidelines and tests too big to be worth fetching are not picked", () => {
  const picked = pickGuidelines([blob("CLAUDE.md", MAX_GUIDE_BLOB_BYTES + 1), blob("AGENTS.md", MAX_GUIDE_BLOB_BYTES)], []);
  assert.deepEqual(picked.map((g) => g.path), ["AGENTS.md"]);
  const index = indexTests([blob("test/a.test.js", MAX_TEST_BLOB_BYTES + 1, "2"), blob("test2/a.test.js", MAX_TEST_BLOB_BYTES, "3")]);
  assert.deepEqual(testsFor(index, "src/a.js").map((e) => e.path), ["test2/a.test.js"]);
});

test("the verifier is told a test that only runs the code, or asserts the fault, refutes nothing", () => {
  const p = verifierPrompt({ title: "t", body: "b", diff: "d", findings: [], tag: "t1", context: { guide: "G", files: "F" } });
  assert.match(p.system, /a test asserts the opposite of the claim/);
  assert.match(p.system, /only runs the code, or that asserts the faulty result, does not refute a claim/);
});

test("the drafter may name an identifier that is only in the context, and only when there is context", () => {
  const prepared = { text: "### src/a.js (modified, +1 -0)\n2 + const b = 2;\n", omitted: [], elsewhere: [] };
  const base = { repository: "TanksterAI/x", title: "t", body: "b", prepared, tag: "tag1" };
  const withContext = buildPrompt({ ...base, context: { text: "x", guide: "", filesText: "x" } });
  assert.match(withContext.instructions, /identifier that appears only in the context/);
  assert.doesNotMatch(buildPrompt(base).instructions, /appears only in the context/);
});

test("a test whose size is unknown is not fetched, and a name over the search limit is not searched for", () => {
  const index = indexTests([{ type: "blob", path: "test/a.test.js", sha: "4".repeat(40) }, blob("test2/a.test.js", 1, "5")].map((e) => ({ ...e, size: Number(e.size) || 0 })));
  assert.deepEqual(testsFor(index, "src/a.js").map((e) => e.path), ["test2/a.test.js"]);
  const patch = (n) => `@@ -0,0 +1 @@\n+export function ${"a".repeat(n)}() {}`;
  assert.deepEqual(changedSymbols(patch(80)), ["a".repeat(80)]);
  assert.deepEqual(changedSymbols(patch(81)), []);
});
