CREATE TABLE IF NOT EXISTS action_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  action    TEXT    NOT NULL,
  data      TEXT    NOT NULL,
  node_id   TEXT    NOT NULL
);
