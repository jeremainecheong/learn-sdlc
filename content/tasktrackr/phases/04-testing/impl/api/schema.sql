-- TaskTrackr's whole data model: four entities and one join table.
--
-- Applied by api/db.py's init_db() the first time the database is opened, and
-- read by ops/selfcheck.py when it counts the tables.

CREATE TABLE lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL
);

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id      INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  priority     TEXT    NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('low','medium','high')),
  due_date     TEXT,                       -- ISO date, or NULL: never overdue
  status       TEXT    NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','done')),
  created_at   TEXT    NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_tasks_list   ON tasks(list_id);
CREATE INDEX idx_tasks_status ON tasks(status, due_date);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT    NOT NULL UNIQUE
);

CREATE TABLE task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
