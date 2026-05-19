#!/usr/bin/env bash
# Wrapper one-liner per manual-image-fill.ts.
#
# Lancia il CLI interattivo per riempire le immagini mancanti di una
# specifica chain. Va eseguito sull'host che ha accesso al DATABASE_URL
# (locale o via SSH al server DB).
#
# Usage:
#   ./scripts/fill.sh <chain>
#
# Dove <chain> è uno tra: despar, aldi, esselunga, lidl, eurospin,
# migross, famila, conad, crai, dpiu, md, rossetto.
set -euo pipefail

CHAIN="${1:-}"
if [[ -z "$CHAIN" ]]; then
  echo "Usage: $0 <chain>" >&2
  echo "Chains: despar aldi esselunga lidl eurospin migross famila conad crai dpiu md rossetto" >&2
  exit 1
fi

SPESABOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SPESABOT_DIR"

# shellcheck disable=SC1091
source "$HOME/.openclaw/op-env.sh" && source "$HOME/.openclaw/non-secret-config.sh"

exec /usr/bin/node "$SPESABOT_DIR/dist/manual-image-fill.js" "$CHAIN"
