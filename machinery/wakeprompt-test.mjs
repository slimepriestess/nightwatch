#!/usr/bin/env node
// wakeprompt-test — new lanes wake self-propelled by default (the dark-
// Saturday class, 10/31: three lanes zero-turn because wakePrompt was set on
// one lane's config only; fixed by hand 11/01; Ra's ruling made product
// 11/11: "nightwatch should wake you without me"). Covers:
//   1. init and lane-add write a default lanes.<id>.wakePrompt
//   2. an explicit spec wakePrompt is used verbatim
//   3. wakePrompt: null opts out (no field written)
//   4. a prompt wake.sh would refuse is refused at CREATION, in one sentence
//   5. wakePromptLines: the Doctor/preflight warning for lanes without one
// Scratch-only, per the rehearsal law: nothing here touches a real hub.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';
import { DEFAULT_WAKE_PROMPT, wakePromptLines, wakePromptProblem } from './versioncheck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const scratch = mkdtempSync(join(tmpdir(), 'nw-wakeprompt-'));
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const run = (specPath, cfg) => {
  const env = { ...process.env, WEFT_NW_NO_ACTIVATE: '1' };
  delete env.WEFT_CONFIG; delete env.NIGHTWATCH_CONFIG; // empty string is not unset (porch-test's lesson)
  if (cfg) env.WEFT_CONFIG = cfg;
  return execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), 'apply', specPath], { encoding: 'utf8', env });
};
const runExpectDie = (specPath, cfg) => {
  try { run(specPath, cfg); return null; }
  catch (e) { return String(e.stderr ?? ''); }
};

try {
  // --- creation defaults -------------------------------------------------
  const hub = join(scratch, 'hub');
  const hubCfg = join(hub, 'nightwatch.config.json');
  const lanes = () => JSON.parse(readFileSync(hubCfg, 'utf8')).lanes;

  run(spec({ op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { about: 'a scratch persona for the wakeprompt test', person: 'Tester' }, schedule: { sleep: '02:00', wake: '08:00' } }));
  check('init writes a default wakePrompt on the first lane', () => {
    const v = lanes().alpha.wakePrompt;
    assert.equal(typeof v, 'string');
    assert.equal(v, DEFAULT_WAKE_PROMPT);
  });
  check('the default itself passes wake.sh\'s own refusal rules (machine-voiced, not a flag, not a bare word)', () => {
    assert.match(DEFAULT_WAKE_PROMPT, /^\[nightwatch\]/);
    assert.equal(wakePromptProblem(DEFAULT_WAKE_PROMPT), null);
  });

  run(spec({ op: 'lane-add', lane: { id: 'beta', model: 'claude-sonnet-5-5', firstSession: { kind: 'fresh' } } }), hubCfg);
  check('lane-add writes the default too', () =>
    assert.equal(lanes().beta.wakePrompt, DEFAULT_WAKE_PROMPT));

  run(spec({ op: 'lane-add', lane: { id: 'gamma', model: 'claude-haiku-5-5', firstSession: { kind: 'fresh' }, wakePrompt: '[nightwatch] custom morning text for gamma' } }), hubCfg);
  check('an explicit spec wakePrompt is used verbatim', () =>
    assert.equal(lanes().gamma.wakePrompt, '[nightwatch] custom morning text for gamma'));

  run(spec({ op: 'lane-add', lane: { id: 'delta', model: 'claude-haiku-5-5', firstSession: { kind: 'fresh' }, wakePrompt: null } }), hubCfg);
  check('wakePrompt: null opts out — no field written', () =>
    assert.equal('wakePrompt' in lanes().delta, false));

  // --- refusals at creation (wake.sh's rules, enforced where a human is) --
  check('a prompt starting with "-" is refused at creation with one sentence', () => {
    const err = runExpectDie(spec({ op: 'lane-add', lane: { id: 'eps', model: 'claude-haiku-5-5', firstSession: { kind: 'fresh' }, wakePrompt: '--dangerously-looks-like-a-flag' } }), hubCfg);
    assert.ok(err !== null, 'apply should have refused');
    assert.match(err, /wakePrompt/);
  });
  check('a single bare word is refused at creation (claude could run it as a subcommand)', () => {
    const err = runExpectDie(spec({ op: 'lane-add', lane: { id: 'zeta', model: 'claude-haiku-5-5', firstSession: { kind: 'fresh' }, wakePrompt: 'doctor' } }), hubCfg);
    assert.ok(err !== null, 'apply should have refused');
    assert.match(err, /wakePrompt/);
  });
  check('a refused lane-add leaves no half-claimed lane behind', () =>
    assert.equal('eps' in lanes() || 'zeta' in lanes(), false));

  // --- the Doctor/preflight lines ----------------------------------------
  check('wakePromptLines warns, amber-voiced, on a lane with no prompt', () => {
    const ls = wakePromptLines({ lanes: { quiet: { model: 'claude-fable-5' } } });
    assert.equal(ls.length, 1);
    assert.match(ls[0], /^WARN/);
    assert.match(ls[0], /quiet/);
    assert.match(ls[0], /wakePrompt/);
  });
  check('wakePromptLines says ok for a lane with a healthy prompt', () => {
    const ls = wakePromptLines({ lanes: { fine: { wakePrompt: DEFAULT_WAKE_PROMPT } } });
    assert.equal(ls.length, 1);
    assert.match(ls[0], /^ok/);
  });
  check('wakePromptLines warns when a set prompt would be refused by wake.sh', () => {
    for (const bad of ['-flag like', 'doctor', 42]) {
      const ls = wakePromptLines({ lanes: { odd: { wakePrompt: bad } } });
      assert.match(ls[0], /^WARN/, `expected WARN for ${JSON.stringify(bad)}`);
      assert.match(ls[0], /refus/i);
    }
  });
  check('wakePromptLines is quiet about a hub with no lanes', () =>
    assert.deepEqual(wakePromptLines({ lanes: {} }), []));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`wakeprompt-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
