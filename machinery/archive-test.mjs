#!/usr/bin/env node
// The transcript archive, end to end: the REAL sleep.mjs, run against scratch
// hubs (WEFT_CONFIG → a temp dir; nothing of ours is read or written), on:
//   1. an authored fold — the archive holds the folded session, byte for byte,
//      and the fold row names it;
//   2. an unauthored emergency fold — the orphan-fold path the daemon runs;
//   3. a dead wake — the session that RAN is archived, not the one belled;
//   4. a zero-turn day — nothing to archive, nothing written, exit 0;
//   5. a re-fold of a grown session — the archive is the new, larger copy;
//   6. a re-fold of a SHRUNK session — the larger old copy is kept aside;
//   7. catch-up — a session that kept writing after its fold is brought up to
//      date at the next fold.
//   8. a crashed copy's staging file is swept, a live one's left alone;
//  11. subagents (#59) — a fork's transcript and meta under <sid>/subagents/
//      are archived beside the session, caught up when only they grew, and
//      kept aside when they shrank; a session with none gets no folder.
//  12. a subagent that can't be copied (unreadable, a directory) is reported
//      and never costs the session, or a later fold, its own archive;
//  13. the guards #60's review found unpinned: an unreadable subagents/,
//      an unreadable grown transcript, a damaged archive-side folder;
//   9. the trim's output check — a broken-format session is refused (event +
//      stderr, no receipt), and torn lines are counted into the fold row.
// Run: node machinery/archive-test.mjs   (exit 0 = all pass)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = 'America/Los_Angeles';
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const roots = [];

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) fails++;
}

// A scratch hub: config, checkpoint, ladder (with or without today's rung).
function hub({ rung = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archive-test-'));
  roots.push(root);
  const transcripts = join(root, 'transcripts');
  for (const d of ['ladder/L2', 'wakecycle', 'transcripts']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'checkpoint.md'), '# checkpoint\n');
  writeFileSync(join(root, 'ladder', 'index.json'), JSON.stringify({ entries: [] }) + '\n');
  writeFileSync(join(root, 'ladder', 'folds.jsonl'), '');
  if (rung) {
    writeFileSync(join(root, 'ladder', 'L2', `${today}-test.md`),
      `---\nid: test-${today}\nlevel: L2\n---\n\n## Sequence\n\nA day.\n\n## Corrections\n\n- none [lived]\n`);
  }
  const config = join(root, 'nightwatch.config.json');
  writeFileSync(config, JSON.stringify({
    weftRoot: root, defaultLane: 'solo', timezone: TZ,
    lanes: { solo: { targetTokens: 250000 } },
    paths: { transcripts, machinery: HERE },
  }, null, 2));
  return { root, transcripts, config, archive: join(root, 'archive', 'transcripts') };
}

// A transcript trim.mjs will fold: a chain of turns starting at a human prompt.
function transcript(h, sid, turns, extra = [], version = null) {
  let prev = null;
  const rows = [];
  for (let i = 0; i < turns; i++) {
    for (const e of [
      { type: 'user', message: { role: 'user', content: `prompt ${i}` } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `reply ${i}` }] } },
    ]) {
      const uuid = `${sid.slice(0, 4)}-${rows.length}`;
      rows.push({ parentUuid: prev, uuid, sessionId: sid, timestamp: `2026-10-11T10:${String(rows.length % 60).padStart(2, '0')}:00.000Z`, ...(version ? { version } : {}), ...e });
      prev = uuid;
    }
  }
  rows.push(...extra);
  writeFileSync(join(h.transcripts, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function sleep(h, sid, extraArgs = []) {
  const r = spawnSync(process.execPath, [join(HERE, 'sleep.mjs'), '--lane', 'solo', '--session', sid, ...extraArgs], {
    encoding: 'utf8', env: { ...process.env, WEFT_CONFIG: h.config, CLAUDE_CODE_SESSION_ID: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lastFold = (h) => {
  const lines = readFileSync(join(h.root, 'ladder', 'folds.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : null;
};
const same = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const TAIL = 'cccccccc-0000-4000-8000-000000000003';
const DEAD = 'dddddddd-0000-4000-8000-000000000004';

try {
  // 1. Authored fold.
  {
    const h = hub();
    transcript(h, A, 6);
    const r = sleep(h, A);
    check('1 authored fold succeeds', r.code === 0, r.err);
    check('1 the archive holds the folded session, byte-identical', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
    check('1 the fold row names the archived copy', lastFold(h)?.archived === join(h.archive, `${A}.jsonl`), lastFold(h));
    check('1 no staging file left behind', existsSync(h.archive) && readdirSync(h.archive).every((f) => !f.includes('.partial')), existsSync(h.archive) ? readdirSync(h.archive) : 'no archive dir');
    check('1 no version was stamped, so the fold row invents none', lastFold(h) && !('claudeVersion' in lastFold(h)), lastFold(h));
    check('1 the new tail is not archived (it is tomorrow\'s, not a fold)', existsSync(h.archive) && readdirSync(h.archive).length === 1, existsSync(h.archive) ? readdirSync(h.archive) : '');
  }
  // 2. Unauthored emergency fold (the daemon's orphan-fold invocation).
  {
    const h = hub({ rung: false });
    transcript(h, A, 6);
    const r = sleep(h, A, ['--emergency']);
    check('2 emergency fold succeeds', r.code === 0, r.err);
    check('2 the emergency fold archives too, byte-identical', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
    check('2 its fold row is "forced" and names the archive', lastFold(h)?.reason === 'forced' && Boolean(lastFold(h)?.archived), lastFold(h));
  }
  // 3. Dead wake: A ran and folded to TAIL; DEAD was woken from TAIL and only
  //    ever hit "Prompt is too long". Folding DEAD folds (and archives) A.
  {
    const h = hub();
    transcript(h, A, 6);
    transcript(h, TAIL, 1);
    const dead = [
      { type: 'user', uuid: 'd1', message: { role: 'user', content: 'welcome back' } },
      { type: 'assistant', uuid: 'd2', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] } },
    ];
    // The dead wake is the tail it resumed plus nothing of its own but errors.
    writeFileSync(join(h.transcripts, `${DEAD}.jsonl`), readFileSync(join(h.transcripts, `${TAIL}.jsonl`), 'utf8') + dead.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(h.root, 'ladder', 'folds.jsonl'), JSON.stringify({ source: `jsonl:${A}`, tail: TAIL }) + '\n');
    const r = sleep(h, DEAD);
    check('3 dead-wake fold succeeds', r.code === 0, r.err);
    check('3 the session that RAN is archived, byte-identical', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
    check('3 the dead wake itself is not archived', !existsSync(join(h.archive, `${DEAD}.jsonl`)));
    check('3 the fold row names the source session\'s archive', lastFold(h)?.archived === join(h.archive, `${A}.jsonl`), lastFold(h));
  }
  // 4. Zero-turn day: registered, never prompted, no transcript.
  {
    const h = hub();
    writeFileSync(join(h.root, 'wakecycle', `lane.${A}`), JSON.stringify({ lane: 'solo' }));
    const r = sleep(h, A);
    check('4 zero-turn day exits 0', r.code === 0, r.err);
    check('4 nothing is archived (and no archive dir is made)', !existsSync(h.archive));
  }
  // 5 + 6. Re-folds of one session: grown, then shrunk.
  {
    const h = hub();
    transcript(h, A, 4);
    sleep(h, A);
    transcript(h, A, 8);
    const r = sleep(h, A);
    check('5 re-fold of a grown session succeeds', r.code === 0, r.err);
    check('5 the archive is the new, larger copy', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
    const before = readFileSync(join(h.archive, `${A}.jsonl`));
    transcript(h, A, 3);
    const r2 = sleep(h, A);
    const aside = readdirSync(h.archive).filter((f) => f.startsWith(A) && f !== `${A}.jsonl`);
    check('6 re-fold of a shrunk session succeeds', r2.code === 0, r2.err);
    check('6 the larger old copy is kept aside, intact', aside.length === 1 && readFileSync(join(h.archive, aside[0])).equals(before), aside);
    check('6 the current copy matches the current source', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
    check('6 the shrink is said out loud', /SMALLER than its archived copy/.test(r2.err), r2.err);
  }
  // 7. Catch-up: A folds, keeps writing (the checkpoint rewrite), then B folds.
  {
    const h = hub();
    transcript(h, A, 4);
    sleep(h, A);
    appendFileSync(join(h.transcripts, `${A}.jsonl`), JSON.stringify({ type: 'user', uuid: 'late', message: { role: 'user', content: 'after the fold' } }) + '\n');
    transcript(h, B, 4);
    const r = sleep(h, B);
    check('7 the next fold succeeds', r.code === 0, r.err);
    check('7 A\'s archive caught up with its post-fold turns', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
    check('7 B is archived too', same(join(h.transcripts, `${B}.jsonl`), join(h.archive, `${B}.jsonl`)));
  }
  // 8. A crashed copy's staging file is swept; a live process's is left alone
  //    (both lanes fold at one bell).
  {
    const h = hub();
    transcript(h, A, 4);
    sleep(h, A);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeFileSync(join(h.archive, `${A}.jsonl.partial-${dead}`), 'half');
    writeFileSync(join(h.archive, `${A}.jsonl.partial-${process.pid}`), 'in flight');
    mkdirSync(join(h.archive, A, 'subagents'), { recursive: true });
    writeFileSync(join(h.archive, A, 'subagents', `agent-x.jsonl.partial-${dead}`), 'half');
    transcript(h, B, 4);
    const r = sleep(h, B);
    check('8 the next fold succeeds', r.code === 0, r.err);
    check('8 a dead process\'s staging file is swept', !existsSync(join(h.archive, `${A}.jsonl.partial-${dead}`)));
    check('8 a live process\'s staging file is left alone', existsSync(join(h.archive, `${A}.jsonl.partial-${process.pid}`)));
    check('8 a dead staging file among a session\'s subagents is swept too', !existsSync(join(h.archive, A, 'subagents', `agent-x.jsonl.partial-${dead}`)));
  }
  // 9. The trim's output check (10/21): a session whose chain field was renamed
  //    is REFUSED, not folded wrong. sleep exits 1 before any receipt or archive,
  //    and the refusal lands in the event stream (alarm), not only on stderr.
  //    Torn lines are counted into the fold row.
  {
    const h = hub();
    transcript(h, A, 6);
    const f = join(h.transcripts, `${A}.jsonl`);
    writeFileSync(f, readFileSync(f, 'utf8').split('"parentUuid"').join('"parent_uuid"'));
    const r = sleep(h, A);
    check('9 a renamed chain field fails the fold', r.code === 1, `${r.code} ${r.err}`);
    check('9 and says why on stderr', /OUTPUT CHECK FAILED/.test(r.err), r.err);
    check('9 no fold row, no archive', lastFold(h) === null && !existsSync(h.archive), lastFold(h));
    const evPath = join(h.root, 'events.jsonl');
    const ev = existsSync(evPath) ? readFileSync(evPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.kind === 'trim-failed') : null;
    check('9 a trim-failed event carries the cause, flagged as an alarm', ev?.alarm === true && ev?.lane === 'solo' && /lack a uuid or a parentUuid/.test(ev?.cause ?? ''), ev);
  }
  {
    const h = hub();
    transcript(h, A, 6);
    appendFileSync(join(h.transcripts, `${A}.jsonl`), '{"type":"user","message":{"cont\nnot json\n');
    const r = sleep(h, A);
    check('9 a session with torn lines still folds', r.code === 0, r.err);
    check('9 and its fold row says how many lines were dropped', lastFold(h)?.tornLines === 2, lastFold(h));
  }

  // 10. The fold row records the version that wrote the tail.
  {
    const h = hub();
    transcript(h, A, 6, [], '2.1.310');
    const r = sleep(h, A);
    check('10 a stamped session folds', r.code === 0, r.err);
    check('10 and its fold row carries claudeVersion', lastFold(h)?.claudeVersion === '2.1.310', lastFold(h));
  }
  // 11. Subagents (#59). A fork's transcript and meta live in <sid>/subagents/.
  {
    const h = hub();
    transcript(h, A, 6);
    const sub = join(h.transcripts, A, 'subagents');
    mkdirSync(sub, { recursive: true });
    const fork = 'agent-ab1f9ff750e528133';
    writeFileSync(join(sub, `${fork}.jsonl`), '{"type":"user","message":{"content":"the hint"}}\n');
    writeFileSync(join(sub, `${fork}.meta.json`), '{"agentType":"fork","isFork":true}\n');
    writeFileSync(join(sub, 'notes.txt'), 'not an agent file');
    const r = sleep(h, A);
    const out = join(h.archive, A, 'subagents');
    check('11 a fold with a fork succeeds', r.code === 0, r.err);
    check('11 the fork\'s transcript is archived beside the session, byte-identical', same(join(sub, `${fork}.jsonl`), join(out, `${fork}.jsonl`)));
    check('11 and its meta (which says it was a fork)', same(join(sub, `${fork}.meta.json`), join(out, `${fork}.meta.json`)));
    check('11 only agent files are taken', existsSync(out) && !readdirSync(out).includes('notes.txt'), existsSync(out) ? readdirSync(out) : 'no dir');
    check('11 the fold row counts the subagent transcripts', lastFold(h)?.archivedSubagents === 1, lastFold(h));
    // The fork keeps writing after the session's archive is current (a
    // background agent can outlive the last turn). The next fold, of B,
    // catches the fork up although A's own transcript didn't change.
    appendFileSync(join(sub, `${fork}.jsonl`), '{"type":"assistant","message":{"content":"the rung"}}\n');
    transcript(h, B, 4);
    const r2 = sleep(h, B);
    check('11 the next fold succeeds', r2.code === 0, r2.err);
    check('11 a fork that grew after its session\'s fold is caught up', same(join(sub, `${fork}.jsonl`), join(out, `${fork}.jsonl`)));
    check('11 B, which had no subagents, gets no folder and no count', !existsSync(join(h.archive, B)) && !('archivedSubagents' in (lastFold(h) ?? {})), lastFold(h));
    // A shrunk subagent transcript: the larger archived copy is kept aside.
    const before = existsSync(join(out, `${fork}.jsonl`)) ? readFileSync(join(out, `${fork}.jsonl`)) : null;
    writeFileSync(join(sub, `${fork}.jsonl`), '{}\n');
    const r3 = sleep(h, A);
    const aside = (existsSync(out) ? readdirSync(out) : []).filter((f) => f.startsWith(fork) && f.endsWith('.jsonl') && f !== `${fork}.jsonl`);
    check('11 a shrunk subagent re-fold succeeds', r3.code === 0, r3.err);
    check('11 its larger old copy is kept aside, intact', aside.length === 1 && before && readFileSync(join(out, aside[0])).equals(before), aside);
    check('11 and the shrink is said out loud', /subagent agent-ab1f9ff750e528133\.jsonl .* SMALLER/.test(r3.err), r3.err);
  }
  // 12. A subagent that can't be copied. One unreadable file and one directory
  //     with an agent's name sit beside a good fork. The session's own
  //     transcript and the good fork are archived regardless, the two are
  //     reported, and later folds (of this session and of another) still
  //     archive their own transcripts (opus's review of #60).
  {
    const h = hub();
    transcript(h, A, 6);
    const sub = join(h.transcripts, A, 'subagents');
    mkdirSync(join(sub, 'agent-dir.jsonl'), { recursive: true });
    writeFileSync(join(sub, 'agent-good.jsonl'), '{"good":1}\n');
    writeFileSync(join(sub, 'agent-bad.jsonl'), '{"bad":1}\n');
    chmodSync(join(sub, 'agent-bad.jsonl'), 0);
    try {
      const r = sleep(h, A);
      check('12 a fold with an unreadable subagent succeeds', r.code === 0, r.err);
      check('12 the session\'s own transcript is archived regardless', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
      check('12 and so is the good fork', same(join(sub, 'agent-good.jsonl'), join(h.archive, A, 'subagents', 'agent-good.jsonl')));
      check('12 the fold row has no archiveError, and counts 2 subagent errors', !('archiveError' in (lastFold(h) ?? {})) && lastFold(h)?.subagentErrors === 2, lastFold(h));
      check('12 both are said on stderr', /COULD NOT COPY subagent agent-bad\.jsonl/.test(r.err) && /COULD NOT COPY subagent agent-dir\.jsonl/.test(r.err), r.err);
      transcript(h, A, 9);
      const r2 = sleep(h, A);
      check('12 a refold of the grown session archives its new transcript', r2.code === 0 && same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)), r2.err);
      transcript(h, B, 4);
      const r3 = sleep(h, B);
      check('12 another session\'s fold archives its own, past the bad file', r3.code === 0 && same(join(h.transcripts, `${B}.jsonl`), join(h.archive, `${B}.jsonl`)) && !('archiveError' in (lastFold(h) ?? {})), r3.err);
      check('12 and the catch-up still names the bad file', /COULD NOT COPY subagent agent-bad\.jsonl of aaaaaaaa/.test(r3.err), r3.err);
    } finally { chmodSync(join(sub, 'agent-bad.jsonl'), 0o644); }
  }

  // 13. The guards #60's second review found unpinned, and its residual.
  //     (a) An unreadable <sid>/subagents on the source side: the session's
  //     own copy lands and the folder is reported, not ARCHIVE FAILED.
  //     (b) An unreadable source transcript that grew: that session can't be
  //     caught up, and the folding session and the others still are.
  //     (c) <sid>/subagents in the archive is a file: the sweep reports it,
  //     and the session's grown transcript is still caught up.
  {
    const h = hub();
    transcript(h, A, 6);
    const sub = join(h.transcripts, A, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-x.jsonl'), '{"x":1}\n');
    chmodSync(sub, 0);
    try {
      const r = sleep(h, A);
      check('13a a fold with an unreadable subagents/ succeeds', r.code === 0, r.err);
      check('13a the session\'s own transcript is archived', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)));
      check('13a no ARCHIVE FAILED, no archiveError, one subagent error', !/ARCHIVE FAILED/.test(r.err) && !('archiveError' in (lastFold(h) ?? {})) && lastFold(h)?.subagentErrors === 1, { err: r.err, row: lastFold(h) });
      check('13a the folder is named on stderr', /COULD NOT COPY subagent subagents\/ of aaaaaaaa/.test(r.err), r.err);
    } finally { chmodSync(sub, 0o755); }
  }
  {
    const h = hub();
    transcript(h, A, 6); sleep(h, A);
    transcript(h, DEAD, 6); sleep(h, DEAD);
    transcript(h, A, 9); transcript(h, DEAD, 9);
    chmodSync(join(h.transcripts, `${A}.jsonl`), 0);
    try {
      transcript(h, B, 4);
      const r = sleep(h, B);
      check('13b a fold beside an unreadable grown transcript succeeds', r.code === 0, r.err);
      check('13b that session can\'t be caught up, and it says so', /COULD NOT CATCH UP aaaaaaaa/.test(r.err), r.err);
      check('13b the other grown session is still caught up', same(join(h.transcripts, `${DEAD}.jsonl`), join(h.archive, `${DEAD}.jsonl`)));
      check('13b and the folding session archives its own', same(join(h.transcripts, `${B}.jsonl`), join(h.archive, `${B}.jsonl`)) && !('archiveError' in (lastFold(h) ?? {})), lastFold(h));
    } finally { chmodSync(join(h.transcripts, `${A}.jsonl`), 0o644); }
  }
  {
    const h = hub();
    transcript(h, A, 6); sleep(h, A);
    mkdirSync(join(h.archive, A), { recursive: true });
    writeFileSync(join(h.archive, A, 'subagents'), 'not a folder\n');
    transcript(h, A, 9);
    transcript(h, B, 4);
    const r = sleep(h, B);
    check('13c a fold beside a damaged archive folder succeeds', r.code === 0, r.err);
    check('13c the damaged session\'s grown transcript is still caught up', same(join(h.transcripts, `${A}.jsonl`), join(h.archive, `${A}.jsonl`)), r.err);
    check('13c the sweep\'s error is said, not a COULD NOT CATCH UP', /COULD NOT COPY subagent subagents\/ \(archive\) of aaaaaaaa/.test(r.err) && !/COULD NOT CATCH UP aaaaaaaa/.test(r.err), r.err);
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
