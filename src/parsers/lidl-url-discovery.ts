/**
 * Lidl URL auto-discovery — finds the current week's offer URLs.
 *
 * Lidl publishes weekly offers under URLs like:
 *   https://www.lidl.it/c/super-offerte-kw-{week}-{year}/a{id}
 *   https://www.lidl.it/c/mega-offerte-kw-{week}-{year}/a{id}
 *
 * The IDs change every week. This script navigates lidl.it homepage
 * and extracts the current week's offer page URLs from the navigation.
 *
 * Usage: npx tsx scripts/discover-lidl.ts
 * Output: writes the discovered URLs to stores.yaml under lidl.current_urls
 */

import { chromium } from 'playwright';

export interface LidlOfferUrl {
  type: string; // category slug extracted from URL (e.g. 'super-offerte', 'carne-e-pesce')
  url: string;
  text: string;
}

export async function discoverLidlOfferUrls(): Promise<LidlOfferUrl[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    await page.goto('https://www.lidl.it', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Accept cookies if the banner is present (content behind it may not render otherwise)
    try { await page.click('button:has-text("Accetta")', { timeout: 3000 }); } catch { /* ignore */ }
    await page.waitForTimeout(1500);

    // Scroll to trigger lazy-loaded navigation tiles
    await page.evaluate(async () => {
      const h = document.body.scrollHeight;
      for (let y = 0; y < h; y += 800) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Lidl organizes weekly offers into ~14 category pages under /c/{slug}-kw-{week}-{year}/a{id}
    // Match ANY weekly category, not just super/mega.
    const links = await page.evaluate(() => {
      const out = new Set<string>();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = (a.getAttribute('href') || '').trim();
        if (/^\/c\/[a-z0-9-]+-kw-\d+-\d+\/a\d+/i.test(href)) {
          out.add(href);
        }
      }
      return [...out];
    });

    // Dedupe by category slug — Lidl sometimes lists two IDs for the same category
    // (e.g. livarno-casa-e-arredo a10092104 AND a10092118, where the second is empty).
    // Keep the FIRST occurrence per slug; the homepage nav puts the canonical one first.
    const bySlug = new Map<string, LidlOfferUrl>();
    for (const href of links) {
      const fullUrl = href.startsWith('http') ? href : `https://www.lidl.it${href}`;
      const slugMatch = href.match(/^\/c\/(.+?)-kw-\d+-\d+\//i);
      const type = slugMatch ? slugMatch[1] : 'other';
      if (!bySlug.has(type)) {
        bySlug.set(type, { type, url: fullUrl, text: type });
      }
    }

    return [...bySlug.values()];
  } finally {
    await browser.close();
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  discoverLidlOfferUrls()
    .then(urls => {
      console.log(`Found ${urls.length} Lidl offer URLs:`);
      urls.forEach(u => console.log(`  [${u.type}] ${u.url}`));
      console.log('');
      console.log('Add these to configs/stores.yaml under lidl.current_urls:');
      urls.forEach(u => console.log(`  - ${u.url}`));
    })
    .catch(err => {
      console.error('Discovery failed:', err.message);
      process.exit(1);
    });
}
