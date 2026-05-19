#!/usr/bin/env npx tsx
/**
 * LLM batch categorization fallback. Picks up products still in 'altro'
 * after the rule-based pass (`scripts/recategorize-products.ts`) and asks
 * an LLM to assign each one to one of the 18 taxonomy categories.
 *
 * Same provider chain as src/llm-match.ts: ZAI → OpenAI → Gemini.
 *
 * Usage:
 *   DATABASE_URL=... ZAI_API_KEY=... npx tsx scripts/categorize-products-llm.ts
 *   DATABASE_URL=... GEMINI_API_KEY=... npx tsx scripts/categorize-products-llm.ts --dry-run
 *   ... --limit 100   # process only first 100 (for testing)
 *   ... --batch 30    # batch size (default 40)
 */

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const ZAI_API_KEY = process.env.ZAI_API_KEY;
const ZAI_BASE = 'https://api.z.ai/api/coding/paas/v4';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!ZAI_API_KEY && !OPENAI_API_KEY && !GEMINI_API_KEY) {
  console.error('Need at least one of ZAI_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY');
  process.exit(1);
}

async function callLLM(prompt: string): Promise<string> {
  if (ZAI_API_KEY) {
    try {
      const res = await fetch(`${ZAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ZAI_API_KEY}` },
        body: JSON.stringify({
          model: 'glm-5.1',
          messages: [
            { role: 'system', content: 'You are a precise Italian grocery taxonomy expert. Output only valid JSON.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
      }
      console.log(`    Z.AI returned ${res.status}, falling back...`);
    } catch (err) {
      console.log(`    Z.AI failed (${err instanceof Error ? err.message : err}), falling back...`);
    }
  }

  if (OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [
            { role: 'system', content: 'You are a precise Italian grocery taxonomy expert. Output only valid JSON.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_completion_tokens: 4096,
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
      }
      console.log(`    GPT-5.4 returned ${res.status}, falling back...`);
    } catch (err) {
      console.log(`    GPT-5.4 failed (${err instanceof Error ? err.message : err}), falling back...`);
    }
  }

  if (!GEMINI_API_KEY) throw new Error('No LLM API available');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096 },
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// Strip code fences if the model wraps JSON in ```json ... ```
function stripFences(s: string): string {
  return s.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

interface ProductRow {
  id: number;
  name: string;
  brand: string | null;
  description: string | null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find(a => a.startsWith('--limit'));
  const batchArg = process.argv.find(a => a.startsWith('--batch'));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1], 10) : 0;
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1] || process.argv[process.argv.indexOf(batchArg) + 1], 10) : 40;

  console.log(`[llm-cat] mode=${dryRun ? 'DRY-RUN' : 'APPLY'} batch=${batchSize}${limit ? ` limit=${limit}` : ''}`);

  // Load taxonomy
  const catRes = await pool.query<{ id: number; slug: string; name_it: string }>(
    `SELECT id, slug, name_it FROM product_categories WHERE slug != 'altro' ORDER BY sort_order`,
  );
  const slugToId = new Map(catRes.rows.map(r => [r.slug, r.id]));
  const slugList = catRes.rows.map(r => `  - ${r.slug} (${r.name_it})`).join('\n');

  // Fetch products
  const productsRes = await pool.query<ProductRow>(
    `SELECT id, name, brand, description FROM products WHERE category = 'altro' ORDER BY id ${limit ? `LIMIT ${limit}` : ''}`,
  );
  console.log(`[llm-cat] ${productsRes.rows.length} products to classify`);

  const batches: ProductRow[][] = [];
  for (let i = 0; i < productsRes.rows.length; i += batchSize) {
    batches.push(productsRes.rows.slice(i, i + batchSize));
  }
  console.log(`[llm-cat] ${batches.length} batches of ~${batchSize}\n`);

  const updates: { id: number; slug: string }[] = [];
  const unmatched: number[] = [];
  let batchIdx = 0;

  for (const batch of batches) {
    batchIdx++;
    const productLines = batch.map(r => {
      const parts = [`#${r.id}`, r.brand || '(no-brand)', r.name];
      if (r.description) parts.push(`[${r.description.slice(0, 60)}]`);
      return parts.join(' | ');
    }).join('\n');

    const prompt = `Classify each Italian grocery product into ONE category slug from this list:
${slugList}

If no category fits, use "altro".

Products (format: #id | brand | name | [optional description]):
${productLines}

Return a JSON array of objects, one per product:
[{"id": <product_id>, "slug": "<category_slug>"}, ...]

Output ONLY the JSON array, no prose, no markdown fences.`;

    try {
      const raw = await callLLM(prompt);
      const cleaned = stripFences(raw);
      const parsed = JSON.parse(cleaned) as { id: number; slug: string }[];
      let okCount = 0;
      for (const p of parsed) {
        if (!p.id || !p.slug) continue;
        if (p.slug === 'altro' || !slugToId.has(p.slug)) {
          unmatched.push(p.id);
          continue;
        }
        updates.push(p);
        okCount++;
      }
      console.log(`[llm-cat] batch ${batchIdx}/${batches.length}: ${okCount}/${batch.length} classified`);
    } catch (err) {
      console.error(`[llm-cat] batch ${batchIdx}/${batches.length} failed: ${err instanceof Error ? err.message : err}`);
      for (const r of batch) unmatched.push(r.id);
    }

    // Small delay to be friendly to API rate limits
    if (batchIdx < batches.length) await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  console.log(`\n[llm-cat] summary:`);
  const bySlug = new Map<string, number>();
  for (const u of updates) bySlug.set(u.slug, (bySlug.get(u.slug) || 0) + 1);
  const sorted = [...bySlug.entries()].sort((a, b) => b[1] - a[1]);
  for (const [slug, n] of sorted) {
    console.log(`  ${slug.padEnd(20)} ${n.toString().padStart(5)} products`);
  }
  console.log(`  ${'(unmatched)'.padEnd(20)} ${unmatched.length.toString().padStart(5)} products → stay in 'altro'`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${productsRes.rows.length.toString().padStart(5)} scanned`);

  if (dryRun || updates.length === 0) {
    console.log(`\n[llm-cat] no DB writes (${dryRun ? 'dry-run' : 'nothing to update'}).`);
    return;
  }

  // Apply updates grouped by slug
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idsBySlug = new Map<string, number[]>();
    for (const u of updates) {
      if (!idsBySlug.has(u.slug)) idsBySlug.set(u.slug, []);
      idsBySlug.get(u.slug)!.push(u.id);
    }
    for (const [slug, ids] of idsBySlug) {
      const catId = slugToId.get(slug)!;
      const res = await client.query(
        `UPDATE products SET category = $1, category_id = $2, updated_at = NOW()
          WHERE id = ANY($3::int[]) AND category = 'altro'`,
        [slug, catId, ids],
      );
      console.log(`  UPDATE ${slug.padEnd(20)} → ${res.rowCount} rows`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n[llm-cat] applied.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => pool.end());
