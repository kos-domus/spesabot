-- 018_product_image_registry.sql
--
-- Persistent cross-chain image library. Solves the problem that some
-- chains (despar 1%, aldi 40%, lidl ~60%) rarely surface product images
-- via their parser, while other chains (famila 97%, migross 100%) do.
-- When a product appears in both, we should be able to "borrow" the
-- image discovered by the rich-coverage chain for the poor-coverage one.
--
-- The existing backfill_missing_images() function only matches by
-- product_id (canonical), which doesn't help chains where the canonical
-- pipeline rarely fires (Esselunga: 24/373 canonicals = 6%). The new
-- registry adds two stronger keys: EAN (gold) and (brand,name,qty)
-- normalized.
--
-- Lifecycle:
--   - Trigger AFTER INSERT/UPDATE on product_skus → register_product_image()
--   - run-pipeline.sh calls backfill_images_from_registry() each cycle
--   - cleanup_expired_offers() never touches the registry: images persist
--     across promotion cycles, so an EAN seen once is remembered forever.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Table
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_image_registry (
  id            SERIAL PRIMARY KEY,
  ean           TEXT,
  brand_norm    TEXT,
  name_norm     TEXT,
  quantity_norm TEXT,
  image_url     TEXT NOT NULL,
  source_chain  TEXT NOT NULL,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  times_seen    INTEGER     NOT NULL DEFAULT 1,
  CHECK (image_url ~* '^https?://')
);

-- EAN match — strongest, narrowest. Partial index keeps it lean.
CREATE INDEX IF NOT EXISTS idx_pir_ean
  ON product_image_registry (ean) WHERE ean IS NOT NULL;

-- (brand, name, quantity) composite — fallback when EAN missing.
CREATE INDEX IF NOT EXISTS idx_pir_brand_name_qty
  ON product_image_registry (brand_norm, name_norm, quantity_norm);

-- (name) only — last-resort match when brand absent (lidl, despar in many cases).
CREATE INDEX IF NOT EXISTS idx_pir_name
  ON product_image_registry (name_norm);

-- ──────────────────────────────────────────────────────────────────────
-- 2. Normalization helper
-- ──────────────────────────────────────────────────────────────────────
--
-- Stable, IMMUTABLE for index use. Lowercases, collapses whitespace,
-- trims; deliberately leaves accents / punctuation alone — vision OCR
-- is the noisier layer, the registry just needs deterministic keys.

CREATE OR REPLACE FUNCTION norm_text(s TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(LOWER(REGEXP_REPLACE(TRIM(s), '\s+', ' ', 'g')), '')
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 3. Register (upsert) function
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION register_product_image(
  p_brand        TEXT,
  p_name         TEXT,
  p_qty          TEXT,
  p_ean          TEXT,
  p_image_url    TEXT,
  p_source_chain TEXT
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_image_url IS NULL OR p_image_url = '' THEN RETURN; END IF;
  IF p_image_url !~* '^https?://' THEN RETURN; END IF;

  -- Branch 1: EAN known → match on EAN exact.
  IF p_ean IS NOT NULL AND p_ean <> '' THEN
    UPDATE product_image_registry
       SET image_url   = p_image_url,
           last_seen   = now(),
           times_seen  = times_seen + 1,
           -- Keep the most-specific brand/name/qty if previously NULL.
           brand_norm    = COALESCE(brand_norm,    norm_text(p_brand)),
           name_norm     = COALESCE(name_norm,     norm_text(p_name)),
           quantity_norm = COALESCE(quantity_norm, norm_text(p_qty))
     WHERE ean = p_ean;
    IF NOT FOUND THEN
      INSERT INTO product_image_registry
        (ean, brand_norm, name_norm, quantity_norm, image_url, source_chain)
      VALUES
        (p_ean, norm_text(p_brand), norm_text(p_name), norm_text(p_qty),
         p_image_url, p_source_chain);
    END IF;
    RETURN;
  END IF;

  -- Branch 2: no EAN → match on (brand, name, qty) normalized.
  IF p_brand IS NOT NULL OR p_name IS NOT NULL THEN
    UPDATE product_image_registry
       SET image_url  = p_image_url,
           last_seen  = now(),
           times_seen = times_seen + 1
     WHERE brand_norm    IS NOT DISTINCT FROM norm_text(p_brand)
       AND name_norm     IS NOT DISTINCT FROM norm_text(p_name)
       AND quantity_norm IS NOT DISTINCT FROM norm_text(p_qty)
       AND ean IS NULL;
    IF NOT FOUND THEN
      INSERT INTO product_image_registry
        (ean, brand_norm, name_norm, quantity_norm, image_url, source_chain)
      VALUES
        (NULL, norm_text(p_brand), norm_text(p_name), norm_text(p_qty),
         p_image_url, p_source_chain);
    END IF;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 4. Lookup function (used by backfill + at-ingest hint)
-- ──────────────────────────────────────────────────────────────────────
--
-- STABLE so callers can use it safely in WHERE/SELECT clauses. Returns
-- the highest-confidence image:
--   1. exact EAN match (if EAN provided)
--   2. (brand, name, qty) normalized match
--   3. (name only) match — last resort

CREATE OR REPLACE FUNCTION lookup_product_image(
  p_brand TEXT,
  p_name  TEXT,
  p_qty   TEXT,
  p_ean   TEXT
) RETURNS TEXT
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  result TEXT;
BEGIN
  IF p_ean IS NOT NULL AND p_ean <> '' THEN
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE ean = p_ean
     ORDER BY last_seen DESC LIMIT 1;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;

  IF p_brand IS NOT NULL OR p_name IS NOT NULL THEN
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE brand_norm    IS NOT DISTINCT FROM norm_text(p_brand)
       AND name_norm     IS NOT DISTINCT FROM norm_text(p_name)
       AND quantity_norm IS NOT DISTINCT FROM norm_text(p_qty)
     ORDER BY last_seen DESC LIMIT 1;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;

  IF p_name IS NOT NULL THEN
    SELECT image_url INTO result
      FROM product_image_registry
     WHERE name_norm = norm_text(p_name)
     ORDER BY times_seen DESC, last_seen DESC LIMIT 1;
  END IF;

  RETURN result;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 5. Trigger: every product_sku INSERT/UPDATE feeds the registry
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_register_product_image() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.image_url IS NOT NULL AND NEW.image_url <> '' THEN
    PERFORM register_product_image(
      NEW.brand, NEW.raw_name, NEW.raw_quantity, NEW.ean,
      NEW.image_url,
      (SELECT slug FROM chains WHERE id = NEW.chain_id)
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS product_skus_register_image ON product_skus;
CREATE TRIGGER product_skus_register_image
AFTER INSERT OR UPDATE OF image_url ON product_skus
FOR EACH ROW EXECUTE FUNCTION trg_register_product_image();

-- ──────────────────────────────────────────────────────────────────────
-- 6. Cross-chain backfill function
-- ──────────────────────────────────────────────────────────────────────
--
-- Heals product_skus where image_url IS NULL by looking up the registry.
-- Returns count of skus updated.

CREATE OR REPLACE FUNCTION backfill_images_from_registry() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  updated INTEGER;
BEGIN
  WITH healed AS (
    UPDATE product_skus sk
       SET image_url = lookup_product_image(sk.brand, sk.raw_name, sk.raw_quantity, sk.ean)
     WHERE sk.image_url IS NULL
       AND lookup_product_image(sk.brand, sk.raw_name, sk.raw_quantity, sk.ean) IS NOT NULL
    RETURNING sk.id
  )
  SELECT COUNT(*) INTO updated FROM healed;
  RETURN updated;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 7. Initial seed from existing product_skus
-- ──────────────────────────────────────────────────────────────────────
--
-- One-shot bootstrap: every existing sku with an image_url feeds the
-- registry. Idempotent — re-running this migration just no-ops on
-- second pass thanks to register_product_image()'s upsert logic.

INSERT INTO product_image_registry (ean, brand_norm, name_norm, quantity_norm, image_url, source_chain, times_seen)
SELECT
  NULLIF(sk.ean, ''),
  norm_text(sk.brand),
  norm_text(sk.raw_name),
  norm_text(sk.raw_quantity),
  sk.image_url,
  c.slug,
  1
FROM product_skus sk
JOIN chains c ON c.id = sk.chain_id
WHERE sk.image_url IS NOT NULL
  AND sk.image_url ~* '^https?://'
ON CONFLICT DO NOTHING;
