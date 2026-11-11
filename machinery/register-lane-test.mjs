#!/usr/bin/env node
// register-lane-test: the SessionStart hook records a session's lane in its
// hub's registry under either lane name, NIGHTWATCH_LANE or the older
// WEFT_LANE a pre-#7 wake exported (issue #7), and names the config the new
// way in the arming line it prints. Scratch hub only, per the rehearsal law.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const hub = mkdtempSync(join(tmpdir(), 'nw-register-lane-'));
try {
  mkdirSync(join(hub, 'wakecycle'), { recursive: true });
  const cfg = join(hub, 'nightwatch.config.json');
  writeFileSync(cfg, JSON.stringify({ defaultLane: 'alpha', lanes: { alpha: {}, beta: {} } }));
  const run = (env, sid) => {
    const e = { ...process.env, ...env };
    for (const k of ['NIGHTWATCH_CONFIG', 'WEFT_CONFIG', 'NIGHTWATCH_LANE', 'WEFT_LANE']) if (!(k in env)) delete e[k];
    return execFileSync('sh', [join(HERE, 'register-lane.sh')], { env: e, input: JSON.stringify({ session_id: sid }), encoding: 'utf8' });
  };
  const entry = (sid) => JSON.parse(readFileSync(join(hub, 'wakecycle', `lane.${sid}`), 'utf8'));

  const out = run({ NIGHTWATCH_CONFIG: cfg, NIGHTWATCH_LANE: 'alpha' }, 'sid-new');
  check('NIGHTWATCH_LANE is recorded in the hub registry', () => assert.equal(entry('sid-new').lane, 'alpha'));
  check('the arming line names the config as NIGHTWATCH_CONFIG', () => assert.match(out, new RegExp(`NIGHTWATCH_CONFIG=${cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `)));

  run({ WEFT_CONFIG: cfg, WEFT_LANE: 'beta' }, 'sid-old');
  check('an older wake\'s WEFT_LANE (and WEFT_CONFIG) still registers', () => assert.equal(entry('sid-old').lane, 'beta'));

  run({ NIGHTWATCH_CONFIG: cfg }, 'sid-none');
  check('no lane named registers nothing', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-none'))));

  // #69: the week-old prune runs on every SessionStart, so it must not take
  // the entry of a session that is still running (a midday-only lane can live
  // longer than a week between folds). A stand-in for that session's claude:
  // a process whose command reads "claude".
  const live = spawn('sleep', ['60'], { argv0: 'claude', stdio: 'ignore' });
  // Some other program now at a recorded pid: a plain sleep, whose command
  // line names no claude wherever the checkout sits.
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    const old = (sid, pid) => {
      const f = join(hub, 'wakecycle', `lane.${sid}`);
      writeFileSync(f, JSON.stringify({ lane: 'alpha', pid, at: '2026-10-01T00:00:00Z' }) + '\n');
      const t = new Date(Date.now() - 9 * 86400e3); utimesSync(f, t, t);
    };
    old('sid-live', live.pid);
    old('sid-dead', 999999);
    old('sid-notclaude', other.pid);
    run({ NIGHTWATCH_CONFIG: cfg }, 'sid-plain'); // an unlaned session opened in the hub runs the prune
    check('a week-old entry whose claude is still running is kept (#69)', () => assert.ok(existsSync(join(hub, 'wakecycle', 'lane.sid-live'))));
    check('a week-old entry whose process is gone is pruned', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-dead'))));
    check('a week-old entry whose pid is now some other program is pruned', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-notclaude'))));
    check('a fresh entry is kept', () => assert.ok(existsSync(join(hub, 'wakecycle', 'lane.sid-new'))));
  } finally {
    live.kill();
    other.kill();
  }
} finally {
  rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
