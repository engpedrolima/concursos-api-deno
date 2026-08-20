CREATE TABLE exams (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE CHECK (trim(external_id) <> ''),
  organizer TEXT NOT NULL CHECK (trim(organizer) <> ''),
  year INTEGER NOT NULL CHECK (year >= 1900),
  role TEXT CHECK (role IS NULL OR trim(role) <> ''),
  subject TEXT CHECK (subject IS NULL OR trim(subject) <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX idx_exams_filters
  ON exams (organizer, year, role, subject);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  statement TEXT NOT NULL CHECK (trim(statement) <> ''),
  kind TEXT NOT NULL CHECK (trim(kind) <> ''),
  answer_label TEXT NOT NULL CHECK (trim(answer_label) <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX idx_questions_kind ON questions (kind);

CREATE TABLE alternatives (
  question_id INTEGER NOT NULL
    REFERENCES questions (id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (trim(label) <> ''),
  position INTEGER NOT NULL CHECK (position >= 0),
  text TEXT NOT NULL CHECK (trim(text) <> ''),
  PRIMARY KEY (question_id, label),
  UNIQUE (question_id, position)
) STRICT;

CREATE TABLE question_occurrences (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL
    REFERENCES questions (id) ON DELETE RESTRICT,
  exam_id INTEGER NOT NULL
    REFERENCES exams (id) ON DELETE RESTRICT,
  number INTEGER NOT NULL CHECK (number > 0),
  subject TEXT CHECK (subject IS NULL OR trim(subject) <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (exam_id, number)
) STRICT;

CREATE INDEX idx_question_occurrences_question
  ON question_occurrences (question_id);
CREATE INDEX idx_question_occurrences_exam_subject
  ON question_occurrences (exam_id, subject);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL
    REFERENCES exams (id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (trim(idempotency_key) <> ''),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  importer_version TEXT NOT NULL CHECK (trim(importer_version) <> ''),
  documents_json TEXT NOT NULL CHECK (json_valid(documents_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  rejected_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rejected_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX idx_import_batches_exam ON import_batches (exam_id);

CREATE TABLE import_occurrences (
  import_batch_id INTEGER NOT NULL
    REFERENCES import_batches (id) ON DELETE CASCADE,
  question_occurrence_id INTEGER NOT NULL
    REFERENCES question_occurrences (id) ON DELETE RESTRICT,
  PRIMARY KEY (import_batch_id, question_occurrence_id)
) STRICT;

CREATE INDEX idx_import_occurrences_occurrence
  ON import_occurrences (question_occurrence_id);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  question_occurrence_id INTEGER NOT NULL
    REFERENCES question_occurrences (id) ON DELETE RESTRICT,
  selected_label TEXT NOT NULL CHECK (trim(selected_label) <> ''),
  correct_label_snapshot TEXT NOT NULL CHECK (trim(correct_label_snapshot) <> ''),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  answered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (answered_at GLOB '????-??-??T??:??:??.???Z'),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)
) STRICT;

CREATE INDEX idx_attempts_occurrence_answered_at
  ON attempts (question_occurrence_id, answered_at);
