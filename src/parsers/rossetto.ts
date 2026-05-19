/**
 * Rossetto (Supermercati Rossetto) parser.
 *
 * Source: https://rossettogroup.it/prezzi-rossetto-in-corso/
 *
 * Rossetto publishes individual product offers on their WordPress site,
 * not as a traditional flyer. The offers page is static HTML (~50 products)
 * with a clean card-based layout. No Playwright or login needed — plain HTTP fetch.
 *
 * Each product card has this structure:
 *
 *   <div class="card" data-category='salumi-e-formaggi'>
 *     <div class="card-offerta">
 *       <h4 class="mb-1">Product Name</h4>
 *       <img src="..." alt="...">
 *       <p class="...font-bold">fino al 19 aprile</p>
 *       <p class="...text-white...">3,48</p>          ← price
 *       <p class="text-white grammi">1,2 kg</p>       ← quantity (optional)
 *     </div>
 *   </div>
 *
 * Some products show price per kg instead of a fixed price (e.g. "9,48/kg").
 * Validity dates appear as "fino al DD mese".
 */

const OFFERS_URL = 'https://rossettogroup.it/prezzi-rossetto-in-corso/';

export interface RossettoProduct {
  prodotto: string;
  brand: string | null;
  prezzo_offerta: number;
  prezzo_originale: number | null;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
  validita_inizio: string | null;
  validita_fine: string | null;
  categoria: string | null;
  immagine_url: string | null;
}

function parsePrice(s: string): number | null {
  const cleaned = s.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

const MONTHS: Record<string, string> = {
  'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
  'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
  'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12',
};

/** Parse "fino al 19 aprile" → "2026-04-19" */
function parseValidityDate(text: string): string | null {
  const m = text.match(/fino\s+al\s+(\d{1,2})\s+(\w+)/i);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = new Date().getFullYear();
  return `${year}-${month}-${day}`;
}

/** Normalize category slug: 'salumi-e-formaggi' → 'Salumi e formaggi' */
function formatCategory(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

/**
 * Fetch the Rossetto offers page and extract all products.
 * No Playwright needed — the page is static HTML.
 */
export async function fetchAndParseRossetto(): Promise<RossettoProduct[]> {
  const response = await fetch(OFFERS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Rossetto offers: HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseRossettoHtml(html);
}

/**
 * Parse the Rossetto offers page HTML into structured products.
 */
export function parseRossettoHtml(html: string): RossettoProduct[] {
  const products: RossettoProduct[] = [];

  // Match each product card block
  // The card structure:
  //   <div ... class="...card" data-category='CATEGORY'>
  //     <div class="...card-offerta">
  //       <h4 ...>NAME</h4>
  //       <img src="IMAGE_URL" ...>
  //       <p ...>fino al DD mese</p>
  //       <p ...text-white...>PRICE</p>
  //       <p ...grammi>QUANTITY</p>  (optional)
  //     </div>
  //   </div>
  const cardRe = /data-category='([^']+)'[\s\S]*?<div[^>]*card-offerta[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>[\s\S]*?<img\s+src="([^"]*)"[\s\S]*?fino\s+al\s+(\d{1,2}\s+\w+)[\s\S]*?text-white[^>]*>(\d+[.,]\d{2}(?:\/kg)?)<\/p>(?:[\s\S]*?grammi[^>]*>([^<]*)<\/p>)?/gi;

  for (const m of html.matchAll(cardRe)) {
    const category = m[1];
    const rawName = m[2].trim().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    const imageUrl = m[3];
    const validityText = `fino al ${m[4]}`;
    const rawPrice = m[5];
    const rawQuantity = m[6]?.trim() || null;

    if (!rawName || rawName.length < 3) continue;

    // Parse price — may be "9,48/kg" for per-kg items
    const isPerKg = rawPrice.endsWith('/kg');
    const priceStr = rawPrice.replace('/kg', '');
    const price = parsePrice(priceStr);
    if (price === null) continue;

    // Parse validity date
    const validTo = parseValidityDate(validityText);

    // Try to extract brand from the product name
    // Common pattern: "Product Name Brand" — brand is the last word(s)
    // e.g. "Formaggio fresco classico Exquisa" → brand=Exquisa
    // e.g. "Birra Beck's" → brand=Beck's
    const { name, brand } = extractBrand(rawName);

    products.push({
      prodotto: name,
      brand,
      prezzo_offerta: price,
      prezzo_originale: null,
      prezzo_al_kg: isPerKg ? price : null,
      unita_prezzo: isPerKg ? 'kg' : null,
      quantita_peso: rawQuantity,
      sconto_percentuale: null,
      validita_inizio: null,
      validita_fine: validTo,
      categoria: formatCategory(category),
      immagine_url: imageUrl,
    });
  }

  return products;
}

// Known brands that appear at the end of Rossetto product names
const KNOWN_BRANDS = new Set([
  'Exquisa', 'Findus', 'Simmenthal', 'Pringles', 'Heinz', "Beck's",
  'Parmareggio', 'Rossetto', 'Primia', 'Iberia', 'Barilla', 'Mulino Bianco',
  'Buitoni', 'Knorr', 'Star', 'Rio Mare', 'Valfrutta', 'Yoga', 'Lavazza',
  'Nescafé', 'Ferrero', 'Kinder', 'Nutella', 'Plasmon', 'Pampers',
  'Scottex', 'Regina', 'Ace', 'Dash', 'Fairy', 'Svelto', 'Dixan',
  'Lysoform', 'Ajax', 'Viakal', 'Cillit Bang', "Oral-B", 'Gillette',
  'Dove', 'Nivea', 'Garnier', "L'Oréal", 'Pantene', 'Head&Shoulders',
]);

/** Try to split "Product Name Brand" into name + brand */
function extractBrand(fullName: string): { name: string; brand: string | null } {
  // Check if the last word(s) match a known brand
  const words = fullName.split(' ');
  for (let i = words.length - 1; i >= 1; i--) {
    const candidate = words.slice(i).join(' ');
    if (KNOWN_BRANDS.has(candidate)) {
      return {
        name: words.slice(0, i).join(' '),
        brand: candidate,
      };
    }
  }
  // Also check last 2 words as brand
  if (words.length >= 3) {
    const last2 = words.slice(-2).join(' ');
    if (KNOWN_BRANDS.has(last2)) {
      return { name: words.slice(0, -2).join(' '), brand: last2 };
    }
  }
  // No known brand found — keep full name, no brand
  return { name: fullName, brand: null };
}
