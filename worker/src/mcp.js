// The reviewer's MCP server: how an agent (any agent) finds out what the
// reviewer will do and asks it for something, with the rules kept here and not
// in the agent's memory.
//
//   - get_review_status: read-only; `next_action` says what to do.
//   - request_review: the same request a comment makes, refused with its
//     reason when it would change nothing (a draft, a closed PR, a commit
//     already reviewed or under review).
//   - list_review_threads: the reviewer's own threads on the PR.
//
// The instructions and annotations below are advice an agent may read; the
// refusals are enforced by the PR's Durable Object, whatever the agent read.
// Each call is made with the caller's own GitHub token, checked against the
// PR first, so a caller sees only what GitHub lets them see.

import { ORG } from "./effects.js";

export const INSTRUCTIONS = [
  "Tankster AI Review reviews a pull request by itself: when it is opened, when a draft is marked ready for review, and a few minutes after the last push.",
  "Do not ask for a review to start one, except as ask_a_writer_to_request_review says. Open pull requests ready for review, not as a draft, and push; the review follows.",
  "Before anything else, call get_review_status and follow its next_action: wait (a review is coming or running), ask_a_writer_to_request_review (a pull request from a fork is reviewed only when someone with write access calls request_review), read_threads (the last commit is reviewed), mark_ready_for_review (a draft is not reviewed), resume (automatic reviews are paused), none (closed).",
  "request_review needs write access: it asks for a review of the commits since the last one, or with full=true of every file again. It refuses, with the reason, whatever would change nothing.",
].join(" ");

const PR_ARGS = {
  repository: { type: "string", description: "Repository as TanksterAI/<name>." },
  pull_number: { type: "integer", minimum: 1, description: "The pull request's number." },
};

export const TOOLS = [
  {
    name: "get_review_status",
    description: "Where the review of a pull request stands, and what to do next (`next_action`). Call this before requesting anything.",
    inputSchema: { type: "object", properties: { ...PR_ARGS }, required: ["repository", "pull_number"], additionalProperties: false },
    annotations: { title: "Review status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_review_threads",
    description: "The reviewer's own review threads on a pull request: open ones unless include_resolved is set, each with its severity, category, file and line.",
    inputSchema: { type: "object", properties: { ...PR_ARGS, include_resolved: { type: "boolean", default: false } }, required: ["repository", "pull_number"], additionalProperties: false },
    annotations: { title: "Review threads", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "request_review",
    description: "Ask for a review now (full: every file again). Refused, with the reason, when it would change nothing: a draft, a closed pull request, a commit already reviewed or under review. Needs write access to the repository.",
    inputSchema: { type: "object", properties: { ...PR_ARGS, full: { type: "boolean", default: false } }, required: ["repository", "pull_number"], additionalProperties: false },
    annotations: { title: "Request a review", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const reply = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const content = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

async function gh(fetchImpl, token, path) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "tankster-ai-review-mcp", "x-github-api-version": "2022-11-28" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error("github"), { status: res.status });
  return res.json();
}

function target(args) {
  const [owner, name, ...rest] = String(args?.repository ?? "").split("/");
  const pr = args?.pull_number;
  if (owner !== ORG || !NAME_RE.test(name ?? "") || rest.length || name === "." || name === ".." || !Number.isSafeInteger(pr) || pr < 1) return null;
  return { repo: { full: `${ORG}/${name}`, name }, pr };
}

async function run(name, args, token, deps) {
  const t = target(args);
  if (!t) return content("Give repository as TanksterAI/<name> and pull_number as a positive integer.", true);
  // The caller's own token must see the pull request.
  const pull = await gh(deps.fetch, token, `/repos/${t.repo.full}/pulls/${t.pr}`);
  if (!pull) return content("That pull request was not found, or your GitHub account cannot see it.", true);
  // GitHub's own spelling of the repository is its identity: names differ only
  // by case, but the reviewer's state is keyed on the name it is given.
  const canonical = pull.base?.repo?.full_name;
  if (canonical) {
    const [o, n] = String(canonical).split("/");
    if (o !== ORG || !NAME_RE.test(n ?? "")) return content("That pull request is not in a TanksterAI repository.", true);
    t.repo = { full: canonical, name: n };
  }
  const slug = deps.slug;
  if (name === "get_review_status") return content(await deps.ask(t.repo.full, t.pr, { op: "status", slug, repo: t.repo, pr: t.pr }));
  if (name === "list_review_threads") return content(await deps.ask(t.repo.full, t.pr, { op: "threads", slug, repo: t.repo, pr: t.pr, include_resolved: args.include_resolved === true }));
  // request_review: write access, as a slash command needs.
  const info = await gh(deps.fetch, token, `/repos/${t.repo.full}`);
  if (!info?.permissions?.push) return content("Requesting a review needs write access to the repository.", true);
  const me = await gh(deps.fetch, token, "/user");
  if (!me?.login) return content("GitHub did not say who you are.", true);
  return content(await deps.ask(t.repo.full, t.pr, { op: "request", slug, login: me.login, repo: t.repo, pr: t.pr, full: args.full === true }));
}

export async function handleMcp(request, env, deps) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
  const auth = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!auth) return new Response("A GitHub token is needed.", { status: 401, headers: { "www-authenticate": 'Bearer realm="tankster-ai-review"' } });
  let msg;
  try {
    msg = JSON.parse(await request.text());
  } catch {
    return fail(null, -32700, "Parse error");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id, -32600, "Invalid request");
  if (msg.id === undefined) return new Response(null, { status: 202 });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "tankster-ai-review", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return reply(msg.id, {});
    case "tools/list": return reply(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(msg.id, -32602, `Unknown tool: ${String(name).slice(0, 60)}`);
      try {
        return reply(msg.id, await run(name, msg.params?.arguments ?? {}, auth[1], deps));
      } catch (e) {
        const g = e?.status;
        return reply(msg.id, content(g === 401 ? "GitHub did not accept your token."
          : g === 403 ? "GitHub refused the request (your token's permissions or a rate limit); try again later."
          : "The reviewer could not answer just now; try again shortly.", true));
      }
    }
    default: return fail(msg.id, -32601, "Method not found");
  }
}
