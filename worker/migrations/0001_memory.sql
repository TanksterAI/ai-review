-- What the reviewer has been taught. D1 (free plan), searched with FTS5.
-- Only a maintainer's `learn`, or a bot's claim the code confirmed, lands here.
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('maintainer', 'confirmed')),
  by TEXT NOT NULL,
  pr INTEGER,
  created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lessons_repo ON lessons (repo, id);
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(text, content = 'lessons', content_rowid = 'id', tokenize = 'porter unicode61');
CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts (lessons_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
