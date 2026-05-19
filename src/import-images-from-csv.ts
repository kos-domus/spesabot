/**
 * Import a CSV (produced by export-missing-images.js) and apply each
 * non-empty image_url to product_skus.image_url. The existing trigger
 * product_skus_register_image auto-feeds product_image_registry so the
 * URL becomes available for cross-chain backfill on the next pipeline.
 *
 * Validation per row before writing:
 *   - sku_id must be a positive integer
 *   - image_url must be a valid http(s) URL
 *   - HEAD request must succeed AND return Content-Type: image/*
 *
 * Rows that fail validation are reported and skipped — no partial writes.
 *
 * Usage:
 *   node dist/import-images-from-csv.js /tmp/missing-images-despar-2026-05-01.csv
 *
 * Idempotent: if image_url is already set for a sku, this will UPDATE it
 * (so you can re-run after correcting a bad paste).
 */

import { readFileSync } from 'node:fs';
import { query, close } from './db.js';

interface ParsedRow {
  sku_id: number;
  image_url: string;
  line_no: number;
}

// Minimal CSV parser: handles quoted fields with embedded commas and "" escapes.
// Spreadsheet exports always emit RFC4180-flavoured CSV so a hand-rolled parser
// is fine here — no need for a dependency.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

async function validateImageUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'not http(s)' };
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) {
      // Some CDNs lie on HEAD — try GET with a tiny range as fallback.
      const g = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(8000) });
      const gct = g.headers.get('content-type') ?? '';
      if (!gct.startsWith('image/')) return { ok: false, reason: `content-type ${ct || '?'}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 60) };
  }
}

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (!csvPath) { console.error('Usage: node dist/import-images-from-csv.js <path-to-csv>'); process.exit(1); }

  const text = readFileSync(csvPath, 'utf-8');
  const rows = parseCsv(text);
  if (rows.length === 0) { console.log('Empty CSV'); await close(); return; }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idIdx  = header.indexOf('sku_id');
  const urlIdx = header.indexOf('image_url');
  if (idIdx < 0 || urlIdx < 0) {
    console.error('CSV must have headers "sku_id" and "image_url"');
    process.exit(1);
  }

  const candidates: ParsedRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const skuStr = (r[idIdx] ?? '').trim();
    const url    = (r[urlIdx] ?? '').trim();
    if (!url) continue;
    const sku_id = parseInt(skuStr, 10);
    if (!Number.isInteger(sku_id) || sku_id <= 0) {
      console.warn(`line ${i + 1}: bad sku_id "${skuStr}" — skipping`);
      continue;
    }
    candidates.push({ sku_id, image_url: url, line_no: i + 1 });
  }

  console.log(`Found ${candidates.length} row(s) with image_url to apply`);
  if (candidates.length === 0) { await close(); return; }

  let applied = 0;
  let skipped = 0;
  for (const c of candidates) {
    const v = await validateImageUrl(c.image_url);
    if (!v.ok) {
      console.warn(`✗ sku ${c.sku_id} (line ${c.line_no}): ${v.reason} — ${c.image_url.slice(0, 80)}`);
      skipped++;
      continue;
    }
    const r = await query(
      `UPDATE product_skus SET image_url = $1, updated_at = now() WHERE id = $2`,
      [c.image_url, c.sku_id],
    );
    if (r.rowCount === 0) {
      console.warn(`✗ sku ${c.sku_id} not found in DB`);
      skipped++;
    } else {
      applied++;
    }
  }

  console.log(`\nDone: ${applied} applied, ${skipped} skipped.`);
  if (applied > 0) {
    console.log(`Trigger registered ${applied} new entries in product_image_registry.`);
  }
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
