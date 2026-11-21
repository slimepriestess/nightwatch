#!/usr/bin/env node
// identify() — the claude-code adapter's own account of who it speaks for
// (anima_dev/nightwatch_providers_design.md §4), and the lane config's
// provider default. The launch-surface claims are checked against the REAL
// `claude --help` fixtures under machinery/testdata (the #44 lesson: a
// fixture written from docs agrees with the regexp written from the docs),
// never against prose. Writes nothing. Run: node machinery/providers-identify-test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identify } from './providers/claude-code.mjs';
import { laneConfig, providerOf } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}  ${e.message}`); fails++; }
};

check('identify() names the provider and its witness, with no io at all', () => {
  const id = identify();
  assert.equal(id.provider, 'claude-code');
  assert.equal(id.witness, 'api-request-shape');
  assert.equal(id.version, null, 'a version never comes from a guess');
  assert.equal(id.versionSource, null);
  assert.ok(Array.isArray(id.launchSurface) && id.launchSurface.length >= 3);
});

check('a transcript-carried version outranks --version, and names its source', () => {
  const id = identify({ transcriptVersion: '2.1.329', runVersion: () => '9.9.9 (Claude Code)', claudeBin: '/x/claude', isExecutable: () => true, lookupPath: () => null });
  assert.equal(id.version, '2.1.329');
  assert.equal(id.versionSource, 'transcript');
});

check('--version is the fallback source, resolved the way wake.sh resolves the binary', () => {
  const id = identify({ claudeBin: '/x/claude', isExecutable: (p) => p === '/x/claude', lookupPath: () => null, runVersion: (p) => (p === '/x/claude' ? '2.1.330 (Claude Code)' : null) });
  assert.equal(id.version, '2.1.330');
  assert.equal(id.versionSource, '--version');
  assert.equal(id.bin, '/x/claude');
  assert.equal(id.via, 'paths.claudeBin');
});

check('an unreadable --version stays null/null, never a made-up string', () => {
  const id = identify({ claudeBin: '/x/claude', isExecutable: () => true, lookupPath: () => null, runVersion: () => 'garbage' });
  assert.equal(id.version, null);
  assert.equal(id.versionSource, null);
});

check('every launch-surface flag claimed as defined has a definition line in each real --help fixture', () => {
  const fixtures = readdirSync(join(HERE, 'testdata')).filter((f) => /^claude-help-.*\.txt$/.test(f));
  assert.ok(fixtures.length >= 1, 'at least one real fixture exists');
  const { launchSurface } = identify();
  for (const f of fixtures) {
    const help = readFileSync(join(HERE, 'testdata', f), 'utf8');
    for (const s of launchSurface.filter((x) => x.defined && x.kind === 'flag')) {
      // (?![\\w-]) and not \\b: a word boundary would let --model match
      // --model-fallback's definition line (second chair's nit).
      const re = new RegExp(`^\\s+(-\\w, )?${s.name}(?![\\w-])`, 'm');
      assert.ok(re.test(help), `${s.name} has no definition line in ${f}`);
    }
  }
});

check("laneConfig defaults a lane's provider to claude-code, and a configured one wins", () => {
  const cfg = { lanes: { a: {}, b: { provider: 'codex' } } };
  assert.equal(laneConfig(cfg, 'a').provider, 'claude-code');
  assert.equal(laneConfig(cfg, 'b').provider, 'codex');
});

check('providerOf — the one stamp implementation — agrees with the readers about every default', () => {
  const lanes = { a: {}, b: { provider: 'codex' } };
  assert.equal(providerOf(lanes, 'a'), 'claude-code');
  assert.equal(providerOf(lanes, 'b'), 'codex');
  assert.equal(providerOf(lanes, 'unknown-lane'), 'claude-code', 'an unknown lane stamps the readers\' own default');
  assert.equal(providerOf(undefined, 'a'), 'claude-code');
});

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
