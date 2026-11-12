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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFoldSource, cannotAnswer, followContinued, liveTranscriptPath } from './deadwake.mjs';

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
// The review's probes (10/19) and the real chains' shapes (2026-11-12, from
// archive/transcripts: dea6fefc → aa4affc0 and 3e621b0b → 1f4cab04).
writeFileSync(join(dir, 'EMPTY.jsonl'), '');
write('P1', [...early, ...late, contIn('EMPTY')]);                       // target is empty
write('SHORT', [...late, user('t', 'later')]);
write('P2', [...early, ...late, contIn('SHORT')]);                       // target lacks P2's first prompt
write('STALE', [...early, user('u', 'one')]);
write('P4', [...early, user('u', 'one'), user('v', 'two'), reply('w', 'x'), contIn('STALE')]); // stale pointer: target lacks 'v'
write('SWAP', [user('c', 'two notes'), reply('d', 'done'), ...early]);
write('P5', [...early, ...late, contIn('SWAP')]);                        // prompts present but out of order
const at = (row, iso) => ({ ...row, timestamp: iso });
write('OLDER', [at(user('a', 'morning'), '2026-10-28T10:00:00Z'), at(reply('b', 'on it'), '2026-10-28T10:01:00Z')]);
write('P6', [at(user('a', 'morning'), '2026-10-28T10:00:00Z'), at(reply('b', 'on it'), '2026-10-28T17:00:00Z'), contIn('OLDER')]); // target older
// 3e621b0b's shape: moved mid-turn, the in-flight assistant row is rewritten
// under a new uuid in the new file, so the old file's LAST uuid isn't there.
write('MIDTURN', [...early, user('x', 'go'), reply('y-inflight', ''), contIn('MOVED'), cost]);
write('MOVED', [...early, user('x', 'go'), reply('y-rewritten', 'answer'), user('z', 'next'), reply('zz', 'more')]);
// dea6fefc's shape: the new file holds every uuid but FEWER ROWS (fewer
// api-request rows), so a row count would refuse the real incident.
const apiReq = { type: 'api-request', requestId: 'r' };
write('MANYROWS', [...early, apiReq, apiReq, apiReq, apiReq, ...late, apiReq, apiReq, contIn('FEWROWS'), cost]);
write('FEWROWS', [...early, ...late, user('zz2', 'goodnight')]);
// Sonnet's read of #24 (2026-11-12): a real resume with nothing said since
// (the same rows, the same newest timestamp) is followed, not "older".
const stamped = [at(user('a', 'morning'), '2026-10-28T10:00:00Z'), at(reply('b', 'on it'), '2026-10-28T17:00:00Z')];
write('SAMETIME', [...stamped, contIn('SAMETIME2'), cost]);
write('SAMETIME2', stamped);
// A pointing file with no prompts: an unrelated target is refused; one that
// carries its rows is followed.
write('NOPROMPT', [reply('np1', 'x'), contIn('UNRELATED')]);
write('UNRELATED', [user('q1', 'other'), reply('q2', 'y')]);
write('NOPROMPT2', [reply('np2', 'x'), contIn('CARRIES')]);
write('CARRIES', [reply('np2', 'x'), user('q3', 'next')]);
// A target that exists but can't be read stops where the record is, said.
mkdirSync(join(dir, 'ISDIR.jsonl'));
write('TODIR', [...early, contIn('ISDIR')]);
write('LOCKED', [...early, user('p', 'goodnight')]);
chmodSync(join(dir, 'LOCKED.jsonl'), 0o000);
write('TOLOCKED', [...early, contIn('LOCKED')]);
// The pointer is read from the tail: a file bigger than the tail window
// whose pointer sits more than the window from the end is not followed (the
// real pointer is the last row but for cost-state); and a big file with no
// pointer resolves to itself.
const pad = (n) => Array.from({ length: n }, (_, i) => ({ type: 'api-request', requestId: `pad-${i}`, body: 'x'.repeat(200) }));
write('BURIED', [...early, contIn('NEW'), ...pad(400)]);
write('BIGPLAIN', [...early, ...pad(400)]);
// Two copies pointing at each other: one hop, then the cycle guard stops it.
write('CYC1', [...early, contIn('CYC2')]);
write('CYC2', [...early, contIn('CYC1')]);
// A pointing file that holds the same prompt row twice (a duplicated line) is
// still a real resume: equal positions are not 'out of order'.
write('DUPROW', [...early, user('a', 'morning'), ...late, contIn('DUPNEW')]);
write('DUPNEW', [...early, ...late, user('dn', 'after')]);
// Sonnet's delta read: an unreadable STARTING file stays put (no throw); a
// file with two pointers follows the last one (the walk reads from the end).
write('LOCKEDSTART', [...early, contIn('NEW')]);
chmodSync(join(dir, 'LOCKEDSTART.jsonl'), 0o000);
mkdirSync(join(dir, 'DIRSTART.jsonl'));
write('TWOPTR', [...early, contIn('UNRELATED'), contIn('NEW')]);

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
  check('an intact chain reports no refusal', fc('OLD').refused === null, fc('OLD'));
  const refusedAt = (sid, to, re) => { const f = fc(sid); return f.sid === sid && f.followed.length === 0 && f.refused?.to === to && re.test(f.refused.why); };
  check('P1 an empty target is refused, the pointing file folds', refusedAt('P1', 'EMPTY', /lacks/), fc('P1'));
  check('P2 a shorter target (missing an earlier prompt) is refused', refusedAt('P2', 'SHORT', /lacks the pointing file's prompt a/), fc('P2'));
  check('P4 a stale pointer to a file without the later prompts is refused', refusedAt('P4', 'STALE', /lacks the pointing file's prompt v/), fc('P4'));
  check('the prompts out of order is refused', refusedAt('P5', 'SWAP', /out of order/), fc('P5'));
  check('an older target is refused', refusedAt('P6', 'OLDER', /older/), fc('P6'));
  check('moved mid-turn (in-flight reply rewritten, last uuid absent) is still followed', fc('MIDTURN').sid === 'MOVED' && fc('MIDTURN').refused === null, fc('MIDTURN'));
  check('a target with fewer rows but every prompt is still followed', fc('MANYROWS').sid === 'FEWROWS' && fc('MANYROWS').refused === null, fc('MANYROWS'));
  check('liveTranscriptPath reads the end of the chain', liveTranscriptPath('OLD', dir) === join(dir, 'NEW.jsonl'));
  check('liveTranscriptPath stays put on a refused pointer', liveTranscriptPath('P2', dir) === join(dir, 'P2.jsonl'));
  check('liveTranscriptPath of an unresumed or missing session is its own file', liveTranscriptPath('LIVE', dir) === join(dir, 'LIVE.jsonl') && liveTranscriptPath('NOPE', dir) === join(dir, 'NOPE.jsonl'));
  check('a self-pointer follows nothing and refuses nothing', fc('LOOP').followed.length === 0 && fc('LOOP').refused === null, fc('LOOP'));
  check('a resume with nothing said since (same rows, same newest timestamp) is followed', fc('SAMETIME').sid === 'SAMETIME2' && fc('SAMETIME').refused === null, fc('SAMETIME'));
  check('a pointing file with no prompts: an unrelated target is refused', refusedAt('NOPROMPT', 'UNRELATED', /no prompts to compare/), fc('NOPROMPT'));
  check('a pointing file with no prompts: a target carrying its rows is followed', fc('NOPROMPT2').sid === 'CARRIES', fc('NOPROMPT2'));
  check('a target that is a directory is refused, never a throw', refusedAt('TODIR', 'ISDIR', /can't be read \(EISDIR\)/), fc('TODIR'));
  const asRoot = process.getuid?.() === 0; // root reads a chmod 000 file anyway
  check('a target that can\'t be read (chmod 000) is refused, never a throw', asRoot || refusedAt('TOLOCKED', 'LOCKED', /can't be read \(EACCES\)/), fc('TOLOCKED'));
  check('liveTranscriptPath stays put on an unreadable target', liveTranscriptPath('TODIR', dir) === join(dir, 'TODIR.jsonl'));
  check('a pointer buried deeper than the tail window is not read (tail-only)', fc('BURIED').sid === 'BURIED' && fc('BURIED').followed.length === 0, fc('BURIED'));
  check('a big file with no pointer is itself', fc('BIGPLAIN').sid === 'BIGPLAIN', fc('BIGPLAIN'));
  check('a two-file cycle takes one hop and stops', fc('CYC1').sid === 'CYC2' && fc('CYC1').followed.join() === 'CYC1', fc('CYC1'));
  check('a duplicated prompt row in the pointing file is still followed', fc('DUPROW').sid === 'DUPNEW' && fc('DUPROW').refused === null, fc('DUPROW'));
  check('an unreadable starting file stays put, never a throw', (asRoot || (fc('LOCKEDSTART').sid === 'LOCKEDSTART' && fc('LOCKEDSTART').followed.length === 0)) && fc('DIRSTART').sid === 'DIRSTART', [fc('LOCKEDSTART'), fc('DIRSTART')]);
  check('two pointers in one file: the last one is followed', fc('TWOPTR').sid === 'NEW' && fc('TWOPTR').refused === null, fc('TWOPTR'));
  // tailPointer closes what it opens: a leak would stop the walk silently at
  // the fd limit (Sonnet: EMFILE after ~30,000 calls). Count this process's
  // open descriptors before and after a few hundred walks.
  // No /proc or /dev/fd on native Windows (Sonnet): there the count is skipped, said.
  const fds = () => { for (const d of ['/proc/self/fd', '/dev/fd']) { try { return readdirSync(d).length; } catch {} } return null; };
  const before = fds();
  for (let i = 0; i < 300; i++) liveTranscriptPath('OLD', dir);
  if (before === null) console.log('SKIP  300 walks leave no file descriptor open (no /proc/self/fd or /dev/fd here)');
  else check('300 walks leave no file descriptor open', fds() === before, `${before} -> ${fds()}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
