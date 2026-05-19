/**
 * Aldi regex parser — extracts products from Aldi's structured markdown output.
 *
 * Aldi's offer page produces very clean markdown with a predictable pattern:
 *   ### BRAND Product Name
 *   [optional description line(s)]
 *   weight (e.g. "200 g", "2 x 100 g", "750 ml")
 *   original_price a confezione/al pezzo **€ offer_price** € price_per_unit/kg|litro
 *
 * This parser handles 100+ products per page in milliseconds, vs LLM which
 * times out or costs 8000+ output tokens.
 */

export interface AldiProduct {
  prodotto: string;          // product name
  brand: string | null;      // brand (first capitalized word(s))
  prezzo_originale: number | null;
  prezzo_offerta: number;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | null;
  quantita_peso: string | null;
  tipo_offerta: string;       // "a confezione", "al pezzo", "a bottiglia", etc.
  sconto_percentuale: number | null;
  categoria: string | null;   // inferred from section headers
  descrizione: string | null; // optional variant info
  image_url: string | null;
}

function parsePrice(str: string): number | null {
  const cleaned = str.replace(/[€\s*]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function extractBrand(productLine: string): { brand: string | null; name: string } {
  // Brand is a sequence of ALL-CAPS words at the start, followed by a lowercase word.
  // Examples: "IL PODERE Hamburger", "ALMARE SEAFOOD Cotolette", "IL TAGLIERE DEL RE Prosciutto", "BIO Grissini"
  // Greedy: consume as many consecutive UPPERCASE words as possible before the first lowercase.
  const tokens = productLine.split(/\s+/);
  let brandEnd = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Check if token is uppercase (allowing accented chars, apostrophes, digits, periods, slashes)
    if (/^[A-ZÀ-Ü0-9'΄./]+$/.test(t) && t.length >= 1) {
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

/**
 * Parse Aldi date-page markdown (e.g. /d.13-04-2026.html).
 *
 * These pages list products in a flat format without ### headings:
 *   [BRAND Product Name]
 *   € X,XX
 *   al pezzo (1 al kg = € Y,YY)
 *
 * Data is sparser than the main page (no original prices, no discounts),
 * but includes products missing from the main page (Occasioni Lampo XXL).
 */
export function parseAldiDatePage(markdown: string): AldiProduct[] {
  const products: AldiProduct[] = [];

  // Match product entries: [BRAND Product Name] followed by € price
  const entryRe = /\[([^\]]+)\]\s*\n\s*€\s*([\d]+[,.][\d]+)\s*\n\s*([^\n]*)/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(markdown)) !== null) {
    const fullName = m[1].trim();
    const offerPrice = parsePrice(m[2]);
    if (offerPrice === null) continue;

    const detailLine = m[3].trim();

    const { brand, name } = extractBrand(fullName);

    // Extract offer type from detail line: "al pezzo", "per chilogrammo", etc.
    const typeMatch = detailLine.match(/al\s+(?:pezzo|kg|litro|mazzo|paio)|a\s+(?:confezione|vasetto|bottiglia|lattina)|per\s+(?:chilogrammo|litro)/i);
    let offerType = typeMatch ? typeMatch[0].trim() : 'al pezzo';
    if (offerType === 'per chilogrammo') offerType = 'al kg';

    // Extract per-unit price: "1 al kg = € X,XX"
    let pricePerUnit: number | null = null;
    let unitLabel: 'kg' | 'litro' | null = null;
    const perUnitMatch = detailLine.match(/al\s+(kg|litro)\s*=\s*€\s*([\d]+[,.][\d]+)/i);
    if (perUnitMatch) {
      unitLabel = /litro/i.test(perUnitMatch[1]) ? 'litro' : 'kg';
      pricePerUnit = parsePrice(perUnitMatch[2]);
    }

    // Extract quantity from name (e.g. "Bastoncini di Surimi XXL" has no weight in name,
    // but some do: "Tonno in olio di oliva XXL 6 x 70 g")
    const qtyRe = /(\d+[.,]?\d*\s*(?:x\s*)?\d*\s*(?:g|kg|ml|cl|l|litri)\b|[\d]+\s*pezzi?)/i;
    const qtyMatch = name.match(qtyRe);
    const quantity = qtyMatch ? qtyMatch[0].replace(/\s+/g, ' ').trim() : null;
    const cleanName = qtyMatch
      ? name.replace(qtyRe, '').replace(/\s+/g, ' ').trim().replace(/,\s*$/, '')
      : name;

    products.push({
      prodotto: cleanName,
      brand,
      prezzo_originale: null,
      prezzo_offerta: offerPrice,
      prezzo_al_kg: pricePerUnit,
      unita_prezzo: unitLabel,
      quantita_peso: quantity,
      tipo_offerta: offerType,
      sconto_percentuale: null,
      categoria: null, // date pages don't have section markers
      descrizione: null,
      image_url: null, // date pages don't have product images
    });
  }

  return products;
}

/**
 * Parse Aldi main-page markdown into structured products.
 */
export function parseAldiMarkdown(markdown: string): AldiProduct[] {
  const products: AldiProduct[] = [];

  // First pass: find positions of all section markers by character index
  // This lets us assign the right category to each product based on its position
  const sectionBoundaries: Array<{ pos: number; category: string }> = [];

  const markers: Array<{ regex: RegExp; category: string }> = [
    { regex: /\[\]\(\)\s*nonfood/gi, category: 'non-food' },
    { regex: /\[\]\(\)\s*carne/gi, category: 'carne' },
    { regex: /Offerte\s+freschezza/gi, category: 'frutta-verdura' },
    { regex: /Speciale\s+Pasqua/gi, category: 'pasqua' },
    { regex: /Offerte\s+weekend/gi, category: 'weekend' },
  ];

  for (const { regex, category } of markers) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(markdown)) !== null) {
      sectionBoundaries.push({ pos: m.index, category });
    }
  }
  sectionBoundaries.sort((a, b) => a.pos - b.pos);

  function categoryAtPosition(pos: number): string {
    let cat = 'alimentari'; // default before any section marker
    for (const b of sectionBoundaries) {
      if (b.pos <= pos) cat = b.category;
      else break;
    }
    return cat;
  }

  // Split by ### headings — each product starts with ### and ends at the next ### or section marker
  // Use a regex match loop to track each heading's position in the original markdown
  const headingRegex = /^### .+?$/gm;
  const headingMatches: Array<{ index: number; line: string }> = [];
  let hm: RegExpExecArray | null;
  while ((hm = headingRegex.exec(markdown)) !== null) {
    headingMatches.push({ index: hm.index, line: hm[0] });
  }

  for (let i = 0; i < headingMatches.length; i++) {
    const startIdx = headingMatches[i].index;
    const endIdx = i + 1 < headingMatches.length ? headingMatches[i + 1].index : markdown.length;
    const chunk = markdown.slice(startIdx, endIdx);
    const currentCategory = categoryAtPosition(startIdx);

    // Look for a product image just before this heading: ![alt](url)
    const prevEnd = i > 0 ? headingMatches[i - 1].index : 0;
    const beforeHeading = markdown.slice(Math.max(prevEnd, startIdx - 200), startIdx);
    const imgMatch = beforeHeading.match(/!\[[^\]]*\]\(([^)]+)\)\s*$/);
    const chunkImageUrl = imgMatch?.[1] || null;

    // chunk starts with ### by construction

    // Extract product line (first line after ###)
    const headingMatch = chunk.match(/^###\s+(.+?)$/m);
    if (!headingMatch) continue;
    const productLine = headingMatch[1].trim();
    const { brand, name } = extractBrand(productLine);

    // Look for the main price pattern: **€ X,XX**
    const priceMatch = chunk.match(/\*\*\s*€\s*([\d]+[,\.][\d]+)\s*\*?\*?/);
    if (!priceMatch) continue; // no price = not a product
    const offerPrice = parsePrice(priceMatch[1]);
    if (offerPrice === null) continue;

    // Extract everything between the heading and the **€** price for context
    const productLineIdx = chunk.indexOf(productLine);
    const priceIdx = chunk.indexOf(priceMatch[0]);
    const productBlock = chunk.slice(productLineIdx + productLine.length, priceIdx);

    // Look for the original price (number followed by "a confezione"/"al pezzo" before the **€)
    let originalPrice: number | null = null;
    const origMatch = productBlock.match(/(\d+[,\.]\d+)\s*(?:\n\s*)?a\s*(?:confezione|vasetto|bottiglia|lattina|pezzo|scatola|tubetto|barattolo)/i);
    if (!origMatch) {
      // Alternative: number just before "al pezzo"/"al kg"/"al litro"/"al mazzo"/"al paio"
      const altMatch = productBlock.match(/(\d+[,\.]\d+)\s*(?:\n\s*)?al\s*(?:pezzo|kg|litro|mazzo|paio)/i);
      if (altMatch) originalPrice = parsePrice(altMatch[1]);
    } else {
      originalPrice = parsePrice(origMatch[1]);
    }

    // Offer type (a confezione, al pezzo, a bottiglia, a lattina, al mazzo, etc.)
    const typeMatch = productBlock.match(/(?:a\s*(?:confezione|vasetto|bottiglia|lattina|pezzo|scatola|tubetto|barattolo)|al\s*(?:pezzo|kg|litro|mazzo|paio))/i);
    const offerType = typeMatch ? typeMatch[0].trim() : 'a confezione';

    // Weight/quantity — look for patterns like "200 g", "2 x 100 g", "750 ml", "1 kg", "1 l"
    // First check the body block, then fall back to the heading (produce items often have
    // weight in the name: "### Fragole 400 g" with an empty body).
    const qtyRe = /(\d+[.,]?\d*\s*(?:x\s*)?\d*\s*(?:g|kg|ml|cl|l|litri)\b|[\d]+\s*pezzi?)/i;
    const bodyQtyMatch = productBlock.match(qtyRe);
    const headingQtyMatch = !bodyQtyMatch ? productLine.match(qtyRe) : null;
    const qtyMatch = bodyQtyMatch || headingQtyMatch;
    const quantity = qtyMatch ? qtyMatch[0].replace(/\s+/g, ' ').trim() : null;

    // If weight was extracted from the heading, strip it from the product name
    // e.g. "Fragole 400 g" → name "Fragole", quantity "400 g"
    let cleanName = name;
    if (headingQtyMatch) {
      cleanName = name.replace(qtyRe, '').replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
    }

    // Description/variant (text between name and weight, excluding prices)
    const descMatch = productBlock.match(/^\s*\n+\s*([a-zà-ü][^\n€\d]+?)\s*\n/i);
    let description: string | null = null;
    if (descMatch) {
      const desc = descMatch[1].trim();
      if (desc.length > 2 && desc.length < 120 && !/^\d/.test(desc)) {
        description = desc;
      }
    }

    // Per-unit price after the offer price: "€ X,XX/kg" or "€ X,XX/litro"
    let pricePerUnit: number | null = null;
    let unitLabel: 'kg' | 'litro' | null = null;
    const afterPrice = chunk.slice(priceIdx + priceMatch[0].length);
    const perUnitMatch = afterPrice.match(/€\s*(\d+[,\.]\d+)\s*\/\s*(kg|litro|l\b)/i);
    if (perUnitMatch) {
      pricePerUnit = parsePrice(perUnitMatch[1]);
      unitLabel = /litro|l/i.test(perUnitMatch[2]) ? 'litro' : 'kg';
    }

    // Compute discount
    let discountPct: number | null = null;
    if (originalPrice && originalPrice > offerPrice) {
      discountPct = Math.round((1 - offerPrice / originalPrice) * 100);
    }

    products.push({
      prodotto: cleanName,
      brand,
      prezzo_originale: originalPrice,
      prezzo_offerta: offerPrice,
      prezzo_al_kg: pricePerUnit,
      unita_prezzo: unitLabel,
      quantita_peso: quantity,
      tipo_offerta: offerType,
      sconto_percentuale: discountPct,
      categoria: currentCategory,
      descrizione: description,
      image_url: chunkImageUrl,
    });
  }

  return products;
}
