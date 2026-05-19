/**
 * Despar/Eurospar/Interspar flyer parser.
 *
 * Extracts products from the text captured by navigating the iPaper-based digital
 * flyer at volantino.despar.it. Text is a continuous stream per page spread with
 * multiple products concatenated (no line breaks between products).
 *
 * Observed product patterns:
 *
 *   A) PRODUCT QUANTITY - UNIT_PRICE €/UNIT Offerta PRICE €/pz
 *      e.g. "Tonno all'olio di oliva Rio mare 3x100 g - 13,30 €/kg Offerta 3, 99 €/pz"
 *
 *   B) PRICE Offerta €/pz ... PRODUCT (price-first, detached from product)
 *      e.g. "1,89 Offerta €/pz Cereali Classic Kellogg's 550 g"
 *
 *   C) PRODUCT Offerta PRICE €/kg (sold by weight, no €/pz)
 *      e.g. "Prosciutto di San Daniele D.O.P. Offerta 13, 90 €/kg"
 *
 *   D) PRODUCT Prezzo S-BUDGET PRICE €/pz (Despar private label everyday low)
 *
 *   E) PRODUCT Ribassati del mese €/pz PRICE
 *
 * Strategy: regex-match all "Offerta PRICE €/{unit}" and "PRICE Offerta €/{unit}"
 * patterns, then look backwards from each match to extract the product name + quantity.
 */

export interface DesparProduct {
  prodotto: string;
  brand: string | null;
  prezzo_offerta: number;
  prezzo_originale: number | null;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
}

function parsePrice(s: string): number | null {
  const cleaned = s.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

// Quantity patterns: "3x100 g", "500 g", "1 L", "750 ml", "4 rotoli", "150 g"
const QTY_RE = /(\d+\s*[xX]\s*)?\d+(?:[.,]\d+)?\s*(?:g|kg|ml|cl|dl|l|pz|pezzi|filtri|lavaggi|discs|caps|rotoli|strappi)\b/i;
// Unit price: "13,30 €/kg" or "6,36 €/L"
const UNIT_PRICE_RE = /(\d+[.,]\d{2})\s*€\/(kg|l|L|pz)/;

export function parseDesparMarkdown(markdown: string): DesparProduct[] {
  const products: DesparProduct[] = [];
  const seen = new Set<string>();

  // Match ALL offer patterns with their position in the text
  const offerPatterns = [
    // "Offerta 3, 99 €/pz" or "Offerta 13, 90 €/kg"
    /Offerta\s+(\d+[.,]\s*\d{2})\s*€\/(pz|kg|l|L)/gi,
    // "3,99 Offerta €/pz" or "13,90 Offerta €/kg"
    /(\d+[.,]\s*\d{2})\s+Offerta\s+€\/(pz|kg|l|L)/gi,
    // "Prezzo S-BUDGET 3, 29 €/pz"
    /Prezzo S-BUDGET\s+(\d+[.,]\s*\d{2})\s*€\/(pz|kg|l|L)/gi,
    // "Ribassati del mese €/pz 1,69"
    /Ribassati del mese\s+€\/(pz|kg|l|L)\s+(\d+[.,]\s*\d{2})/gi,
  ];

  interface Match { price: number; unit: string; index: number; length: number }
  const allMatches: Match[] = [];

  for (const re of offerPatterns) {
    for (const m of markdown.matchAll(re)) {
      // Extract price — in "Ribassati" pattern, group order is swapped
      let priceStr: string;
      let unit: string;
      if (/Ribassati/i.test(m[0])) {
        unit = m[1];
        priceStr = m[2];
      } else {
        priceStr = m[1];
        unit = m[2];
      }
      const price = parsePrice(priceStr);
      if (price === null) continue;
      allMatches.push({
        price,
        unit: unit.toLowerCase(),
        index: m.index!,
        length: m[0].length,
      });
    }
  }

  // Sort by position in the text
  allMatches.sort((a, b) => a.index - b.index);

  for (let i = 0; i < allMatches.length; i++) {
    const match = allMatches[i];
    // Look backwards from the match to find the product name + quantity.
    // The product text is the chunk between the previous match's end and this match's start.
    const prevEnd = i > 0 ? allMatches[i - 1].index + allMatches[i - 1].length : 0;
    let chunk = markdown.slice(prevEnd, match.index).trim();

    // Clean up noise: page numbers, headers, disclaimers, QR mentions
    chunk = chunk
      .replace(/Pagina\s+\d+/g, '')
      .replace(/---\s*SPREAD\s*\d+\s*---/g, '')
      .replace(/Inquadra il QR-Code[^.]*\./g, '')
      .replace(/Dal \d+ al \d+ \w+ \d{4}/g, '')
      .replace(/Offerta promozionale valida[^.]+\./g, '')
      .replace(/ALCUNI ARTICOLI[^.]+\./g, '')
      .replace(/\*[A-Z][^*]{10,200}\*/g, '')
      .replace(/Sconto\s+\d+\s*%/gi, '')
      .replace(/Surgelati\s+/g, '')
      .replace(/-\d+%/g, '')
      .trim();

    if (chunk.length < 3) continue;

    // Extract unit price if present: "X,YY €/kg" pattern before the offer
    let unitPrice: number | null = null;
    let unitLabel: 'kg' | 'litro' | 'pezzo' | null = null;
    const upMatch = chunk.match(UNIT_PRICE_RE);
    if (upMatch) {
      unitPrice = parsePrice(upMatch[1]);
      const u = upMatch[2].toLowerCase();
      unitLabel = u === 'kg' ? 'kg' : (u === 'l' ? 'litro' : 'pezzo');
      chunk = chunk.replace(upMatch[0], '').replace(/\s*-\s*$/, '').trim();
    }

    // Extract quantity from the end of the chunk
    let quantity: string | null = null;
    const qtyMatch = chunk.match(new RegExp(`\\s+(${QTY_RE.source})\\s*$`, 'i'));
    if (qtyMatch) {
      quantity = qtyMatch[1].trim();
      chunk = chunk.slice(0, -qtyMatch[0].length).trim();
    }

    // The remaining chunk is the product name (possibly with brand prefix)
    let name = chunk.replace(/\s+/g, ' ').trim();
    if (!name || name.length < 2) continue;

    // Offer unit
    const offerUnit: 'kg' | 'litro' | 'pezzo' | null =
      match.unit === 'kg' ? 'kg' : match.unit === 'l' ? 'litro' : 'pezzo';

    // If offer is €/kg and no separate unit price, the offer price IS the unit price
    if (offerUnit === 'kg' && !unitPrice) {
      unitPrice = match.price;
    }

    // Dedupe
    const key = `${name}|${match.price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: name,
      brand: null, // Despar flyers mix brand into name — hard to separate reliably
      prezzo_offerta: match.price,
      prezzo_originale: null,
      prezzo_al_kg: unitPrice ?? (unitLabel ? null : (offerUnit === 'kg' ? match.price : null)),
      unita_prezzo: unitLabel ?? offerUnit,
      quantita_peso: quantity,
      sconto_percentuale: null,
    });
  }

  return products;
}
