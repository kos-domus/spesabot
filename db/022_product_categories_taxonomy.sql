-- 022_product_categories_taxonomy.sql
-- Adds a structured taxonomy on top of the existing free-text products.category
-- column. The text column stays as legacy/source-of-truth for ingest pipelines;
-- the new product_categories table provides UI metadata (name_it, emoji, sort).
--
-- Date: 2026-05-13
-- Driver: Shopping list categories + grouping feature (FEATURE B)

BEGIN;

-- 1. Taxonomy table
CREATE TABLE IF NOT EXISTS product_categories (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name_it    TEXT NOT NULL,
  emoji      TEXT,
  parent_id  INT REFERENCES product_categories(id) ON DELETE SET NULL,
  sort_order INT DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Seed with the 16 categories already present in products.category + a few
-- extras frequently expected in Italian groceries. Slugs MATCH the existing
-- free-text values so the FK populate below is a direct join.
INSERT INTO product_categories (slug, name_it, emoji, sort_order) VALUES
  ('frutta-verdura',   'Frutta e Verdura',  '🥦',  10),
  ('panificati',       'Panificati',        '🥖',  20),
  ('latticini',        'Latticini',         '🥛',  30),
  ('carne',            'Carne',             '🥩',  40),
  ('salumi',           'Salumi',            '🍖',  50),
  ('pesce',            'Pesce',             '🐟',  60),
  ('pasta',            'Pasta',             '🍝',  70),
  ('riso-cereali',     'Riso e Cereali',    '🌾',  80),
  ('condimenti',       'Condimenti',        '🫒',  90),
  ('dolci-snack',      'Dolci e Snack',     '🍪', 100),
  ('caffe-te',         'Caffè e Tè',        '☕', 110),
  ('bevande',          'Bevande',           '🥤', 120),
  ('bevande-alcoliche','Bevande Alcoliche', '🍷', 130),
  ('surgelati',        'Surgelati',         '🧊', 140),
  ('cura-casa',        'Cura Casa',         '🧽', 150),
  ('cura-persona',     'Cura Persona',      '🧴', 160),
  ('animali',          'Animali',           '🐕', 170),
  ('altro',            'Altro',             '📦', 999)
ON CONFLICT (slug) DO NOTHING;

-- 3. Add FK from products to taxonomy. Nullable for safety; backfilled by
-- the UPDATE below. The existing text column stays.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category_id INT REFERENCES product_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);

-- 4. Backfill: link existing products to taxonomy via slug match.
UPDATE products p
   SET category_id = pc.id
  FROM product_categories pc
 WHERE pc.slug = p.category
   AND p.category_id IS NULL;

-- 5. Override + sort_order for shopping_list_items (drag-reorder support)
ALTER TABLE shopping_list_items
  ADD COLUMN IF NOT EXISTS category_override_id INT REFERENCES product_categories(id) ON DELETE SET NULL;
ALTER TABLE shopping_list_items
  ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sli_sort_order ON shopping_list_items(list_id, sort_order);

-- 6. Helper view: shopping list items with resolved category
CREATE OR REPLACE VIEW v_shopping_list_items_with_category AS
SELECT
  sli.*,
  COALESCE(sli.category_override_id, p.category_id) AS resolved_category_id,
  pc.slug    AS category_slug,
  pc.name_it AS category_name_it,
  pc.emoji   AS category_emoji,
  pc.sort_order AS category_sort_order
FROM shopping_list_items sli
LEFT JOIN products p   ON p.id = sli.product_id
LEFT JOIN product_categories pc ON pc.id = COALESCE(sli.category_override_id, p.category_id);

COMMIT;

-- Validation:
-- SELECT pc.slug, COUNT(p.*) FROM product_categories pc
--   LEFT JOIN products p ON p.category_id = pc.id
--   GROUP BY pc.slug ORDER BY 2 DESC NULLS LAST;
