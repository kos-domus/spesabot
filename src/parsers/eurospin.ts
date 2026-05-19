/**
 * Eurospin PDF parser — extracts products from the digital flyer PDF.
 *
 * Source: https://digitalflyer.eurospin.it/files/{uuid}/EIT-00.pdf
 *
 * Eurospin publishes a single national PDF flyer per month (e.g. "RIBASSATI APRILE")
 * with ~178 products in a 16-page, 12-products-per-page grid.
 *
 * The PDF text (extracted with `pdftotext -raw`) follows this exact pattern per product:
 *
 *   OFFER_PRICE        <- e.g. "2,49"
 *   ORIGINAL_PRICE     <- e.g. "2,99"
 *   /                  <- separator
 *   NAME line 1        <- e.g. "CIMETTE"
 *   NAME line 2        <- e.g. "DI RAPA"
 *   WEIGHT             <- e.g. "450 g" or "330 g" or "1 kg" or "180 g"
 *   al kg Euro 5,54    <- unit price
 *
 * Some products have variants:
 *   - "cad." = "cadauno" (each piece) instead of weight
 *   - Unit price can be "al kg" or "al litro" or "al pz"
 *   - "/ 1,99\n2,49" alternative ordering near the slash
 *
 * Special items have no original price (always-low items in Eurospin)
 */

import { execFileSync } from 'node:child_process';

export interface EurospinProduct {
  prodotto: string;
  brand: string | null;
  prezzo_originale: number | null;
  prezzo_offerta: number;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
  image_url: string | null;
}

function parsePrice(s: string): number | null {
  const cleaned = s.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

const PRICE_RE = /^\d+,\d{2}$/;
const WEIGHT_RE = /^(\d+(?:[.,]\d+)?\s*(g|kg|ml|cl|dl|l|pz)\b|\d+\s*x\s*\d+\s*(g|kg|ml|cl|dl|l|pz)\b)/i;
// "al kg Euro 5,54" or "al kg Euro 5,54 2,89" (trailing price = next product's offer)
const UNIT_RE = /^al\s+(kg|litro|l|pezzo|pz)\s+Euro\s+(\d+,\d{2})(?:\s+(\d+,\d{2}))?$/i;
// "cad. 4,49" or "cad. 4,49 2,89" — sold per piece with original price (and optional next-offer carry)
const CAD_PRICE_RE = /^cad\.\s+(\d+,\d{2})(?:\s+(\d+,\d{2}))?$/i;
// "al kg" standalone — sold by weight, no fixed package size
const AL_KG_BARE_RE = /^al\s+(kg|litro|l|pezzo|pz)$/i;

/**
 * Extract text from a PDF file using pdftotext (must be installed).
 */
export function extractPdfText(pdfPath: string): string {
  try {
    return execFileSync('pdftotext', ['-raw', pdfPath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`pdftotext failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Parse Eurospin PDF text into structured products.
 *
 * Walks lines forward, recognizing product blocks that end at the `/` separator.
 * The block BEFORE `/` carries the prices; the block AFTER `/` carries name + weight + unit price.
 *
 * Layout variants handled:
 *   A) OFFER \n ORIGINAL \n /                       (clean — most common)
 *   B) OFFER \n cad. ORIGINAL \n /                  (sold per piece — 26 occurrences)
 *   C) [prev unit line ends with OFFER] \n ORIGINAL \n /   (compressed layout — 11 occurrences)
 *   D) [prev unit line ends with OFFER] \n cad. ORIGINAL \n /
 *
 * Unit price lines may be followed by trailing offer (carry) for the next product:
 *   "al kg Euro 6,94 2,89"  →  unit=6,94 for current; carry 2,89 as next product's offer
 *
 * Multi-weight products: "8 PZ" + "328 g" → combine into "8 x 328 g"
 * Bare "al kg" line = sold-by-weight item with no fixed package.
 */
export function parseEurospinPdfText(text: string): EurospinProduct[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const products: EurospinProduct[] = [];

  // Carry forward when a unit-price line ends with the next product's offer price
  let carryOffer: number | null = null;

  let i = 0;
  while (i < lines.length) {
    let offerPrice: number | null = null;
    let originalPrice: number | null = null;
    let isCadauno = false;
    let foundStart = false;

    // ── Try to detect a product start ────────────────────────────────────────
    if (carryOffer !== null) {
      // Variant C/D: offer was already captured from previous line.
      // Expect: ORIGINAL \n / OR cad. ORIGINAL \n /
      if (i + 1 < lines.length && PRICE_RE.test(lines[i]) && lines[i + 1] === '/') {
        const orig = parsePrice(lines[i])!;
        offerPrice = carryOffer;
        originalPrice = orig > carryOffer ? orig : null;
        carryOffer = null;
        i += 2;
        foundStart = true;
      } else if (i + 1 < lines.length) {
        const cadMatch = lines[i].match(CAD_PRICE_RE);
        if (cadMatch && lines[i + 1] === '/') {
          offerPrice = carryOffer;
          const orig = parsePrice(cadMatch[1])!;
          originalPrice = orig > carryOffer ? orig : null;
          isCadauno = true;
          carryOffer = null;
          i += 2;
          foundStart = true;
        }
      }
      if (!foundStart) {
        // Carry didn't match anything sensible — drop it and try normal patterns
        carryOffer = null;
      }
    }

    if (!foundStart) {
      // Variant A: PRICE \n PRICE \n /
      if (
        i + 2 < lines.length &&
        PRICE_RE.test(lines[i]) &&
        PRICE_RE.test(lines[i + 1]) &&
        lines[i + 2] === '/'
      ) {
        const p1 = parsePrice(lines[i])!;
        const p2 = parsePrice(lines[i + 1])!;
        if (p1 < p2) { offerPrice = p1; originalPrice = p2; }
        else { offerPrice = p2; originalPrice = p1; }
        i += 3;
        foundStart = true;
      }
      // Variant B: PRICE \n cad. PRICE \n /
      else if (
        i + 2 < lines.length &&
        PRICE_RE.test(lines[i]) &&
        CAD_PRICE_RE.test(lines[i + 1]) &&
        lines[i + 2] === '/'
      ) {
        const cadMatch = lines[i + 1].match(CAD_PRICE_RE)!;
        const p1 = parsePrice(lines[i])!;
        const p2 = parsePrice(cadMatch[1])!;
        offerPrice = p1 < p2 ? p1 : p2;
        originalPrice = p1 < p2 ? p2 : p1;
        isCadauno = true;
        i += 3;
        foundStart = true;
      }
    }

    if (!foundStart) {
      i++;
      continue;
    }

    // ── Collect name + weight + unit price until block ends ──────────────────
    const nameLines: string[] = [];
    const weightParts: string[] = [];
    let perUnitPrice: number | null = null;
    let unitLabel: 'kg' | 'litro' | 'pezzo' | null = null;

    let walked = 0;
    while (i < lines.length && walked < 18) {
      const line = lines[i];

      // Bail if we hit the start of the next product (Variant A, B, or carry-set)
      if (
        i + 2 < lines.length &&
        PRICE_RE.test(line) &&
        (PRICE_RE.test(lines[i + 1]) || CAD_PRICE_RE.test(lines[i + 1])) &&
        lines[i + 2] === '/'
      ) {
        break;
      }

      // Unit price line — usually the last line of the block
      const unitMatch = line.match(UNIT_RE);
      if (unitMatch) {
        const u = unitMatch[1].toLowerCase();
        unitLabel = (u === 'kg') ? 'kg' : (u === 'l' || u === 'litro') ? 'litro' : 'pezzo';
        perUnitPrice = parsePrice(unitMatch[2]);
        if (unitMatch[3]) {
          // Trailing price = next product's offer price
          carryOffer = parsePrice(unitMatch[3]);
        }
        i++;
        walked++;
        break;
      }

      // Bare "al kg" line — sold by weight, no fixed package; treat as weight signal
      if (AL_KG_BARE_RE.test(line)) {
        if (weightParts.length === 0) weightParts.push(line);
        i++;
        walked++;
        continue;
      }

      // Weight line — collect ALL of them (e.g. "8 PZ" then "328 g")
      // May have trailing price (next product's offer), e.g. "2 PZ 3,19"
      if (WEIGHT_RE.test(line)) {
        const trailingPriceMatch = line.match(/^(.*?)\s+(\d+,\d{2})$/);
        if (trailingPriceMatch && WEIGHT_RE.test(trailingPriceMatch[1])) {
          weightParts.push(trailingPriceMatch[1]);
          carryOffer = parsePrice(trailingPriceMatch[2]);
          i++;
          walked++;
          break; // weight-with-carry signals end of block (no explicit unit-price line)
        }
        weightParts.push(line);
        i++;
        walked++;
        continue;
      }

      // Skip noise (separators + page headers/footers)
      if (
        line === '/' ||
        line === 'cad.' ||
        /^Scarica l/i.test(line) ||
        /^La Spesa intelligente/i.test(line) ||
        /^Eurospin/i.test(line)
      ) {
        i++;
        walked++;
        continue;
      }

      // Stray price = we missed something; bail to next iteration
      if (PRICE_RE.test(line)) break;

      nameLines.push(line);
      i++;
      walked++;
    }

    if (nameLines.length === 0) continue;

    // Compute discount %
    let discount: number | null = null;
    if (originalPrice && offerPrice && originalPrice > offerPrice) {
      discount = Math.round((1 - offerPrice / originalPrice) * 100);
    }

    // Build weight string: combine multi-part (e.g. "8 PZ" + "328 g" → "8 PZ x 328 g")
    let weight: string | null = null;
    if (weightParts.length === 1) {
      weight = weightParts[0];
    } else if (weightParts.length > 1) {
      weight = weightParts.join(' x ');
    }

    // Clean name: strip trailing comma artifacts and squash whitespace
    let name = nameLines.join(' ').replace(/\s+/g, ' ').replace(/\s*,\s*$/, '').trim();

    // Filter out travel/vacation offers (not products) and garbled parser output.
    if (/hotel|viaggio|vacanz/i.test(name)) continue;
    // Skip products with very short names (garbled parser output)
    if (name.length < 5) continue;
    // Skip products where the name looks like a brand-only or partial parse
    if (/^(Prodotto Per|Semi -|Misura -|Sole -)/.test(name)) continue;

    products.push({
      prodotto: name,
      brand: null,
      prezzo_originale: originalPrice,
      prezzo_offerta: offerPrice!,
      prezzo_al_kg: perUnitPrice,
      unita_prezzo: unitLabel,
      quantita_peso: weight,
      sconto_percentuale: discount,
      image_url: null, // enriched later via API
    });
  }

  return products;
}

/**
 * Convenience: download a PDF from URL and parse it.
 */
export async function fetchAndParseEurospinPdf(pdfUrl: string): Promise<EurospinProduct[]> {
  const tmpFile = `/tmp/eurospin-${Date.now()}.pdf`;
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  await import('node:fs').then(fs => fs.writeFileSync(tmpFile, buf));
  const text = extractPdfText(tmpFile);
  await import('node:fs').then(fs => fs.unlinkSync(tmpFile));
  return parseEurospinPdfText(text);
}
