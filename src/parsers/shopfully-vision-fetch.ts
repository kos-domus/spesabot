/**
 * Generic Shopfully flyer fetcher + Gemini vision OCR pipeline.
 *
 * Works for any Italian retail chain whose flyer is published on Shopfully's
 * infrastructure (doveconviene.it, volantinofacile, promoqui, etc.). Given a
 * Shopfully publication ID, this:
 *
 *   1. Fetches page descriptors + per-page enrichments (hotspot bounding boxes)
 *   2. Downloads each page's high-res webp image
 *   3. Crops each hotspot into a JPEG — one crop = one product
 *   4. Sends each crop to Gemini 2.5 Flash with a structured extraction prompt
 *   5. Parses JSON responses into a ConadFlyerProduct-compatible shape
 *   6. Saves crops under data/product-images/{chain}/{pubId}/{hotspotId}.jpg
 *      so the API can serve them at /product-images/{chain}/{pubId}/{hotspotId}.jpg
 *
 * The DOM-free structural approach means image↔product alignment is guaranteed
 * by the hotspot bounding box — each vision call sees exactly one product's
 * visual region.
 *
 * See session 2026-04-20 for the discovery path (PAM/MD bespoke APIs dead-ended,
 * Shopfully + vision emerged as the generic solve).
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ConadFlyerProduct } from './conad-flyer.js';

const SHOPFULLY_API = 'https://shopfully-publication-api.global.ssl.fastly.net';
const GEMINI_MODEL = 'gemini-2.5-flash';

// How many vision calls to run in parallel. Gemini tolerates modest concurrency.
const VISION_CONCURRENCY = 4;
// Per-call timeout (vision can be slow on crowded endpoints).
const VISION_TIMEOUT_MS = 45_000;

// Root for locally-stored crop images. API mounts /product-images/ here.
const CROPS_ROOT = process.env.SPESABOT_PRODUCT_IMAGES_DIR
  ?? join(process.env.HOME!, 'job-desk/spesabot/data/product-images');

// Where the API exposes the crops publicly. Stored in the DB as image_url.
// Must be an absolute URL because ingest.ts validates image_url via `new URL(...).hostname`
// against an allowlist — relative paths throw there and get dropped.
// Derive from SPESABOT_WEBAPP_URL (e.g. https://app.spesify.xyz/webapp/index.html → https://app.spesify.xyz).
function deriveCropsUrlPrefix(): string {
  if (process.env.SPESABOT_PRODUCT_IMAGES_URL) return process.env.SPESABOT_PRODUCT_IMAGES_URL;
  const webapp = process.env.SPESABOT_WEBAPP_URL;
  if (webapp) {
    try {
      const u = new URL(webapp);
      return `${u.protocol}//${u.host}/product-images`;
    } catch { /* fall through */ }
  }
  return 'https://app.spesify.xyz/product-images';
}
const CROPS_URL_PREFIX = deriveCropsUrlPrefix();

// ── Shopfully API response shapes ──────────────────────────────────────────

interface PageRepresentation {
  resourcePath: string;
  height?: number;
  width?: number;
}
interface PageDescriptor {
  pageRepresentation: PageRepresentation;
  type?: string;
  height?: number;
  width?: number;
  size?: number;
}
interface PageData {
  pageNumber: number;
  pageRepresentationDescriptors: PageDescriptor[];
}
interface Shape {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  type?: string;
}
interface Hotspot {
  id: string;
  firstPageNumber: string;
  lastPageNumber: string;
  type: string;
  shape: Shape;
  crop_shape?: Shape;
  url?: string;
}

// Per-crop Gemini response
interface VisionProduct {
  prodotto?: string;
  brand?: string | null;
  quantita?: string | null;
  prezzo_offerta?: number;
  prezzo_originale?: number | null;
  sconto_percentuale?: number | null;
  note?: string | null;
  richiede_carta?: boolean | null;
  nome_carta?: string | null;
  ean?: string | null;
  specifiche?: Record<string, unknown> | null;
  error?: string;
}

// ── Pure HTTP helpers ───────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return (await res.json()) as T;
}

/**
 * Fetch one chunk of page descriptors.
 *
 * The URL parameter is NOT a page number — it's a chunk index. Each chunk
 * returns up to 10 pages in a single JSON response keyed by real page number
 * (e.g. chunk /2 returns pages 11–20). Chunk /1 also includes a
 * `publicationDescriptor` key that we filter out.
 */
async function fetchPageChunk(pubId: string, chunkIdx: number): Promise<Map<number, PageData>> {
  const url = `${SHOPFULLY_API}/publication_pages/it_it/${pubId}/${chunkIdx}?format=webp`;
  const data = await fetchJson<Record<string, PageData | unknown>>(url);
  const out = new Map<number, PageData>();
  for (const [k, v] of Object.entries(data)) {
    if (k === 'publicationDescriptor') continue;
    const pageNum = parseInt(k, 10);
    if (!Number.isFinite(pageNum)) continue;
    out.set(pageNum, v as PageData);
  }
  return out;
}

/**
 * Fetch ALL hotspot enrichments for a publication.
 *
 * Like /publication_pages/{pubId}/{chunkIdx}, the /enr/{chunkIdx} endpoint
 * is also chunked: chunk N contains hotspots for pages (N-1)*10+1 .. N*10,
 * keyed by real page number. Walk until 404 or empty.
 */
async function fetchAllEnrichments(pubId: string): Promise<Map<number, Hotspot[]>> {
  const all = new Map<number, Hotspot[]>();
  for (let chunkIdx = 1; chunkIdx <= 10; chunkIdx++) {
    const url = `${SHOPFULLY_API}/publication_pages/it_it/${pubId}/enr/${chunkIdx}`;
    let data: Record<string, Hotspot[]>;
    try {
      data = await fetchJson<Record<string, Hotspot[]>>(url);
    } catch {
      break; // 404 past the last chunk = end of enrichments
    }
    let emptyChunk = true;
    for (const [k, v] of Object.entries(data)) {
      const pageNum = parseInt(k, 10);
      if (!Number.isFinite(pageNum)) continue;
      if (Array.isArray(v) && v.length > 0) {
        all.set(pageNum, v);
        emptyChunk = false;
      }
    }
    if (emptyChunk) break;
  }
  return all;
}

async function downloadImage(resourcePath: string): Promise<Buffer> {
  const url = resourcePath.startsWith('http') ? resourcePath : `https://${resourcePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Discover all pages in the publication ───────────────────────────────────

/**
 * Walk the chunked publication_pages endpoint until we either hit a 404 or
 * get an empty response. Returns a map keyed by real page number.
 * Caps at 10 chunks (= 100 pages) as a safety limit.
 */
async function fetchAllPages(pubId: string): Promise<Map<number, PageData>> {
  const all = new Map<number, PageData>();
  for (let chunkIdx = 1; chunkIdx <= 10; chunkIdx++) {
    let chunk: Map<number, PageData>;
    try {
      chunk = await fetchPageChunk(pubId, chunkIdx);
    } catch {
      break; // 404 or malformed = end of publication
    }
    if (chunk.size === 0) break;
    for (const [p, v] of chunk) all.set(p, v);
  }
  return all;
}

// ── Gemini vision call ──────────────────────────────────────────────────────

const VISION_PROMPT_IT = `Questa immagine mostra UN prodotto in offerta dal volantino di un supermercato italiano.

Estrai le informazioni leggibili e rispondi con SOLO un oggetto JSON (senza markdown, senza testo aggiuntivo):

{
  "prodotto": "nome del prodotto, pulito, senza il brand se è separato visivamente",
  "brand": "marchio (brand) STAMPATO SULLA CONFEZIONE DEL PRODOTTO — è il NOME DEL PRODUTTORE/AZIENDA che fa il prodotto (es. 'Galbani', 'Barilla', 'Ferrari', 'Coca-Cola'). NON è la categoria merceologica (es. 'Affettati', 'Pasta', 'Yogurt', 'Bevande', 'Salumi', 'Formaggi'). NON è il logo del supermercato. NON sono parole di chiamata all'azione ('scopri', 'nuovo', 'offerta'). NON è il marchio di un prodotto vicino. Se vedi solo una parola che indica il tipo di prodotto (es. 'Affettati' grande sulla confezione di un prosciutto Ferrari), quella NON è il brand: cerca il vero nome del produttore, di solito più piccolo o sul logo. Se non sei sicuro o non riesci a leggere il nome del produttore chiaramente, metti null.",
  "quantita": "peso, volume o numero pezzi come stringa (es. '500 g', '1 l', '6 pz'), oppure null",
  "prezzo_offerta": numero in euro (es. 2.49),
  "prezzo_originale": numero del prezzo pre-sconto se visibile (es. 3.99), altrimenti null,
  "sconto_percentuale": numero intero se visibile (es. 30), altrimenti null,
  "note": "una breve nota utile sul prodotto (es. 'stagionato 12 mesi', 'senza lattosio'), oppure null",
  "richiede_carta": true se il prezzo è riservato ai possessori della carta fedeltà (es. badge "SOLO CON", "CON CARTA", logo carta fedeltà vicino al prezzo), altrimenti false,
  "nome_carta": nome della carta fedeltà se visibile, NORMALIZZATO senza prefisso del supermercato (es. la carta visualizzata come "MD Buona Spesa Card" o "Carta MD Buona Spesa" → estrai "Buona Spesa Card"; "Carta Insieme Conad" → "Carta Insieme"). Restituisci il nome NUDO della carta, senza il nome della catena. Esempi validi: "Buona Spesa Card", "Carta Insieme", "Carta Fedeltà", "Carrefour Pay", "Pam Card". Se la carta non è visibile o il nome non è chiaro, null.,
  "ean": codice EAN/GTIN a 8–14 cifre se chiaramente visibile sulla confezione o vicino al prezzo (solo cifre, niente spazi/trattini), altrimenti null,
  "specifiche": oggetto JSON con specifiche rilevanti se visibili (es. {"classe_energetica":"A++","potenza":"300W"} per elettrodomestici, {"gradazione":"5.2%"} per birre, {"origine":"Italia"} per alimenti). Include SOLO campi leggibili. Restituisci null se nessuna specifica è chiara.
}

Regole:
- Non inventare dati non visibili. Se un campo non è leggibile, metti null.
- Usa il PUNTO come separatore decimale (2.49 non 2,49).
- Per "richiede_carta": cerca badge con testo tipo "SOLO CON", "CON CARTA", o il logo/nome di una carta fedeltà affiancato al prezzo scontato. Se presente, il prezzo_offerta è quello con la carta e prezzo_originale è quello senza la carta.
- Se l'immagine mostra più di un prodotto o è illeggibile o è un badge/cornice decorativa senza prodotto, rispondi {"error": "illegible_or_multiple"}.
- Se l'immagine mostra un prodotto ma prezzo_offerta non è leggibile, rispondi {"error": "no_price"}.
- Se l'immagine mostra un'offerta di viaggio (hotel, B&B, resort, villaggio, crociera, pacchetto vacanza, volo, tour) invece di un prodotto da supermercato, rispondi {"error": "travel_offer"}.`;

const VALIDITY_PROMPT_IT = `Questa immagine è UNA pagina del volantino di un supermercato italiano.

Cerca una dicitura di validità delle promozioni, tipicamente in basso o in alto sulla pagina, con testo come:
- "PROMOZIONI VALIDE DAL 21 APRILE AL 3 MAGGIO 2026"
- "Offerte valide dal 4/3 al 17/3/2026"
- "Dal 1 al 30 aprile"

Rispondi con SOLO un oggetto JSON:
{
  "valid_from": "YYYY-MM-DD" oppure null se non leggibile,
  "valid_to":   "YYYY-MM-DD" oppure null se non leggibile
}

Regole:
- Usa sempre il formato ISO YYYY-MM-DD (es. "2026-04-21").
- Se l'anno non è visibile, assumi l'anno corrente (${new Date().getFullYear()}).
- Se leggi SOLO un intervallo parziale (es. "DAL 21 APRILE"), metti valid_from e lascia valid_to null.
- Se la pagina non contiene alcuna data di validità, rispondi {"valid_from": null, "valid_to": null}.`;

const SUBPROMO_PROMPT_IT = `Questa immagine è UNA pagina del volantino di un supermercato italiano.

Cerca un banner/intestazione di SOTTO-PROMOZIONE che annunci date di validità DIVERSE e più RISTRETTE rispetto al normale periodo del volantino. Esempi tipici:
- "Weekend più uno — venerdì, sabato, domenica 01-02-03 MAGGIO + lunedì 04 MAGGIO"
- "Solo sabato e domenica 4-5 aprile"
- "Offerte del giovedì — 10 aprile"
- "Super sconto dal 25 al 28 aprile"

Il banner occupa tipicamente un riquadro colorato evidente in alto o nella parte superiore della pagina.

NON considerare la dicitura normale del volantino tipo "PROMOZIONI VALIDE DAL X AL Y" che compare nel footer di ogni pagina.

Rispondi con SOLO un oggetto JSON:
{
  "sub_promo_from": "YYYY-MM-DD" oppure null,
  "sub_promo_to":   "YYYY-MM-DD" oppure null
}

Regole:
- Ritorna null, null se la pagina NON ha un banner sotto-promozione evidente.
- Usa sempre il formato ISO YYYY-MM-DD.
- Se l'anno non è visibile nel banner, assumi l'anno corrente (${new Date().getFullYear()}).
- Se il banner indica giorni singoli multipli (es. "01-02-03 MAGGIO + 04 MAGGIO"), usa il primo come sub_promo_from e l'ultimo come sub_promo_to.`;

/**
 * Shared request helper for page-level vision calls (flyer validity, sub-promo).
 * Adds one retry on transient API failures — same rationale as extractProductFromCrop,
 * otherwise a single flaky call loses the dates for the whole flyer or a whole page.
 */
async function callGeminiOnPage(pageImgBuf: Buffer, apiKey: string, prompt: string): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: pageImgBuf.toString('base64') } },
      ],
    }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  const doCall = async (): Promise<string | null> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = `Gemini ${res.status}`;
      if (/\b(429|5\d\d)\b/.test(err)) throw new Error(err);
      return null;
    }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  };
  try {
    return await doCall();
  } catch (e) {
    const msg = (e as Error).message;
    const isTransient = /\b(429|5\d\d)\b/.test(msg) || msg.includes('timeout') || msg.includes('fetch failed');
    if (!isTransient) return null;
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    try { return await doCall(); } catch { return null; }
  }
}

async function extractFlyerValidity(pageImgBuf: Buffer, apiKey: string): Promise<{ from: string | null; to: string | null }> {
  const text = await callGeminiOnPage(pageImgBuf, apiKey, VALIDITY_PROMPT_IT);
  if (!text) return { from: null, to: null };
  try {
    const parsed = JSON.parse(text) as { valid_from?: string | null; valid_to?: string | null };
    const from = parsed.valid_from && /^\d{4}-\d{2}-\d{2}$/.test(parsed.valid_from) ? parsed.valid_from : null;
    const to = parsed.valid_to && /^\d{4}-\d{2}-\d{2}$/.test(parsed.valid_to) ? parsed.valid_to : null;
    return { from, to };
  } catch {
    return { from: null, to: null };
  }
}

async function extractPageSubPromo(pageImgBuf: Buffer, apiKey: string): Promise<{ from: string | null; to: string | null }> {
  const text = await callGeminiOnPage(pageImgBuf, apiKey, SUBPROMO_PROMPT_IT);
  if (!text) return { from: null, to: null };
  try {
    const parsed = JSON.parse(text) as { sub_promo_from?: string | null; sub_promo_to?: string | null };
    const from = parsed.sub_promo_from && /^\d{4}-\d{2}-\d{2}$/.test(parsed.sub_promo_from) ? parsed.sub_promo_from : null;
    const to = parsed.sub_promo_to && /^\d{4}-\d{2}-\d{2}$/.test(parsed.sub_promo_to) ? parsed.sub_promo_to : null;
    return { from, to };
  } catch {
    return { from: null, to: null };
  }
}

// Full-page recovery sweep: Shopfully's hotspot metadata sometimes misses
// products (observed consistently on MD's "Sapori dalla Toscana" green-bordered
// section and on grid layouts where the middle column isn't hotspotted).
// This sweep runs ONE vision call per page asking for every product visible,
// so we can recover the missing ones by de-duping against hotspot extractions.
const PAGE_SWEEP_PROMPT_IT = `Questa immagine è una pagina del volantino di un supermercato italiano.

Elenca TUTTI i singoli prodotti in offerta chiaramente visibili sulla pagina, con il loro prezzo.

ATTENZIONE — sezioni tipicamente difficili da catturare (cerca con doppia attenzione):
- **Sezioni tematiche con bordo colorato** (es. "Sapori dalla Toscana" con bordo verde, "Specialità regionali", "Bio", "Senza glutine"): contengono spesso 6-10 prodotti piccoli affiancati in griglia, ognuno è un prodotto distinto da elencare separatamente.
- **Griglie 2x3, 3x3 o più dense**: la colonna centrale o l'ultima riga vengono spesso saltate. Conta visivamente quanti prodotti contiene la griglia e assicurati di averli tutti.
- **Bundle/multi-pack**: un'unica foto con 3-4 prodotti uniti sotto un solo prezzo → conta come UN solo elemento (non 4).
- **Prodotti con prezzo nascosto sotto/accanto** (es. cartellino fuori dalla cornice principale): includili se il prezzo è visibile da qualche parte della pagina riconducibile al prodotto.

Escludi:
- offerte di viaggio (hotel, B&B, resort, crociere)
- immagini decorative, banner, mascotte, QR code, testo promozionale generico senza prezzo
- prezzi di prodotti mostrati dentro uno smartphone/tablet (mockup app, non offerta reale)

Rispondi con SOLO un oggetto JSON (senza markdown):
{
  "prodotti": [
    {
      "prodotto": "nome prodotto pulito",
      "brand": "produttore/marchio sulla confezione (NON la categoria tipo 'Affettati' o 'Pasta'). null se non leggibile.",
      "quantita": "peso/volume/pezzi come stringa (es. '500 g') o null",
      "prezzo_offerta": numero in euro (es. 2.49),
      "prezzo_originale": numero o null,
      "richiede_carta": true/false
    }
  ]
}

Regole:
- Usa il PUNTO come separatore decimale (2.49 non 2,49).
- Se nessun prodotto è visibile, rispondi {"prodotti": []}.
- **Sii esaustivo**: include OGNI prodotto con prezzo, non solo quelli principali. Conta visivamente i prodotti sulla pagina e verifica che l'array "prodotti" abbia lo stesso numero.
- Non inventare prodotti o prezzi non visibili.`;

interface PageSweepProduct {
  prodotto?: string;
  brand?: string | null;
  quantita?: string | null;
  prezzo_offerta?: number;
  prezzo_originale?: number | null;
  richiede_carta?: boolean | null;
}

async function sweepPageForProducts(pageImgBuf: Buffer, apiKey: string): Promise<PageSweepProduct[]> {
  const text = await callGeminiOnPage(pageImgBuf, apiKey, PAGE_SWEEP_PROMPT_IT);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { prodotti?: PageSweepProduct[] };
    return Array.isArray(parsed.prodotti) ? parsed.prodotti : [];
  } catch {
    return [];
  }
}

async function extractProductFromCropOnce(cropBuf: Buffer, apiKey: string): Promise<VisionProduct> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: VISION_PROMPT_IT },
          { inline_data: { mime_type: 'image/jpeg', data: cropBuf.toString('base64') } },
        ],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');
  try {
    return JSON.parse(text) as VisionProduct;
  } catch (e) {
    throw new Error(`Gemini response not JSON: ${text.slice(0, 100)}`);
  }
}

/**
 * Wraps extractProductFromCropOnce with one retry on transient API failures
 * (network timeouts, 5xx, 429 rate-limits). Observed error rate on MD's 270-hotspot
 * flyer varies from 5% to 50% run-to-run; retries recover most of the 50% cases
 * without blowing up cost since each retry is only one extra call.
 */
async function extractProductFromCrop(cropBuf: Buffer, apiKey: string): Promise<VisionProduct> {
  try {
    return await extractProductFromCropOnce(cropBuf, apiKey);
  } catch (e) {
    const msg = (e as Error).message;
    // Don't retry on explicit Gemini refusals or malformed prompt errors (4xx
    // that aren't 429) — those are stable failures, wasting a call.
    const isTransient = /\b(429|5\d\d)\b/.test(msg) || msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('no text');
    if (!isTransient) throw e;
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    return await extractProductFromCropOnce(cropBuf, apiKey);
  }
}

// ── Crop + save ─────────────────────────────────────────────────────────────

async function cropHotspot(
  pageImgBuf: Buffer,
  pageW: number,
  pageH: number,
  hotspot: Hotspot,
): Promise<Buffer | null> {
  const shape = hotspot.crop_shape ?? hotspot.shape;
  if (!shape) return null;
  const left = Math.max(0, Math.round(shape.x * pageW));
  const top = Math.max(0, Math.round(shape.y * pageH));
  const width = Math.min(pageW - left, Math.round(shape.width * pageW));
  const height = Math.min(pageH - top, Math.round(shape.height * pageH));
  if (width < 40 || height < 40) return null; // too small to be a real product tile
  try {
    return await sharp(pageImgBuf)
      .extract({ left, top, width, height })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (e) {
    return null;
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

// ── Concurrency helper ─────────────────────────────────────────────────────

async function mapWithConcurrency<A, B>(
  items: A[],
  concurrency: number,
  fn: (item: A, idx: number) => Promise<B>,
): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// ── Main entrypoint ─────────────────────────────────────────────────────────

export interface ShopfullyFetchResult {
  products: ConadFlyerProduct[];
  pageCount: number;
  hotspotsTotal: number;
  hotspotsSkipped: number;
  visionErrors: number;
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Pull all products from a Shopfully publication via the crop+vision pipeline.
 *
 * @param publicationId The numeric Shopfully publication ID (e.g. "819150" for MD)
 * @param chain The chain slug used in crop storage path (e.g. "md")
 * @param validFrom Optional flyer validity start date (YYYY-MM-DD), passed through to products
 * @param validTo   Optional flyer validity end date (YYYY-MM-DD), passed through to products
 */
export async function fetchShopfullyProducts(
  publicationId: string,
  chain: string,
  opts: { validFrom?: string; validTo?: string } = {},
): Promise<ShopfullyFetchResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const cropDir = join(CROPS_ROOT, chain, publicationId);
  ensureDir(cropDir);

  console.log(`  shopfully: fetching page descriptors + enrichments for pub ${publicationId}…`);
  const [allPages, allEnrichments] = await Promise.all([
    fetchAllPages(publicationId),
    fetchAllEnrichments(publicationId),
  ]);
  const pageCount = allPages.size;
  if (pageCount === 0) throw new Error(`No pages found for publication ${publicationId}`);
  const totalHotspots = Array.from(allEnrichments.values()).reduce((s, arr) => s + arr.length, 0);
  console.log(`  shopfully: ${pageCount} pages, ${totalHotspots} hotspots on ${allEnrichments.size} pages`);

  // Collect all (page, hotspot, cropBuf, cropRelUrl) tuples first (cheap), then
  // run the vision calls in parallel.
  type Task = {
    pageNum: number;
    hotspot: Hotspot;
    cropBuf: Buffer;
    cropUrl: string;
  };
  const tasks: Task[] = [];
  let hotspotsTotal = 0;
  let hotspotsSkipped = 0;

  // Extract flyer-wide validity dates from the first page footer (e.g. "PROMOZIONI
  // VALIDE DAL 21 APRILE AL 3 MAGGIO 2026"). Only run if the caller didn't already
  // pass explicit dates. This lets the ingest step use the real flyer window instead
  // of falling back to the current-week heuristic.
  let extractedValidFrom: string | null = opts.validFrom ?? null;
  let extractedValidTo: string | null = opts.validTo ?? null;

  // Per-page sub-promo overrides (e.g. "Weekend più uno — 01-02-03 MAGGIO + 04 MAGGIO"
  // on p35 of MD). Products on these pages inherit the narrower window instead of
  // the flyer-wide one. Detected via a separate vision call per page; null means
  // "no override".
  const pageSubPromo = new Map<number, { from: string; to: string }>();

  // Cache of page image buffers so we can run the full-page product-sweep pass
  // (see sweepPageForProducts) in parallel after the per-hotspot vision completes.
  // Shopfully's hotspot metadata sometimes misses products (e.g. "Sapori dalla
  // Toscana" section, middle column on 3-product rows). The sweep recovers them.
  const pageImgBufs = new Map<number, Buffer>();

  const sortedPageNums = Array.from(allPages.keys()).sort((a, b) => a - b);
  let firstPageDone = false;
  for (const pageNum of sortedPageNums) {
    const pageData = allPages.get(pageNum)!;
    // Prefer the highest level image (usually level_5 = 1200px wide)
    const rep = pageData.pageRepresentationDescriptors
      .filter((r) => r.type === 'image')
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    if (!rep) {
      console.log(`  shopfully: page ${pageNum} has no image, skipping`);
      continue;
    }
    const pageW = rep.width ?? 1200;
    const pageH = rep.height ?? 1620;

    const hotspots = allEnrichments.get(pageNum) ?? [];
    // Always download the page image so the full-page sweep below can run
    // even when Shopfully provides 0 hotspots for this page (e.g. Esselunga,
    // which exposes images but no hotspot metadata at all).
    const pageImgBuf = await downloadImage(rep.pageRepresentation.resourcePath);
    pageImgBufs.set(pageNum, pageImgBuf);
    hotspotsTotal += hotspots.length;

    if (!firstPageDone && (!extractedValidFrom || !extractedValidTo)) {
      const v = await extractFlyerValidity(pageImgBuf, apiKey);
      if (v.from) extractedValidFrom = extractedValidFrom ?? v.from;
      if (v.to) extractedValidTo = extractedValidTo ?? v.to;
      console.log(`  shopfully: flyer validity extracted from page ${pageNum}: ${extractedValidFrom ?? '?'} → ${extractedValidTo ?? '?'}`);
      firstPageDone = true;
    }

    // Per-page sub-promo detection. If this page has a narrower window than the
    // flyer-wide one, remember it so this page's products pick up the override.
    const sub = await extractPageSubPromo(pageImgBuf, apiKey);
    if (sub.from && sub.to && (sub.from !== extractedValidFrom || sub.to !== extractedValidTo)) {
      pageSubPromo.set(pageNum, { from: sub.from, to: sub.to });
      console.log(`  shopfully: sub-promo on page ${pageNum}: ${sub.from} → ${sub.to}`);
    }

    for (const hs of hotspots) {
      const cropBuf = await cropHotspot(pageImgBuf, pageW, pageH, hs);
      if (!cropBuf) {
        hotspotsSkipped++;
        continue;
      }
      const cropFilename = `${hs.id}.jpg`;
      const cropPath = join(cropDir, cropFilename);
      writeFileSync(cropPath, cropBuf);
      const cropUrl = `${CROPS_URL_PREFIX}/${chain}/${publicationId}/${cropFilename}`;
      tasks.push({ pageNum, hotspot: hs, cropBuf, cropUrl });
    }
  }
  console.log(`  shopfully: ${tasks.length} crops saved, running vision in parallel (concurrency=${VISION_CONCURRENCY})…`);

  // Run vision in parallel
  let visionErrors = 0;
  const visionResults = await mapWithConcurrency(tasks, VISION_CONCURRENCY, async (t) => {
    try {
      return await extractProductFromCrop(t.cropBuf, apiKey);
    } catch (e) {
      visionErrors++;
      return { error: `call_failed: ${(e as Error).message.slice(0, 80)}` } as VisionProduct;
    }
  });

  // Build the product array — skip vision errors and the prompt's explicit refusals
  const products: ConadFlyerProduct[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const v = visionResults[i];
    if (v.error) continue;
    if (!v.prodotto || typeof v.prezzo_offerta !== 'number' || !Number.isFinite(v.prezzo_offerta) || v.prezzo_offerta <= 0) continue;

    const key = `${(v.brand ?? '').trim()}|${v.prodotto.trim()}|${(v.quantita ?? '').trim()}|${v.prezzo_offerta}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const requiresCard = v.richiede_carta === true;
    const cardName = requiresCard && v.nome_carta ? v.nome_carta.trim() : null;

    // EAN: only keep if it looks like a plausible barcode (digits only, 8–14).
    // Gemini sometimes returns fragments of "COD. 12345" or "lotto n. 42" as
    // ean if the prompt is too eager — the digits-only length gate filters
    // those out before they reach ingest.
    const eanDigits = v.ean ? String(v.ean).replace(/\D/g, '') : '';
    const ean = eanDigits.length >= 8 && eanDigits.length <= 14 ? eanDigits : null;
    const specifications = v.specifiche && typeof v.specifiche === 'object' && Object.keys(v.specifiche).length > 0
      ? v.specifiche
      : null;

    // If the product's page has a sub-promo override (narrower window), use it
    // instead of the flyer-wide window.
    const sub = pageSubPromo.get(t.pageNum);
    const productValidFrom = sub?.from ?? extractedValidFrom;
    const productValidTo = sub?.to ?? extractedValidTo;

    products.push({
      prodotto: v.prodotto.trim(),
      brand: v.brand ? v.brand.trim() : null,
      prezzo_offerta: v.prezzo_offerta,
      prezzo_originale: typeof v.prezzo_originale === 'number' && v.prezzo_originale > 0 ? v.prezzo_originale : null,
      prezzo_al_kg: null,
      unita_prezzo: null,
      quantita_peso: v.quantita ? v.quantita.trim() : null,
      sconto_percentuale: typeof v.sconto_percentuale === 'number' ? Math.round(v.sconto_percentuale) : null,
      validita_inizio: productValidFrom,
      validita_fine: productValidTo,
      // ConadFlyerProduct doesn't have image_url/requires_card/card_name/ean
      // in its interface, but ingest.ts reads these off the product object at
      // runtime. Attach them here so downstream sees them.
      ...({ image_url: t.cropUrl, requires_card: requiresCard, card_name: cardName, mechanic: requiresCard ? 'loyalty_price' : null, ean, specifications } as object),
    });
  }

  // ── Page sweep: recover products missed by hotspot metadata ─────────────────
  // For each page that had hotspots, run one extra full-page vision call asking
  // for ALL visible products. De-dupe against what we already extracted. This
  // fixes structural gaps in Shopfully's hotspot coverage (e.g. MD's "Sapori
  // dalla Toscana" section, middle-column products on 3-wide grids).
  //
  // Normalized de-dup key is PAGE-SCOPED using (pageNum, quantity, price). We
  // deliberately drop the product name from the key because hotspot and sweep
  // phrasing diverges ("BASE PER FOCACCIA" vs "BASE PER FOCACCIA CA' BIANCA").
  // Two products with identical price + quantity on the same page are almost
  // certainly the same SKU, even with different naming.
  const sweepKey = (pageNum: number, quantita: string | null | undefined, price: number): string =>
    `${pageNum}|${(quantita ?? '').toLowerCase().trim()}|${price.toFixed(2)}`;

  const sweepSeen = new Set<string>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const v = visionResults[i];
    if (v.error || !v.prodotto || typeof v.prezzo_offerta !== 'number') continue;
    sweepSeen.add(sweepKey(t.pageNum, v.quantita, v.prezzo_offerta));
  }

  const sweepPageNums = Array.from(pageImgBufs.keys()).sort((a, b) => a - b);
  const sweepResults = await mapWithConcurrency(sweepPageNums, VISION_CONCURRENCY, async (pageNum) => {
    const buf = pageImgBufs.get(pageNum)!;
    try {
      const prods = await sweepPageForProducts(buf, apiKey);
      return { pageNum, prods };
    } catch {
      return { pageNum, prods: [] as PageSweepProduct[] };
    }
  });

  let sweepRecovered = 0;
  for (const { pageNum, prods } of sweepResults) {
    for (const p of prods) {
      if (!p.prodotto || typeof p.prezzo_offerta !== 'number' || !Number.isFinite(p.prezzo_offerta) || p.prezzo_offerta <= 0) continue;
      const key = sweepKey(pageNum, p.quantita, p.prezzo_offerta);
      if (sweepSeen.has(key)) continue;
      sweepSeen.add(key);

      const requiresCard = p.richiede_carta === true;
      const sub = pageSubPromo.get(pageNum);
      const productValidFrom = sub?.from ?? extractedValidFrom;
      const productValidTo = sub?.to ?? extractedValidTo;

      products.push({
        prodotto: p.prodotto.trim(),
        brand: p.brand ? p.brand.trim() : null,
        prezzo_offerta: p.prezzo_offerta,
        prezzo_originale: typeof p.prezzo_originale === 'number' && p.prezzo_originale > 0 ? p.prezzo_originale : null,
        prezzo_al_kg: null,
        unita_prezzo: null,
        quantita_peso: p.quantita ? p.quantita.trim() : null,
        sconto_percentuale: null,
        validita_inizio: productValidFrom,
        validita_fine: productValidTo,
        // No cropUrl — sweep products aren't tied to a specific hotspot image.
        ...({ requires_card: requiresCard, card_name: null, mechanic: requiresCard ? 'loyalty_price' : null } as object),
      });
      sweepRecovered++;
    }
  }
  if (sweepRecovered > 0) {
    console.log(`  shopfully: page sweep recovered ${sweepRecovered} products missed by hotspot metadata`);
  }

  return {
    products,
    pageCount,
    hotspotsTotal,
    hotspotsSkipped,
    visionErrors,
    validFrom: extractedValidFrom,
    validTo: extractedValidTo,
  };
}
