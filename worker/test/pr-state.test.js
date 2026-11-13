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
async function drain(obj) {
  for (let i = 0; i < 50 && ((await obj.ctx.storage.get("outbox")) ?? []).length; i++) await obj.alarm();
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
  assert.equal((await obj.onEvent({ delivery: "5", ev: review({ action: "synchronize" }) })).action, "job");
});

test("review and full review: incremental from the last reviewed commit, or from scratch", async () => {
  const { obj, fx, storage } = make();
  const first = await obj.onEvent({ delivery: "1", ev: review() });
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
  const b = await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
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
  await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
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

  const second = await obj.onEvent({ delivery: "2", ev: review({ action: "synchronize" }) });
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
