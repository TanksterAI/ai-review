// The Worker's settings, from its vars (wrangler.jsonc) with defaults.

export function config(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    model: env.MODEL || "@cf/openai/gpt-oss-120b",
    effort: ["low", "medium", "high"].includes(env.REASONING_EFFORT) ? env.REASONING_EFFORT : "medium",
    cap: num(env.DAILY_NEURON_CAP, 6000),
    maxChars: num(env.MAX_DIFF_CHARS, 90_000),
    // The Worker's own review (review-run.js) covers every file: the diff is
    // cut into batches of at most this many characters, one model call each.
    batchChars: num(env.BATCH_CHARS, 60_000),
    // Past this much diff in one pull request, the rest is named as not
    // covered (and the commit status fails) rather than reviewed.
    maxPrChars: num(env.MAX_PR_CHARS, 5_000_000),
    maxOutput: num(env.MAX_OUTPUT_TOKENS, 12_000),
    // The whole review's time limit, drafting and verifying (milliseconds).
    reviewDeadlineMs: num(env.REVIEW_DEADLINE_MS, 270_000),
    // Where confirmed findings go: chill, assertive or quiet. Findings that
    // are not confirmed are always hidden.
    profile: ["chill", "assertive", "quiet"].includes(env.REVIEW_PROFILE) ? env.REVIEW_PROFILE : "chill",
    // Whether a review reads the pull request's conversation and its checks
    // (context.js): on, or off. The characters it may add to a prompt.
    contextMode: String(env.REVIEW_CONTEXT ?? "on").toLowerCase() === "off" ? "off" : "on",
    contextChars: num(env.CONTEXT_CHARS, 6000),
    // Other reviewing bots whose threads this App resolves, once a later commit
    // fixes what they pointed at (a fix a model judged, and a second model agreed
    // on). Comma-separated GitHub logins as GraphQL names them; "off" for none.
    peerResolve: String(env.PEER_RESOLVE ?? "coderabbitai").toLowerCase() === "off" ? [] : String(env.PEER_RESOLVE ?? "coderabbitai").split(",").map((x) => x.trim().replace(/\[bot\]$/i, "")).filter((x) => /^[A-Za-z0-9-]{1,39}$/.test(x)),
    audience: env.AUDIENCE,
    ownerId: env.OWNER_ID,
    // Comma-separated job_workflow_ref values; an entry ending in * is a prefix.
    workflowRefs: String(env.WORKFLOW_REFS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  };
}
