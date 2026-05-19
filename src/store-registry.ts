/**
 * Store Registry — loads stores.yaml and provides per-chain scrape targets.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REGISTRY_PATH = process.env.SPESABOT_STORES_CONFIG
  ?? join(import.meta.dirname, '..', 'configs', 'stores.yaml');

export type ChainStrategy = 'url-list' | 'national' | 'aggregator' | 'pdf' | 'api';

export interface StoreEntry {
  name: string;
  slug: string;
  city: string;
  url: string;
}

export interface ChainConfig {
  chain: string;
  strategy: ChainStrategy;
  source_type: string;
  notes?: string;
  parser?: string;
  // For url-list chains
  stores?: StoreEntry[];
  // For aggregator/national chains
  url?: string;
  current_urls?: string[];
  discovery?: {
    homepage: string;
    link_pattern: string;
  };
  // For pdf chains
  pdf_url?: string;
}

export interface ScrapeTarget {
  url: string;
  storeName?: string;
  storeSlug?: string;
  validFrom?: string;  // ISO date from chain's API (e.g. Eurospin monthly flyer)
  validTo?: string;
}

let cachedRegistry: Record<string, ChainConfig> | null = null;

export function loadRegistry(): Record<string, ChainConfig> {
  if (cachedRegistry) return cachedRegistry;
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`Store registry not found: ${REGISTRY_PATH}`);
  }
  const raw = readFileSync(REGISTRY_PATH, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, ChainConfig>;
  // Inject chain name into each entry
  for (const [chain, config] of Object.entries(parsed)) {
    config.chain = chain;
  }
  cachedRegistry = parsed;
  return parsed;
}

export function getChainConfig(chain: string): ChainConfig | null {
  const registry = loadRegistry();
  return registry[chain] ?? null;
}

/**
 * Resolve a chain into a list of scrape targets.
 * Each target represents one URL to scrape (with optional store metadata).
 *
 * Async because some chains need URL discovery (e.g. Lidl whose URLs change weekly).
 */
export async function getScrapeTargets(chain: string): Promise<ScrapeTarget[]> {
  const config = getChainConfig(chain);
  if (!config) return [];

  switch (config.strategy) {
    case 'url-list': {
      const stores = config.stores ?? [];
      return stores.map(s => ({
        url: s.url,
        storeName: s.name,
        storeSlug: s.slug,
      }));
    }

    case 'pdf': {
      // Eurospin publishes a new PDF each month with a rotating UUID.
      // Use the auto-discovery module to resolve the current URL via the public API.
      if (chain === 'eurospin') {
        try {
          const { discoverEurospinFlyerPdf } = await import('./parsers/eurospin-url-discovery.js');
          const info = await discoverEurospinFlyerPdf();
          console.log(`[eurospin] auto-discovered flyer: ${info.promotionName} (${info.startDate} → ${info.endDate})`);
          return [{ url: info.pdfUrl, validFrom: info.startDate, validTo: info.endDate }];
        } catch (err) {
          console.error(`[eurospin] PDF discovery failed: ${err instanceof Error ? err.message : err}`);
          // Fall through to static pdf_url if available
        }
      }
      if (config.pdf_url) {
        return [{ url: config.pdf_url }];
      }
      return [];
    }

    case 'aggregator':
    case 'national': {
      // Special case: Aldi splits offers across main page + date-specific pages
      if (chain === 'aldi') {
        try {
          const { discoverAldiOfferUrls } = await import('./parsers/aldi-url-discovery.js');
          const discovered = discoverAldiOfferUrls();
          console.log(`[aldi] discovered ${discovered.length} offer URLs: ${discovered.map(d => d.type).join(', ')}`);
          return discovered.map(d => ({ url: d.url }));
        } catch (err) {
          console.error(`[aldi] URL discovery failed: ${err instanceof Error ? err.message : err}`);
          // Fall through to static url
        }
      }
      // Special case: Lidl needs weekly URL discovery
      if (chain === 'lidl' && config.discovery) {
        try {
          const { discoverLidlOfferUrls } = await import('./parsers/lidl-url-discovery.js');
          const discovered = await discoverLidlOfferUrls();
          if (discovered.length > 0) {
            console.log(`[lidl] auto-discovered ${discovered.length} weekly offer URL(s)`);
            return discovered.map(d => ({ url: d.url }));
          }
        } catch (err) {
          console.error(`[lidl] URL discovery failed: ${err instanceof Error ? err.message : err}`);
          // Fall through to current_urls fallback
        }
      }
      // Single URL or current_urls list (fallback for Lidl, primary for others)
      if (config.current_urls?.length) {
        return config.current_urls.map(url => ({ url }));
      }
      if (config.url) {
        return [{ url: config.url }];
      }
      return [];
    }

    default:
      return [];
  }
}

/**
 * Ordering the chains so the lightweight ones run first. The mini-PC host has
 * a 2-3GB memory cap on the pipeline service; if the browser-heavy chains
 * (famila, conad-flyer) run before the API/HTML-based ones and OOM-kill the
 * process, every chain after them loses its ingest for that cycle. Observed
 * this exact scenario on Apr 21 2026 — despar/aldi/rossetto/pam went stale for
 * a full week because famila crashed the run early.
 *
 * Order (cheapest → most expensive):
 *   1. API-based          (migross, conad) — single HTTP fetch
 *   2. PDF / flat HTML    (eurospin, aldi, lidl, rossetto, despar, pam, martinelli)
 *   3. Shopfully vision   (md, crai, dpiu, esselunga) — Gemini calls
 *   4. Per-store browser  (famila, conad-flyer) — Playwright, RAM-heavy
 */
const CHAIN_COST_RANK: Record<string, number> = {
  migross: 1, conad: 1,
  eurospin: 2, aldi: 2, lidl: 2, rossetto: 2, despar: 2, pam: 2, martinelli: 2,
  md: 3, crai: 3, dpiu: 3, esselunga: 3,
  famila: 4, 'conad-flyer': 4,
  // Gruppo Poli banners — rank 0 so they surface at the top of the list (the
  // runner skips them immediately via parser: unimplemented, so having them
  // first adds no wall-clock cost and keeps the "these exist but aren't
  // scraped yet" signal visible in the run log).
  poli: 0, orvea: 0, regina: 0, amort: 0,
};

export function listChains(): string[] {
  const registry = loadRegistry();
  const slugs = Object.keys(registry);
  return slugs.sort((a, b) => {
    const ra = CHAIN_COST_RANK[a] ?? 5;
    const rb = CHAIN_COST_RANK[b] ?? 5;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}
