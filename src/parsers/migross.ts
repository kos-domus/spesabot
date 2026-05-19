/**
 * Migross product fetcher — extracts products directly from the SMT Digital Flyer API.
 *
 * Migross uses the same SMT platform as Eurospin (digitalflyer.smt.cloud),
 * hosted at www.migross.it/digitalflyer/. The API provides fully structured
 * product data including images, prices, brands, categories, and EAN codes.
 *
 * API flow:
 *   1. POST /digitalflyer/oauth/token (client_credentials, public SPA credentials)
 *   2. GET  /digitalflyer/api/migross/migross/stores/nazionale/promotions
 *   3. GET  /digitalflyer/api/migross/migross/promotions/{alias}/stores/nazionale/products?page=N&size=100
 *
 * No PDF parsing or Playwright needed — pure HTTP.
 */

const API_BASE = 'https://www.migross.it/digitalflyer';
// The migross.it Nuxt.js SPA sends an `Authorization: Basic ...` header on
// every XHR to the digital-flyer API. Extract it yourself (devtools →
// Network → any flyer XHR) and pass via MIGROSS_API_AUTH.
const CLIENT_AUTH = process.env.MIGROSS_API_AUTH;
if (!CLIENT_AUTH) {
  throw new Error(
    'MIGROSS_API_AUTH not set. See src/parsers/migross.ts header for how to derive it from the public SPA.',
  );
}

export interface MigrossProduct {
  prodotto: string;
  brand: string | null;
  prezzo_originale: number | null;
  prezzo_offerta: number;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
  categoria: string | null;
  image_url: string | null;
  validita_inizio: string | null;
  validita_fine: string | null;
  // EAN — derived from the SMT API's item.code.value when it looks like a real
  // barcode (8–14 digits). For Migross this is typically the internal article
  // code, not always a public EAN, but when the length fits we treat it as one.
  ean: string | null;
  specifications: Record<string, unknown>;
  // Which promotion this offer came from. Used by ingest to determine which
  // Migross format (Supermarket / Market / petstore) the offer applies to,
  // so the DB can record per-store rows instead of chain-wide ones.
  promotion_description: string | null;
  promotion_alias: string | null;
}

export interface MigrossPromotionInfo {
  alias: string;
  description: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

interface ApiPromotion {
  alias: string;
  description: string;
  startDate: string; // "YYYYMMDDHHMMSS"
  endDate: string;
  hidden: boolean;
}

async function getAccessToken(): Promise<string> {
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': CLIENT_AUTH,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`Migross oauth/token failed: HTTP ${res.status}`);
  }
  const data = await res.json() as { access_token: string };
  if (!data.access_token) {
    throw new Error('Migross oauth/token response missing access_token');
  }
  return data.access_token;
}

async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Migross API ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Convert SMT "YYYYMMDDHHMMSS" timestamp to "YYYY-MM-DD". */
function normalizeDate(raw: string): string {
  if (!raw || raw.length < 8) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** Extract a property value from the API product properties array. */
function getProp<T = string>(
  properties: Array<{ code: string; values: unknown[] }>,
  code: string,
): T | null {
  const prop = properties.find(p => p.code === code);
  const val = prop?.values?.[0];
  return val !== undefined && val !== null ? val as T : null;
}

/**
 * Discover current Migross promotions.
 */
export async function discoverMigrossPromotions(): Promise<MigrossPromotionInfo[]> {
  const token = await getAccessToken();
  const promotions = await apiGet<ApiPromotion[]>(
    '/api/migross/migross/stores/nazionale/promotions',
    token,
  );

  return promotions
    .filter(p => !p.hidden)
    .map(p => ({
      alias: p.alias,
      description: p.description,
      startDate: normalizeDate(p.startDate),
      endDate: normalizeDate(p.endDate),
    }));
}

/** Parse a single API product item into a MigrossProduct. */
function parseApiProduct(
  item: { description: string; code: { value: string }; properties: Array<{ code: string; unit?: string; values: unknown[] }> },
  validFrom: string | null,
  validTo: string | null,
  promotionAlias: string | null,
  promotionDescription: string | null,
): MigrossProduct | null {
  const props = item.properties;

  if (getProp<boolean>(props, 'HIDDEN') === true) return null;

  const endPrice = getProp<number>(props, 'END-PRICE');
  if (endPrice === null || endPrice <= 0) return null;

  const initialPrice = getProp<number>(props, 'INITIAL-PRICE');
  const endKgPrice = getProp<number>(props, 'END-KG-LT-PRICE');
  const initKgPrice = getProp<number>(props, 'INITIAL-KG-LT-PRICE');
  const discountRate = getProp<number>(props, 'DISCOUNT-RATE');
  const measureUnit = getProp<string>(props, 'MEASURE-UNIT');
  const brand = getProp<string>(props, 'MARK') ?? getProp<string>(props, 'BRAND');
  const category = getProp<string>(props, 'FILTER_CATEGORY') ?? getProp<string>(props, 'CATEGORY');
  const dimension = getProp<string>(props, 'DIMENSION') ?? getProp<string>(props, 'DESCRIPTION');

  // Extract image URL
  let imageUrl: string | null = null;
  const imgProp = props.find(p => p.code === 'IMAGES');
  const imgFile = imgProp?.values?.[0];
  if (imgFile && typeof imgFile === 'object' && 'uniqueId' in imgFile) {
    const f = imgFile as { uniqueId: string; name: string };
    if (f.uniqueId && f.name) {
      imageUrl = `${API_BASE}/files/${f.uniqueId}/${f.name}`;
    }
  }

  // Parse name from description (strip embedded newlines/quantity)
  const rawDesc = item.description.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract quantity from description or DIMENSION field
  let quantity: string | null = null;
  const qtyMatch = rawDesc.match(/\b(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:g|kg|ml|cl|dl|l|pz))\b/i);
  if (qtyMatch) {
    quantity = qtyMatch[1];
  } else if (dimension) {
    const dimQty = dimension.replace(/\n/g, ' ').match(/\b(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:g|kg|ml|cl|dl|l|pz))\b/i);
    if (dimQty) quantity = dimQty[1];
  }

  // Clean product name: remove trailing quantity
  let name = rawDesc;
  if (quantity) {
    name = name.replace(new RegExp(`\\s*${quantity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
  }
  name = name.replace(/\s+al\s+(kg|litro|l)\s*$/i, '').trim();

  let discount = discountRate ?? null;
  if (discount === null && initialPrice && initialPrice > endPrice) {
    discount = Math.round((1 - endPrice / initialPrice) * 100);
  }

  let unitLabel: 'kg' | 'litro' | 'pezzo' | null = null;
  if (measureUnit) {
    const mu = measureUnit.toUpperCase();
    if (mu === 'KG') unitLabel = 'kg';
    else if (mu === 'LT' || mu === 'L') unitLabel = 'litro';
    else if (mu === 'PZ') unitLabel = 'pezzo';
  }

  // EAN candidate from item.code.value — keep only if it's 8–14 digits. Short
  // or alpha-prefixed codes (internal article numbers) are filtered out so we
  // don't pollute the ean column with chain-specific SKU IDs.
  const codeDigits = String(item.code?.value ?? '').replace(/\D/g, '');
  const ean = codeDigits.length >= 8 && codeDigits.length <= 14 ? codeDigits : null;

  // Specifications — gather the SMT API fields that aren't already captured as
  // top-level columns. Category + dimension + measure are useful hints for
  // future enrichment (e.g. "ml 750" dimension, "EL" unit = electrical).
  const specifications: Record<string, unknown> = {};
  if (dimension) specifications.dimension = dimension;
  if (measureUnit) specifications.measure_unit = measureUnit;
  if (category) specifications.category = category;
  if (initKgPrice) specifications.initial_unit_price = initKgPrice;

  return {
    prodotto: name,
    brand: brand ?? null,
    prezzo_originale: initialPrice && initialPrice > endPrice ? initialPrice : null,
    prezzo_offerta: endPrice,
    prezzo_al_kg: endKgPrice ?? initKgPrice ?? null,
    unita_prezzo: unitLabel,
    quantita_peso: quantity,
    sconto_percentuale: discount,
    categoria: category ?? null,
    image_url: imageUrl,
    validita_inizio: validFrom,
    validita_fine: validTo,
    ean,
    specifications,
    promotion_alias: promotionAlias,
    promotion_description: promotionDescription,
  };
}

/**
 * Map a Migross promotion description to the store formats it applies to.
 *
 * The SMT API doesn't expose per-store offer visibility, but the promotion
 * description does ("Superstore" vs "Market&Supermercati" vs "Pet Store Buddy"
 * vs generic). The store name prefix in our DB matches these formats:
 *   - "Migross Supermarket *" → Superstore-class
 *   - "Migross Market *"      → Market-class
 *   - "Migross Cash&Carry"    → CASHCARRY only
 *
 * Returns the set of format tags that apply. Used at ingest time to resolve
 * which stores each offer should be attached to.
 */
export function migrossFormatsForPromotion(description: string | null | undefined): Set<'supermarket' | 'market' | 'cashcarry' | 'all'> {
  const formats = new Set<'supermarket' | 'market' | 'cashcarry' | 'all'>();
  if (!description) { formats.add('all'); return formats; }
  const d = description.toLowerCase();
  const hasSuperstore = /superstore|super/.test(d);
  const hasMarket = /market|supermercat/.test(d);
  // "Pet Store Buddy" is a separate Migross-owned pet brand, not on our grocery
  // catalogue — skip so we don't pollute. The ingest filter will drop these.
  if (/pet\s*store|buddy/.test(d)) { /* no formats */ return formats; }
  if (hasSuperstore) formats.add('supermarket');
  if (hasMarket) formats.add('market');
  if (/cash\s*carry|cash&carry/.test(d)) formats.add('cashcarry');
  // Everything else (Grandi Marche, Catalogo Vini, Beautypharma, generic
  // "volantino") applies to every format.
  if (formats.size === 0) formats.add('all');
  return formats;
}

/** Fetch all paginated products for a single promotion alias. */
async function fetchPromoProducts(
  token: string,
  alias: string,
  description: string,
  validFrom: string | null,
  validTo: string | null,
): Promise<{ products: MigrossProduct[]; total: number }> {
  const products: MigrossProduct[] = [];
  let page = 0;
  const pageSize = 100;

  while (true) {
    const data = await apiGet<{
      totalPages: number;
      totalElements: number;
      elements: Array<{
        description: string;
        code: { value: string };
        properties: Array<{ code: string; unit?: string; values: unknown[] }>;
      }>;
    }>(
      `/api/migross/migross/promotions/${alias}/stores/nazionale/products?page=${page}&size=${pageSize}`,
      token,
    );

    for (const item of data.elements) {
      const product = parseApiProduct(item, validFrom, validTo, alias, description);
      if (product) products.push(product);
    }

    page++;
    if (page >= data.totalPages) break;
  }

  return { products, total: products.length };
}

/**
 * Fetch all products across ALL active Migross promotions.
 *
 * Iterates every non-hidden promotion, fetches products, and deduplicates
 * by product code so the same item appearing in multiple promos (e.g.
 * Superstore + Market) is only included once. The first occurrence wins,
 * and promotions are processed largest-first so the richest data is kept.
 *
 * Returns a merged campaign spanning the widest date range across all promos.
 */
export async function fetchMigrossProducts(promotionAlias?: string): Promise<{
  products: MigrossProduct[];
  promotion: MigrossPromotionInfo;
}> {
  const token = await getAccessToken();

  const allPromos = await apiGet<ApiPromotion[]>(
    '/api/migross/migross/stores/nazionale/promotions',
    token,
  );
  const visible = allPromos.filter(p => !p.hidden);
  if (visible.length === 0) throw new Error('No active Migross promotions found');

  // Single-promotion mode (for testing or targeted fetch)
  if (promotionAlias) {
    const info = visible.find(p => p.alias === promotionAlias) ?? visible[0];
    const validFrom = normalizeDate(info.startDate);
    const validTo = normalizeDate(info.endDate);
    const { products } = await fetchPromoProducts(token, promotionAlias, info.description, validFrom, validTo);
    return {
      products,
      promotion: { alias: promotionAlias, description: info.description, startDate: validFrom, endDate: validTo },
    };
  }

  // All-promotions mode: fetch every promo, deduplicate by product code+price.
  // Map tracks the index in `merged` so a second occurrence can merge its
  // promotion description into the first (see dedup loop below).
  const seen = new Map<string, number>();
  const merged: MigrossProduct[] = [];
  let earliestStart = '9999-12-31';
  let latestEnd = '0000-01-01';

  // Sort promos largest-first so the biggest flyer's data wins on dedup
  const promosBySize: Array<{ promo: ApiPromotion; count: number }> = [];
  for (const promo of visible) {
    // Quick count check (page=0, size=1 → just read totalElements)
    try {
      const peek = await apiGet<{ totalElements: number }>(
        `/api/migross/migross/promotions/${promo.alias}/stores/nazionale/products?page=0&size=1`,
        token,
      );
      promosBySize.push({ promo, count: peek.totalElements });
    } catch {
      promosBySize.push({ promo, count: 0 });
    }
  }
  promosBySize.sort((a, b) => b.count - a.count);

  for (const { promo, count } of promosBySize) {
    if (count === 0) continue;

    const validFrom = normalizeDate(promo.startDate);
    const validTo = normalizeDate(promo.endDate);
    if (validFrom && validFrom < earliestStart) earliestStart = validFrom;
    if (validTo && validTo > latestEnd) latestEnd = validTo;

    const { products } = await fetchPromoProducts(token, promo.alias, promo.description, validFrom, validTo);

    let newCount = 0;
    for (const p of products) {
      // Dedup key: normalized name + price. Same product at the same price
      // across multiple promotions (e.g. Superstore + Market) is one offer
      // in practice — but we MERGE the promotion descriptions so ingest can
      // union the applicable store formats instead of dropping one.
      // Same product at DIFFERENT prices stays as distinct offers.
      const key = `${p.prodotto.toUpperCase()}|${p.prezzo_offerta}`;
      const existingIdx = seen.get(key);
      if (existingIdx !== undefined) {
        const existing = merged[existingIdx];
        if (existing.promotion_description && p.promotion_description
            && !existing.promotion_description.includes(p.promotion_description)) {
          existing.promotion_description = `${existing.promotion_description} + ${p.promotion_description}`;
        }
        continue;
      }
      seen.set(key, merged.length);
      merged.push(p);
      newCount++;
    }
    console.log(`  [migross] ${promo.description} (${promo.alias}): ${products.length} products, ${newCount} new`);
  }

  return {
    products: merged,
    promotion: {
      alias: 'all',
      description: promosBySize.map(p => p.promo.description).join(' + '),
      startDate: earliestStart !== '9999-12-31' ? earliestStart : '',
      endDate: latestEnd !== '0000-01-01' ? latestEnd : '',
    },
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const promos = await discoverMigrossPromotions();
    console.log(`Migross promotions (${promos.length}):`);
    for (const p of promos) {
      console.log(`  ${p.alias} — ${p.description} (${p.startDate} → ${p.endDate})`);
    }

    // Pass a specific alias, or omit to fetch ALL promos merged
    const alias = process.argv[2] || undefined;
    const { products, promotion } = await fetchMigrossProducts(alias);
    console.log(`\nCampaign: ${promotion.description}`);
    console.log(`Valid: ${promotion.startDate} → ${promotion.endDate}`);
    console.log(`Total unique products: ${products.length}`);

    const withImages = products.filter(p => p.image_url);
    const withBrand = products.filter(p => p.brand);
    console.log(`With images: ${withImages.length} | With brand: ${withBrand.length}`);

    console.log(`\nSample products:`);
    for (const p of products.slice(0, 5)) {
      console.log(`  ${p.brand ?? '?'} | ${p.prodotto} | €${p.prezzo_offerta} (was €${p.prezzo_originale ?? '-'}) | ${p.quantita_peso ?? '-'} | img: ${p.image_url ? 'yes' : 'no'}`);
    }
  })().catch(err => {
    console.error('Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
