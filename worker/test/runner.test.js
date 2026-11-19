// Runs the github-script step of .github/workflows/runner.yml exactly as
// written, against stand-ins for core, fetch and getOctokit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const yml = readFileSync(fileURLToPath(new URL("../../.github/workflows/runner.yml", import.meta.url)), "utf8");

function extractScript(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s+script: \|\s*$/.test(l));
  assert.ok(start > 0, "script block not found");
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== "" && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

const SCRIPT = extractScript(yml);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const JOB = `${"0123456789abcdef".repeat(4)}.${"a".repeat(32)}`;
// The old form: base64url of "TanksterAI/browser-relay#39".
const OLD_JOB = `VGFua3N0ZXJBSS9icm93c2VyLXJlbGF5IzM5.${"a".repeat(32)}`;
const HEAD = "c".repeat(40);
const SINCE = "b".repeat(40);

function run({ job = JOB, session, review, pr = {}, compare, files = [{ filename: "a.js", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }], prError } = {}) {
  const log = { notices: [], warnings: [], failed: null, secrets: [], requests: [], fetches: [], revoked: 0, compared: null };
  const core = {
    notice: (m) => log.notices.push(m),
    warning: (m) => log.warnings.push(m),
    setFailed: (m) => { log.failed = m; },
    setSecret: (s) => log.secrets.push(s),
    getIDToken: async (aud) => { assert.equal(aud, "tankster-ai-review"); return `oidc-${log.fetches.length}`; },
  };
  const fetchStub = async (url, init) => {
    const body = JSON.parse(init.body);
    log.fetches.push({ url, auth: init.headers.authorization, body });
    if (url.endsWith("/v1/runner/session")) {
      const s = session ?? { status: 200, json: { job: { repo: { full: "TanksterAI/browser-relay", name: "browser-relay" }, pr: 39, since: SINCE, scope: "review" }, token: "ghs_clone" } };
      return Response.json(s.json, { status: s.status });
    }
    const r = review ?? { status: 200, json: { status: "reviewed", inline: 2, usage: { neurons: 120 } } };
    return Response.json(r.json, { status: r.status });
  };
  const getOctokit = (token, opts) => {
    assert.equal(token, "ghs_clone");
    // Octokit's own logger prints request URLs (on deprecation notices, say).
    for (const level of ["debug", "info", "warn", "error"]) assert.equal(typeof opts?.log?.[level], "function", `log.${level} is silenced`);
    for (const level of ["debug", "info", "warn", "error"]) assert.equal(opts.log[level]("GET /repos/TanksterAI/browser-relay/pulls/39"), undefined);
    assert.notEqual(opts.log.warn, console.warn);
    const listFiles = Symbol("listFiles");
    return {
      rest: {
        pulls: {
          get: async (a) => { if (prError) throw prError; log.prArgs = a; return { data: { state: "open", title: "T", body: null, head: { sha: HEAD }, ...pr } }; },
          listFiles,
        },
        repos: {
          compareCommitsWithBasehead: async (a) => { log.compared = a.basehead; return { data: compare ?? { status: "ahead", files: [{ filename: "new.js", status: "added", patch: "@@ +1 @@\n+x" }] } }; },
        },
      },
      paginate: async (fn) => { assert.equal(fn, listFiles); log.paginated = true; return files; },
      request: async (route) => { log.requests.push(route); if (route === "DELETE /installation/token") log.revoked++; },
    };
  };
  const env = { JOB: job };
  const proc = { env };
  return new AsyncFunction("core", "fetch", "getOctokit", "process", "AbortSignal", SCRIPT)(core, fetchStub, getOctokit, proc, AbortSignal)
    .then(() => log, (e) => { log.threw = e; return log; });
}

test("the workflow keeps its guard rails", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n      job:\n/m);
  assert.doesNotMatch(yml, /repository_dispatch|pull_request_target|issue_comment/);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.match(yml, /^    permissions:\n      id-token: write\n    steps:/m, "id-token only; no GITHUB_TOKEN scopes");
  assert.match(yml, /JOB: \$\{\{ inputs\.job \}\}/, "the job id reaches the script as data");
  assert.doesNotMatch(SCRIPT, /\$\{\{/, "nothing is interpolated into the script");
  assert.match(yml, /actions\/github-script@[0-9a-f]{40} # v9/);
});

test("a run without a valid job id does nothing", async () => {
  for (const job of ["", "x", `${JOB}; rm -rf /`, "a.b", OLD_JOB]) {
    const log = await run({ job });
    assert.match(log.failed, /no valid job id/);
    assert.equal(log.fetches.length, 0);
  }
});

test("incremental: only the commits after the recorded one, then the token is revoked", async () => {
  const log = await run();
  assert.deepEqual(log.secrets, ["ghs_clone"]);
  assert.equal(log.compared, `${SINCE}...${HEAD}`);
  assert.ok(!log.paginated);
  const sent = log.fetches[1];
  assert.match(sent.url, /\/v1\/runner\/review$/);
  assert.equal(sent.body.job, JOB);
  assert.equal(sent.body.since, SINCE);
  assert.equal(sent.body.head_sha, HEAD);
  assert.deepEqual(sent.body.files.map((f) => f.filename), ["new.js"]);
  // A fresh OIDC token per request.
  assert.notEqual(log.fetches[0].auth, log.fetches[1].auth);
  assert.equal(log.revoked, 1);
  assert.match(log.notices[0], /2 inline comment/);
});

test("after a force-push the whole PR is reviewed", async () => {
  const log = await run({ compare: { status: "diverged", files: [] } });
  assert.ok(log.paginated);
  assert.equal(log.fetches[1].body.since, null);
});

test("a refused session stops before any GitHub call", async () => {
  const log = await run({ session: { status: 403, json: { status: "refused", reason: "job already claimed" } } });
  assert.match(log.failed, /job already claimed/);
  assert.equal(log.fetches.length, 1);
});

test("the token is revoked even when the run fails, and the failure shows only its status", async () => {
  const log = await run({ prError: Object.assign(new Error("boom"), { status: 500 }) });
  assert.equal(log.threw, undefined, "reported, not rethrown: a thrown error would print its request URL");
  assert.equal(log.failed, "A GitHub API call failed (HTTP 500).");
  assert.equal(log.revoked, 1);
  const other = await run({ prError: new TypeError("fetch failed for https://api.github.com/repos/TanksterAI/x") });
  assert.equal(other.failed, "The run failed (TypeError).");
  assert.equal(other.revoked, 1);
});

test("closed PRs, deferrals and failures are reported, not hidden", async () => {
  assert.match((await run({ pr: { state: "closed" } })).notices[0], /closed; nothing to review/);
  assert.match((await run({ review: { status: 429, json: { reason: "spent", resets_at: "2026-11-20T00:00:00Z" } } })).warnings[0], /deferred.*after 2026-11-20T00:00:00Z/);
  // 502 and 503 are queued by the Worker and tried again: a warning, not a failure.
  assert.match((await run({ review: { status: 502, json: { reason: "bad answer" } } })).warnings[0], /failed\. It is queued/);
  assert.match((await run({ review: { status: 503, json: { reason: "busy" } } })).warnings[0], /not run yet\. It is queued/);
  assert.equal((await run({ review: { status: 500, json: { reason: "boom" } } })).failed, "Review failed (HTTP 500).");
});

test("big patches are cut and the total is bounded", async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ filename: `f${i}.js`, status: "modified", patch: "x".repeat(30_000) }));
  const log = await run({ compare: { status: "diverged" }, files });
  const sent = log.fetches[1].body.files;
  assert.ok(sent.every((f) => !f.patch || f.patch.length <= 20_000));
  assert.ok(sent.reduce((n, f) => n + (f.patch?.length ?? 0), 0) <= 120_000);
  assert.ok(sent.some((f) => f.patch_omitted));
});

test("public log lines name no repository, pull request, commit or cost", async () => {
  // This repository is public, so its runs' logs are too.
  const logs = [
    await run(),
    await run({ review: { status: 200, json: { status: "reviewed", inline: 1, usage: { provider: "anthropic", model: "claude-haiku-5-5", usd: 0.0123 } } } }),
    await run({ review: { status: 200, json: { status: "skipped", reason: "nothing changed" } } }),
    await run({ review: { status: 409, json: { status: "duplicate" } } }),
    await run({ pr: { state: "closed" } }),
    // The Worker's reasons name models and spend: none may reach the log.
    await run({ review: { status: 429, json: { reason: "gemini:gemini-3.5-flash-lite is out of quota; today's Anthropic budget is spent ($1.23 of $5.00) for claude-haiku-5-5", resets_at: "2026-11-20T00:00:00Z" } } }),
    await run({ review: { status: 502, json: { reason: "claude-haiku-5-5 gave a bad answer for TanksterAI/browser-relay#39" } } }),
    await run({ review: { status: 503, json: { reason: "4000 of 8000 neurons used" } } }),
    await run({ review: { status: 500, json: { reason: "boom in TanksterAI/browser-relay" } } }),
    await run({ review: { status: 200, json: { status: "skipped", reason: "only TanksterAI/browser-relay lockfiles changed" } } }),
    // A failing GitHub call: Octokit's error carries the request URL.
    await run({ prError: Object.assign(new Error(`Server Error - https://api.github.com/repos/TanksterAI/browser-relay/pulls/39 ${HEAD}`), { status: 502, request: { url: "https://api.github.com/repos/TanksterAI/browser-relay/pulls/39" } }) }),
  ];
  for (const log of logs) {
    const lines = [...log.notices, ...log.warnings, log.failed ?? ""].join("\n");
    assert.ok(log.notices.length + log.warnings.length > 0 || log.failed, "each run still says what happened");
    for (const secret of ["TanksterAI", "browser-relay", "#39", "/pulls/", HEAD.slice(0, 7), "neurons", "$", "claude", "haiku", "gemini", "boom", "lockfiles"]) {
      assert.ok(!lines.includes(secret), `"${secret}" in: ${lines}`);
    }
  }
  assert.match(logs[0].notices[0], /^Reviewed: 2 inline comment\(s\)\.$/);
  assert.match(logs[2].notices[0], /^Nothing to review\.$/);
  assert.match(logs[3].notices[0], /already reviewed/);
});
