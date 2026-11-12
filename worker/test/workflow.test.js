// Runs the github-script step of .github/workflows/review.yml exactly as
// written, against stand-ins for github, context, core and fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const yml = readFileSync(fileURLToPath(new URL("../../.github/workflows/review.yml", import.meta.url)), "utf8");

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

function harness({ pr = {}, files = [], response, createReview, env = {}, payload } = {}) {
  const log = { notices: [], warnings: [], failed: null, reviews: [], fetches: [] };
  const prData = {
    number: 39, state: "open", draft: false, title: "T", body: "B",
    user: { login: "rishitank", type: "User" }, head: { sha: "f".repeat(40) }, ...pr,
  };
  const github = {
    rest: {
      pulls: {
        get: async (args) => { log.get = args; return { data: prData }; },
        listFiles: Symbol("listFiles"),
        createReview: async (args) => {
          log.reviews.push(args);
          if (createReview) return createReview(args, log.reviews.length);
          return { data: {} };
        },
      },
    },
    paginate: async (fn, args) => { assert.equal(fn, github.rest.pulls.listFiles); log.paginate = args; return files; },
  };
  const core = {
    notice: (m) => log.notices.push(m),
    warning: (m) => log.warnings.push(m),
    setFailed: (m) => { log.failed = m; },
    getIDToken: async (aud) => { log.aud = aud; return "oidc-token"; },
  };
  const context = { repo: { owner: "TanksterAI", repo: "browser-relay" }, payload: payload ?? { pull_request: { number: 39 } } };
  const fetchStub = async (url, init) => {
    log.fetches.push({ url, init, body: JSON.parse(init.body) });
    const { status = 200, json } = response ?? {};
    return { status, ok: status >= 200 && status < 300, json: async () => { if (json === undefined) throw new Error("no json"); return json; } };
  };
  const processStub = { env: { PR_NUMBER: "0", FORCE: "false", SKIP_BOTS: "true", ENDPOINT: "https://tankster-ai-review.example.dev/", ...env } };
  const run = new AsyncFunction("github", "context", "core", "fetch", "process", SCRIPT);
  return { log, go: () => run(github, context, core, fetchStub, processStub) };
}

const reviewed = {
  status: "reviewed",
  review: { body: "<!-- tankster-ai-review -->\nbody", comments: [{ path: "a.js", line: 3, side: "RIGHT", body: "**Major (bug): x**\n\ny" }] },
  usage: { neurons: 700, spent_today: 1400, cap: 6000 },
};

test("posts one COMMENT review with the Worker's inline comments", async () => {
  const files = [{ filename: "a.js", status: "modified", additions: 1, deletions: 0, patch: "@@", sha: "x", blob_url: "u" }];
  const h = harness({ files, response: { json: reviewed } });
  await h.go();
  assert.equal(h.log.failed, null);
  assert.equal(h.log.aud, "tankster-ai-review");
  assert.equal(h.log.fetches[0].url, "https://tankster-ai-review.example.dev/v1/review");
  assert.equal(h.log.fetches[0].init.headers.authorization, "Bearer oidc-token");
  assert.deepEqual(h.log.fetches[0].body.files, [{ filename: "a.js", status: "modified", additions: 1, deletions: 0, patch: "@@" }]);
  assert.equal(h.log.fetches[0].body.head_sha, "f".repeat(40));
  assert.equal(h.log.reviews.length, 1);
  assert.equal(h.log.reviews[0].event, "COMMENT");
  assert.equal(h.log.reviews[0].commit_id, "f".repeat(40));
  assert.equal(h.log.reviews[0].comments.length, 1);
  assert.match(h.log.notices[0], /1 inline comment\(s\)\. 700 neurons; 1400 of 6000/);
});

test("a dispatched run reviews the PR it is given", async () => {
  const h = harness({ env: { PR_NUMBER: "12", FORCE: "true" }, payload: {}, response: { json: reviewed } });
  await h.go();
  assert.equal(h.log.get.pull_number, 12);
  assert.equal(h.log.fetches[0].body.force, true);
});

test("a refused comment position falls back to findings in the body", async () => {
  const h = harness({
    response: { json: reviewed },
    createReview: (args, n) => { if (n === 1) { const e = new Error("Unprocessable"); e.status = 422; throw e; } return { data: {} }; },
  });
  await h.go();
  assert.equal(h.log.reviews.length, 2);
  assert.equal(h.log.reviews[1].comments, undefined);
  assert.match(h.log.reviews[1].body, /`a\.js:3`: \*\*Major \(bug\): x\*\* y/);
  assert.match(h.log.notices[0], /0 inline comment/);
});

test("other GitHub errors are not swallowed", async () => {
  const h = harness({ response: { json: reviewed }, createReview: () => { const e = new Error("boom"); e.status = 500; throw e; } });
  await assert.rejects(h.go(), /boom/);
});

test("closed, draft and bot pull requests are skipped before any call", async () => {
  for (const pr of [{ state: "closed" }, { draft: true }, { user: { login: "renovate[bot]", type: "Bot" } }]) {
    const h = harness({ pr, response: { json: reviewed } });
    await h.go();
    assert.equal(h.log.fetches.length, 0);
    assert.equal(h.log.reviews.length, 0);
    assert.equal(h.log.failed, null);
    assert.equal(h.log.notices.length, 1);
  }
  const bots = harness({ pr: { user: { login: "renovate[bot]", type: "Bot" } }, env: { SKIP_BOTS: "false" }, response: { json: reviewed } });
  await bots.go();
  assert.equal(bots.log.reviews.length, 1);
});

test("duplicate, deferred and skipped answers are not failures", async () => {
  const cases = [
    [{ status: 409, json: { status: "duplicate" } }, "notices", /already reviewed/],
    [{ status: 429, json: { status: "deferred", reason: "spent", resets_at: "2026-11-13T00:00:00.000Z" } }, "warnings", /deferred: spent.*2026-11-13/],
    [{ status: 200, json: { status: "skipped", reason: "no reviewable text changes" } }, "notices", /Nothing to review/],
  ];
  for (const [response, kind, re] of cases) {
    const h = harness({ response });
    await h.go();
    assert.equal(h.log.failed, null);
    assert.equal(h.log.reviews.length, 0);
    assert.match(h.log[kind][0], re);
  }
});

test("Worker errors fail the job with the reason", async () => {
  for (const response of [{ status: 502, json: { status: "failed", reason: "the model call failed" } }, { status: 503 }, { status: 401, json: { status: "unauthorized", reason: "wrong workflow" } }]) {
    const h = harness({ response });
    await h.go();
    assert.match(h.log.failed, /Review failed \(HTTP \d+\)/);
    assert.equal(h.log.reviews.length, 0);
  }
});

test("no pull request or a non-https endpoint fails before any call", async () => {
  const none = harness({ payload: {} });
  await none.go();
  assert.match(none.log.failed, /No pull request/);
  const http = harness({ env: { ENDPOINT: "http://evil.example" } });
  await http.go();
  assert.match(http.log.failed, /https/);
  assert.equal(http.log.fetches.length, 0);
});

test("patches are capped per file and in total before they are sent", async () => {
  const big = "x".repeat(30_000);
  const files = Array.from({ length: 12 }, (_, i) => ({ filename: `f${i}.js`, status: "modified", additions: 1, deletions: 0, patch: big }));
  files.push({ filename: "logo.png", status: "added", additions: 0, deletions: 0 });
  const h = harness({ files, response: { json: reviewed } });
  await h.go();
  const sent = h.log.fetches[0].body.files;
  assert.equal(sent.length, 13);
  assert.ok(sent.filter((f) => f.patch).every((f) => f.patch.length === 25_000));
  assert.equal(sent.filter((f) => f.patch).length, 10);
  assert.equal(sent.filter((f) => f.patch_omitted).length, 2);
  assert.equal(sent[12].patch, undefined);
  assert.equal(sent[12].patch_omitted, undefined);
});
