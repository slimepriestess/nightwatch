// Leg 3's witness (codexlane.mjs codexHeadWitness): did a codex wake's head carry its checkpoint, and is it the only
// head? Fixtures are three REAL woken rollouts from leg 3's probe (11/25, codex-cli 0.171.0, the sandbox CODEX_HOME),
// scrubbed by testdata/codex/scrub.py; each was folded, then resumed with `-c developer_instructions=<head>`:
//   witness-good.jsonl     the new fold, a second generation woken as BIRCH: the model answered BIRCH (kept 24)
//   witness-doubled.jsonl  only turn_context stripped: the checkpoint recorded beside a doubled head, and the model
//                          answered that it had none, twice (kept 24)
//   witness-missing.jsonl  main's fold of the same first generation, woken as BIRCH: the model answered with the OLD
//                          name, and the new head was never written (kept 30)
// No codex runs here and nothing is spent.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexHeadWitness } from './codexlane.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'codex');
const rows = (f) => readFileSync(join(FX, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const BIRCH = 'This is your checkpoint. For this session your name is BIRCH; use it when anyone asks your name.';
const KESTREL = 'Your checkpoint code word is KESTREL-8A1F.';
const GOOD = rows('witness-good.jsonl');
const DOUBLED = rows('witness-doubled.jsonl');
const MISSING = rows('witness-missing.jsonl');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}  ${e.message}`); }
}
const dev = (text) => ({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } });

check('a good wake: the head is one exact developer part in the woken rows, and the file holds one head', () => {
  assert.deepEqual(codexHeadWitness({ rows: GOOD, appendedFrom: 24, head: BIRCH }), { status: 'ok', seen: 1, tools: 1, fullStates: 1 });
});

check('a doubled head is caught though the checkpoint is present (the case where presence lies)', () => {
  const w = codexHeadWitness({ rows: DOUBLED, appendedFrom: 24, head: KESTREL });
  assert.equal(w.status, 'doubled');
  assert.equal(w.seen, 1, 'the checkpoint IS in the rows');
  assert.deepEqual([w.tools, w.fullStates], [2, 2]);
});

check('doubled outranks missing: a doubled file without the head is told as doubled (the fold is what to fix)', () => {
  const w = codexHeadWitness({ rows: DOUBLED, appendedFrom: 24, head: BIRCH });
  assert.deepEqual([w.status, w.seen], ['doubled', 0]);
});

check('a head never written is missing', () => {
  assert.deepEqual(codexHeadWitness({ rows: MISSING, appendedFrom: 30, head: BIRCH }), { status: 'missing', seen: 0, tools: 1, fullStates: 1 });
});

check('the match is exact: a head one character off is missing', () => {
  assert.equal(codexHeadWitness({ rows: GOOD, appendedFrom: 24, head: BIRCH.replace('BIRCH', 'BIRCHX') }).status, 'missing');
  assert.equal(codexHeadWitness({ rows: GOOD, appendedFrom: 24, head: BIRCH + '\n' }).status, 'missing');
  // a part that only contains the head (a section quoting it, say) is not Codex rendering the head as its own part
  const quoted = MISSING.map((r, i) => (i === 35 ? dev(`Earlier notes: ${BIRCH}`) : r));
  assert.equal(codexHeadWitness({ rows: quoted, appendedFrom: 30, head: BIRCH }).status, 'missing');
});

check('only the wake\'s own rows count: the head sitting in the kept part does not witness this wake', () => {
  const planted = [...MISSING.slice(0, 5), dev(BIRCH), ...MISSING.slice(5)];
  assert.equal(codexHeadWitness({ rows: planted, appendedFrom: 31, head: BIRCH }).status, 'missing');
  assert.equal(codexHeadWitness({ rows: planted, appendedFrom: 5, head: BIRCH }).status, 'ok', 'control: the same row inside the woken range counts');
});

check('pending until the woken rows hold a finished turn', () => {
  const firstDone = GOOD.findIndex((r, i) => i >= 24 && r.type === 'event_msg' && r.payload?.type === 'task_complete');
  assert.ok(firstDone > 24);
  assert.deepEqual(codexHeadWitness({ rows: GOOD.slice(0, firstDone), appendedFrom: 24, head: BIRCH }), { status: 'pending' });
  assert.equal(codexHeadWitness({ rows: GOOD.slice(0, firstDone + 1), appendedFrom: 24, head: BIRCH }).status, 'ok');
});

check('an old head inside a compacted row\'s replacement history counts as a second head', () => {
  const compacted = { timestamp: 't', type: 'compacted', payload: { message: '', replacement_history: [{ type: 'additional_tools', role: 'developer', tools: [] }] } };
  const w = codexHeadWitness({ rows: [GOOD[0], compacted, ...GOOD.slice(1)], appendedFrom: 25, head: BIRCH });
  assert.equal(w.status, 'doubled');
  assert.equal(w.tools, 2);
});

check('either head signal alone marks a double (a second full world_state, no second tools item)', () => {
  const ws = GOOD.find((r) => r.type === 'world_state' && r.payload?.full === true);
  const w = codexHeadWitness({ rows: [GOOD[0], ws, ...GOOD.slice(1)], appendedFrom: 25, head: BIRCH });
  assert.deepEqual([w.status, w.tools, w.fullStates], ['doubled', 1, 2]);
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
