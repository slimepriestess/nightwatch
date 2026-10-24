#!/usr/bin/env node
// launcher: the phase-A launcher asks whoever answers on the viewer's port
// who it is before trusting it, with the app's rule (viewer-judge.mjs). The
// judge's cases run pure; then the real launch-nightwatch.sh runs against
// real viewers started from two scratch copies of this tree, on a spare port,
// with a stand-in for Chrome so no window ever opens.
//
//   node gui/test/launcher.mjs
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { judge, viewerRootIn } from '../viewer-judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) failures++; };

// ------------------------------------------------------------ the rule
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nw-launcher-')));
const A = join(scratch, 'a'), B = join(scratch, 'b');
for (const t of [A, B]) for (const d of ['gui', 'machinery', 'skins']) {
  cpSync(join(REPO, d), join(t, d), { recursive: true, filter: (s) => !/\.chrome-profile|viewer\.log|snapshot\.json/.test(s) });
}
symlinkSync(A, join(scratch, 'a-link'));
const v = (o) => ({ kind: 'viewer', pid: 41, root: A, rev: null, started: 2000, ...o });
const verdict = (a, repo = A, newest = 1000, alive = true) => judge(a, repo, newest, alive, 7999).verdict;
check('a non-viewer on the port is refused', verdict({ kind: 'other', pid: 7, cmd: 'python3 -m http.server' }) === 'refuse');
check('a viewer whose tree can\'t be told is refused', verdict(v({ root: null })) === 'refuse');
check('this tree\'s current viewer is kept', verdict(v()) === 'keep');
check('this tree\'s viewer is kept through a symlinked path', verdict(v({ root: join(scratch, 'a-link') })) === 'keep');
check('this tree\'s viewer is replaced when its code changed after it started', verdict(v({ started: 500 })) === 'replace');
check('this tree\'s viewer from before /whoami is replaced', verdict(v({ started: null })) === 'replace');
check('another living tree\'s viewer is refused, never killed', verdict(v(), B) === 'refuse');
check('a viewer whose tree is gone is replaced', verdict(v(), B, 1000, false) === 'replace');
check('a viewer\'s command line names its tree', viewerRootIn('/usr/local/bin/node /x/nw/gui/server.mjs') === '/x/nw');
check('a relative server.mjs is a viewer with no tree', viewerRootIn('node server.mjs') === null);
check('anything else isn\'t a viewer', viewerRootIn('python3 -m http.server 7352') === undefined);

// ------------------------------------------------------- the real launcher
const PORT = 7400 + Math.floor(Math.random() * 80);
const home = join(scratch, 'home');
const env = { HOME: home, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, NIGHTWATCH_PORT: String(PORT), NIGHTWATCH_CHROME: '/bin/true' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function whoami(port = PORT) {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/whoami`)).json(); } catch { await sleep(250); }
  }
  return null;
}
const launch = (tree, extra = {}) => spawnSync('bash', [join(tree, 'gui', 'launch-nightwatch.sh')], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const logOf = (tree) => { try { return readFileSync(join(tree, 'gui', 'viewer.log'), 'utf8'); } catch { return ''; } };
const pids = new Set();
let other;
try {
  const first = spawn(process.execPath, [join(A, 'gui', 'server.mjs')], { env, stdio: 'ignore', detached: true });
  first.unref();
  const w0 = await whoami();
  pids.add(w0?.pid);
  check('a viewer from tree A answers /whoami', w0?.root === A, JSON.stringify(w0));

  let r = launch(A);
  let w = await whoami();
  check('A\'s launcher keeps A\'s current viewer', r.status === 0 && w?.pid === w0.pid, `exit ${r.status}, pid ${w?.pid} vs ${w0?.pid}`);

  const later = Date.now() / 1000 + 5;
  utimesSync(join(A, 'gui', 'emitter.mjs'), later, later);
  r = launch(A);
  w = await whoami();
  pids.add(w?.pid);
  check('after a code change, A\'s launcher replaces its viewer', r.status === 0 && w?.pid !== w0.pid && w?.root === A && !alive(w0.pid), `exit ${r.status}, pid ${w?.pid}`);
  check('the replacement is logged, with the new server answering', /replacing the viewer server on port \d+: pid \d+, this tree's code changed/.test(logOf(A)) && /the new viewer server answers/.test(logOf(A)), logOf(A).slice(-400));

  const w1 = w;
  r = launch(B);
  w = await whoami();
  check('B\'s launcher refuses A\'s living viewer and exits 1', r.status === 1 && /won't stop another tree's living viewer/.test(r.stderr), `exit ${r.status} ${r.stderr}`);
  check('A\'s viewer is still alive and answering', w?.pid === w1.pid && alive(w1.pid));

  rmSync(A, { recursive: true, force: true });
  r = launch(B);
  w = await whoami();
  pids.add(w?.pid);
  check('with A removed, B\'s launcher replaces the orphaned viewer', r.status === 0 && w?.root === B && !alive(w1.pid), `exit ${r.status}, root ${w?.root}`);
  check('the log says the old tree is gone', /its tree .* is gone/.test(logOf(B)), logOf(B).slice(-400));

  const OPORT = PORT + 100;
  other = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('hi')).listen(${OPORT},'127.0.0.1')`], { stdio: 'ignore' });
  await sleep(500);
  r = launch(B, { NIGHTWATCH_PORT: String(OPORT) });
  check('something that isn\'t a viewer is refused, not killed', r.status === 1 && /isn't a Nightwatch viewer/.test(r.stderr) && alive(other.pid), `exit ${r.status} ${r.stderr}`);
} finally {
  for (const pid of pids) if (pid) { try { process.kill(pid); } catch { /* gone */ } }
  other?.kill();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `LAUNCHER: ${failures} failed` : 'LAUNCHER CLEAN');
process.exit(failures ? 1 : 0);
