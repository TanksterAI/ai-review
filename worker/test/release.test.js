// Runs the github-script step of .github/workflows/release-v1.yml exactly as
// written, against stand-ins for github, context and core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const yml = readFileSync(fileURLToPath(new URL("../../.github/workflows/release-v1.yml", import.meta.url)), "utf8");

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
const MAIN = "b".repeat(40);
const OLD = "a".repeat(40);
const TAG_OBJ = "c".repeat(40);
const REPO = { owner: "TanksterAI", repo: "ai-review" };
const forbidden = () => Object.assign(new Error("Resource not accessible by integration"), { status: 403 });

async function run({ tag, annotated, status, getRefError, writeError } = {}) {
  const log = { notices: [], failed: null, updates: [], creates: [], compares: [], peeled: [] };
  const github = {
    rest: {
      git: {
        getRef: async (a) => {
          assert.deepEqual(a, { ...REPO, ref: "tags/v1" });
          if (getRefError) throw getRefError;
          if (!tag) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { object: annotated ? { type: "tag", sha: TAG_OBJ } : { type: "commit", sha: tag } } };
        },
        getTag: async (a) => { log.peeled.push(a); return { data: { object: { type: "commit", sha: tag } } }; },
        updateRef: async (a) => { log.updates.push(a); if (writeError) throw writeError; return { data: {} }; },
        createRef: async (a) => { log.creates.push(a); if (writeError) throw writeError; return { data: {} }; },
      },
      repos: {
        compareCommitsWithBasehead: async (a) => { log.compares.push(a); return { data: { status } }; },
      },
    },
  };
  const core = { notice: (m) => log.notices.push(m), setFailed: (m) => { log.failed = m; } };
  const context = { sha: MAIN, repo: REPO };
  await new AsyncFunction("github", "context", "core", SCRIPT)(github, context, core);
  return log;
}

test("creates v1 when there is none", async () => {
  const log = await run();
  assert.deepEqual(log.creates, [{ ...REPO, ref: "refs/tags/v1", sha: MAIN }]);
  assert.equal(log.updates.length + log.compares.length, 0);
  assert.equal(log.failed, null);
  assert.match(log.notices[0], /created/);
});

test("leaves v1 alone when it is already at main", async () => {
  const log = await run({ tag: MAIN });
  assert.equal(log.updates.length + log.creates.length + log.compares.length, 0);
  assert.equal(log.failed, null);
  assert.match(log.notices[0], /already at/);
});

test("an annotated v1 is peeled to its commit", async () => {
  const same = await run({ tag: MAIN, annotated: true });
  assert.deepEqual(same.peeled, [{ ...REPO, tag_sha: TAG_OBJ }]);
  assert.equal(same.updates.length + same.compares.length, 0);
  assert.equal(same.failed, null);

  const older = await run({ tag: OLD, annotated: true, status: "ahead" });
  assert.deepEqual(older.compares, [{ ...REPO, basehead: `${OLD}...${MAIN}` }]);
  assert.equal(older.updates.length, 1);
});

test("moves v1 forward when main is ahead of it", async () => {
  const log = await run({ tag: OLD, status: "ahead" });
  assert.deepEqual(log.compares, [{ ...REPO, basehead: `${OLD}...${MAIN}` }]);
  assert.deepEqual(log.updates, [{ ...REPO, ref: "tags/v1", sha: MAIN, force: true }]);
  assert.equal(log.creates.length, 0);
  assert.equal(log.failed, null);
  assert.match(log.notices[0], /moved from aaaaaaa to bbbbbbb/);
});

test("an identical compare is a no-op, not a failure", async () => {
  const log = await run({ tag: OLD, status: "identical" });
  assert.equal(log.updates.length, 0);
  assert.equal(log.failed, null);
});

test("refuses to move v1 back or sideways", async () => {
  for (const status of ["behind", "diverged"]) {
    const log = await run({ tag: OLD, status });
    assert.equal(log.updates.length, 0, status);
    assert.match(log.failed, /not a descendant of v1/);
    assert.match(log.failed, new RegExp(`compare: ${status}`));
  }
});

test("a 403 (commits that change workflows) fails with the command to run by hand", async () => {
  for (const opts of [{ tag: OLD, status: "ahead" }, {}]) {
    const log = await run({ ...opts, writeError: forbidden() });
    assert.match(log.failed, /403/);
    assert.match(log.failed, new RegExp(`git push --force origin ${MAIN}:refs/tags/v1`));
    assert.equal(log.notices.length, 0);
  }
});

test("errors other than a missing tag or a 403 are not swallowed", async () => {
  await assert.rejects(run({ getRefError: Object.assign(new Error("boom"), { status: 500 }) }), /boom/);
  await assert.rejects(
    run({ tag: OLD, status: "ahead", writeError: Object.assign(new Error("bad"), { status: 422 }) }),
    /bad/,
  );
});

test("the workflow keeps its guard rails", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:\n\n/m, "dispatch only");
  assert.match(yml, /^permissions: \{\}$/m, "no permissions by default");
  assert.match(yml, /^    if: github\.ref == 'refs\/heads\/main'$/m, "runs only on main");
  assert.match(yml, /^    permissions:\n      contents: write\n    steps:/m, "contents: write only");
  assert.match(yml, /^concurrency:\n  group: release-v1\n  cancel-in-progress: false$/m, "one at a time");
  assert.match(yml, /actions\/github-script@[0-9a-f]{40} # v9/, "github-script pinned to a commit");
});
