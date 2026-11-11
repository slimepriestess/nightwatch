// wake-test.mjs — wake.sh run for real against a scratch hub, with a stub
// claude that records its argv. Each check pins one Linux-port fix and goes
// red when that fix is reverted:
//   - the head file is made with a template GNU mktemp accepts (mktemp -t
//     without XXXs dies on Linux, and set -e took the whole wake with it);
//   - a first wake is exempt from the stale-receipt guard (FIRSTWAKE used to
//     be read after the guard that tests it);
//   - paths.claudeBin is the claude that runs, when it exists;
//   - an emergency wake's receipts name THIS hub's files, not ~/origin/weft.
// The PreCompact guard rides here too: its JSON must parse and name the
// sleep.mjs beside it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

/** A scratch hub with one lane and a stub claude. `receipt` is next-wake's JSON. */
function scratchHub(receipt, { belledAt, lane = {} } = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'nw-wake-'));
  mkdirSync(join(hub, 'wakecycle'), { recursive: true });
  mkdirSync(join(hub, 'ladder'), { recursive: true });
  mkdirSync(join(hub, 'bin'), { recursive: true });
  const stub = join(hub, 'bin', 'claude-stub');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(hub, 'claude.argv')}"\ncp "$3" "${join(hub, 'head.copy')}" 2>/dev/null || true\nfor a in "$@"; do case "$a" in */nightwatch-wake-head.*) cp "$a" "${join(hub, 'head.copy')}";; esac; done\nexit 0\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(hub, 'checkpoint.md'), '# checkpoint\n');
  const cfg = {
    weftRoot: hub, defaultLane: 'main', lanes: { main: { targetTokens: 250000, ...lane } },
    paths: { workdir: hub, machinery: MACHINERY, claudeBin: stub },
  };
  writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify(cfg));
  writeFileSync(join(hub, 'wakecycle', 'next-wake.main.json'), JSON.stringify({ lane: 'main', checkpoint: join(hub, 'checkpoint.md'), ...receipt }));
  if (belledAt) writeFileSync(join(hub, 'wakecycle', 'nightshift.state.json'), JSON.stringify({ main: { belledAt } }));
  return hub;
}
function runWake(hub) {
  return spawnSync('sh', [join(MACHINERY, 'wake.sh'), 'main'], {
    env: { ...process.env, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 30000,
  });
}

check('a first wake reaches the configured claude (GNU mktemp, paths.claudeBin)', () => {
  const hub = scratchHub({ firstWake: true });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    const argv = readFileSync(join(hub, 'claude.argv'), 'utf8');
    assert.match(argv, /--append-system-prompt-file/);
    assert.doesNotMatch(argv, /--resume/, 'a first wake must not resume');
    assert.match(readFileSync(join(hub, 'nightshift.log'), 'utf8'), /wake receipt: main lane reached exec/);
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('a wake runs the node it was handed (NIGHTWATCH_NODE), never a different one on PATH, and passes it on (10/25)', () => {
  // The window's shell PATH found Homebrew's Node 20 while the daemon ran 22. Here a decoy `node` sits FIRST
  // on PATH and leaves a mark if it ever runs; NIGHTWATCH_NODE is a wrapper that logs each use, then runs
  // the real node. The claude stub records what NIGHTWATCH_NODE it inherited (its hooks and agent shells).
  const hub = scratchHub({ firstWake: true });
  try {
    const decoy = join(hub, 'decoy'); mkdirSync(decoy);
    writeFileSync(join(decoy, 'node'), `#!/bin/sh\ntouch "${join(hub, 'decoy-ran')}"\nexit 97\n`); chmodSync(join(decoy, 'node'), 0o755);
    const wrap = join(hub, 'bin', 'node-wrapper');
    writeFileSync(wrap, `#!/bin/sh\necho "$1" >> "${join(hub, 'wrapper.log')}"\nexec "${process.execPath}" "$@"\n`); chmodSync(wrap, 0o755);
    writeFileSync(join(hub, 'bin', 'claude-stub'), `#!/bin/sh\nprintf '%s' "\${NIGHTWATCH_NODE-unset}" > "${join(hub, 'claude.node')}"\n`);
    const r = spawnSync('sh', [join(MACHINERY, 'wake.sh'), 'main'], {
      env: { ...process.env, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), NIGHTWATCH_NODE: wrap, PATH: `${decoy}:/usr/bin:/bin` },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    assert.equal(existsSync(join(hub, 'decoy-ran')), false, 'the PATH node ran');
    assert.match(readFileSync(join(hub, 'wrapper.log'), 'utf8'), /config\.mjs/, 'the handed node read the config');
    assert.equal(readFileSync(join(hub, 'claude.node'), 'utf8'), wrap, 'claude did not inherit the handed node');
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('a hand run without NIGHTWATCH_NODE uses the shell\'s node and exports nothing', () => {
  const hub = scratchHub({ firstWake: true });
  try {
    writeFileSync(join(hub, 'bin', 'claude-stub'), `#!/bin/sh\nprintf '%s' "\${NIGHTWATCH_NODE-unset}" > "${join(hub, 'claude.node')}"\n`);
    const env = { ...process.env, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    delete env.NIGHTWATCH_NODE;
    const r = spawnSync('sh', [join(MACHINERY, 'wake.sh'), 'main'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(join(hub, 'claude.node'), 'utf8'), 'unset');
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('a first wake is not refused as stale, even with a later bell on record', () => {
  const hub = scratchHub({ firstWake: true }, { belledAt: Date.now() + 3_600_000 });
  try {
    const r = runWake(hub);
    assert.doesNotMatch(r.stdout, /STALE RECEIPT/);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('a resumed wake IS refused when the bell postdates its receipt (the guard still works)', () => {
  const hub = scratchHub({ sessionId: '00000000-0000-0000-0000-000000000000' }, { belledAt: Date.now() + 3_600_000 });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /STALE RECEIPT/);
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check("an emergency wake's receipts name this hub's files, not ~/origin/weft", () => {
  const hub = scratchHub({ sessionId: '00000000-0000-0000-0000-000000000001', emergency: true, sleptAt: 'x', from: 'y', unauthoredSpan: { note: 'note' } });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    const head = readFileSync(join(hub, 'head.copy'), 'utf8');
    assert.match(head, /Emergency wake/);
    assert.doesNotMatch(head, /origin\/weft/);
    assert.ok(head.includes(join(hub, 'wakecycle', 'next-wake.main.json')), head.slice(-300));
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('the PreCompact guard blocks with valid JSON naming the sleep.mjs beside it', () => {
  const env = { ...process.env }; delete env.NIGHTWATCH_NODE;
  const out = execFileSync('sh', [join(MACHINERY, 'precompact-guard.sh')], { encoding: 'utf8', env });
  const j = JSON.parse(out);
  assert.equal(j.decision, 'block');
  assert.ok(j.reason.includes(`node ${MACHINERY}/sleep.mjs`), j.reason);
  assert.doesNotMatch(j.reason, /origin\/weft/);
});
check('the PreCompact guard names the node its session inherited, JSON-safe however it is spelled (10/25)', () => {
  const odd = '/n "q" \\ dir/node';
  const out = execFileSync('sh', [join(MACHINERY, 'precompact-guard.sh')], { encoding: 'utf8', env: { ...process.env, NIGHTWATCH_NODE: odd } });
  const j = JSON.parse(out);
  assert.ok(j.reason.includes(`${odd} ${MACHINERY}/sleep.mjs`), j.reason);
});

// The saved head (item 2 of the compatibility guard): wake.sh keeps the head it built beside the
// receipt so the watch can check the woken session's recorded system prompt against it. Best
// effort, atomic, and unable to stop the launch.
import { readdirSync, mkdirSync as mkdirSyncSh } from 'node:fs';
check('a wake saves the head it built: the checkpoint plus the duties, byte for byte what claude was given', () => {
  const hub = scratchHub({ firstWake: true });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    const kept = readFileSync(join(hub, 'wakecycle', 'last-head.main'), 'utf8');
    assert.equal(kept, readFileSync(join(hub, 'head.copy'), 'utf8'), 'the saved head is the head claude was given');
    assert.ok(kept.startsWith('# checkpoint\n'), 'it starts with the checkpoint'); assert.match(kept, /## Standing wake duties/);
    assert.deepEqual(readdirSync(join(hub, 'wakecycle')).filter((f) => f.includes('.tmp.')), [], 'no half-written copy is left beside it');
  } finally { rmSync(hub, { recursive: true, force: true }); }
});
function runWakeBehind(hub, shimDir) {
  return spawnSync('sh', [join(MACHINERY, 'wake.sh'), 'main'], {
    env: { ...process.env, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${shimDir}:${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 30000,
  });
}
for (const [what, shim] of [['cp', 'case "$*" in *last-head*) exit 1;; esac\nexec /bin/cp "$@"'], ['mv', 'case "$*" in *last-head*) exit 1;; esac\nexec /bin/mv "$@"']]) {
  check(`a failing ${what} of the saved head cannot stop the launch: claude still starts, and no half copy is left`, () => {
    const hub = scratchHub({ firstWake: true });
    try {
      mkdirSyncSh(join(hub, 'shim'), { recursive: true });
      writeFileSync(join(hub, 'shim', what), `#!/bin/sh\n${shim}\n`); chmodSync(join(hub, 'shim', what), 0o755);
      const r = runWakeBehind(hub, join(hub, 'shim'));
      assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
      assert.ok(existsSync(join(hub, 'claude.argv')), 'claude was launched');
      assert.match(readFileSync(join(hub, 'nightshift.log'), 'utf8'), /wake receipt: main lane reached exec/);
      assert.ok(!existsSync(join(hub, 'wakecycle', 'last-head.main')), 'nothing was saved');
      assert.deepEqual(readdirSync(join(hub, 'wakecycle')).filter((f) => f.includes('.tmp.')), [], 'and no temp file was left behind');
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
}

// The wake prompt (lanes.<name>.wakePrompt): claude's positional prompt, the woken session's first user
// turn, so a lane starts its morning without a human typing. The stub writes one argv element per line.
const argvOf = (hub) => readFileSync(join(hub, 'claude.argv'), 'utf8').replace(/\n$/, '').split('\n');
const WAKE_PROMPT = `[nightwatch] it's "10:00": arm $NIGHTWATCH_LANE's watcher, then \`date\` and the receipts`;
for (const [what, receipt] of [['first wake', { firstWake: true }], ['resumed wake', { sessionId: '00000000-0000-0000-0000-000000000002' }]]) {
  check(`a ${what} with no wakePrompt passes no prompt: the argv ends at the flags, as before`, () => {
    const hub = scratchHub(receipt);
    try {
      const r = runWake(hub);
      assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(argvOf(hub).slice(-2), ['--system-prompt-snapshot', 'off']);
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
  check(`a ${what} with a wakePrompt passes it last, as one argument, quote and $ and backticks as written`, () => {
    const hub = scratchHub(receipt, { lane: { wakePrompt: WAKE_PROMPT } });
    try {
      const r = runWake(hub);
      assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
      const argv = argvOf(hub);
      assert.deepEqual(argv.slice(-3), ['--system-prompt-snapshot', 'off', WAKE_PROMPT]);
      if (receipt.sessionId) assert.deepEqual(argv.slice(0, 3), ['--resume', receipt.sessionId, '--fork-session']);
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
}
// A wakePrompt claude would misread is refused, logged, and the wake goes on without it (Opus's asks on #53):
// a hand-edited non-string (`get` would stringify 42 into the prompt "42"), a leading "-" (a flag), and a
// bare word (claude could run it as a subcommand: "doctor", "update").
for (const [what, bad, why] of [['a number', 42, /it is a number, not text/], ['a leading "-"', '--dangerously-skip-permissions now', /starts with "-"/], ['a bare word', 'doctor', /single bare word/]]) {
  check(`a wakePrompt that is ${what} is ignored with a log line, and the wake still launches without a prompt`, () => {
    const hub = scratchHub({ firstWake: true }, { lane: { wakePrompt: bad } });
    try {
      const r = runWake(hub);
      assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(argvOf(hub).slice(-2), ['--system-prompt-snapshot', 'off']);
      const log = readFileSync(join(hub, 'nightshift.log'), 'utf8');
      assert.match(log, /lanes\.main\.wakePrompt ignored/); assert.match(log, why);
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
}

// The app's write side: config.mjs `set` goes through the LANE_KEYS whitelist, so wakePrompt must be on it
// (the mutant that dropped it survived #53's first read), and it takes text, not a number.
check('config.mjs set writes lanes.<name>.wakePrompt as text and refuses a number', () => {
  const hub = scratchHub({ firstWake: true });
  const cfgFile = join(hub, 'nightwatch.config.json');
  const cli = (...a) => spawnSync(process.execPath, [join(MACHINERY, 'config.mjs'), ...a], { env: { ...process.env, NIGHTWATCH_CONFIG: cfgFile, WEFT_CONFIG: cfgFile }, encoding: 'utf8' });
  try {
    const ok = cli('set', 'lanes.main.wakePrompt', '[nightwatch] woken: arm your watcher');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).lanes.main.wakePrompt, '[nightwatch] woken: arm your watcher');
    const no = cli('set', 'lanes.main.wakePrompt', '42');
    assert.equal(no.status, 1); assert.match(no.stderr, /not text/); // the set verb now speaks wakePromptProblem's words (one implementation for all four writers)
    assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).lanes.main.wakePrompt, '[nightwatch] woken: arm your watcher', 'a refused set wrote anyway');
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
