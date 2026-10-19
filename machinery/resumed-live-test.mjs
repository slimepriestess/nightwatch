// resumed-live-test.mjs — nightshift reads a RESUMED session's live file (#24).
// After a resume (/resume, or the session picker) the conversation goes on in
// a new transcript and the registered id's file stops growing at once, ending
// in a continued-in row. Read by the registered id, the session then looks
// QUIET (so the slept-and-quiet close could shut a busy panel) and its
// context looks STALE (so --ring would ring a bell into a window too full for
// the ritual). These checks run the real nightshift.mjs against a scratch hub,
// with a live session built as sleepnow-test.mjs builds one (a copy of node
// named claude, its status file, the registry entry; HOME is scratch):
//   - quiet: belled, slept (next-wake after the bell), the registered stub
//     10 minutes old, the live file just written → --preflight closes nothing;
//     the control (live file also 10 minutes old) → WOULD close, so the setup
//     really reaches the close;
//   - context: the stub at half the window, the live file at 97% → --ring
//     says the window is too full; the control (no resume) rings;
//   - a refused pointer (the target lacks the stub's prompt) reads the stub.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFrom } from './config.mjs';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n    ${detail}`}`);
}

const hub = mkdtempSync(join(tmpdir(), 'nw-resumed-'));
for (const d of ['wakecycle', 'ladder', 'sessions', 'projects', 'bin']) mkdirSync(join(hub, d), { recursive: true });
const cfgFile = join(hub, 'nightwatch.config.json');
writeFileSync(cfgFile, JSON.stringify({
  weftRoot: hub, lanes: { main: { targetTokens: 250000 } },
  notify: { macos: false }, paths: { transcripts: join(hub, 'projects'), sessions: join(hub, 'sessions') },
}));
const cfg = loadConfigFrom(cfgFile);
const home = join(hub, 'home');
mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
const env = { ...process.env, HOME: home, NIGHTWATCH_CONFIG: cfgFile };
for (const k of ['WEFT_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE', 'WEFT_NIGHT_QUIET_MS']) delete env[k];
const nightshift = (...args) => spawnSync(process.execPath, [join(MACHINERY, 'nightshift.mjs'), ...args], { env, encoding: 'utf8', timeout: 30_000 });
const spoolNotes = () => { try { return readdirSync(join(cfg.paths.spool, 'main')).length; } catch { return 0; } };

const fakeClaude = join(hub, 'bin', 'claude');
copyFileSync(process.execPath, fakeClaude);
chmodSync(fakeClaude, 0o755);

const T0 = '2026-11-12T10:00:00.000Z', T1 = '2026-11-12T11:00:00.000Z';
const reply = (uuid, parent, read, ts) => ({ type: 'assistant', uuid, parentUuid: parent, timestamp: ts, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: read, output_tokens: 1 } } });
const user = (uuid, parent, text, ts) => ({ type: 'user', uuid, parentUuid: parent, timestamp: ts, message: { role: 'user', content: text } });
const write = (sid, rows) => writeFileSync(join(hub, 'projects', `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const age = (sid, ms) => { const t = (Date.now() - ms) / 1000; utimesSync(join(hub, 'projects', `${sid}.jsonl`), t, t); };

// stub: the registered id's file. resumed: { to, read, carry } writes the live
// file (carrying the stub's rows when carry, as real resumes do) and ends the
// stub with continued-in.
function session(sid, { read, resumed = null }, run) {
  const stub = [user('a', null, 'hello', T0), reply('b', 'a', read, T0)];
  if (resumed) {
    write(sid, [...stub, { type: 'continued-in', continuedInSessionId: resumed.to }, { type: 'cost-state', totalCostUSD: 1 }]);
    const carried = resumed.carry ? stub.map((e) => ({ ...e, sessionId: resumed.to })) : [user('z', null, 'other', T1)];
    write(resumed.to, [...carried, user('c', carried.at(-1).uuid, 'still going', T1), reply('d', 'c', resumed.read, T1)]);
  } else {
    write(sid, stub);
  }
  const up = spawn(fakeClaude, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    writeFileSync(join(home, '.claude', 'sessions', `${up.pid}.json`), JSON.stringify({ pid: up.pid, sessionId: sid, kind: 'interactive' }));
    writeFileSync(join(hub, 'wakecycle', `lane.${sid}`), JSON.stringify({ lane: 'main', at: new Date(Date.now() - 3600_000).toISOString() }));
    return run(up.pid);
  } finally {
    up.kill();
    rmSync(join(home, '.claude', 'sessions', `${up.pid}.json`), { force: true });
    rmSync(join(hub, 'wakecycle', `lane.${sid}`), { force: true });
  }
}

// Belled a minute ago, slept since (next-wake after the bell), not closed yet.
function belledAndSlept(sid) {
  writeFileSync(cfg.paths.armedFile, 'main\n');
  const belledAt = Date.now() - 60_000;
  writeFileSync(cfg.paths.stateFile, JSON.stringify({ main: { belledAt, belledSession: sid } }));
  writeFileSync(join(cfg.paths.wakecycle, 'next-wake.main.json'), JSON.stringify({ sessionId: sid }));
}

try {
  // ── quiet ──────────────────────────────────────────────────────────────
  session('stub-busy', { read: 100_000, resumed: { to: 'live-busy', read: 100_000, carry: true } }, (pid) => {
    belledAndSlept('stub-busy');
    age('stub-busy', 10 * 60_000);            // the stub stopped at the resume
    const r = nightshift('--preflight');
    check('a resumed session busy in its new file is not closed as quiet', r.status === 0 && !new RegExp(`WOULD close panel pid ${pid}`).test(r.stdout), r.stdout + r.stderr);
  });
  session('stub-idle', { read: 100_000, resumed: { to: 'live-idle', read: 100_000, carry: true } }, (pid) => {
    belledAndSlept('stub-idle');
    age('stub-idle', 10 * 60_000);
    age('live-idle', 10 * 60_000);             // both quiet: the close must happen
    const r = nightshift('--preflight');
    check('control: when the new file is quiet too, the panel WOULD close', r.status === 0 && new RegExp(`WOULD close panel pid ${pid}`).test(r.stdout), r.stdout + r.stderr);
  });
  session('stub-refused', { read: 100_000, resumed: { to: 'live-unrelated', read: 100_000, carry: false } }, (pid) => {
    belledAndSlept('stub-refused');
    age('stub-refused', 10 * 60_000);          // a refused pointer reads the stub: quiet
    const r = nightshift('--preflight');
    check('a refused pointer (target lacks the stub\'s prompt) reads the stub, as before', r.status === 0 && new RegExp(`WOULD close panel pid ${pid}`).test(r.stdout), r.stdout + r.stderr);
  });

  // ── context ────────────────────────────────────────────────────────────
  rmSync(cfg.paths.stateFile, { force: true });
  session('stub-full', { read: 500_000, resumed: { to: 'live-full', read: 970_000, carry: true } }, () => {
    const before = spoolNotes();
    const r = nightshift('--ring', 'main');
    check('--ring judges the room by the live file (97%), not the stub (50%)', r.status === 0 && /too full for the bedtime ritual/.test(r.stdout) && spoolNotes() === before, `status ${r.status}: ${r.stdout}${r.stderr}`);
  });
  rmSync(cfg.paths.stateFile, { force: true });
  session('plain-half', { read: 500_000 }, () => {
    const before = spoolNotes();
    const r = nightshift('--ring', 'main');
    check('control: an unresumed session at 50% rings', r.status === 0 && /bell rung/.test(r.stdout) && spoolNotes() === before + 1, `status ${r.status}: ${r.stdout}${r.stderr}`);
  });
} finally {
  if (!fail) rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed${fail ? `  (scratch kept: ${hub})` : ''}`);
process.exit(fail ? 1 : 0);
