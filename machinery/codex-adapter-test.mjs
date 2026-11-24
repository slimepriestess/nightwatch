// The Codex rollout adapter (providers/codex.mjs) and trim.mjs's --provider flag.
// Fixtures are REAL rollouts written by codex-cli 0.171.0 in the probe sandbox, scrubbed for a public
// repo by testdata/codex/scrub.py (every row, key, type and ordinal kept; identifiers and long text cut):
//   two-turns.jsonl  the P1 session (code word HERON-19D577) plus P3's resumed second turn
//   compacted.jsonl  P8's stale plant after resume: Codex's own `compacted` row inside a later turn
// No codex runs here and nothing is spent. The resume half was run by hand (the PR says how).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { trimTail } from './trim-core.mjs';
import * as codex from './providers/codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'testdata', 'codex');
const lines = (f) => readFileSync(join(FX, f), 'utf8').split('\n').filter((l) => l.trim());
const kind = (l) => { const e = JSON.parse(l); const t = e.payload?.type; return (e.type === 'event_msg' || e.type === 'response_item') && t ? `${e.type}/${t}` : e.type; };

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}  ${e.message}`); }
}
const fold = (ls, target) => trimTail({ lines: ls, adapter: codex, target, imageBudget: 1_000_000, warn: () => {} });
const TWO = lines('two-turns.jsonl');

check('the fixture is the shape P1 recorded (a literal list, so fixture drift shows here)', () => {
  assert.deepEqual([...new Set(TWO.map(kind))].sort(), [
    'event_msg/item_completed', 'event_msg/task_complete', 'event_msg/task_started', 'event_msg/thread_settings_applied',
    'event_msg/token_count', 'response_item/additional_tools', 'response_item/message', 'session_meta',
    'token_usage_record', 'turn_context', 'world_state',
  ]);
  assert.equal(JSON.parse(TWO[0]).payload.history_mode, 'paginated');
  assert.equal(TWO.every((l) => 'ordinal' in JSON.parse(l)), true);
});

check('a whole-session fold: legacy header, no ordinals, no token_count or usage record, everything else kept', () => {
  const r = fold(TWO, 250_000);
  assert.equal(r.refused, undefined, r.refused?.message);
  const k = r.keptLines.map(kind);
  assert.equal(k[0], 'session_meta');
  const meta = JSON.parse(r.keptLines[0]).payload;
  for (const f of ['history_mode', 'history_base', 'forked_from_id']) assert.equal(f in meta, false, f);
  assert.equal(r.keptLines.some((l) => 'ordinal' in JSON.parse(l)), false);
  assert.equal(k.includes('event_msg/token_count'), false);
  assert.equal(k.includes('token_usage_record'), false);
  assert.equal(r.keptLines.length, TWO.length - 4);
  assert.equal(r.facts.counts.tokenCountsDropped, 2);
  assert.equal(r.facts.counts.usageRecordsDropped, 2);
  assert.equal(r.keptLines.join('\n').includes('HERON-19D577'), true);
});

check('a cut at the second turn keeps the header and the first turn\'s preamble, then the turn', () => {
  const r = fold(TWO, 500);
  assert.equal(r.refused, undefined, r.refused?.message);
  assert.equal(r.facts.cut, 19);
  assert.deepEqual(r.keptLines.map(kind), [
    'session_meta',
    'response_item/additional_tools', 'response_item/message', 'response_item/message', 'response_item/message',
    'response_item/message', 'response_item/message', 'world_state',
    'event_msg/task_started', 'response_item/message', 'world_state', 'turn_context', 'response_item/message',
    'event_msg/item_completed', 'event_msg/item_completed', 'response_item/message', 'event_msg/task_complete',
  ]);
  const text = r.keptLines.join('\n');
  assert.equal(text.includes('HERON-19D577'), false, 'the first turn\'s prompt is cut');
  assert.equal(text.includes('Reply with just: resumed.'), true);
  assert.equal(r.keptLines.filter((l) => kind(l) === 'session_meta').length, 1);
});

check('the kept preamble carries no UI event rows (an event inside the first turn\'s preamble stays behind)', () => {
  const ev = JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'thread_settings_applied', marker: 'PREAMBLE-EVENT' } });
  const withEvent = [...TWO.slice(0, 3), ev, ...TWO.slice(3)];
  const r = fold(withEvent, 500);
  assert.equal(r.refused, undefined, r.refused?.message);
  assert.equal(r.keptLines.join('\n').includes('PREAMBLE-EVENT'), false);
});

check('a cut never opens mid-turn: every seam is a task_started', () => {
  const seams = TWO.map((l, i) => (codex.isSeam(codex.parse(l)) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(seams, [1, 19]);
});

check('a rollout with Codex\'s own compacted row folds, the compacted row kept', () => {
  const r = fold(lines('compacted.jsonl'), 250_000);
  assert.equal(r.refused, undefined, r.refused?.message);
  assert.equal(r.keptLines.map(kind).includes('compacted'), true);
  assert.equal(r.keptLines.map(kind).includes('event_msg/token_count'), false);
});

const good = fold(TWO, 250_000).keptLines;
const edit = (ls, i, f) => ls.map((l, j) => (j === i ? JSON.stringify(f(JSON.parse(l))) : l));
check('validate passes the folded tail and refuses each thing P6/P8 showed a wake cannot carry', () => {
  assert.deepEqual(codex.validate(good), []);
  const tc = TWO.find((l) => kind(l) === 'event_msg/token_count');
  assert.match(codex.validate([...good, tc]).join(';'), /token_count/);
  const ur = TWO.find((l) => kind(l) === 'token_usage_record');
  assert.match(codex.validate([...good, ur]).join(';'), /token_usage_record/);
  assert.match(codex.validate(edit(good, 3, (e) => ({ ...e, ordinal: 3 }))).join(';'), /ordinal/);
  for (const f of ['history_mode', 'history_base', 'forked_from_id']) {
    assert.match(codex.validate(edit(good, 0, (e) => ({ ...e, payload: { ...e.payload, [f]: 'x' } }))).join(';'), new RegExp(f));
  }
  assert.match(codex.validate(good.slice(1)).join(';'), /session_meta/);
  assert.match(codex.validate([good[0], ...good]).join(';'), /more than one/);
  assert.match(codex.validate(['not json', ...good]).join(';'), /parse/);
  const noTurn = good.filter((l) => kind(l) !== 'event_msg/task_started');
  assert.match(codex.validate(noTurn).join(';'), /no turn start/);
  const asst = good.find((l) => kind(l) === 'response_item/message' && JSON.parse(l).payload.role === 'assistant');
  assert.match(codex.validate([good[0], asst, ...good.slice(1)]).join(';'), /assistant message sits before/);
});

check('validate refuses a call kept without its output, and an output without its call', () => {
  const call = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec' } });
  const out = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } });
  assert.deepEqual(codex.validate([...good, call, out]), []);
  assert.match(codex.validate([...good, call]).join(';'), /function_call c1 kept without its output/);
  assert.match(codex.validate([...good, out]).join(';'), /function_call_output c1 kept without its call/);
});

check('trim-core refuses the write when validate finds a problem (the gate is on the write path)', () => {
  const broken = { ...codex, keep: (entries, ls, ord) => ({ kept: ord.map((i) => ({ line: ls[i], entry: entries[i] })), counts: { tokenCountsDropped: 0, usageRecordsDropped: 0, ordinalsStripped: 0 } }) };
  const r = trimTail({ lines: TWO, adapter: broken, target: 250_000, imageBudget: 1e6, warn: () => {} });
  assert.match(r.refused?.message ?? '', /OUTPUT CHECK FAILED.*token_count/);
});

check('newSession: today\'s folder under the same sessions root, a canonical name, the new id in the header only', () => {
  const src = '/x/home/sessions/2026/11/23/rollout-2026-11-23T11-17-02-01a209d7-1979-7202-8277-799c4198fdf9.jsonl';
  const now = new Date(2026, 11, 2, 3, 4, 5);
  const id = '0199cccc-1111-7222-8333-444455556666';
  const { path, text } = codex.newSession(good, { srcPath: src, newId: id, now });
  assert.equal(path, `/x/home/sessions/2026/12/02/rollout-2026-12-02T03-04-05-${id}.jsonl`);
  const out = text.trimEnd().split('\n');
  assert.equal(JSON.parse(out[0]).payload.id, id);
  assert.equal(JSON.parse(out[0]).payload.session_id, id);
  assert.deepEqual(out.slice(1), good.slice(1), 'every other line byte for byte');
  assert.equal(codex.sessionIdOf(path), id);
  assert.equal(codex.sessionIdOf(src + '.zst'), '01a209d7-1979-7202-8277-799c4198fdf9');
});

check('images: an older data: image past the budget becomes text; the newest stays', () => {
  const img = (n) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(n) });
  const row = { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [img(600), { type: 'input_text', text: 'hi' }, img(500)] } };
  let used = 0;
  const take = (b) => { if (used + b <= 600) { used += b; return true; } return false; };
  const out = codex.stripImages(row, take, 600);
  assert.equal(out.payload.content[2].type, 'input_image');
  assert.equal(out.payload.content[0].type, 'input_text');
  assert.match(out.payload.content[0].text, /image removed at fold/);
  assert.equal(row.payload.content[0].type, 'input_image', 'the input row is not mutated');
  assert.equal(codex.mayCarryImages(JSON.stringify(row)), true);
});

// The command, on a scratch copy of the fixture laid out as a sessions tree.
const TRIM = join(HERE, 'trim.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'codex-adapter-test-'));
// A long-past day folder, so the fold's own day folder (today's) never exists beforehand: the write must create it
// (CI went red at 00:56Z on 11/24, the first run after UTC midnight, when it didn't).
const day = join(scratch, 'sessions', '2020', '01', '01');
mkdirSync(day, { recursive: true });
const SRC = join(day, 'rollout-2026-11-23T11-17-02-01a209d7-1979-7202-8277-799c4198fdf9.jsonl');
copyFileSync(join(FX, 'two-turns.jsonl'), SRC);
const env = { ...process.env };
for (const k of ['WEFT_CONFIG', 'NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
const run = (...a) => spawnSync(process.execPath, [TRIM, ...a], { encoding: 'utf8', env, timeout: 30_000 });
try {
  check('trim.mjs --provider codex writes the fold into the sessions tree and leaves the source alone', () => {
    const before = readFileSync(SRC);
    const r = run('--provider', 'codex', SRC, '--target-tokens', '250000');
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(existsSync(rep.path), true);
    assert.equal(rep.path.startsWith(join(scratch, 'sessions')), true);
    assert.equal(rep.codexVersion, '0.171.0');
    assert.equal(rep.tokenCountsDropped, 2);
    assert.deepEqual(readFileSync(SRC), before);
    assert.deepEqual(codex.validate(readFileSync(rep.path, 'utf8').trimEnd().split('\n')), []);
  });
  check('without --target-tokens the target is 250,000 (it used to be NaN, and every flagless run refused)', () => {
    const r = run('--provider=codex', SRC, '--dry');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).targetTokens, 250000);
    assert.equal(run('--provider', 'codex', SRC, '--target-tokens', 'lots', '--dry').status, 2);
  });
  check('refusals: an unknown provider, a missing codex path, a compressed rollout', () => {
    assert.equal(run('--provider', 'nope', SRC).status, 2);
    assert.match(run('--provider', 'codex', join(day, 'missing.jsonl')).stderr, /named by its path/);
    writeFileSync(SRC + '.zst', 'zst');
    const z = run('--provider', 'codex', SRC + '.zst');
    assert.equal(z.status, 2);
    assert.match(z.stderr, /compressed/);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('all pass');
