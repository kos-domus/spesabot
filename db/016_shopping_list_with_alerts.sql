-- =============================================================================
-- SPESABOT MIGRATION 016: Shopping list with offer-alert triggers
--
-- Replaces the original 001_schema.sql `shopping_lists` / `shopping_list_items`
-- tables (which referenced the unused `users` table) with versions wired to
-- `user_profiles` and extended for notification triggers.
--
-- Each authenticated user gets a single default list. Items reference canonical
-- `products` so a single list entry covers all chain SKUs. Each item has its
-- own optional `min_discount_pct` and `max_price` thresholds — when notify-
-- grocery-list runs, it sends a Telegram alert for any current offer matching
-- the product that satisfies the per-item thresholds.
-- =============================================================================

-- The legacy tables from 001_schema.sql were empty and FK'd to a `users` table
-- that the active auth flow never populated (we use `user_profiles` instead).
-- Drop in dependency order.
DROP TABLE IF EXISTS shopping_list_items;
DROP TABLE IF EXISTS shopping_lists;

CREATE TABLE shopping_lists (
  id              SERIAL PRIMARY KEY,
  user_profile_id INTEGER NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'Lista della spesa',
  is_default      BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One default list per user. Multiple lists per user are allowed but only one
-- is_default=true at a time; the API uses that as the implicit target.
CREATE UNIQUE INDEX idx_shopping_lists_default
  ON shopping_lists(user_profile_id) WHERE is_default = true;

CREATE INDEX idx_shopping_lists_user ON shopping_lists(user_profile_id);

CREATE TABLE shopping_list_items (
  id                SERIAL PRIMARY KEY,
  list_id           INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Notification triggers — both optional. NULL = don't gate on that axis.
  --   min_discount_pct: only notify when offer discount_pct >= this value
  --   max_price:        only notify when offer_price <= this value
  -- If both are set: AND. If both are NULL: notify on any active offer.
  min_discount_pct  INTEGER,
  max_price         NUMERIC(10,2),
  notify_enabled    BOOLEAN NOT NULL DEFAULT true,
  -- Optional free-form note for the user (e.g. "preferisco Mulino Bianco").
  notes             TEXT,
  -- Last time this item triggered any notification — for the user's UI to
  -- show "ultimo alert: 2 giorni fa". Per-offer dedup is in shopping_list_notifications.
  last_notified_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Same product can't appear twice in the same list.
  UNIQUE (list_id, product_id)
);

CREATE INDEX idx_sli_list ON shopping_list_items(list_id);
CREATE INDEX idx_sli_product ON shopping_list_items(product_id);
CREATE INDEX idx_sli_notify ON shopping_list_items(list_id) WHERE notify_enabled = true;

-- Dedup table mirroring `watch_notifications` — prevents re-sending the same
-- offer to the same list item across pipeline runs.
CREATE TABLE shopping_list_notifications (
  id                    SERIAL PRIMARY KEY,
  shopping_list_item_id INTEGER NOT NULL REFERENCES shopping_list_items(id) ON DELETE CASCADE,
  offer_id              INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shopping_list_item_id, offer_id)
);

CREATE INDEX idx_sln_item ON shopping_list_notifications(shopping_list_item_id);

-- Cap-100 enforcement at the DB level so a buggy / malicious client can't
-- balloon a list past sane limits. App layer also validates and shows a
-- friendly error before hitting this trigger.
CREATE OR REPLACE FUNCTION enforce_shopping_list_cap()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM shopping_list_items WHERE list_id = NEW.list_id) >= 100 THEN
    RAISE EXCEPTION 'shopping list cap of 100 items reached for list_id=%', NEW.list_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shopping_list_cap
  BEFORE INSERT ON shopping_list_items
  FOR EACH ROW
  EXECUTE FUNCTION enforce_shopping_list_cap();

-- Grants for the application role.
GRANT SELECT, INSERT, UPDATE, DELETE ON shopping_lists TO spesabot;
GRANT SELECT, INSERT, UPDATE, DELETE ON shopping_list_items TO spesabot;
GRANT SELECT, INSERT, UPDATE, DELETE ON shopping_list_notifications TO spesabot;
GRANT USAGE, SELECT ON SEQUENCE shopping_lists_id_seq TO spesabot;
GRANT USAGE, SELECT ON SEQUENCE shopping_list_items_id_seq TO spesabot;
GRANT USAGE, SELECT ON SEQUENCE shopping_list_notifications_id_seq TO spesabot;
