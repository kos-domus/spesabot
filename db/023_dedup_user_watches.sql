-- =============================================================================
-- SPESABOT MIGRATION 023: De-duplicate user_watches and enforce uniqueness
-- =============================================================================
-- Originally created via 007 with no uniqueness constraint, so the public
-- POST /api/watches endpoint and two distinct frontend entry points
-- (promptAddWatch + openInlineAlertPrompt) could produce duplicate rows for
-- the same (user, watch_type, query, chain_filter, store_filter). The dup
-- rows caused multiple Telegram notifications for a single matching offer.
--
-- This migration:
--   1. collapses existing duplicates (keeps the oldest row per logical key)
--   2. installs a UNIQUE index supporting case- and whitespace-insensitive
--      query matching ("Latte" == " latte ")
--
-- Combined with the upsert switch in /api/watches (ON CONFLICT DO UPDATE
-- SET max_price = EXCLUDED.max_price, is_active = true), the system becomes
-- idempotent: re-submitting the same alert refreshes its threshold instead
-- of stacking duplicates.

BEGIN;

-- Collapse duplicates. Logical key matches the unique index defined below.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_profile_id,
                        watch_type,
                        lower(trim(query)),
                        chain_filter,
                        store_filter
           ORDER BY created_at, id
         ) AS rn
  FROM user_watches
)
DELETE FROM user_watches
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Enforce uniqueness going forward. Functional index because we want
-- "Latte" / " latte " / "LATTE" to collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_watches_dedup
  ON user_watches (
    user_profile_id,
    watch_type,
    (lower(trim(query))),
    chain_filter,
    store_filter
  );

COMMIT;
