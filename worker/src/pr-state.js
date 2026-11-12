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
import { createEffects } from "./effects.js";

const JOB_TTL_MS = 2 * 3600_000;
const KEEP_DELIVERIES = 200;
const COMMANDS = ["full review", "review", "pause", "resume", "help"];

export function helpText(slug = DEFAULT_SLUG) {
  return [
    `**Tankster AI Review commands**: mention \`@${slug}\` followed by:`,
    "",
    "| Command | What it does |",
    "|---|---|",
    "| `review` | Review the commits pushed since the last review |",
    "| `full review` | Review the whole pull request again |",
    "| `pause` | Stop automatic reviews on this pull request |",
    "| `resume` | Start automatic reviews again |",
    "| `help` | Show this list |",
    "",
    "Reviews of pull requests from forks or from authors without write access start only when someone with write access asks for one.",
  ].join("\n");
}

export function parseCommand(text, slug = DEFAULT_SLUG) {
  const after = String(text).split(mentionOf(slug)).pop() ?? "";
  const line = after.trim().split("\n")[0].toLowerCase().replace(/\s+/g, " ").trim();
  return COMMANDS.find((c) => line === c || line.startsWith(`${c} `) || line.startsWith(`${c}.`)) ?? null;
}

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function jobIdFor(prKey) {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  return `${b64url(prKey)}.${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function prKeyOfJob(jobId) {
  const m = /^([A-Za-z0-9_-]{4,400})\.[0-9a-f]{32}$/.exec(String(jobId ?? ""));
  if (!m) return null;
  try {
    const pad = m[1].replace(/-/g, "+").replace(/_/g, "/");
    return decodeURIComponent(escape(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4))));
  } catch {
    return null;
  }
}

const WRITER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MAX_ATTEMPTS = 5;
const REPLY_WINDOW_MS = 3600_000;
const DELETE_CHUNK = 128; // a Durable Object deletes at most 128 keys per call

export function needsApproval(slug = DEFAULT_SLUG) {
  return `This pull request comes from a fork or from an author without write access, so it is not reviewed automatically. Someone with write access can comment \`@${slug} review\` to start one.`;
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
  }

  async state() {
    return (await this.ctx.storage.get("state")) ?? { lastReviewed: null, paused: false, closed: false };
  }

  async fetch(request) {
    const msg = await request.json();
    let out;
    if (msg.op === "event") out = await this.onEvent(msg);
    else if (msg.op === "claim") out = await this.claim(msg);
    else if (msg.op === "complete") out = await this.complete(msg);
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

  async outbox(item) {
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    box.push({ id: randomId(), attempts: 0, ...item });
    await this.ctx.storage.put("outbox", box);
    await this.ctx.storage.setAlarm(this.now());
  }

  async newJob(ev, st, { full = false, requestedBy = null, queue = true } = {}) {
    // Drop jobs that can no longer be claimed, so they never pile up.
    const old = await this.ctx.storage.list({ prefix: "job:" });
    await this.deleteAll([...old].filter(([, j]) => this.now() - j.createdAt > JOB_TTL_MS).map(([k]) => k));
    const id = jobIdFor(`${ev.repo.full}#${ev.pr}`);
    const job = {
      id,
      repo: { full: ev.repo.full, name: ev.repo.name },
      pr: ev.pr,
      scope: "review",
      since: full ? null : st.lastReviewed,
      requestedBy,
      createdAt: this.now(),
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
      await this.deleteAll([...(await this.ctx.storage.list({ prefix: "job:" })).keys()]);
      return { action: "closed" };
    }

    if (ev.kind === "review") {
      st.closed = false;
      if (ev.draft) return this.save(st, { action: "draft" });
      if (st.paused) return this.save(st, { action: "paused" });
      const opening = ["opened", "reopened", "ready_for_review"].includes(ev.action);
      // Bots wait for a writer, silently. Forks wait for a writer, with a note.
      if (ev.author.bot) return this.save(st, { action: "needs_approval" });
      if (ev.fork) {
        await this.ctx.storage.put("state", st);
        if (opening && (await this.mayReply(ev.author.login, "note"))) {
          await this.outbox({ type: "comment", template: "needs_approval", replyTo: { login: ev.author.login, kind: "note" } });
        }
        return { action: "needs_approval" };
      }
      // author_association can under-report (private org membership), so a
      // non-writer association is checked against the permission API first.
      if (!WRITER_ASSOCIATIONS.has(ev.author.association)) {
        await this.ctx.storage.put("state", st);
        await this.outbox({ type: "author_check", login: ev.author.login, repo: ev.repo, pr: ev.pr, opening });
        return { action: "author_check" };
      }
      const job = await this.newJob(ev, st);
      return this.save(st, { action: "job", jobId: job.id });
    }

    if (ev.kind === "command") {
      const cmd = parseCommand(ev.text, ev.slug);
      // P1 has no chat: anything that is not a command gets no reply.
      if (!cmd) return { action: "not_a_command" };
      if (cmd === "help") {
        if (await this.mayReply(ev.sender.login, "help")) {
          await this.outbox({ type: "comment", body: helpText(ev.slug), replyTo: { login: ev.sender.login, kind: "help" } });
        }
        return { action: "help" };
      }
      // Everything else needs write access, checked through the API by the
      // alarm before it takes effect.
      await this.outbox({ type: "command", cmd, slug: ev.slug, login: ev.sender.login, repo: ev.repo, pr: ev.pr });
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
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    if (!box.length) return;
    const [item, ...rest] = box;
    if (item.attempts >= MAX_ATTEMPTS) {
      console.log(JSON.stringify({ svc: "ai-review", ev: "outbox_dropped", type: item.type }));
      await this.ctx.storage.put("outbox", rest);
    } else {
      item.attempts += 1;
      await this.ctx.storage.put("outbox", [item, ...rest]);
      await this.perform(item);
      const now = (await this.ctx.storage.get("outbox")) ?? [];
      await this.ctx.storage.put("outbox", now.filter((x) => x.id !== item.id));
    }
    if (((await this.ctx.storage.get("outbox")) ?? []).length) await this.ctx.storage.setAlarm(this.now());
  }

  // One job per outbox item, kept on the item so a retried alarm dispatches
  // the same job rather than minting another.
  async keepJobOnItem(item, st, opts) {
    if (item.jobId) return;
    item.jobId = (await this.newJob({ repo: item.repo, pr: item.pr }, st, { ...opts, queue: false })).id;
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    await this.ctx.storage.put("outbox", box.map((x) => (x.id === item.id ? item : x)));
  }

  async perform(item) {
    // No App configured yet: throw, so the item is kept and retried.
    const cfg = this.effects ? null : await appConfig(this.env);
    const fx = this.effects ?? createEffects(this.env, { config: cfg });
    // Replies name the App by its own slug, so mentions people copy work.
    const slug = item.slug ?? cfg?.slug ?? DEFAULT_SLUG;
    const key = await this.ctx.storage.get("key");
    if (item.type === "dispatch") return fx.dispatch(item.jobId);
    if (item.type === "comment") {
      if (!key) return undefined;
      // Re-checked here: several may have been queued before the first posted.
      if (item.replyTo && !(await this.mayReply(item.replyTo.login, item.replyTo.kind))) return undefined;
      await fx.comment(key.repo, key.pr, item.template === "needs_approval" ? needsApproval(slug) : item.body);
      if (item.replyTo) await this.replied(item.replyTo.login, item.replyTo.kind);
      return undefined;
    }

    if (item.type === "author_check") {
      const st = await this.state();
      if (await fx.canWrite(item.repo.full, item.login)) {
        if (st.paused) return undefined;
        await this.keepJobOnItem(item, st, {});
        return fx.dispatch(item.jobId);
      }
      if (item.opening && (await this.mayReply(item.login, "note"))) {
        await fx.comment(item.repo.full, item.pr, needsApproval(slug));
        await this.replied(item.login, "note");
      }
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
        return fx.comment(item.repo.full, item.pr, `Automatic reviews are paused on this pull request. Comment \`@${slug} resume\` to start them again.`);
      }
      if (item.cmd === "resume") {
        st.paused = false;
        await this.ctx.storage.put("state", st);
        return fx.comment(item.repo.full, item.pr, `Automatic reviews are back on. I'll review the next push, or comment \`@${slug} review\` now.`);
      }
      // review / full review
      await this.keepJobOnItem(item, st, { full: item.cmd === "full review", requestedBy: item.login });
      return fx.dispatch(item.jobId);
    }
    return undefined;
  }

  // The runner's first call. A job is claimed once, by one workflow run, and
  // only within two hours of being made.
  async claim({ jobId, runId }) {
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (!job) return { error: "unknown or finished job" };
    if (this.now() - job.createdAt > JOB_TTL_MS) {
      await this.ctx.storage.delete(`job:${jobId}`);
      return { error: "job expired" };
    }
    if (job.claimedBy && job.claimedBy !== String(runId)) return { error: "job already claimed" };
    job.claimedBy = String(runId);
    await this.ctx.storage.put(`job:${jobId}`, job);
    return { job };
  }

  async complete({ jobId, runId, reviewedSha }) {
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (!job || job.claimedBy !== String(runId)) return { error: "not your job" };
    const st = await this.state();
    if (/^[0-9a-f]{40}$/.test(String(reviewedSha))) st.lastReviewed = reviewedSha;
    await this.ctx.storage.put("state", st);
    await this.ctx.storage.delete(`job:${jobId}`);
    return { ok: true };
  }
}
