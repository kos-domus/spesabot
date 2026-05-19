-- =============================================================================
-- SPESABOT MIGRATION 008: Analytics events
-- Lightweight, privacy-preserving event tracking for usage metrics.
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,      -- 'app_open', 'search', 'screen_view', 'click', 'bot_start', etc.
  session_id    TEXT,               -- anonymous session ID from client (localStorage)
  telegram_user_id TEXT,            -- if signed in via Telegram initData
  metadata      JSONB DEFAULT '{}', -- free-form event payload (query text, screen name, chain slug, etc.)
  ip_hash       TEXT,               -- SHA-256 hash of IP (for rough uniqueness without storing IP)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_type_time ON api_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON api_events(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_user ON api_events(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_metadata ON api_events USING GIN(metadata);

GRANT SELECT, INSERT ON api_events TO spesabot;
GRANT USAGE, SELECT ON SEQUENCE api_events_id_seq TO spesabot;

-- Summary view for quick dashboard queries
CREATE OR REPLACE VIEW analytics_summary AS
SELECT
  DATE(created_at) as day,
  event_type,
  COUNT(*) as events,
  COUNT(DISTINCT session_id) as unique_sessions,
  COUNT(DISTINCT telegram_user_id) as unique_users,
  COUNT(DISTINCT ip_hash) as unique_ips
FROM api_events
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(created_at), event_type
ORDER BY day DESC, events DESC;

GRANT SELECT ON analytics_summary TO spesabot;
