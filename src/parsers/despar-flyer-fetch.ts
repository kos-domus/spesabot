/**
 * Despar iPaper flyer text extraction.
 *
 * The Despar digital flyer is hosted on volantino.despar.it as an iPaper-based
 * interactive flipbook. Products are rendered as text overlays on page images.
 * To extract all products we need to:
 *   1. Open the flyer URL in Playwright
 *   2. Navigate through all page spreads (clicking "Pagina successiva")
 *   3. Extract the visible text from each spread
 *
 * The flyer URL follows this pattern:
 *   https://volantino.despar.it/leaflet-{brand}/{year}-os{week}-{brand_code}-{region}/
 *
 * The current URL is discovered by visiting a Verona-area Eurospar store page
 * and capturing the `volantino.despar.it` request from the page load.
 */

import { chromium } from 'playwright';

export interface DesparFlyerResult {
  text: string;
  flyerUrl: string;
  pageCount: number;
}

/**
 * Discover the current flyer URL by visiting a Verona Eurospar store page
 * and intercepting the iPaper request.
 */
export async function discoverDesparFlyerUrl(): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    let flyerUrl: string | null = null;
    page.on('request', req => {
      const u = req.url();
      if (/volantino\.despar\.it\/leaflet-/.test(u) && !u.includes('.asmx')) {
        flyerUrl = u;
      }
    });
    // Use Eurospar Verona (id=133) as anchor — it always links to the Veneto flyer
    await page.goto('https://www.despar.it/it/punto-vendita-eurospar/133/verona/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    if (!flyerUrl) throw new Error('No volantino.despar.it URL captured');
    return flyerUrl;
  } finally {
    await browser.close();
  }
}

/**
 * Navigate the iPaper flyer and extract text from all page spreads.
 */
export async function fetchDesparFlyerText(flyerUrl: string): Promise<DesparFlyerResult> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    await page.goto(flyerUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

    let allText = '';
    let prevLines = new Set<string>();
    let spreadCount = 0;
    const MAX_SPREADS = parseInt(process.env.SPESABOT_DESPAR_MAX_SPREADS ?? '25', 10);

    for (let s = 0; s < MAX_SPREADS; s++) {
      const txt = await page.evaluate(() => document.body.innerText);
      // Only capture lines not seen on the immediately previous spread.
      // Use a Set for O(1) lookup instead of string.includes() which is O(n*m).
      const currentLines = txt.split('\n').map(l => l.trim()).filter(Boolean);
      const newLines = currentLines.filter(l => !prevLines.has(l));
      const newText = newLines.join('\n');
      if (newText.length > 20) {
        allText += '\n' + newText;
        spreadCount++;
      }
      prevLines = new Set(currentLines);

      // Navigate to next spread
      try {
        await page.click('[aria-label="Pagina successiva"]');
        await page.waitForTimeout(2500);
      } catch {
        break; // no more pages
      }
    }

    return {
      text: allText.trim(),
      flyerUrl,
      pageCount: spreadCount,
    };
  } finally {
    await browser.close();
  }
}
