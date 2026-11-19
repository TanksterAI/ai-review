import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_PARALLEL, STEP_SUBREQUESTS, activeRun, mergeResults, rotatedChain, startRun, stepRun } from "../src/review-run.js";
import { config } from "../src/config.js";
import { parseFindingsBlock } from "../src/review.js";
import { askedFindings, memoryKv, memoryStorage, testSleep } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 14, 21, 0, 0);
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const repo = { full: "TanksterAI/ai-review", name: "ai-review" };

// A patch adding n distinctive lines to a new file.
function added(n, word) {
  return `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const ${word}${i} = compute(${i}, "${"x".repeat(40)}");`).join("\n")}`;
}
const file = (filename, patch, over = {}) => ({ filename, status: "added", additions: 1, deletions: 0, patch, sha: null, ...over });

// PR #9's shape: 18 files, about 214,000 characters, every test file and the
// README among them (the old reviewer skipped all of those).
const PR9 = [
  ...Array.from({ length: 10 }, (_, i) => file(`worker/src/m${i}.js`, added(180, `src${i}_`))),
  ...Array.from({ length: 7 }, (_, i) => file(`worker/test/m${i}.test.js`, added(180, `test${i}_`))),
  file("README.md", added(120, "doc_")),
];

function fakeGithub({ files = PR9, pr = {}, compare = null, blobs = new Map(), shas = new Map(), statusOk = true } = {}) {
  const calls = [];
  return {
    calls,
    statuses: [],
    posted: [],
    async pullRequest() { calls.push("pullRequest"); return { state: "open", head: { sha: HEAD }, base: { sha: BASE }, title: "feat: x", body: "Does x.", changed_files: files.length, ...pr }; },
    async listFiles(_r, _p, page) { calls.push(`listFiles:${page}`); return files.slice((page - 1) * 100, page * 100); },
    async compare(_r, base, head) {
      calls.push(`compare:${base.slice(0, 1)}...${head.slice(0, 1)}`);
      return compare?.(base, head) ?? { status: "diverged", merge_base_commit: { sha: MERGE_BASE }, files: [] };
    },
    async blob(_r, sha) { calls.push(`blob:${sha.slice(0, 2)}`); const t = blobs.get(sha); return t === undefined ? null : { bytes: typeof t === "string" ? new TextEncoder().encode(t) : t, size: t.length }; },
    async fileSha(_r, path, ref) { calls.push(`fileSha:${path}@${ref.slice(0, 1)}`); return shas.get(`${path}@${ref}`) ?? null; },
    async setStatus(_r, sha, state, description) { calls.push("setStatus"); if (!statusOk) return false; this.statuses.push({ sha, state, description }); return true; },
    async postReview(_r, pr, review) { calls.push("postReview"); this.posted.push(review); return { inline: review.comments.length }; },
    // The summary comment: one per PR, edited in place (its id is kept).
    summaries: [],
    async upsertSummary(_r, _p, id, body) { calls.push("upsertSummary"); this.summaries.push({ id, body }); return id ?? 501; },
    prLinesMap: new Map(),
    async prLines() { calls.push("prLines"); return this.prLinesMap; },
  };
}

// The files a drafting prompt shows, and its first added line (for a finding
// whose evidence is real).
function shownFiles(text) {
  return [...String(text).matchAll(/^### (\S+) \(/gm)].map((m) => m[1]);
}
function firstLine(text, path) {
  const at = text.indexOf(`### ${path} (`);
  const m = /\n\s*(\d+) \+ (.*)/.exec(text.slice(at));
  return { line: Number(m[1]), evidence: m[2] };
}

const reply = (status, data) => ({ ok: status === 200, status, headers: { get: () => null }, async json() { return data; } });
const geminiDay = reply(429, { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } });

// Model providers: Gemini models draft (one finding on any batch that shows
// `flag`), Claude Haiku verifies (confirms all). Overrides per model by name.
function fakeModels({ flag = "worker/src/m3.js", gemini = {}, anthropic = null, finding = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes("generativelanguage")) {
      const model = decodeURIComponent(/models\/([^:]+):/.exec(url)[1]);
      const text = body.contents[0].parts[0].text;
      calls.push({ model, files: shownFiles(text), text });
      const over = gemini[model]?.(calls.filter((c) => c.model === model).length);
      if (over) return over;
      const findings = [];
      if (shownFiles(text).includes(flag)) {
        const { line, evidence } = firstLine(text, flag);
        findings.push({ path: flag, line, severity: "minor", type: "issue", category: "bug", title: "Off by one", evidence, claim: "It is off by one.", symbols: [], body: "Fix the bound.", ...finding });
      }
      return reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ summary: "s", findings }) }] } }] });
    }
    const asked = askedFindings(body.messages[0].content);
    calls.push({ model: body.model, verify: asked.length });
    if (anthropic) return anthropic(body, asked);
    const text = JSON.stringify({ verdicts: asked.map((f) => ({ id: f.id, verdict: "confirmed", severity: f.severity, suggestion_ok: false, prompt_ok: false, reason: "r" })) });
    return reply(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 100 } });
  };
  fetch.calls = calls;
  return fetch;
}

function setup({ github = fakeGithub(), models = fakeModels(), env: over = {}, job: jobOver = {} } = {}) {
  let now = NOW;
  const storage = memoryStorage();
  const env = {
    LEDGER: memoryKv(), GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "sk", ANTHROPIC_DAILY_USD_CAP: "5", VERIFY: "",
    DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,gemini:gemma-4-31b-it,anthropic:claude-haiku-5-5",
    VERIFY_FALLBACK: "gemini:gemini-3.5-flash-lite",
    ...over,
  };
  const done = [];
  const ctx = {
    storage, env, cfg: config(env), fx: github,
    deps: { now: () => now, sleep: testSleep, fetch: models, log: () => {} },
    again: "- Review again: comment `@tankster-ai-review review`.",
    onDone: async (run, out) => { done.push(out); },
  };
  const job = { id: "job1", repo, pr: 9, since: null, full: false, requestedBy: null, ...jobOver };
  return { ctx, storage, github, models, env, done, job, setNow: (t) => { now = t; }, getNow: () => now };
}

// Runs steps until the run is over; returns how many it took. Time moves to
// each step's due time, as the alarm would.
async function runAll(s, { max = 200 } = {}) {
  await startRun(s.storage, s.job, s.getNow());
  for (let i = 1; i <= max; i++) {
    const at = await stepRun(s.ctx, s.job.id);
    if (at === null) return i;
    if (at > s.getNow()) s.setNow(at);
  }
  throw new Error("the run never finished");
}

test("PR #9's shape: every one of its 18 files is reviewed, in batches, and one review is posted at 100%", async () => {
  const s = setup();
  await runAll(s);
  const prompts = s.models.calls.filter((c) => c.files);
  assert.ok(prompts.length > 1, "more than one pass");
  const reviewed = new Set(prompts.flatMap((c) => c.files));
  for (const f of PR9) assert.ok(reviewed.has(f.filename), `${f.filename} was shown to a model`);
  assert.equal(s.github.posted.length, 1);
  const { body, comments } = s.github.posted[0];
  assert.doesNotMatch(body, /size budget/);
  assert.match(body, new RegExp(`\\n- Coverage: 18 of 18 reviewable files \\(100%\\), [\\d,]+ characters of diff, in ${prompts.length} passes\\.\\n`));
  assert.deepEqual(parseFindingsBlock(body).coverage, { reviewable: 18, covered: 18, complete: true });
  // The one finding was drafted, verified and posted inline.
  assert.equal(comments.length, 1);
  assert.equal(comments[0].path, "worker/src/m3.js");
  assert.match(body, /Reviewed 18 files\. 1 finding confirmed: 1 minor\./);
  // The commit status: pending while it ran, success at the end.
  assert.equal(s.github.statuses[0].state, "pending");
  assert.deepEqual(s.github.statuses.at(-1), { sha: HEAD, state: "success", description: "Reviewed all 18 files (100%): 1 confirmed finding." });
  assert.equal(s.done.at(-1).reviewedSha, HEAD);
  // Its own mark: the single-prompt paths' done: key means less (finding 1 of the independent review).
  assert.ok(s.env.LEDGER.map.has(`donefull:TanksterAI/ai-review#9@${HEAD}`));
  assert.ok(!s.env.LEDGER.map.has(`done:TanksterAI/ai-review#9@${HEAD}`));
  assert.equal(await activeRun(s.storage), null);
});

test("batches running together draw on different free models, and the paid one is last", () => {
  const chain = [{ kind: "gemini", model: "a" }, { kind: "gemini", model: "b" }, { kind: "workers-ai", model: "c" }, { kind: "anthropic", model: "h" }];
  assert.deepEqual(rotatedChain(chain, 0).map((x) => x.model), ["a", "b", "c", "h"]);
  assert.deepEqual(rotatedChain(chain, 1).map((x) => x.model), ["b", "c", "a", "h"]);
  assert.deepEqual(rotatedChain(chain, 5).map((x) => x.model), ["c", "a", "b", "h"]);
});

test("a model out of quota mid-review hands its batch to the next model at once: nothing waits", async () => {
  // Flash-Lite answers once, then is out for the day.
  const models = fakeModels({ gemini: { "gemini-3.5-flash-lite": (n) => (n > 1 ? geminiDay : null) } });
  const s = setup({ models });
  await runAll(s);
  const meta = await s.storage.get("runmeta:job1");
  assert.equal(meta.outcome.state, "success");
  assert.ok(!s.github.statuses.some((x) => /Waiting/.test(x.description)), "no batch waited");
  const body = s.github.posted[0].body;
  assert.match(body, /\n- Models: `gemini-3\.5-flash-lite` \(\d+ pass(es)?\), `gemma-4-31b-it` \(\d+ pass(es)?\); free tiers first/);
  assert.match(body, /Coverage: 18 of 18 reviewable files \(100%\)/);
});

test("only when every drafter is out does a batch wait, and the status says so; it finishes after the reset", async () => {
  let out = true;
  const models = fakeModels({
    gemini: { "gemini-3.5-flash-lite": () => (out ? geminiDay : null), "gemma-4-31b-it": () => (out ? geminiDay : null) },
    anthropic: (body, asked) => {
      if (body.output_config?.format) return reply(200, { content: [{ type: "text", text: JSON.stringify({ verdicts: asked.map((f) => ({ id: f.id, verdict: "confirmed", severity: f.severity, suggestion_ok: false, prompt_ok: false, reason: "r" })) }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } });
      return reply(402, { error: { type: "billing_error", message: "Your credit balance is too low" } });
    },
  });
  const s = setup({ models });
  await startRun(s.storage, s.job, s.getNow());
  let at = null;
  for (let i = 0; i < 20; i++) {
    at = await stepRun(s.ctx, s.job.id);
    if (at > s.getNow()) break;
  }
  assert.ok(at > s.getNow(), "the run waits");
  assert.match(s.github.statuses.at(-1).description, /^Waiting for a model provider to reset at \d\d:\d\d UTC; 0 of 18 files reviewed so far\.$/);
  assert.equal(s.github.statuses.at(-1).state, "pending");
  assert.equal(s.github.posted.length, 0);
  // The providers reset; the review carries on from where it was.
  out = false;
  s.setNow(at);
  s.env.LEDGER.map.clear();
  for (let i = 0; i < 100 && at !== null; i++) {
    at = await stepRun(s.ctx, s.job.id);
    if (at > s.getNow()) s.setNow(at);
  }
  assert.equal(s.github.posted.length, 1);
  assert.equal(s.github.statuses.at(-1).state, "success");
});

test("a file GitHub sent without its patch is diffed by the Worker and reviewed; its findings stay in the body", async () => {
  const oldText = Array.from({ length: 50 }, (_, i) => `const keep${i} = ${i};`).join("\n");
  const newText = oldText.replace("const keep20 = 20;", "const changed20 = compute(20);");
  const files = [file("src/huge.js", undefined, { status: "modified", sha: "e".repeat(40) }), file("src/small.js", added(5, "small_"))];
  const github = fakeGithub({ files, blobs: new Map([["e".repeat(40), newText], ["f".repeat(40), oldText]]), shas: new Map([[`src/huge.js@${MERGE_BASE}`, "f".repeat(40)]]) });
  const s = setup({ github, models: fakeModels({ flag: "src/huge.js" }) });
  await runAll(s);
  const shown = s.models.calls.find((c) => c.files?.includes("src/huge.js"));
  assert.match(shown.text, /### src\/huge\.js \(modified, \+1 -0\) \[diff computed by the reviewer: comments go in the review body\]/);
  assert.match(shown.text, /\s21 \+ const changed20 = compute\(20\);/);
  // The old text came from the merge base, not the base branch's tip.
  assert.ok(github.calls.includes(`compare:${BASE.slice(0, 1)}...${HEAD.slice(0, 1)}`));
  const { body, comments } = github.posted[0];
  assert.equal(comments.length, 0);
  assert.match(body, /Outside diff range comments \(1\)[\s\S]*Off by one/);
  assert.match(body, /Coverage: 2 of 2 reviewable files \(100%\)/);
});

test("a binary file without a patch is not reviewable; lockfiles and deletions are skipped, and none of them count against coverage", async () => {
  const files = [
    file("assets/logo.png", undefined, { sha: "1".repeat(40) }),
    file("data/blob.dat", undefined, { sha: "2".repeat(40) }),
    file("package-lock.json", added(3, "lock_")),
    file("old.js", added(3, "old_"), { status: "removed" }),
    file("src/a.js", added(5, "a_")),
  ];
  const github = fakeGithub({ files, blobs: new Map([["2".repeat(40), new Uint8Array([1, 0, 2])]]) });
  const s = setup({ github });
  await runAll(s);
  // The .png is never fetched; the .dat is, and found binary.
  assert.ok(!github.calls.includes("blob:11"));
  assert.ok(github.calls.includes("blob:22"));
  const body = github.summaries[0].body;
  assert.match(body, /Coverage: 1 of 1 reviewable file \(100%\)/);
  assert.match(body, /Not reviewable \(4\): /);
  assert.equal(github.statuses.at(-1).state, "success");
});

test("every step stays inside Workers Free's 50 subrequests, however big the pull request", async () => {
  const many = Array.from({ length: 250 }, (_, i) => file(`src/f${i}.js`, added(60, `f${i}_`)));
  const github = fakeGithub({ files: many });
  const s = setup({ github });
  await startRun(s.storage, s.job, s.getNow());
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const before = github.calls.length + s.models.calls.length + s.env.LEDGER.ops;
    const at = await stepRun(s.ctx, s.job.id);
    worst = Math.max(worst, github.calls.length + s.models.calls.length + s.env.LEDGER.ops - before);
    if (at === null) break;
    if (at > s.getNow()) s.setNow(at);
  }
  assert.equal(github.summaries.length, 1);
  assert.match(github.summaries[0].body, /Coverage: 250 of 250 reviewable files \(100%\)/);
  // GitHub calls are bounded per step by design, model and KV calls by the counter.
  assert.ok(worst <= 50, `the busiest step made ${worst} subrequests`);
  assert.ok(STEP_SUBREQUESTS < 50 && DRAFT_PARALLEL >= 2);
});

test("a closed pull request is not reviewed, and gets no status", async () => {
  const s = setup({ github: fakeGithub({ pr: { state: "closed" } }) });
  await runAll(s);
  assert.equal(s.github.posted.length, 0);
  assert.equal(s.github.statuses.length, 0);
  assert.equal(s.models.calls.length, 0);
});

test("a commit already reviewed is not reviewed again, unless someone asked", async () => {
  const s = setup();
  await s.env.LEDGER.put(`donefull:TanksterAI/ai-review#9@${HEAD}`, "2026-11-14");
  await runAll(s);
  assert.equal(s.github.posted.length, 0);
  assert.equal(s.done.at(-1).reviewedSha, HEAD);
  const asked = setup({ job: { requestedBy: "rishitank" } });
  await asked.env.LEDGER.put(`donefull:TanksterAI/ai-review#9@${HEAD}`, "2026-11-14");
  await runAll(asked);
  assert.equal(asked.github.posted.length, 1);
});

test("an incremental review reads only the commits since the last review, and says so", async () => {
  const since = "d".repeat(40);
  const github = fakeGithub({ compare: (base) => (base === since ? { status: "ahead", files: [file("worker/src/m3.js", added(4, "inc_"))] } : null) });
  github.prLinesMap = new Map([["worker/src/m3.js", new Set([1, 2, 3, 4])]]);
  const s = setup({ github, job: { since } });
  await runAll(s);
  assert.ok(!github.calls.some((c) => c.startsWith("listFiles")));
  const { body, comments } = github.posted[0];
  assert.equal(comments.length, 1);
  assert.match(body, /_Incremental review: commits after `ddddddd`\._/);
  assert.match(body, /Coverage: 1 of 1 reviewable file \(100%\)/);
});

test("without the statuses permission the review is still posted, and the status is not asked for again", async () => {
  const github = fakeGithub({ statusOk: false });
  const s = setup({ github });
  await runAll(s);
  assert.equal(github.posted.length, 1);
  assert.equal(github.calls.filter((c) => c === "setStatus").length, 1);
});

test("a batch no model can review after three tries makes the review incomplete, and the status fails", async () => {
  // Every model answers with something that is not JSON, for the m3 batch only.
  const broken = (n, text) => (text.includes("### worker/src/m3.js (") ? reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "no" }] } }] }) : null);
  const models = fakeModels();
  const wrapped = async (url, init) => {
    if (url.includes("generativelanguage")) {
      const text = JSON.parse(init.body).contents[0].parts[0].text;
      const r = broken(0, text);
      if (r) { models.calls.push({ model: "x", files: shownFiles(text), text }); return r; }
    }
    return models(url, init);
  };
  wrapped.calls = models.calls;
  const s = setup({ models: wrapped, env: { DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,gemini:gemma-4-31b-it" } });
  await runAll(s);
  const { body } = s.github.summaries[0];
  assert.match(body, /\*\*Incomplete review: \d+ of 18 reviewable files were covered\.\*\*/);
  assert.match(body, /Not covered \(\d+\): [^\n]*`worker\/src\/m3\.js` \(the model did not return a usable answer; try again later\)/);
  assert.equal(s.github.statuses.at(-1).state, "failure");
  assert.match(s.github.statuses.at(-1).description, /^Incomplete: \d+ of 18 files reviewed\./);
});

test("findings from several batches merge into one review: unique ids, and one seen twice is shown once", () => {
  const f = (id, path, line, title, severity = "minor") => ({ id, path, line, title, severity });
  const v = { off: false, weak: false, fallback: false, fallbackBy: [], selfExcluded: [] };
  const m = mergeResults([
    { shown: { inline: [f("aa", "x.js", 1, "T")], general: [] }, hidden: [f("hh", "x.js", 2, "H")], verification: v },
    { shown: { inline: [f("aa", "x.js", 1, "T"), f("aa", "x.js", 9, "T", "major")], general: [] }, hidden: [f("hh", "x.js", 3, "H")], verification: { ...v, weak: true } },
  ]);
  assert.deepEqual(m.shown.inline.map((x) => [x.id, x.line]), [["aa-2", 9], ["aa", 1]]);
  assert.deepEqual(m.hidden.map((x) => x.id), ["hh", "hh-2"]);
  assert.equal(m.verification.weak, true);
  assert.equal(m.verification.off, false);
});

test("worst case, every free model refusing: still within 50 subrequests a step, and Claude drafts so nothing waits", async () => {
  const many = Array.from({ length: 120 }, (_, i) => file(`src/f${i}.js`, added(80, `w${i}_`)));
  const github = fakeGithub({ files: many });
  const models = fakeModels({ gemini: { "gemini-3.5-flash-lite": () => geminiDay, "gemini-3.1-flash-lite": () => geminiDay, "gemma-4-31b-it": () => geminiDay, "gemma-4-26b-a4b-it": () => geminiDay } });
  const s = setup({ github, models, env: { DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite,gemini:gemini-3.1-flash-lite,gemini:gemma-4-31b-it,gemini:gemma-4-26b-a4b-it,workers-ai:@cf/zai-org/glm-4.7-flash,anthropic:claude-haiku-5-5", VERIFY_FALLBACK: "" } });
  // Workers AI is out for the day too.
  s.env.AI = { calls: 0, async run() { this.calls++; throw new Error("AiError: 3036: daily free allocation used up"); } };
  // Claude drafts (no format) and verifies (with the verdict schema).
  const plain = s.ctx.deps.fetch;
  s.ctx.deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes("anthropic") && !body.output_config?.format) {
      models.calls.push({ model: body.model, files: shownFiles(body.messages[0].content), text: body.messages[0].content });
      return reply(200, { content: [{ type: "text", text: '{"summary":"s","findings":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 15000, output_tokens: 200 } });
    }
    return plain(url, init);
  };
  await startRun(s.storage, s.job, s.getNow());
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const before = github.calls.length + models.calls.length + s.env.LEDGER.ops + s.env.AI.calls;
    const at = await stepRun(s.ctx, s.job.id);
    worst = Math.max(worst, github.calls.length + models.calls.length + s.env.LEDGER.ops + s.env.AI.calls - before);
    if (at === null) break;
    assert.ok(at <= s.getNow() + 1, "no step waits: Claude can always draft");
  }
  assert.ok(worst <= 50, `the busiest step made ${worst} subrequests`);
  assert.match(github.summaries[0].body, /Coverage: 120 of 120 reviewable files \(100%\)/);
  assert.match(github.summaries[0].body, /`claude-haiku-5-5`/);
});

test("an incomplete review marks nothing done, so the next one starts from the last complete review", async () => {
  const s = setup({ env: { MAX_PR_CHARS: "100000" } });
  await runAll(s);
  assert.equal(s.github.statuses.at(-1).state, "failure");
  assert.equal(s.done.at(-1).reviewedSha, null);
  assert.ok(!s.env.LEDGER.map.has(`donefull:TanksterAI/ai-review#9@${HEAD}`));
  assert.match(s.github.posted[0].body, /Not covered \(\d+\): [^\n]*\(the pull request is over the reviewer's limit of 100,000 characters of diff\)/);
});

test("batches with nothing to verify are settled without a model call, in the same step", async () => {
  const s = setup({ models: fakeModels({ flag: "none" }) });
  await startRun(s.storage, s.job, s.getNow());
  const stages = [];
  for (let i = 0; i < 100; i++) {
    stages.push((await s.storage.get("runmeta:job1")).stage);
    if ((await stepRun(s.ctx, s.job.id)) === null) break;
  }
  // One verify step for all of the batches, and no verifier was asked.
  assert.equal(stages.filter((x) => x === "verify").length, 1);
  assert.ok(!s.models.calls.some((c) => c.verify !== undefined));
  assert.equal(s.github.statuses.at(-1).state, "success");
});

test("a step that fails is tried again after a pause; failures are counted in a row, and six in a row give up", async () => {
  let fail = 2;
  const github = fakeGithub();
  const listFiles = github.listFiles.bind(github);
  github.listFiles = async (...a) => { if (fail-- > 0) throw new Error("GitHub 502"); return listFiles(...a); };
  const s = setup({ github });
  await runAll(s);
  assert.equal(github.posted.length, 1, "two failures in a row are retried, and the review goes on");
  const always = fakeGithub();
  always.pullRequest = async () => { throw new Error("GitHub 500"); };
  const t = setup({ github: always });
  await runAll(t);
  assert.equal(always.posted.length, 0);
  assert.equal(t.done.at(-1).gaveUp, true);
});

// --- from the independent review ----------------------------------------------

test("a commit marked done by a single-prompt review (v1 or the runner) is still reviewed in full", async () => {
  const s = setup();
  await s.env.LEDGER.put(`done:TanksterAI/ai-review#9@${HEAD}`, "2026-11-14");
  await runAll(s);
  assert.equal(s.github.posted.length, 1);
  assert.match(s.github.posted[0].body, /Coverage: 18 of 18 reviewable files \(100%\)/);
});

test("a commit already reviewed at 100% is not reviewed again, and its status is set again", async () => {
  const s = setup();
  await runAll(s);
  const again = setup();
  again.env.LEDGER.map = s.env.LEDGER.map;
  again.ctx.env.LEDGER = s.env.LEDGER;
  await runAll(again);
  assert.equal(again.github.posted.length, 0);
  assert.deepEqual(again.github.statuses.map((x) => x.state), ["success"]);
  assert.match(again.github.statuses[0].description, /already reviewed at 100%/);
});

test("files GitHub sent without a patch are fetched only while they fit the pull request's limit", async () => {
  const big = (i) => Array.from({ length: 2000 }, (_, k) => `const big${i}_${k} = ${k};`).join("\n");
  const files = Array.from({ length: 6 }, (_, i) => file(`data/big${i}.js`, undefined, { sha: String(i + 1).repeat(40) }));
  const blobs = new Map(files.map((f, i) => [f.sha, big(i)]));
  const github = fakeGithub({ files, blobs });
  const s = setup({ github, env: { MAX_PR_CHARS: "100000" } });
  await runAll(s);
  // About 50,000 characters each: once less than a batch of the limit is
  // left, the rest are named as not covered. Each is fetched once, only to
  // check it is not minified data, and none is stored.
  const fetched = github.calls.filter((c) => c.startsWith("blob:")).length;
  assert.ok(fetched <= 6, `${fetched} blobs were fetched`);
  const stored = [...s.storage.map.keys()].filter((k) => /:p\d+$/.test(k)).length;
  assert.ok(stored <= 2, `${stored} patches were stored`);
  const { body } = github.summaries[0];
  assert.match(body, /Not covered \(\d+\): `data\/big[1-5]\.js` \(the pull request is over the reviewer's limit of 100,000 characters of diff\)/);
  assert.equal(github.statuses.at(-1).state, "failure");
});

test("a step that dies without throwing (out of memory, CPU) is still counted, and six in a row give up", async () => {
  const github = fakeGithub();
  github.pullRequest = () => new Promise(() => {}); // the step never ends: the isolate is killed
  const s = setup({ github });
  await startRun(s.storage, s.job, s.getNow());
  for (let i = 0; i < 6; i++) {
    void stepRun(s.ctx, s.job.id);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await s.storage.get("runmeta:job1")).tries, i + 1);
  }
  // The next alarm finds six dead attempts and gives up, rather than die again.
  assert.equal(await stepRun(s.ctx, s.job.id), null);
  assert.equal(s.done.at(-1).gaveUp, true);
});

test("drafting and verifying count their failures apart: a verifier blip does not throw away a draft", async () => {
  let drafts = 0;
  let verifies = 0;
  const models = fakeModels({
    flag: "src/a.js",
    gemini: { "gemini-3.5-flash-lite": () => (++drafts <= 2 ? reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "nope" }] } }] }) : null) },
    anthropic: (body, asked) => (++verifies === 1 ? reply(500, {}) : reply(200, { content: [{ type: "text", text: JSON.stringify({ verdicts: asked.map((f) => ({ id: f.id, verdict: "confirmed", severity: f.severity, suggestion_ok: false, prompt_ok: false, reason: "r" })) }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } })),
  });
  const s = setup({ github: fakeGithub({ files: [file("src/a.js", added(5, "a_"))] }), models, env: { DRAFT_CHAIN: "gemini:gemini-3.5-flash-lite", VERIFY_FALLBACK: "" } });
  await runAll(s);
  assert.equal(s.github.statuses.at(-1).state, "success");
  assert.equal(s.github.posted[0].comments.length, 1);
});

test("posting is done once: a failure after the review is posted does not post it again", async () => {
  const s = setup();
  const put = s.env.LEDGER.put.bind(s.env.LEDGER);
  let failed = false;
  s.env.LEDGER.put = async (k, v, o) => { if (!failed && k.startsWith("donefull:")) { failed = true; throw new Error("KV 500"); } return put(k, v, o); };
  s.ctx.env.LEDGER = s.env.LEDGER;
  await runAll(s);
  assert.equal(s.github.posted.length, 1);
  assert.equal(s.github.statuses.at(-1).state, "success");
});

test("a single line far longer than a batch (minified or generated data) is not reviewable; a long one that fits is reviewed", async () => {
  const huge = `@@ -0,0 +1,1 @@\n+${JSON.stringify({ data: "q".repeat(600_000) })}`;
  const long = `@@ -0,0 +1,1 @@\n+const blob = "${"z".repeat(100_000)}";`;
  const github = fakeGithub({ files: [file("fixtures/data.json", huge), file("src/blob.js", long), file("src/a.js", added(5, "a_"))] });
  const s = setup({ github });
  await runAll(s);
  const { body } = github.summaries[0];
  assert.match(body, /Coverage: 2 of 2 reviewable files \(100%\)/);
  assert.match(body, /Not reviewable \(1\): `fixtures\/data\.json` \(a line over 240,000 characters: minified or generated data\)/);
  assert.ok(!s.models.calls.some((c) => c.files?.includes("fixtures/data.json")));
});

test("when no reviewable file can be taken at all, a review still says so, and the status fails", async () => {
  const github = fakeGithub({ files: [file("src/a.js", added(400, "a_")), file("src/b.js", added(400, "b_"))] });
  const s = setup({ github, env: { MAX_PR_CHARS: "1000" } });
  await runAll(s);
  const { body } = github.summaries[0];
  assert.match(body, /\*\*Incomplete review: 0 of 2 reviewable files were covered\.\*\*/);
  assert.match(body, /\n- Model: none: no file of this pull request could be sent to a model\.\n/);
  assert.equal(github.statuses.at(-1).state, "failure");
  assert.equal(s.models.calls.length, 0);
});

// --- round 2 of the independent review --------------------------------------------

test("a minified file never uses up the pull request's limit, whatever the file order", async () => {
  const bundle = `@@ -0,0 +1,1 @@\n+${"x".repeat(300_000)}`;
  for (const order of ["bundle first", "bundle last"]) {
    const files = [file("data/catalog.json", bundle), file("src/a.js", added(5, "a_"))];
    if (order === "bundle last") files.reverse();
    const s = setup({ github: fakeGithub({ files }), env: { MAX_PR_CHARS: "200000" } });
    await runAll(s);
    const { body } = s.github.summaries[0];
    assert.match(body, /Coverage: 1 of 1 reviewable file \(100%\)/, order);
    assert.match(body, /`data\/catalog\.json` \(a line over 240,000 characters: minified or generated data\)/, order);
    assert.equal(s.github.statuses.at(-1).state, "success", order);
  }
});

test("a minified file GitHub sent without a patch is not counted against the limit either", async () => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const files = [file("data/catalog.json", undefined, { sha: sha1, additions: 1 }), file("src/b.js", undefined, { sha: sha2, additions: 3 })];
  const github = fakeGithub({ files, blobs: new Map([[sha1, "y".repeat(300_000)], [sha2, "const b0 = 1;\nconst b1 = 2;\nconst b2 = 3;"]]) });
  const s = setup({ github, env: { MAX_PR_CHARS: "200000" } });
  await runAll(s);
  const { body } = github.summaries[0];
  assert.match(body, /Coverage: 1 of 1 reviewable file \(100%\)/);
  assert.match(body, /`data\/catalog\.json` \(a line over 240,000 characters: minified or generated data\)/);
});

test("a minified file without a patch is named as not reviewable, even when the limit is nearly used up", async () => {
  const sha1 = "1".repeat(40);
  const files = [file("src/a.js", added(1500, "near_")), file("data/catalog.json", undefined, { sha: sha1, additions: 1 })];
  const github = fakeGithub({ files, blobs: new Map([[sha1, "y".repeat(300_000)]]) });
  // src/a.js (about 127,000 characters annotated) leaves less than a batch of the limit.
  const s = setup({ github, env: { MAX_PR_CHARS: "150000" } });
  await runAll(s);
  const { body } = github.summaries[0];
  assert.match(body, /Coverage: 1 of 1 reviewable file \(100%\)/);
  assert.match(body, /`data\/catalog\.json` \(a line over 240,000 characters: minified or generated data\)/);
  assert.equal(github.statuses.at(-1).state, "success");
});

test("a file without a patch, with a long unchanged line and a small change, is reviewed or named over the limit, never 'not reviewable'", async () => {
  // The change is two lines below the long line, so the long line is in its context.
  const head = `const icon = "${"D".repeat(300_000)}";\nconst k0 = 0;\nconst changed = compute();\nconst k1 = 1;`;
  const base = `const icon = "${"D".repeat(300_000)}";\nconst k0 = 0;\nconst changed = 1;\nconst k1 = 1;`;
  const files = [file("src/icons.js", undefined, { status: "modified", sha: "1".repeat(40), additions: 1, deletions: 1 })];
  const github = fakeGithub({ files, blobs: new Map([["1".repeat(40), head], ["2".repeat(40), base]]), shas: new Map([[`src/icons.js@${MERGE_BASE}`, "2".repeat(40)]]) });
  const s = setup({ github, models: fakeModels({ flag: "src/icons.js" }) });
  await runAll(s);
  const shown = s.models.calls.find((c) => c.files?.includes("src/icons.js"));
  assert.ok(shown, "the change was shown to a model");
  assert.match(shown.text, /\+ const changed = compute\(\);/);
  assert.match(github.posted[0].body, /Coverage: 1 of 1 reviewable file \(100%\)/);
});

test("a code file whose only change is one line too long to show is not covered: the gate fails, and says how to fix it", async () => {
  const bundle = `@@ -0,0 +1,1 @@\n+${"x".repeat(300_000)}`;
  const github = fakeGithub({ files: [file("public/app.bundle.js", bundle), file("src/a.js", added(5, "a_"))] });
  const s = setup({ github });
  await runAll(s);
  const { body } = github.summaries[0];
  assert.match(body, /Coverage: 1 of 2 reviewable files \(50%\)/);
  assert.match(body, /`public\/app\.bundle\.js` \(1 added line over 240,000 characters could not be shown to a model \(generated code belongs under dist\/ or in a \.min\.js file\)\)/);
  assert.equal(github.statuses.at(-1).state, "failure");
});

// --- CodeRabbit parity: decisions, threads and the summary comment ----------

const OLD = "d".repeat(40);
// One of our inline comments, as GitHub returns its thread (effects.ownThreads).
const ownThread = (over = {}) => ({
  id: "PRRT_a", resolved: false, outdated: false, path: "worker/src/m3.js", line: 20, originalLine: 20, commentId: 71,
  body: "**Minor (bug): Off by one**\n<sub>Potential issue · finding `aaaa1111`</sub>\n\nFix the bound.",
  diffHunk: "@@ -18,3 +18,3 @@\n+const bound = n + 1;", originalCommit: OLD, findingId: "aaaa1111", ...over,
});
// A diff since OLD that changes the lines near 20 of m3.js.
const NEAR_20 = "@@ -19,3 +19,3 @@\n keep();\n-const bound = n + 1;\n+const bound = n;\n more();";

function threadsGithub({ threads = [], since = () => ({ status: "ahead", files: [] }), ...rest } = {}) {
  const g = fakeGithub(rest);
  Object.assign(g, {
    threads, resolved: [], edits: [],
    async ownThreads(_r, _p, login) { g.calls.push(`ownThreads:${login}`); return g.threads; },
    async resolveThread(_r, id) { g.calls.push(`resolve:${id}`); g.resolved.push(id); return true; },
    async editReviewComment(_r, id, body) { g.calls.push(`edit:${id}`); g.edits.push({ id, body }); },
  });
  const plain = g.compare.bind(g);
  g.compare = async (r, base, head) => (base === OLD || base === "e".repeat(40) ? (g.calls.push(`compareSince:${base.slice(0, 1)}`), since(base, head)) : plain(r, base, head));
  return g;
}

// Claude Haiku verifies findings, and judges whether threads were addressed.
function judging(statuses) {
  const judged = [];
  const models = fakeModels({
    flag: "nothing-here.js",
    anthropic: (body, asked) => {
      const text = body.messages[0].content;
      const items = /<<<BEGIN ITEMS (\w+)>>>\n([\s\S]*?)\n<<<END ITEMS \1>>>/.exec(text);
      if (items) {
        const list = JSON.parse(items[2]);
        judged.push(list);
        const out = JSON.stringify({ results: list.map((x) => ({ id: x.id, status: statuses[x.id] ?? "uncertain", reason: "r" })) });
        return reply(200, { content: [{ type: "text", text: out }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
      }
      const v = JSON.stringify({ verdicts: asked.map((f) => ({ id: f.id, verdict: "confirmed", severity: f.severity, suggestion_ok: false, prompt_ok: false, reason: "r" })) });
      return reply(200, { content: [{ type: "text", text: v }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
    },
  });
  models.judged = judged;
  return models;
}

const SMALL = [file("worker/src/m3.js", added(30, "m3_")), file("README.md", added(5, "doc_"))];

test("findings: one review, filed as Changes requested; and the summary comment says how many", async () => {
  const s = setup({ github: threadsGithub({ files: SMALL }), models: fakeModels() });
  await runAll(s);
  assert.equal(s.github.posted.length, 1);
  assert.equal(s.github.posted[0].event, "REQUEST_CHANGES");
  assert.equal(s.github.summaries.length, 1);
  assert.equal(s.github.summaries[0].id, null, "the first summary comment is a new one");
  assert.match(s.github.summaries[0].body, /^### Tankster AI Review\n\n\*\*Latest review:\*\* commit `aaaaaaa`\.\n\nActionable comments posted: 1\. /);
  assert.equal(await s.storage.get("summaryComment"), 501);
  assert.equal(s.done[0].reviewedSha, HEAD);
});

test("no findings: no review at all, and the one summary comment is edited in place", async () => {
  const s = setup({ github: threadsGithub({ files: SMALL }), models: fakeModels({ flag: "nothing-here.js" }) });
  await s.storage.put("summaryComment", 77);
  await runAll(s);
  assert.equal(s.github.posted.length, 0, "a clean review posts nothing new");
  assert.equal(s.github.summaries.length, 1);
  assert.equal(s.github.summaries[0].id, 77);
  assert.match(s.github.summaries[0].body, /No actionable comments were generated in the latest review\. 🎉/);
  assert.match(s.github.summaries[0].body, /<details><summary>About this review<\/summary>/);
  // The gate still gets its answer.
  assert.equal(s.github.statuses.at(-1).state, "success");
  assert.equal(s.done[0].reviewedSha, HEAD);
});

test("earlier threads: fixed ones get CodeRabbit's note and are resolved; untouched or still-present ones stay open", async () => {
  const threads = [
    ownThread(),
    // Its code did not change near line 120: no model is asked about it.
    ownThread({ id: "PRRT_b", findingId: "bbbb2222", commentId: 72, line: 120, originalLine: 120, body: "**Minor (bug): b**\n<sub>Potential issue · finding `bbbb2222`</sub>\n\nb" }),
    // Changed near its line, but the model says the problem is still there.
    ownThread({ id: "PRRT_c", findingId: "cccc3333", commentId: 73, originalLine: 21, body: "**Minor (bug): c**\n<sub>Potential issue · finding `cccc3333`</sub>\n\nc" }),
    // Its file was deleted: addressed, without asking a model.
    ownThread({ id: "PRRT_d", findingId: "dddd4444", commentId: 74, path: "worker/src/gone.js", body: "**Minor (bug): d**\n<sub>Potential issue · finding `dddd4444`</sub>\n\nd" }),
    // Already resolved, and one written at this very head: neither is looked at.
    ownThread({ id: "PRRT_e", resolved: true }),
    ownThread({ id: "PRRT_f", originalCommit: HEAD }),
    // The model is unsure: open, never resolved on a guess.
    ownThread({ id: "PRRT_g", findingId: "eeee5555", commentId: 75, body: "**Minor (bug): g**\n<sub>Potential issue · finding `eeee5555`</sub>\n\ng" }),
  ];
  const since = () => ({ status: "ahead", files: [{ filename: "worker/src/m3.js", status: "modified", patch: NEAR_20 }, { filename: "worker/src/gone.js", status: "removed" }] });
  const models = judging({ "t:PRRT_a": "fixed", "t:PRRT_c": "present" });
  const s = setup({ github: threadsGithub({ files: SMALL, threads, since }), models, env: { ADDRESSED_CHAIN: "anthropic:claude-haiku-5-5" } });
  await runAll(s);
  // Items are named by their thread: one finding can have two threads.
  assert.deepEqual(models.judged.map((l) => l.map((x) => x.id)), [["t:PRRT_a", "t:PRRT_c", "t:PRRT_g"]]);
  // This review's own thread is not compared with anything.
  assert.equal(s.github.calls.some((c) => c.startsWith("compare:a")), false);
  // The model saw the finding, the original code and the change near it, as data.
  const item = models.judged[0][0];
  assert.match(item.finding, /Off by one/);
  assert.match(item.original, /n \+ 1/);
  assert.match(item.since, /\+const bound = n;/);
  assert.deepEqual(s.github.resolved.sort(), ["PRRT_a", "PRRT_d"]);
  assert.deepEqual(s.github.edits.map((e) => e.id).sort(), [71, 74]);
  assert.match(s.github.edits.find((e) => e.id === 71).body, /\n\n✅ Addressed in commit aaaaaaa$/);
  // The note goes on before the thread is resolved.
  assert.ok(s.github.calls.indexOf("edit:71") < s.github.calls.indexOf("resolve:PRRT_a"));
  assert.ok(s.github.calls.includes("ownThreads:tankster-ai-review"));
  // Five earlier threads were open (not this review's own, nor the resolved one).
  assert.match(s.github.summaries[0].body, /Earlier findings: 2 earlier findings addressed and resolved; 3 still open\./);
});

test("threads after a force-push, or when no model can answer, stay open; the review still finishes", async () => {
  const diverged = setup({ github: threadsGithub({ files: SMALL, threads: [ownThread()], since: () => ({ status: "diverged", files: [{ filename: "worker/src/m3.js", status: "modified", patch: NEAR_20 }] }) }), models: judging({ "t:PRRT_a": "fixed" }), env: { ADDRESSED_CHAIN: "anthropic:claude-haiku-5-5" } });
  await runAll(diverged);
  assert.deepEqual(diverged.github.resolved, []);
  assert.equal(diverged.models.judged.length, 0);

  const since = () => ({ status: "ahead", files: [{ filename: "worker/src/m3.js", status: "modified", patch: NEAR_20 }] });
  const none = setup({ github: threadsGithub({ files: SMALL, threads: [ownThread()], since }), models: judging({ "t:PRRT_a": "fixed" }), env: { ADDRESSED_CHAIN: "workers-ai:@cf/openai/gpt-oss-120b" } });
  await runAll(none);
  assert.deepEqual(none.github.resolved, []);
  assert.match(none.github.summaries[0].body, /Some open threads could not be checked this time \([^)]+\); they stay open\./);
  assert.equal(none.github.statuses.at(-1).state, "success");
  assert.equal(none.done[0].reviewedSha, HEAD);

  // A finding whose commit is gone (404) stays open too.
  const gone = setup({ github: threadsGithub({ files: SMALL, threads: [ownThread()], since: () => { throw Object.assign(new Error("nf"), { status: 404 }); } }), models: judging({ "t:PRRT_a": "fixed" }), env: { ADDRESSED_CHAIN: "anthropic:claude-haiku-5-5" } });
  await runAll(gone);
  assert.deepEqual(gone.github.resolved, []);
});

test("findings with no thread (outside the diff) are kept as open findings, and cleared once a later commit fixes them", async () => {
  // A finding on a line the PR's diff no longer shows: listed in the body.
  const s = setup({ github: threadsGithub({ files: SMALL }), models: fakeModels(), job: { since: "e".repeat(40) } });
  s.github.compare = async (_r, base, head) => ({ status: "ahead", files: SMALL });
  await runAll(s);
  assert.equal(s.github.posted[0].event, "REQUEST_CHANGES");
  assert.equal(s.github.posted[0].comments.length, 0, "GitHub could not place it inline");
  const open = await s.storage.get("openFindings");
  assert.equal(open.length, 1);
  assert.equal(open[0].path, "worker/src/m3.js");
  assert.equal(open[0].sha, HEAD);

  // The next review, at a new head: the change near it fixed it.
  const NEXT = "f".repeat(40);
  const later = setup({ github: threadsGithub({ files: SMALL, pr: { head: { sha: NEXT } } }), models: judging({ [`b:${open[0].id}`]: "fixed" }), env: { ADDRESSED_CHAIN: "anthropic:claude-haiku-5-5" } });
  await later.storage.put("openFindings", open);
  later.github.compare = async (_r, base, head) => (base === HEAD
    ? { status: "ahead", files: [{ filename: "worker/src/m3.js", status: "modified", patch: `@@ -${open[0].line},1 +${open[0].line},1 @@\n-x\n+y` }] }
    : { status: "diverged", merge_base_commit: { sha: MERGE_BASE }, files: [] });
  await runAll(later);
  assert.deepEqual(await later.storage.get("openFindings"), []);
});

test("findings GitHub would not place inline (its 422 fallback) are kept as open findings, with those off the diff", async () => {
  const github = threadsGithub({ files: SMALL });
  github.postReview = async (_r, _p, review) => { github.posted.push(review); return { inline: 0 }; };
  const s = setup({ github, models: fakeModels() });
  await runAll(s);
  assert.equal(s.github.posted.length, 1);
  const open = await s.storage.get("openFindings");
  assert.equal(open.length, 1);
  assert.match(open[0].id, /^[0-9a-f]{8}$/);
  assert.equal(open[0].path, "worker/src/m3.js");
});

test("a review that checks threads from many commits still finishes: every threads step counts as a success", async () => {
  // 30 threads, each from its own commit: six compare steps, then the rest.
  const commits = Array.from({ length: 30 }, (_, i) => (i + 10).toString(16).padStart(40, "0"));
  const threads = commits.map((c, i) => ownThread({ id: `PRRT_${i}`, findingId: null, commentId: 100 + i, originalCommit: c }));
  const github = threadsGithub({ files: SMALL, threads });
  const plain = github.compare;
  github.compare = async (r, base, head) => (commits.includes(base) ? { status: "ahead", files: [] } : plain(r, base, head));
  const s = setup({ github, models: fakeModels({ flag: "nothing-here.js" }) });
  await runAll(s);
  assert.equal(s.done[0].gaveUp, false);
  assert.equal(s.done[0].reviewedSha, HEAD);
  assert.equal(s.github.summaries.length, 1);
  assert.equal(s.github.statuses.at(-1).state, "success");
});

test("nitpicks block approval too: listed in the body, kept as open findings; the quiet profile's left-out ones do not", async () => {
  const nit = { severity: "trivial", type: "nitpick", title: "Name it better" };
  const chill = setup({ github: threadsGithub({ files: SMALL }), models: fakeModels({ finding: nit }) });
  await runAll(chill);
  assert.equal(chill.github.posted.length, 1);
  assert.equal(chill.github.posted[0].event, "REQUEST_CHANGES");
  assert.equal(chill.github.posted[0].comments.length, 0, "a nitpick goes in the body under the chill profile");
  const open = await chill.storage.get("openFindings");
  assert.equal(open.length, 1);
  assert.equal(open[0].severe, false);
  assert.match(chill.github.summaries[0].body, /Actionable comments posted: 1\./);

  const quiet = setup({ github: threadsGithub({ files: SMALL }), models: fakeModels({ finding: nit }), env: { REVIEW_PROFILE: "quiet" } });
  await runAll(quiet);
  assert.equal(quiet.github.posted.length, 0, "nothing shown, nothing to resolve: no review");
  assert.equal((await quiet.storage.get("openFindings")) ?? null, null);
  assert.match(quiet.github.summaries[0].body, /No actionable comments were generated/);
});

test("a thread a person reopened is never resolved by the reviewer again", async () => {
  const since = () => ({ status: "ahead", files: [{ filename: "worker/src/m3.js", status: "modified", patch: NEAR_20 }] });
  const models = judging({ "t:PRRT_a": "fixed" });
  const s = setup({ github: threadsGithub({ files: SMALL, threads: [ownThread()], since }), models, env: { ADDRESSED_CHAIN: "anthropic:claude-haiku-5-5" } });
  await s.storage.put("reopenedThreads", ["PRRT_a"]);
  await runAll(s);
  assert.equal(models.judged.length, 0);
  assert.deepEqual(s.github.resolved, []);
  assert.match(s.github.summaries[0].body, /1 still open/);
});

test("a commit with nothing reviewable (a file deleted) still re-checks earlier threads, then says so", async () => {
  const github = threadsGithub({ files: [file("worker/src/m3.js", undefined, { status: "removed", additions: 0, deletions: 30 })], threads: [ownThread()], since: () => ({ status: "ahead", files: [{ filename: "worker/src/m3.js", status: "removed" }] }) });
  const s = setup({ github, models: fakeModels({ flag: "nothing-here.js" }) });
  await runAll(s);
  assert.deepEqual(s.github.resolved, ["PRRT_a"]);
  assert.equal(s.github.posted.length, 0);
  assert.match(s.github.summaries[0].body, /No reviewable changes/);
  assert.equal(s.github.statuses.at(-1).state, "success");
  assert.equal(s.done[0].reviewedSha, HEAD);
});
