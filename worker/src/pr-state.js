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
import { config } from "./config.js";
import { capacity, draftChain } from "./providers.js";
import { RUN, RUN_META, activeRun, dropRun, startRun, stepRun } from "./review-run.js";

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
    else if (msg.op === "complete") out = await this.complete(msg);
    else if (msg.op === "defer") out = await this.defer(msg);
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
    await this.deleteAll([...old].filter(([, j]) => this.now() - j.createdAt > JOB_TTL_MS).map(([k]) => k));
    const id = jobIdFor(`${ev.repo.full}#${ev.pr}`);
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
      await this.ctx.storage.delete("debounce");
      await this.deleteAll([...(await this.ctx.storage.list({ prefix: "job:" })).keys()]);
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
        return this.save(st, { action: "draft" });
      }
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
    // A quiet period that is over becomes a job (and a dispatch in the outbox).
    await this.fireDebounce();
    // One step of the review in progress, if any (review-run.js).
    const runNext = await this.stepActiveRun();
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    const isDue = (x) => !(x.notBefore > this.now());
    const item = box.find(isDue);
    if (item) {
      if (item.attempts >= MAX_ATTEMPTS) {
        console.log(JSON.stringify({ svc: "ai-review", ev: "outbox_dropped", type: item.type }));
        await this.ctx.storage.put("outbox", box.filter((x) => x.id !== item.id));
        // Its job would never get a runner: it must not stand in for later pushes.
        if (item.jobId) await this.ctx.storage.delete(`job:${item.jobId}`);
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
    const box = (await this.ctx.storage.get("outbox")) ?? [];
    await this.ctx.storage.put("outbox", box.map((x) => (x.id === item.id ? item : x)));
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
      await this.ctx.storage.delete(`job:${jobId}`);
      return undefined;
    }
    if (this.mode() === "worker") return this.startWorkerRun(held, st);
    // No model provider can take a review now (sized as the review itself,
    // when it was tried before), or the runner said when one will: hold the
    // dispatch rather than start a runner that can only defer. The job is
    // kept fresh meanwhile.
    const cap = held.retryAt > this.now() ? { ok: false, retryAt: held.retryAt } : await this.capacityNow(held.chars, held.skip);
    if (!cap.ok) {
      await this.ctx.storage.put(`job:${jobId}`, { ...held, createdAt: this.now() });
      console.log(JSON.stringify({ svc: "ai-review", ev: "dispatch_held", retry_at: new Date(cap.retryAt).toISOString() }));
      return { holdUntil: Math.max(this.now() + MIN_DEFER_MS, Math.min(cap.retryAt, this.now() + HOLD_RECHECK_MS)) };
    }
    await fx.dispatch(jobId);
    const job = await this.ctx.storage.get(`job:${jobId}`);
    if (job) await this.ctx.storage.put(`job:${jobId}`, { ...job, dispatchedAt: this.now(), firstRunAt: job.firstRunAt ?? this.now() });
    return undefined;
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
      // review / full review: now, and it covers any push still waiting.
      await this.ctx.storage.delete("debounce");
      await this.keepJobOnItem(item, st, { full: item.cmd === "full review", requestedBy: item.login });
      return this.dispatchJob(fx, item.jobId);
    }
    return undefined;
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
    if (active && active.id !== job.id) return { holdUntil: this.now() + RECHECK_MS };
    const since = job.full ? null : st.lastReviewed;
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
    const app = this.effects ? null : await appConfig(this.env);
    const fx = this.effects ?? createEffects(this.env, { config: app });
    const slug = app?.slug ?? DEFAULT_SLUG;
    const ctx = {
      storage: this.ctx.storage, env: this.env, cfg: config(this.env), fx,
      deps: { now: this.now, sleep: this.sleep, fetch: this.fetchImpl, log: (e) => console.log(JSON.stringify({ svc: "ai-review", ...e })) },
      again: `- Review again: comment \`@${slug} review\` for the commits since this review, or \`@${slug} full review\`. Pushes to this repository's branches by people with write access are also reviewed a few minutes after the last one, unless reviews are paused.`,
      onDone: (r, out) => this.runDone(r, out),
    };
    return stepRun(ctx, run.id);
  }

  // A run is over: its job completes (moving lastReviewed on) or is dropped,
  // and its stored state goes. One given up says so on the PR.
  async runDone(run, { reviewedSha, gaveUp, description }) {
    if (reviewedSha) await this.complete({ jobId: run.id, runId: "worker", reviewedSha });
    else await this.ctx.storage.delete(`job:${run.id}`);
    await dropRun(this.ctx.storage, run.id);
    if (gaveUp) {
      const why = String(description ?? "the review kept failing").replace(/[`\n]/g, " ").slice(0, 200);
      await this.outbox({ type: "comment", template: "gave_up", reason: why, tries: 3, replyTo: { login: "tankster-ai-review", kind: "gave_up" } });
    }
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

  async complete({ jobId, runId, reviewedSha }) {
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
    // Pushes made before this run claimed its job are covered (see fireDebounce).
    if (job.claimedAt !== undefined) st.lastDoneClaimAt = Math.max(st.lastDoneClaimAt ?? -Infinity, job.claimedAt);
    await this.ctx.storage.put("state", st);
    await this.ctx.storage.delete(`job:${jobId}`);
    return { ok: true };
  }
}
