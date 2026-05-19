/**
 * Interactive CLI to fill missing product images one at a time. Bypasses
 * the spreadsheet path entirely — for users who hate Numbers/Excel.
 *
 * Run in a TTY-allocated SSH session against the host that has the DB:
 *
 *   ssh -t <db-host> 'cd <path-to-spesabot-repo> && \
 *       export DATABASE_URL=... && \
 *       node dist/manual-image-fill.js despar'
 *
 * For each SKU missing an image (active offers only, junk-banner rows
 * pre-filtered), the script prints the product, opens nothing, just shows
 * a Google Images search URL — you click it on the Mac, find a clean
 * image, paste its URL into the terminal, ENTER. The script validates the
 * URL (HEAD must return image/*), commits the UPDATE, moves to the next.
 *
 * Commands during the loop:
 *   <empty ENTER>  → skip this SKU
 *   q              → quit (commits done so far stay)
 *   ?              → reprint the current SKU's metadata + search link
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { query, close } from './db.js';

// CDN root + URL prefix — same as shopfully-vision-fetch / despar-images so
// /product-images/ is mounted on the API regardless of which path put the
// file there. Sourced from env, with a sensible fallback.
const CROPS_ROOT = process.env.SPESABOT_PRODUCT_IMAGES_DIR
  ?? join(process.env.HOME!, 'job-desk/spesabot/data/product-images');
const CROPS_URL_PREFIX = (() => {
  if (process.env.SPESABOT_PRODUCT_IMAGES_URL) return process.env.SPESABOT_PRODUCT_IMAGES_URL;
  const webapp = process.env.SPESABOT_WEBAPP_URL;
  if (webapp) {
    try {
      const u = new URL(webapp);
      return `${u.protocol}//${u.host}/product-images`;
    } catch { /* fall through */ }
  }
  return 'https://app.spesify.xyz/product-images';
})();

// Drop spot for Mac→mini-PC scp uploads. Always the same path so the
// instructions stay copy-pasteable; the file is removed after each use.
const SHOT_PATH = '/tmp/spesify-shot.jpg';

interface Sku {
  id: number;
  brand: string | null;
  raw_name: string;
  raw_quantity: string | null;
  best_discount: number | null;
}

function googleImagesUrl(brand: string | null, name: string, qty: string | null): string {
  const q = [brand, name, qty].filter(Boolean).join(' ').trim();
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=isch`;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// Match magic bytes against known image formats. Returns the canonical
// mime + extension, or null if the bytes aren't an image we serve.
function detectImageMagic(buf: Uint8Array): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)                         return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)      return { mime: 'image/png',  ext: 'png' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)      return { mime: 'image/gif',  ext: 'gif' };
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)    return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/**
 * Move /tmp/spesify-shot.jpg (uploaded by the user via scp from the Mac)
 * into the public CDN dir under data/product-images/<chain>/manual/, with
 * a deterministic filename. Returns the public URL the API will serve, or
 * a reason string if the upload didn't materialize.
 */
function ingestShotForSku(chain: string, skuId: number): { ok: true; url: string } | { ok: false; reason: string } {
  if (!existsSync(SHOT_PATH)) return { ok: false, reason: `${SHOT_PATH} not found — did the scp succeed?` };
  let stat;
  try { stat = statSync(SHOT_PATH); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (stat.size < 1024) return { ok: false, reason: `file too small (${stat.size} bytes), looks corrupt` };
  const buf = readFileSync(SHOT_PATH);
  const magic = detectImageMagic(new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 16)));
  if (!magic) return { ok: false, reason: 'magic bytes do not match jpg/png/gif/webp' };

  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
  const dir = join(CROPS_ROOT, chain, 'manual');
  ensureDir(dir);
  const fname = `${skuId}-${hash}.${magic.ext}`;
  writeFileSync(join(dir, fname), buf);
  const url = `${CROPS_URL_PREFIX}/${chain}/manual/${fname}`;
  // Clean the staging file so the next iteration starts fresh; if the
  // user forgets a fresh upload they'll get a clear "not found" reason
  // instead of silently re-using yesterday's screenshot.
  try { unlinkSync(SHOT_PATH); } catch { /* fine if already gone */ }
  return { ok: true, url };
}

// Magic-byte signatures for the formats browsers actually display. CDNs
// that serve images as application/octet-stream (Azure Blob, some S3
// configs, etc.) trip the content-type check even when the file is fine,
// so we always GET the first few bytes as the source of truth.
function detectImageFromMagic(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)                       return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)    return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)    return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)  return 'image/webp';
  return null;
}

async function validateImageUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'not http(s)' };
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  try {
    // First: cheap HEAD reachability check (catches 404, auth-walls, etc.).
    // We don't trust its content-type alone — Azure Blob and friends often
    // return application/octet-stream for valid JPGs. Always confirm via
    // a small range GET + magic-byte sniff.
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!head.ok) return { ok: false, reason: `HTTP ${head.status}` };

    const get = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-15' },
      signal: AbortSignal.timeout(8000),
    });
    if (!get.ok && get.status !== 206) return { ok: false, reason: `HTTP ${get.status} on GET` };
    const buf = new Uint8Array(await get.arrayBuffer());
    const magic = detectImageFromMagic(buf);
    if (magic) return { ok: true };
    const ct = get.headers.get('content-type') ?? head.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) return { ok: true };
    return { ok: false, reason: `not an image (ct=${ct || '?'}, magic missing)` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 60) };
  }
}

function printSku(s: Sku, idx: number, total: number): void {
  const sep = '─'.repeat(72);
  console.log(`\n${sep}`);
  console.log(`[${idx}/${total}]  sku #${s.id}` + (s.best_discount ? `   sconto: -${s.best_discount}%` : ''));
  console.log(`  Brand:    ${s.brand ?? '—'}`);
  console.log(`  Nome:     ${s.raw_name}`);
  console.log(`  Quantità: ${s.raw_quantity ?? '—'}`);
  console.log(`  Cerca:    ${googleImagesUrl(s.brand, s.raw_name, s.raw_quantity)}`);
  console.log(sep);
}

async function main(): Promise<void> {
  const chain = process.argv[2] ?? 'despar';

  const result = await query<Sku>(`
    SELECT
      sk.id,
      sk.brand,
      sk.raw_name,
      sk.raw_quantity,
      MAX(o.discount_pct)::numeric(5,2) AS best_discount
    FROM product_skus sk
    JOIN chains c    ON c.id = sk.chain_id
    JOIN offers o    ON o.sku_id = sk.id
    WHERE c.slug = $1
      AND sk.image_url IS NULL
      AND o.valid_to >= CURRENT_DATE
      AND length(sk.raw_name) BETWEEN 6 AND 90
      AND sk.raw_name !~* '(settimana dal|concorso|partecipa|vince!|app despar|happy card|raccolta punti|tribù)'
    GROUP BY sk.id, sk.brand, sk.raw_name, sk.raw_quantity
    ORDER BY MAX(o.discount_pct) DESC NULLS LAST, sk.id
  `, [chain]);

  if (result.rows.length === 0) {
    console.log(`No SKUs missing images for chain '${chain}'. Nothing to do.`);
    await close();
    return;
  }

  console.log(`\n=== Manual image fill for chain '${chain}' ===`);
  console.log(`${result.rows.length} SKUs need an image. Per ognuno:`);
  console.log(`  - clicca il link "Cerca" sul Mac (Cmd+click in iTerm/Terminal)`);
  console.log(`  - right-click sull'immagine → "Copia indirizzo immagine"`);
  console.log(`  - incolla qui e premi ENTER`);
  console.log(``);
  console.log(`Comandi speciali:`);
  console.log(`  s              → upload screenshot dal Mac (per offerte multi-prodotto)`);
  console.log(`  ?              → ristampa il prodotto corrente`);
  console.log(`  <ENTER vuoto>  → skip questo SKU`);
  console.log(`  q              → quit (i salvataggi già fatti restano)`);

  const rl = createInterface({ input: stdin, output: stdout });

  let applied = 0;
  let skipped = 0;
  for (let i = 0; i < result.rows.length; i++) {
    const s = result.rows[i];
    let answered = false;
    printSku(s, i + 1, result.rows.length);
    while (!answered) {
      const raw = (await rl.question(`URL immagine [${applied}✓ ${skipped}↷]: `)).trim();
      if (raw === '') {
        skipped++;
        answered = true;
      } else if (raw === 'q' || raw === 'Q') {
        console.log('\nQuit. Saved so far:');
        console.log(`  ✓ ${applied} immagini applicate`);
        console.log(`  ↷ ${skipped} skip`);
        rl.close();
        await close();
        return;
      } else if (raw === '?') {
        printSku(s, i + 1, result.rows.length);
      } else if (raw === 's' || raw === 'S') {
        // Screenshot mode: user takes a screenshot on the Mac, scp's it
        // to the mini-PC at SHOT_PATH, then we copy it into the public
        // CDN dir under data/product-images/<chain>/manual/ and apply
        // the resulting URL to the SKU. Use case: multi-product offers
        // where no single Google image fits ("burger gusti assortiti").
        console.log(`\n  → Screenshot mode. Da un secondo terminale sul Mac, esegui:`);
        console.log(`    scp <path-screenshot> <db-host>:${SHOT_PATH}`);
        console.log(`  Poi torna qui e premi ENTER (o "c" per annullare).`);
        const shotAns = (await rl.question(`  Pronto? `)).trim().toLowerCase();
        if (shotAns === 'c' || shotAns === 'q') {
          console.log(`  cancellato, riprova URL o ENTER per skip.`);
          continue;
        }
        const ingest = ingestShotForSku(chain, s.id);
        if (!ingest.ok) {
          console.log(`  ✗ ${ingest.reason}. Riprova "s", URL diretto, o ENTER per skip.`);
          continue;
        }
        const r = await query(
          `UPDATE product_skus SET image_url = $1, updated_at = now() WHERE id = $2`,
          [ingest.url, s.id],
        );
        if ((r.rowCount ?? 0) > 0) {
          applied++;
          console.log(`  ✓ screenshot salvato (sku #${s.id}) → ${ingest.url}`);
        } else {
          console.log(`  ✗ sku non trovato (race condition?)`);
        }
        answered = true;
      } else {
        console.log('  validating...');
        const v = await validateImageUrl(raw);
        if (!v.ok) {
          console.log(`  ✗ rifiutato: ${v.reason}. Riprova o ENTER per skip, q per uscire.`);
          continue;
        }
        const r = await query(
          `UPDATE product_skus SET image_url = $1, updated_at = now() WHERE id = $2`,
          [raw, s.id],
        );
        if ((r.rowCount ?? 0) > 0) {
          applied++;
          console.log(`  ✓ salvato (sku #${s.id})`);
        } else {
          console.log(`  ✗ sku non trovato (race condition?)`);
        }
        answered = true;
      }
    }
  }

  console.log(`\n=== Fine ===`);
  console.log(`  ✓ ${applied} immagini applicate`);
  console.log(`  ↷ ${skipped} skip`);
  rl.close();
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
