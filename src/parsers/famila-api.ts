/**
 * Famila product fetcher — direct Maxidi Digital Flyer API client.
 *
 * Replaces the previous Playwright-based scraper. Famila uses the same
 * Maxidi/SMT digital flyer platform as Migross/Eurospin, exposing fully
 * structured product data via REST. Going API-direct removes Playwright
 * RAM pressure (Famila was the chain that triggered the Apr 21 OOM kill),
 * eliminates the click-pagination fragility that returned 0 products on
 * Apr 24, and runs in seconds rather than ~75s per store.
 *
 * API flow:
 *   1. POST /digitalflyer/oauth/token (Basic client credentials, embedded
 *      in the public SPA bundle)
 *   2. GET  /digitalflyer/api/maxidi/famila/stores/{storeSlug}/promotions
 *   3. For each non-skip promotion:
 *      - GET /digitalflyer/api/maxidi/famila/promotions/{alias}/groups
 *        (skip if empty — same /groups filter as the discovery)
 *      - GET /digitalflyer/api/maxidi/famila/promotions/{alias}/stores/{storeSlug}/products?page=N&size=100
 */

const API_BASE = 'https://famila.maxidi.it/digitalflyer';
const API_PATH = '/api/maxidi/famila';

// The Famila digital-flyer SPA at promo.famila.it sends an
// `Authorization: Basic ...` header on every XHR to the maxidi.it API.
// Those credentials are embedded in the SPA's public JS bundle — extract
// them yourself (devtools → Network → any flyer XHR) and pass via
// FAMILA_API_AUTH. This parser will not run without it.
const CLIENT_AUTH = process.env.FAMILA_API_AUTH;
if (!CLIENT_AUTH) {
  throw new Error(
    'FAMILA_API_AUTH not set. See src/parsers/famila-api.ts header for how to derive it from the public SPA.',
  );
}

export interface FamilaApiProduct {
  prodotto: string;
  brand: string | null;
  prezzo_originale: number | null;
  prezzo_offerta: number;
  prezzo_al_kg: number | null;
  unita_prezzo: 'kg' | 'litro' | 'pezzo' | 'etto' | null;
  quantita_peso: string | null;
  sconto_percentuale: number | null;
  categoria: string | null;
  image_url: string | null;
  validita_inizio: string | null;
  validita_fine: string | null;
  ean: string | null;
  product_code: string | null;
  specifications: Record<string, unknown>;
  promotion_alias: string | null;
  promotion_description: string | null;
}

export interface FamilaApiPromotion {
  alias: string;
  description: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

interface ApiPromotion {
  alias: string;
  description: string;
  startDate: string;  // "YYYYMMDDHHMMSS"
  endDate: string;
  hidden: boolean;
}

interface ApiPropertyValue {
  uniqueId?: string;
  name?: string;
  [k: string]: unknown;
}

interface ApiProperty {
  type: string;
  code: string;
  unit?: string | null;
  values: unknown[];
}

interface ApiProductItem {
  uniqueId: string;
  alias: string;
  description: string;
  code: { type: string; value: string };
  properties: ApiProperty[];
}

interface SpringPage<T> {
  totalPages: number;
  totalElements: number;
  number: number;
  size: number;
  numberOfElements: number;
  first: boolean;
  last: boolean;
  elements: T[];
}

async function getAccessToken(): Promise<string> {
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('scope', 'read write');
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: CLIENT_AUTH,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`Famila oauth/token failed: HTTP ${res.status}`);
  }
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Famila oauth/token: response missing access_token');
  }
  return data.access_token;
}

async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${API_PATH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Famila API ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Convert SMT "YYYYMMDDHHMMSS" timestamp to "YYYY-MM-DD". */
function normalizeDate(raw: string | null | undefined): string {
  if (!raw || raw.length < 8) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function getProp<T = string>(properties: ApiProperty[], code: string): T | null {
  const prop = properties.find(p => p.code === code);
  const val = prop?.values?.[0];
  return val !== undefined && val !== null ? val as T : null;
}

/**
 * Aliases we never want to scrape: brand-sponsored boxes, news, recipes.
 * Mirrors the same allowlist as famila-promo-discovery.
 */
function isSkippablePromo(alias: string): boolean {
  return /sponsor|^news|ricet/i.test(alias);
}

/**
 * List active product-bearing promotions for a store. Filters out sponsor /
 * news / recipe aliases, then verifies each remaining promo has groups —
 * the Selex backend frequently keeps stale promo aliases active without
 * any product groups attached, which silently produced empty flyers in
 * the Playwright pipeline.
 */
export async function discoverFamilaActivePromotions(
  storeSlug: string,
  token?: string,
): Promise<FamilaApiPromotion[]> {
  const t = token ?? await getAccessToken();
  const promos = await apiGet<ApiPromotion[]>(
    `/stores/${storeSlug}/promotions`,
    t,
  );

  const candidates = promos.filter(p => {
    if (p.hidden) return false;
    const alias = (p.alias || '').toLowerCase();
    return !!alias && !isSkippablePromo(alias);
  });

  // Verify each promo actually has groups for this store. /groups returns
  // non-empty only for promos that have product assignments active right now.
  const checked = await Promise.all(candidates.map(async (p) => {
    try {
      const groups = await apiGet<unknown[]>(`/promotions/${p.alias}/groups`, t);
      if (!Array.isArray(groups) || groups.length === 0) return null;
      return {
        alias: p.alias,
        description: p.description,
        startDate: normalizeDate(p.startDate),
        endDate: normalizeDate(p.endDate),
      };
    } catch {
      return null;
    }
  }));

  return checked.filter((x): x is FamilaApiPromotion => x !== null);
}

/** Parse a single API product item into a FamilaApiProduct. */
function parseApiProduct(
  item: ApiProductItem,
  validFrom: string | null,
  validTo: string | null,
  promotionAlias: string,
  promotionDescription: string,
): FamilaApiProduct | null {
  const props = item.properties;

  if (getProp<boolean>(props, 'HIDDEN') === true) return null;

  const endPrice = getProp<number>(props, 'END-PRICE');
  if (endPrice === null || endPrice <= 0) return null;

  const initialPrice = getProp<number>(props, 'INITIAL-PRICE');
  const endKgPrice = getProp<number>(props, 'END-KG-LT-PRICE');
  const initKgPrice = getProp<number>(props, 'INITIAL-KG-LT-PRICE');
  const discountRate = getProp<number>(props, 'DISCOUNT-RATE');
  const measureUnit = getProp<string>(props, 'MEASURE-UNIT');
  const brand = getProp<string>(props, 'MARK');
  const title = getProp<string>(props, 'TITLE');
  const dimension = getProp<string>(props, 'DIMENSION');
  const pieces = getProp<string>(props, 'PIECES');
  const department = getProp<string>(props, 'DEPARTMENT');
  // Validity at item level — overrides promo-level dates if present
  const itemStart = getProp<string>(props, 'START-DATE-VALIDITY');
  const itemEnd = getProp<string>(props, 'END-DATE-VALIDITY');

  // Image URL — IMAGES property holds a file descriptor with uniqueId+name
  let imageUrl: string | null = null;
  const imgProp = props.find(p => p.code === 'IMAGES');
  const imgFile = imgProp?.values?.[0] as ApiPropertyValue | undefined;
  if (imgFile && imgFile.uniqueId && imgFile.name) {
    imageUrl = `${API_BASE}/files/${imgFile.uniqueId}/${imgFile.name}`;
  }

  // Product display name — TITLE if present, else cleaned description
  const cleanedDesc = (item.description ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const displayName = (title && title.trim()) ? title.trim() : cleanedDesc;

  // Quantity — extract from item.description (typically contains the full
  // "8 x 125 g" string) or from DIMENSION when it already includes a unit.
  // Do NOT compose DIMENSION + MEASURE-UNIT: MEASURE-UNIT is the price-per
  // unit (€/kg, €/lt) which is independent from product weight unit. E.g.
  // a tuna can with DIMENSION="60" + MEASURE-UNIT="KG" is 60 g, not 60 kg.
  const qtyRe = /\b(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|hg|ml|cl|dl|l|pz))\b/i;
  let quantity: string | null = null;
  const descQty = cleanedDesc.match(qtyRe);
  if (descQty) quantity = descQty[1];
  if (!quantity && dimension) {
    const dimQty = String(dimension).replace(/\n/g, ' ').match(qtyRe);
    if (dimQty) quantity = dimQty[1];
  }

  let discount = discountRate ?? null;
  if (discount === null && initialPrice && initialPrice > endPrice) {
    discount = Math.round((1 - endPrice / initialPrice) * 100);
  }

  let unitLabel: 'kg' | 'litro' | 'pezzo' | 'etto' | null = null;
  if (measureUnit) {
    const mu = measureUnit.toUpperCase();
    if (mu === 'KG') unitLabel = 'kg';
    else if (mu === 'LT' || mu === 'L') unitLabel = 'litro';
    else if (mu === 'PZ') unitLabel = 'pezzo';
    else if (mu === 'HG' || mu === 'ETTO') unitLabel = 'etto';
  }

  // EAN candidate — properties.EAN takes precedence; fall back to item.code
  // when it looks barcode-shaped (8–14 digits).
  let ean: string | null = null;
  const eanProp = getProp<string>(props, 'EAN');
  if (eanProp) {
    const digits = String(eanProp).replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) ean = digits;
  }
  if (!ean) {
    const codeDigits = String(item.code?.value ?? '').replace(/\D/g, '');
    if (codeDigits.length >= 8 && codeDigits.length <= 14) ean = codeDigits;
  }

  // Specifications — extras worth keeping for downstream enrichment
  const specifications: Record<string, unknown> = {};
  if (dimension) specifications.dimension = dimension;
  if (pieces) specifications.pieces = pieces;
  if (measureUnit) specifications.measure_unit = measureUnit;
  if (department) specifications.department = department;
  if (initKgPrice) specifications.initial_unit_price = initKgPrice;
  if (itemStart) specifications.item_start_date = normalizeDate(itemStart);
  if (itemEnd) specifications.item_end_date = normalizeDate(itemEnd);

  // Famila uses MARK="-" as a placeholder for unbranded fresh produce
  const cleanBrand = brand && brand !== '-' ? brand : null;

  return {
    prodotto: displayName,
    brand: cleanBrand,
    prezzo_originale: initialPrice && initialPrice > endPrice ? initialPrice : null,
    prezzo_offerta: endPrice,
    prezzo_al_kg: endKgPrice ?? initKgPrice ?? null,
    unita_prezzo: unitLabel,
    quantita_peso: quantity,
    sconto_percentuale: discount,
    categoria: department ?? null,
    image_url: imageUrl,
    validita_inizio: itemStart ? normalizeDate(itemStart) : (validFrom ?? null),
    validita_fine: itemEnd ? normalizeDate(itemEnd) : (validTo ?? null),
    ean,
    product_code: item.code?.value ?? null,
    specifications,
    promotion_alias: promotionAlias,
    promotion_description: promotionDescription,
  };
}

/** Fetch all paginated products for one (promotion, store) pair. */
async function fetchPromoStoreProducts(
  promo: FamilaApiPromotion,
  storeSlug: string,
  token: string,
): Promise<FamilaApiProduct[]> {
  const products: FamilaApiProduct[] = [];
  const pageSize = 100;
  let page = 0;

  while (true) {
    const data = await apiGet<SpringPage<ApiProductItem>>(
      `/promotions/${promo.alias}/stores/${storeSlug}/products?page=${page}&size=${pageSize}`,
      token,
    );

    for (const item of data.elements) {
      const p = parseApiProduct(item, promo.startDate || null, promo.endDate || null, promo.alias, promo.description);
      if (p) products.push(p);
    }

    page++;
    if (page >= data.totalPages) break;
  }

  return products;
}

export interface FamilaStoreFetchResult {
  storeSlug: string;
  products: FamilaApiProduct[];
  promotions: FamilaApiPromotion[];
  /** Total products fetched across all promos before dedup. */
  rawProductCount: number;
}

/**
 * Fetch all current offers for a Famila store via API. Iterates active
 * promotions, fetches products per (promo, store), dedups across promos by
 * `(promotion_alias, product_code)`.
 */
export async function fetchFamilaProductsForStore(
  storeSlug: string,
): Promise<FamilaStoreFetchResult> {
  const token = await getAccessToken();
  const promotions = await discoverFamilaActivePromotions(storeSlug, token);

  const all: FamilaApiProduct[] = [];
  for (const promo of promotions) {
    const items = await fetchPromoStoreProducts(promo, storeSlug, token);
    all.push(...items);
  }

  // Dedup by (promo_alias, product_code) — same code can appear in two promos
  // (e.g. sottocosto + grandi-marche overlap). Keep the first occurrence.
  const seen = new Set<string>();
  const deduped: FamilaApiProduct[] = [];
  for (const p of all) {
    const key = `${p.promotion_alias}|${p.product_code ?? p.prodotto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  return {
    storeSlug,
    products: deduped,
    promotions,
    rawProductCount: all.length,
  };
}

// CLI entry point for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2] ?? 'famila-market-legnago';
  console.log(`Fetching: ${slug}`);
  const t0 = Date.now();
  fetchFamilaProductsForStore(slug)
    .then(r => {
      console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`  Promotions used: ${r.promotions.map(p => p.alias).join(', ')}`);
      console.log(`  Products: ${r.products.length} (raw ${r.rawProductCount})`);
      for (const p of r.products.slice(0, 5)) {
        console.log(`    - ${p.brand ?? '?'} | ${p.prodotto} | ${p.quantita_peso ?? '?'} | €${p.prezzo_offerta} | ean=${p.ean ?? '?'}`);
      }
    })
    .catch(err => { console.error('Failed:', err.message); process.exit(1); });
}
