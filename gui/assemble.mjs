// Nightwatch snapshot assembler — PURE, with injected io (Phase B).
//
// assemble(cfg, io, range) turns the house's files into the snapshot the
// emitter renders (NOW/LANES/NIGHT/LOG/ACTIVITY/TIMELINE/DECK). No node
// imports here: everything that touches the world comes through `io`, so
// server.mjs passes node-backed io and the Tauri shell passes io backed by
// a handful of thin Rust commands — one assembler, one emitter, zero drift
// between the browser viewer and the app (the shape opus proposed, taken).
//
// io contract (every call returns a harmless empty on failure, never throws):
//   readText(path)        -> string | null
//   readDir(path)         -> string[]            ([] on failure)
//   stat(path)            -> { size, mtimeMs } | null
//   readTail(path, bytes) -> string | null        (last N bytes of the file)
//   livePids()            -> number[]             (CLAUDE pids only — the
//                            implementation must verify the command, not
//                            just pid existence: pids recycle)
//   psCommand(pid)        -> string | null
//   now()                 -> ms since epoch
//
// Written by: claude-fable-5, 2026-10-06. Logic lifted from gui/server.mjs
// (with claude-opus-5-5's ctx/throughput/cache rewrite of 10/5 intact).

const laneCfg = (cfg, lane) => ({ targetTokens: 250_000, switchboard: false, ...(cfg.lanes?.[lane] ?? {}) });

const parseLines = (text) =>
  (text ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const joinPath = (...parts) => parts.join('/');

// ---------------------------------------------------------------- sources
function laneOfSid(cfg, io, sid, registryLaneForSid) {
  // Lane attribution for a live sid the registry doesn't know: registry
  // first; then the event stream's folded rows, which map tail sids to
  // lanes with authority (a fork-session wake's ps command carries the
  // TAIL sid); the cwd-marker vote is last (lanes[].cwdMarker from config,
  // never a hardcoded repo name).
  if (registryLaneForSid) return registryLaneForSid;
  for (const row of parseLines(io.readText(cfg.paths.events)).reverse()) {
    if (row.kind === 'folded' && row.tail === sid && row.lane) return row.lane;
  }
  const raw = io.readText(joinPath(cfg.paths.transcripts, `${sid}.jsonl`));
  if (raw == null) return null;
  const tail = raw.split('\n').filter(Boolean).slice(-200);
  for (let i = tail.length - 1; i >= 0; i--) {
    try {
      const c = JSON.parse(tail[i]).cwd;
      if (!c) continue;
      for (const [name, lc] of Object.entries(cfg.lanes ?? {})) {
        if (lc && lc.cwdMarker && String(c).includes(lc.cwdMarker)) return name;
      }
    } catch {}
  }
  for (const [name, lc] of Object.entries(cfg.lanes ?? {})) if (lc && lc.switchboard) return name;
  return cfg.defaultLane ?? null;
}

// The harness's own status file per process (~/.claude/sessions/<pid>.json)
// names the session that process is running NOW. A command line's
// `--resume <sid>` is fixed at launch and goes stale through a /clear or an
// in-window /resume (10/8: the window ran 7b83b7ae while its command line
// still said c4454e27), so the status file wins wherever one exists.
const claudeSessionsDir = (cfg) => cfg.paths.claudeSessions ?? String(cfg.paths.transcripts ?? '').replace(/\/projects\/[^/]+\/?$/, '/sessions');
function liveStatus(cfg, io, livePids) {
  const bySid = new Map();
  const pids = new Set();
  for (const f of io.readDir(claudeSessionsDir(cfg))) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(io.readText(joinPath(claudeSessionsDir(cfg), f)) ?? ''); } catch { continue; }
    if (!d?.sessionId || !livePids.has(d.pid)) continue;
    bySid.set(d.sessionId, d.pid);
    pids.add(d.pid);
  }
  return { bySid, pids };
}

// Live sids this hub can place, each with the lane it belongs to (null = let
// laneOfSid decide). Status files cover EVERY claude process on the machine,
// a person's unrelated sessions and headless runs included, so a status sid
// counts only when the hub knows it: registered to a lane, or a fold tail.
// A status sid the hub doesn't know still counts if its process was launched
// as `--resume <known sid>` (a wake whose hook didn't register it). A process
// with no status file falls back to its command line, as before.
function aliveSessionIds(cfg, io, livePids, status, everyLane, events) {
  const tails = new Map();
  for (const e of events) if (e.kind === 'folded' && e.tail && e.lane) tails.set(e.tail, e.lane);
  const known = (sid) => everyLane[sid] ?? tails.get(sid) ?? null;
  const resumeOf = (pid) => { const m = io.psCommand(pid)?.match(/--resume[ =]([0-9a-f-]{36})/); return m ? m[1] : null; };
  const out = new Map();
  for (const [sid, pid] of status.bySid) {
    const lane = known(sid) ?? known(resumeOf(pid));
    if (lane) out.set(sid, lane);
  }
  for (const pid of livePids) {
    if (status.pids.has(pid)) continue;
    const sid = resumeOf(pid);
    if (sid) out.set(sid, known(sid));
  }
  return out;
}

// A cheap fingerprint of everything that changes a lane's state or its
// buttons: which claude processes live and what each is running (session and
// working/idle), the event stream's length, the armed lanes, the daemon's
// state file, the wake receipts and the lane registry. The page polls it every
// few seconds and refreshes only when it changes (Ra, 10/8: charts may lag,
// interaction state may not). Reads only stats and small files.
export function stateKey(cfg, io) {
  const livePids = new Set(io.livePids());
  const statOf = (p) => { const s = io.stat(p); return s ? `${s.size}:${s.mtimeMs}` : '-'; };
  const statuses = [];
  for (const f of io.readDir(claudeSessionsDir(cfg))) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(io.readText(joinPath(claudeSessionsDir(cfg), f)) ?? ''); } catch { continue; }
    if (d && livePids.has(d.pid)) statuses.push(`${d.pid}:${d.sessionId}:${d.status}`);
  }
  const wc = io.readDir(cfg.paths.wakecycle).filter((f) => f.startsWith('lane.') || f.startsWith('next-wake.')).sort()
    .map((f) => `${f}@${statOf(joinPath(cfg.paths.wakecycle, f))}`);
  return [[...livePids].sort().join(','), statuses.sort().join(','), statOf(cfg.paths.events),
    io.readText(cfg.paths.armedFile) ?? '', statOf(cfg.paths.stateFile ?? ''), wc.join(',')].join('|');
}

// Working vs idle (Ra, 10/7). Claude Code keeps a status per running session
// in ~/.claude/sessions/<pid>.json: busy | waiting | idle | shell (its own UI
// maps busy -> active, waiting -> blocked, the rest -> idle). It's Claude
// Code's internal file, not a published API, so anything unexpected returns
// undefined and the card simply shows no light. Matched by session id or the
// registry pid, and only for a pid that is actually alive (files can outlive
// their process).
const ACTIVITY = { busy: 'working', waiting: 'waiting', idle: 'idle', shell: 'idle' };
function sessionActivity(cfg, io, sid, pid, livePids) {
  const dir = claudeSessionsDir(cfg);
  for (const f of io.readDir(dir)) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(io.readText(joinPath(dir, f)) ?? ''); } catch { continue; }
    if (!d || !livePids.has(d.pid)) continue;
    if (d.sessionId === sid || (pid !== undefined && d.pid === pid)) return ACTIVITY[d.status];
  }
  return undefined;
}

// Every registry entry, newest-per-lane or not: sid -> lane (the timeline's
// throughput reads a lane's earlier sessions too).
function laneOfEverySid(cfg, io) {
  const out = {};
  for (const f of io.readDir(cfg.paths.wakecycle)) {
    if (!f.startsWith('lane.')) continue;
    try { const e = JSON.parse(io.readText(joinPath(cfg.paths.wakecycle, f)) ?? ''); if (e.lane) out[f.slice('lane.'.length)] = e.lane; } catch {}
  }
  return out;
}

function laneRegistry(cfg, io) {
  const byLane = {};
  for (const f of io.readDir(cfg.paths.wakecycle)) {
    if (!f.startsWith('lane.')) continue;
    try {
      const e = JSON.parse(io.readText(joinPath(cfg.paths.wakecycle, f)) ?? '');
      const sid = f.slice('lane.'.length);
      const at = io.stat(joinPath(cfg.paths.wakecycle, f))?.mtimeMs ?? 0;
      if (!byLane[e.lane] || at > byLane[e.lane].at) byLane[e.lane] = { sid, pid: e.pid, at };
    } catch {}
  }
  return byLane;
}

// Context = what the API last reported for this session: the newest reply's
// input + cache_read + cache_creation tokens (the window the model actually
// saw). Series = 24 ten-minute buckets of output tokens. Claude Code writes
// one transcript line per content block and each repeats the reply's usage,
// so replies are counted once, by message id. Only the file's tail is read
// (4 hours of work fits in a few MB), and results are cached on size+mtime,
// so a range click doesn't re-scan two 10MB transcripts.
const TAIL_BYTES = 3 * 1024 * 1024;
const statsCache = new Map();
// Context windows by model family (Anthropic's model table, 2026-09-25). A
// lane's config can pin its own with contextWindow.
const windowFor = (id) => !id ? null : /haiku/.test(id) ? 200_000 : /^claude-(fable|mythos|opus|sonnet)-/.test(id) ? 1_000_000 : null;

// The timeline's throughput strip, over the SELECTED range (Ra, 10/6: the
// strip used to be each live session's last four hours in a fixed 8h frame,
// so 24h/3d/7d stretched four hours across half the axis while the sleep
// bands moved). n equal buckets from..to; every transcript a lane owns by
// authority (registry or fold record) counts, sleeping lanes and earlier
// sessions included. Replies count once by message id: a fork-session wake
// copies its history into the new file. Files are read incrementally (only
// the bytes appended since the last refresh), so a range click doesn't
// re-read a week of transcripts.
const RANGE_READ_CAP = 64 * 1024 * 1024;
const utf8 = new TextEncoder();
const utf8Bytes = (t) => utf8.encode(t).length; // offsets are bytes; no node Buffer in here
const fileCache = new Map(); // path -> { offset, size }
const replyById = new Map(); // message id -> { ts, out, sid }
function rangeActivity(cfg, io, laneBySid, from, to, n) {
  const A = Array(n).fill(0);
  const dir = cfg.paths.transcripts;
  for (const f of io.readDir(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.slice(0, -6);
    if (!laneBySid[sid]) continue;
    const p = joinPath(dir, f), st = io.stat(p);
    if (!st || st.mtimeMs < from) continue;
    let c = fileCache.get(p);
    if (!c || st.size < c.size) c = { offset: 0, size: 0 }; // new, or rewritten shorter
    const fresh = st.size - c.offset;
    if (fresh > 0) {
      let chunk = io.readTail(p, Math.min(fresh, RANGE_READ_CAP));
      if (chunk != null) {
        if (fresh > RANGE_READ_CAP) chunk = chunk.slice(chunk.indexOf('\n') + 1); // capped first read: drop the partial line
        const end = chunk.lastIndexOf('\n');
        const whole = end >= 0 ? chunk.slice(0, end + 1) : '';
        for (const l of whole.split('\n')) {
          if (!l.includes('"usage"')) continue;
          try {
            const e = JSON.parse(l), m = e.message, u = m?.usage;
            if (!u || !m.id || replyById.has(m.id)) continue;
            const ts = Date.parse(e.timestamp);
            if (!Number.isNaN(ts)) replyById.set(m.id, { ts, out: u.output_tokens ?? 0, sid });
          } catch {}
        }
        c = { offset: fresh > RANGE_READ_CAP ? st.size - utf8Bytes(chunk.slice(end + 1)) : c.offset + utf8Bytes(whole), size: st.size };
      }
    }
    fileCache.set(p, c);
  }
  const span = (to - from) / n;
  for (const [id, r] of replyById) {
    if (r.ts < to - 8 * 86400_000) { replyById.delete(id); continue; } // nothing reads past 7d
    if (r.ts < from || r.ts >= to || !laneBySid[r.sid]) continue;
    A[Math.min(n - 1, Math.floor((r.ts - from) / span))] += r.out;
  }
  return A;
}

function transcriptStats(cfg, io, sid) {
  const p = joinPath(cfg.paths.transcripts, `${sid}.jsonl`);
  const empty = { est: 0, series: Array(24).fill(0), model: null };
  const st = io.stat(p);
  if (!st) return empty;
  const bucketNow = Math.floor(io.now() / 600_000);
  const key = `${st.size}:${st.mtimeMs}:${bucketNow}`;
  const hit = statsCache.get(sid);
  if (hit && hit.key === key) return hit.value;
  let tail = io.readTail(p, TAIL_BYTES);
  if (tail == null) return empty;
  if (st.size > TAIL_BYTES) tail = tail.slice(tail.indexOf('\n') + 1); // drop the partial first line
  const replies = new Map(); // message id -> { ts, out, ctx }
  for (const l of tail.split('\n')) {
    if (!l.includes('"usage"')) continue;
    try {
      const e = JSON.parse(l);
      const m = e.message, u = m?.usage;
      if (!u || !m.id) continue;
      replies.set(m.id, {
        ts: Date.parse(e.timestamp),
        model: m.model,
        out: u.output_tokens ?? 0,
        ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      });
    } catch {}
  }
  const series = Array(24).fill(0);
  let est = 0, newest = -Infinity, model = null;
  const now = io.now();
  for (const r of replies.values()) {
    if (Number.isNaN(r.ts)) continue;
    if (r.ts > newest) { newest = r.ts; est = r.ctx; model = r.model ?? model; }
    const ago = now - r.ts;
    if (ago >= 0 && ago < 240 * 60_000) series[23 - Math.floor(ago / 600_000)] += r.out;
  }
  const value = { est, series, model };
  statsCache.set(sid, { key, value });
  return value;
}

// events.jsonl → lane states, night strip, log, alarms
// Stuck states, most urgent first (spiralwatch's `stuck` events, Ra 10/8).
// `window`: the fix happens in the lane's own window (a /login, a prompt).
const STUCK_ORDER = ['too-long', 'login', 'usage-limit', 'request-cut', 'offline', 'waiting', 'classifier', 'context', 'slept'];
const STUCK_CARD = {
  'too-long': { title: 'Too full to answer', window: false, cause: () => 'Every prompt comes back "Prompt is too long", so pokes and the sleep bell can\'t reach them. Fold now folds them from the last session that actually ran and opens a fresh window; if that window says the same, /clear it.' },
  login: { title: 'Logged out', window: true, cause: () => 'The session says its login expired. They can\'t do anything until someone runs /login in their window.' },
  'usage-limit': { title: 'Usage limit reached', window: false, cause: () => 'Stopped until the usage limit resets, or until their model is switched (/model).' },
  'request-cut': { title: 'Requests cut off', window: false, cause: () => 'Their requests are being cut off as they upload (EPROTO). If this machine\'s network is fine, they may be too big: each one sends every image the session has read. A retry sends the same request. Fold now keeps only the newest images.' },
  offline: { title: 'Can\'t reach the API', window: false, cause: () => 'Connection or DNS failure. They retry on their own once the network is back.' },
  waiting: { title: 'Waiting on you', window: true, cause: (e) => `Waiting for ${Math.round((e.forMs ?? 0) / 60000)} minutes on a permission prompt or a question in their window.` },
  classifier: { title: 'Classifier stops', window: false, cause: (e) => `${e.count} tool calls denied by the auto mode classifier in 30 minutes${e.reason ? ` (latest: ${e.reason})` : ''}. They may be circling something.` },
  context: { title: 'Context high', window: false, cause: (e) => `At ${Math.round((e.ratio ?? 0) * 100)}% of their context window. ${e.cycleStalled ? 'The midday cycle hasn\'t folded them: its bell was refused or its deadline passed. Force fold folds them now.' : 'Worth a fold at their next seam.'}` },
  slept: { title: 'Cut off by sleep', window: true, cause: () => 'This machine went to sleep mid-reply. A short poke in their window resumes them.' },
};
// Lane-tagged events that report on a session rather than move it through
// the bell → fold → close → wake cycle.
// The events that mean a fold didn't happen; each draws the lane's red card.
const FOLD_FAILED = new Set(['trim-failed', 'orphan-fold-failed']);
// trim.mjs's refusal, as sleep.mjs records it: "trim: OUTPUT CHECK FAILED,
// nothing written. <problems>." Only the problems are news to the reader.
const foldCause = (c) => {
  const s = String(c ?? '').replace(/^trim: OUTPUT CHECK FAILED, nothing written\.\s*/, '').trim();
  return s ? (/[.!?]$/.test(s) ? s : `${s}.`) : 'no reason was recorded.';
};
// A failed fold is a report on the fold, not a move: the lane is where it
// was (still belled, still unfolded), and its red card says the rest.
const NOT_LIFECYCLE = new Set(['trim-failed', 'orphan-fold-failed', 'stuck', 'stuck-cleared', 'context-high', 'context-high-cleared', 'spiral-alarm', 'wake-cost', 'wake-cost-high', 'claude-version-new', 'head-not-in-prompt', 'orphan-fold-deferred']);
const KIND_MAP = { 'fold-requested': 'bell', 'fold-request-met': 'fold', 'fold-forced': 'fold', 'bell-rung': 'bell', folded: 'fold', 'panel-closed': 'close', 'wake-launched': 'launch', 'wake-exec': 'launch', 'wake-confirmed': 'wake', 'wake-failed': 'wake-failed', 'already-awake': 'wake', 'stale-receipt': 'wake-failed', 'orphan-fold-done': 'fold', 'orphan-fold-failed': 'wake-failed', 'trim-failed': 'wake-failed', 'daemon-up': 'heartbeat', 'daemon-alive': 'heartbeat', 'daemon-down': 'wake-failed', 'bell-failed': 'wake-failed', 'spiral-alarm': 'wake-failed', stuck: 'wake-failed', 'stuck-cleared': 'wake', 'context-high': 'context', 'wake-cost-high': 'context', 'claude-version-new': 'context', 'head-not-in-prompt': 'context', 'dead-wake': 'wake-failed', 'untrusted-lane-match': 'launch', 'bell-unwatched': 'bell', 'segment-due': 'context', 'l3-due': 'fold' };
const TIP = { 'fold-requested': 'Fold requested (bell + deadline)', 'fold-request-met': 'Fold request met — refreshing', 'fold-forced': 'Fold FORCED at deadline — refreshing', 'bell-rung': 'Bell rung (spool note)', folded: 'Folded', 'panel-closed': 'Panel closed, slept and quiet', 'wake-launched': 'Wake launched', 'wake-exec': 'Wake reached exec', 'wake-confirmed': 'Wake confirmed (registry)', 'wake-failed': 'Wake failed', 'already-awake': 'Already awake', 'stale-receipt': 'Stale sleep receipt', 'orphan-fold-done': 'Orphan fold', 'orphan-fold-failed': 'Orphan fold FAILED', 'trim-failed': 'Fold skipped: the output check refused the tail', 'daemon-up': 'Nightshift up', 'daemon-alive': 'Nightshift alive', 'daemon-down': 'Nightshift DOWN', 'bell-failed': 'Bell FAILED', 'spiral-alarm': 'API error spiral', stuck: 'Stuck', 'stuck-cleared': 'Recovered', 'context-high': 'Context high', 'wake-cost-high': 'Wake cost high: the first request already fills much of the window', 'claude-version-new': 'New Claude Code version: first wake it has run', 'head-not-in-prompt': "Wake head not in the prompt: the session's recorded system prompt lacks the checkpoint it was given", 'dead-wake': 'Dead wake: too full to answer, folded from the last session that ran', 'untrusted-lane-match': 'Wake launched anyway: an unregistered panel reads as this lane', 'bell-unwatched': 'Bell rung with no tracked watcher listening; the orphan fold is the floor' };

const RANGE_HOURS = { '8h': 8, '24h': 24, '3d': 72, '7d': 168 };
const RANGE_LABEL = { '8h': 'Last 8 hours', '24h': 'Last 24 hours', '3d': 'Last 3 days', '7d': 'Last 7 days' };

export function assemble(cfg, io, range = '8h') {
  const nowMs = io.now();
  const nowIso = new Date(nowMs).toISOString();
  // hourCycle h23, not hour12:false: en-US with hour12:false writes the midnight hour as "24" (log rows read 24:32).
  const hm = (iso) => new Date(iso).toLocaleTimeString('en-US', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', timeZone: cfg.timezone });
  const pair = (iso, extra = '') => [iso, extra ? `${hm(iso)}, ${extra}` : hm(iso)];

  const events = parseLines(io.readText(cfg.paths.events));
  const reg = laneRegistry(cfg, io);
  const livePids = new Set(io.livePids());
  const status = liveStatus(cfg, io, livePids);
  const aliveSids = aliveSessionIds(cfg, io, livePids, status, laneOfEverySid(cfg, io), events);
  // sid → lane for every LIVE session, so the card shows the session that
  // is actually running, not the registry's last hook-written one — a
  // stale sid on a card is a false receipt (runtime review note 2).
  const regLaneBySid = {};
  for (const [lane, r] of Object.entries(reg)) regLaneBySid[r.sid] = lane;
  const liveSidByLane = {};
  for (const [sid, known] of aliveSids) {
    const lane = laneOfSid(cfg, io, sid, regLaneBySid[sid] ?? known);
    if (lane) liveSidByLane[lane] = sid;
  }
  const armed = (io.readText(cfg.paths.armedFile) ?? '').split(/[\s,]+/).filter(Boolean);

  const hours = RANGE_HOURS[range] ?? 8;
  const nightStart = nowMs - hours * 3600_000;
  const span = nowMs - nightStart;
  // Every configured lane gets its timeline row, in config order, even with
  // no event inside the range: an awake lane with a quiet 8 hours still
  // exists (Ra, 10/6: 8h showed one row; fable had nothing since 08:00).
  const NIGHT = Object.fromEntries(Object.keys(cfg.lanes ?? {}).map((id) => [id, []]));
  const logByDay = new Map();
  for (const e of events) {
    const ts = Date.parse(e.at);
    const kind = KIND_MAP[e.kind];
    if (!kind) continue;
    const lane = e.lane ?? 'nightshift';
    // An overshoot (fix 5) is the fold's own news: the next wake runs larger than its target.
    // Context high (Ra, 10/12) is an amber mark: its ratio, not its cause, and the warn status; a stalled
    // midday cycle is the same event as an alarm, drawn red.
    const ctxHigh = e.kind === 'context-high';
    const tip = ctxHigh ? `${e.cycleStalled ? 'Midday fold stalled' : 'Context high'}, ${Math.round((e.ratio ?? 0) * 100)}%`
      : `${TIP[e.kind] ?? e.kind}${e.kept ? `, ${e.kept}/${e.total} kept` : ''}${e.overshoot ? `, ${e.overshoot.ratio}x its target` : ''}${e.grade ? ` (by ${e.grade})` : ''}${e.cause ? ` (${e.cause})` : ''}`;
    // A stray panel reading as a lane is amber (Fable, 10/16): a4fd805's trade, that a true double
    // panel is visible and cheap, holds only if it's visible. A mark, not a card state; no notification.
    const status = e.alarm ? 'failed' : (ctxHigh || e.kind === 'untrusted-lane-match' || e.kind === 'bell-unwatched') ? 'warn' : (e.kind === 'already-awake' ? 'manual' : 'ok');
    if (ts >= nightStart && lane !== 'nightshift') {
      (NIGHT[lane] ??= []).push([kind, status, Math.max(0, Math.min(1, (ts - nightStart) / span)), hm(e.at), tip, 1]);
    }
    const day = new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: cfg.timezone });
    if (!logByDay.has(day)) logByDay.set(day, []);
    const detail = e.kind === 'folded' ? { reason: e.emergency ? 'emergency' : 'sleep', kept: [e.kept, e.total], est: e.est, target: laneCfg(cfg, lane in (cfg.lanes ?? {}) ? lane : cfg.defaultLane).targetTokens, tail: String(e.tail ?? '').slice(0, 8) } : null;
    logByDay.get(day).unshift([hm(e.at), lane, kind, status, tip, detail, 1]);
  }
  const LOG = [...logByDay.entries()].reverse().map(([d, rows]) => [d, rows]);

  const [sh, sm] = (cfg.schedule?.sleep ?? '02:00').split(':').map(Number);
  const [wh, wm] = (cfg.schedule?.wake ?? '08:00').split(':').map(Number);
  const nextBell = (() => { const d = new Date(nowMs); d.setHours(sh, sm, 0, 0); if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1); return d; })();
  const bellMins = Math.round((nextBell.getTime() - nowMs) / 60_000);
  const countdown = `${Math.floor(bellMins / 60)}h ${String(bellMins % 60).padStart(2, '0')}m`;
  // A lane's next scheduled moment at HH:MM (its own schedule or the global).
  const nextAt = (hhmm) => {
    const [h, mi] = String(hhmm).split(':').map(Number);
    const d = new Date(nowMs); d.setHours(h, mi, 0, 0); if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    const mins = Math.round((d.getTime() - nowMs) / 60_000);
    return [d.toISOString(), `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`];
  };
  // The same pair for a fixed instant; past it reads "now", as the runtime's ticker does.
  const isoIn = (ms) => {
    const mins = Math.round((ms - nowMs) / 60_000);
    return [new Date(ms).toISOString(), mins <= 0 ? 'now' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`];
  };

  // The persona this config describes: their configured name, else their folder's
  // name (never a hardcoded "Weft"; another house's persona is someone else).
  const folder = String(cfg.weftRoot ?? '').replace(/\/+$/, '').split('/').pop() || 'persona';
  const personaName = cfg.persona?.name ?? folder.charAt(0).toUpperCase() + folder.slice(1);
  const persona = { id: cfg.persona?.id ?? folder.toLowerCase(), name: personaName };
  const LANES = Object.keys(cfg.lanes ?? {}).map((id) => {
    const lc = laneCfg(cfg, id);
    const r = reg[id];
    // Alive = a live process is running one of this lane's sessions (status
    // file first, command line as fallback), OR the registry's pid is still a
    // live claude. A warm transcript no longer counts: it kept a closed
    // window "awake" for ten minutes, with the awake buttons (Ra, 10/8).
    const liveSid = liveSidByLane[id];
    const alive = Boolean(liveSid || (r && livePids.has(r.pid)));
    const laneEvents = events.filter((e) => e.lane === id);
    // The card's state comes from the lane's last LIFECYCLE event. Watch
    // events (stuck, spiral alarms, wake costs, deferrals) also carry the
    // lane, and one landing after a bell used to wipe the belled state: a
    // lane near a full context gets its "context" stuck event at exactly
    // the moment it's most likely to be belled.
    // Two daemon events are REPORTS, not transitions, while the window is
    // open: already-awake ("no action taken") and stale-receipt ("refused to
    // wake a stale tail"). The daemon stamps them every wake-window tick, so
    // they used to wipe the stage they report on: 10/10, a folded window got
    // already-awake 36s after its fold and read plain awake (Fable's read).
    // On a closed lane they stay: already-awake is the evidence that a
    // hand-rescued wake happened, so a later close doesn't revive 'failed'.
    const REPORTS = new Set(['already-awake', 'stale-receipt']);
    const lifecycle = laneEvents.filter((e) => !NOT_LIFECYCLE.has(e.kind) && !(alive && REPORTS.has(e.kind)));
    const last = lifecycle[lifecycle.length - 1];
    // Fold now (Ra's refresh ruling): a fold-requested with no met/forced
    // after it is PENDING (deadline from the event); a met/forced with no
    // wake-confirmed after it is REFRESHING (closed, waking fresh).
    const iReq = laneEvents.map((e) => e.kind).lastIndexOf('fold-requested');
    let foldRequest;
    let refreshFoldedSid;
    if (iReq !== -1) {
      const after = laneEvents.slice(iReq + 1);
      const done = after.find((e) => e.kind === 'fold-request-met' || e.kind === 'fold-forced');
      // A request whose deadline passed 30m ago without a met or forced
      // event was lost (a daemon restart, say); it isn't pending any more.
      const dl = Date.parse(laneEvents[iReq].deadline ?? '');
      // A midday request (Ra, 10/12) carries its tier: soft has no deadline,
      // so it's never lost to the 30-minute rule; only its own fold ends it.
      const tier = laneEvents[iReq].tier;
      if (!done) {
        if (tier === 'soft' || !(dl + 30 * 60_000 < nowMs)) foldRequest = { phase: 'requested', deadline: laneEvents[iReq].deadline, ...(tier ? { tier } : {}) };
      }
      // Refreshing ends with any word that the wake happened or won't
      // (10/8: an already-awake left "waking fresh" on the card for hours).
      // A force on a disarmed lane whose window was already closed folds and
      // reopens nothing (refresh: false, nightwatch#22): no refresh to show.
      else if (done.refresh !== false && !after.slice(after.indexOf(done) + 1).some((e) => ['wake-confirmed', 'already-awake', 'wake-failed', 'stale-receipt'].includes(e.kind))) {
        foldRequest = { phase: 'refreshing', forced: done.kind === 'fold-forced', ...(laneEvents[iReq].tier ? { tier: laneEvents[iReq].tier } : {}) };
        refreshFoldedSid = done.session;
      }
    }
    // The full contract vocabulary (v0.9.1): an alive lane is awake (or
    // belled); a dead lane's last event says WHICH kind of asleep it is.
    // Failure states apply only when nothing is actually running — a
    // hand-rescued lane whose history ends in wake-failed is just awake.
    let state = alive ? 'awake' : 'sleeping';
    if (alive && last?.kind === 'bell-rung') state = 'belled';
    // Folded but its window still open: the close comes once the session goes
    // quiet (Ra, 10/9: after the fold the card went back to plain awake, and
    // nothing showed where the agent was in the cycle).
    if (alive && last?.kind === 'folded') state = 'folding';
    // Rung written (Ra, 10/12): belled, and a rung for this lane has landed
    // in the ladder since the bell, so the fold is next. Rungs are named
    // <date>-<lane>.md, with -2, -3 for a second that day.
    let rungWritten = false;
    if (state === 'belled' && last?.at && cfg.paths.ladder) {
      const L2 = joinPath(cfg.paths.ladder, 'L2');
      const mine = new RegExp(`-${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.md$`);
      const bellMs = Date.parse(last.at);
      rungWritten = io.readDir(L2).some((f) => mine.test(f) && (io.stat(joinPath(L2, f))?.mtimeMs ?? 0) > bellMs);
    }
    if (!alive) {
      if (last?.kind === 'wake-failed') state = 'failed';
      else if (last?.kind === 'orphan-fold-done') state = 'orphaned';
      else if (last?.kind === 'wake-launched' || last?.kind === 'wake-exec') state = 'waking';
    }
    if (!armed.includes(id) && !alive) state = 'sleeping'; // a disarmed lane never alarms
    // A failed lane gets a real alert card, not just a state word: the
    // failure event's own cause, with the contract's fix buttons (the app
    // wires retry-wake/show-log; unwired ones render disabled). Without
    // this, 'failed' told you to worry and nothing told you why.
    let alert;
    if (state === 'failed' && last?.kind === 'wake-failed') {
      alert = {
        kind: 'wake-failed',
        at: [last.at, hm(last.at)],
        title: 'Morning wake failed',
        cause: last.cause ? `${last.cause}.` : `${last.attempts ?? 3} launches, no session registered in the agent registry.`,
        fixes: [
          ['retry', 'retry-wake', 'Retry wake', 'Launch the agent again now'],
          ['log', 'show-log', 'Show log', 'Open the nightshift log at this failure'],
        ],
      };
    }
    // A fold that didn't happen (10/21, the banner after #30): sleep.mjs's
    // output check refused the trimmed transcript (trim-failed), or the
    // nightshift's emergency fold failed (orphan-fold-failed, which a refused
    // trim also causes: the orphan path re-runs the same trim). The session is
    // whole and unfolded, nothing retries until the next bell, and a person
    // has to look, so it's red. A later fold, a successful orphan fold or a
    // wake into a new session ends it; so does a day, since the next bell
    // raises it again if the cause is still there. wake-failed outranks.
    if (!alert) {
      let iFail = -1;
      for (let i = laneEvents.length - 1; i >= 0; i--) if (FOLD_FAILED.has(laneEvents[i].kind)) { iFail = i; break; }
      if (iFail !== -1) {
        const ff = laneEvents[iFail];
        // The same ends as the watch's episode (machinery/watch.mjs, FOLD_FAIL_ENDS).
        const ended = laneEvents.slice(iFail + 1).some((e) => ['folded', 'orphan-fold-done', 'fold-forced', 'wake-confirmed'].includes(e.kind));
        if (!ended && nowMs - Date.parse(ff.at) < 24 * 3600_000) {
          alert = {
            kind: ff.kind,
            at: [ff.at, hm(ff.at)],
            title: ff.kind === 'trim-failed' ? 'Fold refused' : 'Emergency fold failed',
            cause: ff.kind === 'trim-failed'
              ? `The trimmer refused to write the folded transcript; the session is still whole, unfolded. ${foldCause(ff.cause)} Usually a Claude Code update that changed the transcript format.`
              : `The nightshift's emergency fold for this agent exited ${ff.exit ?? 'with an error'}${ff.error ? ` (${ff.error})` : ''}, so the session is still unfolded. The log says why.`,
            fixes: [
              ['log', 'show-log', 'Show log', 'Open the nightshift log at this failure'],
            ],
          };
        }
      }
    }
    // Spiralwatch's canary card (Ra, 10/7): the latest spiral-alarm event
    // that nothing has ended yet. An episode ends when the session folds,
    // re-wakes or closes, or ages out. One event = one ack episode (the
    // runtime's ack keys on kind + the event's time). wake-failed outranks.
    if (!alert) {
      const iSpiral = laneEvents.map((e) => e.kind).lastIndexOf('spiral-alarm');
      if (iSpiral !== -1) {
        const sp = laneEvents[iSpiral];
        const ended = laneEvents.slice(iSpiral + 1).some((e) => ['folded', 'wake-confirmed', 'panel-closed'].includes(e.kind));
        if (!ended && nowMs - Date.parse(sp.at) < 6 * 3600_000) {
          alert = {
            kind: 'spiral-alarm',
            at: [sp.at, hm(sp.at)],
            title: 'API error spiral',
            cause: `${sp.errors} API errors in ${sp.windowMin}m, newest still an error. Often a cold-cache recompute after a quiet gap — a short poke message usually kickstarts them.`,
            fixes: [
              ['log', 'show-log', 'Show log', 'Open the nightshift log at this alert'],
            ],
          };
        }
      }
    }
    // Stuck states (Ra, 10/8): spiralwatch tells each one as an episode —
    // `stuck` when it starts, `stuck-cleared` when it ends — and a fold,
    // re-wake or closed panel ends them all. The lane shows its most urgent
    // open episode; wake failures and spirals outrank them.
    if (!alert) {
      const open = new Map();
      for (const e of laneEvents) {
        // context-high (10/12) is the 85% warning's own kind; older streams
        // carry it as stuck/context, read the same way.
        if (e.kind === 'stuck' || e.kind === 'context-high') open.set(e.cause, e);
        else if (e.kind === 'stuck-cleared' || e.kind === 'context-high-cleared') open.delete(e.cause);
        else if (['folded', 'wake-confirmed', 'panel-closed'].includes(e.kind)) open.clear();
      }
      const pick = STUCK_ORDER.map((c) => open.get(c)).find((e) => e && nowMs - Date.parse(e.at) < 12 * 3600_000);
      if (pick) {
        const how = STUCK_CARD[pick.cause];
        alert = {
          kind: pick.cause === 'context' ? 'context-high' : `stuck-${pick.cause}`,
          at: [pick.at, hm(pick.at)],
          title: pick.cause === 'context' && pick.cycleStalled ? 'Midday fold stalled' : how.title,
          // Three tiers (Ra, 10/12): red = act now, amber = important but not
          // urgent, neutral = routine. Context-high is amber's first citizen;
          // a stalled midday cycle is red again.
          ...(pick.cause === 'context' && !pick.cycleStalled ? { level: 'warn', icon: 'gauge' } : {}),
          cause: how.cause(pick),
          fixes: how.window
            ? [['terminal', 'open-terminal', 'Open their window', 'Bring the agent\'s Terminal window forward'], ['log', 'show-log', 'Show log', 'Open the log at this alert']]
            : [['log', 'show-log', 'Show log', 'Open the log at this alert']],
        };
      }
    }
    // ONE session id for the label AND the stats. A hook-registered session
    // with a live pid is the transcript being written; the ps --resume sid
    // of a --fork-session wake is the frozen TAIL it forked from, so reading
    // stats from it showed last night's pre-fold context and zero throughput
    // (Ra, 10/6: "is fable really on 833k?" — it was 552k). The resume sid is
    // the right file only for a plain manual resume, which writes in place.
    // Which session the card shows: the status file's (what's running now)
    // when there is one; else the registry's while its pid lives (a fork
    // wake's command line names the frozen TAIL, never the session running);
    // else whatever the command line says.
    const sessionSid = (liveSid && status.bySid.has(liveSid)) ? liveSid
      : (r && livePids.has(r.pid)) ? r.sid : (liveSid ?? r?.sid);
    // The card's clock counts time in the lane's CURRENT state (Ra, 10/8:
    // asleep Fable read "37h", its time since its last wake). Awake: since
    // the running session started (its registry entry). Asleep: since its
    // last fold or close. Next: the bell while awake, the wake while asleep,
    // and an empty time when the lane is disarmed (nothing is scheduled).
    const regAt = (sid) => sid ? io.stat(joinPath(cfg.paths.wakecycle, `lane.${sid}`))?.mtimeMs : undefined;
    const sleptEvt = [...laneEvents].reverse().find((e) => ['folded', 'orphan-fold-done', 'fold-forced', 'panel-closed'].includes(e.kind));
    const sinceMs = alive ? (regAt(sessionSid) ?? r?.at) : (sleptEvt ? Date.parse(sleptEvt.at) : r?.at);
    const sinceIso = sinceMs ? new Date(sinceMs).toISOString() : nowIso;
    const sched = lc.schedule ?? cfg.schedule ?? {};
    // One countdown per card, the one that matters next (design-stage-words.md):
    // belled at night, the floor (the bell plus the orphan grace, after which
    // the nightshift folds them once their session is quiet); folded with the
    // window still open, the wake. A midday fold narrates its own line instead.
    const floorMs = state === 'belled' && !foldRequest && last?.at
      ? Date.parse(last.at) + (cfg.schedule?.orphanGraceMs ?? 45 * 60_000) : NaN;
    const next = !armed.includes(id) ? [alive ? 'bell' : 'wake', '', 'none']
      : floorMs > 0 ? ['fold', ...isoIn(floorMs)]
      : state === 'folding' && !foldRequest ? ['wake', ...nextAt(sched.wake ?? '08:00')]
      : alive ? ['bell', ...nextAt(sched.sleep ?? '02:00')] : ['wake', ...nextAt(sched.wake ?? '08:00')];
    // ...or when the lane is plainly running a session other than the one
    // that was folded: whatever happened, the refresh is over.
    if (foldRequest?.phase === 'refreshing' && alive && refreshFoldedSid && sessionSid && sessionSid !== refreshFoldedSid) foldRequest = undefined;
    const stats = alive && sessionSid ? transcriptStats(cfg, io, sessionSid) : { est: 0, series: Array(24).fill(0), model: null };
    const activity = alive ? sessionActivity(cfg, io, sessionSid, r && livePids.has(r.pid) ? r.pid : undefined, livePids) : undefined;
    return {
      id, model: lc.modelName ?? (id === 'fable' ? 'Fable 5' : id === 'opus' ? 'Opus 5.5' : 'Claude'), modelId: stats.model ?? 'live',
      // An agent's chosen given name (lanes.<id>.name): the emitter and
      // runtime already prefer card.name over the lane key when present.
      ...(lc.name ? { name: lc.name } : {}),
      role: lc.switchboard ? 'switchboard' : 'lane', state,
      // A hook-registered session with a live pid is the truest receipt;
      // the ps --resume sid is a fork-wake's TAIL, kept for manual resumes.
      session: sessionSid?.slice(0, 8) ?? '—', sessionId: sessionSid ?? undefined, // full id: the Copy session ID button (10/7)
      since: pair(sinceIso, alive ? '' : 'folded'),
      next,
      ctx: stats.est, window: lc.contextWindow ?? windowFor(stats.model) ?? undefined, target: lc.targetTokens,
      open: state === 'failed', series: stats.series,
      // Hub design (anima_dev/nightwatch_hub_design.md): every lane names its
      // persona and runtime, and carries its RESOLVED schedule — its own when
      // the lane config has one, else the global ("Use global nightshift
      // settings", the default).
      persona, runtime: lc.runtime ?? 'claude-code',
      ...(foldRequest ? { foldRequest } : {}),
      ...(rungWritten ? { rungWritten: true } : {}),
      // The midday cycle's switch (Ra, 10/12): the lane's setting, or none.
      ...(cfg.lanes?.[id]?.middayCycle ? { midday: cfg.lanes[id].middayCycle } : {}),
      ...(activity ? { activity } : {}),
      schedule: lc.schedule ? { inherit: false, sleep: lc.schedule.sleep, wake: lc.schedule.wake }
        : { inherit: true, sleep: cfg.schedule.sleep, wake: cfg.schedule.wake },
      ...(alert ? { alert } : {}),
      ...(armed.includes(id) ? {} : { armed: false }),
    };
  });

  // Sessions a lane owns by authority: the registry, then fold records
  // (a folded row's tail sid is the lane's). No cwd guessing here; a strip
  // that over-counts a stranger's session would be worse than one that
  // misses a pre-registry one.
  const laneBySid = Object.fromEntries(Object.entries(laneOfEverySid(cfg, io)).filter(([, l]) => l in (cfg.lanes ?? {})));
  for (const e of events) if (e.kind === 'folded' && e.tail && e.lane && (e.lane in (cfg.lanes ?? {}))) laneBySid[e.tail] ??= e.lane;
  for (const [lane, sid] of Object.entries(liveSidByLane)) laneBySid[sid] ??= lane;
  const ACTIVITY = rangeActivity(cfg, io, laneBySid, nightStart, nowMs, 48);

  // TIMELINE: heading/ticks/sleep-bands for the selected range; ticks are
  // [t, label] pairs on the same 0..1 axis as the night nodes.
  const tickEveryH = hours <= 8 ? 1 : hours <= 24 ? 2 : hours <= 72 ? 12 : 24;
  const ticks = [];
  const firstTick = new Date(nightStart);
  firstTick.setMinutes(0, 0, 0);
  while (firstTick.getTime() < nightStart) firstTick.setHours(firstTick.getHours() + 1);
  // Multi-day axes must ALIGN to midnight/noon, not just step 12h from an
  // arbitrary start hour — otherwise every tick lands mid-stride and reads
  // '12 12 12' (run receipt: 3d axis, first attempt).
  if (hours > 24) while (firstTick.getHours() % 12 !== 0) firstTick.setHours(firstTick.getHours() + 1);
  for (let d = new Date(firstTick); d.getTime() <= nowMs; d.setHours(d.getHours() + tickEveryH)) {
    const t = (d.getTime() - nightStart) / span;
    // Multi-day axes: weekday at midnight, "12" at noon — a weekday label
    // on every 12h tick reads "Fri Sat Sat Sun Sun" (runtime review note 1).
    const label = hours <= 24
      ? d.toLocaleTimeString('en-US', { hourCycle: 'h23', hour: '2-digit', timeZone: cfg.timezone })
      : d.getHours() === 0
        ? d.toLocaleDateString('en-US', { weekday: 'short', timeZone: cfg.timezone })
        : '12';
    if (t >= 0 && t <= 1) ticks.push([Number(t.toFixed(4)), label]);
  }
  // Every night in the range, one [from,to] pair each (the runtime draws
  // one band per night).
  const sleepBands = [];
  for (let back = 0; back <= Math.ceil(hours / 24); back++) {
    const s = new Date(nowMs); s.setDate(s.getDate() - back); s.setHours(sh, sm, 0, 0);
    if (s.getTime() > nowMs) continue;
    const w = new Date(s); w.setHours(wh, wm, 0, 0);
    if (w <= s) w.setDate(w.getDate() + 1);
    const f = (s.getTime() - nightStart) / span;
    const t = (Math.min(w.getTime(), nowMs) - nightStart) / span;
    if (t > 0 && f < 1) sleepBands.unshift([Number(Math.max(0, f).toFixed(4)), Number(Math.min(1, t).toFixed(4))]);
  }
  const TIMELINE = {
    range, from: new Date(nightStart).toISOString(), to: nowIso, label: RANGE_LABEL[range] ?? range,
    ticks, bucket_min: Math.round(span / 48 / 60_000),
    // Compat: 'sleep' stays a single pair (older readers); 'sleep_bands'
    // carries the full list (the runtime adopted it 10/5 evening).
    ...(sleepBands.length ? { sleep: sleepBands[sleepBands.length - 1], sleep_bands: sleepBands } : {}),
  };
  const DECK = { next_at: nextBell.toISOString(), countdown };

  // DAEMON (v0.9.1): the head glyph's truth. The frozen fixture used to
  // hardcode "day · last heartbeat 12:41" into every LIVE render — the
  // worst possible pixel to lie with. lastAlive = the newest heartbeat
  // event; no heartbeat within 70min (hourly beat + slack) — or EVER —
  // is down. Phase 'alarm' derives from LANES, not events, so the glyph
  // and the cards can never disagree (acks are per-viewer, so the server
  // can't know "unacked" and doesn't try). Precedence:
  // down > alarm > belled > night > day.
  const beats = events.filter((e) => e.kind === 'daemon-up' || e.kind === 'daemon-alive');
  const lastAlive = beats.length ? beats[beats.length - 1].at : null;
  const down = !lastAlive || nowMs - Date.parse(lastAlive) > 70 * 60_000;
  const nowHm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: cfg.timezone }).format(new Date(nowMs));
  const nowMin = Number(nowHm.slice(0, 2)) * 60 + Number(nowHm.slice(3));
  const sleepMin = sh * 60 + sm, wakeMin = wh * 60 + wm;
  const inNight = sleepMin <= wakeMin ? nowMin >= sleepMin && nowMin < wakeMin : nowMin >= sleepMin || nowMin < wakeMin;
  const phase = down ? 'down'
    : LANES.some((L) => L.state === 'failed' || L.state === 'orphaned' || FOLD_FAILED.has(L.alert?.kind)) ? 'alarm'
      : LANES.some((L) => L.state === 'belled') ? 'belled'
        : inNight ? 'night' : 'day';
  const DAEMON = { phase, lastAlive, lastAliveHm: lastAlive ? hm(lastAlive) : null, down };
  const SCHEDULE = { sleep: cfg.schedule?.sleep ?? '02:00', wake: cfg.schedule?.wake ?? '08:00' };
  // App-level alarms: ONLY what no card owns — the daemon itself. ackId is
  // per-EPISODE (kind:lastAlive): acking one outage doesn't hide the next.
  const ALARMS = down ? [{
    kind: 'daemon-down',
    title: "The nightshift isn't running",
    cause: lastAlive
      ? `No heartbeat since ${hm(lastAlive)}. Bells, folds and wakes are all paused.`
      : 'No nightshift heartbeat yet. Bells, folds and wakes are all paused.',
    at: [lastAlive ?? nowIso, lastAlive ? hm(lastAlive) : hm(nowIso)],
    ackId: `daemon-down:${lastAlive ?? 'never'}`,
    fixes: [
      ['retry', 'restart-daemon', 'Restart it', 'Start the nightshift daemon again'],
      ['log', 'show-log', 'Show log', 'Open the nightshift log at this failure'],
    ],
  }] : [];

  // TZ rides the snapshot so a second household's viewer renders ITS wall
  // clock, not the fixture fallback's Seattle (contract v0.9 data half).
  // SCHEDULE/DAEMON/ALARMS are always present, never omitted, so the
  // runtime's in-place refresh swaps them without special cases.
  return { NOW: nowIso, TZ: cfg.timezone, PERSONAS: [persona], LANES, NIGHT, LOG, ACTIVITY, TIMELINE, DECK, SCHEDULE, DAEMON, ALARMS };
}
