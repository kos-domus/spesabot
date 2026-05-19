/**
 * Lidl regex parser — extracts products from lidl.it weekly offer pages.
 *
 * Lidl pattern (within a single product card):
 *   [ProductName](url) [](url) [Brand?] ProductName
 *   [special: "3+1\n -25%*"]?
 *   OriginalPrice € -DiscountPct% OfferPrice€* Weight confezione,1 kg = PerKg €
 *   In punto vendita dal DD.MM al DD.MM
 *
 * Examples:
 *   Prosciutto cotto affettato 1.59 € -25% 1.19€* 125 g confezione,1 kg = 9.52 €
 *   Mister Choc BARRETTE AL CARAMELLO 0.49 € -28% 0.35€* 58 g confezione,1 kg = 6.03 €
 *   Salsiccia e friarielli 0.79€* 125 g confezione,1 kg = 6.32 €  (no discount)
 *   Brezel 1.96 € -25% 1.47€* 4x 95 g confezione,1 kg = 3.87 €
 */

export interface LidlProduct {
  prodotto: string;
  brand: string | null;
  prezzo_originale: number | null;
  prezzo_offerta: number;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
  validita_inizio: string | null;
  validita_fine: string | null;
  product_code: string | null; // p-code from URL
  requires_card: boolean;       // true if Lidl Plus exclusive price
  image_url: string | null;
}

function parsePrice(str: string): number | null {
  const cleaned = str.replace(/[€\s*]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

function parseLidlDate(month: string, day: string): string | null {
  const m = parseInt(month);
  const d = parseInt(day);
  if (isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Lidl shows dates as DD.MM — assume current year
  const year = new Date().getFullYear();
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse Lidl markdown into structured products.
 *
 * Strategy: split by "In punto vendita dal" delimiter — each chunk before it is one product.
 * Then extract name, prices, weight, unit price from each chunk.
 */
/**
 * @param markdown — raw page markdown
 * @param sourceUrl — optional: the page URL for detecting Lidl Plus pages
 */
export function parseLidlMarkdown(markdown: string, sourceUrl?: string): LidlProduct[] {
  const products: LidlProduct[] = [];
  const seen = new Set<string>();

  // Pattern: optional ![alt](imgUrl) BEFORE the product link, then product link,
  // ending with validity date. Images may also appear AFTER the link as [![alt](imgUrl)](href).
  const productRegex = /(?:!\[[^\]]*\]\(([^)]+)\)\s*)??\[([^\]]+?)\]\((\/p\/[^)]+\/p(\d+))\)([\s\S]*?)In punto vendita dal\s+(\d+)\.(\d+)(?:\s+al\s+(\d+)\.(\d+))?/g;

  // Detect Lidl Plus page from the SOURCE URL (not the markdown — every Lidl page
  // mentions "Lidl Plus" in the navigation, causing false positives)
  const isLidlPlusPage = sourceUrl ? /\/lidl-plus-kw-/i.test(sourceUrl) : false;

  let m: RegExpExecArray | null;
  while ((m = productRegex.exec(markdown)) !== null) {
    let imageUrl = m[1] || null;  // from ![alt](url) prefix

    // If no image before the link, look for [![alt](imgUrl)](href) right after the product link.
    // Lidl renders product images as clickable image links: [![desc](cdnUrl)](pageUrl)
    if (!imageUrl) {
      const afterLink = m[5]; // the block between product link and "In punto vendita"
      const linkedImgMatch = afterLink.match(/\[!\[[^\]]*\]\(([^)]+)\)\]/);
      if (linkedImgMatch) {
        const candidate = linkedImgMatch[1];
        // Only accept lidl.it CDN images, skip badge/seal icons (small PNGs)
        if (/lidl\.it\/assets\/gcp/.test(candidate) || /lidl\.it\/media/.test(candidate)) {
          imageUrl = candidate;
        }
      }
      // Also try standalone image after the link: ![alt](url)
      if (!imageUrl) {
        const standaloneImgMatch = afterLink.match(/!\[[^\]]*\]\(([^)]+lidl\.it\/assets\/gcp[^)]+)\)/);
        if (standaloneImgMatch) imageUrl = standaloneImgMatch[1];
      }
    }
    const linkName = m[2].trim();
    const productCode = m[4];
    const block = m[5];
    const validFrom = parseLidlDate(m[7], m[6]);
    // Non-food pages show only "dal DD.MM" without an end date.
    // Default to start + 6 days (Lidl offers typically run for a week).
    let validTo = m[8] && m[9] ? parseLidlDate(m[9], m[8]) : null;
    if (!validTo && validFrom) {
      const d = new Date(validFrom);
      d.setDate(d.getDate() + 6);
      validTo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    if (seen.has(productCode)) continue;

    // Product name: the markdown often has the name TWICE — once in the link text
    // [short name](/p/...) and once repeated after as plain text. The repeated name
    // is often more complete (e.g. "BARRETTE AL CARAMELLO E BISCOTTO" vs "AL CARAMELLO").
    // Look for a longer name in the block that contains the link name.
    let productName = linkName;
    // The block between the link and the price often repeats the full name
    const nameBlock = block.split(/\d+[.,]\d+\s*€/)[0] || '';
    const cleanBlock = nameBlock.replace(/\[.*?\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    if (cleanBlock.length > productName.length && cleanBlock.length < 120) {
      // Use the longer block text if it seems like a product name (not noise)
      if (!/confezione|In punto|vendita/i.test(cleanBlock)) {
        productName = cleanBlock;
      }
    }

    // Extract prices from block: "1.59 € -25% 1.19€*" or just "0.79€*" (no discount)
    // The OFFER price is always the one followed by `€*`
    const offerPriceMatch = block.match(/(\d+[.,]\d+)\s*€\s*\*/);
    if (!offerPriceMatch) continue;
    const offerPrice = parsePrice(offerPriceMatch[1]);
    if (offerPrice === null) continue;

    // Original price: number followed by `€` (NOT `€*`) before the offer
    let originalPrice: number | null = null;
    const beforeOffer = block.slice(0, block.indexOf(offerPriceMatch[0]));
    const origMatch = beforeOffer.match(/(\d+[.,]\d+)\s*€(?!\s*\*)/);
    if (origMatch) {
      const candidate = parsePrice(origMatch[1]);
      if (candidate !== null && candidate > offerPrice) {
        originalPrice = candidate;
      }
    }

    // Detect Lidl Plus: "Con Lidl Plus" in block, or we're on the Lidl Plus page
    const requiresCard = isLidlPlusPage || /con lidl plus/i.test(block);

    // Discount: -XX%
    const discountMatch = block.match(/-(\d+)\s*%/);
    let discount: number | null = discountMatch ? parseInt(discountMatch[1]) : null;
    if (discount === null && originalPrice && originalPrice > offerPrice) {
      discount = Math.round((1 - offerPrice / originalPrice) * 100);
    }

    // Weight: "125 g confezione" or "2x 140 g confezione" or "6 x 200 ml confezione"
    const weightMatch = block.match(/(\d+\s*[xX]\s*)?(\d+(?:[.,]\d+)?)\s*(g|kg|ml|cl|dl|l)\b/i);
    const weight = weightMatch ? weightMatch[0].replace(/\s+/g, ' ').trim() : null;

    // Per-unit price: "1 kg = 9.52 €" or "1 l = 0.74 €" or "1 pezzo = 1.89 €"
    const perUnitMatch = block.match(/1\s*(kg|l|litro|pezzo)\s*=\s*(\d+[.,]\d+)\s*€/i);
    let pricePerUnit: number | null = null;
    let unitLabel: 'kg' | 'litro' | 'pezzo' | null = null;
    if (perUnitMatch) {
      pricePerUnit = parsePrice(perUnitMatch[2]);
      const u = perUnitMatch[1].toLowerCase();
      if (u === 'kg') unitLabel = 'kg';
      else if (u === 'l' || u === 'litro') unitLabel = 'litro';
      else if (u === 'pezzo') unitLabel = 'pezzo';
    }

    // Brand detection
    const { brand, name } = extractBrand(productName);

    seen.add(productCode);
    products.push({
      prodotto: name,
      brand,
      prezzo_originale: originalPrice,
      prezzo_offerta: offerPrice,
      prezzo_al_kg: pricePerUnit,
      unita_prezzo: unitLabel,
      quantita_peso: weight,
      sconto_percentuale: discount,
      validita_inizio: validFrom,
      validita_fine: validTo,
      product_code: productCode,
      requires_card: requiresCard,
      image_url: imageUrl,
    });
  }

  return products;
}

const LIDL_BRANDS = new Set([
  'MISTER CHOC', 'MILBONA', 'FREEWAY', 'CHIASSO', 'CIEN', 'CRIVIT', 'PARKSIDE',
  'LUPILU', 'LIVARNO', 'ESMARA', 'PRINTON', 'SILVERCREST', 'METCRAFT', 'SOLEVITA',
  'COMBINO', 'DULANO', 'MERADISO', 'PILOS', 'BELLAROM', 'KIM', 'SOTTO COSTO',
  'ITALIAMO', 'FAVORINA', 'MELDORIA', 'MEISTERSCHNITT', 'BARESA', 'BELBAKE',
  'ALESTO', 'GRANDIOL', 'SONAX', 'PHILIPS', 'DUC DE COEUR', 'CHEF SELECT',
  'VEMONDO', 'W5',
]);

function extractBrand(productLine: string): { brand: string | null; name: string } {
  const upperLine = productLine.toUpperCase();
  const sortedBrands = Array.from(LIDL_BRANDS).sort((a, b) => b.length - a.length);
  for (const brand of sortedBrands) {
    if (upperLine.startsWith(brand + ' ')) {
      return { brand, name: productLine.slice(brand.length).trim() };
    }
  }
  // Some lines start with a single capitalised word like "Freeway Tè da infuso"
  // Use the same greedy uppercase-token detection
  const tokens = productLine.split(/\s+/);
  if (tokens.length > 1 && /^[A-ZÀ-Ü][A-ZÀ-Ü']+$/.test(tokens[0])) {
    return {
      brand: tokens[0],
      name: tokens.slice(1).join(' '),
    };
  }
  // Title-case brand (first word starts with capital, multi-word product after)
  // For Lidl, most products don't have a brand; default to null
  return { brand: null, name: productLine.trim() };
}
