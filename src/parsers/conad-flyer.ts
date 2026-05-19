/**
 * Conad weekly flyer (volantino) parser — extracts products from store-specific
 * promotional PDF flyers.
 *
 * Source: Conad weekly flyers (e.g. "Spazio Conad Bussolengo 17-29 Aprile 2026")
 *
 * These PDFs are design-heavy promotional flyers with ~100-150 products across
 * ~16 food pages + non-food pages. Text extracted via `pdftotext -raw` follows
 * several product patterns depending on the section:
 *
 * ── Pattern A: Discounted product (most common, pages 1-11) ──
 *
 *   PRODUCT NAME
 *   BRAND
 *   variant, description
 *   QUANTITY
 *   anziché €/kg ORIG_UNIT  ← optional
 *   OFFER€                  ← offer price (number then €)
 *   €/kg UNIT_PRICE         ← optional
 *   -XX%                    ← discount percentage
 *   € ORIGINAL              ← original price (€ then number, strikethrough in PDF)
 *
 * ── Pattern B: Fixed-price product (no discount) ──
 *
 *   PRODUCT NAME
 *   BRAND
 *   QUANTITY
 *   X,YY €
 *   €/kg Z,ZZ
 *
 * ── Pattern C: Percentage-only discount ──
 *
 *   PRODUCT NAME
 *   BRAND
 *   XX
 *   SCONTO %
 *
 * ── Pattern D: Deli/counter products (per-kg, page 12+) ──
 *
 *   PRODUCT NAME
 *   BRAND
 *   X,YY
 *   €
 *   al kg
 *
 * Strategy: Find price+discount anchors, then look backwards for product name
 * and quantity. Multiple passes handle different product patterns.
 */

export interface ConadFlyerProduct {
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
}

function parsePrice(s: string): number | null {
  const cleaned = s.replace(/[€\s]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

/** Extract validity dates from header: "DA VENERDÌ 17 A MERCOLEDÌ 29 APRILE 2026" */
function parseFlyerDates(text: string): { from: string | null; to: string | null } {
  // "DA ... DD A ... DD MESE YYYY" or "DAL DD AL DD MESE YYYY"
  const months: Record<string, string> = {
    'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
    'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
    'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12',
  };

  // "DA ... DD A ... DD MESE YYYY"
  // Use \S+ instead of \w+ because day names have accented chars (VENERDÌ, MERCOLEDÌ)
  const re = /DA\s+\S+\s+(\d{1,2})\s+A\s+\S+\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i;
  const m = text.match(re);
  if (m) {
    const mm = months[m[3].toLowerCase()];
    if (mm) {
      const from = `${m[4]}-${mm}-${m[1].padStart(2, '0')}`;
      const to = `${m[4]}-${mm}-${m[2].padStart(2, '0')}`;
      return { from, to };
    }
  }

  // "DAL DD AL DD MESE YYYY"
  const re2 = /DAL\s+(\d{1,2})\s+AL\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i;
  const m2 = text.match(re2);
  if (m2) {
    const mm = months[m2[3].toLowerCase()];
    if (mm) {
      const from = `${m2[4]}-${mm}-${m2[1].padStart(2, '0')}`;
      const to = `${m2[4]}-${mm}-${m2[2].padStart(2, '0')}`;
      return { from, to };
    }
  }

  // "VENERDÌ 17 A MERCOLEDÌ 29 APRILE 2026" variant (also handles cross-month)
  const re3 = /(\d{1,2})\s+(?:\w+\s+)?A\s+\w+\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i;
  const m3 = text.match(re3);
  if (m3) {
    const mm = months[m3[3].toLowerCase()];
    if (mm) {
      const from = `${m3[4]}-${mm}-${m3[1].padStart(2, '0')}`;
      const to = `${m3[4]}-${mm}-${m3[2].padStart(2, '0')}`;
      return { from, to };
    }
  }

  return { from: null, to: null };
}

// Known quality/label badges that appear as separate lines but aren't product names
const NOISE_LINES = new Set([
  'LATTE ITALIANO', 'PRODOTTO ITALIANO', 'CARNE ITALIANA', 'POLLO ITALIANO',
  'BROCCOLI ITALIANI', 'POMODORO ITALIANO',
  'OFFERTA RISERVATA', 'ANCORA PIÙ CONVENIENTE',
  'QUESTO PRODOTTO TI REGALA', 'SCELTE DI BENESSERE',
  'IL BUONO DEL PAESE', 'PERCORSO QUALITÀ',
]);

// Patterns that must never be mistaken for a product name or brand.
// - Date header variants (flyer validity banners): "DA MARTEDÌ 7 A GIOVEDÌ 16 APRILE 2026" etc.
// - Loyalty qualifiers: "SOLO TITOLARI" appears above promo prices, means "loyalty members only".
// - Color/descriptor fragments wrongly promoted to brand: "ROSSI E GIALLI" (red+yellow peppers),
//   "BIANCO E ROSSO", "ITALIANI/E/A/O", "FRESCHI/E", etc. — these describe the product, not a brand.
const DATE_HEADER_RE = /^(DA|DAL|FINO\s+A)\s+(LUN|MART|MERC|GIOV|VEN|SAB|DOM|\d{1,2})\S*\s+.*\s+(GENN|FEBB|MARZ|APR|MAG|GIU|LUG|AGO|SETT|OTT|NOV|DIC)/i;
const LOYALTY_RE = /^(SOLO\s+TITOLARI|TITOLARI|CARTA\s+INSIEME|CARTAINSIEME|SPAZIO\s+CONAD|OFFERTA\s+RISERVATA|RISERVATA|PER\s+TE)$/i;
const DESCRIPTOR_NOT_BRAND_RE = /^(ROSSI\s+E\s+GIALLI|BIANCO\s+E\s+ROSSO|ITALIAN[AIEO]|FRESCH[IE]|CLASSIC[IO]|GUSTI\s+ASSORTITI|TIPI\s+ASSORTITI|VARIE\s+FANTASIE|VARI\s+GUSTI|MISTI|VARIET[AÀ]|SELEZIONATI|ARTIGIANAL[EI]|TRADIZIONALE|PICCANTE|DOLCE|NATURALE|BIOLOGIC[OA])$/i;

// Lines that signal page/section noise
const NOISE_RE = /^(FIN\s*O\s*AL|SUPERMARCHE|Le migliori marche|OFFERTA VALIDA|OFFERTARISERVATA|per gli orari|consultare il sito|BUSSOLENGO|S\.S\.\s+\d|CENTRO COMMERCIALE|PORTE DELL|spazio|Persone oltre|Prenditi cura|Scopri|Amplifica|Hai poco tempo|Bastano cinque|Gustosa focaccia|Il classico kaiser|Inquadra|Ritira la tua|punto|punti miPREMIO|E PAGANDO CON|CARTA INSIEME|I PUNTI INDICATI|Buongustaio|Fornaio|Macellaio|Pescatore|Contadino|Convenienti|PREPARATO DA NOI|RISPARMIO GARANTITO|Centinaia di prodotti|BUCATO E|Per una casa|CAMBIO STAGIONE|TUTTO PER LA CASA|Arreda|Vivi il tuo|Spazio alla|STORIE DA|INIZIATIVA RISERVATA|RACCOGLI I BUONI|DAL \d+ AL \d+|Da Conad|parafarmacia|PetStore|HeyConad|VACANZA|SPONSOR|GRANDE CONCORSO|solo se paghi|Regolamento|©Disney|GUARDA I VOLANTINI|SCARICA L.APP|La merce è disponibile|L.iniziativa è valida|CARTAINSIEME|CARTAINSIEMEPIÙ|carta\s*alla|Offerta valida nei|cheespongonoil|I prezzi possono|Nell.ambito del programma|Iniziativa.*RIMBORSIAMO|ACQUISTA.*COLORAZIONE|SODDISFATT|PROVA 1 NOVITÀ)/i;

// Quantity pattern
const QTY_RE = /\b(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|ml|cl|dl|l|litro|litri|pz|pezzi|rotoli|filtri|lavaggi|capsule|compresse|foglietti|fogli|buste|pacchetti|pezzi))\b/i;

// Multi-pack: "250 g x 4" or "100 g x 2" or "660 ml x4"
const MULTIPACK_RE = /\b(\d+(?:[.,]\d+)?\s*(?:g|kg|ml|cl|dl|l)\s*x\s*\d+)\b/i;


/**
 * Parse a Conad weekly flyer's text content.
 * Input: full text from pdftotext -raw or equivalent text extraction.
 */
export function parseConadFlyerText(rawText: string): ConadFlyerProduct[] {
  // Pre-clean: strip "FIN O AL" noise from the "FINO AL 50%" splash graphics
  const text = rawText
    // Strip "FINO AL 50%" splash graphics
    .replace(/FIN\s*O\s*AL\s*(?:OAL\s*)?/g, '')
    // Strip quality badges that appear between price blocks and break regex matching
    // e.g. "€/kg 3,32\nBROCCOLI\nITALIANI\n-20%" → "€/kg 3,32\n-20%"
    .replace(/\n\s*(?:LATTE|BROCCOLI|POMODORO|PRODOTTO|CARNE|POLLO)\s*\n\s*ITALIAN[OAI]\s*\n/gi, '\n');
  const products: ConadFlyerProduct[] = [];
  const seen = new Set<string>();

  // Extract flyer validity dates from header
  const { from: validFrom, to: validTo } = parseFlyerDates(text);

  // ── Pass 1: Discounted products ──
  // Anchor: "X,YY€" (offer) + "-XX%" (discount) + "€ Y,YY" (original)
  // These three elements appear close together, sometimes on the same line.
  // Matches: "X,YY€ ... -XX% € Y,YY" with optional "anziché €/kg Z,ZZ" or "€/kg Z,ZZ" between
  const discountRe =
    /(\d+[.,]\d{2})\s*€\s*(?:(?:anziché\s+)?€\/(?:kg|l)\s*\d+[.,]\d{2}\s*)?-(\d+)\s*%\s*€\s*(\d+[.,]\d{2})/g;

  for (const m of text.matchAll(discountRe)) {
    const offerPrice = parsePrice(m[1]);
    const discount = parseInt(m[2], 10);
    const originalPrice = parsePrice(m[3]);
    if (!offerPrice || !originalPrice) continue;

    // Look backwards from the match for product name + quantity
    const before = text.slice(Math.max(0, m.index! - 500), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    // Look for unit price near the match (before or after)
    const around = text.slice(Math.max(0, m.index! - 100), m.index! + m[0].length + 80);
    const unitInfo = extractUnitPrice(around);

    // Also check for "anziché" original unit price
    const anziché = extractAnzichéPrice(around);

    const key = `${product.name}|${offerPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: offerPrice,
      prezzo_originale: originalPrice,
      prezzo_al_kg: unitInfo?.price ?? anziché?.originalUnitPrice ?? null,
      unita_prezzo: unitInfo?.unit ?? anziché?.unit ?? null,
      quantita_peso: product.quantity,
      sconto_percentuale: discount,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  // ── Pass 2: Products with "anziché" pattern but discount on separate line ──
  // "anziché €/kg Y,YY X,YY€\n€/kg Z,ZZ\n-XX%\n€ W,WW"
  const anzichéRe =
    /anziché\s+€\/(kg|l)\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s*€\s*€\/(kg|l)\s+(\d+[.,]\d{2})\s*-(\d+)\s*%\s*€\s*(\d+[.,]\d{2})/gi;

  for (const m of text.matchAll(anzichéRe)) {
    const unit = m[1].toLowerCase() === 'kg' ? 'kg' as const : 'litro' as const;
    const origUnitPrice = parsePrice(m[2]);
    const offerPrice = parsePrice(m[3]);
    const offerUnitPrice = parsePrice(m[5]);
    const discount = parseInt(m[6], 10);
    const originalPrice = parsePrice(m[7]);
    if (!offerPrice || !originalPrice) continue;

    const before = text.slice(Math.max(0, m.index! - 500), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    const key = `${product.name}|${offerPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: offerPrice,
      prezzo_originale: originalPrice,
      prezzo_al_kg: offerUnitPrice ?? origUnitPrice ?? null,
      unita_prezzo: unit,
      quantita_peso: product.quantity,
      sconto_percentuale: discount,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  // ── Pass 3: Fixed-price products ──
  // Pattern: "X,YY €\n€/kg Z,ZZ" or "X,YY € /conf\n€/kg Z,ZZ" (no discount)
  // Must NOT be already captured in pass 1/2
  const fixedRe =
    /(\d+[.,]\d{2})\s*€\s*(?:\/conf)?\s*€\/(kg|l)\s+(\d+[.,]\d{2})/g;

  for (const m of text.matchAll(fixedRe)) {
    const offerPrice = parsePrice(m[1]);
    const unitLabel = m[2].toLowerCase() === 'kg' ? 'kg' as const : 'litro' as const;
    const unitPrice = parsePrice(m[3]);
    if (!offerPrice) continue;

    const before = text.slice(Math.max(0, m.index! - 500), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    const key = `${product.name}|${offerPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: offerPrice,
      prezzo_originale: null,
      prezzo_al_kg: unitPrice,
      unita_prezzo: unitLabel,
      quantita_peso: product.quantity,
      sconto_percentuale: null,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  // ── Pass 4: Deli/counter products priced per kg ──
  // Pattern: "PRODUCT\nX,YY\n€\nal kg" or "X,YY€\nal kg"
  const deliRe = /(\d+[.,]\d{2})\s*€?\s*\nal\s+kg/gi;

  for (const m of text.matchAll(deliRe)) {
    const price = parsePrice(m[1]);
    if (!price) continue;

    const before = text.slice(Math.max(0, m.index! - 400), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    const key = `${product.name}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: price,
      prezzo_originale: null,
      prezzo_al_kg: price,
      unita_prezzo: 'kg',
      quantita_peso: null,
      sconto_percentuale: null,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  // ── Pass 5: Percentage-only discounts ──
  // Pattern: "XX\nSCONTO %" or "XX%\nSCONTO"
  const pctOnlyRe = /(\d{2})\s*\n\s*SCONTO\s*%/gi;

  for (const m of text.matchAll(pctOnlyRe)) {
    const discount = parseInt(m[1], 10);
    if (discount < 5 || discount > 60) continue;

    const before = text.slice(Math.max(0, m.index! - 400), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    const key = `${product.name}|sconto${discount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: 0, // Unknown — only percentage discount shown
      prezzo_originale: null,
      prezzo_al_kg: null,
      unita_prezzo: null,
      quantita_peso: product.quantity,
      sconto_percentuale: discount,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  // ── Pass 6: Bare price + unit price (PRODOTTI ALLA CARTA loyalty flyer) ──
  // Pattern: "X,YY\n€/kg Z,ZZ" or "X,YY\n€/l Z,ZZ" — price WITHOUT € suffix
  // Only matches prices not already captured (bare numbers preceded by a newline)
  const barePriceRe = /\n(\d+[.,]\d{2})\s*\n€\/(kg|l)\s+(\d+[.,]\d{2})/g;

  for (const m of text.matchAll(barePriceRe)) {
    const offerPrice = parsePrice(m[1]);
    const unitLabel = m[2].toLowerCase() === 'kg' ? 'kg' as const : 'litro' as const;
    const unitPrice = parsePrice(m[3]);
    if (!offerPrice) continue;

    const before = text.slice(Math.max(0, m.index! - 500), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    const key = `${product.name}|${offerPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: offerPrice,
      prezzo_originale: null,
      prezzo_al_kg: unitPrice,
      unita_prezzo: unitLabel,
      quantita_peso: product.quantity,
      sconto_percentuale: null,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  // ── Pass 7: Standalone percentage (PRODOTTI ALLA CARTA loyalty flyer) ──
  // Pattern: product description followed by "XX%" on its own line (no "SCONTO" keyword)
  const standalPctRe = /\n(\d{1,2})%\s*\n/g;

  for (const m of text.matchAll(standalPctRe)) {
    const discount = parseInt(m[1], 10);
    if (discount < 5 || discount > 60) continue;

    const before = text.slice(Math.max(0, m.index! - 400), m.index!);
    const product = extractProductFromContext(before);
    if (!product) continue;

    const key = `${product.name}|sconto${discount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      prodotto: product.name,
      brand: product.brand,
      prezzo_offerta: 0,
      prezzo_originale: null,
      prezzo_al_kg: null,
      unita_prezzo: null,
      quantita_peso: product.quantity,
      sconto_percentuale: discount,
      validita_inizio: validFrom,
      validita_fine: validTo,
    });
  }

  return products;
}

/**
 * Given the text BEFORE a price anchor, extract the product name, brand,
 * and quantity by reading backwards through the lines.
 */
function extractProductFromContext(before: string): { name: string; brand: string | null; quantity: string | null } | null {
  // Split into lines, filter blanks, reverse to read backwards from the price
  const lines = before.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Walk backwards, collecting product-relevant lines
  const collected: string[] = [];
  let quantity: string | null = null;

  for (let i = lines.length - 1; i >= 0 && collected.length < 12; i--) {
    const line = lines[i];

    // Stop at noise lines (page headers, section names, badges)
    if (NOISE_RE.test(line)) break;
    if (NOISE_LINES.has(line.toUpperCase())) continue; // skip but don't stop
    // Never let a flyer date header become a product name/brand
    if (DATE_HEADER_RE.test(line)) continue;
    // Never let loyalty-qualifier lines become a product name/brand
    if (LOYALTY_RE.test(line)) continue;

    // Stop at previous product's price block
    if (/^\d+[.,]\d{2}\s*€/.test(line)) break;
    if (/^€\s*\d+[.,]\d{2}/.test(line)) break;
    if (/^-\d+\s*%/.test(line)) break;
    if (/^\d{1,2}\s*\n?\s*SCONTO/i.test(line)) break;
    if (/^al\s+kg\s*$/i.test(line)) break;
    if (/^€\/(kg|l)\s+\d+/i.test(line)) break;
    if (/^anziché/i.test(line)) break;
    // Stop at standalone percentage (loyalty flyer boundary)
    if (/^\d{1,2}%$/.test(line)) break;

    // Skip page numbers (but not prices like "4,59")
    if (/^\d{1,2}$/.test(line)) continue;

    // Extract quantity if we find it
    if (!quantity) {
      const mpMatch = line.match(MULTIPACK_RE);
      const qMatch = line.match(QTY_RE);
      if (mpMatch) {
        quantity = mpMatch[1].trim();
        // If the line is ONLY the quantity, don't add to name
        if (line.replace(mpMatch[0], '').trim().length < 3) continue;
      } else if (qMatch && line === qMatch[0]) {
        quantity = qMatch[1].trim();
        continue;
      } else if (qMatch) {
        // Quantity embedded in a longer line — extract it and keep the rest
        quantity = qMatch[1].trim();
      }
    }

    collected.push(line);
  }

  if (collected.length === 0) return null;

  // Reverse back to reading order
  collected.reverse();

  // First uppercase line(s) are usually the product name, last uppercase is often brand
  // Heuristic: brand is the last line that's mostly uppercase before lowercase lines begin
  let brand: string | null = null;
  const nameLines: string[] = [];

  for (const line of collected) {
    const isUpper = line === line.toUpperCase() && /[A-Z]/.test(line);
    const isLower = /^[a-z]/.test(line);
    const isVariant = line.endsWith(',') || isLower;

    if (isVariant && nameLines.length > 0) {
      // This is a variant line (e.g. "classico,", "gusti assortiti,")
      // Don't include variant details in the product name
      break;
    }

    if (isUpper) {
      nameLines.push(line);
    } else {
      // Mixed case line — might be brand continuation or stop
      break;
    }
  }

  if (nameLines.length === 0) return null;

  // Try to separate brand from name
  // Common patterns: last uppercase line is brand if it's a known brand-like word
  // or if all preceding lines form the product description
  if (nameLines.length >= 2) {
    const lastLine = nameLines[nameLines.length - 1];
    // If last line looks like a brand (single word or known brand), split it.
    // Reject anything that's really a descriptor, loyalty flag, or line-continuation fragment
    // (e.g. "ROSSI E GIALLI" describes peppers; "SOLO TITOLARI" is a card-required flag;
    //  "PATATE" following "INSALATA DI POLPO/TOTANO/" is the continued name, not a brand).
    const prevLine = nameLines[nameLines.length - 2] ?? '';
    const isContinuation = prevLine.endsWith('/') || prevLine.endsWith(',') || prevLine.endsWith('-');
    const isBrandLike = /^[A-Z][A-Z.&'\s]{1,30}$/.test(lastLine) &&
      !/(SENZA|CON|DI|DEL|DELLA|AL|ALLA|PER|DOP|IGP|DOC|BIO)\s/i.test(lastLine) &&
      !LOYALTY_RE.test(lastLine) &&
      !DESCRIPTOR_NOT_BRAND_RE.test(lastLine) &&
      !DATE_HEADER_RE.test(lastLine) &&
      !isContinuation;

    if (isBrandLike && nameLines.length >= 2) {
      brand = lastLine;
      nameLines.pop();
    }
  }

  let name = nameLines.join(' ').replace(/\s+/g, ' ').trim();
  if (!name || name.length < 3) return null;

  // Filter out non-product entries and parser noise
  if (/hotel|viaggio|vacanz|concorso|collare|lettiera/i.test(name)) return null;
  // Skip lines that are just unit labels or section noise
  if (/^(LAVAGGI|SCONTO|OFFERTA|NOVITÀ|FORMATO|RISERVATO|ACQUISTA|TI RIMBORSIAMO)$/i.test(name)) return null;
  // Skip marketing/promo text that leaked into names
  if (/RIMBORSIAMO|SODDISFATT|COLORAZIONE.*RITOCCO|ACQUISTA.*COLORAZIONE/i.test(name)) return null;

  return { name, brand, quantity };
}

/** Extract unit price from nearby text: "€/kg X,YY" or "€/l X,YY" */
function extractUnitPrice(around: string): { price: number; unit: 'kg' | 'litro' } | null {
  const m = around.match(/€\/(kg|l)\s+(\d+[.,]\d{2})/i);
  if (!m) return null;
  const price = parsePrice(m[2]);
  if (!price) return null;
  return { price, unit: m[1].toLowerCase() === 'kg' ? 'kg' : 'litro' };
}

/** Extract "anziché €/kg X,YY" original unit price */
function extractAnzichéPrice(around: string): { originalUnitPrice: number; unit: 'kg' | 'litro' } | null {
  const m = around.match(/anziché\s+€\/(kg|l)\s+(\d+[.,]\d{2})/i);
  if (!m) return null;
  const price = parsePrice(m[2]);
  if (!price) return null;
  return { originalUnitPrice: price, unit: m[1].toLowerCase() === 'kg' ? 'kg' : 'litro' };
}
