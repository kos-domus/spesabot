/**
 * Famila product fetcher — clicks through paginated promo pages.
 *
 * Famila's promo pages (promo.famila.it) are JavaScript SPAs that show
 * ~18 products at a time behind a "Prodotti successivi" pagination button.
 * A typical store has 400-600 products on offer. The generic Playwright
 * scroll-based fetcher only captures the first visible batch (~18).
 *
 * This fetcher:
 *   1. Opens the store's promo URL in Playwright
 *   2. Dismisses the cookie consent banner
 *   3. Clicks "Prodotti successivi" until all products are loaded
 *   4. Extracts the full page text with all product cards visible
 *
 * Usage from runner.ts — replaces the deep-research pipeline for Famila.
 */

import { chromium, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BROWSER_PROFILE_DIR = process.env.SPESABOT_BROWSER_PROFILE
  ?? join(process.env.HOME ?? '/home/kos', '.spesabot', 'browser-profile');

export interface FamilaFetchResult {
  text: string;
  url: string;
  totalProducts: number;
  pagesLoaded: number;
  /** Map of product code → image URL, captured from network requests during pagination */
  productImages: Map<string, string>;
}

/**
 * Fetch all products from a Famila promo page by clicking through pagination.
 */
export async function fetchFamilaProducts(url: string): Promise<FamilaFetchResult> {
  // Use persistent profile if available (for authenticated sessions)
  const hasProfile = existsSync(BROWSER_PROFILE_DIR);

  let context: BrowserContext;
  let browser: import('playwright').Browser | null = null;

  if (hasProfile) {
    context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: true,
      viewport: { width: 1280, height: 1024 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } else {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 1024 },
    });
  }

  try {
    const page = await context.newPage();

    // Block heavy non-essential resources
    await page.route('**/*.{woff,woff2,ttf,eot,mp4,webm}', route => route.abort());
    await page.route('**/analytics**', route => route.abort());
    await page.route('**/tracking**', route => route.abort());

    // Intercept product image URLs from network requests during pagination.
    // Pattern: maxidi.it/digitalflyer/files/{UUID}/{CODE}@1.jpg
    // This catches lazy-loaded images that only load when scrolled into view.
    const productImages = new Map<string, string>();
    page.on('request', req => {
      const reqUrl = req.url();
      // Match product images: {digits}@{digit}.jpg or {digits}@{digit}-{digit}.jpg
      const m = reqUrl.match(/maxidi\.it\/digitalflyer\/files\/[^/]+\/(\d+)@\d+(?:-\d+)?\.jpg/);
      if (m) {
        productImages.set(m[1], reqUrl);
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie banner — Famila uses various consent libraries
    for (const selector of [
      'button:has-text("Accetta tutti")',
      'button:has-text("Accetta tutto")',
      'button:has-text("Accetta")',
      '#onetrust-accept-btn-handler',
      '[id*="cookie-accept" i]',
    ]) {
      try {
        await page.click(selector, { timeout: 1500 });
        await page.waitForTimeout(800);
        break;
      } catch { /* try next */ }
    }

    // Wait for initial product grid to render
    await page.waitForTimeout(2000);

    // Click "Prodotti successivi" until we've loaded all products.
    // The button text is "Prodotti successivi" and the page shows
    // "Stai visualizzando X prodotti di Y" as a progress indicator.
    const MAX_CLICKS = 60; // safety cap: 60 pages * ~18 products = ~1080 max
    let pagesLoaded = 1;

    for (let i = 0; i < MAX_CLICKS; i++) {
      // Try to find and click the "next" button
      const clicked = await page.evaluate(() => {
        // Look for the pagination button — it could be a button or link
        const candidates = [
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('a'),
          ...document.querySelectorAll('[role="button"]'),
        ];
        for (const el of candidates) {
          const text = el.textContent?.trim() ?? '';
          if (/prodotti\s+success/i.test(text) || /mostra\s+(altri|più)/i.test(text) || /load\s+more/i.test(text)) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (!clicked) {
        // No more pagination button — all products loaded
        break;
      }

      pagesLoaded++;
      // Wait for new products to render, then scroll to bottom to trigger
      // lazy-loading of product images for the newly loaded batch
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);

      // Log progress periodically
      if (pagesLoaded % 5 === 0) {
        const progress = await page.evaluate(() => {
          const text = document.body.innerText;
          const match = text.match(/(\d+)\s*prodott\w*\s*di\s*(\d+)/i);
          return match ? `${match[1]}/${match[2]}` : '?/?';
        });
        console.log(`  [famila] page ${pagesLoaded}: ${progress} products loaded`);
      }
    }

    // Give final batch a moment to render
    await page.waitForTimeout(1000);

    // Extract the full page text now that all products are visible.
    // Pass the extraction logic as a string to page.evaluate to avoid tsx
    // __name decorator leaking into the browser evaluate context.
    const extractionScript = [
      '(() => {',
      '  var remove = document.querySelectorAll("script, style, nav, footer, iframe, noscript, svg");',
      '  remove.forEach(function(el) { el.remove(); });',
      '  var main = document.querySelector("main, [role=main], .content, #content");',
      '  var root = main || document.body;',
      '  var toText = function(node) {',
      '    if (node.nodeType === 3) return (node.textContent || "").trim();',
      '    if (node.nodeType !== 1) return "";',
      '    var el = node;',
      '    var tag = el.tagName.toLowerCase();',
      '    var style = window.getComputedStyle(el);',
      '    if (style.display === "none" || style.visibility === "hidden") return "";',
      '    var children = Array.from(el.childNodes).map(toText).filter(Boolean).join(" ");',
      '    if (tag === "h3") return "\\n### " + children + "\\n";',
      '    if (tag === "a") {',
      '      var href = el.getAttribute("href") || "";',
      '      // Extract product image URL from <img> inside the link',
      '      var img = el.querySelector("img");',
      '      var imgSrc = "";',
      '      if (img) {',
      '        var src = img.src || img.getAttribute("data-src") || "";',
      '        if (src && src.indexOf("maxidi.it") !== -1 && src.indexOf("preview-loading") === -1) {',
      '          imgSrc = "![img](" + src + ")";',
      '        }',
      '      }',
      '      return href ? imgSrc + "[" + children + "](" + href + ")" : children;',
      '    }',
      '    if (tag === "strong" || tag === "b") return "**" + children + "**";',
      '    if (tag === "br") return "\\n";',
      '    return children;',
      '  };',
      '  return toText(root);',
      '})()',
    ].join('\n');
    const rawText = await page.evaluate(extractionScript);
    const text = String(rawText);

    const cleaned = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

    // Count total products from the progress indicator or product codes
    const totalMatch = cleaned.match(/(\d+)\s*prodott\w*\s*di\s*(\d+)/i);
    const totalProducts = totalMatch ? parseInt(totalMatch[2], 10) : 0;

    console.log(`  [famila] captured ${productImages.size} product image URLs from network`);

    if (hasProfile) {
      await page.close(); // keep persistent context alive
    } else {
      await context.close();
    }

    return {
      text: cleaned,
      url,
      totalProducts,
      pagesLoaded,
      productImages,
    };
  } finally {
    if (browser) await browser.close();
  }
}

// CLI entry point for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const testUrl = process.argv[2] ?? 'https://promo.famila.it/nord/punti-vendita/famila-superstore-san-martino-buon-albergo/promozioni/store-grandi-marche-a-piccoli-prezzi';
  console.log(`Fetching: ${testUrl}`);
  fetchFamilaProducts(testUrl)
    .then(result => {
      console.log(`Done: ${result.pagesLoaded} pages, ${result.totalProducts} total products`);
      console.log(`Text length: ${result.text.length} chars`);
      // Show first 500 chars
      console.log(`\nFirst 500 chars:\n${result.text.slice(0, 500)}`);
    })
    .catch(err => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}
