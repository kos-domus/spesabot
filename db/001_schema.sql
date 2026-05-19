-- =============================================================================
-- SPESABOT PHASE 1 SCHEMA
-- PostgreSQL 16+ with PostGIS 3.x + pg_trgm
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CHAINS & STORES
-- ---------------------------------------------------------------------------

CREATE TABLE chains (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  website     TEXT,
  flyer_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id           SERIAL PRIMARY KEY,
  chain_id     INTEGER NOT NULL REFERENCES chains(id),
  external_id  TEXT,
  name         TEXT,
  address      TEXT,
  city         TEXT,
  province     TEXT NOT NULL DEFAULT 'VR',
  postal_code  TEXT,
  location     GEOMETRY(POINT, 4326),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stores_chain ON stores(chain_id);
CREATE INDEX idx_stores_location ON stores USING GIST(location);
CREATE INDEX idx_stores_province ON stores(province) WHERE is_active;

-- ---------------------------------------------------------------------------
-- PRODUCT GRAPH
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id               SERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  subcategory      TEXT,
  unit_type        TEXT NOT NULL,           -- 'weight' | 'volume' | 'count' | 'pack'
  base_unit        TEXT NOT NULL,           -- 'kg' | 'L' | 'unit'
  brand            TEXT,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_slug ON products(slug);
CREATE INDEX idx_products_name_trgm ON products USING GIN(name gin_trgm_ops);

-- Chain-specific SKU: how a chain names/packages a canonical product
CREATE TABLE product_skus (
  id             SERIAL PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  chain_id       INTEGER NOT NULL REFERENCES chains(id),
  chain_sku_id   TEXT,
  raw_name       TEXT NOT NULL,
  brand          TEXT,
  raw_quantity   TEXT,
  quantity_value NUMERIC(10,4),
  quantity_unit  TEXT,
  confidence     NUMERIC(4,3),
  is_verified    BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_id, raw_name, raw_quantity)
);

CREATE INDEX idx_skus_product ON product_skus(product_id);
CREATE INDEX idx_skus_chain ON product_skus(chain_id);
CREATE INDEX idx_skus_raw_name_trgm ON product_skus USING GIN(raw_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- FLYER CAMPAIGNS
-- ---------------------------------------------------------------------------

CREATE TABLE flyer_campaigns (
  id              SERIAL PRIMARY KEY,
  chain_id        INTEGER NOT NULL REFERENCES chains(id),
  valid_from      DATE NOT NULL,
  valid_to        DATE NOT NULL,
  region          TEXT,
  source_url      TEXT,
  research_job_id TEXT,
  scrape_status   TEXT NOT NULL DEFAULT 'pending',
  raw_result_path TEXT,
  products_extracted INTEGER DEFAULT 0,
  products_ingested  INTEGER DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_chain_dates ON flyer_campaigns(chain_id, valid_from, valid_to);
CREATE INDEX idx_campaigns_status ON flyer_campaigns(scrape_status) WHERE scrape_status != 'loaded';

-- ---------------------------------------------------------------------------
-- OFFERS
-- ---------------------------------------------------------------------------

CREATE TYPE offer_mechanic AS ENUM (
  'price_cut',
  'percentage_off',
  'sottocosto',
  'three_for_two',
  'two_for_price_of_one',
  'n_for_price',
  'second_half_price',
  'loyalty_price',
  'multi_buy',
  'bundle',
  'unknown'
);

CREATE TABLE offers (
  id                  SERIAL PRIMARY KEY,
  sku_id              INTEGER NOT NULL REFERENCES product_skus(id),
  campaign_id         INTEGER NOT NULL REFERENCES flyer_campaigns(id),
  store_id            INTEGER REFERENCES stores(id),

  -- Prices
  offer_price         NUMERIC(8,2) NOT NULL,
  original_price      NUMERIC(8,2),
  unit_price          NUMERIC(10,4),
  unit_price_original NUMERIC(10,4),
  discount_pct        NUMERIC(5,2),
  savings_eur         NUMERIC(8,2),

  -- Offer mechanics
  mechanic            offer_mechanic NOT NULL DEFAULT 'price_cut',
  mechanic_detail     JSONB,
  requires_card       BOOLEAN NOT NULL DEFAULT false,
  card_name           TEXT,

  -- Validity
  valid_from          DATE NOT NULL,
  valid_to            DATE NOT NULL,

  -- Quality
  extraction_confidence NUMERIC(4,3),
  raw_text            TEXT,
  is_verified         BOOLEAN NOT NULL DEFAULT false,

  -- Phase 2: near-expiry fields (present but unused)
  lot_id              TEXT,
  expiry_date         DATE,
  stock_band          TEXT,
  markdown_reason     TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(sku_id, campaign_id, store_id)
);

CREATE INDEX idx_offers_sku ON offers(sku_id);
CREATE INDEX idx_offers_campaign ON offers(campaign_id);
CREATE INDEX idx_offers_dates ON offers(valid_from, valid_to);
CREATE INDEX idx_offers_unit_price ON offers(unit_price);
CREATE INDEX idx_offers_active ON offers(valid_from, valid_to, unit_price)
  WHERE valid_to >= CURRENT_DATE;

-- ---------------------------------------------------------------------------
-- PRICE HISTORY
-- ---------------------------------------------------------------------------

CREATE TABLE price_history (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          INTEGER NOT NULL REFERENCES product_skus(id),
  week_start      DATE NOT NULL,
  min_price       NUMERIC(8,2) NOT NULL,
  max_price       NUMERIC(8,2) NOT NULL,
  is_promo_week   BOOLEAN NOT NULL DEFAULT false,
  mechanic        offer_mechanic,
  min_unit_price  NUMERIC(10,4),
  max_unit_price  NUMERIC(10,4),
  reference_price NUMERIC(8,2),
  reference_unit_price NUMERIC(10,4),
  campaign_id     INTEGER REFERENCES flyer_campaigns(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(sku_id, week_start)
);

CREATE INDEX idx_price_history_sku_week ON price_history(sku_id, week_start DESC);
CREATE INDEX idx_price_history_nonpromo ON price_history(sku_id, week_start DESC)
  WHERE is_promo_week = false;

-- ---------------------------------------------------------------------------
-- USERS & SHOPPING LISTS
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  telegram_id     BIGINT NOT NULL UNIQUE,
  telegram_handle TEXT,
  first_name      TEXT,
  home_cap        TEXT,
  preferred_chains INTEGER[],
  max_distance_km INTEGER NOT NULL DEFAULT 10,
  tier            TEXT NOT NULL DEFAULT 'free',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shopping_lists (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'Lista della spesa',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_shopping_lists_default
  ON shopping_lists(user_id) WHERE is_default = true;

CREATE TABLE shopping_list_items (
  id              SERIAL PRIMARY KEY,
  list_id         INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  product_id      INTEGER REFERENCES products(id),
  raw_text        TEXT NOT NULL,
  quantity        NUMERIC(8,2),
  quantity_unit   TEXT,
  notes           TEXT,
  is_checked      BOOLEAN NOT NULL DEFAULT false,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_list_items_list ON shopping_list_items(list_id);
CREATE INDEX idx_list_items_product ON shopping_list_items(product_id)
  WHERE product_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- EXTRACTION STAGING
-- ---------------------------------------------------------------------------

CREATE TABLE staging_raw_offers (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       INTEGER NOT NULL REFERENCES flyer_campaigns(id),
  raw_product_name  TEXT NOT NULL,
  raw_brand         TEXT,
  raw_price         TEXT NOT NULL,
  raw_original_price TEXT,
  raw_quantity      TEXT,
  raw_discount      TEXT,
  raw_category      TEXT,
  raw_validity      TEXT,
  raw_mechanic_text TEXT,
  source_url        TEXT,
  extraction_provider TEXT,
  extraction_confidence NUMERIC(4,3),
  status            TEXT NOT NULL DEFAULT 'pending',
  matched_sku_id    INTEGER REFERENCES product_skus(id),
  match_confidence  NUMERIC(4,3),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

CREATE INDEX idx_staging_campaign ON staging_raw_offers(campaign_id);
CREATE INDEX idx_staging_status ON staging_raw_offers(status) WHERE status != 'matched';

-- ---------------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------------

CREATE VIEW active_offers_view AS
SELECT
  o.id AS offer_id,
  c.slug AS chain_slug,
  c.name AS chain_name,
  p.slug AS product_slug,
  p.name AS product_name,
  p.category,
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
JOIN products p ON p.id = sk.product_id
JOIN chains c ON c.id = sk.chain_id
JOIN flyer_campaigns fc ON fc.id = o.campaign_id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE;

CREATE VIEW best_current_price_view AS
SELECT
  p.id AS product_id,
  p.slug,
  p.name,
  p.category,
  p.base_unit,
  MIN(o.unit_price) AS best_unit_price,
  MIN(o.offer_price) AS best_offer_price,
  COUNT(DISTINCT sk.chain_id) AS chains_with_offer
FROM offers o
JOIN product_skus sk ON sk.id = o.sku_id
JOIN products p ON p.id = sk.product_id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE
  AND o.unit_price IS NOT NULL
GROUP BY p.id, p.slug, p.name, p.category, p.base_unit;
