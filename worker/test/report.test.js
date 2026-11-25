// Errors to Sentry (src/report.js): what leaves is the error's name, a fixed label and its stack
// frames, never its message, and nothing at all without a DSN. This Worker reads other people's diffs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { PrState } from "../src/pr-state.js";
import { eventFor, framesOf, parseDsn, report, resetReportWindow } from "../src/report.js";

const DSN = "https://publickey123@o1.ingest.de.sentry.io/42";
const CANARY = {
  diff: "canary-diff-line-const-apiKey-7731",
  token: "canary-ghs-token-0123456789abcdef",
  repo: "canary-private-repo-name-4410",
  review: "canary-review-comment-text-2288",
};
const message = `failed on ${CANARY.diff} ${CANARY.token} in ${CANARY.repo}: ${CANARY.review}`;

const sink = () => {
  const calls = [];
  return { calls, fetch: async (url, init) => void calls.push({ url, init }) };
};
const allText = (calls) => calls.map((c) => `${c.url}\n${JSON.stringify(c.init.headers)}\n${c.init.body}`).join("\n");
const noLeak = (text) => {
  for (const [k, v] of Object.entries(CANARY)) assert.ok(!text.includes(v), `leaked (${k})`);
};

beforeEach(() => resetReportWindow());

test("parseDsn takes an https DSN with a numeric project and nothing else", () => {
  assert.deepEqual(parseDsn(DSN), { key: "publickey123", host: "o1.ingest.de.sentry.io", project: "42" });
  for (const bad of [undefined, "", "not a url", "http://k@o1.ingest.de.sentry.io/42", "https://o1.ingest.de.sentry.io/42", "https://k@o1.ingest.de.sentry.io/abc"]) {
    assert.equal(parseDsn(bad), null, String(bad));
  }
});

test("an event holds the error's name, a fixed label and frames, never its message", () => {
  const e = new TypeError(message);
  const ev = eventFor({}, e, "fetch");
  assert.equal(ev.exception.values[0].type, "TypeError");
  assert.equal(ev.exception.values[0].value, "TypeError in fetch");
  assert.ok(ev.exception.values[0].stacktrace.frames.length > 0, "frames kept");
  noLeak(JSON.stringify(ev));
});

test("a hostile name or label is replaced, not sent", () => {
  const e = new Error("x");
  e.name = `Bad ${CANARY.diff}!`;
  const ev = eventFor({}, e, `where ${CANARY.review}`);
  assert.equal(ev.exception.values[0].type, "Error");
  assert.equal(ev.tags.where, "worker");
  noLeak(JSON.stringify(ev));
  assert.equal(eventFor({}, "a string " + CANARY.diff, "fetch").exception.values[0].type, "Error");
});

test("frames carry a function, a repository path, a line and a column only", () => {
  const e = new Error("m");
  e.stack = `Error: ${message}\n    at handle (file:///opt/build/worker/src/index.js?v=${CANARY.token}:10:5)\n    at async Object.fetch (/x/node_modules/pkg/a.js:3:9)\n    at ${CANARY.review}`;
  const frames = framesOf(e);
  assert.deepEqual(frames.map((f) => [f.function, f.filename, f.lineno, f.colno, f.in_app]), [
    ["Object.fetch", "a.js", 3, 9, false],
    ["handle", "worker/src/index.js", 10, 5, true],
  ]);
  noLeak(JSON.stringify(frames));
});

test("with no DSN nothing is sent, and a bad DSN is ignored", async () => {
  const s = sink();
  await report({}, new Error(message), "fetch", { fetch: s.fetch });
  await report({ SENTRY_DSN: "nonsense" }, new Error(message), "fetch", { fetch: s.fetch });
  assert.equal(s.calls.length, 0);
});

test("with a DSN one envelope goes to the project's endpoint, without a word of the message", async () => {
  const s = sink();
  await report({ SENTRY_DSN: DSN, CF_VERSION_METADATA: { id: "ver-1" } }, new TypeError(message), "alarm", { fetch: s.fetch });
  assert.equal(s.calls.length, 1);
  const { url, init } = s.calls[0];
  assert.equal(url, "https://o1.ingest.de.sentry.io/api/42/envelope/");
  assert.match(init.headers["X-Sentry-Auth"], /sentry_key=publickey123/);
  const [header, item, payload] = init.body.trim().split("\n").map((l) => JSON.parse(l));
  assert.match(header.event_id, /^[0-9a-f]{32}$/);
  assert.equal(item.type, "event");
  assert.equal(payload.release, "ver-1");
  assert.equal(payload.tags.where, "alarm");
  noLeak(allText(s.calls));
});

test("reporting never throws, even when Sentry is down", async () => {
  await report({ SENTRY_DSN: DSN }, new Error(message), "fetch", { fetch: async () => { throw new Error(message); } });
});

test("at most ten events a minute", async () => {
  const s = sink();
  for (let i = 0; i < 25; i++) await report({ SENTRY_DSN: DSN }, new Error("x"), "fetch", { fetch: s.fetch, now: () => 1_000 });
  assert.equal(s.calls.length, 10);
});

// The wiring: a failure in the real handler or the Durable Object's alarm reaches report(), and the
// runtime still sees the original error.
const realFetch = globalThis.fetch;
const capture = () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response("{}"); };
  return calls;
};
const restore = () => { globalThis.fetch = realFetch; };
const brokenLedger = { get: async () => { throw new Error(message); }, put: async () => { throw new Error(message); } };

test("a failing request is reported and still thrown", async () => {
  const calls = capture();
  const waits = [];
  try {
    const request = new Request("https://ai-review.test/healthz");
    await assert.rejects(worker.fetch(request, { SENTRY_DSN: DSN, LEDGER: brokenLedger, AI: {} }, { waitUntil: (p) => waits.push(p) }), (e) => e.message === message);
    await Promise.all(waits);
    assert.equal(calls.length, 1);
    noLeak(allText(calls));
    assert.match(calls[0].init.body, /in fetch/);
  } finally { restore(); }
});

test("without a DSN a failing request is thrown and nothing is sent", async () => {
  const calls = capture();
  try {
    await assert.rejects(worker.fetch(new Request("https://ai-review.test/healthz"), { LEDGER: brokenLedger, AI: {} }, { waitUntil() {} }), (e) => e.message === message);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test("a failing alarm is reported and still thrown", async () => {
  const calls = capture();
  try {
    const ctx = { storage: { get: async () => { throw new Error(message); }, put: async () => {}, getAlarm: async () => null, setAlarm: async () => {} } };
    const pr = new PrState(ctx, { SENTRY_DSN: DSN });
    await assert.rejects(pr.alarm(), (e) => e.message === message);
    assert.equal(calls.length, 1);
    noLeak(allText(calls));
    assert.match(calls[0].init.body, /in alarm/);
  } finally { restore(); }
});
