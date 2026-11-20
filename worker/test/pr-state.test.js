import { test } from "node:test";
import assert from "node:assert/strict";
import { PrState, parseCommand, jobIdFor, objectOfJob, actionPerformed } from "../src/pr-state.js";
import { memoryStorage, fakeEffects, doCtx } from "./helpers.js";

// These tests cover the runner path (REVIEW_MODE=runner); review-run.test.js
// and the worker-mode tests below cover the Worker's own review.
const RUNNER = { REVIEW_MODE: "runner" };

const NOW = 1_794_500_000_000;
const repo = { full: "TanksterAI/browser-relay", name: "browser-relay", ownerId: "259206056" };

function make({ writers = ["rishitank"], now = () => NOW } = {}) {
  const storage = memoryStorage();
  const fx = fakeEffects({ writers });
  const obj = new PrState(doCtx(storage), RUNNER, { now, effects: fx });
  return { obj, storage, fx };
}

const review = (over = {}) => ({
  kind: "review",
  action: "opened",
  repo,
  pr: 39,
  sender: { login: "rishitank", bot: false },
  head: { sha: "a".repeat(40) },
  fork: false,
  draft: false,
  author: { login: "rishitank", association: "OWNER", bot: false },
  ...over,
});
// As the runtime does: an alarm is cleared before its handler runs.
async function fire(obj) {
  obj.ctx.storage.alarm = null;
  await obj.alarm();
}
// Moves the clock to t and fires the alarm, which must be armed and due by
// then: a test using this fails if nothing would have woken the object.
async function advance(obj, setNow, t) {
  const at = obj.ctx.storage.alarm;
  assert.ok(at !== null && at !== undefined && at <= t, `an alarm is armed by ${t} (it is ${at})`);
  setNow(t);
  await fire(obj);
}
async function drain(obj) {
  for (let i = 0; i < 50 && ((await obj.ctx.storage.get("outbox")) ?? []).length; i++) await fire(obj);
}
const command = (text, login = "rishitank") => ({ kind: "command", repo, pr: 39, sender: { login, bot: false }, text });

test("commands are parsed from the text after the mention", () => {
  // CodeRabbit's rules: the handle starts a line, outside code; nothing else
  // on the command's line; whole-comment commands are all there is.
  const cases = [
    ["@tankster-ai-review full review", "full review"],
    ["@Tankster-AI-Review  Full   Review", "full review"],
    ["  @tankster-ai-review review", "review"],
    ["Please look.\n@tankster-ai-review review\nthanks", "review"],
    ["@tankster-ai-review pause", "pause"],
    ["@tankster-ai-review ignore", "pause"],
    ["@tankster-ai-review resolve", "resolve"],
    ["~~~js\n@tankster-ai-review review\n~~~\n@tankster-ai-review full review", "full review"],
    ["hey @tankster-ai-review review", null],
    ["@tankster-ai-review review please", null],
    ["@tankster-ai-review review.", null],
    ["@tankster-ai-review pause\nthanks", null],
    ["Thanks!\n@tankster-ai-review resume", null],
    ["```\n@tankster-ai-review review\n```", null],
    ["`@tankster-ai-review review`", null],
    ["`x` @tankster-ai-review review", null],
    ["    @tankster-ai-review review", null],
    ["\t@tankster-ai-review review", null],
    ["<!-- @tankster-ai-review review -->", null],
    ["<!--\n@tankster-ai-review review\n-->\n@tankster-ai-review full review", "full review"],
    ["```\nx\n````\n@tankster-ai-review review", "review"],
    ["```js```\n@tankster-ai-review review", "review"],
    ["````\n```\n@tankster-ai-review review\n````", null],
    ["@tankster-ai-review resolve\n```\nwhy\n```", null],
    ["@tankster-ai-review resolve\r\n", "resolve"],
    ["@tankster-ai-review resolve\n<!-- hidden -->", null],
    ["@tankster-ai-review constructor", null],
    ["```\n```<!-- literal -->\n@tankster-ai-review review\n```", null],
    ["```\n<!--\n```\n@tankster-ai-review review", "review"],
    ["<!-- a\nb --> @tankster-ai-review review", null],
    ["<!-- a\nb -->\n@tankster-ai-review full review", "full review"],
    ["<!--\n```\n-->\n@tankster-ai-review review", "review"],
    // Stricter than Markdown where they differ: a comment reopened on the line
    // that closed one hides what follows.
    ["<!--\n--> <!--\n@tankster-ai-review review\n-->", null],
    // A line that starts with a comment is HTML, never a fence (as Markdown).
    ["<!-- x -->```\n@tankster-ai-review review", "review"],
    ["@tankster-ai-review __proto__", null],
    ["@tankster-ai-review hasOwnProperty", null],
    ["    ```\n@tankster-ai-review review", "review"],
    ["@tankster-ai-review reviewing", null],
    ["@tankster-ai-reviewer review", null],
    ["@tankster-ai-review delete everything", null],
  ];
  for (const [text, want] of cases) assert.equal(parseCommand(text), want, JSON.stringify(text));
  assert.throws(() => parseCommand("@x review", "bad slug!"));
  // No backtracking blow-up on a long line of backticks or tildes.
  for (const ch of ["`", "~"]) {
    const t0 = Date.now();
    assert.equal(parseCommand(ch.repeat(8000)), null);
    assert.equal(parseCommand(`${ch.repeat(3)}\n${ch.repeat(7990)}x`), null);
    assert.ok(Date.now() - t0 < 1000, `${ch}: ${Date.now() - t0} ms`);
  }
});

test("job ids carry the PR object's id, never the repository or PR", () => {
  const oid = "0123456789abcdef".repeat(4);
  const id = jobIdFor(oid);
  assert.match(id, /^[0-9a-f]{64}\.[0-9a-f]{32}$/);
  assert.equal(objectOfJob(id), oid);
  assert.notEqual(jobIdFor(oid), id, "each job gets its own random part");
  for (const bad of [undefined, "", "abc", `${id}x`, id.replace(/\.[0-9a-f]+$/, ".zz"), "a.b.c", `${oid.toUpperCase()}.${"a".repeat(32)}`, `VGFua3N0ZXJBSS9icm93c2VyLXJlbGF5IzM5.${"a".repeat(32)}`]) {
    assert.equal(objectOfJob(bad), null, String(bad));
  }
  // An object without a proper id cannot mint jobs nobody could route.
  for (const bad of [undefined, "", "TanksterAI/browser-relay#39", "zz".repeat(32)]) assert.throws(() => jobIdFor(bad), /object.s id/);
});

test("a PR's jobs are minted from its own object id", async () => {
  const storage = memoryStorage();
  const oid = "fedcba9876543210".repeat(4);
  const obj = new PrState(doCtx(storage, oid), RUNNER, { now: () => NOW, effects: fakeEffects({ writers: ["rishitank"] }) });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  assert.equal(out.action, "job");
  assert.equal(objectOfJob(out.jobId), oid);
  const b64 = btoa("TanksterAI/browser-relay").replace(/=+$/, "");
  assert.ok(!out.jobId.includes(b64.slice(0, 12)), "no trace of the repository");
});

test("a review event mints a job and queues its dispatch; the alarm sends it", async () => {
  const { obj, storage, fx } = make();
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  assert.equal(out.action, "job");
  const job = await storage.get(`job:${out.jobId}`);
  assert.deepEqual(job.repo, { full: repo.full, name: repo.name });
  assert.equal(job.since, null);
  assert.equal(storage.alarm, NOW);
  await drain(obj);
  assert.deepEqual(fx.calls, [["dispatch", out.jobId]]);
  assert.deepEqual(await storage.get("outbox"), []);
});

test("a repeated delivery is dropped", async () => {
  const { obj } = make();
  await obj.onEvent({ delivery: "same", ev: review() });
  assert.equal((await obj.onEvent({ delivery: "same", ev: review() })).action, "duplicate");
});

test("old delivery ids are pruned to the last 200", async () => {
  let t = NOW;
  const { obj, storage } = make({ now: () => t++ });
  for (let i = 0; i < 205; i++) await obj.remember(`d${i}`);
  const kept = await storage.list({ prefix: "delivery:" });
  assert.equal(kept.size, 200);
  assert.ok(!kept.has("delivery:d0") && kept.has("delivery:d204"));
});

test("drafts wait; forks need a writer to ask; outsiders are checked first", async () => {
  const { obj, fx } = make({ writers: ["rishitank", "privatemember"] });
  assert.equal((await obj.onEvent({ delivery: "1", ev: review({ draft: true }) })).action, "draft");
  assert.equal((await obj.onEvent({ delivery: "2", ev: review({ fork: true }) })).action, "needs_approval");
  // A bot can only push a branch to this repository with write access, so it is reviewed.
  assert.equal((await obj.onEvent({ delivery: "3", ev: review({ author: { login: "renovate[bot]", association: "NONE", bot: true } }) })).action, "job");
  // An org member whose association under-reports is reviewed after the API says so.
  assert.equal((await obj.onEvent({ delivery: "4", ev: review({ author: { login: "privatemember", association: "CONTRIBUTOR", bot: false } }) })).action, "author_check");
  // A real outsider gets the note, once, on opening.
  assert.equal((await obj.onEvent({ delivery: "5", ev: review({ author: { login: "someone", association: "CONTRIBUTOR", bot: false } }) })).action, "author_check");
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 2, "the bot's and the private member's PRs");
  const all = fx.calls.filter((c) => c[0] === "comment").map((c) => c[3]);
  assert.match(all[0] ?? "", /Review skipped: this pull request is a draft/, "the draft's note (the event's default action is opened)");
  const notes = all.slice(1);
  assert.equal(notes.length, 2, "one for the fork, one for the outsider; none for the bot");
  assert.ok(notes.every((n) => /write access can comment/.test(n)));
});

// The merge gate requires the "Tankster AI Review" status on every pull
// request, so one that waits for a writer must say so, not stay blank.
test("a pull request that waits for a writer gets a pending status saying so", async () => {
  const { obj, fx } = make({ writers: ["rishitank"] });
  const fork = { fork: true, head: { sha: "b".repeat(40) }, author: { login: "outsider", association: "NONE", bot: false } };
  await obj.onEvent({ delivery: "1", ev: review(fork) });
  // A push to the fork's branch moves the head: the new commit waits too.
  await obj.onEvent({ delivery: "2", ev: review({ ...fork, action: "synchronize", head: { sha: "c".repeat(40) } }) });
  // A bot pushing from a fork has shown no write access: it waits like anyone.
  await obj.onEvent({ delivery: "3", ev: review({ ...fork, head: { sha: "d".repeat(40) }, author: { login: "evil[bot]", association: "NONE", bot: true } }) });
  // An outsider whose branch is in this repository (no write access by the API).
  await obj.onEvent({ delivery: "4", ev: review({ head: { sha: "e".repeat(40) }, author: { login: "someone", association: "CONTRIBUTOR", bot: false } }) });
  await drain(obj);
  const statuses = fx.calls.filter((c) => c[0] === "setStatus");
  assert.deepEqual(statuses.map((c) => [c[1], c[2], c[3]]), [
    [repo.full, "b".repeat(40), "pending"],
    [repo.full, "c".repeat(40), "pending"],
    [repo.full, "d".repeat(40), "pending"],
    [repo.full, "e".repeat(40), "pending"],
  ]);
  for (const c of statuses) {
    assert.match(c[4], /write access/);
    assert.match(c[4], /@tankster-ai-review review/);
    assert.ok(c[4].length <= 140, "GitHub keeps 140 characters of a status description");
  }
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0, "nothing is reviewed unasked");
});

test("a writer's own pull request is never marked as waiting for a writer", async () => {
  const { obj, fx } = make({ writers: ["rishitank", "privatemember"] });
  await obj.onEvent({ delivery: "1", ev: review() });
  await obj.onEvent({ delivery: "2", ev: review({ pr: 40, author: { login: "privatemember", association: "CONTRIBUTOR", bot: false } }) });
  await obj.onEvent({ delivery: "3", ev: review({ author: { login: "renovate[bot]", association: "NONE", bot: true } }) });
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "setStatus").length, 0);
});

test("a bot's push is reviewed after the quiet period, as a writer's is", async () => {
  const { obj } = make();
  const bot = { author: { login: "renovate[bot]", association: "NONE", bot: true } };
  assert.equal((await obj.onEvent({ delivery: "1", ev: review({ ...bot, action: "synchronize" }) })).action, "debounced");
});

test("pause and resume need write access, checked through the API", async () => {
  const { obj, fx, storage } = make({ writers: ["rishitank"] });
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review pause", "stranger") });
  await drain(obj);
  assert.equal((await storage.get("state"))?.paused ?? false, false);
  assert.match(fx.calls.at(-1)[3], /only people with write access/);

  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review pause") });
  await drain(obj);
  assert.equal((await storage.get("state")).paused, true);
  assert.equal((await obj.onEvent({ delivery: "3", ev: review({ action: "synchronize" }) })).action, "paused");

  await obj.onEvent({ delivery: "4", ev: command("@tankster-ai-review resume") });
  await drain(obj);
  assert.equal((await storage.get("state")).paused, false);
  assert.equal((await obj.onEvent({ delivery: "5", ev: review({ action: "synchronize" }) })).action, "debounced");
});

test("review and full review: incremental from the last reviewed commit, or from scratch", async () => {
  const { obj, fx, storage } = make();
  const first = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  const claim = await obj.claim({ jobId: first.jobId, runId: "100" });
  await obj.complete({ jobId: first.jobId, runId: "100", reviewedSha: "c".repeat(40) });
  assert.equal(claim.job.since, null);

  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review review") });
  await obj.onEvent({ delivery: "3", ev: command("@tankster-ai-review full review") });
  await drain(obj);
  const dispatched = fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);
  assert.equal(dispatched.length, 3);
  const incremental = await storage.get(`job:${dispatched[1]}`);
  const full = await storage.get(`job:${dispatched[2]}`);
  assert.equal(incremental.since, "c".repeat(40));
  assert.equal(incremental.requestedBy, "rishitank");
  assert.equal(full.since, null);
});

test("a writer's review request starts an outsider's review", async () => {
  const { obj, fx } = make();
  await obj.onEvent({ delivery: "1", ev: review({ fork: true }) });
  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review review") });
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1);
});

test("help answers anyone, once an hour; text that is not a command gets no reply", async () => {
  const { obj, fx } = make({ writers: [] });
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review help", "anyone") });
  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review help", "anyone") });
  assert.equal((await obj.onEvent({ delivery: "3", ev: command("thanks @tankster-ai-review!", "anyone") })).action, "not_a_command");
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "canWrite").length, 0);
  const bodies = fx.calls.filter((c) => c[0] === "comment").map((c) => c[3]);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Tankster AI Review commands/);
});

test("refusals to non-writers are rate-limited", async () => {
  const { obj, fx } = make({ writers: [] });
  for (let i = 0; i < 5; i++) await obj.onEvent({ delivery: `d${i}`, ev: command("@tankster-ai-review pause", "spammer") });
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "comment").length, 1);
});

test("a failed side effect is retried, not lost, and the rest of the outbox waits", async () => {
  const { obj, fx, storage } = make();
  let fail = 2;
  const realDispatch = fx.dispatch;
  fx.dispatch = async (id) => { if (fail-- > 0) throw new Error("GitHub 502"); return realDispatch(id); };
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  const b = await obj.onEvent({ delivery: "2", ev: review({ action: "ready_for_review" }) });
  await assert.rejects(obj.alarm(), /502/);
  await assert.rejects(obj.alarm(), /502/);
  assert.equal((await storage.get("outbox")).length, 2, "nothing dropped");
  await drain(obj);
  assert.deepEqual(fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]), [a.jobId, b.jobId]);
});

test("an item that keeps failing is dropped after five attempts", async () => {
  const { obj, fx, storage } = make();
  fx.dispatch = async () => { throw new Error("down"); };
  await obj.onEvent({ delivery: "1", ev: review() });
  for (let i = 0; i < 5; i++) await assert.rejects(obj.alarm());
  await obj.alarm();
  assert.deepEqual(await storage.get("outbox"), []);
});

test("a retried review command dispatches the same job, not a new one", async () => {
  const { obj, fx, storage } = make();
  let fail = 1;
  const realDispatch = fx.dispatch;
  fx.dispatch = async (id) => { if (fail-- > 0) throw new Error("502"); return realDispatch(id); };
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  await assert.rejects(obj.alarm());
  await drain(obj);
  const jobs = await storage.list({ prefix: "job:" });
  assert.equal(jobs.size, 1);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch")[0][1], [...jobs.values()][0].id);
});

test("closing a PR with many stale jobs deletes them in chunks", async () => {
  const { obj, storage } = make();
  const deletes = [];
  const del = storage.delete.bind(storage);
  storage.delete = async (k) => { if (Array.isArray(k)) { assert.ok(k.length <= 128); if (k.every((x) => x.startsWith("job:"))) deletes.push(k.length); } return del(k); };
  for (let i = 0; i < 300; i++) await storage.put(`job:x${i}`, { id: `x${i}`, createdAt: NOW });
  await obj.onEvent({ delivery: "1", ev: { ...review(), kind: "closed" } });
  assert.equal((await storage.list({ prefix: "job:" })).size, 0);
  assert.deepEqual(deletes, [128, 128, 44]);
});

test("expired jobs are pruned when a new one is made", async () => {
  let t = NOW;
  const { obj, storage } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review() });
  t = NOW + 3 * 3600_000;
  await obj.onEvent({ delivery: "2", ev: review({ action: "reopened" }) });
  assert.equal((await storage.list({ prefix: "job:" })).size, 1);
});

test("a job is claimed by one run, expires, and only that run completes it", async () => {
  let t = NOW;
  const { obj } = make({ now: () => t });
  const { jobId } = await obj.onEvent({ delivery: "1", ev: review() });
  assert.ok((await obj.claim({ jobId, runId: 1 })).job);
  assert.ok((await obj.claim({ jobId, runId: "1" })).job, "the same run may ask again");
  assert.equal((await obj.claim({ jobId, runId: 2 })).error, "job already claimed");
  assert.equal((await obj.complete({ jobId, runId: 2, reviewedSha: "d".repeat(40) })).error, "not your job");
  assert.equal((await obj.claim({ jobId: "nope", runId: 1 })).error, "unknown or finished job");

  const second = await obj.onEvent({ delivery: "2", ev: review({ action: "reopened" }) });
  t = NOW + 2 * 3600_000 + 1;
  assert.equal((await obj.claim({ jobId: second.jobId, runId: 3 })).error, "job expired");
});

test("closing the PR drops its jobs", async () => {
  const { obj, storage } = make();
  const { jobId } = await obj.onEvent({ delivery: "1", ev: review() });
  await obj.onEvent({ delivery: "2", ev: { ...review(), kind: "closed" } });
  assert.equal(await storage.get(`job:${jobId}`), undefined);
  assert.equal((await obj.claim({ jobId, runId: 1 })).error, "unknown or finished job");
});

// --- pushes: incremental reviews once the pushes stop -----------------------

const MIN = 60_000;
const dispatched = (fx) => fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);

test("a push is reviewed incrementally after a 3-minute quiet period, not at once", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  const first = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  await obj.claim({ jobId: first.jobId, runId: "1" });
  await obj.complete({ jobId: first.jobId, runId: "1", reviewedSha: "c".repeat(40) });

  const out = await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  assert.equal(out.action, "debounced");
  assert.equal(out.due, NOW + 3 * MIN);
  assert.equal(storage.alarm, NOW + 3 * MIN);
  t = NOW + 3 * MIN - 1;
  await fire(obj);
  assert.equal(dispatched(fx).length, 1, "nothing before the quiet period is over");
  assert.equal(storage.alarm, NOW + 3 * MIN, "the alarm is set again for the due time");
  await advance(obj, (x) => { t = x; }, NOW + 3 * MIN);
  await drain(obj);
  const ids = dispatched(fx);
  assert.equal(ids.length, 2);
  const job = await storage.get(`job:${ids[1]}`);
  assert.equal(job.since, "c".repeat(40), "from the last reviewed commit");
  assert.equal(await storage.get("debounce"), undefined);
});

test("each push restarts the quiet period, but a burst waits at most 15 minutes", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  for (let i = 0; i < 8; i++) {
    t = NOW + i * 2 * MIN; // a push every 2 minutes, for 14 minutes
    await obj.onEvent({ delivery: `p${i}`, ev: review({ action: "synchronize" }) });
  }
  assert.equal((await storage.get("debounce")).due, NOW + 15 * MIN, "capped at 15 minutes after the first push");
  await advance(obj, (x) => { t = x; }, NOW + 15 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1, "one review for the whole burst");
});

test("a later push moves the due time on; an earlier alarm does not review early", async () => {
  let t = NOW;
  const { obj, fx } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
  t = NOW + 2 * MIN;
  const second = await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  assert.equal(second.due, NOW + 5 * MIN);
  t = NOW + 3 * MIN; // the first push's alarm
  await fire(obj);
  assert.equal(dispatched(fx).length, 0);
  await advance(obj, (x) => { t = x; }, NOW + 5 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
});

test("marked ready, reopened or asked for: reviewed now, and a waiting push is covered by it", async () => {
  for (const trigger of ["ready", "reopened", "review", "full review"]) {
    let t = NOW;
    const { obj, fx, storage } = make({ now: () => t });
    await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
    if (trigger === "ready") await obj.onEvent({ delivery: "2", ev: review({ action: "ready_for_review" }) });
    else if (trigger === "reopened") await obj.onEvent({ delivery: "2", ev: review({ action: "reopened" }) });
    else await obj.onEvent({ delivery: "2", ev: command(`@tankster-ai-review ${trigger}`) });
    await drain(obj);
    assert.equal(dispatched(fx).length, 1, `${trigger}: reviewed now`);
    assert.equal(await storage.get("debounce"), undefined, `${trigger}: the waiting push is dropped`);
    t = NOW + 20 * MIN;
    await fire(obj);
    await drain(obj);
    assert.equal(dispatched(fx).length, 1, `${trigger}: no second review for the same push`);
  }
});

test("a draft's pushes wait; marking it ready reviews it at once", async () => {
  const { obj, fx, storage } = make();
  assert.equal((await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize", draft: true }) })).action, "draft");
  assert.equal(await storage.get("debounce"), undefined);
  assert.equal((await obj.onEvent({ delivery: "2", ev: review({ action: "ready_for_review" }) })).action, "job");
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
});

test("a waiting push is not reviewed once the PR is paused or closed", async () => {
  for (const how of ["pause", "close"]) {
    let t = NOW;
    const { obj, fx, storage } = make({ now: () => t });
    await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
    if (how === "pause") {
      await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review pause") });
      await drain(obj);
    } else {
      await obj.onEvent({ delivery: "2", ev: { ...review(), kind: "closed" } });
      assert.equal(await storage.get("debounce"), undefined, "closing drops it");
    }
    t = NOW + 20 * MIN;
    await fire(obj);
    await drain(obj);
    assert.equal(dispatched(fx).length, 0, how);
    assert.equal(await storage.get("debounce"), undefined, `${how}: nothing left waiting`);
  }
});

test("an outsider-association writer's push waits too; their opened PR is reviewed at once", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t, writers: ["privatemember"] });
  const author = { login: "privatemember", association: "CONTRIBUTOR", bot: false };
  await obj.onEvent({ delivery: "1", ev: review({ author, action: "synchronize" }) });
  await drain(obj);
  assert.equal(dispatched(fx).length, 0, "checked, then waiting");
  assert.equal((await storage.get("debounce")).due, NOW + 3 * MIN);
  t = NOW + 3 * MIN;
  await fire(obj);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);

  await obj.onEvent({ delivery: "2", ev: review({ author, action: "reopened" }) });
  await drain(obj);
  assert.equal(dispatched(fx).length, 2, "reopened: at once");
});

test("an incremental job starts from the last review finished when it is claimed", async () => {
  let t = NOW;
  const { obj, storage } = make({ now: () => t });
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  await obj.claim({ jobId: a.jobId, runId: "1" });
  // A push waits, its job is made, and only then does the first review finish.
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  t = NOW + 3 * MIN;
  await fire(obj);
  const [bId] = [...(await storage.list({ prefix: "job:" })).values()].filter((j) => j.id !== a.jobId).map((j) => j.id);
  assert.equal((await storage.get(`job:${bId}`)).since, null);
  await obj.complete({ jobId: a.jobId, runId: "1", reviewedSha: "c".repeat(40) });
  assert.equal((await obj.claim({ jobId: bId, runId: "2" })).job.since, "c".repeat(40));
  // Fixed at the first claim: a later review does not move it under the run.
  const st = await storage.get("state");
  await storage.put("state", { ...st, lastReviewed: "e".repeat(40) });
  assert.equal((await obj.claim({ jobId: bId, runId: "2" })).job.since, "c".repeat(40));

  // A full review stays full.
  await obj.onEvent({ delivery: "3", ev: command("@tankster-ai-review full review") });
  await drain(obj);
  const full = [...(await storage.list({ prefix: "job:" })).values()].find((j) => j.requestedBy);
  assert.equal((await obj.claim({ jobId: full.id, runId: "3" })).job.since, null);
});

test("the quiet period can be set, and the cap is never below it", async () => {
  const storage = memoryStorage();
  const obj = new PrState(doCtx(storage), { ...RUNNER, REVIEW_DEBOUNCE_S: "60", REVIEW_DEBOUNCE_MAX_S: "30" }, { now: () => NOW, effects: fakeEffects() });
  assert.equal(obj.debounceMs, 60_000);
  assert.equal(obj.debounceMaxMs, 60_000);
  const bad = new PrState(doCtx(), { REVIEW_DEBOUNCE_S: "soon", REVIEW_DEBOUNCE_MAX_S: "-1" }, { now: () => NOW });
  assert.equal(bad.debounceMs, 180_000);
  assert.equal(bad.debounceMaxMs, 900_000);
});

test("a dispatch waiting in the outbox keeps the alarm at now; the push's due time follows", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review help", "anyone") });
  assert.equal(storage.alarm, NOW, "the outbox needs the alarm now");
  await fire(obj);
  assert.equal(storage.alarm, NOW + 3 * MIN, "then the push's due time");
  assert.equal(dispatched(fx).length, 0);

  // The other way round: a push never moves a sooner alarm later.
  const other = make({ now: () => t });
  await other.obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review help", "anyone") });
  await other.obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  assert.equal(other.storage.alarm, NOW);
});

test("converting to a draft drops a waiting push; a draft's alarm reviews nothing", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
  assert.equal((await obj.onEvent({ delivery: "2", ev: review({ action: "converted_to_draft", draft: true }) })).action, "draft");
  assert.equal(await storage.get("debounce"), undefined);
  // Even a waiting push left from before (say, stored before this change) is not reviewed while a draft.
  await storage.put("debounce", { first: NOW, due: NOW + 3 * MIN });
  await storage.setAlarm(NOW + 3 * MIN);
  await advance(obj, (x) => { t = x; }, NOW + 3 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 0);
  assert.equal((await obj.onEvent({ delivery: "3", ev: review({ action: "ready_for_review" }) })).action, "job");
});

test("a review asked for just as a push falls due gives one review, not two", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
  t = NOW + 3 * MIN;
  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review review") });
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
  assert.equal(await storage.get("debounce"), undefined);
});

test("a push while a job waits for a runner makes no second job: the waiting one reviews the latest commit", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  await advance(obj, (x) => { t = x; }, NOW + 3 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
  assert.equal((await storage.list({ prefix: "job:" })).size, 1);
  // The push is not dropped yet: it waits until a review that started after it finishes.
  assert.equal((await storage.get("debounce")).due, NOW + 6 * MIN);
  t = NOW + 4 * MIN;
  await obj.claim({ jobId: a.jobId, runId: "1" });
  await advance(obj, (x) => { t = x; }, NOW + 6 * MIN);
  await drain(obj);
  assert.ok(await storage.get("debounce"), "claimed is not enough: the run must finish");
  t = NOW + 7 * MIN;
  await obj.complete({ jobId: a.jobId, runId: "1", reviewedSha: "c".repeat(40) });
  await advance(obj, (x) => { t = x; }, NOW + 9 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1, "the finished review that started after the push covers it");
  assert.equal(await storage.get("debounce"), undefined);
});

test("a run that claimed after the push but never finished: the push is reviewed once its window ends", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  t = NOW + MIN;
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  t = NOW + 2 * MIN;
  await obj.claim({ jobId: a.jobId, runId: "1" }); // the run then dies: no complete
  for (let i = 0; i < 10 && dispatched(fx).length < 2; i++) {
    await advance(obj, (x) => { t = x; }, obj.ctx.storage.alarm);
    await drain(obj);
  }
  assert.equal(dispatched(fx).length, 2, "the push gets its own review");
  assert.equal(t, NOW + 17 * MIN, "15 minutes after the lost run claimed");
  assert.equal(await storage.get("debounce"), undefined);
});

test("a zero quiet period never spins the alarm while a job is on its way", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), { ...RUNNER, REVIEW_DEBOUNCE_S: "0" }, { now: () => t, effects: fx });
  await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  for (let i = 0; i < 5; i++) {
    await fire(obj);
    assert.ok(storage.alarm > t, `the alarm moves on (${storage.alarm - t} ms)`);
    t = storage.alarm;
  }
  assert.ok(t >= NOW + 2 * 30_000, "re-checked at least 30 s apart");
});

test("a lost runner: a push made just after the dispatch is reviewed once that job's window ends", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  t = NOW + 2 * MIN;
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  // Follow the alarm wherever it is armed, as the runtime would.
  for (let i = 0; i < 10 && dispatched(fx).length < 2; i++) {
    await advance(obj, (x) => { t = x; }, obj.ctx.storage.alarm);
    await drain(obj);
  }
  assert.equal(dispatched(fx).length, 2, "the push gets its own job");
  assert.equal(t, NOW + 15 * MIN, "when the first job's 15 minutes are up");
  assert.equal(await storage.get("debounce"), undefined);
});

test("a retrying dispatch that is finally dropped does not take a waiting push with it", async () => {
  let t = NOW;
  const { obj, fx } = make({ now: () => t });
  const real = fx.dispatch;
  fx.dispatch = async () => { throw new Error("GitHub down"); };
  await obj.onEvent({ delivery: "1", ev: review() });
  await assert.rejects(fire(obj));
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  t = NOW + 3 * MIN;
  for (let i = 0; i < 4; i++) await assert.rejects(fire(obj));
  await fire(obj); // the sixth time: dropped, with its job
  fx.dispatch = real;
  for (let i = 0; i < 10 && dispatched(fx).length < 1; i++) {
    await advance(obj, (x) => { t = x; }, obj.ctx.storage.alarm);
    await drain(obj);
  }
  assert.equal(dispatched(fx).length, 1, "the push is still reviewed");
});

test("pause then resume before the push falls due: the push is still reviewed", async () => {
  let t = NOW;
  const { obj, fx } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review pause") });
  await obj.onEvent({ delivery: "3", ev: command("@tankster-ai-review resume") });
  await drain(obj);
  await advance(obj, (x) => { t = x; }, NOW + 3 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
});

test("a failing dispatch from a push is retried, and nothing waiting is lost", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  let fail = 1;
  const real = fx.dispatch;
  fx.dispatch = async (id) => { if (fail-- > 0) throw new Error("GitHub 502"); return real(id); };
  await obj.onEvent({ delivery: "1", ev: review({ action: "synchronize" }) });
  t = NOW + 3 * MIN;
  obj.ctx.storage.alarm = null;
  await assert.rejects(obj.alarm(), /502/);
  assert.equal((await storage.get("outbox")).length, 1, "the push's dispatch is kept for the retry");
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
});

test("overlapping reviews: the one claimed later stays the last review, whichever finishes first", async () => {
  let t = NOW;
  const { obj, storage } = make({ now: () => t });
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  await obj.claim({ jobId: a.jobId, runId: "1" });
  t = NOW + MIN;
  const b = await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review full review") });
  await drain(obj);
  const bId = [...(await storage.list({ prefix: "job:" })).values()].find((j) => j.requestedBy).id;
  await obj.claim({ jobId: bId, runId: "2" });
  await obj.complete({ jobId: bId, runId: "2", reviewedSha: "b".repeat(40) });
  await obj.complete({ jobId: a.jobId, runId: "1", reviewedSha: "a".repeat(40) });
  assert.equal((await storage.get("state")).lastReviewed, "b".repeat(40));
  assert.ok(b);
});

test("closing drops waiting dispatches; an outsider's opening check does nothing once closed", async () => {
  const { obj, fx, storage } = make({ writers: ["privatemember"] });
  await obj.onEvent({ delivery: "1", ev: review() });
  await obj.onEvent({ delivery: "2", ev: { ...review(), kind: "closed" } });
  assert.deepEqual((await storage.get("outbox")).filter((x) => x.type === "dispatch"), []);
  await drain(obj);
  assert.equal(dispatched(fx).length, 0);

  const other = make({ writers: ["privatemember"] });
  const author = { login: "privatemember", association: "CONTRIBUTOR", bot: false };
  await other.obj.onEvent({ delivery: "1", ev: review({ author }) });
  await other.obj.onEvent({ delivery: "2", ev: { ...review({ author }), kind: "closed" } });
  await drain(other.obj);
  assert.equal(dispatched(other.fx).length, 0);
});

test("a blank or partly numeric quiet period falls back to the default", () => {
  for (const v of [" ", "", "3m", "-5", "1e3", "NaN"]) {
    const o = new PrState(doCtx(), { REVIEW_DEBOUNCE_S: v }, { now: () => NOW });
    assert.equal(o.debounceMs, 180_000, JSON.stringify(v));
  }
  assert.equal(new PrState(doCtx(), { REVIEW_DEBOUNCE_S: " 90 " }, { now: () => NOW }).debounceMs, 90_000);
});

test("a dispatch dropped after five failures takes its job with it; the next push is still reviewed", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  const real = fx.dispatch;
  fx.dispatch = async () => { throw new Error("GitHub down"); };
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  for (let i = 0; i < 5; i++) await assert.rejects(fire(obj));
  await fire(obj);
  assert.deepEqual(await storage.get("outbox"), []);
  assert.equal(await storage.get(`job:${a.jobId}`), undefined, "the dropped dispatch's job is gone");
  fx.dispatch = real;
  t = NOW + 10 * MIN;
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  await advance(obj, (x) => { t = x; }, NOW + 13 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1, "the push is reviewed");
});

test("a job whose runner never came stops covering pushes 15 minutes after its dispatch", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  assert.equal((await [...(await storage.list({ prefix: "job:" })).values()][0]).dispatchedAt, NOW);
  // Within 15 minutes of its dispatch, the waiting job covers a push.
  t = NOW + 5 * MIN;
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  await advance(obj, (x) => { t = x; }, NOW + 8 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
  // After that, a push gets its own job: the first runner is presumed lost.
  t = NOW + 20 * MIN;
  await obj.onEvent({ delivery: "3", ev: review({ action: "synchronize" }) });
  await advance(obj, (x) => { t = x; }, NOW + 23 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 2);
});

test("closing makes a review command's queued dispatch do nothing", async () => {
  const { obj, fx, storage } = make();
  let fail = 1;
  const real = fx.dispatch;
  fx.dispatch = async (id) => { if (fail-- > 0) throw new Error("502"); return real(id); };
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  await assert.rejects(fire(obj));
  assert.ok((await storage.get("outbox"))[0].jobId, "the command minted its job");
  await obj.onEvent({ delivery: "2", ev: { ...review(), kind: "closed" } });
  await drain(obj);
  assert.equal(dispatched(fx).length, 0);
});

test("a job whose dispatch is still being retried covers a push that falls due meanwhile", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  let fail = 1;
  const real = fx.dispatch;
  fx.dispatch = async (id) => { if (fail-- > 0) throw new Error("502"); return real(id); };
  await obj.onEvent({ delivery: "1", ev: review() });
  await assert.rejects(fire(obj));
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  t = NOW + 3 * MIN;
  await drain(obj);
  assert.equal(dispatched(fx).length, 1);
  assert.equal((await storage.list({ prefix: "job:" })).size, 1, "no second job");
});

test("a claim between two pushes covers only the first: the later push is still reviewed", async () => {
  let t = NOW;
  const { obj, fx } = make({ now: () => t });
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  t = NOW + MIN;
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  t = NOW + 2 * MIN;
  await obj.claim({ jobId: a.jobId, runId: "1" });
  t = NOW + 3 * MIN;
  await obj.onEvent({ delivery: "3", ev: review({ action: "synchronize" }) });
  await advance(obj, (x) => { t = x; }, NOW + 6 * MIN);
  await drain(obj);
  assert.equal(dispatched(fx).length, 2, "the push after the claim gets its own review");
});

test("a push after a long wait on a job starts a fresh burst with its own quiet period", async () => {
  let t = NOW;
  const { obj, fx, storage } = make({ now: () => t });
  const a = await obj.onEvent({ delivery: "1", ev: review() });
  await drain(obj);
  t = NOW + MIN;
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
  t = NOW + 14 * MIN;
  await obj.claim({ jobId: a.jobId, runId: "1" }); // still running
  t = NOW + 20 * MIN;
  const out = await obj.onEvent({ delivery: "3", ev: review({ action: "synchronize" }) });
  assert.equal(out.due, NOW + 23 * MIN, "3 minutes after this push, not at once");
  assert.equal((await storage.get("debounce")).first, NOW + 20 * MIN);
  t = NOW + 20 * MIN + 30_000;
  await obj.onEvent({ delivery: "4", ev: review({ action: "synchronize" }) });
  for (let i = 0; i < 10 && dispatched(fx).length < 2; i++) {
    await advance(obj, (x) => { t = x; }, obj.ctx.storage.alarm);
    await drain(obj);
  }
  assert.equal(dispatched(fx).length, 2, "one review for both late pushes");
  assert.ok(t >= NOW + 23 * MIN + 30_000, "after the second push's quiet period");
});

// --- capacity: hold rather than start a runner that can only defer ----------

test("no provider has capacity: the dispatch is held, its job kept fresh, then sent once one resets", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  let cap = { ok: false, retryAt: NOW + 5 * 3600_000 };
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => cap });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await fire(obj);
  assert.deepEqual(fx.calls, []);
  let box = await storage.get("outbox");
  assert.equal(box.length, 1);
  assert.equal(box[0].attempts, 0, "a hold is not a failed attempt");
  // Looked at again within the hour, never left to age out.
  assert.equal(box[0].notBefore, NOW + 3600_000);
  assert.equal(storage.alarm, NOW + 3600_000);
  for (let i = 1; i <= 4; i++) {
    await advance(obj, (v) => { t = v; }, NOW + i * 3600_000);
    assert.equal((await storage.get(`job:${out.jobId}`)).createdAt, t, "kept fresh while held");
  }
  assert.deepEqual(fx.calls, []);
  cap = { ok: true };
  await advance(obj, (v) => { t = v; }, NOW + 5 * 3600_000);
  assert.deepEqual(fx.calls, [["dispatch", out.jobId]]);
  assert.deepEqual(await storage.get("outbox"), []);
  // The runner can still claim it: the job did not expire while held.
  assert.ok((await obj.claim({ jobId: out.jobId, runId: "77" })).job);
  box = await storage.get("outbox");
  assert.deepEqual(box, []);
});

test("no model capacity: the required status is neutral (success, saying why), as CodeRabbit's rate-limited run is, and only once", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const head = "9".repeat(40);
  fx.pullRequest = async () => ({ state: "open", draft: false, head: { sha: head } });
  fx.setStatus = async (...a) => { fx.calls.push(["setStatus", ...a]); return true; };
  const cap = { ok: false, retryAt: NOW + 5 * 3600_000 };
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => cap });
  await obj.onEvent({ delivery: "d1", ev: review() });
  await fire(obj);
  const statuses = () => fx.calls.filter((c) => c[0] === "setStatus");
  assert.equal(statuses().length, 1);
  assert.deepEqual(statuses()[0].slice(2, 4), [head, "success"]);
  assert.match(statuses()[0][4], /^Review delayed: no model has capacity now; it is reviewed when one resets at \d\d:\d\d UTC\.$/);
  assert.ok(statuses()[0][4].length <= 140);
  // Looked at again: no second status for the same job.
  await advance(obj, (v) => { t = v; }, NOW + 3600_000);
  assert.equal(statuses().length, 1);
});

test("a held dispatch does not block other side effects behind it", async () => {
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => NOW, effects: fx, capacity: async () => ({ ok: false, retryAt: NOW + 3600_000 }) });
  await obj.onEvent({ delivery: "d1", ev: review() });
  await fire(obj);
  await obj.onEvent({ delivery: "d2", ev: command("@tankster-ai-review help") });
  await fire(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "comment").length, 1);
  assert.equal((await storage.get("outbox")).length, 1);
});

test("a job queued before job ids became opaque is re-issued, not lost, when it is dispatched", async () => {
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => NOW, effects: fx, capacity: async () => ({ ok: true }) });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  // Make it look like one minted by the old code: base64url("repo#pr").random.
  const old = `VGFua3N0ZXJBSS9icm93c2VyLXJlbGF5IzM5.${"a".repeat(32)}`;
  const job = await storage.get(`job:${out.jobId}`);
  await storage.delete(`job:${out.jobId}`);
  await storage.put(`job:${old}`, { ...job, id: old, requestedBy: "rishitank" });
  await storage.put("outbox", (await storage.get("outbox")).map((x) => (x.jobId === out.jobId ? { ...x, jobId: old } : x)));
  await drain(obj);
  const sent = fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0], old);
  assert.ok(objectOfJob(sent[0]), "the runner gets an id it accepts");
  assert.equal(await storage.get(`job:${old}`), undefined);
  const claimed = await obj.claim({ jobId: sent[0], runId: "1" });
  assert.equal(claimed.job.requestedBy, "rishitank", "the job keeps what it was");
  assert.equal(claimed.job.id, sent[0]);
  assert.ok(!(await storage.get("outbox") ?? []).some((x) => x.jobId === old));
});

test("re-issuing an old job writes the new job and its queue entry together, so a crash loses nothing", async () => {
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  let cap = { ok: false, retryAt: NOW + 3600_000 };
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => NOW, effects: fx, capacity: async () => cap });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  const old = `VGFua3N0ZXJBSS9icm93c2VyLXJlbGF5IzM5.${"c".repeat(32)}`;
  const job = await storage.get(`job:${out.jobId}`);
  await storage.delete(`job:${out.jobId}`);
  await storage.put(`job:${old}`, { ...job, id: old });
  await storage.put("outbox", (await storage.get("outbox")).map((x) => (x.jobId === out.jobId ? { ...x, jobId: old } : x)));
  // The object dies right after the re-issue's first write.
  const put = storage.put;
  const reissue = obj.reissue.bind(obj);
  let inside = false;
  let writes = 0;
  obj.reissue = async (...a) => { inside = true; try { return await reissue(...a); } finally { inside = false; } };
  storage.put = async (...a) => { await put(...a); if (inside && ++writes === 1) throw new Error("evicted"); };
  await obj.alarm().catch(() => {});
  storage.put = put;
  assert.equal(writes, 1, "the crash happened inside the re-issue");
  const queued = (await storage.get("outbox")).map((x) => x.jobId);
  assert.equal(queued.length, 1);
  assert.ok(objectOfJob(queued[0]), "the queue already names the new id");
  assert.ok(await storage.get(`job:${queued[0]}`), "and the new job exists");
});

test("an old job held for capacity keeps its place in the queue under its new id", async () => {
  let t = NOW;
  let cap = { ok: false, retryAt: NOW + 3600_000 };
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => cap });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  const old = `VGFua3N0ZXJBSS9icm93c2VyLXJlbGF5IzM5.${"b".repeat(32)}`;
  const job = await storage.get(`job:${out.jobId}`);
  await storage.delete(`job:${out.jobId}`);
  await storage.put(`job:${old}`, { ...job, id: old });
  await storage.put("outbox", (await storage.get("outbox")).map((x) => (x.jobId === out.jobId ? { ...x, jobId: old } : x)));
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0, "held: no provider is free");
  const queued = (await storage.get("outbox")).map((x) => x.jobId);
  assert.ok(queued.length === 1 && objectOfJob(queued[0]), "the queue names the new id");
  cap = { ok: true };
  await advance(obj, (v) => { t = v; }, NOW + 3600_000);
  const sent = fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);
  assert.deepEqual(sent, queued);
  assert.ok((await obj.claim({ jobId: sent[0], runId: "1" })).job);
});

test("a deferred review is given back: released, queued for the reset, claimable by a new run", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => ({ ok: true }) });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await drain(obj);
  assert.ok((await obj.claim({ jobId: out.jobId, runId: "1" })).job);
  assert.deepEqual(await obj.defer({ jobId: out.jobId, runId: "2", retryAt: NOW + 7200_000 }), { error: "not your job" });
  const d = await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW + 7200_000 });
  // At most an hour away, so the job is looked at (and kept fresh) in time.
  assert.equal(d.retryAt, NOW + 3600_000);
  const job = await storage.get(`job:${out.jobId}`);
  assert.equal(job.claimedBy, null);
  assert.equal(job.claimedAt, undefined);
  assert.equal(storage.alarm, NOW + 3600_000);
  // A second deferral for the same job queues no second dispatch.
  await obj.claim({ jobId: out.jobId, runId: "1" });
  await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW });
  assert.equal((await storage.get("outbox")).length, 1);
  await advance(obj, (v) => { t = v; }, NOW + 3600_000);
  assert.deepEqual(fx.calls.filter((c) => c[0] === "dispatch").length, 2);
  assert.ok((await obj.claim({ jobId: out.jobId, runId: "3" })).job);
});

test("a deferral on a closed pull request just ends its job", async () => {
  const { obj, storage } = make();
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await drain(obj);
  await obj.claim({ jobId: out.jobId, runId: "1" });
  await obj.onEvent({ delivery: "d2", ev: { ...review(), kind: "closed" } });
  // Closing deleted the job already; a late deferral finds nothing to give back.
  assert.deepEqual(await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW }), { error: "not your job" });
  assert.deepEqual(await storage.get("outbox"), []);
});

test("a push while a dispatch is held waits for it, without waking every 30 seconds", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => ({ ok: false, retryAt: NOW + 3600_000 }) });
  await obj.onEvent({ delivery: "d1", ev: review() });
  await fire(obj);
  await obj.onEvent({ delivery: "d2", ev: review({ action: "synchronize" }) });
  await advance(obj, (v) => { t = v; }, NOW + 180_000);
  const d = await storage.get("debounce");
  assert.equal(d.due, NOW + 3600_000);
  assert.equal(storage.alarm, NOW + 3600_000);
  assert.equal((await storage.list({ prefix: "job:" })).size, 1, "no second job");
});

test("a held review request beside a waiting push never spins the alarm (both kinds of covering item)", async () => {
  for (const kind of ["command", "author_check"]) {
    let t = NOW;
    const storage = memoryStorage();
    const fx = fakeEffects({ writers: ["rishitank", "bob"] });
    const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => ({ ok: false, retryAt: NOW + 5 * 3600_000 }) });
    if (kind === "command") {
      await obj.onEvent({ delivery: "d0", ev: review({ action: "synchronize" }) });
      await obj.onEvent({ delivery: "d1", ev: command("@tankster-ai-review review") });
      await fire(obj);
      await obj.onEvent({ delivery: "d2", ev: review({ action: "synchronize" }) });
    } else {
      const bob = { login: "bob", association: "CONTRIBUTOR", bot: false };
      await obj.onEvent({ delivery: "d1", ev: review({ author: bob }) });
      await fire(obj);
      await obj.onEvent({ delivery: "d2", ev: review({ action: "synchronize", author: bob }) });
      await fire(obj);
    }
    t = NOW + 181_000;
    let n = 0;
    while (storage.alarm !== null && storage.alarm <= t && n < 100) { await fire(obj); n++; }
    assert.ok(n <= 2, `${kind}: ${n} alarms at one instant`);
    assert.ok(storage.alarm > t, `${kind}: the next alarm is in the future`);
    assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
  }
});

test("a deferral remembers when and how big: no runner is started before then, and it is sized as the review", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const asked = [];
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async (chars) => { asked.push(chars); return { ok: true }; } });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await drain(obj);
  await obj.claim({ jobId: out.jobId, runId: "1" });
  await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW + 3 * 3600_000, chars: 96_000 });
  // Hourly looks keep the job fresh but start nothing until the time given.
  for (let h = 1; h <= 2; h++) await advance(obj, (v) => { t = v; }, NOW + h * 3600_000);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1);
  await advance(obj, (v) => { t = v; }, NOW + 3 * 3600_000);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 2);
  assert.equal(asked.at(-1), 96_000, "capacity asked for the review's own size");
});

test("busy or failing reviews are retried a few times, then dropped; quota waits never count", async () => {
  const { obj, storage } = make();
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await drain(obj);
  for (let i = 0; i < 5; i++) {
    await obj.claim({ jobId: out.jobId, runId: "1" });
    assert.equal((await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW, why: "quota" })).dropped, undefined);
  }
  await obj.claim({ jobId: out.jobId, runId: "1" });
  assert.equal((await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW, why: "busy" })).dropped, undefined);
  await obj.claim({ jobId: out.jobId, runId: "1" });
  assert.equal((await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW, why: "failed" })).dropped, undefined);
  await obj.claim({ jobId: out.jobId, runId: "1" });
  assert.equal((await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW, why: "failed" })).dropped, true);
  assert.equal(await storage.get(`job:${out.jobId}`), undefined);
});

test("a held automatic review is dropped if the PR is paused or made a draft meanwhile; one asked for still runs", async () => {
  for (const change of ["pause", "draft"]) {
    let t = NOW;
    const storage = memoryStorage();
    const fx = fakeEffects({ writers: ["rishitank"] });
    let cap = { ok: false, retryAt: NOW + 3600_000 };
    const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => cap });
    await obj.onEvent({ delivery: "d1", ev: review() });
    await fire(obj);
    if (change === "pause") { await obj.onEvent({ delivery: "d2", ev: command("@tankster-ai-review pause") }); await fire(obj); }
    else await obj.onEvent({ delivery: "d2", ev: review({ action: "converted_to_draft", draft: true }) });
    cap = { ok: true };
    await advance(obj, (v) => { t = v; }, NOW + 3600_000);
    await drain(obj);
    assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0, change);
    assert.equal((await storage.list({ prefix: "job:" })).size, 0, change);
  }
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  let cap = { ok: false, retryAt: NOW + 3600_000 };
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async () => cap });
  await obj.onEvent({ delivery: "d0", ev: review({ action: "synchronize" }) });
  await obj.onEvent({ delivery: "d1", ev: command("@tankster-ai-review pause") });
  await drain(obj);
  await obj.onEvent({ delivery: "d2", ev: command("@tankster-ai-review review") });
  await fire(obj);
  cap = { ok: true };
  await advance(obj, (v) => { t = v; }, NOW + 3600_000);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1, "asked for: still runs while paused");
});

test("a review given up after its tries says so on the pull request, once an hour at most", async () => {
  const { obj, fx } = make();
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await drain(obj);
  for (let i = 0; i < 3; i++) {
    await obj.claim({ jobId: out.jobId, runId: "1" });
    await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW, why: "failed", reason: "the model did not return a `usable`\nanswer" });
  }
  await drain(obj);
  const notes = fx.calls.filter((c) => c[0] === "comment");
  assert.equal(notes.length, 1);
  assert.match(notes[0][3], /has stopped trying after 3 failed tries \(the model did not return a  usable  answer\)\. Comment `@tankster-ai-review review` to try again\./);
});

test("providers that failed a job are skipped on its later tries and by the capacity check; a job lives three days at most", async () => {
  let t = NOW;
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const asked = [];
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => t, effects: fx, capacity: async (chars, skip) => { asked.push(skip); return { ok: true }; } });
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await drain(obj);
  await obj.claim({ jobId: out.jobId, runId: "1" });
  await obj.defer({ jobId: out.jobId, runId: "1", retryAt: NOW + 120_000, failed: ["gemini:g", 7, "workers-ai:w"] });
  let job = await storage.get(`job:${out.jobId}`);
  assert.deepEqual(job.skip, ["gemini:g", "workers-ai:w"]);
  await advance(obj, (v) => { t = v; }, NOW + 120_000);
  assert.deepEqual(asked.at(-1), ["gemini:g", "workers-ai:w"]);
  // However many quota waits, three days after it was made it is given up, with a note.
  t = NOW + 3 * 24 * 3600_000 + 1;
  // (Hourly holds keep a waiting job fresh; here the clock simply jumps.)
  await storage.put(`job:${out.jobId}`, { ...(await storage.get(`job:${out.jobId}`)), createdAt: t });
  await obj.claim({ jobId: out.jobId, runId: "2" });
  assert.equal((await obj.defer({ jobId: out.jobId, runId: "2", retryAt: t + 3600_000 })).dropped, true);
  await drain(obj);
  const note = fx.calls.filter((c) => c[0] === "comment").at(-1)[3];
  assert.match(note, /waited three days for a model provider \(.*\), so it has stopped trying/);
  job = await storage.get(`job:${out.jobId}`);
  assert.equal(job, undefined);
});

test("capacity check before dispatch: a drafter is not enough, a verifier must be able to run too", async () => {
  const { memoryKv } = await import("./helpers.js");
  const { markExhausted } = await import("../src/budget.js");
  const kv = memoryKv();
  const env = { LEDGER: kv, AI: {}, GEMINI_API_KEY: "k", DRAFT_CHAIN: "workers-ai:@cf/zai-org/glm-4.7-flash", VERIFY_CHAIN: "anthropic:claude-haiku-5-5", VERIFY_FALLBACK: "gemini:gemini-3.5-flash-lite" };
  const obj = new PrState(doCtx(), env, { now: () => NOW, effects: fakeEffects() });
  assert.equal((await obj.capacityNow(10_000)).ok, true);
  await markExhausted(kv, "gemini:gemini-3.5-flash-lite", NOW + 2 * 3600_000, NOW);
  assert.deepEqual(await obj.capacityNow(10_000), { ok: false, retryAt: NOW + 2 * 3600_000 });
  const off = new PrState(doCtx(), { ...env, VERIFY: "off" }, { now: () => NOW, effects: fakeEffects() });
  assert.equal((await off.capacityNow(10_000)).ok, true);
});

test("a runner's complete message cannot claim full coverage", async () => {
  const { obj, storage } = make();
  const out = await obj.onEvent({ delivery: "d1", ev: review() });
  await obj.claim({ jobId: out.jobId, runId: "9" });
  const res = await obj.fetch(new Request("https://pr-state/", { method: "POST", body: JSON.stringify({ op: "complete", jobId: out.jobId, runId: "9", reviewedSha: "e".repeat(40), fullCoverage: true }) }));
  assert.deepEqual(await res.json(), { ok: true });
  const st = await storage.get("state");
  assert.equal(st.lastReviewed, "e".repeat(40));
  assert.equal(st.lastCompleteReviewed, undefined);
});

// github-actions[bot] opens PRs for workflows, some of which an outsider can
// drive (pull_request_target, issue_comment): its PRs prove no write access.
test("github-actions[bot]'s pull requests wait for a writer, like an outsider's", async () => {
  const { obj, fx } = make({ writers: ["rishitank"] });
  const gha = { head: { sha: "f".repeat(40) }, author: { login: "github-actions[bot]", association: "NONE", bot: true } };
  assert.equal((await obj.onEvent({ delivery: "1", ev: review(gha) })).action, "author_check");
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
  assert.deepEqual(fx.calls.filter((c) => c[0] === "setStatus").map((c) => [c[2], c[3]]), [["f".repeat(40), "pending"]]);
});

test("the waiting status never replaces the result of a commit already reviewed or under review", async () => {
  const { obj, fx, storage } = make({ writers: ["rishitank"] });
  const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
  const fork = (sha, action = "ready_for_review") => review({ action, fork: true, head: { sha }, author: { login: "outsider", association: "NONE", bot: false } });
  // A writer asked for a review of A, and it finished.
  await storage.put("state", { lastReviewed: A, lastCompleteReviewed: A, paused: false, closed: false });
  await obj.onEvent({ delivery: "1", ev: fork(A) });
  // B is being reviewed right now.
  await storage.put("runmeta:r1", { id: "r1", stage: "draft", headSha: B });
  await obj.onEvent({ delivery: "2", ev: fork(B, "synchronize") });
  // C is neither: it waits.
  await obj.onEvent({ delivery: "3", ev: fork(C, "synchronize") });
  await drain(obj);
  assert.deepEqual(fx.calls.filter((c) => c[0] === "setStatus").map((c) => c[2]), [C]);
});

// --- command acknowledgements (CodeRabbit's "Action performed") ---------------

function withPr(fx, head) {
  let next = 1000;
  fx.comment = async (repoFull, pr, body) => { fx.calls.push(["comment", repoFull, pr, body]); return next++; };
  fx.editComment = async (repoFull, id, body) => { fx.calls.push(["editComment", repoFull, id, body]); return true; };
  fx.pullRequest = async () => ({ state: "open", draft: false, head: { sha: fx.head ?? head } });
  fx.head = head;
  return fx;
}
const comments = (fx) => fx.calls.filter((c) => c[0] === "comment").map((c) => c[3]);
const edits = (fx) => fx.calls.filter((c) => c[0] === "editComment").map((c) => [c[2], c[3]]);

test("review: acknowledged with \"Review triggered.\", edited to \"Review finished.\" when it completes", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "d".repeat(40));
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  await drain(obj);
  const [ack] = comments(fx);
  assert.match(ack, /<summary>Action performed<\/summary>[\s\S]*Review triggered\./);
  const [jobId] = fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);
  assert.equal((await storage.get(`job:${jobId}`)).ackId, 1000);
  await obj.claim({ jobId, runId: "7" });
  await obj.complete({ jobId, runId: "7", reviewedSha: "d".repeat(40) });
  await drain(obj);
  const [[id, text]] = edits(fx);
  assert.equal(id, 1000);
  assert.match(text, /Review finished\./);
  // A retried alarm does not acknowledge twice.
  assert.equal(comments(fx).length, 1);
});

test("review of a commit already reviewed in full is not run again; full review is", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "c".repeat(40));
  await storage.put("state", { lastReviewed: "c".repeat(40), lastCompleteReviewed: "c".repeat(40) });
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  await drain(obj);
  assert.match(comments(fx)[0], /<summary>Action not completed<\/summary>[\s\S]*Already reviewed the last commit\. Use `@tankster-ai-review full review`/);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review full review") });
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1);
  assert.match(comments(fx)[1], /Review triggered\./);
});

test("a draft PR gets one note, as CodeRabbit's: reviews are skipped until it is marked ready; pushes to it add none", async () => {
  const { obj, fx } = make();
  assert.equal((await obj.onEvent({ delivery: "1", ev: review({ action: "opened", draft: true }) })).action, "draft");
  await drain(obj);
  assert.equal(comments(fx).length, 1);
  assert.match(comments(fx)[0], /Review skipped: this pull request is a draft\. It is reviewed once it is marked ready for review\./);
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize", draft: true }) });
  await obj.onEvent({ delivery: "3", ev: review({ action: "converted_to_draft", draft: true }) });
  await drain(obj);
  assert.equal(comments(fx).length, 1, "once");
  // A push to a draft that was never noted (the App was installed later) is not noted either: no spam.
  const other = make();
  await other.obj.onEvent({ delivery: "1", ev: review({ action: "synchronize", draft: true }) });
  await drain(other.obj);
  assert.equal(comments(other.fx).length, 0);
});

test("review and full review on a draft or closed PR are declined with the reason, and run nothing", async () => {
  for (const [state, shape, note] of [["draft", { state: "open", draft: true }, /draft: it is reviewed once it is marked ready/], ["closed", { state: "closed", draft: false }, /closed: it is reviewed if it is reopened/]]) {
    for (const cmd of ["review", "full review"]) {
      const { obj, fx } = make();
      withPr(fx, "d".repeat(40));
      fx.pullRequest = async () => ({ ...shape, head: { sha: "d".repeat(40) } });
      await obj.onEvent({ delivery: "1", ev: command(`@tankster-ai-review ${cmd}`) });
      await drain(obj);
      assert.match(comments(fx)[0], /<summary>Action not completed<\/summary>/, `${state} ${cmd}`);
      assert.match(comments(fx)[0], note, `${state} ${cmd}`);
      assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0, `${state} ${cmd}`);
    }
  }
});

test("review while a review of the head is already under way is declined, not queued twice", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "d".repeat(40));
  await storage.put("runmeta:r1", { id: "r1", stage: "draft", headSha: "d".repeat(40) });
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  await drain(obj);
  assert.match(comments(fx)[0], /<summary>Action not completed<\/summary>[\s\S]*already under way/);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
});

test("pause names the last reviewed commit and the latest one not reviewed, as CodeRabbit's does", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "e".repeat(40));
  await storage.put("state", { lastReviewed: "c".repeat(40), lastCompleteReviewed: "c".repeat(40) });
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review pause") });
  await drain(obj);
  const text = comments(fx)[0];
  assert.match(text, /are paused on this pull request\. Comment `@tankster-ai-review resume`/);
  assert.match(text, /- Last reviewed commit: `ccccccc`/);
  assert.match(text, /- Latest commit, not reviewed: `eeeeeee`/);
  // Nothing was reviewed yet, or the head is the reviewed one: only what is true is said.
  const two = make();
  withPr(two.fx, "c".repeat(40));
  await two.storage.put("state", { lastReviewed: "c".repeat(40), lastCompleteReviewed: "c".repeat(40) });
  await two.obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review pause") });
  await drain(two.obj);
  assert.doesNotMatch(comments(two.fx)[0], /not reviewed/);
  const none = make();
  withPr(none.fx, "e".repeat(40));
  await none.obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review pause") });
  await drain(none.obj);
  assert.doesNotMatch(comments(none.fx)[0], /Last reviewed commit/);
  assert.match(comments(none.fx)[0], /- Latest commit, not reviewed: `eeeeeee`/);
});

test("resume reviews the commits pushed while paused, as CodeRabbit's; with none, it only says so", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "c".repeat(40));
  await storage.put("state", { lastReviewed: "c".repeat(40), lastCompleteReviewed: "c".repeat(40), paused: true });
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review resume") });
  await drain(obj);
  assert.equal((await storage.get("state")).paused, false);
  assert.equal(comments(fx).at(-1), "Automatic reviews are back on.");
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);

  await obj.onEvent({ delivery: "2", ev: command("@tankster-ai-review pause") });
  await drain(obj);
  fx.head = "e".repeat(40);
  await obj.onEvent({ delivery: "3", ev: command("@tankster-ai-review resume") });
  await drain(obj);
  const [jobId] = fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);
  const job = await storage.get(`job:${jobId}`);
  assert.equal(job.full, false);
  assert.equal(job.since, "c".repeat(40));
  assert.match(comments(fx).at(-1), /Reviewing the commits pushed while they were paused/);
});

test("a review that gives up edits its acknowledgement to say it could not finish", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "d".repeat(40));
  await storage.put("key", { repo: repo.full, pr: 39 });
  await storage.put("job:j1", { id: "j1", ackId: 1234 });
  await obj.runDone({ id: "j1" }, { reviewedSha: null, gaveUp: true, description: "boom" });
  await drain(obj);
  const [[id, text]] = edits(fx);
  assert.equal(id, 1234);
  assert.match(text, /<summary>Action not completed<\/summary>[\s\S]*The review could not finish\./);
});

test("a retried command acknowledges once: the acknowledgement is kept on its item", async () => {
  const { obj, fx } = make();
  withPr(fx, "d".repeat(40));
  let fail = 1;
  const real = fx.dispatch;
  fx.dispatch = async (id) => { if (fail-- > 0) throw new Error("GitHub 502"); return real(id); };
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  for (let i = 0; i < 5; i++) { obj.ctx.storage.alarm = null; try { await obj.alarm(); } catch {} }
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1, "dispatched on the retry");
  assert.equal(comments(fx).filter((c) => /Review triggered/.test(c)).length, 1);
});

// Every way a requested review can end edits its acknowledgement: none is left
// saying "Review triggered." for ever.
async function acked(over = {}) {
  const t = { now: NOW };
  const { obj, fx, storage } = make({ now: () => t.now });
  withPr(fx, "d".repeat(40));
  await storage.put("key", { repo: repo.full, pr: 39 });
  await storage.put("job:j1", { id: "j1", ackId: 1234, createdAt: NOW, ...over });
  return { obj, fx, storage, t };
}
const lastEdit = (fx) => { const e = edits(fx); assert.equal(e.length, 1, JSON.stringify(e)); assert.equal(e[0][0], 1234); return e[0][1]; };

test("ack: a run that covered only part of the PR says it finished, and how far it got", async () => {
  const { obj, fx } = await acked();
  await obj.runDone({ id: "j1" }, { reviewedSha: null, gaveUp: false, description: "Incomplete: 2 of 5 files reviewed. Comment \"review\" to try again." });
  await drain(obj);
  assert.match(lastEdit(fx), /<summary>Action performed<\/summary>[\s\S]*Review finished\. Incomplete: 2 of 5 files reviewed\./);
});

test("ack: a run stopped because the PR is no longer open says so", async () => {
  const { obj, fx } = await acked();
  await obj.runDone({ id: "j1" }, { reviewedSha: null, gaveUp: false });
  await drain(obj);
  assert.match(lastEdit(fx), /Action not completed[\s\S]*no longer open/);
});

test("ack: closing the PR edits the acknowledgement of a review not done (and posts nothing)", async () => {
  const { obj, fx, storage } = await acked();
  await obj.onEvent({ delivery: "c1", ev: { ...review(), kind: "closed" } });
  await drain(obj);
  assert.match(lastEdit(fx), /Action not completed[\s\S]*closed before the review finished/);
  assert.equal(comments(fx).length, 0);
  assert.equal(await storage.get("job:j1"), undefined);
});

test("ack: a deferral that gives the review up edits it", async () => {
  const { obj, fx } = await acked({ claimedBy: "7", retries: 2 });
  assert.equal((await obj.defer({ jobId: "j1", runId: "7", why: "error" })).dropped, true);
  await drain(obj);
  assert.match(lastEdit(fx), /Action not completed[\s\S]*could not finish/);
});

test("ack: a job that expired before its claim edits it", async () => {
  const { obj, fx, t } = await acked();
  t.now = NOW + 3 * 3600_000;
  assert.equal((await obj.claim({ jobId: "j1", runId: "7" })).error, "job expired");
  await drain(obj);
  assert.match(lastEdit(fx), /expired before it could run/);
});

test("ack: a stale job pruned by a new one edits it; a fresh one is left alone", async () => {
  const { obj, fx, storage, t } = await acked();
  await storage.put("job:j2", { id: "j2", ackId: 99, createdAt: NOW + 3 * 3600_000 - 1000 });
  t.now = NOW + 3 * 3600_000;
  await obj.newJob({ repo, pr: 39 }, await obj.state(), { queue: false });
  assert.equal(await storage.get("job:j1"), undefined);
  assert.ok(await storage.get("job:j2"));
  const box = (await storage.get("outbox")) ?? [];
  assert.deepEqual(box.filter((x) => x.type === "ack").map((x) => x.commentId), [1234]);
});

test("ack: a dispatch dropped after its retries edits it", async () => {
  const { obj, fx, storage } = await acked();
  await storage.put("outbox", [{ id: "o1", type: "dispatch", jobId: "j1", attempts: 5 }]);
  await drain(obj);
  assert.match(lastEdit(fx), /Action not completed[\s\S]*could not start/);
  assert.equal(await storage.get("job:j1"), undefined);
});

test("ack: a run given up by the alarm (after MAX_RUN_LIFE) edits it", async () => {
  const { obj, fx, storage, t } = await acked();
  obj.stepActiveRun = async () => { throw new Error("no App"); };
  const { startRun, activeRun } = await import("../src/review-run.js");
  await startRun(storage, { id: "j1", repo, pr: 39 }, NOW);
  assert.ok(await activeRun(storage));
  t.now = NOW + 4 * 24 * 3600_000;
  await fire(obj);
  await drain(obj);
  assert.match(lastEdit(fx), /could not finish/);
});

test("resume turns reviews back on but does not review a draft or a closed PR", async () => {
  for (const [pr, said] of [[{ state: "open", draft: true }, /draft: it is reviewed once it is marked ready/], [{ state: "closed", draft: false }, /closed: it is reviewed if it is reopened/]]) {
    const { obj, fx, storage } = make();
    withPr(fx, "c".repeat(40));
    fx.pullRequest = async () => ({ ...pr, head: { sha: "e".repeat(40) } });
    await storage.put("state", { lastReviewed: "c".repeat(40), paused: true });
    await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review resume") });
    await drain(obj);
    assert.equal((await storage.get("state")).paused, false);
    assert.match(comments(fx).at(-1), said);
    assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
  }
});

test("only resolve works as a reply in a review thread; every other command is top-level", async () => {
  for (const text of ["review", "full review", "pause", "resume", "help", "approve", "ignore"]) {
    const { obj } = make();
    const out = await obj.onEvent({ delivery: "1", ev: { ...command(`@tankster-ai-review ${text}`), where: "thread", commentId: 9, inReplyTo: 5 } });
    assert.equal(out.action, "not_a_command", text);
  }
  const { obj } = make();
  const out = await obj.onEvent({ delivery: "1", ev: { ...command("@tankster-ai-review resolve"), where: "thread", commentId: 9, inReplyTo: 5 } });
  assert.notEqual(out.action, "not_a_command");
});

test("a job waiting behind the review in progress is kept fresh, so it is not pruned as stale", async () => {
  const t = { now: NOW };
  const { obj, storage } = make({ now: () => t.now });
  const { startRun } = await import("../src/review-run.js");
  await startRun(storage, { id: "busy", repo, pr: 39 }, NOW);
  await storage.put("job:j1", { id: "j1", repo, pr: 39, createdAt: NOW });
  t.now = NOW + 3600_000;
  const out = await obj.startWorkerRun(await storage.get("job:j1"), await obj.state());
  assert.ok(out.holdUntil > t.now);
  assert.equal((await storage.get("job:j1")).createdAt, t.now);
});

test("a run that ends without a complete review asks for a decision, so the notice is written again", async () => {
  const { obj, storage } = await acked();
  await obj.runDone({ id: "j1" }, { reviewedSha: null, gaveUp: false, description: "Incomplete: 2 of 5 files reviewed." });
  const box = (await storage.get("outbox")) ?? [];
  assert.equal(box.filter((x) => x.type === "decide").length, 1);
});

test("a retried resume whose head was reviewed meanwhile finishes its job: no second review, the acknowledgement says finished", async () => {
  // Worker mode (the default): a requested run is forced, so dispatching it
  // would review the head again.
  const storage = memoryStorage();
  const fx = fakeEffects({ writers: ["rishitank"] });
  const obj = new PrState(doCtx(storage), {}, { now: () => NOW, effects: fx });
  withPr(fx, "c".repeat(40));
  await storage.put("key", { repo: repo.full, pr: 39 });
  await storage.put("state", { lastReviewed: "c".repeat(40), lastCompleteReviewed: "c".repeat(40), paused: false });
  await storage.put("job:j9", { id: "j9", repo, pr: 39, full: false, createdAt: NOW, ackId: 55 });
  await storage.put("outbox", [{ id: "o9", attempts: 1, type: "command", cmd: "resume", repo, pr: 39, login: "rishitank", jobId: "j9", acked: true, seq: 1 }]);
  await drain(obj);
  const { activeRun } = await import("../src/review-run.js");
  assert.equal(await activeRun(storage), null, "no run started");
  assert.equal(await storage.get("job:j9"), undefined);
  assert.deepEqual(edits(fx), [[55, actionPerformed("Review finished.")]]);
  assert.equal(comments(fx).length, 0);
});

test("a retried resume whose job is already running leaves it to finish", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "e".repeat(40));
  await storage.put("state", { lastReviewed: "c".repeat(40), paused: false });
  await storage.put("job:j9", { id: "j9", repo, pr: 39, createdAt: NOW, ackId: 55, claimedBy: "worker" });
  await storage.put("outbox", [{ id: "o9", attempts: 1, type: "command", cmd: "resume", repo, pr: 39, login: "rishitank", jobId: "j9", acked: true, seq: 1 }]);
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
  assert.ok(await storage.get("job:j9"));
  assert.equal(comments(fx).length + edits(fx).length, 0);
});

test("a retried resume whose review is still to start goes on with it, not the shortcut", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "e".repeat(40));
  await storage.put("state", { lastReviewed: "c".repeat(40), lastCompleteReviewed: "c".repeat(40), paused: false });
  await storage.put("job:j9", { id: "j9", repo, pr: 39, full: false, createdAt: NOW, ackId: 55 });
  await storage.put("outbox", [{ id: "o9", attempts: 1, type: "command", cmd: "resume", repo, pr: 39, login: "rishitank", jobId: "j9", acked: true, seq: 1 }]);
  await drain(obj);
  // Its own job (given an opaque id first, as an old one is), not a new one.
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1);
  assert.equal(await storage.get("job:j9"), undefined);
  assert.equal(comments(fx).length, 0, "no second acknowledgement");
});

test("ack: a retry after the job write failed still gives the job its acknowledgement (no second comment)", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "d".repeat(40));
  // The first try: comment posted, item kept, then the job read fails.
  const real = storage.get.bind(storage);
  let fail = true;
  storage.get = async (k) => { if (fail && typeof k === "string" && k.startsWith("job:") && (await real("outbox"))?.some((x) => x.acked)) { fail = false; throw new Error("storage blip"); } return real(k); };
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  for (let i = 0; i < 5; i++) { obj.ctx.storage.alarm = null; try { await obj.alarm(); } catch {} }
  storage.get = real;
  assert.equal(fail, false, "the job read did fail once");
  const [jobId] = fx.calls.filter((c) => c[0] === "dispatch").map((c) => c[1]);
  assert.ok(jobId, "dispatched on the retry");
  assert.equal((await storage.get(`job:${jobId}`)).ackId, 1000);
  assert.equal(comments(fx).length, 1);
});

test("ack: complete queues its edit once, even when retried before the job is deleted", async () => {
  const { obj, fx, storage } = await acked({ claimedBy: "7", claimedAt: NOW });
  const del = storage.delete.bind(storage);
  let fail = true;
  storage.delete = async (k) => { if (fail && k === "job:j1") { fail = false; throw new Error("storage blip"); } return del(k); };
  await assert.rejects(obj.complete({ jobId: "j1", runId: "7", reviewedSha: "d".repeat(40) }));
  storage.delete = del;
  await obj.complete({ jobId: "j1", runId: "7", reviewedSha: "d".repeat(40) });
  const acks = ((await storage.get("outbox")) ?? []).filter((x) => x.type === "ack");
  assert.equal(acks.length, 1);
  await drain(obj);
  assert.match(lastEdit(fx), /Review finished\./);
});

test("a retried resume whose PR became a draft or closed ends its job, and says why", async () => {
  for (const [pr, said] of [[{ state: "open", draft: true }, /draft/], [{ state: "closed", draft: false }, /closed/]]) {
    const { obj, fx, storage } = make();
    withPr(fx, "e".repeat(40));
    fx.pullRequest = async () => ({ ...pr, head: { sha: "e".repeat(40) } });
    await storage.put("key", { repo: repo.full, pr: 39 });
    await storage.put("state", { lastReviewed: "c".repeat(40), paused: false });
    await storage.put("job:j9", { id: "j9", repo, pr: 39, createdAt: NOW, ackId: 55 });
    await storage.put("outbox", [{ id: "o9", attempts: 1, type: "command", cmd: "resume", repo, pr: 39, login: "rishitank", jobId: "j9", acked: true, ackId: 55, seq: 1 }]);
    await drain(obj);
    assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
    assert.equal(await storage.get("job:j9"), undefined);
    const [[id, text]] = edits(fx);
    assert.equal(id, 55);
    assert.match(text, /Action not completed[\s\S]*/);
    assert.match(text, said);
  }
});

test("a retried resume ends its job on the item's acknowledgement id when the job's was never saved", async () => {
  const cases = [
    [{ state: "open", draft: false }, "c".repeat(40), /Action performed[\s\S]*Review finished\./],
    [{ state: "open", draft: true }, "e".repeat(40), /Action not completed[\s\S]*draft/],
    [{ state: "closed", draft: false }, "e".repeat(40), /Action not completed[\s\S]*closed/],
  ];
  for (const [pr, head, said] of cases) {
    const { obj, fx, storage } = make();
    withPr(fx, head);
    fx.pullRequest = async () => ({ ...pr, head: { sha: head } });
    await storage.put("key", { repo: repo.full, pr: 39 });
    await storage.put("state", { lastReviewed: "c".repeat(40), paused: false });
    await storage.put("job:j9", { id: "j9", repo, pr: 39, createdAt: NOW });
    await storage.put("outbox", [{ id: "o9", attempts: 1, type: "command", cmd: "resume", repo, pr: 39, login: "rishitank", jobId: "j9", acked: true, ackId: 77, seq: 1 }]);
    await drain(obj);
    assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
    assert.equal(await storage.get("job:j9"), undefined);
    const [[id, text]] = edits(fx);
    assert.equal(id, 77);
    assert.match(text, said);
  }
});

test("ack: the flag, the id and the job's copy are one write; a close before the retry edits the acknowledgement", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "d".repeat(40));
  // The acknowledgement is posted, then the dispatch fails: the item waits for a retry.
  fx.dispatch = async () => { throw new Error("GitHub 502"); };
  const puts = [];
  const put = storage.put.bind(storage);
  storage.put = async (k, v) => { puts.push(typeof k === "object" ? Object.keys(k) : [k]); return put(k, v); };
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  obj.ctx.storage.alarm = null;
  try { await obj.alarm(); } catch {}
  const [item] = ((await storage.get("outbox")) ?? []).filter((x) => x.type === "command");
  assert.equal(item.ackId, 1000);
  assert.equal((await storage.get(`job:${item.jobId}`)).ackId, 1000);
  assert.ok(puts.some((ks) => ks.includes("outbox") && ks.includes(`job:${item.jobId}`)), "one write holds both");
  // Closed before the retry: the close edits the acknowledgement.
  await obj.onEvent({ delivery: "2", ev: { ...review(), kind: "closed" } });
  await drain(obj);
  assert.deepEqual(edits(fx).map(([id]) => id), [1000]);
  assert.match(edits(fx)[0][1], /closed before the review finished/);
  assert.equal(comments(fx).length, 1);
});

test("ack: a close while the acknowledgement is being posted still edits it, and nothing is dispatched", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "d".repeat(40));
  const post = fx.comment;
  fx.comment = async (r, p, body) => {
    // The close lands while GitHub's call is pending.
    await obj.onEvent({ delivery: "2", ev: { ...review(), kind: "closed" } });
    return post(r, p, body);
  };
  await obj.onEvent({ delivery: "1", ev: command("@tankster-ai-review review") });
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 0);
  const e = edits(fx);
  assert.equal(e.length, 1);
  assert.equal(e[0][0], 1000);
  assert.match(e[0][1], /Action not completed[\s\S]*closed before the review finished/);
});

test("an ack is queued before its job goes: a failed queue keeps the ackId for the retry (runDone, defer)", async () => {
  for (const op of ["runDone", "defer"]) {
    const storage = memoryStorage();
    const obj = new PrState(doCtx(storage), {}, { now: () => NOW, effects: {} });
    await storage.put("key", { repo: "o/r", pr: 1 });
    await storage.put("job:j1", { id: "j1", ackId: 4242, claimedBy: op === "defer" ? "run9" : null, createdAt: NOW, retries: 99 });
    const put = storage.put.bind(storage);
    storage.put = async (k, v) => { if (k === "outbox") throw new Error("outbox down"); return put(k, v); };
    const go = op === "runDone"
      ? obj.runDone({ id: "j1" }, { reviewedSha: null, gaveUp: true, description: "x" })
      : obj.defer({ jobId: "j1", runId: "run9", why: "error", reason: "x" });
    await assert.rejects(go, /outbox down/, op);
    assert.equal((await storage.get("job:j1"))?.ackId, 4242, `${op}: the job and its ackId survive`);
  }
});

test("review fixes: a hidden comment on a whole-comment command's line stops it; a cut-off body is never the whole comment", async () => {
  assert.equal(parseCommand("@tankster-ai-review approve <!-- extra text -->"), null);
  assert.equal(parseCommand("@tankster-ai-review approve"), "approve");
});

test("review fixes: a job waiting behind a provider's long wait is held for less than its lifetime, so a later job cannot prune it", async () => {
  const { obj, storage } = make();
  const { startRun, activeRun, RUN_META } = await import("../src/review-run.js");
  await startRun(storage, { id: "busy", repo, pr: 39 }, NOW);
  const run = await activeRun(storage);
  const key = [...(await storage.list({ prefix: RUN_META })).keys()][0];
  await storage.put(key, { ...run, waitUntil: NOW + 6 * 3600_000 });
  await storage.put("job:j1", { id: "j1", repo, pr: 39, createdAt: NOW });
  const held = await obj.startWorkerRun(await storage.get("job:j1"), await obj.state());
  assert.ok(held.holdUntil <= NOW + 3600_000, `held until +${(held.holdUntil - NOW) / 3600_000} h`);
});

test("review fixes: an acknowledgement that cannot be posted does not stop the review", async () => {
  const { obj, fx, storage } = make();
  withPr(fx, "a".repeat(40));
  fx.comment = async () => { throw new Error("locked conversation"); };
  await obj.onEvent({ delivery: "d1", ev: command("@tankster-ai-review review") });
  await fire(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1, "the review is still dispatched");
});
