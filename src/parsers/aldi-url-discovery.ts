/**
 * Aldi URL auto-discovery — finds the current week's offer URLs.
 *
 * Aldi's website splits offers across multiple pages:
 *   - /it/offerte-settimanali/offerte-di-questa-settimana.html
 *       → "Prezzi bassi ogni giorno", "Offerte freschezza", "Offerte settimana", "Weekend"
 *       → ~95 food products (but MISSING "Occasioni Lampo XXL" and "Occasioni Lampo")
 *   - /it/offerte-settimanali/d.DD-MM-YYYY.html (Monday date)
 *       → All Monday-start offers including "Occasioni Lampo XXL" (~70 food products)
 *   - /it/offerte-settimanali/d.DD-MM-YYYY.html (Thursday date)
 *       → Thursday non-food specials: appliances, garden, clothing (~30 products)
 *
 * The main offers page is missing ~30-40 XXL products that only appear on
 * the date-specific pages. This module computes the correct date URLs
 * for the current week so the scraper fetches everything.
 *
 * Usage: npx tsx src/parsers/aldi-url-discovery.ts
 */

const BASE = 'https://www.aldi.it/it/offerte-settimanali';

export interface AldiOfferUrl {
  type: 'main' | 'monday' | 'thursday';
  url: string;
  label: string;
}

/** Pad day/month to 2 digits. */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Get the Monday of the current (or given) week.
 * Aldi's weekly cycle runs Monday → Sunday.
 */
function getCurrentMonday(now = new Date()): Date {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Build the date-specific URL: /d.DD-MM-YYYY.html
 */
function dateUrl(d: Date): string {
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  return `${BASE}/d.${dd}-${mm}-${yyyy}.html`;
}

/**
 * Discover the Aldi offer URLs for the current week.
 * Returns the main page plus Monday and Thursday date-specific pages.
 *
 * Monday page: food + Occasioni Lampo XXL (~70 products)
 * Thursday page: non-food weekly specials — appliances, garden, clothing (~30 products)
 * Both are time-limited deals worth tracking.
 */
export function discoverAldiOfferUrls(now = new Date()): AldiOfferUrl[] {
  const monday = getCurrentMonday(now);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);

  return [
    {
      type: 'main',
      url: `${BASE}/offerte-di-questa-settimana.html`,
      label: 'Prezzi bassi + Offerte settimana + Weekend',
    },
    {
      type: 'monday',
      url: dateUrl(monday),
      label: `Occasioni Lampo da lunedì ${pad2(monday.getDate())}.${pad2(monday.getMonth() + 1)}`,
    },
    {
      type: 'thursday',
      url: dateUrl(thursday),
      label: `Offerte da giovedì ${pad2(thursday.getDate())}.${pad2(thursday.getMonth() + 1)}`,
    },
  ];
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const urls = discoverAldiOfferUrls();
  console.log(`Aldi offer URLs for this week:`);
  urls.forEach(u => console.log(`  [${u.type}] ${u.url} — ${u.label}`));
}
