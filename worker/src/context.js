// What the pull request's other participants have said, and what its checks
// report, as data for the drafter and the verifier.
//
// Everything here is read from GitHub and is untrusted: other people's words
// and other bots' output. It is cleaned (hidden HTML, collapsed sections and
// the "prompt for AI agents" blocks bots add are dropped, secrets are
// redacted), bounded, and fenced as data. It is never an instruction, and it
// is never evidence: a finding another reviewer reported is a claim to check
// against the code, not a reason to believe it.

import { fence, sanitize } from "./review.js";

export const DEFAULT_CONTEXT_CHARS = 6000;
const SNIPPET = 360; // one comment's or finding's text
const REPLY = 220; // one reply's text
const REPLIES = 3; // replies kept per thread, the latest
const MAX_COMMENTS = 40; // conversation comments kept, the latest
const MAX_LISTED = 12; // names listed per kind of check

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
    "\\bsk-[A-Za-z0-9_-]{20,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
    "\\bAIza[0-9A-Za-z_-]{30,}",
    "(?:authorization|bearer)[\"':= ]+[A-Za-z0-9._~+/=-]{24,}",
  ].join("|"),
  "gi",
);

export function redact(text) {
  return String(text ?? "").replace(SECRET, "[redacted]");
}

// Bots wrap their output in hidden markers, collapsed sections (fix prompts,
// committable suggestions, run details) and badges. None of that is the
// finding. The prompts a bot writes for AI agents are instructions by design,
// so they never reach a model here.
export function cleanBody(body) {
  let s = String(body ?? "").replace(/\r/g, "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<details[\s\S]*?<\/details>/gi, " ");
  s = s.replace(/<(?:picture|svg|script|style)[\s\S]*?<\/(?:picture|svg|script|style)>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/^>+\s?/gm, "");
  s = redact(s);
  return s.replace(/\s+/g, " ").trim();
}

// Output that says nothing about the change: a bot's rate-limit notice, an
// acknowledgement, a pending marker.
const NOISE = /review limit reached|rate limited|action not completed|review triggered|review finished|currently processing|^\W*$/i;

const snippet = (body, max) => sanitize(cleanBody(body), max, { inline: true });

const stateOf = (t) => (t.resolved ? "resolved" : t.outdated ? "outdated" : "open");

/**
 * conv: {comments, reviews, threads} from effects.conversation; ci: {checks,
 * statuses, runs} from effects.ciState (either may be null). Returns the
 * context as plain data, bounded, ready to render and to keep.
 */
export function buildContext({ conv = null, ci = null, ourLogin }) {
  const threads = [];
  for (const t of conv?.threads ?? []) {
    const [first, ...rest] = t.comments ?? [];
    if (!first) continue;
    const kind = actorKind(first, ourLogin);
    const text = snippet(first.body, SNIPPET);
    const replies = rest
      .map((c) => ({ by: String(c.login ?? "").replace(/\[bot\]$/i, ""), kind: actorKind(c, ourLogin), text: snippet(c.body, REPLY) }))
      .filter((r) => r.text && !NOISE.test(r.text))
      .slice(-REPLIES);
    if (!text && !replies.length) continue;
    threads.push({ by: String(first.login ?? "").replace(/\[bot\]$/i, ""), kind, state: stateOf(t), path: t.path ?? null, line: t.line ?? t.originalLine ?? null, text, replies, resolvedBy: t.resolvedBy ?? null });
  }
  const comments = [];
  for (const c of conv?.comments ?? []) {
    const kind = actorKind(c, ourLogin);
    if (kind === "ours") continue;
    const text = snippet(c.body, SNIPPET);
    if (!text || NOISE.test(text)) continue;
    comments.push({ by: String(c.login ?? "").replace(/\[bot\]$/i, ""), kind, text, at: c.at ?? null });
  }
  const reviews = [];
  for (const r of conv?.reviews ?? []) {
    const kind = actorKind(r, ourLogin);
    if (kind === "ours") continue;
    const text = snippet(r.body, SNIPPET);
    if (!text || NOISE.test(text)) continue;
    reviews.push({ by: String(r.login ?? "").replace(/\[bot\]$/i, ""), kind, state: String(r.state ?? ""), text, at: r.at ?? null });
  }
  return { threads, comments: comments.slice(-MAX_COMMENTS), reviews: reviews.slice(-MAX_COMMENTS), ci: summariseCi(ci, ourLogin) };
}

// This App's own status is the review being run now: not news to itself.
function summariseCi(ci, ourLogin) {
  if (!ci) return null;
  const ours = (name) => /tankster ai review/i.test(String(name ?? "")) || bare(name) === bare(ourLogin);
  const failed = (c) => ["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(c);
  const items = [];
  for (const c of ci.checks ?? []) {
    if (ours(c.name)) continue;
    const state = c.status && c.status !== "completed" ? "pending" : failed(c.conclusion) ? "failing" : c.conclusion === "cancelled" ? "cancelled" : c.conclusion === "neutral" || c.conclusion === "skipped" ? "neutral" : "passing";
    items.push({ kind: "check", name: String(c.name ?? "").slice(0, 80), state, detail: state === "failing" ? snippet([c.title, c.summary].filter(Boolean).join(": "), 200) : "" });
  }
  for (const s of ci.statuses ?? []) {
    if (ours(s.context)) continue;
    const state = s.state === "success" ? "passing" : s.state === "pending" ? "pending" : "failing";
    items.push({ kind: "status", name: String(s.context ?? "").slice(0, 80), state, detail: state === "failing" ? snippet(s.description, 200) : "" });
  }
  for (const r of ci.runs ?? []) {
    const state = r.status && r.status !== "completed" ? "pending" : failed(r.conclusion) ? "failing" : r.conclusion === "cancelled" ? "cancelled" : r.conclusion === "skipped" ? "neutral" : "passing";
    items.push({ kind: "workflow", name: String(r.name ?? "").slice(0, 80), state, detail: "" });
  }
  const count = (s) => items.filter((i) => i.state === s).length;
  return { passing: count("passing"), failing: count("failing"), pending: count("pending"), other: items.length - count("passing") - count("failing") - count("pending"), items };
}

const line = (s) => sanitize(s, 600, { inline: true });

/**
 * The context as fenced blocks for a prompt, within max characters (most
 * useful first), and what it holds, for the review's own account of itself.
 */
export function renderContext(built, { tag, max = DEFAULT_CONTEXT_CHARS }) {
  const stats = { threads: 0, comments: 0, reviews: 0, bots: [], failing: 0, pending: 0, passing: 0, ci: false, cut: false };
  if (!built) return { text: "", stats };
  const bots = new Set();
  const seen = (by, kind) => { if (kind === "bot" && by) bots.add(by); };
  const talk = [];
  let used = 0;
  const room = (s) => { if (used + s.length + 1 > max) { stats.cut = true; return false; } used += s.length + 1; return true; };
  const add = (s) => { if (room(s)) { talk.push(s); return true; } return false; };

  // Maintainers' words first, then open findings by others, then the rest.
  const ours = built.threads.filter((t) => t.kind === "ours");
  const others = built.threads.filter((t) => t.kind !== "ours");
  for (const c of built.comments.filter((x) => x.kind === "maintainer" || x.kind === "contributor")) {
    if (add(line(`- comment by ${c.kind} ${c.by}: ${c.text}`))) stats.comments++;
  }
  for (const t of [...others.filter((x) => x.state === "open"), ...others.filter((x) => x.state !== "open")]) {
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "no file";
    const head = line(`- finding by ${t.kind} ${t.by} [${t.state}${t.resolvedBy ? `, resolved by ${t.resolvedBy}` : ""}] at ${where}: ${t.text}`);
    if (!add(head)) break;
    stats.threads++;
    seen(t.by, t.kind);
    for (const r of t.replies) { if (!add(line(`    reply by ${r.kind} ${r.by}: ${r.text}`))) break; seen(r.by, r.kind); }
  }
  for (const t of ours) {
    // Only what people said back to this App's own findings matters here.
    const said = t.replies.filter((r) => r.kind !== "ours");
    if (!said.length) continue;
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "no file";
    if (!add(line(`- our earlier finding [${t.state}] at ${where}: ${t.text}`))) break;
    for (const r of said) { if (!add(line(`    reply by ${r.kind} ${r.by}: ${r.text}`))) break; seen(r.by, r.kind); }
  }
  for (const r of built.reviews) {
    if (add(line(`- review by ${r.kind} ${r.by} (${r.state.toLowerCase()}): ${r.text}`))) { stats.reviews++; seen(r.by, r.kind); }
  }
  for (const c of built.comments.filter((x) => x.kind === "bot")) {
    if (add(line(`- comment by bot ${c.by}: ${c.text}`))) { stats.comments++; seen(c.by, "bot"); }
  }
  stats.bots = [...bots].sort();

  const ci = built.ci;
  const checks = [];
  if (ci && ci.items.length) {
    stats.ci = true;
    stats.failing = ci.failing;
    stats.pending = ci.pending;
    stats.passing = ci.passing;
    checks.push(`${ci.passing} passing, ${ci.failing} failing, ${ci.pending} still running${ci.other ? `, ${ci.other} other` : ""}.`);
    for (const state of ["failing", "pending"]) {
      for (const i of ci.items.filter((x) => x.state === state).slice(0, MAX_LISTED)) checks.push(line(`- ${state}: ${i.kind} ${i.name}${i.detail ? ` (${i.detail})` : ""}`));
    }
  }

  const blocks = [];
  if (talk.length) blocks.push(fence("OTHER PEOPLE AND BOTS ON THIS PULL REQUEST", tag, talk.join("\n")));
  if (checks.length) blocks.push(fence("CHECKS AND WORKFLOWS ON THE LATEST COMMIT", tag, checks.join("\n")));
  return { text: blocks.join("\n\n"), stats };
}
