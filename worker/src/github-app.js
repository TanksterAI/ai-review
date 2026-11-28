// GitHub App authentication for the Tankster AI Review App.
//
// - The private key arrives as GitHub hands it out: PKCS#1 ("BEGIN RSA PRIVATE
//   KEY"). WebCrypto only imports PKCS#8, so the PKCS#1 DER is wrapped in a
//   PKCS#8 envelope here. A PKCS#8 key ("BEGIN PRIVATE KEY") is used as is.
// - App JWTs are RS256, issued 60 s in the past (clock skew), valid for
//   GitHub's maximum of 10 minutes, and reused for 7 (3 minutes of margin):
//   RSA signing is the costly part of 10 ms of CPU.
// - Installation tokens are always minted for named repositories and a named
//   subset of permissions, never for the whole installation, and cached until
//   five minutes before they expire. A token handed to someone else who will
//   revoke it (the runner deletes its token when its run ends) is minted fresh
//   and never cached: a shared one would be revoked under every other run for
//   the same repository.

const API = "https://api.github.com";
const UA = "tankster-ai-review";

export class GithubAppError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GithubAppError";
    this.status = status;
  }
}

function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function derLength(n) {
  if (n < 0x80) return [n];
  const out = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

function der(tag, content) {
  return [tag, ...derLength(content.length), ...content];
}

// rsaEncryption OID 1.2.840.113549.1.1.1 with NULL parameters.
const RSA_ALGORITHM_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

export function pkcs1ToPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const octets = der(0x04, Array.from(pkcs1));
  return new Uint8Array(der(0x30, [...version, ...RSA_ALGORITHM_ID, ...octets]));
}

export function pemToPkcs8(pem) {
  const text = String(pem ?? "").replace(/\\n/g, "\n").trim();
  const m = text.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/);
  if (!m || Boolean(m[1]) !== Boolean(m[3])) throw new GithubAppError("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const bin = atob(m[2].replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return m[1] ? pkcs1ToPkcs8(bytes) : bytes;
}

export function createGithubApp({ appId, privateKeyPem, fetcher = fetch, now = () => Date.now(), org = "TanksterAI" }) {
  if (!appId || !privateKeyPem) throw new GithubAppError("the GitHub App is not configured");
  let keyPromise;
  let installationId;
  let jwt = null; // {token, until}: reused for 7 of its 10 minutes
  const tokens = new Map();

  function key() {
    keyPromise ??= crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return keyPromise;
  }

  async function appJwt() {
    if (jwt && jwt.until > now()) return jwt.token;
    const iat = Math.floor(now() / 1000) - 60;
    const head = b64urlJson({ alg: "RS256", typ: "JWT" });
    const body = b64urlJson({ iat, exp: iat + 600, iss: String(appId) });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key(), new TextEncoder().encode(`${head}.${body}`));
    const token = `${head}.${body}.${b64urlBytes(new Uint8Array(sig))}`;
    jwt = { token, until: now() + 7 * 60_000 };
    return token;
  }

  // Requests sent so far (Workers Free allows 50 an invocation); a caller
  // takes the difference across its own work.
  let sent = 0;
  const subrequests = () => sent;

  async function call(method, path, { token, body } = {}) {
    sent++;
    const res = await fetcher(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GithubAppError(`GitHub ${method} ${path.split("?")[0]} failed: ${res.status}`, res.status);
    return res.status === 204 ? null : res.json();
  }

  async function installation() {
    installationId ??= (await call("GET", `/orgs/${org}/installation`, { token: await appJwt() })).id;
    return installationId;
  }

  // repos: bare repository names in the org. permissions: e.g. {contents: "read"}.
  // fresh: mint a new token and keep it out of the cache (see the top).
  async function installationToken(repos, permissions, { fresh = false } = {}) {
    const names = [...new Set(repos)].sort();
    if (!names.length || names.some((r) => !/^[A-Za-z0-9._-]+$/.test(r))) {
      throw new GithubAppError("installation tokens are only minted for named repositories");
    }
    const k = `${names.join(",")}|${JSON.stringify(Object.entries(permissions).sort())}`;
    const hit = fresh ? null : tokens.get(k);
    if (hit && hit.expires - 5 * 60_000 > now()) return hit.token;
    const out = await call("POST", `/app/installations/${await installation()}/access_tokens`, {
      token: await appJwt(),
      body: { repositories: names, permissions },
    });
    if (!fresh) tokens.set(k, { token: out.token, expires: Date.parse(out.expires_at) });
    return out.token;
  }

  return { appJwt, installation, installationToken, call, subrequests };
}
