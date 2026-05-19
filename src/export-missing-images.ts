/**
 * Export a CSV of SKUs that need a manual image. Use this when a chain's
 * parser doesn't extract images natively and even the cross-chain fuzzy
 * registry can't fill them — i.e. private-label products unique to that
 * chain (Despar's "Vivi Verde", Aldi's "Specialty Selected", etc.).
 *
 * Workflow:
 *
 *   1. node dist/export-missing-images.js <chain>  (default: despar)
 *      → writes /tmp/missing-images-<chain>-<date>.csv
 *
 *   2. Open the CSV in any spreadsheet (Numbers/Excel/Sheets). For each row,
 *      click the search_hint column to open Google Images preloaded with the
 *      product brand+name, find a clean image, copy its URL, paste it into
 *      the image_url column.
 *
 *   3. node dist/import-images-from-csv.js /tmp/missing-images-<chain>-<date>.csv
 *      → updates product_skus.image_url for each row that has a URL filled in;
 *        the existing trigger auto-registers it in product_image_registry, so
 *        future SKUs with the same name will heal automatically.
 *
 * Rows are ordered by current discount_pct desc (most-promoted products first)
 * + then by id, so if Rakki has limited time he can fill the top of the list
 * and still cover the offers that matter most for the front-page deals.
 */

import { writeFileSync } from 'node:fs';
import { query, close } from './db.js';

interface SkuRow {
  sku_id: number;
  brand: string | null;
  raw_name: string;
  raw_quantity: string | null;
  best_discount: number | null;
  active_offers: number;
}

function csvEscape(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function googleImagesUrl(brand: string | null, name: string, qty: string | null): string {
  const q = [brand, name, qty].filter(Boolean).join(' ').trim();
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=isch`;
}

async function main(): Promise<void> {
  const chain = process.argv[2] ?? 'despar';
  const today = new Date().toISOString().slice(0, 10);

  // Filter out junk rows captured by the text parser as if they were
  // products: promotional banners ("Chi pesca, vince!", "concorso", "App
  // Despar Tribù"), week markers ("1 a settimana dal..."), and very
  // long names that are clearly multiple products concatenated. These
  // shouldn't have an image looked up — they should ideally be cleaned
  // out of the catalog entirely (separate concern).
  const result = await query<SkuRow>(`
    SELECT
      sk.id            AS sku_id,
      sk.brand,
      sk.raw_name,
      sk.raw_quantity,
      MAX(o.discount_pct)::numeric(5,2) AS best_discount,
      COUNT(o.id)::int AS active_offers
    FROM product_skus sk
    JOIN chains c    ON c.id = sk.chain_id
    JOIN offers o    ON o.sku_id = sk.id
    WHERE c.slug = $1
      AND sk.image_url IS NULL
      AND o.valid_to >= CURRENT_DATE
      AND length(sk.raw_name) BETWEEN 6 AND 90
      AND sk.raw_name !~* '(settimana dal|concorso|partecipa|vince!|app despar|happy card|raccolta punti|tribù)'
    GROUP BY sk.id, sk.brand, sk.raw_name, sk.raw_quantity
    ORDER BY MAX(o.discount_pct) DESC NULLS LAST, sk.id
  `, [chain]);

  if (result.rows.length === 0) {
    console.log(`No SKUs missing images for chain '${chain}' — nothing to export.`);
    await close();
    return;
  }

  const header = ['sku_id', 'brand', 'name', 'quantita', 'best_discount_pct', 'active_offers', 'search_google_images', 'image_url'];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of result.rows) {
    lines.push([
      r.sku_id,
      r.brand,
      r.raw_name,
      r.raw_quantity,
      r.best_discount,
      r.active_offers,
      googleImagesUrl(r.brand, r.raw_name, r.raw_quantity),
      '',  // image_url to fill
    ].map(csvEscape).join(','));
  }

  const path = `/tmp/missing-images-${chain}-${today}.csv`;
  writeFileSync(path, lines.join('\n') + '\n');
  console.log(`Wrote ${result.rows.length} SKUs to ${path}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open ${path} in a spreadsheet`);
  console.log(`  2. Click the 'search_google_images' link, find a clean image, copy its URL`);
  console.log(`  3. Paste into 'image_url' column, save the CSV`);
  console.log(`  4. node dist/import-images-from-csv.js ${path}`);
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
