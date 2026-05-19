/**
 * Conad weekly flyer URL discovery.
 *
 * Two-phase approach:
 *   1. **Store discovery** — Call the public Conad API to list all grocery stores
 *      in the Verona area (POST /api/corporate/it-it.retrievePointOfService.json).
 *      Filters by VR province, skips PetStore/specialized, skips stores with 0 flyers.
 *
 *   2. **Flyer discovery** — For each store, navigate to its page on conad.it
 *      with Playwright, intercept network requests for PDF/volantini URLs,
 *      extract validity dates from filenames.
 *
 * Conad serves store-specific flyers as PDFs at:
 *   https://www.conad.it/assets/common/volantini/{coop}/{subfolder}/{filename}.pdf
 *
 * The persistent browser profile is at ~/.spesabot/browser-profile/ and must have
 * an active Conad session. Run `npx tsx scripts/login-setup.ts conad` first.
 */

import { chromium, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const PROFILE_DIR = process.env.SPESABOT_BROWSER_PROFILE
  ?? join(process.env.HOME ?? '/home/kos', '.spesabot', 'browser-profile');

/** Open a Playwright browser context, reusing persistent profile if available. */
async function openBrowserContext(): Promise<BrowserContext> {
  const hasProfile = existsSync(PROFILE_DIR);
  if (!hasProfile) {
    console.warn(`[conad-flyer] No browser profile at ${PROFILE_DIR}. Run: npx tsx scripts/login-setup.ts conad`);
  }
  if (hasProfile) {
    return chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 1024 },
    });
  }
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browser.newContext({ viewport: { width: 1280, height: 1024 } });
}

// Verona city center coordinates + search radius
const SEARCH_LAT = '45.4384';
const SEARCH_LNG = '10.9917';
const SEARCH_RADIUS_KM = '50';
const TARGET_PROVINCE = 'VR';

export interface ConadStoreInfo {
  anacanId: string;
  name: string;           // e.g. "Spazio Conad"
  insegna: string;        // e.g. "SPAZIO CONAD"
  city: string;           // e.g. "BUSSOLENGO"
  address: string;        // e.g. "Località Ferlina 11"
  cap: string;            // e.g. "37012"
  province: string;       // e.g. "VR"
  cooperative: string;    // e.g. "CIA"
  storePageUrl: string;   // full URL to the store page on conad.it
  flyerCount: number;     // number of currently active flyers
  slug: string;           // short identifier, e.g. "spazio-conad-bussolengo"
}

export interface ConadFlyerInfo {
  pdfUrl: string;
  title: string;
  validFrom: string | null;
  validTo: string | null;
  storeSlug: string;
}

/**
 * Discover all Conad grocery stores in the Verona area via the public API.
 * Returns only VR-province stores that aren't PetStore/specialized.
 */
export async function listConadStores(): Promise<ConadStoreInfo[]> {
  // The API requires a browser context (cookies/headers) — use Playwright
  const context = await openBrowserContext();
  try {
    const page = context.pages()[0] ?? await context.newPage();

    // Navigate to conad.it first to establish cookies
    await page.goto('https://www.conad.it/ricerca-negozi', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Call the store search API from within the page context
    const rawJson = await page.evaluate(async (params: { lat: string; lng: string; radius: string }) => {
      const resp = await fetch('/api/corporate/it-it.retrievePointOfService.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          latitudine: params.lat,
          longitudine: params.lng,
          raggioRicerca: params.radius,
          insegneId: [],
          serviziId: [],
          repartiId: [],
          apertura: [],
        }),
      });
      return resp.text();
    }, { lat: SEARCH_LAT, lng: SEARCH_LNG, radius: SEARCH_RADIUS_KM });

    const parsed = JSON.parse(rawJson);
    const allStores: Array<Record<string, unknown>> = parsed.data ?? parsed;

    if (!Array.isArray(allStores)) {
      console.warn('[conad-flyer] API returned unexpected format');
      return [];
    }

    // Filter to VR province, non-specialized, non-petstore
    const groceryStores = allStores.filter(s => {
      const prov = String(s.codiceProvincia ?? '');
      const insegna = String(s.descrizioneInsegna ?? '');
      const specialized = Boolean(s.specialized);
      return prov === TARGET_PROVINCE
        && !specialized
        && !insegna.includes('PET STORE');
    });

    return groceryStores.map(s => {
      const insegna = String(s.descrizioneInsegna ?? '');
      const city = String(s.nomeComune ?? '');
      const code = String(s.anacanId ?? '');
      const pageUrl = String(s.pdvPlainUrl ?? '');

      // Build a clean slug: "spazio-conad-bussolengo" from "SPAZIO CONAD" + "BUSSOLENGO"
      const slug = `${insegna}-${city}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      return {
        anacanId: code,
        name: String(s.pdvTitle ?? insegna),
        insegna,
        city,
        address: String(s.indirizzo ?? ''),
        cap: String(s.cap ?? ''),
        province: String(s.codiceProvincia ?? ''),
        cooperative: String(s.codiceCooperativa ?? ''),
        storePageUrl: pageUrl,
        flyerCount: Number(s.volantiniCount ?? 0),
        slug,
      };
    });

  } finally {
    await context.close();
  }
}

/**
 * Discover current flyer PDF URLs for a Conad store.
 *
 * Accepts either a store slug (looked up via API) or a direct store page URL.
 */
export async function discoverConadFlyers(storeSlugOrUrl: string): Promise<ConadFlyerInfo[]> {
  let storeUrl: string;
  let storeSlug: string;

  if (storeSlugOrUrl.startsWith('http')) {
    storeUrl = storeSlugOrUrl;
    storeSlug = storeUrl.split('/').pop()?.split('--')[0] ?? 'unknown';
  } else {
    // Look up via API
    const stores = await listConadStores();
    const match = stores.find(s => s.slug === storeSlugOrUrl || s.anacanId === storeSlugOrUrl);
    if (!match) {
      throw new Error(`Conad store not found: ${storeSlugOrUrl}. Available: ${stores.map(s => s.slug).join(', ')}`);
    }
    storeUrl = match.storePageUrl;
    storeSlug = match.slug;
  }

  // Track discovered flyer URLs from network requests
  const discoveredPdfUrls = new Set<string>();
  const discoveredFlyerData: ConadFlyerInfo[] = [];

  const context = await openBrowserContext();

  try {
    const page = context.pages()[0] ?? await context.newPage();

    // ── Intercept network requests for PDF/volantini URLs ──
    page.on('request', req => {
      const url = req.url();
      if (/volantini.*\.pdf/i.test(url) || /\.pdf.*volantini/i.test(url)) {
        // Strip cache-buster params and rendition suffixes (e.g. "/renditions/previewvol.webp")
        const cleanUrl = url.split('?')[0].replace(/\/renditions\/.*$/, '');
        discoveredPdfUrls.add(cleanUrl);
      }
    });

    page.on('response', async resp => {
      const url = resp.url();
      // Capture JSON API responses that might contain flyer data
      if (resp.status() === 200 && /application\/json/i.test(resp.headers()['content-type'] ?? '')) {
        if (/volantini|flyer|leaflet/i.test(url)) {
          try {
            const json = await resp.json();
            console.log(`[conad-flyer] API response from ${url}:`, JSON.stringify(json).slice(0, 500));
          } catch { /* ignore */ }
        }
      }
    });

    // ── Navigate to the store page ──
    console.log(`[conad-flyer] Navigating to ${storeUrl}...`);
    await page.goto(storeUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(5000); // Extra wait for JS rendering

    // ── Try clicking on "Volantini" tab/section if it exists ──
    const flyerSelectors = [
      'text=Volantini',
      'text=Sfoglia il volantino',
      'text=Sfoglia',
      '[data-testid*="volantini"]',
      '[data-testid*="flyer"]',
      'a[href*="volantini"]',
      'a[href*="volantino"]',
    ];

    for (const sel of flyerSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          console.log(`[conad-flyer] Clicking: ${sel}`);
          await el.click();
          await page.waitForTimeout(5000);
          break;
        }
      } catch { /* selector not found */ }
    }

    // ── Extract flyer links from the rendered DOM ──
    const domFlyers = await page.evaluate(() => {
      const results: Array<{
        href: string;
        text: string;
        title: string;
      }> = [];

      // Look for links to PDFs
      document.querySelectorAll('a[href*=".pdf"], a[href*="volantini"]').forEach(a => {
        const href = (a as HTMLAnchorElement).href;
        const text = a.textContent?.trim() ?? '';
        results.push({ href, text, title: (a as HTMLAnchorElement).title ?? '' });
      });

      // Look for iframes that might embed a flyer viewer
      document.querySelectorAll('iframe').forEach(iframe => {
        const src = iframe.src;
        if (src && /volantini|flyer|pdf/i.test(src)) {
          results.push({ href: src, text: 'iframe', title: 'embedded viewer' });
        }
      });

      // Look for image links that might be flyer covers
      document.querySelectorAll('img[src*="volantini"], img[data-src*="volantini"]').forEach(img => {
        const src = (img as HTMLImageElement).src || img.getAttribute('data-src') || '';
        results.push({ href: src, text: 'cover image', title: '' });
      });

      // Grab any JSON-LD or structured data
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        try {
          const data = JSON.parse(script.textContent ?? '');
          if (data.offers || data.flyer) {
            results.push({ href: JSON.stringify(data).slice(0, 300), text: 'json-ld', title: '' });
          }
        } catch { /* ignore */ }
      });

      return results;
    });

    console.log(`[conad-flyer] DOM extraction found ${domFlyers.length} elements`);
    for (const f of domFlyers) {
      console.log(`  ${f.text}: ${f.href}`);
      if (/\.pdf/i.test(f.href)) {
        const cleanUrl = f.href.split('?')[0].replace(/\/renditions\/.*$/, '');
        discoveredPdfUrls.add(cleanUrl);
      }
    }

    // ── Also capture the full page URL in case it redirected to a flyer viewer ──
    const currentUrl = page.url();
    if (/volantini|flyer/i.test(currentUrl)) {
      console.log(`[conad-flyer] Page redirected to flyer: ${currentUrl}`);
    }

    // ── If no PDFs found via network/DOM, try the inner HTML for hidden refs ──
    if (discoveredPdfUrls.size === 0) {
      const html = await page.content();
      const pdfMatches = html.matchAll(/https?:\/\/[^"'\s]+volantini[^"'\s]*\.pdf/gi);
      for (const m of pdfMatches) {
        const cleanUrl = m[0].split('?')[0].replace(/\/renditions\/.*$/, '');
        discoveredPdfUrls.add(cleanUrl);
      }
    }

    // ── Filter: keep only grocery/promo flyers, skip catalogs, manuals, tax docs ──
    const SKIP_PATTERNS = [
      /strategia.?fiscale/i,     // tax strategy doc
      /manuale/i,                // user manuals
      /cpay/i,                   // payment app docs
      /CID-manuale/i,            // card manual
      /PETFOOD/i,                // pet store catalog (separate from grocery)
      /catalogo.*primavera/i,    // seasonal catalog (non-food)
      /CAT_ARREDO/i,             // garden furniture catalog (non-food)
      /Parafarmacia.*Catalogo/i, // parafarmacia catalog (non-food)
      /assets\/documents/i,      // generic corporate documents, not flyers
    ];

    // Also filter to only keep flyers that mention this store (or are generic)
    // Extract the city keyword for matching (e.g. "BUSSOLENGO" from "spazio-conad-bussolengo")
    const cityKeyword = storeSlug.split('-').pop()?.toUpperCase() ?? '';

    console.log(`[conad-flyer] All PDF URLs (before filtering): ${discoveredPdfUrls.size}`);
    for (const url of discoveredPdfUrls) {
      const skip = SKIP_PATTERNS.some(re => re.test(url));
      // Only skip flyers that mention a DIFFERENT SPECIFIC CITY in the filename.
      // Regional flyers (e.g. "CONAD_VENETO") and generic ones pass through.
      const isWrongStore = isFlierForDifferentCity(url, cityKeyword);
      const label = skip ? 'SKIP' : isWrongStore ? 'SKIP(store)' : ' OK ';
      console.log(`  ${label} ${url}`);
      if (skip || isWrongStore) continue;

      // Try to extract dates from the filename, e.g. "17APR_29APR" or "7-16aprile"
      const dates = extractDatesFromFilename(url);

      discoveredFlyerData.push({
        pdfUrl: url,
        title: extractTitleFromUrl(url),
        validFrom: dates.from,
        validTo: dates.to,
        storeSlug,
      });
    }

  } finally {
    await context.close();
  }

  if (discoveredFlyerData.length === 0) {
    console.warn(`[conad-flyer] No flyer PDFs discovered for ${storeSlug}. Is the browser profile logged in?`);
  }

  return discoveredFlyerData;
}

// Known Italian city names that appear in Conad flyer filenames — used to detect
// flyers meant for a different store location. Only includes cities observed in
// the cia/dao/ccn cooperative areas; extend as needed.
const KNOWN_FLYER_CITIES = [
  'BUSSOLENGO', 'MORTEGLIANO', 'PESCHIERA', 'VERONA', 'BRESCIA', 'VICENZA',
  'TRENTO', 'BOLZANO', 'BELLUNO', 'PADOVA', 'TREVISO', 'UDINE', 'TRIESTE',
  'MANTOVA', 'ROVIGO', 'PORDENONE', 'GORIZIA',
];

/** Check if a flyer URL mentions a city that's NOT ours. */
function isFlierForDifferentCity(url: string, ourCity: string): boolean {
  if (!ourCity) return false;
  const filename = decodeURIComponent(url.split('/').pop() ?? '').toUpperCase();
  for (const city of KNOWN_FLYER_CITIES) {
    if (city === ourCity) continue; // skip our own city
    if (filename.includes(city)) return true; // another city mentioned
  }
  return false;
}

/** Extract a human-readable title from the PDF URL path */
function extractTitleFromUrl(url: string): string {
  const filename = decodeURIComponent(url.split('/').pop()?.replace(/\.pdf$/i, '') ?? 'unknown');
  return filename.replace(/_/g, ' ').replace(/-/g, ' ');
}

/** Try to extract validity dates from a flyer filename.
 *  Patterns: "17APR_29APR", "7-16aprile", "16_22 APRILE"
 */
function extractDatesFromFilename(url: string): { from: string | null; to: string | null } {
  const filename = decodeURIComponent(url.split('/').pop() ?? '');
  const months: Record<string, string> = {
    'gen': '01', 'feb': '02', 'mar': '03', 'apr': '04',
    'mag': '05', 'giu': '06', 'lug': '07', 'ago': '08',
    'set': '09', 'ott': '10', 'nov': '11', 'dic': '12',
    'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
    'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
    'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12',
  };

  const year = new Date().getFullYear();

  // "17APR_29APR" or "17APR-29APR"
  const m1 = filename.match(/(\d{1,2})\s*([A-Z]{3})[_\s-]+(\d{1,2})\s*([A-Z]{3})/i);
  if (m1) {
    const mm1 = months[m1[2].toLowerCase()];
    const mm2 = months[m1[4].toLowerCase()];
    if (mm1 && mm2) {
      return {
        from: `${year}-${mm1}-${m1[1].padStart(2, '0')}`,
        to: `${year}-${mm2}-${m1[3].padStart(2, '0')}`,
      };
    }
  }

  // "7-16aprile" or "16_22 APRILE"
  const m2 = filename.match(/(\d{1,2})[_-](\d{1,2})\s*(\w+)/i);
  if (m2) {
    const mm = months[m2[3].toLowerCase()];
    if (mm) {
      return {
        from: `${year}-${mm}-${m2[1].padStart(2, '0')}`,
        to: `${year}-${mm}-${m2[2].padStart(2, '0')}`,
      };
    }
  }

  return { from: null, to: null };
}

/**
 * Download a Conad flyer PDF and extract text via pdftotext.
 * Returns raw text suitable for parseConadFlyerText().
 */
export async function fetchConadFlyerText(pdfUrl: string): Promise<string> {
  const tmpFile = `/tmp/conad-flyer-${Date.now()}.pdf`;
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: HTTP ${response.status} from ${pdfUrl}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    writeFileSync(tmpFile, buf);
    console.log(`[conad-flyer] Downloaded ${(buf.length / 1024).toFixed(0)} KB → ${tmpFile}`);

    const text = execFileSync('pdftotext', ['-raw', tmpFile, '-'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return text;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ── CLI: run directly to list stores or discover flyers ──
// Usage:
//   npx tsx src/parsers/conad-flyer-discovery.ts stores          — list all VR stores
//   npx tsx src/parsers/conad-flyer-discovery.ts discover        — discover flyers for all stores with active flyers
//   npx tsx src/parsers/conad-flyer-discovery.ts discover <url>  — discover flyers for a specific store URL
if (process.argv[1]?.endsWith('conad-flyer-discovery.ts')) {
  const cmd = process.argv[2] ?? 'stores';

  if (cmd === 'stores') {
    listConadStores()
      .then(stores => {
        console.log(`\n=== ${stores.length} Conad stores in VR ===\n`);
        for (const s of stores) {
          const vol = s.flyerCount > 0 ? ` (${s.flyerCount} flyers)` : '';
          console.log(`  [${s.anacanId}] ${s.insegna} — ${s.city}, ${s.address}${vol}`);
          console.log(`    ${s.storePageUrl}`);
        }
      })
      .catch(err => { console.error(err.message); process.exit(1); });
  } else if (cmd === 'discover') {
    const target = process.argv[3]; // optional store URL
    (async () => {
      if (target) {
        const flyers = await discoverConadFlyers(target);
        console.log(`\n=== Discovered ${flyers.length} flyers ===`);
        for (const f of flyers) {
          console.log(`  [${f.validFrom ?? '?'} → ${f.validTo ?? '?'}] ${f.title}`);
          console.log(`    ${f.pdfUrl}`);
        }
      } else {
        // Discover for all stores with flyers
        const stores = await listConadStores();
        const withFlyers = stores.filter(s => s.flyerCount > 0);
        console.log(`\nDiscovering flyers for ${withFlyers.length} stores...\n`);
        for (const store of withFlyers) {
          console.log(`--- ${store.name} (${store.city}) ---`);
          const flyers = await discoverConadFlyers(store.storePageUrl);
          for (const f of flyers) {
            console.log(`  [${f.validFrom ?? '?'} → ${f.validTo ?? '?'}] ${f.title}`);
            console.log(`    ${f.pdfUrl}`);
          }
        }
      }
    })().catch(err => { console.error(err.message); process.exit(1); });
  } else {
    console.log('Usage: npx tsx src/parsers/conad-flyer-discovery.ts [stores|discover] [url]');
  }
}
