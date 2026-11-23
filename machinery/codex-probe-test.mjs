// Offline test of the Codex probe kit's file handling (probes/codex/rollout.mjs).
// No codex, no login, no spend. The fixture below is SYNTHETIC, written from
// the 11/20 source read: it tests the planter's own promises, not codex's
// format. P1 replaces this kind of fixture with a real capture.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalFilename, idFromFilename, kindOf, parseRollout, plant, summarize } from '../probes/codex/rollout.mjs';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}  ${e.message}`); }
}

const SRC_ID = '0199aaaa-1111-7222-8333-444455556666';
const L = (o) => JSON.stringify(o);
const fixture = [
  L({ timestamp: '2026-11-21T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: SRC_ID, session_id: SRC_ID, cwd: '/tmp/w', cli_version: '0.171.0', history_mode: 'paginated', history_base: { thread_id: 'x', end_ordinal_exclusive: 3 }, base_instructions: 'BASE' } }),
  L({ timestamp: '2026-11-21T10:00:01.000Z', ordinal: 1, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-x' } }),
  L({ timestamp: '2026-11-21T10:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'remember: heron' }] } }),
  L({ timestamp: '2026-11-21T10:00:03.000Z', ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
  L({ timestamp: '2026-11-21T10:00:04.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, total_tokens: 1000 }, last_token_usage: { input_tokens: 400, total_tokens: 450 }, model_context_window: 200000 }, rate_limits: { primary: { used_percent: 3 } } } }),
  '{"timestamp": "torn',
  L({ timestamp: '2026-11-21T10:00:05.000Z', ordinal: 5, type: 'token_usage_record', payload: { thread_id: SRC_ID, usage: {} } }),
].join('\n') + '\n';
const rows = parseRollout(fixture);
const COMPACTED = { timestamp: '2026-11-21T10:00:06.000Z', ordinal: 9, type: 'compacted', payload: { message: 'summary' } };

check('a torn line is skipped, as codex skips it', () => assert.equal(rows.length, 6));
check('kindOf names the nested kind for event_msg and response_item only', () => {
  assert.deepEqual(rows.map(kindOf), ['session_meta', 'turn_context', 'response_item/message', 'response_item/message', 'event_msg/token_count', 'token_usage_record']);
});
check('summarize reports the facts the design stands on, as found', () => {
  const s = summarize(rows);
  assert.equal(s.firstIsSessionMeta, true);
  assert.equal(s.historyMode, 'paginated');
  assert.equal(s.cliVersion, '0.171.0');
  assert.equal(s.ordinals, 6);
  assert.equal(s.parentChain, false);
  assert.deepEqual(s.messageRoles, { user: 1, assistant: 1 });
  assert.equal(s.tokenCounts, 1);
  assert.equal(s.tokenCountsWithRateLimits, 1);
  assert.equal(s.tokenUsageRecords, 1);
  assert.equal(s.turnContexts, 1);
});
check('filenames: canonical out, id back in (plain, .zst, and a reverted thread)', () => {
  const id = '0199bbbb-1111-7222-8333-444455556666';
  const f = canonicalFilename(id, new Date(2026, 10, 21, 9, 5, 7));
  assert.deepEqual(f, { dir: '2026/11/21', name: `rollout-2026-11-21T09-05-07-${id}.jsonl` });
  assert.equal(idFromFilename(f.name), id);
  assert.equal(idFromFilename(f.name + '.zst'), id);
  assert.equal(idFromFilename(`rollout-2026-11-21T09-05-07-${id}_r2.jsonl`), id);
  assert.equal(idFromFilename('notes.jsonl'), null);
});

const NEW_ID = '0199cccc-1111-7222-8333-444455556666';
const NOW = new Date('2026-11-22T03:00:00.000Z');
check('plant: a fresh id in session_meta, legacy (no history_mode/base, not a fork), no ordinals anywhere', () => {
  const p = plant(rows, { id: NEW_ID, now: NOW });
  const back = parseRollout(p.text);
  assert.equal(back[0].type, 'session_meta');
  assert.equal(back[0].payload.id, NEW_ID);
  assert.equal(back[0].payload.session_id, NEW_ID);
  for (const k of ['history_mode', 'history_base', 'forked_from_id']) assert.equal(k in back[0].payload, false, k);
  assert.equal(back[0].payload.base_instructions, 'BASE', 'the rest of the header is kept');
  assert.equal(back.filter((r) => 'ordinal' in r).length, 0);
  assert.equal(p.filename.name.endsWith(`-${NEW_ID}.jsonl`), true);
});
check('plant: token counts are stripped by default (the amended recipe), and nothing else is', () => {
  const p = plant(rows, { id: NEW_ID, now: NOW });
  assert.deepEqual(p.rows.map(kindOf), ['session_meta', 'turn_context', 'response_item/message', 'response_item/message', 'token_usage_record']);
});
check("plant: 'keep' keeps them as the source has them", () => {
  const p = plant(rows, { id: NEW_ID, now: NOW, tokenCounts: 'keep' });
  assert.equal(p.rows.filter((r) => kindOf(r) === 'event_msg/token_count')[0].payload.info.total_token_usage.total_tokens, 1000);
});
check('plant: { inflate } plants the stale total in BOTH total_ and last_token_usage, and says so (P8)', () => {
  const p = plant(rows, { id: NEW_ID, now: NOW, tokenCounts: { inflate: 937000 } });
  const info = p.rows.filter((r) => kindOf(r) === 'event_msg/token_count')[0].payload.info;
  for (const field of ['total_token_usage', 'last_token_usage']) {
    assert.equal(info[field].total_tokens, 937000, field);
    assert.equal(info[field].input_tokens, 937000, field);
  }
  assert.deepEqual(p.inflated, ['total_token_usage', 'last_token_usage']);
  assert.deepEqual(plant(rows, { id: NEW_ID, now: NOW }).inflated, []);
});
check('plant: a real compacted row leads the tail; a non-compacted row is refused', () => {
  const p = plant(rows, { id: NEW_ID, now: NOW, compacted: COMPACTED });
  assert.equal(p.rows[1].type, 'compacted');
  assert.equal('ordinal' in p.rows[1], false);
  assert.throws(() => plant(rows, { compacted: rows[1] }), /not a compacted row/);
});
check('plant never writes or mutates its source rows (against a fresh parse, so earlier calls count too)', () => {
  plant(rows, { id: NEW_ID, now: NOW, tokenCounts: { inflate: 5 }, compacted: COMPACTED });
  assert.equal(JSON.stringify(rows), JSON.stringify(parseRollout(fixture)));
});
check('plant refuses a source without session_meta first, a bad fromIndex, or an unknown token mode', () => {
  assert.throws(() => plant(rows.slice(1)), /session_meta/);
  assert.throws(() => plant(rows, { fromIndex: 0 }), /outside/);
  assert.throws(() => plant(rows, { tokenCounts: 'nope' }), /tokenCounts/);
});

// The driver's guards, pinned (Selvage's ask on #83). Every case runs under a FAKE $HOME
// (os.homedir() honors it), so nothing of the real user's is in reach, and no case
// reaches a codex spawn except through --codex, which points at /usr/bin/false.
const PROBE = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes', 'codex', 'probe.mjs');
const fake = mkdtempSync(join(tmpdir(), 'codex-probe-test-'));
const fakeHome = join(fake, 'home-user');
mkdirSync(join(fakeHome, '.codex'), { recursive: true });
const env = { ...process.env, HOME: fakeHome };
delete env.CODEX_HOME; delete env.OPENAI_API_KEY;
const probe = (...a) => spawnSync(process.execPath, [PROBE, ...a, '--codex', '/usr/bin/false'], { env, encoding: 'utf8', timeout: 30_000 });
const entries = (d) => readdirSync(d).sort();
try {
  check('guard: a run dir that resolves to the home folder is refused, and nothing is created there', () => {
    const before = entries(fakeHome);
    const r = probe('P1', '--run', join(fakeHome, '.codex', '..'));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /home folder/);
    assert.deepEqual(entries(fakeHome), before);
  });
  check("guard: a run dir that is the home folder's parent is refused", () => {
    const r = probe('P1', '--run', fake);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /home folder/);
  });
  check('guard: a sandbox home that is a symlink to ~/.codex is refused before any codex spawn', () => {
    const run = join(fake, 'linked-run');
    mkdirSync(run);
    symlinkSync(join(fakeHome, '.codex'), join(run, 'home'));
    const r = probe('status', '--run', run);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /is ~\/\.codex/);
    assert.deepEqual(entries(join(fakeHome, '.codex')), []);
  });
  check('guard: --spend on a sandbox that is not logged in is refused', () => {
    const r = probe('P1', '--spend', '--run', join(fake, 'spend-run'));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /not logged in/);
    assert.equal(existsSync(join(fake, 'spend-run', 'results')), false);
  });
  check('control: a dry run in a scratch dir succeeds, prints its command, and writes nothing under results/', () => {
    const run = join(fake, 'dry-run');
    const r = probe('P1', '--run', run);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run/);
    assert.match(r.stdout, / exec --skip-git-repo-check /);
    assert.equal(existsSync(join(run, 'results')), false);
    assert.equal(lstatSync(join(run, 'home')).isDirectory(), true);
  });
  check('a dry run of a later probe before any P1 previews with placeholders instead of refusing', () => {
    for (const p of ['P6', 'P8', 'P2', 'P3']) {
      const r = probe(p, '--run', join(fake, `dry-${p}`));
      assert.equal(r.status, 0, `${p}: ${r.stderr}`);
      assert.match(r.stdout, /<P1 rollout>|<P1 session id>/, p);
    }
  });
} finally {
  rmSync(fake, { recursive: true, force: true });
}

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('all pass');
