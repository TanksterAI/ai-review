// What the reviewer has been taught, kept in D1 (free plan) and found with
// FTS5. A lesson is one short sentence about a repository, from one of two
// sources only: a maintainer's `learn` (the commenter's write access is
// re-checked through the API before it reaches here), or a bot's claim that
// the code confirmed. Never from anyone else, never from a model's own idea.
//
// Everything is optional: with no MEMORY binding, or a failing database,
// reviews run as before and say nothing was learned.

import { redact } from "./context.js";

export const MAX_LESSON_CHARS = 400;
export const MAX_PER_REPO = 200;
const SOURCES = new Set(["maintainer", "confirmed"]);

// Words to look for, from titles and file paths: letters and digits, three or
// more characters, each quoted so nothing in them is FTS syntax.
export function searchTerms(...texts) {
  const seen = new Set();
  for (const t of texts) {
    for (const w of String(t ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && w.length <= 30 && !STOP.has(w)) seen.add(w);
      if (seen.size >= 16) break;
    }
  }
  return [...seen];
}
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "src", "test", "tests", "index", "main", "add", "fix", "use", "new", "js", "ts", "md"]);

// One lesson as stored: one line, secrets redacted, bounded.
export function cleanLesson(text) {
  return redact(String(text ?? "")).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LESSON_CHARS);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function createMemory(db) {
  if (!db || typeof db.prepare !== "function") return null;
  const one = (sql, ...args) => db.prepare(sql).bind(...args);
  return {
    // {ok:true, id} | {ok:false, reason: "empty"|"duplicate"|"full"|"source"}
    async add({ repo, text, source, by, pr = null, now = new Date() }) {
      const clean = cleanLesson(text);
      if (!SOURCES.has(source)) return { ok: false, reason: "source" };
      if (clean.length < 8) return { ok: false, reason: "empty" };
      const rows = (await one("SELECT id, text FROM lessons WHERE repo = ?1", repo).all()).results ?? [];
      if (rows.some((r) => norm(r.text) === norm(clean))) return { ok: false, reason: "duplicate" };
      if (rows.length >= MAX_PER_REPO) return { ok: false, reason: "full" };
      const res = await one("INSERT INTO lessons (repo, text, source, by, pr, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", repo, clean, source, String(by).slice(0, 80), Number.isSafeInteger(pr) ? pr : null, now.toISOString()).run();
      return { ok: true, id: res.meta?.last_row_id ?? null, text: clean };
    },

    // The lessons most relevant to these words, best first; if none match, the
    // newest. Used lessons have their count raised, so the useful stay.
    async relevant({ repo, terms = [], limit = 8 }) {
      const q = terms.filter((t) => /^[a-z0-9]+$/.test(t)).slice(0, 16).map((t) => `"${t}"`).join(" OR ");
      let rows = [];
      if (q) {
        rows = (await one("SELECT l.id, l.text, l.source, l.by FROM lessons_fts f JOIN lessons l ON l.id = f.rowid WHERE lessons_fts MATCH ?1 AND l.repo = ?2 ORDER BY bm25(lessons_fts), l.hits DESC LIMIT ?3", q, repo, limit).all()).results ?? [];
      }
      if (rows.length < limit) {
        const have = new Set(rows.map((r) => r.id));
        const more = (await one("SELECT id, text, source, by FROM lessons WHERE repo = ?1 ORDER BY hits DESC, id DESC LIMIT ?2", repo, limit).all()).results ?? [];
        for (const r of more) if (rows.length < limit && !have.has(r.id)) rows.push(r);
      }
      if (rows.length) await db.batch(rows.map((r) => one("UPDATE lessons SET hits = hits + 1 WHERE id = ?1", r.id)));
      return rows.map((r) => ({ id: r.id, text: r.text, source: r.source, by: r.by }));
    },

    async list({ repo, limit = 30 }) {
      return ((await one("SELECT id, text, source, by, hits FROM lessons WHERE repo = ?1 ORDER BY id DESC LIMIT ?2", repo, limit).all()).results ?? []);
    },

    // Only this repository's own lessons can be forgotten from it.
    async forget({ repo, id }) {
      const res = await one("DELETE FROM lessons WHERE id = ?1 AND repo = ?2", id, repo).run();
      return (res.meta?.changes ?? 0) > 0;
    },
  };
}
