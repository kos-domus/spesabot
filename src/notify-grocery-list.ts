/**
 * Shopping-list notification daemon.
 *
 * Sibling to notify-watches.ts. Iterates every active shopping_list_items
 * row, checks for currently-active offers on the linked canonical product
 * that satisfy the per-item thresholds (min_discount_pct AND/OR max_price),
 * sends a Telegram alert per fresh offer, and dedups via the
 * shopping_list_notifications table so the same offer doesn't fire twice
 * for the same item across pipeline runs.
 *
 * Run: DATABASE_URL=... SPESABOT_BOT_TOKEN=... npx tsx src/notify-grocery-list.ts
 */

import { query, close } from './db.js';

const BOT_TOKEN = process.env.SPESABOT_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('SPESABOT_BOT_TOKEN required');
  process.exit(1);
}

interface ListItem {
  id: number;
  list_id: number;
  product_id: number;
  product_name: string;
  product_brand: string | null;
  min_discount_pct: number | null;
  max_price: number | null;
  telegram_user_id: string;
}

interface Match {
  item_id: number;
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

async function findMatches(item: ListItem): Promise<Match[]> {
  // Build the per-item threshold clauses. Both filters are AND'd; null means
  // "don't gate on this axis". When both are null we still fire on any fresh
  // offer — the user explicitly opted into that ("qualsiasi offerta").
  const params: unknown[] = [item.id, item.product_id];
  let priceClause = '';
  let discountClause = '';
  if (item.max_price !== null) {
    params.push(item.max_price);
    priceClause = `AND o.offer_price <= $${params.length}`;
  }
  if (item.min_discount_pct !== null) {
    params.push(item.min_discount_pct);
    discountClause = `AND o.discount_pct IS NOT NULL AND o.discount_pct >= $${params.length}`;
  }

  const sql = `
    SELECT
      o.id            AS offer_id,
      sk.raw_name,
      sk.brand,
      o.offer_price,
      o.original_price,
      o.discount_pct,
      sk.raw_quantity AS quantita,
      c.name          AS chain_name,
      s.name          AS store_name
    FROM offers o
    JOIN product_skus sk ON sk.id = o.sku_id
    JOIN chains c ON c.id = sk.chain_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE sk.product_id = $2
      AND o.valid_to   >= CURRENT_DATE
      AND o.valid_from <= CURRENT_DATE
      ${priceClause}
      ${discountClause}
      AND NOT EXISTS (
        SELECT 1 FROM shopping_list_notifications sln
        WHERE sln.shopping_list_item_id = $1 AND sln.offer_id = o.id
      )
    ORDER BY o.discount_pct DESC NULLS LAST, o.offer_price ASC
    LIMIT 5
  `;

  const result = await query<Match>(sql, params);
  return result.rows.map(r => ({ ...r, item_id: item.id, telegram_user_id: item.telegram_user_id }));
}

function formatMatch(match: Match, productName: string, productBrand: string | null): string {
  const price = `€${Number(match.offer_price).toFixed(2)}`;
  const origPart = match.original_price
    ? ` ~~€${Number(match.original_price).toFixed(2)}~~`
    : '';
  const discPart = match.discount_pct ? ` *-${Math.round(Number(match.discount_pct))}%*` : '';
  const qtyPart = match.quantita ? ` · ${match.quantita}` : '';
  const storePart = match.store_name ? ` (${match.store_name})` : '';
  // Show the canonical product name in the title, plus the actual SKU name
  // below — this way the alert is tied to the user's mental model ("Spaghetti
  // Barilla 500g") even when the chain SKU label is verbose.
  const headline = productBrand
    ? `*${productBrand}* ${productName}`
    : `*${productName}*`;

  return `\u{1F6D2} ${headline}\n\n` +
    `${match.raw_name}${qtyPart}\n` +
    `${price}${origPart}${discPart}\n` +
    `\u{1F6D2} ${match.chain_name}${storePart}`;
}

async function main() {
  console.log(`=== Shopping-list notifications — ${new Date().toISOString()} ===`);

  const items = await query<ListItem>(`
    SELECT
      sli.id,
      sli.list_id,
      sli.product_id,
      p.name  AS product_name,
      p.brand AS product_brand,
      sli.min_discount_pct,
      sli.max_price,
      up.telegram_user_id::text AS telegram_user_id
    FROM shopping_list_items sli
    JOIN shopping_lists sl ON sl.id = sli.list_id
    JOIN user_profiles up ON up.id = sl.user_profile_id
    JOIN products p ON p.id = sli.product_id
    WHERE sli.notify_enabled = true
  `);

  console.log(`Active list items: ${items.rows.length}`);
  if (items.rows.length === 0) { await close(); return; }

  let totalNotified = 0;

  for (const item of items.rows) {
    const matches = await findMatches(item);
    if (matches.length === 0) continue;

    console.log(`Item #${item.id} (product #${item.product_id} ${item.product_name}) → ${matches.length} new matches`);

    for (const match of matches) {
      const msg = formatMatch(match, item.product_name, item.product_brand);
      await sendTelegram(match.telegram_user_id, msg);

      await query(
        'INSERT INTO shopping_list_notifications (shopping_list_item_id, offer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [match.item_id, match.offer_id],
      );
      totalNotified++;

      // Same conservative rate limit as notify-watches
      await new Promise(r => setTimeout(r, 100));
    }

    await query('UPDATE shopping_list_items SET last_notified_at = now() WHERE id = $1', [item.id]);
  }

  console.log(`Total notifications sent: ${totalNotified}`);
  await close();
}

main().catch(async (err) => {
  console.error('Error:', err);
  await close();
  process.exit(1);
});
