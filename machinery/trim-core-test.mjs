#!/usr/bin/env node
// The trimmer core's contract with its adapters (trim-core.mjs): an adapter that lacks a member is
// refused by name before anything is read, and a validate that returns no list of problems is refused
// rather than read as "no problems". The format gate must not be optional. Writes nothing.
// Run: node machinery/trim-core-test.mjs   (exit 0 = all pass)
import { trimTail, REQUIRED } from './trim-core.mjs';
import * as claudeCode from './providers/claude-code.mjs';

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) fails++;
}
const lines = [
  JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hello' } }),
  JSON.stringify({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
];
// A throw is a failed check, not a crash: one plant must not hide the checks after it.
const run = (adapter) => {
  const warned = [];
  try {
    return { r: trimTail({ lines, adapter, target: 100_000, imageBudget: 1_000_000, warn: (m) => warned.push(m) }), warned };
  } catch (err) {
    return { r: { threw: String(err?.message ?? err) }, warned };
  }
};

// The list itself, literally: the loop below reads REQUIRED, so a member dropped from it would leave
// every other check green. validate above all: the format gate is the one member that must never be optional.
check('REQUIRED names exactly the contract\'s members', JSON.stringify(REQUIRED) === JSON.stringify(['parse', 'serialize', 'weigh', 'drop', 'inert', 'isSeam', 'order', 'keep', 'mayCarryImages', 'stripImages', 'validate', 'timestampOf']), JSON.stringify(REQUIRED));

// The real adapter has every member, and trims.
{
  const { r } = run(claudeCode);
  check('the Claude Code adapter has every required member', REQUIRED.every((m) => typeof claudeCode[m] === 'function'), REQUIRED.filter((m) => typeof claudeCode[m] !== 'function').join(','));
  check('…and trims the fixture', !r.refused && r.keptLines.length === 2, JSON.stringify(r.refused ?? r.keptLines?.length));
}

// Each member, removed in turn: refused by name, exit 2, and before parse or validate ever ran.
for (const m of REQUIRED) {
  let touched = false;
  const adapter = { ...claudeCode, name: 'test', parse: (l) => { touched = true; return claudeCode.parse(l); } };
  delete adapter[m];
  const { r } = run(adapter);
  check(`without ${m}: refused by name, exit 2, nothing read`,
    r.refused?.exit === 2 && r.refused.message === `trim: the test adapter lacks ${m}` && !touched,
    JSON.stringify(r.refused) + ` touched=${touched}`);
}

// A validate that returns no list is not "no problems".
for (const bad of [undefined, null, 'fine', 0]) {
  const { r } = run({ ...claudeCode, name: 'test', validate: () => bad });
  check(`a validate that returns ${JSON.stringify(bad)}: refused, exit 2`,
    r.refused?.exit === 2 && /validate returned no list of problems/.test(r.refused.message), JSON.stringify(r.refused ?? 'accepted'));
}

// A validate that returns a problem blocks the write, in the output check's words.
{
  const { r } = run({ ...claudeCode, validate: () => ['planted'] });
  check('a validate with a problem: refused, exit 1, in the output check\'s words',
    r.refused?.exit === 1 && r.refused.message === 'trim: OUTPUT CHECK FAILED, nothing written. planted.', JSON.stringify(r.refused));
}

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
