// Test helpers: a real RSA key pair standing in for GitHub's OIDC signer, an
// in-memory KV and a scripted Workers AI binding.

export const OWNER_ID = "259206056";
export const AUDIENCE = "tankster-ai-review";
export const WORKFLOW = "TanksterAI/ai-review/.github/workflows/review.yml";
// The refs the deployed Worker trusts (wrangler.jsonc WORKFLOW_REFS).
export const WORKFLOW_REFS = [`${WORKFLOW}@refs/heads/main`, `${WORKFLOW}@refs/tags/v1`];

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function makeSigner(kid = "test-key") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig", alg: "RS256" };
  async function sign(claims, header = {}) {
    const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid, ...header })));
    const p = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }
  return { jwk, sign };
}

export function claimsAt(nowS, over = {}) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: AUDIENCE,
    iat: nowS - 10,
    nbf: nowS - 10,
    exp: nowS + 290,
    repository: "TanksterAI/browser-relay",
    repository_owner: "TanksterAI",
    repository_owner_id: OWNER_ID,
    job_workflow_ref: `${WORKFLOW}@refs/tags/v1`,
    jti: crypto.randomUUID(),
    event_name: "pull_request",
    ...over,
  };
}

export function staticJwks(keys) {
  return { async get(kid) { const k = keys.find((x) => x.kid === kid); if (!k) throw new Error("no key"); return k; } };
}

export function memoryKv() {
  const m = new Map();
  return {
    map: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
  };
}

export function responsesResult(text, usage = { input_tokens: 1000, output_tokens: 500, neurons: 66 }) {
  return {
    object: "response",
    status: "completed",
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
    usage,
  };
}

export const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import { a } from './a.js';",
  "-const x = 1;",
  "+const x = 2;",
  "+const y = x / 0;",
  " ",
  " export { x };",
].join("\n");
