// A codex lane's bell, liveness and quiet (anima_dev/nightwatch_codex_lane_plan.md, leg 2b): codexlane.mjs on its own,
// then the REAL nightshift.mjs on a scratch hub: `--ring` (the bell queued with `codex queue`, to a live session only)
// and `--preflight` (one real tick with every act narrated as WOULD, so the real liveSessions and quiet readers decide
// the bell, the close and the orphan floor). No codex runs: paths.codexBin is a stub that records its argv and
// CODEX_HOME, and a live codex session is a stand-in process whose command reads "codex". HOME is the scratch hub too.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexBellPlan, codexBinFor, codexLiveSessions, codexQuietMs, findRollout, isCodexSession, queueBell, BELL_PREFIX } from './codexlane.mjs';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const procs = [];
const stand = (argv0, extra = []) => {   // a process whose command line reads `<argv0> …`
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', ...extra], { argv0, stdio: 'ignore' });
  procs.push(p); return p;
};
const roots = [];
const scratch = (tag) => { const d = mkdtempSync(join(tmpdir(), `nw-codex-bells-${tag}-`)); roots.push(d); return d; };
const SID = '019a0000-0000-7000-8000-0000000000b1';
const rollout = (home, sid, ageMs) => {
  const d = join(home, 'sessions', '2020', '01', '01'); mkdirSync(d, { recursive: true });
  const f = join(d, `rollout-2020-01-01T00-00-00-${sid}.jsonl`); writeFileSync(f, '{"type":"session_meta"}\n');
  if (ageMs != null) { const t = new Date(Date.now() - ageMs); utimesSync(f, t, t); }
  return f;
};

try {
  // ---------------- codexlane.mjs ----------------
  await check('a codex session is codex by its executable, never the app-server daemon, never a claude', () => {
    assert.equal(isCodexSession('/x/vendor/bin/codex resume 019a --no-daemon [nightwatch] hi'), true);
    assert.equal(isCodexSession('/x/packages/app-server-daemon/bin/codex app-server --listen unix:// --managed-daemon'), false);
    assert.equal(isCodexSession('/Users/x/.local/bin/claude --resume abc'), false);
    assert.equal(isCodexSession('node /x/bin/codex resume 019a'), false, 'the node wrapper is not the registered session');
    assert.equal(isCodexSession(''), false);
  });
  await check('live codex sessions: the registry\'s codex rows whose pid runs codex, and no others', async () => {
    const wc = scratch('wc');
    const live = stand('codex', ['resume', SID]), daemon = stand('codex', ['app-server', '--managed-daemon']), other = stand('sleeper'), claudeish = stand('codex');
    await new Promise((r) => setTimeout(r, 300));
    const row = (sid, pid, provider = 'codex', at = new Date().toISOString()) => writeFileSync(join(wc, `lane.${sid}`), JSON.stringify({ lane: 'lark', pid, provider, at }));
    row(SID, live.pid); row('sid-daemon', daemon.pid); row('sid-recycled', other.pid); row('sid-dead', 999999); row('sid-claude', claudeish.pid, 'claude-code');
    const got = codexLiveSessions(wc).map((s) => s.sessionId);
    assert.deepEqual(got, [SID]);
    assert.equal(codexLiveSessions(wc)[0].provider, 'codex');
  });
  await check('a pid recycled onto ANOTHER codex session is not this row\'s session: the process is younger than the row (Sonnet\'s #89 read)', async () => {
    const wc = scratch('wc2'); const p = stand('codex', ['resume', 'some-other-session']); await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(wc, 'lane.sid-week-old'), JSON.stringify({ lane: 'lark', pid: p.pid, provider: 'codex', at: new Date(Date.now() - 7 * 86400e3).toISOString() }));
    writeFileSync(join(wc, 'lane.sid-no-at'), JSON.stringify({ lane: 'lark', pid: p.pid, provider: 'codex' }));
    assert.deepEqual(codexLiveSessions(wc), [], 'a week-old row, and a row with no time, name no live session');
    writeFileSync(join(wc, `lane.${SID}`), JSON.stringify({ lane: 'lark', pid: p.pid, provider: 'codex', at: new Date().toISOString() }));
    assert.deepEqual(codexLiveSessions(wc).map((s) => s.sessionId), [SID]);
  });
  await check('two rows on one pid (a second session in the process): the newest row is the session', async () => {
    const wc = scratch('wc3'); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    // directory order is name order here: the newest row is read last and the oldest first, so first-seen can't pass
    const at = (ms) => JSON.stringify({ lane: 'lark', pid: p.pid, provider: 'codex', at: new Date(t + ms).toISOString() });
    writeFileSync(join(wc, 'lane.sid-a'), at(0)); writeFileSync(join(wc, 'lane.sid-b'), at(1000)); writeFileSync(join(wc, 'lane.sid-c'), at(2000));
    assert.deepEqual(codexLiveSessions(wc).map((s) => s.sessionId), ['sid-c']);
  });
  await check('the bell\'s plan: queue to a running session; skip one whose pid is gone; fail with no codexHome', () => {
    const wc = scratch('wc4');
    writeFileSync(join(wc, `lane.${SID}`), JSON.stringify({ lane: 'lark', pid: 999999, provider: 'codex', at: new Date().toISOString() }));
    assert.deepEqual(codexBellPlan({ sessionId: SID, codexHome: '/h', live: codexLiveSessions(wc) }), { act: 'skip', why: 'not-live' });
    const live = [{ pid: 4, sessionId: SID, provider: 'codex' }];
    assert.deepEqual(codexBellPlan({ sessionId: SID, codexHome: '/h', live }), { act: 'queue' });
    assert.deepEqual(codexBellPlan({ sessionId: SID, codexHome: undefined, live }), { act: 'fail', why: 'no codexHome' });
  });
  await check('quiet is the rollout\'s age; no rollout is null (unknown), never Infinity', () => {
    const home = scratch('home');
    rollout(home, SID, 600_000);
    const q = codexQuietMs(home, SID);
    assert.ok(q >= 599_000 && q < 660_000, String(q));
    assert.equal(codexQuietMs(home, 'no-such-session'), null);
    assert.equal(findRollout(home, 'no-such-session'), null);
    // two rollouts for one id (a resumed session's newer file): the newest is the one read
    const older = rollout(home, 'twice', 0);
    const d2 = join(home, 'sessions', '2020', '01', '02'); mkdirSync(d2, { recursive: true });
    const newer = join(d2, 'rollout-2020-01-02T00-00-00-twice.jsonl'); writeFileSync(newer, '{}\n');
    assert.equal(findRollout(home, 'twice'), newer, `not ${older}`);
  });
  await check('the bell is `codex queue --thread <id>` in the lane\'s CODEX_HOME, prefixed as the machinery\'s', () => {
    const d = scratch('q'); const stub = join(d, 'codex-stub');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(d, 'argv')}"\nprintf '%s' "$CODEX_HOME" > "${join(d, 'home')}"\nexit 0\n`); chmodSync(stub, 0o755);
    const r = queueBell({ codexBin: stub, codexHome: join(d, 'h'), sessionId: SID, text: 'the ritual' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(readFileSync(join(d, 'argv'), 'utf8').trimEnd().split('\n'), ['queue', '--thread', SID, '--message', `${BELL_PREFIX} the ritual`]);
    assert.equal(readFileSync(join(d, 'home'), 'utf8'), join(d, 'h'));
    // a codexHome written as ~/… reaches codex expanded (a literal ~ would be a folder named ~)
    queueBell({ codexBin: stub, codexHome: '~/.nw-test-codex-home', sessionId: SID, text: 'x' });
    assert.equal(readFileSync(join(d, 'home'), 'utf8'), join(homedir(), '.nw-test-codex-home'));
    const bad = join(d, 'codex-fails'); writeFileSync(bad, '#!/bin/sh\necho "no such thread" >&2\nexit 3\n'); chmodSync(bad, 0o755);
    const f = queueBell({ codexBin: bad, codexHome: d, sessionId: SID, text: 'x' });
    assert.equal(f.ok, false); assert.equal(f.status, 3); assert.match(f.stderr, /no such thread/);
  });
  await check('the codex to run: the configured one, else the one beside this node, else PATH\'s', () => {
    const d = scratch('bin'); const c = join(d, 'codex'); writeFileSync(c, '#!/bin/sh\n'); chmodSync(c, 0o755);
    assert.equal(codexBinFor(c, '/nowhere/node'), c);
    assert.equal(codexBinFor(null, join(d, 'node')), c);
    assert.equal(codexBinFor(join(d, 'missing'), '/nowhere/node'), 'codex');
  });

  // ---------------- the real nightshift, on a scratch hub ----------------
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (offsetMin) => { const t = new Date(Date.now() + offsetMin * 60_000); return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; };
  function hub({ codexHome = true, state = null, nextWakeAgeMs = null, graceMs = 0, claudeTranscript = null, armed = true, provider = 'codex' } = {}) {
    const root = scratch('hub');
    for (const d of ['wakecycle', 'ladder', 'projects', 'codex-home', 'bin', 'spool']) mkdirSync(join(root, d), { recursive: true });
    const stub = join(root, 'bin', 'codex-stub');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, 'codex.argv')}"\nprintf '%s' "$CODEX_HOME" > "${join(root, 'codex.home')}"\nexit 0\n`); chmodSync(stub, 0o755);
    const cfg = {
      weftRoot: root, defaultLane: 'lark', timezone: 'UTC',
      // the sleep window holds now, and the wake is hours off (the orphan floor never runs in the last pre-wake hour)
      schedule: { sleep: hm(-60), wake: hm(240), quietMs: 60_000, orphanQuietMs: 60_000, orphanGraceMs: graceMs },
      lanes: { lark: { targetTokens: 250000, provider, ...(codexHome ? { codexHome: join(root, 'codex-home') } : {}) } },
      notify: { macos: false },
      paths: { workdir: root, transcripts: join(root, 'projects'), codexBin: stub, spool: join(root, 'spool') },
    };
    const cfgFile = join(root, 'nightwatch.config.json'); writeFileSync(cfgFile, JSON.stringify(cfg));
    // a Claude Code transcript that happens to carry the codex session's id (#85's collision): Claude's readers must not judge a codex session by it
    if (claudeTranscript) writeFileSync(join(root, 'projects', `${SID}.jsonl`), claudeTranscript.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const get = (k) => spawnSync(process.execPath, [join(MACHINERY, 'config.mjs'), 'get', k], { env: envOf(root, cfgFile), encoding: 'utf8' }).stdout.trim();
    writeFileSync(get('paths.armedFile'), armed ? 'lark\n' : '');
    if (state) writeFileSync(get('paths.stateFile'), JSON.stringify({ lark: state }));
    if (nextWakeAgeMs != null) {
      const nw = join(get('paths.wakecycle'), 'next-wake.lark.json'); writeFileSync(nw, JSON.stringify({ lane: 'lark', sessionId: 'x' }));
      const t = new Date(Date.now() - nextWakeAgeMs); utimesSync(nw, t, t);
    }
    return { root, cfgFile, wc: get('paths.wakecycle'), home: join(root, 'codex-home'), log: get('paths.nightshiftLog') };
  }
  function envOf(root, cfgFile) {
    const e = { ...process.env, HOME: root, NIGHTWATCH_CONFIG: cfgFile, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    for (const k of ['WEFT_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE', 'NIGHTWATCH_NODE', 'CODEX_HOME', 'WEFT_NIGHT_QUIET_MS', 'WEFT_ORPHAN_QUIET_MS', 'WEFT_ORPHAN_GRACE_MS']) delete e[k];
    return e;
  }
  const nightshift = (h, ...args) => spawnSync(process.execPath, [join(MACHINERY, 'nightshift.mjs'), ...args], { env: envOf(h.root, h.cfgFile), encoding: 'utf8', timeout: 60_000 });
  const register = (h, sid, pid) => writeFileSync(join(h.wc, `lane.${sid}`), JSON.stringify({ lane: 'lark', pid, provider: 'codex', at: new Date().toISOString() }));

  await check('--ring queues the bell to the live codex session: its thread, its CODEX_HOME, the ritual naming it', async () => {
    const h = hub(); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    const r = nightshift(h, '--ring', 'lark');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const argv = readFileSync(join(h.root, 'codex.argv'), 'utf8').trimEnd().split('\n');
    assert.deepEqual(argv.slice(0, 4), ['queue', '--thread', SID, '--message']);
    assert.ok(argv[4].startsWith(`${BELL_PREFIX} [nightshift] Sleep-bell for the lark lane`), argv[4].slice(0, 120));
    assert.match(argv.slice(4).join('\n'), new RegExp(`--session ${SID}`), 'the ritual names this session for sleep.mjs');
    assert.equal(readFileSync(join(h.root, 'codex.home'), 'utf8'), h.home);
    assert.match(readFileSync(h.log, 'utf8'), /queued to its thread/);
    assert.equal(existsSync(join(h.root, 'spool', 'lark')) && spawnSync('ls', [join(h.root, 'spool', 'lark')], { encoding: 'utf8' }).stdout.trim() !== '', false, 'no spool note for a codex lane');
  });
  await check('--ring: a codex session whose pid is gone is not awake, and nothing is queued', () => {
    const h = hub(); register(h, SID, 999999);
    const r = nightshift(h, '--ring', 'lark');
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(existsSync(join(h.root, 'codex.argv')), false);
  });
  await check('--ring: a codex lane with no codexHome fails loudly instead of queueing anywhere', async () => {
    const h = hub({ codexHome: false }); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    nightshift(h, '--ring', 'lark');
    assert.equal(existsSync(join(h.root, 'codex.argv')), false);
    assert.match(readFileSync(h.log, 'utf8'), /bell FAILED for lark: a codex lane with no codexHome/);
  });

  // #85's lesson: a codex session id can name a Claude Code transcript too. Each Claude reader must leave a codex session alone.
  const TOO_LONG = [{ type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Prompt is too long' }] } }];
  const FULL = [{ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 995_000 }, content: [{ type: 'text', text: 'ok' }] } }];
  const API_ERR = [{ type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Overloaded' }] } }];
  await check('collision: a Claude transcript of the same id saying "Prompt is too long" doesn\'t stop the codex bell', async () => {
    const h = hub({ claudeTranscript: TOO_LONG }); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    const r = nightshift(h, '--ring', 'lark');
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(existsSync(join(h.root, 'codex.argv')), true, 'queued');
  });
  await check('collision: a nearly full Claude transcript of the same id doesn\'t turn the codex bell into "Sleep now, full"', async () => {
    const h = hub({ claudeTranscript: FULL }); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    const r = nightshift(h, '--ring', 'lark');
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(existsSync(join(h.root, 'codex.argv')), true, 'queued');
    assert.doesNotMatch(readFileSync(h.log, 'utf8'), /SLEEP NOW, FULL/);
  });
  await check('collision: a Claude transcript of the same id ending in an API error doesn\'t cut the codex orphan floor\'s grace', async () => {
    const h = hub({ claudeTranscript: API_ERR, graceMs: 60 * 60_000, state: { belledAt: Date.now() - 5 * 60_000, belledSession: SID }, nextWakeAgeMs: 2 * 3600_000 });
    const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    rollout(h.home, SID, 30 * 60_000);
    const r = nightshift(h, '--preflight');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /WOULD orphan-fold lark/, 'belled 5 minutes ago with an hour of grace: too soon');
  });

  // one real tick (--preflight): the bell, the close and the orphan floor decided by the real readers
  const T = Date.now();
  await check('the scheduled bell sees a live codex session (preflight: WOULD ring)', async () => {
    const h = hub(); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    const r = nightshift(h, '--preflight');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /live sessions: 019a0000…→lark/);
    assert.match(r.stdout, /WOULD ring the sleep-bell for lark/);
  });
  const slept = { belledAt: T - 5 * 60_000, belledSession: SID };
  for (const [what, age, want] of [['a rollout quiet 30 minutes: WOULD close', 30 * 60_000, true], ['a rollout written just now: no close', 0, false], ['no rollout at all: unknown, so no close (Claude Code\'s missing file reads Infinity)', null, false]]) {
    await check(`close after the fold: ${what}`, async () => {
      const h = hub({ state: slept, nextWakeAgeMs: 60_000 }); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
      if (age !== null) rollout(h.home, SID, age);
      const r = nightshift(h, '--preflight');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(/WOULD close panel pid/.test(r.stdout), want, r.stdout.split('\n').filter((l) => /WOULD|decision/.test(l)).join(' | ') || '(no decision lines)');
    });
  }
  const unslept = { belledAt: T - 30 * 60_000, belledSession: SID };
  for (const [what, age, want] of [['belled, never folded, quiet 30 minutes: WOULD orphan-fold', 30 * 60_000, true], ['belled, still writing: no orphan fold', 0, false], ['belled, no rollout found: no orphan fold', null, false]]) {
    await check(`the orphan floor: ${what}`, async () => {
      const h = hub({ state: unslept, nextWakeAgeMs: 2 * 3600_000 }); const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
      if (age !== null) rollout(h.home, SID, age);
      const r = nightshift(h, '--preflight');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(/WOULD orphan-fold lark/.test(r.stdout), want, r.stdout.split('\n').filter((l) => /WOULD|decision/.test(l)).join(' | ') || '(no decision lines)');
    });
  }
  await check('QUIET UNKNOWN: belled past the grace, the session\'s rollout can\'t be found: said once, as an alarm (Sonnet\'s #89 read)', async () => {
    for (const [what, age, want, graceMs] of [['no rollout', null, true, 0], ['a rollout', 0, false, 0], ['no rollout, still inside an hour\'s grace', null, false, 3600_000]]) {
      const h = hub({ state: { belledAt: Date.now() - 30 * 60_000, belledSession: SID }, nextWakeAgeMs: 2 * 3600_000, graceMs });
      const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
      if (age !== null) rollout(h.home, SID, age);
      const r = nightshift(h, '--preflight');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(/\[decision\] QUIET UNKNOWN: lark codex session 019a0000/.test(r.stdout), want, `${what}: ${r.stdout.split('\n').filter((l) => /decision|WOULD/.test(l)).join(' | ')}`);
    }
  });
  await check('QUIET UNKNOWN on a refresh: the old session can\'t read quiet, so the refresh would wait forever: said', async () => {
    // an unarmed lane is ticked for its refresh at any hour (a Fold now's refresh)
    const h = hub({ state: { refreshWake: true, refreshFrom: SID }, nextWakeAgeMs: 60_000, armed: false });
    const p = stand('codex', ['resume', SID]); await new Promise((r) => setTimeout(r, 300)); register(h, SID, p.pid);
    const r = nightshift(h, '--preflight');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[decision\] QUIET UNKNOWN: lark codex session 019a0000.*the refresh can't close it/);
  });
  await check('a Claude Code lane belled past the grace: the unknown-quiet check passes over it without throwing (the `!!cx` guard)', () => {
    const h = hub({ provider: 'claude-code', codexHome: false, state: { belledAt: Date.now() - 30 * 60_000, belledSession: 'claude-session' }, nextWakeAgeMs: 2 * 3600_000 });
    const r = nightshift(h, '--preflight');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /QUIET UNKNOWN/);
    assert.match(r.stdout, /preflight complete/);
  });
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
