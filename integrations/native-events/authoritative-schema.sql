-- Additive to the existing Studio migrations and native schema.sql.
-- This persists wake INTENT only. It does not register a Cloudflare alarm/queue.
CREATE TABLE IF NOT EXISTS native_source_events (
  mention_id TEXT PRIMARY KEY REFERENCES mentions(id),
  event_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  enqueued INTEGER NOT NULL DEFAULT 0 CHECK(enqueued IN (0,1))
);
CREATE TABLE IF NOT EXISTS native_wake_intent (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation INTEGER NOT NULL
);
