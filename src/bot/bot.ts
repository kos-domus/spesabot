#!/usr/bin/env node
import { Bot, InlineKeyboard } from 'grammy';
import { query } from '../db.js';
import { registerConadCard } from '../loyalty/conad-signup.js';
import { encryptProfile, decryptProfile, encryptValue } from '../crypto.js';

const BOT_TOKEN = process.env.SPESABOT_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('SPESABOT_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Mini App URL (served via named Cloudflare Tunnel → Fastify)
const WEBAPP_URL = process.env.SPESABOT_WEBAPP_URL || 'https://app.spesify.xyz/webapp/index.html';

/**
 * Load the user's preferred chain slugs. Returns empty array = show all chains.
 * Used by every search/display command to filter results.
 */
async function getUserChainFilter(userId: number): Promise<string[]> {
  const result = await query(
    'SELECT preferred_chains FROM user_profiles WHERE telegram_user_id = $1',
    [userId],
  );
  const prefs = result.rows[0]?.preferred_chains;
  return Array.isArray(prefs) && prefs.length > 0 ? prefs : [];
}

/**
 * Build a SQL WHERE clause fragment for chain filtering.
 * Returns { clause: string, params: unknown[], nextIdx: number }
 * If no filter is set, returns an always-true clause.
 */
function chainFilterSQL(chains: string[], paramStartIdx: number): {
  clause: string;
  params: unknown[];
  nextIdx: number;
} {
  if (chains.length === 0) {
    return { clause: 'TRUE', params: [], nextIdx: paramStartIdx };
  }
  const placeholders = chains.map((_, i) => `$${paramStartIdx + i}`);
  return {
    clause: `c.slug = ANY(ARRAY[${placeholders.join(',')}])`,
    params: chains,
    nextIdx: paramStartIdx + chains.length,
  };
}

// --- Private chat guard for sensitive commands ---
function requirePrivateChat(ctx: any): boolean {
  if (ctx.chat?.type !== 'private') {
    ctx.reply('🔒 Questo comando funziona solo in chat privata con il bot.', { parse_mode: 'Markdown' });
    return false;
  }
  return true;
}

// --- /start ---
bot.command('start', async (ctx) => {
  // Analytics: track unique bot starts
  try {
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    const username = ctx.from?.username ?? null;
    const firstName = ctx.from?.first_name ?? null;
    await query(
      `INSERT INTO api_events (event_type, telegram_user_id, metadata)
       VALUES ('bot_start', $1, $2)`,
      [userId, JSON.stringify({ username, first_name: firstName, language: ctx.from?.language_code })],
    );
  } catch (e) { console.warn('bot_start tracking failed:', e); }

  await ctx.reply(
    `🛒 *SpesaBot* — Il tuo consulente per la spesa\n\n` +
    `Trovo le migliori offerte nei supermercati della tua zona.\n\n` +
    `*Comandi:*\n` +
    `/cerca [prodotto] — Cerca un prodotto\n` +
    `/categoria — Sfoglia per categoria (senza lattosio, bio, baby...)\n` +
    `/offerte — Migliori sconti della settimana\n` +
    `/catene — Supermercati disponibili\n` +
    `/confronta [prodotto] — Confronta prezzi tra catene\n` +
    `/preferenze — Scegli i supermercati da visualizzare\n` +
    `/negozi [catena] — Negozi con link Google Maps\n` +
    `/carte — Info carte fedeltà\n` +
    `/iscriviti — Crea le carte fedeltà (tutto = tutte)\n` +
    `/profilo — Salva i tuoi dati personali\n` +
    `/help — Mostra questo messaggio\n\n` +
    `Oppure scrivi direttamente il nome di un prodotto!\n` +
    `_I prezzi con 🔑 sono riservati ai possessori di carta._`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .webApp('🛒 Apri SpesaBot App', WEBAPP_URL)
        .row(),
    },
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `*Comandi SpesaBot:*\n\n` +
    `🔍 /cerca latte — Cerca "latte" tra le offerte\n` +
    `📂 /categoria — Sfoglia per categoria\n` +
    `    senza-lattosio, senza-glutine, bio, vegano,\n` +
    `    prima-infanzia, integrale, proteico, surgelati,\n` +
    `    cura-casa, cura-persona\n` +
    `🏷 /offerte — Top 10 sconti della settimana\n` +
    `🏪 /catene — Lista supermercati\n` +
    `📊 /confronta yogurt — Confronta prezzi yogurt\n` +
    `💳 /carte — Carte fedeltà e iscrizioni\n` +
    `ℹ️ /stato — Stato del sistema\n\n` +
    `💡 I prezzi con 🔑 sono riservati ai possessori di carta fedeltà`,
    { parse_mode: 'Markdown' },
  );
});

// --- /preferenze — Set preferred chains to filter results ---
bot.command('preferenze', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const arg = ctx.match?.trim().toLowerCase();

  // Get all chains with active offers
  const chainsResult = await query(`
    SELECT c.slug, c.name, COUNT(o.id) as offerte
    FROM chains c
    LEFT JOIN product_skus sk ON sk.chain_id = c.id
    LEFT JOIN offers o ON o.sku_id = sk.id AND o.valid_to >= CURRENT_DATE
    GROUP BY c.slug, c.name HAVING COUNT(o.id) > 0
    ORDER BY c.name
  `);
  const allChains = chainsResult.rows;

  // Load current preferences
  const currentFilter = await getUserChainFilter(userId);

  if (!arg) {
    // Show current settings + toggle buttons
    let msg = `⚙️ *Preferenze — Supermercati visualizzati*\n\n`;
    if (currentFilter.length === 0) {
      msg += `Attualmente vedi *tutti* i supermercati.\n`;
      msg += `Tocca per escludere quelli che non ti interessano:\n\n`;
    } else {
      msg += `Vedi solo: ${currentFilter.map((s: string) => `*${s}*`).join(', ')}\n\n`;
    }

    const keyboard = new InlineKeyboard();
    for (const c of allChains) {
      const active = currentFilter.length === 0 || currentFilter.includes(c.slug);
      const icon = active ? '✅' : '⬜';
      msg += `${icon} ${c.name} (${c.offerte} offerte)\n`;
      keyboard.text(
        `${icon} ${c.name}`,
        `pref:toggle:${c.slug}`,
      ).row();
    }
    keyboard.text('🔄 Mostra tutti', 'pref:reset').row();

    msg += `\nTocca un supermercato per attivarlo/disattivarlo.`;
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  // Direct text command: /preferenze famila lidl eurospin
  const slugs = arg.split(/[\s,]+/).filter((s: string) => allChains.some((c: any) => c.slug === s));
  if (slugs.length === 0 && arg !== 'tutti' && arg !== 'all' && arg !== 'reset') {
    const available = allChains.map((c: any) => c.slug).join(', ');
    await ctx.reply(`Catene disponibili: ${available}\nEs: /preferenze famila lidl eurospin\nOppure: /preferenze tutti`);
    return;
  }

  const newPrefs = (arg === 'tutti' || arg === 'all' || arg === 'reset') ? [] : slugs;
  await query(`
    INSERT INTO user_profiles (telegram_user_id, preferred_chains)
    VALUES ($1, $2)
    ON CONFLICT (telegram_user_id) DO UPDATE SET preferred_chains = $2, updated_at = now()
  `, [userId, newPrefs]);

  if (newPrefs.length === 0) {
    await ctx.reply('✅ Filtro rimosso — vedrai offerte da *tutti* i supermercati.', { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(`✅ Preferenze salvate: vedrai solo ${newPrefs.map(s => `*${s}*`).join(', ')}`, { parse_mode: 'Markdown' });
  }
});

// Preference toggle callback
bot.callbackQuery(/^pref:toggle:(.+)$/, async (ctx) => {
  const slug = ctx.match![1];
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();

  // Get all active chain slugs
  const chainsResult = await query(`
    SELECT c.slug FROM chains c
    JOIN product_skus sk ON sk.chain_id = c.id
    JOIN offers o ON o.sku_id = sk.id AND o.valid_to >= CURRENT_DATE
    GROUP BY c.slug
  `);
  const allSlugs = chainsResult.rows.map((r: any) => r.slug);

  let current = await getUserChainFilter(userId);
  // If empty (= all), initialize with all chains then toggle off the clicked one
  if (current.length === 0) {
    current = allSlugs.filter(s => s !== slug);
  } else if (current.includes(slug)) {
    current = current.filter(s => s !== slug);
    if (current.length === 0) current = []; // empty = all
  } else {
    current.push(slug);
    // If all chains are now selected, reset to empty (= all)
    if (current.length >= allSlugs.length) current = [];
  }

  await query(`
    INSERT INTO user_profiles (telegram_user_id, preferred_chains)
    VALUES ($1, $2)
    ON CONFLICT (telegram_user_id) DO UPDATE SET preferred_chains = $2, updated_at = now()
  `, [userId, current]);

  const label = current.length === 0
    ? 'Tutti i supermercati attivi'
    : `Solo: ${current.join(', ')}`;
  await ctx.api.sendMessage(ctx.chat!.id, `⚙️ ${label}`);
});

// Reset preferences callback
bot.callbackQuery('pref:reset', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();
  await query(`
    INSERT INTO user_profiles (telegram_user_id, preferred_chains)
    VALUES ($1, '{}')
    ON CONFLICT (telegram_user_id) DO UPDATE SET preferred_chains = '{}', updated_at = now()
  `, [userId]);
  await ctx.api.sendMessage(ctx.chat!.id, '✅ Filtro rimosso — vedrai tutti i supermercati.');
});

// --- /profilo — Save personal details for loyalty card registration ---
bot.command('profilo', async (ctx) => {
  if (!requirePrivateChat(ctx)) return;
  const userId = ctx.from?.id;
  if (!userId) return;

  const args = ctx.match?.trim();

  // Show current profile if no arguments
  if (!args) {
    const existing = await query('SELECT * FROM user_profiles WHERE telegram_user_id = $1', [userId]);
    if (existing.rows.length === 0) {
      await ctx.reply(
        `📋 *Nessun profilo salvato*\n\n` +
        `Per creare le carte fedeltà automaticamente, salvami i tuoi dati:\n\n` +
        `\`/profilo nome=Mario cognome=Rossi email=mario@email.it telefono=3331234567 indirizzo=Via Roma numero=10 citta=Verona cap=37100 cf=RSSMRA90A01L781Z\`\n\n` +
        `_I dati sono salvati solo localmente sul server SpesaBot._`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    const p = decryptProfile(existing.rows[0]);
    await ctx.reply(
      `📋 *Il tuo profilo*\n\n` +
      `Nome: ${p.nome || '-'} ${p.cognome || '-'}\n` +
      `Email: ${p.email || '-'}\n` +
      `Telefono: ${p.telefono || '-'}\n` +
      `Indirizzo: ${p.indirizzo || '-'} ${p.numero_civico || '-'}\n` +
      `Città: ${p.citta || '-'} (${p.provincia || '-'}) ${p.cap || '-'}\n` +
      `CF: ${p.codice_fiscale || '-'}\n\n` +
      `Per aggiornare: /profilo nome=NuovoNome ...`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Parse key=value pairs
  const fields: Record<string, string> = {};
  const pairs = args.match(/(\w+)=([^\s]+)/g) || [];
  for (const pair of pairs) {
    const [k, v] = pair.split('=');
    fields[k.toLowerCase()] = v;
  }

  const fieldMap: Record<string, string> = {
    nome: 'nome', cognome: 'cognome', email: 'email', telefono: 'telefono',
    indirizzo: 'indirizzo', numero: 'numero_civico', citta: 'citta',
    provincia: 'provincia', cap: 'cap', cf: 'codice_fiscale',
  };

  const updates: string[] = [];
  const values: unknown[] = [userId];
  let idx = 2;
  for (const [key, col] of Object.entries(fieldMap)) {
    if (fields[key]) {
      updates.push(`${col} = $${idx}`);
      values.push(fields[key]);
      idx++;
    }
  }

  if (updates.length === 0) {
    await ctx.reply('Nessun campo riconosciuto. Usa: /profilo nome=Mario cognome=Rossi ...');
    return;
  }

  // Encrypt PII fields before storing
  const encrypted = encryptProfile(
    Object.fromEntries(
      Object.entries(fieldMap)
        .filter(([k]) => fields[k])
        .map(([k, col]) => [col, fields[k]]),
    ),
  );
  // Rebuild values with encrypted data
  const encValues: unknown[] = [userId];
  for (const [key, col] of Object.entries(fieldMap)) {
    if (fields[key]) {
      encValues.push(encrypted[col] ?? fields[key]);
    }
  }

  await query(`
    INSERT INTO user_profiles (telegram_user_id, ${Object.entries(fieldMap).filter(([k]) => fields[k]).map(([, col]) => col).join(', ')})
    VALUES ($1, ${encValues.slice(1).map((_, i) => `$${i + 2}`).join(', ')})
    ON CONFLICT (telegram_user_id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()
  `, encValues);

  await ctx.reply(`✅ Profilo aggiornato! (${updates.length} campi)\nScrivi /profilo per verificare.`);
});

// --- /iscriviti — Automated loyalty card creation ---
bot.command('iscriviti', async (ctx) => {
  if (!requirePrivateChat(ctx)) return;
  const userId = ctx.from?.id;
  if (!userId) return;

  const chainArg = ctx.match?.trim().toLowerCase();

  // Get user profile
  const profileResult = await query('SELECT * FROM user_profiles WHERE telegram_user_id = $1', [userId]);
  if (profileResult.rows.length === 0) {
    await ctx.reply(
      `❌ Prima salva il tuo profilo:\n\n` +
      `/profilo nome=Mario cognome=Rossi email=mario@email.it telefono=3331234567 indirizzo=Via\\ Roma numero=10 citta=Verona cap=37100 cf=RSSMRA90A01L781Z`,
    );
    return;
  }
  const profile = decryptProfile(profileResult.rows[0]);

  // Get chains with loyalty programs
  const chains = await query(`
    SELECT id, slug, name, loyalty_card_name, loyalty_signup_url, loyalty_app_url
    FROM chains WHERE loyalty_card_name IS NOT NULL ORDER BY name
  `);

  if (!chainArg) {
    // Show overview of all chains with status
    const cards = await query(`
      SELECT ulc.chain_id, ulc.status FROM user_loyalty_cards ulc
      JOIN user_profiles up ON up.id = ulc.user_profile_id
      WHERE up.telegram_user_id = $1
    `, [userId]);
    const cardMap = new Map(cards.rows.map((c: any) => [c.chain_id, c.status]));

    let msg = `💳 *Iscrizione Carte Fedeltà*\n\n`;
    const keyboard = new InlineKeyboard();
    for (const c of chains.rows) {
      const status = cardMap.get(c.id);
      const icon = status === 'active' ? '✅' : status === 'registered' ? '⏳' : '⬜';
      msg += `${icon} *${c.name}* — ${c.loyalty_card_name}\n`;
      if (!status || status === 'pending') {
        keyboard.text(`📝 Iscriviti ${c.name}`, `signup:${c.slug}`).row();
      }
    }
    msg += `\nTocca un pulsante per iscriverti, oppure:\n`;
    msg += `/iscriviti tutto — Iscriviti a tutte le catene`;
    keyboard.text(`🚀 Iscriviti a TUTTE`, `signup:all`).row();

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  // Handle "tutto" (all chains)
  if (chainArg === 'tutto' || chainArg === 'all') {
    await ctx.reply(`🚀 Avvio iscrizione per tutte le catene...`);
    for (const c of chains.rows) {
      await processSignup(ctx, profile, c);
    }
    return;
  }

  // Single chain
  const chain = chains.rows.find((c: any) => c.slug === chainArg || c.name.toLowerCase().includes(chainArg));
  if (!chain) {
    await ctx.reply(`Catena "${chainArg}" non trovata. Scrivi /iscriviti per la lista.`);
    return;
  }
  await processSignup(ctx, profile, chain);
});

// Signup callback handler
bot.callbackQuery(/^signup:(.+)$/, async (ctx) => {
  const target = ctx.match![1];
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) return;

  const profileResult = await query('SELECT * FROM user_profiles WHERE telegram_user_id = $1', [userId]);
  if (profileResult.rows.length === 0) {
    await ctx.api.sendMessage(ctx.chat!.id, `❌ Prima salva il tuo profilo con /profilo`);
    return;
  }
  const profile = decryptProfile(profileResult.rows[0]);

  const chains = await query(`
    SELECT id, slug, name, loyalty_card_name, loyalty_signup_url, loyalty_app_url
    FROM chains WHERE loyalty_card_name IS NOT NULL ORDER BY name
  `);

  if (target === 'all') {
    await ctx.api.sendMessage(ctx.chat!.id, `🚀 Avvio iscrizione per tutte le catene...`);
    for (const c of chains.rows) {
      await processSignup({ reply: (msg: string, opts?: any) => ctx.api.sendMessage(ctx.chat!.id, msg, opts) } as any, profile, c);
    }
    return;
  }

  const chain = chains.rows.find((c: any) => c.slug === target);
  if (chain) {
    await processSignup({ reply: (msg: string, opts?: any) => ctx.api.sendMessage(ctx.chat!.id, msg, opts) } as any, profile, chain);
  }
});

/** Process signup for a single chain. */
async function processSignup(ctx: any, profile: any, chain: any): Promise<void> {
  const APP_ONLY_CHAINS = ['lidl', 'eurospin', 'despar', 'famila'];

  if (chain.slug === 'conad') {
    // Conad: web form automation (requires physical card number)
    await ctx.reply(
      `🏪 *${chain.name} — ${chain.loyalty_card_name}*\n\n` +
      `Conad richiede una carta fisica (13 cifre) che puoi ritirare gratis in negozio.\n\n` +
      `Se hai già la carta, inviami il numero:\n` +
      `/conad\\_attiva 1234567890123\n\n` +
      `Il bot compilerà automaticamente il form di attivazione online.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (APP_ONLY_CHAINS.includes(chain.slug)) {
    // App-only: send formatted details + app download link
    let msg = `📱 *${chain.name} — ${chain.loyalty_card_name}*\n\n`;
    msg += `Questa carta si crea dall'app. Ecco i tuoi dati pronti da copiare:\n\n`;
    msg += `\`\`\`\n`;
    msg += `Nome: ${profile.nome || ''}\n`;
    msg += `Cognome: ${profile.cognome || ''}\n`;
    msg += `Email: ${profile.email || ''}\n`;
    msg += `Telefono: ${profile.telefono || ''}\n`;
    msg += `Indirizzo: ${profile.indirizzo || ''} ${profile.numero_civico || ''}\n`;
    msg += `Città: ${profile.citta || ''} (${profile.provincia || 'VR'}) ${profile.cap || ''}\n`;
    if (profile.codice_fiscale) msg += `CF: ${profile.codice_fiscale}\n`;
    msg += `\`\`\`\n\n`;

    const kb = new InlineKeyboard();
    if (chain.loyalty_app_url) {
      kb.url(`📱 Scarica App ${chain.loyalty_card_name}`, chain.loyalty_app_url).row();
    }
    if (chain.loyalty_signup_url) {
      kb.url(`🌐 Registrati Online`, chain.loyalty_signup_url).row();
    }

    msg += `Tocca "Scarica App", poi incolla i dati durante la registrazione.`;

    // For Despar/Famila: same loyalty program
    if (chain.slug === 'famila') {
      msg += `\n\n_💡 Famila usa la stessa carta "Despar Tribù" di Despar._`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });

    // Track as pending
    const profileId = profile.id;
    await query(`
      INSERT INTO user_loyalty_cards (user_profile_id, chain_id, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (user_profile_id, chain_id) DO NOTHING
    `, [profileId, chain.id]);
    return;
  }

  // Fallback: just show the signup URL
  await ctx.reply(
    `🔗 *${chain.name} — ${chain.loyalty_card_name}*\n\nRegistrati qui: ${chain.loyalty_signup_url || 'non disponibile'}`,
    { parse_mode: 'Markdown' },
  );
}

// --- /conad_attiva — Activate Conad card with card number ---
bot.command('conad_attiva', async (ctx) => {
  if (!requirePrivateChat(ctx)) return;
  const userId = ctx.from?.id;
  if (!userId) return;

  const cardNumber = ctx.match?.trim();
  if (!cardNumber || !/^\d{13}$/.test(cardNumber)) {
    await ctx.reply('Il numero carta deve essere di 13 cifre. Es: /conad_attiva 1234567890123');
    return;
  }

  const profileResult = await query('SELECT * FROM user_profiles WHERE telegram_user_id = $1', [userId]);
  if (profileResult.rows.length === 0) {
    await ctx.reply('❌ Prima salva il tuo profilo con /profilo');
    return;
  }
  const p = decryptProfile(profileResult.rows[0]);

  if (!p.nome || !p.cognome || !p.email) {
    await ctx.reply('❌ Il profilo deve avere almeno nome, cognome e email. Aggiorna con /profilo');
    return;
  }

  await ctx.reply(`⏳ Compilo il form di registrazione Conad con i tuoi dati...`);

  // Generate a cryptographically random password instead of a predictable one
  const { randomBytes } = await import('node:crypto');
  const generatedPassword = `Sp${randomBytes(6).toString('base64url')}!`;

  const result = await registerConadCard({
    cardNumber,
    nome: p.nome as string,
    cognome: p.cognome as string,
    email: p.email as string,
    password: generatedPassword,
    dataNascita: '', // TODO: add to profile if needed
  });

  if (result.success) {
    await ctx.reply(
      `✅ *Registrazione Conad inviata!*\n\n${result.needsManualAction || 'Controlla la tua email.'}\n\nPassword: \`${escMd(generatedPassword)}\``,
      { parse_mode: 'Markdown' },
    );
    // Track the card
    const chainResult = await query("SELECT id FROM chains WHERE slug = 'conad'");
    if (chainResult.rows.length > 0) {
      const encryptedCard = encryptValue(cardNumber);
      await query(`
        INSERT INTO user_loyalty_cards (user_profile_id, chain_id, card_number, status, registered_at)
        VALUES ($1, $2, $3, 'registered', now())
        ON CONFLICT (user_profile_id, chain_id) DO UPDATE SET card_number = $3, status = 'registered', registered_at = now()
      `, [p.id, chainResult.rows[0].id, encryptedCard]);
    }
  } else {
    let msg = `⚠️ *Registrazione Conad — ${result.step}*\n\n`;
    if (result.needsManualAction) msg += `${result.needsManualAction}\n\n`;
    if (result.error) msg += `Errore: ${result.error}`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }
});

// --- /carte — Loyalty card info and signup ---
bot.command('carte', async (ctx) => {
  if (!requirePrivateChat(ctx)) return;
  const chainArg = ctx.match?.trim().toLowerCase();

  const results = await query(`
    SELECT slug, name, loyalty_card_name, loyalty_signup_url, loyalty_app_url
    FROM chains
    WHERE loyalty_card_name IS NOT NULL
    ORDER BY name
  `);

  if (results.rows.length === 0) {
    await ctx.reply('Nessuna informazione sulle carte fedeltà disponibile.');
    return;
  }

  // If a specific chain was requested, show only that chain with all details
  if (chainArg) {
    const chain = results.rows.find((r: any) => r.slug === chainArg || r.name.toLowerCase().includes(chainArg));
    if (!chain) {
      await ctx.reply(`Catena "${chainArg}" non trovata. Scrivi /carte per la lista completa.`);
      return;
    }
    let msg = `💳 *${chain.name} — ${chain.loyalty_card_name}*\n\n`;
    msg += `Iscriviti per accedere a offerte riservate e accumulare punti.\n\n`;
    const kb = new InlineKeyboard();
    if (chain.loyalty_signup_url) {
      msg += `📝 *Iscrizione online:* tocca il pulsante qui sotto\n`;
      kb.url(`📝 Iscriviti a ${chain.loyalty_card_name}`, chain.loyalty_signup_url).row();
    }
    if (chain.loyalty_app_url) {
      msg += `📱 *App:* scarica e registrati direttamente dall'app\n`;
      kb.url(`📱 Scarica App ${chain.name}`, chain.loyalty_app_url).row();
    }
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
    return;
  }

  // Show all chains overview with quick-action buttons
  let msg = `💳 *Carte Fedeltà — Un tocco per iscriverti*\n\n`;
  msg += `Molte offerte sono riservate ai possessori di carta.\n`;
  msg += `Tocca un pulsante per iscriverti o scaricare l'app:\n\n`;

  const keyboard = new InlineKeyboard();
  for (const r of results.rows) {
    msg += `*${r.name}* — ${r.loyalty_card_name}\n`;
    if (r.loyalty_signup_url) {
      keyboard.url(`📝 ${r.loyalty_card_name}`, r.loyalty_signup_url);
    }
    if (r.loyalty_app_url) {
      keyboard.url(`📱 App`, r.loyalty_app_url);
    }
    keyboard.row();
  }

  msg += `\nOppure scrivi /carte lidl per dettagli su una catena specifica.`;
  msg += `\n_Le offerte con 🔑 richiedono la carta._`;

  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// --- /categoria [tag] ---
bot.command('categoria', async (ctx) => {
  const tag = ctx.match?.trim().toLowerCase();

  const tagLabels: Record<string, string> = {
    'senza-lattosio': '🥛 Senza Lattosio',
    'senza-glutine': '🌾 Senza Glutine',
    'integrale': '🌿 Integrale',
    'bio': '🌱 Bio / Biologico',
    'vegano': '🥬 Vegano / Vegetale',
    'prima-infanzia': '👶 Prima Infanzia',
    'proteico': '💪 Proteico',
    'surgelati': '🧊 Surgelati',
    'cura-casa': '🏠 Cura Casa',
    'cura-persona': '🧴 Cura Persona',
  };

  if (!tag || !tagLabels[tag]) {
    // Show available categories with inline keyboard
    const results = await query(`
      SELECT unnest(sk.tags) as tag, COUNT(DISTINCT sk.id) as cnt
      FROM product_skus sk
      JOIN offers o ON o.sku_id = sk.id
      WHERE o.valid_to >= CURRENT_DATE AND array_length(sk.tags, 1) > 0
      GROUP BY tag ORDER BY cnt DESC
    `);

    let msg = `📂 *Categorie disponibili*\n\nScegli una categoria o scrivi: /categoria senza-lattosio\n`;
    const keyboard = new InlineKeyboard();
    for (const r of results.rows) {
      const label = tagLabels[r.tag] ?? r.tag;
      msg += `\n${label} — ${r.cnt} prodotti`;
      keyboard.text(`${label} (${r.cnt})`, `cat:${r.tag}`).row();
    }
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  const results = await query(`
    SELECT DISTINCT ON (sk.normalized_name, c.slug)
      sk.raw_name, sk.brand, o.offer_price, o.original_price,
      o.discount_pct, sk.raw_quantity, c.name as catena
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE o.valid_to >= CURRENT_DATE AND $1 = ANY(sk.tags)
    ORDER BY sk.normalized_name, c.slug, o.offer_price ASC
  `, [tag]);

  const sorted = results.rows
    .sort((a: any) => a.offer_price)
    .slice(0, 15);

  if (sorted.length === 0) {
    await ctx.reply(`Nessun prodotto trovato per "${tagLabels[tag]}".`);
    return;
  }

  let msg = `${tagLabels[tag]} *Offerte attive*\n\n`;
  for (const r of sorted) {
    const name = escMd(truncate(r.raw_name, 35));
    const price = `€${Number(r.offer_price).toFixed(2)}`;
    const discount = r.discount_pct ? ` *-${Math.round(r.discount_pct)}%*` : '';
    msg += `${name}\n${price}${discount} — _${escMd(r.catena)}_\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Category inline keyboard callback
bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
  const tag = ctx.match![1];
  await ctx.answerCallbackQuery();
  // Reuse the command handler
  ctx.match = tag;
  await ctx.api.sendMessage(ctx.chat!.id, `Cerco offerte per la categoria "${tag}"...`);

  const tagLabels: Record<string, string> = {
    'senza-lattosio': '🥛 Senza Lattosio', 'senza-glutine': '🌾 Senza Glutine',
    'integrale': '🌿 Integrale', 'bio': '🌱 Bio', 'vegano': '🥬 Vegano',
    'prima-infanzia': '👶 Prima Infanzia', 'proteico': '💪 Proteico',
    'surgelati': '🧊 Surgelati', 'cura-casa': '🏠 Cura Casa', 'cura-persona': '🧴 Cura Persona',
  };

  const results = await query(`
    SELECT DISTINCT ON (sk.normalized_name, c.slug)
      sk.raw_name, o.offer_price, o.discount_pct, sk.raw_quantity, c.name as catena
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE o.valid_to >= CURRENT_DATE AND $1 = ANY(sk.tags)
    ORDER BY sk.normalized_name, c.slug, o.offer_price ASC
  `, [tag]);

  const sorted = results.rows
    .sort((a: any) => a.offer_price)
    .slice(0, 15);

  if (sorted.length === 0) {
    await ctx.api.sendMessage(ctx.chat!.id, `Nessun prodotto per "${tagLabels[tag] ?? tag}".`);
    return;
  }

  let msg = `${tagLabels[tag] ?? tag} *Offerte attive*\n\n`;
  for (const r of sorted) {
    const name = escMd(truncate(r.raw_name, 35));
    const price = `€${Number(r.offer_price).toFixed(2)}`;
    const discount = r.discount_pct ? ` *-${Math.round(r.discount_pct)}%*` : '';
    msg += `${name}\n${price}${discount} — _${escMd(r.catena)}_\n\n`;
  }

  await ctx.api.sendMessage(ctx.chat!.id, msg, { parse_mode: 'Markdown' });
});

// --- /cerca [query] ---
bot.command('cerca', async (ctx) => {
  const q = ctx.match?.trim();
  if (!q) {
    await ctx.reply('Cosa cerchi? Scrivi: /cerca latte');
    return;
  }
  await searchAndReply(ctx, q);
});

// --- /offerte ---
bot.command('offerte', async (ctx) => {
  const chainFilter = ctx.from?.id ? await getUserChainFilter(ctx.from.id) : [];
  const cf = chainFilterSQL(chainFilter, 1);

  const results = await query(`
    SELECT DISTINCT ON (sk.normalized_name)
      sk.raw_name, sk.brand, o.offer_price, o.original_price,
           o.discount_pct, sk.raw_quantity, c.name as catena
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE o.valid_to >= CURRENT_DATE
      AND o.discount_pct IS NOT NULL
      AND o.offer_price < 50
      AND LENGTH(sk.raw_name) < 120
      AND ${cf.clause}
    ORDER BY sk.normalized_name, o.discount_pct DESC
  `, [...cf.params]);

  const topDeals = results.rows
    .sort((a: any, b: any) => (b.discount_pct || 0) - (a.discount_pct || 0))
    .slice(0, 10);

  if (topDeals.length === 0) {
    await ctx.reply('Nessuna offerta trovata questa settimana.');
    return;
  }

  let msg = '🏷 *Top 10 sconti della settimana*\n\n';
  for (const r of topDeals) {
    const name = escMd(truncate(r.raw_name, 35));
    const discount = r.discount_pct ? `-${Math.round(r.discount_pct)}%` : '';
    const price = `€${Number(r.offer_price).toFixed(2)}`;
    const orig = r.original_price ? ` ~~€${Number(r.original_price).toFixed(2)}~~` : '';
    msg += `*${discount}* ${name}\n`;
    msg += `${price}${orig} — ${escMd(r.catena)}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// --- /catene ---
bot.command('catene', async (ctx) => {
  const results = await query(`
    SELECT c.slug, c.name, count(o.id) as offerte
    FROM chains c
    LEFT JOIN product_skus sk ON sk.chain_id = c.id
    LEFT JOIN offers o ON o.sku_id = sk.id AND o.valid_to >= CURRENT_DATE
    GROUP BY c.slug, c.name
    HAVING count(o.id) > 0
    ORDER BY count(o.id) DESC
  `);

  if (results.rows.length === 0) {
    await ctx.reply('Nessun supermercato con offerte attive.');
    return;
  }

  let msg = '🏪 *Supermercati con offerte attive*\n\n';
  for (const r of results.rows) {
    msg += `*${r.name}* — ${r.offerte} offerte\n`;
  }

  // Add inline keyboard to view each chain
  const keyboard = new InlineKeyboard();
  for (const r of results.rows) {
    keyboard.text(`📋 ${r.name}`, `chain:${r.slug}`).row();
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// --- /confronta [query] ---
bot.command('confronta', async (ctx) => {
  const q = ctx.match?.trim();
  if (!q) {
    await ctx.reply('Cosa vuoi confrontare? Scrivi: /confronta yogurt');
    return;
  }

  const chainFilter = ctx.from?.id ? await getUserChainFilter(ctx.from.id) : [];
  const cf = chainFilterSQL(chainFilter, 2); // $1=q, $2+=chains

  const results = await query(`
    SELECT DISTINCT ON (sk.normalized_name, c.slug)
      sk.raw_name, sk.brand, o.offer_price, o.original_price,
           o.discount_pct, sk.raw_quantity, c.name as catena, c.slug
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE o.valid_to >= CURRENT_DATE
      AND LENGTH(sk.raw_name) < 120
      AND ${cf.clause}
      AND (sk.raw_name ILIKE '%' || $1 || '%' OR similarity(sk.raw_name, $1) > 0.25)
    ORDER BY sk.normalized_name, c.slug, o.offer_price ASC
  `, [q, ...cf.params]);

  const sorted = results.rows
    .sort((a: any, b: any) => a.offer_price - b.offer_price)
    .slice(0, 15);

  if (sorted.length === 0) {
    await ctx.reply(`Nessun risultato per "${q}". Prova con un altro termine.`);
    return;
  }

  let msg = `📊 *Confronto prezzi: "${escMd(q)}"*\n\n`;
  for (const r of sorted) {
    const name = escMd(truncate(r.raw_name, 30));
    const price = `€${Number(r.offer_price).toFixed(2)}`;
    const discount = r.discount_pct ? ` (-${Math.round(r.discount_pct)}%)` : '';
    msg += `${price}${discount} — ${name}\n`;
    msg += `  _${escMd(r.catena)}_${r.raw_quantity ? ' | ' + escMd(r.raw_quantity) : ''}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// --- /negozi [chain?] — Show nearby stores with Google Maps links ---
bot.command('negozi', async (ctx) => {
  const chainArg = ctx.match?.trim().toLowerCase();

  const whereClause = chainArg
    ? `WHERE s.location IS NOT NULL AND c.slug = $1`
    : `WHERE s.location IS NOT NULL`;
  const params = chainArg ? [chainArg] : [];

  const results = await query(`
    SELECT s.name, s.address, s.city, s.postal_code, c.slug, c.name as catena,
      ST_Y(s.location::geometry) as lat, ST_X(s.location::geometry) as lng
    FROM stores s JOIN chains c ON c.id = s.chain_id
    ${whereClause}
    ORDER BY c.name, s.city, s.name
  `, params);

  if (results.rows.length === 0) {
    await ctx.reply(chainArg
      ? `Nessun negozio trovato per "${chainArg}". Scrivi /negozi per la lista completa.`
      : `Nessun negozio con coordinate disponibile.`);
    return;
  }

  // Group by chain
  const byChain: Record<string, any[]> = {};
  for (const r of results.rows) {
    if (!byChain[r.catena]) byChain[r.catena] = [];
    byChain[r.catena].push(r);
  }

  let msg = `📍 *Negozi nella zona di Verona*\n\n`;
  for (const [chain, stores] of Object.entries(byChain)) {
    msg += `*${chain}* (${stores.length} negozi)\n`;
    for (const s of stores.slice(0, chainArg ? 20 : 5)) {
      const addr = s.address ? `${s.address}, ` : '';
      const link = mapsLink(s.lat, s.lng, `${s.name} ${s.address} ${s.city}`);
      msg += `  ${s.city} — ${addr}[📍 Maps](${link})\n`;
    }
    if (!chainArg && stores.length > 5) {
      msg += `  _...e altri ${stores.length - 5}. Scrivi /negozi ${stores[0].slug}_\n`;
    }
    msg += `\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
});

// --- /stato ---
bot.command('stato', async (ctx) => {
  const stats = await query(`
    SELECT
      (SELECT count(*) FROM offers WHERE valid_to >= CURRENT_DATE) as offerte_attive,
      (SELECT count(DISTINCT chain_id) FROM product_skus sk JOIN offers o ON o.sku_id = sk.id WHERE o.valid_to >= CURRENT_DATE) as catene,
      (SELECT max(created_at)::text FROM flyer_campaigns WHERE scrape_status = 'loaded') as ultimo_aggiornamento
  `);
  const s = stats.rows[0];

  await ctx.reply(
    `ℹ️ *Stato SpesaBot*\n\n` +
    `Offerte attive: ${s.offerte_attive}\n` +
    `Catene monitorate: ${s.catene}\n` +
    `Ultimo aggiornamento: ${s.ultimo_aggiornamento ? new Date(s.ultimo_aggiornamento).toLocaleDateString('it-IT') : 'mai'}\n` +
    `Versione: 0.1.0`,
    { parse_mode: 'Markdown' },
  );
});

// --- Inline keyboard callbacks ---
bot.callbackQuery(/^chain:(.+)$/, async (ctx) => {
  const slug = ctx.match![1];
  await ctx.answerCallbackQuery();

  const results = await query(`
    SELECT sk.raw_name, o.offer_price, o.original_price, o.discount_pct, sk.raw_quantity
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    WHERE c.slug = $1 AND o.valid_to >= CURRENT_DATE
    ORDER BY o.discount_pct DESC NULLS LAST
    LIMIT 15
  `, [slug]);

  if (results.rows.length === 0) {
    await ctx.reply('Nessuna offerta attiva per questa catena.');
    return;
  }

  let msg = `🏪 *Offerte ${escMd(slug.charAt(0).toUpperCase() + slug.slice(1))}*\n\n`;
  for (const r of results.rows) {
    const name = escMd(truncate(r.raw_name, 35));
    const price = `€${Number(r.offer_price).toFixed(2)}`;
    const discount = r.discount_pct ? ` *-${Math.round(r.discount_pct)}%*` : '';
    const orig = r.original_price ? ` ~~€${Number(r.original_price).toFixed(2)}~~` : '';
    msg += `${name}\n${price}${orig}${discount}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// --- Free text: treat as product search ---
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  // Ignore if it starts with / (unknown command)
  if (text.startsWith('/')) {
    await ctx.reply(`Comando sconosciuto. Scrivi /help per la lista dei comandi.`);
    return;
  }
  await searchAndReply(ctx, text);
});

// --- Shared search function ---
async function searchAndReply(ctx: any, q: string): Promise<void> {
  // Full-text search with Italian stemming + ILIKE fallback
  const tsQuery = q.trim().split(/\s+/).filter(w => w.length >= 2).join(' & ');
  if (!tsQuery) {
    await ctx.reply(`Termine troppo corto. Scrivi almeno 2 caratteri.`);
    return;
  }

  // Apply user's chain preferences as filter
  const userId = ctx.from?.id;
  const chainFilter = userId ? await getUserChainFilter(userId) : [];
  const cf = chainFilterSQL(chainFilter, 3); // $1=q, $2=tsQuery, $3+=chains

  const results = await query(`
    SELECT DISTINCT ON (sk.normalized_name, c.slug)
      sk.raw_name, sk.brand, o.offer_price, o.original_price,
           o.discount_pct, o.unit_price, sk.raw_quantity, c.name as catena,
           s.name as negozio, s.city as citta,
           ST_Y(s.location::geometry) as store_lat,
           ST_X(s.location::geometry) as store_lng,
           o.requires_card, c.loyalty_card_name,
           ts_rank(sk.search_vector, to_tsquery('italian', $2)) as fts_rank,
           similarity(sk.raw_name, $1) as match_score
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE o.valid_to >= CURRENT_DATE
      AND LENGTH(sk.raw_name) < 120
      AND ${cf.clause}
      AND (
        sk.search_vector @@ to_tsquery('italian', $2)
        OR sk.raw_name ILIKE '%' || $1 || '%'
      )
    ORDER BY sk.normalized_name, c.slug, o.offer_price ASC
  `, [q, tsQuery, ...cf.params]);

  // Re-sort: FTS rank first, then similarity, then price. Take top 10.
  const sorted = results.rows
    .sort((a: any, b: any) => (b.fts_rank - a.fts_rank) || (b.match_score - a.match_score) || (a.offer_price - b.offer_price))
    .slice(0, 10);
  results.rows = sorted;
  results.rowCount = sorted.length;

  if (results.rows.length === 0) {
    await ctx.reply(`Nessun risultato per "${q}".\n\nProva con un altro termine, ad es: latte, yogurt, pasta, olio`);
    return;
  }

  let hasLoyalty = false;
  let msg = `🔍 *Risultati per "${escMd(q)}"*\n\n`;
  for (const r of results.rows) {
    const name = escMd(truncate(r.raw_name, 35));
    const price = `€${Number(r.offer_price).toFixed(2)}`;
    const discount = r.discount_pct ? ` *-${Math.round(r.discount_pct)}%*` : '';
    const orig = r.original_price ? ` ~~€${Number(r.original_price).toFixed(2)}~~` : '';
    const qty = r.raw_quantity ? ` (${escMd(r.raw_quantity)})` : '';
    const unitPrice = r.unit_price ? ` · €${Number(r.unit_price).toFixed(2)}/kg` : '';
    const loyalty = r.requires_card ? ' 🔑' : '';
    if (r.requires_card) hasLoyalty = true;
    // Show chain + city + Google Maps link if coordinates available
    const storeLabel = r.citta ? `${escMd(r.catena)} ${escMd(r.citta)}` : escMd(r.catena);
    const maps = r.store_lat && r.store_lng
      ? ` [📍](${mapsLink(r.store_lat, r.store_lng, r.negozio + ' ' + r.citta)})`
      : '';
    msg += `*${name}*${qty}\n`;
    msg += `${price}${orig}${discount}${unitPrice}${loyalty}\n`;
    msg += `_${storeLabel}_${maps}\n\n`;
  }

  if (hasLoyalty) {
    msg += `_🔑 = prezzo con carta fedeltà. Scrivi /carte per iscriverti._`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

/** Generate a Google Maps link from lat/lng coordinates. */
function mapsLink(lat: number, lng: number, name?: string): string {
  if (!lat || !lng) return '';
  const q = name ? encodeURIComponent(name) : `${lat},${lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

/**
 * Escape a string for safe use inside Telegram Markdown (v1) messages.
 * Prevents scraped product names/data from breaking message formatting
 * or injecting markdown syntax. Escapes: _ * ` [ ]
 */
function escMd(s: string): string {
  if (!s) return '';
  return s.replace(/([_*`\[\]])/g, '\\$1');
}

// --- Start bot ---
console.log('SpesaBot Telegram bot starting...');
bot.start({
  onStart: async () => {
    console.log('SpesaBot bot is live!');
    // Set the Mini App as the chat menu button (replaces the default "/" menu)
    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'SpesaBot',
          web_app: { url: WEBAPP_URL },
        },
      });
      console.log(`Mini App menu button set: ${WEBAPP_URL}`);
    } catch (err) {
      console.error('Failed to set menu button:', err instanceof Error ? err.message : err);
    }
  },
});
