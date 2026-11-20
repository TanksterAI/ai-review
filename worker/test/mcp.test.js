import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcp, TOOLS, INSTRUCTIONS } from "../src/mcp.js";

// A GitHub that knows one token: who it is, and what it may do on one repo.
function github({ login = "rishitank", push = true, read = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.headers?.authorization]);
    const u = new URL(url);
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const no = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (init.headers?.authorization !== "Bearer ghu_good") return new Response("{}", { status: 401 });
    if (u.pathname === "/user") return ok({ login });
    if (/^\/repos\/TanksterAI\/[\w.-]+$/.test(u.pathname)) return read ? ok({ permissions: { push } }) : no();
    if (/^\/repos\/TanksterAI\/[\w.-]+\/pulls\/\d+$/.test(u.pathname)) return read ? ok({ number: 3 }) : no();
    return no();
  };
  return { calls, fetchImpl };
}

function stub(replies = {}) {
  const asked = [];
  return {
    asked,
    ask: async (repo, pr, msg) => { asked.push({ repo, pr, msg }); return replies[msg.op] ?? { ok: true }; },
  };
}

const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const post = (body, token = "ghu_good") => new Request("https://w/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const text = async (res) => JSON.parse((await res.json()).result.content[0].text);

test("no token: 401 with a Bearer challenge, and nothing is asked of GitHub", async () => {
  const gh = github();
  const res = await handleMcp(post(rpc("tools/list"), null), {}, { fetch: gh.fetchImpl, ...stub() });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /^Bearer/);
  assert.equal(gh.calls.length, 0);
});

test("initialize carries the instructions an agent follows, and the tools capability", async () => {
  const res = await handleMcp(post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } })), {}, { fetch: github().fetchImpl, ...stub() });
  const r = (await res.json()).result;
  assert.ok(r.capabilities.tools);
  assert.equal(r.serverInfo.name, "tankster-ai-review");
  assert.equal(r.instructions, INSTRUCTIONS);
  assert.match(INSTRUCTIONS, /get_review_status/);
  assert.match(INSTRUCTIONS, /not as a draft|ready for review/);
  assert.match(INSTRUCTIONS, /next_action/);
});

test("tools/list: three tools, annotated, with the read-only ones marked so", async () => {
  const res = await handleMcp(post(rpc("tools/list")), {}, { fetch: github().fetchImpl, ...stub() });
  const tools = (await res.json()).result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_review_status", "list_review_threads", "request_review"]);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.get_review_status.annotations.readOnlyHint, true);
  assert.equal(by.list_review_threads.annotations.readOnlyHint, true);
  assert.equal(by.request_review.annotations.readOnlyHint, false);
  assert.equal(by.request_review.annotations.destructiveHint, false);
  for (const t of tools) assert.deepEqual(t.inputSchema.required.slice(0, 2), ["repository", "pull_number"]);
  assert.equal(TOOLS.length, 3);
});

test("get_review_status: the token's own access is checked, then the PR's object answers", async () => {
  const gh = github();
  const s = stub({ status: { next_action: "wait", can_request_review: true } });
  const res = await handleMcp(post(call("get_review_status", { repository: "TanksterAI/ai-review", pull_number: 3 })), {}, { fetch: gh.fetchImpl, ...s });
  assert.deepEqual(await text(res), { next_action: "wait", can_request_review: true });
  assert.equal(s.asked[0].msg.op, "status");
  assert.equal(s.asked[0].repo, "TanksterAI/ai-review");
  assert.equal(s.asked[0].pr, 3);
  assert.ok(gh.calls.some(([u]) => u.endsWith("/repos/TanksterAI/ai-review/pulls/3")));
});

test("a PR the token cannot see is refused, and the reviewer's object is never asked", async () => {
  const s = stub();
  const res = await handleMcp(post(call("get_review_status", { repository: "TanksterAI/ai-review", pull_number: 3 })), {}, { fetch: github({ read: false }).fetchImpl, ...s });
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.equal(s.asked.length, 0);
});

test("repositories outside the organisation, and malformed arguments, are refused before any call", async () => {
  const gh = github();
  const s = stub();
  for (const args of [
    { repository: "evil/ai-review", pull_number: 3 },
    { repository: "TanksterAI/ai-review/../x", pull_number: 3 },
    { repository: "TanksterAI/ai-review", pull_number: "3; drop" },
    { repository: "TanksterAI/ai-review", pull_number: -1 },
    {},
  ]) {
    const res = await handleMcp(post(call("get_review_status", args)), {}, { fetch: gh.fetchImpl, ...s });
    assert.equal((await res.json()).result.isError, true, JSON.stringify(args));
  }
  assert.equal(gh.calls.length, 0);
  assert.equal(s.asked.length, 0);
});

test("request_review needs push access; a reader is refused, a writer's request is passed on as that login", async () => {
  const args = { repository: "TanksterAI/ai-review", pull_number: 3 };
  const reader = stub();
  const r1 = await handleMcp(post(call("request_review", args)), {}, { fetch: github({ push: false }).fetchImpl, ...reader });
  assert.equal((await r1.json()).result.isError, true);
  assert.equal(reader.asked.length, 0);

  const writer = stub({ request: { accepted: true, next_action: "wait" } });
  const r2 = await handleMcp(post(call("request_review", { ...args, full: true })), {}, { fetch: github().fetchImpl, slug: "tankster-ai-review", ...writer });
  assert.deepEqual(await text(r2), { accepted: true, next_action: "wait" });
  assert.deepEqual(writer.asked[0].msg, { op: "request", slug: "tankster-ai-review", login: "rishitank", repo: { full: "TanksterAI/ai-review", name: "ai-review" }, pr: 3, full: true });
});

test("a refusal is a normal answer with its reason, not an error: the agent reads it and stops", async () => {
  const s = stub({ request: { accepted: false, reason: "This pull request is a draft: it is reviewed once it is marked ready.", next_action: "mark_ready_for_review" } });
  const res = await handleMcp(post(call("request_review", { repository: "TanksterAI/ai-review", pull_number: 3 })), {}, { fetch: github().fetchImpl, ...s });
  const body = await res.json();
  assert.notEqual(body.result.isError, true);
  assert.equal(JSON.parse(body.result.content[0].text).accepted, false);
});

test("list_review_threads passes the filter on; unknown tools and methods are JSON-RPC errors; notifications get 202", async () => {
  const s = stub({ threads: { threads: [] } });
  const ok = await handleMcp(post(call("list_review_threads", { repository: "TanksterAI/ai-review", pull_number: 3, include_resolved: true })), {}, { fetch: github().fetchImpl, ...s });
  assert.deepEqual(await text(ok), { threads: [] });
  assert.equal(s.asked[0].msg.include_resolved, true);
  const unk = await handleMcp(post(call("nope", {})), {}, { fetch: github().fetchImpl, ...stub() });
  assert.ok((await unk.json()).error);
  const m = await handleMcp(post(rpc("resources/list")), {}, { fetch: github().fetchImpl, ...stub() });
  assert.equal((await m.json()).error.code, -32601);
  const n = await handleMcp(post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), {}, { fetch: github().fetchImpl, ...stub() });
  assert.equal(n.status, 202);
  const g = await handleMcp(new Request("https://w/mcp", { method: "GET", headers: { authorization: "Bearer ghu_good" } }), {}, { fetch: github().fetchImpl, ...stub() });
  assert.equal(g.status, 405);
});

test("a GitHub 401, 403 or 5xx is told apart from a PR that is not found, and nothing is asked of the reviewer", async () => {
  for (const [status, re] of [[401, /did not accept your token/], [403, /refused the request/], [502, /could not answer/]]) {
    const s = stub();
    const fetchImpl = async () => new Response("{}", { status });
    const body = await (await handleMcp(post(call("get_review_status", { repository: "TanksterAI/ai-review", pull_number: 3 })), {}, { fetch: fetchImpl, ...s })).json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, re);
    assert.equal(s.asked.length, 0);
  }
});

test("the repository's canonical name from GitHub is what the reviewer's state is keyed on, whatever case the caller used", async () => {
  const s = stub({ status: { ok: true } });
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (/^\/repos\/TanksterAI\/[\w.-]+\/pulls\/\d+$/.test(u.pathname)) return new Response(JSON.stringify({ number: 3, base: { repo: { full_name: "TanksterAI/ai-review" } } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  await handleMcp(post(call("get_review_status", { repository: "TanksterAI/AI-REVIEW", pull_number: 3 })), {}, { fetch: fetchImpl, ...s });
  assert.equal(s.asked[0].repo, "TanksterAI/ai-review");
  assert.equal(s.asked[0].msg.repo.full, "TanksterAI/ai-review");
});

test("a pull request whose base repository is not in the organisation is refused", async () => {
  const s = stub();
  const fetchImpl = async () => new Response(JSON.stringify({ number: 3, base: { repo: { full_name: "someone-else/ai-review" } } }), { status: 200 });
  const body = await (await handleMcp(post(call("get_review_status", { repository: "TanksterAI/ai-review", pull_number: 3 })), {}, { fetch: fetchImpl, ...s })).json();
  assert.equal(body.result.isError, true);
  assert.equal(s.asked.length, 0);
});
