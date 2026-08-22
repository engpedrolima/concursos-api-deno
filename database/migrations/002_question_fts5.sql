CREATE VIRTUAL TABLE question_fts USING fts5(
  statement,
  content = 'questions',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO question_fts(question_fts) VALUES ('rebuild');

CREATE TRIGGER questions_fts_after_insert
AFTER INSERT ON questions BEGIN
  INSERT INTO question_fts(rowid, statement)
  VALUES (new.id, new.statement);
END;

CREATE TRIGGER questions_fts_after_delete
AFTER DELETE ON questions BEGIN
  INSERT INTO question_fts(question_fts, rowid, statement)
  VALUES ('delete', old.id, old.statement);
END;

CREATE TRIGGER questions_fts_after_update
AFTER UPDATE OF statement ON questions BEGIN
  INSERT INTO question_fts(question_fts, rowid, statement)
  VALUES ('delete', old.id, old.statement);
  INSERT INTO question_fts(rowid, statement)
  VALUES (new.id, new.statement);
END;
