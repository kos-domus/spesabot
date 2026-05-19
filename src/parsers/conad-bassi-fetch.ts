/**
 * Conad "Bassi e Fissi" structural scraper.
 *
 * Replaces the old markdown-regex parser in conad.ts for the national everyday-low-price
 * page. The old approach fetched rendered markdown and used a regex to extract an optional
 * trailing image per product — which silently misaligned images when Conad's card order
 * placed the image markup BEFORE the heading rather than after. See session 2026-04-20.
 *
 * This fetcher talks to the DOM directly via Playwright. Each product card on
 * https://www.conad.it/prodotti-e-marchi/bassi-e-fissi has a container
 * `.rt213-card-product-flyer` that co-locates:
 *   - data-ean / data-code : 13-digit EAN (used to build the image URL)
 *   - data-nome            : full product name (brand + name + quantity in one string)
 *   - <img src="...ID-Shot.jpeg..."> : the product photo, bound to the same card
 *   - .rt213-card-product-flyer__validity : "Dal DD/MM al DD/MM"
 *   - text content containing "X,YY €"
 *
 * Because every datum is a child of the same card node, image→product alignment is
 * structurally guaranteed. No more off-by-one.
 *
 * The page uses infinite scroll; we scroll until the card count stops growing.
 */
import { chromium, type BrowserContext } from 'playwright';
import type { ConadProduct } from './conad.js';

const BASSI_URL = 'https://www.conad.it/prodotti-e-marchi/bassi-e-fissi';
const SCROLL_STEP_PX = 1500;
const SCROLL_PAUSE_MS = 700;
const STABLE_ROUNDS_REQUIRED = 3;
const MAX_SCROLL_ROUNDS = 80;

// Shape of a raw card extracted from the DOM.
interface RawCard {
  ean: string | null;
  nome: string;
  imageUrl: string | null;
  validity: string | null;
  priceText: string | null;
}

// Quantity suffix at the end of a product name. Same intent as conad.ts QTY_RE.
const QTY_RE = /(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|ml|cl|dl|l|pz|pezzi))\b/i;
const IMAGE_HOST = 'www.conad.it';

function parsePrice(s: string): number | null {
  const cleaned = s.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseValidity(s: string): { from: string | null; to: string | null } {
  // "Dal 1/1 al 30/4" → current year YYYY-MM-DD range
  const m = s.match(/Dal\s+(\d{1,2})\/(\d{1,2})\s+al\s+(\d{1,2})\/(\d{1,2})/i);
  if (!m) return { from: null, to: null };
  const year = new Date().getFullYear();
  const fmt = (dd: string, mm: string) => {
    const d = parseInt(dd, 10);
    const mo = parseInt(mm, 10);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  return { from: fmt(m[1], m[2]), to: fmt(m[3], m[4]) };
}

/**
 * Split a "data-nome" string into (brand, name, quantity).
 *
 * Conad's data-nome is the full concatenated label: "CONAD Ribe 1 kg",
 * "CONAD Freschi & Soffici Prosciutto Cotto di Alta Qualità 80 g", etc.
 * 99.7% of products are Conad private-label with a "CONAD" prefix.
 */
function splitDataNome(nome: string): { brand: string; name: string; quantity: string | null } {
  const trimmed = nome.trim();
  // Peel trailing quantity
  let rest = trimmed;
  let quantity: string | null = null;
  const qtyMatch = rest.match(new RegExp(`(.*?)\\s+${QTY_RE.source}\\s*$`, 'i'));
  if (qtyMatch) {
    rest = qtyMatch[1].trim();
    quantity = qtyMatch[2].trim();
  }

  // Brand: leading all-caps tokens (or literal "Conad"). Treats "CONAD" as the common case.
  const brandMatch = rest.match(/^((?:CONAD|[A-Z][A-Z.&]{1,15})(?:\s+[A-Z][A-Z.&]{1,15}){0,3})\s+(.+)$/);
  if (brandMatch) {
    const brand = /^conad$/i.test(brandMatch[1]) ? 'Conad' : brandMatch[1].trim();
    return { brand, name: brandMatch[2].trim(), quantity };
  }
  // Fallback: everything becomes name, brand defaults to Conad
  return { brand: 'Conad', name: rest, quantity };
}

/**
 * Validate that an image URL points at the conad.it product-asset path.
 * Anything else — tracking pixels, CDN rewrites, etc. — is rejected.
 */
function validateImageUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== IMAGE_HOST) return null;
    if (!u.pathname.startsWith('/assets/products/')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function scrollUntilStable(page: import('playwright').Page): Promise<number> {
  let stable = 0;
  let prevCount = 0;
  for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
    await page.evaluate(`window.scrollBy(0, ${SCROLL_STEP_PX})`);
    await page.waitForTimeout(SCROLL_PAUSE_MS);
    const count = await page.evaluate(
      `document.querySelectorAll('.rt213-card-product-flyer').length`,
    ) as number;
    if (count === prevCount) {
      stable++;
      if (stable >= STABLE_ROUNDS_REQUIRED) return count;
    } else {
      stable = 0;
      prevCount = count;
    }
  }
  return prevCount;
}

async function extractCards(page: import('playwright').Page): Promise<RawCard[]> {
  // Use string-form evaluate to avoid TS helper injection into browser context.
  const script = `
    (() => {
      const cards = Array.from(document.querySelectorAll('.rt213-card-product-flyer'));
      return cards.map((card) => {
        const ean = card.getAttribute('data-ean') || card.getAttribute('data-code') || null;
        const nome = card.getAttribute('data-nome') || '';
        const img = card.querySelector('img');
        const imageUrl = img ? img.src || img.getAttribute('data-src') || null : null;
        const validityEl = card.querySelector('.rt213-card-product-flyer__validity');
        const validity = validityEl ? (validityEl.textContent || '').trim() : null;
        const priceMatch = (card.textContent || '').match(/(\\d+[.,]\\d{1,2})\\s*€/);
        const priceText = priceMatch ? priceMatch[1] : null;
        return { ean, nome, imageUrl, validity, priceText };
      });
    })()
  `;
  return (await page.evaluate(script)) as RawCard[];
}

/**
 * Fetch and structure all products from Conad's bassi-e-fissi page.
 *
 * Returns a deduplicated array. Alignment of image_url to product is guaranteed by
 * the DOM (both come from the same card container), so the downstream ingest path
 * never needs to pair them again.
 */
export async function fetchConadBassiProducts(): Promise<ConadProduct[]> {
  const browser = await chromium.launch({ headless: true });
  let ctx: BrowserContext | null = null;
  try {
    ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'it-IT',
    });
    const page = await ctx.newPage();
    await page.goto(BASSI_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    // Wait for at least one card to render before scrolling
    await page.waitForSelector('.rt213-card-product-flyer', { timeout: 30_000 });

    const finalCount = await scrollUntilStable(page);
    console.log(`  conad-bassi: scroll settled at ${finalCount} cards`);

    const raw = await extractCards(page);
    console.log(`  conad-bassi: extracted ${raw.length} cards from DOM`);

    const products: ConadProduct[] = [];
    const seen = new Set<string>();

    for (const card of raw) {
      if (!card.nome) continue;
      const price = card.priceText ? parsePrice(card.priceText) : null;
      if (price === null) continue;

      const { brand, name, quantity } = splitDataNome(card.nome);
      if (!name) continue;

      const { from, to } = card.validity
        ? parseValidity(card.validity)
        : { from: null, to: null };

      // Dedupe on brand+name+quantity+price (the same product can appear under
      // multiple on-page category filters).
      const key = `${brand}|${name}|${quantity || ''}|${price}`;
      if (seen.has(key)) continue;
      seen.add(key);

      products.push({
        prodotto: name,
        brand,
        prezzo_offerta: price,
        prezzo_originale: null,
        prezzo_al_kg: null,
        unita_prezzo: null,
        quantita_peso: quantity,
        sconto_percentuale: null,
        validita_inizio: from,
        validita_fine: to,
        image_url: validateImageUrl(card.imageUrl),
      });
    }

    console.log(`  conad-bassi: ${products.length} deduped products, ${products.filter((p) => p.image_url).length} with image`);
    return products;
  } finally {
    if (ctx) await ctx.close();
    await browser.close();
  }
}
