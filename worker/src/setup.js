// One-time setup of the GitHub App from a manifest, so that no person ever
// sees, copies or pastes its secrets.
//
//   GET /v1/setup/github-app            a page with one button. It POSTs the
//                                       App's manifest to GitHub with a
//                                       state that is valid for an hour.
//   GET /v1/setup/github-app/callback   GitHub sends back ?code&state. The
//                                       Worker swaps the code for the App's id,
//                                       slug, private key and webhook secret
//                                       (POST /app-manifests/{code}/conversions)
//                                       and keeps them in the AppSecrets Durable
//                                       Object, which only this Worker's code
//                                       can read.
//
// Guards: the state lasts 1 hour, until setup succeeds; the new App must belong to
// our organisation (numeric id); once an App is stored, setup is closed for
// good (re-opening needs a code change). Secrets are never returned in a
// response or written to a log.

const GITHUB = "https://github.com";
const API = "https://api.github.com";
const STATE_TTL_MS = 3600_000;
const MAX_STATES = 10;
const CACHE_MS = 5 * 60_000;
// The App's webhook and redirect always point here, whatever host served the
// setup page (a preview URL, http, a future custom domain): setup is refused
// anywhere else.
export const PUBLIC_ORIGIN = "https://tankster-ai-review.rishi-tank.workers.dev";

export const DEFAULT_SLUG = "tankster-ai-review";

export function manifest(origin) {
  return {
    name: "Tankster AI Review",
    url: "https://github.com/TanksterAI/ai-review",
    description: "Line-by-line AI pull request review for the TanksterAI organisation. Source: TanksterAI/ai-review (private).",
    public: false,
    hook_attributes: { url: `${origin}/v1/github/webhook`, active: true },
    redirect_url: `${origin}/v1/setup/github-app/callback`,
    // Only what P1 uses; later phases add to it, and GitHub asks the owner to
    // approve each addition.
    default_permissions: {
      metadata: "read",
      contents: "read",
      pull_requests: "write",
      issues: "read",
      actions: "write",
      // The "Tankster AI Review" commit status: success only when every
      // reviewable file of the pull request was covered (the merge gate).
      statuses: "write",
    },
    default_events: ["pull_request", "issue_comment", "pull_request_review_comment"],
  };
}

function hex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(status, title, body) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1b1f24;background:#fff}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:0;background:#1f6feb;color:#fff;cursor:pointer}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      // The only place this page may send anything is GitHub's App form.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

// The AppSecrets Durable Object: one instance ("github-app"). Reachable only
// through this Worker's binding; no route exposes its contents.
export class AppSecrets {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.now = deps.now ?? (() => Date.now());
  }

  async fetch(request) {
    const msg = await request.json();
    const s = this.ctx.storage;
    if (msg.op === "get") return Response.json({ app: (await s.get("app")) ?? null });
    if (msg.op === "configured") return Response.json({ configured: Boolean(await s.get("app")) });
    if (msg.op === "newState") {
      if (await s.get("app")) return Response.json({ error: "already set up" });
      // Expired states are dropped; at most MAX_STATES are outstanding, so
      // crawlers and link previews cannot fill the store.
      const all = await s.list({ prefix: "state:" });
      const expired = [...all].filter(([, until]) => until <= this.now()).map(([k]) => k);
      if (expired.length) await s.delete(expired.slice(0, 128));
      if (all.size - expired.length >= MAX_STATES) return Response.json({ error: "too many setup links outstanding; try again in an hour" });
      const state = hex(16);
      await s.put(`state:${state}`, this.now() + STATE_TTL_MS);
      return Response.json({ state });
    }
    // A state stays valid until setup succeeds, so a failed callback can be
    // retried from the same link within the hour.
    if (msg.op === "checkState") {
      const until = await s.get(`state:${String(msg.state ?? "")}`);
      return Response.json({ ok: Boolean(until && until > this.now()) });
    }
    if (msg.op === "store") {
      if (await s.get("app")) return Response.json({ error: "already set up" });
      await s.put("app", msg.app);
      const states = await s.list({ prefix: "state:" });
      await s.delete([...states.keys()].slice(0, 128));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown op" });
  }
}

async function ask(env, msg) {
  const stub = env.APP_SECRETS.get(env.APP_SECRETS.idFromName("github-app"));
  const res = await stub.fetch("https://app-secrets/", { method: "POST", body: JSON.stringify(msg) });
  return res.json();
}

let cache = null; // {at, value}

// The App's configuration: Worker secrets win if set, otherwise what the
// manifest flow stored. Cached in memory for five minutes.
export async function appConfig(env, { now = () => Date.now() } = {}) {
  if (env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET && env.GITHUB_APP_ID) {
    const slug = env.GITHUB_APP_SLUG || DEFAULT_SLUG;
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("GITHUB_APP_SLUG is not a valid App slug");
    return { appId: String(env.GITHUB_APP_ID), pem: env.GITHUB_APP_PRIVATE_KEY, webhookSecret: env.GITHUB_WEBHOOK_SECRET, slug };
  }
  if (cache && now() - cache.at < CACHE_MS) return cache.value;
  let value = null;
  if (env.APP_SECRETS) {
    const { app } = await ask(env, { op: "get" });
    if (app) value = { appId: String(app.id), pem: app.pem, webhookSecret: app.webhook_secret, slug: app.slug };
  }
  // Only a configured App is cached, so setup shows up within one request.
  if (value) cache = { at: now(), value };
  return value;
}

export function resetConfigCache() {
  cache = null;
}

function wrongOrigin(request) {
  return new URL(request.url).origin !== PUBLIC_ORIGIN
    ? page(400, "Setup refused", `<p>Open setup at <a href="${esc(PUBLIC_ORIGIN)}/v1/setup/github-app">${esc(PUBLIC_ORIGIN)}</a> only.</p>`)
    : null;
}

export async function handleSetupStart(request, env) {
  const wrong = wrongOrigin(request);
  if (wrong) return wrong;
  if (!env.APP_SECRETS) return page(503, "Setup unavailable", "<p>The AppSecrets store is not bound.</p>");
  const out = await ask(env, { op: "newState" });
  if (out.error === "already set up") return page(409, "Already set up", "<p>The GitHub App is already set up. Setup is closed.</p>");
  if (!out.state) return page(429, "Setup busy", `<p>${esc(out.error ?? "Try again later.")}</p>`);
  const origin = PUBLIC_ORIGIN;
  const action = `${GITHUB}/organizations/TanksterAI/settings/apps/new?state=${out.state}`;
  return page(200, "Create the Tankster AI Review GitHub App", `
<p>This creates the organisation's GitHub App from a manifest. GitHub hands its private key and webhook secret straight to this service, so no one sees or copies them.</p>
<form method="post" action="${esc(action)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest(origin)))}">
<button type="submit">Create the App on GitHub</button>
</form>
<p>The link is valid for an hour, until setup succeeds.</p>`);
}

export async function handleSetupCallback(request, env, deps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const wrong = wrongOrigin(request);
  if (wrong) return wrong;
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!env.APP_SECRETS) return page(503, "Setup unavailable", "<p>The AppSecrets store is not bound.</p>");
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(code) || !/^[0-9a-f]{32}$/.test(state)) return page(400, "Setup refused", "<p>Missing or malformed code or state.</p>");
  // Checked before converting, so a second tab or a reload never turns a code
  // into an App whose keys would have nowhere to go.
  if ((await ask(env, { op: "configured" })).configured) return page(409, "Already set up", "<p>The GitHub App is already set up. Nothing changed.</p>");
  if (!(await ask(env, { op: "checkState", state })).ok) return page(403, "Setup refused", "<p>This setup link has expired or is unknown. Start again from the setup page.</p>");

  let res;
  try {
    res = await fetcher(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tankster-ai-review" },
    });
  } catch {
    res = null;
  }
  if (!res?.ok) {
    return page(502, "Setup failed", `<p>GitHub did not convert the code (${res ? `HTTP ${res.status}` : "no response"}). Reload this page to try again within the hour. If GitHub says the code was already used, the App may exist without its keys: delete it under TanksterAI's settings, GitHub Apps, then start setup again.</p>`);
  }
  const app = await res.json();
  const orphan = (why) => {
    console.log(JSON.stringify({ svc: "ai-review", ev: "setup_refused", reason: why, app: app?.id ?? null }));
    const where = app?.slug && /^[a-z0-9-]+$/.test(String(app.slug))
      ? ` Delete it at <a href="${esc(`${GITHUB}/organizations/TanksterAI/settings/apps/${app.slug}/advanced`)}">its settings</a> if it is in TanksterAI.`
      : "";
    return page(403, "Setup refused", `<p>Nothing was stored (${esc(why)}). The App GitHub created (id ${esc(app?.id ?? "unknown")}) has no stored keys.${where}</p>`);
  };
  if (String(app?.owner?.id ?? "") !== String(env.OWNER_ID)) return orphan("not owned by the TanksterAI organisation");
  if (!app.id || !app.pem || !app.webhook_secret || !/^[a-z0-9-]+$/.test(String(app.slug))) return orphan("GitHub's answer was incomplete");
  // Only what is used: the client id and secret are not kept.
  const stored = await ask(env, {
    op: "store",
    app: { id: app.id, slug: app.slug, pem: app.pem, webhook_secret: app.webhook_secret, created_at: new Date().toISOString() },
  });
  if (!stored.ok) return orphan("an App was already stored");
  resetConfigCache();
  console.log(JSON.stringify({ svc: "ai-review", ev: "setup_done", app: app.id, slug: app.slug }));
  return page(200, "Tankster AI Review is set up", `
<p>App <strong>${esc(app.slug)}</strong> (id ${esc(app.id)}) is stored in this service's AppSecrets store. Its private key and webhook secret were never shown to anyone.</p>
<p>Next: <a href="${esc(`${GITHUB}/apps/${app.slug}/installations/new`)}">install it on TanksterAI</a>.</p>`);
}
