// Errors to Sentry, without an SDK and without a dependency: this repository installs nothing, and
// the Worker reads other people's diffs, so what leaves is built here from a short allowlist.
//
// An event carries the error's NAME, where it happened (a fixed label) and its stack FRAMES (function
// name, file path inside this repository, line and column). Never the message: it can echo a diff, a
// review, a token or a repository name. No request, header, body, user or breadcrumb is ever added.
// Off unless SENTRY_DSN (a Worker secret) is set. Reporting never throws and never waits long.

const NAME = /^[A-Za-z][\w.]{0,60}$/;
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.*?):(\d+):(\d+)\)?\s*$/;
const FN = /^[A-Za-z_$][\w$.<>[\] ]{0,80}$/;
const WHERE = /^[a-z][a-z0-9:_-]{0,40}$/;
const SERVICE = "ai-review";
const MAX_FRAMES = 40;
const PER_MINUTE = 10;

export function parseDsn(dsn) {
  try {
    const u = new URL(String(dsn ?? "").trim());
    const project = u.pathname.split("/").filter(Boolean).pop();
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(project ?? "")) return null;
    return { key: u.username, host: u.host, project };
  } catch {
    return null;
  }
}

// A file as the bundle names it, cut to the part inside this repository.
function pathOf(file) {
  const clean = String(file).replace(/^file:\/\//, "").split(/[?#]/)[0];
  const at = clean.lastIndexOf("worker/");
  const tail = at >= 0 ? clean.slice(at) : clean.split("/").pop();
  return /^[\w./-]{1,120}$/.test(tail) ? tail : "<unknown>";
}

export function framesOf(e) {
  const stack = e instanceof Error && typeof e.stack === "string" ? e.stack.split("\n") : [];
  const frames = [];
  for (const line of stack) {
    const m = FRAME.exec(line);
    if (!m) continue;
    frames.push({ function: m[1] && FN.test(m[1]) ? m[1] : "?", filename: pathOf(m[2]), lineno: Number(m[3]), colno: Number(m[4]), in_app: !m[2].includes("node_modules") });
  }
  return frames.slice(0, MAX_FRAMES).reverse(); // Sentry wants the oldest call first.
}

export function eventFor(env, e, where, { now = Date.now, id = () => crypto.randomUUID().replaceAll("-", "") } = {}) {
  const name = e instanceof Error && NAME.test(e.name) ? e.name : "Error";
  const label = WHERE.test(where) ? where : "worker";
  return {
    event_id: id(),
    timestamp: now() / 1000,
    platform: "javascript",
    level: "error",
    environment: /^[a-z][a-z0-9_-]{0,30}$/.test(env?.SENTRY_ENVIRONMENT ?? "") ? env.SENTRY_ENVIRONMENT : "production",
    release: typeof env?.CF_VERSION_METADATA?.id === "string" ? env.CF_VERSION_METADATA.id : undefined,
    tags: { service: SERVICE, where: label },
    sdk: { name: "tankster.report", version: "1.0.0" },
    exception: { values: [{ type: name, value: `${name} in ${label}`, stacktrace: { frames: framesOf(e) } }] },
  };
}

let windowStart = 0;
let sentInWindow = 0;

/** Send one error. Resolves whatever happens; with no DSN it does nothing at all. */
export async function report(env, e, where, deps = {}) {
  try {
    const dsn = parseDsn(env?.SENTRY_DSN);
    if (!dsn) return;
    const now = deps.now ?? Date.now;
    if (now() - windowStart > 60_000) {
      windowStart = now();
      sentInWindow = 0;
    }
    if (++sentInWindow > PER_MINUTE) return;
    const event = eventFor(env, e, where, deps);
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date(now()).toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    const send = deps.fetch ?? ((...a) => fetch(...a));
    await send(`https://${dsn.host}/api/${dsn.project}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=tankster-report/1.0.0, sentry_key=${dsn.key}` },
      body,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Reporting a failure must never become one.
  }
}

/** Test hook: forget the rate window. */
export function resetReportWindow() {
  windowStart = 0;
  sentInWindow = 0;
}
