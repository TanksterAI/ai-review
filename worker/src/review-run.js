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
//   post     one review for the whole pull request, and the commit status
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
// A commit reviewed at full coverage. Not the single-prompt paths' done: key.
export const doneKeyOf = (run) => `donefull:${run.repo.full}#${run.pr}@${run.headSha}`;

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
    if (run.stage === "plan") return await stagePlan(counted, run, save);
    if (run.stage === "draft") return await stageDraft(counted, run, save);
    if (run.stage === "verify") return await stageVerify(counted, run, save);
    if (run.stage === "post") return await stagePost(counted, run, save);
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
  if (!run.headSha || run.statusOk === false) return;
  try {
    const ok = await ctx.fx.setStatus(run.repo.full, run.headSha, state, description);
    if (ok === false && run.statusOk !== false) {
      run.statusOk = false;
      ctx.deps.log?.({ ev: "status_unavailable", reason: "the App lacks statuses:write" });
    } else if (ok) run.statusOk = true;
  } catch (e) {
    ctx.deps.log?.({ ev: "status_failed", error: String(e?.message ?? e).slice(0, 120) });
  }
}

async function finish(ctx, run, save, { state, description, posted = false, gaveUp = false, reviewedSha = null }) {
  if (state) await status(ctx, run, state, description);
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
    // Nothing reviewable at all: a pass.
    return finish(ctx, run, save, { state: "success", description: "No reviewable changes (deleted, binary or generated files only).", reviewedSha: run.headSha });
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
  // Each batch drafted in this step gets its share of what is left, so
  // batches running at once cannot overrun the step together.
  const share = Math.floor(Math.max(0, ctx.budget.left) / Math.max(1, todo.length));
  await Promise.all(todo.map(async ({ b, i }) => {
    const mine = { left: share };
    const bctx = countSubrequests(ctx, mine);
    const prepared = batchPrepared(asPlan(plan, batches), i);
    const { instructions, input } = buildPrompt({ repository: run.repo.full, title: run.title, body: run.body, prepared, tag: randomTag(), pass: { index: i + 1, total: batches.length } });
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
  await status(ctx, run, "pending", `Waiting for a model provider to reset at ${new Date(run.waitUntil).toISOString().slice(11, 16)} UTC; ${cov.covered} of ${cov.reviewable} files reviewed so far.`);
  await save(run);
  return run.waitUntil;
}

async function stageVerify(ctx, run, save) {
  const { plan, batches } = await loadPlan(ctx, run);
  const now = ctx.deps.now();
  const full = asPlan(plan, batches);
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
      : await verifyFindings({ classified: grounded.classified, prepared, title: run.title, body: run.body, drafter: b.drafter, env: ctx.env, cfg: ctx.cfg, deps: ctx.deps, started: now });
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
  const coveredPaths = plan.files.filter((f) => f.batches.every((b) => done.has(b))).map((f) => f.path);
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
  const review = renderReview({
    answer: null, classified: merged.shown, hidden: merged.hidden,
    prepared: { included: coveredPaths, omitted: plan.skipped, uncovered, chars: plan.chars, coverage: { ...cov, passes: batches.length } },
    verification: merged.verification,
    meta: { model: modelOf(ids[0]?.[0] ?? ""), modelLine, costLine, again: ctx.again, headSha: run.headSha, profile: ctx.cfg.profile },
  });
  let { body: text, comments } = review;
  if (run.since) {
    // Inline comments may only sit on lines of the PR's own diff; findings on
    // lines a later commit undid go in the body instead.
    const lines = await ctx.fx.prLines(run.repo.full, run.pr, comments.map((c) => c.path));
    const { kept, off } = placeComments(comments, review.singleLine, lines);
    comments = kept;
    if (off.length) text += `\n\n#### Also noted (on lines no longer in this pull request's diff)\n\n${off.map((c) => `- \`${codeSpan(c.path)}:${c.line}\`: ${titleLine(c.body)}`).join("\n")}`;
    text += `\n\n_Incremental review: commits after \`${run.since.slice(0, 7)}\`._`;
  }
  // Posted once: a step retried after the post (a failed write below) does
  // not post the review again.
  let posted = run.posted ?? null;
  if (!posted) {
    posted = await ctx.fx.postReview(run.repo.full, run.pr, { commitId: run.headSha, body: text, comments });
    run.posted = { inline: posted?.inline ?? 0 };
    await save(run);
  }
  const complete = cov.complete;
  // Only a complete review marks the commit done and moves the PR's last
  // reviewed commit on: after an incomplete one, the next review starts from
  // the last complete one, so nothing it missed is passed over.
  if (complete) await ctx.env.LEDGER?.put(doneKeyOf(run), utcDay(ctx.deps.now()), { expirationTtl: 30 * 24 * 3600 });
  const shownCount = merged.shown.inline.length + merged.shown.general.length;
  ctx.deps.log?.({ ev: "run_reviewed", repository: run.repo.full, pr: run.pr, passes: batches.length, covered: cov.covered, reviewable: cov.reviewable, shown: shownCount, hidden: merged.hidden.length, inline: posted?.inline ?? 0, neurons: Math.round(run.spend.neurons), usd: Number(run.spend.usd.toFixed(5)) });
  return finish(ctx, run, save, {
    state: complete ? "success" : "failure",
    description: complete
      ? `Reviewed all ${plural(cov.reviewable, "file")} (100%): ${plural(shownCount, "confirmed finding")}.`
      : `Incomplete: ${cov.covered} of ${cov.reviewable} files reviewed. Comment "review" to try again.`,
    posted: true,
    reviewedSha: complete ? run.headSha : null,
  });
}
