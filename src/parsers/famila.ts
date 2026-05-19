/**
 * Famila regex parser — extracts products from promo.famila.it markdown.
 *
 * Famila pages have two product list formats, both fully parseable:
 *
 * Format A (detailed cards with ### heading):
 *   [Valido dal DD/MM/YYYY al DD/MM/YYYY ** -XX%
 *   ### BRAND PRODUCT NAME 150 G
 *    €original €offer KG €perkg](url-with-cod-XXXXX)
 *
 * Format B (compact line):
 *   [-XX% ** BRAND PRODUCT NAME 250 G €original €offer KG €perkg](url)
 *
 * Both formats give us: discount %, name, weight, original price, offer price, price/kg|L
 */

export interface FamilaProduct {
  prodotto: string;
  brand: string | null;
  prezzo_originale: number | null;
  prezzo_offerta: number;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'etto' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
  validita_inizio: string | null;
  validita_fine: string | null;
  product_code: string | null;
  image_url: string | null;
}

const ITALIAN_BRANDS = new Set([
  'BARILLA', 'MULINO BIANCO', 'GALBANI', 'PARMALAT', 'GRANAROLO', 'MULLER', 'MÜLLER',
  'MONINI', 'BERTOLLI', 'CARAPELLI', 'GIOVANNI RANA', 'RANA', 'BUITONI', 'KNORR',
  'NESTLE', 'NESTLÉ', 'FERRERO', 'MOTTA', 'BAULI', 'PAVESI', 'DORIA', 'ZUEGG',
  'STAR', 'CIRIO', 'LA DORIA', 'MUTTI', 'POMI', 'SAN PELLEGRINO', 'LEVISSIMA',
  'COCA COLA', 'COCA-COLA', 'PEPSI', 'SAN BENEDETTO', 'AMITA', 'YOMO', 'MILKA',
  'KINDER', 'NUTELLA', 'LAVAZZA', 'ILLY', 'SEGAFREDO', 'KIMBO', 'SAN CARLO',
  'AMICA CHIPS', 'PRINGLES', 'FONZIES', 'GALBANI', 'INVERNIZZI', 'CASTELLI',
  'BELPAESE', 'SOTTILETTE', 'PHILADELPHIA', 'STELLA', 'CAMEO', 'PANEANGELI',
  'ELLEDI', 'COLUSSI', 'GRANCEREALE', 'MISURA', 'VITASNELLA', 'KELLOGG',
  'CESARIN', 'PERONI', 'NASTRO AZZURRO', 'MORETTI', 'HEINEKEN', 'BIRRA MORETTI',
  'BARILLA', 'DE CECCO', 'VOIELLO', 'GAROFALO', 'AGNESI', 'LA MOLISANA',
  'FRATELLI CECCHIN', 'IL TAGLIERE', 'IL PODERE', 'SMART-TECH',
]);

function parsePrice(str: string): number | null {
  const cleaned = str.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

function parseItalianDate(str: string): string | null {
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function extractBrand(productLine: string): { brand: string | null; name: string } {
  // Try multi-word brands first (longest match wins)
  const upperLine = productLine.toUpperCase();
  const sortedBrands = Array.from(ITALIAN_BRANDS).sort((a, b) => b.length - a.length);
  for (const brand of sortedBrands) {
    if (upperLine.startsWith(brand + ' ')) {
      return { brand, name: productLine.slice(brand.length).trim() };
    }
  }

  // Fallback: greedy uppercase token consumption (like Aldi)
  const tokens = productLine.split(/\s+/);
  let brandEnd = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[A-ZÀ-Ü0-9'΄&]+$/.test(t) && t.length >= 2) {
      brandEnd = i + 1;
    } else {
      break;
    }
  }
  if (brandEnd > 0 && brandEnd < tokens.length) {
    return {
      brand: tokens.slice(0, brandEnd).join(' '),
      name: tokens.slice(brandEnd).join(' '),
    };
  }
  return { brand: null, name: productLine.trim() };
}

function extractWeight(productName: string): { weight: string | null; nameWithoutWeight: string } {
  // Match weight at end: "150 G", "750 ML", "1 KG", "1,5 L", "8X 125 G", etc.
  const weightRegex = /\s*(\d+\s*[xX]\s*)?(\d+(?:[.,]\d+)?)\s*(KG|G|HG|L|ML|CL|DL|GR)\b\.?\s*$/i;
  const m = productName.match(weightRegex);
  if (m) {
    const weight = m[0].trim();
    return {
      weight,
      nameWithoutWeight: productName.slice(0, m.index).trim(),
    };
  }
  return { weight: null, nameWithoutWeight: productName };
}

/**
 * Parse Famila markdown into structured products.
 *
 * Strategy: extract every link bracket [...] containing a price pattern.
 * Handles both Format A (### heading) and Format B (compact).
 */
export function parseFamilaMarkdown(markdown: string): FamilaProduct[] {
  const products: FamilaProduct[] = [];
  const seen = new Set<string>(); // dedup by product_code

  // Capture link pattern: [content](url), optionally preceded by ![img](imageUrl)
  // Content has either "### NAME" (Format A) or starts with "-XX%" (Format B)
  // Use [^\]]* to match content not containing ']' (won't span links)
  const linkRegex = /(?:!\[img\]\(([^)]+)\))?\[([^\]]+?)\]\((\/nord\/punti-vendita\/[^)]+)\)/g;

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(markdown)) !== null) {
    const imageUrl = m[1] || null; // from ![img](url) prefix, if present
    const content = m[2];
    const url = m[3];

    // Extract product code from URL: cod-XXXXXXX
    const codeMatch = url.match(/cod-(\d+)/);
    const productCode = codeMatch ? codeMatch[1] : null;
    if (!productCode || seen.has(productCode)) continue;

    // Discount: -XX% (after asterisks or at start)
    const discountMatch = content.match(/-(\d+)\s*%/);
    if (!discountMatch) continue;
    const discount = parseInt(discountMatch[1]);

    // Validity dates — match "dal X al Y" (with or without year)
    const dateRangeMatch = content.match(/dal\s+(\d{2}\/\d{2}(?:\/\d{4})?)\s+al\s+(\d{2}\/\d{2}(?:\/\d{4})?)/);
    let validFrom: string | null = null;
    let validTo: string | null = null;
    if (dateRangeMatch) {
      // If year is missing, append current year
      const year = new Date().getFullYear();
      const from = dateRangeMatch[1].includes('/') && dateRangeMatch[1].split('/').length === 3
        ? dateRangeMatch[1] : `${dateRangeMatch[1]}/${year}`;
      const to = dateRangeMatch[2].includes('/') && dateRangeMatch[2].split('/').length === 3
        ? dateRangeMatch[2] : `${dateRangeMatch[2]}/${year}`;
      validFrom = parseItalianDate(from);
      validTo = parseItalianDate(to);
    }

    // Product name + prices
    // Format A: "### NAME 150 G\n €1.25 €0.65 KG €4.33"
    // Format B: "-30% ** NAME 125 G €1.99 €1.39 KG €11.12"
    let productLine: string;
    let priceSection: string;

    const headingMatch = content.match(/###\s+([^\n]+)/);
    if (headingMatch) {
      // Format A
      productLine = headingMatch[1].trim();
      const afterHeading = content.slice(content.indexOf(headingMatch[0]) + headingMatch[0].length);
      priceSection = afterHeading;
    } else {
      // Format B: extract everything after "-XX%" (with optional ** or validity dates)
      const compactMatch = content.match(/-\d+%\s*(?:\*+\s*)?(?:Valido\s+dal\s+\S+\s+al\s+\S+\s*)?(.+?)$/s);
      if (!compactMatch) continue;
      const rest = compactMatch[1].trim();
      // Find first € — text before is product name, text from € is prices
      const euroIdx = rest.indexOf('€');
      if (euroIdx < 0) continue;
      productLine = rest.slice(0, euroIdx).trim();
      priceSection = rest.slice(euroIdx);
    }

    // Extract prices from the price section
    // Patterns: €1.25 €0.65 KG €4.33  OR  €399.00 €299.00  OR  €2.95 €2.19 all'etto
    const priceMatches = [...priceSection.matchAll(/€\s*([\d]+[.,][\d]+)/g)];
    if (priceMatches.length < 1) continue;

    const prices = priceMatches.map(p => parsePrice(p[1])).filter((p): p is number => p !== null);
    if (prices.length === 0) continue;

    // Heuristics:
    // - If 3 prices: [original, offer, perKg]
    // - If 2 prices and second is smaller: [original, offer]
    // - If 1 price: [offer] only
    let originalPrice: number | null = null;
    let offerPrice: number;
    let perUnitPrice: number | null = null;

    if (prices.length >= 3) {
      originalPrice = prices[0];
      offerPrice = prices[1];
      perUnitPrice = prices[2];
    } else if (prices.length === 2) {
      if (prices[0] > prices[1]) {
        originalPrice = prices[0];
        offerPrice = prices[1];
      } else {
        offerPrice = prices[0];
      }
    } else {
      offerPrice = prices[0];
    }

    // Detect unit (KG, L, etto, etc.) — looks for "KG €X.XX" or "L €X.XX" or "all'etto"
    let unit: 'kg' | 'litro' | 'etto' | null = null;
    if (/KG\s*€/.test(priceSection) || /\/kg/i.test(priceSection)) unit = 'kg';
    else if (/\bL\s*€/.test(priceSection) || /\/litro/i.test(priceSection)) unit = 'litro';
    else if (/all'?etto|hg|\/100\s*g/i.test(priceSection)) unit = 'etto';

    // Extract weight from product name and clean it up
    const { weight, nameWithoutWeight } = extractWeight(productLine);
    const { brand, name } = extractBrand(nameWithoutWeight);

    seen.add(productCode);
    products.push({
      prodotto: name,
      brand,
      prezzo_originale: originalPrice,
      prezzo_offerta: offerPrice,
      prezzo_al_kg: perUnitPrice,
      unita_prezzo: unit,
      quantita_peso: weight,
      sconto_percentuale: discount,
      validita_inizio: validFrom,
      validita_fine: validTo,
      product_code: productCode,
      image_url: imageUrl,
    });
  }

  return products;
}
