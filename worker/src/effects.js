// Everything the Worker does to GitHub, as the Tankster AI Review App.
// Each call mints (or reuses) a token for exactly one repository and only the
// permissions that call needs. The runner receives only cloneToken's read-only
// token, minted fresh for each run and never reused (it revokes it at the end).

import { createGithubApp } from "./github-app.js";
import { annotatePatch, codeSpan } from "./review.js";
import { findingIdOf } from "./addressed.js";

// A REST comment id from GraphQL's fullDatabaseId (a string) or an old Int.
export function commentIdOf(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const ORG = "TanksterAI";
export const RUNNER_REPO = "ai-review";
const WRITE_LEVELS = new Set(["admin", "maintain", "write"]);
// One scope for everything the Worker does on a reviewed repository, so one
// cached token serves comments, permission checks and reviews. Every
// installation token can read metadata (the permission check needs it).
const PR_SCOPE = { pull_requests: "write" };
// The Worker's own review reads the pull request and its files with this.
const READ_SCOPE = { contents: "read", pull_requests: "read" };
const STATUS_SCOPE = { statuses: "write" };
// Reading threads through GraphQL names each comment's commit: Commit
// objects need contents:read as well.
const THREAD_SCOPE = { contents: "read", pull_requests: "write" };
export const STATUS_CONTEXT = "Tankster AI Review";
export const MARKER = "<!-- tankster-ai-review -->";

export function base64Bytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const apps = new Map(); // appId -> App client, one per isolate

function nameOf(repoFull) {
  const [owner, name, extra] = String(repoFull).split("/");
  if (owner !== ORG || !name || extra !== undefined) throw new Error("not a TanksterAI repository");
  return name;
}

// deps.config: {appId, pem} from appConfig() (setup.js). Without it there is
// no App to act as, and this throws.
export function createEffects(env, deps = {}) {
  let app = deps.app;
  if (!app) {
    const cfg = deps.config;
    if (!cfg?.appId || !cfg?.pem) throw new Error("the GitHub App is not set up yet");
    if (!apps.has(cfg.appId)) apps.set(cfg.appId, createGithubApp({ appId: cfg.appId, privateKeyPem: cfg.pem, org: ORG }));
    app = apps.get(cfg.appId);
  }

  return {
    app,

    // workflow_dispatch needs only actions:write on ai-review, not contents.
    async dispatch(jobId) {
      const token = await app.installationToken([RUNNER_REPO], { actions: "write" });
      await app.call("POST", `/repos/${ORG}/${RUNNER_REPO}/actions/workflows/runner.yml/dispatches`, {
        token,
        body: { ref: "main", inputs: { job: jobId } },
      });
    },

    async comment(repoFull, pr, body) {
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], PR_SCOPE);
      const made = await app.call("POST", `/repos/${ORG}/${name}/issues/${Number(pr)}/comments`, {
        token,
        body: { body: `${MARKER}\n${body}` },
      });
      // Its id, so a reply can be edited later (a command's acknowledgement).
      return Number.isSafeInteger(made?.id) ? made.id : null;
    },

    // Edits one of the App's own conversation comments. False if it is gone.
    async editComment(repoFull, commentId, body) {
      const name = nameOf(repoFull);
      if (!Number.isSafeInteger(commentId)) throw new Error("not a comment id");
      const token = await app.installationToken([name], PR_SCOPE);
      try {
        await app.call("PATCH", `/repos/${ORG}/${name}/issues/comments/${commentId}`, { token, body: { body: `${MARKER}\n${body}` } });
        return true;
      } catch (e) {
        if (e.status === 404) return false;
        throw e;
      }
    },

    async canWrite(repoFull, login) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(String(login))) return false;
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], PR_SCOPE);
      try {
        const out = await app.call("GET", `/repos/${ORG}/${name}/collaborators/${login}/permission`, { token });
        return WRITE_LEVELS.has(out?.permission);
      } catch (e) {
        if (e.status === 404) return false;
        throw e;
      }
    },

    // Read-only, for the runner's clone: contents and pull requests of one repo.
    // Fresh for every run: the runner revokes it when it ends, so a cached,
    // shared token would fail with 401 for every other run on that repository.
    async cloneToken(repoFull) {
      return app.installationToken([nameOf(repoFull)], { contents: "read", pull_requests: "read" }, { fresh: true });
    },

    // The lines a review comment may sit on: the RIGHT side of the PR's own
    // diff, for the files named (only those are parsed). An incremental
    // review's findings outside them would make GitHub refuse the whole review.
    async prLines(repoFull, pr, paths) {
      const want = new Set(paths);
      const lines = new Map();
      if (!want.size) return lines;
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], PR_SCOPE);
      for (let page = 1; page <= 10 && lines.size < want.size; page++) {
        const files = await app.call("GET", `/repos/${ORG}/${name}/pulls/${Number(pr)}/files?per_page=100&page=${page}`, { token });
        for (const f of files ?? []) {
          if (want.has(f.filename) && typeof f.patch === "string") lines.set(f.filename, annotatePatch(f.patch).lines);
        }
        if (!files || files.length < 100) break;
      }
      return lines;
    },

    // --- the Worker's own review (review-run.js): reads, with a read-only
    // token for one repository, and the commit status.

    async pullRequest(repoFull, pr) {
      const name = nameOf(repoFull);
      return app.call("GET", `/repos/${ORG}/${name}/pulls/${Number(pr)}`, { token: await app.installationToken([name], READ_SCOPE) });
    },

    // One page of the pull request's files (100 a page; GitHub lists 3,000 at most).
    async listFiles(repoFull, pr, page) {
      const name = nameOf(repoFull);
      return app.call("GET", `/repos/${ORG}/${name}/pulls/${Number(pr)}/files?per_page=100&page=${Number(page)}`, { token: await app.installationToken([name], READ_SCOPE) });
    },

    // A comparison of two commits: its status, merge base and (first page) files.
    async compare(repoFull, base, head) {
      const name = nameOf(repoFull);
      if (![base, head].every((x) => /^[0-9a-f]{40}$/.test(String(x)))) throw new Error("compare takes two commit ids");
      return app.call("GET", `/repos/${ORG}/${name}/compare/${base}...${head}?per_page=100`, { token: await app.installationToken([name], READ_SCOPE) });
    },

    // A blob's bytes (GitHub sends them base64-encoded), or null if it is gone.
    async blob(repoFull, sha) {
      const name = nameOf(repoFull);
      if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error("not a blob id");
      try {
        const out = await app.call("GET", `/repos/${ORG}/${name}/git/blobs/${sha}`, { token: await app.installationToken([name], READ_SCOPE) });
        return { bytes: base64Bytes(out?.content ?? ""), size: Number(out?.size) || 0 };
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    // A file's blob id at a commit, or null when the file is not there.
    async fileSha(repoFull, path, ref) {
      const name = nameOf(repoFull);
      if (!/^[0-9a-f]{40}$/.test(String(ref))) throw new Error("not a commit id");
      const enc = String(path).split("/").map(encodeURIComponent).join("/");
      try {
        const out = await app.call("GET", `/repos/${ORG}/${name}/contents/${enc}?ref=${ref}`, { token: await app.installationToken([name], READ_SCOPE) });
        return Array.isArray(out) || out?.type !== "file" ? null : out.sha ?? null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    // The commit status the merge gate reads (needs the App's statuses:write).
    // state: pending, success, failure or error. Returns false when the App
    // does not have that permission yet, rather than failing the review.
    async setStatus(repoFull, sha, state, description) {
      const name = nameOf(repoFull);
      if (!/^[0-9a-f]{40}$/.test(String(sha))) return false;
      let token;
      try {
        token = await app.installationToken([name], STATUS_SCOPE);
      } catch (e) {
        if (e.status === 403 || e.status === 422) return false;
        throw e;
      }
      await app.call("POST", `/repos/${ORG}/${name}/statuses/${sha}`, {
        token,
        body: { state, context: STATUS_CONTEXT, description: String(description).slice(0, 140) },
      });
      return true;
    },

    // event: COMMENT, or REQUEST_CHANGES while the review has findings (as
    // CodeRabbit's Automatic Approvals do). Returns {inline, event}: event is
    // what GitHub filed, COMMENT when it refused the decision itself.
    async postReview(repoFull, pr, { commitId, body, comments, event = "COMMENT" }) {
      const name = nameOf(repoFull);
      if (!REVIEW_EVENTS.has(event)) throw new Error("not a review event");
      const token = await app.installationToken([name], PR_SCOPE);
      const path = `/repos/${ORG}/${name}/pulls/${Number(pr)}/reviews`;
      try {
        await app.call("POST", path, { token, body: { commit_id: commitId, event, body, comments } });
        return { inline: comments.length, event };
      } catch (e) {
        if (e.status !== 422) throw e;
        // A comment position GitHub refuses, or the commit left the PR: keep
        // every finding, in the body.
        // Each comment's first line only (labels and title), so the list stays
        // readable and well inside GitHub's size limit.
        const listed = comments.map((c) => `- \`${codeSpan(c.path)}:${c.line}\`: ${String(c.body).split("\n")[0].slice(0, 300)}`).join("\n");
        const text = [body, `Reviewed commit ${String(commitId).slice(0, 7)}.`, listed && `#### Findings (GitHub would not place them inline)\n\n${listed}`]
          .filter(Boolean)
          .join("\n\n");
        let filed = event;
        try {
          await app.call("POST", path, { token, body: { event, body: text } });
        } catch (e2) {
          // Refused for the event itself (GitHub allows no decision on some
          // pull requests): the findings are still posted, as a comment.
          if (e2.status !== 422 || event === "COMMENT") throw e2;
          await app.call("POST", path, { token, body: { event: "COMMENT", body: text } });
          filed = "COMMENT";
        }
        return { inline: 0, event: filed };
      }
    },

    // --- approvals, threads and the summary comment (CodeRabbit parity) ---

    // An approval of exactly the commit that was checked: GitHub refuses it if
    // that commit is no longer the PR's (the caller checks the head first).
    // false when GitHub refuses it (422: the commit left the PR, or the App
    // may not approve this pull request), rather than an error retried for ever.
    async approve(repoFull, pr, { commitId, body }) {
      const name = nameOf(repoFull);
      if (!SHA.test(String(commitId))) throw new Error("approve takes a commit id");
      const token = await app.installationToken([name], PR_SCOPE);
      try {
        await app.call("POST", `/repos/${ORG}/${name}/pulls/${Number(pr)}/reviews`, {
          token,
          // The marker only, when there is no text: it shows nothing.
          body: { commit_id: commitId, event: "APPROVE", body: body ? `${MARKER}\n${body}` : MARKER },
        });
        return true;
      } catch (e) {
        if (e.status === 422) return false;
        throw e;
      }
    },

    // The App's own review decision as GitHub counts it: its latest review
    // that approved, requested changes or was dismissed (comments change
    // nothing), with the ids of every approval of its own still standing (a
    // renewed approval leaves the older one standing too, so a withdrawal
    // dismisses them all). {state, commitId, id, approvedIds, truncated}, or
    // null. truncated: ten full pages were read and there may be more, so the
    // answer may be out of date; then state is null if none of the App's
    // decisions was among them.
    async reviewDecision(repoFull, pr, botLogin) {
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], PR_SCOPE);
      let last = null;
      const approvedIds = [];
      // The commit each standing approval names: a head one of them already
      // covers is never approved again.
      const approvedHeads = [];
      let truncated = false;
      for (let page = 1; page <= 10; page++) {
        const list = await app.call("GET", `/repos/${ORG}/${name}/pulls/${Number(pr)}/reviews?per_page=100&page=${page}`, { token });
        for (const r of list ?? []) {
          if (r?.user?.type !== "Bot" || r.user.login !== botLogin || !DECISIONS.has(r.state)) continue;
          last = { state: r.state, commitId: r.commit_id ?? null, id: r.id ?? null };
          if (r.state === "APPROVED" && Number.isSafeInteger(r.id)) approvedIds.push(r.id);
          if (r.state === "APPROVED" && typeof r.commit_id === "string") approvedHeads.push(r.commit_id);
        }
        if (!list || list.length < 100) break;
        if (page === 10) truncated = true;
      }
      // Nothing of the App's in ten full pages is not "never decided": the
      // answer is unknown (state null), so a caller approves nothing.
      if (!last) return truncated ? { state: null, commitId: null, id: null, approvedIds, approvedHeads, truncated } : null;
      return { ...last, approvedIds, approvedHeads, truncated };
    },

    // Withdraws one of the App's own reviews (an approval no longer true), as
    // CodeRabbit withdraws its approval. False when GitHub refuses.
    async dismissReview(repoFull, pr, reviewId, message) {
      const name = nameOf(repoFull);
      if (!Number.isSafeInteger(reviewId)) throw new Error("not a review id");
      const token = await app.installationToken([name], PR_SCOPE);
      try {
        await app.call("PUT", `/repos/${ORG}/${name}/pulls/${Number(pr)}/reviews/${reviewId}/dismissals`, { token, body: { message, event: "DISMISS" } });
        return true;
      } catch (e) {
        if (e.status === 422 || e.status === 403) return false;
        throw e;
      }
    },

    // The App's own review threads (the first comment is the App's), with the
    // finding each is about. botLogin as GraphQL names it: the slug, no [bot].
    async ownThreads(repoFull, pr, botLogin) {
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], THREAD_SCOPE);
      const out = [];
      let after = null;
      for (let page = 0; page < 20; page++) {
        const data = await graphql(token, THREADS_QUERY, { owner: ORG, name, pr: Number(pr), after });
        const conn = data?.repository?.pullRequest?.reviewThreads;
        for (const t of conn?.nodes ?? []) {
          const c = t?.comments?.nodes?.[0];
          if (!c || c.author?.login !== botLogin) continue;
          out.push({
            id: t.id, resolved: Boolean(t.isResolved), outdated: Boolean(t.isOutdated), path: t.path ?? null,
            line: Number.isInteger(t.line) ? t.line : null, originalLine: Number.isInteger(t.originalLine) ? t.originalLine : null,
            // fullDatabaseId (a BigInt, sent as a string): review comment ids
            // are past 2^31 now, where the old Int databaseId fails.
            commentId: commentIdOf(c.fullDatabaseId ?? c.databaseId), body: String(c.body ?? ""), diffHunk: String(c.diffHunk ?? ""),
            originalCommit: c.originalCommit?.oid ?? null, findingId: findingIdOf(c.body),
            resolvedBy: t.resolvedBy?.login ?? null,
          });
        }
        if (!conn?.pageInfo?.hasNextPage) return out;
        after = conn.pageInfo.endCursor;
      }
      // Never a partial list: open threads past it would go unseen, and an
      // approval follow. The caller fails and tries again later.
      throw new Error("too many review threads to list");
    },

    async resolveThread(repoFull, threadId) {
      const name = nameOf(repoFull);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(threadId))) throw new Error("not a thread id");
      const token = await app.installationToken([name], THREAD_SCOPE);
      const data = await graphql(token, RESOLVE_MUTATION, { id: threadId });
      return data?.resolveReviewThread?.thread?.isResolved === true;
    },

    async editReviewComment(repoFull, commentId, body) {
      const name = nameOf(repoFull);
      if (!Number.isSafeInteger(commentId)) throw new Error("not a comment id");
      const token = await app.installationToken([name], PR_SCOPE);
      await app.call("PATCH", `/repos/${ORG}/${name}/pulls/comments/${commentId}`, { token, body: { body } });
    },

    // The one summary comment, edited in place on every review (CodeRabbit's
    // walkthrough comment does the same). A new one only when it is missing.
    // Returns its id.
    async upsertSummary(repoFull, pr, commentId, body) {
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], PR_SCOPE);
      const text = { body: `${MARKER}\n${body}` };
      if (Number.isSafeInteger(commentId)) {
        try {
          await app.call("PATCH", `/repos/${ORG}/${name}/issues/comments/${commentId}`, { token, body: text });
          return commentId;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      const made = await app.call("POST", `/repos/${ORG}/${name}/issues/${Number(pr)}/comments`, { token, body: text });
      return made?.id ?? null;
    },
  };

  // GraphQL answers 200 with errors: those are failures too.
  async function graphql(token, query, variables) {
    const out = await app.call("POST", "/graphql", { token, body: { query, variables } });
    if (Array.isArray(out?.errors) && out.errors.length) {
      throw new Error(`GitHub GraphQL failed: ${String(out.errors[0]?.message ?? "error").slice(0, 120)}`);
    }
    return out?.data ?? null;
  }
}

const SHA = /^[0-9a-f]{40}$/;
const REVIEW_EVENTS = new Set(["COMMENT", "REQUEST_CHANGES", "APPROVE"]);
const DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine resolvedBy { login }
          comments(first: 1) { nodes { fullDatabaseId author { login } body diffHunk originalCommit { oid } } }
        }
      }
    }
  }
}`;
const RESOLVE_MUTATION = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`;
