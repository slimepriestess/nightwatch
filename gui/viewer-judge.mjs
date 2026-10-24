#!/usr/bin/env node
// Who answers on the viewer's port, and what the phase-A launcher should do
// about it: the same rule the desktop app applies (app/src-tauri/src/lib.rs,
// judge), for launch-nightwatch.sh. The viewer server outlives whatever
// started it, so the one answering can be running code from another tree, a
// removed one, or this tree before a pull (WSL, 10/21: a viewer from a deleted
// worktree answered ENOENT for every page).
//
//   node gui/viewer-judge.mjs <port> <tree>
//
// prints one line: `keep`, `replace <pid> <why>` or `refuse <why>`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// A viewer since /whoami says who it is: { kind: 'viewer', pid, root, rev,
// started }. One from before it is known by its command line, with started
// null. Anything else is { kind: 'other', pid, cmd }.
const describe = (a) => a.kind === 'viewer'
  ? `pid ${a.pid}, tree ${a.root ?? 'unknown'}, rev ${a.rev ? a.rev.slice(0, 12) : 'unknown'}, ${a.started != null ? 'answers /whoami' : 'from before /whoami'}`
  : `pid ${a.pid ?? 'unknown'}, ${a.cmd || 'command unknown'}`;

// The rule, kept pure for its tests. `alive`: the answering viewer's tree is
// still a tree on disk. `newest`: this tree's newest code file, ms. Replace
// this tree's own viewer when its code changed after it started (or it
// predates /whoami, so nobody can tell), and a viewer whose tree is gone.
// Never kill another living tree's viewer: two hubs sharing a port would
// otherwise each kill the other's healthy server on every launch (Weft, 10/21).
export function judge(a, repo, newest, alive, port) {
  if (a.kind !== 'viewer') {
    return { verdict: 'refuse', why: `Port ${port} is taken by something that isn't a Nightwatch viewer (${describe(a)}), so the viewer can't start there. Stop it, or give Nightwatch another port with NIGHTWATCH_PORT.` };
  }
  if (!a.root) {
    return { verdict: 'refuse', why: `Port ${port} is held by a Nightwatch viewer whose tree can't be told (${describe(a)}). Quit it (pid ${a.pid}) and reopen Nightwatch.` };
  }
  if (canon(a.root) === canon(repo)) {
    if (a.started == null) return { verdict: 'replace', pid: a.pid, why: 'it predates /whoami, so its code can\'t be checked' };
    if (a.started >= newest) return { verdict: 'keep' };
    return { verdict: 'replace', pid: a.pid, why: 'this tree\'s code changed after it started' };
  }
  if (!alive) return { verdict: 'replace', pid: a.pid, why: `its tree ${a.root} is gone` };
  return { verdict: 'refuse', why: `Port ${port} already serves the Nightwatch viewer from ${a.root}, and this launcher runs from ${repo}. Nightwatch won't stop another tree's living viewer: quit that one (pid ${a.pid}), or give one of them its own NIGHTWATCH_PORT.` };
}

// A viewer's command line is node running some gui/server.mjs: its tree (or
// null when the path isn't absolute) for a viewer, undefined for anything else.
export function viewerRootIn(cmd) {
  const words = cmd.trim().split(/\s+/);
  if (words[0]?.split('/').pop() !== 'node') return undefined;
  const script = words.slice(1).find((w) => w === 'server.mjs' || w.endsWith('/gui/server.mjs'));
  if (!script) return undefined;
  const tree = script.slice(0, -'/gui/server.mjs'.length);
  return script.endsWith('/gui/server.mjs') && tree.startsWith('/') ? tree : null;
}

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const commandOf = (pid) => run('ps', ['-p', String(pid), '-o', 'command=']).trim();

// The pid listening on the port, for a viewer too old to say: lsof (macOS has
// it; most Linux too), else ss.
function listenerPid(port) {
  for (const lsof of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
    if (!existsSync(lsof)) continue;
    const pid = parseInt(run(lsof, ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']).split('\n')[0], 10);
    return Number.isNaN(pid) ? null : pid;
  }
  const m = run('ss', ['-ltnpH', `sport = :${port}`]).match(/pid=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export async function answererOn(port) {
  let who = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(2000) });
    const j = res.status === 200 ? await res.json() : null;
    if (j?.nightwatch === 'viewer') who = j;
  } catch { /* not a viewer since /whoami */ }
  const pid = who ? who.pid : listenerPid(port);
  if (pid == null) return { kind: 'other', pid: null, cmd: '' };
  // A viewer's pid must really be node running a gui/server.mjs before it
  // counts: a /whoami alone could be anyone's.
  const cmd = commandOf(pid);
  const argvRoot = viewerRootIn(cmd);
  if (argvRoot === undefined) return { kind: 'other', pid, cmd };
  return who
    ? { kind: 'viewer', pid, root: who.root ?? null, rev: who.rev ?? null, started: who.started ?? null }
    : { kind: 'viewer', pid, root: argvRoot, rev: null, started: null };
}

// The newest code file the viewer loads (gui's and machinery's modules), in
// ms since the epoch: a server that started before it runs older code.
export function newestCode(repo) {
  let newest = 0;
  for (const d of ['gui', 'machinery']) {
    let names = [];
    try { names = readdirSync(join(repo, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.mjs')) continue;
      try { newest = Math.max(newest, statSync(join(repo, d, n)).mtimeMs); } catch { /* raced away */ }
    }
  }
  return Math.floor(newest);
}

const isTree = (p) => existsSync(join(p, 'gui', 'server.mjs'));

if (process.argv[1] && canon(process.argv[1]) === canon(fileURLToPath(import.meta.url))) {
  const [port, repo] = process.argv.slice(2);
  const a = await answererOn(Number(port));
  const v = judge(a, repo, newestCode(repo), a.root ? isTree(a.root) : false, Number(port));
  console.log(v.verdict === 'keep' ? 'keep' : v.verdict === 'replace' ? `replace ${v.pid} ${v.why}` : `refuse ${v.why}`);
}
