// GitHub App webhooks: signature check and normalisation.
//
// Only the HMAC proves a delivery came from GitHub. Signatures carry no
// timestamp, so replays are stopped by remembering X-GitHub-Delivery ids
// (the PR's Durable Object does that). The payload is untrusted beyond the
// fields GitHub itself sets; nothing here acts on it, it only describes it.

// The App's slug decides its login ("<slug>[bot]") and how people mention it.
export const DEFAULT_SLUG = "tankster-ai-review";
export const BOT_LOGIN = `${DEFAULT_SLUG}[bot]`;

export function mentionOf(slug = DEFAULT_SLUG) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("bad App slug");
  return new RegExp(`(^|[^\\w-])@${slug}(?![\\w-])`, "i");
}
export const MENTION = mentionOf();

// converted_to_draft arrives with draft: true, so it only stops a push from
// being reviewed.
const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize", "converted_to_draft"]);
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Constant-time: WebCrypto's HMAC verify compares in constant time.
export async function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const sig = hexToBytes(header.slice(7).toLowerCase());
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, rawBody);
}

function repoOf(p) {
  const r = p.repository;
  if (!r || typeof r.full_name !== "string" || typeof r.name !== "string") return null;
  return { full: r.full_name, name: r.name, ownerId: String(r.owner?.id ?? ""), private: Boolean(r.private) };
}

// Returns null for anything ai-review ignores, otherwise a small plain object.
export function normalise(event, p, { ownerId, slug = DEFAULT_SLUG } = {}) {
  if (!p || typeof p !== "object") return null;
  const repo = repoOf(p);
  if (!repo || (ownerId && repo.ownerId !== String(ownerId))) return null;
  const sender = { login: String(p.sender?.login ?? ""), bot: p.sender?.type === "Bot" };

  if (event === "pull_request") {
    const pr = p.pull_request;
    if (!pr || !Number.isInteger(pr.number)) return null;
    const base = {
      repo,
      pr: pr.number,
      sender,
      head: { sha: pr.head?.sha, ref: pr.head?.ref, repo: pr.head?.repo?.full_name ?? null },
      baseSha: pr.base?.sha,
      fork: pr.head?.repo?.full_name !== repo.full,
      draft: Boolean(pr.draft),
      author: { login: String(pr.user?.login ?? ""), association: String(pr.author_association ?? "NONE"), bot: pr.user?.type === "Bot" },
    };
    if (p.action === "closed") return { kind: "closed", ...base, merged: Boolean(pr.merged) };
    if (REVIEW_ACTIONS.has(p.action)) return { kind: "review", action: p.action, ...base, before: p.before ?? null };
    return null;
  }

  // Commands: a mention of the bot in a PR conversation comment or a review
  // thread reply. The bot's own comments and other bots never command it.
  const isComment = event === "issue_comment" || event === "pull_request_review_comment";
  if (isComment && p.action === "created") {
    const c = p.comment;
    if (!c || sender.bot || sender.login === `${slug}[bot]` || !mentionOf(slug).test(String(c.body ?? ""))) return null;
    const prNumber = event === "issue_comment" ? (p.issue?.pull_request ? p.issue.number : null) : p.pull_request?.number;
    if (!Number.isInteger(prNumber)) return null;
    return {
      kind: "command",
      slug,
      repo,
      pr: prNumber,
      sender,
      where: event === "issue_comment" ? "conversation" : "thread",
      commentId: c.id,
      inReplyTo: c.in_reply_to_id ?? null,
      text: String(c.body).slice(0, 8000),
      association: String(c.author_association ?? "NONE"),
      // The association is a hint only: write commands re-check the commenter's
      // permission through the API before doing anything.
      maybeWriter: WRITERS.has(String(c.author_association ?? "")),
    };
  }
  return null;
}

// The Durable Object that owns a pull request's state.
export function prKey(repoFull, pr) {
  return `${repoFull}#${pr}`;
}
