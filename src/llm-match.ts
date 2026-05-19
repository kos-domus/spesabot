/**
 * LLM-assisted canonical product matching.
 *
 * Takes candidate pairs (same brand, different chains, trigram sim > 0.3)
 * and asks an LLM to confirm which are the same product. Merges confirmed
 * matches by linking SKUs to a single canonical product.
 *
 * Uses Gemini Flash for cost efficiency (~134 pairs = 1 API call).
 *
 * Run: DATABASE_URL=... GEMINI_API_KEY=... npx tsx src/llm-match.ts
 */

import { query, getClient, close } from './db.js';
import { startRun, finishRun } from './etl-runs.js';

// LLM provider chain: Z.AI → GPT-5.4 → Gemini
const ZAI_API_KEY = process.env.ZAI_API_KEY;
const ZAI_BASE = 'https://api.z.ai/api/coding/paas/v4';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!ZAI_API_KEY && !OPENAI_API_KEY && !GEMINI_API_KEY) {
  console.error('At least one LLM API key required (ZAI_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)');
  process.exit(1);
}

interface CandidatePair {
  id_a: number;
  name_a: string;
  brand: string;
  chain_a: string;
  qty_a: string | null;
  id_b: number;
  name_b: string;
  chain_b: string;
  qty_b: string | null;
  similarity: number;
}

async function callLLM(prompt: string): Promise<string> {
  // Try Z.AI first, fall back to Gemini
  if (ZAI_API_KEY) {
    try {
      const res = await fetch(`${ZAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'glm-5.1',
          messages: [
            { role: 'system', content: 'You are a precise grocery product matching expert. Output only valid JSON.' },
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
      console.log(`    Z.AI returned ${res.status}, falling back to Gemini...`);
    } catch (err) {
      console.log(`    Z.AI failed (${err instanceof Error ? err.message : err}), falling back to Gemini...`);
    }
  }

  // GPT-5.4 fallback (via OpenAI API / Codex subscription)
  if (OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [
            { role: 'system', content: 'You are a precise grocery product matching expert. Output only valid JSON.' },
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
      console.log(`    GPT-5.4 returned ${res.status}, falling back to Gemini...`);
    } catch (err) {
      console.log(`    GPT-5.4 failed (${err instanceof Error ? err.message : err}), falling back to Gemini...`);
    }
  }

  // Gemini fallback
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

let runId = 0;

async function main() {
  console.log('=== LLM-Assisted Product Matching ===\n');
  try {
    runId = await startRun({ runType: 'matching-llm' });
  } catch (err) {
    console.error(`(etl_runs start failed, continuing without tracking: ${err instanceof Error ? err.message : err})`);
  }

  // Step 1: Find candidate pairs
  console.log('Step 1: Finding candidate pairs...');
  const candidates = await query<CandidatePair>(`
    SELECT DISTINCT ON (LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id))
      p1.id as id_a, p1.name as name_a, p1.brand,
      c1.slug as chain_a, sk1.raw_quantity as qty_a,
      p2.id as id_b, p2.name as name_b,
      c2.slug as chain_b, sk2.raw_quantity as qty_b,
      similarity(lower(p1.name), lower(p2.name)) as similarity
    FROM products p1
    JOIN product_skus sk1 ON sk1.product_id = p1.id
    JOIN chains c1 ON sk1.chain_id = c1.id
    JOIN products p2 ON p2.id > p1.id
      AND p2.brand IS NOT NULL
      AND lower(p2.brand) = lower(p1.brand)
      AND p2.category = p1.category
    JOIN product_skus sk2 ON sk2.product_id = p2.id
    JOIN chains c2 ON sk2.chain_id = c2.id AND c2.id != c1.id
    WHERE p1.brand IS NOT NULL
      AND similarity(lower(p1.name), lower(p2.name)) > 0.3
    ORDER BY LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id), similarity(lower(p1.name), lower(p2.name)) DESC
  `);

  console.log(`  Found ${candidates.rows.length} candidate pairs`);
  if (candidates.rows.length === 0) {
    console.log('  Nothing to match.');
    if (runId) {
      try { await finishRun(runId, { status: 'success', summary: { total_pairs: 0 } }); }
      catch (err) { console.error(`(etl_runs finish failed: ${err instanceof Error ? err.message : err})`); }
    }
    await close();
    return;
  }

  // Step 2: Ask LLM in batches of 30 pairs
  console.log('\nStep 2: Asking LLM to confirm matches (batched)...');

  const BATCH_SIZE = 30;
  const allMatchedIndices: number[] = [];

  for (let batchStart = 0; batchStart < candidates.rows.length; batchStart += BATCH_SIZE) {
    const batch = candidates.rows.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(candidates.rows.length / BATCH_SIZE);
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} pairs)...`);

    const pairsList = batch.map((p, i) =>
      `${i + 1}. "${p.name_a}" (${p.chain_a}, ${p.qty_a ?? '?'}) vs "${p.name_b}" (${p.chain_b}, ${p.qty_b ?? '?'})`
    ).join('\n');

    const prompt = `You are a grocery product matching expert. Below is a list of product pairs from different Italian supermarket chains. For each pair, determine if they are the EXACT SAME product (same brand, same type, same variant, compatible size/quantity).

Rules:
- SAME: identical product sold under different chain names (e.g. "Barilla Spaghetti n.5 500g" and "BARILLA Spaghetti N°5 500g")
- DIFFERENT: different variants, flavors, types, or sizes (e.g. "Spaghetti" vs "Farfalle", "Integrale" vs regular, "500g" vs "1kg")
- When quantity is "?" for both, focus on product type match only
- "Integrale" (whole wheat) is a DIFFERENT product from regular

Respond with ONLY a JSON array of pair numbers that are the SAME product. Example: [1, 5, 12, 23]
If none match, respond with: []

Pairs:
${pairsList}`;

    try {
      const response = await callLLM(prompt);
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        // Convert batch-local indices to global indices
        const globalIndices = parsed
          .filter((n: unknown) => typeof n === 'number')
          .map((n: number) => n + batchStart); // offset to global
        allMatchedIndices.push(...globalIndices);
        console.log(`    → ${globalIndices.length} matches confirmed`);
      }
    } catch (err) {
      console.error(`    → batch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n  Total LLM-confirmed matches: ${allMatchedIndices.length} out of ${candidates.rows.length} pairs`);

  const matchedIndices = allMatchedIndices;

  if (matchedIndices.length === 0) {
    console.log('  No matches to apply.');
    if (runId) {
      try {
        await finishRun(runId, {
          status: 'success',
          summary: { total_pairs: candidates.rows.length, llm_confirmed: 0 },
        });
      } catch (err) {
        console.error(`(etl_runs finish failed: ${err instanceof Error ? err.message : err})`);
      }
    }
    await close();
    return;
  }

  // Step 3: Merge matched products
  console.log('\nStep 3: Merging matched products...');

  const client = await getClient();
  // candidates.rows is a snapshot from before the loop. Once we merge B into A,
  // a later pair referencing B as its "keep" side would FK-violate. Track the
  // redirect chain in-memory and resolve both sides before each merge.
  const redirects = new Map<number, number>();
  const resolve = (id: number): number => {
    let cur = id;
    const seen = new Set<number>();
    while (redirects.has(cur)) {
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = redirects.get(cur)!;
    }
    return cur;
  };

  let merged = 0;
  let skippedAlreadyMerged = 0;
  let skippedErrors = 0;

  try {
    await client.query('BEGIN');

    for (const idx of matchedIndices) {
      const pair = candidates.rows[idx - 1]; // 1-indexed
      if (!pair) continue;

      const resolvedA = resolve(pair.id_a);
      const resolvedB = resolve(pair.id_b);

      if (resolvedA === resolvedB) {
        skippedAlreadyMerged++;
        continue;
      }

      // Stable canonical = lower id, matching the SQL invariant id_a < id_b
      const keepId = Math.min(resolvedA, resolvedB);
      const mergeId = Math.max(resolvedA, resolvedB);
      const viaRedirect = keepId !== pair.id_a || mergeId !== pair.id_b;

      await client.query('SAVEPOINT merge_step');
      try {
        const updated = await client.query(
          'UPDATE product_skus SET product_id = $1 WHERE product_id = $2',
          [keepId, mergeId],
        );

        const remaining = await client.query(
          'SELECT COUNT(*) as cnt FROM product_skus WHERE product_id = $1',
          [mergeId],
        );
        if (parseInt(remaining.rows[0].cnt) === 0) {
          await client.query('DELETE FROM products WHERE id = $1', [mergeId]);
        }

        await client.query('RELEASE SAVEPOINT merge_step');
        redirects.set(mergeId, keepId);

        const tag = viaRedirect ? '*' : '';
        console.log(`  Merged${tag}: "${pair.name_b}" (${pair.chain_b}) → "${pair.name_a}" (${pair.chain_a}) [${updated.rowCount} SKUs moved]`);
        merged++;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_step');
        await client.query('RELEASE SAVEPOINT merge_step');
        skippedErrors++;
        console.error(`  Skipped: "${pair.name_b}" → "${pair.name_a}" (keep=${keepId}, merge=${mergeId}) — ${err instanceof Error ? err.message : err}`);
      }
    }

    await client.query('COMMIT');
    console.log(`\n  Summary: merged=${merged}, skipped_already_merged=${skippedAlreadyMerged}, skipped_errors=${skippedErrors}`);

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection-level failure, nothing to rollback */ }
    throw err;
  } finally {
    client.release();
  }

  // Step 4: Report
  const crossChain = await query<{ count: number }>(`
    SELECT COUNT(*)::int as count FROM (
      SELECT p.id FROM products p
      JOIN product_skus sk ON sk.product_id = p.id
      GROUP BY p.id HAVING COUNT(DISTINCT sk.chain_id) >= 2
    ) x
  `);
  console.log(`\n  Cross-chain products now: ${crossChain.rows[0].count}`);

  if (runId) {
    try {
      await finishRun(runId, {
        status: 'success',
        summary: {
          total_pairs: candidates.rows.length,
          llm_confirmed: matchedIndices.length,
          merged,
          skipped_already_merged: skippedAlreadyMerged,
          skipped_errors: skippedErrors,
          cross_chain_products: crossChain.rows[0].count,
        },
      });
    } catch (err) {
      console.error(`(etl_runs finish failed: ${err instanceof Error ? err.message : err})`);
    }
  }

  await close();
}

main().catch(async (err) => {
  console.error('Error:', err);
  if (runId) {
    try {
      await finishRun(runId, {
        status: 'failed',
        errorTail: (err instanceof Error ? err.stack ?? err.message : String(err)).slice(-2000),
      });
    } catch { /* swallow — already in error path */ }
  }
  await close();
  process.exit(1);
});
