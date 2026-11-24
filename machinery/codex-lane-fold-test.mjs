// A codex lane's fold at bedtime, end to end: the REAL sleep.mjs against a scratch hub whose lane is
// provider:codex, with a CODEX_HOME holding a real 0.171.0 rollout (testdata/codex/two-turns.jsonl).
// anima_dev/nightwatch_codex_lane_plan.md, leg 1. No codex runs; nothing is spent.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as codex from './providers/codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = 'America/Los_Angeles';
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const SID = '01a209d7-1979-7202-8277-799c4198fdf9'; // the fixture's own session id
let fails = 0;
const roots = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) fails++;
}

function hub({ codexHome = true, register = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-lane-fold-test-'));
  roots.push(root);
  for (const d of ['ladder/L2', 'wakecycle', 'transcripts']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'checkpoint.md'), '# checkpoint\n');
  writeFileSync(join(root, 'ladder', 'index.json'), JSON.stringify({ entries: [] }) + '\n');
  writeFileSync(join(root, 'ladder', 'folds.jsonl'), '');
  writeFileSync(join(root, 'ladder', 'L2', `${today}-test.md`), `---\nid: test-${today}\nlevel: L2\n---\n\n## Sequence\n\nA day.\n`);
  const home = join(root, 'codex-home');
  // A long-past day folder: the fold writes into today's, which must be created (main went red at 00:56Z 11/24).
  const day = join(home, 'sessions', '2020', '01', '01');
  mkdirSync(day, { recursive: true });
  const src = join(day, `rollout-2026-11-23T11-17-02-${SID}.jsonl`);
  copyFileSync(join(HERE, 'testdata', 'codex', 'two-turns.jsonl'), src);
  if (register) writeFileSync(join(root, 'wakecycle', `lane.${SID}`), JSON.stringify({ lane: 'solo', pid: 1, provider: 'codex' }) + '\n');
  const config = join(root, 'nightwatch.config.json');
  writeFileSync(config, JSON.stringify({
    weftRoot: root, defaultLane: 'solo', timezone: TZ,
    lanes: { solo: { targetTokens: 250000, provider: 'codex', ...(codexHome ? { codexHome: home } : {}) } },
    paths: { transcripts: join(root, 'transcripts'), machinery: HERE },
  }, null, 2));
  return { root, home, src, config, archive: join(root, 'archive', 'transcripts') };
}
function sleep(h, sid = SID, extra = []) {
  const env = { ...process.env, WEFT_CONFIG: h.config, CLAUDE_CODE_SESSION_ID: '' };
  for (const k of ['NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
  const r = spawnSync(process.execPath, [join(HERE, 'sleep.mjs'), '--lane', 'solo', '--session', sid, ...extra], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lastFold = (h) => {
  const lines = readFileSync(join(h.root, 'ladder', 'folds.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : null;
};
const same = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
const rollouts = (home) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(join(home, 'sessions'));
  return out.sort();
};

try {
  // 1. The fold.
  {
    const h = hub();
    const before = readFileSync(h.src);
    const r = sleep(h);
    check('1 a codex lane folds (exit 0)', r.code === 0, r.err);
    const row = lastFold(h);
    check('1 the fold row says codex, its version and the new tail', row?.provider === 'codex' && row?.codexVersion === '0.171.0' && typeof row?.tail === 'string' && row.tail !== SID, row);
    const tail = rollouts(h.home).find((f) => f.endsWith(`-${row?.tail}.jsonl`));
    check('1 the tail is a new rollout in the lane\'s own CODEX_HOME', !!tail, rollouts(h.home));
    const lines = tail ? readFileSync(tail, 'utf8').trimEnd().split('\n') : [];
    check('1 the tail passes the codex format gate, with the fresh id in its header', codex.validate(lines).length === 0 && JSON.parse(lines[0] ?? '{}').payload?.id === row?.tail, codex.validate(lines));
    check('1 the source rollout is untouched (it stays where Codex put it)', existsSync(h.src) && readFileSync(h.src).equals(before));
    check('1 the archive holds a byte-identical COPY under the session id', same(h.src, join(h.archive, `${SID}.jsonl`)));
    check('1 the fold row names the archive copy', row?.archived === join(h.archive, `${SID}.jsonl`), row);
    const receipt = JSON.parse(readFileSync(join(h.root, 'wakecycle', 'next-wake.solo.json'), 'utf8'));
    check('1 the next-wake receipt points the wake at the codex tail', receipt.sessionId === row?.tail && receipt.from === SID && receipt.lane === 'solo', receipt);
    check('1 it says the Claude Code rules were skipped, and why', /codex lane: continued-in and dead-wake are Claude Code rules/.test(r.err), r.err);
  }
  // 2. No codexHome: refuse, before anything is written.
  {
    const h = hub({ codexHome: false });
    const r = sleep(h);
    check('2 a codex lane with no codexHome refuses (exit 2)', r.code === 2 && /no codexHome/.test(r.err), r);
    check('2 and writes no fold row', lastFold(h) === null);
  }
  // 3. A registered session with no rollout yet: the zero-turn path, as for Claude Code.
  {
    const h = hub();
    rmSync(h.src);
    const r = sleep(h);
    const receipt = JSON.parse(readFileSync(join(h.root, 'wakecycle', 'next-wake.solo.json'), 'utf8'));
    check('3 no rollout for a registered session is a zero-turn day (fresh-start receipt, no fold row)', r.code === 0 && receipt.firstWake === true && lastFold(h) === null, r.err);
  }
  // 4. A compressed rollout: trim refuses by name; the fold fails loudly and writes no row.
  {
    const h = hub();
    const z = h.src + '.zst';
    copyFileSync(h.src, z);
    rmSync(h.src);
    const r = sleep(h);
    check('4 a .jsonl.zst rollout fails the fold with trim\'s reason, and no fold row', r.code === 1 && /compressed/.test(r.err) && lastFold(h) === null, r);
  }
  // 5. A codex lane never reads Claude Code's transcripts folder: a same-named file there is ignored.
  {
    const h = hub();
    writeFileSync(join(h.root, 'transcripts', `${SID}.jsonl`), '{"type":"user","message":{"role":"user","content":"a claude transcript"}}\n');
    const r = sleep(h);
    check('5 a codex lane folds its rollout, not a Claude Code transcript with the same id', r.code === 0 && lastFold(h)?.codexVersion === '0.171.0', r.err);
  }
  // 7. The collision Selvage built on #85: the codex session's id ALSO names a Claude Code transcript in the hub's
  //    shared transcripts folder, and that file is a continued-in pointer to another session that plausibly
  //    contains it. Without the codex skip, the walk would redirect the fold away from the rollout.
  {
    const h = hub();
    const Y = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const userRow = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello world' }, uuid: 'u1', timestamp: '2026-11-23T10:00:00.000Z' });
    writeFileSync(join(h.root, 'transcripts', `${SID}.jsonl`), userRow + '\n' + JSON.stringify({ type: 'continued-in', continuedInSessionId: Y }) + '\n');
    writeFileSync(join(h.root, 'transcripts', `${Y}.jsonl`), userRow + '\n');
    const r = sleep(h);
    const row = lastFold(h);
    check('7 a same-id Claude Code continued-in pointer does not redirect a codex fold', r.code === 0 && row?.provider === 'codex' && row?.source === `jsonl:${SID}`, r.err || row);
  }
  // 6. A Claude Code lane in the same hub still folds its own transcript (the default path is untouched).
  {
    const h = hub();
    const cfg = JSON.parse(readFileSync(h.config, 'utf8'));
    cfg.lanes.solo = { targetTokens: 250000 };
    writeFileSync(h.config, JSON.stringify(cfg));
    writeFileSync(join(h.root, 'wakecycle', `lane.${SID}`), JSON.stringify({ lane: 'solo', pid: 1 }) + '\n');
    const rows = [
      { parentUuid: null, uuid: 'u1', sessionId: SID, timestamp: '2026-11-23T10:00:00.000Z', type: 'user', message: { role: 'user', content: 'prompt' } },
      { parentUuid: 'u1', uuid: 'u2', sessionId: SID, timestamp: '2026-11-23T10:00:01.000Z', type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply' }] } },
    ];
    writeFileSync(join(h.root, 'transcripts', `${SID}.jsonl`), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const r = sleep(h);
    const row = lastFold(h);
    check('6 a claude-code lane still folds its transcript, with no codex fields', r.code === 0 && row?.provider === 'claude-code' && !('codexVersion' in (row ?? {})) && !/codex lane/.test(r.err), r.err || row);
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all pass');
