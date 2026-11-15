import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFindings, prepareFiles } from "../src/review.js";
import { REASONS, codeShape, groundFindings, hasContent, named, normaliseLine, publicReason, suggestionBalanced } from "../src/grounding.js";
import { PATCH, GROUNDED_PATCH, bestOf, growth } from "./helpers.js";

// A 20-line new file: line n reads "const vN = compute(N);".
const LONG = `@@ -0,0 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `+const v${i + 1} = compute(${i + 1});`).join("\n")}`;
// A file whose old line is removed, and one ending in braces.
const SWAP = "@@ -1,1 +1,1 @@\n-const oldValue = compute(1);\n+const newValue = compute(2);";
const BRACES = "@@ -0,0 +1,6 @@\n+function check(user) {\n+  if (user.admin) {\n+    return grantAccess(user);\n+  }\n+  return;\n+}";
const prepared = () => prepareFiles([
  { filename: "src/long.js", patch: LONG },
  { filename: "src/a.js", patch: GROUNDED_PATCH },
  { filename: "src/swap.js", patch: SWAP },
  { filename: "src/braces.js", patch: BRACES },
]);

function ground(findings, { title = "Add compute", body = "Adds the values.", p = prepared() } = {}) {
  const c = classifyFindings({ findings: findings.map((f) => ({ severity: "minor", category: "bug", body: "b", ...f })) }, p.commentable, p.lineText);
  return groundFindings(c, p, { title, body });
}
const kept = (g) => [...g.classified.inline, ...g.classified.general].map((f) => f.title);
const why = (g) => g.dropped.map((d) => [d.finding.title, d.reason]);

test("evidence on the cited line, or within 3 lines of it, is kept", () => {
  const g = ground([
    { path: "src/long.js", line: 10, title: "on the line", evidence: "const v10 = compute(10);" },
    { path: "src/long.js", line: 10, title: "three above", evidence: "const v7 = compute(7);" },
    { path: "src/long.js", line: 10, title: "three below", evidence: ["const v13 = compute(13);"] },
    { path: "src/long.js", line: 10, title: "two lines", evidence: "const v9 = compute(9);\nconst v10 = compute(10);" },
  ]);
  assert.deepEqual(kept(g), ["on the line", "three above", "three below", "two lines"]);
  assert.deepEqual(g.dropped, []);
});

test("evidence elsewhere in the file, in another file or nowhere is dropped", () => {
  const g = ground([
    { path: "src/long.js", line: 10, title: "four away", evidence: "const v14 = compute(14);" },
    { path: "src/long.js", line: 10, title: "other file", evidence: "const ratio = total / 0;" },
    { path: "src/long.js", line: 10, title: "invented", evidence: "const v10 = compute(10, cache);" },
    // One true line and one invented one: every line must match.
    { path: "src/long.js", line: 10, title: "half true", evidence: "const v10 = compute(10);\nif (cache) return;" },
    // A removed line is not in the new file, so it cannot ground a finding.
    { path: "src/swap.js", line: 1, title: "removed line", evidence: "const oldValue = compute(1);" },
  ]);
  assert.deepEqual(kept(g), []);
  assert.ok(why(g).every(([, r]) => r === REASONS.notInCode), JSON.stringify(why(g)));
});

test("a finding without evidence is dropped", () => {
  const g = ground([
    { path: "src/long.js", line: 10, title: "none" },
    { path: "src/long.js", line: 10, title: "empty", evidence: "" },
    { path: "src/long.js", line: 10, title: "blank lines", evidence: ["  ", "\n\t"] },
    { path: "src/long.js", line: 10, title: "not text", evidence: 42 },
  ]);
  assert.deepEqual(why(g), [["none", "no evidence"], ["empty", "no evidence"], ["blank lines", "no evidence"], ["not text", "no evidence"]]);
});

test("whitespace differences are tolerated, and so is a copied line-number prefix", () => {
  assert.equal(normaliseLine("  a \t =  b  "), "a = b");
  const g = ground([
    { path: "src/long.js", line: 5, title: "spaced", evidence: "   const  v5 =\tcompute(5);   " },
    { path: "src/long.js", line: 5, title: "prefixed", evidence: "    5 + const v5 = compute(5);" },
    { path: "src/long.js", line: 5, title: "plus", evidence: "+const v5 = compute(5);" },
    { path: "src/long.js", line: 5, title: "crlf", evidence: "const v5 = compute(5);\r\n" },
  ]);
  assert.deepEqual(kept(g), ["spaced", "prefixed", "plus", "crlf"]);
});

test("general findings must be about a file in the change, with evidence anywhere in that file", () => {
  const g = ground([
    // Line 99 is not in the diff, so the finding is general, but its file is shown.
    { path: "src/long.js", line: 99, title: "file wide", evidence: "const v1 = compute(1);" },
    { path: "src/long.js", line: 99, title: "wrong file", evidence: "const ratio = total / 0;" },
    { title: "no path", evidence: "export { x };" },
    { path: "src/elsewhere.js", line: 1, title: "unseen file", evidence: "const ratio = total / 0;" },
    // A lockfile was skipped: never shown, so not a file in the change.
    { path: "package-lock.json", line: 1, title: "skipped file", evidence: "const ratio = total / 0;" },
  ], { p: prepareFiles([{ filename: "src/long.js", patch: LONG }, { filename: "src/a.js", patch: GROUNDED_PATCH }, { filename: "package-lock.json", patch: GROUNDED_PATCH }]) });
  assert.deepEqual(kept(g), ["file wide"]);
  assert.deepEqual(why(g), [
    ["wrong file", "evidence not in the code"],
    ["no path", "not about a file in the change"],
    ["unseen file", "not about a file in the change"],
    ["skipped file", "not about a file in the change"],
  ]);
});

test("evidence must say something: punctuation and keywords alone neither ground a finding nor need to match", () => {
  for (const l of ["}", "  } ", "});", "]", "{", "} else {", "return;", "return null;", "=> {", "&& ||", ";;"]) assert.equal(hasContent(l), false, l);
  for (const l of ["} catch (error) {", "if err != nil {", "x = 0", "dx := x1 - x0", "return a[i] - b[i];"]) assert.equal(hasContent(l), true, l);
  // Names of 3 or more characters outside the keywords and well-known names.
  assert.deepEqual(["return grantAccess(user);", "} catch (error) {", "if err != nil {", "self.n = n + 1"].map(named), [true, false, false, false]);
  const at = { path: "src/braces.js", line: 4 };
  const g = ground([
    { ...at, title: "lone brace", evidence: "}" },
    { ...at, title: "braces and keywords", evidence: ["  }", "  return;", "}"] },
    // Real content: the brace lines around it neither count nor need to match.
    { ...at, title: "brace and a real line", evidence: ["  }", "return grantAccess(user);"] },
    { ...at, title: "invented braces still fail on the real line", evidence: ["}", "return denyAccess(user);"] },
    // A brace that is not even in the file does not matter: only lines with content must match.
    { ...at, title: "real line, odd brace", evidence: ["})]", "if (user.admin) {"] },
  ]);
  assert.deepEqual(kept(g), ["brace and a real line", "real line, odd brace"]);
  assert.deepEqual(why(g), [
    ["lone brace", "evidence too thin"],
    ["braces and keywords", "evidence too thin"],
    ["invented braces still fail on the real line", "evidence not in the code"],
  ]);
});

// A new file made of these lines, one per line.
const fileOf = (lines) => `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("distinctive evidence: the reviewer's table", () => {
  // Short, generic-looking lines still ground a finding when they are unique in their file.
  const unique = ["for (let i = 0; i <= n; i++) {", "if err != nil {", "const y = x / 0;", "return a[i] - b[i];", "if (!ok) return;", "dx := x1 - x0", "self.n = n + 1"];
  const p = prepareFiles([{ filename: "src/t.js", patch: fileOf(unique) }]);
  const g = ground(unique.map((l, i) => ({ path: "src/t.js", line: i + 1, title: `u${i}`, evidence: l })), { p });
  assert.deepEqual(kept(g), unique.map((_, i) => `u${i}`), JSON.stringify(why(g)));
  // Twice in the file is still distinctive enough for a line nearby; three times is not.
  for (const l of unique) {
    const twice = prepareFiles([{ filename: "src/t.js", patch: fileOf([l, "first();", l]) }]);
    assert.deepEqual(kept(ground([{ path: "src/t.js", line: 3, title: "twice", evidence: l }], { p: twice })), ["twice"], l);
    const thrice = prepareFiles([{ filename: "src/t.js", patch: fileOf([l, "first();", l, "second();", l]) }]);
    assert.deepEqual(why(ground([{ path: "src/t.js", line: 3, title: "thrice", evidence: l }], { p: thrice })), [["thrice", "evidence too thin"]], l);
  }
  // These do not count when they repeat.
  for (const l of ["}", "return null;", "} catch (error) {"]) {
    const thrice = prepareFiles([{ filename: "src/t.js", patch: fileOf([l, "first();", l, "second();", l]) }]);
    assert.deepEqual(why(ground([{ path: "src/t.js", line: 3, title: "repeated", evidence: l }], { p: thrice })), [["repeated", "evidence too thin"]], l);
  }
  // A line that names something of its own counts even when it repeats (up to five times).
  const named3 = prepareFiles([{ filename: "src/t.js", patch: fileOf(["grantAccess(user);", "first();", "grantAccess(user);", "second();", "grantAccess(user);"]) }]);
  assert.deepEqual(kept(ground([{ path: "src/t.js", line: 3, title: "named", evidence: "grantAccess(user);" }], { p: named3 })), ["named"]);
  // Pure punctuation never counts, even when it is unique.
  const punct = prepareFiles([{ filename: "src/t.js", patch: fileOf(["start();", "})];", "end();"]) }]);
  assert.deepEqual(why(ground([{ path: "src/t.js", line: 2, title: "punct", evidence: "})];" }], { p: punct })), [["punct", "evidence too thin"]]);
});

test("a finding outside the diff matches anywhere in its file, so its line must occur there only once", () => {
  const twice = prepareFiles([{ filename: "src/t.js", patch: fileOf(["const y = x / 0;", "first();", "const y = x / 0;", "grantAccess(user);", "grantAccess(user);"]) }]);
  const g = ground([
    // Line 99 is outside the diff: a general finding.
    { path: "src/t.js", line: 99, title: "twice, generic", evidence: "const y = x / 0;" },
    { path: "src/t.js", line: 99, title: "twice, named", evidence: "grantAccess(user);" },
    { path: "src/t.js", line: 99, title: "once", evidence: "first();" },
  ], { p: twice });
  assert.deepEqual(kept(g), ["once"]);
  assert.deepEqual(why(g), [["twice, generic", "evidence too thin"], ["twice, named", "evidence too thin"]]);
  // Inline, near the cited line, the same two lines are fine.
  assert.deepEqual(kept(ground([{ path: "src/t.js", line: 3, title: "inline", evidence: "const y = x / 0;" }], { p: twice })), ["inline"]);
});

test("a multi-line suggestion's whole range counts as near the cited line", () => {
  const p = prepared();
  const c = classifyFindings({ findings: [{ path: "src/long.js", start_line: 2, line: 12, title: "range", body: "b", evidence: "const v2 = compute(2);",
    suggestion: Array.from({ length: 11 }, (_, i) => `const v${i + 2} = compute(${i + 2}) | 0;`).join("\n") }] }, p.commentable, p.lineText);
  assert.ok(c.inline[0].suggestion);
  assert.deepEqual(kept(groundFindings(c, p)), ["range"]);
});

test("a name that is not in the change is dropped; keywords, globals and the PR's own words are kept", () => {
  const ev = { path: "src/long.js", line: 3, evidence: "const v3 = compute(3);" };
  const g = ground([
    { ...ev, title: "symbol in diff", symbols: ["compute", "v3"] },
    { ...ev, title: "invented symbol", symbols: ["computeAsync"] },
    { ...ev, title: "Calls `memoize` here" },
    { ...ev, title: "t1", claim: "It awaits `fetchUser`." },
    { ...ev, title: "t2", body: "Wrap `compute` in a `Promise` and check for `null`, `undefined` and `NaN`." },
    { ...ev, title: "t3", body: "The `values` field is never read." },
    { ...ev, title: "t4", symbols: ["values"], body: "named in the description" },
    // A bare word is not a name: only backticked identifiers and symbols count.
    { ...ev, title: "t5", body: "memoize would help, as would a `compute()` cache." },
    // Partial words do not count: "comp" is not a whole word of the diff.
    { ...ev, title: "t6", symbols: ["comp"] },
    // The body is prose, which may name what a fix would add: not checked.
    { ...ev, title: "t7", body: "Add a `cacheLayer` here." },
    // Nor is a suggestion: new code may define new names.
    { ...ev, title: "t8", suggestion: "const v3 = memoizedCompute(3);" },
    { ...ev, title: "t9", claim: "The `values` field is never read." },
  ], { body: "Adds the `values` table." });
  assert.deepEqual(kept(g), ["symbol in diff", "t2", "t3", "t4", "t5", "t7", "t8", "t9"]);
  assert.ok(g.classified.inline.find((f) => f.title === "t8").suggestion, "the suggestion is kept");
  assert.deepEqual(why(g), [
    ["invented symbol", "names something not in the change: computeAsync"],
    ["Calls `memoize` here", "names something not in the change: memoize"],
    ["t1", "names something not in the change: fetchUser"],
    ["t6", "names something not in the change: comp"],
  ]);
  // Shown anywhere, the name itself never is: only its kind.
  assert.equal(publicReason(g.dropped[0].reason), REASONS.unnamed);
  assert.equal(publicReason(REASONS.notInCode), REASONS.notInCode);
});

test("a dotted path checks its last segment", () => {
  const ev = { path: "src/long.js", line: 3, evidence: "const v3 = compute(3);" };
  const g = ground([
    { ...ev, title: "dotted ok", symbols: ["this.helpers.compute"], claim: "See `cache.v3` and `utils.compute()`." },
    { ...ev, title: "global, unknown member", claim: "See `Math.hypot()`." },
    { ...ev, title: "dotted bad", claim: "See `compute.invalidate`." },
    { ...ev, title: "symbol dotted bad", symbols: ["compute.flush()"] },
    { ...ev, title: "not a path", symbols: ["compute(v3) / 0"] },
    { ...ev, title: "not a path, bad", symbols: ["compute(v99)"] },
  ]);
  assert.deepEqual(kept(g), ["dotted ok", "not a path"]);
  assert.deepEqual(why(g).map(([, r]) => r), [
    "names something not in the change: hypot",
    "names something not in the change: invalidate",
    "names something not in the change: flush",
    "names something not in the change: v99",
  ]);
});

test("an unbalanced suggestion is stripped and its finding kept", () => {
  const p = prepareFiles([{ filename: "src/a.js", patch: GROUNDED_PATCH }, { filename: "conf/x.json", patch: '@@ -1,1 +1,1 @@\n-{"name": [1]}\n+{"name": [2]}' }]);
  const base = { path: "src/a.js", line: 3, severity: "minor", category: "bug", title: "t", body: "b", evidence: "const ratio = total / 0;" };
  const one = (suggestion, over = {}) => {
    const c = classifyFindings({ findings: [{ ...base, suggestion, ...over }] }, p.commentable, p.lineText);
    assert.ok(c.inline[0].suggestion, `classifyFindings kept ${suggestion}`);
    const g = groundFindings(c, p);
    assert.equal(g.dropped.length, 0);
    return g;
  };
  assert.ok(one("const y = x === 0 ? 0 : x / 2;").classified.inline[0].suggestion);
  assert.ok(one("const y = f(x, [1, 2], { a: '(' });").classified.inline[0].suggestion, "brackets inside strings do not count");
  assert.ok(one("const y = x / 2; // (unclosed in a comment").classified.inline[0].suggestion);
  for (const bad of ["const y = (x / 2;", "const y = [x / 2;", "const y = x / 2; }", "const y = 'x / 2;", "const y = `x / 2;"]) {
    const g = one(bad);
    assert.equal(g.classified.inline.length, 1, bad);
    assert.equal(g.classified.inline[0].suggestion, null, bad);
    assert.equal(g.classified.inline[0].note, REASONS.unbalanced);
    assert.deepEqual(g.stripped.map((s) => s.reason), [REASONS.unbalanced]);
  }
  // JSON: the replacement of a balanced line must nest correctly.
  const json = { ...base, path: "conf/x.json", line: 1, evidence: '{"name": [2]}' };
  assert.ok(one('{"name": [3]}', json).classified.inline[0].suggestion);
  assert.equal(one('{"name": [3}]', json).classified.inline[0].suggestion, null);
  // The rough lexer: Python's // is division, # starts a comment there.
  assert.deepEqual(codeShape("x = (a // b)", "a.py").parens, 0);
  assert.deepEqual(codeShape("x = f(  # (\n)", "a.py").parens, 0);
  assert.equal(codeShape("it's (fine)", "README.md").parens, 0);
  assert.ok(suggestionBalanced({ original: "if (a) {", code: "if (b) {" }, "a.js"), "a range may open a block it does not close");
  assert.ok(!suggestionBalanced({ original: "if (a) {", code: "if (b) {}" }, "a.js"));
});

test("the gate stays linear on hostile input (10 ms of CPU on Workers Free)", () => {
  // A diff of k times 90,000 characters, and twelve findings built to be slow.
  const setup = (k) => {
    const rows = Array.from({ length: 2400 * k }, (_, i) => `+${"a.".repeat(15)}b${i} = (${"[".repeat(3)}`);
    const big = prepareFiles([{ filename: "src/big.js", patch: `@@ -0,0 +1,${rows.length} @@\n${rows.join("\n")}` }], { maxChars: 90_000 * k, maxFileChars: 90_000 * k });
    const findings = Array.from({ length: 12 }, (_, i) => ({
      path: "src/big.js", line: 5 + i, severity: "minor", category: "bug", title: `t${i} ${"`a.a`".repeat(15)}`,
      // Real evidence and names, so every check runs to the end.
      claim: "`a`".repeat(90), body: `${"`a.a.b0`".repeat(80)}`, evidence: [`${"a.".repeat(15)}b${4 + i} = (${"[".repeat(3)}`],
      symbols: Array.from({ length: 12 }, () => "a.".repeat(39) + "a"),
      suggestion: "(".repeat(1500) + "'\"`".repeat(400),
    }));
    return { big, c: classifyFindings({ findings }, big.commentable, big.lineText) };
  };
  const sized = { 1: setup(1), 4: setup(4) };
  const run = (k) => groundFindings(sized[k].c, sized[k].big, { title: "x".repeat(300), body: "y ".repeat(1500) });
  // The fastest of five warm passes is the gate's own cost, not the machine's noise.
  const ms = bestOf(5, () => run(1));
  assert.ok(ms < 25, `one pass took ${ms.toFixed(1)} ms`);
  // Four times the diff costs about four times the time, not sixteen.
  const g = growth(run);
  assert.ok(g < 8, `4x the diff took ${g.toFixed(1)}x the time`);
  const { big, c } = sized[1];
  const g1 = groundFindings(c, big, {});
  assert.equal(g1.dropped.length, 0, JSON.stringify(g1.dropped.map((d) => d.reason)));
  assert.equal(g1.stripped.length, 12, "every check ran, the last one included");
});

test("keyword-only evidence does not ground a finding; '} catch (error) {' does when it is unique", () => {
  const CATCH = "@@ -0,0 +1,6 @@\n+try {\n+  return loadProfile(user);\n+} catch (error) {\n+  return null;\n+}\n+";
  const p = prepareFiles([{ filename: "src/catch.js", patch: CATCH }]);
  const at = { path: "src/catch.js", line: 3 };
  const g = ground([
    // Keywords and null only: nothing to find it by.
    { ...at, title: "returns null", evidence: "return null;" },
    // "error" is a name, not a keyword, and this catch is the only one in the file.
    { ...at, title: "the catch", evidence: "} catch (error) {" },
    { ...at, title: "both", evidence: ["} catch (error) {", "  return null;"] },
    { ...at, title: "grounded", evidence: ["} catch (error) {", "return loadProfile(user);"] },
    // error is an allowed name for the symbol check (Go's built-in type, and every catch clause's).
    { ...at, title: "names error", evidence: "return loadProfile(user);", symbols: ["error"], claim: "The `error` is swallowed." },
  ], { p });
  assert.deepEqual(kept(g), ["the catch", "both", "grounded", "names error"]);
  assert.deepEqual(why(g), [["returns null", "evidence too thin"]]);
});

test("word-like closers and bare tags say nothing, and a named line repeated six times is not distinctive", () => {
  for (const l of ["end", "  end", "endif", "</div>", "<br/>", "<x:y />", "fi", "done", "pub fn", "end end"]) assert.equal(hasContent(l), false, l);
  // A tag with attributes, or code beside the tags, is content.
  for (const l of ['<div class="banner">', "<td>{total}</td>", "pub fn main() {", "use std::io;"]) assert.equal(hasContent(l), true, l);
  assert.equal(named("end"), false, "a keyword is never a name of its own");
  // A lone end or </div> that repeats does not ground a finding.
  for (const l of ["end", "</div>"]) {
    const p = prepareFiles([{ filename: "src/t.rb", patch: fileOf([l, "first()", l, "second()", l]) }]);
    assert.deepEqual(why(ground([{ path: "src/t.rb", line: 3, title: "closer", evidence: l }], { p })), [["closer", "evidence too thin"]], l);
  }
  // end ten times, next to a unique named line: it passes, through that line.
  const ends = [...Array(5).fill("end"), "grant_access(user)", ...Array(5).fill("end")];
  const pe = prepareFiles([{ filename: "src/t.rb", patch: fileOf(ends) }]);
  assert.deepEqual(kept(ground([{ path: "src/t.rb", line: 6, title: "through the named line", evidence: ["end", "grant_access(user)", "end"] }], { p: pe })), ["through the named line"]);
  assert.deepEqual(why(ground([{ path: "src/t.rb", line: 6, title: "ends only", evidence: ["end", "end"] }], { p: pe })), [["ends only", "evidence too thin"]]);
  // A named line: five times nearby still counts; six or more do not.
  const repeated = (n) => prepareFiles([{ filename: "src/t.js", patch: fileOf(Array(n).fill("grantAccess(user);")) }]);
  assert.deepEqual(kept(ground([{ path: "src/t.js", line: 3, title: "five", evidence: "grantAccess(user);" }], { p: repeated(5) })), ["five"]);
  for (const n of [6, 9]) {
    assert.deepEqual(why(ground([{ path: "src/t.js", line: 3, title: "many", evidence: "grantAccess(user);" }], { p: repeated(n) })), [["many", "evidence too thin"]], String(n));
  }
});
