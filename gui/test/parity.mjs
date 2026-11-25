#!/usr/bin/env node
// Byte-parity harness: gui/emitter.mjs vs skins/build_fixture.py.
// Acceptance for the Phase B port (opus's spec): the frozen fixture, live
// snapshots at every range, and a quiet night must render IDENTICALLY
// through both emitters. Any diff is a bug in the port (or a drift in the
// python) — there is no "close enough" here, because two emitters that
// differ by a byte will differ by a feature within a week.
//
//   node gui/test/parity.mjs          all cases
//   node gui/test/parity.mjs frozen   one case
//
// Written by: claude-fable-5, 2026-10-06
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, mergeSnapshot } from '../emitter.mjs';
import { FIXTURE } from '../fixture-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI = join(HERE, '..');
const SKINS = join(GUI, '..', 'skins');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

// Cross-check: fixture-data's frozen SKINS list vs what the python will
// read from disk (skins_installed). If a skin lands or renames, this fails
// first with a clear message instead of a mysterious byte diff.
const SKIN_ORDER = ['minimal', 'glass', 'amber', 'metal', 'wacky', 'steampunk', 'concrete'];
function skinsFromDisk() {
  const found = [];
  for (const d of readdirSync(SKINS).sort()) {
    try {
      const m = join(SKINS, d, 'manifest.json');
      statSync(m); statSync(join(SKINS, d, 'skin.css'));
      found.push([d, JSON.parse(readFileSync(m, 'utf8')).title ?? d]);
    } catch {}
  }
  const rank = Object.fromEntries(SKIN_ORDER.map((n, i) => [n, i]));
  return found.sort((a, b) => (rank[a[0]] ?? SKIN_ORDER.length) - (rank[b[0]] ?? SKIN_ORDER.length) || (a[0] < b[0] ? -1 : 1));
}

function pythonRender(snapPath) {
  const args = [join(SKINS, 'build_fixture.py')];
  if (snapPath) args.push('--data', snapPath);
  args.push('--out', '-');
  return execFileSync('python3', args, { encoding: 'utf8', cwd: SKINS, maxBuffer: 64 * 1024 * 1024 });
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function diffReport(name, py, js) {
  const i = firstDiff(py, js);
  if (i === -1) return null;
  const from = Math.max(0, i - 80);
  return `  first diff at byte ${i} (py ${py.length}B, js ${js.length}B)\n` +
    `  py: …${JSON.stringify(py.slice(from, i + 80))}\n` +
    `  js: …${JSON.stringify(js.slice(from, i + 80))}`;
}

const CASES = {
  frozen: () => ({ snap: null }),
  live_8h: () => ({ live: '8h' }), live_24h: () => ({ live: '24h' }),
  live_3d: () => ({ live: '3d' }), live_7d: () => ({ live: '7d' }),
  daemon_down: () => ({
    snap: {
      NOW: '2026-10-06T12:30-07:00',
      SCHEDULE: { sleep: '03:00', wake: '09:00' },
      DAEMON: { phase: 'down', lastAlive: '2026-10-06T09:42-07:00', lastAliveHm: '09:42', down: true },
      ALARMS: [{
        kind: 'daemon-down',
        title: "The nightshift isn't running",
        cause: 'No heartbeat since 09:42. Bells, folds and wakes are all paused.',
        at: ['2026-10-06T09:42-07:00', '09:42'],
        ackId: 'daemon-down:2026-10-06T09:42-07:00',
        fixes: [
          ['retry', 'restart-daemon', 'Restart it', 'Start the nightshift daemon again'],
          ['log', 'show-log', 'Show log', 'Open the nightshift log at this failure'],
        ],
      }],
    },
  }),
  // The stage words and midday requests (Ra, 10/12): a bell with its rung in,
  // a soft midday request (no deadline), an urgent one, and a reopening.
  stages: () => {
    const L = FIXTURE.LANES;
    const set = (i, extra) => ({ ...L[i], ...extra });
    return { snap: { LANES: [
      set(0, { state: 'belled', rungWritten: true, next: ['fold', '2026-10-05T13:30-07:00', '40m'] }),
      set(1, { state: 'awake', foldRequest: { phase: 'requested', deadline: null, tier: 'soft' }, midday: { softPct: 0.85, urgentPct: 0.95, urgentMin: 10 } }),
      set(2, { state: 'awake', foldRequest: { phase: 'requested', deadline: '2026-10-05T13:20-07:00', tier: 'urgent' } }),
      ...L.slice(3).map((x) => ({ ...x, state: 'sleeping', foldRequest: { phase: 'refreshing', forced: true } })),
    ] } };
  },
  // The severity tiers (Ra, 10/12): an amber context-high card beside a red
  // stuck card, so both twins render the warn level and its own glyph.
  tiers: () => {
    const L = FIXTURE.LANES;
    const at = ['2026-10-05T12:40-07:00', '12:40'];
    const log = ['log', 'show-log', 'Show log', 'Open the log at this alert'];
    return { snap: { LANES: [
      { ...L[0], open: false, alert: { kind: 'context-high', level: 'warn', icon: 'gauge', at, title: 'Context high', cause: 'At 88% of their context window. Worth a fold at their next seam.', fixes: [log] } },
      { ...L[1], open: false, alert: { kind: 'stuck-login', at, title: 'Logged out', cause: "The session says its login expired. They can't do anything until someone runs /login in their window.", fixes: [log] } },
      ...L.slice(2),
    ],
    // and its marks: an amber context node on the timeline and a Context row in the log
    NIGHT: { ...FIXTURE.NIGHT, [L[0].id]: [...(FIXTURE.NIGHT[L[0].id] ?? []), ['context', 'warn', 0.7, '06:10', 'Context high, 88%', 1]] },
    LOG: [['Oct 5', [['06:10', L[0].id, 'context', 'warn', 'Context high, 88%', null, 1], ...(FIXTURE.LOG[0]?.[1] ?? [])]], ...FIXTURE.LOG.slice(1)],
    } };
  },
  // Plan usage (Ra, 11/19): every state the card draws. Weft's reading is
  // stale with an expired 5-hour window, a weekly window over its limit, a
  // spend window with dollars, a window with no percentage, an unknown key
  // and a Fable key; Lark's plan reports one window (no flip button).
  usage: () => {
    const L = FIXTURE.LANES;
    const weft = { id: 'weft', name: 'Weft', usage: { provider: 'anthropic', at: '2026-10-05T16:40:00.000Z', stale: true, model: 'claude-fable-5', windows: [
      { key: 'five_hour', pct: 97, resetsAt: '2026-10-05T18:00:00.000Z', expired: true },
      { key: 'seven_day', pct: 100.4, resetsAt: '2026-10-07T16:00:00.000Z', expired: false },
      { key: 'spend_limit', pct: 81.5, resetsAt: '2026-11-01T07:00:00.000Z', expired: false, usedUsd: 40.75, limitUsd: 50, period: 'month' },
      { key: 'fable_week', pct: 12, resetsAt: '2026-10-07T16:00:00.000Z', expired: false },
      { key: 'some_new_window', pct: null, resetsAt: null, expired: false },
    ] }, usageCodex: { provider: 'openai', at: '2026-10-05T20:09:00.000Z', stale: false, model: null, windows: [
      { key: 'five_hour', pct: 2, resetsAt: '2026-10-05T23:00:00.000Z', expired: false },
      { key: 'seven_day', pct: 1, resetsAt: '2026-10-11T16:00:00.000Z', expired: false },
    ] } };
    const lark = { id: 'lark', name: 'Lark', usage: { provider: 'anthropic', at: '2026-10-05T20:09:30.000Z', stale: false, model: 'claude-haiku-4-5', windows: [
      { key: 'five_hour', pct: 3, resetsAt: '2026-10-05T21:15:00.000Z', expired: false },
    ] } };
    return { snap: { LANES: L.map((x) => ({ ...x, persona: x.persona.id === 'lark' ? lark : weft })) } };
  },
  quiet: () => ({
    snap: {
      NOW: '2026-10-06T08:05-07:00',
      ACTIVITY: Array(48).fill(0),
      TIMELINE: { range: '8h', from: '2026-10-06T00:05-07:00', to: '2026-10-06T08:05-07:00', label: 'Last 8 hours',
        ticks: [[0.1, '01'], [0.6, '06']], sleep_bands: [[0.2396, 0.9896]] },
      DECK: { next_at: '2026-10-07T02:00-07:00', countdown: '17h 55m' },
    },
  }),
};

const diskSkins = skinsFromDisk();
if (JSON.stringify(diskSkins) !== JSON.stringify(FIXTURE.SKINS)) {
  console.error('SKINS drift: fixture-data.mjs says', JSON.stringify(FIXTURE.SKINS));
  console.error('           but the skins dir has', JSON.stringify(diskSkins));
  process.exit(1);
}

// Live cases need a live snapshot per range: ask the running server (it
// writes gui/snapshot.json on every render), else skip with a note.
async function liveSnap(range) {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.NIGHTWATCH_PORT ?? 7352}/?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.text();
    return JSON.parse(readFileSync(join(GUI, 'snapshot.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

const only = process.argv[2];
let failures = 0, ran = 0;
for (const [name, make] of Object.entries(CASES)) {
  if (only && name !== only) continue;
  const c = make();
  let snap = c.snap;
  if (c.live) {
    snap = await liveSnap(c.live);
    if (!snap) { console.log(`SKIP ${name} — viewer not serving on 7352`); continue; }
  }
  let snapPath = null;
  if (snap) {
    snapPath = join(OUT, `${name}.snapshot.json`);
    writeFileSync(snapPath, JSON.stringify(snap));
  }
  const py = pythonRender(snapPath);
  const js = renderPage(mergeSnapshot(FIXTURE, snap ?? {}));
  ran++;
  const report = diffReport(name, py, js);
  if (report) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(report);
    writeFileSync(join(OUT, `${name}.py.html`), py);
    writeFileSync(join(OUT, `${name}.js.html`), js);
  } else {
    console.log(`PASS ${name} (${py.length} bytes, identical)`);
  }
}
console.log(failures === 0 ? `PARITY CLEAN (${ran} case${ran === 1 ? '' : 's'})` : `PARITY: ${failures} failure(s) — diffs in gui/test/out/`);
process.exit(failures ? 1 : 0);
