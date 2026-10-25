-- Additive Node/SQLite candidate. Apply the existing Studio domain migrations first.
-- Not a D1 deployment migration and not a scheduler.
CREATE TABLE IF NOT EXISTS native_subscription_fences (
  id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS native_subscriptions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
  arguments TEXT NOT NULL, url TEXT NOT NULL, sealed_secret TEXT NOT NULL,
  secret_hash TEXT NOT NULL, version INTEGER NOT NULL,
  verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1))
);
CREATE INDEX IF NOT EXISTS native_subscription_owner ON native_subscriptions(owner_id);
CREATE TABLE IF NOT EXISTS native_outbox (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES native_subscriptions(id),
  subscription_version INTEGER NOT NULL, mention_id TEXT NOT NULL REFERENCES mentions(id),
  event_id TEXT NOT NULL, event_name TEXT NOT NULL, body TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 8),
  state TEXT NOT NULL CHECK(state IN ('pending','leased','retry','delivered','terminal')),
  due_at INTEGER NOT NULL, lease_token TEXT, lease_expires_at INTEGER,
  result TEXT,
  UNIQUE(subscription_id, subscription_version, event_id)
);
CREATE INDEX IF NOT EXISTS native_outbox_due ON native_outbox(owner_id,state,due_at);
