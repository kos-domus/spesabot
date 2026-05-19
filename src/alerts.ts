/**
 * SpesaBot Telegram alerts — sends pipeline status to Kos.
 */

const BOT_TOKEN = process.env.SPESABOT_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.SPESABOT_ADMIN_CHAT_ID;

export async function sendAlert(message: string, level: 'info' | 'warning' | 'critical' = 'info'): Promise<void> {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.error(`[ALERT ${level.toUpperCase()}] ${message}`);
    console.error('SPESABOT_BOT_TOKEN or SPESABOT_ADMIN_CHAT_ID not set — alert logged to stderr only');
    return;
  }

  const prefix = level === 'critical' ? '🔴' : level === 'warning' ? '🟡' : '🟢';
  const text = `${prefix} *SpesaBot*\n\n${message}`;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error(`Failed to send Telegram alert: ${err instanceof Error ? err.message : err}`);
  }
}

export interface PipelineSummary {
  succeeded: Array<{ chain: string; products: number }>;
  failed: Array<{ chain: string; error: string }>;
  durationSeconds: number;
}

export async function sendPipelineSummary(summary: PipelineSummary): Promise<void> {
  const ok = summary.succeeded.length;
  const total = ok + summary.failed.length;
  const level = ok === 0 ? 'critical' : ok < total ? 'warning' : 'info';

  const date = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  const lines = [`*Pipeline ${date}*`, `Status: ${ok}/${total} catene OK`, `Durata: ${summary.durationSeconds}s`, ''];

  for (const s of summary.succeeded) {
    lines.push(`✅ ${s.chain}: ${s.products} prodotti`);
  }
  for (const f of summary.failed) {
    lines.push(`❌ ${f.chain}: ${f.error.slice(0, 80)}`);
  }

  const totalProducts = summary.succeeded.reduce((sum, s) => sum + s.products, 0);
  lines.push('', `Totale: ${totalProducts} offerte caricate`);

  await sendAlert(lines.join('\n'), level);
}
