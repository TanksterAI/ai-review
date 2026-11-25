// The one-time GitHub App setup from a manifest, and where the App's
// configuration is read from.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AppSecrets, manifest, handleSetupStart, handleSetupCallback, appConfig, resetConfigCache } from "../src/setup.js";
import { normalise } from "../src/webhook.js";
import { PrState, parseCommand, helpText } from "../src/pr-state.js";
import { memoryStorage, doCtx } from "./helpers.js";

// These tests cover the runner path (REVIEW_MODE=runner); review-run.test.js
// and the worker-mode tests below cover the Worker's own review.
const RUNNER = { REVIEW_MODE: "runner" };

const NOW = 1_794_500_000_000;
const ORIGIN = "https://tankster-ai-review.rishi-tank.workers.dev";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nSECRETKEY\n-----END RSA PRIVATE KEY-----";
const HOOK_SECRET = "whsec-from-github";

function secretsNs(now = () => NOW) {
  const obj = new AppSecrets({ storage: memoryStorage() }, {}, { now });
  return { obj, idFromName: (n) => n, get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
}

function env(over = {}) {
  return { OWNER_ID: "259206056", APP_SECRETS: secretsNs(), ...over };
}

const converted = (over = {}) => ({
  id: 9999999, slug: "tankster-ai-review", owner: { id: 259206056, login: "TanksterAI" },
  pem: PEM, webhook_secret: HOOK_SECRET, client_id: "Iv23x", client_secret: "cs-secret", ...over,
});

function github(body, status = 201) {
  const calls = [];
  return { calls, fetcher: async (url, init) => { calls.push({ url, init }); return Response.json(body, { status }); } };
}

async function startState(e) {
  const res = await handleSetupStart(new Request(`${ORIGIN}/v1/setup/github-app`), e);
  const html = await res.text();
  return { res, html, state: /state=([0-9a-f]{32})/.exec(html)?.[1] };
}

beforeEach(() => resetConfigCache());

test("the manifest asks for exactly what v2 uses, and points back at this Worker", () => {
  const m = manifest(ORIGIN);
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.url, `${ORIGIN}/v1/github/webhook`);
  assert.equal(m.redirect_url, `${ORIGIN}/v1/setup/github-app/callback`);
  assert.deepEqual(m.default_events, ["pull_request", "issue_comment", "pull_request_review_comment", "pull_request_review_thread", "merge_group"]);
  // statuses: the "Tankster AI Review" commit status the merge gate reads.
  assert.deepEqual(m.default_permissions, { metadata: "read", contents: "read", pull_requests: "write", issues: "read", actions: "write", statuses: "write" });
  assert.equal(m.default_permissions.workflows, undefined);
  assert.equal(m.default_permissions.administration, undefined);
});

test("the start page: a single-use state, a form to GitHub only, strict headers", async () => {
  const e = env();
  const { res, html, state } = await startState(e);
  assert.equal(res.status, 200);
  assert.ok(state);
  assert.match(html, /action="https:\/\/github\.com\/organizations\/TanksterAI\/settings\/apps\/new\?state=[0-9a-f]{32}"/);
  assert.match(html, /name="manifest" value="\{&quot;name&quot;:&quot;Tankster AI Review&quot;/);
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the whole flow stores the App and never shows its secrets", async () => {
  const e = env();
  const { state } = await startState(e);
  const gh = github(converted());
  const res = await handleSetupCallback(new Request(`${ORIGIN}/v1/setup/github-app/callback?code=abc12345&state=${state}`), e, { fetcher: gh.fetcher });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /SECRETKEY|whsec|cs-secret/);
  const stored = await e.APP_SECRETS.obj.ctx.storage.get("app");
  assert.equal(stored.client_secret, undefined, "unused credentials are not kept");
  assert.match(html, /github\.com\/apps\/tankster-ai-review\/installations\/new/);
  assert.equal(gh.calls[0].url, "https://api.github.com/app-manifests/abc12345/conversions");
  assert.equal(gh.calls[0].init.method, "POST");
  assert.equal(gh.calls[0].init.headers.authorization, undefined, "the conversion needs no credential");

  const cfg = await appConfig(e);
  assert.deepEqual(cfg, { appId: "9999999", pem: PEM, webhookSecret: HOOK_SECRET, slug: "tankster-ai-review" });

  // Setup is now closed: no new state, and a second callback stores nothing.
  const again = await startState(e);
  assert.equal(again.res.status, 409);
});

test("a failed conversion can be retried from the same link; states expire after an hour", async () => {
  let t = NOW;
  const e = env({ APP_SECRETS: secretsNs(() => t) });
  const { state } = await startState(e);
  const down = github(converted(), 500);
  const first = await handleSetupCallback(new Request(`${ORIGIN}/cb?code=abc12345&state=${state}`), e, { fetcher: down.fetcher });
  assert.equal(first.status, 502);
  assert.match(await first.text(), /Reload this page to try again/);
  // Same link, GitHub back: it works.
  const ok = await handleSetupCallback(new Request(`${ORIGIN}/cb?code=abc12345&state=${state}`), e, { fetcher: github(converted()).fetcher });
  assert.equal(ok.status, 200);

  const e2 = env({ APP_SECRETS: secretsNs(() => t) });
  const second = await startState(e2);
  t = NOW + 3600_000 + 1;
  const gh = github(converted());
  assert.equal((await handleSetupCallback(new Request(`${ORIGIN}/cb?code=abc12345&state=${second.state}`), e2, { fetcher: gh.fetcher })).status, 403);
  assert.equal(gh.calls.length, 0, "an expired state never reaches GitHub");
});

test("a second tab after setup never converts its code", async () => {
  const e = env();
  const a = await startState(e);
  const b = await startState(e);
  await handleSetupCallback(new Request(`${ORIGIN}/cb?code=abc12345&state=${a.state}`), e, { fetcher: github(converted()).fetcher });
  const gh = github(converted({ id: 2 }));
  const res = await handleSetupCallback(new Request(`${ORIGIN}/cb?code=zzz12345&state=${b.state}`), e, { fetcher: gh.fetcher });
  assert.equal(res.status, 409);
  assert.equal(gh.calls.length, 0);
});

test("setup only runs on the Worker's own public origin", async () => {
  for (const origin of ["http://tankster-ai-review.rishi-tank.workers.dev", "https://abc123-tankster-ai-review.rishi-tank.workers.dev", "https://evil.example"]) {
    const e = env();
    assert.equal((await handleSetupStart(new Request(`${origin}/v1/setup/github-app`), e)).status, 400, origin);
    assert.equal((await handleSetupCallback(new Request(`${origin}/cb?code=abc12345&state=${"a".repeat(32)}`), e, { fetcher: github(converted()).fetcher })).status, 400, origin);
  }
});

test("outstanding setup links are capped and expired ones pruned", async () => {
  let t = NOW;
  const e = env({ APP_SECRETS: secretsNs(() => t) });
  for (let i = 0; i < 10; i++) assert.equal((await startState(e)).res.status, 200);
  assert.equal((await startState(e)).res.status, 429);
  t = NOW + 3600_000 + 1;
  assert.equal((await startState(e)).res.status, 200);
  assert.equal((await e.APP_SECRETS.obj.ctx.storage.list({ prefix: "state:" })).size, 1);
});

test("malformed or unknown code and state are refused before GitHub", async () => {
  const e = env();
  const gh = github(converted());
  for (const q of ["", "?code=abc12345", `?state=${"a".repeat(32)}`, `?code=a b&state=${"a".repeat(32)}`, `?code=abc12345&state=${"a".repeat(32)}`]) {
    const res = await handleSetupCallback(new Request(`${ORIGIN}/cb${q}`), e, { fetcher: gh.fetcher });
    assert.ok([400, 403].includes(res.status), q);
  }
  assert.equal(gh.calls.length, 0);
});

test("an App owned by anyone else, or incomplete, is never stored", async () => {
  for (const bad of [
    converted({ owner: { id: 1, login: "evil" } }),
    converted({ pem: "" }),
    converted({ webhook_secret: undefined }),
    converted({ slug: "Bad Slug" }),
  ]) {
    const e = env();
    const { state } = await startState(e);
    const res = await handleSetupCallback(new Request(`${ORIGIN}/cb?code=abc12345&state=${state}`), e, { fetcher: github(bad).fetcher });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /has no stored keys/);
    assert.doesNotMatch(html, /SECRETKEY|whsec/);
    assert.equal(await appConfig(e), null);
  }
});

test("Worker secrets, when all set, take precedence; nothing set means not set up", async () => {
  const fromEnv = await appConfig({ GITHUB_APP_ID: 5, GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "w" });
  assert.deepEqual(fromEnv, { appId: "5", pem: "k", webhookSecret: "w", slug: "tankster-ai-review" });
  assert.equal(await appConfig({}), null);
  await assert.rejects(appConfig({ GITHUB_APP_ID: 5, GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "w", GITHUB_APP_SLUG: "Bad Slug" }), /not a valid App slug/);
  assert.equal(await appConfig(env()), null);
});

test("the stored config is cached for five minutes", async () => {
  const e = env();
  const { state } = await startState(e);
  await handleSetupCallback(new Request(`${ORIGIN}/cb?code=abc12345&state=${state}`), e, { fetcher: github(converted()).fetcher });
  let reads = 0;
  const realGet = e.APP_SECRETS.get;
  e.APP_SECRETS.get = (id) => { reads++; return realGet(id); };
  let t = NOW;
  await appConfig(e, { now: () => t });
  await appConfig(e, { now: () => t });
  assert.equal(reads, 1);
  t += 5 * 60_000 + 1;
  await appConfig(e, { now: () => t });
  assert.equal(reads, 2);
});

test("another App slug changes the mention, the bot login and the help text", () => {
  const repository = { full_name: "TanksterAI/x", name: "x", owner: { id: 259206056 } };
  const comment = (body, login = "rishitank") => ({
    action: "created", repository, sender: { login, type: "User" },
    issue: { number: 3, pull_request: {} }, comment: { id: 1, body, author_association: "OWNER" },
  });
  const opts = { ownerId: "259206056", slug: "tankster-ai-reviewer" };
  assert.equal(normalise("issue_comment", comment("@tankster-ai-reviewer pause"), opts).slug, "tankster-ai-reviewer");
  assert.equal(normalise("issue_comment", comment("@tankster-ai-review pause"), opts), null);
  assert.equal(normalise("issue_comment", comment("@tankster-ai-reviewer pause", "tankster-ai-reviewer[bot]"), opts), null);
  assert.equal(parseCommand("@tankster-ai-reviewer full review", "tankster-ai-reviewer"), "full review");
  assert.match(helpText("tankster-ai-reviewer"), /`@tankster-ai-reviewer`/);
});

test("before setup, the outbox keeps its work and retries", async () => {
  const storage = memoryStorage();
  const obj = new PrState(doCtx(storage), { ...RUNNER, OWNER_ID: "259206056" }, { now: () => NOW });
  await obj.onEvent({
    delivery: "1",
    ev: {
      kind: "review", action: "opened", repo: { full: "TanksterAI/x", name: "x" }, pr: 3,
      sender: { login: "rishitank", bot: false }, head: { sha: "a".repeat(40) }, fork: false, draft: false,
      author: { login: "rishitank", association: "OWNER", bot: false },
    },
  });
  await assert.rejects(obj.alarm(), /not set up/);
  assert.equal((await storage.get("outbox")).length, 1);
});

test("replies name the App by its configured slug", async () => {
  const comments = [];
  const fx = {
    async comment(_r, _p, body) { comments.push(body); },
    async canWrite() { return true; },
    async dispatch() {},
  };
  const storage = memoryStorage();
  const obj = new PrState(doCtx(storage), RUNNER, { now: () => NOW, effects: fx });
  const repo = { full: "TanksterAI/x", name: "x" };
  await obj.onEvent({ delivery: "1", ev: { kind: "command", slug: "tankster-ai-reviewer", repo, pr: 3, sender: { login: "rishitank", bot: false }, text: "@tankster-ai-reviewer pause" } });
  await obj.alarm();
  assert.match(comments[0], /`@tankster-ai-reviewer resume`/);
  assert.doesNotMatch(comments[0], /@tankster-ai-review\b(?!er)/);
});
