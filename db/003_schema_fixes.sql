-- =============================================================================
-- SPESABOT MIGRATION 003: Schema fixes from technical audit
-- Fixes: missing extensions, nullable product_id, missing columns/tables,
--        missing constraints, missing functions, campaign model improvements.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bootstrap required extensions (Critical: assumed but never created)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. Fix product_skus.product_id: make nullable (Critical: code inserts NULL)
-- The canonical product matching is a Phase 2 feature. Ingest inserts SKUs
-- without a matched product_id. The NOT NULL constraint blocks all inserts.
-- ---------------------------------------------------------------------------
ALTER TABLE product_skus ALTER COLUMN product_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Add missing columns to product_skus (needed by API queries)
-- ---------------------------------------------------------------------------
-- normalized_name: lowercased, whitespace-collapsed version for dedup/grouping
ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- search_vector: tsvector for full-text search (used by /api/search and bot)
ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- tags: macro-category tags (senza-lattosio, bio, etc.) used by /api/categoria
ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Index for search_vector (GIN for full-text search)
CREATE INDEX IF NOT EXISTS idx_skus_search_vector ON product_skus USING GIN(search_vector);

-- Index for tags (GIN for array containment queries)
CREATE INDEX IF NOT EXISTS idx_skus_tags ON product_skus USING GIN(tags);

-- ---------------------------------------------------------------------------
-- 4. Add updated_at to flyer_campaigns (missing, referenced by upsert)
-- ---------------------------------------------------------------------------
ALTER TABLE flyer_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ---------------------------------------------------------------------------
-- 5. Add unique constraint for campaign upserts (chain_id, valid_from)
-- The ingest code uses ON CONFLICT (chain_id, valid_from) but no constraint exists.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_campaign_chain_week'
  ) THEN
    ALTER TABLE flyer_campaigns
      ADD CONSTRAINT uq_campaign_chain_week UNIQUE (chain_id, valid_from);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Add unique constraint for stores (chain_id, external_id)
-- Used by populate-store-locations.ts ON CONFLICT clause.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_stores_chain_external'
  ) THEN
    ALTER TABLE stores
      ADD CONSTRAINT uq_stores_chain_external UNIQUE (chain_id, external_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Create user_profiles table (referenced by bot.ts and API preferences)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  id              SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  -- Personal data for loyalty card registration
  nome            TEXT,
  cognome         TEXT,
  email           TEXT,
  telefono        TEXT,
  indirizzo       TEXT,
  numero_civico   TEXT,
  citta           TEXT,
  provincia       TEXT DEFAULT 'VR',
  cap             TEXT,
  codice_fiscale  TEXT,
  -- Preferences (used by Mini App and bot for filtering)
  preferred_chains   TEXT[] DEFAULT '{}',
  preferred_store_ids INTEGER[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 8. Create user_loyalty_cards table (referenced by bot.ts /iscriviti)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_loyalty_cards (
  id              SERIAL PRIMARY KEY,
  user_profile_id INTEGER NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  chain_id        INTEGER NOT NULL REFERENCES chains(id),
  card_number     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, registered, active
  registered_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_profile_id, chain_id)
);

-- ---------------------------------------------------------------------------
-- 9. Add loyalty columns to chains table (referenced by bot.ts)
-- ---------------------------------------------------------------------------
ALTER TABLE chains ADD COLUMN IF NOT EXISTS loyalty_card_name TEXT;
ALTER TABLE chains ADD COLUMN IF NOT EXISTS loyalty_signup_url TEXT;
ALTER TABLE chains ADD COLUMN IF NOT EXISTS loyalty_app_url TEXT;

-- ---------------------------------------------------------------------------
-- 10. Create refresh_product_tags() function (called by ingest.ts)
-- Tags SKUs with macro-categories based on product name pattern matching.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_product_tags() RETURNS void AS $$
BEGIN
  -- Reset tags
  UPDATE product_skus SET tags = '{}';

  -- Tag based on Italian product name patterns
  UPDATE product_skus SET tags = array_append(tags, 'senza-lattosio')
    WHERE raw_name ILIKE '%senza lattosio%' OR raw_name ILIKE '%delattosato%'
       OR raw_name ILIKE '%lactose free%' OR raw_name ILIKE '%s.lattosio%';

  UPDATE product_skus SET tags = array_append(tags, 'senza-glutine')
    WHERE raw_name ILIKE '%senza glutine%' OR raw_name ILIKE '%gluten free%'
       OR raw_name ILIKE '%s.glutine%';

  UPDATE product_skus SET tags = array_append(tags, 'integrale')
    WHERE raw_name ILIKE '%integrale%' OR raw_name ILIKE '%integrali%';

  UPDATE product_skus SET tags = array_append(tags, 'bio')
    WHERE raw_name ILIKE '%biologic%' OR raw_name ILIKE '% bio %'
       OR raw_name ILIKE '%bio %' OR raw_name ILIKE '% bio';

  UPDATE product_skus SET tags = array_append(tags, 'vegano')
    WHERE raw_name ILIKE '%vegan%' OR raw_name ILIKE '%vegetale%'
       OR raw_name ILIKE '%plant based%' OR raw_name ILIKE '%plant-based%';

  UPDATE product_skus SET tags = array_append(tags, 'prima-infanzia')
    WHERE raw_name ILIKE '%neonato%' OR raw_name ILIKE '%bimbo%'
       OR raw_name ILIKE '%pannolin%' OR raw_name ILIKE '%omogenizz%'
       OR raw_name ILIKE '%baby%' OR raw_name ILIKE '%infanzia%'
       OR raw_name ILIKE '%crescita%';

  UPDATE product_skus SET tags = array_append(tags, 'proteico')
    WHERE raw_name ILIKE '%proteic%' OR raw_name ILIKE '%protein%'
       OR raw_name ILIKE '%high protein%';

  UPDATE product_skus SET tags = array_append(tags, 'surgelati')
    WHERE raw_name ILIKE '%surgelat%' OR raw_name ILIKE '%congelat%'
       OR raw_name ILIKE '%frozen%';

  UPDATE product_skus SET tags = array_append(tags, 'cura-casa')
    WHERE raw_name ILIKE '%detersivo%' OR raw_name ILIKE '%detergente%'
       OR raw_name ILIKE '%ammorbidente%' OR raw_name ILIKE '%sgrassator%'
       OR raw_name ILIKE '%candeggina%' OR raw_name ILIKE '%anticalcar%'
       OR raw_name ILIKE '%lavastoviglie%' OR raw_name ILIKE '%pavimenti%'
       OR raw_name ILIKE '%carta igienica%' OR raw_name ILIKE '%scottex%'
       OR raw_name ILIKE '%sacchetti%';

  UPDATE product_skus SET tags = array_append(tags, 'cura-persona')
    WHERE raw_name ILIKE '%shampoo%' OR raw_name ILIKE '%balsamo%'
       OR raw_name ILIKE '%bagnoschiuma%' OR raw_name ILIKE '%dentifricio%'
       OR raw_name ILIKE '%doccia%' OR raw_name ILIKE '%crema%'
       OR raw_name ILIKE '%deodorante%' OR raw_name ILIKE '%rasoio%'
       OR raw_name ILIKE '%assorbent%' OR raw_name ILIKE '%sapone%';

  -- Update normalized_name for all SKUs that don't have it yet
  UPDATE product_skus
    SET normalized_name = lower(regexp_replace(trim(raw_name), '\s+', ' ', 'g'))
    WHERE normalized_name IS NULL OR normalized_name = '';

  -- Update search_vector for full-text search
  UPDATE product_skus
    SET search_vector = to_tsvector('italian',
      coalesce(raw_name, '') || ' ' || coalesce(brand, '')
    );
END;
$$ LANGUAGE plpgsql;

-- Run it once to populate existing data
SELECT refresh_product_tags();

-- ---------------------------------------------------------------------------
-- 11. Update views to handle nullable product_id
-- The active_offers_view uses JOIN products which fails when product_id is NULL.
-- Replace with LEFT JOIN so SKUs without canonical product matches still appear.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW active_offers_view AS
SELECT
  o.id AS offer_id,
  c.slug AS chain_slug,
  c.name AS chain_name,
  p.slug AS product_slug,
  p.name AS product_name,
  COALESCE(p.category, 'uncategorized') AS category,
  p.base_unit,
  sk.raw_name,
  sk.brand,
  sk.raw_quantity,
  sk.quantity_value,
  sk.quantity_unit,
  o.offer_price,
  o.original_price,
  o.unit_price,
  o.unit_price_original,
  o.discount_pct,
  o.mechanic,
  o.mechanic_detail,
  o.valid_from,
  o.valid_to,
  o.raw_text,
  fc.region
FROM offers o
JOIN product_skus sk ON sk.id = o.sku_id
LEFT JOIN products p ON p.id = sk.product_id
JOIN chains c ON c.id = sk.chain_id
JOIN flyer_campaigns fc ON fc.id = o.campaign_id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE;

CREATE OR REPLACE VIEW best_current_price_view AS
SELECT
  COALESCE(p.id, sk.id) AS product_id,
  COALESCE(p.slug, sk.normalized_name) AS slug,
  COALESCE(p.name, sk.raw_name) AS name,
  COALESCE(p.category, 'uncategorized') AS category,
  p.base_unit,
  MIN(o.unit_price) AS best_unit_price,
  MIN(o.offer_price) AS best_offer_price,
  COUNT(DISTINCT sk.chain_id) AS chains_with_offer
FROM offers o
JOIN product_skus sk ON sk.id = o.sku_id
LEFT JOIN products p ON p.id = sk.product_id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE
  AND o.unit_price IS NOT NULL
GROUP BY COALESCE(p.id, sk.id), COALESCE(p.slug, sk.normalized_name),
         COALESCE(p.name, sk.raw_name), COALESCE(p.category, 'uncategorized'),
         p.base_unit;
