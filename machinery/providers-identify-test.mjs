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
import { identify as codexIdentify, parseVersion as codexVersion } from './providers/codex.mjs';
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

// The codex adapter (codex lane leg 5). Its fixtures are the real `codex --help` pages of 0.171.0, one per page the
// machinery runs: the top page (subcommands), `resume --help` (wake.sh's flags), `queue --help` (the bells').
check('codex identify() names the provider and its witness, with no io at all', () => {
  const id = codexIdentify();
  assert.equal(id.provider, 'codex');
  assert.equal(id.witness, 'rollout-developer-part');
  assert.deepEqual([id.version, id.versionSource, id.bin, id.via], [null, null, null, null]);
});

check('codex: the rollout\'s own cli_version outranks --version, and names its source', () => {
  const id = codexIdentify({ rolloutVersion: '0.171.0', codexBin: '/x/codex', runVersion: () => 'codex-cli 9.9.9' });
  assert.deepEqual([id.version, id.versionSource], ['0.171.0', 'rollout']);
});

check('codex: --version is the fallback, and the binary resolves as the machinery runs it (configured, beside node, PATH)', () => {
  const run = (p) => (p === '/c/codex' || p === '/n/bin/codex' || p === '/p/codex' ? 'codex-cli 0.171.0\n' : null);
  const base = { nodePath: '/n/bin/node', lookupPath: (n) => (n === 'codex' ? '/p/codex' : null), runVersion: run };
  let id = codexIdentify({ ...base, codexBin: '/c/codex', isExecutable: () => true });
  assert.deepEqual([id.bin, id.via, id.version, id.versionSource], ['/c/codex', 'paths.codexBin', '0.171.0', '--version']);
  id = codexIdentify({ ...base, codexBin: '/gone/codex', isExecutable: (p) => p === '/n/bin/codex' });
  assert.deepEqual([id.bin, id.via], ['/n/bin/codex', 'beside node']);
  id = codexIdentify({ ...base, isExecutable: () => false });
  assert.deepEqual([id.bin, id.via], ['/p/codex', 'PATH']);
  id = codexIdentify({ ...base, isExecutable: () => false, lookupPath: () => null });
  assert.deepEqual([id.bin, id.via, id.version], [null, null, null]);
});

check('codex: an unreadable --version stays null/null; the real output parses', () => {
  const id = codexIdentify({ codexBin: '/x/codex', isExecutable: () => true, lookupPath: () => null, runVersion: () => 'garbage' });
  assert.deepEqual([id.version, id.versionSource], [null, null]);
  assert.equal(codexVersion(readFileSync(join(HERE, 'testdata', 'codex', 'version-0.171.0.txt'), 'utf8')), '0.171.0');
});

check('codex: every launch-surface claim is defined on its own page of each real --help fixture set', () => {
  const dir = join(HERE, 'testdata', 'codex');
  const versions = [...new Set(readdirSync(dir).map((f) => /^help-(\d+\.\d+\.\d+)\.txt$/.exec(f)?.[1]).filter(Boolean))];
  assert.ok(versions.length >= 1, 'at least one real fixture set exists');
  const { launchSurface } = codexIdentify();
  assert.deepEqual(launchSurface.map((s) => s.name), ['resume', 'queue', '--no-daemon', '--model', '--config', '--thread', '--message'], 'the list itself, literally');
  for (const v of versions) {
    for (const s of launchSurface.filter((x) => x.defined)) {
      const page = readFileSync(join(dir, `help-${v}${s.page ? `-${s.page}` : ''}.txt`), 'utf8');
      const re = s.kind === 'subcommand' ? new RegExp(`^\\s+${s.name}\\s`, 'm') : new RegExp(`^\\s+(-\\w, )?${s.name}(?![\\w-])`, 'm');
      assert.ok(re.test(page), `${s.name} has no definition line in help-${v}${s.page ? `-${s.page}` : ''}.txt`);
    }
  }
});

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
