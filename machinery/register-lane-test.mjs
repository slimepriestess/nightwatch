#!/usr/bin/env node
// register-lane-test: the SessionStart hook records a session's lane in its
// hub's registry under either lane name, NIGHTWATCH_LANE or the older
// WEFT_LANE a pre-#7 wake exported (issue #7), and names the config the new
// way in the arming line it prints. Scratch hub only, per the rehearsal law.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
  check('the registry entry carries the lane\'s provider (claude-code by default)', () => assert.equal(entry('sid-new').provider, 'claude-code'));
  check('the arming line names the config as NIGHTWATCH_CONFIG', () => assert.match(out, new RegExp(`NIGHTWATCH_CONFIG=${cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `)));

  const cfgCodex = join(hub, 'codex.config.json');
  writeFileSync(cfgCodex, JSON.stringify({ defaultLane: 'alpha', lanes: { alpha: { provider: 'codex' }, beta: {} } }));
  run({ NIGHTWATCH_CONFIG: cfgCodex, NIGHTWATCH_LANE: 'alpha' }, 'sid-codex');
  check('a configured provider reaches the registry entry', () => assert.equal(entry('sid-codex').provider, 'codex'));

  run({ WEFT_CONFIG: cfg, WEFT_LANE: 'beta' }, 'sid-old');
  check('an older wake\'s WEFT_LANE (and WEFT_CONFIG) still registers', () => assert.equal(entry('sid-old').lane, 'beta'));

  run({ NIGHTWATCH_CONFIG: cfg }, 'sid-none');
  check('no lane named registers nothing', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-none'))));

  // The pid recorded is the claude that ran the hook, though a shell sits
  // between (Claude Code on WSL runs hooks through one, so the hook's $PPID
  // is that shell, gone by the time anything reads the entry: marginalia's
  // run of #73). A stand-in claude (node with argv0 "claude") runs the hook
  // through `sh -c` with a second command, so the shell doesn't exec it away.
  {
    const hook = join(HERE, 'register-lane.sh');
    const e = { ...process.env, NIGHTWATCH_CONFIG: cfg, NIGHTWATCH_LANE: 'alpha' };
    for (const k of ['WEFT_CONFIG', 'WEFT_LANE']) delete e[k];
    const code = `const { execFileSync } = require('node:child_process');
      execFileSync('sh', ['-c', 'sh "$0" < "$1"; true', ${JSON.stringify(hook)}, process.argv[1]], { stdio: 'ignore' });
      process.stdout.write(String(process.pid));`;
    // The input sits under a .claude folder, so the wrapper's own command line
    // mentions claude: only the claude executable itself may be taken.
    mkdirSync(join(hub, '.claude'), { recursive: true });
    const input = join(hub, '.claude', 'hook-input.json'); writeFileSync(input, JSON.stringify({ session_id: 'sid-wrapped' }));
    const r = spawnSync(process.execPath, ['-e', code, input], { argv0: 'claude', env: e, encoding: 'utf8' });
    check('the recorded pid is the claude above the hook\'s shell, not the shell (#73, WSL)', () => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(entry('sid-wrapped').pid, Number(r.stdout));
    });
  }

  // Two lines of the walk-up Sonnet's second read found unpinned. A wrapper
  // whose own executable sits under a claude-named folder isn't claude: only
  // an executable named claude is. And with no claude within reach the entry
  // records the hook's $PPID, which is what keeps it right where ps's first
  // word can't name claude (a home folder with a space in it).
  {
    const hook = join(HERE, 'register-lane.sh');
    const e = { ...process.env, NIGHTWATCH_CONFIG: cfg, NIGHTWATCH_LANE: 'alpha' };
    for (const k of ['WEFT_CONFIG', 'WEFT_LANE']) delete e[k];
    const inputFor = (sid) => { const f = join(hub, `input-${sid}.json`); writeFileSync(f, JSON.stringify({ session_id: sid })); return f; };
    const runner = join(hub, '.claude', 'hooks', 'run');
    const code = `const { execFileSync } = require('node:child_process');
      execFileSync('sh', ['-c', 'sh "$0" < "$1"; true', ${JSON.stringify(hook)}, process.argv[1]], { stdio: 'ignore', argv0: ${JSON.stringify(runner)} });
      process.stdout.write(String(process.pid));`;
    const r = spawnSync(process.execPath, ['-e', code, inputFor('sid-runner')], { argv0: 'claude', env: e, encoding: 'utf8' });
    check('a wrapper whose own path is under a claude-named folder is passed over for the claude above it', () => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(entry('sid-runner').pid, Number(r.stdout));
    });
    // Nine shells between the hook and anything above it put any claude past
    // the walk's reach; the innermost one, the hook's parent, writes its pid.
    const chain = join(hub, 'chain.sh');
    const pidFile = join(hub, 'innermost.pid');
    writeFileSync(chain, `if [ "$1" -gt 0 ]; then sh "$0" $(($1 - 1)) "$2" "$3"; true; else echo $$ > ${JSON.stringify(pidFile)}; sh ${JSON.stringify(hook)} < "$2"; true; fi\n`);
    execFileSync('sh', [chain, '8', inputFor('sid-noclaude'), 'x'], { env: e, stdio: 'ignore' });
    check('with no claude in reach, the entry records the hook\'s parent', () => {
      assert.equal(entry('sid-noclaude').pid, Number(readFileSync(pidFile, 'utf8').trim()));
    });
  }

  // A codex lane (leg 2) runs this same hook from Codex's SessionStart. Its parent is the native
  // codex binary (probe Q2), so the walk looks for codex, never a claude above it; and a codex
  // session has no background tasks, so it gets no watcher line (its bells are `codex queue`).
  {
    const hook = join(HERE, 'register-lane.sh');
    const e = { ...process.env, NIGHTWATCH_CONFIG: cfgCodex, NIGHTWATCH_LANE: 'alpha' };
    for (const k of ['WEFT_CONFIG', 'WEFT_LANE']) delete e[k];
    const input = join(hub, 'codex-hook-input.json'); writeFileSync(input, JSON.stringify({ session_id: 'sid-codex-chain' }));
    const outFile = join(hub, 'codex-hook-out.txt');
    // A stand-in codex (node with argv0 "codex") under a stand-in claude: the entry must name the codex.
    const inner = `const { execFileSync } = require('node:child_process');
      execFileSync('sh', ['-c', 'sh "$0" < "$1" > "$2"; true', ${JSON.stringify(hook)}, process.argv[1], process.argv[2]], { stdio: 'ignore' });
      process.stdout.write(String(process.pid));`;
    const outer = `const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}, process.argv[1], process.argv[2]], { argv0: 'codex', encoding: 'utf8' });
      process.stdout.write(r.stdout);`;
    const r = spawnSync(process.execPath, ['-e', outer, input, outFile], { argv0: 'claude', env: e, encoding: 'utf8' });
    check('a codex lane records the codex above the hook, not a claude further up (leg 2)', () => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(entry('sid-codex-chain').pid, Number(r.stdout));
      assert.equal(entry('sid-codex-chain').provider, 'codex');
    });
    check('a codex lane gets no bell-watcher line (its bells are codex queue messages)', () => {
      assert.doesNotMatch(readFileSync(outFile, 'utf8'), /bell-watcher/);
    });
  }

  // An app-server daemon between the hook and the session is passed over: it outlives the session
  // (leg 2's end-to-end). A stand-in daemon is node with argv0 "codex" and an app-server argument.
  {
    const hook = join(HERE, 'register-lane.sh');
    const e = { ...process.env, NIGHTWATCH_CONFIG: cfgCodex, NIGHTWATCH_LANE: 'alpha' };
    for (const k of ['WEFT_CONFIG', 'WEFT_LANE']) delete e[k];
    const input = join(hub, 'codex-daemon-input.json'); writeFileSync(input, JSON.stringify({ session_id: 'sid-codex-daemon' }));
    const daemon = `const { execFileSync } = require('node:child_process');
      execFileSync('sh', ['-c', 'sh "$0" < "$1"; true', ${JSON.stringify(hook)}, process.argv[1]], { stdio: 'ignore' });`;
    const session = `const { spawnSync } = require('node:child_process');
      spawnSync(process.execPath, ['-e', ${JSON.stringify(daemon)}, process.argv[1], 'app-server', '--managed-daemon'], { argv0: 'codex', stdio: 'ignore' });
      process.stdout.write(String(process.pid));`;
    const r = spawnSync(process.execPath, ['-e', session, input], { argv0: 'codex', env: e, encoding: 'utf8' });
    check('a codex app-server daemon above the hook is passed over for the session above it (leg 2 e2e)', () => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(entry('sid-codex-daemon').pid, Number(r.stdout));
    });
  }

  // #69: the week-old prune runs on every SessionStart, so it must not take
  // the entry of a session that is still running (a midday-only lane can live
  // longer than a week between folds). A stand-in for that session's claude:
  // a process whose command reads "claude".
  const live = spawn('sleep', ['60'], { argv0: 'claude', stdio: 'ignore' });
  // Some other program now at a recorded pid: a plain sleep, whose command
  // line names no claude wherever the checkout sits.
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  // A live codex lane's session: its entry must survive the prune too.
  const liveCodex = spawn('sleep', ['60'], { argv0: 'codex', stdio: 'ignore' });
  try {
    const old = (sid, pid) => {
      const f = join(hub, 'wakecycle', `lane.${sid}`);
      writeFileSync(f, JSON.stringify({ lane: 'alpha', pid, at: '2026-10-01T00:00:00Z' }) + '\n');
      const t = new Date(Date.now() - 9 * 86400e3); utimesSync(f, t, t);
    };
    old('sid-live', live.pid);
    old('sid-dead', 999999);
    old('sid-notclaude', other.pid);
    old('sid-live-codex', liveCodex.pid);
    run({ NIGHTWATCH_CONFIG: cfg }, 'sid-plain'); // an unlaned session opened in the hub runs the prune
    check('a week-old entry whose claude is still running is kept (#69)', () => assert.ok(existsSync(join(hub, 'wakecycle', 'lane.sid-live'))));
    check('a week-old entry whose process is gone is pruned', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-dead'))));
    check('a week-old entry whose pid is now some other program is pruned', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-notclaude'))));
    check('a fresh entry is kept', () => assert.ok(existsSync(join(hub, 'wakecycle', 'lane.sid-new'))));
    check('a week-old entry whose codex is still running is kept (leg 2)', () => assert.ok(existsSync(join(hub, 'wakecycle', 'lane.sid-live-codex'))));
  } finally {
    liveCodex.kill();
    live.kill();
    other.kill();
  }
} finally {
  rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
