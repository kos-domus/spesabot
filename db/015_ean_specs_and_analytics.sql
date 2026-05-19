-- Extend product_skus with EAN + specifications, add image-url fallback
-- helper, and expose promotion analytics views.
--
-- Motivation:
--
--   - EAN codes are the strongest cross-chain identity signal. When two
--     chains list the same product, their EAN matches even if the name or
--     brand formatting differs. Populating EAN lets canonical-match.ts
--     collapse exact matches without fuzzy logic.
--
--   - specifications (JSONB) captures chain-specific metadata that doesn't
--     fit a flat column: energy class for appliances, nutrition for food,
--     package dimensions, alcohol %, country of origin, etc. Parsers
--     populate whatever they can extract; the rest stays NULL. Future
--     retrieval code can look for fields by key instead of blind parsing.
--
--   - The "missing image" fallback: when a new ingest inserts a SKU without
--     an image_url but a canonical sibling from a previous week has one,
--     reuse it so user-facing views don't go blank. Implemented as a
--     trigger that fires AFTER the canonical-match pass links product_id.

ALTER TABLE product_skus
  ADD COLUMN IF NOT EXISTS ean TEXT,
  ADD COLUMN IF NOT EXISTS specifications JSONB DEFAULT '{}'::jsonb;

-- EAN lookups: partial unique index on non-null values. A chain might reuse
-- the same EAN across weeks (same SKU re-promoted) so uniqueness is scoped
-- to chain_id + ean — cross-chain EAN collisions are the whole point of the
-- identity signal and handled by canonical-match.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_skus_chain_ean
  ON product_skus (chain_id, ean) WHERE ean IS NOT NULL;

-- Global index for cross-chain EAN lookup (non-unique — many chains may list
-- the same product).
CREATE INDEX IF NOT EXISTS idx_product_skus_ean_lookup
  ON product_skus (ean) WHERE ean IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Image-url fallback function
-- ---------------------------------------------------------------------------
-- Called manually after ingest (can be scheduled into run-pipeline.sh). For
-- every SKU with NULL image_url but a non-null product_id, look up the most
-- recently-updated sibling SKU (same canonical product) that HAS an image
-- and copy it over. Returns the count of SKUs healed.
CREATE OR REPLACE FUNCTION backfill_missing_images() RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  WITH healed AS (
    UPDATE product_skus ps
    SET image_url = src.image_url
    FROM (
      SELECT DISTINCT ON (product_id) product_id, image_url
      FROM product_skus
      WHERE image_url IS NOT NULL AND product_id IS NOT NULL
      ORDER BY product_id, updated_at DESC
    ) src
    WHERE ps.image_url IS NULL
      AND ps.product_id = src.product_id
    RETURNING ps.id
  )
  SELECT COUNT(*) INTO updated_count FROM healed;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Promotion analytics view
-- ---------------------------------------------------------------------------
-- One row per (chain, week, category-tag, mechanic). Enables questions like:
--   - What mix of price_cut vs loyalty_price vs 3x2 does each chain use?
--   - Which categories do different chains promote most aggressively?
--   - How does average discount depth trend over time?
-- Materialised view would be faster but the underlying data is small enough
-- that a regular view keeps it always-fresh with minimal overhead.
CREATE OR REPLACE VIEW v_promotion_analytics AS
WITH exploded AS (
  -- Explode tags into one row per (offer, category) via a LATERAL join.
  -- Offers with empty tags surface as a single 'uncategorized' row so they
  -- still participate in the aggregates below.
  SELECT
    c.slug AS chain,
    c.name AS chain_name,
    date_trunc('week', o.valid_from)::date AS week_start,
    COALESCE(tag, 'uncategorized') AS category,
    o.mechanic,
    o.requires_card,
    o.offer_price,
    o.discount_pct
  FROM offers o
  JOIN product_skus ps ON o.sku_id = ps.id
  JOIN chains c ON ps.chain_id = c.id
  LEFT JOIN LATERAL unnest(COALESCE(NULLIF(ps.tags, '{}'), ARRAY[NULL]::text[])) AS tag ON true
)
SELECT
  chain,
  chain_name,
  week_start,
  category,
  mechanic,
  requires_card,
  COUNT(*)            AS offer_count,
  AVG(discount_pct)   AS avg_discount_pct,
  AVG(offer_price)    AS avg_price,
  MIN(offer_price)    AS min_price,
  MAX(offer_price)    AS max_price
FROM exploded
GROUP BY chain, chain_name, week_start, category, mechanic, requires_card;

-- Compact per-chain snapshot for the current week — used by the /api/analytics
-- dashboard. Filters to only rows that cover today's date.
CREATE OR REPLACE VIEW v_current_promotions AS
SELECT
  c.slug                           AS chain,
  c.name                           AS chain_name,
  COUNT(DISTINCT o.id)             AS active_offers,
  COUNT(DISTINCT o.sku_id)         AS unique_skus,
  COUNT(*) FILTER (WHERE o.requires_card)                       AS loyalty_only,
  COUNT(*) FILTER (WHERE o.mechanic = 'loyalty_price')          AS loyalty_priced,
  COUNT(*) FILTER (WHERE o.mechanic = 'three_for_two')          AS three_for_two,
  COUNT(*) FILTER (WHERE o.mechanic = 'percentage_off')         AS pct_off,
  COUNT(*) FILTER (WHERE o.mechanic = 'price_cut')              AS price_cut,
  AVG(o.discount_pct) FILTER (WHERE o.discount_pct IS NOT NULL) AS avg_discount,
  MAX(o.valid_to)                                               AS flyer_ends
FROM offers o
JOIN product_skus ps ON o.sku_id = ps.id
JOIN chains c ON ps.chain_id = c.id
WHERE o.valid_from <= CURRENT_DATE AND o.valid_to >= CURRENT_DATE
GROUP BY c.slug, c.name;
