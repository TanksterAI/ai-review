// A line diff, for the files GitHub sends without a patch (its API leaves the
// patch out of very large diffs). The Worker fetches the old and new text and
// works the diff out itself, so those files are reviewed too.
//
// Myers' O(ND) algorithm on the lines between the common prefix and suffix,
// with three lines of context, like git. A change with more than maxEdits
// edits (a rewrite) is not worth the memory of an exact minimal diff: its
// middle becomes one hunk that removes the old lines and adds the new ones.
// That is still an exact diff, just not the smallest, and every new line is
// shown. Runs in a Durable Object alarm (30 s of CPU), never in a request.

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

/**
 * The unified diff from oldText to newText, hunks only (no file header), or
 * "" when they are the same.
 */
export function unifiedDiff(oldText, newText, { context = 3, maxEdits = 1000 } = {}) {
  const a = split(oldText);
  const b = split(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (!midA.length && !midB.length) return "";
  const mid = myers(midA, midB, maxEdits) ?? [...midA.map((l) => ["-", l]), ...midB.map((l) => ["+", l])];
  const ops = [...a.slice(0, pre).map((l) => ["=", l]), ...mid, ...a.slice(a.length - suf).map((l) => ["=", l])];

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
    const body = [];
    for (let i = from; i <= to; i++) {
      const [op, line] = ops[i];
      if (op !== "+") oldLen++;
      if (op !== "-") newLen++;
      body.push(`${op === "=" ? " " : op}${line}`);
    }
    // An empty side starts at the line before it (0 for the start of a file).
    const oldStart = oldLen ? pos[from][0] : pos[from][0] - 1;
    const newStart = newLen ? pos[from][1] : pos[from][1] - 1;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...body);
  }
  return out.join("\n");
}
