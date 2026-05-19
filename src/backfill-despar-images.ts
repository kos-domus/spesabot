/**
 * Backfill product images for the Despar chain.
 *
 * Despar's text parser can't capture product images (1.5% native coverage).
 * This script runs the iPaper page-image vision extractor (despar-images.ts),
 * registers each extracted (brand, name, qty) → image_url into the persistent
 * product_image_registry, then triggers the existing registry backfill so
 * the matching despar SKUs in product_skus get their image_url assigned
 * immediately.
 *
 * Run weekly (or on-demand after a Despar volantino refresh):
 *   node dist/scripts/backfill-despar-images.js
 *
 * The registry is the persistent layer, so even if a Despar SKU expires
 * (offers cleaned up), the image we extracted today stays available
 * forever and will heal future SKUs with the same name.
 */

import { extractDesparImages } from './parsers/despar-images.js';
import { query, close } from './db.js';

async function main(): Promise<void> {
  console.log('=== despar image backfill — start ===');
  const startedAt = Date.now();

  const products = await extractDesparImages();
  console.log(`extracted ${products.length} products with images from current despar flyer`);
  if (products.length === 0) {
    console.log('nothing to register');
    await close();
    return;
  }

  // Insert each into the registry. Use the existing register_product_image()
  // SQL function so the upsert logic (EAN-priority, then brand+name+qty match,
  // last-seen bump) is consistent with what the trigger does for fresh SKUs.
  let inserted = 0;
  for (const p of products) {
    try {
      await query(
        'SELECT register_product_image($1, $2, $3, $4, $5, $6)',
        [p.brand, p.prodotto, p.quantita, null, p.image_url, 'despar'],
      );
      inserted++;
    } catch (e) {
      console.warn(`[despar-images] register failed for "${p.prodotto}": ${(e as Error).message}`);
    }
  }
  console.log(`registered ${inserted}/${products.length} entries in product_image_registry`);

  // Now apply the registry to existing SKUs without an image. The function
  // itself returns the number healed.
  const healed = await query<{ healed: number }>('SELECT backfill_images_from_registry()::int AS healed');
  console.log(`backfilled ${healed.rows[0].healed} despar SKUs with newly-registered images`);

  // Final coverage check
  const cov = await query<{ active: number; with_img: number; pct: number }>(`
    SELECT
      COUNT(o.id)::int AS active,
      COUNT(*) FILTER (WHERE sk.image_url IS NOT NULL)::int AS with_img,
      ROUND(100.0 * COUNT(*) FILTER (WHERE sk.image_url IS NOT NULL) / NULLIF(COUNT(o.id), 0), 1)::float AS pct
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE c.slug = 'despar' AND o.valid_to >= CURRENT_DATE
  `);
  const r = cov.rows[0];
  console.log(`despar active offers: ${r.with_img}/${r.active} have an image (${r.pct}%)`);

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`=== despar image backfill — done in ${elapsed}s ===`);
  await close();
}

main().catch((e) => {
  console.error('despar backfill failed:', e);
  process.exit(1);
});
