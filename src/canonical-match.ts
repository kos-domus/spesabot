/**
 * Canonical product matching — links chain-specific SKUs to unified products.
 *
 * Strategy (multi-pass, conservative):
 *
 *   Pass 1: Exact match key — brand + stripped name + normalized quantity.
 *           Groups SKUs that clearly describe the same product.
 *
 *   Pass 2: Fuzzy match — pg_trgm similarity on unmatched SKUs against
 *           existing canonical products. Only matches above a high threshold.
 *
 * The match key normalizes product names by:
 *   - Lowercasing
 *   - Stripping the brand from the product name (since brand is a separate field)
 *   - Removing Italian articles & filler words (il, la, lo, di, del, alla, etc.)
 *   - Normalizing quantity formats (500g → 500 g)
 *   - Collapsing whitespace
 *
 * Run: DATABASE_URL=... npx tsx src/canonical-match.ts
 */

import { query, getClient, close } from './db.js';
import { startRun, finishRun } from './etl-runs.js';

/** Build a normalized match key from a product name and brand. */
function buildMatchKey(rawName: string, brand: string | null, rawQuantity: string | null): string {
  let name = rawName.toLowerCase().trim();

  // Strip brand from name (it's stored separately)
  if (brand) {
    const brandLower = brand.toLowerCase().trim();
    // Remove brand at start or end of name
    name = name
      .replace(new RegExp(`^${escapeRegex(brandLower)}\\s+`, 'i'), '')
      .replace(new RegExp(`\\s+${escapeRegex(brandLower)}$`, 'i'), '')
      .trim();
  }

  // Remove common Italian articles and filler words
  const fillers = /\b(il|lo|la|i|gli|le|un|uno|una|di|del|dello|della|dei|degli|delle|al|allo|alla|ai|agli|alle|da|dal|dallo|dalla|con|su|sul|sullo|sulla|per|in|nel|nello|nella|tra|fra|e|o|a)\b/gi;
  name = name.replace(fillers, ' ');

  // Remove "pasta di semola di grano duro" → just the product name
  name = name.replace(/pasta\s+di\s+semola\s+(di\s+grano\s+duro\s*)?/gi, '');

  // Normalize number formats: "n.5" → "n5", "n°5" → "n5", "n. 5" → "n5"
  name = name.replace(/n[.°]\s*(\d+)/gi, 'n$1');

  // Normalize accented chars
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Remove extra punctuation
  name = name.replace(/[,;:!?'"()[\]{}]/g, ' ');

  // Collapse whitespace
  name = name.replace(/\s+/g, ' ').trim();

  // Build the full key: brand|name|quantity
  const normBrand = brand ? brand.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() : '';
  const normQty = normalizeQuantity(rawQuantity);

  return `${normBrand}|${name}|${normQty}`;
}

/** Normalize quantity string for consistent comparison. */
function normalizeQuantity(raw: string | null): string {
  if (!raw) return '';
  let q = raw.toLowerCase().trim();

  // "500g" → "500 g", "1,5l" → "1.5 l"
  q = q.replace(/(\d)\s*(g|kg|ml|cl|dl|l|pz)\b/gi, '$1 $2');
  q = q.replace(',', '.');

  // Normalize units: "1.5 l" → "1500 ml", "0.5 kg" → "500 g"
  const match = q.match(/^(\d+(?:\.\d+)?)\s*(g|kg|ml|cl|dl|l|pz)$/i);
  if (match) {
    let val = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'kg') { val *= 1000; return `${val} g`; }
    if (unit === 'l') { val *= 1000; return `${val} ml`; }
    if (unit === 'cl') { val *= 10; return `${val} ml`; }
    if (unit === 'dl') { val *= 100; return `${val} ml`; }
    return `${val} ${unit}`;
  }

  // Handle multi-pack: "2 x 100 g" → "2x100 g"
  q = q.replace(/(\d+)\s*x\s*(\d+)\s*(g|kg|ml|cl|dl|l|pz)/gi, '$1x$2 $3');

  return q;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Slugify a product name for the canonical products table. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

/** Infer a broad category from a product name. */
function inferCategory(name: string): string {
  const n = name.toLowerCase();
  if (/latte|yogurt|formaggio|ricotta|mozzarella|burrata|parmigiano|grana|mascarpone|stracchino/i.test(n)) return 'latticini';
  if (/pasta\b|spaghett|penne|rigatoni|fusilli|farfalle|orecchiette|tagliatelle|lasagn/i.test(n)) return 'pasta';
  if (/pane|grissini|cracker|fette biscottate|pan bauletto|focaccia/i.test(n)) return 'panificati';
  if (/birra|vino|prosecco|champagne|lambrusco|spumante|aperol|campari|spritz/i.test(n)) return 'bevande-alcoliche';
  if (/acqua|succo|aranciata|cola|limonata|the |te /i.test(n)) return 'bevande';
  if (/prosciutto|salame|mortadella|bresaola|speck|pancetta|wurstel|salsiccia/i.test(n)) return 'salumi';
  if (/pollo|manzo|vitello|maiale|tacchino|coniglio|agnello|hamburger|carne/i.test(n)) return 'carne';
  if (/salmone|tonno|merluzzo|pesce|gamberi|calamari|cozze|vongole/i.test(n)) return 'pesce';
  if (/biscotti|cioccolat|gelato|torta|merendina|croissant|brioche|wafer|snack/i.test(n)) return 'dolci-snack';
  if (/olio|aceto|sale|pepe|sugo|passata|pelati|pomodoro|pesto|condiment/i.test(n)) return 'condimenti';
  if (/detersivo|detergente|ammorbidente|candeggina|sgrassator|carta igienica|scottex/i.test(n)) return 'cura-casa';
  if (/shampoo|balsamo|bagnoschiuma|dentifricio|sapone|crema|deodorant/i.test(n)) return 'cura-persona';
  if (/surgelat|congela|frozen/i.test(n)) return 'surgelati';
  if (/caffe|caffè|orzo|camomilla/i.test(n)) return 'caffe-te';
  if (/riso\b|risotto|arborio|carnaroli|basmati/i.test(n)) return 'riso-cereali';
  return 'altro';
}

let runId = 0;

async function main() {
  console.log('=== Canonical Product Matching ===\n');
  try {
    runId = await startRun({ runType: 'matching-rule' });
  } catch (err) {
    console.error(`(etl_runs start failed, continuing without tracking: ${err instanceof Error ? err.message : err})`);
  }

  // Step 1: Compute match keys for all SKUs
  console.log('Step 1: Computing match keys...');
  const skus = await query<{
    id: number;
    raw_name: string;
    brand: string | null;
    raw_quantity: string | null;
    chain_id: number;
    product_id: number | null;
  }>('SELECT id, raw_name, brand, raw_quantity, chain_id, product_id FROM product_skus');

  const matchKeyMap = new Map<string, number[]>(); // matchKey → [sku_id, ...]
  let alreadyMatched = 0;

  for (const sku of skus.rows) {
    if (sku.product_id !== null) {
      alreadyMatched++;
      continue;
    }
    const key = buildMatchKey(sku.raw_name, sku.brand, sku.raw_quantity);
    const group = matchKeyMap.get(key) ?? [];
    group.push(sku.id);
    matchKeyMap.set(key, group);
  }

  console.log(`  Total SKUs: ${skus.rows.length}`);
  console.log(`  Already matched: ${alreadyMatched}`);
  console.log(`  Unique match keys: ${matchKeyMap.size}`);
  const multiChainGroups = [...matchKeyMap.entries()].filter(([, ids]) => {
    // Check if this group spans multiple chains
    const chainIds = new Set(ids.map(id => skus.rows.find(s => s.id === id)!.chain_id));
    return chainIds.size > 1;
  });
  console.log(`  Groups spanning 2+ chains: ${multiChainGroups.length}`);

  // Step 2: Create canonical products and link SKUs
  console.log('\nStep 2: Creating canonical products...');

  const client = await getClient();
  try {
    await client.query('BEGIN');

    let productsCreated = 0;
    let skusLinked = 0;

    for (const [matchKey, skuIds] of matchKeyMap) {
      // Pick the "best" SKU for naming the canonical product:
      // prefer the one with brand + longest name (most descriptive)
      const groupSkus = skuIds.map(id => skus.rows.find(s => s.id === id)!);
      groupSkus.sort((a, b) => {
        const aScore = (a.brand ? 10 : 0) + a.raw_name.length;
        const bScore = (b.brand ? 10 : 0) + b.raw_name.length;
        return bScore - aScore;
      });
      const best = groupSkus[0];

      // Build canonical product name: "Brand ProductName" or just "ProductName"
      let canonicalName = best.raw_name.replace(/\s+/g, ' ').trim();
      const brand = best.brand?.trim() || null;
      const category = inferCategory(canonicalName);
      const qty = normalizeQuantity(best.raw_quantity);

      // Determine base unit from quantity
      let baseUnit = 'unit';
      if (qty.includes(' g')) baseUnit = 'kg';
      else if (qty.includes(' ml')) baseUnit = 'L';
      else if (qty.includes(' pz')) baseUnit = 'unit';

      let unitType = 'count';
      if (baseUnit === 'kg') unitType = 'weight';
      else if (baseUnit === 'L') unitType = 'volume';

      // Create slug — must be unique
      let slug = slugify(canonicalName);
      if (qty) slug += '-' + slugify(qty);

      // Insert canonical product (or get existing by slug)
      const existing = await client.query('SELECT id FROM products WHERE slug = $1', [slug]);
      let productId: number;

      if (existing.rows.length > 0) {
        productId = existing.rows[0].id;
      } else {
        // Ensure slug uniqueness by appending chain if needed
        const slugCheck = await client.query('SELECT id FROM products WHERE slug = $1', [slug]);
        if (slugCheck.rows.length > 0) {
          slug += '-' + best.chain_id;
        }

        const insertResult = await client.query(
          `INSERT INTO products (slug, name, category, unit_type, base_unit, brand)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (slug) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [slug, canonicalName, category, unitType, baseUnit, brand],
        );
        productId = insertResult.rows[0].id;
        productsCreated++;
      }

      // Link all SKUs in this group to the canonical product
      for (const skuId of skuIds) {
        await client.query(
          'UPDATE product_skus SET product_id = $1 WHERE id = $2 AND product_id IS NULL',
          [productId, skuId],
        );
        skusLinked++;
      }
    }

    await client.query('COMMIT');
    console.log(`  Canonical products created: ${productsCreated}`);
    console.log(`  SKUs linked: ${skusLinked}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Step 3: Fuzzy match pass — link remaining unmatched SKUs to existing products
  console.log('\nStep 3: Fuzzy matching unmatched SKUs...');
  const unmatched = await query<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM product_skus WHERE product_id IS NULL',
  );
  console.log(`  Unmatched SKUs remaining: ${unmatched.rows[0].count}`);

  // Use pg_trgm to find high-similarity matches between unmatched SKUs and existing products
  const SIMILARITY_THRESHOLD = 0.6;
  const fuzzyResult = await query<{ sku_id: number; product_id: number; similarity: number }>(
    `SELECT DISTINCT ON (sk.id)
       sk.id as sku_id,
       p.id as product_id,
       similarity(sk.normalized_name, p.name) as similarity
     FROM product_skus sk
     CROSS JOIN LATERAL (
       SELECT p2.id, p2.name
       FROM products p2
       WHERE p2.brand IS NOT NULL
         AND sk.brand IS NOT NULL
         AND lower(p2.brand) = lower(sk.brand)
         AND similarity(sk.normalized_name, lower(p2.name)) > $1
       ORDER BY similarity(sk.normalized_name, lower(p2.name)) DESC
       LIMIT 1
     ) p
     WHERE sk.product_id IS NULL`,
    [SIMILARITY_THRESHOLD],
  );

  if (fuzzyResult.rows.length > 0) {
    const client2 = await getClient();
    try {
      await client2.query('BEGIN');
      for (const row of fuzzyResult.rows) {
        await client2.query(
          'UPDATE product_skus SET product_id = $1, confidence = $2 WHERE id = $3',
          [row.product_id, row.similarity, row.sku_id],
        );
      }
      await client2.query('COMMIT');
      console.log(`  Fuzzy-matched: ${fuzzyResult.rows.length} SKUs`);
    } catch (err) {
      await client2.query('ROLLBACK');
      throw err;
    } finally {
      client2.release();
    }
  } else {
    console.log('  No fuzzy matches found above threshold');
  }

  // Final stats
  console.log('\n=== Final Stats ===');
  const finalStats = await query<{ total: number; matched: number; products: number }>(`
    SELECT
      (SELECT COUNT(*)::int FROM product_skus) as total,
      (SELECT COUNT(*)::int FROM product_skus WHERE product_id IS NOT NULL) as matched,
      (SELECT COUNT(*)::int FROM products) as products
  `);
  const s = finalStats.rows[0];
  console.log(`  Total SKUs: ${s.total}`);
  console.log(`  Matched: ${s.matched} (${Math.round(s.matched / s.total * 100)}%)`);
  console.log(`  Canonical products: ${s.products}`);
  console.log(`  Unmatched: ${s.total - s.matched}`);

  // Show cross-chain products
  const crossChain = await query<{ name: string; chains: string; chain_count: number }>(`
    SELECT p.name, array_agg(DISTINCT c.slug ORDER BY c.slug) as chains, COUNT(DISTINCT c.slug)::int as chain_count
    FROM products p
    JOIN product_skus sk ON sk.product_id = p.id
    JOIN chains c ON sk.chain_id = c.id
    GROUP BY p.id, p.name
    HAVING COUNT(DISTINCT c.slug) >= 2
    ORDER BY COUNT(DISTINCT c.slug) DESC, p.name
    LIMIT 20
  `);
  console.log(`\n  Cross-chain products (top 20):`);
  for (const row of crossChain.rows) {
    console.log(`    [${row.chain_count} chains] ${row.name} → ${row.chains}`);
  }

  if (runId) {
    try {
      await finishRun(runId, {
        status: 'success',
        summary: {
          total_skus: s.total,
          matched: s.matched,
          unmatched: s.total - s.matched,
          products: s.products,
        },
      });
    } catch (err) {
      console.error(`(etl_runs finish failed: ${err instanceof Error ? err.message : err})`);
    }
  }

  await close();
}

main().catch(async (err) => {
  console.error('Error:', err);
  if (runId) {
    try {
      await finishRun(runId, {
        status: 'failed',
        errorTail: (err instanceof Error ? err.stack ?? err.message : String(err)).slice(-2000),
      });
    } catch { /* swallow — already in error path */ }
  }
  await close();
  process.exit(1);
});
