/**
 * Despar product-image extractor.
 *
 * The Despar text parser (despar-flyer-fetch.ts) extracts product names and
 * prices from the iPaper flipbook overlays but never captures product images
 * — the result is despar SKUs at ~1.5% image coverage in DB. This module
 * fills that gap:
 *
 *   1. Discover the current iPaper flyer URL (reuses discoverDesparFlyerUrl)
 *   2. Open it in Playwright and SNIFF the signed CloudFront URLs of each
 *      page image (Pages/N/Zoom.jpg) as the page loads — iPaper uses AWS
 *      CloudFront with policy-signed URLs that 403 without the right
 *      session, so passive sniffing is the cleanest way in
 *   3. Download each page image and pass it to Gemini vision with a prompt
 *      asking for products + bounding boxes (normalized [0..1])
 *   4. Crop each bbox region (sharp), save the crop under
 *      data/product-images/despar/<flyer-slug>/<hash>.jpg
 *   5. Return ProductImage[] — caller (scripts/backfill-despar-images.ts)
 *      registers each in product_image_registry so the next pipeline run
 *      can heal the existing despar SKUs by name match
 *
 * Cost note: Gemini Flash @ ~$0.0005/page. For a 20-page Despar flyer the
 * total run is well under $0.02. Pages are processed serially (concurrency
 * doesn't help here — vision is the bottleneck and rate-limit risk is real).
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { discoverDesparFlyerUrl } from './despar-flyer-fetch.js';

// Reuse the same crop root + URL prefix as shopfully-vision-fetch.ts so the
// API's static mount works for both. Don't import them — that file is heavy
// and we only need these two constants.
const CROPS_ROOT = process.env.SPESABOT_PRODUCT_IMAGES_DIR
  ?? join(process.env.HOME!, 'job-desk/spesabot/data/product-images');

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

const GEMINI_MODEL = 'gemini-2.5-flash';
const VISION_TIMEOUT_MS = 60_000;
const MAX_PAGES = parseInt(process.env.SPESABOT_DESPAR_MAX_IMAGE_PAGES ?? '25', 10);

const VISION_PROMPT = `Questa è una pagina di un volantino del supermercato Despar/Eurospar (Italiano).

Per ogni prodotto chiaramente visibile sulla pagina, restituisci un oggetto con:
- "prodotto": nome del prodotto come scritto sul packaging
- "brand": marchio (Despar, Eurospar, S-Budget, Vivi Verde, Hofer, oppure brand commerciale)
- "quantita": peso/volume/pezzi come stringa (es. "500 g", "1 L", "6 pezzi") o null
- "prezzo_offerta": numero in euro (usa il PUNTO come decimale, es. 2.49)
- "prezzo_originale": numero in euro o null
- "bbox": bounding box normalizzato della regione che contiene il prodotto e il suo prezzo,
  in coordinate frazionarie [0..1] dell'immagine: {"x": <left>, "y": <top>, "w": <width>, "h": <height>}.
  Includi sia l'immagine del prodotto che il cartellino prezzo nel riquadro.

Escludi: banner generici, mascotte, QR code, immagini di lifestyle senza prezzo, hotspot di carta fedelta'.

Rispondi con SOLO un oggetto JSON nel formato: {"prodotti": [...]}.

Regole:
- Sii preciso sui bbox — devono includere TUTTO il riquadro prodotto + cartellino prezzo, ma nient'altro.
- Se la pagina non ha prodotti (cover, retro, banner intero), rispondi {"prodotti": []}.
- Non inventare prodotti o prezzi non visibili.`;

interface BBox { x: number; y: number; w: number; h: number; }

interface VisionProduct {
  prodotto?: string;
  brand?: string | null;
  quantita?: string | null;
  prezzo_offerta?: number;
  prezzo_originale?: number | null;
  bbox?: BBox;
}

export interface DesparImageResult {
  prodotto: string;
  brand: string | null;
  quantita: string | null;
  prezzo_offerta: number;
  prezzo_originale: number | null;
  image_url: string;
  page_num: number;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function flyerSlug(flyerUrl: string): string {
  // Extract the leaflet slug, e.g. "2026-os39-2026-es-veneto"
  const m = flyerUrl.match(/leaflet-[^/]+\/([^/]+)/);
  return m?.[1] ?? createHash('sha1').update(flyerUrl).digest('hex').slice(0, 12);
}

/**
 * Open the flyer with Playwright and capture every signed Pages/N/Zoom.jpg
 * URL the iPaper viewer requests. We click "Pagina successiva" up to
 * MAX_PAGES times so the lazy-loader fetches all spreads.
 */
async function sniffPageImageUrls(flyerUrl: string): Promise<Map<number, string>> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    const pageUrls = new Map<number, string>();
    page.on('request', (req) => {
      const u = req.url();
      const m = u.match(/\/Pages\/(\d+)\/Zoom\.jpg\?/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!pageUrls.has(n)) pageUrls.set(n, u);
      }
    });
    await page.goto(flyerUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(3000);

    for (let i = 0; i < MAX_PAGES; i++) {
      try {
        await page.click('[aria-label="Pagina successiva"]', { timeout: 2000 });
        await page.waitForTimeout(2000);
      } catch {
        break;
      }
    }
    return pageUrls;
  } finally {
    await browser.close();
  }
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading page image`);
  return Buffer.from(await res.arrayBuffer());
}

async function callGeminiOnPage(buf: Buffer, apiKey: string): Promise<VisionProduct[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: VISION_PROMPT },
        { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } },
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
  let raw: string | null;
  try {
    raw = await doCall();
  } catch (e) {
    const msg = (e as Error).message;
    const transient = /\b(429|5\d\d)\b/.test(msg) || msg.includes('timeout') || msg.includes('fetch failed');
    if (!transient) return [];
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    try { raw = await doCall(); } catch { return []; }
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { prodotti?: VisionProduct[] };
    return Array.isArray(parsed.prodotti) ? parsed.prodotti : [];
  } catch {
    return [];
  }
}

/**
 * Crop a normalized [0..1] bbox out of a page image buffer. Returns null
 * for degenerate boxes (too small or out of bounds) so callers can skip
 * the registration without raising.
 */
async function cropBBox(pageBuf: Buffer, bbox: BBox): Promise<Buffer | null> {
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W < 200 || H < 200) return null;
  const left = Math.max(0, Math.round(bbox.x * W));
  const top = Math.max(0, Math.round(bbox.y * H));
  const width = Math.min(W - left, Math.round(bbox.w * W));
  const height = Math.min(H - top, Math.round(bbox.h * H));
  if (width < 60 || height < 60) return null;
  try {
    return await sharp(pageBuf)
      .extract({ left, top, width, height })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Main entry point. Returns an array of products with their freshly-extracted
 * image_url (saved locally + reachable via /product-images/...). Caller is
 * responsible for registering each in product_image_registry.
 */
export async function extractDesparImages(opts: { apiKey?: string; flyerUrl?: string } = {}): Promise<DesparImageResult[]> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const flyerUrl = opts.flyerUrl ?? await discoverDesparFlyerUrl();
  const slug = flyerSlug(flyerUrl);
  const cropDir = join(CROPS_ROOT, 'despar', slug);
  ensureDir(cropDir);
  console.log(`[despar-images] flyer ${slug} → crops to ${cropDir}`);

  const pageUrls = await sniffPageImageUrls(flyerUrl);
  console.log(`[despar-images] sniffed ${pageUrls.size} page image URLs`);
  if (pageUrls.size === 0) return [];

  const out: DesparImageResult[] = [];
  const sortedPageNums = [...pageUrls.keys()].sort((a, b) => a - b);

  for (const pageNum of sortedPageNums) {
    const pageImgUrl = pageUrls.get(pageNum)!;
    let pageBuf: Buffer;
    try {
      pageBuf = await downloadImage(pageImgUrl);
    } catch (e) {
      console.warn(`[despar-images] page ${pageNum} download failed: ${(e as Error).message}`);
      continue;
    }
    const products = await callGeminiOnPage(pageBuf, apiKey);
    if (products.length === 0) continue;
    let kept = 0;
    for (const p of products) {
      if (!p.prodotto || !p.bbox || typeof p.prezzo_offerta !== 'number' || !Number.isFinite(p.prezzo_offerta) || p.prezzo_offerta <= 0) continue;
      const cropBuf = await cropBBox(pageBuf, p.bbox);
      if (!cropBuf) continue;
      const hash = createHash('sha1')
        .update(`${slug}|${pageNum}|${p.prodotto}|${p.prezzo_offerta}`)
        .digest('hex')
        .slice(0, 16);
      const fname = `${pageNum}-${hash}.jpg`;
      writeFileSync(join(cropDir, fname), cropBuf);
      const cropUrl = `${CROPS_URL_PREFIX}/despar/${slug}/${fname}`;
      out.push({
        prodotto: p.prodotto.trim(),
        brand: p.brand ? String(p.brand).trim() : null,
        quantita: p.quantita ? String(p.quantita).trim() : null,
        prezzo_offerta: p.prezzo_offerta,
        prezzo_originale: typeof p.prezzo_originale === 'number' && p.prezzo_originale > 0 ? p.prezzo_originale : null,
        image_url: cropUrl,
        page_num: pageNum,
      });
      kept++;
    }
    console.log(`[despar-images] page ${pageNum}: ${kept}/${products.length} products extracted`);
  }
  return out;
}
