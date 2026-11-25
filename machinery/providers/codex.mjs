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
 * A tail opens at a turn's start (event_msg/task_started). The folded file carries NO initial context: no
 * tool declarations, no developer rows, no environment or AGENTS.md rows, no world_state, no turn_context,
 * and none inside a compacted row's replacement history either. Codex builds a session's head (base prompt,
 * tools, environment, and the -c developer_instructions that carry the checkpoint) only when the file has no
 * turn_context baseline, and then appends it whole. Leg 3's probe (11/25, four turns on one sandbox session):
 *   - kept as before (the first turn's preamble and the turn_context rows): the checkpoint never reached the
 *     model, silently;
 *   - turn_context alone stripped: the rollout recorded the checkpoint beside a doubled head, and the model
 *     answered that it had none, twice; a row in the file is not a row the model read;
 *   - every initial-context row stripped: one fresh head, the checkpoint read, the history kept.
 * So a wake rebuilds exactly one head, and the checkpoint is part of it.
 *
 * Rollouts older than 7 days are compressed to .jsonl.zst by Codex; this adapter reads plain .jsonl only
 * and trim refuses a .zst source by name rather than reading compressed bytes as lines.
 */
import { join, dirname, basename } from 'node:path';

import { estLine } from '../trim-core.mjs';

export const name = 'codex';

/**
 * Who this adapter speaks for, with the receipt behind each claim (anima_dev/nightwatch_providers_design.md §4; codex
 * lane leg 5). Pure: all I/O is injected, and WITHOUT io the identity is still whole, with version null and
 * versionSource null, never a guess.
 *
 * io: { rolloutVersion } — session_meta.cli_version off the session's own rollout (the strongest source: it names
 *     what actually ran); or { codexBin, nodePath, isExecutable(path), lookupPath(name), runVersion(path) } to
 *     resolve the binary the way the machinery runs it (codexlane.mjs codexBinFor: paths.codexBin, else the codex
 *     beside the daemon's node, else PATH's) and ask it.
 *
 * launchSurface lists exactly what wake.sh and the bells stand on, each with the help page that must define it; every
 * `defined` claim is checked against the REAL `codex --help` fixtures under machinery/testdata/codex by
 * providers-identify-test.mjs (the #44 lesson). witness: the woken rollout's own developer part, one head
 * (codexlane.mjs codexHeadWitness, leg 3).
 */
export function parseVersion(text) {
  const m = /codex-cli (\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}
export function identify(io = {}) {
  let bin = io.codexBin ?? null;
  let via = io.codexBin ? 'paths.codexBin' : null;
  if (io.isExecutable && io.lookupPath) {
    const beside = io.nodePath ? join(dirname(io.nodePath), 'codex') : null;
    if (io.codexBin && io.isExecutable(io.codexBin)) { bin = io.codexBin; via = 'paths.codexBin'; }
    else if (beside && io.isExecutable(beside)) { bin = beside; via = 'beside node'; }
    else { bin = io.lookupPath('codex') ?? null; via = bin ? 'PATH' : null; }
  }
  let version = null;
  let versionSource = null;
  if (typeof io.rolloutVersion === 'string' && io.rolloutVersion) {
    version = io.rolloutVersion;
    versionSource = 'rollout';
  } else if (io.runVersion && bin) {
    version = parseVersion(io.runVersion(bin));
    versionSource = version ? '--version' : null;
  }
  return {
    provider: name,
    bin,
    via,
    lookupLabel: 'Codex CLI',
    version,
    versionSource,
    launchSurface: [
      { name: 'resume', kind: 'subcommand', page: '', defined: true }, // wake.sh: codex resume <tail>
      { name: 'queue', kind: 'subcommand', page: '', defined: true }, // the bells: codex queue
      { name: '--no-daemon', kind: 'flag', page: 'resume', defined: true }, // leg 2's e2e: no outliving daemon
      { name: '--model', kind: 'flag', page: 'resume', defined: true }, // wake.sh -m <model>
      { name: '--config', kind: 'flag', page: 'resume', defined: true }, // wake.sh -c developer_instructions=<head>
      { name: '--thread', kind: 'flag', page: 'queue', defined: true },
      { name: '--message', kind: 'flag', page: 'queue', defined: true },
    ],
    witness: 'rollout-developer-part',
  };
}

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

// Initial context: what Codex writes into a session's head and rebuilds on a resume when the file has none
// (leg 3's probe). A response item counts by its own type and role, so the same rule reads rows and the items
// inside a compacted row's replacement history. Every developer row seen in the sandbox's 16 rollouts was
// context (base prompt, permissions, skills, tools, modes, plugins, incremental tool updates, a planted
// checkpoint); the user rows here are the environment and AGENTS.md, which Codex re-injects per launch.
// Bells ("[nightwatch bell, ...]") and the person's prompts are conversation and stay.
const CONTEXT_USER = ['<environment_context>', '# AGENTS.md instructions for'];
function isContextItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (it.type === 'additional_tools') return true;
  if (it.type !== 'message') return false;
  if (it.role === 'developer' || it.role === 'system') return true;
  if (it.role !== 'user') return false;
  // The first content part only: Codex 0.171.0 writes the environment and AGENTS.md rows as one part each. A future
  // multi-part row is a known edge (Selvage's note on #90): anything this rule misses keeps a second head, which the
  // witness's one-head count reports red.
  const first = Array.isArray(it.content) ? it.content[0]?.text : undefined;
  return typeof first === 'string' && CONTEXT_USER.some((p) => first.startsWith(p));
}
export function isContext(e) {
  if (e === null || typeof e !== 'object') return false;
  const k = kindOf(e);
  if (k === 'world_state' || k === 'turn_context') return true;
  return e.type === 'response_item' && isContextItem(e.payload);
}

// Never kept, never weighed: the stale-usage rows (P8) and the initial context (leg 3).
export function drop(e) {
  if (e === null) return false;
  const k = kindOf(e);
  return k === 'event_msg/token_count' || k === 'token_usage_record' || isContext(e);
}

// Kept, never weighed, never sent: the header and the UI's event copies. Codex builds the model's input from
// response_item and compacted rows (turn_context and world_state are context, dropped above).
export function inert(e) {
  if (e === null) return false;
  const k = kindOf(e);
  return k === 'session_meta' || e.type === 'event_msg';
}

export function isSeam(e) {
  return kindOf(e) === 'event_msg/task_started';
}

export function order(entries, cut) {
  const meta = entries.findIndex((e) => kindOf(e) === 'session_meta');
  const out = meta >= 0 && meta < cut ? [meta] : [];
  for (let i = cut; i < entries.length; i++) out.push(i);
  return { order: out, movedIn: 0 };
}

export function keep(entries, lines, ord) {
  const kept = [];
  const counts = { dropped: 0, ordinalsStripped: 0, tokenCountsDropped: 0, usageRecordsDropped: 0, contextDropped: 0, contextInCompacted: 0 };
  for (const i of ord) {
    const e0 = entries[i];
    if (e0 === null) continue;
    if (drop(e0)) {
      counts.dropped++;
      if (kindOf(e0) === 'event_msg/token_count') counts.tokenCountsDropped++;
      else if (kindOf(e0) === 'token_usage_record') counts.usageRecordsDropped++;
      else counts.contextDropped++;
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
    // Codex's own compaction carries a copy of the old head in its replacement history; it goes the same way.
    const hist = kindOf(e) === 'compacted' ? e.payload?.replacement_history : null;
    if (Array.isArray(hist) && hist.some(isContextItem)) {
      const keptHist = hist.filter((it) => !isContextItem(it));
      counts.contextInCompacted += hist.length - keptHist.length;
      e = { ...e, payload: { ...e.payload, replacement_history: keptHist } };
      changed = true;
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
  // Defense in depth: drop() removes these, so only a tail built some other way could carry one; whether resume
  // seeds from it is unestablished, and a wall costs nothing (Selvage's read, #84).
  const records = rows.filter((r) => kindOf(r) === 'token_usage_record').length;
  if (records) problems.push(`${records} token_usage_record row(s) kept (usage accounting does not travel)`);
  if (rows.some((r) => r && 'ordinal' in r)) problems.push('a kept row still carries an ordinal');
  // A kept head means the woken session gets no new one, and with it no checkpoint (leg 3's probe).
  const ctx = rows.filter(isContext);
  if (ctx.length) problems.push(`${ctx.length} initial-context row(s) kept (${[...new Set(ctx.map(kindOf))].join(', ')}): the wake would show no checkpoint`);
  const inHist = rows.reduce((n, r) => n + (kindOf(r) === 'compacted' && Array.isArray(r.payload?.replacement_history) ? r.payload.replacement_history.filter(isContextItem).length : 0), 0);
  if (inHist) problems.push(`${inHist} initial-context item(s) kept inside a compacted row's replacement history: the wake would show no checkpoint`);
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
    contextDropped: f.counts.contextDropped,
    ...(f.counts.contextInCompacted ? { contextInCompacted: f.counts.contextInCompacted } : {}),
    ...(f.imagesStripped.count ? { imagesStripped: f.imagesStripped } : {}),
    cutAt: timestampOf(f.entries[f.cut]),
    cutPrompt: String(prompt?.payload?.content?.[0]?.text ?? '').slice(0, 120),
  };
}
