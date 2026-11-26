import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createGithubApp, pemToPkcs8, GithubAppError, TOKEN_TIMEOUT_MS } from "../src/github-app.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const NOW = 1_794_500_000_000;

function fakeGithub(over = {}) {
  const calls = [];
  async function fetcher(url, init) {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/orgs/TanksterAI/installation")) return Response.json({ id: 77 });
    if (url.includes("/access_tokens")) {
      return Response.json({ token: `ghs_${calls.length}`, expires_at: new Date(NOW + 3600_000).toISOString() }, { status: 201 });
    }
    return over[url] ?? new Response("nope", { status: 404 });
  }
  return { calls, fetcher };
}

function verifyJwt(jwt) {
  const [h, p, s] = jwt.split(".");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")), "signature verifies with the App's public key");
  return { header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(p, "base64url")) };
}

test("a PKCS#1 key as GitHub hands it out signs a valid App JWT", async () => {
  const app = createGithubApp({ appId: 5735981, privateKeyPem: privateKey, now: () => NOW });
  const { header, claims } = verifyJwt(await app.appJwt());
  assert.equal(header.alg, "RS256");
  assert.equal(claims.iss, "5735981");
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.equal(claims.exp - claims.iat, 600);
});

test("a PKCS#8 key and a key pasted with literal \\n both work", async () => {
  const { privateKey: p8 } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await createGithubApp({ appId: 1, privateKeyPem: p8 }).appJwt();
  const escaped = privateKey.replace(/\n/g, "\\n");
  verifyJwt(await createGithubApp({ appId: 1, privateKeyPem: escaped }).appJwt());
});

test("anything that is not a private key is refused", () => {
  for (const bad of ["", "ghs_token", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"]) {
    assert.throws(() => pemToPkcs8(bad), GithubAppError);
  }
  assert.throws(() => createGithubApp({ appId: 1 }), GithubAppError);
});

test("a fresh token is minted every time and never cached or served from the cache", async () => {
  // Two runs on one repository: the first revokes its token when it ends, so
  // the second must never be handed the same one.
  const gh = fakeGithub();
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: gh.fetcher, now: () => NOW });
  const cached = await app.installationToken(["browser-relay"], { contents: "read" });
  const a = await app.installationToken(["browser-relay"], { contents: "read" }, { fresh: true });
  const b = await app.installationToken(["browser-relay"], { contents: "read" }, { fresh: true });
  assert.notEqual(a, b);
  assert.notEqual(a, cached);
  assert.notEqual(b, cached);
  // The cached token is still the one served to cached callers.
  assert.equal(await app.installationToken(["browser-relay"], { contents: "read" }), cached);
  assert.equal(gh.calls.filter((c) => c.url.includes("/access_tokens")).length, 3);
});

test("installation tokens are scoped to named repos and permissions, and cached", async () => {
  const gh = fakeGithub();
  let t = NOW;
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: gh.fetcher, now: () => t });
  const a = await app.installationToken(["browser-relay"], { contents: "read" });
  const b = await app.installationToken(["browser-relay"], { contents: "read" });
  assert.equal(a, b);
  const mint = gh.calls.filter((c) => c.url.includes("/access_tokens"));
  assert.equal(mint.length, 1);
  assert.equal(mint[0].url, "https://api.github.com/app/installations/77/access_tokens");
  assert.deepEqual(mint[0].body, { repositories: ["browser-relay"], permissions: { contents: "read" } });
  verifyJwt(mint[0].init.headers.authorization.slice(7));

  // Different scope: a new token. Near expiry: a new token.
  await app.installationToken(["browser-relay"], { pull_requests: "write" });
  t = NOW + 56 * 60_000;
  await app.installationToken(["browser-relay"], { contents: "read" });
  assert.equal(gh.calls.filter((c) => c.url.includes("/access_tokens")).length, 3);
  // The installation id is looked up once.
  assert.equal(gh.calls.filter((c) => c.url.endsWith("/installation")).length, 1);
});

test("tokens are never minted for the whole installation or odd names", async () => {
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: fakeGithub().fetcher });
  await assert.rejects(app.installationToken([], { contents: "read" }), GithubAppError);
  await assert.rejects(app.installationToken(["../x"], { contents: "read" }), GithubAppError);
  await assert.rejects(app.installationToken(["TanksterAI/x"], { contents: "read" }), GithubAppError);
});

test("GitHub errors surface with their status and no response body", async () => {
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: async () => new Response("secret detail", { status: 403 }) });
  await assert.rejects(app.installation(), (e) => e instanceof GithubAppError && e.status === 403 && !/secret/.test(e.message));
});

test("the App JWT is reused for 7 minutes, then re-signed", async () => {
  let t = NOW;
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, now: () => t });
  const a = await app.appJwt();
  t += 6 * 60_000;
  assert.equal(await app.appJwt(), a);
  t += 2 * 60_000;
  const b = await app.appJwt();
  assert.notEqual(b, a);
  verifyJwt(b);
});

// A call with a deadline is cut off when GitHub gives no answer: the abort reaches the fetcher as a signal, and the call throws an error with no status, which readers of optional context take for no answer.
const hangs = (log) => (url, init) => new Promise((_resolve, reject) => {
  log.push({ url, signal: init.signal });
  init.signal?.addEventListener("abort", () => reject(init.signal.reason));
});

test("a call with timeoutMs is aborted when GitHub gives no answer, and one without has no deadline of its own", async () => {
  const log = [];
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: hangs(log), now: () => NOW });
  // A timeout signal's own timer does not keep the process alive, so a timer of the test's own does, and makes a call that is never cut off fail at once and clearly.
  let giveUp;
  const never = new Promise((_resolve, reject) => { giveUp = setTimeout(() => reject(new Error("the call was never cut off")), 2000); });
  const at = Date.now();
  try {
    await Promise.race([assert.rejects(app.call("GET", "/repos/TanksterAI/x/git/trees/abc", { token: "t", timeoutMs: 30 }), (e) => e.name === "TimeoutError" && e.status === undefined), never]);
  } finally {
    clearTimeout(giveUp);
  }
  assert.ok(Date.now() - at < 2000, "it did not wait for GitHub");
  assert.ok(log[0].signal instanceof AbortSignal);
  // With no timeoutMs there is no signal at all.
  const seen = [];
  const quick = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: async (url, init) => { seen.push(init); return Response.json({}); }, now: () => NOW });
  await quick.call("GET", "/x", { token: "t" });
  assert.equal(seen[0].signal, undefined);
});

test("minting a token has a deadline too, so a hung mint is cut off", async () => {
  const seen = [];
  const app = createGithubApp({
    appId: 1, privateKeyPem: privateKey, now: () => NOW,
    fetcher: async (url, init) => {
      seen.push({ url, signal: init.signal });
      if (url.endsWith("/orgs/TanksterAI/installation")) return Response.json({ id: 77 });
      return Response.json({ token: "ghs_1", expires_at: new Date(NOW + 3600_000).toISOString() }, { status: 201 });
    },
  });
  await app.installationToken(["x"], { contents: "read" });
  // Both calls of a mint (finding the installation, then the token) carry a signal that is not yet aborted.
  assert.equal(seen.length, 2);
  for (const c of seen) { assert.ok(c.signal instanceof AbortSignal, c.url); assert.equal(c.signal.aborted, false); }
  assert.ok(TOKEN_TIMEOUT_MS > 0 && TOKEN_TIMEOUT_MS <= 60_000);
});

test("a call with maxBytes reads the answer as it arrives and stops at the limit, however much more is coming", async () => {
  const enc = new TextEncoder();
  // A body that hands out its parts one by one, and records how many were asked for and whether it was cancelled.
  const stream = (parts, headers = {}) => {
    const log = { pulled: 0, cancelled: false };
    const body = new ReadableStream({
      pull(ctrl) { if (log.pulled >= parts.length) return ctrl.close(); ctrl.enqueue(enc.encode(parts[log.pulled++])); },
      cancel() { log.cancelled = true; },
    });
    return { log, res: new Response(body, { headers }) };
  };
  const clientFor = (res) => createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: async () => res, now: () => NOW });
  // Under the limit the answer is the JSON, as without a limit.
  const small = stream(['{"a":"', "x".repeat(1000), '"}']);
  assert.deepEqual(await clientFor(small.res).call("GET", "/x", { token: "t", maxBytes: 5000 }), { a: "x".repeat(1000) });
  // A body of 100,000 bytes with a limit of 5,000: stopped and cancelled after a few parts, with an error marked tooLarge and no status.
  const big = stream(['{"a":"', ...Array.from({ length: 100 }, () => "x".repeat(1000)), '"}']);
  await assert.rejects(clientFor(big.res).call("GET", "/repos/TanksterAI/x/git/blobs/abc?q=1", { token: "t", maxBytes: 5000 }), (e) => e instanceof GithubAppError && e.tooLarge === true && e.status === undefined && !e.message.includes("?q=1"));
  assert.equal(big.log.cancelled, true);
  assert.ok(big.log.pulled < 20, `${big.log.pulled} parts were read of 102`);
  // An answer that declares more than the limit is not read at all.
  const declared = stream(['{"a":"1"}'], { "content-length": "50000000" });
  await assert.rejects(clientFor(declared.res).call("GET", "/x", { token: "t", maxBytes: 5000 }), (e) => e.tooLarge === true);
  assert.equal(declared.log.cancelled, true);
  assert.ok(declared.log.pulled <= 1);
  // A stand-in answer with no stream is read as text and held to the same limit.
  const plain = (text) => ({ ok: true, status: 200, headers: { get: () => null }, async text() { return text; } });
  assert.deepEqual(await clientFor(plain('{"b":2}')).call("GET", "/x", { token: "t", maxBytes: 100 }), { b: 2 });
  await assert.rejects(clientFor(plain(`{"b":"${"y".repeat(200)}"}`)).call("GET", "/x", { token: "t", maxBytes: 100 }), (e) => e.tooLarge === true);
  // No limit: read whole, as before. An error status and a 204 are as before too.
  assert.deepEqual(await clientFor(Response.json({ c: 3 })).call("GET", "/x", { token: "t" }), { c: 3 });
  assert.equal(await clientFor(new Response(null, { status: 204 })).call("DELETE", "/x", { token: "t", maxBytes: 100 }), null);
  await assert.rejects(clientFor(new Response("no", { status: 404 })).call("GET", "/x", { token: "t", maxBytes: 100 }), (e) => e.status === 404 && e.tooLarge === undefined);
});
