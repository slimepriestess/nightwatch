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
//   9. a resumed session — picked from the session list, it went on under a
//      new id; folding the belled (old) id folds and archives the new one.
// Run: node machinery/archive-test.mjs   (exit 0 = all pass)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
function transcript(h, sid, turns, extra = []) {
  let prev = null;
  const rows = [];
  for (let i = 0; i < turns; i++) {
    for (const e of [
      { type: 'user', message: { role: 'user', content: `prompt ${i}` } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `reply ${i}` }] } },
    ]) {
      const uuid = `${sid.slice(0, 4)}-${rows.length}`;
      rows.push({ parentUuid: prev, uuid, sessionId: sid, timestamp: `2026-10-11T10:${String(rows.length % 60).padStart(2, '0')}:00.000Z`, ...e });
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
const RESUMED = 'eeeeeeee-0000-4000-8000-000000000005';

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
    transcript(h, B, 4);
    const r = sleep(h, B);
    check('8 the next fold succeeds', r.code === 0, r.err);
    check('8 a dead process\'s staging file is swept', !existsSync(join(h.archive, `${A}.jsonl.partial-${dead}`)));
    check('8 a live process\'s staging file is left alone', existsSync(join(h.archive, `${A}.jsonl.partial-${process.pid}`)));
  }
  // 9. Resumed: A was picked from the session list and went on as RESUMED.
  //    A's file ends at the resume (continued-in, then cost-state); RESUMED
  //    holds A's turns and the goodnight after. The bell names A.
  {
    const h = hub();
    transcript(h, A, 3, [{ type: 'continued-in', continuedInSessionId: RESUMED }, { type: 'cost-state', totalCostUSD: 1 }]);
    transcript(h, RESUMED, 5);
    const r = sleep(h, A);
    check('9 resumed fold succeeds', r.code === 0, r.err);
    check('9 it says out loud that it followed the resume', /RESUMED/.test(r.err), r.err);
    check('9 the fold row names the newest file and where it came from', lastFold(h)?.source === `jsonl:${RESUMED}` && lastFold(h)?.continuedFrom?.join() === A, lastFold(h));
    const tail = lastFold(h)?.tail ? readFileSync(join(h.transcripts, `${lastFold(h).tail}.jsonl`), 'utf8') : '';
    check('9 the tail reaches the turns after the resume', tail.includes('prompt 4') && tail.includes('reply 4'), lastFold(h));
    check('9 the newest file is archived, byte-identical', same(join(h.transcripts, `${RESUMED}.jsonl`), join(h.archive, `${RESUMED}.jsonl`)));
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
