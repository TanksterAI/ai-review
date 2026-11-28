// The Worker's own review of a pull request (PR C, TAN-278): full coverage,
// run in the PR's Durable Object alarm instead of on a runner.
//
// Why here: a review that makes many model calls takes minutes, and a runner
// holding one HTTP request open for it is cut off at about 64 s (TAN-278). A
// Durable Object alarm may run for 15 minutes with 30 s of CPU, and it can
// arm itself again at once, so a review of any size is done in steps, each
// one inside Workers Free's 50 subrequests per invocation:
//
//   pr       read the pull request (open? head commit? already reviewed?)
//   files    list its files, 10 pages a step (GitHub lists 3,000 at most)
//   content  for files GitHub sends without a patch (very large diffs), fetch
//            the old and new text and work the diff out (linediff.js)
//   plan     cut the whole diff into batches (coverage.js): nothing is left
//            out for size
//   draft    draft up to DRAFT_PARALLEL batches a step, each with the whole
//            chain of free models, rotated so batches running together use
//            different free quotas; Claude on the plan's credit is last
//   verify   ground and verify one batch a step (every finding, TAN-299)
//   post     one review for the whole pull request, only when it has
//            findings: "Changes requested", as CodeRabbit's Automatic
//            Approvals do. A clean review posts no review.
//   threads  the App's own open threads (and findings it could only list in
//            a review's body) from earlier commits: those the new commits
//            addressed are marked "Addressed in commit …" and resolved
//            (addressed.js)
//   summary  the one summary comment, edited in place, and the commit status.
//            The PR's object then decides whether to approve (pr-state.js).
//
// Nothing waits while any provider can work. A batch waits only when every
// drafter (or every verifier) is out of quota, and then only until the first
// one resets; the commit status says so meanwhile. The commit status
// (STATUS_CONTEXT) is success only when every reviewable file was covered.
//
// State lives in the Durable Object's storage under run:<job id>, so a step
// that fails (the alarm throws and is retried) repeats only itself.

import { batchPrepared, coverageOf, onlyHidden, planReview, prLimitReason, skipReason, trimLongLines } from "./coverage.js";
import { unifiedDiff } from "./linediff.js";
import { createSerial, nextUtcMidnight, utcDay } from "./budget.js";
import { createProviders, draftChain } from "./providers.js";
import { draftWithChain } from "./draft.js";
import { groundFindings } from "./grounding.js";
import { applyVerdicts, verifyFindings } from "./verify.js";
import { SEVERITIES, buildPrompt, classifyFindings, codeSpan, placeComments, priority, renderReview, titleLine } from "./review.js";
import { addressedNote, findingIdOf, judgeAddressed, nearHunks, nitpickFinding, severeFinding } from "./addressed.js";
import { DEFAULT_SLUG } from "./webhook.js";
import { createMemory, searchTerms } from "./memory.js";
import { buildContext, renderContext } from "./context.js";

// A run's data (files, plan, batches) is under run:<id>:…; its small record
// under runmeta:<id>, so finding the run in progress never loads its data.
export const RUN = "run:";
export const RUN_META = "runmeta:";
export const STATUS_CONTEXT = "Tankster AI Review";
// Subrequests one step may make: Workers Free allows 50 an invocation.
export const STEP_SUBREQUESTS = 45;
const PAGES_PER_STEP = 10;
const MAX_PAGES = 30;
const CONTENTS_PER_STEP = 6;
// At most six connections may be open at once in an invocation.
export const DRAFT_PARALLEL = 4;
// A batch or a file tried this many times without an answer is given up, and
// counted as not covered.
const MAX_TRIES = 3;
export const MAX_RUN_LIFE_MS = 3 * 24 * 3600_000;
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
// Patches are stored in pieces: a Durable Object value is bounded.
const PIECE = 512 * 1024;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|mkv|webm|ogg|wav|flac|sqlite|db)$/i;

class Gone extends Error {}

function randomTag() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const passes = (n) => `${n} pass${n === 1 ? "" : "es"}`;

// --- storage helpers ---------------------------------------------------------

const metaKey = (id) => `${RUN_META}${id}`;
const fileKey = (id, i) => `${RUN}${id}:file:${String(i).padStart(5, "0")}`;
const pieceKey = (id, i, k) => `${fileKey(id, i)}:p${k}`;
const batchKey = (id, i) => `${RUN}${id}:batch:${String(i).padStart(4, "0")}`;
const planKey = (id) => `${RUN}${id}:plan`;
const contextKey = (id) => `${RUN}${id}:context`;
// Kept by the PR's object across runs: the summary comment's id, and the
// findings a review could only list in its body (they have no thread).
export const SUMMARY_KEY = "summaryComment";
// The summary comment's text as the last review wrote it, and the approval
// notice the latest decision added to it (pr-state.js decide).
export const SUMMARY_BASE = "summaryBase";
export const SUMMARY_NOTICE = "summaryNotice";
// The approval notice goes just under the heading, as CodeRabbit's does.
export function withNotice(base, notice) {
  const text = String(base ?? "");
  if (!notice) return text;
  const at = text.indexOf("\n");
  return at < 0 ? `${text}\n\n${notice}` : `${text.slice(0, at)}\n\n${notice}${text.slice(at)}`;
}
// One key a finding (OPEN_FINDINGS + its id), so none is ever dropped for
// space: each stays until it is addressed or cleared.
export const OPEN_FINDINGS = "openfinding:";
// One key a thread, so no mark or acceptance is ever evicted to make room.
// A thread a person reopened by hand (pr-state.js) keeps its mark (REOPENED +
// thread id → mark number) until someone with write access resolves it or the
// PR merges: the reviewer never resolves it again; it is that person's to close.
export const REOPENED = "reopened:";
// A thread resolved by someone without write access that a later review
// found fixed, or that a writer's resolve/approve vouched for (ACCEPTED +
// thread id): it no longer holds back approval (pr-state.js decide). It is
// kept until the thread is reopened or the PR merges.
export const ACCEPTED = "accepted:";
export async function reopenMark(storage, threadId) {
  return threadId ? storage.get(`${REOPENED}${threadId}`) : undefined;
}
async function idsUnder(storage, prefix) {
  return new Set([...(await storage.list({ prefix })).keys()].map((k) => k.slice(prefix.length)));
}
export const reopenedSet = (storage) => idsUnder(storage, REOPENED);
export const acceptedSet = (storage) => idsUnder(storage, ACCEPTED);
export async function acceptThreads(storage, ids) {
  for (let i = 0; i < ids.length; i += 128) await storage.put(Object.fromEntries(ids.slice(i, i + 128).map((id) => [`${ACCEPTED}${id}`, true])));
}
export async function clearPrefix(storage, prefix) {
  const keys = [...(await storage.list({ prefix })).keys()];
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
}
const threadsKey = (id) => `${RUN}${id}:threads`;
const summaryKey = (id) => `${RUN}${id}:summary`;
// GitHub calls one threads step may make (each counts as a subrequest).
const COMPARES_PER_STEP = 6;
const COMMITS_SHOWN = 20;
const APPLIES_PER_STEP = 10;
const JUDGE_CHARS = 50_000;
// A commit reviewed at full coverage. Not the single-prompt paths' done: key.
// The base branch is part of the mark: a retarget leaves the head the same but
// the diff (and so what was reviewed) different.
export const doneKeyOf = (run) => `donefull:${run.repo.full}#${run.pr}@${run.headSha}${run.baseRef ? `~${run.baseRef}` : ""}`;

// A file's record holds its patch's length, never the patch: the patch is in
// pieces of its own, so the plan can choose what fits the pull request's
// limit before it loads any text.
const META_FIELDS = ["filename", "status", "additions", "deletions", "sha", "previous_filename", "patch_omitted", "synthetic", "unfetched", "binary", "checked", "contentTries", "minified", "hiddenAdded", "hiddenLines"];

async function putFile(storage, id, i, f, batchChars) {
  const rec = {};
  for (const k of META_FIELDS) if (f[k] !== undefined) rec[k] = f[k];
  // Long lines are cut before anything is stored or counted (coverage.js).
  let patch = typeof f.patch === "string" ? f.patch : null;
  if (patch !== null) {
    // What was cut is recorded, added to what an earlier cut recorded.
    const t = trimLongLines(patch, batchChars);
    patch = t.patch;
    rec.hiddenAdded = (Number(f.hiddenAdded) || 0) + t.hidden;
    rec.hiddenLines = [...(Array.isArray(f.hiddenLines) ? f.hiddenLines : []), ...t.hiddenLines];
    rec.allHidden = onlyHidden(t, rec.hiddenAdded);
  }
  rec.patchLen = patch === null ? -1 : patch.length;
  if (patch !== null) {
    let n = 1;
    for (let k = patch.indexOf("\n"); k >= 0; k = patch.indexOf("\n", k + 1)) n++;
    rec.patchLines = n;
  }
  rec.pieces = patch === null ? 0 : Math.max(1, Math.ceil(patch.length / PIECE));
  for (let k = 0; k < rec.pieces; k++) await storage.put(pieceKey(id, i, k), patch.slice(k * PIECE, (k + 1) * PIECE));
  await storage.put(fileKey(id, i), rec);
}

const getMeta = (storage, id, i) => storage.get(fileKey(id, i));

// What a patch costs of the pull request's limit once annotated: every line
// gains its number (about 8 characters), and each part a header.
export const ANNOTATION_PER_LINE = 8;
const costOf = (len, lines) => len + ANNOTATION_PER_LINE * lines + 200;
// A file whose added lines are all too long to show is minified or
// generated data (coverage.js): it never counts against the limit.

async function getFile(storage, id, i) {
  const rec = await getMeta(storage, id, i);
  if (!rec) return rec;
  const { pieces, patchLen, patchLines: _n, allHidden: _h, ...f } = rec;
  if (patchLen < 0) return f;
  const parts = [];
  for (let k = 0; k < pieces; k++) parts.push(await storage.get(pieceKey(id, i, k)));
  return { ...f, patch: parts.join("") };
}

/** Deletes everything a run stored. */
export async function dropRun(storage, id) {
  const keys = [metaKey(id), ...(await storage.list({ prefix: `${RUN}${id}:` })).keys()];
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
}

/** The run in progress, if any. One per pull request at a time. */
export async function activeRun(storage) {
  for (const v of (await storage.list({ prefix: RUN_META })).values()) if (v && v.stage !== "done") return v;
  return null;
}

/** Starts a run for a job: the alarm takes it from there. */
export async function startRun(storage, job, now) {
  const run = {
    id: job.id, repo: job.repo, pr: job.pr, since: job.since ?? null, full: Boolean(job.full),
    requestedBy: job.requestedBy ?? null, force: Boolean(job.requestedBy) || Boolean(job.force),
    stage: "pr", createdAt: now, page: 1, files: 0, tries: 0, waitUntil: 0,
    spend: { neurons: 0, usd: 0 }, drafters: {}, statusOk: null,
  };
  await storage.put(metaKey(job.id), run);
  return run;
}

// --- one step ------------------------------------------------------------------

/**
 * Runs one step of a run. ctx: {storage, env, cfg, fx, deps: {now, sleep,
 * fetch, log}, again, onDone(run, {reviewedSha, posted})}. Returns when the
 * next step is due (epoch ms; now for at once), or null once the run is over.
 */
export async function stepRun(ctx, id) {
  const { storage, deps } = ctx;
  const run = await storage.get(metaKey(id));
  if (!run || run.stage === "done") return null;
  if (run.waitUntil > deps.now()) return run.waitUntil;
  // However long it waits for providers, a run is given up after three days.
  if (deps.now() - run.createdAt > MAX_RUN_LIFE_MS) {
    return finish(ctx, run, (r) => storage.put(metaKey(id), r), { state: "error", description: "The review waited three days for a model provider and stopped. Comment \"review\" to try again.", gaveUp: true });
  }
  // Subrequests left in this invocation: the model calls and their ledgers.
  const budget = { left: STEP_SUBREQUESTS };
  const counted = countSubrequests(ctx, budget);
  // A run deleted while this step waited on a model (the PR was closed) is
  // not written back: the step stops, and what it wrote is cleaned up.
  const save = async (r) => {
    if (!(await storage.get(metaKey(id)))) throw new Gone();
    await storage.put(metaKey(id), r);
  };
  // Failures are counted in a row, and an attempt is counted before it runs:
  // a step killed outright (out of memory, out of CPU) throws nothing, but it
  // still counts. A step that succeeds starts the count again.
  const failedBefore = run.tries ?? 0;
  if (failedBefore >= MAX_TRIES * 2) {
    return finish(ctx, run, (r) => storage.put(metaKey(id), r), { state: "error", description: `The review stopped: its ${run.stage} step kept failing.`, gaveUp: true });
  }
  await storage.put(metaKey(id), { ...run, tries: failedBefore + 1 });
  run.tries = 0;
  try {
    if (run.stage === "pr") return await stagePr(counted, run, save);
    if (run.stage === "files") return await stageFiles(counted, run, save);
    if (run.stage === "content") return await stageContent(counted, run, save);
    if (run.stage === "context") return await stageContext(counted, run, save);
    if (run.stage === "plan") return await stagePlan(counted, run, save);
    if (run.stage === "draft") return await stageDraft(counted, run, save);
    if (run.stage === "verify") return await stageVerify(counted, run, save);
    if (run.stage === "post") return await stagePost(counted, run, save);
    if (run.stage === "threads") return await stageThreads(counted, run, save);
    if (run.stage === "summary") return await stageSummary(counted, run, save);
  } catch (e) {
    if (e instanceof Gone) {
      await dropRun(storage, id);
      return null;
    }
    // A step that throws is tried again, a few times, then the run is given up.
    run.tries = failedBefore + 1;
    deps.log?.({ ev: "run_step_failed", stage: run.stage, tries: run.tries, error: String(e?.message ?? e).slice(0, 200) });
    try {
      if (run.tries >= MAX_TRIES * 2) return await finish(counted, run, save, { state: "error", description: `The review stopped: its ${run.stage} step kept failing.`, gaveUp: true });
      await save(run);
    } catch (e2) {
      if (!(e2 instanceof Gone)) throw e2;
      await dropRun(storage, id);
      return null;
    }
    return deps.now() + 30_000 * run.tries;
  }
  return null;
}

// KV and model calls (deps.fetch) count against the step's subrequests.
function countSubrequests(ctx, budget) {
  const kv = ctx.env.LEDGER;
  const LEDGER = kv && {
    async get(...a) { budget.left--; return kv.get(...a); },
    async put(...a) { budget.left--; return kv.put(...a); },
  };
  const fetch = (...a) => { budget.left--; return ctx.deps.fetch(...a); };
  // Workers AI goes through its binding: a subrequest too.
  const AI = ctx.env.AI && { run: (...a) => { budget.left--; return ctx.env.AI.run(...a); } };
  return { ...ctx, budget, env: { ...ctx.env, ...(LEDGER ? { LEDGER } : {}), ...(AI ? { AI } : {}) }, deps: { ...ctx.deps, fetch, serial: createSerial() } };
}

async function status(ctx, run, state, description) {
  // lastStatusOk: whether the latest write landed, so a run that ends after
  // holding the neutral "delayed" success can put the commit back to pending.
  if (!run.headSha || run.statusOk === false) { run.lastStatusOk = false; return; }
  try {
    const ok = await ctx.fx.setStatus(run.repo.full, run.headSha, state, description);
    run.lastStatusOk = ok !== false;
    if (ok === false && run.statusOk !== false) {
      run.statusOk = false;
      ctx.deps.log?.({ ev: "status_unavailable", reason: "the App lacks statuses:write" });
    } else if (ok) run.statusOk = true;
  } catch (e) {
    run.lastStatusOk = false;
    ctx.deps.log?.({ ev: "status_failed", error: String(e?.message ?? e).slice(0, 120) });
  }
}

async function finish(ctx, run, save, { state, description, posted = false, gaveUp = false, reviewedSha = null }) {
  if (state) await status(ctx, run, state, description);
  // Before the run is marked done (a done run is not picked up again): any
  // follow-up the gate needs, such as resetting a held success, is handed over.
  await ctx.beforeDone?.(run, { reviewedSha, state });
  run.stage = "done";
  run.outcome = { state, posted, gaveUp };
  await save(run);
  await ctx.onDone?.(run, { reviewedSha, posted, gaveUp, description });
  return null;
}

// --- stages --------------------------------------------------------------------

async function stagePr(ctx, run, save) {
  const pr = await ctx.fx.pullRequest(run.repo.full, run.pr);
  if (pr?.state !== "open") return finish(ctx, run, save, {});
  run.headSha = pr.head.sha;
  run.baseSha = pr.base.sha;
  run.baseRef = typeof pr.base?.ref === "string" ? pr.base.ref.slice(0, 255) : "";
  run.title = String(pr.title ?? "").slice(0, 300);
  run.body = String(pr.body ?? "").slice(0, 3000);
  run.changedFiles = Number(pr.changed_files) || 0;
  // Only a full-coverage review's own mark counts: the single-prompt paths
  // (v1, REVIEW_MODE=runner) mark commits done: too, but read at most 90,000
  // characters of them.
  if (!run.force && (await ctx.env.LEDGER?.get(doneKeyOf(run)))) {
    ctx.deps.log?.({ ev: "run_duplicate", repository: run.repo.full, pr: run.pr });
    return finish(ctx, run, save, { state: "success", description: "This commit was already reviewed at 100% coverage.", reviewedSha: run.headSha });
  }
  await status(ctx, run, "pending", "Reviewing every changed file…");
  // Incremental when the last reviewed commit is still behind the head (no
  // force-push since), and the comparison lists every file it changed.
  if (run.since && run.since !== run.headSha && !run.full) {
    try {
      const cmp = await ctx.fx.compare(run.repo.full, run.since, run.headSha);
      const files = Array.isArray(cmp?.files) ? cmp.files : [];
      if (cmp?.status === "ahead" && files.length < 300) {
        for (const [i, f] of files.entries()) await putFile(ctx.storage, run.id, i, f, ctx.cfg.batchChars);
        run.files = files.length;
        run.mergeBase = run.since;
        // The commits this review covers, shown in its summary (the last 20).
        const cs = Array.isArray(cmp.commits) ? cmp.commits : [];
        run.commitCount = Number.isSafeInteger(cmp.total_commits) ? cmp.total_commits : cs.length;
        run.commits = cs.slice(-COMMITS_SHOWN).map((c) => ({ sha: String(c?.sha ?? ""), subject: String(c?.commit?.message ?? "").split("\n")[0] }));
        run.stage = "content";
        await save(run);
        return ctx.deps.now();
      }
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  run.since = null;
  run.stage = "files";
  await save(run);
  return ctx.deps.now();
}

async function stageFiles(ctx, run, save) {
  for (let n = 0; n < PAGES_PER_STEP; n++) {
    const page = await ctx.fx.listFiles(run.repo.full, run.pr, run.page);
    const list = Array.isArray(page) ? page : [];
    for (const f of list) await putFile(ctx.storage, run.id, run.files++, f, ctx.cfg.batchChars);
    run.page++;
    if (list.length < 100 || run.page > MAX_PAGES) {
      run.stage = "content";
      break;
    }
  }
  await save(run);
  return ctx.deps.now();
}

const NUL = (bytes) => bytes.subarray(0, 8000).includes(0);

// Files GitHub sent without a patch: their diff, worked out from both sides.
async function stageContent(ctx, run, save) {
  // The diff characters already in hand (GitHub's own patches), so files
  // without a patch are fetched only while they can still fit the limit.
  if (run.patchChars === undefined) {
    run.patchChars = 0;
    for (let i = 0; i < run.files; i++) {
      const m = await getMeta(ctx.storage, run.id, i);
      if (m && m.patchLen > 0 && !skipReason(m) && !m.allHidden) run.patchChars += costOf(m.patchLen, m.patchLines ?? 0);
    }
  }
  if (!run.mergeBase) {
    const cmp = await ctx.fx.compare(run.repo.full, run.baseSha, run.headSha);
    run.mergeBase = cmp?.merge_base_commit?.sha ?? run.baseSha;
  }
  let done = 0;
  for (let i = run.contentAt ?? 0; i < run.files; i++) {
    const f = await getFile(ctx.storage, run.id, i);
    run.contentAt = i;
    const needs = f && typeof f.patch !== "string" && !skipReason(f) && !BINARY_EXT.test(f.filename) && f.status !== "removed" && !f.checked;
    if (!needs) continue;
    if (done >= CONTENTS_PER_STEP) { await save(run); return ctx.deps.now(); }
    done++;
    // Both sides are always fetched and diffed: only the added lines can say
    // whether a file is minified data (not reviewable, not counted), and a
    // long unchanged line is cut by trimLongLines, never taken for the file.
    const left = ctx.cfg.maxPrChars - run.patchChars;
    try {
      const head = f.sha ? await ctx.fx.blob(run.repo.full, f.sha) : null;
      const oldPath = f.previous_filename ?? f.filename;
      const baseSha = f.status === "added" ? null : await ctx.fx.fileSha(run.repo.full, oldPath, run.mergeBase);
      const base = baseSha ? await ctx.fx.blob(run.repo.full, baseSha) : null;
      if (!head) f.unfetched = "its new text could not be fetched";
      else if (head.bytes.length > MAX_FETCH_BYTES || (base?.bytes.length ?? 0) > MAX_FETCH_BYTES) f.unfetched = `it is over the reviewer's limit of ${MAX_FETCH_BYTES / 1024 / 1024} MB a file`;
      else if (NUL(head.bytes) || (base && NUL(base.bytes))) f.binary = true;
      else {
        const dec = new TextDecoder();
        let patch = "";
        try {
          patch = unifiedDiff(base ? dec.decode(base.bytes) : "", dec.decode(head.bytes));
        } catch {
          f.unfetched = "its diff could not be worked out";
        }
        const t = patch ? trimLongLines(patch, ctx.cfg.batchChars) : null;
        const lines = t ? t.patch.split("\n").length : 0;
        // Every added line minified or generated: named as such, never kept or counted.
        if (t && onlyHidden(t, t.hidden)) f.minified = true;
        else if (t && costOf(t.patch.length, lines) > left) f.unfetched = prLimitReason(ctx.cfg.maxPrChars);
        else if (t) { f.patch = t.patch; f.hiddenAdded = t.hidden; f.hiddenLines = t.hiddenLines; f.synthetic = true; run.patchChars += costOf(t.patch.length, lines); }
      }
      f.checked = true;
    } catch (e) {
      f.contentTries = (f.contentTries ?? 0) + 1;
      if (f.contentTries < MAX_TRIES) { await putFile(ctx.storage, run.id, i, f, ctx.cfg.batchChars); await save(run); return ctx.deps.now() + 10_000; }
      f.unfetched = "its text could not be fetched";
      f.checked = true;
    }
    await putFile(ctx.storage, run.id, i, f, ctx.cfg.batchChars);
  }
  // Reading the conversation and the checks comes first when this deployment
  // can (older fakes and the runner paths cannot, and go straight on).
  run.stage = ctx.cfg.contextMode !== "off" && typeof ctx.fx.conversation === "function" ? "context" : "plan";
  await save(run);
  return ctx.deps.now();
}

// What others have said on the pull request, and what its checks report, read
// once per run and kept bounded for the drafting and verifying steps. A read
// that fails never fails the review: it goes on without, and says so.
async function stageContext(ctx, run, save) {
  const login = `${ctx.slug ?? DEFAULT_SLUG}[bot]`;
  try {
    const [conv, ci] = await Promise.all([
      ctx.fx.conversation(run.repo.full, run.pr),
      typeof ctx.fx.ciState === "function" ? ctx.fx.ciState(run.repo.full, run.headSha).catch(() => ({ checks: [], statuses: [], runs: [], missing: ["checks and workflows"] })) : null,
    ]);
    // What the maintainers taught it about this repository: never fatal.
    let lessons = [];
    try {
      lessons = (await createMemory(ctx.env.MEMORY)?.relevant({ repo: run.repo.full, terms: searchTerms(run.title, run.body), limit: 8 })) ?? [];
    } catch (e) {
      ctx.deps.log?.({ ev: "lessons_failed", error: String(e?.message ?? e).slice(0, 160) });
    }
    const built = buildContext({ conv, ci, lessons, ourLogin: login });
    const { stats } = renderContext(built, { tag: "x", max: ctx.cfg.contextChars });
    await ctx.storage.put(contextKey(run.id), built);
    run.context = { ...stats, partial: Boolean(conv?.moreThreads) || Boolean(conv?.moreTalk) || Boolean(ci?.truncated) || Boolean(ci?.missing?.length), missing: ci?.missing ?? [] };
  } catch (e) {
    ctx.deps.log?.({ ev: "context_failed", error: String(e?.message ?? e).slice(0, 160) });
    run.context = { failed: true };
  }
  run.stage = "plan";
  await save(run);
  return ctx.deps.now();
}

async function stagePlan(ctx, run, save) {
  // What fits the limit is chosen from the records, in the plan's order
  // (code, tests, docs), and only those patches are loaded.
  const metas = [];
  for (let i = 0; i < run.files; i++) metas.push({ i, m: await getMeta(ctx.storage, run.id, i) });
  metas.sort((x, y) => priority(x.m.filename) - priority(y.m.filename) || x.i - y.i);
  const files = [];
  let budget = ctx.cfg.maxPrChars;
  for (const { i, m } of metas) {
    const { pieces: _p, patchLen: _l, patchLines: _n, allHidden: _h, ...rec } = m;
    if (m.patchLen > 0 && m.allHidden) { files.push({ ...rec, minified: true }); continue; }
    if (m.patchLen > 0 && !skipReason(m) && m.unfetched === undefined) {
      const cost = costOf(m.patchLen, m.patchLines ?? 0);
      if (cost > budget) { files.push({ ...rec, unfetched: prLimitReason(ctx.cfg.maxPrChars) }); continue; }
      budget -= cost;
      files.push(await getFile(ctx.storage, run.id, i));
    } else {
      files.push(rec);
    }
  }
  const plan = planReview(files, { batchChars: ctx.cfg.batchChars, maxPrChars: ctx.cfg.maxPrChars });
  // GitHub lists 3,000 files at most: any beyond that are not covered.
  if (!run.since && run.changedFiles > run.files) {
    plan.uncovered.push({ path: `(${run.changedFiles - run.files} more files)`, reason: "GitHub lists at most 3,000 files of a pull request" });
  }
  const { batches, ...rest } = plan;
  await ctx.storage.put(planKey(run.id), { ...rest, batchCount: batches.length });
  for (const [i, parts] of batches.entries()) await ctx.storage.put(batchKey(run.id, i), { parts, status: "pending", draftTries: 0, verifyTries: 0, waitUntil: 0 });
  run.batches = batches.length;
  if (!batches.length && !plan.uncovered.length) {
    // Nothing reviewable at all: a pass. Earlier threads are still checked (a
    // commit that deletes a file can address them), then the summary.
    await ctx.storage.put(summaryKey(run.id), { summary: "No reviewable changes (deleted, binary or generated files only).", about: "", shown: 0, complete: true, none: true, since: run.since ?? null, covered: 0, reviewable: 0 });
    run.result = { complete: true, shown: 0, covered: 0, reviewable: 0, none: true };
    run.posted = { inline: 0, none: true };
    await ctx.env.LEDGER?.put(doneKeyOf(run), utcDay(ctx.deps.now()), { expirationTtl: 30 * 24 * 3600 });
    run.stage = "threads";
    await save(run);
    return ctx.deps.now();
  }
  if (!batches.length) {
    // Reviewable files, none of which could be taken: the review says so.
    run.stage = "post";
    await save(run);
    return ctx.deps.now();
  }
  const files_ = plan.files.length + plan.uncovered.length;
  await status(ctx, run, "pending", `Reviewing ${plural(files_, "file")} in ${passes(batches.length)}…`);
  run.stage = "draft";
  await save(run);
  return ctx.deps.now();
}

async function loadPlan(ctx, run) {
  const plan = await ctx.storage.get(planKey(run.id));
  const batches = [];
  for (let i = 0; i < run.batches; i++) batches.push(await ctx.storage.get(batchKey(run.id, i)));
  return { plan, batches };
}

// The plan as coverage.js made it, from storage.
const asPlan = (plan, batches) => ({ ...plan, batches: batches.map((b) => b.parts) });

// The drafting chain for batch i: the free models rotated, so batches drafted
// together draw on different free quotas; the paid ones (the plan's credit)
// always last.
export function rotatedChain(chain, i) {
  const free = chain.filter((x) => x.kind !== "anthropic");
  const paid = chain.filter((x) => x.kind === "anthropic");
  const k = free.length ? i % free.length : 0;
  return [...free.slice(k), ...free.slice(0, k), ...paid];
}

const earliestWait = (outcomes, now) => {
  const waiting = outcomes.filter((o) => o.kind === "deferred" || (o.kind === "unavailable" && o.resetAt));
  if (!waiting.length) return null;
  return Math.min(...waiting.map((o) => o.resetAt ?? nextUtcMidnight(now)));
};

async function stageDraft(ctx, run, save) {
  const { plan, batches } = await loadPlan(ctx, run);
  const now = ctx.deps.now();
  const todo = batches.map((b, i) => ({ b, i })).filter(({ b }) => b.status === "pending" && !(b.waitUntil > now)).slice(0, DRAFT_PARALLEL);
  const started = now;
  if (!todo.length) return next(ctx, run, save, batches, "pending", "verify");
  // Providers out of quota are found once a step, not by every batch: a
  // batch that had to walk past them on its own share of the subrequests
  // could run out of share before it reached one that can work.
  const chain = [];
  const resets = [];
  for (const x of draftChain(ctx.env, ctx.cfg)) {
    const [p] = createProviders(ctx.env, ctx.cfg, [x], ctx.deps);
    if (!p.configured) continue;
    const until = await p.exhausted();
    if (until) resets.push(until);
    else chain.push(x);
  }
  if (!chain.length && resets.length) {
    // Every drafter is out of quota: the batches wait for the first reset.
    const at = Math.min(...resets);
    for (const { b, i } of todo) { b.waitUntil = at; await ctx.storage.put(batchKey(run.id, i), b); }
    return next(ctx, run, save, batches, "pending", "verify");
  }
  // What others said and what the checks report (stageContext), if read.
  const contextBuilt = run.context?.failed ? null : await ctx.storage.get(contextKey(run.id));
  // Each batch drafted in this step gets its share of what is left, so
  // batches running at once cannot overrun the step together.
  const share = Math.floor(Math.max(0, ctx.budget.left) / Math.max(1, todo.length));
  await Promise.all(todo.map(async ({ b, i }) => {
    const mine = { left: share };
    const bctx = countSubrequests(ctx, mine);
    const prepared = batchPrepared(asPlan(plan, batches), i);
    const tag = randomTag();
    const { instructions, input } = buildPrompt({ repository: run.repo.full, title: run.title, body: run.body, prepared, tag, pass: { index: i + 1, total: batches.length }, context: renderContext(contextBuilt, { tag, max: ctx.cfg.contextChars }).text });
    const chars = instructions.length + input.length;
    const providers = createProviders(bctx.env, ctx.cfg, rotatedChain(chain, i), bctx.deps);
    const d = await draftWithChain({ providers, instructions, modelInput: input, chars, cfg: ctx.cfg, deps: bctx.deps, started, repository: run.repo.full, pr: run.pr, budget: mine });
    run.spend.neurons += d.neurons;
    run.spend.usd += d.usd;
    if (d.answer) {
      b.status = "drafted";
      b.findings = Array.isArray(d.answer.findings) ? d.answer.findings.slice(0, 40) : [];
      b.drafter = { id: d.used.id, kind: d.used.kind, model: d.used.model, label: d.used.label };
      run.drafters[d.used.id] = (run.drafters[d.used.id] ?? 0) + 1;
    } else if (d.outOfStep || d.late || d.timedOut) {
      // Carried on in the next step.
    } else {
      const wait = earliestWait(d.outcomes, ctx.deps.now());
      if (wait) b.waitUntil = wait;
      else if ((b.draftTries = (b.draftTries ?? 0) + 1) >= MAX_TRIES) { b.status = "failed"; b.reason = d.outcomes.at(-1)?.reason ?? "no model could review it"; }
    }
    await ctx.storage.put(batchKey(run.id, i), b);
  }));
  return next(ctx, run, save, batches, "pending", "verify");
}

// What comes after a step. Batches still at this stage (status `at`): none
// left, on to the next stage at once; one ready, at once; all waiting for a
// provider to reset, when the first is due (the status says so meanwhile).
async function next(ctx, run, save, batches, at, nextStage) {
  const now = ctx.deps.now();
  const left = batches.filter((b) => b.status === at);
  if (!left.length) {
    run.stage = nextStage;
    run.waitUntil = 0;
    await save(run);
    return now;
  }
  if (left.some((b) => !(b.waitUntil > now))) { await save(run); return now; }
  run.waitUntil = Math.min(...left.map((b) => b.waitUntil));
  const plan = await ctx.storage.get(planKey(run.id));
  const done = new Set(batches.map((b, i) => (b.status === "verified" ? i : -1)).filter((i) => i >= 0));
  const cov = coverageOf(plan, done);
  // Neutral, as CodeRabbit's rate-limited run is, while nothing has been
  // reviewed yet: the gate passes and the finished review replaces this status.
  // Once some files are reviewed it stays pending, so a PR is never merged
  // with files unreviewed because the providers ran out.
  const delayed = `Review delayed: waiting for a model provider to reset at ${new Date(run.waitUntil).toISOString().slice(11, 16)} UTC; ${cov.covered} of ${cov.reviewable} files reviewed so far.`;
  // Held until a non-success write lands, so a failed write cannot clear it.
  if (done.size === 0) run.heldSuccess = true;
  await status(ctx, run, done.size > 0 ? "pending" : "success", delayed);
  if (done.size > 0 && run.lastStatusOk) run.heldSuccess = false;
  await save(run);
  return run.waitUntil;
}

async function stageVerify(ctx, run, save) {
  const { plan, batches } = await loadPlan(ctx, run);
  const now = ctx.deps.now();
  const full = asPlan(plan, batches);
  const verifyContext = run.context?.failed ? null : await ctx.storage.get(contextKey(run.id));
  for (const [i, b] of batches.entries()) {
    if (b.status !== "drafted" || b.waitUntil > now) continue;
    const prepared = batchPrepared(full, i);
    const classified = classifyFindings({ findings: b.findings }, prepared.commentable, prepared.lineText);
    const grounded = groundFindings(classified, prepared, { title: run.title, body: run.body });
    const empty = !grounded.classified.inline.length && !grounded.classified.general.length;
    // Nothing passed the grounding gate: settled here, without a model call,
    // and the step goes on to the next batch.
    const v = empty
      ? { outcome: { kind: "ok" }, verdicts: new Map(), off: false, weak: false, fallback: false, fallbackBy: [], selfExcluded: [] }
      : await verifyFindings({ classified: grounded.classified, prepared, title: run.title, body: run.body, context: renderContext(verifyContext, { tag: randomTag(), max: ctx.cfg.contextChars }).text, drafter: b.drafter, env: ctx.env, cfg: ctx.cfg, deps: ctx.deps, started: now });
    run.spend.neurons += v.neurons ?? 0;
    run.spend.usd += v.usd ?? 0;
    const o = v.outcome;
    if (o.kind === "ok") {
      const { shown, hidden } = applyVerdicts(grounded.classified, grounded.dropped, v.verdicts);
      b.status = "verified";
      b.result = {
        shown, hidden,
        verification: { off: Boolean(v.off), weak: Boolean(v.weak), fallback: Boolean(v.fallback), fallbackBy: v.fallbackBy ?? [], selfExcluded: v.selfExcluded ?? [] },
      };
    } else if (o.kind === "deferred") {
      b.waitUntil = o.resetAt;
    } else if ((b.verifyTries = (b.verifyTries ?? 0) + 1) >= MAX_TRIES) {
      b.status = "failed";
      b.reason = o.reason;
    } else {
      b.waitUntil = now + (o.kind === "unavailable" ? 30_000 : 60_000);
    }
    await ctx.storage.put(batchKey(run.id, i), b);
    // One batch with findings a step: its verifier calls use the step's subrequests.
    if (!empty) break;
  }
  return next(ctx, run, save, batches, "drafted", "post");
}

// Findings from several batches, as one review: ids stay unique, and one
// finding seen twice (a file split across batches) is shown once.
export function mergeResults(results) {
  const shown = { inline: [], general: [] };
  const hidden = [];
  const ids = new Set();
  const seen = new Set();
  const flags = { off: true, weak: false, fallback: false, fallbackBy: [], selfExcluded: [] };
  for (const r of results) {
    for (const group of ["inline", "general"]) {
      for (const f of r.shown[group]) {
        const key = `${f.path}:${f.line}:${f.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let id = f.id;
        for (let n = 2; ids.has(id); n++) id = `${f.id}-${n}`;
        ids.add(id);
        shown[group].push({ ...f, id });
      }
    }
    for (const f of r.hidden) {
      let id = f.id;
      for (let n = 2; ids.has(id); n++) id = `${f.id}-${n}`;
      ids.add(id);
      hidden.push({ ...f, id });
    }
    const v = r.verification ?? {};
    flags.off &&= Boolean(v.off);
    flags.weak ||= Boolean(v.weak);
    flags.fallback ||= Boolean(v.fallback);
    flags.fallbackBy.push(...(v.fallbackBy ?? []));
    flags.selfExcluded.push(...(v.selfExcluded ?? []));
  }
  if (!results.length) flags.off = false;
  const rank = (x) => SEVERITIES.indexOf(x.severity);
  shown.inline.sort((a, b) => rank(a) - rank(b));
  shown.general.sort((a, b) => rank(a) - rank(b));
  flags.fallbackBy = [...new Set(flags.fallbackBy)];
  flags.selfExcluded = [...new Set(flags.selfExcluded)];
  return { shown, hidden, verification: flags };
}

const modelOf = (id) => String(id).slice(String(id).indexOf(":") + 1);

async function stagePost(ctx, run, save) {
  const { plan, batches } = await loadPlan(ctx, run);
  const done = new Set(batches.map((b, i) => (b.status === "verified" ? i : -1)).filter((i) => i >= 0));
  const full = asPlan(plan, batches);
  // Batches no model could review: their files are not covered.
  const failedPaths = new Set();
  for (const b of batches) if (b.status === "failed") for (const p of b.parts) failedPaths.add(p.path);
  const uncovered = [...plan.uncovered, ...[...failedPaths].map((path) => ({ path, reason: batches.find((b) => b.status === "failed" && b.parts.some((p) => p.path === path))?.reason ?? "no model could review it" }))];
  const cov = coverageOf(full, done);
  const notCovered = new Set(uncovered.map((u) => u.path));
  const coveredPaths = plan.files.filter((f) => !notCovered.has(f.path) && f.batches.every((b) => done.has(b))).map((f) => f.path);
  const merged = mergeResults(batches.filter((b) => b.status === "verified").map((b) => b.result));
  const ids = Object.entries(run.drafters);
  const modelLine = !ids.length
    ? "- Model: none: no file of this pull request could be sent to a model."
    : ids.length === 1
    ? `- Model: ${batches.find((b) => b.drafter?.id === ids[0][0])?.drafter.label ?? `\`${modelOf(ids[0][0])}\``}`
    : `- Models: ${ids.map(([id, n]) => `\`${modelOf(id)}\` (${passes(n)})`).join(", ")}; free tiers first, the plan's API credit last, never billed.`;
  const costParts = [];
  if (run.spend.neurons > 0) costParts.push(`${run.spend.neurons.toFixed(0)} neurons of Workers AI's free allocation`);
  if (run.spend.usd > 0) costParts.push(`$${run.spend.usd.toFixed(4)} of the plan's API credit`);
  const costLine = `- Cost (drafting and verification): ${costParts.length ? costParts.join(" and ") : "nothing (free tier)"}.`;
  const contextLine = contextLineOf(run.context);
  const review = renderReview({
    answer: null, classified: merged.shown, hidden: merged.hidden,
    prepared: { included: coveredPaths, omitted: plan.skipped, uncovered, chars: plan.chars, coverage: { ...cov, passes: batches.length } },
    verification: merged.verification,
    meta: { model: modelOf(ids[0]?.[0] ?? ""), modelLine, costLine, contextLine, again: ctx.again, headSha: run.headSha, since: run.since ?? null, profile: ctx.cfg.profile },
  });
  let { body: text, comments } = review;
  if (run.since) {
    // Inline comments may only sit on lines of the PR's own diff; findings on
    // lines a later commit undid go in the body instead.
    const lines = await ctx.fx.prLines(run.repo.full, run.pr, comments.map((c) => c.path));
    const { kept, off } = placeComments(comments, review.singleLine, lines);
    comments = kept;
    review.off = off;
    if (off.length) text += `\n\n#### Also noted (on lines no longer in this pull request's diff)\n\n${off.map((c) => `- \`${codeSpan(c.path)}:${c.line}\`: ${titleLine(c.body)}`).join("\n")}`;
    text += `\n\n_Incremental review: commits after \`${run.since.slice(0, 7)}\`._`;
  }
  // Actionable findings request changes and hold back approval; a review
  // with only nitpicks is a comment, and they never block (as CodeRabbit's).
  const shownCount = review.shown ?? review.blocking;
  const blocking = review.blocking;
  // Posted once, and only with findings: a step retried after the post (a
  // failed write below) does not post the review again. A review with no
  // findings posts nothing (CodeRabbit does not either); the summary comment
  // and the commit status say how it went.
  let posted = run.posted ?? null;
  if (!posted && shownCount > 0) {
    posted = await ctx.fx.postReview(run.repo.full, run.pr, { commitId: run.headSha, body: text, comments, event: blocking > 0 ? "REQUEST_CHANGES" : "COMMENT" });
    run.posted = { inline: posted?.inline ?? 0 };
    await save(run);
  }
  // Outside the post's guard: a step retried after the post still keeps them
  // (keeping one twice changes nothing).
  if (blocking > 0 && run.posted && !run.posted.none) {
    // Actionable findings with no thread of their own (outside the diff,
    // listed in the body; or GitHub would not place them) are kept, so they
    // too must be addressed before approval. One that names no file
    // cannot be checked against later changes, so it is not kept: it would
    // block approval with nothing to resolve.
    const inBody = [
      ...review.listed,
      // GitHub's refusal (422) moves every inline comment to the body; those
      // off the diff are in the body either way.
      // (Nitpicks among them never block.)
      ...[...(run.posted.inline < comments.length ? comments : []), ...(review.off ?? [])]
        .filter((c) => !nitpickFinding(c.body))
        .map((c) => ({ id: findingIdOf(c.body), path: c.path, line: c.line, severe: severeFinding(c.body), text: c.body })),
    ].filter((x) => x.id && x.path);
    if (inBody.length) {
      await keepOpenFindings(ctx.storage, inBody.map((x) => ({
        id: x.id, path: x.path, line: x.line ?? null, text: String(x.text).slice(0, 2500), sha: run.headSha,
        severe: x.severe ?? (x.severity === "critical" || x.severity === "major" || x.category === "security"),
      })));
    }
  }
  if (!run.posted) run.posted = { inline: 0, none: true };
  const complete = cov.complete;
  // Only a complete review marks the commit done and moves the PR's last
  // reviewed commit on: after an incomplete one, the next review starts from
  // the last complete one, so nothing it missed is passed over.
  if (complete) await ctx.env.LEDGER?.put(doneKeyOf(run), utcDay(ctx.deps.now()), { expirationTtl: 30 * 24 * 3600 });
  ctx.deps.log?.({ ev: "run_reviewed", repository: run.repo.full, pr: run.pr, passes: batches.length, covered: cov.covered, reviewable: cov.reviewable, shown: shownCount, hidden: merged.hidden.length, inline: run.posted.inline, neurons: Math.round(run.spend.neurons), usd: Number(run.spend.usd.toFixed(5)) });
  // What the summary comment shows, once the threads are checked.
  await ctx.storage.put(summaryKey(run.id), {
    summary: review.summary, about: review.about, shown: shownCount, actionable: blocking, complete, since: run.since ?? null,
    commits: run.since ? run.commits ?? [] : [], commitCount: run.since ? run.commitCount ?? 0 : 0,
    covered: cov.covered, reviewable: cov.reviewable,
  });
  run.result = { complete, shown: shownCount, covered: cov.covered, reviewable: cov.reviewable };
  run.stage = "threads";
  await save(run);
  return ctx.deps.now();
}

// The PR's open body-only findings: kept, listed, dropped one by one, and
// cleared. Keeping one twice changes nothing, so a retried step is safe.
// A finding's occurrence: its id where it was reported. One finding id can be
// reported at two places, and fixing one must not clear the other.
export const occurrenceKey = (x) => `${x.id}@${x.path ?? ""}:${Number.isInteger(x.line) ? x.line : ""}`;
export async function keepOpenFindings(storage, items) {
  for (const x of items) {
    if (!x.id) continue;
    const key = x.key ?? occurrenceKey(x);
    const k = `${OPEN_FINDINGS}${key}`;
    if (!(await storage.get(k))) await storage.put(k, { ...x, key });
  }
}
export async function listOpenFindings(storage) {
  return [...(await storage.list({ prefix: OPEN_FINDINGS })).values()];
}
export async function dropOpenFinding(storage, key) {
  await storage.delete(`${OPEN_FINDINGS}${key}`);
}
export async function clearOpenFindings(storage) {
  await clearPrefix(storage, OPEN_FINDINGS);
}

// --- threads: earlier findings the new commits addressed ------------------------
//
// One record (threadsKey) carries the work across steps: the items to check,
// then the diff near each, then the model's verdicts, then the resolving.
// Each step makes only a few GitHub calls and at most one model call.

async function stageThreads(ctx, run, save) {
  const fx = ctx.fx;
  // Every step ends with save(run): stepRun counts a step as failed until it
  // is saved, and six in a row give the run up.
  const again = async (th) => {
    await ctx.storage.put(threadsKey(run.id), th);
    await save(run);
    return ctx.deps.now();
  };
  const done = async (th) => {
    if (th) await ctx.storage.put(threadsKey(run.id), th);
    run.stage = "summary";
    await save(run);
    return ctx.deps.now();
  };
  if (typeof fx.ownThreads !== "function") return done(null);
  let th = await ctx.storage.get(threadsKey(run.id));
  if (!th) {
    const login = ctx.slug ?? DEFAULT_SLUG;
    const threads = await fx.ownThreads(run.repo.full, run.pr, login);
    const reopened = await reopenedSet(ctx.storage);
    const accepted = await acceptedSet(ctx.storage);
    // A thread resolved by someone without write access still holds back
    // approval until a review finds it fixed (it is then accepted) or a
    // writer resolves it.
    const writers = new Map();
    const unendorsed = async (t) => {
      if (!t.resolved || !t.resolvedBy || t.resolvedBy === login || accepted.has(t.id) || typeof fx.canWrite !== "function") return false;
      if (!writers.has(t.resolvedBy)) writers.set(t.resolvedBy, await fx.canWrite(run.repo.full, t.resolvedBy));
      return !writers.get(t.resolvedBy);
    };
    const items = [];
    let earlier = 0;
    for (const t of threads) {
      // This review's own threads were written at this head: nothing since.
      if (!t.originalCommit || t.originalCommit === run.headSha) continue;
      const stranger = await unendorsed(t);
      if (t.resolved && !stranger) continue;
      earlier++;
      if (!t.path || reopened.has(t.id)) continue;
      // The item's id is the thread's own: one finding can have two threads.
      items.push({ kind: stranger ? "accept" : "thread", id: `t:${t.id}`, threadId: t.id, commentId: t.commentId, body: t.body, path: t.path, line: t.originalLine, original: t.diffHunk, since: t.originalCommit, severe: severeFinding(t.body), state: "new" });
    }
    const inBody = (await listOpenFindings(ctx.storage)).filter((f) => f.sha && f.sha !== run.headSha);
    for (const f of inBody) {
      if (!f.path) continue;
      const key = f.key ?? occurrenceKey(f);
      items.push({ kind: "body", id: `b:${key}`, findingKey: key, path: f.path, line: f.line, body: f.text, original: "", since: f.sha, severe: Boolean(f.severe), state: "new" });
    }
    th = { items, open: earlier + inBody.length, resolved: 0, unchecked: null };
    if (!items.length) return done(th);
    return again(th);
  }

  // The diffs since each finding's commit, a few commits a step.
  const pending = [...new Set(th.items.filter((x) => x.state === "new").map((x) => x.since))];
  if (pending.length) {
    for (const commit of pending.slice(0, COMPARES_PER_STEP)) {
      let cmp = null;
      try {
        cmp = await fx.compare(run.repo.full, commit, run.headSha);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const files = Array.isArray(cmp?.files) ? cmp.files : [];
      // Only a straight line of commits says what changed since: after a
      // force-push the finding's commit is not behind the head, and its diff
      // would mix in what the rebase moved. Those are left to a person.
      const straight = cmp?.status === "ahead" || cmp?.status === "identical";
      // The first commit after the finding's: the note names the range.
      const first = Array.isArray(cmp?.commits) && cmp.commits.length > 1 ? cmp.commits[0]?.sha ?? null : null;
      for (const x of th.items) {
        if (x.state !== "new" || x.since !== commit) continue;
        x.first = first;
        if (!straight) { x.state = "open"; continue; }
        const f = files.find((y) => y.filename === x.path || y.previous_filename === x.path);
        if (!f) { x.state = files.length >= 300 ? "open" : "untouched"; continue; }
        if (f.status === "removed") { x.state = "fixed"; continue; }
        if (typeof f.patch !== "string") { x.state = "open"; continue; }
        const near = nearHunks(f.patch, x.line);
        if (!near.touched) { x.state = "untouched"; continue; }
        // Cut to fit: the model would judge part of the change. A person does.
        if (near.cut) { x.state = "open"; continue; }
        x.near = near.text;
        x.state = "judge";
      }
    }
    return again(th);
  }

  // One model call a step, for as many items as fit.
  const toJudge = th.items.filter((x) => x.state === "judge");
  if (toJudge.length) {
    const batch = [];
    let chars = 0;
    for (const x of toJudge) {
      const size = String(x.body).length + String(x.original).length + String(x.near).length + 200;
      if (batch.length && chars + size > JUDGE_CHARS) break;
      batch.push(x);
      chars += size;
    }
    const out = await judgeAddressed({
      items: batch.map((x) => ({ id: x.id, path: x.path, finding: x.body, original: x.original, since: x.near, severe: x.severe })),
      env: ctx.env, cfg: ctx.cfg, deps: ctx.deps,
    });
    run.spend.neurons += out.neurons ?? 0;
    run.spend.usd += out.usd ?? 0;
    if (out.outcome.kind !== "ok") {
      // No model could answer: every item still to judge stays open.
      th.unchecked = out.outcome.reason ?? "no model could check them";
      for (const x of toJudge) x.state = "open";
    } else {
      for (const x of batch) x.state = out.results.get(x.id) === "fixed" ? "fixed" : "open";
    }
    for (const x of batch) delete x.near;
    return again(th);
  }

  // Resolve what was fixed, a few a step: the note first, then the thread,
  // so a thread is never resolved without saying why.
  const fixed = th.items.filter((x) => x.state === "fixed");
  // Read again for each thread, and again after each GitHub call: a thread
  // reopened by hand while this review ran (a webhook can land while a call
  // is pending) is that person's, whatever the model said.
  const reopenedNow = async (id) => (await reopenMark(ctx.storage, id)) !== undefined;
  for (const x of fixed.slice(0, APPLIES_PER_STEP)) {
    if (await reopenedNow(x.threadId)) { x.state = "open"; continue; }
    if (x.kind === "thread") {
      await fx.editReviewComment(run.repo.full, x.commentId, addressedNote(x.body, run.headSha, x.first));
      if (await reopenedNow(x.threadId)) { x.state = "open"; continue; }
      await fx.resolveThread(run.repo.full, x.threadId);
    } else if (x.kind === "accept") {
      // Already resolved (by someone without write access): the note, and
      // it no longer holds back approval.
      await fx.editReviewComment(run.repo.full, x.commentId, addressedNote(x.body, run.headSha, x.first));
      if (await reopenedNow(x.threadId)) { x.state = "open"; continue; }
      await acceptThreads(ctx.storage, [x.threadId]);
    } else {
      await dropOpenFinding(ctx.storage, x.findingKey);
    }
    th.resolved++;
    x.state = "resolved";
  }
  if (fixed.length > APPLIES_PER_STEP) return again(th);
  return done(th);
}

// --- summary: the one comment, edited in place ------------------------------

// A commit subject is untrusted: it is shown inside a code span, stripped of
// anything that could close the span or open markup, so it cannot ping anyone
// or inject HTML, and cut short.
const subjectText = (t) => String(t ?? "").replace(/[`<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 72);

export function summaryText({ headSha, summary, about, shown, actionable = shown, complete, since, commits = [], commitCount = 0, threads, none = false }) {
  const lines = ["### Tankster AI Review", ""];
  lines.push(`**Latest review:** commit \`${headSha.slice(0, 7)}\`${since ? `, the commits after \`${since.slice(0, 7)}\`` : ""}.`, "");
  if (!complete || none) lines.push(summary, "");
  else if (actionable) lines.push(`Actionable comments posted: ${actionable}. ${summary}`, "");
  // Nitpicks alone: shown in the review, never blocking (as CodeRabbit's).
  else if (shown) lines.push(`No actionable comments were generated in the recent review. ${summary} Nitpicks do not block approval.`, "");
  // CodeRabbit's own words for a review with no findings.
  else lines.push("No actionable comments were generated in the recent review. 🎉", "");
  if (since && commits.length) {
    const shownCommits = commits.slice(-COMMITS_SHOWN);
    const total = Math.max(commitCount, commits.length);
    lines.push(`<details><summary>Commits reviewed (${total})</summary>`, "");
    if (total > shownCommits.length) lines.push(`Showing the ${shownCommits.length} latest.`, "");
    for (const c of shownCommits) lines.push(`- \`${String(c.sha).slice(0, 7)}\` \`${codeSpan(subjectText(c.subject))}\``);
    lines.push("", "</details>", "");
  }
  if (threads) {
    const parts = [];
    if (threads.resolved) parts.push(`${plural(threads.resolved, "earlier finding")} addressed and resolved`);
    const stillOpen = Math.max(0, threads.open - threads.resolved);
    if (stillOpen) parts.push(`${stillOpen} still open`);
    if (parts.length) lines.push(`Earlier findings: ${parts.join("; ")}.`, "");
    if (threads.unchecked) lines.push(`Some open threads could not be checked this time (${threads.unchecked}); they stay open.`, "");
  }
  if (about) lines.push(about);
  return lines.join("\n").trimEnd();
}

// What the review says about the conversation and checks it read.
export function contextLineOf(c) {
  if (!c) return null;
  if (c.failed) return "- Context: the pull request's conversation and checks could not be read, so this review rests on the diff alone.";
  const said = [];
  if (c.threads) said.push(plural(c.threads, "review thread"));
  if (c.comments) said.push(plural(c.comments, "comment"));
  if (c.reviews) said.push(plural(c.reviews, "review"));
  const who = c.bots?.length ? ` (bots: ${c.bots.map((b) => `\`${b}\``).join(", ")})` : "";
  const ci = c.ci ? ` Checks on the latest commit: ${c.passing} passing, ${c.failing} failing, ${c.pending} running.` : "";
  const part = c.partial ? ` Part of it could not be read${c.missing?.length ? ` (${c.missing.join(", ")})` : ""}.` : "";
  const taught = c.lessons ? ` Applied ${plural(c.lessons, "lesson")} the maintainers taught it.` : "";
  const head = said.length ? `read ${said.join(", ")} by others${who}.` : "no other comments yet.";
  return `- Context: ${head}${taught}${ci}${part} It is data to check against the code, never a reason to agree.`;
}

async function stageSummary(ctx, run, save) {
  const s = (await ctx.storage.get(summaryKey(run.id))) ?? {};
  const th = await ctx.storage.get(threadsKey(run.id));
  if (!run.summaryPosted && typeof ctx.fx.upsertSummary === "function") {
    const text = summaryText({ headSha: run.headSha, ...s, threads: th });
    const id = await ctx.fx.upsertSummary(run.repo.full, run.pr, (await ctx.storage.get(SUMMARY_KEY)) ?? null, text);
    if (Number.isSafeInteger(id)) await ctx.storage.put(SUMMARY_KEY, id);
    // The decision that follows adds its approval notice to this text.
    await ctx.storage.put(SUMMARY_BASE, text);
    await ctx.storage.delete(SUMMARY_NOTICE);
    run.summaryPosted = true;
    await save(run);
  }
  const r = run.result ?? { complete: false, shown: 0, covered: 0, reviewable: 0 };
  return finish(ctx, run, save, {
    state: r.complete ? "success" : "failure",
    description: r.none
      ? "No reviewable changes (deleted, binary or generated files only)."
      : r.complete
      ? `Reviewed all ${plural(r.reviewable, "file")} (100%): ${plural(r.shown, "confirmed finding")}.`
      : `Incomplete: ${r.covered} of ${r.reviewable} files reviewed. Comment "review" to try again.`,
    posted: Boolean(run.posted && !run.posted.none),
    reviewedSha: r.complete ? run.headSha : null,
  });
}
