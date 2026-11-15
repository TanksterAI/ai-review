// The grounding gate (TAN-299, layer 2): deterministic checks, no model, that
// a finding is about code the drafter was actually shown. It runs before the
// verifier, so a finding that misreads the lines or names an invented API
// costs nothing to drop. Every pass is linear in what it reads (Workers Free
// allows 10 ms of CPU a request): the diff's words are collected once, and
// each finding looks at no more than its own few lines.

export const REASONS = {
  noEvidence: "no evidence",
  thin: "evidence too thin",
  notInCode: "evidence not in the code",
  offChange: "not about a file in the change",
  unnamed: "names something not in the change",
  unbalanced: "suggestion stripped: unbalanced",
};

// Evidence must sit this close to the line a finding cites.
export const EVIDENCE_WINDOW = 3;

// Language keywords and well-known globals (JS/TS, Python, Go and a little
// shell): naming one is not inventing it.
const ALLOW = new Set(`
null undefined true false this self super None True False NaN Infinity globalThis window document
Promise Array Object JSON Math Date Error TypeError RangeError SyntaxError console fetch Map Set WeakMap WeakSet
String Number Boolean Symbol BigInt RegExp Reflect Proxy Intl URL URLSearchParams Request Response Headers
TextEncoder TextDecoder crypto structuredClone setTimeout clearTimeout setInterval clearInterval queueMicrotask
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent atob btoa process require module exports
Buffer ArrayBuffer Uint8Array DataView AbortController AbortSignal ReadableStream WritableStream Blob FormData
async await return const let var function class new typeof instanceof delete void in of if else for while do
switch case default break continue throw try catch finally import export from as yield static get set extends
implements interface type enum namespace declare readonly private protected public abstract keyof infer never
unknown any string number boolean object symbol bigint
def lambda pass raise except with assert global nonlocal not and or is elif print len range list dict tuple str
int float bool bytes open isinstance issubclass hasattr getattr setattr super Exception ValueError KeyError
IndexError AttributeError RuntimeError StopIteration __init__ __name__ __main__
func go defer chan select struct map package fallthrough goto nil err error make append cap copy panic recover
iota byte rune uint uint8 uint16 uint32 uint64 int8 int16 int32 int64 float32 float64 complex64 complex128 fmt
echo exit local then fi esac done
`.split(/\s+/).filter(Boolean));

const IDENT = /[A-Za-z_$][\w$]*/g;
const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
// A backticked identifier or dotted path, with an optional call: `a`, `a.b`, `f()`.
const TICKED = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;
const DOC = /\.(md|mdx|txt|rst|adoc)$/i;
const HASH_COMMENTS = /\.(py|pyi|rb|sh|bash|zsh|ya?ml|toml|pl|r|tf|conf|cfg|ini)$|(^|\/)(Dockerfile|Makefile)$/i;
const NO_SLASH_COMMENTS = /\.(py|pyi|rb|sh|bash|zsh|ya?ml|toml|pl|r|ini|cfg|conf)$/i;

export function normaliseLine(s) {
  return String(s).trim().replace(/\s+/g, " ");
}

// The forms a model may copy a line in: as it is, with the diff's
// line-number prefix, or with the leading "+" of an added line. Each still has
// to equal a line the model was shown, so none can let invented text through.
function forms(line) {
  const out = [normaliseLine(line)];
  const m = /^\s*\d+ [+ ] (.*)$/.exec(line);
  if (m) out.push(normaliseLine(m[1]));
  if (/^[+ ]/.test(line)) out.push(normaliseLine(line.slice(1)));
  return out;
}

// Keywords and the null and boolean literals, in the languages we review
// most. A line made only of these (and punctuation) says nothing about which
// line it is: "}", "return null;", "} else {". Names are not on this list,
// however common: "error" or "err" in a line can still pick it out.
const KEYWORDS = new Set(`
async await return const let var function class new typeof instanceof delete void in if else for while do
switch case default break continue throw try catch finally import export yield static extends implements
interface enum private protected public this super
def lambda pass raise except with assert global nonlocal not and or is elif
func go defer chan select struct map package fallthrough goto
then fi esac done local
end endif endfor endwhile endfunction begin unless until module require include
pub fn impl mut let match struct enum trait use mod crate
public private protected static final void override fun val
null nil None undefined true false True False
`.split(/\s+/).filter(Boolean));
const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*/g;
// A bare closing or empty tag (</div>, <br/>, <x:y />): markup with no
// attributes says no more than a brace does.
const BARE_TAG = /<\/?[\w:-]+\s*\/?>/g;
const untagged = (line) => String(line).replace(BARE_TAG, " ");

// Whether an evidence line has anything in it besides punctuation and
// keywords: a name or a number, of any length. Lines with nothing are
// ignored: they neither ground a finding nor need to match.
export function hasContent(line) {
  for (const m of untagged(line).matchAll(TOKEN)) if (!KEYWORDS.has(m[0])) return true;
  return false;
}

// Whether a line names something of its own: a name of 3 or more
// characters that is not a keyword or a well-known global (ALLOW, which does
// include common names such as "error" and "err").
export function named(line) {
  for (const m of untagged(line).matchAll(IDENT)) if (m[0].length >= 3 && !ALLOW.has(m[0]) && !KEYWORDS.has(m[0])) return true;
  return false;
}

// Evidence must be distinctive enough to find. A line with content grounds
// an inline finding if it is near the cited line and occurs at most
// MAX_REPEATS times among the file's shown lines, or names something of its
// own and occurs at most MAX_NAMED_REPEATS times.
export const MAX_REPEATS = 2;
export const MAX_NAMED_REPEATS = 5;

function addWords(text, into) {
  for (const m of String(text ?? "").matchAll(IDENT)) into.add(m[0]);
  return into;
}

// The last segment of a dotted path; or, for anything else a model put in
// `symbols`, every identifier in it.
function namesIn(symbol) {
  const t = String(symbol).trim().replace(/\(\)$/, "");
  if (DOTTED.test(t)) return [t.slice(t.lastIndexOf(".") + 1)];
  return [...t.matchAll(IDENT)].map((m) => m[0]);
}

// Bracket balance and string state of some code, with string and comment
// contents left out (roughly: one pass, no grammar). Strings in ' and " end at
// a newline if not closed; template strings run on. In prose only brackets
// count, since an apostrophe opens nothing.
export function codeShape(text, path = "") {
  const prose = DOC.test(path);
  const hash = HASH_COMMENTS.test(path);
  const slash = !NO_SLASH_COMMENTS.test(path) && !prose;
  // Character codes, not strings: this loop sees every character of every
  // suggestion and the lines it replaces.
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let dq = 0;
  let sq = 0;
  let bt = 0;
  const stack = [];
  let nested = true;
  let state = 0; // 0 code, 1 string, 2 line comment, 3 block comment
  let quote = 0;
  const s = String(text);
  const close = (kind) => { if (stack.pop() !== kind) nested = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (state === 2) { if (ch === 10) state = 0; continue; }
    if (state === 3) { if (ch === 42 && s.charCodeAt(i + 1) === 47) { state = 0; i++; } continue; }
    if (state === 1) {
      if (ch === 92) i++;
      else if (ch === quote) { if (ch === 34) dq++; else if (ch === 39) sq++; else bt++; state = 0; }
      else if (ch === 10 && quote !== 96) state = 0;
      continue;
    }
    switch (ch) {
      case 34: case 39: case 96: // " ' `
        if (prose) break;
        if (ch === 34) dq++; else if (ch === 39) sq++; else bt++;
        state = 1;
        quote = ch;
        break;
      case 47: // /
        if (!slash) break;
        if (s.charCodeAt(i + 1) === 47) state = 2;
        else if (s.charCodeAt(i + 1) === 42) { state = 3; i++; }
        break;
      case 35: // #
        if (hash && (i === 0 || /\s/.test(s[i - 1]))) state = 2;
        break;
      case 92: i++; break; // \
      case 40: parens++; stack.push(0); break;
      case 41: parens--; close(0); break;
      case 91: brackets++; stack.push(1); break;
      case 93: brackets--; close(1); break;
      case 123: braces++; stack.push(2); break;
      case 125: braces--; close(2); break;
      default: break;
    }
  }
  return { parens, brackets, braces, quotes: `${dq % 2}${sq % 2}${bt % 2}`, balanced: nested && stack.length === 0 };
}

// A suggestion must leave the code's shape as it found it: the same net
// brackets of each kind and the same open strings as the lines it replaces.
// In JSON, a replacement for lines that balance must itself nest correctly.
export function suggestionBalanced(suggestion, path) {
  const a = codeShape(suggestion.original, path);
  const b = codeShape(suggestion.code, path);
  if (a.parens !== b.parens || a.brackets !== b.brackets || a.braces !== b.braces || a.quotes !== b.quotes) return false;
  if (/\.json$/i.test(path) && a.balanced && !b.balanced) return false;
  return true;
}

/**
 * classified: classifyFindings' {inline, general}; prepared: prepareFiles'
 * result; title and body: the PR's own, which a finding may name things from.
 * Returns the findings that pass, and the rest with the reason each failed.
 * A suggestion that would unbalance the code is stripped; its finding stays.
 */
export function groundFindings(classified, prepared, { title = "", body = "" } = {}) {
  const lineText = prepared.lineText ?? new Map();
  const commentable = prepared.commentable ?? new Map();
  // Every line the model was shown: the commentable ones, and (coverage.js)
  // those of a diff the Worker worked out itself, which GitHub may not accept
  // comments on, so their findings stay in the body.
  const shownLines = prepared.shown ?? commentable;
  const included = new Set(prepared.included ?? []);
  // The lines the model was shown in a file, normalised, with how often
  // each occurs: counted once, on first use, so the work stays linear.
  const perFile = new Map();
  const fileLines = (path) => {
    if (!perFile.has(path)) {
      const counts = new Map();
      const text = lineText.get(path);
      for (const n of shownLines.get(path) ?? []) {
        if (!text?.has(n)) continue;
        const l = normaliseLine(text.get(n));
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      perFile.set(path, counts);
    }
    return perFile.get(path);
  };
  let known = null;
  const knownWords = () => {
    if (!known) {
      known = addWords(prepared.text, new Set());
      addWords(title, known);
      addWords(body, known);
    }
    return known;
  };

  const evidenceFails = (f, inline) => {
    // Every finding is about a file in the change: one with no file, or a
    // file the model was not shown, cannot have its evidence checked.
    if (!f.path || !included.has(f.path)) return REASONS.offChange;
    const lines = (f.evidence ?? []).filter((l) => normaliseLine(l));
    if (!lines.length) return REASONS.noEvidence;
    const counts = fileLines(f.path);
    let pool;
    if (inline) {
      // Near the cited line, or the range a suggestion replaces.
      pool = new Set();
      const text = lineText.get(f.path);
      const shown = commentable.get(f.path);
      const from = Math.min(f.suggestion?.start ?? f.line, f.line) - EVIDENCE_WINDOW;
      for (let n = from; n <= f.line + EVIDENCE_WINDOW; n++) if (shown?.has(n) && text?.has(n)) pool.add(normaliseLine(text.get(n)));
    } else {
      pool = counts;
    }
    // Every line with content must be a line shown there; at least one of
    // them must be distinctive. A finding outside the diff matches anywhere
    // in its file, so its line must occur there only once.
    let distinct = false;
    for (const l of lines) {
      if (!hasContent(l)) continue;
      const m = forms(l).find((x) => pool.has(x));
      if (m === undefined) return REASONS.notInCode;
      const n = counts.get(m) ?? 0;
      if (inline ? n <= MAX_REPEATS || (named(l) && n <= MAX_NAMED_REPEATS) : n === 1) distinct = true;
    }
    return distinct ? null : REASONS.thin;
  };

  // The names a finding depends on: its symbols, and backticked names in its
  // title and claim. Not its body (prose that may name what the fix adds),
  // and never its suggestion: new code may define new names.
  const unknownName = (f) => {
    const words = knownWords();
    const check = (name) => name && !ALLOW.has(name) && !words.has(name);
    for (const s of f.symbols ?? []) for (const n of namesIn(s)) if (check(n)) return n;
    for (const text of [f.title, f.claim]) {
      for (const m of String(text ?? "").matchAll(TICKED)) {
        const n = m[1].slice(m[1].lastIndexOf(".") + 1);
        if (check(n)) return n;
      }
    }
    return null;
  };

  const out = { inline: [], general: [] };
  const dropped = [];
  const stripped = [];
  for (const [group, list] of [["inline", classified.inline], ["general", classified.general]]) {
    for (const raw of list) {
      const bad = evidenceFails(raw, group === "inline");
      if (bad) { dropped.push({ finding: raw, reason: bad }); continue; }
      const name = unknownName(raw);
      if (name) { dropped.push({ finding: raw, reason: `${REASONS.unnamed}: ${name}` }); continue; }
      const kept = { ...raw };
      if (kept.suggestion && !suggestionBalanced(kept.suggestion, kept.path)) {
        kept.suggestion = null;
        kept.note = REASONS.unbalanced;
        stripped.push({ finding: kept, reason: REASONS.unbalanced });
      }
      out[group].push(kept);
    }
  }
  return { classified: out, dropped, stripped };
}

// A drop reason as the Worker may show it: its kind, never the name a model
// invented (that is the finding's own text).
export function publicReason(reason) {
  const r = String(reason ?? "");
  return r.startsWith(REASONS.unnamed) ? REASONS.unnamed : r;
}
