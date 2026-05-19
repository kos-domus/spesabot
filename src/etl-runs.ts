/**
 * ETL/matching run history — library + CLI.
 *
 * Library API (called from inside Node scripts that already have a DB
 * connection): startRun() / finishRun() to bracket a run with summary
 * metrics and optional error tail.
 *
 * CLI mode (called from bash wrappers like run-pipeline.sh):
 *   node dist/etl-runs.js start  --type matching-llm [--chain X]
 *     → prints the new run id to stdout
 *   node dist/etl-runs.js finish --id <id> --status success [--summary JSON]
 *   node dist/etl-runs.js finish --id <id> --status failed  --error-tail '...'
 *
 * The CLI swallows DB errors and prints a fallback id of 0 so a flaky
 * record DB never breaks the upstream pipeline. The pipeline is the
 * source of value; observability is best-effort.
 */

import { query } from './db.js';

export type RunStatus = 'running' | 'success' | 'failed' | 'timeout';

export interface StartRunInput {
  runType: string;
  chain?: string | null;
  pid?: number | null;
}

export interface FinishRunInput {
  status: Exclude<RunStatus, 'running'>;
  summary?: Record<string, unknown>;
  errorTail?: string | null;
}

export async function startRun(input: StartRunInput): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO etl_runs (run_type, chain, pid)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.runType, input.chain ?? null, input.pid ?? process.pid],
  );
  return res.rows[0].id;
}

export async function finishRun(id: number, input: FinishRunInput): Promise<void> {
  await query(
    `UPDATE etl_runs
        SET finished_at = now(),
            status      = $2,
            summary     = COALESCE(summary, '{}'::jsonb) || $3::jsonb,
            error_tail  = $4
      WHERE id = $1`,
    [id, input.status, JSON.stringify(input.summary ?? {}), input.errorTail ?? null],
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, 'true');
    }
  }
  return out;
}

async function cli() {
  const [, , verb, ...rest] = process.argv;
  const args = parseArgs(rest);

  try {
    if (verb === 'start') {
      const runType = args.get('type');
      if (!runType) {
        console.error('--type required');
        process.exit(2);
      }
      const id = await startRun({
        runType,
        chain: args.get('chain') ?? null,
      });
      console.log(id);
    } else if (verb === 'finish') {
      const idStr = args.get('id');
      const status = args.get('status') as Exclude<RunStatus, 'running'> | undefined;
      if (!idStr || !status) {
        console.error('--id and --status required');
        process.exit(2);
      }
      const id = parseInt(idStr, 10);
      if (Number.isNaN(id) || id <= 0) {
        // Fallback id from a previously-failed start — silently ignore.
        process.exit(0);
      }
      let summary: Record<string, unknown> | undefined;
      const summaryRaw = args.get('summary');
      if (summaryRaw) {
        try { summary = JSON.parse(summaryRaw); }
        catch { console.error(`bad --summary JSON, ignored: ${summaryRaw}`); }
      }
      await finishRun(id, {
        status,
        summary,
        errorTail: args.get('error-tail') ?? null,
      });
    } else {
      console.error(`unknown verb: ${verb} (expected: start | finish)`);
      process.exit(2);
    }
  } catch (err) {
    // Best-effort: never let the recorder break the pipeline.
    console.error(`etl-runs ${verb} failed: ${err instanceof Error ? err.message : err}`);
    if (verb === 'start') {
      // Print fallback id so the bash caller can still capture it cleanly.
      console.log('0');
    }
    process.exit(0);
  }

  // Close PG pool so node exits cleanly.
  const { close } = await import('./db.js');
  await close();
}

// Only run CLI when invoked directly, not when imported.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('etl-runs.js') || entry.endsWith('etl-runs.ts');
  } catch { return false; }
})();

if (invokedDirectly) {
  cli();
}
