#!/usr/bin/env node
/**
 * SpesaBot Pipeline Runner
 *
 * Orchestrates weekly supermarket scraping:
 * 1. For each chain: scrape flyer via deep-research pipeline
 * 2. Ingest results into PostgreSQL
 * 3. Send summary alert via Telegram
 *
 * Run: node dist/runner.js
 * Or:  systemctl start spesabot-pipeline.service
 */
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { ingestJobResult } from './ingest.js';
import { sendPipelineSummary, sendAlert, type PipelineSummary } from './alerts.js';
import { close as closeDb, query } from './db.js';
import { getScrapeTargets, getChainConfig, listChains } from './store-registry.js';
import { extractPdfText } from './parsers/eurospin.js';
import { fetchEurospinProductImages } from './parsers/eurospin-url-discovery.js';
import { discoverDesparFlyerUrl, fetchDesparFlyerText } from './parsers/despar-flyer-fetch.js';
import { discoverConadFlyers, fetchConadFlyerText, listConadStores } from './parsers/conad-flyer-discovery.js';
import { fetchFamilaProductsForStore } from './parsers/famila-api.js';
import { fetchAndParseRossetto } from './parsers/rossetto.js';
import { fetchGruppoPoliChain, GRUPPOPOLI_CHAINS } from './parsers/gruppopoli.js';
import { fetchMigrossProducts } from './parsers/migross.js';
import { fetchConadBassiProducts } from './parsers/conad-bassi-fetch.js';
import { fetchShopfullyProducts } from './parsers/shopfully-vision-fetch.js';
import { resolveShopfullyPubId, discoverShopfullyMultiPubForChain } from './parsers/shopfully-pub-discovery.js';

// Deep-research pipeline imports (direct, no MCP overhead)
const DEEP_RESEARCH_DIR = process.env.DEEP_RESEARCH_DIR
  ?? '/home/kos/job-desk/tools/deep-research';

// Dynamic import to avoid compile-time coupling
async function loadPipeline() {
  const distDir = join(DEEP_RESEARCH_DIR, 'dist');
  const { createJob, getJob } = await import(join(distDir, 'queue', 'job-queue.js'));
  const { executeJob } = await import(join(distDir, 'pipeline.js'));
  const { closeBrowser } = await import(join(distDir, 'fetchers', 'playwright.js'));
  const { loadDomainConfig } = await import(join(distDir, 'config.js'));
  return { createJob, getJob, executeJob, closeBrowser, loadDomainConfig };
}

// Active chains from env or default to all chains in the registry
const ACTIVE_CHAINS = process.env.SPESABOT_CHAINS
  ? process.env.SPESABOT_CHAINS.split(',')
  : listChains();

// Delay between chains to avoid rate-limiting. Configurable via env for tuning.
// On a mini PC with limited RAM, sequential execution is safer than parallelism
// since each chain may spawn a full browser context via deep-research.
const INTER_CHAIN_DELAY_MS = parseInt(process.env.SPESABOT_CHAIN_DELAY_MS ?? '30000', 10);

// Chains that have a regex/PDF parser registered in ingest.ts CHAIN_PARSERS.
// For these, the deep-research pipeline should skip its (expensive, often failing)
// LLM extraction step and just return rawMarkdown — the chain parser handles the rest.
const CHAINS_WITH_PARSER = new Set(['aldi', 'famila', 'lidl', 'eurospin', 'conad', 'conad-flyer', 'despar', 'rossetto', 'md', 'crai', 'dpiu', 'esselunga']);

// Chains whose flyer is only accessible via Shopfully aggregator (doveconviene/promoqui)
// and scraped via page-image-crop + Gemini vision OCR. Configure publication ids via
// {SLUG}_SHOPFULLY_PUBLICATION_ID env vars. Publication ids rotate with each new flyer.
const SHOPFULLY_CHAINS = new Set(['md', 'crai', 'dpiu', 'esselunga']);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a multi-publication Shopfully ingest for a chain whose flyer varies
 * by store-group within the same city (today: Esselunga). Reads the env
 * var {SLUG}_PUBLICATIONS as a JSON array of `{pubId, externalIds[]}`,
 * and for each entry: fetches the publication, resolves external_ids →
 * stores.id, builds a synthetic JobResult with `targetStoreIds`, and
 * runs ingest. The ingest layer fans each offer across the target store
 * set and clean-deletes only those stores' rows from the campaign so a
 * sibling pub for a different store-group is not wiped on the same run.
 *
 * Returns true if at least one publication succeeded with > 0 products.
 */
async function runShopfullyMultiPub(
  chain: string,
  envJson: string,
  summary: PipelineSummary,
  chainIndex: number,
): Promise<boolean> {
  let entries: Array<{ pubId: string; externalIds: string[] }>;
  try {
    const parsed = JSON.parse(envJson);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    entries = parsed.map((e) => ({
      pubId: String(e.pubId),
      externalIds: Array.isArray(e.externalIds) ? e.externalIds.map(String) : [],
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${chain}] ${chain.toUpperCase()}_PUBLICATIONS env is not valid JSON: ${msg}`);
    summary.failed.push({ chain, error: `invalid ${chain.toUpperCase()}_PUBLICATIONS JSON` });
    return false;
  }

  // Resolve all external_ids → store.id once up front so we fail fast if
  // the seed migration wasn't applied or the IDs don't match.
  const allExternalIds = [...new Set(entries.flatMap((e) => e.externalIds))];
  const storeRows = await query<{ id: number; external_id: string }>(
    `SELECT s.id, s.external_id
       FROM stores s
       JOIN chains c ON c.id = s.chain_id
       WHERE c.slug = $1 AND s.external_id = ANY($2::text[])`,
    [chain, allExternalIds],
  );
  const externalToStoreId = new Map<string, number>();
  for (const r of storeRows.rows) externalToStoreId.set(r.external_id, r.id);
  const missing = allExternalIds.filter((eid) => !externalToStoreId.has(eid));
  if (missing.length > 0) {
    console.error(`[${chain}] external_ids missing in DB: ${missing.join(', ')}. Apply the seed migration before re-running.`);
    summary.failed.push({ chain, error: `missing stores: ${missing.join(',')}` });
    return false;
  }

  let anySuccess = false;
  for (const entry of entries) {
    const targetStoreIds = entry.externalIds.map((eid) => externalToStoreId.get(eid)!).filter(Boolean);
    console.log(`\n[${chainIndex + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (Shopfully pub ${entry.pubId} → stores [${targetStoreIds.join(',')}])...`);
    try {
      const result = await fetchShopfullyProducts(entry.pubId, chain);
      console.log(`  extracted ${result.products.length} products from ${result.hotspotsTotal} hotspots (${result.visionErrors} vision errors, ${result.hotspotsSkipped} skipped)`);

      if (result.validFrom && result.validTo) {
        const today = new Date().toISOString().slice(0, 10);
        if (today < result.validFrom || today > result.validTo) {
          // Hard-fail on stale Shopfully publications (override with
          // ALLOW_STALE_SHOPFULLY=true). Previously we logged a warning and
          // ingested anyway — that produced "loaded" CRAI campaigns with 0
          // active offers, since every offer's valid_to was already past.
          if (process.env.ALLOW_STALE_SHOPFULLY !== 'true') {
            console.error(`[${chain}] ✗ refusing to ingest stale flyer ${result.validFrom} → ${result.validTo} (today=${today}). Pub ${entry.pubId} is stale; set ALLOW_STALE_SHOPFULLY=true to override.`);
            summary.failed.push({ chain: `${chain}#${entry.pubId}`, error: `stale flyer ${result.validFrom}→${result.validTo}` });
            continue;
          }
          console.warn(`[${chain}] ⚠ flyer validity ${result.validFrom} → ${result.validTo} does NOT cover today (${today}). Ingesting under ALLOW_STALE_SHOPFULLY override.`);
        }
      } else {
        console.warn(`[${chain}] ⚠ flyer validity dates could not be extracted — products will use fallback current-week window.`);
      }

      const ts = Date.now();
      const tmpJson = `/tmp/spesabot-${chain}-${entry.pubId}-${ts}.json`;
      const sourceUrl = `https://www.doveconviene.it/volantino/${chain}`;
      const synthetic = {
        jobId: `shopfully-${chain}-${entry.pubId}-${ts}`,
        query: `${chain} Shopfully vision scrape pub ${entry.pubId}`,
        domain: 'supermarket-deals',
        project: 'spesabot',
        startedAt: new Date(ts).toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - ts) / 1000),
        sites: [{ url: sourceUrl, method: 'shopfully-vision', status: 'success', fetchTimeMs: Date.now() - ts }],
        results: [{
          sourceUrl,
          title: `${chain} weekly flyer (pub ${entry.pubId})`,
          extracted: result.products,
          validFrom: result.validFrom ?? undefined,
          validTo: result.validTo ?? undefined,
          targetStoreIds,
        }],
      };
      writeFileSync(tmpJson, JSON.stringify(synthetic));
      const stats = await ingestJobResult(tmpJson, chain);
      if (stats.productsIngested > 0) {
        summary.succeeded.push({ chain: `${chain}#${entry.pubId}`, products: stats.productsIngested });
        console.log(`${chain}#${entry.pubId}: ${stats.productsIngested} offers ingested across ${targetStoreIds.length} store(s)`);
        anySuccess = true;
      } else {
        summary.failed.push({ chain: `${chain}#${entry.pubId}`, error: stats.errors[0] ?? 'Ingest returned 0 products' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    error: ${msg}`);
      summary.failed.push({ chain: `${chain}#${entry.pubId}`, error: msg });
    }
  }
  return anySuccess;
}

/**
 * Download a chain's monthly PDF flyer, extract its raw text, synthesize a JobResult
 * JSON file, and feed it through the normal ingest path. The chain's parser
 * (registered in ingest.CHAIN_PARSERS) handles the raw text as if it were markdown.
 */
async function ingestPdfChain(chain: string, pdfUrl: string, validFrom?: string, validTo?: string, productImages?: Record<string, string>) {
  const ts = Date.now();
  const tmpPdf = `/tmp/spesabot-${chain}-${ts}.pdf`;
  const tmpJson = `/tmp/spesabot-${chain}-${ts}.json`;

  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  writeFileSync(tmpPdf, buf);
  console.log(`  downloaded ${(buf.length / 1024).toFixed(0)} KB → ${tmpPdf}`);

  const text = extractPdfText(tmpPdf);
  console.log(`  extracted ${text.split('\n').length} lines of text`);

  // Synthesize a JobResult JSON the ingest pipeline understands.
  // The chain parser receives `rawMarkdown` and returns structured products.
  const synthetic = {
    jobId: `pdf-${chain}-${ts}`,
    query: `PDF flyer ingest for ${chain}`,
    domain: 'supermarket-deals',
    project: 'spesabot',
    startedAt: new Date(ts).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - ts) / 1000),
    sites: [{ url: pdfUrl, method: 'pdf-fetch', status: 'success', fetchTimeMs: Date.now() - ts }],
    results: [{
      sourceUrl: pdfUrl,
      title: `${chain} monthly PDF flyer`,
      extracted: [],
      rawMarkdown: text,
      // Pass promotion dates so products get correct validity (not generic week dates)
      validFrom,
      validTo,
    }],
    // Optional: per-product image URLs from an external API (e.g. Eurospin digitalflyer)
    productImages: productImages ?? undefined,
  };
  writeFileSync(tmpJson, JSON.stringify(synthetic));

  return ingestJobResult(tmpJson, chain);
}

/**
 * Ingest text extracted from a digital flyer (iPaper or similar).
 * Creates a synthetic JobResult JSON and feeds it through the normal ingest path,
 * where the chain's parser (registered in CHAIN_PARSERS) handles the text.
 */
async function ingestFlyerText(
  chain: string,
  text: string,
  sourceUrl: string,
  store?: { externalId: string; name: string; city?: string; province?: string },
) {
  const ts = Date.now();
  const tmpJson = `/tmp/spesabot-${chain}-flyer-${ts}.json`;
  const synthetic = {
    jobId: `flyer-${chain}-${ts}`,
    query: `Digital flyer ingest for ${chain}${store ? ` @ ${store.name}` : ''}`,
    domain: 'supermarket-deals',
    project: 'spesabot',
    startedAt: new Date(ts).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - ts) / 1000),
    sites: [{ url: sourceUrl, method: 'ipaper-fetch', status: 'success', fetchTimeMs: Date.now() - ts }],
    results: [{
      sourceUrl,
      title: `${chain} weekly flyer${store ? ` — ${store.name}` : ''}`,
      extracted: [],
      rawMarkdown: text,
      // Store context is consumed by ingest.ts to scope offers per-store. Without
      // this, multiple stores under the same chain+week would collide on the
      // campaign-level DELETE and wipe each other's offers.
      store: store ?? undefined,
    }],
  };
  writeFileSync(tmpJson, JSON.stringify(synthetic));
  return ingestJobResult(tmpJson, chain);
}

async function main(): Promise<void> {
  console.log(`SpesaBot Pipeline starting — ${ACTIVE_CHAINS.length} chains: ${ACTIVE_CHAINS.join(', ')}`);
  const startTime = Date.now();

  const pipeline = await loadPipeline();
  const domainConfig = pipeline.loadDomainConfig('supermarket-deals');

  const summary: PipelineSummary = {
    succeeded: [],
    failed: [],
    durationSeconds: 0,
  };

  for (let i = 0; i < ACTIVE_CHAINS.length; i++) {
    const chain = ACTIVE_CHAINS[i];
    const chainConfig = getChainConfig(chain);

    // Chains with parser: unimplemented are intentionally seeded (rows in the
    // chains table, cross-chain views, etc.) but have no working scraper yet.
    // Skip cleanly — don't count them as a failure in the summary, since
    // "no scraper yet" is the expected state, not an error.
    if (chainConfig?.parser === 'unimplemented') {
      console.log(`[${chain}] scraper not yet implemented — skipping (config entry present for future use)`);
      continue;
    }

    // Campaign-scoped cleanup now happens inside ingestJobResult() —
    // only the specific campaign's offers are deleted before re-insert,
    // preserving SKUs and cross-campaign history.

    // ── Migross: pure API fetch, no Playwright/PDF needed ──
    if (chain === 'migross') {
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (SMT API)...`);
      try {
        const { products, promotion } = await fetchMigrossProducts();
        console.log(`  fetched ${products.length} products from promotion "${promotion.description}"`);
        console.log(`  valid: ${promotion.startDate} → ${promotion.endDate}`);

        // Build synthetic JobResult JSON for the ingest pipeline.
        // Since products are already structured, we serialize them as the "extracted" array.
        const ts = Date.now();
        const tmpJson = `/tmp/spesabot-migross-${ts}.json`;
        const synthetic = {
          jobId: `api-migross-${ts}`,
          query: `API fetch for migross promotion ${promotion.alias}`,
          domain: 'supermarket-deals',
          project: 'spesabot',
          startedAt: new Date(ts).toISOString(),
          completedAt: new Date().toISOString(),
          durationSeconds: Math.round((Date.now() - ts) / 1000),
          sites: [{ url: `https://www.migross.it/digitalflyer/api/migross/migross/promotions/${promotion.alias}`, method: 'api-fetch', status: 'success', fetchTimeMs: Date.now() - ts }],
          results: [{
            sourceUrl: `https://www.migross.it/digitalflyer/api/migross/migross/promotions/${promotion.alias}`,
            title: `Migross ${promotion.description}`,
            extracted: products,
            validFrom: promotion.startDate,
            validTo: promotion.endDate,
          }],
        };
        writeFileSync(tmpJson, JSON.stringify(synthetic));
        const stats = await ingestJobResult(tmpJson, chain);
        if (stats.productsIngested > 0) {
          summary.succeeded.push({ chain, products: stats.productsIngested });
          console.log(`${chain}: ${stats.productsIngested} products ingested`);
        } else {
          summary.failed.push({ chain, error: stats.errors[0] ?? 'API returned 0 products' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── Rossetto: plain HTTP fetch, no Playwright/PDF needed ──
    if (chain === 'rossetto') {
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (HTTP fetch)...`);
      try {
        const products = await fetchAndParseRossetto();
        console.log(`  fetched ${products.length} products from rossettogroup.it`);
        // Build synthetic HTML for the ingest pipeline (parser re-parses it)
        // Instead, directly create a JobResult with the raw HTML
        const resp = await fetch('https://rossettogroup.it/prezzi-rossetto-in-corso/');
        const html = await resp.text();
        const stats = await ingestFlyerText(chain, html, 'https://rossettogroup.it/prezzi-rossetto-in-corso/');
        if (stats.productsIngested > 0) {
          summary.succeeded.push({ chain, products: stats.productsIngested });
          console.log(`${chain}: ${stats.productsIngested} products ingested`);
        } else {
          summary.failed.push({ chain, error: stats.errors[0] ?? 'Parser returned 0 products' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── Gruppo Poli (Poli/Orvea/Regina/Amort): ASP.NET WebForms picker → AJAX category fetch ──
    // Single shared site (gruppopoli.it) with per-(insegna, negozio) session. Each chain
    // is configured with one or more InsegnaStore pairs (see GRUPPOPOLI_CHAINS).
    // For Verona-province scope we currently only enable `orvea` (Peschiera del Garda + Affi).
    if (chain in GRUPPOPOLI_CHAINS) {
      const config = GRUPPOPOLI_CHAINS[chain];
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (Gruppo Poli — ${config.coverage})...`);

      if (!config.enabled || config.stores.length === 0) {
        console.log(`  ${chain} disabled or no stores configured — skipping`);
        if (i < ACTIVE_CHAINS.length - 1) {
          console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
          await sleep(INTER_CHAIN_DELAY_MS);
        }
        continue;
      }

      try {
        const result = await fetchGruppoPoliChain(chain);
        console.log(`  fetched ${result.totalProducts} total products across ${result.stores.length} store(s)`);

        // Group products by negozio_code → one ingest per store with runtimeStore
        const byStore = new Map<string, { label: string; products: typeof result.products }>();
        for (const p of result.products) {
          if (!byStore.has(p.negozio_code)) {
            byStore.set(p.negozio_code, { label: p.negozio_label, products: [] });
          }
          byStore.get(p.negozio_code)!.products.push(p);
        }

        let totalIngested = 0;
        let storesOk = 0;
        let storesEmpty = 0;
        let storesFailed = 0;

        for (const [externalId, group] of byStore) {
          if (group.products.length === 0) {
            storesEmpty++;
            console.warn(`  [${chain}] ${group.label}: 0 products — skipping ingest`);
            continue;
          }

          // Heuristic city/province: infer city from store label (last word of "X City") and stay in VR for now
          const cityMatch = group.label.match(/(?:Orvea|IperOrvea|Poli|IperPoli|MiniPoli|Regina|Amort)\s+(.+)$/);
          const city = cityMatch ? cityMatch[1].trim() : null;

          const ts = Date.now();
          const tmpJson = `/tmp/spesabot-gruppopoli-${chain}-${externalId}-${ts}.json`;
          const synthetic = {
            jobId: `gruppopoli-${chain}-${externalId}-${ts}`,
            query: `gruppopoli.it scrape for ${chain} @ ${group.label}`,
            domain: 'supermarket-deals',
            project: 'spesabot',
            startedAt: new Date(ts).toISOString(),
            completedAt: new Date().toISOString(),
            durationSeconds: Math.round((Date.now() - ts) / 1000),
            sites: [{ url: 'https://www.gruppopoli.it/it/volantino/', method: 'aspnet-postback+ajax', status: 'success', fetchTimeMs: Date.now() - ts }],
            results: [{
              sourceUrl: 'https://www.gruppopoli.it/it/volantino/',
              title: `${chain} flyer @ ${group.label} (${group.products.length} products)`,
              extracted: group.products,
              store: { externalId, name: group.label, city, province: 'VR' },
            }],
          };
          writeFileSync(tmpJson, JSON.stringify(synthetic));

          try {
            const stats = await ingestJobResult(tmpJson, chain);
            totalIngested += stats.productsIngested;
            if (stats.productsIngested > 0) {
              storesOk++;
              console.log(`  [${chain}] ${group.label}: ${stats.productsIngested} products ingested`);
            } else {
              storesEmpty++;
              console.warn(`  [${chain}] ${group.label}: 0 ingested (parser returned ${group.products.length} but ingest dropped them)`);
            }
          } catch (err) {
            storesFailed++;
            console.error(`  [${chain}] ${group.label}: ingest FAILED — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.failures.length > 0) {
          for (const f of result.failures) {
            console.warn(`  [${chain}] fetch FAILURE: ${f.store.label}: ${f.error}`);
          }
          storesFailed += result.failures.length;
        }

        if (storesOk > 0) {
          summary.succeeded.push({ chain: `${chain} (${storesOk}/${config.stores.length} stores)`, products: totalIngested });
          console.log(`${chain}: ${storesOk}/${config.stores.length} stores OK, ${storesEmpty} empty, ${storesFailed} failed, ${totalIngested} total products`);
        } else {
          summary.failed.push({ chain, error: `0/${config.stores.length} stores succeeded (${storesEmpty} empty, ${storesFailed} failed)` });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── iPaper flyer strategy (Despar): self-discovers URL, no targets needed ──
    if (chain === 'despar') {
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (iPaper flyer)...`);
      try {
        console.log(`  discovering current flyer URL...`);
        const flyerUrl = await discoverDesparFlyerUrl();
        console.log(`  flyer: ${flyerUrl}`);
        const result = await fetchDesparFlyerText(flyerUrl);
        console.log(`  extracted ${result.pageCount} spreads, ${result.text.length} chars`);
        const stats = await ingestFlyerText(chain, result.text, flyerUrl);
        if (stats.productsIngested > 0) {
          summary.succeeded.push({ chain, products: stats.productsIngested });
          console.log(`${chain}: ${stats.productsIngested} products ingested from flyer`);
        } else {
          summary.failed.push({ chain, error: stats.errors[0] ?? 'Flyer parser returned 0 products' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── Shopfully + Gemini vision OCR (generic path for aggregator-only chains) ──
    // Any chain whose flyer is only distributed via Shopfully (doveconviene/promoqui
    // embedded viewer). Publication IDs rotate each flyer cycle, so we discover the
    // current one from doveconviene.it automatically; the {SLUG}_SHOPFULLY_PUBLICATION_ID
    // env var is only a fallback if discovery fails (network or layout change on the
    // aggregator page).
    //
    // Multi-publication / per-store fan-out path (e.g. Esselunga):
    // {SLUG}_PUBLICATIONS env var holds a JSON array
    //   [{"pubId":"824458","externalIds":["1020871"]}, …]
    // Each entry is fetched independently and ingested with targetStoreIds
    // resolved from external_ids → store.id, so a flyer that varies by
    // store-group (Verona Fiera vs Corso Milano) isn't double-counted.
    if (SHOPFULLY_CHAINS.has(chain)) {
      const multiPubKey = chain.toUpperCase().replace(/-/g, '_') + '_PUBLICATIONS';
      let multiPubRaw = process.env[multiPubKey];
      let multiPubSource: 'env' | 'auto' | null = null;
      if (multiPubRaw) {
        multiPubSource = 'env';
      } else {
        // Auto-discover multi-pub from live DB stores. Each city in the
        // chain's store list gets probed on doveconviene; external_ids
        // cluster by the resolved pub id. This eliminates the weekly
        // chore of refreshing a static *_PUBLICATIONS env var.
        try {
          const entries = await discoverShopfullyMultiPubForChain(chain, async (slug) => {
            const r = await query<{ external_id: string; city: string }>(
              `SELECT s.external_id, s.city
               FROM stores s JOIN chains c ON c.id = s.chain_id
               WHERE c.slug = $1 AND s.is_active = true
                 AND s.external_id IS NOT NULL AND s.city IS NOT NULL`,
              [slug],
            );
            return r.rows.map(row => ({ externalId: row.external_id, city: row.city }));
          });
          if (entries.length > 0) {
            multiPubRaw = JSON.stringify(entries);
            multiPubSource = 'auto';
            const summarized = entries.map(e => `${e.pubId}→[${e.externalIds.length}]`).join(', ');
            console.log(`[${chain}] auto-discovered ${entries.length} pub group(s): ${summarized}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${chain}] multi-pub auto-discovery failed: ${msg} — falling back to single-pub`);
        }
      }
      if (multiPubRaw) {
        if (multiPubSource === 'env') {
          console.log(`[${chain}] using ${multiPubKey} env override (${multiPubRaw.length} chars)`);
        }
        const ok = await runShopfullyMultiPub(chain, multiPubRaw, summary, i);
        if (i < ACTIVE_CHAINS.length - 1) await sleep(INTER_CHAIN_DELAY_MS);
        if (!ok) continue;
        continue;
      }
      const envKey = chain.toUpperCase().replace(/-/g, '_') + '_SHOPFULLY_PUBLICATION_ID';
      const envFallback = process.env[envKey];
      // Some chains (Esselunga) only embed the viewer on city-specific
      // doveconviene pages, not the national directory. Set
      // {SLUG}_SHOPFULLY_CITY to a city slug where the chain has stores.
      const cityKey = chain.toUpperCase().replace(/-/g, '_') + '_SHOPFULLY_CITY';
      const city = process.env[cityKey];
      const resolved = await resolveShopfullyPubId(chain, envFallback, city);
      if (!resolved) {
        console.warn(`[${chain}] skipped: could not discover publication id from https://www.doveconviene.it/volantino/${chain} and no ${envKey} env fallback set`);
        summary.failed.push({ chain, error: `no Shopfully publication id (discovery failed, ${envKey} not set)` });
        if (i < ACTIVE_CHAINS.length - 1) await sleep(INTER_CHAIN_DELAY_MS);
        continue;
      }
      const pubId = resolved.pubId;
      if (resolved.source === 'discovered' && envFallback && envFallback !== pubId) {
        console.log(`[${chain}] publication id rotated: ${envFallback} (env) → ${pubId} (discovered). Using fresh id; consider updating ${envKey}.`);
      } else if (resolved.source === 'env-fallback') {
        console.warn(`[${chain}] discovery failed, using env fallback ${pubId}. Flyer may be stale.`);
      }
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (Shopfully pub ${pubId}, source=${resolved.source} + Gemini vision)...`);
      try {
        const result = await fetchShopfullyProducts(pubId, chain);
        console.log(`  extracted ${result.products.length} products from ${result.hotspotsTotal} hotspots (${result.visionErrors} vision errors, ${result.hotspotsSkipped} skipped)`);

        // Data sanity: the flyer's extracted validity window should cover today.
        // If not, either we've scraped a stale/future publication or the vision
        // date-extraction misread. Hard-fail unless ALLOW_STALE_SHOPFULLY=true.
        if (result.validFrom && result.validTo) {
          const today = new Date().toISOString().slice(0, 10);
          if (today < result.validFrom || today > result.validTo) {
            if (process.env.ALLOW_STALE_SHOPFULLY !== 'true') {
              console.error(`[${chain}] ✗ refusing to ingest stale flyer ${result.validFrom} → ${result.validTo} (today=${today}). Pub ${pubId} is stale; set ALLOW_STALE_SHOPFULLY=true to override.`);
              summary.failed.push({ chain, error: `stale flyer ${result.validFrom}→${result.validTo}` });
              if (i < ACTIVE_CHAINS.length - 1) await sleep(INTER_CHAIN_DELAY_MS);
              continue;
            }
            console.warn(`[${chain}] ⚠ flyer validity ${result.validFrom} → ${result.validTo} does NOT cover today (${today}). Ingesting under ALLOW_STALE_SHOPFULLY override.`);
          }
        } else {
          console.warn(`[${chain}] ⚠ flyer validity dates could not be extracted — products will use fallback current-week window.`);
        }

        const ts = Date.now();
        const tmpJson = `/tmp/spesabot-${chain}-${ts}.json`;
        const sourceUrl = `https://www.doveconviene.it/volantino/${chain}`;
        const synthetic = {
          jobId: `shopfully-${chain}-${ts}`,
          query: `${chain} Shopfully vision scrape pub ${pubId}`,
          domain: 'supermarket-deals',
          project: 'spesabot',
          startedAt: new Date(ts).toISOString(),
          completedAt: new Date().toISOString(),
          durationSeconds: Math.round((Date.now() - ts) / 1000),
          sites: [{ url: sourceUrl, method: 'shopfully-vision', status: 'success', fetchTimeMs: Date.now() - ts }],
          results: [{
            sourceUrl,
            title: `${chain} weekly flyer (pub ${pubId})`,
            extracted: result.products,
            validFrom: result.validFrom ?? undefined,
            validTo: result.validTo ?? undefined,
          }],
        };
        writeFileSync(tmpJson, JSON.stringify(synthetic));
        const stats = await ingestJobResult(tmpJson, chain);
        if (stats.productsIngested > 0) {
          summary.succeeded.push({ chain, products: stats.productsIngested });
          console.log(`${chain}: ${stats.productsIngested} products ingested`);
        } else {
          summary.failed.push({ chain, error: stats.errors[0] ?? 'Ingest returned 0 products' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── Conad "Bassi e Fissi": structural Playwright scrape of the national EDLP page ──
    // Replaces the old deep-research → markdown → regex path. The new fetcher extracts
    // each product card's fields (incl. correctly-paired image URL) directly from the DOM,
    // so there's no room for image↔product misalignment.
    if (chain === 'conad') {
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (Playwright structural scrape)...`);
      try {
        const products = await fetchConadBassiProducts();
        console.log(`  fetched ${products.length} products`);
        const withImg = products.filter((p) => p.image_url).length;
        console.log(`  ${withImg}/${products.length} products have images (${Math.round((withImg / Math.max(products.length, 1)) * 100)}%)`);

        const ts = Date.now();
        const tmpJson = `/tmp/spesabot-conad-${ts}.json`;
        const synthetic = {
          jobId: `playwright-conad-${ts}`,
          query: 'Conad bassi-e-fissi structural scrape',
          domain: 'supermarket-deals',
          project: 'spesabot',
          startedAt: new Date(ts).toISOString(),
          completedAt: new Date().toISOString(),
          durationSeconds: Math.round((Date.now() - ts) / 1000),
          sites: [{ url: 'https://www.conad.it/prodotti-e-marchi/bassi-e-fissi', method: 'playwright', status: 'success', fetchTimeMs: Date.now() - ts }],
          results: [{
            sourceUrl: 'https://www.conad.it/prodotti-e-marchi/bassi-e-fissi',
            title: 'Conad Bassi e Fissi',
            extracted: products,
          }],
        };
        writeFileSync(tmpJson, JSON.stringify(synthetic));
        const stats = await ingestJobResult(tmpJson, chain);
        if (stats.productsIngested > 0) {
          summary.succeeded.push({ chain, products: stats.productsIngested });
          console.log(`${chain}: ${stats.productsIngested} products ingested`);
        } else {
          summary.failed.push({ chain, error: stats.errors[0] ?? 'Scraper returned 0 products' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── Conad weekly flyer: API-based store discovery + Playwright PDF discovery ──
    if (chain === 'conad-flyer') {
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (API store discovery + Playwright PDF)...`);
      try {
        // Dynamically discover all VR-province Conad stores via API
        console.log(`  discovering Conad stores in Verona province...`);
        const stores = await listConadStores();
        // Only process stores that currently have flyers
        const storesWithFlyers = stores.filter(s => s.flyerCount > 0);
        console.log(`  found ${stores.length} stores, ${storesWithFlyers.length} with active flyers`);

        let totalIngested = 0;
        for (const store of storesWithFlyers) {
          console.log(`  discovering flyers for ${store.name} (${store.city})...`);
          const flyers = await discoverConadFlyers(store.storePageUrl);
          console.log(`  found ${flyers.length} flyer PDFs`);
          for (const flyer of flyers) {
            console.log(`  downloading: ${flyer.title} (${flyer.pdfUrl})`);
            const text = await fetchConadFlyerText(flyer.pdfUrl);
            console.log(`  extracted ${text.length} chars`);
            const stats = await ingestFlyerText(chain, text, flyer.pdfUrl, {
              externalId: store.anacanId,
              name: store.name,
              city: store.city,
              province: store.province,
            });
            if (stats.productsIngested > 0) {
              totalIngested += stats.productsIngested;
              console.log(`  ${flyer.title}: ${stats.productsIngested} products ingested`);
            } else {
              console.warn(`  ${flyer.title}: 0 products (${stats.errors[0] ?? 'parser returned nothing'})`);
            }
          }
        }
        if (totalIngested > 0) {
          summary.succeeded.push({ chain, products: totalIngested });
        } else {
          summary.failed.push({ chain, error: 'No flyer PDFs discovered or 0 products extracted' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    // ── Famila: pure Maxidi API fetch (no Playwright) ──
    if (chain === 'famila') {
      const targets = await getScrapeTargets(chain);
      console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (${targets.length} stores, Maxidi API)...`);
      let totalIngested = 0;
      let storesOk = 0;
      let storesEmpty = 0;
      let storesFailed = 0;

      for (let t = 0; t < targets.length; t++) {
        const target = targets[t];
        const label = target.storeName ?? target.url;
        if (!target.storeSlug) {
          console.warn(`  [${t + 1}/${targets.length}] ${label} — missing storeSlug, skipping`);
          storesFailed++;
          continue;
        }
        console.log(`  [${t + 1}/${targets.length}] ${label}`);
        try {
          const result = await fetchFamilaProductsForStore(target.storeSlug);
          const promoSummary = result.promotions.map(p => `${p.alias} (${p.startDate}→${p.endDate})`).join(', ') || 'none';
          console.log(`    [famila] ${result.promotions.length} promo(s): ${promoSummary}`);
          console.log(`    ${result.products.length} products fetched`);

          if (result.products.length === 0) {
            // No products from API — could be no active promos this week or
            // a store that's outside any active promo's area. Don't ingest.
            storesEmpty++;
            console.warn(`    [famila] ${label}: 0 products from API — skipping ingest`);
            continue;
          }

          // Build a synthetic JobResult with structured products. Use the
          // YAML URL as sourceUrl so url-list-strategy store matching links
          // offers to the correct DB store (matched via slug substring).
          const ts = Date.now();
          const tmpJson = `/tmp/spesabot-famila-${target.storeSlug}-${ts}.json`;
          const synthetic = {
            jobId: `api-famila-${target.storeSlug}-${ts}`,
            query: `API fetch for famila @ ${target.storeSlug}`,
            domain: 'supermarket-deals',
            project: 'spesabot',
            startedAt: new Date(ts).toISOString(),
            completedAt: new Date().toISOString(),
            durationSeconds: Math.round((Date.now() - ts) / 1000),
            sites: [{ url: target.url, method: 'api-fetch', status: 'success', fetchTimeMs: Date.now() - ts }],
            results: [{
              sourceUrl: target.url,
              title: `Famila ${label} (${result.promotions.length} active promo${result.promotions.length === 1 ? '' : 's'})`,
              extracted: result.products,
              validFrom: result.promotions[0]?.startDate,
              validTo: result.promotions[0]?.endDate,
            }],
          };
          writeFileSync(tmpJson, JSON.stringify(synthetic));
          const stats = await ingestJobResult(tmpJson, chain);
          totalIngested += stats.productsIngested;
          if (stats.productsIngested > 0) {
            storesOk++;
          } else {
            storesEmpty++;
          }
          console.log(`    ${stats.productsIngested} products ingested`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`    error: ${msg}`);
          storesFailed++;
        }
      }

      const reached = storesOk + storesEmpty;
      if (storesOk > 0) {
        summary.succeeded.push({ chain: `${chain} (${storesOk}/${targets.length} stores)`, products: totalIngested });
        console.log(`${chain}: ${storesOk}/${targets.length} stores with products, ${storesEmpty} empty, ${storesFailed} failed, ${totalIngested} total products`);
        if (storesEmpty > 0) {
          console.warn(`${chain}: WARNING ${storesEmpty} store(s) returned 0 products — possible site change or empty discovery`);
        }
      } else if (reached > 0) {
        summary.failed.push({ chain, error: `${storesEmpty}/${targets.length} stores returned 0 products (silent failure — check API/discovery)` });
      } else {
        summary.failed.push({ chain, error: `0/${targets.length} stores succeeded` });
      }
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    const targets = await getScrapeTargets(chain);
    if (targets.length === 0) {
      console.error(`No scrape targets configured for chain: ${chain}`);
      summary.failed.push({ chain, error: 'No targets configured' });
      continue;
    }

    console.log(`\n[${i + 1}/${ACTIVE_CHAINS.length}] Scraping ${chain} (${targets.length} target${targets.length > 1 ? 's' : ''})...`);

    // ── PDF strategy: bypass deep-research, download + extract directly ───
    if (chainConfig?.strategy === 'pdf') {
      try {
        const target = targets[0];
        console.log(`  downloading PDF: ${target.url}`);

        // For Eurospin: fetch product images from the digitalflyer API in parallel with PDF download
        let productImages: Record<string, string> | undefined;
        if (chain === 'eurospin') {
          try {
            console.log(`  fetching product images from Eurospin API...`);
            const imageMap = await fetchEurospinProductImages();
            productImages = Object.fromEntries(imageMap);
            console.log(`  fetched ${imageMap.size} product image URLs`);
          } catch (err) {
            console.warn(`  image fetch failed (non-fatal): ${err instanceof Error ? err.message : err}`);
          }
        }

        const stats = await ingestPdfChain(chain, target.url, target.validFrom, target.validTo, productImages);
        if (stats.productsIngested > 0) {
          summary.succeeded.push({ chain, products: stats.productsIngested });
          console.log(`${chain}: ${stats.productsIngested} products ingested from PDF`);
        } else {
          summary.failed.push({ chain, error: stats.errors[0] ?? 'PDF parser returned 0 products' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        summary.failed.push({ chain, error: msg });
      }
      // Cooldown before next chain
      if (i < ACTIVE_CHAINS.length - 1) {
        console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
        await sleep(INTER_CHAIN_DELAY_MS);
      }
      continue;
    }

    let totalIngested = 0;
    let storesOk = 0;
    let storesFailed = 0;

    // For national chains with multiple category URLs (Lidl, Aldi), we must
    // aggregate all page results into a single ingestion call. Otherwise each
    // page would clean and replace the same campaign, keeping only the last page.
    const isNational = chainConfig?.strategy === 'national' || chainConfig?.strategy === 'aggregator';
    const aggregatedResults: Array<{ sourceUrl: string; title: string; extracted: any[]; rawMarkdown?: string }> = [];

    // Submit one job per target (per store for url-list chains)
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      const label = target.storeName ?? target.url;
      console.log(`  [${t + 1}/${targets.length}] ${label}`);

      try {
        const job = pipeline.createJob({
          domain: 'supermarket-deals',
          project: 'spesabot',
          query: `Offerte settimanali ${chain}${target.storeName ? ' (' + target.storeName + ')' : ''} — estrai tutti i prodotti con prezzi, brand, sconti, quantità`,
          sites: [target.url],
          requester: 'spesabot-pipeline',
          priority: 'high' as const,
          skipDedup: true,
          // Chains with a regex parser don't need LLM extraction — just give us raw markdown.
          // Saves ~30s/site (Z.AI timeout + Gemini retry) and avoids quota/cost.
          skipExtraction: CHAINS_WITH_PARSER.has(chain),
        });

        const result = await pipeline.executeJob(job, domainConfig);

        const okSites = result.sites.filter((s: any) => s.status === 'success').length;
        if (okSites === 0) {
          console.error(`    failed: ${result.sites[0]?.error ?? 'unknown'}`);
          storesFailed++;
          continue;
        }

        const updatedJob = pipeline.getJob(job.id);
        if (updatedJob?.resultPath && existsSync(updatedJob.resultPath)) {
          if (isNational && targets.length > 1) {
            // Aggregate: collect result for batch ingestion at the end
            const raw = JSON.parse(readFileSync(updatedJob.resultPath, 'utf-8'));
            for (const r of raw.results ?? []) {
              aggregatedResults.push(r);
            }
            storesOk++;
            console.log(`    scraped OK (aggregating for batch ingest)`);
          } else {
            // Per-store ingestion (url-list chains like Famila)
            const stats = await ingestJobResult(updatedJob.resultPath, chain);
            totalIngested += stats.productsIngested;
            storesOk++;
            console.log(`    ${stats.productsIngested} products ingested`);
            if (stats.errors.length > 0 && stats.errors.length < 3) {
              console.error(`    errors:`, stats.errors.slice(0, 3));
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    error: ${msg}`);
        storesFailed++;
      }
    }

    // For national chains: ingest all aggregated results in one shot
    if (isNational && aggregatedResults.length > 0) {
      const ts = Date.now();
      const tmpJson = `/tmp/spesabot-${chain}-aggregated-${ts}.json`;
      const synthetic = {
        jobId: `aggregated-${chain}-${ts}`,
        query: `Aggregated ${chain} offers from ${aggregatedResults.length} pages`,
        domain: 'supermarket-deals',
        project: 'spesabot',
        startedAt: new Date(ts).toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: 0,
        sites: aggregatedResults.map(r => ({ url: r.sourceUrl, method: 'aggregated', status: 'success', fetchTimeMs: 0 })),
        results: aggregatedResults,
      };
      writeFileSync(tmpJson, JSON.stringify(synthetic));
      const stats = await ingestJobResult(tmpJson, chain);
      totalIngested = stats.productsIngested;
      console.log(`  aggregated ingest: ${stats.productsIngested} products from ${aggregatedResults.length} pages`);
    }

    // Close browser between chains to free RAM
    await pipeline.closeBrowser();

    if (storesOk > 0) {
      summary.succeeded.push({ chain: `${chain} (${storesOk}/${targets.length} stores)`, products: totalIngested });
      console.log(`${chain}: ${storesOk}/${targets.length} stores OK, ${totalIngested} total products`);
    } else {
      summary.failed.push({ chain, error: `0/${targets.length} stores succeeded` });
    }

    // Cooldown between chains (except after last)
    if (i < ACTIVE_CHAINS.length - 1) {
      console.log(`Waiting ${INTER_CHAIN_DELAY_MS / 1000}s before next chain...`);
      await sleep(INTER_CHAIN_DELAY_MS);
    }
  }

  summary.durationSeconds = Math.round((Date.now() - startTime) / 1000);

  console.log(`\nPipeline complete in ${summary.durationSeconds}s`);
  console.log(`Succeeded: ${summary.succeeded.map(s => s.chain).join(', ') || 'none'}`);
  console.log(`Failed: ${summary.failed.map(f => f.chain).join(', ') || 'none'}`);

  await sendPipelineSummary(summary);
  await closeDb();
}

main().catch(async (err) => {
  console.error('Pipeline fatal error:', err);
  await sendAlert(`Pipeline crashed: ${err.message}`, 'critical');
  await closeDb();
  process.exit(1);
});
