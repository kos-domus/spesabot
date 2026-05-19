#!/bin/bash
# SpesaBot — Install systemd user timers for automated scraping + matching
#
# Schedules:
#   pipeline: Tue 03:00 + Fri 03:00 (scrape all chains)
#   matching: Tue 05:00 + Thu 05:00 + Sat 05:00 (canonical + LLM matching)
# Runs as user services, no root needed.
#
# Usage:
#   ./scripts/install-systemd-timer.sh
#   systemctl --user enable --now spesabot-pipeline.timer spesabot-matching.timer
#   systemctl --user list-timers 'spesabot-*'
#   journalctl --user -u spesabot-pipeline.service -f

set -e

SPESABOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# --- Service: runs the pipeline once ---
# Uses scripts/run-pipeline.sh wrapper because op-env.sh + non-secret-config.sh are bash scripts
# (uses `export KEY=value`), not a systemd EnvironmentFile (plain KEY=value).
cat > "$SYSTEMD_DIR/spesabot-pipeline.service" <<EOF
[Unit]
Description=SpesaBot weekly scraping pipeline
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$SPESABOT_DIR
ExecStart=$SPESABOT_DIR/scripts/run-pipeline.sh
TimeoutStartSec=3600
StandardOutput=journal
StandardError=journal
# Resource limits — protect the mini PC under heavy load
MemoryMax=2G
MemoryHigh=1500M
CPUQuota=80%
EOF

# --- Timer: triggers the service twice per week ---
cat > "$SYSTEMD_DIR/spesabot-pipeline.timer" <<EOF
[Unit]
Description=SpesaBot bi-weekly scraping (Tue + Fri 03:00)

[Timer]
# Tuesday 03:00 — catches Aldi (Mon) + Famila (Mon/Tue) new flyers
# Friday 03:00  — catches Lidl (Thu) + Despar (Wed/Thu) new flyers
OnCalendar=Tue 03:00
OnCalendar=Fri 03:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

# --- Service: runs the matching once (canonical rule-based + LLM verify) ---
# TimeoutStartSec sized for ~56 batches × ~45-90s each (Z.AI 500 → Gemini fallback
# can double per-batch wall time). 7200s = 120 min gives ~25% headroom.
cat > "$SYSTEMD_DIR/spesabot-matching.service" <<EOF
[Unit]
Description=SpesaBot product matching (canonical + LLM)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$SPESABOT_DIR
ExecStart=$SPESABOT_DIR/scripts/run-matching.sh
TimeoutStartSec=7200
StandardOutput=journal
StandardError=journal
# Matching is LLM-bound, not CPU-bound — modest limits are fine
MemoryMax=512M
CPUQuota=50%
EOF

# --- Timer: triggers matching three times per week ---
cat > "$SYSTEMD_DIR/spesabot-matching.timer" <<EOF
[Unit]
Description=SpesaBot product matching (Tue/Thu/Sat 05:00)

[Timer]
# Tuesday 05:00  — after Tue 03:00 pipeline run, matches new Aldi/Famila products
# Thursday 05:00 — mid-week run, catches any manual re-ingests
# Saturday 05:00 — after Fri 03:00 pipeline run, matches new Lidl/Despar products
OnCalendar=Tue 05:00
OnCalendar=Thu 05:00
OnCalendar=Sat 05:00
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
echo "Installed:"
echo "  $SYSTEMD_DIR/spesabot-pipeline.service"
echo "  $SYSTEMD_DIR/spesabot-pipeline.timer"
echo "  $SYSTEMD_DIR/spesabot-matching.service"
echo "  $SYSTEMD_DIR/spesabot-matching.timer"
echo ""
echo "To activate:"
echo "  systemctl --user enable --now spesabot-pipeline.timer spesabot-matching.timer"
echo ""
echo "To trigger once manually:"
echo "  systemctl --user start spesabot-pipeline.service"
echo "  systemctl --user start spesabot-matching.service"
echo ""
echo "To watch logs:"
echo "  journalctl --user -u spesabot-pipeline.service -f"
echo "  journalctl --user -u spesabot-matching.service -f"
echo ""
echo "Next scheduled runs:"
systemctl --user list-timers 'spesabot-*' 2>/dev/null || echo "  (timers not yet enabled)"
