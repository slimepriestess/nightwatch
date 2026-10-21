#!/usr/bin/env node
// deadwake.mjs against the 2026-10-08 chain, rebuilt small:
//   LIVE (ran all day) --fold--> TAIL1 --wake--> DEAD1 ("Prompt is too long")
//   DEAD1 --refold--> TAIL2 --wake--> DEAD2 ("Prompt is too long")
// plus WORKED: woken from TAIL1, did real turns, THEN hit the limit.
// Expect: DEAD2 and DEAD1 resolve to LIVE; LIVE and WORKED resolve to
// themselves; cannotAnswer is true only for sessions whose newest reply
// says the prompt is too long. Temp dir only.
// followContinued, the 2026-10-19 resume rebuilt small: OLD was resumed
// from the session picker as MID, MID again as NEW (each old file ends in a
// continued-in row, then Claude Code's cost-state); GONE points at a file
// that isn't there; LOOP points at itself. Expect OLD → NEW, a missing hop
// stops where the record is, and a self-pointer never spins.
// Run: node wakecycle/deadwake-test.mjs   (exit 0 = all pass)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFoldSource, cannotAnswer, followContinued } from './deadwake.mjs';

const dir = mkdtempSync(join(tmpdir(), 'deadwake-test-'));
const write = (sid, rows) => writeFileSync(join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const user = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const reply = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const tooLong = (uuid) => ({ type: 'assistant', uuid, isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] } });
const noReply = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } });
const head = (uuid) => ({ type: 'attachment', uuid, attachment: { type: 'instructions', files: [] } });

const early = [user('a', 'morning'), reply('b', 'on it')];
const late = [user('c', 'two notes'), reply('d', 'done')];
write('LIVE', [...early, ...late]);
write('TAIL1', late);                                                  // fold of LIVE
write('DEAD1', [...late, noReply('e'), user('f', 'welcome back'), head('g'), tooLong('h')]);
write('TAIL2', [user('f', 'welcome back'), head('g'), tooLong('h')]);  // refold of DEAD1
write('DEAD2', [user('f', 'welcome back'), head('g'), tooLong('h'), user('i', 'again'), head('j'), tooLong('k')]);
write('WORKED', [...late, user('l', 'next'), reply('m', 'real work'), user('n', 'more'), tooLong('o')]);
const foldsPath = join(dir, 'folds.jsonl');
writeFileSync(foldsPath, [
  { source: 'jsonl:LIVE', tail: 'TAIL1' },
  { source: 'jsonl:DEAD1', tail: 'TAIL2' },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

const contIn = (to) => ({ type: 'continued-in', continuedInSessionId: to });
const cost = { type: 'cost-state', totalCostUSD: 1 };
write('OLD', [...early, contIn('MID'), cost]);
write('MID', [...early, user('p', 'goodnight'), contIn('NEW'), cost]);
write('NEW', [...early, user('p', 'goodnight'), reply('q', 'sleep well'), user('r', 'bell'), reply('s', 'rung written')]);
write('GONE', [...early, contIn('ELSEWHERE')]);
write('LOOP', [...early, contIn('LOOP')]);

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) fails++;
}
const r = (sid) => resolveFoldSource(sid, { transcripts: dir, foldsPath });
try {
  const d2 = r('DEAD2');
  check('second dead wake walks back to the session that ran', d2.sid === 'LIVE' && d2.skipped.join() === 'DEAD2,DEAD1', d2);
  const d1 = r('DEAD1');
  check('first dead wake folds its source', d1.sid === 'LIVE' && d1.skipped.join() === 'DEAD1', d1);
  check('a live session folds as itself', r('LIVE').sid === 'LIVE' && r('LIVE').skipped.length === 0, r('LIVE'));
  const wk = r('WORKED');
  check('worked, then hit the limit: its own turns are the record', wk.sid === 'WORKED' && wk.skipped.length === 0, wk);
  check('cannotAnswer: dead and worked-then-full are true', cannotAnswer(join(dir, 'DEAD2.jsonl')) && cannotAnswer(join(dir, 'WORKED.jsonl')));
  check('cannotAnswer: a live session is false', !cannotAnswer(join(dir, 'LIVE.jsonl')));
  check('cannotAnswer: a missing file is false, never a throw', cannotAnswer(join(dir, 'NOPE.jsonl')) === false);
  const fc = (sid) => followContinued(sid, { transcripts: dir });
  check('a resumed session folds its newest file', fc('OLD').sid === 'NEW' && fc('OLD').followed.join() === 'OLD,MID', fc('OLD'));
  check('the middle of a chain goes forward only', fc('MID').sid === 'NEW' && fc('MID').followed.join() === 'MID', fc('MID'));
  check('an unresumed session is itself', fc('LIVE').sid === 'LIVE' && fc('LIVE').followed.length === 0, fc('LIVE'));
  check('a hop to a missing file stops where the record is', fc('GONE').sid === 'GONE' && fc('GONE').followed.length === 0, fc('GONE'));
  check('a self-pointer never spins', fc('LOOP').sid === 'LOOP', fc('LOOP'));
  check('a missing start is itself, never a throw', fc('NOPE').sid === 'NOPE');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
