#!/usr/bin/env node
// The trimmer's replay gate (PR A of anima_dev/nightwatch_providers_design.md): run a trim.mjs over every
// archived transcript at each lane target and record, per run,
// the exit code, a hash of stderr, the report (minus the new id and path), and a hash of the written
// tail with the new session id replaced by a fixed placeholder. Two such records must be identical.
//
//   node trim-replay.mjs run <trim.mjs> <archiveDir> <out.json> [--targets 200000,250000] [--limit N]
//   node trim-replay.mjs diff <a.json> <b.json>
//
// Run the OLD trim from a frozen copy (git archive <base> machinery | tar -x -C <dir>), never from the tree
// being edited: the harness starts a fresh trim for every transcript, so an edit mid-run mixes the two.
// Not a *-test.mjs: CI has no archive. Run by hand before any change to trim.mjs or its adapters.
//
// The archive is never written: each transcript gets a symlink in a scratch dir, trim reads through it
// and writes its tail beside the link, and the tail is hashed and removed at once.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const [mode, ...rest] = process.argv.slice(2);

if (mode === 'diff') {
  const [a, b] = rest.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const key = (r) => `${r.file}@${r.target}`;
  const bm = new Map(b.runs.map((r) => [key(r), r]));
  let same = 0; const diffs = [];
  for (const r of a.runs) {
    const o = bm.get(key(r));
    if (!o) { diffs.push(`${key(r)}: missing in b`); continue; }
    const ja = JSON.stringify(r), jb = JSON.stringify(o);
    if (ja === jb) same++; else diffs.push(`${key(r)}: ${ja.slice(0, 300)}\n    vs ${jb.slice(0, 300)}`);
    bm.delete(key(r));
  }
  for (const k of bm.keys()) diffs.push(`${k}: missing in a`);
  console.log(`identical ${same} of ${a.runs.length} (a) / ${b.runs.length} (b); differences ${diffs.length}`);
  for (const d of diffs.slice(0, 20)) console.log('  ' + d);
  process.exit(diffs.length ? 1 : 0);
}

if (mode !== 'run') { console.error('usage: trim-replay.mjs run|diff ...'); process.exit(2); }
const [trim, archive, outPath, ...flags] = rest;
const ti = flags.indexOf('--targets');
const targets = (ti >= 0 ? flags[ti + 1] : '200000,250000').split(',').map(Number);
const limit = flags.includes('--limit') ? Number(flags[flags.indexOf('--limit') + 1]) : Infinity;
const files = readdirSync(archive).filter((f) => f.endsWith('.jsonl')).sort().slice(0, limit);
const scratch = mkdtempSync(join(tmpdir(), 'trim-replay-'));
const env = { ...process.env };
for (const k of ['WEFT_CONFIG', 'NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE', 'NIGHTWATCH_NODE']) delete env[k];
const runs = [];
const started = Date.now();
try {
  for (const [n, f] of files.entries()) {
    const link = join(scratch, f);
    symlinkSync(resolve(archive, f), link);
    for (const target of targets) {
      const p = spawnSync(process.execPath, [trim, link, '--target-tokens', String(target)], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
      const run = { file: f, target, exit: p.status, stderr: sha(p.stderr ?? '') };
      if (p.status === 0) {
        const report = JSON.parse(p.stdout);
        const out = report.path;
        const body = readFileSync(out, 'utf8').split(report.newSessionId).join('NEW-SESSION-ID');
        unlinkSync(out);
        delete report.newSessionId; delete report.path;
        run.report = report; run.out = sha(body);
      }
      runs.push(run);
    }
    unlinkSync(link);
    if (n % 25 === 0) console.error(`${n + 1}/${files.length} ${Math.round((Date.now() - started) / 1000)}s`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const trimSha = sha(readFileSync(trim));
writeFileSync(outPath, JSON.stringify({ trim, trimSha, archive, targets, files: files.length, runs }, null, 1));
const exits = runs.reduce((m, r) => (m[r.exit] = (m[r.exit] ?? 0) + 1, m), {});
console.log(`done: ${runs.length} runs over ${files.length} files in ${Math.round((Date.now() - started) / 1000)}s; exits ${JSON.stringify(exits)}`);
