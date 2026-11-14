// Drafting a review with a chain of model providers, shared by the single
// review (index.js, runReview) and the Worker's own full-coverage review
// (review-run.js), which drafts one batch of the diff at a time.

import { nextUtcMidnight } from "./budget.js";
import { LATE, ProviderError, beforeDeadline } from "./providers.js";
import { parseAnswer } from "./review.js";

function log(event) {
  // Ids, counts and timings only: never diff text, titles or model output.
  console.log(JSON.stringify({ svc: "ai-review", ...event }));
}

/**
 * Drafting: each provider in turn, until one answers. One that is out of
 * quota, busy, or failing hands over to the next. On one provider, up to two
 * calls:
 *   - an answer cut short (reasoning used the room): once more, with low
 *     reasoning effort, if the budget allows;
 *   - an answer that tried to be JSON but does not parse (escaping code in a
 *     suggestion is where models slip): once more, if the budget allows.
 *   Either retry asks for no suggestions, which makes the answer shorter and
 *   its JSON simpler.
 * Every call races the deadline (started + cfg.reviewDeadlineMs): one that
 * has not answered by then is given up (late). Drafting stops a minute before
 * it, so verification still has time: no new provider and no retry after
 * that (timedOut). budget, when given ({left}): the subrequests this
 * invocation may still make (Workers Free allows 50); no provider is tried
 * with fewer than STEP_RESERVE left (outOfStep), so a step ends cleanly and
 * the next one carries on.
 * Returns {answer, used, neurons, usd, last, outcomes, timedOut, late, outOfStep}.
 */
// The most one provider attempt costs: its quota check, its spend check,
// the call, and the spend's read and write.
export const STEP_RESERVE = 6;
export async function draftWithChain({ providers, instructions, modelInput, chars, cfg, deps, started, repository, pr, budget = null }) {
  const now = deps.now;
  const deadline = started + cfg.reviewDeadlineMs;
  const outOfTime = () => now() - started > cfg.reviewDeadlineMs - 60_000;
  const out = { answer: null, used: null, neurons: 0, usd: 0, last: {}, outcomes: [], timedOut: false, late: false, outOfStep: false };
  const { outcomes } = out;
  for (const p of providers) {
    if (!p.configured) continue;
    if (outOfTime()) { out.timedOut = true; break; }
    if (budget && budget.left < STEP_RESERVE) { out.outOfStep = true; break; }
    const until = await p.exhausted();
    if (until) { outcomes.push({ id: p.id, kind: "deferred", reason: `${p.id} is out of quota`, resetAt: until }); continue; }
    const first = await p.affordable(chars, cfg.maxOutput);
    if (!first.ok) {
      (deps.log ?? log)({ ev: "deferred", repository, pr, provider: p.id, spent: first.spent, estimate: first.estimate });
      // No reset time means it can never take this review (too long for it).
      outcomes.push(first.resetAt === null
        ? { id: p.id, kind: "failed", reason: first.reason }
        : { id: p.id, kind: "deferred", reason: first.reason, resetAt: first.resetAt ?? nextUtcMidnight(now()) });
      continue;
    }
    let note = "";
    let low = false;
    let lastStatus = null;
    for (let attempt = 1; attempt <= 2 && !out.answer; attempt++) {
      if (attempt > 1 && outOfTime()) { out.timedOut = true; break; }
      if (attempt > 1 && budget && budget.left < STEP_RESERVE) { out.outOfStep = true; break; }
      let r;
      try {
        r = await beforeDeadline(p.complete({ system: instructions + note, user: modelInput, maxOutput: cfg.maxOutput, low }), deadline, deps);
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        outcomes.push({ id: p.id, kind: e.kind, reason: e.reason, resetAt: e.resetAt });
        lastStatus = "error";
        break;
      }
      if (r === LATE) {
        // The call may still finish and record its spend; this draft stops.
        (deps.log ?? log)({ ev: "draft_out_of_time", repository, pr, provider: p.id, attempt });
        out.late = true;
        return out;
      }
      out.neurons += r.neurons ?? 0;
      out.usd += r.usd ?? 0;
      out.last = r;
      out.answer = parseAnswer(r.text);
      if (out.answer) { out.used = p; break; }
      lastStatus = r.incomplete ? "incomplete" : "unparseable";
      (deps.log ?? log)({ ev: "unparseable", repository, pr, provider: p.id, attempt, incomplete: r.incomplete });
      if ((!r.incomplete && !r.text.includes("{")) || !(await p.affordable(chars, cfg.maxOutput)).ok) break;
      if (r.incomplete) low = true;
      note = "\nYour previous answer could not be used. Answer again, shorter, and leave out every \"suggestion\" key.";
    }
    if (out.answer || out.outOfStep) break;
    if (lastStatus === "incomplete") outcomes.push({ id: p.id, kind: "failed", reason: "the model ran out of output room before it answered; try again, or review a smaller change" });
    else if (lastStatus === "unparseable") outcomes.push({ id: p.id, kind: "failed", reason: "the model did not return a usable answer; try again later" });
  }
  return out;
}

