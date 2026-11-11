// versioncheck-test.mjs: Doctor's Claude Code version check. The pure lines
// are checked with injected I/O (no real claude); the wiring is checked by
// running the nightshift's own --preflight on a scratch hub with a stub claude
// and wake-cost rows, because a check nobody calls is a green about nothing.
// Each check goes red when the behaviour it names is reverted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaude, parseVersion, seenVersions, claudeVersionLines, realIo, lookupCommand, flagLines, WAKE_FLAGS, NODE_FLOOR, parseExecStart, parseExecWords, nodeJobs, nodeLines, nodeRealIo } from './versioncheck.mjs';
import { platformKind, daemonJob } from './platform.mjs';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const scratch0 = tmpdir();
// A help text shaped like claude's: each flag DEFINED at the start of a line, and also named in prose elsewhere.
// `omit` removes the definition line but leaves the prose mention (the case a loose match would miss).
const HELP_LINES = {
  '--append-system-prompt': '  --append-system-prompt <prompt>       Append a system prompt to the default',
  '--resume': '  -r, --resume [value]                  Resume a conversation by session ID',
  '--fork-session': '  --fork-session                        When resuming, create a new session ID',
  '--model': '  --model <model>                       Model for the current session',
  '--system-prompt-snapshot': '  --system-prompt-snapshot <on|off>     Record the system prompt once per conversation',
};
const HELP = (omit = []) => ['Usage: claude [options]', 'Options:', ...Object.entries(HELP_LINES).filter(([f]) => !omit.includes(f)).map(([, l]) => l),
  '  --bare                                Minimal mode. Provide context via --append-system-prompt[-file], and see --resume, --model, --fork-session, --system-prompt-snapshot'].join('\n') + '\n';
const rows = (...vs) => vs.map((v) => JSON.stringify(v === null ? { lane: 'x' } : { lane: 'x', version: v })).join('\n') + '\n';
const io = (over = {}) => ({
  claudeBin: '/cfg/claude', isExecutable: (p) => p === '/cfg/claude', lookupPath: () => '/usr/bin/claude',
  runVersion: () => '2.1.310 (Claude Code)\n', wakeCostsText: rows('2.1.309'), ...over,
});

// ── resolving the binary the way wake.sh does ──
check('paths.claudeBin wins when it is there and executable', () => {
  assert.deepEqual(resolveClaude(io()), { path: '/cfg/claude', via: 'paths.claudeBin' });
});
check('a configured claude that is not executable falls through to PATH', () => {
  assert.deepEqual(resolveClaude(io({ isExecutable: () => false })), { path: '/usr/bin/claude', via: 'PATH' });
});
check('an unset paths.claudeBin falls through to PATH', () => {
  assert.deepEqual(resolveClaude(io({ claudeBin: undefined })), { path: '/usr/bin/claude', via: 'PATH' });
});
check('neither: no path, no via', () => {
  assert.deepEqual(resolveClaude(io({ isExecutable: () => false, lookupPath: () => null })), { path: null, via: null });
});

// ── reading versions ──
check('parseVersion reads claude --version and nothing else', () => {
  assert.equal(parseVersion('2.1.310 (Claude Code)\n'), '2.1.310');
  assert.equal(parseVersion('  12.0.1'), '12.0.1');
  for (const bad of ['latest', '', null, undefined, 'v2.1.310', 'Claude Code 2.1.310', '2.1']) assert.equal(parseVersion(bad), null, String(bad));
});
check('seenVersions: distinct, in file order, skipping torn lines and rows without a version', () => {
  const text = rows('2.1.309', '2.1.310', null, '2.1.309') + '{"version":"2.1.3' + '\n' + JSON.stringify({ version: 7 }) + '\n' + JSON.stringify({ version: '' }) + '\n';
  assert.deepEqual(seenVersions(text), ['2.1.309', '2.1.310']);
  assert.deepEqual(seenVersions(''), []);
  assert.deepEqual(seenVersions(undefined), []);
});

// ── the lines ──
const one = (over) => { const l = claudeVersionLines(io(over)); assert.equal(l.length, 1); return l[0]; };
check('a version that has woken on a folded tail is ok, and the path and its source are named', () => {
  const l = one({ runVersion: () => '2.1.309 (Claude Code)' });
  assert.match(l, /^ok {6}/); assert.match(l, /2\.1\.309/); assert.match(l, /\/cfg\/claude \(via paths\.claudeBin\)/);
});
check('a version no wake has run is amber, names what has, and says it is not a fault', () => {
  const l = one({ wakeCostsText: rows('2.1.308', '2.1.309') });
  assert.match(l, /^WARN {4}/); assert.match(l, /2\.1\.310/); assert.match(l, /woken: 2\.1\.308, 2\.1\.309/); assert.match(l, /not a fault/);
});
check('newness is membership: a version seen earlier but not last is ok (a rollback)', () => {
  const l = one({ runVersion: () => '2.1.309 (Claude Code)', wakeCostsText: rows('2.1.309', '2.1.310') });
  assert.match(l, /^ok {6}/);
});
check('no wake row carries a version yet: neutral, not amber', () => {
  for (const text of ['', rows(null, null)]) {
    const l = one({ wakeCostsText: text });
    assert.match(l, /^note {4}/); assert.match(l, /no baseline/); assert.doesNotMatch(l, /WARN/);
  }
});
check('the path found on PATH is named as such', () => {
  const l = one({ isExecutable: () => false });
  assert.match(l, /\/usr\/bin\/claude \(via PATH\)/);
  const withLabel = one({ isExecutable: () => false, lookupLabel: 'looked up by `zsh -ilc`, the shell the wake window runs' });
  assert.match(withLabel, /\(via PATH; looked up by `zsh -ilc`/, 'who looked is said, so the line never implies more than it has');
});
check('no claude anywhere is amber and names where it looked', () => {
  const l = one({ isExecutable: () => false, lookupPath: () => null });
  assert.match(l, /^WARN {4}/); assert.match(l, /\/cfg\/claude/); assert.match(l, /PATH/);
});
check('a --version that fails or prints something else is amber and shows what it printed', () => {
  const a = one({ runVersion: () => null }); assert.match(a, /^WARN {4}/); assert.match(a, /could not read a version/);
  const b = one({ runVersion: () => 'Claude, the assistant' }); assert.match(b, /^WARN {4}/); assert.match(b, /Claude, the assistant/);
});
check('never red: no case produces MISSING or BAD', () => {
  const cases = [{}, { wakeCostsText: '' }, { wakeCostsText: rows('1.0.0') }, { runVersion: () => null }, { isExecutable: () => false, lookupPath: () => null }, { runVersion: () => 'x' }];
  for (const c of cases) assert.doesNotMatch(one(c), /^(MISSING|BAD)/);
});

// ── which shell looks (Opus's measurement, 10/25: sh -lc and zsh -lc find the old
//    Homebrew cask, only an interactive login shell finds the live claude) ──
check('darwin looks as Terminal\'s window does: the user\'s shell, interactive login (-ilc)', () => {
  const c = lookupCommand({ kind: 'darwin', shell: '/bin/zsh' });
  assert.equal(c.bin, '/bin/zsh'); assert.deepEqual(c.args, ['-ilc', 'command -v claude']); assert.match(c.label, /-ilc/);
  assert.equal(lookupCommand({ kind: 'darwin', shell: '/opt/homebrew/bin/fish' }).bin, '/opt/homebrew/bin/fish');
});
check('darwin without a usable shell falls back to zsh, still -ilc', () => {
  // null, empty and a bare name are unusable. undefined is NOT passed here: it means "use $SHELL", and
  // the CI runner's $SHELL is /bin/bash, so asserting zsh for it passed on a Mac by coincidence (10/25).
  for (const shell of [null, '', 'zsh']) { const c = lookupCommand({ kind: 'darwin', shell }); assert.equal(c.bin, '/bin/zsh', String(shell)); assert.equal(c.args[0], '-ilc'); }
});
check('darwin with no shell argument looks as the environment\'s $SHELL does', () => {
  const saved = process.env.SHELL;
  try {
    process.env.SHELL = '/bin/bash'; assert.equal(lookupCommand({ kind: 'darwin' }).bin, '/bin/bash');
    process.env.SHELL = '/bin/zsh'; assert.equal(lookupCommand({ kind: 'darwin' }).bin, '/bin/zsh');
    delete process.env.SHELL; assert.equal(lookupCommand({ kind: 'darwin' }).bin, '/bin/zsh');
  } finally { if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved; }
});
check('linux and wsl look as the window does: sh -lc with the node and configured-claude directories first', () => {
  for (const kind of ['linux', 'wsl']) {
    const c = lookupCommand({ kind, nodePath: '/home/u/.nvm/bin/node', claudeBin: '/home/u/.local/bin/claude' });
    assert.equal(c.bin, '/bin/sh'); assert.equal(c.args[0], '-lc');
    assert.match(c.args[1], /^PATH="\/home\/u\/\.nvm\/bin:\/home\/u\/\.local\/bin:\$PATH"; command -v claude$/); assert.match(c.label, /sh -lc/);
  }
});
// The string above is only matched; run it. The directories are real and each holds a claude that says whose it is, so
// which one `command -v` finds is the order the lookup puts them in. kind is passed, so this runs the linux/wsl command on
// any machine (sh -lc is POSIX). Found by marginalia's WSL machine, where the real claude sits beside node (npm into the
// same nvm bin) and the end-to-end test below assumed none does.
check('linux and wsl lookups, run: a claude beside node wins over the configured claude\'s directory; with none beside node, the configured one is found', () => {
  const d = mkdtempSync(join(tmpdir(), 'nw-vc-order-'));
  try {
    const nodeDir = join(d, 'nodedir'), cfgDir = join(d, 'cfgdir'), plainNodeDir = join(d, 'plainnode');
    for (const x of [nodeDir, cfgDir, plainNodeDir]) mkdirSync(x);
    for (const x of [join(nodeDir, 'claude'), join(cfgDir, 'claude')]) { writeFileSync(x, '#!/bin/sh\n'); chmodSync(x, 0o755); }
    const find = (kind, nodePath) => { const c = lookupCommand({ kind, nodePath, claudeBin: join(cfgDir, 'claude-missing') }); return spawnSync(c.bin, c.args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim(); };
    for (const kind of ['linux', 'wsl']) {
      assert.equal(find(kind, join(nodeDir, 'node')), join(nodeDir, 'claude'), `${kind}: node's directory comes first, as the wake window's PATH does`);
      assert.equal(find(kind, join(plainNodeDir, 'node')), join(cfgDir, 'claude'), `${kind}: with no claude beside node, the configured claude's directory is the next`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
check('an unknown platform says it is only Doctor\'s shell, and never claims the window\'s', () => {
  const c = lookupCommand({ kind: 'plan9' }); assert.match(c.label, /Doctor's shell/); assert.doesNotMatch(c.label, /as the wake window runs/);
});
check('realIo actually spawns the interactive login form on darwin (not what a stubbed lookupPath would hide)', () => {
  const calls = [];
  const r = realIo({ claudeBin: '/x', wakeCostsPath: join(scratch0, 'none'), kind: 'darwin', shell: '/bin/zsh', spawn: (bin, args) => { calls.push([bin, args]); return { status: 0, stdout: 'rc noise\n/etc/zshrc: loaded\n/opt/found/claude\n' }; } });
  assert.equal(r.lookupPath(), '/opt/found/claude', 'rc noise is skipped; the last path line wins');
  assert.deepEqual(calls, [['/bin/zsh', ['-ilc', 'command -v claude']]]);
  assert.match(r.lookupLabel, /-ilc/);
});
check('realIo: a failed lookup, or output with no path in it, is null', () => {
  const mk = (out) => realIo({ claudeBin: '/x', wakeCostsPath: join(scratch0, 'none'), kind: 'darwin', shell: '/bin/zsh', spawn: () => out });
  assert.equal(mk({ status: 1, stdout: '/a/claude\n' }).lookupPath(), null);
  assert.equal(mk({ status: 0, stdout: 'claude not found\n' }).lookupPath(), null);
  assert.equal(mk({ status: 0, stdout: '' }).lookupPath(), null);
});
{
  // The real thing, hermetic: a throwaway ZDOTDIR whose .zshrc puts a stub claude first on PATH.
  // An interactive login zsh reads .zshrc; `zsh -lc` does not. The control proves this can tell them apart.
  const haveZsh = existsSync('/bin/zsh');
  if (!haveZsh) console.log('  - skipped: the real-shell check needs /bin/zsh');
  else {
    const zd = mkdtempSync(join(tmpdir(), 'nw-zdot-')); const bind = join(zd, 'bin'); mkdirSync(bind);
    const fake = join(bind, 'claude'); writeFileSync(fake, '#!/bin/sh\necho "0.0.1 (Claude Code)"\n'); chmodSync(fake, 0o755);
    writeFileSync(join(zd, '.zshrc'), `export PATH="${bind}:$PATH"\n`);
    const saved = process.env.ZDOTDIR; process.env.ZDOTDIR = zd;
    try {
      check('the real interactive login zsh reads .zshrc and finds the claude put there', () => {
        const r = realIo({ claudeBin: '/x', wakeCostsPath: join(scratch0, 'none'), kind: 'darwin', shell: '/bin/zsh' });
        assert.equal(r.lookupPath(), fake);
      });
      check('control: a non-interactive login zsh (-lc) does NOT find it, so the check can tell the shells apart', () => {
        const c = spawnSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
        assert.notEqual(String(c.stdout).trim().split('\n').pop(), fake);
      });
    } finally { if (saved === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = saved; rmSync(zd, { recursive: true, force: true }); }
  }
}

// ── the flags wake.sh passes, in claude --help ──
const flagOne = (over) => { const l = flagLines(io({ runHelp: () => HELP(), ...over })); assert.equal(l.length, 1); return l[0]; };
check('flags: every flag wake.sh passes is listed: ok, the path and its source named, and the family caveat said', () => {
  const l = flagOne({});
  assert.match(l, /^ok {6}/); assert.match(l, /\/cfg\/claude \(via paths\.claudeBin\)/);
  for (const { flag } of WAKE_FLAGS) assert.ok(l.includes(flag), flag);
  assert.match(l, /listed as a family/);
});
for (const flag of Object.keys(HELP_LINES)) {
  check(`flags: ${flag} no longer defined in --help is amber and names exactly it, even though prose still mentions it`, () => {
    const l = flagOne({ runHelp: () => HELP([flag]) });
    assert.match(l, /^WARN {4}/); assert.match(l, /before 08:00/);
    const shown = flag === '--append-system-prompt' ? '--append-system-prompt[-file]' : flag;
    assert.ok(l.includes(`no longer lists ${shown}`), l);
    // only that flag is named in the "no longer lists ..." part, never the others
    const namedPart = l.split(', which wake.sh passes')[0];
    for (const other of WAKE_FLAGS.map((f) => f.flag).filter((f) => f !== shown)) assert.ok(!namedPart.includes(other), `${other} wrongly named in: ${l}`);
  });
}
// The fixture that matters: the REAL claude --help (2.1.310), because its description text wraps onto
// continuation lines indented ~40 that name flags too. A hand-written help cannot contain what fooled the first
// version of this check (Opus, 10/25: deleting each flag's definition line from this file left --resume and
// --append-system-prompt "seen" through `^\s+`).
const REAL_HELP = readFileSync(join(MACHINERY, 'testdata', 'claude-help-2.1.310.txt'), 'utf8');
const baseOf = (flag) => flag.replace('[-file]', '');
const optionColumn = (flag) => new RegExp(`^ {1,6}(?:-\\w, )?${baseOf(flag).replace(/[-]/g, '\\-')}(?![\\w-])`);
const withoutDefinition = (help, flag) => help.split('\n').filter((l) => !optionColumn(flag).test(l)).join('\n');
check('flags: the real 2.1.310 help lists all five (ok)', () => {
  assert.match(flagOne({ runHelp: () => REAL_HELP }), /^ok {6}/);
});
check('flags: the fixture really contains deeply indented continuation lines naming --resume and --append-system-prompt (not vacuous)', () => {
  for (const flag of ['--resume', '--append-system-prompt']) {
    assert.ok(REAL_HELP.split('\n').some((l) => /^ {30,}/.test(l) && l.includes(flag)), `no deep line names ${flag}`);
    assert.equal(REAL_HELP.split('\n').filter((l) => optionColumn(flag).test(l)).length, 1, `${flag} should have exactly one definition line`);
  }
});
for (const { flag } of WAKE_FLAGS) {
  check(`flags: on the REAL help with ${flag}'s definition line deleted, exactly that flag is reported missing`, () => {
    const cut = withoutDefinition(REAL_HELP, flag);
    assert.notEqual(cut, REAL_HELP, 'a definition line was removed');
    const l = flagOne({ runHelp: () => cut });
    assert.match(l, /^WARN {4}/);
    const namedPart = l.split(', which wake.sh passes')[0];
    assert.ok(namedPart.includes(`no longer lists ${flag}`), l);
    for (const other of WAKE_FLAGS.map((f) => f.flag).filter((f) => f !== flag)) assert.ok(!namedPart.includes(other), `${other} wrongly named in: ${l}`);
  });
}
check('flags: two flags gone are both named', () => {
  const l = flagOne({ runHelp: () => HELP(['--fork-session', '--model']) });
  assert.match(l, /^WARN {4}/); assert.match(l, /no longer lists --model, --fork-session|no longer lists --fork-session, --model/);
});
check('flags: --append-system-prompt-file need not be its own line (claude does not list it): the family definition is enough', () => {
  assert.match(flagOne({ runHelp: () => HELP() }), /^ok {6}/);
});
check('flags: help that cannot be read is amber, not ok', () => {
  for (const out of [null, '']) assert.match(flagOne({ runHelp: () => out }), /^WARN {4}.*could not read/);
});
check('flags: no claude to ask gives no line (the version lines already said so)', () => {
  assert.deepEqual(flagLines(io({ isExecutable: () => false, lookupPath: () => null, runHelp: () => HELP() })), []);
});
check('flags: never red', () => {
  for (const c of [{}, { runHelp: () => null }, { runHelp: () => HELP(Object.keys(HELP_LINES)) }]) assert.doesNotMatch(flagOne(c), /^(MISSING|BAD)/);
});

// ── the node the background jobs run on, against the floor CI certifies ──
const M = '/hub/machinery';
const nio = (over = {}) => ({
  kind: 'darwin', dir: '/LA', machineryDir: M, realpath: (p) => p,
  readdir: () => ['a.plist', 'b.plist', 'c.txt'],
  readFile: () => '', readPlist: (f) => ({ '/LA/a.plist': ['/n/node22', `${M}/nightshift.mjs`], '/LA/b.plist': ['/n/node20', `${M}/watch.mjs`] })[f] ?? null,
  runNode: (p) => ({ '/n/node22': 'v22.21.1\n', '/n/node20': 'v20.20.2\n' })[p] ?? null, ...over,
});
check('node: NODE_FLOOR is CI\'s node-version; the two cannot drift', () => {
  const yml = readFileSync(join(MACHINERY, '..', '.github', 'workflows', 'linux.yml'), 'utf8');
  const vs = [...yml.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(vs.length >= 1, 'found no node-version in the workflow');
  for (const v of vs) assert.equal(v, NODE_FLOOR, `workflow pins ${v}, NODE_FLOOR is ${NODE_FLOOR}`);
});
check('node: a job at or above the floor is ok, one below is amber, each naming its node path and job file', () => {
  const l = nodeLines(nio());
  assert.equal(l.length, 2);
  assert.match(l[0], /^ok {6}node: the nightshift job runs on node 22\.21\.1 \(\/n\/node22, from a\.plist\), at or above the 22 floor/);
  assert.match(l[1], /^WARN {4}node: the watch job runs on node 20\.20\.2 \(\/n\/node20, from b\.plist\), below the 22 floor CI certifies; it runs, but nothing certifies/);
});
check('node: lines come out nightshift first, then watch, whatever order the directory lists them in', () => {
  const l = nodeLines(nio({ readdir: () => ['b.plist', 'a.plist'] }));
  assert.match(l[0], /the nightshift job/); assert.match(l[1], /the watch job/);
});
check('node: the floor boundary: 21.9.9 is amber, 22.0.0 and 23.1.0 are ok', () => {
  const at = (v) => nodeLines(nio({ readdir: () => ['a.plist'], runNode: () => `v${v}\n` }))[0];
  assert.match(at('21.9.9'), /^WARN/); assert.match(at('22.0.0'), /^ok/); assert.match(at('23.1.0'), /^ok/);
});
check('node: a node that cannot be run for a version is amber, not ok', () => {
  for (const out of [null, '', 'command not found']) assert.match(nodeLines(nio({ readdir: () => ['a.plist'], runNode: () => out }))[0], /^WARN {4}node: .*could not be run for a version/);
});
check('node: another hub\'s jobs, and malformed plists, are ignored: no job for this machinery is a neutral note', () => {
  const l = nodeLines(nio({ readPlist: (f) => ({ '/LA/a.plist': ['/n/node22', '/other/machinery/nightshift.mjs'], '/LA/b.plist': ['/n/node20'] })[f] ?? null }));
  assert.equal(l.length, 1); assert.match(l[0], /^note {4}node: no background job for this machinery \(\/hub\/machinery\) was found in \/LA/);
});
check('node: a missing job directory reads as no jobs (a note), not a crash', () => {
  assert.match(nodeLines(nio({ readdir: () => { throw new Error('ENOENT'); } }))[0], /^note {4}/);
});
check('node: an unknown platform says it cannot tell, neutrally', () => {
  const l = nodeLines(nio({ kind: 'plan9' })); assert.equal(l.length, 1); assert.match(l[0], /^note {4}node: this platform/);
});
check('node: a job found through a symlinked machinery directory still matches (realpath on both sides)', () => {
  const l = nodeLines(nio({ readdir: () => ['a.plist'], realpath: (p) => p.replace('/link/', '/hub/machinery/'), readPlist: () => ['/n/node22', '/link/nightshift.mjs'], machineryDir: M, ...{} }));
  assert.equal(l.length, 1);
  assert.match(l[0], /^ok {6}node: the nightshift job runs on node 22/, 'the symlinked path matched only because both sides go through realpath (a single "no job" note would also be one line)');
});
// A job whose node is not an absolute path is resolved by the JOB's own PATH when it runs; Doctor's `node -v`
// would run Doctor's PATH's node and report THAT as the job's (the same trap as the claude lookup). So it says it
// cannot tell, and does not run anything. An `env node` launcher also hides the script behind a second word.
const bareLine = (over) => { let ran = 0; const l = nodeLines(nio({ readdir: () => ['a.plist'], runNode: () => { ran++; return 'v22.21.1\n'; }, ...over })); return { l, ran }; };
check('node: a plist whose node is a bare `node` is amber: the job\'s own PATH decides, so Doctor does not run its own', () => {
  const { l, ran } = bareLine({ readPlist: () => ['node', `${M}/nightshift.mjs`] });
  assert.equal(l.length, 1); assert.match(l[0], /^WARN {4}node: the nightshift job's command is `node`.*a\.plist.*its own PATH resolves.*cannot say which node/);
  assert.equal(ran, 0, 'Doctor ran a node -v for a job that names no node');
});
check('node: an `/usr/bin/env node` launcher is found (not "no job") and is amber for the same reason', () => {
  const { l, ran } = bareLine({ readPlist: () => ['/usr/bin/env', 'node', `${M}/watch.mjs`] });
  assert.equal(l.length, 1); assert.match(l[0], /^WARN {4}node: the watch job's command is `\/usr\/bin\/env node`/);
  assert.equal(ran, 0);
});
check('node: a relative node path is bare too (./node resolves from the job\'s directory)', () => {
  const { l, ran } = bareLine({ readPlist: () => ['./node', `${M}/nightshift.mjs`] });
  assert.match(l[0], /^WARN {4}node: the nightshift job's command is `\.\/node`/); assert.equal(ran, 0);
});
check('node: systemd ExecStart with a bare node or env node: found, amber, nothing run', () => {
  for (const [exec, shown] of [[`node "${M}/nightshift.mjs"`, '`node`'], [`/usr/bin/env node "${M}/nightshift.mjs"`, '`/usr/bin/env node`'], [`env node ${M}/nightshift.mjs`, '`env node`']]) {
    const { l, ran } = bareLine({ kind: 'linux', dir: '/sd', readdir: () => ['x.service'], readFile: () => `[Service]\nExecStart=${exec}\n` });
    assert.equal(l.length, 1, exec); assert.ok(l[0].startsWith('WARN') && l[0].includes(shown), l[0]); assert.equal(ran, 0, exec);
  }
});
check('node: another hub\'s env-style job is still ignored (the script decides, not the launcher)', () => {
  const { l } = bareLine({ readPlist: () => ['/usr/bin/env', 'node', '/other/machinery/nightshift.mjs'] });
  assert.match(l[0], /^note {4}node: no background job for this machinery/);
});
check('node: an absolute node path is unchanged: run, versioned, ok (the bare rule does not catch it)', () => {
  const l = nodeLines(nio({ readdir: () => ['a.plist'], readPlist: () => ['/n/node22', `${M}/nightshift.mjs`] }));
  assert.equal(l.length, 1); assert.match(l[0], /^ok {6}node: the nightshift job runs on node 22\.21\.1 \(\/n\/node22/);
});
check('node: parseExecWords returns every word, quoted or bare, and null with no ExecStart', () => {
  assert.deepEqual(parseExecWords('ExecStart=/usr/bin/env node "/a b/s.mjs" --flag\n'), ['/usr/bin/env', 'node', '/a b/s.mjs', '--flag']);
  assert.equal(parseExecWords('Restart=always\n'), null);
});
check('node: never red', () => {
  for (const o of [{}, { runNode: () => null }, { readdir: () => [] }, { kind: 'plan9' }]) for (const l of nodeLines(nio(o))) assert.doesNotMatch(l, /^(MISSING|BAD)/);
});
check('node: linux and wsl read the systemd ExecStart, as daemonJob writes it', () => {
  const unit = (n, s) => `[Service]\nExecStart="${n}" "${s}"\nRestart=always\n`;
  const io2 = nio({ kind: 'linux', dir: '/sd', readdir: () => ['x.service', 'y.service', 'z.timer'], readFile: (f) => ({ '/sd/x.service': unit('/n/node22', `${M}/nightshift.mjs`), '/sd/y.service': unit('/n/node20', `${M}/watch.mjs`) })[f] ?? '' });
  const l = nodeLines(io2); assert.equal(l.length, 2); assert.match(l[0], /^ok {6}.*nightshift.*x\.service/); assert.match(l[1], /^WARN {4}.*watch.*y\.service/);
  assert.equal(nodeLines({ ...io2, kind: 'wsl' }).length, 2);
});
check('node: parseExecStart reads quoted, spaced, %%-escaped and bare words, and nothing else', () => {
  assert.deepEqual(parseExecStart('ExecStart="/a b/node" "/c d/s.mjs"\n'), ['/a b/node', '/c d/s.mjs']);
  assert.deepEqual(parseExecStart('x\nExecStart="/n/100%%/node" "/s.mjs"\n'), ['/n/100%/node', '/s.mjs']);
  assert.deepEqual(parseExecStart('ExecStart=/usr/bin/node /s.mjs\n'), ['/usr/bin/node', '/s.mjs']);
  assert.equal(parseExecStart('Restart=always\n'), null); assert.equal(parseExecStart('ExecStart="/only/one"\n'), null); assert.equal(parseExecStart(undefined), null);
});

// the real writer's own files, read back by the real reader (darwin: plutil; linux: the systemd text)
let nodeFix;
{
  const hubDir = mkdtempSync(join(tmpdir(), 'nw-nodejobs-'));
  const jobsDir = join(hubDir, 'jobs'); mkdirSync(jobsDir);
  const fakeNode = (name, v) => { const f = join(hubDir, name); writeFileSync(f, `#!/bin/sh\necho v${v}\n`); chmodSync(f, 0o755); return f; };
  const n22 = fakeNode('node22', '22.21.1'), n20 = fakeNode('node20', '20.20.2');
  const kind = platformKind();
  const put = (jobKind, slug, node, machineryDir) => { const j = daemonJob({ slug, hub: hubDir, jobKind, node, machineryDir, configPath: join(hubDir, 'c.json') }, kind); writeFileSync(join(jobsDir, j.fileName), j.content); return j.fileName; };
  const saved = process.env.NW_INSTALL_DIR; process.env.NW_INSTALL_DIR = jobsDir;
  try {
    const fNs = put('nightshift', 'one', n22, MACHINERY), fW = put('watch', 'one', n20, MACHINERY), fOther = put('nightshift', 'two', n20, join(hubDir, 'some-other-machinery'));
    check('node: reading back files written by the REAL daemonJob (this platform): both jobs found, the other hub\'s ignored', () => {
      const l = nodeLines(nodeRealIo({ machineryDir: MACHINERY }));
      assert.equal(l.length, 2, l.join('\n'));
      assert.ok(l[0].startsWith('ok') && l[0].includes(n22) && l[0].includes(fNs), l[0]);
      assert.ok(l[1].startsWith('WARN') && l[1].includes(n20) && l[1].includes(fW), l[1]);
      assert.ok(!l.join('\n').includes(fOther), 'the other hub\'s job must not appear');
    });
  } finally { if (saved === undefined) delete process.env.NW_INSTALL_DIR; else process.env.NW_INSTALL_DIR = saved; }
  nodeFix = { hubDir, n22, n20, kind };
}

// ── real I/O ──
const scratch = mkdtempSync(join(tmpdir(), 'nw-versioncheck-'));
const stub = (name, body) => { const f = join(scratch, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
check('realIo runs the binary it is given and reads its stdout', () => {
  const s = stub('claude-ok', 'echo "9.9.9 (Claude Code)"');
  assert.equal(parseVersion(realIo({ claudeBin: s, wakeCostsPath: join(scratch, 'none') }).runVersion(s)), '9.9.9');
});
check('realIo: a binary that exits nonzero reads as no output', () => {
  const s = stub('claude-bad', 'echo "9.9.9 (Claude Code)"; exit 3');
  assert.equal(realIo({ claudeBin: s, wakeCostsPath: join(scratch, 'none') }).runVersion(s), null);
});
check('realIo.runHelp reads a binary\'s --help; a nonzero exit or empty output is null', () => {
  const ok = stub('claude-help-ok', 'echo "  --system-prompt-snapshot <on|off>  x"'); const bad = stub('claude-help-bad', 'echo "x"; exit 2'); const empty = stub('claude-help-empty', 'exit 0');
  const r = realIo({ claudeBin: ok, wakeCostsPath: join(scratch, 'none') });
  assert.match(r.runHelp(ok), /system-prompt-snapshot/); assert.equal(r.runHelp(bad), null); assert.equal(r.runHelp(empty), null);
});
check('realIo: isExecutable is false for a missing file and for a file without the bit', () => {
  const r = realIo({ claudeBin: '/x', wakeCostsPath: join(scratch, 'none') });
  const plain = join(scratch, 'plain'); writeFileSync(plain, 'x');
  assert.equal(r.isExecutable(join(scratch, 'absent')), false); assert.equal(r.isExecutable(plain), false);
});
check('realIo: a missing wake-costs file reads as empty', () => {
  assert.equal(realIo({ claudeBin: '/x', wakeCostsPath: join(scratch, 'none') }).wakeCostsText, '');
});

// ── the wiring: the nightshift's own --preflight ──
// fallThrough: the configured claude is MISSING and a stub `claude` is findable only by the lookup the wake
// window's shell would do. On macOS that is an interactive login zsh, so a throwaway ZDOTDIR/.zshrc puts the
// stub dir first on PATH; on Linux and WSL the lookup prefixes the configured claude's own directory, so the
// stub sits there. Either way the stub is not on the child's PATH, so only the fall-through can find it.
function preflightLines(wakeCostsText, claudeBinOk = true, { fallThrough = false, omit = [], installDir, armed = '' } = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'nw-vc-hub-'));
  try {
    for (const d of ['wakecycle', 'ladder', 'projects', 'sessions']) mkdirSync(join(hub, d), { recursive: true });
    const s = stub('claude-hub', `case "$1" in --help) cat <<'NW_HELP_EOF'\n${HELP(omit)}NW_HELP_EOF\n;; *) echo "2.1.310 (Claude Code)";; esac`);
    writeFileSync(join(hub, 'checkpoint.md'), '# checkpoint\n');
    // armed: the armed file's text; null leaves it out, as a hub with nights off has none (#68).
    if (armed !== null) writeFileSync(join(hub, 'wakecycle', 'nightshift.armed'), armed);
    writeFileSync(join(hub, 'ladder', 'wake-costs.jsonl'), wakeCostsText);
    let claudeBin = claudeBinOk ? s : join(hub, 'no-such-claude'); let found = null; const extraEnv = {};
    // On linux and wsl the lookup puts node's own directory first, as the window's PATH does, so a claude installed
    // beside the test's node (npm into the same nvm bin; marginalia's WSL) would win over the stub below. The fall-through
    // case therefore runs the preflight under a copy of node in a directory of its own, where no claude sits.
    let nodeExe = process.execPath, nodeDir = dirname(process.execPath);
    if (fallThrough && platformKind() !== 'darwin') {
      nodeDir = join(hub, 'nodebin'); mkdirSync(nodeDir); nodeExe = join(nodeDir, 'node');
      copyFileSync(process.execPath, nodeExe); chmodSync(nodeExe, 0o755);
    }
    if (installDir) extraEnv.NW_INSTALL_DIR = installDir; // the bench seam: where this platform's background job files are read from
    if (fallThrough) {
      const bin = join(hub, 'stubbin'); mkdirSync(bin);
      found = join(bin, 'claude'); writeFileSync(found, '#!/bin/sh\necho "2.1.310 (Claude Code)"\n'); chmodSync(found, 0o755);
      claudeBin = join(bin, 'claude-missing'); // not there: wake.sh would fall through; on linux/wsl its directory is prefixed onto the lookup's PATH
      if (platformKind() === 'darwin') {
        const zd = join(hub, 'zdot'); mkdirSync(zd); writeFileSync(join(zd, '.zshrc'), `export PATH="${bin}:$PATH"\n`);
        extraEnv.ZDOTDIR = zd; extraEnv.SHELL = '/bin/zsh';
      }
    }
    const cfg = { weftRoot: hub, defaultLane: 'main', lanes: { main: { targetTokens: 250000 } }, notify: { macos: false },
      paths: { workdir: hub, machinery: MACHINERY, transcripts: join(hub, 'projects'), sessions: join(hub, 'sessions'), claudeBin } };
    writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify(cfg));
    const env = { ...process.env, ...extraEnv, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${nodeDir}:/usr/bin:/bin` };
    for (const k of ['NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
    const r = spawnSync(nodeExe, [join(MACHINERY, 'nightshift.mjs'), '--preflight'], { env, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, lines: r.stdout.split('\n'), err: r.stderr, stub: s, found };
  } finally { rmSync(hub, { recursive: true, force: true }); }
}
check('preflight carries the check: an unseen version is amber and the stub path is named', () => {
  const r = preflightLines(rows('2.1.309'));
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^\w+\s+claude /.test(x)); assert.ok(l, r.lines.join('\n'));
  assert.match(l, /^WARN/); assert.match(l, /claude-hub \(via paths\.claudeBin\)/); assert.match(l, /woken: 2\.1\.309/);
  assert.ok(r.lines.some((x) => /preflight complete/.test(x)), 'the rest of the preflight still runs');
});
check('preflight runs on a hub with no armed file, as a nights-off hub has none, and says so (#68)', () => {
  const r = preflightLines(rows('2.1.310'), true, { armed: null });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.lines.some((x) => /armed file parses as: \[DISARMED\] \(raw: \(no file\)\)/.test(x)), r.lines.join('\n'));
  assert.ok(r.lines.some((x) => /preflight complete/.test(x)), 'the rest of the preflight still runs');
});
check('preflight carries the flag check: a --help that lists them is ok, naming the stub; one missing a flag is amber and names it', () => {
  const ok = preflightLines(rows('2.1.310'));
  assert.ok(ok.lines.some((x) => /^ok {6}claude .*claude-hub.*`--help` still lists the flags/.test(x)), ok.lines.join('\n'));
  const gone = preflightLines(rows('2.1.310'), true, { omit: ['--system-prompt-snapshot'] });
  assert.equal(gone.code, 0, gone.err);
  assert.ok(gone.lines.some((x) => /^WARN {4}claude .*no longer lists --system-prompt-snapshot/.test(x)), gone.lines.join('\n'));
  assert.ok(!gone.lines.some((x) => /^(MISSING|BAD)/.test(x) && /claude/.test(x)), 'never red');
});
// The node the background jobs run on, through the nightshift's own --preflight. The job files are written by the
// real daemonJob for this platform and name stub nodes, so the reader, the writer and the wiring agree.
const jobDir = (nightshiftNode, watchNode) => {
  const d = mkdtempSync(join(nodeFix.hubDir, 'jd-'));
  for (const [jobKind, node] of [['nightshift', nightshiftNode], ['watch', watchNode]]) {
    const j = daemonJob({ slug: 'wired', hub: nodeFix.hubDir, jobKind, node, machineryDir: MACHINERY, configPath: join(nodeFix.hubDir, 'c.json') }, nodeFix.kind);
    writeFileSync(join(d, j.fileName), j.content);
  }
  return d;
};
check('preflight carries the node check: a job on node 20 is amber and names the stub, one on 22 is ok', () => {
  const r = preflightLines(rows('2.1.310'), true, { installDir: jobDir(nodeFix.n20, nodeFix.n22) });
  assert.equal(r.code, 0, r.err);
  const l = r.lines.filter((x) => /^(ok|WARN|note) +node:/.test(x));
  assert.equal(l.length, 2, r.lines.join('\n'));
  assert.ok(l[0].startsWith('WARN') && l[0].includes('the nightshift job') && l[0].includes(nodeFix.n20) && l[0].includes('below the 22 floor'), l[0]);
  assert.ok(l[1].startsWith('ok') && l[1].includes('the watch job') && l[1].includes(nodeFix.n22), l[1]);
  assert.ok(!r.lines.some((x) => /^(MISSING|BAD)/.test(x) && /node/.test(x)), 'never red');
});
check('preflight: no job file for this machinery is a note, and the rest of the preflight still runs', () => {
  const r = preflightLines(rows('2.1.310'), true, { installDir: mkdtempSync(join(nodeFix.hubDir, 'empty-')) });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.lines.some((x) => /^note {4}node: no background job for this machinery/.test(x)), r.lines.join('\n'));
  assert.ok(r.lines.some((x) => /preflight complete/.test(x)));
});
check('preflight: a version that has woken is ok; no baseline is a note', () => {
  assert.match(preflightLines(rows('2.1.310')).lines.find((x) => /claude 2\.1\.310/.test(x)), /^ok/);
  assert.match(preflightLines('').lines.find((x) => /claude 2\.1\.310/.test(x)), /^note/);
});
check('preflight: a configured claude that is missing is never reported as the binary, and the line says what was found', () => {
  // Machine-independent and NOT the fall-through test (Opus, 10/25: this passes with the fall-through removed):
  // a box with a claude on PATH says "via PATH"; one without (the CI runner) says none was found.
  const r = preflightLines(rows('2.1.310'), false);
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^(ok|WARN|note)\s+claude/.test(x));
  assert.ok(l && /via PATH|no paths\.claudeBin/.test(l) && !/via paths\.claudeBin/.test(l), r.lines.join('\n'));
});
if (platformKind() === 'darwin' && !existsSync('/bin/zsh')) console.log('  - skipped: the fall-through wiring check needs /bin/zsh on macOS');
else check('preflight: a missing configured claude falls through to the claude the wake window\'s shell finds, on every machine, and the line names it', () => {
  const r = preflightLines(rows('2.1.310'), false, { fallThrough: true });
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^(ok|WARN|note)\s+claude/.test(x));
  assert.ok(l, r.lines.join('\n'));
  assert.ok(l.startsWith('ok') && l.includes(`claude 2.1.310 ${r.found} (via PATH`), l);
});

rmSync(scratch, { recursive: true, force: true });
rmSync(nodeFix.hubDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
