#!/usr/bin/env node
// Four of trim.mjs's behaviours that neither trim-test.mjs nor the archive replay reached (Sonnet's
// second read of nightwatch#81 planted each and saw it survive both): the torn-line warning on stderr,
// the no-seam refusal's exit and message, harnessDropped counted apart from relinked, and the writer
// version when only the cut entry carries one. They pin what the trimmer already does, so this file
// passes against main's trim.mjs from before the providers split too. Writes only to a temp dir.
// Run: node machinery/trim-pins-test.mjs   (exit 0 = all pass)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'trim-pins-'));
let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) fails++;
}

// A chain of rows; each row's parent is the one before it unless it names its own.
function transcript(sid, specs) {
  let prev = null;
  return specs.map((e, i) => {
    if (typeof e === 'string') return e; // a raw (torn) line, written as is
    const uuid = `${sid.slice(0, 4)}-u${i + 1}`;
    const row = { parentUuid: prev, uuid, sessionId: sid, timestamp: `2026-11-20T20:${String(i).padStart(2, '0')}:00.000Z`, ...e };
    prev = uuid;
    return JSON.stringify(row);
  }).join('\n') + '\n';
}
function trim(sid, text, target = 100_000) {
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, text);
  return spawnSync(process.execPath, [join(HERE, 'trim.mjs'), path, '--target-tokens', String(target), '--dry'], { encoding: 'utf8' });
}
const human = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const reply = (text, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const instructions = { type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: 'head' }] } };

try {
  // C8: a torn line is dropped and SAID, on stderr, in these words.
  {
    const r = trim('a0000000-0000-0000-0000-00000000000c', transcript('a0000000', [human('hello'), '{"type":"user","message":{"cont', reply('hi')]));
    check('a torn line: the fold goes ahead', r.status === 0, `exit ${r.status}: ${r.stderr}`);
    check('a torn line: stderr says so, in the warning\'s words', r.stderr.includes('warning: 1 unparseable line(s) will be dropped'), JSON.stringify(r.stderr));
  }

  // C10: no row a tail may open at: exit 1 and the refusal's own message, nothing written.
  {
    const r = trim('b0000000-0000-0000-0000-00000000000a', transcript('b0000000', [reply('one'), reply('two'), { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x' } }]));
    check('no seam: exit 1', r.status === 1, `exit ${r.status}`);
    check('no seam: the refusal says why', r.stderr.includes('no human prompt found anywhere — refusing to cut'), JSON.stringify(r.stderr));
    check('no seam: no report on stdout', r.stdout.trim() === '', JSON.stringify(r.stdout));
  }

  // A1: two harness heads in a row are both dropped, and only the row after them is re-pointed,
  // so harnessDropped (2) and relinked (1) differ.
  {
    const r = trim('c0000000-0000-0000-0000-0000000000a1', transcript('c0000000', [human('welcome back'), instructions, instructions, reply('reply')]));
    const rep = r.status === 0 ? JSON.parse(r.stdout) : {};
    check('two heads in a row: both dropped', rep.harnessDropped === 2, JSON.stringify(rep));
    check('two heads in a row: one row re-pointed', rep.relinked === 1, JSON.stringify(rep));
  }

  // A10: the writer version is read from the cut entry itself when it is the only kept entry with one.
  {
    const r = trim('d0000000-0000-0000-0000-0000000000a0', transcript('d0000000', [human('the only prompt', { version: '2.1.329' }), reply('a'), reply('b')]));
    const rep = r.status === 0 ? JSON.parse(r.stdout) : {};
    check('only the cut entry carries a version: the report names it', rep.claudeVersion === '2.1.329', JSON.stringify(rep));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
