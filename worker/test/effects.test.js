import { test } from "node:test";
import assert from "node:assert/strict";
import { commentIdOf, createEffects, MARKER } from "../src/effects.js";

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

// --- the Worker's own review (review-run.js) --------------------------------

const err = (status) => Object.assign(new Error(`GitHub ${status}`), { status });

test("the review's reads use a read-only token for the one repository, and nothing else", async () => {
  const app = fakeApp((m, path) => (path.includes("/contents/") ? { type: "file", sha: "f".repeat(40) } : path.includes("/git/blobs/") ? { content: btoa("hi\n"), size: 3 } : []));
  const fx = createEffects({}, { app });
  await fx.pullRequest("TanksterAI/x", 7);
  await fx.listFiles("TanksterAI/x", 7, 2);
  await fx.compare("TanksterAI/x", "a".repeat(40), "b".repeat(40));
  const blob = await fx.blob("TanksterAI/x", "c".repeat(40));
  assert.equal(new TextDecoder().decode(blob.bytes), "hi\n");
  assert.equal(await fx.fileSha("TanksterAI/x", "dir/a b.js", "d".repeat(40)), "f".repeat(40));
  assert.ok(app.log.tokens.every((t) => t.repos.join() === "x" && JSON.stringify(t.permissions) === JSON.stringify({ contents: "read", pull_requests: "read" })));
  assert.deepEqual(app.log.calls.map((c) => [c.method, c.path]), [
    ["GET", "/repos/TanksterAI/x/pulls/7"],
    ["GET", "/repos/TanksterAI/x/pulls/7/files?per_page=100&page=2"],
    ["GET", `/repos/TanksterAI/x/compare/${"a".repeat(40)}...${"b".repeat(40)}?per_page=100`],
    ["GET", `/repos/TanksterAI/x/git/blobs/${"c".repeat(40)}`],
    ["GET", `/repos/TanksterAI/x/contents/dir/a%20b.js?ref=${"d".repeat(40)}`],
  ]);
});

test("reads refuse anything but commit ids, and a missing file or blob is null, not an error", async () => {
  const fx = createEffects({}, { app: fakeApp(() => err(404)) });
  await assert.rejects(fx.compare("TanksterAI/x", "main", "b".repeat(40)));
  await assert.rejects(fx.blob("TanksterAI/x", "../x"));
  await assert.rejects(fx.fileSha("TanksterAI/x", "a.js", "HEAD"));
  assert.equal(await fx.blob("TanksterAI/x", "c".repeat(40)), null);
  assert.equal(await fx.fileSha("TanksterAI/x", "a.js", "d".repeat(40)), null);
  // A directory at that path is not a file.
  assert.equal(await createEffects({}, { app: fakeApp(() => [{ type: "file" }]) }).fileSha("TanksterAI/x", "src", "d".repeat(40)), null);
  await assert.rejects(createEffects({}, { app: fakeApp(() => err(500)) }).blob("TanksterAI/x", "c".repeat(40)));
});

test("the commit status: a statuses:write token, the fixed context, a bounded description; false without the permission", async () => {
  const app = fakeApp(() => ({}));
  const fx = createEffects({}, { app });
  assert.equal(await fx.setStatus("TanksterAI/x", "e".repeat(40), "success", "x".repeat(300)), true);
  assert.deepEqual(app.log.tokens.at(-1).permissions, { statuses: "write" });
  const c = app.log.calls.at(-1);
  assert.equal(c.path, `/repos/TanksterAI/x/statuses/${"e".repeat(40)}`);
  assert.equal(c.body.context, "Tankster AI Review");
  assert.equal(c.body.description.length, 140);
  // The App without statuses:write: GitHub refuses the token.
  const denied = { ...fakeApp(), async installationToken() { throw err(422); } };
  assert.equal(await createEffects({}, { app: denied }).setStatus("TanksterAI/x", "e".repeat(40), "pending", "d"), false);
  assert.equal(await fx.setStatus("TanksterAI/x", "not-a-sha", "pending", "d"), false);
  await assert.rejects(fx.setStatus("Other/x", "e".repeat(40), "pending", "d"));
});

// --- decisions, threads and the summary comment (CodeRabbit parity) ---------

const SHA = "a".repeat(40);

test("postReview files the event it is given, also in its 422 fallback; COMMENT by default", async () => {
  let first = true;
  const app = fakeApp(() => {
    if (first) { first = false; return err(422); }
    return {};
  });
  const fx = createEffects({}, { app });
  await fx.postReview("TanksterAI/x", 3, { commitId: SHA, body: "B", comments: [{ path: "a.js", line: 2, body: "t" }], event: "REQUEST_CHANGES" });
  assert.equal(app.log.calls[0].body.event, "REQUEST_CHANGES");
  assert.equal(app.log.calls[1].body.event, "REQUEST_CHANGES");
  const plain = fakeApp(() => ({}));
  await createEffects({}, { app: plain }).postReview("TanksterAI/x", 3, { commitId: SHA, body: "B", comments: [] });
  assert.equal(plain.log.calls[0].body.event, "COMMENT");
  // Only the three review events GitHub knows.
  await assert.rejects(createEffects({}, { app: plain }).postReview("TanksterAI/x", 3, { commitId: SHA, body: "B", comments: [], event: "MERGE" }));
});

test("approve: an APPROVE review pinned to the commit it checked", async () => {
  const app = fakeApp(() => ({}));
  await createEffects({}, { app }).approve("TanksterAI/x", 3, { commitId: SHA, body: "ok" });
  assert.deepEqual(app.log.tokens[0], { repos: ["x"], permissions: { pull_requests: "write" } });
  assert.equal(app.log.calls[0].method, "POST");
  assert.equal(app.log.calls[0].path, "/repos/TanksterAI/x/pulls/3/reviews");
  assert.deepEqual(app.log.calls[0].body, { commit_id: SHA, event: "APPROVE", body: `${MARKER}\nok` });
  await assert.rejects(createEffects({}, { app }).approve("TanksterAI/x", 3, { commitId: "main", body: "ok" }));
  // No text: the marker alone, which shows nothing (CodeRabbit's approval).
  const quiet = fakeApp(() => ({}));
  await createEffects({}, { app: quiet }).approve("TanksterAI/x", 3, { commitId: SHA, body: "" });
  assert.equal(quiet.log.calls[0].body.body, MARKER);
});

test("dismissReview: withdraws one of the App's reviews; a refusal is false", async () => {
  const app = fakeApp(() => ({}));
  assert.equal(await createEffects({}, { app }).dismissReview("TanksterAI/x", 3, 77, "why"), true);
  assert.equal(app.log.calls[0].method, "PUT");
  assert.equal(app.log.calls[0].path, "/repos/TanksterAI/x/pulls/3/reviews/77/dismissals");
  assert.deepEqual(app.log.calls[0].body, { message: "why", event: "DISMISS" });
  for (const status of [422, 403]) assert.equal(await createEffects({}, { app: fakeApp(() => err(status)) }).dismissReview("TanksterAI/x", 3, 77, "why"), false);
  await assert.rejects(createEffects({}, { app: fakeApp(() => err(500)) }).dismissReview("TanksterAI/x", 3, 77, "why"));
  await assert.rejects(createEffects({}, { app }).dismissReview("TanksterAI/x", 3, "77", "why"));
});

test("reviewDecision: the App's own latest approving, change-requesting or dismissed review; comments do not count", async () => {
  const bot = { login: "tankster-ai-review[bot]", type: "Bot" };
  const page1 = [
    { user: bot, state: "CHANGES_REQUESTED", commit_id: "1".repeat(40) },
    ...Array.from({ length: 99 }, () => ({ user: { login: "rishitank", type: "User" }, state: "APPROVED", commit_id: "2".repeat(40) })),
  ];
  const page2 = [
    { user: bot, state: "APPROVED", commit_id: "3".repeat(40), id: 33 },
    { user: bot, state: "COMMENTED", commit_id: "4".repeat(40) },
    { user: { login: "tankster-ai-review[bot]", type: "User" }, state: "DISMISSED", commit_id: "5".repeat(40) },
  ];
  const app = fakeApp((m, path) => (path.endsWith("&page=1") ? page1 : page2));
  const d = await createEffects({}, { app }).reviewDecision("TanksterAI/x", 3, "tankster-ai-review[bot]");
  // With its id, so a stale approval can be dismissed, and the ids of every
  // approval of the App's that still stands (here only 33).
  assert.deepEqual(d, { state: "APPROVED", commitId: "3".repeat(40), id: 33, approvedIds: [33], truncated: false });
  assert.equal(app.log.calls.length, 2);
  const none = fakeApp(() => []);
  assert.equal(await createEffects({}, { app: none }).reviewDecision("TanksterAI/x", 3, "tankster-ai-review[bot]"), null);
});

test("reviewDecision: every standing approval of the App's, and a list too long to read whole is marked truncated", async () => {
  const bot = { login: "tankster-ai-review[bot]", type: "Bot" };
  const reviews = [
    { user: bot, state: "APPROVED", commit_id: "1".repeat(40), id: 11 },
    { user: bot, state: "DISMISSED", commit_id: "2".repeat(40), id: 22 },
    { user: bot, state: "APPROVED", commit_id: "3".repeat(40), id: 33 },
  ];
  const d = await createEffects({}, { app: fakeApp(() => reviews) }).reviewDecision("TanksterAI/x", 3, "tankster-ai-review[bot]");
  assert.deepEqual(d.approvedIds, [11, 33]);
  assert.equal(d.truncated, false);
  // Ten full pages: there may be more, so the answer is marked truncated.
  const full = Array.from({ length: 100 }, (_, i) => ({ user: bot, state: "APPROVED", commit_id: "4".repeat(40), id: i }));
  const t = await createEffects({}, { app: fakeApp(() => full) }).reviewDecision("TanksterAI/x", 3, "tankster-ai-review[bot]");
  assert.equal(t.truncated, true);
});

const thread = (over = {}) => ({
  id: "PRRT_1", isResolved: false, isOutdated: false, path: "a.js", line: 5, originalLine: 4,
  comments: { nodes: [{ fullDatabaseId: "4637412430", author: { login: "tankster-ai-review" }, body: "**Minor (bug): x**\n<sub>Potential issue · finding `fd6a7c0b`</sub>\n\nfix", diffHunk: "@@ -1 +1 @@\n+y", originalCommit: { oid: "1".repeat(40) } }] },
  ...over,
});

test("ownThreads: the App's own threads across pages, read through GraphQL with the finding id", async () => {
  const pages = [
    { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [thread(), thread({ id: "PRRT_2", comments: { nodes: [{ fullDatabaseId: "12", author: { login: "coderabbitai" }, body: "x", diffHunk: "", originalCommit: { oid: "1".repeat(40) } }] } })] } } } } },
    { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread({ id: "PRRT_3", isResolved: true, line: null, resolvedBy: { login: "rishitank" } })] } } } } },
  ];
  const app = fakeApp(() => pages.shift());
  const list = await createEffects({}, { app }).ownThreads("TanksterAI/x", 3, "tankster-ai-review");
  // Commit objects in GraphQL need contents:read too.
  assert.deepEqual(app.log.tokens[0], { repos: ["x"], permissions: { contents: "read", pull_requests: "write" } });
  assert.match(app.log.calls[0].body.query, /resolvedBy \{ login \}/);
  assert.equal(list[1].resolvedBy, "rishitank");
  assert.equal(list[0].resolvedBy, null);
  assert.equal(app.log.calls[0].path, "/graphql");
  assert.deepEqual(app.log.calls[0].body.variables, { owner: "TanksterAI", name: "x", pr: 3, after: null });
  assert.equal(app.log.calls[1].body.variables.after, "c1");
  assert.deepEqual(list.map((t) => [t.id, t.resolved, t.findingId, t.commentId, t.line, t.originalLine, t.originalCommit]), [
    ["PRRT_1", false, "fd6a7c0b", 4637412430, 5, 4, "1".repeat(40)],
    ["PRRT_3", true, "fd6a7c0b", 4637412430, null, 4, "1".repeat(40)],
  ]);
  // Ids past 2^31 come as fullDatabaseId, a string: read as a safe integer.
  assert.match(app.log.calls[0].body.query, /fullDatabaseId/);
});

test("commentIdOf: fullDatabaseId strings and old Ints; nothing else", () => {
  assert.equal(commentIdOf("4637412430"), 4637412430);
  assert.equal(commentIdOf(11), 11);
  for (const bad of [null, undefined, "", "12a", "-3", 0, -1, 1.5, "99999999999999999"]) assert.equal(commentIdOf(bad), null, String(bad));
});

test("GraphQL errors are errors, not empty answers", async () => {
  const app = fakeApp(() => ({ errors: [{ message: "Resource not accessible by integration" }] }));
  const fx = createEffects({}, { app });
  await assert.rejects(fx.ownThreads("TanksterAI/x", 3, "tankster-ai-review"), /GraphQL/);
  await assert.rejects(fx.resolveThread("TanksterAI/x", "PRRT_1"), /GraphQL/);
});

test("resolveThread and editReviewComment: one thread or comment of one repository", async () => {
  const app = fakeApp((m, path) => (path === "/graphql" ? { data: { resolveReviewThread: { thread: { isResolved: true } } } } : {}));
  const fx = createEffects({}, { app });
  assert.equal(await fx.resolveThread("TanksterAI/x", "PRRT_1"), true);
  assert.match(app.log.calls[0].body.query, /resolveReviewThread/);
  assert.deepEqual(app.log.calls[0].body.variables, { id: "PRRT_1" });
  await fx.editReviewComment("TanksterAI/x", 11, "new");
  assert.deepEqual(app.log.calls[1], { method: "PATCH", path: "/repos/TanksterAI/x/pulls/comments/11", token: "tok-x", body: { body: "new" } });
  await assert.rejects(fx.resolveThread("TanksterAI/x", "x\"} mutation"), /thread id/);
  await assert.rejects(fx.editReviewComment("TanksterAI/x", "11/../..", "x"));
});

test("upsertSummary: edits the summary comment in place, and posts a new one only when it is missing", async () => {
  const app = fakeApp((m, path) => {
    if (m === "PATCH" && path.endsWith("/comments/7")) return err(404);
    if (m === "POST") return { id: 8 };
    return { id: 9 };
  });
  const fx = createEffects({}, { app });
  assert.equal(await fx.upsertSummary("TanksterAI/x", 3, null, "S"), 8);
  assert.deepEqual(app.log.calls[0], { method: "POST", path: "/repos/TanksterAI/x/issues/3/comments", token: "tok-x", body: { body: `${MARKER}\nS` } });
  assert.equal(await fx.upsertSummary("TanksterAI/x", 3, 9, "S2"), 9);
  assert.deepEqual(app.log.calls[1], { method: "PATCH", path: "/repos/TanksterAI/x/issues/comments/9", token: "tok-x", body: { body: `${MARKER}\nS2` } });
  // Deleted by someone: a new one.
  assert.equal(await fx.upsertSummary("TanksterAI/x", 3, 7, "S3"), 8);
  assert.equal(app.log.calls.at(-1).method, "POST");
});

test("a 422 for the decision itself still posts the findings, as a comment; a refused approval is false, not an error", async () => {
  let n = 0;
  const app = fakeApp((m, path, opts) => {
    n++;
    if (opts.body.event !== "COMMENT") return err(422);
    return {};
  });
  await createEffects({}, { app }).postReview("TanksterAI/x", 3, { commitId: SHA, body: "B", comments: [{ path: "a.js", line: 2, body: "t" }], event: "REQUEST_CHANGES" });
  assert.deepEqual(app.log.calls.map((c) => c.body.event), ["REQUEST_CHANGES", "REQUEST_CHANGES", "COMMENT"]);
  assert.equal(await createEffects({}, { app }).approve("TanksterAI/x", 3, { commitId: SHA, body: "ok" }), false);
  const boom = fakeApp(() => err(500));
  await assert.rejects(createEffects({}, { app: boom }).approve("TanksterAI/x", 3, { commitId: SHA, body: "ok" }));
});

test("ownThreads never returns a partial list: past its page limit it fails", async () => {
  const page = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [] } } } } };
  const app = fakeApp(() => page);
  await assert.rejects(createEffects({}, { app }).ownThreads("TanksterAI/x", 3, "tankster-ai-review"), /too many review threads/);
  assert.equal(app.log.calls.length, 20);
});
