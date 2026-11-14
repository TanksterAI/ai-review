import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../src/linediff.js";
import { annotatePatch } from "../src/review.js";

// Applies a unified diff to the old text, checking every context and removed
// line against it: the patch must be exact, not just plausible.
function apply(oldText, patch) {
  if (patch === "") return oldText;
  const old = oldText === "" ? [] : oldText.split("\n");
  const out = [];
  let at = 0; // index into old
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[i]);
    assert.ok(m, `a hunk header at line ${i}: ${lines[i]}`);
    const oldStart = Number(m[1]);
    const oldLen = m[2] === undefined ? 1 : Number(m[2]);
    const newLen = m[4] === undefined ? 1 : Number(m[4]);
    const from = oldLen === 0 ? oldStart : oldStart - 1;
    while (at < from) out.push(old[at++]);
    let o = 0;
    let n = 0;
    while (o < oldLen || n < newLen) {
      const l = lines[++i];
      assert.notEqual(l, undefined, "the hunk is complete");
      if (l.startsWith("+")) { out.push(l.slice(1)); n++; } else if (l.startsWith("-")) { assert.equal(old[at], l.slice(1)); at++; o++; } else {
        assert.equal(old[at], l.slice(1), "context matches the old file");
        out.push(old[at++]);
        o++;
        n++;
      }
    }
  }
  while (at < old.length) out.push(old[at++]);
  return out.join("\n");
}

const numbered = (n, word = "line") => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`);

test("no change, no diff", () => {
  assert.equal(unifiedDiff("a\nb", "a\nb"), "");
});

test("a new file is one hunk of added lines", () => {
  const patch = unifiedDiff("", "x\ny\nz");
  assert.equal(patch, "@@ -0,0 +1,3 @@\n+x\n+y\n+z");
  assert.deepEqual([...annotatePatch(patch).lines], [1, 2, 3]);
});

test("changes in the middle give hunks with three lines of context, and the patch is exact", () => {
  const old = numbered(200);
  const next = [...old];
  next[49] = "changed 50";
  next.splice(120, 0, "inserted after 120");
  next.splice(180, 3);
  const a = old.join("\n");
  const b = next.join("\n");
  const patch = unifiedDiff(a, b);
  assert.equal(apply(a, patch), b);
  assert.equal(patch.split("\n").filter((l) => l.startsWith("@@")).length, 3);
  // The annotated lines carry their true numbers in the new file.
  const { content } = annotatePatch(patch);
  assert.equal(content.get(50), "changed 50");
  assert.equal(content.get(121), "inserted after 120");
});

test("nearby changes share a hunk", () => {
  const old = numbered(30);
  const next = [...old];
  next[10] = "x";
  next[14] = "y";
  const patch = unifiedDiff(old.join("\n"), next.join("\n"));
  assert.equal(patch.split("\n").filter((l) => l.startsWith("@@")).length, 1);
  assert.equal(apply(old.join("\n"), patch), next.join("\n"));
});

test("a rewrite too different to diff cheaply is still exact: one hunk replacing the middle", () => {
  const old = numbered(4000, "old");
  const next = numbered(4000, "new");
  next[0] = old[0];
  next[3999] = old[3999];
  const patch = unifiedDiff(old.join("\n"), next.join("\n"), { maxEdits: 50 });
  assert.equal(apply(old.join("\n"), patch), next.join("\n"));
  assert.equal(annotatePatch(patch).lines.size, 4000);
});

test("random edits round-trip", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 40; k++) {
    const old = numbered(rnd(60));
    const next = [...old];
    for (let e = rnd(8); e > 0; e--) {
      const op = rnd(3);
      const at = rnd(next.length + 1);
      if (op === 0) next.splice(at, 0, `new ${k}-${e}`);
      else if (op === 1 && next.length) next.splice(Math.min(at, next.length - 1), 1);
      else if (next.length) next[Math.min(at, next.length - 1)] = `edit ${k}-${e}`;
    }
    const a = old.join("\n");
    const b = next.join("\n");
    assert.equal(apply(a, unifiedDiff(a, b)), b, `case ${k}`);
  }
});
