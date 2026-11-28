// Automatic approvals, as CodeRabbit's: the PR's object approves once the
// latest commit was reviewed in full and none of the App's own threads (or
// body-only findings) is open, and asks for changes again if one is reopened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrState, helpText, parseCommand } from "../src/pr-state.js";
import { MARKER } from "../src/effects.js";
import { doCtx, memoryStorage } from "./helpers.js";
import { acceptThreads, acceptedSet, keepOpenFindings, listOpenFindings, reopenMark, reopenedSet } from "../src/review-run.js";

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
  assert.equal(review.body, "", "no text, as CodeRabbit's approval");
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

test("approves each fully reviewed head once, and never a commit that is no longer the head", async () => {
  // Already approved at this head: nothing more.
  const already = await make({ decision: { state: "APPROVED", commitId: HEAD } });
  await decide(already);
  assert.equal(approvals(already.calls).length, 0);

  // Approved at an older commit, and the new head has a complete review with
  // nothing open: approved again at the head. GitHub counts an approval only
  // for the commits it covers when later ones were pushed by a bot or a branch
  // update (a ruleset's "extra approval for unattributed changes"), and the
  // organisation keeps no stale-review dismissal, so the reviewer keeps its
  // own approval current, as CodeRabbit re-approves after an incremental review.
  const older = await make({ decision: { state: "APPROVED", commitId: "c".repeat(40) } });
  await decide(older);
  const again = approvals(older.calls);
  assert.equal(again.length, 1);
  assert.equal(again[0][1].commitId, HEAD);

  // Approved at an older commit whose GitHub record names no commit: treated as
  // not this head, so the head is approved.
  const unknown = await make({ decision: { state: "APPROVED", commitId: null } });
  await decide(unknown);
  assert.equal(approvals(unknown.calls).length, 1);

  // Approved at an older commit, but an App thread is open: no approval.
  const blocked = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: "c".repeat(40) } });
  await decide(blocked);
  assert.equal(approvals(blocked.calls).length, 0);

  // Approved at an older commit, and the head has no complete review yet: no
  // approval, and the notice says pending.
  const unreviewed = await make({ decision: { state: "APPROVED", commitId: "c".repeat(40) }, reviewed: "b".repeat(40) });
  await decide(unreviewed);
  assert.equal(approvals(unreviewed.calls).length, 0);

  // Approved at an older commit and a writer's resolve or approve forces a
  // decision while the head (a bot's push, say) has no complete review: the
  // renewal still waits for that review. A forced first approval is a
  // writer's own call; renewing one over unreviewed commits never is.
  const forced = await make({ decision: { state: "APPROVED", commitId: "c".repeat(40) }, reviewed: "b".repeat(40) });
  await decide(forced, { force: true, login: "rishitank" });
  assert.equal(approvals(forced.calls).length, 0);

  // Renewed once, then the same decision asked for three more times: still one.
  const repeat = await make({ decision: { state: "APPROVED", commitId: "c".repeat(40) } });
  for (let i = 0; i < 4; i++) await decide(repeat);
  assert.equal(approvals(repeat.calls).length, 1);

  // GitHub's list was too long to read whole: the decision is unknown, so
  // nothing is approved (never once per trigger).
  const truncated = await make({ decision: { state: "APPROVED", commitId: "c".repeat(40), truncated: true } });
  await decide(truncated);
  assert.equal(approvals(truncated.calls).length, 0);

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

test("a reopened thread withdraws every approval of the App's that still stands, not only the latest", async () => {
  // A renewal leaves the older approval standing too; both are dismissed.
  const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 77, approvedIds: [55, 77] } });
  const dismissed = [];
  m.fx.dismissReview = async (_r, _p, id) => { dismissed.push(id); return true; };
  await decide(m, { reopened: true });
  assert.deepEqual(dismissed.sort(), [55, 77]);
  assert.equal(m.calls.filter((c) => c[0] === "postReview").length, 0);

  // One refused: changes are requested, so nothing still reads as approved.
  const r = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 77, approvedIds: [55, 77] } });
  r.fx.dismissReview = async (_r, _p, id) => id === 77;
  await decide(r, { reopened: true });
  assert.equal(r.calls.filter((c) => c[0] === "postReview").length, 1);
});

test("a reopen keeps withdrawing while any approval of the App's still stands, even when the latest is dismissed", async () => {
  // A retry after a partial withdrawal: the latest review is dismissed, but 55
  // still approves. It is dismissed, and a refusal still requests changes.
  for (const [ok, posted] of [[true, 0], [false, 1]]) {
    const m = await make({ threads: [thread("t1", false)], decision: { state: "DISMISSED", commitId: HEAD, id: 77, approvedIds: [55] } });
    const dismissed = [];
    m.fx.dismissReview = async (_r, _p, id) => { dismissed.push(id); return ok; };
    await decide(m, { reopened: true });
    assert.deepEqual(dismissed, [55]);
    assert.equal(m.calls.filter((c) => c[0] === "postReview").length, posted, `ok=${ok}`);
  }
});

test("a withdrawal whose change request GitHub files only as a comment is retried, not dropped", async () => {
  // Dismissal refused, and GitHub refuses the decision so postReview falls
  // back to a comment: the approval still stands, so the decision fails and
  // the outbox tries it again (within its limit), rather than removing it.
  const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 77, approvedIds: [77] } });
  m.fx.dismissReview = async () => false;
  m.fx.postReview = async (_r, _p, review) => { m.calls.push(["postReview", review]); return { inline: 0, event: "COMMENT" }; };
  await m.obj.outbox({ type: "decide", reopened: true });
  // Each failed alarm throws (Cloudflare retries it) and leaves the item stored.
  let thrown = 0;
  for (let i = 0; i < 3; i++) {
    m.obj.ctx.storage.alarm = null;
    try { await m.obj.alarm(); } catch (e) { thrown++; assert.match(String(e.message), /could not be withdrawn/); }
  }
  assert.equal(thrown, 3);
  assert.equal(m.calls.filter((c) => c[0] === "postReview").length, 3, "tried again each time");
  assert.ok(((await m.storage.get("outbox")) ?? []).some((x) => x.type === "decide"), "still waiting to be retried");
});

test("a withdrawal of many approvals is spread over alarms (Workers Free's 50 subrequests), and the holds use up no attempts", async () => {
  // 120 standing approvals: at most 20 are dismissed an alarm, so six alarms,
  // more than the outbox's five attempts; each one with progress is a hold.
  const ids = Array.from({ length: 120 }, (_, i) => i + 1);
  const m = await make({ threads: [thread("t1", false)] });
  let standing = [...ids];
  m.fx.reviewDecision = async () => ({ state: standing.length ? "APPROVED" : "DISMISSED", commitId: HEAD, id: 120, approvedIds: [...standing] });
  const perAlarm = [];
  let n = 0;
  m.fx.dismissReview = async (_r, _p, id) => { n++; standing = standing.filter((x) => x !== id); return true; };
  await m.obj.outbox({ type: "decide", reopened: true });
  let t = NOW;
  for (let i = 0; i < 20 && ((await m.storage.get("outbox")) ?? []).length; i++) {
    n = 0;
    t += 60_000;
    m.setNow(t);
    m.obj.ctx.storage.alarm = null;
    await m.obj.alarm();
    if (n) perAlarm.push(n);
  }
  assert.deepEqual(standing, [], "every approval withdrawn");
  assert.ok(perAlarm.every((x) => x <= 20), `at most 20 an alarm: ${perAlarm}`);
  assert.equal(perAlarm.length, 6);
  assert.equal(m.calls.filter((c) => c[0] === "postReview").length, 0, "all dismissed: no change request");
  assert.equal(((await m.storage.get("outbox")) ?? []).length, 0);

  // A refusal within a batch requests changes at once: nothing waits.
  const r = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 120, approvedIds: ids } });
  r.fx.dismissReview = async (_r, _p, id) => id !== 3;
  await decide(r, { reopened: true });
  assert.equal(r.calls.filter((c) => c[0] === "postReview" && c[1].event === "REQUEST_CHANGES").length, 1);

  // Truncated: the known approvals go first, then changes are requested.
  const tr = await make({ threads: [thread("t1", false)] });
  let left = [...ids];
  tr.fx.reviewDecision = async () => ({ state: left.length ? "APPROVED" : "DISMISSED", commitId: HEAD, id: 120, approvedIds: [...left], truncated: true });
  const order = [];
  tr.fx.dismissReview = async (_r, _p, id) => { order.push("dismiss"); left = left.filter((x) => x !== id); return true; };
  const post = tr.fx.postReview;
  tr.fx.postReview = async (...a) => { order.push("post"); return post(...a); };
  await tr.obj.outbox({ type: "decide", reopened: true });
  t = NOW;
  for (let i = 0; i < 20 && ((await tr.storage.get("outbox")) ?? []).length; i++) {
    t += 60_000;
    tr.setNow(t);
    tr.obj.ctx.storage.alarm = null;
    await tr.obj.alarm();
  }
  assert.deepEqual(left, []);
  assert.equal(order.filter((x) => x === "post").length, 1);
  assert.equal(order.at(-1), "post", "changes requested after every known dismissal");
});

test("a reopen with a review list too long to read whole also requests changes, since an approval may be unlisted", async () => {
  const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 77, approvedIds: [77], truncated: true } });
  m.fx.dismissReview = async () => true;
  await decide(m, { reopened: true });
  assert.equal(m.calls.filter((c) => c[0] === "postReview" && c[1].event === "REQUEST_CHANGES").length, 1);
});

test("a review list too long to read whole with no decision of the App's in it approves nothing, forced or not", async () => {
  for (const force of [false, true]) {
    const m = await make({ decision: { state: null, commitId: null, id: null, approvedIds: [], truncated: true } });
    await decide(m, { force, login: "rishitank" });
    assert.equal(approvals(m.calls).length, 0, `force=${force}`);
  }
});

test("a reopen with a truncated list withdraws even when no approval is known, since one may be unlisted", async () => {
  for (const decision of [
    { state: null, commitId: null, id: null, approvedIds: [], truncated: true },
    { state: "DISMISSED", commitId: HEAD, id: 77, approvedIds: [], truncated: true },
  ]) {
    const m = await make({ threads: [thread("t1", false)], decision });
    m.fx.dismissReview = async () => true;
    await decide(m, { reopened: true });
    assert.equal(m.calls.filter((c) => c[0] === "postReview" && c[1].event === "REQUEST_CHANGES").length, 1, String(decision.state));
  }
  // A complete list with no standing approval: nothing to withdraw.
  const none = await make({ threads: [thread("t1", false)], decision: { state: "DISMISSED", commitId: HEAD, id: 77, approvedIds: [], truncated: false } });
  await decide(none, { reopened: true });
  assert.equal(none.calls.filter((c) => c[0] === "postReview").length, 0);
});

test("a forced decision never approves an unreviewed head while any approval of the App's still stands", async () => {
  // The latest review was dismissed (a partial withdrawal) but 55 still stands:
  // this is not a first approval, so the head's complete review is required.
  const m = await make({ decision: { state: "DISMISSED", commitId: "c".repeat(40), id: 77, approvedIds: [55] }, reviewed: "b".repeat(40) });
  await decide(m, { force: true, login: "rishitank" });
  assert.equal(approvals(m.calls).length, 0);
  // With nothing standing, a forced first approval is still the writer's call.
  const first = await make({ decision: { state: "DISMISSED", commitId: "c".repeat(40), id: 77, approvedIds: [] }, reviewed: "b".repeat(40) });
  await decide(first, { force: true, login: "rishitank" });
  assert.equal(approvals(first.calls).length, 1);
  // And once the head is reviewed in full, the renewal goes ahead.
  const covered = await make({ decision: { state: "DISMISSED", commitId: "c".repeat(40), id: 77, approvedIds: [55] } });
  await decide(covered);
  assert.equal(approvals(covered.calls).length, 1);
});

test("after a reopen dismisses the approval, the head is approved again only once its threads are resolved", async () => {
  const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 77 } });
  m.fx.dismissReview = async () => { m.w.decision = { state: "DISMISSED", commitId: HEAD, id: 77 }; return true; };
  await decide(m, { reopened: true });
  await decide(m);
  assert.equal(approvals(m.calls).length, 0, "still open");
  m.w.threads[0].resolved = true;
  await decide(m);
  assert.equal(approvals(m.calls).length, 1);
});

test("a stale approval is withdrawn by dismissing it, as CodeRabbit's; only if GitHub refuses are changes requested", async () => {
  for (const [ok, posted] of [[true, 0], [false, 1]]) {
    const m = await make({ threads: [thread("t1", false)], decision: { state: "APPROVED", commitId: HEAD, id: 77 } });
    m.fx.dismissReview = async (_r, _p, id, message) => { m.calls.push(["dismissReview", id, message]); return ok; };
    await decide(m, { reopened: true });
    const [[, id, message]] = m.calls.filter((c) => c[0] === "dismissReview");
    assert.equal(id, 77);
    assert.match(message, /reopened/);
    assert.equal(m.calls.filter((c) => c[0] === "postReview").length, posted, `dismissed=${ok}`);
  }
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
  // One that did not cover every file asks too, so the summary's notice says
  // approval is pending (the head has no complete review, so it cannot approve).
  const partial = await make({ reviewed: "b".repeat(40) });
  await partial.obj.runDone({ id: "j1" }, { reviewedSha: null });
  assert.ok(((await partial.storage.get("outbox")) ?? []).some((x) => x.type === "decide"));
  await decide(partial);
  assert.equal(approvals(partial.calls).length, 0);
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
    assert.equal(review.body, "", "an approval with no text, as CodeRabbit's");
  }

  // Someone without write access: refused, nothing resolved.
  const no = await make({ threads: [thread("t1", false)], writers: [] });
  await no.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "stranger", bot: false }, text: "@tankster-ai-review approve" } });
  await drain(no.obj);
  assert.equal(no.calls.some((c) => c[0] === "resolveThread" || c[0] === "approve"), false);

  // In a review thread's replies `approve` is not a command (CodeRabbit's rule).
  const reply = await make({ threads: [thread("t1", false)] });
  const r = await reply.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "thread", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review approve" } });
  assert.equal(r.action, "not_a_command");
});

test("resolve as a reply in one of the App's threads resolves that thread only, then decides", async () => {
  const threads = [{ ...thread("t1", false), commentId: 101 }, { ...thread("t2", false), commentId: 202 }];
  for (const [inReplyTo, id] of [[202, "t2"], [101, "t1"]]) {
    const n = await make({ threads: threads.map((t) => ({ ...t })) });
    const out = await n.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "thread", repo, pr: 39, sender: { login: "rishitank", bot: false }, commentId: 999, inReplyTo, text: "@tankster-ai-review resolve" } });
    assert.equal(out.cmd, "resolve");
    await drain(n.obj);
    assert.deepEqual(n.calls.filter((c) => c[0] === "resolveThread").map((c) => c[1]), [id]);
    assert.ok((await acceptedSet(n.storage)).has(id));
    assert.equal(approvals(n.calls).length, 0, "the other thread is still open");
  }
  // A reply in a thread that is not the App's: nothing happens.
  const other = await make({ threads });
  await other.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "thread", repo, pr: 39, sender: { login: "rishitank", bot: false }, commentId: 999, inReplyTo: 555, text: "@tankster-ai-review resolve" } });
  await drain(other.obj);
  assert.equal(other.calls.some((c) => c[0] === "resolveThread"), false);
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
  assert.deepEqual([...(await reopenedSet(m.storage))], ["PRRT_9"]);
  // An outsider's resolve keeps the mark.
  await m.obj.onEvent({ delivery: "d2", ev: ev("resolved", "stranger") });
  await drain(m.obj);
  assert.deepEqual([...(await reopenedSet(m.storage))], ["PRRT_9"]);
  await m.obj.onEvent({ delivery: "d3", ev: ev("resolved") });
  await drain(m.obj);
  assert.deepEqual([...(await reopenedSet(m.storage))], []);

  // A writer resolves, then it is reopened again before that resolve is
  // checked: the newer mark stays.
  await m.obj.onEvent({ delivery: "d4", ev: ev("unresolved") });
  await m.obj.onEvent({ delivery: "d5", ev: ev("resolved") });
  await m.obj.onEvent({ delivery: "d6", ev: ev("unresolved") });
  await drain(m.obj);
  assert.deepEqual([...(await reopenedSet(m.storage))], ["PRRT_9"]);
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
  await m.storage.put("reopened:PRRT_1", 1);
  await acceptThreads(m.storage, ["PRRT_2"]);
  await m.storage.put("summaryComment", 5);
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "closed", repo, pr: 39, merged: true } });
  await m.storage.put("reopenSeq", 3);
  await m.obj.onEvent({ delivery: "d9", ev: { kind: "closed", repo, pr: 39, merged: true } });
  for (const k of ["summaryComment", "reopenSeq"]) assert.equal(await m.storage.get(k), undefined, k);
  assert.equal((await reopenedSet(m.storage)).size, 0);
  assert.equal((await acceptedSet(m.storage)).size, 0);
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
  await acceptThreads(acc.storage, ["t1"]);
  await decide(acc);
  assert.equal(approvals(acc.calls).length, 1);
});

test("a writer's approve vouches for stranger-resolved threads for later decisions too; a reopen takes that back", async () => {
  const m = await make({ threads: [{ id: "t1", resolved: true, resolvedBy: "stranger" }] });
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review approve" } });
  await drain(m.obj);
  assert.deepEqual([...(await acceptedSet(m.storage))], ["t1"]);
  await m.obj.onEvent({ delivery: "d2", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t1" } });
  assert.deepEqual([...(await acceptedSet(m.storage))], []);
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
  assert.equal((await acceptedSet(m.storage)).size, 700);
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

test("reopen marks are never evicted: 2,001 reopens keep every mark until a writer resolves", async () => {
  const m = await make();
  for (let i = 0; i < 2001; i++) {
    await m.obj.onEvent({ delivery: `d${i}`, ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: `T${i}` } });
  }
  const marks = await reopenedSet(m.storage);
  assert.equal(marks.size, 2001);
  assert.ok(marks.has("T0"), "the oldest mark is kept");
  assert.equal(await reopenMark(m.storage, "T0"), 1);
});

test("an accepted thread stays accepted however many others are accepted after it", async () => {
  const m = await make({ threads: [{ id: "T", resolved: true, resolvedBy: "stranger" }] });
  await acceptThreads(m.storage, ["T"]);
  // 1,999 stale ids (threads no longer listed), then a new acceptance.
  await acceptThreads(m.storage, Array.from({ length: 1999 }, (_, i) => `stale${i}`));
  await acceptThreads(m.storage, ["U"]);
  assert.ok((await acceptedSet(m.storage)).has("T"));
  // A later ordinary decision still counts T as resolved.
  await decide(m);
  assert.equal(approvals(m.calls).length, 1);
});

test("a thread reopened while resolve is running is not vouched for", async () => {
  const m = await make({ threads: [thread("t1", false), { id: "t2", resolved: true, resolvedBy: "stranger" }], writers: ["rishitank"] });
  const resolve = m.fx.resolveThread;
  let n = 0;
  m.fx.resolveThread = async (r, id) => {
    // A reopen lands while GitHub's call is pending.
    if (n++ === 0) await m.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t2" } });
    return resolve(r, id);
  };
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  m.storage.alarm = null;
  await m.obj.alarm();
  const accepted = await acceptedSet(m.storage);
  assert.ok(accepted.has("t1"));
  assert.equal(accepted.has("t2"), false, "the reopen keeps its acceptance removed");
});

test("a heavy item keeps a backing-off review's deadline: neither earlier nor later", async () => {
  const m = await make();
  await m.storage.put("runmeta:j1", { id: "j1", stage: "draft" });
  await m.storage.put({ runFailures: 3, runRetryAt: NOW + 120_000 });
  m.obj.stepActiveRun = async () => { throw new Error("must not step"); };
  // The decision arrives 119 s into the wait.
  m.setNow(NOW + 119_000);
  await m.obj.outbox({ type: "decide" });
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(approvals(m.calls).length, 1);
  assert.equal(m.storage.alarm, NOW + 120_000, "the original deadline");
  assert.equal(await m.storage.get("runFailures"), 3, "its failure count is kept");
});

test("a failed step stores its retry deadline; a good step clears it", async () => {
  const m = await make();
  await m.storage.put("runmeta:j1", { id: "j1", stage: "draft", createdAt: NOW });
  let fail = true;
  m.obj.stepActiveRun = async () => { if (fail) throw new Error("boom"); return null; };
  m.storage.alarm = null;
  await m.obj.alarm();
  const at = await m.storage.get("runRetryAt");
  assert.ok(at > NOW);
  assert.equal(m.storage.alarm, at);
  fail = false;
  m.setNow(at);
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(await m.storage.get("runRetryAt"), undefined);
});

test("a forced decision does not approve over a thread reopened during resolve and then resolved by an outsider", async () => {
  const threads = [thread("t1", false), { id: "t2", resolved: true, resolvedBy: "stranger" }];
  const m = await make({ threads, writers: ["rishitank"] });
  const resolve = m.fx.resolveThread;
  let n = 0;
  m.fx.resolveThread = async (r, id) => {
    if (n++ === 0) await m.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t2" } });
    return resolve(r, id);
  };
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  m.storage.alarm = null;
  await m.obj.alarm();
  // Then an outsider resolves t2, before the forced decision runs.
  await m.obj.onEvent({ delivery: "r2", ev: { kind: "thread", action: "resolved", repo, pr: 39, sender: { login: "stranger", bot: false }, threadId: "t2" } });
  await drain(m.obj);
  assert.equal(approvals(m.calls).length, 0);
});

test("resolve vouches for the threads as they stood when it was posted, across its steps", async () => {
  // Over 20 open threads, so it takes two steps; X is reopened and then
  // resolved by an outsider in between.
  const threads = Array.from({ length: 25 }, (_, i) => thread(`t${i}`, false));
  threads.push({ id: "X", resolved: true, resolvedBy: "stranger" });
  const m = await make({ threads, writers: ["rishitank"] });
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  m.storage.alarm = null;
  await m.obj.alarm();
  await m.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "stranger", bot: false }, threadId: "X" } });
  await m.obj.onEvent({ delivery: "r2", ev: { kind: "thread", action: "resolved", repo, pr: 39, sender: { login: "stranger", bot: false }, threadId: "X" } });
  for (let i = 0; i < 10 && ((await m.storage.get("outbox")) ?? []).length; i++) {
    if (m.storage.alarm > NOW) m.setNow(m.storage.alarm);
    m.storage.alarm = null;
    await m.obj.alarm();
  }
  assert.equal((await acceptedSet(m.storage)).has("X"), false);
  assert.equal(approvals(m.calls).length, 0);
});

test("no outbox item steps a review before its retry deadline", async () => {
  const m = await make();
  await m.storage.put("runmeta:j1", { id: "j1", stage: "draft", createdAt: NOW });
  await m.storage.put({ runFailures: 2, runRetryAt: NOW + 60_000 });
  let stepped = 0;
  m.obj.stepActiveRun = async () => { stepped++; return null; };
  await m.obj.outbox({ type: "comment", template: "gave_up", reason: "x", tries: 1 });
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(stepped, 0);
  assert.equal(await m.storage.get("runRetryAt"), NOW + 60_000, "the deadline stands");
  m.setNow(NOW + 60_000);
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.equal(stepped, 1);
  assert.equal(await m.storage.get("runRetryAt"), undefined);
});

test("an open nitpick thread does not hold back approval; an open issue thread does", async () => {
  const nit = { id: "n1", resolved: false, body: "**Trivial (maintainability): Name it better**\n<sub>Nitpick · finding `aaaaaaaa`</sub>\n\nx" };
  const typed = { id: "n2", resolved: false, body: "**Minor (maintainability): Tidy**\n<sub>Nitpick · finding `bbbbbbbb`</sub>\n\nx" };
  const ok = await make({ threads: [nit, typed] });
  await decide(ok);
  assert.equal(approvals(ok.calls).length, 1);
  const issue = { id: "i1", resolved: false, body: "**Minor (bug): Off by one**\n<sub>Potential issue · finding `cccccccc`</sub>\n\nx" };
  const blocked = await make({ threads: [nit, issue] });
  await decide(blocked);
  assert.equal(approvals(blocked.calls).length, 0);
});

test("closing a pull request clears a backing-off run's retry state", async () => {
  const m = await make();
  await m.storage.put({ runFailures: 4, runRetryAt: NOW + 60_000 });
  await m.obj.onEvent({ delivery: "c1", ev: { kind: "closed", repo, pr: 39, merged: false } });
  assert.equal(await m.storage.get("runFailures"), undefined);
  assert.equal(await m.storage.get("runRetryAt"), undefined);
});

test("a kept finding that is a nitpick does not hold back approval; an actionable one does", async () => {
  const nit = await make();
  await keepOpenFindings(nit.storage, [{ id: "aaaaaaaa", path: "a.js", line: 1, text: "**Trivial (maintainability): Name it**\n<sub>Nitpick · finding `aaaaaaaa`</sub>", sha: HEAD }]);
  await decide(nit);
  assert.equal(approvals(nit.calls).length, 1);
  const issue = await make();
  await keepOpenFindings(issue.storage, [{ id: "bbbbbbbb", path: "a.js", line: 1, text: "**Critical (security): Leak**\n<sub>Nitpick · finding `bbbbbbbb`</sub>", sha: HEAD }]);
  await decide(issue);
  assert.equal(approvals(issue.calls).length, 0);
});

test("a kept finding whose model title imitates a nitpick label still blocks", async () => {
  // review.listed keeps `${title}\n\n${body}`: the first line is the model's.
  for (const severe of [true, false]) {
    const m = await make();
    await keepOpenFindings(m.storage, [{ id: "cccccccc", path: "a.js", line: 9, text: "**Trivial (style): looks fine**\n\nIt is not.", sha: HEAD, severe }]);
    await decide(m);
    assert.equal(approvals(m.calls).length, 0, `severe=${severe}`);
  }
});

test("a kept finding with a nitpick header but kept as severe still blocks", async () => {
  const text = "**Trivial (maintainability): Name it**\n<sub>Nitpick · finding `dddddddd`</sub>\n\nx";
  for (const [severe, approved] of [[true, 0], [false, 1]]) {
    const m = await make();
    await keepOpenFindings(m.storage, [{ id: "dddddddd", path: "a.js", line: 2, text, sha: HEAD, severe }]);
    await decide(m);
    assert.equal(approvals(m.calls).length, approved, `severe=${severe}`);
  }
});

test("the summary comment says why approval is withheld, with links to the open threads, then that it is approved", async () => {
  const m = await make({ threads: [{ ...thread("t1", false), commentId: 501 }, { ...thread("t2", true), commentId: 502 }] });
  const summaries = [];
  m.fx.upsertSummary = async (_r, _p, id, body) => { summaries.push({ id, body }); return 9; };
  await m.storage.put("summaryBase", "### Tankster AI Review\n\n**Latest review:** commit `aaaaaaa`.");
  await decide(m);
  assert.equal(summaries.length, 1);
  const [first] = summaries;
  assert.match(first.body, /^### Tankster AI Review\n\n\*\*Automatic approval withheld\*\*/);
  assert.match(first.body, /1 review thread is still open and must be resolved first:\n\n- \[Thread 1\]\(https:\/\/github\.com\/TanksterAI\/browser-relay\/pull\/39#discussion_r501\)/);
  assert.match(first.body, /post `@tankster-ai-review approve` as a new top-level comment/);
  assert.match(first.body, /\*\*Latest review:\*\* commit `aaaaaaa`\./, "the review's own text is kept");
  // The same decision again writes nothing.
  await decide(m);
  assert.equal(summaries.length, 1);
  // Resolved: approved, and the notice says so.
  m.w.threads[0].resolved = true;
  await decide(m);
  assert.equal(approvals(m.calls).length, 1);
  assert.match(summaries.at(-1).body, /\*\*Automatic approval\*\*: approved at commit `[0-9a-f]{12}`\./);
  assert.doesNotMatch(summaries.at(-1).body, /withheld/);
});

test("the notice says approval is pending while the head has no complete review; nothing before a review wrote the summary", async () => {
  const m = await make({ reviewed: "b".repeat(40) });
  const summaries = [];
  m.fx.upsertSummary = async (_r, _p, id, body) => { summaries.push(body); return 9; };
  await decide(m);
  assert.equal(summaries.length, 0, "no summary yet: nothing to add to");
  await m.storage.put("summaryBase", "### Tankster AI Review");
  await decide(m);
  assert.match(summaries[0], /\*\*Automatic approval pending\*\*: commit `[0-9a-f]{12}` has no complete review yet\./);
});

test("a reopen after the approval turns the summary's notice back to withheld, with the open thread", async () => {
  const m = await make({ threads: [{ ...thread("t1", false), commentId: 501 }], decision: { state: "APPROVED", commitId: HEAD, id: 77 } });
  const summaries = [];
  m.fx.upsertSummary = async (_r, _p, _id, body) => { summaries.push(body); return 9; };
  m.fx.dismissReview = async () => true;
  await m.storage.put("summaryBase", "### Tankster AI Review");
  await m.storage.put("summaryNotice", `**Automatic approval**: approved at commit \`${HEAD.slice(0, 12)}\`.`);
  await decide(m, { reopened: true });
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /\*\*Automatic approval withheld\*\*[\s\S]*#discussion_r501/);
  assert.doesNotMatch(summaries[0], /approved at commit/);
});

test("a thread reopened after a resolve command was posted is left open, not resolved by the App", async () => {
  // Thread reply: the command is numbered 0, the reopen 1 (before the alarm).
  const one = await make({ threads: [{ ...thread("t1", false), commentId: 101 }] });
  await one.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "thread", repo, pr: 39, sender: { login: "rishitank", bot: false }, commentId: 999, inReplyTo: 101, text: "@tankster-ai-review resolve" } });
  await one.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t1" } });
  await drain(one.obj);
  assert.equal(one.calls.filter((c) => c[0] === "resolveThread").length, 0);
  assert.equal((await acceptedSet(one.storage)).has("t1"), false);
  assert.equal(approvals(one.calls).length, 0);

  // Top-level: the reopened thread stays open, the others are resolved.
  const all = await make({ threads: [thread("t1", false), thread("t2", false)] });
  await all.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  await all.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t2" } });
  await drain(all.obj);
  assert.deepEqual(all.calls.filter((c) => c[0] === "resolveThread").map((c) => c[1]), ["t1"]);
  assert.equal(all.w.threads[1].resolved, false);
  assert.equal(approvals(all.calls).length, 0, "the newer reopen holds approval back");
});

test("a reopen during resolve's own GitHub call is never vouched for, nor resolved by the App", async () => {
  const reopen = (m, id, d) => m.obj.onEvent({ delivery: d, ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: id } });
  // Thread reply: the reopen lands while that thread is being resolved.
  const one = await make({ threads: [{ ...thread("t1", false), commentId: 101 }] });
  const r1 = one.fx.resolveThread;
  one.fx.resolveThread = async (r, id) => { const ok = await r1(r, id); await reopen(one, "t1", "r1"); one.w.threads[0].resolved = false; return ok; };
  await one.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "thread", repo, pr: 39, sender: { login: "rishitank", bot: false }, commentId: 999, inReplyTo: 101, text: "@tankster-ai-review resolve" } });
  await drain(one.obj);
  assert.equal((await acceptedSet(one.storage)).has("t1"), false);
  assert.equal(approvals(one.calls).length, 0);

  // Top-level: t2 is reopened while t1 is being resolved; t2 is not resolved.
  const all = await make({ threads: [thread("t1", false), thread("t2", false)] });
  const r2 = all.fx.resolveThread;
  let first = true;
  all.fx.resolveThread = async (r, id) => { if (first) { first = false; await reopen(all, "t2", "r2"); } return r2(r, id); };
  await all.obj.onEvent({ delivery: "d1", ev: { kind: "command", where: "conversation", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review resolve" } });
  await drain(all.obj);
  assert.deepEqual(all.calls.filter((c) => c[0] === "resolveThread").map((c) => c[1]), ["t1"]);
  assert.equal(approvals(all.calls).length, 0);
});

test("decide: a thread the App resolved while a person's reopen stands counts as open, unless a command accepted it", async () => {
  for (const [accept, approved] of [[false, 0], [true, 1]]) {
    const m = await make({ threads: [{ ...thread("t1", true), resolvedBy: "tankster-ai-review" }] });
    await m.storage.put("reopened:t1", 3);
    if (accept) await acceptThreads(m.storage, ["t1"]);
    await decide(m);
    assert.equal(approvals(m.calls).length, approved, `accepted=${accept}`);
  }
});

test("a reopen while a reopened decision's GitHub reads are pending still withdraws the approval", async () => {
  const reopen = (m, id) => m.obj.onEvent({ delivery: `r-${id}`, ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: id } });
  // The decision for one reopen is running; another thread is reopened while
  // its thread list is fetched, and finds that decision still waiting, so no
  // new one is queued. The list that comes back is the stale one.
  const m = await make({ threads: [{ ...thread("t1", true), resolvedBy: "rishitank" }], decision: { state: "APPROVED", commitId: HEAD, id: 77 } });
  await acceptThreads(m.storage, ["t1"]);
  const dismissed = [];
  m.fx.dismissReview = async (_r, _p, id) => { dismissed.push(id); return true; };
  const own = m.fx.ownThreads;
  let first = true;
  m.fx.ownThreads = async (...a) => { const out = (await own(...a)).map((t) => ({ ...t })); if (first) { first = false; await reopen(m, "t1"); m.w.threads[0].resolved = false; } return out; };
  await decide(m, { reopened: true });
  assert.deepEqual(dismissed, [77], "the approval is withdrawn, from a fresh snapshot");
  assert.equal((await acceptedSet(m.storage)).has("t1"), false);
});

test("a reopen between the snapshot and the last head check is decided again, not approved", async () => {
  const m = await make({ threads: [thread("t1", true)] });
  const pr = m.fx.pullRequest;
  let n = 0;
  m.fx.pullRequest = async (...a) => { if (++n === 2) { await m.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "t1" } }); m.w.threads[0].resolved = false; } return pr(...a); };
  await decide(m);
  assert.equal(approvals(m.calls).length, 0);
});

test("a retry after a reopen during the final head check keeps its kind: a nitpick reopen still ends in approval", async () => {
  const nit = { id: "n1", resolved: true, resolvedBy: "rishitank", body: "**Trivial (maintainability): Name it better**\n<sub>Nitpick · finding `aaaaaaaa`</sub>\n\nx" };
  const m = await make({ threads: [nit] });
  const pr = m.fx.pullRequest;
  let n = 0;
  m.fx.pullRequest = async (...a) => { if (++n === 2) { await m.obj.onEvent({ delivery: "r1", ev: { kind: "thread", action: "unresolved", repo, pr: 39, sender: { login: "rishitank", bot: false }, threadId: "n1" } }); m.w.threads[0].resolved = false; } return pr(...a); };
  await decide(m);
  assert.equal(approvals(m.calls).length, 1, "an ordinary replacement approves: only a nitpick is open");
});

test("a retarget during the decision is decided again, not approved from the old base's review", async () => {
  const m = await make({ threads: [thread("t1", true)] });
  const pr = m.fx.pullRequest;
  let n = 0;
  m.fx.pullRequest = async (...a) => {
    // The final head check: the base changes while it is pending. The head is the same.
    if (++n === 2) await m.obj.onEvent({ delivery: "e1", ev: { kind: "review", action: "edited", repo, pr: 39, sender: { login: "rishitank", bot: false }, head: { sha: HEAD }, baseRef: "release", draft: false, fork: false, author: { login: "rishitank", association: "OWNER", bot: false } } });
    return pr(...a);
  };
  await decide(m);
  assert.equal(approvals(m.calls).length, 0, "the review was of the old base");
});

test("an approval on an unchanged base still proceeds", async () => {
  const m = await make({ threads: [thread("t1", true)] });
  await m.obj.ctx.storage.put("state", { lastReviewed: HEAD, lastCompleteReviewed: HEAD, paused: false, closed: false, baseEpoch: 2 });
  await decide(m);
  assert.equal(approvals(m.calls).length, 1);
});
