import { test } from "node:test";
import assert from "node:assert/strict";
import { createJwksCache, verifyGithubOidc, OidcError, JWKS_URL } from "../src/oidc.js";
import { makeSigner, claimsAt, staticJwks, AUDIENCE, OWNER_ID, WORKFLOW, WORKFLOW_REFS } from "./helpers.js";

const NOW = 1_794_500_000;
const signer = await makeSigner();
const opts = { audience: AUDIENCE, ownerId: OWNER_ID, workflowRefs: WORKFLOW_REFS, jwks: staticJwks([signer.jwk]), nowS: NOW };

async function rejects(token, reason, o = opts) {
  await assert.rejects(verifyGithubOidc(token, o), (e) => e instanceof OidcError && e.reason === reason);
}

test("accepts a valid token from our workflow", async () => {
  const c = await verifyGithubOidc(await signer.sign(claimsAt(NOW)), opts);
  assert.equal(c.repository, "TanksterAI/browser-relay");
});

test("accepts main, v1 and v1.x point tags, and an audience list", async () => {
  for (const ref of ["refs/heads/main", "refs/tags/v1", "refs/tags/v1.2.0"]) {
    await verifyGithubOidc(await signer.sign(claimsAt(NOW, { aud: ["other", AUDIENCE], job_workflow_ref: `${WORKFLOW}@${ref}` })), opts);
  }
});

test("refuses review.yml at unreleased refs", async () => {
  for (const ref of ["refs/heads/feature", "a".repeat(40), "refs/tags/v10", "refs/tags/v1-evil", "refs/heads/main-evil", "refs/pull/1/merge"]) {
    await rejects(await signer.sign(claimsAt(NOW, { job_workflow_ref: `${WORKFLOW}@${ref}` })), "wrong workflow");
  }
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
  await rejects(await signer.sign(claimsAt(NOW)), "verifier not configured", { ...opts, workflowRefs: [] });
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
  // A made-up kid forces a refetch at most once a minute.
  await assert.rejects(cache.get("zzz"), (e) => e.reason === "unknown signing key");
  assert.equal(calls, 2);
  t = 61 * 1000;
  await assert.rejects(cache.get("yyy"), (e) => e.reason === "unknown signing key");
  assert.equal(calls, 3);
  await assert.rejects(cache.get("xxx"), (e) => e.reason === "unknown signing key");
  assert.equal(calls, 3);
  t = 12 * 60 * 1000;
  await cache.get("a");
  assert.equal(calls, 4);
});

test("a failing key endpoint is an OidcError", async () => {
  const cache = createJwksCache(async () => ({ ok: false, status: 503 }));
  await assert.rejects(cache.get("a"), (e) => e instanceof OidcError);
});
