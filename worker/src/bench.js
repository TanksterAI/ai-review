// POST /v1/bench: the owner's measuring stick for the reviewer.
//
// Runs the real drafting and verifying code (the same prompt, grounding gate,
// verifier and spend caps as a review) over a diff the caller supplies, with
// the draft chain, and optionally the verify chain, chosen by the caller.
// Nothing is posted, nothing is marked done, and no PR is touched: the answer
// says what each stage kept and dropped, so a chain can be scored against
// known defects before it becomes the default.
//
// Auth: a GitHub token (Authorization: Bearer) that belongs to the App's owner
// (OWNER_ID). The token is only used to read who it is. Spend goes through the
// same daily ledger and caps as reviews, so a benchmark can never spend more
// than a day's review budget.
//
//   body: {files: [{filename, status, patch, additions, deletions}], title?, body?,
//          chain?: "kind:model,kind:model", verify_chain?: "kind:model", verify?: false}
//   200 {status: "benched", drafted, grounded, verified?, shown, usage}

import { buildPrompt, classifyFindings, prepareFiles } from "./review.js";
import { draftWithChain } from "./draft.js";
import { createSerial } from "./budget.js";
import { createProviders, draftChain, verifyOff } from "./providers.js";
import { groundFindings } from "./grounding.js";
import { applyVerdicts, verifyFindings } from "./verify.js";
import { config } from "./config.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const KINDS = ["anthropic", "gemini", "workers-ai"];
const ID = /^[a-z-]+:[A-Za-z0-9@._/:-]{1,120}$/;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function randomTag() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// "kind:model,kind:model" -> the string, or null if any entry is not a known
// provider and a plain model id. At most 8 entries.
export function cleanChain(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.length > 8) return null;
  for (const p of parts) if (!ID.test(p) || !KINDS.includes(p.slice(0, p.indexOf(":")))) return null;
  return parts.join(",");
}

const brief = (f) => ({ path: f.path, line: f.line ?? null, severity: f.severity, title: f.title });

export async function handleBench(request, env, deps = {}) {
  if (request.method !== "POST") return json(405, { status: "rejected", reason: "POST only" });
  const cfg = config(env);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));

  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return json(401, { status: "unauthorized", reason: "a GitHub token is needed" });
  let who;
  try {
    const r = await fetchImpl("https://api.github.com/user", { headers: { authorization: `Bearer ${m[1]}`, accept: "application/vnd.github+json", "user-agent": "tankster-ai-review" } });
    if (!r.ok) return json(401, { status: "unauthorized", reason: "GitHub did not accept the token" });
    who = await r.json();
  } catch {
    return json(502, { status: "failed", reason: "could not reach GitHub" });
  }
  if (!env.OWNER_ID || String(who?.id) !== String(env.OWNER_ID)) return json(403, { status: "forbidden", reason: "the benchmark is for the App's owner" });

  let input;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { status: "rejected", reason: "request too large" });
    input = JSON.parse(text);
  } catch {
    return json(400, { status: "rejected", reason: "body is not JSON" });
  }
  if (!Array.isArray(input?.files) || input.files.length === 0 || input.files.length > 200) return json(400, { status: "rejected", reason: "files must be an array of 1 to 200" });

  const chainText = input.chain === undefined ? null : cleanChain(input.chain);
  if (input.chain !== undefined && !chainText) return json(400, { status: "rejected", reason: "chain must be kind:model entries (anthropic, gemini or workers-ai), at most 8" });
  const verifyText = input.verify_chain === undefined ? null : cleanChain(input.verify_chain);
  if (input.verify_chain !== undefined && !verifyText) return json(400, { status: "rejected", reason: "verify_chain must be kind:model entries" });
  const benchEnv = { ...env, ...(chainText ? { DRAFT_CHAIN: chainText } : {}), ...(verifyText ? { VERIFY_CHAIN: verifyText } : {}) };

  const prepared = prepareFiles(input.files, { maxChars: cfg.maxChars });
  if (prepared.included.length === 0) return json(200, { status: "skipped", reason: "no reviewable text changes", omitted: prepared.omitted });

  const repository = "TanksterAI/bench";
  const { instructions, input: modelInput } = buildPrompt({ repository, title: input.title, body: input.body, prepared, tag: randomTag() });
  const chars = instructions.length + modelInput.length;
  const started = now();
  const d = { now, sleep, fetch: fetchImpl, log: () => {}, serial: createSerial() };
  const providers = createProviders(benchEnv, cfg, draftChain(benchEnv, cfg), d);
  const drafted = await draftWithChain({ providers, instructions, modelInput, chars, cfg, deps: d, started, repository, pr: 0 });
  if (!drafted.answer) {
    const why = drafted.outcomes.map((o) => `${o.id ?? ""} ${o.kind}: ${o.reason ?? ""}`.trim());
    return json(drafted.timedOut || drafted.late ? 503 : 502, { status: "failed", reason: "no model in the chain gave an answer", outcomes: why });
  }
  const { answer, used } = drafted;
  const raw = Array.isArray(answer.findings) ? answer.findings : [];
  const classified = classifyFindings(answer, prepared.commentable, prepared.lineText);
  const grounded = groundFindings(classified, prepared, { title: input.title, body: input.body });
  const out = {
    status: "benched",
    drafter: used.id,
    summary: typeof answer.summary === "string" ? answer.summary.slice(0, 300) : "",
    drafted: { raw: raw.length, kept_after_grounding: grounded.classified.inline.length + grounded.classified.general.length, dropped_by_grounding: grounded.dropped.length },
    usage: { drafting: { usd: drafted.usd, neurons: drafted.neurons } },
  };
  if (input.verify === false || verifyOff(benchEnv)) {
    out.shown = [...grounded.classified.inline, ...grounded.classified.general].map(brief);
    out.verified = null;
    return json(200, out);
  }
  const verified = await verifyFindings({ classified: grounded.classified, prepared, title: input.title, body: input.body, drafter: used, env: benchEnv, cfg, deps: d, started });
  if (verified.outcome.kind !== "ok") return json(200, { ...out, verified: { stopped: verified.outcome.kind, reason: verified.outcome.reason ?? "" }, shown: [] });
  const { shown, hidden } = applyVerdicts(grounded.classified, grounded.dropped, verified.verdicts);
  out.shown = [...shown.inline, ...shown.general].map(brief);
  out.verified = { calls: verified.calls, hidden: hidden.length, off: !!verified.off };
  out.usage.verification = { usd: verified.usd, neurons: verified.neurons };
  return json(200, out);
}
