#!/usr/bin/env node
// usage-tee.mjs — a statusLine command that tees Claude Code's plan-usage
// numbers to a file the viewer can read, and prints a compact status line.
//
// Claude Code invokes the configured statusLine command with a JSON payload
// on stdin on every refresh (new message, /compact, timers). That payload's
// `rate_limits` object is the only documented place the subscription's
// 5-hour and weekly windows appear (used_percentage + resets_at per window),
// so this tee is the viewer's whole data source for the persona card's
// usage bar. Wiring it is a per-machine settings.json choice the hub's
// person makes:
//
//   "statusLine": { "type": "command",
//     "command": "node <machinery>/usage-tee.mjs --out <hub>/wakecycle/usage.json" }
//
// Contract (usage-tee-test.mjs pins each point):
// - NEVER breaks the statusline: every input, malformed included, exits 0
//   and prints exactly one line.
// - Writes atomically (tmp + rename) and creates the parent dir, so a
//   concurrent reader sees the old file or the new one, never half of one.
// - Passes rate_limits through VERBATIM: the window set is Claude Code's,
//   not ours, so a window this script has never heard of still reaches the
//   viewer (the forward-compat door for any Fable-specific window).
// - Malformed input leaves the out file untouched: stale truth beats
//   fresh garbage, and the file's own `at` stamp carries its age.
// - No --out means print-only: the statusline half works before anyone
//   decides where the file should live.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readStdin() {
  const chunks = [];
  return new Promise((resolve) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

// Short labels for the windows the docs name today; an unknown key falls
// back to itself so a new window still shows up, just unprettily.
const LABEL = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' };

function line(payload) {
  const parts = [];
  const model = payload?.model?.display_name || payload?.model?.id;
  if (model) parts.push(model);
  const rl = payload?.rate_limits;
  if (rl && typeof rl === 'object') {
    for (const [key, w] of Object.entries(rl)) {
      const pct = w?.used_percentage;
      if (typeof pct === 'number') parts.push(`${LABEL[key] ?? key} ${Math.round(pct)}%`);
    }
  }
  return parts.length ? parts.join(' · ') : 'nightwatch usage-tee';
}

const main = async () => {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : null;

  const raw = await readStdin();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* malformed: print-only */ }

  if (payload && typeof payload === 'object' && out) {
    try {
      const doc = {
        at: new Date().toISOString(),
        provider: 'anthropic',
        source: 'statusline',
        session_id: payload.session_id ?? null,
        version: payload.version ?? null,
        model: payload.model?.id ?? null,
        rate_limits: payload.rate_limits ?? null,
      };
      mkdirSync(dirname(out), { recursive: true });
      const tmp = join(dirname(out), `.usage-tee.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(doc) + '\n');
      renameSync(tmp, out);
    } catch { /* a write problem must not break the statusline */ }
  }

  process.stdout.write(line(payload) + '\n');
  process.exit(0);
};

main();
