// One Durable Object per pull request ("TanksterAI/repo#12"). It is the only
// place that decides what ai-review does for that PR:
//   - drops repeated webhook deliveries (signatures carry no timestamp);
//   - keeps the PR's state: last reviewed commit, paused, pending approval;
//   - mints single-use jobs whose repo, PR, commits and scope it chose itself,
//     so a runner can never ask for more than the job says;
//   - performs side effects (dispatch a runner, post a comment) from its alarm,
//     after the webhook has been acknowledged.

import { DEFAULT_SLUG, mentionOf } from "./webhook.js";
import { appConfig } from "./setup.js";
import { MARKER, createEffects } from "./effects.js";
import { config } from "./config.js";
import { capacity, draftChain } from "./providers.js";
import { findingIdOf, nitpickFinding } from "./addressed.js";
import { parseHeader } from "./labels.js";
import { ACCEPTED, MAX_RUN_LIFE_MS, REOPENED, RUN, RUN_META, SUMMARY_BASE, SUMMARY_KEY, SUMMARY_NOTICE, withNotice, acceptThreads, acceptedSet, activeRun, clearOpenFindings, clearPrefix, dropRun, listOpenFindings, reopenMark, startRun, stepRun } from "./review-run.js";

const JOB_TTL_MS = 2 * 3600_000;
const KEEP_DELIVERIES = 200;
// New commits are reviewed incrementally once the pushes stop, as CodeRabbit
// does: the review starts DEBOUNCE_S after the last push, and at most
// DEBOUNCE_MAX_S after the first push it covers, so a steady stream of pushes
// is still reviewed. One review per burst also spares the light lane and the
// daily neuron cap. REVIEW_DEBOUNCE_S and REVIEW_DEBOUNCE_MAX_S override them.
const DEBOUNCE_S = 180;
const DEBOUNCE_MAX_S = 900;
// A push waiting on a job already on its way is looked at again no sooner
// than this, whatever REVIEW_DEBOUNCE_S says (0 would otherwise spin).
const RECHECK_MS = 30_000;

function seconds(v, fallback) {
  return /^\d+(\.\d+)?$/.test(String(v ?? "").trim()) ? Number(String(v).trim()) : fallback;
}
const COMMANDS = ["full review", "review", "pause", "resume", "resolve", "approve", "rate limit", "help"];
// As CodeRabbit's (reference/review-commands): these run only when they are
// the whole comment, with no other text before or after. `review` and
// `full review` need only be alone on their line.
const WHOLE_COMMENT = new Set(["pause", "resume", "resolve", "approve", "rate limit", "help"]);
// `ignore` is CodeRabbit's other name for `pause`.
const ALIASES = { ignore: "pause" };
// As CodeRabbit's: `approve` works only as a top-level comment. `resolve` in
// a reply in one of the App's threads resolves only that thread.
// As CodeRabbit's: only resolve works as a reply in a review thread (it
// resolves that thread); every other command goes in a PR comment.
const TOP_LEVEL_ONLY = new Set(["review", "full review", "pause", "resume", "help", "approve", "rate limit"]);
// Threads one alarm resolves at most (each is a subrequest; Workers Free
// allows 50 an invocation, and the same alarm may also run a review step).
// The rest are resolved by the next alarms.
const RESOLVE_PER_STEP = 20;

// After n failures in a row outside the run's own step: up to an hour.
const runBackoffMs = (n) => Math.min(3600_000, RECHECK_MS * 2 ** Math.min(n - 1, 10));

export function helpText(slug = DEFAULT_SLUG) {
  return [
    `**Tankster AI Review commands**: start a line with \`@${slug}\` and the command, as plain text (not in code). One command per comment.`,
    "",
    "| Command | What it does |",
    "|---|---|",
    "| `review` | Review the commits pushed since the last review |",
    "| `full review` | Review the whole pull request again |",
    "| `pause` (or `ignore`) | Stop automatic reviews on this pull request |",
    "| `resume` | Start automatic reviews again, and review the commits pushed while they were paused |",
    "| `resolve` | Resolve all of its review threads and approve, without waiting for a review of the latest commit (as CodeRabbit's). As a reply in one of its threads, resolve that thread only |",
    "| `approve` | The same as a top-level `resolve` |",
    "| `rate limit` | Say whether a review can run now, or when one can |",
    "| `help` | Show this list |",
    "",
    "`review` and `full review` must be alone on their line; the others must be the whole comment.",
    "",
    "Reviews of pull requests from forks or from authors without write access start only when someone with write access asks for one.",
    "",
    "It requests changes while it has actionable findings, resolves its threads once a later commit addresses them, and approves once none is open and the latest commit is reviewed in full. Nitpicks never block. Post `approve` as a top-level comment.",
  ].join("\n");
}

// CodeRabbit's command rules: the handle starts a line, as plain text (not in
// a code block or an HTML comment); one command per comment (the first such
// line); case does not matter. Other text on the command's line stops it
// being a command, and the whole-comment commands must be all there is,
// code blocks included. Anything else is chat, which gets no reply here (yet).
// Lines are read one by one (no backtracking pattern), as GitHub's Markdown
// reads them: a fence of three or more backticks or tildes, closed by a fence
// of the same kind at least as long. A line indented four spaces or more
// (code, in Markdown) neither opens a fence nor holds a command.
export function parseCommand(text, slug = DEFAULT_SLUG) {
  mentionOf(slug); // throws on a malformed slug before it reaches a pattern
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const handle = new RegExp(`^ {0,3}@${slug}(?![\\w-])(.*)$`, "i");
  // One pass, as Markdown reads it: inside a fence everything is literal,
  // HTML comments included (a fence closes on its own raw line); outside
  // one, HTML comments are hidden, across lines too.
  let fence = null;
  let comment = false;
  let at = -1;
  let shown = "";
  for (let i = 0; i < lines.length; i++) {
    const raw_ = lines[i];
    if (fence) {
      const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw_);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    // The line as shown: what is outside HTML comments.
    let l = "";
    for (let k = 0; k < raw_.length;) {
      if (comment) {
        const close = raw_.indexOf("-->", k);
        if (close < 0) break;
        comment = false;
        k = close + 3;
      } else {
        const open = raw_.indexOf("<!--", k);
        if (open < 0) { l += raw_.slice(k); break; }
        l += raw_.slice(k, open);
        comment = true;
        k = open + 4;
      }
    }
    // A fence starts the line as written (never text after a comment), and a
    // backtick fence's info string may not hold a backtick.
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (f && raw_.startsWith(l.slice(0, f[0].length - f[2].length)) && !(f[1][0] === "`" && f[2].includes("`"))) { fence = f[1]; continue; }
    // The handle starts the line as written too: not text after a comment.
    if (handle.test(l) && handle.test(raw_)) { at = i; shown = l; break; }
  }
  if (at < 0) return null;
  const said = handle.exec(shown)[1].trim().toLowerCase().replace(/\s+/g, " ");
  // Own keys only: "constructor" or "__proto__" is no alias.
  const cmd = Object.hasOwn(ALIASES, said) ? ALIASES[said] : COMMANDS.includes(said) ? said : null;
  if (!cmd) return null;
  // Whole comment: nothing else at all, hidden or shown, before or after.
  if (WHOLE_COMMENT.has(cmd) && (lines.filter((l) => l.trim()).length !== 1 || shown.trim() !== lines[at].trim())) return null;
  return cmd;
}

// A job id is the PR object's own id (64 hex characters, which Cloudflare
// derives from the PR's name and does not let anyone reverse) and 32 random
// hex characters. The runner's repository is public, and so is every
// workflow_dispatch input: the id must not say which repository or PR it is.
const OBJECT_ID = /^[0-9a-f]{64}$/;
const JOB_ID = /^([0-9a-f]{64})\.[0-9a-f]{32}$/;

export function jobIdFor(objectId) {
  const oid = String(objectId ?? "");
  if (!OBJECT_ID.test(oid)) throw new Error("a job needs its PR object's id (64 hex characters)");
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  return `${oid}.${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// The PR object a job id belongs to, or null if it is no job id.
export function objectOfJob(jobId) {
  return JOB_ID.exec(String(jobId ?? ""))?.[1] ?? null;
}

const WRITER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MAX_ATTEMPTS = 5;
const REPLY_WINDOW_MS = 3600_000;
const DELETE_CHUNK = 128; // a Durable Object deletes at most 128 keys per call
// A dispatch held while no model provider has capacity is looked at again at
// least this often, and its job kept fresh, so it never ages out (JOB_TTL_MS).
const HOLD_RECHECK_MS = 3600_000;
// A job the runner gave back (every provider deferred) waits at least this long.
const MIN_DEFER_MS = 60_000;
// A job given back because its review failed or the service was busy (not
// for quota) is tried this many times in all, then dropped.
const MAX_RETRIES = 3;
// However it waits, a job is given up this long after it was first made.
const MAX_JOB_LIFE_MS = 3 * 24 * 3600_000;

// A command's acknowledgement, as CodeRabbit's: "Action performed" (edited
// when the review finishes) or "Action not completed", collapsed.
export const actionPerformed = (text) => `<details>\n<summary>Action performed</summary>\n\n${text}\n\n</details>`;
export const actionNotCompleted = (text) => `<details>\n<summary>Action not completed</summary>\n\n${text}\n\n</details>`;

export function needsApproval(slug = DEFAULT_SLUG) {
  return `This pull request comes from a fork or from an author without write access, so it is not reviewed automatically. Someone with write access can comment \`@${slug} review\` to start one.`;
}

// The pending status a pull request shows while it waits for a writer to ask
// for its review. The merge gate requires the status, so it must not be blank.
// GitHub keeps 140 characters of a description.
const ACTIONS_BOT = /^github-actions(\[bot\])?$/i;

export function waitingStatus(slug = DEFAULT_SLUG) {
  return `Waiting: someone with write access must comment @${slug} review`;
}

function randomId() {
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  return Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class PrState {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.now = deps.now ?? (() => Date.now());
    // {dispatch(jobId), comment(repoFull, pr, body), canWrite(repoFull, login)}
    this.effects = deps.effects ?? null;
    // () => {ok} | {ok: false, retryAt}: can any model provider take a review now?
    this.capacity = deps.capacity ?? null;
    // The Worker's own review (review-run.js) needs a fetch and a timer; tests
    // pass their own.
    // (Not this.fetch: that is the object's own request handler.)
    this.fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.debounceMs = seconds(env?.REVIEW_DEBOUNCE_S, DEBOUNCE_S) * 1000;
    this.debounceMaxMs = Math.max(this.debounceMs, seconds(env?.REVIEW_DEBOUNCE_MAX_S, DEBOUNCE_MAX_S) * 1000);
  }

  async state() {
    return (await this.ctx.storage.get("state")) ?? { lastReviewed: null, paused: false, closed: false };
  }

  async fetch(request) {
    const msg = await request.json();
    let out;
    if (msg.op === "event") out = await this.onEvent(msg);
    else if (msg.op === "claim") out = await this.claim(msg);
    // Only the Worker's own runs (stepActiveRun) may say a review covered every file.
    else if (msg.op === "complete") out = await this.complete({ jobId: msg.jobId, runId: msg.runId, reviewedSha: msg.reviewedSha });
    else if (msg.op === "defer") out = await this.defer(msg);
    else if (msg.op === "status") out = await this.status(msg);
    else if (msg.op === "request") out = await this.request(msg);
    else if (msg.op === "threads") out = await this.threads(msg);
    else out = { error: "unknown op" };
    return Response.json(out);
  }

  async deleteAll(keys) {
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) await this.ctx.storage.delete(keys.slice(i, i + DELETE_CHUNK));
  }

  async remember(delivery) {
    if (!delivery) return true;
    const k = `delivery:${delivery}`;
    if (await this.ctx.storage.get(k)) return false;
    await this.ctx.storage.put(k, this.now());
    const all = await this.ctx.storage.list({ prefix: "delivery:" });
    if (all.size > KEEP_DELIVERIES) {
      await this.deleteAll([...all.entries()].sort((a, b) => a[1] - b[1]).slice(0, all.size - KEEP_DELIVERIES).map(([key]) => key));
    }
    return true;
  }

  // At most one reply of a kind per person per hour: mentions and reopened
  // PRs cannot be turned into a spam amplifier. Recorded only once the reply
  // has been posted, so a failed post is retried.
  async mayReply(login, kind) {
    const last = await this.ctx.storage.get(`reply:${kind}:${String(login).toLowerCase()}`);
    return !(last && this.now() - last < REPLY_WINDOW_MS);
  }

  async replied(login, kind) {
    await this.ctx.storage.put(`reply:${kind}:${String(login).toLowerCase()}`, this.now());
    const all = await this.ctx.storage.list({ prefix: "reply:" });
    const stale = [...all].filter(([, t]) => this.now() - t > REPLY_WINDOW_MS).map(([k]) => k);
    await this.deleteAll(stale);
  }

  // An edit to an acknowledgement, queued once: a step retried after queueing
  // it (before its job was deleted) does not queue it again.
  async queueAck(commentId, text) {
    if (!Number.isSafeInteger(commentId)) return;
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    if (box.some((x) => x.type === "ack" && x.commentId === commentId && x.text === text)) return;
    await this.outbox({ type: "ack", commentId, text });
  }

  async outbox(item) {
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    box.push({ id: randomId(), attempts: 0, ...item });
    await this.ctx.storage.put("outbox", box);
    await this.ctx.storage.setAlarm(this.now());
  }

  // The DO has one alarm: moved earlier, never later (the alarm re-arms itself
  // for whatever is still due when it runs).
  async armAt(t) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur === undefined || cur > t) await this.ctx.storage.setAlarm(t);
  }

  // A push: (re)start the quiet period before the incremental review.
  async debounce() {
    const now = this.now();
    const d = (await this.ctx.storage.get("debounce")) ?? { first: now };
    // A burst already past its cap (it waited on a job) starts afresh, so this
    // push still gets its quiet period.
    if (now >= d.first + this.debounceMaxMs) d.first = now;
    d.last = now;
    d.due = Math.min(now + this.debounceMs, d.first + this.debounceMaxMs);
    await this.ctx.storage.put("debounce", d);
    await this.armAt(d.due);
    return d.due;
  }

  // From the alarm: once the quiet period is over, the incremental review.
  async fireDebounce() {
    const d = await this.ctx.storage.get("debounce");
    if (!d || d.due > this.now()) return;
    // A review asked for, or an opening one, still waiting in the outbox
    // covers this push, and drops it when it runs.
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    const covering = box.filter((x) => (x.type === "command" && (x.cmd === "review" || x.cmd === "full review")) || (x.type === "author_check" && x.opening));
    if (covering.length) {
      // It may be held for capacity: look again once it can go, never in a
      // loop meanwhile.
      d.due = Math.max(this.now() + RECHECK_MS, Math.min(...covering.map((x) => x.notBefore ?? 0)));
      await this.ctx.storage.put("debounce", d);
      return;
    }
    const st = await this.state();
    const key = await this.ctx.storage.get("key");
    if (st.paused || st.closed || st.draft || !key) {
      await this.ctx.storage.delete("debounce");
      return;
    }
    const last = d.last ?? d.first;
    // A review that finished, from a run that claimed its job after the last
    // push, read the head after it: the push is covered.
    if ((st.lastDoneClaimAt ?? -Infinity) > last) {
      await this.ctx.storage.delete("debounce");
      return;
    }
    // A job that will read the head after the push is on its way when its
    // dispatch is queued, or went out less than DEBOUNCE_MAX_S ago, or a run
    // claimed it after the push less than DEBOUNCE_MAX_S ago and has not
    // finished. The push waits for it rather than minting another job, and is
    // looked at again (never sooner than RECHECK_MS): covered once that review
    // finishes, or reviewed on its own once the window is over (the runner,
    // or its run, presumed lost).
    const now = this.now();
    const recheck = now + Math.max(this.debounceMs, RECHECK_MS);
    const jobs = await this.ctx.storage.list({ prefix: "job:" });
    const queued = new Map(box.filter((x) => x.jobId).map((x) => [x.jobId, x.notBefore ?? 0]));
    let next = Infinity;
    for (const j of jobs.values()) {
      if (now - j.createdAt > JOB_TTL_MS) continue;
      if (j.claimedBy) {
        if (j.claimedAt !== undefined && j.claimedAt > last && now - j.claimedAt < this.debounceMaxMs) {
          next = Math.min(next, recheck, j.claimedAt + this.debounceMaxMs);
        }
      } else if (queued.has(j.id)) {
        // A dispatch held for capacity: nothing to look at until it goes out.
        next = Math.min(next, Math.max(recheck, queued.get(j.id)));
      } else if (j.dispatchedAt !== undefined && now - j.dispatchedAt < this.debounceMaxMs) {
        next = Math.min(next, recheck, j.dispatchedAt + this.debounceMaxMs);
      }
    }
    if (next !== Infinity) {
      d.due = next;
      await this.ctx.storage.put("debounce", d);
      await this.armAt(next);
      return;
    }
    await this.ctx.storage.delete("debounce");
    await this.newJob({ repo: { full: key.repo, name: String(key.repo).split("/")[1] }, pr: key.pr }, st);
  }

  async newJob(ev, st, { full = false, requestedBy = null, queue = true } = {}) {
    // Drop jobs that can no longer be claimed, so they never pile up.
    const old = await this.ctx.storage.list({ prefix: "job:" });
    // Never the job of the review in progress: it may wait hours for a provider.
    const running = (await activeRun(this.ctx.storage))?.id;
    const stale = [...old].filter(([, j]) => this.now() - j.createdAt > JOB_TTL_MS && j.id !== running);
    for (const [, j] of stale) { await this.ackEnded(j, "The review expired before it could run."); await this.releaseHeld(j); }
    await this.deleteAll(stale.map(([k]) => k));
    const id = jobIdFor(this.ctx.id?.toString());
    const job = {
      id,
      repo: { full: ev.repo.full, name: ev.repo.name },
      pr: ev.pr,
      scope: "review",
      full,
      since: full ? null : st.lastReviewed,
      requestedBy,
      createdAt: this.now(),
      firstAt: this.now(),
      claimedBy: null,
    };
    await this.ctx.storage.put(`job:${id}`, job);
    if (queue) await this.outbox({ type: "dispatch", jobId: id });
    return job;
  }

  async onEvent({ delivery, ev }) {
    if (!(await this.remember(delivery))) return { action: "duplicate" };
    if (!(await this.ctx.storage.get("key"))) await this.ctx.storage.put("key", { repo: ev.repo.full, pr: ev.pr });
    const st = await this.state();

    if (ev.kind === "closed") {
      st.closed = true;
      await this.ctx.storage.put("state", st);
      // Merged: what the reviewer kept about it is of no more use.
      if (ev.merged) {
        await this.ctx.storage.delete([SUMMARY_KEY, SUMMARY_BASE, SUMMARY_NOTICE, "reopenSeq"]);
        await clearPrefix(this.ctx.storage, REOPENED);
        await clearPrefix(this.ctx.storage, ACCEPTED);
        await clearOpenFindings(this.ctx.storage);
      }
      await this.ctx.storage.delete(["debounce", "runFailures", "runRetryAt"]);
      const jobs = await this.ctx.storage.list({ prefix: "job:" });
      // A review asked for and not done says why, in its own comment (an edit:
      // nothing new is posted on a closed PR).
      for (const j of jobs.values()) await this.ackEnded(j, "The pull request was closed before the review finished.");
      await this.deleteAll([...jobs.keys()]);
      // A review in progress stops: nothing is posted on a closed PR.
      for (const prefix of [RUN_META, RUN]) await this.deleteAll([...(await this.ctx.storage.list({ prefix })).keys()]);
      // Their dispatches would only start runners the Worker then refuses.
      const box = (await this.ctx.storage.get("outbox")) ?? [];
      await this.ctx.storage.put("outbox", box.filter((x) => x.type !== "dispatch"));
      return { action: "closed" };
    }

    if (ev.kind === "review") {
      st.closed = false;
      st.draft = Boolean(ev.draft);
      if (ev.draft) {
        // Converted to a draft, or a push to one: nothing waits for it.
        await this.ctx.storage.delete("debounce");
        // As CodeRabbit's: one note, when the draft is opened or converted,
        // saying when it will be reviewed. Pushes to it add none.
        if (["opened", "converted_to_draft"].includes(ev.action) && !st.draftNoted) {
          st.draftNoted = true;
          await this.outbox({ type: "comment", body: "Review skipped: this pull request is a draft. It is reviewed once it is marked ready for review." });
        }
        return this.save(st, { action: "draft" });
      }
      if (st.paused) return this.save(st, { action: "paused" });
      const opening = ["opened", "reopened", "ready_for_review"].includes(ev.action);
      // Forks wait for a writer, with a note and a pending status (the merge
      // gate requires one), whoever opened them: a bot included.
      if (ev.fork) {
        await this.ctx.storage.put("state", st);
        await this.outbox({ type: "status", sha: ev.head?.sha, state: "pending", waiting: true });
        if (opening && !ev.author.bot && (await this.mayReply(ev.author.login, "note"))) {
          await this.outbox({ type: "comment", template: "needs_approval", replyTo: { login: ev.author.login, kind: "note" } });
        }
        return { action: "needs_approval" };
      }
      // A bot (Renovate, Dependabot, an agent's App) can push a branch to this
      // repository only with write access, so it is reviewed as a writer is.
      // github-actions[bot] is the exception: workflows that an outsider can
      // drive (pull_request_target, issue_comment) open PRs as it, so it is
      // checked like anyone else (and has no write access of its own).
      // author_association can under-report (private org membership), so a
      // non-writer association is checked against the permission API first.
      const trustedBot = ev.author.bot && !ACTIONS_BOT.test(ev.author.login);
      if (!trustedBot && !WRITER_ASSOCIATIONS.has(ev.author.association)) {
        await this.ctx.storage.put("state", st);
        await this.outbox({ type: "author_check", login: ev.author.login, repo: ev.repo, pr: ev.pr, opening, sha: ev.head?.sha });
        return { action: "author_check" };
      }
      // Opened, reopened or marked ready: reviewed now. A push: reviewed
      // incrementally once the pushes stop.
      if (!opening) {
        await this.ctx.storage.put("state", st);
        return { action: "debounced", due: await this.debounce() };
      }
      await this.ctx.storage.delete("debounce");
      const job = await this.newJob(ev, st);
      return this.save(st, { action: "job", jobId: job.id });
    }

    if (ev.kind === "thread") {
      if (st.closed) return { action: "closed" };
      // A thread reopened by hand is that person's: the reviewer never
      // resolves it again (review-run.js stageThreads).
      // The mark goes only when someone with write access resolves it
      // (checked by the alarm: an outsider's resolve keeps it).
      // Each mark has its own number, so an older resolve's check cannot
      // clear a newer reopen of the same thread.
      if (ev.threadId && ev.action === "unresolved") {
        const n = ((await this.ctx.storage.get("reopenSeq")) ?? 0) + 1;
        // The mark and the lost acceptance land together (no await between
        // them, so the object writes them as one).
        const put = this.ctx.storage.put({ [`${REOPENED}${ev.threadId}`]: n, reopenSeq: n });
        // A reopened thread loses any earlier acceptance.
        const unaccept = this.ctx.storage.delete(`${ACCEPTED}${ev.threadId}`);
        await Promise.all([put, unaccept]);
      } else if (ev.threadId && ev.sender?.login) {
        const mark = await reopenMark(this.ctx.storage, ev.threadId);
        if (mark !== undefined) await this.outbox({ type: "unmark", threadId: ev.threadId, mark, login: ev.sender.login });
      }
      await this.queueDecide({ reopened: ev.action === "unresolved" });
      return { action: "decide" };
    }

    if (ev.kind === "command") {
      const cmd = parseCommand(ev.text, ev.slug);
      // P1 has no chat: anything that is not a command gets no reply.
      if (!cmd || (TOP_LEVEL_ONLY.has(cmd) && ev.where === "thread")) return { action: "not_a_command" };
      if (cmd === "help") {
        if (await this.mayReply(ev.sender.login, "help")) {
          await this.outbox({ type: "comment", body: helpText(ev.slug), replyTo: { login: ev.sender.login, kind: "help" } });
        }
        return { action: "help" };
      }
      // Everything else needs write access, checked through the API by the
      // alarm before it takes effect.
      // resolve/approve vouch for the threads as they stood when the writer
      // asked: reopens numbered after this are not covered, however long
      // the command waits or however many steps it takes (resolveAll).
      const seq = cmd === "resolve" || cmd === "approve" ? { seq: (await this.ctx.storage.get("reopenSeq")) ?? 0 } : {};
      // `resolve` as a reply in a thread: that thread only (its first comment).
      const thread = ev.where === "thread" && cmd === "resolve" ? { inThreadOf: Number(ev.inReplyTo ?? ev.commentId) } : {};
      await this.outbox({ type: "command", cmd, slug: ev.slug, login: ev.sender.login, repo: ev.repo, pr: ev.pr, ...seq, ...thread });
      return { action: "command", cmd };
    }
    return { action: "ignored" };
  }

  async save(st, out) {
    await this.ctx.storage.put("state", st);
    return out;
  }

  // One outbox item per invocation. An item stays stored until its side
  // effect succeeds, so a failure is retried (Cloudflare retries alarms that
  // throw); after MAX_ATTEMPTS it is dropped. A repeated dispatch is harmless:
  // a job can be claimed by one run only.
  async alarm() {
    // A quiet period that is over becomes a job (and a dispatch in the outbox).
    await this.fireDebounce();
    // One step of the review in progress, if any (review-run.js). A step that
    // throws must not hold up the outbox: commands are still answered, and the
    // run is looked at again shortly.
    // Failures here (before the run's own step, which counts its own) back
    // off, and six in a row give the run up: it must never wake for ever.
    // A decision or a resolve/approve command due now gets this invocation to
    // itself: it may make two dozen GitHub calls, and a review step's would
    // share Workers Free's 50 subrequests. The review moves on at the next.
    const due = ((await this.ctx.storage.get("outbox")) ?? []).find((x) => !(x.notBefore > this.now()));
    const isHeavy = (x) => Boolean(x) && (x.type === "decide" || (x.type === "command" && (x.cmd === "resolve" || x.cmd === "approve")));
    const heavy = isHeavy(due);
    // Whether a review step runs in this invocation: a heavy item that
    // arrives while it runs (webhooks land during its GitHub calls) waits too.
    // A run that is backing off keeps its deadline: no outbox item, heavy or
    // not, is a reason to try it early.
    const active = Boolean(await activeRun(this.ctx.storage));
    const retryAt = (await this.ctx.storage.get("runRetryAt")) ?? 0;
    const waiting = active && retryAt > this.now();
    const stepping = !heavy && active && !waiting;
    let runNext;
    try {
      runNext = !active ? (heavy ? null : await this.stepActiveRun()) : heavy || waiting ? Math.max(this.now(), retryAt) : await this.stepActiveRun();
      if (!heavy && !waiting) await this.ctx.storage.delete(["runFailures", "runRetryAt"]);
    } catch (e) {
      const n = ((await this.ctx.storage.get("runFailures")) ?? 0) + 1;
      console.log(JSON.stringify({ svc: "ai-review", ev: "run_alarm_failed", failures: n, error: String(e?.message ?? e).slice(0, 200) }));
      // Backing off to an hour, for as long as a run may live; then the run is
      // given up, and the PR is told (its status may still say pending).
      const run = await activeRun(this.ctx.storage);
      if (run && this.now() - run.createdAt > MAX_RUN_LIFE_MS) {
        await dropRun(this.ctx.storage, run.id);
        await this.ackEnded(await this.ctx.storage.get(`job:${run.id}`), "The review could not finish.");
        await this.ctx.storage.delete(`job:${run.id}`);
        await this.ctx.storage.delete(["runFailures", "runRetryAt"]);
        await this.outbox({ type: "comment", template: "gave_up", reason: "the review could not run (the App may not be set up)", tries: n, replyTo: { login: "tankster-ai-review", kind: "gave_up" } });
        runNext = null;
      } else {
        runNext = run ? this.now() + runBackoffMs(n) : null;
        // The deadline itself is kept: a heavy item before it neither moves
        // it earlier nor pushes it back.
        await this.ctx.storage.put({ runFailures: n, runRetryAt: runNext ?? 0 });
      }
    }
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    const isDue = (x) => !(x.notBefore > this.now());
    const found = box.find(isDue);
    // Left for the next alarm, its attempts untouched: a review step ran here.
    const item = stepping && isHeavy(found) ? null : found;
    if (item) {
      if (item.attempts >= MAX_ATTEMPTS) {
        console.log(JSON.stringify({ svc: "ai-review", ev: "outbox_dropped", type: item.type }));
        await this.ctx.storage.put("outbox", box.filter((x) => x.id !== item.id));
        // Its job would never get a runner: it must not stand in for later pushes.
        if (item.jobId) {
          if (item.type !== "ack") await this.ackEnded(await this.ctx.storage.get(`job:${item.jobId}`), "The review could not start.");
          await this.ctx.storage.delete(`job:${item.jobId}`);
        }
      } else {
        item.attempts += 1;
        await this.ctx.storage.put("outbox", box.map((x) => (x.id === item.id ? item : x)));
        const out = await this.perform(item);
        const now = (await this.ctx.storage.get("outbox")) ?? [];
        if (out?.holdUntil) {
          // Held, not failed: the attempt does not count.
          await this.ctx.storage.put("outbox", now.map((x) => (x.id === item.id ? { ...x, attempts: x.attempts - 1, notBefore: out.holdUntil } : x)));
        } else {
          await this.ctx.storage.put("outbox", now.filter((x) => x.id !== item.id));
        }
      }
    }
    const rest = (await this.ctx.storage.get("outbox")) ?? [];
    const run = runNext ?? Infinity;
    if (rest.some(isDue) || run <= this.now()) {
      await this.ctx.storage.setAlarm(this.now());
    } else {
      const d = await this.ctx.storage.get("debounce");
      const next = Math.min(d ? d.due : Infinity, run, ...rest.map((x) => x.notBefore));
      // Never in the past: an alarm with nothing due must not fire at once.
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next > this.now() ? next : this.now() + RECHECK_MS);
    }
  }

  // One job per outbox item, kept on the item so a retried alarm dispatches
  // the same job rather than minting another.
  async keepJobOnItem(item, st, opts) {
    if (item.jobId) return;
    item.jobId = (await this.newJob({ repo: item.repo, pr: item.pr }, st, { ...opts, queue: false })).id;
    await this.keepItem(item);
  }

  // Starts the runner for a job that still exists (closing a PR deletes its
  // jobs), and records when, so a push can tell a job on its way from one
  // whose runner never came.
  async dispatchJob(fx, jobId) {
    const held = await this.ctx.storage.get(`job:${jobId}`);
    if (!held) return undefined;
    // A dispatch can wait for hours now: an automatic one (not asked for)
    // whose PR was paused or made a draft meanwhile is dropped.
    const st = await this.state();
    if (!held.requestedBy && (st.paused || st.draft)) {
      await this.releaseHeld(held);
      await this.ctx.storage.delete(`job:${jobId}`);
      return undefined;
    }
    if (this.mode() === "worker") return this.startWorkerRun(held, st);
    // A job minted before job ids became opaque names its PR in the clear,
    // and the runner refuses it: give it a new id first.
    if (!objectOfJob(jobId)) return this.dispatchJob(fx, await this.reissue(jobId, held));
    // No model provider can take a review now (sized as the review itself,
    // when it was tried before), or the runner said when one will: hold the
    // dispatch rather than start a runner that can only defer. The job is
    // kept fresh meanwhile.
    const cap = held.retryAt > this.now() ? { ok: false, retryAt: held.retryAt } : await this.capacityNow(held.chars, held.skip);
    if (!cap.ok) {
      // As CodeRabbit's rate-limited run is neutral, not failing or pending,
      // the required status passes while no model can take the review, and
      // says why; the review's own result replaces it. Once per job.
      let heldStatus = held.heldStatus;
      let heldSha = held.heldSha;
      if (!heldStatus && typeof fx.pullRequest === "function" && typeof fx.setStatus === "function") {
        const head = (await fx.pullRequest(held.repo.full, held.pr))?.head?.sha;
        const st = await this.state();
        if (head && head !== st.lastCompleteReviewed) {
          const when = Number.isFinite(cap.retryAt) ? ` at ${new Date(cap.retryAt).toISOString().slice(11, 16)} UTC` : "";
          await fx.setStatus(held.repo.full, head, "success", `Review delayed: no model has capacity now; it is reviewed when one resets${when}.`);
          heldSha = head;
        }
        heldStatus = true;
      }
      await this.ctx.storage.put(`job:${jobId}`, { ...held, heldStatus, heldSha, createdAt: this.now() });
      console.log(JSON.stringify({ svc: "ai-review", ev: "dispatch_held", retry_at: new Date(cap.retryAt).toISOString() }));
      return { holdUntil: Math.max(this.now() + MIN_DEFER_MS, Math.min(cap.retryAt, this.now() + HOLD_RECHECK_MS)) };
    }
    await fx.dispatch(jobId);
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (job) await this.ctx.storage.put(`job:${jobId}`, { ...job, dispatchedAt: this.now(), firstRunAt: job.firstRunAt ?? this.now() });
    return undefined;
  }

  // The same job under a fresh, opaque id; the queue follows it. The new job
  // and the queue are written in one atomic put, so the job cannot be lost;
  // if the object dies before the old key is deleted, that key is an orphan
  // nothing points at, swept with the other stale jobs.
  async reissue(jobId, held) {
    const id = jobIdFor(this.ctx.id?.toString());
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    await this.ctx.storage.put({
      [`job:${id}`]: { ...held, id },
      outbox: box.map((x) => (x.jobId === jobId ? { ...x, jobId: id } : x)),
    });
    await this.ctx.storage.delete(`job:${jobId}`);
    return id;
  }

  // A job that set the neutral "Review delayed" status and then ends without
  // a review (given up, dropped, swept) must not leave the gate passing: the
  // commit goes back to waiting, as before the neutral status existed.
  async releaseHeld(job) {
    if (!job?.heldSha) return;
    await this.outbox({ type: "status", sha: job.heldSha, waiting: true });
  }

  // Marks a commit as waiting for a writer. A review run sets the status
  // itself when it starts, so this never overwrites a real result.
  // A commit already reviewed (a writer asked), or under review now, keeps the
  // status its run set or will set.
  async waitingFor(fx, repoFull, sha, slug) {
    if (typeof fx.setStatus !== "function") return;
    const st = await this.state();
    if (sha === st.lastReviewed || sha === st.lastCompleteReviewed) return;
    if ((await activeRun(this.ctx.storage))?.headSha === sha) return;
    await fx.setStatus(repoFull, sha, "pending", waitingStatus(slug));
  }

  async perform(item) {
    // No App configured yet: throw, so the item is kept and retried.
    const cfg = this.effects ? null : await appConfig(this.env);
    const fx = this.effects ?? createEffects(this.env, { config: cfg });
    // Replies name the App by its own slug, so mentions people copy work.
    const slug = item.slug ?? cfg?.slug ?? DEFAULT_SLUG;
    const key = await this.ctx.storage.get("key");
    if (item.type === "dispatch") return this.dispatchJob(fx, item.jobId);
    if (item.type === "comment") {
      if (!key) return undefined;
      // Re-checked here: several may have been queued before the first posted.
      if (item.replyTo && !(await this.mayReply(item.replyTo.login, item.replyTo.kind))) return undefined;
      const text = item.template === "needs_approval" ? needsApproval(slug)
        : item.template === "gave_up"
          ? (item.waited
            ? `The AI review of this pull request waited three days for a model provider (${item.reason}), so it has stopped trying. Comment \`@${slug} review\` to try again.`
            : `The AI review of this pull request has stopped trying after ${item.tries ?? MAX_RETRIES} failed ${(item.tries ?? MAX_RETRIES) === 1 ? "try" : "tries"} (${item.reason}). Comment \`@${slug} review\` to try again.`)
          : item.body;
      await fx.comment(key.repo, key.pr, text);
      if (item.replyTo) await this.replied(item.replyTo.login, item.replyTo.kind);
      return undefined;
    }

    if (item.type === "author_check") {
      const st = await this.state();
      if (await fx.canWrite(item.repo.full, item.login)) {
        if (st.paused || st.closed) return undefined;
        // A push waits for the quiet period, as a writer's own push does.
        if (!item.opening) {
          await this.debounce();
          return undefined;
        }
        await this.ctx.storage.delete("debounce");
        await this.keepJobOnItem(item, st, {});
        return this.dispatchJob(fx, item.jobId);
      }
      if (item.sha) await this.waitingFor(fx, item.repo.full, item.sha, slug);
      if (item.opening && (await this.mayReply(item.login, "note"))) {
        await fx.comment(item.repo.full, item.pr, needsApproval(slug));
        await this.replied(item.login, "note");
      }
      return undefined;
    }

    if (item.type === "decide") return this.decide(fx, item, slug);
    if (item.type === "unmark") {
      if (await fx.canWrite(key?.repo, item.login)) {
        // Only the mark this resolve answered: a later reopen keeps its own.
        if ((await reopenMark(this.ctx.storage, item.threadId)) === item.mark) await this.ctx.storage.delete(`${REOPENED}${item.threadId}`);
      }
      return undefined;
    }

    if (item.type === "status") {
      if (!key || !item.sha) return undefined;
      if (item.waiting) await this.waitingFor(fx, key.repo, item.sha, slug);
      return undefined;
    }

    if (item.type === "command") {
      if (!(await fx.canWrite(item.repo.full, item.login))) {
        if (await this.mayReply(item.login, "denied")) {
          await fx.comment(item.repo.full, item.pr, `@${item.login} only people with write access can use \`${item.cmd}\`.`);
          await this.replied(item.login, "denied");
        }
        return undefined;
      }
      const st = await this.state();
      if (item.cmd === "pause") {
        st.paused = true;
        await this.ctx.storage.put("state", st);
        // As CodeRabbit's pause notice: where the reviews stand.
        const head = typeof fx.pullRequest === "function" ? (await fx.pullRequest(item.repo.full, item.pr))?.head?.sha : null;
        const seen = st.lastCompleteReviewed ?? st.lastReviewed;
        const where = [];
        if (seen) where.push(`- Last reviewed commit: \`${seen.slice(0, 7)}\``);
        if (head && head !== seen) where.push(`- Latest commit, not reviewed: \`${head.slice(0, 7)}\``);
        return fx.comment(item.repo.full, item.pr, `Automatic reviews are paused on this pull request. Comment \`@${slug} resume\` to start them again.${where.length ? `\n\n${where.join("\n")}` : ""}`);
      }
      if (item.cmd === "resume") {
        st.paused = false;
        await this.ctx.storage.put("state", st);
        // As CodeRabbit's: the commits pushed while paused are reviewed now.
        // Not a draft's, nor a closed PR's: those wait to be ready or reopened.
        const pr = typeof fx.pullRequest === "function" ? await fx.pullRequest(item.repo.full, item.pr) : null;
        const head = pr?.head?.sha ?? null;
        const draft = Boolean(pr?.draft) || Boolean(st.draft);
        const shut = (pr && pr.state !== "open") || st.closed;
        // A retried resume whose review is already under way (its job kept on
        // the item) goes on with it: the shortcut is only for a fresh one.
        const kept = item.jobId ? await this.ctx.storage.get(`job:${item.jobId}`) : null;
        if (kept) {
          // Already running: its own end edits the acknowledgement.
          if (kept.claimedBy) return undefined;
          // The item's id stands in when the job's write failed (reviewNow
          // saves it on the item first).
          const ackId = Number.isSafeInteger(kept.ackId) ? kept.ackId : item.ackId;
          // The head was reviewed meanwhile: the job is done without a second
          // review (a requested run is forced, so it would review it again).
          if (head && (head === st.lastReviewed || head === st.lastCompleteReviewed)) {
            await this.queueAck(ackId, actionPerformed("Review finished."));
            await this.ctx.storage.delete(`job:${item.jobId}`);
            return undefined;
          }
          // It became a draft, or closed, meanwhile: no review now.
          if (draft || shut) {
            await this.ackEnded({ ackId }, shut ? "This pull request is closed: it is reviewed if it is reopened." : "This pull request is a draft: it is reviewed once it is marked ready.");
            await this.ctx.storage.delete(`job:${item.jobId}`);
            return undefined;
          }
          return this.reviewNow(fx, item, st, { full: false, text: "Automatic reviews are back on. Reviewing the commits pushed while they were paused." });
        }
        if (!head || draft || shut || head === st.lastReviewed || head === st.lastCompleteReviewed) {
          const note = shut ? " This pull request is closed: it is reviewed if it is reopened." : draft ? " This pull request is a draft: it is reviewed once it is marked ready." : "";
          if (!item.acked) await fx.comment(item.repo.full, item.pr, `Automatic reviews are back on.${note}`);
          return undefined;
        }
        return this.reviewNow(fx, item, st, { full: false, text: "Automatic reviews are back on. Reviewing the commits pushed while they were paused." });
      }
      if (item.cmd === "rate limit") {
        const cap = await this.capacityNow();
        const at = Number.isFinite(cap.retryAt) ? new Date(cap.retryAt).toISOString().slice(11, 16) : null;
        await fx.comment(item.repo.full, item.pr, actionPerformed(cap.ok ? "A review can run now: a model has capacity." : `No model has capacity now${at ? `: a review runs when one resets, at ${at} UTC` : ""}. Reviews are delayed, not skipped.`));
        return undefined;
      }
      if (item.cmd === "resolve" && Number.isSafeInteger(item.inThreadOf)) return this.resolveOne(fx, item, slug);
      if (item.cmd === "resolve" || item.cmd === "approve") return this.resolveAll(fx, item, slug);
      // review / full review: now, and it covers any push still waiting.
      // As CodeRabbit's: a commit already reviewed in full is not reviewed
      // again by `review` (`full review` does that).
      // A request that would change nothing is declined with its reason, so
      // a caller (a person or an agent) cannot make a redundant review: a
      // draft or closed PR is reviewed when it is made ready or reopened, and
      // a head already under review is not queued twice. A retried item
      // (its job already kept) skips these checks.
      if ((item.cmd === "review" || item.cmd === "full review") && !item.jobId && typeof fx.pullRequest === "function") {
        const a = await this.advise(fx, st, { cmd: item.cmd, slug, repo: item.repo, pr: item.pr, ignore: item.id });
        if (a.why) {
          await fx.comment(item.repo.full, item.pr, actionNotCompleted(a.why));
          return undefined;
        }
        await this.reconcile(st, a);
      }
      return this.reviewNow(fx, item, st, { full: item.cmd === "full review", text: "Review triggered." });
    }
    if (item.type === "ack") {
      if (!key || !Number.isSafeInteger(item.commentId) || typeof fx.editComment !== "function") return undefined;
      await fx.editComment(key.repo, item.commentId, item.text);
      return undefined;
    }
    return undefined;
  }

  // A review a writer asked for (review, full review, resume): one job, and
  // one acknowledgement, edited to "Review finished." when it is done. Both
  // are kept on the item, so a retried alarm makes neither twice.
  // What a caller (a person's comment, or an agent through the MCP tools)
  // may usefully do now. One rule set for both: a request that would change
  // nothing is refused with its reason, and `next_action` says what to do
  // instead. Decided here, from the PR as GitHub reports it and the state the
  // reviewer keeps, never from what the caller remembers.
  async advise(fx, st, { cmd = "review", slug = DEFAULT_SLUG, repo, pr, ignore = null }) {
    const info = typeof fx.pullRequest === "function" ? await fx.pullRequest(repo.full, pr) : null;
    const head = info?.head?.sha ?? null;
    // GitHub's own answer wins over the stored flags, which a missed webhook
    // could leave stale; the flags are only for when GitHub cannot be asked.
    const shut = info ? info.state !== "open" : Boolean(st.closed);
    const draft = info ? Boolean(info.draft) : Boolean(st.draft);
    // A worker run, or a runner's job that has been dispatched or claimed and
    // is not expired (a runner leaves no run record of its own).
    let running = await activeRun(this.ctx.storage);
    if (!running) {
      const now = this.now();
      for (const j of (await this.ctx.storage.list({ prefix: "job:" })).values()) {
        const at = j?.claimedAt ?? j?.dispatchedAt;
        if (at !== undefined && now - at < JOB_TTL_MS) { running = { runner: true, headSha: j.headSha ?? null }; break; }
      }
    }
    // Work already queued that has not started (a dispatch held for capacity,
    // or a command whose sender is already known to have write access): a
    // request now would queue a second review. A comment's command is not
    // counted until it is checked, so an outsider's cannot block a writer's.
    const queued = ((await this.ctx.storage.get("outbox")) ?? []).some((x) => x.id !== ignore && (x.type === "dispatch" || (x.type === "command" && x.authorised === true && /review$/.test(String(x.cmd)))));
    // A fork's pull request is reviewed only when a writer asks.
    const fork = Boolean(info?.head?.repo?.full_name && info?.base?.repo?.full_name && info.head.repo.full_name !== info.base.repo.full_name);
    const reviewed = Boolean(head) && head === st.lastCompleteReviewed;
    const why = shut ? "This pull request is closed: it is reviewed if it is reopened."
      : draft ? "This pull request is a draft: it is reviewed once it is marked ready."
      : running?.runner || (head && running?.headSha === head) ? "A review of the last commit is already under way."
      : queued && /review$/.test(cmd) ? "A review is already queued."
      : cmd === "review" && reviewed && !running ? `Already reviewed the last commit. Use \`@${slug} full review\` to review every file again.`
      : null;
    const next = shut ? "none"
      : draft ? "mark_ready_for_review"
      : running || queued ? "wait"
      : fork && !reviewed ? "ask_a_writer_to_request_review"
      : st.paused ? "resume"
      : reviewed ? "read_threads"
      : "wait";
    return { why, next, head, shut, draft, running, reviewed, open: Boolean(info) && !shut && !draft };
  }

  // GitHub says the pull request is open and ready: the stored flags follow,
  // so a missed reopen or ready webhook cannot make the review's own
  // decision (or the dispatch) treat it as closed or a draft.
  async reconcile(st, a) {
    if (!a.open || (!st.closed && !st.draft)) return;
    st.closed = false;
    st.draft = false;
    await this.ctx.storage.put("state", st);
  }

  // MCP tool `get_review_status`: read-only.
  async status({ slug = DEFAULT_SLUG, repo = null, pr = null } = {}) {
    const st = await this.state();
    const key = (await this.ctx.storage.get("key")) ?? {};
    const a = await this.advise(this.effects ?? createEffects(this.env, { config: await appConfig(this.env) }), st, { cmd: "review", slug, repo: repo ?? { full: key.repo }, pr: pr ?? key.pr });
    return {
      state: a.shut ? "closed" : a.draft ? "draft" : a.running ? "reviewing" : st.paused ? "paused" : "open",
      head: a.head,
      reviewed_head: st.lastCompleteReviewed ?? null,
      last_attempted_head: st.lastReviewed ?? null,
      paused: Boolean(st.paused),
      reviewing: Boolean(a.running),
      can_request_review: !a.why,
      reason: a.why,
      next_action: a.next,
    };
  }

  // MCP tool `list_review_threads`: the reviewer's own threads, compact.
  async threads({ slug = DEFAULT_SLUG, repo, pr, include_resolved = false }) {
    const fx = this.effects ?? createEffects(this.env, { config: await appConfig(this.env) });
    if (typeof fx.ownThreads !== "function") return { threads: [] };
    const out = [];
    for (const t of await fx.ownThreads(repo.full, pr, slug)) {
      if (t.resolved && !include_resolved) continue;
      const h = parseHeader(t.body);
      out.push({
        id: t.id, resolved: Boolean(t.resolved), outdated: Boolean(t.outdated), path: t.path, line: t.line,
        severity: h?.severity ?? null, category: h?.category ?? null, finding_id: t.findingId ?? null,
        body: String(t.body ?? "").slice(0, 600),
      });
    }
    return { threads: out };
  }

  // MCP tool `request_review`: the same command a comment would queue, after
  // the same refusals. The alarm still checks the caller's write access.
  async request({ slug = DEFAULT_SLUG, login, repo, pr, full = false }) {
    const st = await this.state();
    const a = await this.advise(this.effects ?? createEffects(this.env, { config: await appConfig(this.env) }), st, { cmd: full ? "full review" : "review", slug, repo, pr });
    if (a.why) return { accepted: false, reason: a.why, next_action: a.next };
    await this.reconcile(st, a);
    if (!(await this.ctx.storage.get("key"))) await this.ctx.storage.put("key", { repo: repo.full, pr });
    await this.outbox({ type: "command", cmd: full ? "full review" : "review", slug, login, repo, pr, authorised: true });
    return { accepted: true, next_action: "wait" };
  }

  async reviewNow(fx, item, st, { full, text }) {
    await this.ctx.storage.delete("debounce");
    await this.keepJobOnItem(item, st, { full, requestedBy: item.login });
    if (!item.acked) {
      // Best effort: a comment that cannot be posted (a locked conversation, a
      // rate limit) must not stop the review that was asked for.
      let commentId = null;
      try {
        commentId = await fx.comment(item.repo.full, item.pr, actionPerformed(text));
      } catch (e) {
        console.log(JSON.stringify({ svc: "ai-review", ev: "ack_failed", pr: item.pr, message: String(e?.message ?? e).slice(0, 120) }));
      }
      item.acked = true;
      if (Number.isSafeInteger(commentId)) item.ackId = commentId;
      // The flag, the id and the job's copy of it in one write (a multi-key
      // put is atomic): no failure can leave one without the others.
      const box = (await this.ctx.storage.get("outbox")) ?? [];
      const job = await this.ctx.storage.get(`job:${item.jobId}`);
      const writes = { outbox: box.map((x) => (x.id === item.id ? item : x)) };
      if (job && Number.isSafeInteger(item.ackId)) writes[`job:${item.jobId}`] = { ...job, ackId: item.ackId };
      await this.ctx.storage.put(writes);
    }
    // Events interleave while GitHub's call is pending: the PR may have been
    // closed (its jobs deleted) before the comment's id was known. The
    // acknowledgement then says so, and nothing is dispatched.
    if (!(await this.ctx.storage.get(`job:${item.jobId}`))) {
      const closed = (await this.state()).closed;
      await this.queueAck(item.ackId, actionNotCompleted(closed ? "The pull request was closed before the review finished." : "The review could not start."));
      return undefined;
    }
    return this.dispatchJob(fx, item.jobId);
  }

  // A job ends without completing (given up, dropped, its PR closed): its
  // acknowledgement, if any, says so rather than "Review triggered." for ever.
  async ackEnded(job, why) {
    await this.queueAck(job?.ackId, actionNotCompleted(why));
  }

  async keepItem(item) {
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    await this.ctx.storage.put("outbox", box.map((x) => (x.id === item.id ? item : x)));
  }

  // "worker" (the default): the review runs here, in this object's alarm, in
  // steps, and covers every file (review-run.js). "runner": the earlier path,
  // a runner on the light lane that sends the diff to /v1/runner/review.
  mode() {
    return String(this.env?.REVIEW_MODE ?? "").trim().toLowerCase() === "runner" ? "runner" : "worker";
  }

  // One review at a time per pull request: a job that comes while one runs
  // waits for it (it then reviews from where that one stopped).
  async startWorkerRun(job, st) {
    const active = await activeRun(this.ctx.storage);
    // Held until the running review can next move (no sooner than RECHECK_MS):
    // a review waiting hours for a provider must not wake this every 30 s.
    if (active && active.id !== job.id) {
      // Kept fresh while it waits, or newJob would prune it (JOB_TTL_MS) and
      // its acknowledgement would say it expired.
      await this.ctx.storage.put(`job:${job.id}`, { ...job, createdAt: this.now() });
      // At most half the job's lifetime: looked at again (and kept fresh) well before it could expire.
      return { holdUntil: Math.min(Math.max(this.now() + RECHECK_MS, active.waitUntil || 0), this.now() + JOB_TTL_MS / 2) };
    }
    // Only a full-coverage review's commit is a starting point: the runner and
    // v1 move lastReviewed too, but read at most 90,000 characters.
    const since = job.full ? null : (st.lastCompleteReviewed ?? null);
    if (!active) await startRun(this.ctx.storage, { ...job, since }, this.now());
    const now = this.now();
    await this.ctx.storage.put(`job:${job.id}`, { ...job, since, claimedBy: "worker", claimedAt: now, dispatchedAt: now, firstRunAt: job.firstRunAt ?? now });
    console.log(JSON.stringify({ svc: "ai-review", ev: "run_started", pr: job.pr }));
    await this.armAt(now);
    return undefined;
  }

  // Runs one step of the review in progress; returns when the next is due.
  async stepActiveRun() {
    const run = await activeRun(this.ctx.storage);
    if (!run) return null;
    // A run may wait hours for a provider: its job is kept fresh meanwhile, or
    // newJob would prune it (JOB_TTL_MS) and the finish could not be recorded.
    const job = await this.ctx.storage.get(`job:${run.id}`);
    if (job) await this.ctx.storage.put(`job:${run.id}`, { ...job, createdAt: this.now() });
    const app = this.effects ? null : await appConfig(this.env);
    const fx = this.effects ?? createEffects(this.env, { config: app });
    const slug = app?.slug ?? DEFAULT_SLUG;
    const ctx = {
      storage: this.ctx.storage, env: this.env, cfg: config(this.env), fx, slug,
      deps: { now: this.now, sleep: this.sleep, fetch: this.fetchImpl, log: (e) => console.log(JSON.stringify({ svc: "ai-review", ...e })) },
      again: `- Review again: comment \`@${slug} review\` for the commits since this review, or \`@${slug} full review\`. Pushes to this repository's branches by people with write access are also reviewed a few minutes after the last one, unless reviews are paused.`,
      onDone: (r, out) => this.runDone(r, out),
    };
    return stepRun(ctx, run.id);
  }

  // A run is over: its job completes (moving lastReviewed on) or is dropped,
  // and its stored state goes. One given up says so on the PR.
  async runDone(run, { reviewedSha, gaveUp, description }) {
    if (reviewedSha) {
      await this.complete({ jobId: run.id, runId: "worker", reviewedSha, fullCoverage: true });
      // The latest commit has a complete review: approve, if nothing is open.
      await this.queueDecide({});
    } else {
      const job = await this.ctx.storage.get(`job:${run.id}`);
      // A review that ran but could not cover every file did finish: it says
      // how far it got. One given up, or stopped by the PR closing, did not.
      const said = String(description ?? "").replace(/[`\n]/g, " ").slice(0, 200);
      if (Number.isSafeInteger(job?.ackId)) {
        await this.queueAck(job.ackId, !gaveUp && said ? actionPerformed(`Review finished. ${said}`) : actionNotCompleted(gaveUp ? "The review could not finish." : "The pull request is no longer open."));
      }
      // Only after the edit is queued: were that to fail, the job (and its
      // ackId) is still there for the retry.
      await this.ctx.storage.delete(`job:${run.id}`);
      // The summary was written again without its notice: decide puts back
      // the right one (pending, as the head has no complete review).
      await this.queueDecide({});
    }
    await dropRun(this.ctx.storage, run.id);
    if (gaveUp) {
      const why = String(description ?? "the review kept failing").replace(/[`\n]/g, " ").slice(0, 200);
      await this.outbox({ type: "comment", template: "gave_up", reason: why, tries: 3, replyTo: { login: "tankster-ai-review", kind: "gave_up" } });
    }
  }

  // --- automatic approvals (CodeRabbit's Automatic Approvals) ---------------

  // One decision waiting at a time of each kind: a burst of resolved threads
  // is decided once.
  async queueDecide({ reopened = false, force = false, login = null }) {
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    if (!force && box.some((x) => x.type === "decide" && Boolean(x.reopened) === reopened && !x.force)) return;
    await this.outbox({ type: "decide", reopened, force, login });
  }

  // Approves the head when (as CodeRabbit's requirements) the latest commit has
  // a complete review (unless a writer's command forces it), none of the App's
  // own threads and no body-only finding is open, the App has not approved
  // already, and the head is unchanged just before approving. A thread
  // resolved by someone without write access still counts as open. A thread
  // reopened after an approval asks for changes again, whatever was reviewed.
  async decide(fx, item, slug) {
    if (typeof fx.ownThreads !== "function" || typeof fx.reviewDecision !== "function") return undefined;
    const key = await this.ctx.storage.get("key");
    const st = await this.state();
    if (!key || st.closed) return undefined;
    const pr = await fx.pullRequest(key.repo, key.pr);
    const head = pr?.head?.sha;
    if (pr?.state !== "open" || pr.draft || !/^[0-9a-f]{40}$/.test(String(head))) return undefined;
    if (!item.reopened && !item.force && st.lastCompleteReviewed !== head) {
      // A review of this head is still to come (or failed): say so.
      await this.noticeApproval(fx, key, { pending: head, slug });
      return undefined;
    }
    // External calls let other events run: a thread reopened while they are
    // pending would leave this snapshot (and its view of what a writer
    // accepted) out of date, and its own decision is already waiting, so no
    // new one is queued. Every reopen bumps reopenSeq together with its mark
    // and the lost acceptance; a snapshot taken across a bump is taken again.
    let open, inBody, decision, seqAtSnapshot, settled = false;
    for (let tries = 0; tries < 3 && !settled; tries++) {
      const seq0 = (await this.ctx.storage.get("reopenSeq")) ?? 0;
      open = [];
      const writers = new Map();
      const isWriter = async (login) => {
        if (!writers.has(login)) writers.set(login, await fx.canWrite(key.repo, login));
        return writers.get(login);
      };
      // A thread resolved by someone without write access counts as open,
      // unless a review since found it fixed, or a writer's resolve/approve
      // vouched for it (both recorded in ACCEPTED).
      const accepted = await acceptedSet(this.ctx.storage);
      for (const t of await fx.ownThreads(key.repo, key.pr, slug)) {
        // A nitpick never holds back approval (CodeRabbit's rule), open or not.
        if (nitpickFinding(t.body)) continue;
        if (!t.resolved) open.push(t);
        // A writer's resolve/approve vouches through ACCEPTED (resolveAll),
        // only for the threads in its own view: one reopened since and then
        // resolved by an outsider is open, forced or not.
        else if (t.resolvedBy && t.resolvedBy !== slug && !accepted.has(t.id) && !(await isWriter(t.resolvedBy))) open.push(t);
        // Resolved by the App while a person's reopen still stands (its mark
        // goes only when a writer resolves it): a command's race, not a fix.
        // The reviewer never resolves a reopened thread, and a command that
        // vouched for it accepted it.
        else if (t.resolvedBy === slug && !accepted.has(t.id) && (await reopenMark(this.ctx.storage, t.id)) !== undefined) open.push(t);
      }
      // A kept finding that is a nitpick never blocks either. Only text that
      // carries the Worker's own comment header (its id line, as from the 422
      // fallback) is judged: a body-listed finding's text starts with the
      // model's title, which could imitate a label. Never one kept as severe.
      const isNit = (f) => !f.severe && Boolean(findingIdOf(f.text)) && nitpickFinding(f.text);
      inBody = (await listOpenFindings(this.ctx.storage)).filter((f) => !isNit(f));
      decision = await fx.reviewDecision(key.repo, key.pr, `${slug}[bot]`);
      seqAtSnapshot = seq0;
      settled = ((await this.ctx.storage.get("reopenSeq")) ?? 0) === seq0;
    }
    if (!settled) {
      // Reopens kept arriving: decide again from scratch, never from this snapshot.
      await this.outbox({ type: "decide", reopened: Boolean(item.reopened), force: Boolean(item.force), login: item.login ?? null });
      return undefined;
    }
    if (item.reopened) {
      if ((open.length || inBody.length) && decision?.state === "APPROVED") {
        // As CodeRabbit's: the approval is withdrawn (dismissed). Only if
        // GitHub refuses that is changes requested instead.
        const why = "A review thread was reopened, so this pull request is no longer approved. It is approved again once its threads are resolved.";
        const dismissed = typeof fx.dismissReview === "function" && Number.isSafeInteger(decision.id)
          ? await fx.dismissReview(key.repo, key.pr, decision.id, why) : false;
        if (!dismissed) await fx.postReview(key.repo, key.pr, { commitId: head, comments: [], event: "REQUEST_CHANGES", body: `${MARKER}\n${why}` });
      }
      // The summary's notice must not still say approved: it lists what is open.
      if (open.length || inBody.length) await this.noticeApproval(fx, key, { withheld: head, open, inBody, slug });
      return undefined;
    }
    if (open.length || inBody.length) {
      await this.noticeApproval(fx, key, { withheld: head, open, inBody, slug });
      return undefined;
    }
    if (decision?.state === "APPROVED") {
      await this.noticeApproval(fx, key, { approved: decision.commitId ?? head });
      return undefined;
    }
    const now = await fx.pullRequest(key.repo, key.pr);
    if (now?.head?.sha !== head || now?.state !== "open" || now.draft) return undefined;
    // As CodeRabbit's: an approval with no text (the summary comment says why).
    // A reopen since the snapshot: decide again, of the same kind (a reopened
    // decision never approves, so an ordinary one must stay ordinary), rather
    // than approve from it.
    const again = () => this.outbox({ type: "decide", reopened: Boolean(item.reopened), force: Boolean(item.force), login: item.login ?? null });
    if (((await this.ctx.storage.get("reopenSeq")) ?? 0) !== seqAtSnapshot) { await again(); return undefined; }
    const ok = await fx.approve(key.repo, key.pr, { commitId: head, body: "" });
    if (ok !== false) await this.noticeApproval(fx, key, { approved: head });
    console.log(JSON.stringify({ svc: "ai-review", ev: ok === false ? "approval_refused" : "approved", pr: key.pr, forced: Boolean(item.force) }));
    return undefined;
  }

  // The approval notice in the summary comment (CodeRabbit's "Automatic
  // approval withheld"): why the pull request is not approved, with links to
  // the open threads, or that it is. Written only when it changes, and only
  // once a review has written the summary.
  async noticeApproval(fx, key, { pending, withheld, approved, open = [], inBody = [], slug = DEFAULT_SLUG }) {
    if (typeof fx.upsertSummary !== "function") return;
    const base = await this.ctx.storage.get(SUMMARY_BASE);
    if (typeof base !== "string") return;
    const url = (t) => `https://github.com/${key.repo}/pull/${key.pr}#discussion_r${t.commentId}`;
    let notice;
    if (approved) notice = `**Automatic approval**: approved at commit \`${String(approved).slice(0, 12)}\`.`;
    else if (pending) notice = `**Automatic approval pending**: commit \`${String(pending).slice(0, 12)}\` has no complete review yet.`;
    else {
      const lines = ["**Automatic approval withheld**", ""];
      if (open.length) {
        lines.push(`${open.length === 1 ? "1 review thread is" : `${open.length} review threads are`} still open and must be resolved first:`, "");
        for (const [i, t] of open.slice(0, 20).entries()) lines.push(Number.isSafeInteger(t.commentId) ? `- [Thread ${i + 1}](${url(t)})` : `- Thread ${i + 1}`);
        if (open.length > 20) lines.push(`- …and ${open.length - 20} more`);
        lines.push("");
      }
      if (inBody.length) lines.push(`${inBody.length === 1 ? "1 finding listed in a review body is" : `${inBody.length} findings listed in review bodies are`} still open.`, "");
      lines.push(`Address them and push, resolve the threads on the pull request, or post \`@${slug} approve\` as a new top-level comment to resolve them and request approval.`, "", `Commit: \`${String(withheld).slice(0, 12)}\`.`);
      notice = lines.join("\n");
    }
    if ((await this.ctx.storage.get(SUMMARY_NOTICE)) === notice) return;
    const id = await fx.upsertSummary(key.repo, key.pr, (await this.ctx.storage.get(SUMMARY_KEY)) ?? null, withNotice(base, notice));
    if (Number.isSafeInteger(id)) await this.ctx.storage.put(SUMMARY_KEY, id);
    await this.ctx.storage.put(SUMMARY_NOTICE, notice);
  }

  // `resolve` posted as a reply in one of the App's threads (CodeRabbit's
  // reference): that thread only. The writer vouches for it, as for a
  // top-level resolve, unless it was reopened after the command was posted;
  // then an ordinary decision follows.
  async resolveOne(fx, item, slug) {
    const key = await this.ctx.storage.get("key");
    if (!key || typeof fx.ownThreads !== "function") return undefined;
    const t = (await fx.ownThreads(key.repo, key.pr, slug)).find((x) => x.commentId === item.inThreadOf);
    // Not one of the App's own threads: nothing to do, as CodeRabbit.
    if (!t) return undefined;
    // Reopened after the command was posted: newer than it, so it stays open
    // (resolved by the App, decide would count it as resolved).
    const newer = (await reopenMark(this.ctx.storage, t.id)) > (Number.isInteger(item.seq) ? item.seq : Infinity);
    if (!newer) {
      if (!t.resolved && !(await fx.resolveThread(key.repo, t.id))) throw new Error("the thread could not be resolved");
      // Read again: a reopen can land during GitHub's call.
      if (!((await reopenMark(this.ctx.storage, t.id)) > (Number.isInteger(item.seq) ? item.seq : Infinity))) await acceptThreads(this.ctx.storage, [t.id]);
    }
    await this.queueDecide({});
    return undefined;
  }

  // resolve / approve: every open thread of the App's own is resolved (a few
  // a step), its body-only findings are cleared, then a decision is queued
  // as its own item (its calls do not share this alarm's subrequests).
  async resolveAll(fx, item, slug) {
    const key = await this.ctx.storage.get("key");
    if (!key || typeof fx.ownThreads !== "function") return undefined;
    // Reopens numbered after the command was posted are newer than its view
    // (onEvent stores the number on the item; an item from before that has
    // none and uses the number now).
    const seq = Number.isInteger(item.seq) ? item.seq : (await this.ctx.storage.get("reopenSeq")) ?? 0;
    const threads = await fx.ownThreads(key.repo, key.pr, slug);
    // A thread reopened after the command was posted is newer than its view:
    // left open, never resolved by the App on the command's behalf.
    const marks = new Map();
    for (const t of threads) marks.set(t.id, (await reopenMark(this.ctx.storage, t.id)) > seq);
    const open = threads.filter((t) => !t.resolved && !marks.get(t.id));
    let done = 0;
    for (const t of open.slice(0, RESOLVE_PER_STEP)) {
      // Read again: a reopen can land during an earlier thread's call.
      if ((await reopenMark(this.ctx.storage, t.id)) > seq) { done++; continue; }
      if (await fx.resolveThread(key.repo, t.id)) done++;
    }
    // Nothing moved: an attempt that counts, so it cannot spin for ever.
    if (open.length && !done) throw new Error("no thread could be resolved");
    // Some still open (past this step's share, or refused): again shortly,
    // and nothing is cleared or decided until none is.
    if (done < open.length) return { holdUntil: this.now() + 1000 };
    // The writer vouched for every thread, those resolved by people without
    // write access included: later decisions count them as resolved too.
    const vouched = [];
    // Read again: a reopen can land while GitHub's calls are pending.
    for (const t of threads) if (!((await reopenMark(this.ctx.storage, t.id)) > seq)) vouched.push(t.id);
    await acceptThreads(this.ctx.storage, vouched);
    await clearOpenFindings(this.ctx.storage);
    await this.queueDecide({ force: true, login: item.login });
    return undefined;
  }

  async capacityNow(chars, skip = []) {
    if (this.capacity) return this.capacity(chars, skip);
    if (!this.env?.LEDGER) return { ok: true };
    const cfg = config(this.env);
    const deps = { now: this.now, sleep: async () => {}, fetch: () => Promise.reject(new Error("no calls")), log: () => {} };
    const chain = draftChain(this.env, cfg).filter((x) => !skip.includes(`${x.kind}:${x.model}`));
    return capacity(this.env, cfg, chain, deps, Number(chars) > 0 ? Number(chars) : undefined);
  }

  // The runner's review was deferred (every provider out of quota): the job
  // is released and dispatched again once one resets. Queued, never dropped.
  async defer({ jobId, runId, retryAt, why = "quota", chars, reason, failed }) {
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (!job || job.claimedBy !== String(runId)) return { error: "not your job" };
    const st = await this.state();
    const retries = (job.retries ?? 0) + (why === "quota" ? 0 : 1);
    // Three days from its first run, not from when it was made: a job held
    // for days before any provider could take it gets its full time.
    const old = this.now() - (job.firstRunAt ?? job.firstAt ?? job.createdAt) > MAX_JOB_LIFE_MS;
    if (st.closed || retries >= MAX_RETRIES || old) {
      // The edit is queued before the job goes: a failed queue keeps its ackId.
      await this.ackEnded(job, st.closed ? "The pull request was closed before the review finished." : "The review could not finish.");
      if (!st.closed) await this.releaseHeld(job);
      await this.ctx.storage.delete(`job:${jobId}`);
      if (!st.closed) {
        // Never silently: say so on the PR, at most once an hour.
        console.log(JSON.stringify({ svc: "ai-review", ev: "review_given_up", retries }));
        const why = String(reason ?? "the review kept failing").replace(/[`\n]/g, " ").slice(0, 200);
        await this.outbox({ type: "comment", template: "gave_up", reason: why, tries: retries, waited: old, replyTo: { login: "tankster-ai-review", kind: "gave_up" } });
      }
      return { ok: true, dropped: true };
    }
    const { claimedAt: _c, dispatchedAt: _d, ...rest } = job;
    const when = Math.max(this.now() + MIN_DEFER_MS, Number(retryAt) || 0);
    // Providers that failed this review outright are skipped on its next tries
    // (and by the capacity check), so one that always fails cannot keep a
    // waiting review running, and spending the others' quota.
    const skip = [...new Set([...(job.skip ?? []), ...(Array.isArray(failed) ? failed.filter((x) => typeof x === "string").slice(0, 10) : [])])];
    await this.ctx.storage.put(`job:${jobId}`, {
      ...rest, claimedBy: null, createdAt: this.now(), retries, retryAt: when, skip,
      ...(Number(chars) > 0 ? { chars: Number(chars) } : {}),
    });
    // Looked at again at least hourly (keeping the job fresh) until retryAt.
    const at = Math.min(when, this.now() + HOLD_RECHECK_MS);
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    if (!box.some((x) => x.type === "dispatch" && x.jobId === jobId)) {
      box.push({ id: randomId(), attempts: 0, type: "dispatch", jobId, notBefore: at });
      await this.ctx.storage.put("outbox", box);
    }
    await this.armAt(at);
    return { ok: true, retryAt: at };
  }

  // The runner's first call. A job is claimed once, by one workflow run, and
  // only within two hours of being made.
  async claim({ jobId, runId }) {
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (!job) return { error: "unknown or finished job" };
    if (this.now() - job.createdAt > JOB_TTL_MS) {
      await this.ackEnded(job, "The review expired before it could run.");
      await this.ctx.storage.delete(`job:${jobId}`);
      return { error: "job expired" };
    }
    if (job.claimedBy && job.claimedBy !== String(runId)) return { error: "job already claimed" };
    // An incremental job starts from the last review finished by the time it
    // is claimed, not when it was made: a review that completed in between is
    // not reviewed twice.
    if (!job.claimedBy && job.full === false) job.since = (await this.state()).lastReviewed;
    if (!job.claimedBy) job.claimedAt = this.now();
    job.claimedBy = String(runId);
    await this.ctx.storage.put(`job:${jobId}`, job);
    return { job };
  }

  // fullCoverage: the Worker's own review covered every file (review-run.js);
  // only such a review moves lastCompleteReviewed, its incremental start.
  async complete({ jobId, runId, reviewedSha, fullCoverage = false }) {
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (!job || job.claimedBy !== String(runId)) return { error: "not your job" };
    const st = await this.state();
    // Two reviews can overlap. The one claimed later almost always read the
    // newer head (each run reads the head just after its claim), so one that
    // finishes after it never moves lastReviewed back. If two runs read the
    // head in the other order, a few commits are reviewed again: harmless.
    const at = job.claimedAt ?? 0;
    if (/^[0-9a-f]{40}$/.test(String(reviewedSha)) && at >= (st.lastClaimedAt ?? 0)) {
      st.lastReviewed = reviewedSha;
      st.lastClaimedAt = at;
    }
    if (fullCoverage && /^[0-9a-f]{40}$/.test(String(reviewedSha)) && at >= (st.lastCompleteClaimedAt ?? 0)) {
      st.lastCompleteReviewed = reviewedSha;
      st.lastCompleteClaimedAt = at;
    }
    // Pushes made before this run claimed its job are covered (see fireDebounce).
    if (job.claimedAt !== undefined) st.lastDoneClaimAt = Math.max(st.lastDoneClaimAt ?? -Infinity, job.claimedAt);
    await this.ctx.storage.put("state", st);
    // The edit is queued before the job goes: a retry after a failure in
    // between finds the job and queues nothing twice (queueAck).
    await this.queueAck(job.ackId, actionPerformed("Review finished."));
    await this.ctx.storage.delete(`job:${jobId}`);
    return { ok: true };
  }
}
