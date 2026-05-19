/**
 * Watchlist notification daemon.
 *
 * Runs after each pipeline scrape to check active user watches against
 * currently active offers. Sends Telegram notifications for matching offers
 * that haven't been notified before. Deduplication is handled via the
 * `watch_notifications` table.
 *
 * Watch types:
 *   - product:  exact/fuzzy match on product name
 *   - category: match on sk.tags array (senza-lattosio, bio, etc.)
 *   - keyword:  substring match on product name
 *
 * Run: DATABASE_URL=... SPESABOT_BOT_TOKEN=... npx tsx src/notify-watches.ts
 */

import { query, close } from './db.js';

const BOT_TOKEN = process.env.SPESABOT_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('SPESABOT_BOT_TOKEN required');
  process.exit(1);
}

interface Watch {
  id: number;
  user_profile_id: number;
  watch_type: 'product' | 'category' | 'keyword';
  query: string;
  max_price: number | null;
  chain_filter: string[];
  store_filter: number[];
  telegram_user_id: string;
}

interface Match {
  watch_id: number;
  telegram_user_id: string;
  offer_id: number;
  raw_name: string;
  brand: string | null;
  offer_price: number;
  original_price: number | null;
  discount_pct: number | null;
  quantita: string | null;
  chain_name: string;
  store_name: string | null;
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.warn(`Failed to notify ${chatId}: ${res.status} ${err}`);
  }
}

async function findMatches(watch: Watch): Promise<Match[]> {
  const chainClause = watch.chain_filter.length > 0
    ? `AND c.slug = ANY($${3 + (watch.max_price !== null ? 1 : 0)})`
    : '';
  const storeClause = watch.store_filter.length > 0
    ? `AND (o.store_id IS NULL OR o.store_id = ANY($${3 + (watch.max_price !== null ? 1 : 0) + (watch.chain_filter.length > 0 ? 1 : 0)}))`
    : '';
  const priceClause = watch.max_price !== null ? 'AND o.offer_price <= $3' : '';

  let matchClause = '';
  if (watch.watch_type === 'product') {
    // Prioritize products where query is a primary match (starts-with or whole word)
    matchClause = `AND (sk.raw_name ILIKE '%' || $2 || '%' OR similarity(lower(sk.raw_name), lower($2)) > 0.4)`;
  } else if (watch.watch_type === 'category') {
    matchClause = `AND $2 = ANY(sk.tags)`;
  } else {
    // keyword: loose substring
    matchClause = `AND sk.raw_name ILIKE '%' || $2 || '%'`;
  }

  const params: unknown[] = [watch.id, watch.query];
  if (watch.max_price !== null) params.push(watch.max_price);
  if (watch.chain_filter.length > 0) params.push(watch.chain_filter);
  if (watch.store_filter.length > 0) params.push(watch.store_filter);

  const sql = `
    SELECT
      o.id as offer_id,
      sk.raw_name,
      sk.brand,
      o.offer_price,
      o.original_price,
      o.discount_pct,
      sk.raw_quantity as quantita,
      c.name as chain_name,
      s.name as store_name
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE o.valid_to >= CURRENT_DATE
      AND o.valid_from <= CURRENT_DATE
      ${matchClause}
      ${priceClause}
      ${chainClause}
      ${storeClause}
      AND NOT EXISTS (
        SELECT 1 FROM watch_notifications wn
        WHERE wn.watch_id = $1 AND wn.offer_id = o.id
      )
    ORDER BY o.discount_pct DESC NULLS LAST, o.offer_price ASC
    LIMIT 10
  `;

  const result = await query<Match>(sql, params);
  return result.rows.map(r => ({ ...r, watch_id: watch.id, telegram_user_id: watch.telegram_user_id }));
}

function formatMatch(match: Match, watchQuery: string): string {
  const price = `€${Number(match.offer_price).toFixed(2)}`;
  const origPart = match.original_price
    ? ` ~~€${Number(match.original_price).toFixed(2)}~~`
    : '';
  const discPart = match.discount_pct ? ` *-${Math.round(Number(match.discount_pct))}%*` : '';
  const qtyPart = match.quantita ? ` · ${match.quantita}` : '';
  const storePart = match.store_name ? ` (${match.store_name})` : '';
  const brandPart = match.brand ? ` ${match.brand}` : '';

  return `🔔 *${watchQuery}* in offerta!\n\n` +
    `${brandPart ? `*${match.brand}*\n` : ''}` +
    `${match.raw_name}${qtyPart}\n` +
    `${price}${origPart}${discPart}\n` +
    `🛒 ${match.chain_name}${storePart}`;
}

async function main() {
  console.log(`=== Watchlist notifications — ${new Date().toISOString()} ===`);

  // Load all active watches with user telegram IDs
  const watches = await query<Watch>(`
    SELECT w.id, w.user_profile_id, w.watch_type, w.query, w.max_price,
           w.chain_filter, w.store_filter,
           up.telegram_user_id::text as telegram_user_id
    FROM user_watches w
    JOIN user_profiles up ON up.id = w.user_profile_id
    WHERE w.is_active = true
  `);

  console.log(`Active watches: ${watches.rows.length}`);
  if (watches.rows.length === 0) { await close(); return; }

  let totalNotified = 0;

  for (const watch of watches.rows) {
    const matches = await findMatches(watch);
    if (matches.length === 0) continue;

    console.log(`Watch #${watch.id} (${watch.watch_type}: ${watch.query}) → ${matches.length} new matches`);

    for (const match of matches) {
      const msg = formatMatch(match, watch.query);
      await sendTelegram(watch.telegram_user_id, msg);

      // Record the notification to avoid duplicates
      await query(
        'INSERT INTO watch_notifications (watch_id, offer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [watch.id, match.offer_id],
      );
      totalNotified++;

      // Rate limit: Telegram allows ~30 msg/sec, we stay conservative
      await new Promise(r => setTimeout(r, 100));
    }

    // Update last_notified_at
    await query('UPDATE user_watches SET last_notified_at = now() WHERE id = $1', [watch.id]);
  }

  console.log(`Total notifications sent: ${totalNotified}`);
  await close();
}

main().catch(async (err) => {
  console.error('Error:', err);
  await close();
  process.exit(1);
});
