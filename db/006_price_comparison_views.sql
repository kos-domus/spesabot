-- =============================================================================
-- SPESABOT MIGRATION 006: Price comparison views
-- Cross-chain price comparison for canonical products.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cross-chain price comparison: shows every active offer grouped by
--    canonical product, so you can see which chain has the best price.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cross_chain_prices AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  p.brand AS product_brand,
  p.category,
  c.slug AS chain_slug,
  c.name AS chain_name,
  sk.raw_name,
  sk.raw_quantity,
  sk.image_url,
  o.offer_price,
  o.original_price,
  o.unit_price,
  o.discount_pct,
  o.valid_from,
  o.valid_to,
  o.mechanic
FROM products p
JOIN product_skus sk ON sk.product_id = p.id
JOIN offers o ON o.sku_id = sk.id
JOIN chains c ON sk.chain_id = c.id
JOIN flyer_campaigns fc ON o.campaign_id = fc.id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE;

-- ---------------------------------------------------------------------------
-- 2. Best price per canonical product: the cheapest current offer for each
--    product, with runner-up for comparison.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW best_prices AS
SELECT DISTINCT ON (p.id)
  p.id AS product_id,
  p.name AS product_name,
  p.brand AS product_brand,
  p.category,
  c.slug AS cheapest_chain,
  c.name AS cheapest_chain_name,
  o.offer_price AS best_price,
  o.original_price,
  o.unit_price AS best_unit_price,
  o.discount_pct,
  sk.raw_quantity,
  sk.image_url,
  o.valid_to,
  (SELECT COUNT(DISTINCT sk2.chain_id)
   FROM product_skus sk2
   JOIN offers o2 ON o2.sku_id = sk2.id
   WHERE sk2.product_id = p.id
     AND o2.valid_to >= CURRENT_DATE
     AND o2.valid_from <= CURRENT_DATE) AS chains_with_offer
FROM products p
JOIN product_skus sk ON sk.product_id = p.id
JOIN offers o ON o.sku_id = sk.id
JOIN chains c ON sk.chain_id = c.id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE
ORDER BY p.id, o.offer_price ASC;

-- ---------------------------------------------------------------------------
-- 3. Price spread: products available at 2+ chains, showing the price range
--    and potential savings. This is the "money shot" view for the bot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW price_spread AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  p.brand AS product_brand,
  p.category,
  COUNT(DISTINCT c.id) AS chain_count,
  MIN(o.offer_price) AS min_price,
  MAX(o.offer_price) AS max_price,
  ROUND(MAX(o.offer_price) - MIN(o.offer_price), 2) AS price_spread,
  ROUND((1 - MIN(o.offer_price) / NULLIF(MAX(o.offer_price), 0)) * 100, 1) AS savings_pct,
  (SELECT c2.name FROM chains c2
   JOIN product_skus sk2 ON sk2.chain_id = c2.id AND sk2.product_id = p.id
   JOIN offers o2 ON o2.sku_id = sk2.id
   WHERE o2.valid_to >= CURRENT_DATE AND o2.valid_from <= CURRENT_DATE
   ORDER BY o2.offer_price ASC LIMIT 1) AS cheapest_chain,
  array_agg(DISTINCT c.name ORDER BY c.name) AS available_at
FROM products p
JOIN product_skus sk ON sk.product_id = p.id
JOIN offers o ON o.sku_id = sk.id
JOIN chains c ON sk.chain_id = c.id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE
GROUP BY p.id, p.name, p.brand, p.category
HAVING COUNT(DISTINCT c.id) >= 2;

-- ---------------------------------------------------------------------------
-- 4. Category price leaders: cheapest chain per category (aggregated view).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW category_price_leaders AS
SELECT
  p.category,
  c.name AS chain_name,
  COUNT(*) AS products_cheapest,
  ROUND(AVG(o.offer_price)::numeric, 2) AS avg_price
FROM products p
JOIN product_skus sk ON sk.product_id = p.id
JOIN offers o ON o.sku_id = sk.id
JOIN chains c ON sk.chain_id = c.id
WHERE o.valid_to >= CURRENT_DATE
  AND o.valid_from <= CURRENT_DATE
  AND o.offer_price = (
    SELECT MIN(o2.offer_price)
    FROM product_skus sk2
    JOIN offers o2 ON o2.sku_id = sk2.id
    WHERE sk2.product_id = p.id
      AND o2.valid_to >= CURRENT_DATE
      AND o2.valid_from <= CURRENT_DATE
  )
GROUP BY p.category, c.name
ORDER BY p.category, products_cheapest DESC;
