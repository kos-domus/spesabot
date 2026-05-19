#!/bin/bash
# SpesaBot product matching — run canonical + LLM matching.
# Scheduled via systemd timer (Mon/Wed/Fri after pipeline run).

set -euo pipefail

SPESABOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SPESABOT_DIR"

# Load secrets
if [[ -f "$HOME/.openclaw/op-env.sh" ]]; then
  source "$HOME/.openclaw/op-env.sh" && source "$HOME/.openclaw/non-secret-config.sh"
fi

export NODE_ENV="${NODE_ENV:-production}"

echo "=== SpesaBot Product Matching — $(date) ==="

# Step 1: Rule-based canonical matching (fast, handles new SKUs)
echo ""
echo "--- Rule-based matching ---"
/usr/bin/node "$SPESABOT_DIR/dist/canonical-match.js"

# Step 2: LLM-assisted matching (catches fuzzy cross-chain matches)
echo ""
echo "--- LLM-assisted matching ---"
/usr/bin/node "$SPESABOT_DIR/dist/llm-match.js"

echo ""
echo "=== Matching complete — $(date) ==="
