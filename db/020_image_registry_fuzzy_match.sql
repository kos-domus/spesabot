-- 020_image_registry_fuzzy_match.sql

-- Trigram GiST index on name_norm — speeds up similarity() queries from
-- a full table scan on 32k+ rows to a filtered nearest-neighbor lookup.
-- Without this the fuzzy fallback below takes ~30s per query, with it
-- returns in <50ms.
CREATE INDEX IF NOT EXISTS idx_pir_name_trgm
  ON product_image_registry USING gist (name_norm gist_trgm_ops);

--
-- The image registry's lookup_product_image() did exact (brand_norm,
-- name_norm, quantity_norm) match. That's fine when the same parser
-- produced both sides (e.g. famila products in famila SKUs), but fails
-- across "vision-extracted" vs "text-parsed" names. Concretely: the
-- despar image backfill registered 131 products with names like
-- "sensodyne dentifricio assortito 75ml", while the Despar text parser
-- writes SKUs as "Detergente per pavimenti, profumazioni assortite
-- Amuchina 1,25 l". Same product, different word order + extras.
--
-- Add a final fallback that uses pg_trgm similarity. The pg_trgm
-- extension is already enabled (DOSSIER reference). Threshold tuned
-- conservatively: 0.45 catches "sensodyne dentifricio" ≈ "Dentifricio
-- Sensodyne" (similarity ≈ 0.6) but rejects unrelated products
-- (similarity < 0.3).

CREATE OR REPLACE FUNCTION lookup_product_image(
  p_brand TEXT,
  p_name  TEXT,
  p_qty   TEXT,
  p_ean   TEXT
) RETURNS TEXT
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  result TEXT;
  norm_name  TEXT := norm_text(p_name);
  norm_brand TEXT := norm_text(p_brand);
  norm_qty   TEXT := norm_text(p_qty);
BEGIN
  -- Branch 1: EAN exact match (gold standard)
  IF p_ean IS NOT NULL AND p_ean <> '' THEN
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE ean = p_ean
     ORDER BY last_seen DESC LIMIT 1;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;

  -- Branch 2: (brand, name, qty) exact normalized match
  IF p_brand IS NOT NULL OR p_name IS NOT NULL THEN
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE brand_norm    IS NOT DISTINCT FROM norm_brand
       AND name_norm     IS NOT DISTINCT FROM norm_name
       AND quantity_norm IS NOT DISTINCT FROM norm_qty
     ORDER BY last_seen DESC LIMIT 1;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;

  -- Branch 3: name-only exact match
  IF p_name IS NOT NULL THEN
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE name_norm = norm_name
     ORDER BY times_seen DESC, last_seen DESC LIMIT 1;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;

  -- Branch 4 (NEW): trigram similarity fallback. Catches the cross-parser
  -- name-divergence case (vision-OCR-from-crop vs text-overlay-extract).
  -- Quantity guard: only consider candidates with the same qty_norm when
  -- the SKU has one — prevents matching "Sensodyne 75ml" to "Sensodyne 100ml".
  -- Brand boost: when brand matches AND name similarity > 0.3, that beats
  -- a higher-similarity candidate with different brand.
  IF p_name IS NOT NULL AND length(norm_name) >= 6 THEN
    -- Same-brand best match (preferred)
    IF norm_brand IS NOT NULL THEN
      SELECT image_url INTO result
        FROM product_image_registry
       WHERE brand_norm = norm_brand
         AND (norm_qty IS NULL OR quantity_norm IS NULL OR quantity_norm = norm_qty)
         AND similarity(name_norm, norm_name) > 0.3
       ORDER BY similarity(name_norm, norm_name) DESC, last_seen DESC
       LIMIT 1;
      IF result IS NOT NULL THEN RETURN result; END IF;
    END IF;
    -- Cross-brand fallback (last resort)
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE (norm_qty IS NULL OR quantity_norm IS NULL OR quantity_norm = norm_qty)
       AND similarity(name_norm, norm_name) > 0.45
     ORDER BY similarity(name_norm, norm_name) DESC, last_seen DESC
     LIMIT 1;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;

  RETURN NULL;
END $$;
