#!/usr/bin/env node
// The Codex provider probe (anima_dev/nightwatch_providers_design.md §6).
//
//   node probes/codex/probe.mjs status
//   node probes/codex/probe.mjs <P1|P6|P8|P2|P3|P4> [--spend] [--from <rollout>]
//
// Every probe runs against a SANDBOX CODEX_HOME (default
// ~/.nightwatch-probes/codex/home), never ~/.codex. The sandbox is logged in by
// Ra herself (`status` prints the command); this kit never reads, copies or
// prints a credential. Without --spend a probe prints the exact codex commands
// it would run and stops: a model turn spends on Ra's plan, so it runs only
// when she (or a lane at her word) passes --spend.
//
// Results land in <run>/results/<probe>-<stamp>/: the commands, codex's
// --json output, sha256s of every rollout before and after, and verdict.json.
// A verdict says what was SEEN; anything inferred is labelled as such.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { idFromFilename, parseRollout, plant, summarize } from './rollout.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const cmd = args[0];
const SPEND = args.includes('--spend');
const RUN = resolve(flag('--run', join(homedir(), '.nightwatch-probes', 'codex')));
const HOME = join(RUN, 'home');
const WORK = join(RUN, 'work');
const CODEX = flag('--codex', 'codex');

// The hard lines: never the real ~/.codex, and never a run directory that is the home folder or holds it
// (a run dir gets home/ and work/ made inside it).
function realOrSelf(p) { try { return realpathSync(p); } catch { return resolve(p); } }
const USER_HOME = realOrSelf(homedir());
if (USER_HOME === realOrSelf(RUN) || USER_HOME.startsWith(realOrSelf(RUN) + '/')) {
  console.error(`refusing: --run ${RUN} is the home folder or one of its parents; give the kit a dedicated directory`);
  process.exit(2);
}
const REAL = realOrSelf(join(homedir(), '.codex'));
if (realOrSelf(HOME) === REAL || realOrSelf(HOME).startsWith(REAL + '/')) {
  console.error(`refusing: the sandbox home ${HOME} is ~/.codex`);
  process.exit(2);
}
for (const d of [RUN, HOME, WORK]) mkdirSync(d, { recursive: true, mode: 0o700 });

const env = { ...process.env, CODEX_HOME: HOME };
delete env.OPENAI_API_KEY; // the sandbox's own login, nothing inherited

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
function rollouts() {
  const out = [];
  const walk = (d) => { let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (idFromFilename(e.name)) out.push(p); } };
  walk(join(HOME, 'sessions'));
  return out.sort();
}
const snapshot = () => Object.fromEntries(rollouts().map((f) => [f, { sha: sha(f), bytes: statSync(f).size }]));

function newDir(probe) {
  const d = join(RUN, 'results', `${probe}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (SPEND) mkdirSync(d, { recursive: true }); // a dry run creates nothing under results/
  return d;
}

// Every codex call goes through here: printed always, run only with --spend.
function codex(dir, label, argv) {
  const line = [`CODEX_HOME=${HOME}`, CODEX, ...argv.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a))].join(' ');
  console.log(`  ${label}: ${line}`);
  if (!SPEND) return null;
  const r = spawnSync(CODEX, argv, { cwd: WORK, env, encoding: 'utf8', timeout: 10 * 60_000 });
  writeFileSync(join(dir, `${label}.cmd`), line + '\n');
  writeFileSync(join(dir, `${label}.stdout`), r.stdout ?? '');
  writeFileSync(join(dir, `${label}.stderr`), r.stderr ?? '');
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
}
const lastMessage = (dir, label) => { try { return readFileSync(join(dir, `${label}.last`), 'utf8').trim(); } catch { return null; } };
// Read-only sandbox for every model turn. `exec` takes -s; `exec resume` and `exec fork` have no -s in
// 0.171.0's help, so the same setting goes as a config override (the key is from the docs, unconfirmed
// until P1 runs: P1's rollout records the sandbox policy it ran under).
const RO = ['--skip-git-repo-check', '-c', 'sandbox_mode="read-only"'];

function loggedIn() {
  const r = spawnSync(CODEX, ['login', 'status'], { env, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] };
}

function latestP1() {
  const dirs = (() => { try { return readdirSync(join(RUN, 'results')).filter((d) => d.startsWith('P1-')).sort(); } catch { return []; } })();
  for (const d of dirs.reverse()) { const f = join(RUN, 'results', d, 'verdict.json'); if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')); }
  return null;
}
function sourceRollout() {
  const from = flag('--from');
  if (from) return { file: resolve(from), word: flag('--word') };
  const p1 = latestP1();
  if (!p1) {
    // A dry run previews the plan with placeholders; a spend run refuses (Selvage's read, #83).
    if (!SPEND) return { file: '<P1 rollout>', word: '<code word>', placeholder: true };
    console.error('no P1 result yet: run P1 first, or pass --from <rollout> --word <code word>'); process.exit(2);
  }
  return { file: p1.rollout, word: p1.codeWord };
}
function writePlant(src, opts) {
  const rows = parseRollout(readFileSync(src, 'utf8'));
  const p = plant(rows, opts);
  const dest = join(HOME, 'sessions', p.filename.dir, p.filename.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, p.text, { flag: 'wx' });
  return { id: p.id, file: dest, sha: sha(dest), lines: p.rows.length, inflated: p.inflated };
}
const answers = (text, word) => typeof text === 'string' && typeof word === 'string' && text.toUpperCase().includes(word.toUpperCase());

const PROBES = {
  // P1: a short session; read the rollout; the schema as found.
  P1() {
    const dir = newDir('P1');
    const word = `HERON-${randomBytes(3).toString('hex').toUpperCase()}`;
    const before = snapshot();
    const r = codex(dir, 'p1-session', ['exec', ...RO, '-C', WORK, '--json', '-o', join(dir, 'p1-session.last'),
      `Please remember this code word for later: ${word}. Reply with just: noted.`]);
    if (!r) return;
    const created = Object.keys(snapshot()).filter((f) => !before[f]);
    const verdict = { probe: 'P1', codeWord: word, exit: r.status, created, rollout: created[0] ?? null };
    if (created[0]) {
      copyFileSync(created[0], join(dir, basename(created[0])));
      verdict.summary = summarize(parseRollout(readFileSync(created[0], 'utf8')));
    }
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
    console.log(JSON.stringify({ exit: r.status, rollout: verdict.rollout, summary: verdict.summary && { ...verdict.summary, kinds: Object.keys(verdict.summary.kinds) } }, null, 2));
  },

  // P6: the fold recipe, planted as a NEW file, resumed, and asked something only the planted file knows.
  P6() {
    const { file, word } = sourceRollout();
    const dir = newDir('P6');
    if (!SPEND) { console.log(`  would plant from ${file} (strip token counts), then:`); codex(dir, 'p6-resume', ['exec', 'resume', '<planted-id>', ...RO, '--json', '-o', join(dir, 'p6-resume.last'), 'What was the code word I asked you to remember? Reply with the word only.']); return; }
    const srcSha = sha(file);
    const planted = writePlant(file, { tokenCounts: 'strip' });
    const r = codex(dir, 'p6-resume', ['exec', 'resume', planted.id, ...RO, '--json', '-o', join(dir, 'p6-resume.last'), 'What was the code word I asked you to remember? Reply with the word only.']);
    const reply = lastMessage(dir, 'p6-resume');
    const verdict = { probe: 'P6', source: file, sourceUnchanged: sha(file) === srcSha, planted, exit: r.status, reply, codeWord: word,
      answered: answers(reply, word), plantedAfter: { sha: sha(planted.file), appended: sha(planted.file) !== planted.sha },
      newRollouts: rollouts().filter((f) => f !== planted.file && f !== file) };
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
    console.log(JSON.stringify(verdict, null, 2));
  },

  // P8: a planted tail that KEEPS a stale, inflated token count, beside one that strips it.
  P8() {
    const { file, word } = sourceRollout();
    const dir = newDir('P8');
    const inflate = Number(flag('--inflate', '937000'));
    const ask = 'What was the code word I asked you to remember? Reply with the word only.';
    if (!SPEND) { console.log(`  would plant two files from ${file} (one with each token count's total_token_usage and last_token_usage set to ${inflate}, one stripped), then resume each:`); codex(dir, 'p8-stale', ['exec', 'resume', '<stale-id>', ...RO, '--json', '-o', '…', ask]); codex(dir, 'p8-clean', ['exec', 'resume', '<clean-id>', ...RO, '--json', '-o', '…', ask]); return; }
    const out = { probe: 'P8', source: file, inflate };
    for (const [label, tokenCounts] of [['p8-stale', { inflate }], ['p8-clean', 'strip']]) {
      const planted = writePlant(file, { tokenCounts });
      const r = codex(dir, label, ['exec', 'resume', planted.id, ...RO, '--json', '-o', join(dir, `${label}.last`), ask]);
      const after = parseRollout(readFileSync(planted.file, 'utf8'));
      const added = after.slice(planted.lines);
      const counts = added.filter((x) => x.type === 'event_msg' && x.payload?.type === 'token_count').map((x) => x.payload?.info?.total_token_usage ?? null);
      out[label] = { planted, exit: r.status, reply: lastMessage(dir, label), answered: answers(lastMessage(dir, label), word),
        addedKinds: added.map((x) => (x.payload?.type && (x.type === 'event_msg' || x.type === 'response_item') ? `${x.type}/${x.payload.type}` : x.type)),
        tokenTotalsAfter: counts, compactedAfter: added.some((x) => x.type === 'compacted') };
    }
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify(out, null, 2));
  },

  // P2: fork leaves the original untouched and writes a new file.
  P2() {
    const { file } = sourceRollout();
    const id = idFromFilename(basename(file)) ?? '<P1 session id>';
    const dir = newDir('P2');
    const before = snapshot();
    const r = codex(dir, 'p2-fork', ['exec', 'fork', id, ...RO, '--json', '-o', join(dir, 'p2-fork.last'), 'Reply with just: forked.']);
    if (!r) return;
    const after = snapshot();
    const verdict = { probe: 'P2', source: file, exit: r.status, originalUnchanged: before[file]?.sha === after[file]?.sha,
      created: Object.keys(after).filter((f) => !before[f]), changed: Object.keys(before).filter((f) => after[f] && after[f].sha !== before[f].sha) };
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
    console.log(JSON.stringify(verdict, null, 2));
  },

  // P3: plain resume appends to the original (the reason a lane never resumes its archive).
  P3() {
    const { file } = sourceRollout();
    const id = idFromFilename(basename(file)) ?? '<P1 session id>';
    const dir = newDir('P3');
    const before = snapshot();
    const r = codex(dir, 'p3-resume', ['exec', 'resume', id, ...RO, '--json', '-o', join(dir, 'p3-resume.last'), 'Reply with just: resumed.']);
    if (!r) return;
    const after = snapshot();
    const verdict = { probe: 'P3', source: file, exit: r.status, before: before[file], after: after[file],
      // Appended = longer, and the old bytes are still the file's prefix, unchanged.
      appended: (after[file]?.bytes ?? 0) > (before[file]?.bytes ?? 0)
        && createHash('sha256').update(readFileSync(file).subarray(0, before[file].bytes)).digest('hex') === before[file].sha,
      created: Object.keys(after).filter((f) => !before[f]) };
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
    console.log(JSON.stringify(verdict, null, 2));
  },

  // P4: is AGENTS.md re-read on resume, and does a changed one show the "replace" notice?
  // Reads codex's own prompt rendering (debug prompt-input) before and after the edit; no model turn.
  P4() {
    const dir = newDir('P4');
    const agents = join(WORK, 'AGENTS.md');
    const A = `Probe marker A ${randomBytes(3).toString('hex')}.`, B = `Probe marker B ${randomBytes(3).toString('hex')}.`;
    // The work dir is shared by every later probe and session, so the planted file must not outlive this one
    // (11/23: a leftover AGENTS.md was read by a later session). Put back whatever was there, or remove it.
    const prior = existsSync(agents) ? readFileSync(agents) : null;
    let a, b;
    try {
      if (SPEND) writeFileSync(agents, A + '\n');
      a = codex(dir, 'p4-prompt-a', ['debug', 'prompt-input', '-c', 'sandbox_mode="read-only"', 'probe']);
      if (SPEND) writeFileSync(agents, B + '\n');
      b = codex(dir, 'p4-prompt-b', ['debug', 'prompt-input', '-c', 'sandbox_mode="read-only"', 'probe']);
    } finally {
      if (SPEND) { if (prior) writeFileSync(agents, prior); else rmSync(agents, { force: true }); }
    }
    if (!a || !b) return;
    const verdict = { probe: 'P4', note: 'prompt-input renders a NEW session; the resumed-session half needs a spend run (P4 resume, not built yet)',
      markerAInA: a.stdout.includes(A), markerBInB: b.stdout.includes(B), markerAInB: b.stdout.includes(A) };
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
    console.log(JSON.stringify(verdict, null, 2));
  },
};

if (cmd === 'status') {
  const s = loggedIn();
  console.log(`sandbox CODEX_HOME: ${HOME}`);
  console.log(`codex: ${spawnSync(CODEX, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '?'}`);
  console.log(`login status: ${s.text} (exit ${s.status})`);
  console.log(`rollouts in the sandbox: ${rollouts().length}`);
  console.log(`To log the sandbox in (Ra's own login; this kit never touches credentials):\n  CODEX_HOME=${HOME} ${CODEX} login`);
} else if (PROBES[cmd]) {
  if (SPEND && loggedIn().status !== 0) { console.error('refusing: the sandbox is not logged in (run `status` for the command)'); process.exit(2); }
  console.log(`${cmd}${SPEND ? '' : ' (dry run: add --spend to run; each run spends on the logged-in plan)'}:`);
  PROBES[cmd]();
} else {
  console.error('usage: probe.mjs status | P1 | P6 | P8 | P2 | P3 | P4  [--spend] [--from <rollout> --word <w>] [--run <dir>]');
  process.exit(2);
}
