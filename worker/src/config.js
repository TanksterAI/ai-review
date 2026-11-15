// The Worker's settings, from its vars (wrangler.jsonc) with defaults.

export function config(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    model: env.MODEL || "@cf/openai/gpt-oss-120b",
    effort: ["low", "medium", "high"].includes(env.REASONING_EFFORT) ? env.REASONING_EFFORT : "medium",
    cap: num(env.DAILY_NEURON_CAP, 6000),
    maxChars: num(env.MAX_DIFF_CHARS, 90_000),
    maxOutput: num(env.MAX_OUTPUT_TOKENS, 12_000),
    // The whole review's time limit, drafting and verifying (milliseconds).
    reviewDeadlineMs: num(env.REVIEW_DEADLINE_MS, 270_000),
    // Where confirmed findings go: chill, assertive or quiet. Findings that
    // are not confirmed are always hidden.
    profile: ["chill", "assertive", "quiet"].includes(env.REVIEW_PROFILE) ? env.REVIEW_PROFILE : "chill",
    audience: env.AUDIENCE,
    ownerId: env.OWNER_ID,
    // Comma-separated job_workflow_ref values; an entry ending in * is a prefix.
    workflowRefs: String(env.WORKFLOW_REFS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  };
}
