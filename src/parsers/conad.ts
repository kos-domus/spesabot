/**
 * Conad "Bassi e Fissi" parser — extracts everyday-low-price products from
 * https://www.conad.it/prodotti-e-marchi/bassi-e-fissi
 *
 * These are Conad's nationally-fixed "always low price" items (~700-750 products,
 * valid for an entire quarter). Unlike the weekly flyers (which require store login),
 * this page is fully public.
 *
 * The Playwright-rendered page produces markdown in a dead-simple 3-line pattern:
 *
 *   Dal DD/MM al DD/MM
 *   BRAND Product name quantity
 *   PRICE €
 *
 * Examples:
 *   Dal 1/1 al 30/4
 *   CONAD Ribe 1 kg
 *   2,29 €
 *
 *   Dal 1/1 al 30/4
 *   CONAD Freschi & Soffici Prosciutto Cotto di Alta Qualità 80 g
 *   1,59 €
 *
 * Brand detection: 99.7% of products are Conad-private-label with "CONAD" prefix.
 * A few (~5) have different brand prefixes — we try to detect them, otherwise fall
 * back to "Conad".
 */

export interface ConadProduct {
  prodotto: string;
  brand: string | null;
  prezzo_offerta: number;
  prezzo_originale: number | null; // always null for bassi-e-fissi
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null; // always null (no "before" price shown)
  validita_inizio: string | null;
  validita_fine: string | null;
  image_url: string | null;
}

function parsePrice(s: string): number | null {
  const cleaned = s.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

/** Convert "DD/MM" + current year to "YYYY-MM-DD". */
function parseConadDate(dd: string, mm: string): string | null {
  const d = parseInt(dd, 10);
  const m = parseInt(mm, 10);
  if (isNaN(d) || isNaN(m) || d < 1 || d > 31 || m < 1 || m > 12) return null;
  const year = new Date().getFullYear();
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Quantity trailing the product name: "1 kg", "80 g", "2 x 80 g", "16 x 31,25 g", "160 pz"
const QTY_RE = /(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|ml|cl|dl|l|pz|pezzi))\b/i;

/**
 * Parse the Conad bassi-e-fissi page content.
 *
 * Handles two observed renderings:
 *
 * 1. Plain text (direct `page.innerText`):
 *      Dal DD/MM al DD/MM
 *      BRAND Product name quantity
 *      PRICE €
 *
 * 2. Playwright markdown (what deep-research actually stores):
 *      #### BRAND Product name quantity
 *      PRICE € Dal DD/MM al DD/MM
 *
 * Strategy: a single regex matches either layout by allowing the validity marker
 * to appear either immediately before the product heading or inline after the price.
 */
export function parseConadMarkdown(markdown: string): ConadProduct[] {
  const products: ConadProduct[] = [];
  const seen = new Set<string>();

  // Match a Conad product block:
  //   - Optional leading #### (Playwright h4 rendering)
  //   - BRAND (1+ upper-case tokens, or the literal "Conad")
  //   - Product name (any characters)
  //   - Price "X,YY €"
  //   - Validity "Dal DD/MM al DD/MM"
  // The regex is non-anchored and uses lazy matching so adjacent products don't bleed.
  //
  // NOTE: image capture intentionally removed. Conad's rendered markdown often lists
  // the image BEFORE the heading rather than after the price, so the optional trailing
  // group was silently picking up the NEXT product's image and mis-assigning it.
  // See session 2026-04-20 for context. A dedicated image fetcher (by EAN) is the
  // proper fix and lives in a follow-up session.
  const productRe =
    /(?:####\s*)?(?<brand>CONAD|Conad|[A-Z][A-Z.&]{1,15}(?:\s+[A-Z][A-Z.&]{1,15}){0,3})\s+(?<rest>[^\n]{2,200}?)\s+(?<price>\d+[.,]\d{1,2})\s*€\s*Dal\s+(?<fromDay>\d{1,2})\/(?<fromMonth>\d{1,2})\s+al\s+(?<toDay>\d{1,2})\/(?<toMonth>\d{1,2})/gi;

  for (const match of markdown.matchAll(productRe)) {
    const g = match.groups!;
    const price = parsePrice(g.price);
    if (price === null) continue;

    const validFrom = parseConadDate(g.fromDay, g.fromMonth);
    const validTo = parseConadDate(g.toDay, g.toMonth);

    // Normalize brand case
    const brand = /^conad$/i.test(g.brand) ? 'Conad' : g.brand.trim();

    // Peel the trailing quantity off the product name
    let name = g.rest.trim();
    let quantity: string | null = null;
    const qtyMatch = name.match(new RegExp(`(.*?)\\s+${QTY_RE.source}\\s*$`, 'i'));
    if (qtyMatch) {
      name = qtyMatch[1].trim();
      quantity = qtyMatch[2].trim();
    }

    if (!name) continue;

    // Dedupe: the page lists products under multiple category filters
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
      validita_inizio: validFrom,
      validita_fine: validTo,
      image_url: null,
    });
  }

  return products;
}
