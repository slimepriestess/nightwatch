/**
 * The OpenAI Codex CLI rollout adapter for the trimmer (trim-core.mjs).
 *
 * Everything the trimmer knows about a Codex rollout lives here. The rules are the fold recipe of
 * anima_dev/nightwatch_providers_design.md §3b, run against codex-cli 0.171.0 by the probe kit
 * (probes/codex) on 2026-11-23; each rule below names the probe it stands on.
 *
 * A rollout is a linear event log: one JSON object per line, {timestamp, ordinal?, type, payload}, with
 * session_meta first and no parent chains (P1). The fold writes a NEW file, the way P6 proved resumes and
 * answers from the file alone (with a control: the same session with its word swapped answered the
 * swapped word):
 *   - session_meta first, with history_mode, history_base and forked_from_id removed, so the new file is a
 *     legacy rollout and not a fork that points at its parent by byte offset (P2), and a fresh id;
 *   - no `ordinal` on any line (ordinals belong to paginated files; P6 resumed without them and Codex kept
 *     the file legacy);
 *   - no event_msg/token_count: a kept one seeds the woken session with the folded session's size, and
 *     Codex then compacts before the first turn and keeps counting from the stale total (P8). validate()
 *     refuses any tail that still carries one, as trim's usage check does for Claude Code;
 *   - no token_usage_record either: it is accounting, never sent, and whether resume seeds anything from it
 *     is unestablished (P8 did not inflate it), so it does not travel.
 * A tail opens at a turn's start (event_msg/task_started). Base instructions, tool declarations and the
 * environment come once, in the session's first turn (P1); a later turn repeats only some of them. So a
 * cut past the first turn keeps the first turn's preamble (its rows before its turn_context) ahead of the
 * tail, the way a system prompt stays.
 *
 * Rollouts older than 7 days are compressed to .jsonl.zst by Codex; this adapter reads plain .jsonl only
 * and trim refuses a .zst source by name rather than reading compressed bytes as lines.
 */
import { join, dirname, basename } from 'node:path';

import { estLine } from '../trim-core.mjs';

export const name = 'codex';

const kindOf = (e) => {
  if (!e || typeof e !== 'object') return null;
  const sub = e.payload && typeof e.payload === 'object' ? e.payload.type : undefined;
  return (e.type === 'event_msg' || e.type === 'response_item') && sub ? `${e.type}/${sub}` : String(e.type);
};

export function parse(line) {
  try {
    const e = JSON.parse(line);
    return e && typeof e === 'object' && !Array.isArray(e) && typeof e.type === 'string' ? e : null;
  } catch {
    return null;
  }
}

export function serialize(e) {
  return JSON.stringify(e);
}

export function weigh(line) {
  return estLine(line);
}

const ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]+)?\.jsonl(?:\.zst)?$/;
export function sessionIdOf(srcPath) {
  const m = ID_RE.exec(basename(srcPath));
  return m ? m[1] : null;
}

export function timestampOf(e) {
  return typeof e?.timestamp === 'string' ? e.timestamp : null;
}

// Never kept, never weighed: the stale-usage rows (P8).
export function drop(e) {
  if (e === null) return false;
  const k = kindOf(e);
  return k === 'event_msg/token_count' || k === 'token_usage_record';
}

// Kept, never weighed, never sent: the header, per-turn settings and the UI's event copies. Codex builds the
// model's input from response_item, compacted and world_state rows.
export function inert(e) {
  if (e === null) return false;
  const k = kindOf(e);
  return k === 'session_meta' || k === 'turn_context' || e.type === 'event_msg';
}

export function isSeam(e) {
  return kindOf(e) === 'event_msg/task_started';
}

// The first turn's preamble: its rows after task_started and before its turn_context, minus UI events.
function preamble(entries) {
  const start = entries.findIndex((e) => isSeam(e));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < entries.length; i++) {
    const k = kindOf(entries[i]);
    if (k === 'turn_context' || isSeam(entries[i])) break;
    if (entries[i] && entries[i].type !== 'event_msg' && !drop(entries[i])) out.push(i);
  }
  return out;
}

export function order(entries, cut) {
  const meta = entries.findIndex((e) => kindOf(e) === 'session_meta');
  const head = meta >= 0 && meta < cut ? [meta] : [];
  const firstTurn = entries.findIndex((e) => isSeam(e));
  const pre = firstTurn >= 0 && cut > firstTurn ? preamble(entries).filter((i) => i < cut) : [];
  const out = [...head, ...pre];
  for (let i = cut; i < entries.length; i++) out.push(i);
  return { order: out, movedIn: 0 };
}

export function keep(entries, lines, ord) {
  const kept = [];
  const counts = { dropped: 0, ordinalsStripped: 0, tokenCountsDropped: 0, usageRecordsDropped: 0 };
  for (const i of ord) {
    const e0 = entries[i];
    if (e0 === null) continue;
    if (drop(e0)) {
      counts.dropped++;
      if (kindOf(e0) === 'event_msg/token_count') counts.tokenCountsDropped++;
      else counts.usageRecordsDropped++;
      continue;
    }
    let e = e0;
    let changed = false;
    if ('ordinal' in e) {
      e = { ...e };
      delete e.ordinal;
      counts.ordinalsStripped++;
      changed = true;
    }
    if (kindOf(e) === 'session_meta' && e.payload && typeof e.payload === 'object') {
      const p = { ...e.payload };
      let touched = false;
      for (const k of ['history_mode', 'history_base', 'forked_from_id']) if (k in p) { delete p[k]; touched = true; }
      if (touched) { e = { ...e, payload: p }; changed = true; }
    }
    kept.push({ line: changed ? JSON.stringify(e) : lines[i], entry: e });
  }
  return { kept, counts };
}

// Images arrive as input_image blocks whose image_url is a data: URI.
export function mayCarryImages(line) {
  return line.includes('"input_image"');
}
export function stripImages(e, take, imageBudget) {
  const content = e?.payload?.content;
  if (!Array.isArray(content)) return null;
  let changed = false;
  const blocks = content.slice();
  for (let j = blocks.length - 1; j >= 0; j--) {
    const b = blocks[j];
    if (b?.type !== 'input_image' || typeof b.image_url !== 'string' || !b.image_url.startsWith('data:')) continue;
    if (take(b.image_url.length)) continue;
    blocks[j] = { type: 'input_text', text: `[image removed at fold: ${Math.round(b.image_url.length / 1024)} KB of base64; a fold keeps only the newest images, ${Math.round(imageBudget / 1e6 * 10) / 10} MB in all]` };
    changed = true;
  }
  return changed ? { ...e, payload: { ...e.payload, content: blocks } } : null;
}

/**
 * The format gate: any problem blocks the write (trim-core). Each rule is a property P6 resumed with or
 * P8 showed the woken session needs.
 */
export function validate(keptLines) {
  const problems = [];
  const rows = keptLines.map(parse);
  if (rows.some((r) => r === null)) problems.push('a kept line does not parse as a rollout row');
  if (kindOf(rows[0]) !== 'session_meta') problems.push('the tail does not open with session_meta');
  const meta = rows[0]?.payload ?? {};
  for (const k of ['history_mode', 'history_base', 'forked_from_id']) {
    if (kindOf(rows[0]) === 'session_meta' && k in meta) problems.push(`session_meta still carries ${k}`);
  }
  if (rows.filter((r) => kindOf(r) === 'session_meta').length > 1) problems.push('more than one session_meta');
  const counts = rows.filter((r) => kindOf(r) === 'event_msg/token_count').length;
  if (counts) problems.push(`${counts} event_msg/token_count row(s) kept (a stale count seeds the woken session: P8)`);
  if (rows.some((r) => r && 'ordinal' in r)) problems.push('a kept row still carries an ordinal');
  const start = rows.findIndex((r) => isSeam(r) || kindOf(r) === 'compacted');
  if (start < 0) problems.push('no turn start (task_started) or compacted row in the tail');
  else {
    const early = rows.slice(1, start).find((r) => kindOf(r) === 'response_item/message' && r.payload?.role === 'assistant');
    if (early) problems.push('an assistant message sits before the first turn start');
  }
  // A call kept without its output, or an output without its call, cannot be replayed.
  const calls = new Map();
  const outputs = new Map();
  for (const r of rows) {
    const t = r?.type === 'response_item' ? r.payload?.type : null;
    const id = r?.payload?.call_id;
    if (typeof t !== 'string' || typeof id !== 'string') continue;
    if (t.endsWith('_call_output')) outputs.set(id, t);
    else if (t.endsWith('_call')) calls.set(id, t);
  }
  for (const [id, t] of calls) if (!outputs.has(id)) problems.push(`${t} ${id} kept without its output`);
  for (const [id, t] of outputs) if (!calls.has(id)) problems.push(`${t} ${id} kept without its call`);
  return problems;
}

// Codex finds a rollout by scanning sessions/YYYY/MM/DD for rollout-<local time>-<id>.jsonl. The new file goes
// in today's folder under the same sessions root as the source, with the fresh id in its header.
export function newSession(keptLines, { srcPath, newId, now = new Date() }) {
  const p2 = (n) => String(n).padStart(2, '0');
  const day = join(dirname(dirname(dirname(dirname(srcPath)))), String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate()));
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  const out = keptLines.map((l, i) => {
    if (i !== 0) return l;
    const e = JSON.parse(l);
    return JSON.stringify({ ...e, timestamp: now.toISOString(), payload: { ...e.payload, id: newId, session_id: newId, timestamp: now.toISOString() } });
  });
  return { path: join(day, `rollout-${stamp}-${newId}.jsonl`), text: out.join('\n') + '\n' };
}

export function report(f) {
  const tail = f.entries.slice(f.cut);
  const meta = f.entries.find((e) => kindOf(e) === 'session_meta');
  const prompt = tail.find((e) => kindOf(e) === 'response_item/message' && e.payload?.role === 'user'
    && !String(e.payload?.content?.[0]?.text ?? '').startsWith('<environment_context>'));
  return {
    newSessionId: f.newId,
    path: f.path,
    keptEntries: f.keptEntries,
    totalEntries: f.totalEntries,
    estTokens: f.estTokens,
    targetTokens: f.target,
    ...(f.overshoot ? { overshoot: f.overshoot } : {}),
    ...(typeof meta?.payload?.cli_version === 'string' ? { codexVersion: meta.payload.cli_version } : {}),
    tornLines: f.torn,
    tokenCountsDropped: f.counts.tokenCountsDropped,
    usageRecordsDropped: f.counts.usageRecordsDropped,
    ordinalsStripped: f.counts.ordinalsStripped,
    ...(f.imagesStripped.count ? { imagesStripped: f.imagesStripped } : {}),
    cutAt: timestampOf(f.entries[f.cut]),
    cutPrompt: String(prompt?.payload?.content?.[0]?.text ?? '').slice(0, 120),
  };
}
