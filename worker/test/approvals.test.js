// Automatic approvals, as CodeRabbit's: the PR's object approves once the
// latest commit was reviewed in full and none of the App's own threads (or
// body-only findings) is open, and asks for changes again if one is reopened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrState, helpText, parseCommand } from "../src/pr-state.js";
import { MARKER } from "../src/effects.js";
import { doCtx, memoryStorage } from "./helpers.js";
import { keepOpenFindings, listOpenFindings } from "../src/review-run.js";

const NOW = Date.UTC(2026, 10, 19, 21, 0, 0);
const repo = { full: "TanksterAI/browser-relay", name: "browser-relay", ownerId: "259206056" };
const HEAD = "a".repeat(40);

function world({ head = HEAD, threads = [], decision = null, writers = ["rishitank"], heads = null } = {}) {
  const calls = [];
  const w = { head, threads, decision, heads };
  const fx = {
    calls,
    async canWrite(_r, login) { calls.push(["canWrite", login]); return writers.includes(login); },
    async comment(_r, _p, body) { calls.push(["comment", body]); },
    async pullRequest() { calls.push(["pullRequest"]); const h = w.heads ? w.heads.shift() ?? w.head : w.head; return { state: "open", draft: false, head: { sha: h } }; },
    async ownThreads(_r, _p, login) { calls.push(["ownThreads", login]); return w.threads; },
    async resolveThread(_r, id) { calls.push(["resolveThread", id]); const t = w.threads.find((x) => x.id === id); if (t) t.resolved = true; return true; },
    async reviewDecision(_r, _p, login) { calls.push(["reviewDecision", login]); return w.decision; },
    async approve(_r, _p, review) { calls.push(["approve", review]); w.decision = { state: "APPROVED", commitId: review.commitId }; },
    async postReview(_r, _p, review) { calls.push(["postReview", review]); if (review.event === "REQUEST_CHANGES") w.decision = { state: "CHANGES_REQUESTED", commitId: review.commitId }; return { inline: 0 }; },
  };
  return { fx, w, calls };
}

async function make(over = {}) {
  const storage = memoryStorage();
  const { fx, w, calls } = world(over);
  let t = NOW;
  const obj = new PrState(doCtx(storage), {}, { now: () => t, effects: fx });
  await storage.put("key", { repo: repo.full, pr: 39 });
  await storage.put("state", { lastReviewed: HEAD, lastCompleteReviewed: over.reviewed ?? HEAD, paused: false, closed: false });
  return { obj, storage, fx, w, calls, setNow: (x) => { t = x; } };
}

async function drain(obj) {
  for (let i = 0; i < 50 && ((await obj.ctx.storage.get("outbox")) ?? []).length; i++) {
    obj.ctx.storage.alarm = null;
    await obj.alarm();
  }
}
const decide = async (m, item = {}) => { await m.obj.outbox({ type: "decide", ...item }); await drain(m.obj); };
const approvals = (calls) => calls.filter((c) => c[0] === "approve");
const thread = (id, resolved) => ({ id, resolved, findingId: id });

test("approves when the latest commit was reviewed in full and every one of its threads is resolved", async () => {
  const m = await make({ threads: [thread("t1", true)] });
  await decide(m);
  const [[, review]] = approvals(m.calls);
  assert.equal(review.commitId, HEAD);
  assert.match(review.body, /every finding is resolved/i);
  // It looked at its own threads and its own decision, by its own logins.
  assert.deepEqual(m.calls.find((c) => c[0] === "ownThreads"), ["ownThreads", "tankster-ai-review"]);
  assert.deepEqual(m.calls.find((c) => c[0] === "reviewDecision"), ["reviewDecision", "tankster-ai-review[bot]"]);
});

test("does not approve while a thread or a body-only finding is open, or the latest commit has no complete review", async () => {
  const open = await make({ threads: [thread("t1", false)] });
  await decide(open);
  assert.equal(approvals(open.calls).length, 0);

  const body = await make();
  await keepOpenFindings(body.storage, [{ id: "f1", path: "a.js", line: 3, text: "x", sha: HEAD }]);
  await decide(body);
  assert.equal(approvals(body.calls).length, 0);

  // The head moved on since the last complete review.
  const behind = await make({ reviewed: "b".repeat(40) });
  await decide(behind);
  assert.equal(approvals(behind.calls).length, 0);
  assert.equal(behind.calls.some((c) => c[0] === "ownThreads"), false, "nothing else is read");
});

test("approves once only, and never a commit that is no longer the head", async () => {
  const already = await make({ decision: { state: "APPROVED", commitId: "c".repeat(40) } });
  await decide(already);
  assert.equal(approvals(already.calls).length, 0);

  // A change request or a dismissed approval: approved again.
  for (const state of ["CHANGES_REQUESTED", "DISMISSED"]) {
    const m = await make({ decision: { state, commitId: "c".repeat(40) } });
    await decide(m);
    assert.equal(approvals(m.calls).length, 1, state);
  }

  // A push lands while it checks: the head is read again just before approving.
  const raced = await make({ heads: [HEAD, "f".repeat(40)] });
  await decide(raced);
  assert.equal(approvals(raced.calls).length, 0);
});

test("a thread reopened after the approval asks for changes again; reopened before it, nothing", async () => {
  const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD } });
  await decide(m, { reopened: true });
  const [[, review]] = m.calls.filter((c) => c[0] === "postReview");
  assert.equal(review.event, "REQUEST_CHANGES");
  assert.equal(review.commitId, HEAD);
  assert.ok(review.body.startsWith(`${MARKER}\n`));
  assert.match(review.body, /reopened/);

  const before = await make({ threads: [thread("t1", false)], decision: { state: "CHANGES_REQUESTED", commitId: HEAD } });
  await decide(before, { reopened: true });
  assert.equal(before.calls.some((c) => c[0] === "postReview"), false);
});

test("a finished review, and a resolved or reopened thread, each ask for a decision", async () => {
  const m = await make();
  const out = await m.obj.onEvent({ delivery: "d1", ev: { kind: "thread", action: "resolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t1" } });
  assert.equal(out.action, "decide");
  // A second event while one waits adds nothing.
  await m.obj.onEvent({ delivery: "d2", ev: { kind: "thread", action: "resolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t2" } });
  const decisions = async () => ((await m.storage.get("outbox")) ?? []).filter((x) => x.type === "decide").map((x) => [x.type, Boolean(x.reopened)]);
  assert.deepEqual(await decisions(), [["decide", false]]);
  await m.obj.onEvent({ delivery: "d3", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t2" } });
  assert.deepEqual(await decisions(), [["decide", false], ["decide", true]]);

  // A closed pull request gets no decision.
  const closed = await make();
  await closed.storage.put("state", { closed: true });
  assert.equal((await closed.obj.onEvent({ delivery: "d1", ev: { kind: "thread", action: "resolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t1" } })).action, "closed");

  // The Worker's own review, once it covered every file.
  const done = await make();
  await done.storage.put(`job:j1`, { id: "j1", claimedBy: "worker", claimedAt: NOW });
  await done.obj.runDone({ id: "j1" }, { reviewedSha: HEAD });
  assert.ok(((await done.storage.get("outbox")) ?? []).some((x) => x.type === "decide"));
  const partial = await make();
  await partial.obj.runDone({ id: "j1" }, { reviewedSha: null });
  assert.equal(((await partial.storage.get("outbox")) ?? []).some((x) => x.type === "decide"), false);
});

test("resolve and approve: top-level commands from writers that resolve every thread of the App's own and approve", async () => {
  assert.equal(parseCommand("@tankster-ai-review resolve"), "resolve");
  assert.equal(parseCommand("@tankster-ai-review approve"), "approve");
  assert.equal(parseCommand("@tankster-ai-review resume"), "resume");
  assert.match(helpText(), /`resolve`/);
  assert.match(helpText(), /`approve`/);

  for (const cmd of ["resolve", "approve"]) {
    // No complete review of the head is needed for these, as CodeRabbit's.
    const m = await make({ threads: [thread("t1", false), thread("t2", true), thread("t3", false)], reviewed: "b".repeat(40) });
    await keepOpenFindings(m.storage, [{ id: "f1", path: "a.js", line: 3, text: "x", sha: HEAD }]);
    const out = await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: `@tankster-ai-review ${cmd}` } });
    assert.equal(out.cmd, cmd);
    await drain(m.obj);
    assert.deepEqual(m.calls.filter((c) => c[0] === "resolveThread").map((c) => c[1]), ["t1", "t3"]);
    assert.deepEqual(await listOpenFindings(m.storage), []);
    const [[, review]] = approvals(m.calls);
    assert.match(review.body, /@rishitank/);
  }

  // Someone without write access: refused, nothing resolved.
  const no = await make({ threads: [thread("t1", false)], writers: [] });
  await no.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "stranger", bot: false }, text: "@tankster-ai-review approve" } });
  await drain(no.obj);
  assert.equal(no.calls.some((c) => c[0] === "resolveThread" || c[0] === "approve"), false);

  // In a review thread's replies they are not commands (CodeRabbit's rule).
  const reply = await make({ threads: [thread("t1", false)] });
  const r = await reply.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "thread", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  assert.equal(r.action, "not_a_command");
});

test("many threads are resolved over several alarms, never more than the step allows at once", async () => {
  const threads = Array.from({ length: 95 }, (_, i) => thread(`t${i}`, false));
  const m = await make({ threads });
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  let most = 0;
  for (let i = 0; i < 20 && ((await m.storage.get("outbox")) ?? []).length; i++) {
    const before = m.calls.length;
    // As the runtime: the alarm fires when it is due.
    if (m.storage.alarm > NOW) m.setNow(m.storage.alarm);
    m.storage.alarm = null;
    await m.obj.alarm();
    most = Math.max(most, m.calls.slice(before).filter((c) => c[0] === "resolveThread").length);
  }
  assert.equal(m.calls.filter((c) => c[0] === "resolveThread").length, 95);
  assert.ok(most <= 20, `at most 20 a step (was ${most})`);
  assert.equal(approvals(m.calls).length, 1);
});

test("a thread reopened after an approval asks for changes even when the head has no complete review", async () => {
  // Approved by command at a head that was never reviewed in full.
  const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD }, reviewed: "b".repeat(40) });
  await decide(m, { reopened: true });
  assert.equal(m.calls.filter((c) => c[0] === "postReview").length, 1);
});

test("a thread reopened by hand is remembered, and forgotten only once a writer resolves it", async () => {
  const m = await make();
  const ev = (action, login = "rishitank") => ({ kind: "thread", action, repo, pr: 39, sender: { login, bot: false }, threadId: "PRRT_9" });
  await m.obj.onEvent({ delivery: "d1", ev: ev("unresolved") });
  assert.deepEqual(Object.keys(await m.storage.get("reopenedThreads")), ["PRRT_9"]);
  // An outsider's resolve keeps the mark.
  await m.obj.onEvent({ delivery: "d2", ev: ev("resolved", "stranger") });
  await drain(m.obj);
  assert.deepEqual(Object.keys(await m.storage.get("reopenedThreads")), ["PRRT_9"]);
  await m.obj.onEvent({ delivery: "d3", ev: ev("resolved") });
  await drain(m.obj);
  assert.deepEqual(await m.storage.get("reopenedThreads"), {});

  // A writer resolves, then it is reopened again before that resolve is
  // checked: the newer mark stays.
  await m.obj.onEvent({ delivery: "d4", ev: ev("unresolved") });
  await m.obj.onEvent({ delivery: "d5", ev: ev("resolved") });
  await m.obj.onEvent({ delivery: "d6", ev: ev("unresolved") });
  await drain(m.obj);
  assert.deepEqual(Object.keys(await m.storage.get("reopenedThreads")), ["PRRT_9"]);
});

test("a thread resolved by someone without write access still counts as open", async () => {
  const m = await make({ threads: [{ id: "t1", resolved: true, resolvedBy: "stranger" }], writers: ["rishitank"] });
  await decide(m);
  assert.equal(approvals(m.calls).length, 0);
  const ok = await make({ threads: [{ id: "t1", resolved: true, resolvedBy: "rishitank" }, { id: "t2", resolved: true, resolvedBy: "tankster-ai-review" }] });
  await decide(ok);
  assert.equal(approvals(ok.calls).length, 1);
  // The App's own resolving needs no permission check.
  assert.equal(ok.calls.some((c) => c[0] === "canWrite" && c[1] === "tankster-ai-review"), false);
});

test("resolving that makes no progress is a failed attempt, not a loop", async () => {
  const m = await make({ threads: [thread("t1", false)] });
  m.fx.resolveThread = async (_r, id) => { m.calls.push(["resolveThread", id]); return false; };
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  let threw = 0;
  for (let i = 0; i < 20 && ((await m.storage.get("outbox")) ?? []).length; i++) {
    m.storage.alarm = null;
    // As the runtime: an alarm that throws is retried.
    try { await m.obj.alarm(); } catch { threw++; }
  }
  assert.ok(threw >= 1);
  assert.equal(((await m.storage.get("outbox")) ?? []).length, 0, "given up after its attempts");
  assert.ok(m.calls.filter((c) => c[0] === "resolveThread").length <= 5);
  assert.equal(approvals(m.calls).length, 0);
});

test("a merged pull request forgets its open findings, reopened threads and summary comment", async () => {
  const m = await make();
  await keepOpenFindings(m.storage, [{ id: "f1" }]);
  await m.storage.put("reopenedThreads", ["PRRT_1"]);
  await m.storage.put("summaryComment", 5);
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "closed", repo, pr: 39, merged: true } });
  await m.storage.put("reopenSeq", 3);
  await m.obj.onEvent({ delivery: "d9", ev: { kind: "closed", repo, pr: 39, merged: true } });
  for (const k of ["reopenedThreads", "summaryComment", "acceptedThreads", "reopenSeq"]) assert.equal(await m.storage.get(k), undefined, k);
  assert.deepEqual(await listOpenFindings(m.storage), []);
  const kept = await make();
  await kept.storage.put("summaryComment", 5);
  await kept.obj.onEvent({ delivery: "d1", ev: { kind: "closed", repo, pr: 39, merged: false } });
  assert.equal(await kept.storage.get("summaryComment"), 5, "closed unmerged may be reopened");
});

test("the approval is re-checked against a draft too: a PR made a draft meanwhile is not approved", async () => {
  const m = await make();
  let n = 0;
  m.fx.pullRequest = async () => ({ state: "open", draft: n++ > 0, head: { sha: HEAD } });
  await decide(m);
  assert.equal(approvals(m.calls).length, 0);
});

test("a stranger-resolved thread is cleared by a writer's approve, or once a review accepted it as fixed", async () => {
  const stranger = () => [{ id: "t1", resolved: true, resolvedBy: "stranger" }];
  const cmd = await make({ threads: stranger(), writers: ["rishitank"] });
  await cmd.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review approve" } });
  await drain(cmd.obj);
  assert.equal(approvals(cmd.calls).length, 1);

  const acc = await make({ threads: stranger(), writers: ["rishitank"] });
  await acc.storage.put("acceptedThreads", ["t1"]);
  await decide(acc);
  assert.equal(approvals(acc.calls).length, 1);
});

test("a writer's approve vouches for stranger-resolved threads for later decisions too; a reopen takes that back", async () => {
  const m = await make({ threads: [{ id: "t1", resolved: true, resolvedBy: "stranger" }] });
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review approve" } });
  await drain(m.obj);
  assert.deepEqual(await m.storage.get("acceptedThreads"), ["t1"]);
  await m.obj.onEvent({ delivery: "d2", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t1" } });
  assert.deepEqual(await m.storage.get("acceptedThreads"), []);
});

test("resolve: a thread GitHub refused keeps the command pending; nothing is cleared or decided until none is open", async () => {
  const m = await make({ threads: [thread("t1", false), thread("t2", false)] });
  await keepOpenFindings(m.storage, [{ id: "f1", path: "a.js", line: 3, text: "x", sha: HEAD }]);
  let refused = false;
  m.fx.resolveThread = async (_r, id) => {
    m.calls.push(["resolveThread", id]);
    if (id === "t2" && !refused) { refused = true; return false; }
    m.w.threads.find((x) => x.id === id).resolved = true;
    return true;
  };
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal((await listOpenFindings(m.storage)).length, 1, "not cleared while a thread is open");
  assert.equal(((await m.storage.get("outbox")) ?? []).some((x) => x.type === "decide"), false);
  for (let i = 0; i < 10 && ((await m.storage.get("outbox")) ?? []).length; i++) {
    if (m.storage.alarm > NOW) m.setNow(m.storage.alarm);
    m.storage.alarm = null;
    await m.obj.alarm();
  }
  assert.deepEqual(await listOpenFindings(m.storage), []);
  assert.equal(approvals(m.calls).length, 1);
});

test("a decision due now gets the alarm to itself: the review in progress steps at the next one", async () => {
  const m = await make();
  await m.storage.put("runmeta:j1", { id: "j1", stage: "draft" });
  let stepped = 0;
  m.obj.stepActiveRun = async () => { stepped++; return null; };
  await m.obj.outbox({ type: "decide" });
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(stepped, 0, "no review step beside the decision");
  assert.equal(approvals(m.calls).length, 1);
  assert.ok(m.storage.alarm !== null, "the review is woken again");
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(stepped, 1);
});

test("every vouched thread is kept, past 500", async () => {
  const threads = Array.from({ length: 700 }, (_, i) => ({ id: `t${i}`, resolved: true, resolvedBy: "stranger" }));
  const m = await make({ threads });
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review approve" } });
  await drain(m.obj);
  assert.equal((await m.storage.get("acceptedThreads")).length, 700);
  // A later ordinary decision counts them all as resolved.
  m.w.decision = null;
  await decide(m);
  assert.equal(approvals(m.calls).length, 2);
});

test("a heavy item that arrives during a review step waits for the next alarm, its attempts untouched", async () => {
  const m = await make();
  await m.storage.put("runmeta:j1", { id: "j1", stage: "draft" });
  let stepped = 0;
  m.obj.stepActiveRun = async () => {
    stepped++;
    // A resolve command lands while the step's GitHub calls are pending.
    if (stepped === 1) await m.obj.outbox({ type: "decide" });
    return m.now?.() ?? NOW;
  };
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(stepped, 1);
  assert.equal(approvals(m.calls).length, 0, "not in the step's invocation");
  const [left] = (await m.storage.get("outbox")) ?? [];
  assert.equal(left.attempts, 0);
  assert.ok(m.storage.alarm !== null);
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(stepped, 1, "the decision has its own invocation");
  assert.equal(approvals(m.calls).length, 1);
});

test("reopen marks are never evicted while a thread could still be listed", async () => {
  const m = await make();
  for (let i = 0; i < 1001; i++) {
    await m.obj.onEvent({ delivery: `d${i}`, ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: `T${i}` } });
  }
  const marks = await m.storage.get("reopenedThreads");
  assert.equal(Object.keys(marks).length, 1001);
  assert.ok("T0" in marks);
});
