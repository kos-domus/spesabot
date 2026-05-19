-- =============================================================================
-- SPESABOT MIGRATION 004: Add product image URLs
-- Stores the chain-specific product image URL on each SKU.
-- Different chains may have different images for the same canonical product.
-- =============================================================================

-- Add image_url column to product_skus
ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Recreate active_offers_view to include image_url
-- Must DROP first because adding a column changes the column order
DROP VIEW IF EXISTS best_current_price_view;
DROP VIEW IF EXISTS active_offers_view;

CREATE VIEW active_offers_view AS
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
  sk.image_url,
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

-- Recreate best_current_price_view (was dropped due to dependency)
CREATE VIEW best_current_price_view AS
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
