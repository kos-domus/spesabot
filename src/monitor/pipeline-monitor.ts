/**
 * Pipeline monitor: watches spesabot-*.service systemd units and DMs the
 * owner on Telegram when one transitions to failed (or fails again with a
 * different ExecMainExitTimestamp from the last notified failure).
 *
 * Also writes a state JSON the API endpoint /api/admin/health reads from,
 * so the operational dashboard always reflects current systemd reality
 * without the API process needing to shell out to systemctl itself.
 *
 * Run: SPESABOT_BOT_TOKEN=... SPESABOT_OWNER_TG_ID=... node dist/monitor/pipeline-monitor.js
 * Scheduled via spesabot-monitor.timer (every 15 min).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);

const UNITS = [
  'spesabot-api.service',
  'spesabot-bot.service',
  'spesabot-matching.service',
  'spesabot-pipeline.service',
  'spesabot-pipeline-heavy.service',
];

const STATE_PATH = join(homedir(), '.cache', 'spesabot-monitor', 'state.json');

const BOT_TOKEN = process.env.SPESABOT_BOT_TOKEN;
const OWNER_ID = process.env.SPESABOT_OWNER_TG_ID;

interface UnitState {
  unit: string;
  activeState: string;        // active, inactive, failed, activating, ...
  subState: string;           // running, dead, exited, failed, ...
  result: string;             // success, exit-code, signal, timeout, ...
  lastExitTimestamp: string;  // ISO or empty when never executed
  lastExitStatus: string;     // numeric exit code as string
  observedAt: string;         // ISO of this poll
}

interface MonitorState {
  units: Record<string, UnitState>;
  lastNotifiedFailure: Record<string, string>; // unit → ExecMainExitTimestamp we already DM'd about
}

async function showUnit(unit: string): Promise<UnitState> {
  // systemctl show returns Key=Value lines, one per requested property.
  // Using --property keeps the output narrow and parser-friendly.
  const { stdout } = await exec('systemctl', [
    '--user', 'show', unit,
    '--property=ActiveState,SubState,Result,ExecMainExitTimestamp,ExecMainStatus',
  ]);
  const kv: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    kv[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return {
    unit,
    activeState: kv.ActiveState ?? 'unknown',
    subState: kv.SubState ?? 'unknown',
    result: kv.Result ?? 'unknown',
    lastExitTimestamp: kv.ExecMainExitTimestamp ?? '',
    lastExitStatus: kv.ExecMainStatus ?? '',
    observedAt: new Date().toISOString(),
  };
}

async function tailJournal(unit: string, lines = 12): Promise<string> {
  try {
    const { stdout } = await exec('journalctl', [
      '--user', '-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat',
    ]);
    return stdout.trim();
  } catch (err) {
    return `(journalctl unavailable: ${err instanceof Error ? err.message : err})`;
  }
}

async function sendTelegram(text: string): Promise<boolean> {
  if (!BOT_TOKEN || !OWNER_ID) {
    console.error('SPESABOT_BOT_TOKEN or SPESABOT_OWNER_TG_ID missing — skip DM');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Telegram sendMessage threw: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function loadState(): Promise<MonitorState> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      units: parsed.units ?? {},
      lastNotifiedFailure: parsed.lastNotifiedFailure ?? {},
    };
  } catch {
    return { units: {}, lastNotifiedFailure: {} };
  }
}

async function saveState(state: MonitorState): Promise<void> {
  await fs.mkdir(dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
  const previous = await loadState();
  const next: MonitorState = {
    units: {},
    lastNotifiedFailure: { ...previous.lastNotifiedFailure },
  };

  const candidateFailures: UnitState[] = [];

  for (const unit of UNITS) {
    let state: UnitState;
    try {
      state = await showUnit(unit);
    } catch (err) {
      console.error(`failed to show ${unit}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    next.units[unit] = state;

    const isFailed = state.activeState === 'failed';
    if (!isFailed) {
      // Clear the notified marker so a future failure is treated as new.
      delete next.lastNotifiedFailure[unit];
      continue;
    }

    const alreadyNotified = previous.lastNotifiedFailure[unit] === state.lastExitTimestamp;
    if (!alreadyNotified) {
      candidateFailures.push(state);
    }
  }

  // Send DMs first; only mark a failure as notified once Telegram confirms.
  // This avoids the worst case where we save the "already notified" marker
  // but Telegram was down → user never sees the alert.
  for (const state of candidateFailures) {
    const tail = await tailJournal(state.unit, 12);
    const msg =
      `🚨 <b>${escapeHtml(state.unit)}</b> failed\n` +
      `state: ${escapeHtml(state.activeState)}/${escapeHtml(state.subState)}, result: ${escapeHtml(state.result)}, exit: ${escapeHtml(state.lastExitStatus)}\n` +
      `at: ${escapeHtml(state.lastExitTimestamp || 'unknown')}\n\n` +
      `<pre>${escapeHtml(tail).slice(0, 2500)}</pre>\n\n` +
      `<code>journalctl --user -u ${escapeHtml(state.unit)} -n 50</code>`;
    const sent = await sendTelegram(msg);
    if (sent) {
      next.lastNotifiedFailure[state.unit] = state.lastExitTimestamp;
      console.log(`DM sent for ${state.unit} (exit at ${state.lastExitTimestamp})`);
    } else {
      console.log(`DM NOT sent for ${state.unit} (will retry next tick)`);
    }
  }

  await saveState(next);

  if (candidateFailures.length === 0) {
    console.log(`OK — ${Object.keys(next.units).length} units checked, no new failures`);
  }
}

main().catch((err) => {
  console.error('monitor crashed:', err);
  process.exit(1);
});
