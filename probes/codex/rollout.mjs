// Codex rollout files, read and planted, for the provider probe
// (anima_dev/nightwatch_providers_design.md §6, §3b).
//
// Pure functions over text, so the offline test needs no codex and no login.
// Everything here stands on the 11/20 source read (clone 1c0c806); the probe's
// job is to confirm or overturn it on the INSTALLED version, so nothing in this
// file is a claim about codex's behaviour, only about the file format as read.
//
// Lines: {"timestamp", "ordinal"?, "type", "payload"}. A linear log: no parent
// chains. The first line must be session_meta. Paginated files carry ordinals;
// legacy files don't.

import { randomUUID } from 'node:crypto';

/** One parsed line, or null for a line codex would skip (torn, not an object). */
export function parseLine(line) {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function parseRollout(text) {
  return String(text).split('\n').map(parseLine).filter(Boolean);
}

/** The thread id a canonical filename names: rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl(.zst) */
export function idFromFilename(name) {
  const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]+)?\.jsonl(?:\.zst)?$/.exec(name);
  return m ? m[1] : null;
}

/** The canonical filename for a thread started at `date` (local time, as codex writes it). */
export function canonicalFilename(id, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
  return { dir: `${date.getFullYear()}/${p(date.getMonth() + 1)}/${p(date.getDate())}`, name: `rollout-${ts}-${id}.jsonl` };
}

/** The kind of a line, one level deeper where codex nests one (event_msg and response_item). */
export function kindOf(row) {
  const sub = row.payload && typeof row.payload === 'object' ? row.payload.type : undefined;
  return sub && (row.type === 'event_msg' || row.type === 'response_item') ? `${row.type}/${sub}` : String(row.type);
}

/**
 * P1's schema summary: what kinds of line there are, which keys each carries,
 * and the facts the design depends on, each as found (never assumed).
 */
export function summarize(rows) {
  const kinds = {};
  for (const r of rows) {
    const k = kindOf(r);
    const entry = (kinds[k] ??= { count: 0, keys: new Set(), payloadKeys: new Set() });
    entry.count++;
    for (const key of Object.keys(r)) entry.keys.add(key);
    if (r.payload && typeof r.payload === 'object') for (const key of Object.keys(r.payload)) entry.payloadKeys.add(key);
  }
  const meta = rows[0]?.type === 'session_meta' ? rows[0].payload ?? {} : null;
  const roles = {};
  for (const r of rows) {
    if (r.type === 'response_item' && r.payload?.type === 'message') roles[r.payload.role] = (roles[r.payload.role] ?? 0) + 1;
  }
  return {
    lines: rows.length,
    firstIsSessionMeta: rows[0]?.type === 'session_meta',
    sessionMetaKeys: meta ? Object.keys(meta).sort() : null,
    historyMode: meta?.history_mode ?? null,
    cliVersion: meta?.cli_version ?? null,
    ordinals: rows.filter((r) => r.ordinal !== undefined).length,
    parentChain: rows.some((r) => 'parentUuid' in r || 'parent_id' in r || r.payload?.parent_id !== undefined),
    messageRoles: roles,
    tokenCounts: rows.filter((r) => kindOf(r) === 'event_msg/token_count').length,
    tokenCountsWithRateLimits: rows.filter((r) => kindOf(r) === 'event_msg/token_count' && r.payload?.rate_limits).length,
    tokenUsageRecords: rows.filter((r) => r.type === 'token_usage_record').length,
    turnContexts: rows.filter((r) => r.type === 'turn_context').length,
    compacted: rows.filter((r) => r.type === 'compacted').length,
    kinds: Object.fromEntries(Object.entries(kinds).sort().map(([k, v]) => [k, { count: v.count, keys: [...v.keys].sort(), payloadKeys: [...v.payloadKeys].sort() }])),
  };
}

const isTokenCount = (r) => kindOf(r) === 'event_msg/token_count';

/**
 * The fold recipe as read (§3b), for P6 and P8. Returns { id, text } for a NEW
 * file; the source is never written.
 *
 * - session_meta first, with a fresh id/session_id; history_mode, history_base
 *   and forked_from_id removed (legacy by default, not a fork).
 * - no `ordinal` on any line.
 * - the tail: the source's lines from `fromIndex` on (a turn boundary is the
 *   caller's choice; the probe keeps whole sessions, so the default is 1).
 * - tokenCounts: 'strip' (the amended recipe), 'keep' (as the source has them),
 *   or { inflate: N } (keep them and set every total to N: P8's planted stale
 *   total).
 * - compacted: a REAL `compacted` row captured from codex (never synthesized
 *   here: its shape is not settled at read grade), placed first in the tail.
 */
export function plant(rows, { id = randomUUID(), fromIndex = 1, tokenCounts = 'strip', compacted = null, now = new Date() } = {}) {
  if (rows[0]?.type !== 'session_meta') throw new Error('plant: the source does not start with session_meta');
  if (fromIndex < 1 || fromIndex > rows.length) throw new Error(`plant: fromIndex ${fromIndex} is outside 1..${rows.length}`);
  if (compacted && compacted.type !== 'compacted') throw new Error('plant: the compacted row given is not a compacted row');
  const meta = structuredClone(rows[0]);
  delete meta.ordinal;
  meta.timestamp = now.toISOString();
  meta.payload = { ...meta.payload, id, session_id: id, timestamp: now.toISOString() };
  for (const k of ['history_mode', 'history_base', 'forked_from_id']) delete meta.payload[k];
  let tail = rows.slice(fromIndex).map((r) => {
    const c = structuredClone(r);
    delete c.ordinal;
    return c;
  });
  if (tokenCounts === 'strip') tail = tail.filter((r) => !isTokenCount(r));
  else if (tokenCounts && typeof tokenCounts === 'object' && Number.isFinite(tokenCounts.inflate)) {
    const n = tokenCounts.inflate;
    for (const r of tail) {
      const info = isTokenCount(r) ? r.payload?.info : null;
      if (info?.total_token_usage && typeof info.total_token_usage === 'object') {
        info.total_token_usage = { ...info.total_token_usage, total_tokens: n, input_tokens: n };
      }
    }
  } else if (tokenCounts !== 'keep') throw new Error(`plant: tokenCounts must be 'strip', 'keep' or { inflate: N }`);
  if (compacted) {
    const c = structuredClone(compacted);
    delete c.ordinal;
    tail.unshift(c);
  }
  const out = [meta, ...tail];
  return { id, rows: out, text: out.map((r) => JSON.stringify(r)).join('\n') + '\n', filename: canonicalFilename(id, now) };
}
