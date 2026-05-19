/**
 * SpesaBot ETL: Load deep-research JSON results into PostgreSQL.
 * Reads JobResult JSON → normalizes → inserts into staging → matches to products.
 */
import { readFileSync } from 'node:fs';
import { query, getClient } from './db.js';
import { parsePrice, parseQuantity, parseMechanic, computeUnitPrice } from './normalize.js';
import { parseAldiMarkdown, parseAldiDatePage } from './parsers/aldi.js';
import { parseFamilaMarkdown } from './parsers/famila.js';
import { parseLidlMarkdown } from './parsers/lidl.js';
import { parseEurospinPdfText } from './parsers/eurospin.js';
import { parseConadMarkdown } from './parsers/conad.js';
import { parseConadFlyerText } from './parsers/conad-flyer.js';
import { parseDesparMarkdown } from './parsers/despar.js';
import { parseRossettoHtml } from './parsers/rossetto.js';
import { getChainConfig } from './store-registry.js';

interface JobResult {
  jobId: string;
  query: string;
  domain: string;
  project: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  sites: Array<{ url: string; method: string; status: string; fetchTimeMs: number; error?: string }>;
  results: Array<{
    sourceUrl: string;
    title: string;
    extracted: Record<string, unknown> | Array<Record<string, unknown>>;
    rawMarkdown?: string;
    validFrom?: string;
    validTo?: string;
  }>;
  /** Optional: per-product image URLs from an external API (key = uppercase product name) */
  productImages?: Record<string, string>;
}

export interface IngestStats {
  chain: string;
  campaignId: number;
  productsExtracted: number;
  productsIngested: number;
  productsSkipped: number;
  errors: string[];
}

/**
 * DEPRECATED: Full chain wipe before re-ingesting.
 * This was destructive — it deleted ALL offers and SKUs for a chain, which:
 *   - Churned primary keys (breaks price_history foreign keys)
 *   - Destroyed historical data needed for price trend analysis
 *   - Made re-runs non-idempotent if they failed partway through
 *
 * Replaced by campaign-scoped cleanup: only delete offers for the specific
 * campaign being re-ingested. SKUs are preserved (upserted via ON CONFLICT).
 *
 * Kept as a utility for manual data reset; NOT called by the pipeline anymore.
 */
export async function cleanChainData(chainSlug: string): Promise<void> {
  const chainResult = await query('SELECT id FROM chains WHERE slug = $1', [chainSlug]);
  if (chainResult.rows.length === 0) return;
  const chainId = chainResult.rows[0].id;
  const del1 = await query('DELETE FROM offers WHERE sku_id IN (SELECT id FROM product_skus WHERE chain_id = $1)', [chainId]);
  const del2 = await query('DELETE FROM product_skus WHERE chain_id = $1', [chainId]);
  if (del1.rowCount || del2.rowCount) {
    console.log(`[${chainSlug}] cleaned ${del1.rowCount} offers + ${del2.rowCount} SKUs (manual reset)`);
  }
}

/**
 * Clean only the offers for a specific campaign, preserving SKUs and history.
 * Called before re-ingesting a campaign to ensure idempotent re-runs without
 * destroying cross-campaign data or churning SKU primary keys.
 */

export async function ingestJobResult(
  resultPath: string,
  chainSlug: string,
): Promise<IngestStats> {
  const raw = readFileSync(resultPath, 'utf-8');
  const jobResult = JSON.parse(raw) as JobResult;

  const stats: IngestStats = {
    chain: chainSlug,
    campaignId: 0,
    productsExtracted: 0,
    productsIngested: 0,
    productsSkipped: 0,
    errors: [],
  };

  // Get chain ID — some parser chains map to a parent DB chain (e.g. conad-flyer → conad)
  const dbSlug = chainSlug.replace(/-flyer$/, '');
  const chainResult = await query('SELECT id FROM chains WHERE slug = $1', [dbSlug]);
  if (chainResult.rows.length === 0) {
    throw new Error(`Chain not found: ${dbSlug} (from ${chainSlug})`);
  }
  const chainId = chainResult.rows[0].id;

  // Resolve which store this scrape belongs to.
  //
  // Two entry points:
  //   (a) url-list chains — match the scrape's sourceUrl against the registry's store list
  //   (b) per-scrape store context — the runner attaches jobResult.results[0].store
  //       (used by conad-flyer, which discovers stores at runtime rather than
  //       reading them from stores.yaml). Previously ignored, which meant multiple
  //       store flyers for the same week collided on the campaign-level DELETE.
  //
  // For aggregator/national chains (storeId stays null) offers apply chain-wide.
  const chainConfig = getChainConfig(chainSlug);
  let storeId: number | null = null;
  const runtimeStore = (jobResult.results[0] as { store?: { externalId: string; name: string; city?: string; province?: string } })?.store;

  if (runtimeStore) {
    const existing = await query(
      'SELECT id FROM stores WHERE chain_id = $1 AND external_id = $2',
      [chainId, runtimeStore.externalId],
    );
    if (existing.rows.length > 0) {
      storeId = existing.rows[0].id;
    } else {
      const created = await query(
        `INSERT INTO stores (chain_id, external_id, name, city, province, is_active)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [chainId, runtimeStore.externalId, runtimeStore.name, runtimeStore.city ?? null, runtimeStore.province ?? null],
      );
      storeId = created.rows[0].id;
    }
    console.log(`[${chainSlug}] linked to runtime store: ${runtimeStore.name} (id=${storeId}, external=${runtimeStore.externalId})`);
  } else if (chainConfig?.strategy === 'url-list' && chainConfig.stores) {
    const firstUrl = jobResult.results[0]?.sourceUrl ?? '';
    const matchedStore = chainConfig.stores.find(s => firstUrl.includes(s.slug));
    if (matchedStore) {
      const existing = await query(
        'SELECT id FROM stores WHERE chain_id = $1 AND external_id = $2',
        [chainId, matchedStore.slug],
      );
      if (existing.rows.length > 0) {
        storeId = existing.rows[0].id;
      } else {
        const created = await query(
          `INSERT INTO stores (chain_id, external_id, name, city, province, is_active)
           VALUES ($1, $2, $3, $4, 'VR', true) RETURNING id`,
          [chainId, matchedStore.slug, matchedStore.name, matchedStore.city],
        );
        storeId = created.rows[0].id;
      }
      console.log(`[${chainSlug}] linked to store: ${matchedStore.name} (id=${storeId})`);
    }
  }

  // ── Parse products FIRST so we can derive campaign dates from the data ──

  const allProducts: Array<Record<string, unknown>> = [];

  // Chain-specific parsers: when available, use them INSTEAD of LLM extraction.
  const CHAIN_PARSERS: Record<string, (md: string, url?: string) => Array<Record<string, unknown>>> = {
    aldi: (md, url) => {
      // Date-specific pages (/d.DD-MM-YYYY.html) use a flat list format
      const isDatePage = url && /\/d\.\d{2}-\d{2}-\d{4}\.html/.test(url);
      const parser = isDatePage ? parseAldiDatePage : parseAldiMarkdown;
      return parser(md) as unknown as Array<Record<string, unknown>>;
    },
    famila: (md) => parseFamilaMarkdown(md) as unknown as Array<Record<string, unknown>>,
    lidl: (md, url) => parseLidlMarkdown(md, url) as unknown as Array<Record<string, unknown>>,
    eurospin: (text) => parseEurospinPdfText(text) as unknown as Array<Record<string, unknown>>,
    conad: (md) => parseConadMarkdown(md) as unknown as Array<Record<string, unknown>>,
    'conad-flyer': (text) => parseConadFlyerText(text) as unknown as Array<Record<string, unknown>>,
    despar: (md) => parseDesparMarkdown(md) as unknown as Array<Record<string, unknown>>,
    rossetto: (html) => parseRossettoHtml(html) as unknown as Array<Record<string, unknown>>,
  };
  const chainParser = CHAIN_PARSERS[chainSlug];

  for (const siteResult of jobResult.results) {
    if (chainParser && siteResult.rawMarkdown) {
      const parsed = chainParser(siteResult.rawMarkdown, siteResult.sourceUrl);
      if (parsed.length > 0) {
        console.log(`[${chainSlug}] chain parser extracted ${parsed.length} products from ${siteResult.sourceUrl}`);
        // Propagate promotion-level validity dates to products that don't have their own.
        // E.g. Eurospin monthly flyer: API says April 1-30, individual products don't specify.
        const promoValidFrom = siteResult.validFrom;
        const promoValidTo = siteResult.validTo;
        for (const p of parsed) {
          if (!p.validita_inizio && promoValidFrom) p.validita_inizio = promoValidFrom;
          if (!p.validita_fine && promoValidTo) p.validita_fine = promoValidTo;
        }
        allProducts.push(...parsed);
        continue;
      }
      console.log(`[${chainSlug}] chain parser returned 0 products, falling back to LLM extraction`);
    }

    // Fallback: use LLM-extracted products from deep-research
    const extracted = siteResult.extracted;
    if (Array.isArray(extracted)) {
      allProducts.push(...extracted);
    } else if (typeof extracted === 'object' && extracted !== null) {
      const keys = Object.keys(extracted);
      if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
        for (const v of Object.values(extracted)) {
          if (typeof v === 'object' && v !== null) allProducts.push(v as Record<string, unknown>);
        }
      } else {
        allProducts.push(extracted);
      }
    }
  }

  // ── Enrich products with external image URLs (if provided) ──
  if (jobResult.productImages && Object.keys(jobResult.productImages).length > 0) {
    const imgMap = jobResult.productImages;
    let matched = 0;
    for (const p of allProducts) {
      if (p.image_url) continue; // already has an image
      const name = String(p.prodotto ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!name) continue;

      // Try exact match first
      if (imgMap[name]) {
        p.image_url = imgMap[name];
        matched++;
        continue;
      }

      // Try slash variants: "RAVIOLI DI CARNE/ NOODLES CON VERDURE" → try each part
      if (name.includes('/')) {
        const parts = name.split(/\s*\/\s*/);
        const slashMatch = parts.find(part => part.trim() && imgMap[part.trim()]);
        if (slashMatch) {
          p.image_url = imgMap[slashMatch.trim()];
          matched++;
          continue;
        }
      }

      // Try substring match: find API name that contains the PDF name or vice versa
      for (const [apiName, url] of Object.entries(imgMap)) {
        if (apiName.includes(name) || name.includes(apiName)) {
          p.image_url = url;
          matched++;
          break;
        }
      }
    }
    console.log(`[${chainSlug}] enriched ${matched}/${allProducts.length} products with API images`);
  }

  // ── Determine campaign validity dates ──
  // Priority:
  //   1. Result-level promo dates (set by PDF/flyer discovery APIs — Eurospin monthly, etc.)
  //   2. Product-level dates (e.g. Conad "Dal 1/1 al 30/4" parsed per product)
  //   3. Default: current week (Mon → Sun)
  const now = new Date();
  const weekStart = getMonday(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const promoFrom = jobResult.results[0]?.validFrom;
  const promoTo = jobResult.results[0]?.validTo;

  let campaignFrom = promoFrom ?? localDateStr(weekStart);
  let campaignTo = promoTo ?? localDateStr(weekEnd);

  // If no result-level dates, try to derive from parsed products (covers Conad quarterly etc.)
  if (!promoFrom && !promoTo && allProducts.length > 0) {
    const productDates = allProducts
      .filter(p => p.validita_inizio && p.validita_fine)
      .map(p => ({ from: String(p.validita_inizio), to: String(p.validita_fine) }));
    if (productDates.length > 0) {
      // Use the most common (from, to) pair — covers the dominant campaign window
      const dateCounts = new Map<string, number>();
      for (const d of productDates) {
        const key = `${d.from}|${d.to}`;
        dateCounts.set(key, (dateCounts.get(key) ?? 0) + 1);
      }
      let bestKey = '';
      let bestCount = 0;
      for (const [key, count] of dateCounts) {
        if (count > bestCount) { bestKey = key; bestCount = count; }
      }
      if (bestKey) {
        const [derivedFrom, derivedTo] = bestKey.split('|');
        campaignFrom = derivedFrom;
        campaignTo = derivedTo;
        console.log(`[${chainSlug}] campaign dates derived from products: ${campaignFrom} → ${campaignTo} (${bestCount}/${productDates.length} products)`);
      }
    }
  }

  // Upsert campaign: one per chain per validity window. Re-running the pipeline for the
  // same period updates the existing campaign rather than creating a duplicate.
  const campaignResult = await query(
    `INSERT INTO flyer_campaigns (chain_id, valid_from, valid_to, research_job_id, scrape_status, raw_result_path)
     VALUES ($1, $2, $3, $4, 'scraped', $5)
     ON CONFLICT (chain_id, valid_from) DO UPDATE SET
       valid_to = EXCLUDED.valid_to,
       research_job_id = EXCLUDED.research_job_id,
       raw_result_path = EXCLUDED.raw_result_path,
       scrape_status = 'scraped',
       updated_at = now()
     RETURNING id`,
    [chainId, campaignFrom, campaignTo, jobResult.jobId, resultPath],
  );

  stats.campaignId = campaignResult.rows[0].id;

  stats.productsExtracted = allProducts.length;

  // SAFETY GUARD: if the parser produced zero products, do NOT clean the
  // existing offers for this campaign. A 0-product ingest is almost always
  // a parser failure (e.g. Conad multi-PDF where one PDF is unparseable
  // wipes the offers loaded by the previous PDF in the same campaign window;
  // CRAI Shopfully fallback returns 0 hotspots; Aldi date-page parser
  // returns []). The previous behaviour wiped the campaign clean, which
  // turned a transient parser miss into permanent data loss.
  if (allProducts.length === 0) {
    await query(
      `UPDATE flyer_campaigns
         SET scrape_status = 'empty',
             products_extracted = 0,
             products_ingested = 0,
             updated_at = now()
       WHERE id = $1`,
      [stats.campaignId],
    );
    stats.errors.push('parser returned 0 products — existing offers preserved');
    console.warn(`[${chainSlug}] ⚠ parser returned 0 products for campaign ${stats.campaignId}; skipping clean+insert to preserve existing offers`);
    return stats;
  }

  // Insert each product into staging.
  // IMPORTANT: the campaign clean + re-insert must run in a single transaction.
  // If we cleaned outside the transaction (previous behaviour) and the insert
  // loop then crashed mid-way, the campaign would be left either empty or
  // partially reloaded until the next scheduled run. Keeping the DELETE inside
  // the transaction means old offers remain visible to readers until the new
  // ones are ready to commit atomically.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Scope the pre-insert clean by store(s) when this ingest is for a known
    // store-set (e.g. conad-flyer runs one campaign per chain/week but offers
    // are per-store; without this scope, store B's run wipes store A's offers).
    //
    // Three cases, in priority order:
    //   1. targetStoreIds attached by runner → multi-store fan-out (Esselunga
    //      per-pubid). Clean only the rows for those specific stores so a
    //      sibling pubid (different store-set, same campaign) is preserved.
    //   2. single resolved storeId → conad-flyer/url-list path.
    //   3. neither → chain-wide ingest, wipe everything in the campaign.
    const runtimeTargetStoreIdsForClean = (jobResult.results[0] as { targetStoreIds?: number[] })?.targetStoreIds;
    let cleanResult: { rowCount: number | null };
    let cleanScope: string;
    if (runtimeTargetStoreIdsForClean && runtimeTargetStoreIdsForClean.length > 0) {
      cleanResult = await client.query(
        'DELETE FROM offers WHERE campaign_id = $1 AND store_id = ANY($2::int[])',
        [stats.campaignId, runtimeTargetStoreIdsForClean],
      );
      cleanScope = `stores [${runtimeTargetStoreIdsForClean.join(',')}]`;
    } else if (storeId !== null) {
      cleanResult = await client.query(
        'DELETE FROM offers WHERE campaign_id = $1 AND store_id = $2',
        [stats.campaignId, storeId],
      );
      cleanScope = `store ${storeId}`;
    } else {
      cleanResult = await client.query(
        'DELETE FROM offers WHERE campaign_id = $1',
        [stats.campaignId],
      );
      cleanScope = '(chain-wide + all stores)';
    }
    if (cleanResult.rowCount) {
      console.log(`  cleaned ${cleanResult.rowCount} existing offers for campaign ${stats.campaignId} ${cleanScope}`);
    }

    // For Migross: preload store IDs grouped by format so per-promotion offers
    // can be fanned out across the applicable stores. Each Migross SMT promotion
    // (Superstore / Market / Vini / Grandi Marche / …) targets a subset of the
    // 29 stores; without this fan-out every offer would show up as chain-wide
    // and users couldn't tell which specific store carries it.
    const migrossStoresByFormat: Record<string, number[]> = { supermarket: [], market: [], cashcarry: [], all: [] };
    if (chainSlug === 'migross') {
      const rows = await client.query(
        `SELECT id, name FROM stores WHERE chain_id = $1 AND is_active`,
        [chainId],
      );
      for (const s of rows.rows) {
        const n = String(s.name);
        migrossStoresByFormat.all.push(s.id);
        if (/^Migross Supermarket\b/i.test(n) || /^Migross Superstore\b/i.test(n)) migrossStoresByFormat.supermarket.push(s.id);
        else if (/^Migross Market\b/i.test(n)) migrossStoresByFormat.market.push(s.id);
        else if (/Cash\s*&?\s*Carry/i.test(n)) migrossStoresByFormat.cashcarry.push(s.id);
      }
      console.log(`[migross] store fan-out index: supermarket=${migrossStoresByFormat.supermarket.length} market=${migrossStoresByFormat.market.length} cashcarry=${migrossStoresByFormat.cashcarry.length} all=${migrossStoresByFormat.all.length}`);
    }

    function migrossTargetStoreIds(promotionDescription: string | null | undefined): number[] {
      if (chainSlug !== 'migross') return [];
      if (!promotionDescription) return migrossStoresByFormat.all;
      const d = promotionDescription.toLowerCase();
      if (/pet\s*store|buddy/.test(d)) return []; // skip petstore promos
      const ids = new Set<number>();
      if (/superstore|super/.test(d)) migrossStoresByFormat.supermarket.forEach(id => ids.add(id));
      if (/market|supermercat/.test(d)) migrossStoresByFormat.market.forEach(id => ids.add(id));
      if (/cash\s*carry|cash&carry/.test(d)) migrossStoresByFormat.cashcarry.forEach(id => ids.add(id));
      if (ids.size === 0) return migrossStoresByFormat.all;
      return [...ids];
    }

    for (const product of allProducts) {
      const rawName = String(product.prodotto ?? product.product_name ?? product.nome_prodotto ?? '').trim();
      const rawPrice = String(product.prezzo_offerta ?? product.price ?? '');

      if (!rawName || !rawPrice) {
        stats.productsSkipped++;
        continue;
      }

      const price = parsePrice(rawPrice);
      if (price === null) {
        stats.productsSkipped++;
        stats.errors.push(`Unparseable price: ${rawPrice} for ${rawName}`);
        continue;
      }

      // Normalize raw_quantity so case/spacing variations ("1 L" vs "1 l" vs "1  l")
      // collide on the unique constraint and don't ingest as different SKUs.
      const rawQuantity = String(product.quantita_peso ?? product.quantity ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const rawBrand = String(product.brand ?? product.marca ?? '');
      const rawDiscount = String(product.sconto_percentuale ?? product.discount ?? '');
      const rawMechanic = String(product.tipo_offerta ?? product.mechanic ?? '');

      // Use parser-provided validity dates when available (e.g. Lidl Thu-Tue, Famila biweekly)
      // Fall back to campaign week dates only if the parser didn't provide dates.
      const productValidFrom = product.validita_inizio
        ? String(product.validita_inizio)
        : localDateStr(weekStart);
      const productValidTo = product.validita_fine
        ? String(product.validita_fine)
        : localDateStr(weekEnd);

      const quantity = parseQuantity(rawQuantity || null);
      const mechanic = parseMechanic(rawMechanic || null, rawDiscount || null);
      // Prefer parser-provided unit price (e.g. Famila gives us €/kg directly)
      const parserUnitPrice = product.prezzo_al_kg !== undefined && product.prezzo_al_kg !== null
        ? Number(product.prezzo_al_kg)
        : null;
      const unitPrice = parserUnitPrice ?? (quantity ? computeUnitPrice(price, quantity) : null);

      const originalPrice = parsePrice(String(product.prezzo_originale ?? product.original_price ?? ''));
      // Prefer parser-provided discount percent (e.g. Famila gives us this directly)
      const parserDiscount = product.sconto_percentuale !== undefined && product.sconto_percentuale !== null
        ? Number(product.sconto_percentuale)
        : null;
      const rawDiscountPct = parserDiscount
        ?? mechanic.discountPct
        ?? (originalPrice && price < originalPrice ? Math.round((1 - price / originalPrice) * 100) : null);
      // Sanitize: discard nonsensical discounts (>= 90% is almost certainly a data error,
      // e.g. loyalty points "100" parsed as discount percentage)
      const discountPct = rawDiscountPct !== null && rawDiscountPct > 0 && rawDiscountPct < 90
        ? rawDiscountPct : null;

      // Image URL — parsers may provide it as immagine_url or image_url
      // Validate against allowed hostnames to prevent tracking/abuse
      const rawImageUrl = String(product.immagine_url ?? product.image_url ?? '') || null;
      const IMAGE_HOST_ALLOWLIST = [
        'migross.it', 'lidl.it', 'conad.it', 'eurospin.it',
        'rossettogroup.it', 'maxidi.it', 'famila.it', 'despar.it',
        'digitalflyer.eurospin.it', 'b-cdn.ipaper.io',
        // Spesify's own crop-serving endpoint (populated by parsers/shopfully-vision-fetch.ts)
        'spesify.xyz',
      ];
      let imageUrl: string | null = null;
      if (rawImageUrl) {
        try {
          const host = new URL(rawImageUrl).hostname;
          if (IMAGE_HOST_ALLOWLIST.some(allowed => host === allowed || host.endsWith('.' + allowed))) {
            imageUrl = rawImageUrl;
          }
        } catch { /* invalid URL — skip */ }
      }

      try {
        await client.query('SAVEPOINT product_insert');

        // Parser-supplied EAN + specifications. Stored alongside the SKU for
        // cross-chain identity (EAN) and future enrichment (specifications is
        // a free-form JSONB that parsers fill with whatever metadata they can
        // extract — energy class, alcohol %, nutrition, origin, etc.).
        // Only keep digits-only EANs of plausible length (8–14) so noise from
        // vision extraction ("COD. 12345 PROMO") doesn't pollute the column.
        const rawEanCandidate = String(product.ean ?? product.gtin ?? product.barcode ?? '').replace(/\D/g, '');
        const ean = rawEanCandidate.length >= 8 && rawEanCandidate.length <= 14 ? rawEanCandidate : null;
        const specifications = (product.specifications && typeof product.specifications === 'object')
          ? JSON.stringify(product.specifications)
          : '{}';

        // Find or create SKU (product_id is nullable — canonical match comes later).
        // EAN + specifications use COALESCE-on-conflict so a richer later ingest
        // (e.g. one that had the EAN visible) progressively fills in sparser
        // rows from earlier ingests of the same product.
        const skuResult = await client.query(
          `INSERT INTO product_skus (product_id, chain_id, raw_name, brand, raw_quantity, quantity_value, quantity_unit, confidence, image_url, ean, specifications)
           VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (chain_id, raw_name, raw_quantity) DO UPDATE SET
             updated_at = now(),
             image_url = COALESCE(EXCLUDED.image_url, product_skus.image_url),
             ean = COALESCE(EXCLUDED.ean, product_skus.ean),
             specifications = product_skus.specifications || EXCLUDED.specifications
           RETURNING id`,
          [
            chainId,
            rawName,
            rawBrand || null,
            rawQuantity || null,
            quantity?.baseValue ?? null,
            quantity?.baseUnit ?? null,
            quantity?.confidence ?? null,
            imageUrl,
            ean,
            specifications,
          ],
        );
        const skuId = skuResult.rows[0].id;

        const requiresCard = product.requires_card === true || mechanic.type === 'loyalty_price';
        // Normalize card name: strip a leading chain slug if the vision pass prefixed
        // it (e.g. "MD Buona Spesa Card" → "Buona Spesa Card"). The chain is already
        // associated with the offer via sku_id → chain_id, so the prefix is redundant
        // and creates duplicate string variants in aggregation queries.
        const cardName = requiresCard && product.card_name
          ? String(product.card_name).trim().replace(new RegExp(`^${chainSlug}\\s+`, 'i'), '').trim() || null
          : null;
        // When the vision extractor flagged a loyalty-card requirement but couldn't
        // match it to a known mechanic regex, force mechanic=loyalty_price so the
        // DB correctly categorises the offer type (price_cut would be misleading).
        const finalMechanicType = requiresCard ? 'loyalty_price' : mechanic.type;

        // Fan-out resolution priority:
        //   1. If the runner attached `targetStoreIds` to the result (currently
        //      Esselunga, where one publication serves a known store-set —
        //      e.g. pub 824458 = Verona/Fiera, pub 824460 = Verona/CorsoMilano
        //      + Verona/Fincato), use that list verbatim. Each offer is
        //      duplicated once per store_id so "Vicino a me" can find them.
        //   2. Migross: derive stores from the promotion description (each
        //      promo applies to a subset of stores defined by name prefix).
        //   3. Everything else: single insert with whatever storeId the
        //      runner resolved (often NULL for chain-wide).
        const runtimeTargetStoreIds = (jobResult.results[0] as { targetStoreIds?: number[] })?.targetStoreIds;
        const targetStoreIds: Array<number | null> = (runtimeTargetStoreIds && runtimeTargetStoreIds.length > 0)
          ? runtimeTargetStoreIds
          : chainSlug === 'migross'
            ? (() => {
                const ids = migrossTargetStoreIds(
                  product.promotion_description ? String(product.promotion_description) : null,
                );
                // Empty result means "petstore-only promo, skip". Drop the offer.
                return ids.length > 0 ? ids : [];
              })()
            : [storeId];

        for (const targetStoreId of targetStoreIds) {
          await client.query(
            `INSERT INTO offers (
               sku_id, campaign_id, store_id, offer_price, original_price, unit_price, discount_pct,
               mechanic, mechanic_detail, requires_card, card_name, valid_from, valid_to,
               extraction_confidence, raw_text
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::offer_mechanic, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT DO NOTHING`,
            [
              skuId,
              stats.campaignId,
              targetStoreId,
              price,
              originalPrice,
              unitPrice,
              discountPct,
              finalMechanicType,
              JSON.stringify(mechanic.detail),
              requiresCard,
              cardName,
              productValidFrom,
              productValidTo,
              mechanic.confidence,
              `${rawName} ${rawPrice} ${rawDiscount}`.trim(),
            ],
          );
        }

        stats.productsIngested++;
        await client.query('RELEASE SAVEPOINT product_insert');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT product_insert');
        stats.productsSkipped++;
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push(`${rawName}: ${msg}`);
      }
    }

    // Update campaign stats
    await client.query(
      `UPDATE flyer_campaigns
       SET scrape_status = 'loaded', products_extracted = $1, products_ingested = $2
       WHERE id = $3`,
      [stats.productsExtracted, stats.productsIngested, stats.campaignId],
    );

    // Populate price_history from the offers just inserted.
    // Aggregates min/max price per SKU per week for trend tracking.
    await client.query(`
      INSERT INTO price_history (sku_id, week_start, min_price, max_price, is_promo_week,
                                 mechanic, min_unit_price, max_unit_price,
                                 reference_price, reference_unit_price, campaign_id)
      SELECT
        o.sku_id,
        date_trunc('week', o.valid_from)::date AS week_start,
        MIN(o.offer_price),
        MAX(o.offer_price),
        true,
        (array_agg(o.mechanic ORDER BY o.offer_price))[1],
        MIN(o.unit_price),
        MAX(o.unit_price),
        MIN(o.original_price),
        MIN(CASE WHEN o.original_price IS NOT NULL AND o.unit_price IS NOT NULL
                 THEN o.unit_price * (o.original_price / NULLIF(o.offer_price, 0))
            END),
        $1
      FROM offers o
      WHERE o.campaign_id = $1
      GROUP BY o.sku_id, date_trunc('week', o.valid_from)::date
      ON CONFLICT (sku_id, week_start) DO UPDATE SET
        min_price = LEAST(price_history.min_price, EXCLUDED.min_price),
        max_price = GREATEST(price_history.max_price, EXCLUDED.max_price),
        min_unit_price = LEAST(price_history.min_unit_price, EXCLUDED.min_unit_price),
        max_unit_price = GREATEST(price_history.max_unit_price, EXCLUDED.max_unit_price),
        campaign_id = EXCLUDED.campaign_id
    `, [stats.campaignId]);

    await client.query('COMMIT');

    // Refresh macro-category tags after successful ingest
    await query('SELECT refresh_product_tags()');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return stats;
}

function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Format a Date as YYYY-MM-DD in local timezone (NOT UTC).
 *  Using toISOString().split('T')[0] is wrong in CEST — it can be 1 day behind. */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const [resultPath, chain] = process.argv.slice(2);
  if (!resultPath || !chain) {
    console.error('Usage: node ingest.js <result-json-path> <chain-slug>');
    process.exit(1);
  }
  ingestJobResult(resultPath, chain)
    .then(stats => {
      console.log(JSON.stringify(stats, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
