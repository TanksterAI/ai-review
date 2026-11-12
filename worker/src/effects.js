// Everything the Worker does to GitHub, as the Tankster AI Review App.
// Each call mints (or reuses) a token for exactly one repository and only the
// permissions that call needs. The runner never receives any of these.

import { createGithubApp } from "./github-app.js";
import { annotatePatch } from "./review.js";

export const ORG = "TanksterAI";
export const RUNNER_REPO = "ai-review";
const WRITE_LEVELS = new Set(["admin", "maintain", "write"]);
// One scope for everything the Worker does on a reviewed repository, so one
// cached token serves comments, permission checks and reviews. Every
// installation token can read metadata (the permission check needs it).
const PR_SCOPE = { pull_requests: "write" };
export const MARKER = "<!-- tankster-ai-review -->";

let cached;

function nameOf(repoFull) {
  const [owner, name, extra] = String(repoFull).split("/");
  if (owner !== ORG || !name || extra !== undefined) throw new Error("not a TanksterAI repository");
  return name;
}

export function createEffects(env, deps = {}) {
  const app =
    deps.app ??
    (cached ??= createGithubApp({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, org: ORG }));

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
      await app.call("POST", `/repos/${ORG}/${name}/issues/${Number(pr)}/comments`, {
        token,
        body: { body: `${MARKER}\n${body}` },
      });
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
    async cloneToken(repoFull) {
      return app.installationToken([nameOf(repoFull)], { contents: "read", pull_requests: "read" });
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

    async postReview(repoFull, pr, { commitId, body, comments }) {
      const name = nameOf(repoFull);
      const token = await app.installationToken([name], PR_SCOPE);
      const path = `/repos/${ORG}/${name}/pulls/${Number(pr)}/reviews`;
      try {
        await app.call("POST", path, { token, body: { commit_id: commitId, event: "COMMENT", body, comments } });
        return { inline: comments.length };
      } catch (e) {
        if (e.status !== 422) throw e;
        // A comment position GitHub refuses, or the commit left the PR: keep
        // every finding, in the body.
        const listed = comments.map((c) => `- \`${c.path}:${c.line}\`: ${String(c.body).replace(/\n+/g, " ")}`).join("\n");
        const text = [body, `Reviewed commit ${String(commitId).slice(0, 7)}.`, listed && `#### Findings (GitHub would not place them inline)\n\n${listed}`]
          .filter(Boolean)
          .join("\n\n");
        await app.call("POST", path, { token, body: { event: "COMMENT", body: text } });
        return { inline: 0 };
      }
    },
  };
}
