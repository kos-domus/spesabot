/**
 * Famila per-store promotion discovery.
 *
 * Famila rotates the URL slug of each store's weekly flyer roughly every two
 * weeks (e.g. `superstore-grandi-marche-dal-23-aprile-al-6-maggio`). Hardcoding
 * the slug in stores.yaml causes silent breakage when the alias changes.
 *
 * This module spins up a Playwright browser, visits the store's landing page,
 * intercepts the maxidi `/promotions` API response (which carries the OAuth
 * bearer the SPA acquires automatically), and returns the URL(s) of active
 * product-bearing promotions for that store.
 *
 * IMPORTANT: any given store can have multiple concurrent active promotions
 * (e.g. "grandi-marche", "sottocosto", weekend-only, etc.). Picking only one
 * by name heuristic is fragile — a Selex-side reshuffle of the slug taxonomy
 * caused a silent 0-products run on Apr 24. We instead query each promo's
 * /groups endpoint and keep only those that actually have products today.
 */
import { chromium, type Browser } from 'playwright';

interface Promotion {
  code?: string;
  alias?: string;
  slug?: string;
  typeCode?: string;
  type?: string;
  name?: string;
  title?: string;
  validFrom?: string;
  validTo?: string;
  startDate?: string;
  endDate?: string;
}

const FAMILA_BASE = 'https://promo.famila.it/nord/punti-vendita';
const FAMILA_API = 'https://famila.maxidi.it/digitalflyer/api/maxidi/famila';
const PROMOTIONS_RE = /\/stores\/[^/]+\/promotions(\?|$)/;

export interface FamilaActivePromotion {
  alias: string;
  url: string;
  name: string | null;
  groupsCount: number;
}

/**
 * Aliases we never want to scrape: brand-sponsored boxes, news, recipes.
 * Sottocosto used to be excluded too — but it's a real weekly flyer with the
 * lowest prices, often with more products than "grandi-marche". Keep it in.
 */
function isSkippablePromo(alias: string): boolean {
  return /sponsor|^news|ricet/i.test(alias);
}

/**
 * Resolve all active product-bearing promotions for a Famila store.
 *
 * Visits the store landing page in Playwright to let the SPA bootstrap the
 * OAuth bearer + /promotions list, then calls /promotions/{alias}/groups for
 * each candidate to filter out empty promotions (an alias can exist without
 * any product groups assigned to a given store).
 */
export async function resolveFamilaActivePromotions(
  storeSlug: string,
  browser?: Browser,
): Promise<FamilaActivePromotion[]> {
  const ownsBrowser = !browser;
  const b = browser ?? await chromium.launch({ headless: true });
  try {
    const ctx = await b.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    let token: string | null = null;
    let promos: Promotion[] | null = null;

    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('/oauth/token') && resp.status() === 200) {
        try {
          const j = await resp.json() as { access_token?: string };
          if (j.access_token) token = j.access_token;
        } catch { /* not JSON */ }
      }
      if (PROMOTIONS_RE.test(url) && resp.status() === 200) {
        try {
          const body = await resp.json() as { content?: Promotion[] } | Promotion[];
          promos = Array.isArray(body) ? body : (body.content ?? []);
        } catch { /* not JSON */ }
      }
    });

    // domcontentloaded + short wait is enough for the SPA to fire the OAuth +
    // /promotions calls. Old code used networkidle with 30s timeout which
    // routinely failed because the SPA polls indefinitely.
    await page.goto(`${FAMILA_BASE}/${storeSlug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await ctx.close();

    if (!promos || !token) return [];

    const candidates = (promos as Promotion[]).filter((p) => {
      const alias = (p.alias || p.slug || '').toLowerCase();
      return !!alias && !isSkippablePromo(alias);
    });

    const checked = await Promise.all(candidates.map(async (p) => {
      const alias = (p.alias || p.slug)!;
      try {
        const r = await fetch(`${FAMILA_API}/promotions/${alias}/groups`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return null;
        const groups = await r.json() as unknown[];
        const groupsCount = Array.isArray(groups) ? groups.length : 0;
        if (groupsCount === 0) return null;
        return {
          alias,
          url: `${FAMILA_BASE}/${storeSlug}/promozioni/${alias}`,
          name: p.name ?? p.title ?? null,
          groupsCount,
        };
      } catch {
        return null;
      }
    }));

    return checked.filter((x): x is FamilaActivePromotion => x !== null);
  } finally {
    if (ownsBrowser) await b.close();
  }
}

/**
 * Backwards-compatible single-URL wrapper. Returns the first active promo URL
 * or null. Prefer resolveFamilaActivePromotions() — picking a single promo
 * means missing the parallel ones (sottocosto next to grandi-marche etc).
 */
export async function resolveFamilaPromotionUrl(
  storeSlug: string,
  browser?: Browser,
): Promise<string | null> {
  const promos = await resolveFamilaActivePromotions(storeSlug, browser);
  return promos[0]?.url ?? null;
}
