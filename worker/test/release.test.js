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

async function run({ tag, status, getRefError } = {}) {
  const log = { notices: [], failed: null, updates: [], creates: [], compares: [] };
  const github = {
    rest: {
      git: {
        getRef: async () => {
          if (getRefError) throw getRefError;
          if (!tag) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { object: { sha: tag } } };
        },
        updateRef: async (a) => { log.updates.push(a); return { data: {} }; },
        createRef: async (a) => { log.creates.push(a); return { data: {} }; },
      },
      repos: {
        compareCommitsWithBasehead: async (a) => { log.compares.push(a); return { data: { status } }; },
      },
    },
  };
  const core = { notice: (m) => log.notices.push(m), setFailed: (m) => { log.failed = m; } };
  const context = { sha: MAIN, repo: { owner: "TanksterAI", repo: "ai-review" } };
  await new AsyncFunction("github", "context", "core", SCRIPT)(github, context, core);
  return log;
}

test("creates v1 when there is none", async () => {
  const log = await run();
  assert.deepEqual(log.creates, [{ owner: "TanksterAI", repo: "ai-review", ref: "refs/tags/v1", sha: MAIN }]);
  assert.equal(log.updates.length, 0);
  assert.equal(log.failed, null);
});

test("leaves v1 alone when it is already at main", async () => {
  const log = await run({ tag: MAIN });
  assert.equal(log.updates.length + log.creates.length + log.compares.length, 0);
  assert.match(log.notices[0], /already at/);
});

test("moves v1 forward when main is ahead of it", async () => {
  const log = await run({ tag: OLD, status: "ahead" });
  assert.deepEqual(log.compares, [{ owner: "TanksterAI", repo: "ai-review", basehead: `${OLD}...${MAIN}` }]);
  assert.equal(log.updates.length, 1);
  assert.equal(log.updates[0].sha, MAIN);
  assert.equal(log.failed, null);
});

test("refuses to move v1 back or sideways", async () => {
  for (const status of ["behind", "diverged"]) {
    const log = await run({ tag: OLD, status });
    assert.equal(log.updates.length, 0, status);
    assert.match(log.failed, new RegExp(`is ${status} of v1`));
  }
});

test("errors other than a missing tag are not swallowed", async () => {
  await assert.rejects(run({ getRefError: Object.assign(new Error("boom"), { status: 500 }) }), /boom/);
});
