-- 021_etl_runs.sql
--
-- Run history for ETL/matching scripts. Closes the observability gap left
-- by spesabot-monitor (which reports unit-level state but not per-script
-- outcome metrics). Without this table we cannot answer:
--   - "did Tuesday's pipeline-light run actually finish all chains?"
--   - "how many merges did the last LLM matching attempt commit before
--     the FK violation rolled it back?"
--   - "is matching-rule slowing down over time?"
--
-- Schema is deliberately wide-and-flexible: status as text, summary as
-- jsonb so each run_type can record whatever metrics make sense without
-- a migration per metric.

CREATE TABLE IF NOT EXISTS etl_runs (
  id           BIGSERIAL PRIMARY KEY,
  -- pipeline-light | pipeline-heavy | matching-rule | matching-llm | (future: per-chain)
  run_type     TEXT        NOT NULL,
  -- nullable; populated only when a row represents a single chain inside
  -- a pipeline run (e.g. future per-chain breakdown from runner.ts).
  chain        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  -- running | success | failed | timeout
  status       TEXT        NOT NULL DEFAULT 'running',
  -- arbitrary metrics: { merged: 89, skipped_already_merged: 4, skipped_errors: 1 }
  --                    { products_in: 1249, products_out: 709, stores: 2 }
  summary      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- last few lines of the error / journal tail when status='failed'
  error_tail   TEXT,
  -- pid of the recording process — useful to disambiguate concurrent runs
  -- in dev (cron + manual invocation overlapping)
  pid          INT
);

-- Lookup index for "give me the last 20 runs of run_type X (optionally
-- filtered by chain)" — the dominant access pattern from the API endpoint.
CREATE INDEX IF NOT EXISTS idx_etl_runs_type_started
  ON etl_runs (run_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_etl_runs_chain_started
  ON etl_runs (chain, started_at DESC)
  WHERE chain IS NOT NULL;

-- Backstop: a run row stuck in 'running' with started_at older than a few
-- hours is a crashed process. The view surfaces it for the API endpoint
-- so we don't have to compute "stuckness" client-side.
CREATE OR REPLACE VIEW v_etl_runs_recent AS
SELECT
  r.*,
  EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at))::int AS duration_sec,
  CASE
    WHEN r.status = 'running' AND r.started_at < now() - interval '2 hours'
      THEN true
    ELSE false
  END AS likely_stuck
FROM etl_runs r
ORDER BY r.started_at DESC;

COMMENT ON TABLE etl_runs IS
  'Per-script ETL/matching run history. Written by record-run.ts at start
  and update at finish. Read by /api/admin/runs and the optional
  per-script summary in /api/admin/health.';
