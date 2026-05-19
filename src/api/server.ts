#!/usr/bin/env node
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { query, getClient } from '../db.js';

const MONITOR_STATE_PATH = join(homedir(), '.cache', 'spesabot-monitor', 'state.json');

async function readMonitorState(): Promise<unknown> {
  try {
    const raw = await fs.readFile(MONITOR_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Telegram initData validation ──────────────────────────────────────────────
// Augment FastifyRequest so handlers can read req.telegramUserId safely
declare module 'fastify' {
  interface FastifyRequest {
    telegramUserId?: string;
  }
}

// Maximum age for auth_date before we reject the initData as stale (5 minutes).
const AUTH_DATE_MAX_AGE_SECONDS = 86400; // 24 hours — Mini App sessions can be long

// Simple in-memory nonce/replay cache. Stores hash -> timestamp for dedup.
// Entries expire after AUTH_DATE_MAX_AGE_SECONDS to prevent unbounded growth.
const replayCache = new Map<string, number>();
const REPLAY_CACHE_CLEANUP_INTERVAL = 60_000; // 1 minute

setInterval(() => {
  const cutoff = Date.now() - AUTH_DATE_MAX_AGE_SECONDS * 1000;
  for (const [hash, ts] of replayCache) {
    if (ts < cutoff) replayCache.delete(hash);
  }
}, REPLAY_CACHE_CLEANUP_INTERVAL).unref();

/**
 * Non-throwing variant: runs the same HMAC + freshness checks as
 * validateTelegramAuth but instead of responding 401 it sets req.telegramUserId
 * only on success. Used by endpoints that want graceful "not authenticated"
 * behaviour (e.g. GET /api/profile can render a register form instead of
 * erroring out).
 */
function tryValidateTelegramAuth(req: FastifyRequest): boolean {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('tma ')) return false;
  const initData = authHeader.slice(4);
  const botToken = process.env.SPESABOT_BOT_TOKEN;
  if (!botToken) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDateStr = params.get('auth_date');
  if (!receivedHash || !authDateStr) return false;
  // Guard: receivedHash must be a 64-char hex string before Buffer.from('hex'),
  // otherwise timingSafeEqual gets a buffer of unequal length and throws.
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) return false;
  const authDate = parseInt(authDateStr, 10);
  if (isNaN(authDate)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > AUTH_DATE_MAX_AGE_SECONDS) return false;
  params.delete('hash');
  const sortedKeys = [...params.keys()].sort();
  const dataCheckString = sortedKeys.map(k => `${k}=${params.get(k)}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (expectedHash.length !== receivedHash.length ||
      !timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(receivedHash, 'hex'))) {
    return false;
  }
  const userJson = params.get('user');
  if (!userJson) return false;
  try {
    const user = JSON.parse(userJson) as { id: number };
    if (!user.id) return false;
    req.telegramUserId = String(user.id);
    return true;
  } catch {
    return false;
  }
}

// Async preHandler — Fastify v5 hangs on sync hooks that don't take a `done`
// callback. Keeping this Promise-returning is load-bearing.
async function validateTelegramAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('tma ')) {
    reply.status(401).send({ error: 'Missing Telegram auth' });
    return;
  }

  const initData = authHeader.slice(4); // strip "tma "
  const botToken = process.env.SPESABOT_BOT_TOKEN;
  if (!botToken) {
    // Misconfiguration — fail closed
    reply.status(500).send({ error: 'Server misconfiguration' });
    return;
  }

  // Parse initData as URL query params
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) {
    reply.status(401).send({ error: 'Invalid initData: missing hash' });
    return;
  }
  // Guard: hash must be 64-char hex. Without this, a malformed (non-hex)
  // string of length 64 reaches Buffer.from('hex') which silently produces
  // a shorter buffer, making timingSafeEqual throw a 500 instead of a clean 401.
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
    reply.status(401).send({ error: 'Invalid initData: malformed hash' });
    return;
  }

  // Note: replay protection removed — Telegram's initData is reused for the
  // entire Mini App session. HMAC verification + freshness check is sufficient.

  // --- Freshness check: reject if auth_date is too old ---
  const authDateStr = params.get('auth_date');
  if (!authDateStr) {
    reply.status(401).send({ error: 'Invalid initData: missing auth_date' });
    return;
  }
  const authDate = parseInt(authDateStr, 10);
  if (isNaN(authDate)) {
    reply.status(401).send({ error: 'Invalid initData: malformed auth_date' });
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > AUTH_DATE_MAX_AGE_SECONDS) {
    reply.status(401).send({ error: 'initData expired: auth_date too old' });
    return;
  }

  // Remove hash, sort remaining params, build data-check-string
  params.delete('hash');
  const sortedKeys = [...params.keys()].sort();
  const dataCheckString = sortedKeys.map(k => `${k}=${params.get(k)}`).join('\n');

  // secret_key = HMAC-SHA256("WebAppData", botToken)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();

  // expectedHash = HMAC-SHA256(dataCheckString, secretKey)
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  if (expectedHash.length !== receivedHash.length ||
      !timingSafeEqual(
        Buffer.from(expectedHash, 'hex'),
        Buffer.from(receivedHash, 'hex'),
      )) {
    reply.status(401).send({ error: 'Invalid Telegram signature' });
    return;
  }

  // Extract user.id from the validated "user" param
  const userJson = params.get('user');
  if (!userJson) {
    reply.status(401).send({ error: 'No user in initData' });
    return;
  }
  try {
    const user = JSON.parse(userJson) as { id: number };
    if (!user.id) throw new Error('missing id');
    req.telegramUserId = String(user.id);
  } catch {
    reply.status(401).send({ error: 'Malformed user in initData' });
  }
}

const PORT = parseInt(process.env.SPESABOT_API_PORT ?? '3080', 10);

const app = Fastify({
  logger: {
    level: 'info',
    transport: undefined, // journalctl captures stdout
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, ip: req.ip }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  },
});

// Security headers
app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Image CDNs by source kind:
      //   'self' / data:                 — fallback emoji + inline
      //   app.spesify.xyz                — our self-hosted product-image registry
      //                                    (Esselunga, DPiù, and ~1.9k SKUs without
      //                                    a public chain URL). Without this, those
      //                                    product cards render emoji-only and the
      //                                    chain looks "missing" from the UI.
      //   chain CDNs                     — direct flyer hosts per chain (Migross,
      //                                    Lidl, Conad, Rossetto, Famila/maxidi,
      //                                    Eurospin/digitalflyer)
      //   s7g10.scene7.com               — Adobe Scene7 CDN used by Aldi (+ Conad,
      //                                    Orvea, Lidl fallbacks)
      //   *.blob.core.windows.net        — Despar Azure-hosted product images
      imgSrc: [
        "'self'", "data:",
        "https://app.spesify.xyz",
        "https://*.migross.it", "https://*.lidl.it", "https://*.conad.it",
        "https://rossettogroup.it", "https://*.maxidi.it",
        "https://digitalflyer.eurospin.it",
        "https://s7g10.scene7.com",
        "https://*.blob.core.windows.net",
      ],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameSrc: ["'none'"],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
  crossOriginEmbedderPolicy: false, // needed for Telegram WebView
});

// Rate limiting — protect against abuse from public endpoints
app.register(rateLimit, {
  max: 60,           // 60 requests per window
  timeWindow: '1 minute',
  keyGenerator: (req) => req.ip,
});

// CORS — allow Mini App to call API from Telegram WebView.
// The Authorization header (for initData) triggers a preflight OPTIONS request.
// Must return early on OPTIONS to prevent Fastify from routing it as a real request.
//
// Allowed origins: Telegram WebView (web.telegram.org variants) and the configured
// webapp URL. CORS '*' is replaced with an explicit allowlist to prevent cross-origin
// abuse of authenticated endpoints.
const ALLOWED_ORIGINS = new Set([
  'https://web.telegram.org',
  'https://webk.telegram.org',
  'https://webz.telegram.org',
  // Allow the configured webapp URL's origin (Cloudflare Tunnel or custom domain)
  ...(process.env.SPESABOT_WEBAPP_URL
    ? [new URL(process.env.SPESABOT_WEBAPP_URL).origin]
    : []),
]);

app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return reply.status(204).send();
  }
});

// Serve the Telegram Mini App static files
app.register(fastifyStatic, {
  root: join(import.meta.dirname, '..', 'webapp'),
  prefix: '/webapp/',
  cacheControl: false, // disable caching during development
});

// Serve locally-stored product crops (populated by the Shopfully vision pipeline
// in src/parsers/shopfully-vision-fetch.ts). Stored outside dist/ so they
// survive rebuilds. Override root via SPESABOT_PRODUCT_IMAGES_DIR.
const productImagesRoot = process.env.SPESABOT_PRODUCT_IMAGES_DIR
  ?? join(import.meta.dirname, '..', '..', 'data', 'product-images');
app.register(fastifyStatic, {
  root: productImagesRoot,
  prefix: '/product-images/',
  decorateReply: false, // avoid "Fastify instance already has reply decorator" clash with previous register
  cacheControl: true,
  maxAge: 7 * 24 * 3600 * 1000, // crops are immutable once written
});

// Prevent aggressive caching of webapp assets
app.addHook('onSend', async (req, reply) => {
  if (req.url.startsWith('/webapp/')) {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
});

// Root redirect to Mini App
app.get('/', async (_, reply) => {
  reply.redirect('/webapp/index.html');
});

// --- Health / Status ---
app.get('/api/status', async () => {
  const stats = await query(`
    SELECT
      (SELECT count(*) FROM offers) as total_offers,
      (SELECT count(*) FROM product_skus) as total_skus,
      (SELECT count(DISTINCT sk.chain_id) FROM offers o JOIN product_skus sk ON sk.id = o.sku_id) as chains_with_offers,
      (SELECT count(*) FROM flyer_campaigns WHERE scrape_status = 'loaded') as campaigns_loaded,
      (SELECT max(created_at) FROM flyer_campaigns WHERE scrape_status = 'loaded') as last_scrape
  `);
  return {
    status: 'ok',
    database: stats.rows[0],
    version: '0.1.0',
  };
});

/**
 * Build SQL clause + params for store_ids filter.
 * National offers (store_id IS NULL) always pass through — they apply to all stores.
 * Only filters store-specific offers (Famila) to the selected store IDs.
 */
function buildStoreFilter(storeIdsParam: string | undefined, paramOffset: number): { clause: string; params: number[] } {
  const ids = (storeIdsParam ?? '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n > 0);
  if (ids.length === 0) return { clause: '', params: [] };
  const placeholders = ids.map((_, i) => `$${paramOffset + i}`).join(',');
  // Include: national offers (no store) + offers from selected stores
  return {
    clause: `AND (o.store_id IS NULL OR o.store_id IN (${placeholders}))`,
    params: ids,
  };
}

// --- Search offers by product name ---
app.get<{ Querystring: { q: string; limit?: string; chains?: string; store_ids?: string } }>('/api/search', async (req) => {
  const q = req.query.q;
  const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
  // Optional chain filter: ?chains=famila,lidl,eurospin
  const chainsParam = req.query.chains?.split(',').filter(Boolean) ?? [];
  if (!q || q.length < 2) {
    return { error: 'Query too short (min 2 chars)', results: [] };
  }

  const tsQuery = q.trim().split(/\s+/).filter(w => w.length >= 2).join(' & ');
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // PostgreSQL regex uses \y for word boundary, not \b. Patterns rank how
  // closely the query appears as a "head word" of the product name:
  //   startsWithPattern — query is the first non-brand token (e.g. "Latte intero")
  //   wordBoundaryPattern — query appears as a whole word anywhere
  const startsWithPattern = `^\\s*([A-Za-z&.]+\\s+)?${escaped}\\y`;
  const wordBoundaryPattern = `(^|\\s)${escaped}(\\s|$)`;

  // Search drives off the canonical `products.name`, not the raw chain SKU
  // labels. SKU labels carry brand/scent/marketing noise (PALMOLIVE Doccia
  // Crema Latte e Pesca) that produces spurious matches on simple terms
  // like "latte". Canonical names are the curated head — much cleaner.
  // Each (canonical product, chain) collapses to one row with the cheapest
  // active offer; we rank by canonical-name relevance (FTS + word-boundary).
  const results = await query(`
    SELECT DISTINCT ON (p.id, c.slug)
      sk.id            AS sku_id,
      p.id             AS product_id,
      p.name           AS prodotto,
      COALESCE(p.brand, sk.brand) AS brand,
      sk.image_url,
      o.offer_price,
      o.original_price,
      o.discount_pct,
      o.unit_price,
      sk.raw_quantity AS quantita,
      c.name           AS catena,
      c.slug           AS chain_slug,
      s.name           AS negozio,
      s.city           AS citta,
      o.mechanic,
      o.valid_from,
      o.valid_to,
      ts_rank(to_tsvector('italian', p.name), to_tsquery('italian', $2)) AS fts_rank,
      similarity(p.name, $1) AS match_score,
      (CASE WHEN p.name ~* $3 THEN 2 ELSE 0 END
        + CASE WHEN p.name ~* $4 THEN 1 ELSE 0 END) AS word_match
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN products p     ON p.id = sk.product_id
    JOIN chains c       ON c.id = sk.chain_id
    LEFT JOIN stores s  ON s.id = o.store_id
    WHERE o.valid_to >= CURRENT_DATE
      ${chainsParam.length > 0
        ? `AND c.slug = ANY(ARRAY[${chainsParam.map((_, i) => `$${i + 5}`).join(',')}])`
        : ''}
      ${buildStoreFilter(req.query.store_ids, 5 + chainsParam.length).clause}
      -- Drop canonical names that look like extracted fragments rather
      -- than real product titles. The rule-based canonical matcher
      -- occasionally produces names like "E LATTE" or "DI MANDORLE" by
      -- splitting a longer SKU label at the wrong spot — a search for
      -- "latte" otherwise dredges up shower gels and creams.
      AND p.name !~* '^\\s*(e|con|al|alla|alle|allo|della|delle|dello|del|dei|di|in|per|su|da)\\s+'
      AND LENGTH(p.name) >= 4
      AND (
        p.name ~* $4                                                     -- whole-word match wins
        OR to_tsvector('italian', p.name) @@ to_tsquery('italian', $2)   -- stemmed FTS
        OR similarity(p.name, $1) > 0.4                                  -- close fuzzy
      )
    ORDER BY p.id, c.slug, o.offer_price ASC
  `, [q, tsQuery, startsWithPattern, wordBoundaryPattern, ...chainsParam, ...buildStoreFilter(req.query.store_ids, 5 + chainsParam.length).params]);

  // Re-sort: word boundary matches first, then FTS rank, then similarity, then price
  const sorted = results.rows
    .sort((a: any, b: any) =>
      (b.word_match - a.word_match) ||
      (b.fts_rank - a.fts_rank) ||
      (b.match_score - a.match_score) ||
      (a.offer_price - b.offer_price))
    .slice(0, limit);

  return { query: q, count: sorted.length, results: sorted };
});

// --- Universal explore endpoint ---
//
// Single-stop replacement for /api/search + /api/deals/top + /api/deals/expiring
// + /api/offers/nearby + /api/categoria/:tag. All filters optional and combinable
// (e.g. "Migross offers expiring in 3 days near 45.45,11.0"). Always returns the
// /api/deals/top response shape (results[] with stores[] aggregation) so the UI
// can render with the existing productCard().
//
// Filter axes:
//   q            — free-text product name (ILIKE on raw_name + canonical name,
//                  ranked by pg_trgm similarity)
//   chains       — comma-separated chain slugs
//   store_ids    — comma-separated store IDs
//   expiring_within_days — int, only offers ending within N days
//   lat,lng,radius_km — geo proximity (PostGIS ST_DWithin); national offers
//                       (store_id IS NULL) always included
//   category     — single tag from the canonical list
//   sort         — 'discount' (default) | 'expiring' | 'price' | 'relevance' (auto if q)
//   limit        — max 100, default 50
app.get<{
  Querystring: {
    q?: string;
    chains?: string;
    store_ids?: string;
    expiring_within_days?: string;
    lat?: string;
    lng?: string;
    radius_km?: string;
    category?: string;
    sort?: string;
    limit?: string;
  };
}>('/api/explore', async (req) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 100);
  const q = (req.query.q ?? '').trim();
  const chainsList = req.query.chains?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const storeIdsList = req.query.store_ids
    ?.split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0) ?? [];
  const expiringDays = req.query.expiring_within_days
    ? Math.max(0, Math.min(parseInt(req.query.expiring_within_days, 10) || 0, 60))
    : null;
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng ? parseFloat(req.query.lng) : null;
  const radiusKm = req.query.radius_km
    ? Math.min(parseFloat(req.query.radius_km) || 20, 50)
    : 20;
  const useGeo = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);
  const validCategories = new Set([
    'senza-lattosio','senza-glutine','integrale','bio','vegano',
    'prima-infanzia','proteico','surgelati','cura-casa','cura-persona',
  ]);
  // Accept either a single value (legacy) or a CSV (multi-select).
  // Whitelist-filter to drop unknown/malicious tags before hitting SQL.
  const categoriesList = (req.query.category ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(c => validCategories.has(c));
  const useCategories = categoriesList.length > 0;
  const sortRaw = req.query.sort?.trim() || (q ? 'relevance' : 'discount');

  // Build params + WHERE clauses dynamically. Param indices are tracked so the
  // SQL stays valid as we append optional filters in any combination.
  const params: unknown[] = [];
  const where: string[] = ['o.valid_to >= CURRENT_DATE'];
  const push = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (q && q.length >= 2) {
    const qParam = push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(sk.raw_name) LIKE ${qParam} OR LOWER(COALESCE(p.name,'')) LIKE ${qParam} OR LOWER(COALESCE(sk.brand,'')) LIKE ${qParam})`);
  }
  if (chainsList.length > 0) {
    const chainsParam = push(chainsList);
    where.push(`c.slug = ANY(${chainsParam}::text[])`);
  }
  if (storeIdsList.length > 0) {
    const storesParam = push(storeIdsList);
    where.push(`o.store_id = ANY(${storesParam}::int[])`);
  }
  if (expiringDays !== null) {
    const daysParam = push(expiringDays);
    where.push(`o.valid_to <= CURRENT_DATE + (${daysParam}::int * INTERVAL '1 day')`);
  }
  if (useCategories) {
    // PostgreSQL array overlap operator `&&` returns true if any element
    // matches → OR semantics across selected categories.
    const catParam = push(categoriesList);
    where.push(`sk.tags && ${catParam}::text[]`);
  }
  if (useGeo) {
    const latP = push(lat);
    const lngP = push(lng);
    const radP = push(radiusKm);
    // National (store_id NULL) always included; store-specific must be in radius.
    where.push(`(o.store_id IS NULL OR ST_DWithin(s.location::geography, ST_SetSRID(ST_MakePoint(${lngP}, ${latP}), 4326)::geography, ${radP}::float * 1000))`);
  }

  // Sort. 'relevance' uses pg_trgm similarity over canonical name; the others
  // map to a deterministic single-axis ORDER BY for predictable scrolling.
  let orderBy: string;
  let trgmRankParam = '';
  if (sortRaw === 'relevance' && q && q.length >= 2) {
    trgmRankParam = push(q);
    orderBy = `MAX(GREATEST(similarity(LOWER(sk.raw_name), LOWER(${trgmRankParam})), similarity(LOWER(COALESCE(p.name,'')), LOWER(${trgmRankParam})))) DESC, MAX(o.discount_pct) DESC NULLS LAST`;
  } else if (sortRaw === 'expiring') {
    orderBy = 'MIN(o.valid_to) ASC, MAX(o.discount_pct) DESC NULLS LAST';
  } else if (sortRaw === 'price') {
    orderBy = 'MIN(o.offer_price) ASC';
  } else {
    orderBy = 'MAX(o.discount_pct) DESC NULLS LAST, MIN(o.offer_price) ASC';
  }
  const limitParam = push(limit);

  const sql = `
    SELECT
      sk.id                       AS sku_id,
      sk.product_id               AS product_id,
      sk.raw_name                 AS prodotto,
      sk.brand,
      sk.image_url,
      sk.raw_quantity             AS quantita,
      c.name                      AS catena,
      c.slug                      AS chain_slug,
      MIN(o.offer_price)          AS offer_price,
      MAX(o.offer_price)          AS offer_price_max,
      MIN(o.original_price)       AS original_price,
      MAX(o.discount_pct)         AS discount_pct,
      MAX(o.unit_price)           AS unit_price,
      MAX(o.mechanic::text)       AS mechanic,
      MIN(o.valid_to)             AS valid_to,
      MIN(o.valid_from)           AS valid_from,
      (COUNT(DISTINCT o.store_id) FILTER (WHERE o.store_id IS NOT NULL))::int AS store_count,
      BOOL_OR(o.store_id IS NULL) AS is_national,
      COALESCE(
        json_agg(
          json_build_object('name', s.name, 'city', s.city, 'offer_price', o.offer_price)
          ORDER BY o.offer_price, s.name
        ) FILTER (WHERE s.id IS NOT NULL),
        '[]'::json
      )                           AS stores
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c       ON c.id = sk.chain_id
    LEFT JOIN stores s  ON s.id = o.store_id
    LEFT JOIN products p ON p.id = sk.product_id
    WHERE ${where.join(' AND ')}
    GROUP BY sk.id, sk.raw_name, sk.brand, sk.image_url, sk.raw_quantity, c.name, c.slug
    ORDER BY ${orderBy}
    LIMIT ${limitParam}
  `;

  const results = await query(sql, params);
  return {
    count: results.rows.length,
    filters: {
      q: q || null,
      chains: chainsList.length > 0 ? chainsList : null,
      store_ids: storeIdsList.length > 0 ? storeIdsList : null,
      expiring_within_days: expiringDays,
      nearby: useGeo ? { lat, lng, radius_km: radiusKm } : null,
      categories: useCategories ? categoriesList : null,
      sort: sortRaw,
    },
    results: results.rows,
  };
});

// --- Search by macro-category (tags) ---
app.get<{ Params: { tag: string }; Querystring: { limit?: string; chains?: string; store_ids?: string } }>('/api/categoria/:tag', async (req) => {
  const tag = req.params.tag.toLowerCase();
  const limit = Math.min(parseInt(req.query.limit ?? '30', 10), 100);
  const chainsParam = req.query.chains?.split(',').filter(Boolean) ?? [];
  const catStoreFilter = buildStoreFilter(req.query.store_ids, 2 + chainsParam.length);

  const validTags = [
    'senza-lattosio', 'senza-glutine', 'integrale', 'bio', 'vegano',
    'prima-infanzia', 'proteico', 'surgelati', 'cura-casa', 'cura-persona',
  ];
  if (!validTags.includes(tag)) {
    return { error: `Tag sconosciuto. Disponibili: ${validTags.join(', ')}`, results: [] };
  }

  const results = await query(`
    SELECT DISTINCT ON (sk.normalized_name, c.slug)
      sk.raw_name as prodotto,
      sk.brand,
      sk.image_url,
      o.offer_price,
      o.original_price,
      o.discount_pct,
      o.unit_price,
      sk.raw_quantity as quantita,
      c.name as catena,
      c.slug as chain_slug,
      s.name as negozio,
      s.city as citta,
      sk.tags
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE o.valid_to >= CURRENT_DATE
      AND $1 = ANY(sk.tags)
      ${chainsParam.length > 0
        ? `AND c.slug = ANY(ARRAY[${chainsParam.map((_, i) => `$${i + 2}`).join(',')}])`
        : ''}
      ${catStoreFilter.clause}
    ORDER BY sk.normalized_name, c.slug, o.offer_price ASC
  `, [tag, ...chainsParam, ...catStoreFilter.params]);

  const sorted = results.rows
    .sort((a: any, b: any) => (a.offer_price - b.offer_price))
    .slice(0, limit);

  return { categoria: tag, count: sorted.length, results: sorted };
});

// --- List available categories with product counts ---
app.get('/api/categorie', async () => {
  const results = await query(`
    SELECT unnest(sk.tags) as tag, COUNT(DISTINCT sk.id) as prodotti
    FROM product_skus sk
    JOIN offers o ON o.sku_id = sk.id
    WHERE o.valid_to >= CURRENT_DATE AND array_length(sk.tags, 1) > 0
    GROUP BY tag ORDER BY prodotti DESC
  `);
  return { categorie: results.rows };
});

// --- List stores per chain ---
app.get<{ Params: { chain: string } }>('/api/stores/:chain', async (req) => {
  const chain = req.params.chain;
  const results = await query(`
    SELECT
      s.id, s.name, s.city, s.external_id as slug,
      count(o.id) as offerte_attive
    FROM stores s
    JOIN chains c ON c.id = s.chain_id
    LEFT JOIN offers o ON o.store_id = s.id AND o.valid_to >= CURRENT_DATE
    WHERE c.slug = $1 AND s.is_active
    GROUP BY s.id, s.name, s.city, s.external_id
    ORDER BY count(o.id) DESC, s.name
  `, [chain]);
  return { chain, count: results.rows.length, stores: results.rows };
});

// --- Top deals this week ---
app.get<{ Querystring: { limit?: string; chains?: string; store_ids?: string } }>('/api/deals/top', async (req) => {
  const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
  const chainsParam = req.query.chains?.split(',').filter(Boolean) ?? [];
  const chainClause = chainsParam.length > 0
    ? `AND c.slug = ANY(ARRAY[${chainsParam.map((_, i) => `$${i + 2}`).join(',')}])`
    : '';
  const dealsStoreFilter = buildStoreFilter(req.query.store_ids, 2 + chainsParam.length);

  // Group by (sku, chain) so the same product on 26 famila stores appears
  // ONCE with a store list + price range, instead of 26 rows that push real
  // deals off the page. For store-less national offers (store_id IS NULL),
  // stores[] is an empty array and price_min = price_max = offer_price.
  const results = await query(`
    SELECT
      sk.id                       AS sku_id,
      sk.product_id               AS product_id,
      sk.raw_name                 AS prodotto,
      sk.brand,
      sk.image_url,
      sk.raw_quantity             AS quantita,
      c.name                      AS catena,
      c.slug                      AS chain_slug,
      MIN(o.offer_price)          AS offer_price,
      MAX(o.offer_price)          AS offer_price_max,
      MIN(o.original_price)       AS original_price,
      MAX(o.discount_pct)         AS discount_pct,
      MAX(o.mechanic::text)       AS mechanic,
      MIN(o.valid_to)             AS valid_to,
      MIN(o.valid_from)           AS valid_from,
      (COUNT(DISTINCT o.store_id) FILTER (WHERE o.store_id IS NOT NULL))::int AS store_count,
      BOOL_OR(o.store_id IS NULL) AS is_national,
      -- Compact store list for UI: name + city + offer_price per store.
      -- Null store_ids collapse to one implicit "chain-wide" entry, handled
      -- via is_national above.
      COALESCE(
        json_agg(
          json_build_object('name', s.name, 'city', s.city, 'offer_price', o.offer_price)
          ORDER BY o.offer_price, s.name
        ) FILTER (WHERE s.id IS NOT NULL),
        '[]'::json
      )                           AS stores
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE o.valid_to >= CURRENT_DATE
      AND o.discount_pct IS NOT NULL
      AND o.offer_price < 50
      ${chainClause}
      ${dealsStoreFilter.clause}
    GROUP BY sk.id, sk.raw_name, sk.brand, sk.image_url, sk.raw_quantity, c.name, c.slug
    ORDER BY MAX(o.discount_pct) DESC
    LIMIT $1
  `, [limit, ...chainsParam, ...dealsStoreFilter.params]);

  return { count: results.rows.length, results: results.rows };
});

// --- Deals expiring soon ---
// Same shape as /api/deals/top, but filtered to offers expiring within
// `within_days` (default 3, max 14) and ordered by valid_to ASC. Powers
// the "🔥 In scadenza" sidebar entry — surface offers about to disappear.
app.get<{ Querystring: { within_days?: string; limit?: string; chains?: string; store_ids?: string } }>('/api/deals/expiring', async (req) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100);
  const withinDays = Math.min(Math.max(parseInt(req.query.within_days ?? '3', 10), 0), 14);
  const chainsParam = req.query.chains?.split(',').filter(Boolean) ?? [];
  const chainClause = chainsParam.length > 0
    ? `AND c.slug = ANY(ARRAY[${chainsParam.map((_, i) => `$${i + 3}`).join(',')}])`
    : '';
  const dealsStoreFilter = buildStoreFilter(req.query.store_ids, 3 + chainsParam.length);

  const results = await query(`
    SELECT
      sk.id                       AS sku_id,
      sk.product_id               AS product_id,
      sk.raw_name                 AS prodotto,
      sk.brand,
      sk.image_url,
      sk.raw_quantity             AS quantita,
      c.name                      AS catena,
      c.slug                      AS chain_slug,
      MIN(o.offer_price)          AS offer_price,
      MAX(o.offer_price)          AS offer_price_max,
      MIN(o.original_price)       AS original_price,
      MAX(o.discount_pct)         AS discount_pct,
      MAX(o.mechanic::text)       AS mechanic,
      MIN(o.valid_to)             AS valid_to,
      MIN(o.valid_from)           AS valid_from,
      (COUNT(DISTINCT o.store_id) FILTER (WHERE o.store_id IS NOT NULL))::int AS store_count,
      BOOL_OR(o.store_id IS NULL) AS is_national,
      COALESCE(
        json_agg(
          json_build_object('name', s.name, 'city', s.city, 'offer_price', o.offer_price)
          ORDER BY o.offer_price, s.name
        ) FILTER (WHERE s.id IS NOT NULL),
        '[]'::json
      )                           AS stores
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE o.valid_to >= CURRENT_DATE
      AND o.valid_to <= (CURRENT_DATE + ($2 || ' days')::interval)::date
      AND o.offer_price < 50
      ${chainClause}
      ${dealsStoreFilter.clause}
    GROUP BY sk.id, sk.raw_name, sk.brand, sk.image_url, sk.raw_quantity, c.name, c.slug
    ORDER BY MIN(o.valid_to) ASC, MAX(o.discount_pct) DESC NULLS LAST
    LIMIT $1
  `, [limit, String(withinDays), ...chainsParam, ...dealsStoreFilter.params]);

  return { count: results.rows.length, within_days: withinDays, results: results.rows };
});

// --- Offers by chain ---
app.get<{ Params: { chain: string }; Querystring: { limit?: string } }>('/api/chain/:chain', async (req) => {
  const chain = req.params.chain;
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100);

  const results = await query(`
    SELECT
      sk.raw_name as prodotto,
      sk.brand,
      sk.image_url,
      o.offer_price,
      o.original_price,
      o.discount_pct,
      sk.raw_quantity as quantita,
      c.name as catena,
      c.slug as chain_slug,
      s.name as negozio,
      s.city as citta,
      o.mechanic
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE c.slug = $1
      AND o.valid_to >= CURRENT_DATE
    ORDER BY o.discount_pct DESC NULLS LAST, o.offer_price ASC
    LIMIT $2
  `, [chain, limit]);

  return { chain, count: results.rows.length, results: results.rows };
});

// --- Compare product across chains ---
app.get<{ Querystring: { q: string; limit?: string } }>('/api/compare', async (req) => {
  const q = req.query.q;
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100);
  if (!q || q.length < 2) {
    return { error: 'Query too short', results: [] };
  }

  const results = await query(`
    SELECT
      sk.raw_name as prodotto,
      sk.brand,
      sk.image_url,
      o.offer_price,
      o.original_price,
      o.discount_pct,
      o.unit_price,
      sk.raw_quantity as quantita,
      c.name as catena,
      c.slug as chain_slug
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE o.valid_to >= CURRENT_DATE
      AND (sk.raw_name ILIKE '%' || $1 || '%' OR similarity(sk.raw_name, $1) > 0.25)
    ORDER BY o.offer_price ASC
    LIMIT $2
  `, [q, limit]);

  return { query: q, count: results.rows.length, results: results.rows };
});

// --- Price spread: products available at 2+ chains with price comparison ---
app.get<{ Querystring: { limit?: string; min_savings?: string } }>('/api/price-spread', async (req) => {
  const limit = Math.min(parseInt(req.query.limit ?? '30', 10), 100);
  const minSavings = parseFloat(req.query.min_savings ?? '0');

  const results = await query(`
    SELECT
      product_name, product_brand, category, chain_count,
      min_price, max_price, price_spread, savings_pct,
      cheapest_chain, available_at
    FROM price_spread
    WHERE savings_pct >= $1 AND savings_pct < 90
    ORDER BY savings_pct DESC
    LIMIT $2
  `, [minSavings, limit]);

  return { count: results.rows.length, results: results.rows };
});

// --- Cross-chain prices for a specific product ---
app.get<{ Params: { id: string } }>('/api/product/:id/prices', async (req) => {
  const productId = parseInt(req.params.id, 10);
  if (isNaN(productId)) return { error: 'Invalid product ID', results: [] };

  const directResults = await query(`
    SELECT
      chain_name as catena, chain_slug,
      raw_name as prodotto, image_url,
      offer_price, original_price, unit_price, discount_pct,
      raw_quantity as quantita,
      valid_from, valid_to
    FROM cross_chain_prices
    WHERE product_id = $1
    ORDER BY offer_price ASC
  `, [productId]);

  return { product_id: productId, count: directResults.rows.length, prices: directResults.rows };
});

// --- Stores with locations ---
app.get<{ Params: { chain: string } }>('/api/negozi/:chain', async (req) => {
  const chain = req.params.chain;
  const results = await query(`
    SELECT s.name, s.address, s.city, s.postal_code,
      ST_Y(s.location::geometry) as lat, ST_X(s.location::geometry) as lng,
      c.name as catena
    FROM stores s JOIN chains c ON c.id = s.chain_id
    WHERE c.slug = $1 AND s.location IS NOT NULL
    ORDER BY s.city, s.name
  `, [chain]);

  return {
    chain,
    count: results.rows.length,
    stores: results.rows.map((s: any) => ({
      ...s,
      maps_url: `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`,
    })),
  };
});

// --- Profile registration & management ---
// All profile endpoints require validated Telegram initData — the user id comes
// from the cryptographically verified payload, NEVER from client-supplied params.
// A client that can forge telegram_user_id would otherwise read or modify any
// other user's profile by knowing their Telegram id (trivial to enumerate).
// Returns 200 with { authenticated: false } when initData is missing/invalid,
// so the Mini App can render a friendly "open from Telegram" message or a
// registration form instead of a blank error. POST /api/profile/register still
// requires a valid HMAC so an unauthenticated client can't actually create a
// profile — the 200 here is purely informational.
app.get(
  '/api/profile',
  async (req) => {
    if (!tryValidateTelegramAuth(req)) {
      return { authenticated: false, registered: false };
    }
    const result = await query(
      `SELECT id, username, display_name, email, onboarded, preferred_chains, preferred_store_ids, created_at
       FROM user_profiles WHERE telegram_user_id = $1`,
      [req.telegramUserId],
    );
    if (result.rows.length === 0) {
      return { authenticated: true, registered: false };
    }
    return { authenticated: true, registered: true, profile: result.rows[0] };
  },
);

app.post<{ Body: { username: string; email: string; display_name?: string } }>(
  '/api/profile/register',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const userId = req.telegramUserId!;
    const { username, email, display_name } = req.body;

    // Validate
    if (!username || username.length < 3 || username.length > 30) {
      return reply.status(400).send({ error: 'Username deve essere tra 3 e 30 caratteri' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return reply.status(400).send({ error: 'Username può contenere solo lettere, numeri e underscore' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send({ error: 'Email non valida' });
    }

    // Check uniqueness
    const existingUser = await query(
      'SELECT id FROM user_profiles WHERE username = $1 AND telegram_user_id != $2',
      [username.toLowerCase(), userId],
    );
    if (existingUser.rows.length > 0) {
      return reply.status(409).send({ error: 'Username già in uso' });
    }
    const existingEmail = await query(
      'SELECT id FROM user_profiles WHERE email = $1 AND telegram_user_id != $2',
      [email.toLowerCase(), userId],
    );
    if (existingEmail.rows.length > 0) {
      return reply.status(409).send({ error: 'Email già registrata' });
    }

    // Upsert profile
    await query(`
      INSERT INTO user_profiles (telegram_user_id, username, email, display_name, onboarded)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        username = $2, email = $3, display_name = COALESCE($4, user_profiles.display_name),
        onboarded = true, updated_at = now()
    `, [userId, username.toLowerCase(), email.toLowerCase(), display_name || null]);

    return { ok: true };
  },
);

app.put<{ Body: { username?: string; email?: string; display_name?: string } }>(
  '/api/profile',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const userId = req.telegramUserId!;
    const { username, email, display_name } = req.body;

    const updates: string[] = [];
    const params: unknown[] = [userId];
    let idx = 2;

    if (username !== undefined) {
      if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return reply.status(400).send({ error: 'Username non valido' });
      }
      const dup = await query('SELECT id FROM user_profiles WHERE username = $1 AND telegram_user_id != $2', [username.toLowerCase(), userId]);
      if (dup.rows.length > 0) return reply.status(409).send({ error: 'Username già in uso' });
      updates.push(`username = $${idx++}`);
      params.push(username.toLowerCase());
    }
    if (email !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.status(400).send({ error: 'Email non valida' });
      }
      const dup = await query('SELECT id FROM user_profiles WHERE email = $1 AND telegram_user_id != $2', [email.toLowerCase(), userId]);
      if (dup.rows.length > 0) return reply.status(409).send({ error: 'Email già registrata' });
      updates.push(`email = $${idx++}`);
      params.push(email.toLowerCase());
    }
    if (display_name !== undefined) {
      updates.push(`display_name = $${idx++}`);
      params.push(display_name);
    }

    if (updates.length === 0) return { ok: true };

    updates.push('updated_at = now()');
    await query(`UPDATE user_profiles SET ${updates.join(', ')} WHERE telegram_user_id = $1`, params);
    return { ok: true };
  },
);

// --- User preferences (for Mini App) — protected by Telegram initData auth ---
app.get<{ Querystring: Record<string, never> }>(
  '/api/preferences',
  { preHandler: validateTelegramAuth },
  async (req) => {
    const userId = req.telegramUserId!;
    const result = await query(
      'SELECT preferred_chains, preferred_store_ids FROM user_profiles WHERE telegram_user_id = $1',
      [userId],
    );
    return result.rows[0] ?? { preferred_chains: [], preferred_store_ids: [] };
  },
);

app.post<{ Body: { preferred_chains?: string[]; preferred_store_ids?: number[] } }>(
  '/api/preferences',
  { preHandler: validateTelegramAuth },
  async (req) => {
    const userId = req.telegramUserId!;
    const { preferred_chains, preferred_store_ids } = req.body;

    await query(`
      INSERT INTO user_profiles (telegram_user_id, preferred_chains, preferred_store_ids)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        preferred_chains = COALESCE($2, user_profiles.preferred_chains),
        preferred_store_ids = COALESCE($3, user_profiles.preferred_store_ids),
        updated_at = now()
    `, [userId, preferred_chains ?? [], preferred_store_ids ?? []]);

    return { ok: true };
  },
);

// --- All stores (for Mini App store picker) ---
app.get('/api/stores', async () => {
  // Two sources unioned:
  //   1. Actual store rows (chain_id via stores) — per-store chains like famila, lidl, conad-flyer.
  //   2. A synthetic "national coverage" row per chain whose offers are
  //      chain-wide (store_id IS NULL on the offers table). Without this,
  //      national-only chains (md, crai, dpiu, esselunga, poli, …) never
  //      appeared in the Negozi/Preferenze pickers even though they were
  //      actively promoting. is_national=true lets the frontend render them
  //      with a "valido in tutti i punti vendita" badge instead of an address.
  const real = await query(`
    SELECT s.id, s.name, s.address, s.city, s.postal_code, c.slug as chain, c.name as chain_name,
      ST_Y(s.location::geometry) as lat, ST_X(s.location::geometry) as lng,
      false AS is_national
    FROM stores s JOIN chains c ON c.id = s.chain_id
    WHERE s.is_active
    ORDER BY c.name, s.city, s.name
  `);
  const national = await query(`
    SELECT
      NULL::int           AS id,
      c.name || ' (rete nazionale)' AS name,
      NULL                AS address,
      'Italia'            AS city,
      NULL                AS postal_code,
      c.slug              AS chain,
      c.name              AS chain_name,
      NULL::float         AS lat,
      NULL::float         AS lng,
      true                AS is_national
    FROM chains c
    WHERE EXISTS (
      SELECT 1 FROM offers o
      JOIN product_skus ps ON ps.id = o.sku_id
      WHERE ps.chain_id = c.id
        AND o.store_id IS NULL
        AND o.valid_to >= CURRENT_DATE
    )
    ORDER BY c.name
  `);
  const stores = [...real.rows, ...national.rows];
  return { count: stores.length, stores };
});

// --- Nearby stores: IDs + names of physical stores within radius_km of (lat, lng).
// Used by the Preferenze "Vicino a me" button to pre-select every store in range,
// NOT just the closest one. PostGIS ST_DWithin does the distance filter.
app.get<{ Querystring: { lat: string; lng: string; radius_km?: string } }>(
  '/api/stores/nearby',
  async (req) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusKm = Math.min(parseFloat(req.query.radius_km ?? '20'), 50);
    if (isNaN(lat) || isNaN(lng)) {
      return { error: 'Invalid lat/lng', stores: [] };
    }
    const results = await query(`
      SELECT
        s.id, s.name, s.city, c.slug AS chain, c.name AS chain_name,
        ROUND((ST_Distance(
          s.location::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
        ) / 1000)::numeric, 1) AS km
      FROM stores s
      JOIN chains c ON c.id = s.chain_id
      WHERE s.is_active
        AND s.location IS NOT NULL
        AND ST_DWithin(
          s.location::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3::float * 1000
        )
      ORDER BY km ASC
    `, [lat, lng, radiusKm]);
    return { count: results.rows.length, radius_km: radiusKm, stores: results.rows };
  },
);

// --- Nearby offers: all current offers from stores within radius_km of (lat, lng) ---
app.get<{ Querystring: { lat: string; lng: string; radius_km?: string; limit?: string } }>(
  '/api/offers/nearby',
  async (req) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusKm = Math.min(parseFloat(req.query.radius_km ?? '20'), 50);
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);

    if (isNaN(lat) || isNaN(lng)) {
      return { error: 'Invalid lat/lng', results: [] };
    }

    // Include national offers (store_id IS NULL) + store-specific offers within radius.
    // Uses PostGIS ST_DWithin for efficient geo filtering.
    // Note: cast $3 to float to allow decimal radii (e.g. 0.5 km) without
    //   "invalid input syntax for type integer" errors from PostgreSQL.
    const results = await query(`
      SELECT
        sk.raw_name as prodotto,
        sk.brand,
        sk.image_url,
        o.offer_price,
        o.original_price,
        o.discount_pct,
        o.unit_price,
        sk.raw_quantity as quantita,
        c.name as catena,
        c.slug as chain_slug,
        s.name as negozio,
        s.city as citta,
        ROUND((ST_Distance(s.location::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000)::numeric, 1) as km,
        o.mechanic,
        o.valid_to,
        o.valid_from
      FROM offers o
      JOIN product_skus sk ON sk.id = o.sku_id
      JOIN chains c ON c.id = sk.chain_id
      LEFT JOIN stores s ON s.id = o.store_id
      WHERE o.valid_to >= CURRENT_DATE
        AND (
          o.store_id IS NULL
          OR ST_DWithin(s.location::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3::float * 1000)
        )
      ORDER BY o.discount_pct DESC NULLS LAST, o.offer_price ASC
      LIMIT $4
    `, [lat, lng, radiusKm, limit]);

    return { count: results.rows.length, radius_km: radiusKm, results: results.rows };
  },
);

// --- Store-specific offers: all offers from a specific store + national offers from same chain ---
app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
  '/api/store/:id/offers',
  async (req) => {
    const storeId = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 200);
    if (isNaN(storeId)) return { error: 'Invalid store ID', results: [] };

    // Get the chain for this store so we can also include the chain's national offers
    const storeInfo = await query(
      'SELECT s.id, s.name, s.city, s.chain_id, c.slug as chain_slug, c.name as chain_name FROM stores s JOIN chains c ON c.id = s.chain_id WHERE s.id = $1',
      [storeId],
    );
    if (storeInfo.rows.length === 0) {
      return { error: 'Store not found', results: [] };
    }
    const store = storeInfo.rows[0];

    const results = await query(`
      SELECT
        sk.raw_name as prodotto,
        sk.brand,
        sk.image_url,
        o.offer_price,
        o.original_price,
        o.discount_pct,
        o.unit_price,
        sk.raw_quantity as quantita,
        c.name as catena,
        c.slug as chain_slug,
        s.name as negozio,
        s.city as citta,
        o.mechanic
      FROM offers o
      JOIN product_skus sk ON sk.id = o.sku_id
      JOIN chains c ON c.id = sk.chain_id
      LEFT JOIN stores s ON s.id = o.store_id
      WHERE o.valid_to >= CURRENT_DATE
        AND sk.chain_id = $2
        AND (o.store_id IS NULL OR o.store_id = $1)
      ORDER BY o.discount_pct DESC NULLS LAST, o.offer_price ASC
      LIMIT $3
    `, [storeId, store.chain_id, limit]);

    return {
      store: { id: store.id, name: store.name, city: store.city, chain_slug: store.chain_slug, chain_name: store.chain_name },
      count: results.rows.length,
      results: results.rows,
    };
  },
);

// --- Watchlist: registered users watch products/categories for price alerts ---

// Resolve the DB profile id for the authenticated Telegram user. Requires
// validateTelegramAuth to have run as preHandler — req.telegramUserId is only
// set by the HMAC-validated initData, never from query/body.
async function resolveAuthedProfileId(req: FastifyRequest): Promise<number | null> {
  const tgId = req.telegramUserId;
  if (!tgId) return null;
  const result = await query<{ id: number }>('SELECT id FROM user_profiles WHERE telegram_user_id = $1', [tgId]);
  return result.rows[0]?.id ?? null;
}

app.get(
  '/api/watches',
  { preHandler: validateTelegramAuth },
  async (req) => {
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return { watches: [] };

    const results = await query(`
      SELECT id, watch_type, query, max_price, chain_filter, store_filter, is_active, created_at
      FROM user_watches
      WHERE user_profile_id = $1 AND is_active = true
      ORDER BY created_at DESC
    `, [profileId]);

    return { count: results.rows.length, watches: results.rows };
  },
);

app.post<{ Body: {
  watch_type: 'product' | 'category' | 'keyword';
  query: string;
  max_price?: number;
  chain_filter?: string[];
  store_filter?: number[];
} }>(
  '/api/watches',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const { watch_type, query: q, max_price, chain_filter, store_filter } = req.body;
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return reply.status(401).send({ error: 'Devi registrare un profilo prima' });

    if (!watch_type || !['product', 'category', 'keyword'].includes(watch_type)) {
      return reply.status(400).send({ error: 'watch_type non valido' });
    }
    if (!q || q.length < 2) {
      return reply.status(400).send({ error: 'Query troppo corta' });
    }

    // Upsert against uq_user_watches_dedup (migration 023). Re-submitting an
    // identical alert refreshes its max_price and re-activates it instead of
    // creating a duplicate row. `xmax = 0` is true only for freshly INSERTed
    // rows, so we can tell the client whether to render "creato" vs "aggiornato".
    const result = await query(`
      INSERT INTO user_watches (user_profile_id, watch_type, query, max_price, chain_filter, store_filter)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_profile_id, watch_type, (lower(trim(query))), chain_filter, store_filter)
      DO UPDATE SET max_price = EXCLUDED.max_price,
                    is_active = true
      RETURNING id, (xmax = 0) AS created
    `, [profileId, watch_type, q.trim(), max_price ?? null, chain_filter ?? [], store_filter ?? []]);

    return { ok: true, id: result.rows[0].id, created: result.rows[0].created };
  },
);

app.delete<{ Params: { id: string } }>(
  '/api/watches/:id',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const watchId = parseInt(req.params.id, 10);
    if (isNaN(watchId)) return reply.status(400).send({ error: 'Invalid ID' });

    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return reply.status(401).send({ error: 'Auth required' });

    const result = await query(
      'DELETE FROM user_watches WHERE id = $1 AND user_profile_id = $2',
      [watchId, profileId],
    );
    return { ok: true, deleted: result.rowCount };
  },
);

// --- Shopping list with offer-alert triggers ---
//
// Each authed user has a single default list (auto-created on first use).
// Items reference canonical `products`, so one entry covers all chain SKUs.
// Each item carries optional thresholds (min_discount_pct, max_price) used
// by notify-grocery-list.ts to decide when to push a Telegram alert.

const SHOPPING_LIST_CAP = 100;

/**
 * Fetch or lazy-create the default shopping list for a user profile.
 * Atomic via a single CTE so concurrent GET+POST from the same user (which
 * is what happens when the Mini App boots: DOMContentLoaded fires the GET
 * while the user instantly clicks a heart) don't race on the partial unique
 * index `idx_shopping_lists_default` and end up with one query waiting on
 * a row-level lock that the other never releases.
 */
async function getOrCreateDefaultList(profileId: number): Promise<number> {
  const result = await query<{ id: number }>(
    `WITH ins AS (
       INSERT INTO shopping_lists (user_profile_id, name, is_default)
       SELECT $1, 'Lista della spesa', true
       WHERE NOT EXISTS (
         SELECT 1 FROM shopping_lists WHERE user_profile_id = $1 AND is_default = true
       )
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     SELECT id FROM ins
     UNION ALL
     SELECT id FROM shopping_lists WHERE user_profile_id = $1 AND is_default = true
     LIMIT 1`,
    [profileId],
  );
  if (!result.rows[0]) {
    throw new Error(`Failed to resolve shopping list for profile ${profileId}`);
  }
  return result.rows[0].id;
}

app.get(
  '/api/shopping-list',
  { preHandler: validateTelegramAuth },
  async (req) => {
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return { items: [], list: null };
    const listId = await getOrCreateDefaultList(profileId);

    // Items joined with their cheapest active offer per chain. We surface
    // the best (lowest) currently-available price + the chain that has it,
    // plus a count of chains with an active offer so the UI can show e.g.
    // "in offerta da 3 catene".
    const items = await query(`
      SELECT
        sli.id,
        sli.product_id,
        p.name        AS product_name,
        p.brand       AS product_brand,
        p.category    AS product_category,
        sli.min_discount_pct,
        sli.max_price,
        sli.notify_enabled,
        sli.notes,
        sli.last_notified_at,
        sli.created_at,
        sli.category_override_id,
        sli.sort_order,
        pc.id         AS category_id,
        pc.slug       AS category_slug,
        pc.name_it    AS category_name,
        pc.emoji      AS category_emoji,
        pc.sort_order AS category_sort_order,
        best.best_price,
        best.best_original_price,
        best.best_discount_pct,
        best.best_chain_name,
        best.best_chain_slug,
        best.active_chain_count,
        best.best_image_url
      FROM shopping_list_items sli
      JOIN products p ON p.id = sli.product_id
      LEFT JOIN product_categories pc
        ON pc.id = COALESCE(sli.category_override_id, p.category_id)
      LEFT JOIN LATERAL (
        SELECT
          MIN(o.offer_price) AS best_price,
          (ARRAY_AGG(o.original_price ORDER BY o.offer_price ASC))[1] AS best_original_price,
          (ARRAY_AGG(o.discount_pct ORDER BY o.offer_price ASC))[1]   AS best_discount_pct,
          (ARRAY_AGG(c.name ORDER BY o.offer_price ASC))[1]           AS best_chain_name,
          (ARRAY_AGG(c.slug ORDER BY o.offer_price ASC))[1]           AS best_chain_slug,
          (ARRAY_AGG(sk.image_url ORDER BY o.offer_price ASC) FILTER (WHERE sk.image_url IS NOT NULL))[1] AS best_image_url,
          COUNT(DISTINCT c.id)::int AS active_chain_count
        FROM offers o
        JOIN product_skus sk ON sk.id = o.sku_id
        JOIN chains c ON c.id = sk.chain_id
        WHERE sk.product_id = sli.product_id
          AND o.valid_to   >= CURRENT_DATE
          AND o.valid_from <= CURRENT_DATE
      ) best ON true
      WHERE sli.list_id = $1
      ORDER BY pc.sort_order NULLS LAST, sli.sort_order, sli.created_at DESC
    `, [listId]);

    return {
      list: { id: listId, cap: SHOPPING_LIST_CAP },
      count: items.rows.length,
      items: items.rows,
    };
  },
);

app.post<{ Body: {
  product_id?: number;
  sku_id?: number;
  min_discount_pct?: number;
  max_price?: number;
  notes?: string;
} }>(
  '/api/shopping-list/items',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return reply.status(401).send({ error: 'Devi registrare un profilo prima' });

    let { product_id } = req.body;
    const { sku_id, min_discount_pct, max_price, notes } = req.body;

    // Allow callers to pass either canonical product_id directly, or a sku_id
    // that we resolve to its product_id. The Mini App's heart-button sends
    // sku_id (cards already have it); the dedicated search box sends product_id.
    if (!product_id && sku_id) {
      const resolved = await query<{ product_id: number | null }>(
        'SELECT product_id FROM product_skus WHERE id = $1',
        [sku_id],
      );
      if (!resolved.rows[0]?.product_id) {
        return reply.status(400).send({ error: 'SKU non collegato a un prodotto canonico' });
      }
      product_id = resolved.rows[0].product_id;
    }
    if (!product_id || product_id <= 0) {
      return reply.status(400).send({ error: 'product_id (o sku_id valido) richiesto' });
    }
    if (min_discount_pct !== undefined && min_discount_pct !== null) {
      if (!Number.isFinite(min_discount_pct) || min_discount_pct < 0 || min_discount_pct > 100) {
        return reply.status(400).send({ error: 'min_discount_pct deve essere 0-100' });
      }
    }
    if (max_price !== undefined && max_price !== null) {
      if (!Number.isFinite(max_price) || max_price < 0 || max_price > 9999) {
        return reply.status(400).send({ error: 'max_price non valido' });
      }
    }
    if (notes && notes.length > 200) {
      return reply.status(400).send({ error: 'note troppo lunghe (max 200 char)' });
    }

    const listId = await getOrCreateDefaultList(profileId);

    // Pre-flight cap check so users see a friendly error instead of the
    // BEFORE-INSERT trigger's RAISE EXCEPTION text.
    const cnt = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM shopping_list_items WHERE list_id = $1',
      [listId],
    );
    if (parseInt(cnt.rows[0]?.count ?? '0', 10) >= SHOPPING_LIST_CAP) {
      return reply.status(400).send({ error: `Lista piena (max ${SHOPPING_LIST_CAP} prodotti)` });
    }

    try {
      const inserted = await query<{ id: number }>(
        `INSERT INTO shopping_list_items
           (list_id, product_id, min_discount_pct, max_price, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (list_id, product_id) DO UPDATE SET
           min_discount_pct = EXCLUDED.min_discount_pct,
           max_price        = EXCLUDED.max_price,
           notes            = EXCLUDED.notes
         RETURNING id`,
        [listId, product_id, min_discount_pct ?? null, max_price ?? null, notes ?? null],
      );
      return { ok: true, id: inserted.rows[0].id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('cap of 100')) {
        return reply.status(400).send({ error: `Lista piena (max ${SHOPPING_LIST_CAP} prodotti)` });
      }
      throw err;
    }
  },
);

app.patch<{ Params: { id: string }; Body: {
  min_discount_pct?: number | null;
  max_price?: number | null;
  notify_enabled?: boolean;
  notes?: string | null;
  category_override_id?: number | null;
  sort_order?: number;
} }>(
  '/api/shopping-list/items/:id',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return reply.status(401).send({ error: 'Auth required' });
    const itemId = parseInt(req.params.id, 10);
    if (isNaN(itemId)) return reply.status(400).send({ error: 'Invalid ID' });

    const { min_discount_pct, max_price, notify_enabled, notes,
            category_override_id, sort_order } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];
    if (min_discount_pct !== undefined) {
      if (min_discount_pct !== null && (!Number.isFinite(min_discount_pct) || min_discount_pct < 0 || min_discount_pct > 100)) {
        return reply.status(400).send({ error: 'min_discount_pct deve essere 0-100' });
      }
      params.push(min_discount_pct);
      updates.push(`min_discount_pct = $${params.length}`);
    }
    if (max_price !== undefined) {
      if (max_price !== null && (!Number.isFinite(max_price) || max_price < 0 || max_price > 9999)) {
        return reply.status(400).send({ error: 'max_price non valido' });
      }
      params.push(max_price);
      updates.push(`max_price = $${params.length}`);
    }
    if (notify_enabled !== undefined) {
      params.push(!!notify_enabled);
      updates.push(`notify_enabled = $${params.length}`);
    }
    if (notes !== undefined) {
      if (notes && notes.length > 200) return reply.status(400).send({ error: 'note troppo lunghe' });
      params.push(notes);
      updates.push(`notes = $${params.length}`);
    }
    if (category_override_id !== undefined) {
      if (category_override_id !== null) {
        if (!Number.isInteger(category_override_id) || category_override_id <= 0) {
          return reply.status(400).send({ error: 'category_override_id non valido' });
        }
        const valid = await query(
          'SELECT 1 FROM product_categories WHERE id = $1',
          [category_override_id],
        );
        if (valid.rowCount === 0) {
          return reply.status(400).send({ error: 'categoria sconosciuta' });
        }
      }
      params.push(category_override_id);
      updates.push(`category_override_id = $${params.length}`);
    }
    if (sort_order !== undefined) {
      if (!Number.isInteger(sort_order) || sort_order < 0 || sort_order > 99999) {
        return reply.status(400).send({ error: 'sort_order non valido (0-99999)' });
      }
      params.push(sort_order);
      updates.push(`sort_order = $${params.length}`);
    }
    if (updates.length === 0) return { ok: true, updated: 0 };

    params.push(itemId, profileId);
    const result = await query(
      `UPDATE shopping_list_items SET ${updates.join(', ')}
       WHERE id = $${params.length - 1}
         AND list_id IN (SELECT id FROM shopping_lists WHERE user_profile_id = $${params.length})`,
      params,
    );
    return { ok: true, updated: result.rowCount };
  },
);

app.delete<{ Params: { id: string } }>(
  '/api/shopping-list/items/:id',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return reply.status(401).send({ error: 'Auth required' });
    const itemId = parseInt(req.params.id, 10);
    if (isNaN(itemId)) return reply.status(400).send({ error: 'Invalid ID' });

    const result = await query(
      `DELETE FROM shopping_list_items
       WHERE id = $1
         AND list_id IN (SELECT id FROM shopping_lists WHERE user_profile_id = $2)`,
      [itemId, profileId],
    );
    return { ok: true, deleted: result.rowCount };
  },
);

// Static taxonomy list — cached on the client (rarely changes). Used by the
// shopping list UI to render group headers and the category-override picker.
app.get('/api/categories', async () => {
  const result = await query<{
    id: number; slug: string; name_it: string; emoji: string | null; sort_order: number;
  }>(`
    SELECT id, slug, name_it, emoji, sort_order
    FROM product_categories
    ORDER BY sort_order
  `);
  return { categories: result.rows };
});

// Atomic reorder of shopping list items. Accepts the new full order as an
// array of item ids; assigns sort_order = index * 10 to each (gaps allow
// future single-item moves without re-numbering everything). Restricted to
// items the user owns (subquery scope by user_profile_id).
app.post<{ Body: { order: number[] } }>(
  '/api/shopping-list/reorder',
  { preHandler: validateTelegramAuth },
  async (req, reply) => {
    const profileId = await resolveAuthedProfileId(req);
    if (!profileId) return reply.status(401).send({ error: 'Auth required' });
    const { order } = req.body || {};
    if (!Array.isArray(order) || order.length === 0) {
      return reply.status(400).send({ error: 'order deve essere un array non vuoto di id' });
    }
    if (order.length > 500) {
      return reply.status(400).send({ error: 'troppi item nel reorder (max 500)' });
    }
    if (!order.every(id => Number.isInteger(id) && id > 0)) {
      return reply.status(400).send({ error: 'order deve contenere solo id interi positivi' });
    }
    // Use unnest with WITH ORDINALITY to update each item in one statement
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE shopping_list_items sli
            SET sort_order = (pos.idx - 1) * 10
           FROM unnest($1::int[]) WITH ORDINALITY AS pos(item_id, idx)
          WHERE sli.id = pos.item_id
            AND sli.list_id IN (
              SELECT id FROM shopping_lists WHERE user_profile_id = $2
            )`,
        [order, profileId],
      );
      await client.query('COMMIT');
      return { ok: true, updated: updated.rowCount };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
);

// Search canonical products (used by the dedicated "aggiungi prodotto" UI).
// Returns canonical product_id + best current price across all chains so
// users see if it's actually in offer right now before adding to the list.
app.get<{ Querystring: { q: string; limit?: string } }>(
  '/api/products/search',
  async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 50);
    if (q.length < 2) return reply.status(400).send({ error: 'Query troppo corta', results: [] });

    const results = await query(`
      SELECT
        p.id,
        p.name,
        p.brand,
        p.category,
        p.slug,
        best.best_price,
        best.active_chain_count,
        best.best_chain_name,
        best.best_image_url
      FROM products p
      LEFT JOIN LATERAL (
        SELECT
          MIN(o.offer_price) AS best_price,
          (ARRAY_AGG(c.name ORDER BY o.offer_price ASC))[1] AS best_chain_name,
          (ARRAY_AGG(sk.image_url ORDER BY o.offer_price ASC) FILTER (WHERE sk.image_url IS NOT NULL))[1] AS best_image_url,
          COUNT(DISTINCT c.id)::int AS active_chain_count
        FROM offers o
        JOIN product_skus sk ON sk.id = o.sku_id
        JOIN chains c ON c.id = sk.chain_id
        WHERE sk.product_id = p.id
          AND o.valid_to >= CURRENT_DATE
          AND o.valid_from <= CURRENT_DATE
      ) best ON true
      WHERE p.name ILIKE '%' || $1 || '%'
         OR p.slug ILIKE '%' || $1 || '%'
         OR similarity(p.name, $1) > 0.3
      ORDER BY
        CASE WHEN p.name ILIKE $1 || '%' THEN 0 ELSE 1 END,
        similarity(p.name, $1) DESC,
        p.name ASC
      LIMIT $2
    `, [q, limit]);

    return { count: results.rows.length, results: results.rows };
  },
);

// --- Analytics event tracking ---

/** Hash an IP address with a static salt for anonymous uniqueness tracking. */
function hashIp(ip: string): string {
  const salt = process.env.SPESABOT_IP_SALT ?? 'spesify-default-salt';
  return createHash('sha256').update(ip + salt).digest('hex').slice(0, 16);
}

app.post<{ Body: {
  event_type: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
} }>(
  '/api/events',
  async (req) => {
    const { event_type, session_id, metadata } = req.body;
    if (!event_type || typeof event_type !== 'string' || event_type.length > 50) {
      return { ok: false };
    }
    // Anonymous sessions are OK (session_id only). But never trust a
    // client-provided telegram_user_id — attackers could forge it to attribute
    // events to other users. Only record it if HMAC-validated initData.
    tryValidateTelegramAuth(req); // anonymous OK — sets req.telegramUserId only on valid HMAC
    const authedUserId = req.telegramUserId ?? null;
    const ipHash = hashIp(req.ip);
    await query(
      `INSERT INTO api_events (event_type, session_id, telegram_user_id, metadata, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [event_type, session_id ?? null, authedUserId, JSON.stringify(metadata ?? {}), ipHash],
    );
    return { ok: true };
  },
);

// --- Operational health dashboard (owner only) ---
//
// One JSON view of "is the platform actually serving fresh data?"
// Answers the questions the security/operational audit flagged:
//   - which chains are stale (loaded but 0 active offers)
//   - which chains have low image coverage
//   - when did the last successful ingest fire (per chain)
//   - is the image registry growing
//
// Owner-gated via SPESABOT_OWNER_TG_ID, same pattern as /api/analytics/summary.
// Read-only; safe to poll from a status page or alerting cron.
app.get('/api/admin/health', async (req) => {
  const ownerId = process.env.SPESABOT_OWNER_TG_ID;
  tryValidateTelegramAuth(req);
  if (!ownerId || req.telegramUserId !== ownerId) {
    return { error: 'Forbidden' };
  }

  // Per-chain freshness + coverage. Joins offers→skus→chains so we get
  // active counts and image coverage in the same row, plus the latest
  // campaign timestamp so we can spot drift (e.g. a chain that hasn't
  // been ingested in 10 days even though its timer still fires).
  const chains = await query(`
    SELECT
      c.slug,
      COUNT(o.id)                                      AS active_offers,
      ROUND(100.0 * COUNT(*) FILTER (WHERE sk.image_url IS NOT NULL)
            / NULLIF(COUNT(o.id), 0), 1)               AS pct_image,
      MAX(fc.updated_at)                               AS last_campaign_update,
      COUNT(DISTINCT fc.id) FILTER (WHERE fc.scrape_status = 'loaded' AND fc.valid_to >= CURRENT_DATE)  AS loaded_active,
      COUNT(DISTINCT fc.id) FILTER (WHERE fc.scrape_status = 'failed' AND fc.updated_at > now() - interval '7 days') AS failed_recent_7d,
      COUNT(DISTINCT fc.id) FILTER (WHERE fc.scrape_status = 'empty'  AND fc.updated_at > now() - interval '7 days') AS empty_recent_7d
    FROM chains c
    LEFT JOIN flyer_campaigns fc ON fc.chain_id = c.id
    LEFT JOIN product_skus sk    ON sk.chain_id = c.id
    LEFT JOIN offers o           ON o.sku_id = sk.id AND o.valid_to >= CURRENT_DATE
    GROUP BY c.slug
    ORDER BY c.slug
  `);

  // Stale flag: a chain is "stale" if it has campaigns scrape_status='loaded'
  // but 0 active offers, OR if the most recent campaign update is >9 days old
  // (the cron runs Tue+Fri = max 4-day gap; flag at 9 to leave headroom).
  const chainStatus = chains.rows.map((r: any) => ({
    ...r,
    stale: (r.loaded_active > 0 && r.active_offers === 0) ||
           (r.last_campaign_update !== null &&
            (Date.now() - new Date(r.last_campaign_update).getTime()) > 9 * 86400000),
  }));

  // Image registry growth — supplements v_image_library_status added in
  // migration 019, gives the headline numbers in one place.
  const registry = await query(`
    SELECT
      COUNT(*)                                                     AS total_rows,
      COUNT(DISTINCT image_url)                                    AS unique_urls,
      COUNT(DISTINCT source_chain)                                 AS chains_contributing,
      COUNT(*) FILTER (WHERE first_seen > now() - interval '7 days')  AS new_last_7d,
      COUNT(*) FILTER (WHERE first_seen > now() - interval '30 days') AS new_last_30d
    FROM product_image_registry
  `);

  // Recent failed/empty campaigns — surface what the audit Opt-B fix
  // is actually catching. If empty_recent_7d > 0 for some chain, the
  // ingest correctly refused to wipe existing offers when the parser
  // returned 0 products. That's a feature, not a bug.
  const recentFailures = await query(`
    SELECT c.slug AS chain, fc.scrape_status, fc.valid_from, fc.valid_to,
           fc.updated_at::timestamptz AS updated_at
    FROM flyer_campaigns fc
    JOIN chains c ON c.id = fc.chain_id
    WHERE fc.scrape_status IN ('failed', 'empty')
      AND fc.updated_at > now() - interval '14 days'
    ORDER BY fc.updated_at DESC
    LIMIT 20
  `);

  // Service-level health from the pipeline-monitor state file (written every
  // 15 min by spesabot-monitor.timer). Decouples this endpoint from systemd:
  // even if the monitor is down, the staleness of monitor_observed_at makes
  // it obvious. Owner gets DM'd by the monitor on new failures regardless.
  const monitorRaw = await readMonitorState();
  const monitor = monitorRaw && typeof monitorRaw === 'object'
    ? (monitorRaw as { units?: Record<string, { observedAt?: string }> })
    : null;
  const services = monitor?.units
    ? Object.values(monitor.units)
    : [];
  const monitorObservedAt = services.length > 0
    ? services
        .map((s) => s.observedAt ?? '')
        .filter(Boolean)
        .sort()
        .pop() ?? null
    : null;
  const monitorStale = monitorObservedAt
    ? (Date.now() - new Date(monitorObservedAt).getTime()) > 60 * 60 * 1000
    : true;

  // Last run per run_type — gives the dashboard an at-a-glance "is each
  // moving part healthy?" without forcing a separate /api/admin/runs call.
  const lastByType = await query(`
    SELECT DISTINCT ON (run_type)
      run_type, status, started_at, finished_at, duration_sec, summary, likely_stuck
    FROM v_etl_runs_recent
    ORDER BY run_type, started_at DESC
  `);

  return {
    generated_at: new Date().toISOString(),
    chains: chainStatus,
    registry: registry.rows[0],
    recent_failed_or_empty: recentFailures.rows,
    services,
    monitor_observed_at: monitorObservedAt,
    monitor_stale: monitorStale,
    last_runs_by_type: lastByType.rows,
  };
});

// --- ETL run history (owner only) ---
//
// Detail view backing /api/admin/health's last_runs_by_type summary. Use
// query params to drill into a specific script: /api/admin/runs?run_type=
// matching-llm&limit=20. Defaults to the most recent 50 runs across all
// types so an unfiltered call gives a usable feed.
app.get<{ Querystring: { run_type?: string; chain?: string; limit?: string; status?: string } }>(
  '/api/admin/runs',
  async (req) => {
    const ownerId = process.env.SPESABOT_OWNER_TG_ID;
    tryValidateTelegramAuth(req);
    if (!ownerId || req.telegramUserId !== ownerId) {
      return { error: 'Forbidden' };
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.run_type) {
      params.push(req.query.run_type);
      filters.push(`run_type = $${params.length}`);
    }
    if (req.query.chain) {
      params.push(req.query.chain);
      filters.push(`chain = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      filters.push(`status = $${params.length}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit);

    const runs = await query(
      `SELECT id, run_type, chain, started_at, finished_at, status,
              duration_sec, summary, error_tail, likely_stuck, pid
         FROM v_etl_runs_recent
         ${where}
         LIMIT $${params.length}`,
      params,
    );

    return {
      generated_at: new Date().toISOString(),
      filters: { run_type: req.query.run_type ?? null, chain: req.query.chain ?? null, status: req.query.status ?? null },
      limit,
      count: runs.rows.length,
      runs: runs.rows,
    };
  },
);

// --- Analytics dashboard (owner only) ---
app.get<{ Querystring: { days?: string } }>(
  '/api/analytics/summary',
  async (req) => {
    const days = Math.min(parseInt(req.query.days ?? '7', 10), 90);
    const ownerId = process.env.SPESABOT_OWNER_TG_ID;

    // Gate: only the bot owner can see this (by telegram ID)
    tryValidateTelegramAuth(req);
    if (!ownerId || req.telegramUserId !== ownerId) {
      return { error: 'Forbidden' };
    }

    const byDay = await query(`
      SELECT day::text, event_type, events, unique_sessions, unique_users, unique_ips
      FROM analytics_summary
      WHERE day >= CURRENT_DATE - ($1::int - 1)
      ORDER BY day DESC, events DESC
    `, [days]);

    const totals = await query(`
      SELECT
        COUNT(*)::int as total_events,
        COUNT(DISTINCT session_id)::int as total_sessions,
        COUNT(DISTINCT telegram_user_id)::int as total_users,
        COUNT(DISTINCT ip_hash)::int as total_ips
      FROM api_events
      WHERE created_at >= CURRENT_DATE - ($1::int - 1)
    `, [days]);

    const topSearches = await query(`
      SELECT metadata->>'query' as query, COUNT(*)::int as count
      FROM api_events
      WHERE event_type = 'search' AND metadata ? 'query'
        AND created_at >= CURRENT_DATE - ($1::int - 1)
      GROUP BY metadata->>'query'
      ORDER BY count DESC LIMIT 10
    `, [days]);

    return {
      days,
      totals: totals.rows[0],
      by_day: byDay.rows,
      top_searches: topSearches.rows,
    };
  },
);

// --- Loyalty cards / programs ---
app.get('/api/loyalty', async () => {
  const results = await query(`
    SELECT c.slug, c.name, c.loyalty_card_name, c.loyalty_signup_url, c.loyalty_app_url,
      (SELECT COUNT(*)::int FROM offers o
       JOIN product_skus sk ON o.sku_id = sk.id
       WHERE sk.chain_id = c.id AND o.valid_to >= CURRENT_DATE AND o.requires_card = true
      ) as offerte_carta
    FROM chains c
    WHERE c.loyalty_card_name IS NOT NULL
    ORDER BY c.name
  `);
  return { count: results.rows.length, programs: results.rows };
});

// --- List chains ---
app.get('/api/chains', async () => {
  const results = await query(`
    SELECT
      c.slug,
      c.name,
      count(o.id) as offerte_attive
    FROM chains c
    LEFT JOIN product_skus sk ON sk.chain_id = c.id
    LEFT JOIN offers o ON o.sku_id = sk.id AND o.valid_to >= CURRENT_DATE
    GROUP BY c.slug, c.name
    ORDER BY offerte_attive DESC
  `);
  return { chains: results.rows };
});

// --- Start ---
app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`SpesaBot API running at ${address}`);
});
