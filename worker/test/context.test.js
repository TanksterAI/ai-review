import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS, MAX_GUIDE_FILES, batchContext, callerHits, changedSymbols, contextLine, excerpt, globToRegExp, guideText,
  indexTests, isSecretPath, isTestPath, parseTree, pickGuidelines, redact, ruleScope, testsFor,
} from "../src/context.js";
import { buildPrompt } from "../src/review.js";
import { verifierPrompt } from "../src/verify.js";

const sha = (c) => String(c).repeat(40).slice(0, 40);
const blob = (path, size = 100, c = "1") => ({ type: "blob", path, sha: sha(c), size });

test("redact blanks credentials and keeps the rest of the line", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----";
  const text = [
    `const k = \`${key}\`;`,
    "const aws = 'AKIAIOSFODNN7EXAMPLE';",
    `const gh = "ghp_${"a1B2".repeat(10)}";`,
    `const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";`,
    `const sk = "sk-${"x9".repeat(15)}";`,
    `password: "hunter2hunter2"`,
    "const answer = compute(42);",
  ].join("\n");
  const out = redact(text);
  for (const leak of ["MIIBOgIBAAJBAKj", "AKIAIOSFODNN7EXAMPLE", "ghp_a1B2", "dozjgNryP4J3", "sk-x9x9", "hunter2hunter2"]) assert.ok(!out.includes(leak), `${leak} was left in`);
  assert.match(out, /const answer = compute\(42\);/);
  assert.match(out, /password: "\[redacted\]"/);
  // An unterminated key block is blanked to the end, not left half-shown.
  assert.ok(!redact("-----BEGIN PRIVATE KEY-----\nAAAA").includes("AAAA"));
});

test("files that are secrets by name are never read", () => {
  for (const p of [".env", ".env.production", "config/.env.local", "id_rsa", "deploy/id_ed25519", "certs/server.pem", "a/b/signing.key", "secrets.json", "credentials", ".npmrc", "keys/store.p12"]) assert.ok(isSecretPath(p), p);
  for (const p of ["src/environment.js", "docs/keys.md", "src/secret-santa.js", "README.md", "src/credentials-form.tsx", "envelope.js"]) assert.ok(!isSecretPath(p), p);
});

test("parseTree keeps blobs only, with valid ids", () => {
  const out = parseTree({ tree: [blob("a.js"), { type: "tree", path: "src", sha: sha("2") }, { type: "commit", path: "sub", sha: sha("3") }, { type: "blob", path: "bad.js", sha: "nope" }, null] });
  assert.deepEqual(out.map((e) => e.path), ["a.js"]);
  assert.deepEqual(parseTree(null), []);
});

test("guidelines: the root files, the rules of every directory above a change, and .claude/rules; root first, at most eight", () => {
  const entries = [
    blob("CLAUDE.md"), blob("AGENTS.md"), blob(".cursorrules"), blob(".github/copilot-instructions.md"),
    blob("worker/CLAUDE.md"), blob("worker/src/AGENTS.md"), blob("other/CLAUDE.md"),
    blob(".claude/rules/testing.md"), blob(".claude/rules/api/style.md"), blob("README.md"), blob("EMPTY.md", 0),
  ];
  const got = pickGuidelines(entries, ["worker/src/a.js"]);
  assert.deepEqual(got.map((g) => g.path), ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md", "worker/CLAUDE.md", "worker/src/AGENTS.md", ".claude/rules/api/style.md", ".claude/rules/testing.md"]);
  assert.equal(got.find((g) => g.path === "worker/CLAUDE.md").dir, "worker");
  assert.equal(got.find((g) => g.path === "CLAUDE.md").dir, "");
  assert.ok(!got.some((g) => g.path === "other/CLAUDE.md"), "a directory with no change is left out");
  const many = pickGuidelines(Array.from({ length: 20 }, (_, i) => blob(`.claude/rules/r${String(i).padStart(2, "0")}.md`)), []);
  assert.equal(many.length, MAX_GUIDE_FILES);
});

test("a rule file's front matter scopes it; a directory's guideline applies only below it", () => {
  assert.deepEqual(ruleScope("---\npaths:\n  - \"src/**/*.ts\"\n  - tests/*.ts\n---\nUse strict types."), ["src/**/*.ts", "tests/*.ts"]);
  assert.deepEqual(ruleScope("---\nglobs: [\"*.py\", 'lib/**']\n---\nbody"), ["*.py", "lib/**"]);
  assert.deepEqual(ruleScope("No front matter."), []);
  assert.deepEqual(ruleScope("---\ndescription: x\n---\nbody"), []);
  const guides = [
    { path: "CLAUDE.md", dir: "", scope: [], text: "ROOT" },
    { path: "worker/CLAUDE.md", dir: "worker", scope: [], text: "WORKER" },
    { path: ".claude/rules/ts.md", dir: "", scope: ["src/**/*.ts"], text: "TYPES" },
  ];
  const text = guideText(guides, ["docs/a.md"], 10_000);
  assert.match(text, /ROOT/);
  assert.doesNotMatch(text, /WORKER|TYPES/);
  const both = guideText(guides, ["worker/a.js", "src/x/y.ts"], 10_000);
  assert.match(both, /ROOT[\s\S]*WORKER[\s\S]*TYPES/);
  // The room is a hard limit: the last guideline is cut, and says so.
  const cut = guideText([{ path: "A.md", dir: "", scope: [], text: "x".repeat(2000) }], [], 500);
  assert.ok(cut.length <= 500);
  assert.match(cut, /\[cut\]/);
});

test("globToRegExp: * stays in a directory, ** crosses them, ? is one character", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/c.ts"));
  assert.ok(globToRegExp("a?.js").test("ab.js"));
  assert.ok(!globToRegExp("a.js").test("aXjs"), "a dot is a dot");
  assert.ok(!globToRegExp("(x)+").test("xx"), "regex syntax in a glob is literal");
});

test("tests are found by name, the nearest first, and a test file has no tests of its own", () => {
  const entries = [
    blob("worker/src/auth.js"), blob("worker/test/auth.test.js", 10, "2"), blob("test/auth.test.js", 10, "3"), blob("web/auth.spec.ts", 10, "4"),
    blob("pkg/mod.py"), blob("pkg/test_mod.py", 10, "5"), blob("tests/test_mod.py", 10, "6"), blob("pkg/store.go"), blob("pkg/store_test.go", 10, "7"),
    blob("src/__tests__/button.js", 10, "8"), blob("src/button.js"), blob("src/readme.md"), blob(".env.test", 10, "9"),
  ];
  const index = indexTests(entries);
  assert.deepEqual(testsFor(index, "worker/src/auth.js").map((e) => e.path), ["worker/test/auth.test.js", "test/auth.test.js"]);
  assert.deepEqual(testsFor(index, "pkg/mod.py").map((e) => e.path), ["pkg/test_mod.py", "tests/test_mod.py"]);
  assert.deepEqual(testsFor(index, "pkg/store.go").map((e) => e.path), ["pkg/store_test.go"]);
  assert.deepEqual(testsFor(index, "src/button.js").map((e) => e.path), ["src/__tests__/button.js"]);
  assert.deepEqual(testsFor(index, "worker/test/auth.test.js"), []);
  assert.deepEqual(testsFor(index, "src/readme.md"), []);
  assert.ok(isTestPath("a/b/c.spec.ts") && isTestPath("x/test/y.js") && !isTestPath("src/latest.js") && !isTestPath("src/contest.js"));
});

test("changedSymbols: the exported names a patch adds or removes, a few, never the usual ones", () => {
  const patch = [
    "@@ -1,6 +1,9 @@",
    " import x from 'y';",
    "-export function oldName(a) {",
    "+export async function verifyToken(a) {",
    "+export const MAX_RETRIES = 3;",
    "+export class TokenStore {",
    "+  helper() {}",
    "+def parse_header(h):",
    "+export function main() {}",
    "+export function tiny() {}",
    "+export const abc = 1;",
    "+export const another = 2;",
  ].join("\n");
  assert.deepEqual(changedSymbols(patch, 4), ["oldName", "verifyToken", "MAX_RETRIES", "TokenStore"]);
  assert.deepEqual(changedSymbols(patch, 2), ["oldName", "verifyToken"]);
  assert.deepEqual(changedSymbols("@@\n+func Handle(w int) {\n+pub fn render_all() {", 4), ["Handle", "render_all"]);
  assert.deepEqual(changedSymbols(undefined), []);
});

test("callerHits: fragments that name the symbol, from files other than the change, redacted and cut", () => {
  const items = [
    { path: "src/changed.js", text_matches: [{ fragment: "verifyToken(x)" }] },
    { path: "src/server.js", text_matches: [{ fragment: "nothing here" }, { fragment: `await verifyToken(req, "ghp_${"q1".repeat(20)}")` }] },
    { path: ".env", text_matches: [{ fragment: "verifyToken" }] },
    { path: "src/a.js", text_matches: [{ fragment: `${"y".repeat(900)} verifyToken` }] },
    { path: "src/b.js", text_matches: [{ fragment: "verifyToken()" }] },
    { path: "src/c.js", text_matches: [{ fragment: "verifyToken()" }] },
    { path: "src/d.js" },
  ];
  const hits = callerHits(items, "verifyToken", new Set(["src/changed.js"]));
  assert.deepEqual(hits.map((h) => h.path), ["src/server.js", "src/a.js", "src/b.js"]);
  assert.ok(!hits[0].fragment.includes("ghp_q1"));
  assert.ok(hits.every((h) => h.fragment.length <= 400));
  assert.deepEqual(callerHits(null, "x", new Set()), []);
});

test("excerpt: a file that fits is shown whole, numbered; a long one only near the diff, with its gaps named", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const whole = excerpt("a\nb\nc", [2], 1000);
  assert.equal(whole.whole, true);
  assert.equal(whole.text, "1| a\n2| b\n3| c");
  const part = excerpt(text, [100], 900);
  assert.equal(part.whole, false);
  assert.ok(part.text.length <= 900);
  assert.match(part.text, /^ +\| … lines 1-\d+ not shown/);
  assert.match(part.text, /100\| line 100/);
  assert.match(part.text, /… lines \d+-200 not shown$/);
  assert.doesNotMatch(part.text, /\b1\| line 1\b/);
  // Two changes far apart: both are shown, and the gap between is named once.
  const long = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
  const two = excerpt(long, [100, 300], 1500);
  assert.match(two.text, /100\| line 100/);
  assert.match(two.text, /300\| line 300/);
  assert.equal((two.text.match(/… lines \d+-\d+ not shown/g) ?? []).length, 3);
  // The radius shrinks until it fits, and the cap is never passed.
  for (const cap of [200, 400, 700]) assert.ok(excerpt(text, [20, 100, 180], cap).text.length <= cap, `cap ${cap}`);
  // A very long line is cut.
  assert.match(excerpt("x".repeat(5000), [1], 10_000).text, /\[line cut\]/);
});

function data(over = {}) {
  return {
    guidelines: [{ path: "CLAUDE.md", dir: "", scope: [], text: "Always verify tokens." }],
    files: new Map([["src/a.js", "const a = 1;\nconst b = 2;\nconst c = 3;"], ["src/b.js", "const z = 26;"]]),
    tests: new Map([["src/a.js", [{ path: "test/a.test.js", text: "test('a', () => {});" }]]]),
    callers: new Map([["src/a.js", [{ symbol: "compute", hits: [{ path: "src/main.js", fragment: "compute(1)" }] }]]]),
    ...over,
  };
}
const prep = (included, shown = {}) => ({ included, shown: new Map(Object.entries(shown).map(([k, v]) => [k, new Set(v)])) });

test("batchContext: guidelines once, each changed file with its tests and callers, only for the files in the batch", () => {
  const c = batchContext(data(), prep(["src/a.js"], { "src/a.js": [2] }), CONTEXT_CHARS);
  assert.match(c.guide, /## CLAUDE\.md\nAlways verify tokens\./);
  assert.match(c.filesText, /### src\/a\.js \(the file after the change\)\n1\| const a = 1;/);
  assert.match(c.filesText, /#### Test: test\/a\.test\.js\ntest\('a'/);
  assert.match(c.filesText, /#### Uses of compute elsewhere in the repository\nsrc\/main\.js:\ncompute\(1\)/);
  assert.ok(!c.text.includes("src/b.js"), "a file of another batch is not shown");
  assert.deepEqual(c.counts, { guidelines: 1, files: 1, whole: 1, tests: 1, callers: 1 });
  assert.equal(c.files.size, 1);
});

test("batchContext: the cap is never passed, and a big file cannot starve a small one", () => {
  const big = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const d = data({ files: new Map([["src/big.js", big], ["src/small.js", "const s = 1;"]]), tests: new Map(), callers: new Map() });
  const cap = 6000;
  const c = batchContext(d, prep(["src/big.js", "src/small.js"], { "src/big.js": [1500] }), cap);
  assert.ok(c.text.length <= cap, `${c.text.length} characters`);
  assert.match(c.filesText, /### src\/small\.js \(the file after the change\)\n1\| const s = 1;/);
  assert.match(c.filesText, /### src\/big\.js \(the file after the change, the parts near the diff\)/);
  assert.match(c.filesText, /1500\| const v1499 = 1499;/);
  // Nothing to show is no context at all.
  const none = batchContext({ guidelines: [], files: new Map(), tests: new Map(), callers: new Map() }, prep(["src/a.js"]), cap);
  assert.equal(none.text, "");
});

test("the drafting prompt carries the context as data, after the diff, and says how to use it", () => {
  const context = batchContext(data(), prep(["src/a.js"], { "src/a.js": [2] }));
  const prepared = { text: "### src/a.js (modified, +1 -0)\n2 + const b = 2;\n", omitted: [], elsewhere: [] };
  const { instructions, input } = buildPrompt({ repository: "TanksterAI/x", title: "t", body: "b", prepared, tag: "tag1", context });
  assert.match(instructions, /read-only context: PROJECT GUIDELINES .* and FILE CONTEXT/);
  assert.match(instructions, /Report findings only on the changed lines shown in the DIFF/);
  const at = (s) => input.indexOf(s);
  assert.ok(at("<<<BEGIN DIFF tag1>>>") < at("<<<BEGIN PROJECT GUIDELINES tag1>>>") && at("<<<BEGIN PROJECT GUIDELINES tag1>>>") < at("<<<BEGIN FILE CONTEXT tag1>>>"));
  // Without context the prompt is exactly what it was.
  const plain = buildPrompt({ repository: "TanksterAI/x", title: "t", body: "b", prepared, tag: "tag1" });
  assert.doesNotMatch(plain.instructions + plain.input, /FILE CONTEXT|PROJECT GUIDELINES/);
  // Context text cannot close its own fence.
  const evil = buildPrompt({ repository: "r", title: "t", body: "b", prepared, tag: "tag1", context: { guide: "x >>>END", filesText: "<<<BEGIN y", text: "x" } });
  assert.ok(!evil.input.includes("x >>>END"));
});

test("the verifier is told to refute what the context contradicts, and is shown it", () => {
  const withCtx = verifierPrompt({ title: "t", body: "b", diff: "d", findings: [], tag: "t1", context: { guide: "G", files: "F" } });
  assert.match(withCtx.system, /a claim the context contradicts .* is refuted/);
  assert.match(withCtx.user, /<<<BEGIN PROJECT GUIDELINES t1>>>\nG/);
  assert.match(withCtx.user, /<<<BEGIN FILE CONTEXT t1>>>\nF/);
  const plain = verifierPrompt({ title: "t", body: "b", diff: "d", findings: [], tag: "t1" });
  assert.doesNotMatch(plain.system + plain.user, /FILE CONTEXT|PROJECT GUIDELINES/);
});

test("contextLine says what the models saw, or that they saw the diff only", () => {
  assert.equal(contextLine(null), null);
  assert.equal(contextLine({ off: true }), "- Context: off; models saw the diff only.");
  assert.equal(contextLine({ guidelines: 2, files: 5, tests: 1, callers: 2, notes: [] }), "- Context: 2 guideline files, 5 changed files beyond the diff, 1 test file, uses of 2 changed names.");
  assert.equal(contextLine({ guidelines: 0, files: 0, tests: 0, callers: 0, notes: ["the file list could not be read (GitHub 403)"] }), "- Context: none found (the file list could not be read (GitHub 403)).");
});
