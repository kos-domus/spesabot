/**
 * Conad Carta Insieme — automated web registration.
 *
 * Conad is the only chain with a full web registration form.
 * Requires a physical card number (13 digits) obtained at a Conad store.
 * After that, the online activation collects personal details + password.
 *
 * Flow:
 *   1. User gets physical card at Conad store
 *   2. This script fills the online activation form at my.conad.it/registrazione
 *   3. User may need to solve reCAPTCHA manually (v3 invisible — often passes silently
 *      when using a persistent browser profile with browsing history)
 *   4. Email confirmation link is sent — can be auto-clicked via Gmail API
 */

import { chromium, type BrowserContext } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use a fresh temporary profile each time to avoid leaking session data
// (cookies, localStorage, cached credentials) between different users.
// If SPESABOT_BROWSER_PROFILE is explicitly set, respect it (for debugging only).
function createTempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'spesabot-conad-'));
}

const BROWSER_PROFILE = process.env.SPESABOT_BROWSER_PROFILE ?? null;

export interface ConadSignupData {
  cardNumber: string;    // 13-digit Conad card number
  nome: string;
  cognome: string;
  email: string;
  password: string;
  dataNascita: string;   // DD/MM/YYYY
}

export interface SignupResult {
  success: boolean;
  step: string;           // last step completed
  needsManualAction?: string; // what the user needs to do
  error?: string;
}

export async function registerConadCard(data: ConadSignupData): Promise<SignupResult> {
  // Use a fresh temp profile each invocation to prevent session leakage between users.
  // Only reuse a persistent profile if explicitly configured (debugging only).
  const profileDir = BROWSER_PROFILE ?? createTempProfile();

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false, // visible so user can solve CAPTCHA if needed
      viewport: { width: 1280, height: 1024 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch {
    // Fallback to headless if persistent context is locked
    const browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
  }

  try {
    const page = await context.newPage();
    await page.goto('https://my.conad.it/registrazione', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Accept cookies
    try { await page.click('#onetrust-accept-btn-handler', { timeout: 3000 }); } catch { /* ok */ }
    await page.waitForTimeout(1000);

    // Step 1: Enter card number
    await page.fill('input[name="codiceCarta"]', data.cardNumber);
    await page.waitForTimeout(500);

    // Step 2: Fill personal details
    // The form has duplicate field names (two views). Target the visible ones.
    const nameFields = await page.$$('input[name="nome"]:visible');
    if (nameFields.length > 0) await nameFields[0].fill(data.nome);
    const surnameFields = await page.$$('input[name="cognome"]:visible');
    if (surnameFields.length > 0) await surnameFields[0].fill(data.cognome);

    await page.fill('input[name="dataNascita"]', data.dataNascita);

    // Step 3: Email + password
    const emailFields = await page.$$('input[name="email"]:visible');
    if (emailFields.length > 0) await emailFields[0].fill(data.email);
    const emailConfirmFields = await page.$$('input[name="emailConfirm"]:visible');
    if (emailConfirmFields.length > 0) await emailConfirmFields[0].fill(data.email);

    const pwFields = await page.$$('input[name="password"]:visible');
    if (pwFields.length > 0) await pwFields[0].fill(data.password);
    const pwConfirmFields = await page.$$('input[name="passwordRepeat"]:visible');
    if (pwConfirmFields.length > 0) await pwConfirmFields[0].fill(data.password);

    // Step 4: Privacy consents (required)
    // privacy1-3 + privacyTZ: click the "Sì" radio for privacy1 (mandatory),
    // "No" for the optional marketing ones
    try {
      await page.click('input[name="privacy1"][value="true"]');
      await page.click('input[name="privacy2"][value="false"]');
      await page.click('input[name="privacy3"][value="false"]');
      await page.click('input[name="privacyTZ"][value="false"]');
    } catch { /* some may not exist */ }

    await page.waitForTimeout(1000);

    // Step 5: Submit — reCAPTCHA v3 fires on submission
    // If the browser profile has enough history, it usually passes silently.
    const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Registrati")');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(5000);

      // Check if we landed on a success/confirmation page
      const url = page.url();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      if (/conferma|verifica|email.*inviata|registrazione.*completata/i.test(text)) {
        return {
          success: true,
          step: 'submitted',
          needsManualAction: 'Controlla la tua email per il link di conferma',
        };
      }
      if (/captcha|verifica.*robot|errore/i.test(text)) {
        return {
          success: false,
          step: 'captcha_blocked',
          needsManualAction: 'Il reCAPTCHA ha bloccato la registrazione. Riprova dal browser.',
          error: 'reCAPTCHA challenge triggered',
        };
      }
    }

    return {
      success: false,
      step: 'form_filled',
      needsManualAction: 'Il form è stato compilato. Verifica i dati e clicca "Registrati" manualmente.',
    };
  } catch (err) {
    return {
      success: false,
      step: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close();
  }
}
