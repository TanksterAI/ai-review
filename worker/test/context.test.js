import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS, MAX_GUIDE_FILES, batchContext, callerHits, changedSymbols, contextLine, excerpt, globToRegExp, guideText,
  indexTests, isSecretPath, isTestPath, parseTree, pickGuidelines, redact, ruleScope, testsFor, wellFormed,
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

test("redact blanks prefixed names, JSON keys, bare values, URL passwords and bearer tokens", () => {
  const cases = [
    ['const DB_PASSWORD = "hunter2hunter2";', "hunter2hunter2"],
    ['AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', "wJalrXUtnFEMI"],
    ['{"password": "hunter2hunter2"}', "hunter2hunter2"],
    ["password: hunter2hunter2", "hunter2hunter2"],
    ["API_KEY=abcdef1234567890abcd", "abcdef1234567890abcd"],
    ["postgres://user:p4ssw0rd@host/db", "p4ssw0rd"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", "abcdefghijklmnopqrstuvwxyz123456"],
    [`const k = "sk_live_${"A1b2".repeat(6)}";`, "sk_live_A1b2"],
  ];
  for (const [text, secret] of cases) assert.ok(!redact(text).includes(secret), `${secret} was left in ${text}`);
  // Code that only names a credential is left as it is.
  for (const keep of ["token: string", "const token = getTokenFromRequest", "const answer = compute(42);", "https://example.com/docs"]) assert.equal(redact(keep), keep);
  assert.equal(redact('const DB_PASSWORD = "hunter2hunter2";'), 'const DB_PASSWORD = "[redacted]";');
});

test("isSecretPath covers the usual secret files and leaves source files alone", () => {
  for (const p of [".envrc", ".env.local", "config/prod.env", ".dev.vars", "k.p8", "service-account.json", "serviceAccountKey.json", "terraform.tfstate", "a.tfvars", ".htpasswd", "kubeconfig", "secrets/prod.json", "a.pkcs12", ".aws/credentials", "id_rsa", "deploy/KEY.PEM"]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ["src/credentials.ts", "src/environment.ts", "README.md", "src/secret-santa.js", "docs/keys.md", "worker/src/context.js"]) assert.equal(isSecretPath(p), false, p);
});

test("a rule scoped with a brace glob applies to the files it names", () => {
  const re = globToRegExp("src/**/*.{ts,tsx}");
  assert.ok(re.test("src/a/b.ts") && re.test("src/b.tsx") && !re.test("src/b.js"));
  const text = "---\npaths:\n  - \"src/**/*.{ts,tsx}\"\n---\nUse strict types.";
  const scope = ruleScope(text);
  assert.ok(guideText([{ path: ".claude/rules/ts.md", dir: "", scope, text }], ["src/a/b.ts"], 5000).includes("Use strict types"));
  assert.equal(guideText([{ path: ".claude/rules/ts.md", dir: "", scope, text }], ["src/a/b.py"], 5000), "");
});

test("a changed name too long to search for is not picked, so the callers step cannot fail on it", () => {
  const long = "x".repeat(100);
  const patch = `+export function ${long}() {}\n+def test_${"y".repeat(159)}(client):\n+export function okName() {}`;
  assert.deepEqual(changedSymbols(patch), ["okName"]);
});

test("a note with a path the author chose cannot ping, link or reference from the review", () => {
  const line = contextLine({ notes: ["@octocat/docs/[x](http://evil.example)#12.md is too large to read whole", "a`b``c.md could not be read"] });
  assert.equal(contextLine({ notes: ["docs/a b.md is too large to read whole"] }), "- Context: none found (docs/a b.md is too large to read whole).");
  assert.match(contextLine({ notes: ["www.evil.example/x.md could not be read"] }), /\(` www\.evil\.example\/x\.md could not be read `\)\.$/);
  assert.match(line, /\(` @octocat\/docs\/\[x\]\(http:\/\/evil\.example\)#12\.md is too large to read whole `; ``` a`b``c\.md could not be read ```\)\.$/);
});

test("text cut through a surrogate pair is made well-formed before it is sent", () => {
  assert.equal(wellFormed("a\ud83d"), "a�");
  assert.equal(wellFormed("\ude00b"), "�b");
  assert.equal(wellFormed("ok 😀"), "ok 😀");
  const line = `${"a".repeat(399)}😀 tail`;
  const out = batchContext({ files: new Map([["a.js", line]]) }, { included: ["a.js"], shown: new Map([["a.js", [1]]]) }, 5000);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out.text), "a lone high surrogate was left");
});

test("redact stays fast on files built to be slow, and leaves code that only names a credential alone", () => {
  const inputs = ["a-".repeat(150_000), "a.".repeat(150_000), `${"a+".repeat(40_000)}://x:yyy`, "abcd-efgh".repeat(30_000), "password".repeat(40_000), "password=".repeat(30_000), "token_".repeat(40_000), "Bearer ".repeat(30_000), `password${" ".repeat(250_000)}`];
  const at = Date.now();
  for (const text of inputs) redact(text);
  assert.ok(Date.now() - at < 2000, `redact took ${Date.now() - at} ms`);
  for (const keep of ["const isTokenValid = validateToken2(session)", "const tokenUrl = process.env.TOKEN_URL_V2;", "token = tokens.get_token_v2_cached()", "maxTokens = 123456789012", "TOKEN_LIMIT=100000000000"]) assert.equal(redact(keep), keep);
  for (const [text, secret] of [["const password: string = \"hunter2hunter2\";", "hunter2hunter2"], ["postgres://u:pa/ss@host/db", "pa/ss"], ["authorization: bearer abcdefghijklmnopqrstuvwxyz123456", "abcdefghijklmnopqrstuvwxyz"]]) assert.ok(!redact(text).includes(secret), text);
});

test("isSecretPath covers prefixed names and the usual config stores of credentials", () => {
  for (const p of ["gcp-service-account.json", "prod-kubeconfig", "app-secrets.json", "config/prod.secrets.yaml", "client_secret_123.json", "terraform.tfvars.json", ".docker/config.json", ".kube/config", ".pgpass", "wp-config.php", ".yarnrc.yml"]) assert.equal(isSecretPath(p), true, p);
});

test("a glob with many alternatives cannot be made to take long", () => {
  const evil = `${"{*,*}".repeat(10)}Z`;
  const at = Date.now();
  // Twenty runs of stars is more than a scope may have: the glob applies to every path.
  assert.equal(globToRegExp(evil).test("a".repeat(30)), true);
  assert.ok(Date.now() - at < 500, `took ${Date.now() - at} ms`);
});

test("notes: a bare issue number, a commit-like word and an empty note do not get through as plain text", () => {
  assert.match(contextLine({ notes: ["GH-12 is too large to read whole"] }), /\(` GH-12 is too large to read whole `\)\.$/);
  assert.match(contextLine({ notes: ["deadbeef1 could not be read"] }), /\(` deadbeef1 could not be read `\)\.$/);
  assert.match(contextLine({ notes: ["docs/_a_/b.md could not be read"] }), /\(` docs\/_a_\/b\.md could not be read `\)\.$/);
  assert.equal(contextLine({ notes: ["", "  ", "docs/a.md could not be read"] }), "- Context: none found (docs/a.md could not be read).");
});

test("redact blanks Basic credentials after an Authorization name, and leaves the word in prose and paths", () => {
  const b64 = "dXNlcjpwYXNzd29yZA==";
  for (const text of [`curl -H "Authorization: Basic ${b64}" https://x`, `authorization = 'basic ${b64}'`, `Authorization: Basic ${b64}`, `headers: { "Authorization": "Basic ${b64}" }`, `res.headers.set("Authorization", "Basic ${b64}")`, `Proxy-Authorization: Basic ${b64}`, "Authorization: Basic dXNlcjpwYXNzd29yZA-_"]) {
    const out = redact(text);
    assert.ok(!out.includes("dXNlcjpwYXNz"), `${text} -> ${out}`);
    assert.match(out, /Basic \[redacted\]/i);
  }
  assert.equal(redact(`curl -H "Authorization: Basic ${b64}" https://x`), 'curl -H "Authorization: Basic [redacted]" https://x');
  for (const keep of ["Basic setup is easy", "Basic authentication is used here", "// Basic implementation of the parser", "the Basic option", "// Basic src/components/Button2.tsx handles it", "Basic infrastructure/config1 notes", "Basic configurationManagement2024"]) assert.equal(redact(keep), keep);
});

test("redact finds a JSON Web Token of any length, even after a failed first try in the same run", () => {
  const jwt = (n) => `eyJhbGciOiJIUzI1NiJ9.${"eyJzdWIiOiIx".repeat(n)}.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
  for (const n of [1, 50, 5000]) assert.equal(redact(`const jwt = "${jwt(n)}";`), 'const jwt = "[redacted]";');
  assert.equal(redact(`see ${jwt(1)}.`), "see [redacted].");
  assert.equal(redact(`see ${jwt(1)}...`), "see [redacted]...");
  for (const keep of ["eyJ.short.x", "eyJabcdefghijk.only.two", "eyJabcdefghijk", "eyJ...", "x.eyJabcdefghijk.b.c"]) assert.equal(redact(keep), keep);
  // A first try that fails does not hide a real token later in the same run.
  // Exact outputs: the real token's own parts (its header, payload and signature) are gone, and what came before it is kept.
  assert.equal(redact(`eyJfoo.${jwt(1)}`), "eyJfoo.[redacted]", "token after a failed start was left");
  assert.equal(redact(`eyJ-${jwt(1)}`), "[redacted]", "token after a dash was left");
  for (const text of [`eyJfoo.${jwt(1)}`, `eyJ-${jwt(1)}`]) {
    const out = redact(text);
    assert.match(out, /\[redacted\]/);
    for (const part of ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIx", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"]) assert.ok(!out.includes(part), `${part} was left in ${out}`);
  }
});

test("redact takes time linear in the text for runs built to make a token search start again", () => {
  const time = (text) => { const at = process.hrtime.bigint(); redact(text); return Number(process.hrtime.bigint() - at) / 1e6; };
  // Quadratic code takes minutes on these; linear code takes milliseconds.
  for (const text of ["eyJabcdefghijk-".repeat(80_000), `eyJ${".".repeat(400_000)}x`, "eyJabcdefghijk.".repeat(80_000), "eyJ.".repeat(300_000), `eyJabcdefghijk${".a".repeat(300_000)}`, "Authorization: Basic ".repeat(50_000), "Basic ".repeat(100_000)]) {
    const ms = time(text);
    assert.ok(ms < 3000, `redact took ${ms} ms for ${text.slice(0, 30)}...`);
  }
});

test("redact blanks a quoted credential of any length, with escaped quotes inside, and stays linear", () => {
  const long = "x9".repeat(5000);
  assert.equal(redact(`API_KEY = "${long}"`), 'API_KEY = "[redacted]"');
  assert.equal(redact(`{"api_key": "${long}"}`), '{"api_key": "[redacted]"}');
  assert.equal(redact(`password = '${long}' // kept`), "password = '[redacted]' // kept");
  // A backslash escapes the quote after it: the value goes on to the quote that closes it.
  assert.equal(redact('token = "abcd1234\\"efgh5678\\"ijkl" + rest'), 'token = "[redacted]" + rest');
  // Code that only names a credential is left alone, at any length of what follows.
  assert.equal(redact(`const secretCount = ${"9".repeat(5000)};`), `const secretCount = ${"9".repeat(5000)};`);
  const time = (text) => { const at = process.hrtime.bigint(); redact(text); return Number(process.hrtime.bigint() - at) / 1e6; };
  // Quotes never closed, closed late, escaped to the end, and many starts on one line.
  for (const text of [`password="${"x".repeat(400_000)}`, 'password="x'.repeat(40_000), ("password=\"a" + "password='a").repeat(20_000), `password="${"\\\\".repeat(200_000)}`, `password="${"\\".repeat(400_000)}`, `secret="${"y".repeat(390_000)}"`, ("token=`" + "b".repeat(20)).repeat(20_000)]) {
    const ms = time(text);
    assert.ok(ms < 3000, `redact took ${ms} ms for ${text.slice(0, 30)}...`);
  }
});

test("redact blanks an unquoted credential, a bearer token, Basic credentials and a URL password of any length", () => {
  const alnum = "x9".repeat(150);
  // A base64 value with a "/" just before the old limit of 200: all of it goes, not the part before the limit.
  const b64 = `${"aB3+".repeat(49)}aB3/${"Qz7=".repeat(25)}`;
  assert.ok(b64.length > 250 && b64[199] === "/", "the value is built with a slash at 199");
  assert.equal(redact(`API_KEY=${alnum}`), "API_KEY=[redacted]");
  assert.equal(redact(`API_KEY=${b64}\nnext: line`), "API_KEY=[redacted]\nnext: line");
  assert.equal(redact(`password: ${"p4".repeat(2000)} # kept`), "password: [redacted] # kept");
  assert.equal(redact(`Authorization: Bearer ${"Ab1.".repeat(1500)}`), "Authorization: Bearer [redacted]");
  assert.equal(redact(`curl -H "Authorization: Basic ${"dXNl".repeat(1500)}==" https://x`), 'curl -H "Authorization: Basic [redacted]" https://x');
  assert.equal(redact(`postgres://user:${"pa/ss1".repeat(200)}@host/db`), "postgres://user:[redacted]@host/db");
  // A call or a path into an object is not a credential, at any length; nor is a value with no digit or no letter.
  for (const keep of [`token = ${"a1".repeat(300)}(x)`, `token = ${"a1".repeat(300)}.field`, `token = ${"a".repeat(300)}`, `token = ${"7".repeat(300)}`, `https://u:${"p".repeat(300)} no at sign`, `postgres://user:${"a".repeat(3000)}@host`]) assert.equal(redact(keep), keep);
  // A credential with a sentence's full stop or a path after it still goes (the longest part before a "+/~=-"), and a `: type` that is really part of the value does not hide it.
  assert.equal(redact("# set TOKEN=abc123def456ghi789==."), "# set TOKEN=[redacted]=.");
  assert.equal(redact("API_KEY=abc123def456/path.ext"), "API_KEY=[redacted]/path.ext");
  assert.equal(redact("token: ab12=cdefghijklmnop"), "token: [redacted]");
  assert.equal(redact("const password: string = hunter2hunter2xx"), "const password: string = [redacted]");
  // The text of a minified file with an address at its end, and no white space, is not a password.
  const minified = `{"api":"http://localhost:3000/v1","rows":[${"1,".repeat(5000)}],"mail":"x@example.com"}`;
  assert.equal(redact(minified), minified);
  // Short URL passwords and a "@" after white space are as before.
  assert.equal(redact("postgres://user:p4ssw0rd@host/db and a@b.c"), "postgres://user:[redacted]@host/db and a@b.c");
  assert.equal(redact("see https://user:ab @host"), "see https://user:ab @host");
  assert.equal(redact("a://u:x1y@h b://v:y22@h"), "a://u:[redacted]@h b://v:[redacted]@h");
});

test("redact takes time linear in the text for long values and many starts of a URL password", () => {
  const time = (text) => { const at = process.hrtime.bigint(); redact(text); return Number(process.hrtime.bigint() - at) / 1e6; };
  for (const text of [`API_KEY=${"a1".repeat(200_000)}`, "password=".repeat(60_000), `${"token=a1a1a1a1a1a1a1("}`.repeat(30_000), `token=${"a1-".repeat(150_000)}`, `token=${"a1-".repeat(150_000)}(`, `token: ${"ab12=".repeat(80_000)}`, "a://b:".repeat(100_000), `x://u:${"p".repeat(400_000)}`, `x://u:${"p".repeat(400_000)}@h`, "x://u:pp".repeat(60_000), "x://u:pp ".repeat(60_000), `Bearer ${"a".repeat(400_000)}`, `Authorization: Basic ${"A".repeat(400_000)}`, `${"Bearer ".repeat(10)}${"a1".repeat(200_000)}`]) {
    const ms = time(text);
    assert.ok(ms < 3000, `redact took ${ms} ms for ${text.slice(0, 30)}...`);
  }
});

test("ruleScope: a comment after a value is not part of it, and a # inside a quoted path stays", () => {
  assert.deepEqual(ruleScope('---\npaths:\n  - "src/**" # source files\n  - \'lib/**\' # more\n  - tests/*.ts # unquoted\n---\nbody'), ["src/**", "lib/**", "tests/*.ts"]);
  assert.deepEqual(ruleScope('---\npaths: ["src/**", \'b/*.js\'] # an inline list\n---\nbody'), ["src/**", "b/*.js"]);
  assert.deepEqual(ruleScope('---\nglobs: # the key has one too\n  # and a line of its own\n  - "src/#x/**"\n  - src/a#b/**\n---\nbody'), ["src/#x/**", "src/a#b/**"]);
  // A comment at the start of a line does not end the list.
  assert.deepEqual(ruleScope("---\npaths:\n  - a/*.ts\n# a note\n  - b/*.ts\nother: x\n  - c\n---\nbody"), ["a/*.ts", "b/*.ts"]);
  // The rule then applies to the file the scope names.
  const text = '---\npaths:\n  - "src/**" # source files\n---\nVerify tokens.';
  assert.ok(guideText([{ path: ".claude/rules/a.md", dir: "", scope: ruleScope(text), text }], ["src/auth.js"], 5000).includes("Verify tokens."));
});
