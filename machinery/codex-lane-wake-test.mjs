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

function hub({ receipt = { sessionId: SID }, lane = {}, rollout = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nw-codex-wake-'));
  for (const d of ['wakecycle', 'ladder', 'bin', 'codex-home']) mkdirSync(join(root, d), { recursive: true });
  // The tail's rollout, where codex keeps it: wake.sh refuses a resume whose rollout isn't there (codex would start
  // a fresh session without a word).
  if (rollout) {
    mkdirSync(join(root, 'codex-home', 'sessions', '2020', '01', '01'), { recursive: true });
    writeFileSync(join(root, 'codex-home', 'sessions', '2020', '01', '01', `rollout-2020-01-01T00-00-00-${SID}.jsonl`), '{"type":"session_meta","payload":{}}\n');
  }
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
const HATCH = {}; // leg 2's test hatch is gone with leg 3's refusal; the cases below keep their shape
const argv = (root) => readFileSync(join(root, 'codex.argv'), 'utf8').trim().split('\n');
// the argv with its developer_instructions value set aside, and that value decoded (it is a JSON string: one argv line)
const split = (root) => {
  const a = argv(root); const i = a.indexOf('-c');
  if (i < 0 || !a[i + 1]?.startsWith('developer_instructions=')) return { rest: a, dev: null };
  return { rest: [...a.slice(0, i), ...a.slice(i + 2)], dev: JSON.parse(a[i + 1].slice('developer_instructions='.length)) };
};
const log = (root) => { try { return readFileSync(join(root, 'nightshift.log'), 'utf8'); } catch { return ''; } };
const roots = [];
const mk = (o) => { const r = hub(o); roots.push(r); return r; };
const procs = [];

try {
  check('leg 3 lifted the refusal: a codex lane wakes with no hatch, its checkpoint in its developer instructions', () => {
    const r = mk();
    const res = wake(r);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(log(r), /WAKE REFUSED/);
    assert.equal(split(r).dev, readFileSync(join(r, 'wakecycle', 'last-head.main'), 'utf8'));
  });
  check('a codex lane with no codexHome is refused', () => {
    const r = mk({ lane: { codexHome: undefined } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 7, res.stdout + res.stderr);
    assert.match(log(r), /a codex lane with no lanes\.main\.codexHome/);
    assert.equal(existsSync(join(r, 'codex.argv')), false);
  });
  check('the wake runs `codex resume <tail>` in the lane\'s CODEX_HOME, never claude', () => {
    const r = mk();
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const { rest, dev } = split(r);
    assert.deepEqual(rest, ['resume', SID, '--no-daemon']);
    // the head reaches codex as developer instructions, byte for byte the head wake.sh saved for the witness
    assert.equal(dev, readFileSync(join(r, 'wakecycle', 'last-head.main'), 'utf8'));
    assert.match(dev, /^# checkpoint\n/);
    assert.match(dev, /Your bells arrive as messages in this session marked "\[nightwatch bell, sent by the machinery\]"/);
    assert.doesNotMatch(dev, /bell-watcher|inbox watcher/, 'a codex session has no watcher to arm');
    assert.equal(readFileSync(join(r, 'codex.home'), 'utf8'), join(r, 'codex-home'));
    assert.equal(existsSync(join(r, 'claude-ran')), false);
    assert.match(log(r), /wake receipt: main lane reached exec/);
  });
  check('the pinned model and the wake prompt ride the codex command line, prompt last', () => {
    const r = mk({ lane: { model: 'gpt-test', wakePrompt: '[nightwatch] the morning wake: read the receipts.' } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(split(r).rest, ['resume', SID, '--no-daemon', '-m', 'gpt-test', '[nightwatch] the morning wake: read the receipts.']);
  });
  check('a head that can\'t be read into developer instructions refuses the wake (exit 7, logged, nothing launched)', () => {
    const r = mk();
    // a node that fails only for wake.sh's head-quoting call, and runs every other call (config reads) as usual
    const wrap = join(r, 'bin', 'node-nohead');
    writeFileSync(wrap, `#!/bin/sh\ncase "$*" in *JSON.stringify*) exit 1 ;; esac\nexec "${process.execPath}" "$@"\n`); chmodSync(wrap, 0o755);
    const res = wake(r, { ...HATCH, NIGHTWATCH_NODE: wrap });
    assert.equal(res.status, 7, res.stdout + res.stderr);
    assert.match(log(r), /couldn't put the head into developer instructions/);
    assert.equal(existsSync(join(r, 'codex.argv')), false);
  });
  check('a first wake starts a fresh codex session (no resume)', () => {
    const r = mk({ receipt: { firstWake: true }, lane: { model: 'gpt-test' } });
    const res = wake(r, HATCH);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(split(r).rest, ['--no-daemon', '-m', 'gpt-test']);
    assert.ok(split(r).dev?.includes('## Standing wake duties'), 'a first wake carries the head too');
  });
  check('a tail whose rollout is not under the lane\'s CODEX_HOME is refused (exit 7, logged, codex never runs)', () => {
    const r = mk({ rollout: false });
    const res = wake(r, HATCH);
    assert.equal(res.status, 7, res.stdout + res.stderr);
    assert.match(log(r), new RegExp(`WAKE REFUSED for main: no rollout for tail ${SID}`));
    assert.equal(existsSync(join(r, 'codex.argv')), false);
  });
  check('a codexHome written as ~/… is expanded to the home folder (a first wake: no tail to look for)', () => {
    const r = mk({ receipt: { firstWake: true, created: true }, lane: { codexHome: '~/.nightwatch-test-codex-home' } });
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
