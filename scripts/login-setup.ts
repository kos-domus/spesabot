#!/usr/bin/env node
/**
 * SpesaBot Login Setup — Interactive browser for logging into supermarket sites.
 *
 * Opens a visible Chromium browser with a persistent profile.
 * You log in manually, then the session is saved for the automated pipeline.
 *
 * Usage:
 *   npx tsx scripts/login-setup.ts [site]
 *
 * Sites: conad, despar, aldi, all
 *
 * The browser profile is saved to ~/.spesabot/browser-profile/
 * The weekly pipeline reuses this profile for authenticated scraping.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.SPESABOT_BROWSER_PROFILE
  ?? join(process.env.HOME ?? '/home/kos', '.spesabot', 'browser-profile');

const SITES: Record<string, { url: string; name: string; instructions: string }> = {
  conad: {
    url: 'https://www.conad.it/ricerca-negozi',
    name: 'Conad',
    instructions: `
    1. Click "Accedi" or "Registrati"
    2. Log in with spesabot email
    3. Set your preferred store (Verona area)
    4. Navigate to your store's flyer/offers page
    5. When done, close the browser window
    `,
  },
  despar: {
    url: 'https://www.despar.it',
    name: 'Despar',
    instructions: `
    1. Click on "Offerte per te" or login
    2. Log in with spesabot email
    3. Set your store (Verona area)
    4. Check that offers are visible
    5. When done, close the browser window
    `,
  },
  aldi: {
    url: 'https://www.aldi.it/it/offerte-settimanali/offerte-di-questa-settimana.html',
    name: 'Aldi',
    instructions: `
    1. Accept cookies if prompted
    2. Check if offers are visible without login
    3. If login needed, register/login with spesabot email
    4. When done, close the browser window
    `,
  },
};

async function main() {
  const site = process.argv[2] ?? 'all';

  mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`Browser profile will be saved to: ${PROFILE_DIR}`);
  console.log('');

  const sitesToVisit = site === 'all'
    ? Object.entries(SITES)
    : SITES[site]
      ? [[site, SITES[site]] as const]
      : (console.error(`Unknown site: ${site}. Use: conad, despar, aldi, all`), process.exit(1), []);

  for (const [slug, config] of sitesToVisit) {
    console.log(`\n=== ${config.name} ===`);
    console.log(`URL: ${config.url}`);
    console.log(`Instructions: ${config.instructions}`);
    console.log('Opening browser... (close the window when done)');
    console.log('');

    // Launch visible browser with persistent profile
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox'],
    });

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for user to close the browser
    await new Promise<void>((resolve) => {
      context.on('close', () => resolve());
    });

    console.log(`${config.name}: Session saved to profile.`);
  }

  console.log('\n=== All done! ===');
  console.log(`Profile saved at: ${PROFILE_DIR}`);
  console.log('The weekly pipeline will reuse these sessions.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
