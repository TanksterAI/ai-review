import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createGithubApp, pemToPkcs8, GithubAppError } from "../src/github-app.js";

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

test("the App counts every request it sends to GitHub (Workers Free allows 50 an invocation)", async () => {
  const gh = fakeGithub();
  const app = createGithubApp({ appId: 1, privateKeyPem: privateKey, fetcher: gh.fetcher, now: () => NOW });
  assert.equal(app.subrequests(), 0);
  await app.installationToken(["browser-relay"], { contents: "read" });
  await app.installationToken(["browser-relay"], { contents: "read" }); // cached: no request
  assert.equal(app.subrequests(), gh.calls.length);
  assert.ok(gh.calls.length >= 2, "the installation lookup and the token");
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
