// The PR's Durable Object running the review itself (REVIEW_MODE=worker, the
// default): no runner, every file covered, one review at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrState } from "../src/pr-state.js";
import { askedFindings, memoryKv, memoryStorage, testSleep } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 14, 21, 0, 0);
const repo = { full: "TanksterAI/browser-relay", name: "browser-relay", ownerId: "259206056" };
const sha = (c) => c.repeat(40);

function added(n, word) {
  return `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const ${word}${i} = compute(${i}, "${"x".repeat(40)}");`).join("\n")}`;
}

function world({ files, head = sha("a") } = {}) {
  const state = { head, files: files ?? Array.from({ length: 12 }, (_, i) => ({ filename: `src/f${i}.js`, status: "added", additions: 300, deletions: 0, patch: added(300, `f${i}_`) })), compare: null };
  const calls = [];
  const fx = {
    calls, posted: [], statuses: [],
    async comment(r, pr, body) { calls.push(["comment", body]); },
    async canWrite() { return true; },
    async dispatch(id) { calls.push(["dispatch", id]); },
    async pullRequest() { calls.push(["pullRequest"]); return { state: "open", head: { sha: state.head }, base: { sha: sha("b") }, title: "t", body: "b", changed_files: state.files.length }; },
    async listFiles(_r, _p, page) { calls.push(["listFiles", page]); return state.files.slice((page - 1) * 100, page * 100); },
    async compare(_r, base, headSha) { calls.push(["compare", base, headSha]); return state.compare?.(base, headSha) ?? { status: "diverged", merge_base_commit: { sha: sha("c") }, files: [] }; },
    async blob() { return null; },
    async fileSha() { return null; },
    async setStatus(_r, s, st, d) { fx.statuses.push({ sha: s, state: st, description: d }); return true; },
    async postReview(_r, _p, review) { fx.posted.push(review); return { inline: review.comments.length }; },
    async prLines() { return new Map(); },
  };
  return { state, fx };
}

const reply = (status, data) => ({ ok: status === 200, status, headers: { get: () => null }, async json() { return data; } });
const models = Object.assign(async (url, init) => {
  const body = JSON.parse(init.body);
  if (url.includes("generativelanguage")) return reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"summary":"s","findings":[]}' }] } }] });
  const asked = askedFindings(body.messages[0].content);
  return reply(200, { content: [{ type: "text", text: JSON.stringify({ verdicts: asked.map((f) => ({ id: f.id, verdict: "confirmed", severity: f.severity, suggestion_ok: false, prompt_ok: false, reason: "r" })) }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } });
}, {});

function make(w = world()) {
  let t = NOW;
  const storage = memoryStorage();
  const env = { LEDGER: memoryKv(), GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "sk", VERIFY: "", DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,gemini:gemma-4-31b-it", BATCH_CHARS: "30000" };
  const obj = new PrState({ storage }, env, { now: () => t, effects: w.fx, fetch: models, sleep: testSleep });
  return { obj, storage, env, ...w, now: () => t, set: (x) => { t = x; } };
}

const ev = (over = {}) => ({
  kind: "review", action: "opened", repo, pr: 39, sender: { login: "rishitank", bot: false }, head: { sha: sha("a") },
  fork: false, draft: false, author: { login: "rishitank", association: "OWNER", bot: false }, ...over,
});

// Fires the alarm until nothing is due (moving time to each wake-up), as the
// runtime would. Stops once the clock would pass `until`.
async function settle(m, until = NOW + 3600_000) {
  for (let i = 0; i < 400; i++) {
    const at = m.storage.alarm;
    if (at === null || at === undefined || at > until) return;
    if (at > m.now()) m.set(at);
    m.storage.alarm = null;
    await m.obj.alarm();
  }
  throw new Error("the alarm never settled");
}

test("an opened PR is reviewed by the Worker itself: no runner, every file, one review, a status", async () => {
  const m = make();
  await m.obj.onEvent({ delivery: "d1", ev: ev() });
  await settle(m);
  assert.ok(!m.fx.calls.some((c) => c[0] === "dispatch"), "no runner was started");
  assert.equal(m.fx.posted.length, 1);
  assert.match(m.fx.posted[0].body, /Coverage: 12 of 12 reviewable files \(100%\), [\d,]+ characters of diff, in \d+ passes\./);
  assert.equal(m.fx.statuses.at(-1).state, "success");
  const st = await m.storage.get("state");
  assert.equal(st.lastReviewed, sha("a"));
  // Nothing is left behind: no job, no run state.
  assert.deepEqual([...(await m.storage.list({ prefix: "job:" })).keys()], []);
  assert.deepEqual([...(await m.storage.list({ prefix: "run" })).keys()], [], "no run: or runmeta: keys are left");
});

test("a push during a review waits for it, then the next review covers only the new commits", async () => {
  const m = make();
  await m.obj.onEvent({ delivery: "d1", ev: ev() });
  // A few steps in, someone asks for a review of a newer push.
  for (let i = 0; i < 3; i++) { m.storage.alarm = null; await m.obj.alarm(); }
  m.state.head = sha("e");
  m.state.compare = (base) => (base === sha("a") ? { status: "ahead", files: [{ filename: "src/new.js", status: "added", additions: 2, deletions: 0, patch: added(2, "new_") }] } : null);
  await m.obj.onEvent({ delivery: "d2", ev: { kind: "command", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review review" } });
  await settle(m);
  // The first review finished on its own commit; the second read from it on.
  assert.equal(m.fx.posted.length, 2);
  assert.ok(m.fx.calls.some((c) => c[0] === "compare" && c[1] === sha("a") && c[2] === sha("e")));
  assert.match(m.fx.posted[1].body, /_Incremental review: commits after `aaaaaaa`\._/);
  assert.match(m.fx.posted[1].body, /Coverage: 1 of 1 reviewable file \(100%\)/);
  assert.equal((await m.storage.get("state")).lastReviewed, sha("e"));
});

test("closing the PR stops the review in progress: nothing is posted", async () => {
  const m = make();
  await m.obj.onEvent({ delivery: "d1", ev: ev() });
  for (let i = 0; i < 3; i++) { m.storage.alarm = null; await m.obj.alarm(); }
  await m.obj.onEvent({ delivery: "d2", ev: ev({ kind: "closed" }) });
  await settle(m);
  assert.equal(m.fx.posted.length, 0);
  assert.deepEqual([...(await m.storage.list({ prefix: "run" })).keys()], [], "no run: or runmeta: keys are left");
});

test("REVIEW_MODE=runner keeps the runner path", async () => {
  const w = world();
  const storage = memoryStorage();
  const obj = new PrState({ storage }, { REVIEW_MODE: "runner" }, { now: () => NOW, effects: w.fx });
  const out = await obj.onEvent({ delivery: "d1", ev: ev() });
  storage.alarm = null;
  await obj.alarm();
  assert.deepEqual(w.fx.calls.filter((c) => c[0] === "dispatch"), [["dispatch", out.jobId]]);
});

test("a PR closed while a step waits on a model: the step does not bring the review back", async () => {
  const m = make();
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  m.obj.fetchImpl = async (url, init) => {
    if (first && url.includes("generativelanguage")) { first = false; await held; }
    return models(url, init);
  };
  await m.obj.onEvent({ delivery: "d1", ev: ev() });
  // Steps until drafting starts and blocks on the model.
  let stepping = null;
  for (let i = 0; i < 10 && !stepping; i++) {
    m.storage.alarm = null;
    const p = m.obj.alarm();
    const done = await Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 20))]);
    if (!done) stepping = p;
  }
  assert.ok(stepping, "a step is waiting on the model");
  await m.obj.onEvent({ delivery: "d2", ev: ev({ kind: "closed" }) });
  release();
  await stepping;
  await settle(m);
  assert.equal(m.fx.posted.length, 0);
  assert.deepEqual([...(await m.storage.list({ prefix: "run" })).keys()], [], "no run: or runmeta: keys are left");
  assert.ok(!m.fx.statuses.some((s) => s.state === "error"), "no error status on a closed PR");
});

// --- from the independent review ----------------------------------------------

test("after a single-prompt review (the runner), the first Worker review covers the whole PR, not just the commits since", async () => {
  const m = make();
  m.state.compare = (base) => (base === sha("a") ? { status: "ahead", files: [{ filename: "src/new.js", status: "added", additions: 2, deletions: 0, patch: added(2, "new_") }] } : null);
  // The runner reviewed head a (in one prompt, skipping what did not fit).
  await m.storage.put("state", { lastReviewed: sha("a"), lastClaimedAt: NOW - 1, paused: false, closed: false });
  m.state.head = sha("e");
  await m.obj.onEvent({ delivery: "d1", ev: ev({ action: "synchronize" }) });
  await settle(m, NOW + 7200_000);
  assert.ok(m.fx.calls.some((c) => c[0] === "listFiles"), "the whole PR was listed");
  assert.ok(!m.fx.calls.some((c) => c[0] === "compare" && c[1] === sha("a")), "no review started from the runner's commit");
  assert.match(m.fx.posted[0].body, /Coverage: 12 of 12 reviewable files \(100%\)/);
  assert.equal((await m.storage.get("state")).lastCompleteReviewed, sha("e"));
});

test("a run step that throws does not hold up the outbox: commands are still answered", async () => {
  const m = make();
  m.obj.stepActiveRun = async () => { throw new Error("boom"); };
  await m.obj.onEvent({ delivery: "d1", ev: { kind: "command", repo, pr: 39, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-review pause" } });
  m.storage.alarm = null;
  await m.obj.alarm();
  assert.ok(m.fx.calls.some((c) => c[0] === "comment" && /paused/.test(c[1])));
  assert.ok(m.storage.alarm > m.now(), "the run is looked at again later");
});
