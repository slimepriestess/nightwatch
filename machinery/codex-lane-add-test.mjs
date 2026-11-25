#!/usr/bin/env node
// Add agent for a codex lane (codex lane leg 6): nightwatch.mjs lane-add with lane.provider "codex" on a scratch hub,
// activation off (no codex app-server, no Terminal window), and trustLaneHook's logic against a fake app server.
// The real trust ran in the probe sandbox (a fresh, never-signed-in CODEX_HOME: untrusted -> trusted). Nothing here
// touches a real hub or a real CODEX_HOME.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { laneHooksJson, trustLaneHook } from './codexlane.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = async (name, fn) => { try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const scratch = mkdtempSync(join(tmpdir(), 'nw-codex-add-'));
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const env = (cfg) => {
  const e = { ...process.env, WEFT_NW_NO_ACTIVATE: '1' };
  delete e.WEFT_CONFIG; delete e.NIGHTWATCH_CONFIG;
  if (cfg) e.WEFT_CONFIG = cfg;
  return e;
};
const nw = (verb, specPath, cfg) => execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), verb, specPath], { encoding: 'utf8', env: env(cfg) });
const dies = (verb, specPath, cfg) => { try { nw(verb, specPath, cfg); return null; } catch (e) { return String(e.stderr ?? ''); } };

try {
  const hub = join(scratch, 'hub');
  const cfgPath = join(hub, 'nightwatch.config.json');
  nw('apply', spec({ op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { about: 'a scratch persona for the codex lane-add test', person: 'Tester' }, schedule: { sleep: '02:00', wake: '08:00' } }));
  const cfg = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
  const wren = { op: 'lane-add', lane: { id: 'wren', model: 'gpt-6.2-sol', provider: 'codex', firstSession: { kind: 'fresh' } } };

  await check('the plan names the codex home, the hook\'s trust and a Codex first wake that leaves the login to the person', () => {
    const steps = JSON.parse(nw('plan', spec(wren), cfgPath)).steps;
    const say = steps.map((s) => `${s.verb} ${s.what}`);
    assert.ok(say.includes("Make the agent's own Codex home"), say.join(' | '));
    assert.ok(say.includes('Trust that hook in Codex'), say.join(' | '));
    const open = steps.find((s) => s.verb === 'Open');
    assert.match(open.what, /running Codex \(gpt-6\.2-sol\)/);
    assert.match(open.detail, /sign this agent in there \(the login is yours\)/);
    // the home and its hook come before the claim, so a failure leaves no claimed lane
    assert.ok(say.indexOf("Make the agent's own Codex home") < say.findIndex((x) => x.startsWith('Add agent')));
    assert.equal(cfg().lanes.wren, undefined, 'plan writes nothing');
  });

  nw('apply', spec(wren), cfgPath);
  const home = join(hub, 'codex', 'wren');
  await check('apply claims a codex lane with its own CODEX_HOME, named in the config', () => {
    const l = cfg().lanes.wren;
    assert.equal(l.provider, 'codex');
    assert.equal(l.codexHome, home);
    assert.equal(l.model, 'gpt-6.2-sol');
    assert.equal(typeof l.wakePrompt, 'string', 'a codex lane wakes self-propelled too');
  });
  await check('the home exists, private, holding the registration hook that points at this hub\'s machinery', () => {
    assert.equal(statSync(home).mode & 0o777, 0o700);
    const machinery = cfg().paths?.machinery ?? HERE;
    const hooks = readFileSync(join(home, 'hooks.json'), 'utf8');
    assert.equal(hooks, laneHooksJson(machinery));
    assert.match(JSON.parse(hooks).hooks.SessionStart[0].hooks[0].command, /^bash .*\/register-lane\.sh$/);
  });
  await check('the first wake is a creation receipt, like any new agent\'s', () => {
    const r = JSON.parse(readFileSync(join(hub, 'wakecycle', 'next-wake.wren.json'), 'utf8'));
    assert.deepEqual([r.firstWake, r.created, r.lane], [true, true, 'wren']);
  });

  await check('a codex home given explicitly is used and named as given', () => {
    const own = join(scratch, 'elsewhere', 'finch-home');
    nw('apply', spec({ op: 'lane-add', lane: { id: 'finch', model: 'gpt-6.2-sol', provider: 'codex', codexHome: own } }), cfgPath);
    assert.equal(cfg().lanes.finch.codexHome, own);
    assert.ok(existsSync(join(own, 'hooks.json')));
  });

  await check('a home already holding other hooks is refused before the claim: nothing changed, no lane', () => {
    const busy = join(scratch, 'busy-home');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'hooks.json'), '{"hooks":{}}\n');
    const err = dies('apply', spec({ op: 'lane-add', lane: { id: 'kite', model: 'gpt-6.2-sol', provider: 'codex', codexHome: busy } }), cfgPath);
    assert.match(err ?? '', /already there with other hooks; nothing was changed/);
    assert.equal(readFileSync(join(busy, 'hooks.json'), 'utf8'), '{"hooks":{}}\n');
    assert.equal(cfg().lanes.kite, undefined);
  });

  await check('refusals, each one sentence: adopting into codex, a codex hub at init, an unknown provider', () => {
    assert.match(dies('apply', spec({ op: 'lane-add', lane: { id: 'owl', model: 'm', provider: 'codex', firstSession: { kind: 'adopt', sessionId: 'x' } } }), cfgPath) ?? '', /a codex agent starts fresh/);
    assert.match(dies('apply', spec({ op: 'init', hub: join(scratch, 'h2'), lane: { id: 'a', model: 'm', provider: 'codex' }, persona: { about: 'x', person: 'y' } })) ?? '', /added to a hub that exists/);
    assert.match(dies('apply', spec({ op: 'lane-add', lane: { id: 'owl', model: 'm', provider: 'hermes' } }), cfgPath) ?? '', /must be "claude-code" or "codex"/);
    assert.equal(cfg().lanes.owl, undefined);
  });

  await check('a Claude Code agent added the same way gets no codex fields and no codex home', () => {
    nw('apply', spec({ op: 'lane-add', lane: { id: 'beta', model: 'claude-sonnet-5-5' } }), cfgPath);
    const l = cfg().lanes.beta;
    assert.equal('provider' in l || 'codexHome' in l, false);
    assert.equal(existsSync(join(hub, 'codex', 'beta')), false);
  });

  // ---- trustLaneHook, against a fake app server shaped like 0.171.0's answers (sandbox run, 11/25).
  const H = '/h/home';
  const listed = (status) => ({ result: { data: [{ cwd: H, hooks: [
    { key: '/elsewhere/hooks.json:session_start:0:0', sourcePath: '/elsewhere/hooks.json', eventName: 'sessionStart', currentHash: 'sha256:other', trustStatus: 'untrusted' },
    { key: `${H}/hooks.json:session_start:0:0`, sourcePath: `${H}/hooks.json`, eventName: 'sessionStart', currentHash: 'sha256:abc', trustStatus: status },
  ] }] } });
  const fake = (statuses, { writeError = null } = {}) => {
    const seen = [];
    const rpc = async (calls) => calls.map(([m, p]) => { seen.push([m, p]); return m === 'hooks/list' ? listed(statuses.shift()) : (writeError ? { error: { message: writeError } } : { result: {} }); });
    return { rpc, seen };
  };
  await check('trust: an untrusted hook gets exactly the entry Codex\'s UI writes, then reads trusted', async () => {
    const f = fake(['untrusted', 'trusted']);
    const r = await trustLaneHook({ codexHome: H, rpc: f.rpc });
    assert.deepEqual(r, { key: `${H}/hooks.json:session_start:0:0`, hash: 'sha256:abc', wrote: true });
    const w = f.seen.find(([m]) => m === 'config/value/write')[1];
    assert.deepEqual(w, { keyPath: 'hooks.state', mergeStrategy: 'upsert', value: { [`${H}/hooks.json:session_start:0:0`]: { trusted_hash: 'sha256:abc' } } });
  });
  await check('trust: an already-trusted hook writes nothing', async () => {
    const f = fake(['trusted']);
    assert.equal((await trustLaneHook({ codexHome: H, rpc: f.rpc })).wrote, false);
    assert.equal(f.seen.some(([m]) => m === 'config/value/write'), false);
  });
  await check('trust: still untrusted after the write is an error, never a quiet success', async () => {
    await assert.rejects(trustLaneHook({ codexHome: H, rpc: fake(['untrusted', 'untrusted']).rpc }), /still reads the hook as untrusted/);
  });
  await check('trust: a refused write and a missing hook are errors that say so', async () => {
    await assert.rejects(trustLaneHook({ codexHome: H, rpc: fake(['untrusted', 'trusted'], { writeError: 'nope' }).rpc }), /refused to record the hook's trust: nope/);
    await assert.rejects(trustLaneHook({ codexHome: '/other', rpc: fake(['untrusted']).rpc }), /does not list the SessionStart hook/);
  });
} finally {
  if (!fail) rmSync(scratch, { recursive: true, force: true });
  else console.log(`(scratch kept: ${scratch})`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
