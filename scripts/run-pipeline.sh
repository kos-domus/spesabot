#!/bin/bash
# SpesaBot pipeline wrapper — used by systemd timer and manual runs.
#
# Sources the cached secrets file (which uses `export KEY=value` syntax,
# not the plain `KEY=value` that systemd's EnvironmentFile= requires) and
# then invokes node. Keeping the shell sourcing out of the .service file
# avoids the "EnvironmentFile doesn't parse bash exports" footgun.

set -euo pipefail

# Resolve the spesabot directory from the script location so the timer
# works regardless of where it was triggered from.
SPESABOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SPESABOT_DIR"

# Load secrets (OPENAI_API_KEY, FIRECRAWL_API_KEY, ZAI_API_KEY, SPESABOT_BOT_TOKEN, ...)
if [[ -f "$HOME/.openclaw/op-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.openclaw/op-env.sh" && source "$HOME/.openclaw/non-secret-config.sh"
fi

# Pipeline defaults (overridable via systemd Environment= directives)
export NODE_ENV="${NODE_ENV:-production}"
export RESEARCH_JOB_TIMEOUT="${RESEARCH_JOB_TIMEOUT:-600000}"
# DATABASE_URL is loaded from op-env.sh (1Password Tech vault, item "Spesabot Postgres DATABASE_URL") — no default here to keep
# credentials out of the repo. Update item in vault Tech if missing.
export DEEP_RESEARCH_DIR="${DEEP_RESEARCH_DIR:-/home/kos/job-desk/tools/deep-research}"
export SPESABOT_BROWSER_PROFILE="${SPESABOT_BROWSER_PROFILE:-$HOME/.spesabot/browser-profile}"

# Open an etl_runs record so /api/admin/runs can surface this attempt
# even if the script crashes mid-flight. trap on EXIT updates with
# success/failed status and registry delta. RUN_TYPE differentiates
# light vs heavy via SPESABOT_RUN_TYPE (set in the heavy systemd unit).
RUN_TYPE="${SPESABOT_RUN_TYPE:-pipeline-light}"
CHAINS_LIST="${SPESABOT_CHAINS:-}"
RUN_ID=$(/usr/bin/node "$SPESABOT_DIR/dist/etl-runs.js" start --type "$RUN_TYPE" 2>/dev/null || echo 0)

record_finish() {
  local status=$1
  local summary
  summary=$(printf '{"chains":"%s","registry_before":"%s","registry_after":"%s"}' \
    "$CHAINS_LIST" \
    "${REGISTRY_SIZE_BEFORE:-?}" \
    "${REGISTRY_SIZE_AFTER:-?}")
  /usr/bin/node "$SPESABOT_DIR/dist/etl-runs.js" finish \
    --id "$RUN_ID" --status "$status" --summary "$summary" 2>/dev/null || true
}
trap 'rc=$?; if [ "$rc" = "0" ]; then record_finish success; else record_finish failed; fi' EXIT

# Snapshot the image registry size BEFORE the run so we can report the
# delta after the trigger has been fed by all the new SKUs. This is the
# accumulator that lets private-label coverage grow week over week —
# Aldi/Despar SKUs that the parser captures with a real image_url today
# stay in the registry forever (even after offers expire).
REGISTRY_SIZE_BEFORE=$(psql "$DATABASE_URL" -tA -c "SELECT COUNT(*) FROM product_image_registry;" 2>/dev/null || echo "?")
echo "[image-registry] size before run: ${REGISTRY_SIZE_BEFORE}"

/usr/bin/node "$SPESABOT_DIR/dist/runner.js" "$@"

REGISTRY_SIZE_AFTER=$(psql "$DATABASE_URL" -tA -c "SELECT COUNT(*) FROM product_image_registry;" 2>/dev/null || echo "?")
echo "[image-registry] size after run:  ${REGISTRY_SIZE_AFTER}"

# Run canonical matching immediately after ingest so cross-chain views are
# usable without waiting for the separate Tue/Thu/Sat 05:00 matching timer.
# Best-effort — a matching failure shouldn't invalidate the ingest itself.
# The LLM-assisted pass (run-matching.sh) still runs on its own schedule for
# fuzzy matches; here we only do the fast rule-based pass.
echo ""
echo "--- Running canonical (rule-based) matching ---"
/usr/bin/node "$SPESABOT_DIR/dist/canonical-match.js" || echo "Canonical matching failed (non-fatal)"

# Back-fill image_url for freshly-ingested SKUs that are missing an image but
# share a canonical product_id with a sibling SKU that has one. Typical case:
# a chain's flyer this week shows product X without a picture (decorative
# placeholder), but another chain or last week's ingest has a real image.
echo ""
echo "--- Back-filling missing images from canonical siblings ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "SELECT 'Images healed (canonical): ' || backfill_missing_images();" \
  || echo "Image backfill (canonical) failed (non-fatal)"

# Cross-chain image registry: looks up any SKU still missing an image
# against the persistent product_image_registry, matching by EAN first,
# then (brand, name, qty) normalized, then name-only as last resort.
# Lets despar/aldi/lidl borrow images first surfaced by famila/migross.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "SELECT 'Images healed (registry): ' || backfill_images_from_registry();" \
  || echo "Image backfill (registry) failed (non-fatal)"

# Purge offers that ended more than 14 days ago and any campaigns left with no
# offers and no price_history references. Keeps the offers table lean (the API
# already filters by valid_to >= today, but stale rows add bloat and slow
# queries). price_history preserves the long-term signal.
# Small grace window (2 days) is safer than 0: if a pipeline run straddles
# midnight between timezones or a flyer's own clock, we don't prematurely
# remove offers that will legitimately be re-ingested in the same run. The
# API enforces valid_to >= CURRENT_DATE for user-facing reads either way, so
# a 2-day internal buffer is invisible to end users.
echo ""
echo "--- Purging expired offers ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA <<'SQL' || echo "Expired-offer cleanup failed (non-fatal)"
SELECT 'Deleted offers: ' || cleanup_expired_offers(2);
SELECT 'Deleted campaigns: ' || cleanup_abandoned_campaigns(2);
SQL

# After pipeline completes, run watchlist + shopping-list notifications.
# Best-effort: a notifier failure shouldn't fail the run since ingest already
# committed and the next run will catch up unsent alerts.
echo ""
echo "--- Running watchlist notifications ---"
/usr/bin/node "$SPESABOT_DIR/dist/notify-watches.js" || echo "Watchlist notifications failed (non-fatal)"

echo ""
echo "--- Running shopping-list notifications ---"
/usr/bin/node "$SPESABOT_DIR/dist/notify-grocery-list.js" || echo "Shopping-list notifications failed (non-fatal)"
