// Full coverage (PR C): every reviewable file of a pull request is reviewed,
// however big the pull request is. Nothing is left out for size.
//
// The diff is cut into batches that each fit one model call (BATCH_CHARS), the
// way the design asks (small-model accuracy collapses on large prompts), and
// each batch is drafted and verified on its own. A file bigger than a batch is
// split at hunk boundaries, and a hunk bigger than a batch between lines, so
// every line the model may comment on is shown exactly once, with its true
// line number in the new file.
//
// What is not reviewed, and why, is always said:
//   - skipped: not reviewable at all (deleted, lockfiles and generated files,
//     binary files), as CodeRabbit's default path filters skip them;
//   - uncovered: reviewable, but the reviewer could not get or take the text.
//     Any uncovered file makes the review incomplete, and the commit status
//     says so (the merge gate needs 100%).
//
// Pure functions, no I/O.

import { SKIP, annotatePatch, priority } from "./review.js";

export const BATCH_CHARS = 60_000;
// A line longer than this many batches is minified or generated data: not
// reviewable, and too big to store or send.
export const LONG_LINE_BATCHES = 4;
// Unchanged and removed lines are context, not under review: past this length
// they are cut to a marker, so a long one never crowds out the change.
export const CONTEXT_LINE_MAX = 2_000;
const HIDDEN = /^\[ai-review: a line of [\d,]+ characters, not shown\]$/;
const hiddenMarker = (n) => `[ai-review: a line of ${n.toLocaleString("en-GB")} characters, not shown]`;

/**
 * Long lines, judged line by line (never the whole file by one line):
 * an unchanged or removed line over CONTEXT_LINE_MAX, and an added line over
 * LONG_LINE_BATCHES batches, become a short marker in their place. Line
 * numbers are kept. Returns {patch, added, hidden}: the added lines, and how
 * many of them are markers (cut now or before: this is idempotent).
 */
export function trimLongLines(patch, batchChars = BATCH_CHARS) {
  const addedMax = LONG_LINE_BATCHES * batchChars;
  const out = [];
  let added = 0;
  let hidden = 0;
  let changed = false;
  for (const line of String(patch).split("\n")) {
    const tag = line[0];
    if (tag === "+" && !line.startsWith("+++")) {
      added++;
      const body = line.slice(1);
      if (HIDDEN.test(body)) hidden++;
      else if (body.length > addedMax) { out.push(`+${hiddenMarker(body.length)}`); hidden++; changed = true; continue; }
    } else if ((tag === " " || tag === "-") && line.length - 1 > CONTEXT_LINE_MAX) {
      out.push(`${tag}${hiddenMarker(line.length - 1)}`);
      changed = true;
      continue;
    }
    out.push(line);
  }
  return { patch: changed ? out.join("\n") : String(patch), added, hidden };
}
export const MAX_PR_CHARS = 5_000_000;
// Room kept for a block's header line.
const HEADER_ROOM = 160;
const LINE_NO = /^\s*(\d+) [+ ] /;

export function longestLine(text) {
  let max = 0;
  for (let at = 0; at < text.length;) {
    const end = text.indexOf("\n", at);
    const stop = end < 0 ? text.length : end;
    if (stop - at > max) max = stop - at;
    at = stop + 1;
  }
  return max;
}

/** Why a file is not reviewable at all, or null when it is. */
export function skipReason(f) {
  if (f.status === "removed") return "deleted";
  if (SKIP.some((re) => re.test(f.filename))) return "generated or lockfile";
  return null;
}

function header(f, part, parts) {
  const label = parts > 1 ? ` [part ${part} of ${parts}]` : "";
  const computed = f.synthetic ? " [diff computed by the reviewer: comments go in the review body]" : "";
  return `### ${f.filename} (${f.status ?? "modified"}, +${f.additions ?? "?"} -${f.deletions ?? "?"})${label}${computed}`;
}

/**
 * One file's diff, annotated with new-file line numbers and cut into parts of
 * at most maxChars (a single line longer than that is a part of its own).
 * Returns [{path, part, parts, block, chars, commentable, shown, lineText}]:
 * commentable is empty for a diff the Worker computed itself (f.synthetic),
 * since GitHub may not accept comments on its lines; shown always has them.
 */
export function splitFile(f, maxChars = BATCH_CHARS) {
  const { text, lines, content } = annotatePatch(f.patch);
  const room = Math.max(1, maxChars - f.filename.length - HEADER_ROOM);
  // Hunks: each starts at its "@@" header.
  const hunks = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("@@") || !hunks.length) hunks.push([]);
    hunks[hunks.length - 1].push(line);
  }
  const chunks = [];
  let cur = [];
  let size = 0;
  const close = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    size = 0;
  };
  for (const hunk of hunks) {
    const len = hunk.reduce((n, l) => n + l.length + 1, 0);
    if (size + len <= room) { cur.push(...hunk); size += len; continue; }
    close();
    if (len <= room) { cur.push(...hunk); size = len; continue; }
    // A hunk bigger than a part: between lines, each later piece marked as
    // continued (its lines keep their own numbers).
    // A piece always holds a line of the diff besides its header or marker.
    let held = 0;
    for (const line of hunk) {
      if (size + line.length + 1 > room && held > 0) {
        held = 0;
        close();
        cur.push(null); // the continuation marker, numbered below
        size = 40;
      }
      cur.push(line);
      size += line.length + 1;
      if (!line.startsWith("@@")) held++;
    }
    close();
  }
  close();
  return chunks.map((chunk, i) => {
    const shown = new Set();
    const lineText = new Map();
    const body = chunk.map((l) => (l === null ? `@@ continued from part ${i} @@` : l));
    for (const l of body) {
      const m = LINE_NO.exec(l);
      if (!m) continue;
      const n = Number(m[1]);
      if (lines.has(n)) { shown.add(n); lineText.set(n, content.get(n)); }
    }
    const block = `${header(f, i + 1, chunks.length)}\n${body.join("\n")}\n`;
    return {
      path: f.filename, part: i + 1, parts: chunks.length, block, chars: block.length,
      commentable: f.synthetic ? new Set() : shown, shown, lineText,
    };
  });
}

/**
 * Plans a review of every file: {batches: [[part]], skipped: [{path, reason}],
 * uncovered: [{path, reason}], files: [{path, parts}], chars}. Code comes
 * first, then tests, then docs; a file's parts stay together and in order.
 */
export function prLimitReason(maxPrChars) {
  return `the pull request is over the reviewer's limit of ${maxPrChars.toLocaleString("en-GB")} characters of diff`;
}

export function planReview(files, { batchChars = BATCH_CHARS, maxPrChars = MAX_PR_CHARS } = {}) {
  const ordered = [...files]
    .filter((f) => f && typeof f.filename === "string")
    .map((f, i) => ({ f, i }))
    .sort((a, b) => priority(a.f.filename) - priority(b.f.filename) || a.i - b.i)
    .map(({ f }) => f);
  const skipped = [];
  const uncovered = [];
  const planned = [];
  const limit = prLimitReason(maxPrChars);
  let chars = 0;
  for (const f of ordered) {
    const path = f.filename;
    const skip = skipReason(f);
    if (skip) { skipped.push({ path, reason: skip }); continue; }
    const long = `a line over ${(LONG_LINE_BATCHES * batchChars).toLocaleString("en-GB")} characters: minified or generated`;
    if (f.minified === true) { skipped.push({ path, reason: long }); continue; }
    if (typeof f.unfetched === "string") { uncovered.push({ path, reason: f.unfetched }); continue; }
    if (f.patch_omitted === true) { uncovered.push({ path, reason: "its diff was not sent" }); continue; }
    if (typeof f.patch !== "string" || f.patch.length === 0) { skipped.push({ path, reason: "binary or no textual diff" }); continue; }
    const t = trimLongLines(f.patch, batchChars);
    // Every added line too long to show: minified or generated data.
    if (t.added > 0 && t.hidden === t.added) { skipped.push({ path, reason: long }); continue; }
    // The limit is checked on the patch first, so a file far past it is
    // never annotated (annotation adds about 8 characters a line).
    if (chars + t.patch.length > maxPrChars) { uncovered.push({ path, reason: limit }); continue; }
    if (t.hidden > 0) {
      skipped.push({ path, reason: `${t.hidden} added line${t.hidden === 1 ? "" : "s"} over ${(LONG_LINE_BATCHES * batchChars).toLocaleString("en-GB")} characters not shown (minified or generated); the rest was reviewed` });
    }
    const parts = splitFile({ ...f, patch: t.patch }, batchChars);
    const size = parts.reduce((n, p) => n + p.chars, 0);
    if (chars + size > maxPrChars) { uncovered.push({ path, reason: limit }); continue; }
    chars += size;
    planned.push({ path, parts });
  }
  const batches = [];
  let cur = null;
  let size = 0;
  for (const { parts } of planned) {
    for (const p of parts) {
      if (!cur || (size + p.chars > batchChars && cur.length)) {
        cur = [];
        size = 0;
        batches.push(cur);
      }
      p.batch = batches.length - 1;
      cur.push(p);
      size += p.chars;
    }
  }
  return { batches, skipped, uncovered, files: planned.map(({ path, parts }) => ({ path, parts: parts.length, batches: [...new Set(parts.map((p) => p.batch))] })), chars };
}

/**
 * How much of the plan is reviewed, given the batches finished (a Set of
 * indexes): a file counts only when every batch holding a part of it is done.
 */
export function coverageOf(plan, done) {
  const covered = plan.files.filter((f) => f.batches.every((b) => done.has(b))).length;
  const reviewable = plan.files.length + plan.uncovered.length;
  return { reviewable, covered, complete: covered === reviewable, chars: plan.chars };
}

/**
 * One batch in the shape prepareFiles returns, so the prompt, the classifier,
 * the grounding gate and the verifier work on it unchanged. elsewhere: the
 * files reviewed in the other batches, named so the model knows they exist.
 */
export function batchPrepared(plan, index) {
  const batch = plan.batches[index];
  const included = [];
  const commentable = new Map();
  const shown = new Map();
  const lineText = new Map();
  const blocks = new Map();
  for (const p of batch) {
    if (!commentable.has(p.path)) {
      included.push(p.path);
      commentable.set(p.path, new Set());
      shown.set(p.path, new Set());
      lineText.set(p.path, new Map());
      blocks.set(p.path, []);
    }
    for (const n of p.commentable) commentable.get(p.path).add(n);
    for (const n of p.shown) shown.get(p.path).add(n);
    for (const [n, t] of p.lineText) lineText.get(p.path).set(n, t);
    blocks.get(p.path).push(p.block);
  }
  const text = batch.map((p) => p.block).join("\n");
  const here = new Set(included);
  const fileText = new Map([...blocks].map(([path, b]) => [path, b.join("\n")]));
  return {
    text, chars: text.length, included, omitted: [], commentable, shown, lineText, fileText,
    elsewhere: plan.files.map((f) => f.path).filter((p) => !here.has(p)),
  };
}
