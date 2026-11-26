// Review context (TAN-303): what a reviewer needs to see besides the diff.
//
// A model shown only a diff cannot tell a missing check from one that sits a
// few lines above the hunk, or in the caller, or in the project's own rules.
// It reports the first as a defect (the false "Major" on performance-kitchen
// #6: the ID token's signature was verified 100 lines away). So each batch is
// shown, as read-only data beside its diff:
//
//   guidelines  the project's own rules (CLAUDE.md, AGENTS.md, .cursorrules,
//               .github/copilot-instructions.md, .claude/rules/*.md), read
//               from the pull request's BASE commit: a pull request cannot
//               rewrite the rules it is judged by
//   files       each changed file as it is after the change, with line
//               numbers: all of it when it fits, otherwise the parts around
//               the diff
//   tests       the test files that belong to a changed file, found by name
//   callers     where a changed exported name is used elsewhere in the
//               repository (GitHub code search of the default branch)
//
// Everything here is pure: the stage in review-run.js does the fetching.
// Nothing leaves this module that looks like a secret (redact), and files
// that are secrets by name are never read at all.

export const CONTEXT_CHARS = 36_000;
// Of those, at most this much (and a quarter of them) is the guidelines.
export const GUIDE_CHARS = 8_000;
export const GUIDE_FILE_CHARS = 5_000;
export const MAX_GUIDE_FILES = 8;
// Changed files whose text is fetched in one review, and the size past
// which a file is not fetched (a very large file is not read whole).
export const MAX_CONTEXT_FILES = 60;
export const MAX_CONTEXT_FILE_CHARS = 100_000;
export const MAX_TESTS = 6;
// Blobs bigger than this (bytes, from the tree) are not fetched at all: only the first part of a guideline or a test is ever shown.
export const MAX_GUIDE_BLOB_BYTES = 400_000;
export const MAX_TEST_BLOB_BYTES = 400_000;
export const TESTS_PER_FILE = 2;
export const MAX_CALLER_SYMBOLS = 4;
export const CALLERS_PER_SYMBOL = 3;
export const CALLER_FRAGMENT_CHARS = 400;
const LINE_CHARS = 400;

// --- what must never be read or sent ---------------------------------------

const SECRET_PATH = new RegExp(
  "(^|/)(" + [
    "\\.env(rc)?($|\\.[^/]*$)", "[^/]*\\.env$", "\\.dev\\.vars(\\.[^/]*)?$",
    "\\.npmrc$", "\\.yarnrc\\.yml$", "\\.netrc$", "\\.pypirc$", "\\.pgpass$", "\\.htpasswd$", "\\.git-credentials$", "wp-config\\.php$",
    "[^/]*kubeconfig(\\.[^/]*)?$", "\\.kube/", "\\.docker/config\\.json$",
    "id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$",
    "credentials(\\.(json|ya?ml|toml|ini|txt|csv|xml))?$",
    "[^/]*secrets?\\.(json|ya?ml|toml|env|txt)$", "client_secret[^/]*\\.json$",
    "[^/]*service[-_]?account[^/]*\\.json$",
    "[^/]*\\.(tfstate|tfstate\\.backup|tfvars|tfvars\\.json|pem|key|p8|p12|pfx|pkcs12|jks|keystore|kdbx)$",
    "\\.?secrets?/", "\\.(ssh|aws|gnupg)/",
  ].join("|") + ")", "i");
export const isSecretPath = (path) => SECRET_PATH.test(String(path));

const REDACT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const KEYWORD = "(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)";
// Every quantifier below is bounded, so the time a file takes is linear in its size however it is written.
// A name that holds a credential (DB_PASSWORD, "apiKey", aws_secret_access_key, `password: string`), then a quoted value.
const NAME_THEN = `(${KEYWORD}\\w{0,40}["']?(?:\\s{0,20}:\\s{0,20}[\\w<>|]{1,30})?\\s{0,20}[:=]\\s{0,20})`;
// The value runs to the quote that opened it, so a quote of another kind inside it ("it's ...") does not end it early, and a backslash escapes the next character.
const QUOTED = (q) => `${q}(?:[^${q}\\\\\\n]|\\\\.){8,500}${q}`;
const ASSIGNED = new RegExp(`${NAME_THEN}(${QUOTED('"')}|${QUOTED("'")}|${QUOTED("`")})`, "gi");
// The same with no quotes (an .env style line, YAML): a value that looks like a secret (12 or more characters with a digit and a letter, not a call or a path into an object).
const ASSIGNED_BARE = new RegExp(`${NAME_THEN}(?=[A-Za-z0-9+/_~=-]{0,200}\\d)(?=[A-Za-z0-9+/_~=-]{0,200}[A-Za-z])[A-Za-z0-9+/_~=-]{12,200}(?![\\w(.])`, "gi");
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,64}:)[^\s@]{3,200}(@)/gi;
const BEARER = /\b(Bearer\s{1,5})[A-Za-z0-9._~+/-]{20,2000}=*/gi;

/** The text with the common forms of a credential blanked out (a safety net, not a guarantee). */
export function redact(text) {
  let t = String(text ?? "");
  // A blanked block keeps its line breaks, so the line numbers shown after it stay true.
  for (const re of REDACT) t = t.replace(re, (m) => `[redacted]${"\n".repeat(m.split("\n").length - 1)}`);
  return t
    .replace(ASSIGNED, (_m, name, value) => `${name}${value[0]}[redacted]${value[0]}`)
    .replace(ASSIGNED_BARE, "$1[redacted]")
    .replace(URL_PASSWORD, "$1[redacted]$2")
    .replace(BEARER, "$1[redacted]");
}

/** The text with any half of a surrogate pair (a cut through an emoji) replaced, so it is well-formed. */
export const wellFormed = (text) => String(text ?? "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");

// --- the repository's tree ---------------------------------------------------

/** Blobs of a git tree response: [{path, sha, size}] (directories and submodules left out). */
export function parseTree(tree) {
  const list = Array.isArray(tree?.tree) ? tree.tree : [];
  return list
    .filter((e) => e && e.type === "blob" && typeof e.path === "string" && /^[0-9a-f]{40}$/.test(String(e.sha)))
    .map((e) => ({ path: e.path, sha: e.sha, size: Number(e.size) || 0 }));
}

const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);

// --- guidelines -----------------------------------------------------------------

const ROOT_GUIDES = ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md"];
const DIR_GUIDES = ["CLAUDE.md", "AGENTS.md"];
const RULES = /^\.claude\/rules\/(?:[^/]+\/)*[^/]+\.md$/;

/**
 * The guideline files to read, from the base commit's tree: the root ones,
 * the CLAUDE.md or AGENTS.md of every directory above a changed file, and
 * .claude/rules. Root files first, then deeper directories; at most
 * MAX_GUIDE_FILES. Each: {path, sha, dir} (dir: where it applies, "" for all).
 */
export function pickGuidelines(entries, changedPaths) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const out = [];
  const add = (path, dir) => {
    const e = byPath.get(path);
    if (e && e.size > 0 && e.size <= MAX_GUIDE_BLOB_BYTES && !out.some((x) => x.path === path)) out.push({ path, sha: e.sha, dir });
  };
  for (const p of ROOT_GUIDES) add(p, "");
  const dirs = new Set();
  for (const path of changedPaths) {
    let d = dirOf(path);
    while (d) { dirs.add(d); d = dirOf(d); }
  }
  const nested = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  for (const d of nested) for (const n of DIR_GUIDES) add(`${d}/${n}`, d);
  for (const e of entries.filter((x) => RULES.test(x.path)).sort((a, b) => (a.path < b.path ? -1 : 1))) add(e.path, "");
  return out.slice(0, MAX_GUIDE_FILES);
}

// The items of an inline list, split at the commas outside quotes and braces: `["src/*.{ts,tsx}", 'lib/**']` is two.
function splitInline(text) {
  const out = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (const c of String(text)) {
    if (quote) { if (c === quote) quote = ""; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && depth > 0) depth--;
    else if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// A rule file may name the paths it applies to in its front matter
// (`paths:` as a YAML list, or `globs:`); one without applies everywhere.
export function ruleScope(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
  if (!m) return [];
  const globs = [];
  let inList = false;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trimEnd();
    const key = /^(paths|globs)\s*:\s*(.*)$/.exec(line);
    if (key) {
      inList = true;
      for (const g of splitInline(key[2].replace(/^\[|\]$/g, ""))) if (g.trim()) globs.push(g.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (inList && item) { globs.push(item[1].trim().replace(/^["']|["']$/g, "")); continue; }
    if (/^\S/.test(line)) inList = false;
  }
  return globs.slice(0, 20);
}

// Each run of stars multiplies the work a failed match does. A glob with more than this many (or with stars and alternatives past MAX_GLOB_WORK together) is not compiled: it applies to every path (a rule shown too widely does no harm; one left out would), and paths longer than MAX_SCOPE_PATH do not match a scope at all.
export const MAX_GLOB_STARS = 3;
// Runs of stars plus commas (the alternatives of a brace) together: each multiplies the work of a failed match.
export const MAX_GLOB_WORK = 5;
export const MAX_SCOPE_PATH = 200;
const reCache = new Map();
/** A glob (`*`, `**`, `?`) as a regular expression on a whole path. */
export function globToRegExp(glob) {
  if (reCache.has(glob)) return reCache.get(glob);
  let re = "";
  let depth = 0;
  const g = String(glob).slice(0, 200);
  const stars = (g.match(/\*+/g) ?? []).length;
  if (stars > MAX_GLOB_STARS || stars + (g.match(/,/g) ?? []).length > MAX_GLOB_WORK) { const any = /^/; reCache.set(glob, any); return any; }
  // Alternatives multiply the work a failed match does, so a glob with more than a few of them keeps its braces as plain characters.
  const braces = (g.match(/\{/g) ?? []).length <= 3 && (g.match(/,/g) ?? []).length <= 8;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      // A run of stars is one wildcard: two or more cross directories, one does not.
      let j = i;
      while (g[j] === "*") j++;
      if (j - i >= 2) { re += g[j] === "/" ? "(?:.*/)?" : ".*"; i = g[j] === "/" ? j : j - 1; }
      else re += "[^/]*";
    }
    else if (c === "?") re += "[^/]";
    else if (c === "{" && braces) { depth++; re += "(?:"; }
    else if (c === "}" && braces && depth > 0) { depth--; re += ")"; }
    else if (c === "," && braces && depth > 0) re += "|";
    else re += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  re += ")".repeat(depth);
  const out = new RegExp(`^${re}$`);
  reCache.set(glob, out);
  return out;
}

/** The guidelines that apply to the files of one batch, as text. `used` collects the paths of those shown. */
export function guideText(guidelines, paths, cap, used = []) {
  const parts = [];
  let size = 0;
  for (const g of guidelines) {
    if (g.dir && !paths.some((p) => p.startsWith(`${g.dir}/`))) continue;
    if (g.scope?.length && !paths.some((p) => p.length <= MAX_SCOPE_PATH && g.scope.some((s) => globToRegExp(s).test(p)))) continue;
    const block = `## ${g.path}\n${g.text}\n`;
    // The newline that joins a block to the one before it is part of the cap too.
    const join = parts.length ? 1 : 0;
    if (size + join + block.length > cap) {
      // What is left, less the heading and the marker that says it was cut.
      const head = `## ${g.path}\n`;
      const tail = "\n[cut]\n";
      const room = cap - size - join - head.length - tail.length;
      if (room > 200) { parts.push(`${head}${g.text.slice(0, room)}${tail}`); used.push(g.path); }
      break;
    }
    parts.push(block);
    used.push(g.path);
    size += join + block.length;
  }
  return parts.join("\n");
}

// --- tests that belong to a file ----------------------------------------------

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e)(\/|$)/i;
const TEST_NAME = /(^|[._-])(test|tests|spec)([._-]|$)|^test_|_test\.[^.]+$/i;
export const isTestPath = (path) => TEST_DIR.test(path) || TEST_NAME.test(baseOf(path));

// "auth.test.ts", "auth_test.go", "test_auth.py", "auth.spec.js" -> "auth".
function stemOf(path) {
  let n = baseOf(path).replace(/\.[^.]+$/, "");
  n = n.replace(/\.(test|spec)$/i, "").replace(/[._-](test|tests|spec)$/i, "").replace(/^(test|tests|spec)[._-]/i, "");
  return n.toLowerCase();
}

/** An index of the tree's test files by the file name they are named for. */
export function indexTests(entries) {
  const index = new Map();
  for (const e of entries) {
    // A size that is missing (0) means the blob's weight is unknown, so it is not fetched.
    if (!isTestPath(e.path) || isSecretPath(e.path) || !(e.size > 0 && e.size <= MAX_TEST_BLOB_BYTES)) continue;
    const s = stemOf(e.path);
    if (!s) continue;
    if (!index.has(s)) index.set(s, []);
    index.get(s).push(e);
  }
  return index;
}

const shared = (a, b) => {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
};

/** The tests of a changed file: up to TESTS_PER_FILE, those nearest it first. */
export function testsFor(index, path) {
  if (isTestPath(path)) return [];
  const hits = index.get(stemOf(path)) ?? [];
  return hits
    .map((e) => ({ e, near: shared(path, e.path) }))
    .sort((a, b) => b.near - a.near || (a.e.path < b.e.path ? -1 : 1))
    .slice(0, TESTS_PER_FILE)
    .map((x) => x.e);
}

// --- names that other files may use -----------------------------------------------

const EXPORTED = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*class\s+([A-Za-z_][\w]*)\s*[(:]/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z][\w]*)\s*\(/,
  /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
  /^\s*public\s+(?:static\s+)?[\w<>[\],\s]+?\s+([A-Za-z_][\w]*)\s*\(/,
];
const COMMON = new Set(["default", "main", "init", "setup", "index", "handler", "constructor", "test", "run", "get", "set", "new", "from", "load", "start", "stop", "build", "name", "data", "value"]);

/** The names a patch adds, changes or removes that other files may call (the first few). */
export function changedSymbols(patch, max = MAX_CALLER_SYMBOLS) {
  const found = [];
  for (const line of String(patch ?? "").split("\n")) {
    if (!/^[+-][^+-]/.test(line) && !/^[+-]$/.test(line)) continue;
    const text = line.slice(1);
    for (const re of EXPORTED) {
      const m = re.exec(text);
      if (!m) continue;
      const name = m[1];
      if (name.length >= 4 && /^[A-Za-z_$][\w$]{2,79}$/.test(name) && !COMMON.has(name.toLowerCase()) && !found.includes(name)) found.push(name);
      break;
    }
    if (found.length >= max) break;
  }
  return found;
}

/** A code-search hit as the fragments worth showing; the changed files themselves are left out. */
export function callerHits(items, symbol, exclude) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const path = String(it?.path ?? "");
    if (!path || exclude.has(path) || isSecretPath(path)) continue;
    const fragment = (Array.isArray(it.text_matches) ? it.text_matches : []).map((m) => String(m?.fragment ?? "")).find((f) => f.includes(symbol));
    if (!fragment) continue;
    out.push({ path, fragment: redact(fragment).replace(/\s+$/g, "").slice(0, CALLER_FRAGMENT_CHARS) });
    if (out.length >= CALLERS_PER_SYMBOL) break;
  }
  return out;
}

// --- a file as the model sees it ------------------------------------------------------

const cutLine = (l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}… [line cut]` : l);

/**
 * A file's text with line numbers, within cap characters: all of it when it
 * fits, otherwise the lines within `radius` of a changed line (the diff's
 * lines), the radius shrinking until it fits. Gaps are marked.
 */
export function excerpt(text, near, cap) {
  const lines = String(text ?? "").split("\n");
  const width = String(lines.length).length;
  const fmt = (n) => `${String(n).padStart(width)}| ${cutLine(lines[n - 1])}`;
  const all = lines.map((_, i) => fmt(i + 1)).join("\n");
  if (all.length <= cap) return { text: all, whole: true };
  const marks = [...near].filter((n) => Number.isInteger(n) && n >= 1 && n <= lines.length).sort((a, b) => a - b);
  for (const radius of [30, 15, 8, 3, 0]) {
    const keep = [];
    let end = 0;
    for (const n of marks) {
      const from = Math.max(1, n - radius, end + 1);
      const to = Math.min(lines.length, n + radius);
      if (to < from) continue;
      keep.push([from, to]);
      end = to;
    }
    const out = [];
    let prev = 0;
    for (const [from, to] of keep) {
      if (from > prev + 1) out.push(`${" ".repeat(width)}| … lines ${prev + 1}-${from - 1} not shown`);
      for (let n = from; n <= to; n++) out.push(fmt(n));
      prev = to;
    }
    if (prev < lines.length) out.push(`${" ".repeat(width)}| … lines ${prev + 1}-${lines.length} not shown`);
    const joined = out.join("\n");
    if (joined.length <= cap) return { text: joined, whole: false };
    if (radius === 0) {
      const mark = "\n[cut: over the room for this file]";
      return { text: cap > mark.length ? `${joined.slice(0, cap - mark.length)}${mark}` : "", whole: false };
    }
  }
  return { text: "", whole: false };
}

/**
 * The context of one batch, from what the stage stored: {text, guide, files:
 * Map(path -> text), counts}. data: {guidelines: [{path, dir, scope, text}],
 * files: Map(path -> text), tests: Map(path -> [{path, text}]), callers:
 * Map(path -> [{symbol, hits: [{path, fragment}]}])}. prepared: the batch
 * (included, shown). cap: the characters it may use in all.
 */
export function batchContext(data, prepared, cap = CONTEXT_CHARS) {
  const paths = prepared.included ?? [];
  const usedGuides = [];
  const guide = guideText(data.guidelines ?? [], paths, Math.min(GUIDE_CHARS, Math.floor(cap / 4)), usedGuides);
  // What was shown, by name: a file split across batches is in each of them, and the review counts it once.
  const names = { guidelines: usedGuides, files: [], tests: [], callers: [] };
  const want = paths.filter((p) => data.files?.has(p) || data.tests?.get(p)?.length || data.callers?.get(p)?.length);
  // The blank lines that join the guidelines and the files are part of the cap too: they are taken here, once.
  let room = Math.max(0, cap - guide.length - 2 * (want.length + 1));
  // Files with the least to show are served first, so one big file cannot
  // starve the small ones: each gets an equal share of what is left.
  const order = want.map((p, i) => ({ p, i, size: (data.files?.get(p) ?? "").length })).sort((a, b) => a.size - b.size || a.i - b.i);
  const blocks = new Map();
  const counts = { guidelines: 0, files: 0, whole: 0, tests: 0, callers: 0 };
  let left = order.length;
  for (const { p } of order) {
    const share = Math.floor(room / left--);
    const related = [];
    const tests = data.tests?.get(p) ?? [];
    const callers = data.callers?.get(p) ?? [];
    for (const t of tests) related.push(`#### Test: ${t.path}\n${t.text}`);
    for (const c of callers) {
      if (!c.hits.length) continue;
      related.push(`#### Uses of ${c.symbol} elsewhere in the repository\n${c.hits.map((h) => `${h.path}:\n${h.fragment}`).join("\n---\n")}`);
    }
    const relatedText = related.join("\n\n");
    const relatedCap = relatedText ? Math.min(relatedText.length, Math.floor(share * 0.4)) : 0;
    const body = data.files?.has(p) ? excerpt(data.files.get(p), prepared.shown?.get(p) ?? [], Math.max(0, share - relatedCap - p.length - 80)) : null;
    const parts = [];
    if (body?.text) parts.push(`### ${p} (the file after the change${body.whole ? "" : ", the parts near the diff"})\n${body.text}`);
    // A cut marker that does not fit is left out, so a tiny cap gives nothing rather than a marker over the limit.
    const relatedShown = relatedText.length <= relatedCap ? relatedText : relatedCap > 7 ? `${relatedText.slice(0, relatedCap - 7)}\n[cut]` : "";
    if (relatedCap > 0 && relatedShown) parts.push(relatedShown);
    const block = parts.join("\n\n");
    if (!block) continue;
    blocks.set(p, block);
    room -= block.length;
    if (body?.text) { counts.files++; names.files.push(p); if (body.whole) counts.whole++; }
    // Counted from what is shown: a cut can drop the later entries.
    if (relatedShown) {
      for (const t of tests) if (relatedShown.includes(`#### Test: ${t.path}\n`)) { counts.tests++; names.tests.push(t.path); }
      for (const c of callers) if (c.hits.length && relatedShown.includes(`#### Uses of ${c.symbol} elsewhere in the repository\n`)) { counts.callers++; names.callers.push(`${p}:${c.symbol}`); }
    }
  }
  counts.guidelines = usedGuides.length;
  const files = new Map([...blocks].filter(([, v]) => v).map(([k, v]) => [k, wellFormed(v)]));
  const filesText = paths.filter((p) => files.has(p)).map((p) => files.get(p)).join("\n\n");
  const guideOk = wellFormed(guide);
  const text = [guideOk, filesText].filter(Boolean).join("\n\n");
  return { text, guide: guideOk, filesText, files, counts, names };
}

const noteSpan = (n) => {
  const t = wellFormed(String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 200));
  // Plain words, digits and the punctuation of a path or a sentence can do nothing in Markdown: shown as they are.
  if (t === "") return "";
  if (/^[A-Za-z0-9 .,'()/-]*$/.test(t) && !/www\./i.test(t) && !/\bgh-\d+\b|\b[0-9a-f]{7,40}\b/i.test(t)) return t;
  const run = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(run + 1);
  return `${fence} ${t} ${fence}`;
};

/** One line for the review's About block: what context the models were shown (summary.gathered: something was read but none of it fit). */
export function contextLine(summary) {
  if (!summary) return null;
  if (summary.off) return "- Context: off; models saw the diff only.";
  const bits = [];
  if (summary.guidelines) bits.push(`${summary.guidelines} guideline file${summary.guidelines === 1 ? "" : "s"}`);
  if (summary.files) bits.push(`${summary.files} changed file${summary.files === 1 ? "" : "s"} beyond the diff`);
  if (summary.tests) bits.push(`${summary.tests} test file${summary.tests === 1 ? "" : "s"}`);
  if (summary.callers) bits.push(`uses of ${summary.callers} changed name${summary.callers === 1 ? "" : "s"}`);
  // A note can carry a path the author chose: unless it is plain, it is shown as code, so no mention, link or reference in it can act.
  const notes = (summary.notes ?? []).map((n) => noteSpan(n)).filter(Boolean).slice(0, 3).join("; ");
  return `- Context: ${bits.length ? bits.join(", ") : summary.gathered ? "none fit the allowance" : "none found"}${notes ? ` (${notes})` : ""}.`;
}
