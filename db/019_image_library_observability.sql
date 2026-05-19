-- 019_image_library_observability.sql
--
-- Visibility layer over product_image_registry. Without these views Rakki
-- can't easily answer "is the registry actually growing every week?" or
-- "how many private-label products have we accumulated for Aldi/Despar?".
-- Two views + an admin endpoint helper:
--
--   v_image_library_status        — current snapshot per source_chain
--   v_image_library_weekly_growth — rows added per ISO week, per chain
--
-- Both are pure projections of product_image_registry, no recomputation.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Current snapshot
-- ──────────────────────────────────────────────────────────────────────
-- One row per source_chain (the chain that ORIGINALLY contributed the
-- image). Tells you immediately: "Aldi has X images learned, of which Y
-- via EAN; their last image was first seen on date Z."

CREATE OR REPLACE VIEW v_image_library_status AS
SELECT
  source_chain,
  COUNT(*)                                               AS rows,
  COUNT(DISTINCT image_url)                              AS unique_urls,
  COUNT(*) FILTER (WHERE ean IS NOT NULL)                AS with_ean,
  COUNT(*) FILTER (WHERE brand_norm IS NOT NULL)         AS with_brand,
  MIN(first_seen)::date                                  AS first_seen_at,
  MAX(last_seen)::date                                   AS last_seen_at,
  COUNT(*) FILTER (WHERE first_seen > now() - interval '7 days')  AS new_last_7d,
  COUNT(*) FILTER (WHERE first_seen > now() - interval '30 days') AS new_last_30d
FROM product_image_registry
GROUP BY source_chain
ORDER BY rows DESC;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Weekly growth (per chain × ISO week)
-- ──────────────────────────────────────────────────────────────────────
-- ISO week buckets: each row = (chain, week_starting_monday, count).
-- Use date_trunc('week', ...) which gives Monday-of-week. After 4-8
-- weeks of pipeline runs you can see the cumulative private-label
-- accumulation for Aldi/Despar.

CREATE OR REPLACE VIEW v_image_library_weekly_growth AS
SELECT
  source_chain,
  date_trunc('week', first_seen)::date AS week_starting,
  COUNT(*)                              AS new_images
FROM product_image_registry
GROUP BY source_chain, date_trunc('week', first_seen)
ORDER BY week_starting DESC, new_images DESC;

-- ──────────────────────────────────────────────────────────────────────
-- 3. Adoption — how many SKUs are using a "borrowed" image right now
-- ──────────────────────────────────────────────────────────────────────
-- An image_url on product_skus is "borrowed" when the registry's
-- source_chain differs from the SKU's own chain. Tells you: of the
-- chains with poor own-coverage (despar/aldi), how many of their active
-- offer cards are using a cross-chain image.

CREATE OR REPLACE VIEW v_image_borrowed_summary AS
SELECT
  c.slug                                AS chain,
  COUNT(DISTINCT sk.id)                 AS skus,
  COUNT(DISTINCT sk.id) FILTER (WHERE sk.image_url IS NOT NULL)                                            AS with_image,
  COUNT(DISTINCT sk.id) FILTER (WHERE sk.image_url IS NOT NULL AND pir.source_chain IS NOT NULL
                                     AND pir.source_chain <> c.slug)                                       AS borrowed,
  ROUND(
    100.0 * COUNT(DISTINCT sk.id) FILTER (WHERE sk.image_url IS NOT NULL AND pir.source_chain IS NOT NULL
                                              AND pir.source_chain <> c.slug)
    / NULLIF(COUNT(DISTINCT sk.id) FILTER (WHERE sk.image_url IS NOT NULL), 0),
    1
  )                                     AS pct_borrowed
FROM product_skus sk
JOIN chains c                       ON c.id = sk.chain_id
LEFT JOIN product_image_registry pir ON pir.image_url = sk.image_url
GROUP BY c.slug
ORDER BY skus DESC;
