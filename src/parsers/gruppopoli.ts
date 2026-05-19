/**
 * Gruppo Poli (Poli / Orvea / Regina / Amort) parser.
 *
 * Source: https://www.gruppopoli.it/it/volantino/
 *
 * Gruppo Poli runs four supermarket banners under one ASP.NET WebForms site.
 * The flyer is store-scoped via __VIEWSTATE postback, then products are loaded
 * per-category via XHR to /interne/ajax/ContentCategoriaVolantino.aspx.
 *
 * Strategy:
 *   1. Playwright loads /it/volantino/cambia-negozio/, dismisses cookie banner,
 *      selects insegna + negozio, clicks #btnTrova → ASP.NET session is set.
 *   2. We harvest the session cookies + the volantino id (embedded in JS calls
 *      as `IDCategoria=X&id=VOLANTINO_ID`) + the list of category data-ids.
 *   3. For each category we POST the AJAX endpoint with the cookie jar — the
 *      response is a chunk of HTML containing one or more `.band-volantino-prodotto`
 *      product cards. Pure HTML, no JS execution needed past the picker.
 *   4. parseProductCards() extracts structured offers from each chunk.
 *
 * Each chain (poli/orvea/regina/amort) maps to one (insegna, default-store) pair.
 * Multi-store fan-out (à la Migross) can be added later.
 */

import { chromium, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BROWSER_PROFILE_DIR = process.env.SPESABOT_BROWSER_PROFILE
  ?? join(process.env.HOME ?? '/home/kos', '.spesabot', 'browser-profile');

const PICKER_URL = 'https://www.gruppopoli.it/it/volantino/cambia-negozio/';
const VOLANTINO_URL = 'https://www.gruppopoli.it/it/volantino/';
const AJAX_URL = 'https://www.gruppopoli.it/interne/ajax/ContentCategoriaVolantino.aspx';

/** Shape of a single offer extracted from one product card. */
export interface GruppoPoliProduct {
  /** Stable rotator-item id from the card, e.g. "1506130". Used as supplier sku. */
  itemId: string;
  /** Product title as printed (uppercase in the HTML, normalised here). */
  prodotto: string;
  /** Quantity / pack-size as a free string (e.g. "800 g", "1 l"). */
  quantita_peso: string | null;
  /** Discounted price in EUR. */
  prezzo_offerta: number;
  /** Pre-discount price (often missing — only present when there was a strikethrough). */
  prezzo_originale: number | null;
  /** Reference price per kg/litre (e.g. 2.36 from "(2,36 €/kg)"). */
  prezzo_al_kg: number | null;
  /** Image URL (data-src — lazy-loaded). Aliased to `image_url` for ingest compatibility. */
  image_url: string | null;
  /** Promo label as printed (e.g. "Risparmio", "ScontaTu", "Sottocosto"). */
  etichetta_promo: string | null;
  /** Category id from the AJAX call (e.g. "1660" → ORTOFRUTTA). */
  categoria_id: string;
  /** Human-readable category title (resolved by caller from the picker page). */
  categoria_nome: string;
  /** Brand slug (poli/orvea/regina/amort) — set by the caller. */
  insegna: string;
  /** Store code from the picker (e.g. "00765" for Orvea Peschiera del Garda). */
  negozio_code: string;
  /** Store label from the picker (e.g. "Orvea Peschiera del Garda"). */
  negozio_label: string;
}

/**
 * Per-chain configuration: which Gruppo Poli `insegna` value to pick in the
 * dropdown, and which default store. Multi-store fan-out can be added later by
 * iterating store options (see `dumpAvailableStores` helper below).
 *
 * Insegna values harvested 2026-05-02 from the picker page:
 *   182=Supermercati Poli, 183=Regina, 184=IperPoli, 185=MiniPoli,
 *   251=Amort, 308=Supermercati Orvea, 315=IperOrvea
 */
/**
 * One (insegna, negozio) pair. A chain may have multiple — e.g. Orvea covers
 * Verona province via both "Supermercati Orvea Peschiera del Garda" (308/00765)
 * AND "IperOrvea Affi" (315/00760), both formats live under the `orvea` chain.
 */
export interface InsegnaStore {
  insegnaCode: string;
  negozioCode: string;
  label: string;
}

export interface ChainConfig {
  stores: InsegnaStore[];
  enabled: boolean;
  /** Human note about coverage (geographic scope) */
  coverage: string;
}

/**
 * Geographic targeting: only Verona + province for now. The Gruppo Poli site
 * exposes 7 insegne × ~62 stores total; the vast majority are Trentino-Alto
 * Adige. Verona-province presence is limited to Orvea (Peschiera del Garda)
 * and IperOrvea (Affi).
 *
 * To expand coverage later: add stores here and the runner picks them up.
 * Multi-store fan-out is handled by iterating `stores[]`.
 */
export const GRUPPOPOLI_CHAINS: Record<string, ChainConfig> = {
  poli: {
    enabled: false,
    coverage: 'Trentino + Alto Adige only — no Verona-province stores',
    stores: [],
  },
  orvea: {
    enabled: true,
    coverage: 'Verona province — Peschiera del Garda + Affi (IperOrvea)',
    stores: [
      { insegnaCode: '308', negozioCode: '00765', label: 'Orvea Peschiera del Garda' },
      { insegnaCode: '315', negozioCode: '00760', label: 'IperOrvea Affi' },
    ],
  },
  regina: {
    enabled: false,
    coverage: 'Trentino-Alto Adige only — no Verona-province stores',
    stores: [],
  },
  amort: {
    enabled: false,
    coverage: 'Alto Adige only (German-speaking) — no Verona-province stores',
    stores: [],
  },
};

/** Per-store fetch result (one InsegnaStore). */
export interface StoreFetchResult {
  storeLabel: string;
  volantinoId: string;
  categories: { id: string; name: string }[];
  productCount: number;
}

/** Result of a successful flyer fetch for one chain (aggregated across stores). */
export interface GruppoPoliFetchResult {
  insegna: string;
  totalProducts: number;
  /** All products across all stores, each tagged with negozio_code+label. */
  products: GruppoPoliProduct[];
  /** Per-store metadata for diagnostics. */
  stores: StoreFetchResult[];
  /** Stores that failed to fetch (with error message). Non-fatal — chain continues. */
  failures: { store: InsegnaStore; error: string }[];
}

/* ------------------------------------------------------------------ */
/* Playwright session bootstrap                                       */
/* ------------------------------------------------------------------ */

interface SessionContext {
  cookieHeader: string;
  volantinoId: string;
  categories: { id: string; name: string }[];
  storeLabel: string;
}

async function bootstrapSession(store: InsegnaStore): Promise<SessionContext> {
  const hasProfile = existsSync(BROWSER_PROFILE_DIR);

  let context: BrowserContext;
  let browser: import('playwright').Browser | null = null;

  if (hasProfile) {
    context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: true,
      viewport: { width: 1280, height: 1024 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } else {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 1024 },
    });
  }

  try {
    const page = await context.newPage();
    await page.goto(PICKER_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Dismiss cookie banner if present
    const cookieBtn = await page.$('button:has-text("Accetta")').catch(() => null);
    if (cookieBtn) {
      try { await cookieBtn.click({ timeout: 3000 }); await page.waitForTimeout(500); } catch {}
    }

    // Select insegna (triggers postback that repopulates the negozio dropdown)
    await page.selectOption(
      'select[name="ctl00$ContentPlaceBody$CambiaNegozio1$ddInsegna"]',
      store.insegnaCode,
    );
    await page.waitForTimeout(800);

    await page.selectOption(
      'select[name="ctl00$ContentPlaceBody$CambiaNegozio1$ddNegozio"]',
      store.negozioCode,
    );
    await page.waitForTimeout(400);

    // Capture chosen store label for logs (fallback to configured label)
    const storeLabel = await page.$eval(
      `select[name="ctl00$ContentPlaceBody$CambiaNegozio1$ddNegozio"] option[value="${store.negozioCode}"]`,
      (el) => (el.textContent ?? '').trim(),
    ).catch(() => store.label);

    // Submit picker — this navigates to /it/volantino/ with ASP.NET session set
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20000 }),
      page.click('#ctl00_ContentPlaceBody_CambiaNegozio1_btnTrova'),
    ]);

    // Wait for the volantino structure to be populated
    await page.waitForSelector('.fascia-volantino', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(2000);

    const html = await page.content();

    // Extract volantino id (shared across all categories in this flyer)
    const idMatch = html.match(/IDCategoria=\d+&id=(\d+)/);
    const volantinoId = idMatch?.[1];
    if (!volantinoId) {
      throw new Error(`Could not locate volantino id on flyer page for ${store.label} (${storeLabel}) — likely no active flyer for this store`);
    }

    // Extract category id+name pairs
    const fasce = Array.from(html.matchAll(
      /data-cat="(\d+)"[\s\S]*?titolo-fascia-volantino[^>]*>\s*([\s\S]+?)\s*<\/span>/g,
    ));
    const categories = fasce.map(m => ({
      id: m[1],
      name: m[2].trim().replace(/\s+/g, ' '),
    }));
    if (categories.length === 0) {
      throw new Error(`No flyer categories found for ${store.label} (${storeLabel})`);
    }

    // Capture cookie jar
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    return { cookieHeader, volantinoId, categories, storeLabel };
  } finally {
    await context.close();
    if (browser) await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* AJAX category fetch                                                */
/* ------------------------------------------------------------------ */

async function fetchCategoryHtml(
  cookieHeader: string,
  volantinoId: string,
  categoryId: string,
): Promise<string> {
  const url = `${AJAX_URL}?IDCategoria=${categoryId}&id=${volantinoId}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': VOLANTINO_URL,
    },
  });
  if (!resp.ok) {
    throw new Error(`AJAX category ${categoryId} returned HTTP ${resp.status}`);
  }
  return resp.text();
}

/* ------------------------------------------------------------------ */
/* HTML → product parsing                                             */
/* ------------------------------------------------------------------ */

const NUM_RE = /\d+(?:[.,]\d+)?/;

function parseEuroPrice(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(NUM_RE);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse "(2,36 €/kg)" → 2.36 */
function parsePerUnitPrice(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*€\/(?:kg|l|litro)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract structured products from one AJAX category response chunk.
 * Each card looks like:
 *
 *   <div class="band-volantino-prodotto visible container-prodotto"
 *        data-cat="1660" data-sottocat="1661" ...>
 *     <div class="band-volantino-prodotto-etichetta blu">Risparmio</div>
 *     <div ... data-id="1506130">
 *       <img data-src='IMAGE_URL' alt="..." title="..."/>
 *       <div class="band-volantino-prodotto-titolo">PRODUCT NAME</div>
 *       <span class="band-volantino-prodotto-produttore">800 g</span>
 *     </div>
 *     <div class="band-volantino-prodotto-prezzo-normale">2,49 €</div>
 *     <div class="band-volantino-prodotto-prezzo-scontato">1,89 €</div>
 *     <div class="band-volantino-prodotto-prezzo-al-kg">(2,36 €/kg)</div>
 *   </div>
 */
export function parseProductCards(
  html: string,
  categoryId: string,
  categoryName: string,
  insegna: string,
  negozio_code: string,
  negozio_label: string,
): GruppoPoliProduct[] {
  const products: GruppoPoliProduct[] = [];

  // Split on the card opener — keep everything between two openers as one card.
  // Using a global match on the wrapper class is more robust than nested regex.
  const cards = html.split(/<div\s+class="band-volantino-prodotto\s/).slice(1);

  for (const cardRaw of cards) {
    const card = '<div class="band-volantino-prodotto ' + cardRaw;

    // itemId from the rotator-item data-id (stable supplier sku)
    const itemIdMatch = card.match(/rotator-item[^>]+data-id="(\d+)"/);
    if (!itemIdMatch) continue;
    const itemId = itemIdMatch[1];

    // Title
    const titleMatch = card.match(/band-volantino-prodotto-titolo[^>]*>\s*([^<]+?)\s*<\/div>/);
    const prodotto = titleMatch ? stripTags(titleMatch[1]) : '';
    if (!prodotto || prodotto.length < 2) continue;

    // Quantity
    const qtyMatch = card.match(/band-volantino-prodotto-produttore[^>]*>\s*([^<]+?)\s*<\/span>/);
    const quantita_peso = qtyMatch ? stripTags(qtyMatch[1]) : null;

    // Image (data-src or src)
    const imgMatch = card.match(/<img[^>]+(?:data-src|src)\s*=\s*['"]([^'"]+)['"]/);
    const image_url = imgMatch ? imgMatch[1] : null;

    // Promo label (etichetta) — first one only, may be missing
    const labelMatch = card.match(/band-volantino-prodotto-etichetta[^>]*>\s*([^<]+?)\s*<\/div>/);
    const etichetta_promo = labelMatch ? stripTags(labelMatch[1]) : null;

    // Prices
    const offerPriceMatch = card.match(/band-volantino-prodotto-prezzo-scontato[^>]*>\s*([^<]+?)\s*<\/div>/);
    const normalPriceMatch = card.match(/band-volantino-prodotto-prezzo-normale[^>]*>\s*([^<]+?)\s*<\/div>/);
    const perKgMatch = card.match(/band-volantino-prodotto-prezzo-al-kg[^>]*>\s*([^<]+?)\s*<\/div>/);

    // If no scontato block, fall back to normale (some products have only one price)
    const prezzo_offerta = parseEuroPrice(offerPriceMatch?.[1]) ?? parseEuroPrice(normalPriceMatch?.[1]);
    if (prezzo_offerta == null) continue;

    // prezzo_originale only when scontato AND normale both present (true discount)
    const prezzo_originale = offerPriceMatch ? parseEuroPrice(normalPriceMatch?.[1]) : null;
    const prezzo_al_kg = parsePerUnitPrice(perKgMatch?.[1]);

    products.push({
      itemId,
      prodotto,
      quantita_peso,
      prezzo_offerta,
      prezzo_originale,
      prezzo_al_kg,
      image_url,
      etichetta_promo,
      categoria_id: categoryId,
      categoria_nome: categoryName,
      insegna,
      negozio_code,
      negozio_label,
    });
  }

  return products;
}

/* ------------------------------------------------------------------ */
/* Main entry: fetch a chain end-to-end                               */
/* ------------------------------------------------------------------ */

/**
 * Fetch all flyer offers for one Gruppo Poli chain (poli/orvea/regina/amort).
 *
 * @param chain - DB chain slug
 * @returns structured fetch result with products[] ready for ingest
 */
export async function fetchGruppoPoliChain(chain: string): Promise<GruppoPoliFetchResult> {
  const config = GRUPPOPOLI_CHAINS[chain];
  if (!config) {
    throw new Error(`Unknown Gruppo Poli chain: ${chain}`);
  }

  if (!config.enabled || config.stores.length === 0) {
    console.log(`[gruppopoli] ${chain} disabled or no stores configured (${config.coverage}). Skipping.`);
    return { insegna: chain, totalProducts: 0, products: [], stores: [], failures: [] };
  }

  console.log(`[gruppopoli] ${chain}: ${config.stores.length} store(s) configured — ${config.coverage}`);

  const allProducts: GruppoPoliProduct[] = [];
  const storeResults: StoreFetchResult[] = [];
  const failures: { store: InsegnaStore; error: string }[] = [];

  for (const store of config.stores) {
    console.log(`[gruppopoli] ${chain} / bootstrapping store ${store.label} (${store.insegnaCode}/${store.negozioCode})...`);
    let session: SessionContext;
    try {
      session = await bootstrapSession(store);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[gruppopoli] ${chain} / store ${store.label}: bootstrap FAILED — ${msg}`);
      failures.push({ store, error: msg });
      continue;
    }
    console.log(`[gruppopoli] ${chain} / ${session.storeLabel}: volantinoId=${session.volantinoId}, ${session.categories.length} categories`);

    let storeProductCount = 0;
    for (const cat of session.categories) {
      try {
        const html = await fetchCategoryHtml(session.cookieHeader, session.volantinoId, cat.id);
        const cards = parseProductCards(html, cat.id, cat.name, chain, store.negozioCode, session.storeLabel);
        allProducts.push(...cards);
        storeProductCount += cards.length;
      } catch (err) {
        console.warn(`[gruppopoli] ${chain} / ${session.storeLabel} / cat ${cat.id} (${cat.name}): FAILED — ${(err as Error).message}`);
      }
    }
    console.log(`[gruppopoli] ${chain} / ${session.storeLabel}: ${storeProductCount} products`);

    storeResults.push({
      storeLabel: session.storeLabel,
      volantinoId: session.volantinoId,
      categories: session.categories,
      productCount: storeProductCount,
    });
  }

  return {
    insegna: chain,
    totalProducts: allProducts.length,
    products: allProducts,
    stores: storeResults,
    failures,
  };
}
