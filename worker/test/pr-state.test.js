import { test } from "node:test";
import assert from "node:assert/strict";
import { PrState, parseCommand, jobIdFor, prKeyOfJob } from "../src/pr-state.js";
import { memoryStorage, fakeEffects } from "./helpers.js";

const NOW = 1_794_500_000_000;
const repo = { full: "TanksterAI/browser-relay", name: "browser-relay", ownerId: "259206056" };

function make({ writers = ["rishitank"], now = () => NOW } = {}) {
  const storage = memoryStorage();
  const fx = fakeEffects({ writers });
  const obj = new PrState({ storage }, {}, { now, effects: fx });
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
  assert.equal(parseCommand("@tankster-ai-review full review"), "full review");
  assert.equal(parseCommand("hey @tankster-ai-review   Review please"), "review");
  assert.equal(parseCommand("@tankster-ai-review pause.\nthanks"), "pause");
  assert.equal(parseCommand("@tankster-ai-review reviewing"), null);
  assert.equal(parseCommand("@tankster-ai-review delete everything"), null);
});

test("job ids name their PR and nothing else can be forged into them", () => {
  const id = jobIdFor("TanksterAI/browser-relay#39");
  assert.equal(prKeyOfJob(id), "TanksterAI/browser-relay#39");
  for (const bad of [undefined, "", "abc", `${id}x`, id.replace(/\.[0-9a-f]+$/, ".zz"), "a.b.c"]) assert.equal(prKeyOfJob(bad), null);
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

test("drafts wait; forks and bots need a writer to ask; outsiders are checked first", async () => {
  const { obj, fx } = make({ writers: ["rishitank", "privatemember"] });
  assert.equal((await obj.onEvent({ delivery: "1", ev: review({ draft: true }) })).action, "draft");
  assert.equal((await obj.onEvent({ delivery: "2", ev: review({ fork: true }) })).action, "needs_approval");
  assert.equal((await obj.onEvent({ delivery: "3", ev: review({ author: { login: "renovate[bot]", association: "NONE", bot: true } }) })).action, "needs_approval");
  // An org member whose association under-reports is reviewed after the API says so.
  assert.equal((await obj.onEvent({ delivery: "4", ev: review({ author: { login: "privatemember", association: "CONTRIBUTOR", bot: false } }) })).action, "author_check");
  // A real outsider gets the note, once, on opening.
  assert.equal((await obj.onEvent({ delivery: "5", ev: review({ author: { login: "someone", association: "CONTRIBUTOR", bot: false } }) })).action, "author_check");
  await drain(obj);
  assert.equal(fx.calls.filter((c) => c[0] === "dispatch").length, 1, "only the private member's PR");
  const notes = fx.calls.filter((c) => c[0] === "comment").map((c) => c[3]);
  assert.equal(notes.length, 2, "one for the fork, one for the outsider; none for the bot");
  assert.ok(notes.every((n) => /write access can comment/.test(n)));
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
  storage.delete = async (k) => { if (Array.isArray(k)) { assert.ok(k.length <= 128); deletes.push(k.length); } return del(k); };
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
  const obj = new PrState({ storage }, { REVIEW_DEBOUNCE_S: "60", REVIEW_DEBOUNCE_MAX_S: "30" }, { now: () => NOW, effects: fakeEffects() });
  assert.equal(obj.debounceMs, 60_000);
  assert.equal(obj.debounceMaxMs, 60_000);
  const bad = new PrState({ storage: memoryStorage() }, { REVIEW_DEBOUNCE_S: "soon", REVIEW_DEBOUNCE_MAX_S: "-1" }, { now: () => NOW });
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
  const obj = new PrState({ storage }, { REVIEW_DEBOUNCE_S: "0" }, { now: () => t, effects: fx });
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
    const o = new PrState({ storage: memoryStorage() }, { REVIEW_DEBOUNCE_S: v }, { now: () => NOW });
    assert.equal(o.debounceMs, 180_000, JSON.stringify(v));
  }
  assert.equal(new PrState({ storage: memoryStorage() }, { REVIEW_DEBOUNCE_S: " 90 " }, { now: () => NOW }).debounceMs, 90_000);
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
