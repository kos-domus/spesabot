/**
 * Eurospin PDF auto-discovery.
 *
 * Eurospin publishes a monthly national flyer ("RIBASSATI {MONTH}") as a PDF
 * served from digitalflyer.eurospin.it. The UUID in the PDF URL changes each
 * month. This module uses the public SMT-DigitalFlyer API to resolve the
 * current month's PDF URL without any manual intervention.
 *
 * API flow (reverse-engineered from the SPA at eurospin.it/volantino-store-eurospin/):
 *
 *   1. POST /oauth/token
 *      Authorization: Basic <hardcoded SPA client credentials>
 *      Form: grant_type=client_credentials
 *      → { access_token, expires_in }
 *
 *   2. GET /api/eurospin/eurospin-italia/stores/{storeAlias}/promotions
 *      Authorization: Bearer {token}
 *      → [{ alias, description, startDate, endDate, ... }]
 *      (pick the current/active promotion — typically "ribassati-{MM}-{YYYY}-italia")
 *
 *   3. GET /api/eurospin/eurospin-italia/stores/{storeAlias}/promotions/{alias}/contents-light?typeCode=FLY
 *      Authorization: Bearer {token}
 *      → [{ name: "pdf-volantino-...", properties: [{ code: "PDF", values: [{ uniqueId, name }] }] }]
 *      (extract the PDF's uniqueId — that becomes the UUID in the final URL)
 *
 *   4. Construct: https://digitalflyer.eurospin.it/files/{uniqueId}/{name}
 *
 * Store alias "elmas" is used as a permanent query anchor because Eurospin offers
 * are national (same flyer across all 1250+ stores). Any real store alias works.
 *
 * The SPA client credentials are public (embedded in the JavaScript bundle). They're
 * safe to hardcode here — they're not a secret, they just gate anonymous API access.
 */

const API_BASE = 'https://digitalflyer.eurospin.it';
// The Eurospin digital-flyer SPA sends an `Authorization: Basic ...` header
// on every XHR. Extract it yourself (devtools → Network) and pass via
// EUROSPIN_API_AUTH.
const CLIENT_AUTH = process.env.EUROSPIN_API_AUTH;
if (!CLIENT_AUTH) {
  throw new Error(
    'EUROSPIN_API_AUTH not set. See src/parsers/eurospin-url-discovery.ts header for how to derive it from the public SPA.',
  );
}
const STORE_ALIAS = 'elmas';

export interface EurospinFlyerInfo {
  pdfUrl: string;
  promotionAlias: string;     // e.g. "ribassati-04-2026-italia"
  promotionName: string;      // e.g. "RIBASSATI APRILE"
  startDate: string;          // ISO date (YYYY-MM-DD)
  endDate: string;            // ISO date (YYYY-MM-DD)
  pdfSizeBytes: number | null;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface ApiPromotion {
  identifier: string;
  code: string;
  alias: string;
  description: string;
  startDate: string; // "YYYYMMDDHHMMSS" format from API
  endDate: string;
  hidden: boolean;
}

interface ApiFileValue {
  uniqueId: string;
  name: string;
  extension: string;
  size: number | null;
  mimeType: string | null;
}

interface ApiProperty {
  type: string;
  code: string;
  values: ApiFileValue[];
}

interface ApiContent {
  uniqueId: string;
  name: string;
  type: { code: string }; // "FLY" = flyer, "FLT" = filter
  properties: ApiProperty[];
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
    throw new Error(`oauth/token failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error('oauth/token response missing access_token');
  }
  return data.access_token;
}

async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Convert Eurospin's "YYYYMMDDHHMMSS" timestamp to "YYYY-MM-DD". */
function normalizeDate(raw: string): string {
  if (!raw || raw.length < 8) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Resolve the current month's Eurospin national flyer PDF URL.
 *
 * Picks the first visible non-hidden promotion whose validity window covers today.
 * Falls back to the first visible promotion if no overlap is found.
 */
export async function discoverEurospinFlyerPdf(): Promise<EurospinFlyerInfo> {
  const token = await getAccessToken();

  const promotions = await apiGet<ApiPromotion[]>(
    `/api/eurospin/eurospin-italia/stores/${STORE_ALIAS}/promotions`,
    token,
  );
  const visible = promotions.filter(p => !p.hidden);
  if (visible.length === 0) {
    throw new Error('No visible promotions in Eurospin API response');
  }

  const today = new Date().toISOString().slice(0, 10);
  const current =
    visible.find(p => {
      const s = normalizeDate(p.startDate);
      const e = normalizeDate(p.endDate);
      return s && e && s <= today && today <= e;
    }) ?? visible[0];

  const contents = await apiGet<ApiContent[]>(
    `/api/eurospin/eurospin-italia/stores/${STORE_ALIAS}/promotions/${current.alias}/contents-light?typeCode=FLY&typeCode=FLT`,
    token,
  );
  const flyers = contents.filter(c => c.type?.code === 'FLY');
  for (const flyer of flyers) {
    const pdfProp = flyer.properties?.find(p => p.code === 'PDF');
    const pdfFile = pdfProp?.values?.[0];
    if (pdfFile?.uniqueId && pdfFile.name) {
      return {
        pdfUrl: `${API_BASE}/files/${pdfFile.uniqueId}/${pdfFile.name}`,
        promotionAlias: current.alias,
        promotionName: current.description,
        startDate: normalizeDate(current.startDate),
        endDate: normalizeDate(current.endDate),
        pdfSizeBytes: pdfFile.size,
      };
    }
  }
  throw new Error(`No PDF file found in flyer contents for promotion ${current.alias}`);
}

/**
 * Fetch product image URLs from the Eurospin API for the current promotion.
 *
 * Returns a Map of normalized product name → image URL. The API provides
 * structured product data including high-res images for every product in the
 * flyer, which the PDF text extraction can't capture.
 *
 * Usage: call this after PDF parsing, then match products by name to attach
 * image URLs.
 */
export async function fetchEurospinProductImages(): Promise<Map<string, string>> {
  const token = await getAccessToken();

  // Get current promotion
  const promotions = await apiGet<ApiPromotion[]>(
    `/api/eurospin/eurospin-italia/stores/${STORE_ALIAS}/promotions`,
    token,
  );
  const visible = promotions.filter(p => !p.hidden);
  if (visible.length === 0) return new Map();

  const today = new Date().toISOString().slice(0, 10);
  const current =
    visible.find(p => {
      const s = normalizeDate(p.startDate);
      const e = normalizeDate(p.endDate);
      return s && e && s <= today && today <= e;
    }) ?? visible[0];

  // Fetch all products (paginated, max 200 per page)
  const imageMap = new Map<string, string>();
  let page = 0;
  const pageSize = 50;

  while (true) {
    const data = await apiGet<{
      totalPages: number;
      elements: Array<{
        description: string;
        properties: Array<{
          code: string;
          values: Array<{ uniqueId?: string; name?: string } | string | number | boolean>;
        }>;
      }>;
    }>(
      `/api/eurospin/eurospin-italia/promotions/${current.alias}/stores/${STORE_ALIAS}/products?page=${page}&size=${pageSize}`,
      token,
    );

    for (const product of data.elements) {
      const imgProp = product.properties.find(p => p.code === 'IMAGES');
      const imgFile = imgProp?.values?.[0];
      if (imgFile && typeof imgFile === 'object' && 'uniqueId' in imgFile && imgFile.uniqueId && imgFile.name) {
        const imageUrl = `${API_BASE}/files/${imgFile.uniqueId}/${imgFile.name}`;
        // Normalize: uppercase, collapse whitespace/newlines, strip trailing quantity
        // API names often include "\n3 PZ" or ", \n8 PZ" suffixes
        const raw = product.description.toUpperCase().replace(/\s+/g, ' ').trim();
        const key = raw.replace(/,?\s*\d+\s*PZ\s*$/, '').trim();
        imageMap.set(key, imageUrl);
        // Also store the raw version for exact matches
        if (key !== raw) imageMap.set(raw, imageUrl);
      }
    }

    page++;
    if (page >= data.totalPages) break;
  }

  return imageMap;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  discoverEurospinFlyerPdf()
    .then(info => {
      console.log(`Promotion: ${info.promotionName} (${info.promotionAlias})`);
      console.log(`Valid:     ${info.startDate} → ${info.endDate}`);
      console.log(`PDF size:  ${info.pdfSizeBytes ? (info.pdfSizeBytes / 1024 / 1024).toFixed(2) + ' MB' : 'unknown'}`);
      console.log(`PDF URL:   ${info.pdfUrl}`);
    })
    .catch(err => {
      console.error('Discovery failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
