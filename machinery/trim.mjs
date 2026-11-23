#!/usr/bin/env node
/**
 * Transcript trimmer — the tail half of the wake (resident_ladder_on_claude_code.md rev 4).
 *
 * Takes a Claude Code session transcript, keeps the newest ~TARGET tokens of
 * entries extended back to the nearest genuine human prompt, and writes the
 * kept tail as a NEW session file (fresh uuid) in the same project directory.
 * Delete-only: whole JSONL entries are kept or dropped, nothing inside an
 * entry is rewritten except the session id itself, each reply's recorded
 * token `usage` (see STALE USAGE), images past the fold's image budget (see
 * IMAGE BUDGET), and, where a dropped harness entry sat
 * mid-chain, its children's parentUuid (see HARNESS_LOADED). The original is never
 * touched. `claude --resume <new-id> --fork-session` loads the copy as
 * native turns (tested 2026-09-27: 1,058/1,987 entries, 29 s load, texture
 * intact).
 *
 * The transcript format is the harness's own and undocumented; this script
 * knows as little of it as possible on purpose. If the format shifts, the
 * next wake breaks loudly here rather than corrupting anything.
 *
 * Usage: node trim.mjs <session-id-or-path> [--target-tokens 250000] [--image-budget-bytes 1000000] [--dry]
 * Prints JSON: { newSessionId, path, keptEntries, totalEntries, estTokens,
 *               targetTokens, cutAt, cutPrompt, overshoot?, claudeVersion? }
 * claudeVersion is the `version` on the LAST kept entry that carries one (the
 * last-written, not a semver max), the version that WROTE the tail (the one that wakes on it is recorded by
 * the watch, in the wake-cost row). Absent when no kept entry carries one.
 * overshoot (fix 5, 10/9) appears when reaching back to a human prompt carried
 * the kept estimate past OVERSHOOT × target: { ratio, extendedEntries,
 * walkCutAt }. It's also said on stderr, so a person running a fold sees it.
 *
 * This file is the command: arguments, reading the transcript, writing the tail. The
 * trimming is trim-core.mjs, and everything it knows about Claude Code's transcript is
 * providers/claude-code.mjs (PR A of anima_dev/nightwatch_providers_design.md).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { loadConfig } from './config.mjs';
import { trimTail } from './trim-core.mjs';
import * as claudeCode from './providers/claude-code.mjs';
import * as codex from './providers/codex.mjs';

const args = process.argv.slice(2);
const src = args.find((a, i) => !a.startsWith('--') && !['--target-tokens', '--image-budget-bytes', '--provider'].includes(args[i - 1]));
// Both spellings. Without the flag the target is 250,000: the old expression read args[indexOf(-1) + 1], the
// transcript's own path, so the default was NaN and every flagless run refused ("no human prompt found").
const tgtEq = args.find((a) => a.startsWith('--target-tokens='));
const tgtArg = args.indexOf('--target-tokens');
const target = Number(tgtEq !== undefined ? tgtEq.split('=')[1] : tgtArg >= 0 ? args[tgtArg + 1] : 250_000);
if (!Number.isFinite(target) || target <= 0) { console.error('trim: --target-tokens takes a number of tokens, more than 0'); process.exit(2); }
const dry = args.includes('--dry');
// Which runtime wrote the transcript (lane.provider; anima_dev/nightwatch_providers_design.md §4). Both
// spellings, as --target-tokens takes them. Without the flag it is claude-code, as every lane was before.
const provEq = args.find((a) => a.startsWith('--provider='));
const provArg = args.indexOf('--provider');
const PROVIDER = provEq !== undefined ? provEq.split('=')[1] : provArg >= 0 ? args[provArg + 1] : 'claude-code';
const ADAPTERS = { 'claude-code': claudeCode, codex };
const adapter = ADAPTERS[PROVIDER];
if (!adapter) { console.error(`trim: no adapter for provider ${JSON.stringify(PROVIDER)} (known: ${Object.keys(ADAPTERS).join(', ')})`); process.exit(2); }
// Both spellings, as --target-tokens takes them: `--image-budget-bytes N` and `--image-budget-bytes=N`.
const imgEq = args.find((a) => a.startsWith('--image-budget-bytes='));
const imgArg = args.indexOf('--image-budget-bytes');
const IMAGE_BUDGET = imgEq !== undefined ? Number(imgEq.split('=')[1] === '' ? NaN : imgEq.split('=')[1])
  : imgArg >= 0 ? Number(args[imgArg + 1] === '' || args[imgArg + 1] === undefined ? NaN : args[imgArg + 1]) : 1_000_000;
if (!Number.isFinite(IMAGE_BUDGET) || IMAGE_BUDGET < 0) { console.error('trim: --image-budget-bytes takes a number of bytes, 0 or more'); process.exit(2); }
if (!src) {
  console.error('usage: trim.mjs <session-id-or-path> [--target-tokens N] [--dry]');
  process.exit(2);
}

// A path names its own transcript. Only a bare session id needs the hub's
// transcripts folder, so only then is a hub config required: since #7 (A2)
// a missing config is an error, and loading it up front refused path runs
// that touch no hub (trim-test's, and any by hand).
if (PROVIDER === 'codex' && !existsSync(src)) {
  console.error(`trim: a codex rollout is named by its path (no rollout at ${src})`);
  process.exit(2);
}
if (PROVIDER === 'codex' && src.endsWith('.zst')) {
  console.error('trim: this rollout is compressed (.jsonl.zst, Codex compresses rollouts older than 7 days); the codex adapter reads plain .jsonl only');
  process.exit(2);
}
const srcPath = existsSync(src) ? src : join(loadConfig().paths.transcripts, `${src}.jsonl`);
if (!existsSync(srcPath)) {
  console.error(`no transcript at ${srcPath}`);
  process.exit(2);
}
const oldId = adapter.sessionIdOf(srcPath);

const lines = readFileSync(srcPath, 'utf8').split('\n').filter((l) => l.trim());
const result = trimTail({ lines, adapter, target, imageBudget: IMAGE_BUDGET, warn: (m) => console.error(m) });
if (result.refused) {
  console.error(result.refused.message);
  process.exit(result.refused.exit);
}

const newId = randomUUID();
const { path: outPath, text: out } = adapter.newSession(result.keptLines, { srcPath, oldId, newId });
const report = adapter.report({ ...result.facts, newId, path: outPath });
if (dry) {
  report.dry = true;
} else {
  writeFileSync(outPath, out);
}
console.log(JSON.stringify(report, null, 2));
