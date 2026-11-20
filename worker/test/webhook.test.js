import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, normalise, prKey, BOT_LOGIN } from "../src/webhook.js";

const SECRET = "test-webhook-secret";
const sign = (body, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const enc = (s) => new TextEncoder().encode(s);
const OWNER_ID = "259206056";

const repository = { full_name: "TanksterAI/browser-relay", name: "browser-relay", private: true, owner: { id: 259206056 } };
const prPayload = (over = {}) => ({
  action: "opened",
  repository,
  sender: { login: "rishitank", type: "User" },
  pull_request: {
    number: 39,
    draft: false,
    user: { login: "rishitank", type: "User" },
    author_association: "OWNER",
    head: { sha: "a".repeat(40), ref: "feat/x", repo: { full_name: "TanksterAI/browser-relay" } },
    base: { sha: "b".repeat(40) },
  },
  ...over,
});

test("signatures: valid, wrong secret, tampered, missing, malformed", async () => {
  const body = JSON.stringify(prPayload());
  assert.equal(await verifySignature(SECRET, enc(body), sign(body)), true);
  assert.equal(await verifySignature(SECRET, enc(body), sign(body, "other")), false);
  assert.equal(await verifySignature(SECRET, enc(`${body} `), sign(body)), false);
  for (const h of [null, "", "sha1=abc", "sha256=xyz", `sha256=${"0".repeat(63)}`]) {
    assert.equal(await verifySignature(SECRET, enc(body), h), false, String(h));
  }
  assert.equal(await verifySignature("", enc(body), sign(body, "")), false, "no secret, no trust");
});

test("pull_request events become review or closed", () => {
  for (const action of ["opened", "reopened", "ready_for_review", "synchronize", "converted_to_draft"]) {
    const ev = normalise("pull_request", prPayload({ action }), { ownerId: OWNER_ID });
    assert.equal(ev.kind, "review");
    assert.equal(ev.pr, 39);
    assert.equal(ev.fork, false);
    assert.equal(ev.author.association, "OWNER");
  }
  assert.equal(normalise("pull_request", prPayload({ action: "closed" }), { ownerId: OWNER_ID }).kind, "closed");
  assert.equal(normalise("pull_request", prPayload({ action: "labeled" }), { ownerId: OWNER_ID }), null);
  const fork = prPayload();
  fork.pull_request.head.repo.full_name = "someone/browser-relay";
  assert.equal(normalise("pull_request", fork, { ownerId: OWNER_ID }).fork, true);
});

test("other organisations and malformed payloads are ignored", () => {
  const other = prPayload({ repository: { ...repository, owner: { id: 1 } } });
  assert.equal(normalise("pull_request", other, { ownerId: OWNER_ID }), null);
  assert.equal(normalise("pull_request", null, { ownerId: OWNER_ID }), null);
  assert.equal(normalise("pull_request", { action: "opened", repository }, { ownerId: OWNER_ID }), null);
  assert.equal(normalise("push", { repository }, { ownerId: OWNER_ID }), null);
});

const commentPayload = (body, over = {}) => ({
  action: "created",
  repository,
  sender: { login: "rishitank", type: "User" },
  issue: { number: 39, pull_request: { url: "x" } },
  comment: { id: 5, body, author_association: "OWNER" },
  ...over,
});

test("a mention in a PR comment is a command; elsewhere it is not", () => {
  const ev = normalise("issue_comment", commentPayload("@tankster-ai-review pause"), { ownerId: OWNER_ID });
  assert.equal(ev.kind, "command");
  assert.equal(ev.where, "conversation");
  assert.equal(ev.maybeWriter, true);
  // No mention, a longer name, an issue that is not a PR, an edit: ignored.
  for (const [p] of [
    [commentPayload("please pause")],
    [commentPayload("@tankster-ai-reviewer pause")],
    [commentPayload("@tankster-ai-review pause", { issue: { number: 3 } })],
    [commentPayload("@tankster-ai-review pause", { action: "edited" })],
  ]) assert.equal(normalise("issue_comment", p, { ownerId: OWNER_ID }), null);
  // A thread reply on a review comment.
  const thread = normalise("pull_request_review_comment", {
    action: "created",
    repository,
    sender: { login: "rishitank", type: "User" },
    pull_request: { number: 39 },
    comment: { id: 9, in_reply_to_id: 8, body: "@tankster-ai-review why?", author_association: "MEMBER" },
  }, { ownerId: OWNER_ID });
  assert.equal(thread.where, "thread");
  assert.equal(thread.inReplyTo, 8);
});

test("bots, including this one, never command it", () => {
  const bot = commentPayload("@tankster-ai-review review", { sender: { login: "renovate[bot]", type: "Bot" } });
  assert.equal(normalise("issue_comment", bot, { ownerId: OWNER_ID }), null);
  const self = commentPayload("@tankster-ai-review review", { sender: { login: BOT_LOGIN, type: "User" } });
  assert.equal(normalise("issue_comment", self, { ownerId: OWNER_ID }), null);
});

test("an outsider's association is passed on as a hint only", () => {
  const p = commentPayload("@tankster-ai-review review");
  p.comment.author_association = "CONTRIBUTOR";
  assert.equal(normalise("issue_comment", p, { ownerId: OWNER_ID }).maybeWriter, false);
});

test("prKey", () => assert.equal(prKey("TanksterAI/x", 3), "TanksterAI/x#3"));

// pull_request_review_thread: only the App's own threads, and never its own doing.
test("a resolved or reopened thread of the App's own is an event; anyone else's, or the App's own resolving, is not", () => {
  const base = (over = {}) => ({
    action: "resolved",
    repository: { full_name: "TanksterAI/x", name: "x", owner: { id: 259206056 } },
    sender: { login: "rishitank", type: "User" },
    pull_request: { number: 7 },
    thread: { node_id: "PRRT_1", comments: [{ user: { login: "tankster-ai-review[bot]", type: "Bot" } }] },
    ...over,
  });
  const ev = normalise("pull_request_review_thread", base(), { ownerId: "259206056" });
  assert.deepEqual(ev, { kind: "thread", action: "resolved", repo: { full: "TanksterAI/x", name: "x", ownerId: "259206056", private: false }, pr: 7, sender: { login: "rishitank", bot: false }, threadId: "PRRT_1" });
  assert.equal(normalise("pull_request_review_thread", base({ action: "unresolved" }), { ownerId: "259206056" }).action, "unresolved");
  assert.equal(normalise("pull_request_review_thread", base({ thread: { node_id: "PRRT_2", comments: [{ user: { login: "coderabbitai[bot]", type: "Bot" } }] } }), { ownerId: "259206056" }), null);
  assert.equal(normalise("pull_request_review_thread", base({ sender: { login: "tankster-ai-review[bot]", type: "Bot" } }), { ownerId: "259206056" }), null);
  assert.equal(normalise("pull_request_review_thread", base({ action: "edited" }), { ownerId: "259206056" }), null);
  assert.equal(normalise("pull_request_review_thread", base({ pull_request: {} }), { ownerId: "259206056" }), null);
  // Another slug: its own login.
  const other = base({ thread: { node_id: "PRRT_1", comments: [{ user: { login: "my-app[bot]", type: "Bot" } }] } });
  assert.equal(normalise("pull_request_review_thread", other, { ownerId: "259206056", slug: "my-app" }).kind, "thread");
});

test("a body cut at 8,000 characters keeps a visible mark, so a whole-comment command in it is never the whole comment", async () => {
  const { parseCommand } = await import("../src/pr-state.js");
  const long = `@tankster-ai-review approve${"\n".repeat(9000)}and more`;
  const ev = normalise("issue_comment", commentPayload(long), { ownerId: OWNER_ID });
  assert.equal(parseCommand(ev.text), null);
  assert.equal(parseCommand(normalise("issue_comment", commentPayload("@tankster-ai-review approve"), { ownerId: OWNER_ID }).text), "approve");
});
