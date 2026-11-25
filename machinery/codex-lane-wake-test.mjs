// A codex lane's wake (anima_dev/nightwatch_codex_lane_plan.md, leg 2): the REAL wake.sh against a scratch hub
// whose lane is provider:codex, with a stub codex (paths.codexBin) that records its argv and CODEX_HOME. No codex
// runs and nothing is spent. The stand-ins for a live session are plain `sleep`s whose argv0 reads "codex".
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
const SID = '019a0000-0000-7000-8000-00000000aaaa';
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function hub({ receipt = { sessionId: SID }, lane = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nw-codex-wake-'));
  for (const d of ['wakecycle', 'ladder', 'bin', 'codex-home']) mkdirSync(join(root, d), { recursive: true });
  const stub = join(root, 'bin', 'codex-stub');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, 'codex.argv')}"\nprintf '%s' "\${CODEX_HOME-unset}" > "${join(root, 'codex.home')}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  const claude = join(root, 'bin', 'claude-stub');
  writeFileSync(claude, `#!/bin/sh\ntouch "${join(root, 'claude-ran')}"\nexit 0\n`);
  chmodSync(claude, 0o755);
  writeFileSync(join(root, 'checkpoint.md'), '# checkpoint\n');
  writeFileSync(join(root, 'nightwatch.config.json'), JSON.stringify({
    weftRoot: root, defaultLane: 'main',
    lanes: { main: { targetTokens: 250000, provider: 'codex', codexHome: join(root, 'codex-home'), ...lane } },
    paths: { workdir: root, machinery: MACHINERY, claudeBin: claude, codexBin: stub },
  }));
  writeFileSync(join(root, 'wakecycle', 'next-wake.main.json'), JSON.stringify({ lane: 'main', checkpoint: join(root, 'checkpoint.md'), ...receipt }));
  return root;
}
function wake(root, env = {}) {
  const e = { ...process.env, WEFT_CONFIG: join(root, 'nightwatch.config.json'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...env };
  for (const k of ['NIGHTWATCH_CONFIG', 'NIGHTWATCH_LANE', 'WEFT_LANE', 'NIGHTWATCH_NODE', 'CODEX_HOME']) if (!(k in env)) delete e[k];
  return spawnSync('sh', [join(MACHINERY, 'wake.sh'), 'main'], { env: e, encoding: 'utf8', timeout: 30000 });
}
const HATCH = { NIGHTWATCH_CODEX_WAKE_WITHOUT_CHECKPOINT: '1' };
const argv = (root) => readFileSync(join(root, 'codex.argv'), 'utf8').trim().split('\n');
const log = (root) => { try { return readFileSync(join(root, 'nightshift.log'), 'utf8'); } catch { return ''; } };
const roots = [];
const mk = (o) => { const r = hub(o); roots.push(r); return r; };
const procs = [];

try {
  check('a codex lane is refused until leg 3 can carry its checkpoint (exit 7, logged, nothing launched)', () => {
    const r = mk();
    const res = wake(r);
    assert.equal(res.status, 7, res.stdout + res.stderr);
    assert.match(log(r), /WAKE REFUSED for main: a codex lane can't yet carry its checkpoint/);
    assert.equal(existsSync(join(r, 'codex.argv')), false);
    assert.equal(existsSync(join(r, 'claude-ran')), false);
  });
  check('a codex lane with no codexHome is refused, even through the test hatch', () => {
    const r = mk({ lane: { codexHome: undefined } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 7, res.stdout + res.stderr);
    assert.match(log(r), /a codex lane with no lanes\.main\.codexHome/);
    assert.equal(existsSync(join(r, 'codex.argv')), false);
  });
  check('through the hatch, the wake runs `codex resume <tail>` in the lane\'s CODEX_HOME, never claude', () => {
    const r = mk();
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(argv(r), ['resume', SID, '--no-daemon']);
    assert.equal(readFileSync(join(r, 'codex.home'), 'utf8'), join(r, 'codex-home'));
    assert.equal(existsSync(join(r, 'claude-ran')), false);
    assert.match(log(r), /this codex wake carries NO checkpoint/);
    assert.match(log(r), /wake receipt: main lane reached exec/);
  });
  check('the pinned model and the wake prompt ride the codex command line, prompt last', () => {
    const r = mk({ lane: { model: 'gpt-test', wakePrompt: '[nightwatch] the morning wake: read the receipts.' } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(argv(r), ['resume', SID, '--no-daemon', '-m', 'gpt-test', '[nightwatch] the morning wake: read the receipts.']);
  });
  check('a first wake starts a fresh codex session (no resume)', () => {
    const r = mk({ receipt: { firstWake: true }, lane: { model: 'gpt-test' } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(argv(r), ['--no-daemon', '-m', 'gpt-test']);
  });
  check('a codexHome written as ~/… is expanded to the home folder', () => {
    const r = mk({ lane: { codexHome: '~/.nightwatch-test-codex-home' } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(readFileSync(join(r, 'codex.home'), 'utf8'), join(homedir(), '.nightwatch-test-codex-home'));
  });
  check('already awake: a live `codex resume <tail>` refuses a second wake (exit 5)', () => {
    const r = mk();
    // The real command shape from the e2e: `codex resume <id> --no-daemon [prompt]`.
    const p = spawn('sleep', ['30'], { argv0: `codex resume ${SID} --no-daemon [nightwatch] a prompt`, stdio: 'ignore' });
    procs.push(p);
    try {
      const res = wake(r, HATCH);
      assert.equal(res.status, 5, res.stdout + res.stderr);
      assert.match(res.stdout, /ALREADY AWAKE: a live codex process already resumes this receipt/);
      assert.equal(existsSync(join(r, 'codex.argv')), false);
    } finally { p.kill(); }
  });
  check('already awake: a registered live codex session for the lane refuses a second wake', () => {
    const r = mk({ receipt: { sessionId: '019a0000-0000-7000-8000-00000000bbbb' } });
    const p = spawn('sleep', ['30'], { argv0: 'codex', stdio: 'ignore' });
    procs.push(p);
    try {
      writeFileSync(join(r, 'wakecycle', 'lane.019a-live'), JSON.stringify({ lane: 'main', pid: p.pid, provider: 'codex' }));
      const res = wake(r, HATCH);
      assert.equal(res.status, 5, res.stdout + res.stderr);
      assert.match(res.stdout, /ALREADY AWAKE: lane main has a live registered session/);
    } finally { p.kill(); }
  });
  check('control: the same registered live codex does not count for a claude-code lane', () => {
    const r = mk({ lane: { provider: undefined } });
    const p = spawn('sleep', ['30'], { argv0: 'codex', stdio: 'ignore' });
    procs.push(p);
    try {
      writeFileSync(join(r, 'wakecycle', 'lane.019a-live'), JSON.stringify({ lane: 'main', pid: p.pid, provider: 'codex' }));
      const res = wake(r);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(existsSync(join(r, 'claude-ran')), true, 'a claude-code lane launches claude');
      assert.equal(existsSync(join(r, 'codex.argv')), false);
    } finally { p.kill(); }
  });
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
