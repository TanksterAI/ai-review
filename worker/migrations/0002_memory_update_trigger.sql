-- Keep the search index right if a lesson's text is ever changed.
CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE OF text ON lessons BEGIN
  INSERT INTO lessons_fts (lessons_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO lessons_fts (rowid, text) VALUES (new.id, new.text);
END;
