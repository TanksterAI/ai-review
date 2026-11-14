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
  const kv = {
    map: m,
    // Every get and put, as Workers counts them (subrequests).
    ops: 0,
    async get(k) { kv.ops++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { kv.ops++; m.set(k, String(v)); },
  };
  return kv;
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

// PATCH's shape (lines 2 and 3 added, 1, 4 and 5 context) with lines that
// name things (total, ratio, loadStore), for tests that go through the
// grounding gate.
export const GROUNDED_PATCH = [
  "@@ -1,4 +1,5 @@",
  " import { loadStore } from './store.js';",
  "-const total = 1;",
  "+const total = 2;",
  "+const ratio = total / 0;",
  " ",
  " export { total };",
].join("\n");

// A Durable Object storage stand-in with the calls PrState uses.
export function memoryStorage() {
  const m = new Map();
  const s = {
    map: m,
    alarm: null,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) {
      if (Array.isArray(k)) { let n = 0; for (const x of k) n += m.delete(x) ? 1 : 0; return n; }
      return m.delete(k);
    },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort()); },
    async setAlarm(t) { s.alarm = t; },
    async getAlarm() { return s.alarm; },
  };
  return s;
}

// Fake GitHub side effects, recording every call.
export function fakeEffects({ writers = [] } = {}) {
  const calls = [];
  return {
    calls,
    async dispatch(jobId) { calls.push(["dispatch", jobId]); },
    async comment(repo, pr, body) { calls.push(["comment", repo, pr, body]); },
    async canWrite(repo, login) { calls.push(["canWrite", repo, login]); return writers.includes(login); },
    async cloneToken(repo) { calls.push(["cloneToken", repo]); return "ghs_clone"; },
    async postReview(repo, pr, review) { calls.push(["postReview", repo, pr, review]); return { inline: review.comments.length }; },
    prLinesMap: new Map(),
    async prLines(repo, pr, paths) { calls.push(["prLines", repo, pr, paths]); return this.prLinesMap; },
  };
}

// The findings a fake verifier was asked about, read back out of its input.
export function askedFindings(user) {
  const m = /<<<BEGIN FINDINGS (\w+)>>>\n([\s\S]*?)\n<<<END FINDINGS \1>>>/.exec(String(user));
  return m ? JSON.parse(m[2]) : [];
}

// A timer for tests: short waits (a retry pause) pass at once; a long one
// (the verifier's time budget) never runs out unless a test makes it.
export function testSleep(ms) {
  return ms >= 60_000 ? new Promise(() => {}) : Promise.resolve();
}
