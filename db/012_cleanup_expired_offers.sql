-- Automated cleanup of expired offers.
--
-- Offers that ended more than a grace period ago (default 14 days) are
-- redundant: the API already filters by valid_to >= CURRENT_DATE, and
-- price_history preserves the long-term pricing signal. Keeping stale rows
-- around only adds table bloat and makes debugging harder.
--
-- The grace window is deliberately generous so:
--   - Users scrolling "last week's offers" views still see recent data.
--   - A failed pipeline re-ingest the following week isn't penalised.
--
-- Invoked from scripts/run-pipeline.sh after each ingest.

CREATE OR REPLACE FUNCTION cleanup_expired_offers(grace_days INTEGER DEFAULT 14) RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
  cutoff DATE;
BEGIN
  cutoff := CURRENT_DATE - (grace_days || ' days')::interval;
  DELETE FROM offers WHERE valid_to < cutoff;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Also drop flyer_campaigns rows that ended more than `grace_days` ago AND
-- have no remaining offers (so no data is lost). price_history keeps its
-- campaign_id FK pointing to pre-existing campaigns via
-- ON DELETE RESTRICT semantics — we only delete campaigns with zero offers
-- AND zero price_history references, which are genuinely abandoned.
CREATE OR REPLACE FUNCTION cleanup_abandoned_campaigns(grace_days INTEGER DEFAULT 14) RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
  cutoff DATE;
BEGIN
  cutoff := CURRENT_DATE - (grace_days || ' days')::interval;
  DELETE FROM flyer_campaigns fc
    WHERE fc.valid_to < cutoff
      AND NOT EXISTS (SELECT 1 FROM offers WHERE campaign_id = fc.id)
      AND NOT EXISTS (SELECT 1 FROM price_history WHERE campaign_id = fc.id);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
