-- =============================================================================
-- SPESABOT MIGRATION 007: Product watchlist for notifications
-- Registered users can watch products/categories and get Telegram alerts
-- when matching offers appear or drop below a price threshold.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_watches (
  id              SERIAL PRIMARY KEY,
  user_profile_id INTEGER NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  watch_type      TEXT NOT NULL CHECK (watch_type IN ('product', 'category', 'keyword')),
  query           TEXT NOT NULL,                -- product name, category tag, or keyword
  max_price       NUMERIC(10,2),                -- optional price threshold (notify only when below this)
  chain_filter    TEXT[] DEFAULT '{}',          -- optional: only these chain slugs
  store_filter    INTEGER[] DEFAULT '{}',       -- optional: only these store IDs
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_notified_at TIMESTAMPTZ,                 -- dedupe: don't re-notify for same offer
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watches_user ON user_watches(user_profile_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_watches_active ON user_watches(is_active, watch_type);

-- Track which offers have been notified to which watch, to avoid duplicates
CREATE TABLE IF NOT EXISTS watch_notifications (
  id          SERIAL PRIMARY KEY,
  watch_id    INTEGER NOT NULL REFERENCES user_watches(id) ON DELETE CASCADE,
  offer_id    INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(watch_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_notifs_watch ON watch_notifications(watch_id);

-- Grant permissions to the spesabot role
GRANT SELECT, INSERT, UPDATE, DELETE ON user_watches TO spesabot;
GRANT SELECT, INSERT, UPDATE, DELETE ON watch_notifications TO spesabot;
GRANT USAGE, SELECT ON SEQUENCE user_watches_id_seq TO spesabot;
GRANT USAGE, SELECT ON SEQUENCE watch_notifications_id_seq TO spesabot;
