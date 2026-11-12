import { test } from "node:test";
import assert from "node:assert/strict";
import { createJwksCache, verifyGithubOidc, OidcError, JWKS_URL } from "../src/oidc.js";
import { makeSigner, claimsAt, staticJwks, AUDIENCE, OWNER_ID, WORKFLOW_PREFIX } from "./helpers.js";

const NOW = 1_794_500_000;
const signer = await makeSigner();
const opts = { audience: AUDIENCE, ownerId: OWNER_ID, workflowPrefix: WORKFLOW_PREFIX, jwks: staticJwks([signer.jwk]), nowS: NOW };

async function rejects(token, reason, o = opts) {
  await assert.rejects(verifyGithubOidc(token, o), (e) => e instanceof OidcError && e.reason === reason);
}

test("accepts a valid token from our workflow", async () => {
  const c = await verifyGithubOidc(await signer.sign(claimsAt(NOW)), opts);
  assert.equal(c.repository, "TanksterAI/browser-relay");
});

test("accepts a SHA-pinned workflow ref and an audience list", async () => {
  const t = await signer.sign(claimsAt(NOW, { aud: ["other", AUDIENCE], job_workflow_ref: `${WORKFLOW_PREFIX}${"a".repeat(40)}` }));
  await verifyGithubOidc(t, opts);
});

test("rejects other audiences, owners, workflows and issuers", async () => {
  await rejects(await signer.sign(claimsAt(NOW, { aud: "sts.amazonaws.com" })), "wrong audience");
  await rejects(await signer.sign(claimsAt(NOW, { repository_owner_id: "1" })), "wrong owner");
  // Same login, different id: a renamed or squatted organisation.
  await rejects(await signer.sign(claimsAt(NOW, { repository_owner: "TanksterAI", repository_owner_id: "999" })), "wrong owner");
  await rejects(await signer.sign(claimsAt(NOW, { job_workflow_ref: "TanksterAI/browser-relay/.github/workflows/evil.yml@refs/heads/main" })), "wrong workflow");
  // A prefix trick: another repository whose name starts with ours.
  await rejects(await signer.sign(claimsAt(NOW, { job_workflow_ref: "TanksterAI/ai-review-fork/.github/workflows/review.yml@x" })), "wrong workflow");
  await rejects(await signer.sign(claimsAt(NOW, { job_workflow_ref: undefined })), "wrong workflow");
  await rejects(await signer.sign(claimsAt(NOW, { iss: "https://evil.example" })), "wrong issuer");
});

test("rejects expired, future and over-long tokens", async () => {
  await rejects(await signer.sign(claimsAt(NOW, { exp: NOW - 120 })), "expired");
  await rejects(await signer.sign(claimsAt(NOW, { nbf: NOW + 600 })), "not yet valid");
  await rejects(await signer.sign(claimsAt(NOW, { iat: NOW + 600, nbf: undefined })), "bad iat");
  await rejects(await signer.sign(claimsAt(NOW, { iat: NOW - 10, exp: NOW + 7200 })), "lifetime too long");
});

test("rejects bad signatures, other keys and other algorithms", async () => {
  const good = await signer.sign(claimsAt(NOW));
  const [h, p, s] = good.split(".");
  const tampered = `${h}.${Buffer.from(JSON.stringify(claimsAt(NOW, { repository: "TanksterAI/x" }))).toString("base64url")}.${s}`;
  await rejects(tampered, "bad signature");
  const other = await makeSigner("test-key");
  await rejects(await other.sign(claimsAt(NOW)), "bad signature");
  await rejects(await signer.sign(claimsAt(NOW), { alg: "none" }), "unsupported alg");
  await rejects(await signer.sign(claimsAt(NOW), { alg: "HS256" }), "unsupported alg");
  await rejects(`${h}.${p}`, "malformed token");
  await rejects("", "malformed token");
  await rejects(`${h}.!!!.${s}`, "malformed token");
});

test("refuses to run unconfigured", async () => {
  await rejects(await signer.sign(claimsAt(NOW)), "verifier not configured", { ...opts, ownerId: undefined });
});

test("the key cache refetches once on an unknown kid, and expires", async () => {
  let calls = 0;
  let keys = [];
  let t = 0;
  const cache = createJwksCache(async (url) => {
    assert.equal(url, JWKS_URL);
    calls++;
    return { ok: true, json: async () => ({ keys }) };
  }, () => t);
  keys = [{ kid: "a", kty: "RSA" }];
  assert.equal((await cache.get("a")).kid, "a");
  assert.equal(calls, 1);
  await cache.get("a");
  assert.equal(calls, 1);
  keys = [{ kid: "a", kty: "RSA" }, { kid: "b", kty: "RSA" }];
  assert.equal((await cache.get("b")).kid, "b");
  assert.equal(calls, 2);
  await assert.rejects(cache.get("zzz"), (e) => e.reason === "unknown signing key");
  t = 11 * 60 * 1000;
  await cache.get("a");
  assert.equal(calls, 4);
});

test("a failing key endpoint is an OidcError", async () => {
  const cache = createJwksCache(async () => ({ ok: false, status: 503 }));
  await assert.rejects(cache.get("a"), (e) => e instanceof OidcError);
});
