/**
 * Shopfully publication ID discovery.
 *
 * Every Shopfully-hosted chain (MD, CRAI, DPIU, Esselunga…) rotates its
 * publication ID every time a new flyer goes live. The aggregator page at
 * https://www.doveconviene.it/volantino/{chain} embeds the current
 * publication ID in the HTML (as `shopfully.cloud/publication/it_it_{NNN}`).
 *
 * This module scrapes that page, extracts the current pub id, and verifies
 * it's reachable via the Shopfully API before returning it. The runner uses
 * it to avoid re-scraping a stale flyer — if the env-configured id no longer
 * matches what doveconviene is currently serving, the discovered one wins.
 */

const DISCOVERY_TIMEOUT_MS = 15_000;
const SHOPFULLY_API = 'https://shopfully-publication-api.global.ssl.fastly.net';

export interface DiscoveryResult {
  pubId: string;
  source: 'discovered' | 'env-fallback';
  discoveredFrom?: string; // URL we scraped
}

/**
 * Fetch https://www.doveconviene.it/volantino/{chain} (or
 * /{city}/volantino/{chain} if city is provided) and extract the Shopfully
 * publication id currently embedded in the page. Returns null if we can't
 * find or validate one — caller should fall back to env.
 *
 * Some retailers (e.g. Esselunga) only embed the viewer on city-specific
 * pages, not on the national directory page — for those, set
 * {SLUG}_SHOPFULLY_CITY env var to a city slug like "verona" or "milano"
 * where the chain has stores.
 */
export async function discoverShopfullyPubId(
  chainSlug: string,
  city?: string,
): Promise<string | null> {
  const path = city ? `${city}/volantino/${chainSlug}` : `volantino/${chainSlug}`;
  const url = `https://www.doveconviene.it/${path}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpesaBot/1.0)' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // The embedded viewer URL looks like:
    //   https://viewer.shopfully.cloud/publication/it_it_819138
    // Pick the numeric id out of it. If multiple are present (rare; e.g. a
    // chain showing a carousel of current + next week), prefer the first.
    const match = html.match(/shopfully\.cloud\/publication\/it_it_(\d{5,8})/);
    if (!match) return null;
    const candidate = match[1];

    // Sanity check: the Shopfully API should return a non-empty page 1 chunk
    // for this id. If not, the page was stale/invalid.
    const probe = await fetch(`${SHOPFULLY_API}/publication_pages/it_it/${candidate}/1?format=webp`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!probe.ok) return null;
    const body = await probe.json() as Record<string, unknown>;
    // Chunk /1 must contain at least one page descriptor.
    const hasPages = Object.keys(body).some((k) => /^\d+$/.test(k));
    if (!hasPages) return null;

    return candidate;
  } catch {
    return null;
  }
}

/**
 * Resolve the publication id for a Shopfully-hosted chain. Preference order:
 *
 *   1. discovered id (fresh, via doveconviene.it — national page first,
 *      then city-specific page if {SLUG}_SHOPFULLY_CITY is set)
 *   2. env fallback ({SLUG}_SHOPFULLY_PUBLICATION_ID)
 *   3. null → caller must skip the chain
 *
 * The `source` field on the returned object lets the runner log which
 * branch fired — "env-fallback" is the warning case (stale or discovery
 * broke), "discovered" is the healthy case.
 */
export async function resolveShopfullyPubId(
  chainSlug: string,
  envFallback?: string,
  city?: string,
): Promise<DiscoveryResult | null> {
  // Try national directory first; if the chain only embeds the viewer on
  // city pages (Esselunga), fall through to the city-specific path.
  let discovered = await discoverShopfullyPubId(chainSlug);
  let path = `volantino/${chainSlug}`;
  if (!discovered && city) {
    discovered = await discoverShopfullyPubId(chainSlug, city);
    path = `${city}/volantino/${chainSlug}`;
  }
  if (discovered) {
    return {
      pubId: discovered,
      source: 'discovered',
      discoveredFrom: `https://www.doveconviene.it/${path}`,
    };
  }
  if (envFallback) {
    return { pubId: envFallback, source: 'env-fallback' };
  }
  return null;
}

export interface MultiPubEntry {
  pubId: string;
  externalIds: string[];
}

/**
 * Convert a city name from the DB ("Verona", "San Bonifacio") into the slug
 * doveconviene uses in URLs ("verona", "san-bonifacio"). Lowercase, NFD-strip
 * accents, dash-separate words. Good enough for Italian city names.
 */
function citySlug(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Build a multi-publication config from live DB stores + doveconviene city
 * pages. For each distinct city in the chain's stores, probe
 * `/{city}/volantino/{chain}` to extract the current Shopfully pub id, then
 * cluster external_ids by pub id.
 *
 * Returns [] if no city resolved a pub id (caller falls back to single-pub
 * discovery or skip). Designed to replace the static `*_PUBLICATIONS` env
 * var so the config can't go stale week-over-week.
 */
export async function discoverShopfullyMultiPubForChain(
  chainSlug: string,
  fetchStores: (chainSlug: string) => Promise<Array<{ externalId: string; city: string }>>,
): Promise<MultiPubEntry[]> {
  const stores = await fetchStores(chainSlug);
  if (stores.length === 0) return [];

  const byCity = new Map<string, string[]>();
  for (const s of stores) {
    if (!s.externalId || !s.city) continue;
    const slug = citySlug(s.city);
    if (!byCity.has(slug)) byCity.set(slug, []);
    byCity.get(slug)!.push(s.externalId);
  }

  const cityToPub = new Map<string, string>();
  for (const city of byCity.keys()) {
    const pub = await discoverShopfullyPubId(chainSlug, city);
    if (pub) cityToPub.set(city, pub);
  }

  const byPub = new Map<string, string[]>();
  for (const [city, externalIds] of byCity) {
    const pub = cityToPub.get(city);
    if (!pub) continue;
    if (!byPub.has(pub)) byPub.set(pub, []);
    byPub.get(pub)!.push(...externalIds);
  }

  return Array.from(byPub).map(([pubId, externalIds]) => ({ pubId, externalIds }));
}
