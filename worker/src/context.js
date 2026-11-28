// What the pull request's other participants have said, and what its checks
// report, as data for the drafter and the verifier.
//
// Everything here is read from GitHub and is untrusted: other people's words
// and other bots' output. It is cleaned (hidden HTML, collapsed sections and
// the "prompt for AI agents" blocks bots add are dropped, secrets are
// redacted), bounded, and fenced as data. It is never an instruction, and it
// is never evidence: a finding another reviewer reported is a claim to check
// against the code, not a reason to believe it. And only a bot's or a
// maintainer's word counts as a finding or an explanation: a contributor's
// (the pull request's own author included) is shown as a comment and is never
// a reason to leave a finding out.

import { fence, sanitize } from "./review.js";

export const DEFAULT_CONTEXT_CHARS = 6000;
const RAW = 4000; // characters of one body read at all: nothing below runs on more
const SNIPPET = 360; // one comment's or finding's text
const REPLY = 220; // one reply's text
const REPLIES = 3; // replies kept per thread, the latest
const MAX_THREADS = 30; // threads kept: open ones first
const MAX_COMMENTS = 40; // conversation comments kept, the latest
const MAX_REVIEWS = 20;
const MAX_LISTED = 12; // names listed per kind of check
const MAX_SAVED = 100_000; // bytes kept for a run (a Durable Object value holds 128 KiB)

// Who wrote it. "ours" is this App; "maintainer" is the repository's owner, a
// member or a collaborator (GitHub's association, which is a hint: it decides
// how the line is labelled, not what anyone may do); "bot" is any App.
export function actorKind({ login, type, association }, ourLogin) {
  const l = bare(login);
  if (l && l === bare(ourLogin)) return "ours";
  if (/^bot$/i.test(String(type ?? "")) || /\[bot\]$/i.test(String(login ?? ""))) return "bot";
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(String(association ?? "").toUpperCase())) return "maintainer";
  return "contributor";
}

// GraphQL names an App's login without "[bot]"; REST names it with.
const bare = (login) => String(login ?? "").replace(/\[bot\]$/i, "").toLowerCase();

const SECRET = new RegExp(
  [
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
    "\\bgh[pousr]_[A-Za-z0-9]{20,}",
    "\\bgithub_pat_[A-Za-z0-9_]{20,}",
    "\\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}",
    "\\bsk-[A-Za-z0-9_-]{20,}",
    "\\bnpm_[A-Za-z0-9]{30,}",
    "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
    "\\bAIza[0-9A-Za-z_-]{30,}",
    "(?:authorization|bearer)[\"':= ]+[A-Za-z0-9._~+/=-]{24,}",
    "(?:password|passwd|secret|token|api[_-]?key)[\"']?\\s*[:=]\\s*[\"']?[^\\s\"']{8,}",
  ].join("|"),
  "gi",
);

export function redact(text) {
  return String(text ?? "").replace(SECRET, "[redacted]");
}

// Drops every open...close block, and an unclosed one to the end: one pass
// with indexOf, so no input makes it slow (a lazy pattern with no closer is
// quadratic).
function dropBlocks(s, open, close) {
  const lower = s.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    const i = lower.indexOf(open, at);
    if (i < 0) return out + s.slice(at);
    out += `${s.slice(at, i)} `;
    const j = lower.indexOf(close, i + open.length);
    if (j < 0) return out;
    at = j + close.length;
  }
}

// Only real HTML tags go: "Map<string, number>" and "a < b && c > d" stay.
const HTML_TAG = /<\/?(?:a|b|i|u|s|em|strong|code|pre|p|br|hr|img|ul|ol|li|h[1-6]|sub|sup|table|thead|tbody|tr|td|th|blockquote|div|span|kbd|source)\b[^<>]{0,200}>/gi;

// Bots wrap their output in hidden markers, collapsed sections (fix prompts,
// committable suggestions, run details) and badges. None of that is the
// finding. The prompts a bot writes for AI agents are instructions by design,
// so they never reach a model here. At most RAW characters are read.
export function cleanBody(body) {
  let s = String(body ?? "").slice(0, RAW).replace(/\r/g, "");
  s = dropBlocks(s, "<!--", "-->");
  s = dropBlocks(s, "<details", "</details>");
  for (const t of ["picture", "svg", "script", "style"]) s = dropBlocks(s, `<${t}`, `</${t}>`);
  s = s.replace(HTML_TAG, " ");
  s = s.replace(/!\[[^\]\n]{0,200}\]\([^)\n]{0,500}\)/g, " ");
  s = s.replace(/\[([^\]\n]{1,200})\]\([^)\n]{0,500}\)/g, "$1");
  s = s.replace(/^>+\s?/gm, "");
  s = redact(s);
  return s.replace(/\s+/g, " ").trim();
}

// A bot's rate-limit notice, an acknowledgement, a pending marker: they say
// nothing about the change. (Only bots' own: a person may write these words.)
const NOISE = /review limit reached|rate limited|action not completed|review triggered|review finished|currently processing/i;
const quiet = (kind, text) => !text || (kind === "bot" && NOISE.test(text));

const snippet = (body, max) => sanitize(cleanBody(body), max, { inline: true });
const who = (login) => String(login ?? "").replace(/\[bot\]$/i, "");
const stateOf = (t) => (t.resolved ? "resolved" : t.outdated ? "outdated" : "open");

/**
 * conv: {comments, reviews, threads} from effects.conversation; ci: {checks,
 * statuses, runs} from effects.ciState (either may be null). Returns the
 * context as plain data, bounded (threads, comments, reviews, listed checks,
 * and bytes), ready to render and to keep.
 */
export function buildContext({ conv = null, ci = null, lessons = [], ourLogin }) {
  // Open threads first, then the rest.
  const ranked = [...(conv?.threads ?? [])].sort((a, b) => Number(Boolean(a.resolved)) - Number(Boolean(b.resolved)));
  const threads = [];
  for (const t of ranked) {
    if (threads.length >= MAX_THREADS) break;
    const [first, ...rest] = t.comments ?? [];
    if (!first) continue;
    const kind = actorKind(first, ourLogin);
    const text = snippet(first.body, SNIPPET);
    const replies = rest
      .slice(-REPLIES)
      .map((c) => { const k = actorKind(c, ourLogin); return { by: who(c.login), kind: k, text: snippet(c.body, REPLY) }; })
      .filter((r) => !quiet(r.kind, r.text));
    if (!text && !replies.length) continue;
    threads.push({ by: who(first.login), kind, state: stateOf(t), path: t.path ?? null, line: t.line ?? t.originalLine ?? null, text, replies, resolvedBy: t.resolvedBy ?? null });
  }
  const comments = [];
  for (const c of (conv?.comments ?? []).slice(-MAX_COMMENTS)) {
    const kind = actorKind(c, ourLogin);
    if (kind === "ours") continue;
    const text = snippet(c.body, SNIPPET);
    if (quiet(kind, text)) continue;
    comments.push({ by: who(c.login), kind, text, at: c.at ?? null });
  }
  const reviews = [];
  for (const r of (conv?.reviews ?? []).slice(-MAX_REVIEWS)) {
    const kind = actorKind(r, ourLogin);
    if (kind === "ours") continue;
    const text = snippet(r.body, SNIPPET);
    if (quiet(kind, text)) continue;
    reviews.push({ by: who(r.login), kind, state: String(r.state ?? ""), text, at: r.at ?? null });
  }
  const taught = (lessons ?? []).slice(0, 8).map((l) => ({ id: l.id, by: who(l.by), source: l.source === "confirmed" ? "confirmed" : "maintainer", text: snippet(l.text, 400), matched: l.matched !== false })).filter((l) => l.text);
  const built = { lessons: taught, threads, comments, reviews, ci: summariseCi(ci, ourLogin) };
  // Never more than a Durable Object can hold: trim the least useful first.
  while (JSON.stringify(built).length > MAX_SAVED && (built.comments.length || built.reviews.length || built.threads.length > 5)) {
    if (built.comments.length > 5) built.comments.splice(0, Math.ceil(built.comments.length / 2));
    else if (built.reviews.length > 3) built.reviews.splice(0, Math.ceil(built.reviews.length / 2));
    else if (built.threads.length > 5) built.threads.pop();
    else { built.comments.length = 0; built.reviews.length = 0; }
  }
  return built;
}

// This App's own status is the review being run now: not news to itself.
function summariseCi(ci, ourLogin) {
  if (!ci) return null;
  const ours = (name) => /tankster ai review/i.test(String(name ?? "")) || bare(name) === bare(ourLogin);
  const failed = (c) => ["failure", "timed_out", "startup_failure"].includes(c);
  const items = [];
  for (const c of ci.checks ?? []) {
    if (ours(c.name)) continue;
    const state = c.status && c.status !== "completed" ? "pending" : failed(c.conclusion) ? "failing" : c.conclusion === "success" ? "passing" : "other";
    items.push({ kind: "check", name: String(c.name ?? "").slice(0, 80), state, detail: state === "failing" ? snippet([c.title, c.summary].filter(Boolean).join(": "), 200) : "" });
  }
  for (const s of ci.statuses ?? []) {
    if (ours(s.context)) continue;
    const state = s.state === "success" ? "passing" : s.state === "pending" ? "pending" : "failing";
    items.push({ kind: "status", name: String(s.context ?? "").slice(0, 80), state, detail: state === "failing" ? snippet(s.description, 200) : "" });
  }
  const count = (s) => items.filter((i) => i.state === s).length;
  // A workflow's jobs are already checks: the runs are named only when one is
  // failing or still going, never counted a second time.
  const runs = [];
  for (const r of ci.runs ?? []) {
    const state = r.status && r.status !== "completed" ? "pending" : failed(r.conclusion) ? "failing" : null;
    if (state) runs.push({ kind: "workflow", name: String(r.name ?? "").slice(0, 80), state, detail: "" });
  }
  const kept = [
    ...items.filter((i) => i.state === "failing").slice(0, MAX_LISTED),
    ...items.filter((i) => i.state === "pending").slice(0, MAX_LISTED),
    ...runs.slice(0, MAX_LISTED),
  ];
  return { passing: count("passing"), failing: count("failing"), pending: count("pending"), other: count("other"), items: kept, total: items.length, truncated: Boolean(ci.truncated) };
}

const line = (s) => sanitize(s, 600, { inline: true });
// What the lessons may take of the context budget.
const LESSON_CHARS = 1500;

/**
 * The context as fenced blocks for a prompt, within max characters in all
 * (checks first, then the talk by usefulness), and what it holds, for the
 * review's own account of itself.
 */
export function renderContext(built, { tag, max = DEFAULT_CONTEXT_CHARS }) {
  const stats = { lessons: 0, threads: 0, comments: 0, reviews: 0, bots: [], failing: 0, pending: 0, passing: 0, ci: false, cut: false };
  if (!built) return { text: "", stats };

  const ci = built.ci;
  const checks = [];
  if (ci && (ci.total > 0 || ci.items?.length)) {
    stats.ci = true;
    stats.failing = ci.failing;
    stats.pending = ci.pending;
    stats.passing = ci.passing;
    checks.push(`${ci.passing} passing, ${ci.failing} failing, ${ci.pending} still running${ci.other ? `, ${ci.other} other` : ""}.`);
    for (const i of ci.items) checks.push(line(`- ${i.state}: ${i.kind} ${i.name}${i.detail ? ` (${i.detail})` : ""}`));
  }
  const checksText = checks.length ? fence("CHECKS AND WORKFLOWS ON THE LATEST COMMIT", tag, checks.join("\n")) : "";

  const bots = new Set();
  const seen = (by, kind) => { if (kind === "bot" && by) bots.add(by); };
  const talk = [];
  let used = checksText.length + 200; // the talk block's own fence
  const add = (s) => {
    if (used + s.length + 1 > max) { stats.cut = true; return false; }
    used += s.length + 1;
    talk.push(s);
    return true;
  };
  // What the maintainers taught it has its own small share, in its own block,
  // so it can neither crowd out the talk nor be mistaken for it.
  const taught = [];
  let taughtUsed = 0;
  for (const l of built.lessons ?? []) {
    const s = line(`- lesson ${l.id} (${l.source === "maintainer" ? `from maintainer ${l.by}` : "a claim the code confirmed"}): ${l.text}`);
    if (taughtUsed + s.length + 1 > LESSON_CHARS || used + s.length + 1 > max) { stats.cut = true; break; }
    taughtUsed += s.length + 1;
    used += s.length + 1;
    taught.push(s);
    // A lesson only counts as applied when its words matched this pull request.
    if (l.matched !== false) stats.lessons++;
  }
  const where = (t) => (t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "no file");
  const replies = (rs) => { for (const r of rs) { if (!add(line(`    reply by ${r.kind} ${r.by}: ${r.text}`))) return false; seen(r.by, r.kind); } return true; };
  // What is said about a spot in the code: a bot's or a maintainer's is a
  // finding; a contributor's (the author's included) is only a comment.
  const heading = (t) => line(`- ${t.kind === "contributor" ? `comment on code by contributor ${t.by}` : `finding by ${t.kind} ${t.by}`} [${t.state}${t.resolvedBy ? `, resolved by ${t.resolvedBy}` : ""}] at ${where(t)}: ${t.text}`);
  const others = built.threads.filter((t) => t.kind !== "ours");

  // 1 maintainers' words, 2 open findings (bots, maintainers), 3 replies to
  // our own findings, 4 closed findings, 5 reviews, 6 bots' comments,
  // 7 contributors' (a few, short).
  for (const c of built.comments.filter((x) => x.kind === "maintainer").slice(-8)) {
    if (add(line(`- comment by maintainer ${c.by}: ${c.text}`))) stats.comments++;
  }
  for (const t of others.filter((x) => x.state === "open" && x.kind !== "contributor")) {
    if (!add(heading(t))) break;
    stats.threads++; seen(t.by, t.kind);
    if (!replies(t.replies)) break;
  }
  for (const t of built.threads.filter((x) => x.kind === "ours")) {
    const said = t.replies.filter((r) => r.kind !== "ours");
    if (!said.length) continue;
    if (!add(line(`- our earlier finding [${t.state}] at ${where(t)}: ${t.text}`))) break;
    if (!replies(said)) break;
  }
  for (const t of others.filter((x) => x.state !== "open" && x.kind !== "contributor")) {
    if (!add(heading(t))) break;
    stats.threads++; seen(t.by, t.kind);
    if (!replies(t.replies)) break;
  }
  for (const r of built.reviews) {
    if (add(line(`- review by ${r.kind} ${r.by} (${r.state.toLowerCase()}): ${r.text}`))) { stats.reviews++; seen(r.by, r.kind); }
  }
  for (const c of built.comments.filter((x) => x.kind === "bot").slice(-5)) {
    if (add(line(`- comment by bot ${c.by}: ${c.text}`))) { stats.comments++; seen(c.by, "bot"); }
  }
  for (const t of others.filter((x) => x.kind === "contributor").slice(0, 5)) {
    if (add(heading(t).slice(0, 260))) stats.threads++;
  }
  for (const c of built.comments.filter((x) => x.kind === "contributor").slice(-5)) {
    if (add(line(`- comment by contributor ${c.by}: ${c.text}`.slice(0, 260)))) stats.comments++;
  }
  stats.bots = [...bots].sort();

  const blocks = [];
  if (taught.length) blocks.push(fence("WHAT MAINTAINERS TAUGHT THIS REPOSITORY", tag, taught.join("\n")));
  if (talk.length) blocks.push(fence("OTHER PEOPLE AND BOTS ON THIS PULL REQUEST", tag, talk.join("\n")));
  if (checksText) blocks.push(checksText);
  return { text: blocks.join("\n\n"), stats };
}
