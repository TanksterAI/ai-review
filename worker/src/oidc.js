// Verifies a GitHub Actions OIDC token (RS256 JWT) with WebCrypto.
//
// This is the only authentication the review endpoint has, and it needs no
// secret: GitHub signs a short-lived token for the job, and we check the
// signature against GitHub's published keys plus the claims that pin the call
// to this organisation and to our own reusable workflow.

export const ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;

// Clock skew allowed on exp/nbf/iat, in seconds.
const SKEW_S = 60;
// Longest token lifetime we accept (GitHub issues them for minutes).
const MAX_LIFETIME_S = 60 * 60;
// How long a fetched key set is trusted before it is fetched again.
const JWKS_TTL_MS = 10 * 60 * 1000;
// An unknown kid forces a refetch at most this often, so unauthenticated
// requests with made-up kids cannot make us hammer GitHub.
const FORCED_REFETCH_MS = 60 * 1000;

export class OidcError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "OidcError";
    this.reason = reason;
  }
}

function b64urlToBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new OidcError("malformed token");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError("malformed token");
  }
}

// A small key cache shared by requests in the same isolate. A miss on the
// kid forces one refetch (at most once a minute), so a key rotation is picked
// up at once.
export function createJwksCache(fetcher = (url) => fetch(url), now = () => Date.now()) {
  let keys = null;
  let fetchedAt = 0;
  let lastForced = -Infinity;
  async function load() {
    const res = await fetcher(JWKS_URL);
    if (!res.ok) throw new OidcError(`jwks fetch failed (${res.status})`);
    const body = await res.json();
    if (!body || !Array.isArray(body.keys)) throw new OidcError("jwks malformed");
    keys = body.keys;
    fetchedAt = now();
  }
  return {
    async get(kid) {
      if (!keys || now() - fetchedAt > JWKS_TTL_MS) await load();
      let jwk = keys.find((k) => k.kid === kid);
      if (!jwk && now() - lastForced > FORCED_REFETCH_MS) {
        lastForced = now();
        await load();
        jwk = keys.find((k) => k.kid === kid);
      }
      if (!jwk) throw new OidcError("unknown signing key");
      return jwk;
    },
  };
}

/**
 * @param {string} token
 * @param {{audience: string, ownerId: string, workflowRefs: string[],
 *          jwks: {get(kid: string): Promise<JsonWebKey>}, nowS?: number}} opts
 * @returns {Promise<Record<string, unknown>>} the verified claims
 */
export async function verifyGithubOidc(token, opts) {
  const { audience, ownerId, workflowRefs, jwks } = opts;
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (!audience || !ownerId || !Array.isArray(workflowRefs) || workflowRefs.length === 0) {
    throw new OidcError("verifier not configured");
  }
  if (typeof token !== "string") throw new OidcError("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("malformed token");
  const [h, p, s] = parts;
  const header = decodeJson(h);
  // Decoded now so a malformed token fails as malformed; nothing in it is
  // trusted until the signature below checks out.
  const c = decodeJson(p);
  if (header.alg !== "RS256") throw new OidcError("unsupported alg");
  if (typeof header.kid !== "string") throw new OidcError("missing kid");

  const jwk = await jwks.get(header.kid);
  if (jwk.kty !== "RSA") throw new OidcError("unexpected key type");
  let key;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new OidcError("bad signing key");
  }
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new OidcError("bad signature");

  if (c.iss !== ISSUER) throw new OidcError("wrong issuer");
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(audience)) throw new OidcError("wrong audience");
  if (typeof c.exp !== "number" || c.exp + SKEW_S < nowS) throw new OidcError("expired");
  if (typeof c.nbf === "number" && c.nbf - SKEW_S > nowS) throw new OidcError("not yet valid");
  if (typeof c.iat !== "number" || c.iat - SKEW_S > nowS) throw new OidcError("bad iat");
  if (c.exp - c.iat > MAX_LIFETIME_S) throw new OidcError("lifetime too long");
  // The numeric id, not the login: a renamed or re-registered login cannot
  // take over the trust.
  if (String(c.repository_owner_id) !== String(ownerId)) throw new OidcError("wrong owner");
  if (typeof c.repository !== "string" || !c.repository.includes("/")) throw new OidcError("missing repository");
  // Only our reusable workflow, at a released ref, may call: a job that
  // writes its own curl, or calls review.yml from an unmerged branch or an
  // arbitrary commit, gets a job_workflow_ref that is not on the list. An
  // entry ending in "*" matches that prefix (refs/tags/v1.* for point tags).
  const ref = c.job_workflow_ref;
  const allowed = typeof ref === "string" && workflowRefs.some((w) =>
    w.endsWith("*") ? ref.startsWith(w.slice(0, -1)) : ref === w);
  if (!allowed) throw new OidcError("wrong workflow");
  return c;
}
