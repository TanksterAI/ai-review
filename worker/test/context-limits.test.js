import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GLOB_STARS, MAX_GUIDE_BLOB_BYTES, MAX_SCOPE_PATH, MAX_TEST_BLOB_BYTES, batchContext, changedSymbols, contextLine, excerpt, globToRegExp, guideText, indexTests, parseTree, pickGuidelines, redact, ruleScope, testsFor } from "../src/context.js";
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

test("a test whose size is unknown is not fetched", () => {
  const entries = parseTree({ tree: [{ type: "blob", path: "test/a.test.js", sha: "4".repeat(40) }, { type: "blob", path: "test2/a.test.js", sha: "5".repeat(40), size: 1 }] });
  assert.deepEqual(testsFor(indexTests(entries), "src/a.js").map((e) => e.path), ["test2/a.test.js"]);
});

test("a name over the search limit is not searched for, and one at the limit is", () => {
  const patch = (n) => `@@ -0,0 +1 @@\n+export function ${"a".repeat(n)}() {}`;
  assert.deepEqual(changedSymbols(patch(80)), ["a".repeat(80)]);
  assert.deepEqual(changedSymbols(patch(81)), []);
});

test("the whole context, guidelines, files, tests and callers together, never goes over its cap, whatever the cap", () => {
  const lines = (n, w) => Array.from({ length: n }, (_, i) => `const v${i} = ${w}${i};`).join("\n");
  const data = {
    guidelines: [{ path: "CLAUDE.md", dir: "", text: "Rule one.\n".repeat(60) }, { path: "src/AGENTS.md", dir: "src", text: "Rule two.\n".repeat(40) }],
    files: new Map([["src/a.js", lines(80, "1")], ["src/b.js", lines(5, "2")]]),
    tests: new Map([["src/a.js", [{ path: "test/a.test.js", text: "t".repeat(300) }]], ["a.js", [{ path: "a.test.js", text: "x" }]]]),
    callers: new Map([["src/b.js", [{ symbol: "useB", hits: [{ path: "src/c.js", fragment: "useB();".repeat(30) }] }]]]),
  };
  const prepared = { included: ["src/a.js", "src/b.js", "a.js"], shown: new Map([["src/a.js", new Set([40])], ["src/b.js", new Set([2])]]) };
  for (let cap = 0; cap <= 1500; cap++) assert.ok(batchContext(data, prepared, cap).text.length <= cap, `cap ${cap}`);
  // The example that went over: only a test for one file, and a cap of 3.
  const only = { tests: new Map([["a.js", [{ path: "a.test.js", text: "x" }]]]) };
  for (const cap of [0, 1, 3, 6, 7, 8, 12]) assert.ok(batchContext(only, { included: ["a.js"] }, cap).text.length <= cap, `tests only, cap ${cap}`);
});

test("the counts of tests and callers are those shown, not those found", () => {
  const data = {
    tests: new Map([["a.js", [{ path: "one.test.js", text: "x".repeat(400) }, { path: "two.test.js", text: "y".repeat(400) }]]]),
    callers: new Map([["a.js", [{ symbol: "useA", hits: [{ path: "c.js", fragment: "useA();" }] }]]]),
  };
  const prepared = { included: ["a.js"] };
  for (let cap = 0; cap <= 3000; cap += 7) {
    const { text, counts } = batchContext(data, prepared, cap);
    // A heading cut in half is not an entry: only whole headings count.
    const tests = ["one.test.js", "two.test.js"].filter((n) => text.includes(`#### Test: ${n}\n`)).length;
    assert.equal(counts.tests, tests, `tests at cap ${cap}`);
    assert.equal(counts.callers, text.includes("#### Uses of useA elsewhere in the repository\n") ? 1 : 0, `callers at cap ${cap}`);
  }
});

test("the guidelines stay within their own allowance, the newlines between files included", () => {
  const two = [{ path: "CLAUDE.md", dir: "", text: "x" }, { path: "AGENTS.md", dir: "", text: "x" }];
  const exact = guideText(two, ["src/a.js"], 1000).length;
  assert.ok(guideText(two, ["src/a.js"], exact).includes("AGENTS.md"), "both fit at their exact length");
  assert.ok(!guideText(two, ["src/a.js"], exact - 1).includes("AGENTS.md"), "one character less and the second no longer fits");
  assert.equal(batchContext({ guidelines: two }, { included: ["src/a.js"] }, 120).guide.length <= 30, true);
  const long = [{ path: "CLAUDE.md", dir: "", text: "a".repeat(300) }, { path: "AGENTS.md", dir: "", text: "b".repeat(900) }];
  for (let cap = 0; cap <= 1400; cap++) assert.ok(guideText(long, ["src/a.js"], cap).length <= cap, `guide cap ${cap}`);
});

test("a credential is blanked whichever quote opens its value, and a quote of the other kind inside it does not end it", () => {
  for (const [text, want] of [
    [`{"password": "it's-a-long-secret"}`, `{"password": "[redacted]"}`],
    [`password = 'say "hi" now ok'`, `password = '[redacted]'`],
    ['const apiKey = "abc\\"defghijklmnop";', 'const apiKey = "[redacted]";'],
    ["token: `a 'b' c d e f g`", "token: `[redacted]`"],
  ]) assert.equal(redact(text), want, text);
  // Not a credential: another kind of name, a short value, a value that is only talked about.
  for (const text of [`const message = "it's a long message here";`, `password = "short"`, `const note = "the password is in the vault";`]) assert.equal(redact(text), text, text);
  // Line breaks around it are kept.
  assert.equal(redact(`a\npassword = "it's-a-long-secret"\nb`).split("\n").length, 3);
});

test("an inline list of scope globs is split at the commas outside quotes and braces", () => {
  assert.deepEqual(ruleScope(`---\npaths: ["src/**/*.{ts,tsx}", 'lib/**']\n---\nx`), ["src/**/*.{ts,tsx}", "lib/**"]);
  assert.deepEqual(ruleScope("---\nglobs: src/*.{a,b}, docs/*.md\n---\nx"), ["src/*.{a,b}", "docs/*.md"]);
  const guides = [{ path: ".claude/rules/ts.md", dir: "", scope: ruleScope(`---\npaths: ["src/**/*.{ts,tsx}"]\n---\nx`), text: "Strict types." }];
  assert.match(guideText(guides, ["src/a.tsx"], 1000), /Strict types\./);
  assert.equal(guideText(guides, ["src/a.py"], 1000), "");
});

test("a scope glob with more than a few runs of stars applies everywhere, and cannot be made to take long", () => {
  const at = Date.now();
  assert.equal(globToRegExp(`${"*a".repeat(24)}b`).test("a".repeat(64)), true);
  // At the limit the glob still compiles, and a failed match on a longest path is quick.
  const limit = globToRegExp(`${"*a".repeat(MAX_GLOB_STARS)}b`);
  assert.equal(limit.test("a".repeat(MAX_SCOPE_PATH)), false);
  assert.ok(Date.now() - at < 500, `took ${Date.now() - at} ms`);
  assert.ok(globToRegExp("packages/*/src/**/*.ts").test("packages/x/src/a/b.ts"));
  assert.ok(!globToRegExp("packages/*/src/**/*.ts").test("packages/x/lib/a/b.ts"));
  // A path past the limit matches no scope.
  const scoped = [{ path: ".claude/rules/x.md", dir: "", scope: ["src/**"], text: "R" }];
  assert.match(guideText(scoped, ["src/a.js"], 1000), /## \.claude\/rules\/x\.md/);
  assert.equal(guideText(scoped, [`src/${"a".repeat(MAX_SCOPE_PATH)}`], 1000), "");
});

test("the About line tells collected context from context that fit", () => {
  assert.equal(contextLine({ guidelines: 0, files: 0, tests: 0, callers: 0, gathered: true, notes: [] }), "- Context: none fit the allowance.");
  assert.equal(contextLine({ guidelines: 0, files: 0, tests: 0, callers: 0, notes: [] }), "- Context: none found.");
});

test("the guidelines are counted by file, not by the headings inside them; names are kept for the review", () => {
  const data = { guidelines: [{ path: "CLAUDE.md", dir: "", text: "## Style\nx\n## Testing\ny\n## Security\nz" }] };
  const bc = batchContext(data, { included: ["src/a.js"] }, 4000);
  assert.equal(bc.counts.guidelines, 1);
  assert.deepEqual(bc.names.guidelines, ["CLAUDE.md"]);
  const used = [];
  guideText(data.guidelines, ["src/a.js"], 4000, used);
  assert.deepEqual(used, ["CLAUDE.md"]);
});

test("a long run of stars is one wildcard, and stars with alternatives past a small total apply everywhere", () => {
  const at = Date.now();
  assert.equal(globToRegExp(`${"*".repeat(40)}a${"*".repeat(40)}b`).test("a".repeat(200)), false);
  assert.ok(Date.now() - at < 500, `took ${Date.now() - at} ms`);
  assert.ok(globToRegExp("src/***/x.js").test("src/a/b/x.js"));
  assert.ok(globToRegExp("src/***/x.js").test("src/x.js"));
  assert.equal(globToRegExp("*{a,aa}*{a,aa}*{a,aa}b").test("zzz"), true, "too much work in one glob: it applies everywhere");
  assert.equal(globToRegExp("*{a,aa}*b").test("zzz"), false, "a small one is matched as written");
});
