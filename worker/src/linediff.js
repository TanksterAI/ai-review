// A line diff, for the files GitHub sends without a patch (its API leaves the
// patch out of very large diffs). The Worker fetches the old and new text and
// works the diff out itself, so those files are reviewed too.
//
// Myers' O(ND) algorithm, with three lines of context, like git. Myers needs
// memory in the square of the edits, so past maxEdits a range is first cut
// at its anchors (patience diff: lines that occur exactly once on each side,
// kept in order), and each piece between anchors is diffed on its own. Only a
// piece with no anchor that is still too different becomes one hunk that
// removes the old lines and adds the new ones. Every diff is exact (applying
// it gives the new text); only the last case is not minimal. Large files are
// what GitHub leaves the patch out of, so nothing here spreads a long array
// into a call. Runs in a Durable Object alarm (30 s of CPU), never in a request.

function split(text) {
  const s = String(text ?? "");
  if (s === "") return [];
  return (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n");
}

// The edit script turning a into b, as [op, line] with op "=", "-" or "+",
// or null when it needs more than maxD edits.
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    // The values from the last round that this round reads: k in [-d-1, d+1].
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const t = trace[d];
    const at = (k) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(["=", a[x - 1]]); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push(["+", b[y - 1]]);
      else ops.push(["-", a[x - 1]]);
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// Lines that occur exactly once in a[lo..hi) and once in b[blo..bhi), paired
// and kept in the order of both (the longest increasing run, by patience
// sorting): the anchors a patience diff cuts at.
function anchors(a, alo, ahi, b, blo, bhi) {
  const count = new Map();
  for (let i = alo; i < ahi; i++) { const c = count.get(a[i]) ?? [0, 0, -1, -1]; c[0]++; c[2] = i; count.set(a[i], c); }
  for (let j = blo; j < bhi; j++) { const c = count.get(b[j]); if (c) { c[1]++; c[3] = j; } }
  const pairs = [];
  for (let i = alo; i < ahi; i++) { const c = count.get(a[i]); if (c && c[0] === 1 && c[1] === 1) pairs.push([c[2], c[3]]); }
  // Longest increasing subsequence of the b indices.
  const tops = [];
  const prev = new Array(pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tops.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pairs[tops[m]][1] < pairs[k][1]) lo = m + 1; else hi = m; }
    prev[k] = lo > 0 ? tops[lo - 1] : -1;
    tops[lo] = k;
  }
  const out = [];
  for (let k = tops.length ? tops[tops.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

// The edit script for a[alo..ahi) against b[blo..bhi), appended to ops.
function diffRange(a, alo, ahi, b, blo, bhi, maxD, ops, depth = 0) {
  while (alo < ahi && blo < bhi && a[alo] === b[blo]) { ops.push(["=", a[alo]]); alo++; blo++; }
  let tail = 0;
  while (ahi - tail > alo && bhi - tail > blo && a[ahi - 1 - tail] === b[bhi - 1 - tail]) tail++;
  const suffix = [];
  for (let k = ahi - tail; k < ahi; k++) suffix.push(["=", a[k]]);
  ahi -= tail;
  bhi -= tail;
  if (alo < ahi || blo < bhi) {
    const mid = alo === ahi || blo === bhi ? null : myers(a.slice(alo, ahi), b.slice(blo, bhi), maxD);
    if (alo === ahi || blo === bhi || mid) {
      if (mid) for (const op of mid) ops.push(op);
      else {
        for (let k = alo; k < ahi; k++) ops.push(["-", a[k]]);
        for (let k = blo; k < bhi; k++) ops.push(["+", b[k]]);
      }
    } else {
      const cut = depth < 12 ? anchors(a, alo, ahi, b, blo, bhi) : [];
      if (!cut.length) {
        for (let k = alo; k < ahi; k++) ops.push(["-", a[k]]);
        for (let k = blo; k < bhi; k++) ops.push(["+", b[k]]);
      } else {
        let i = alo;
        let j = blo;
        for (const [x, y] of cut) {
          diffRange(a, i, x, b, j, y, maxD, ops, depth + 1);
          ops.push(["=", a[x]]);
          i = x + 1;
          j = y + 1;
        }
        diffRange(a, i, ahi, b, j, bhi, maxD, ops, depth + 1);
      }
    }
  }
  for (const op of suffix) ops.push(op);
}

/**
 * The unified diff from oldText to newText, hunks only (no file header), or
 * "" when they are the same.
 */
export function unifiedDiff(oldText, newText, { context = 3, maxEdits = 1000 } = {}) {
  const a = split(oldText);
  const b = split(newText);
  const ops = [];
  diffRange(a, 0, a.length, b, 0, b.length, maxEdits, ops);
  if (!ops.some(([op]) => op !== "=")) return "";

  // Each op's line numbers (1-based) in the old and new file.
  const pos = [];
  let o = 1;
  let nn = 1;
  for (const [op] of ops) {
    pos.push([o, nn]);
    if (op !== "+") o++;
    if (op !== "-") nn++;
  }
  const changed = [];
  for (let i = 0; i < ops.length; i++) if (ops[i][0] !== "=") changed.push(i);
  // Changes closer than twice the context share a hunk.
  const groups = [];
  for (const i of changed) {
    const g = groups[groups.length - 1];
    if (g && i - g[1] <= 2 * context + 1) g[1] = i;
    else groups.push([i, i]);
  }
  const out = [];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldLen = 0;
    let newLen = 0;
    const head = out.length;
    out.push("");
    for (let i = from; i <= to; i++) {
      const [op, line] = ops[i];
      if (op !== "+") oldLen++;
      if (op !== "-") newLen++;
      out.push(`${op === "=" ? " " : op}${line}`);
    }
    // An empty side starts at the line before it (0 for the start of a file).
    const oldStart = oldLen ? pos[from][0] : pos[from][0] - 1;
    const newStart = newLen ? pos[from][1] : pos[from][1] - 1;
    out[head] = `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`;
  }
  return out.join("\n");
}
