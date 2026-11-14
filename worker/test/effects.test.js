import { test } from "node:test";
import assert from "node:assert/strict";
import { createEffects, MARKER } from "../src/effects.js";

function fakeApp(respond = () => ({})) {
  const log = { tokens: [], calls: [] };
  return {
    log,
    async installationToken(repos, permissions, opts) { log.tokens.push({ repos, permissions, ...(opts ? { opts } : {}) }); return `tok-${repos.join(",")}`; },
    async call(method, path, opts) {
      log.calls.push({ method, path, ...opts });
      const out = respond(method, path, opts);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

test("dispatch: an actions:write token for ai-review only, the runner on main, just the job id", async () => {
  const app = fakeApp();
  await createEffects({}, { app }).dispatch("job.123");
  assert.deepEqual(app.log.tokens, [{ repos: ["ai-review"], permissions: { actions: "write" } }]);
  assert.equal(app.log.calls[0].path, "/repos/TanksterAI/ai-review/actions/workflows/runner.yml/dispatches");
  assert.deepEqual(app.log.calls[0].body, { ref: "main", inputs: { job: "job.123" } });
});

test("prLines: the RIGHT-side lines of the PR's own files, across pages", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.js`, patch: "@@ -1,1 +1,2 @@\n a\n+b" }));
  const app = fakeApp((m, path) => (path.endsWith("&page=1") ? page1 : [{ filename: "last.js", patch: "@@ -0,0 +5,1 @@\n+x" }, { filename: "bin.png" }]));
  const lines = await createEffects({}, { app }).prLines("TanksterAI/x", 3, ["f0.js", "last.js", "f0.js"]);
  assert.equal(lines.size, 2, "only the files asked for are parsed");
  assert.deepEqual([...lines.get("f0.js")], [1, 2]);
  assert.deepEqual([...lines.get("last.js")], [5]);
  assert.equal(app.log.calls.length, 2);
  // Paging stops once every named file is found; nothing named, no calls.
  const early = fakeApp(() => page1);
  await createEffects({}, { app: early }).prLines("TanksterAI/x", 3, ["f0.js"]);
  assert.equal(early.log.calls.length, 1);
  const none = fakeApp(() => page1);
  assert.equal((await createEffects({}, { app: none }).prLines("TanksterAI/x", 3, [])).size, 0);
  assert.equal(none.log.calls.length, 0);
});

test("comment: one repo, pull_requests:write, marked as the bot's", async () => {
  const app = fakeApp();
  await createEffects({}, { app }).comment("TanksterAI/browser-relay", 39, "hello");
  assert.deepEqual(app.log.tokens[0], { repos: ["browser-relay"], permissions: { pull_requests: "write" } });
  assert.equal(app.log.calls[0].path, "/repos/TanksterAI/browser-relay/issues/39/comments");
  assert.equal(app.log.calls[0].body.body, `${MARKER}\nhello`);
});

test("only TanksterAI repositories are ever touched", async () => {
  const fx = createEffects({}, { app: fakeApp() });
  for (const bad of ["evil/repo", "TanksterAI", "TanksterAI/a/b", ""]) {
    await assert.rejects(fx.comment(bad, 1, "x"));
    await assert.rejects(fx.cloneToken(bad));
  }
});

test("canWrite: write, maintain and admin; not read, not unknown users, not odd logins", async () => {
  const levels = { a: "write", b: "maintain", c: "admin", d: "read", e: "triage" };
  const app = fakeApp((m, path) => {
    const login = path.split("/")[5];
    if (login === "ghost") return Object.assign(new Error("nf"), { status: 404 });
    return { permission: levels[login] };
  });
  const fx = createEffects({}, { app });
  for (const [login, ok] of [["a", true], ["b", true], ["c", true], ["d", false], ["e", false], ["ghost", false]]) {
    assert.equal(await fx.canWrite("TanksterAI/x", login), ok, login);
  }
  assert.equal(await fx.canWrite("TanksterAI/x", "../admin"), false);
  assert.deepEqual(app.log.tokens[0].permissions, { pull_requests: "write" });
});

test("cloneToken is read-only and fresh for every run (the runner revokes it)", async () => {
  const app = fakeApp();
  await createEffects({}, { app }).cloneToken("TanksterAI/browser-relay");
  assert.deepEqual(app.log.tokens[0], {
    repos: ["browser-relay"], permissions: { contents: "read", pull_requests: "read" }, opts: { fresh: true },
  });
});

test("postReview falls back to a body-only review on a 422", async () => {
  let first = true;
  const app = fakeApp(() => {
    if (first) { first = false; return Object.assign(new Error("unprocessable"), { status: 422 }); }
    return {};
  });
  const out = await createEffects({}, { app }).postReview("TanksterAI/x", 3, {
    commitId: "a".repeat(40), body: "B", comments: [{ path: "a.js", line: 2, body: "fix\nthis" }],
  });
  assert.equal(out.inline, 0);
  const second = app.log.calls[1].body;
  assert.equal(second.commit_id, undefined);
  // Each comment's first line only.
  assert.match(second.body, /`a\.js:2`: fix$/);
});

test("postReview's fallback keeps a hostile path inside its code span", async () => {
  let first = true;
  const app = fakeApp(() => {
    if (first) { first = false; return Object.assign(new Error("unprocessable"), { status: 422 }); }
    return {};
  });
  await createEffects({}, { app }).postReview("TanksterAI/x", 3, {
    commitId: "a".repeat(40), body: "B", comments: [{ path: "x`@octocat <img src=//e/t.png>\n# h.js", line: 2, body: "t" }],
  });
  const line = app.log.calls[1].body.body.split("\n").find((l) => l.startsWith("- `"));
  assert.equal((line.match(/`/g) || []).length, 2);
  assert.doesNotMatch(line, /@[a-z]|<[a-z]/);
});
