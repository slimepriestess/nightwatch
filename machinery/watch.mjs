#!/usr/bin/env node
/**
 * The stuck/spiral watch: notices when an agent this hub runs is stuck, and
 * says so. Notify-only by design: it never folds, kills, pokes or writes to a
 * session. Its own daemon per hub (launchd label house.nightwatch.<slug>.watch),
 * apart from nightshift, so a fault here can never touch the bell or the wake.
 *
 * What counts (every signature is a real transcript's, surveyed 10/8 across
 * 323 transcripts on Weft's machine):
 *   spiral      two or more API-error lines inside watch.spiralWindowMs with
 *               the newest still an error. Each line is a turn that already
 *               used up Claude Code's ~10 automatic retries, so two is ~20
 *               failures (Ra's calibration, 9/30). Most bursts are cold-cache
 *               recomputes after a quiet gap, which one short message usually
 *               clears.
 *   too-long    "Prompt is too long": the session can't take any prompt, so
 *               messages and the sleep bell can't reach it.
 *   login       the login expired ("OAuth session expired", "Please run /login").
 *   usage-limit the account's usage limit.
 *   request-cut "Unable to connect to API (EPROTO)": requests cut off mid-upload, as images past
 *               about 4-5 MB did on 10/25. A retry won't help, and it isn't the network.
 *   offline     "Unable to connect to API" / "Can't reach the API server".
 *   slept       "Your computer went to sleep mid-response".
 *   classifier  watch.classifierThreshold auto-mode classifier denials inside
 *               watch.classifierWindowMs.
 *   context     the newest reply's input side at watch.contextWarn of the
 *               model's window (re-arms below watch.contextRearm).
 *   waiting     the session's status file says 'waiting' (a permission prompt
 *               or a question) for watch.waitingMs.
 *
 * Which sessions: Claude Code's live status files (paths.sessions), kept to
 * the ones THIS hub's registry knows (wakecycle/lane.<sessionId>), and not
 * already folded. A session stuck on a prompt or a usage limit stops writing
 * its transcript, so status files, not transcript age, say what's alive.
 *
 * Where an alert goes: always the hub's event stream (the app's alert cards:
 * kinds spiral-alarm, stuck, stuck-cleared), then the notifier (config
 * notify.*): a macOS Notification Center banner, and/or notify.command, an
 * executable run with the message on stdin and NIGHTWATCH_ALERT_* in its
 * environment. Each stuck state is an episode: one alert when it starts, one
 * stuck-cleared event when it ends while the session lives. Episodes persist
 * (paths.watchState), so a restart doesn't re-announce anything.
 *
 * Wake cost (incident fix 4, 10/9): for each recent fold, the watch finds the
 * session woken from its tail (a session this hub registered after the fold
 * whose transcript carries the tail's entries, whichever path woke it) and
 * records that session's first real request beside the fold's estimate: one
 * row in paths.wakeCosts and one `wake-cost` event, fields {at, lane, tail,
 * session, source, estTokens, firstRequestTokens}. Every night then measures
 * the trimmer's estimate against what the harness actually sent. A first
 * request at or past watch.wakeCostWarn of the lane's window (default 0.5; 0
 * turns it off) also emits one amber `wake-cost-high` event, never a banner.
 * The row also carries `headMatch`/`headRef` where the woken session's recorded
 * system prompt could be compared with the head (see headWitness), `headFresh`/`headDisc`
 * for the lines that were not already in the previous wake's prompt (the only ones that
 * tell fresh from stale), and an amber `head-not-in-prompt` event when `headFresh` is
 * under watch.headMatchWarn. The row also carries `version`, the Claude Code version that woke (from the
 * reply's own `version`); the first wake by a version no earlier row has seen
 * emits one amber `claude-version-new` event.
 *
 * Run: NIGHTWATCH_CONFIG=<hub config> node watch.mjs [--once]
 *
 * Written by: claude-opus-5-5, 2026-10-09, from weft's watch-spiral.mjs
 * (claude-fable-5 and claude-opus-5-5, 9/30–10/8). Left behind on purpose: the
 * fill bell (transcript bytes as a fill gauge, which the context cause now
 * measures from real usage, and a headless relay pass the house retired) and
 * the cwd-based lane guess (the registry is the only attribution).
 */
import { readFileSync, readdirSync, statSync, appendFileSync, writeFileSync, renameSync, mkdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { notifyBanner } from './platform.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextOfEntries, envWithConfig, loadConfig, loadConfigFrom, windowForLane } from './config.mjs';

const CFG = loadConfig();
const W = CFG.watch;
const P = CFG.paths;
const ONCE = process.argv.includes('--once');
const TAIL_BYTES = 2 * 1024 * 1024;
const TAIL_LINES = 400;

function log(line) {
  const out = `${new Date().toISOString()} ${line}`;
  console.log(out);
  try { appendFileSync(P.watchLog, out + '\n'); } catch {}
}

function emit(event) {
  try { appendFileSync(P.events, JSON.stringify(event) + '\n'); } catch (e) { log(`event write failed: ${e.message}`); }
}

// ── who an alert is about ────────────────────────────────────────────────
// Words for people: "agent", never "lane", and no pronouns the agent didn't
// choose (Ra, 10/8). A named persona with several agents reads "Weft (opus)";
// a single-agent hub reads just its name.
function agentLabel(lane) {
  const name = CFG.persona?.name;
  // An agent's chosen given name (lanes.<id>.name) outranks the lane key,
  // which stays plumbing (spool paths, registry, fold rows).
  const shown = CFG.lanes?.[lane]?.name ?? lane;
  const several = Object.keys(CFG.lanes ?? {}).length > 1;
  if (name) return several ? `${name} (${shown})` : name;
  return `the ${shown} agent`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ── notifier ─────────────────────────────────────────────────────────────
const pending = [];

function notify(alert) {
  // notify.macos keeps its name for existing configs; it means "native
  // banner on this platform" (platform.mjs picks the mechanism per OS).
  if (CFG.notify?.macos) {
    for (const child of notifyBanner({ title: alert.title, text: alert.text })) {
      child.on('error', (e) => log(`banner failed: ${e.message}`));
    }
  }
  const cmd = CFG.notify?.command;
  if (!cmd) return;
  pending.push(new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          NIGHTWATCH_ALERT_KIND: alert.kind, NIGHTWATCH_ALERT_CAUSE: alert.cause ?? '',
          NIGHTWATCH_ALERT_LANE: alert.lane, NIGHTWATCH_ALERT_SESSION: alert.session ?? '',
          NIGHTWATCH_ALERT_TITLE: alert.title, NIGHTWATCH_PERSONA: CFG.persona?.name ?? '',
        },
      });
    } catch (e) { log(`notify command failed to start: ${e.message}`); return resolve(); }
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 30_000);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); log(`notify command failed: ${e.message}`); resolve(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      log(code === 0 ? `notified (${alert.kind}${alert.cause ? `: ${alert.cause}` : ''}) for ${alert.session ? `${alert.session.slice(0, 8)}…` : alert.lane}`
        : `notify command exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}; the event card still stands`);
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(alert.text);
  }));
}

// ── reading sessions ─────────────────────────────────────────────────────
/** The newest TAIL_LINES entries, reading only the file's last TAIL_BYTES. */
function tailEntries(path) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const size = statSync(path).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString('utf8').split('\n');
    if (len < size) lines = lines.slice(1); // the first line is cut
    const out = [];
    for (const l of lines.filter((x) => x.trim()).slice(-TAIL_LINES)) { try { out.push(JSON.parse(l)); } catch {} }
    return out;
  } finally { closeSync(fd); }
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function foldedSessions() {
  const out = new Set();
  let text = '';
  try { text = readFileSync(P.folds, 'utf8'); } catch { return out; }
  for (const l of text.split('\n')) {
    try {
      const f = JSON.parse(l);
      // A fold's source is the session it closed; its tail is a copy no live
      // window ever runs as (wakes fork it to a fresh id).
      if (f.source?.startsWith('jsonl:')) out.add(f.source.slice(6));
      if (f.tail) out.add(f.tail);
    } catch {}
  }
  return out;
}

function liveSessions() {
  const out = [];
  let names = [];
  try { names = readdirSync(P.sessions).filter((f) => f.endsWith('.json')); } catch { return out; }
  const folded = foldedSessions();
  for (const f of names) {
    let d; try { d = JSON.parse(readFileSync(join(P.sessions, f), 'utf8')); } catch { continue; }
    if (!d?.sessionId || !d.pid || !pidAlive(d.pid)) continue;
    if (d.kind && d.kind !== 'interactive') continue;
    if (folded.has(d.sessionId)) continue;
    let lane = null;
    try { lane = JSON.parse(readFileSync(join(P.wakecycle, `lane.${d.sessionId}`), 'utf8')).lane ?? null; } catch {}
    if (!lane) continue; // not this hub's agent
    out.push({ sid: d.sessionId, lane, status: d.status, statusAt: d.statusUpdatedAt ?? d.updatedAt });
  }
  return out;
}

const textOf = (e) => {
  const c = e?.message?.content;
  return Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ') : typeof c === 'string' ? c : '';
};

/** The named stuck cause an API-error entry stands for, or null for a plain API error (a spiral's). */
function errorCause(e) {
  const t = textOf(e);
  if (/prompt is too long/i.test(t)) return 'too-long';
  if (e.error === 'authentication_failed' || /OAuth|Login expired|Please run \/login|Failed to authenticate/i.test(t)) return 'login';
  if (e.error === 'rate_limit' && /limit/i.test(t)) return 'usage-limit';
  if (/reached your .{0,40}limit|usage limit/i.test(t)) return 'usage-limit';
  // EPROTO is a request cut off mid-upload, not a network that's down, and a retry sends the same request.
  if (/Unable to connect to API.*EPROTO/i.test(t)) return 'request-cut';
  if (/Unable to connect to API|Can't reach the API server|check your internet/i.test(t)) return 'offline';
  if (/went to sleep mid-response/i.test(t)) return 'slept';
  return null;
}

function windowFor(lane, model) { return windowForLane(CFG, lane, model); }

// ── state ────────────────────────────────────────────────────────────────
// active: `${sid}\u0000${cause}` → episode key; spiral: sid → last alert ms;
// costed: tails whose wake cost is recorded; costSeen: tail → woken transcript mtime last read.
// eventsAt: how far into events.jsonl the fold-failure check has read; foldFail: lane → the failure it told.
let state = { active: {}, spiral: {}, midday: {}, due: { seg: {}, l3: null }, costed: [], costSeen: {}, eventsAt: null, foldFail: {} };
try { state = { ...state, ...JSON.parse(readFileSync(P.watchState, 'utf8')) }; } catch { /* first run */ }
function saveState() {
  try { writeFileSync(P.watchState + '.tmp', JSON.stringify(state)); renameSync(P.watchState + '.tmp', P.watchState); }
  catch (e) { log(`state save failed: ${e.message}`); }
}

// ── the words ────────────────────────────────────────────────────────────
const mins = (ms) => Math.round(ms / 60000);
const STUCK = {
  'too-long': (a) => ['Too full to answer', `${cap(a)} can't take any prompt ("Prompt is too long"), so messages and the sleep bell can't reach the session. Force fold on the agent's card folds from the last session that actually ran and opens a fresh window. If the fresh window says the same, run /clear there.`],
  login: (a) => ['Logged out', `${cap(a)} is logged out (the login expired). Nothing can happen until someone runs /login in the agent's window.`],
  'usage-limit': (a) => ['Usage limit reached', `${cap(a)} hit the account's usage limit and is stopped until the limit resets or the model is switched (/model).`],
  offline: (a) => ['Can\'t reach the API', `${cap(a)} can't reach the API (connection or DNS). The session retries when the network is back; worth a look if this machine is offline.`],
  'request-cut': (a) => ['Requests cut off', `${cap(a)}'s requests are being cut off as they upload (EPROTO). If this machine's network is fine, they may be too big: each request sends every image the session has read, and on 10/25 the API was cutting off requests over about 4-5 MB, which may have moved since. A retry sends the same request. Force fold on the agent's card keeps only the newest images.`],
  slept: (a) => ['Cut off by sleep', `${cap(a)} was cut off mid-reply when this machine went to sleep. A short message in the agent's window resumes the session.`],
  classifier: (a, d) => ['Classifier denials', `${cap(a)} has had ${d.count} tool calls denied by the auto mode classifier in ${mins(Wn().classifierWindowMs)} minutes${d.reason ? ` (latest: ${d.reason})` : ''}. The session may be circling something; worth a look.`],
  context: (a, d) => [d.cycleStalled ? 'Midday fold stalled' : 'Context filling up', `${cap(a)} is at ${Math.round(d.ratio * 100)}% of the context window (${Math.round(d.tokens / 1000)}k of ${Math.round(d.window / 1000)}k). ${d.cycleStalled ? 'The midday cycle hasn\'t folded them: its bell was refused or its deadline passed. Force fold folds them now.' : 'Worth a fold at the next good stopping point.'}`],
  waiting: (a, d) => ['Waiting on you', `${cap(a)} has been waiting for ${mins(d.forMs)} minutes (a permission prompt or a question in the agent's window).`],
};

// ── checks ───────────────────────────────────────────────────────────────
function spiralCheck(now, s, entries) {
  const errors = entries.filter((e) => e.isApiErrorMessage && e.timestamp && now - Date.parse(e.timestamp) < Wn().spiralWindowMs);
  if (errors.length < Wn().spiralThreshold) return;
  // Still spiraling? A session that answered since the errors is left alone.
  const newest = [...entries].reverse().find((e) => e.type === 'assistant' || e.type === 'user');
  if (!newest?.isApiErrorMessage) return;
  // A named stuck state is the stuck check's: its advice is the one that helps
  // (a too-full session can't take the short message a spiral wants).
  if (errorCause(newest)) return;
  if (now - (state.spiral[s.sid] ?? 0) < Wn().spiralCooldownMs) return;
  state.spiral[s.sid] = now;
  const a = agentLabel(s.lane);
  log(`SPIRAL: ${s.lane} (${s.sid.slice(0, 8)}…) — ${errors.length} API errors in ${mins(Wn().spiralWindowMs)}m, newest still an error`);
  emit({ at: new Date(now).toISOString(), kind: 'spiral-alarm', lane: s.lane, session: s.sid, errors: errors.length, windowMin: mins(Wn().spiralWindowMs), alarm: true });
  notify({
    kind: 'spiral-alarm', lane: s.lane, session: s.sid, title: 'API errors',
    text: `${cap(a)} has hit ${errors.length} API errors in ${mins(Wn().spiralWindowMs)} minutes and is still erroring. Usually this is a cold cache after a quiet gap, and one short message in the agent's window gets the session going again. If that doesn't, Force fold on the agent's card closes the window, folds, and opens a fresh one, which writes the rung for the day.`,
  });
}

function stuckCauses(now, s, entries) {
  const causes = new Map();
  if (s.status === 'waiting' && s.statusAt && now - s.statusAt >= Wn().waitingMs) {
    causes.set('waiting', { key: String(s.statusAt), detail: { forMs: now - s.statusAt } });
  }
  const newest = [...entries].reverse().find((e) => e.type === 'assistant' || e.type === 'user');
  if (newest?.isApiErrorMessage) {
    const cause = errorCause(newest);
    if (cause) causes.set(cause, { key: newest.uuid ?? newest.timestamp ?? 'x', detail: { text: textOf(newest).slice(0, 160) } });
  }
  const denials = [];
  for (const e of entries) {
    if (e.type !== 'user' || !e.timestamp || now - Date.parse(e.timestamp) > Wn().classifierWindowMs) continue;
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b?.type !== 'tool_result' || !b.is_error) continue;
      const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      if (/denied by the Claude Code auto mode classifier/i.test(t)) denials.push({ at: e.timestamp, reason: (t.match(/Reason:\s*([^\n.]{0,80})/) ?? [])[1] });
    }
  }
  if (denials.length >= Wn().classifierThreshold) {
    causes.set('classifier', { key: denials[0].at, detail: { count: denials.length, reason: denials[denials.length - 1].reason } });
  }
  const ctx = contextOf(s, entries);
  if (ctx) {
    const { ratio, tokens, window } = ctx;
    const k = `${s.sid}\u0000context`;
    const was = k in state.active;
    const cycling = !!lanesNow()?.[s.lane]?.middayCycle;
    if ((ratio >= Wn().contextWarn || (was && ratio >= Wn().contextRearm)) && !(cycling && cycleCovers(now, s, ratio))) {
      causes.set('context', { key: was ? state.active[k] : String(now), detail: { ratio, tokens, window, ...(cycling ? { cycleStalled: true } : {}) } });
    }
  }
  return causes;
}

// For a lane on the midday cycle (Ra, 10/12) the context alarm means "the
// cycle isn't handling it": at softPct the bell already asked for a fold, so
// the old alarm would only repeat it (it fired 125ms beside the first live
// bell). It stays quiet while this session's midday request stands: a soft
// one covers up to urgentPct, above that only the urgent one does, and that
// stops covering once its deadline is MIDDAY_GRACE_MS past (the nightshift
// forces at the deadline on its minute tick, so a live session after that
// means the force didn't land). A bell the nightshift refused (state.midday
// unset) covers nothing. Lanes without the cycle keep the alarm as it was:
// there the person is the only responder.
const MIDDAY_GRACE_MS = 5 * 60_000;
function cycleCovers(now, s, ratio) {
  const mc = lanesNow()?.[s.lane]?.middayCycle;
  if (!mc || !state.midday[s.sid]) return false;
  let fr;
  try { fr = JSON.parse(readFileSync(P.stateFile, 'utf8'))?.[s.lane]?.foldRequest; } catch { return false; }
  if (!fr || fr.sessionId !== s.sid) return false;
  if (ratio >= (mc.urgentPct ?? 0.95) && fr.tier !== 'urgent') return false;
  return fr.deadline == null || now <= fr.deadline + MIDDAY_GRACE_MS;
}

/** The newest real reply's input side against the lane's window, or null. */
function contextOf(s, entries) { return contextOfEntries(CFG, s.lane, entries); }

// ── the midday cycle's trigger (Ra, 10/12) ───────────────────────────────
// For a lane whose config has middayCycle: a soft bell when the context
// reaches softPct, an urgent one at urgentPct. Each tier is asked once per
// session; the nightshift owns the request, its deadline, the nightly-window
// rule and the escalation. A refusal (the session isn't registered yet, say)
// isn't recorded, so the next poll asks again.
const NIGHTSHIFT = join(dirname(fileURLToPath(import.meta.url)), 'nightshift.mjs');
// The card's midday switch (Ra, 10/12) edits the config while this watch
// runs, so the lanes' settings are re-read whenever the file changes, as the
// nightshift reloads its own; nothing needs a restart to take a switch.
let cfgSeen = { mtime: null, lanes: CFG.lanes, watch: CFG.watch };
function cfgNow() {
  const file = CFG.__configFile;
  if (!file) return cfgSeen;
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime !== cfgSeen.mtime) {
      const fresh = loadConfigFrom(file); // loadConfig() caches: it would hand back the old config
      if (cfgSeen.mtime !== null) log(`config reloaded — midday cycle on: [${Object.entries(fresh.lanes ?? {}).filter(([, l]) => l?.middayCycle).map(([k]) => k).join(', ')}], l3HorizonDays: ${fresh.watch?.l3HorizonDays ?? 'off'}`);
      cfgSeen = { mtime, lanes: fresh.lanes, watch: fresh.watch };
    }
  } catch (e) { log(`config reload failed, keeping the last good config: ${e.message}`); }
  return cfgSeen;
}
// The due knobs and the midday cycle are both switches a person flips while
// the daemon runs; both read through cfgNow so neither needs a restart
// (opus's nit on the enable, 10/17: l3HorizonDays read once at boot while
// segmentNoteEveryTokens hot-reloaded — an asymmetry the --once bench can't
// see, since every bench tick is a fresh process).
function lanesNow() { return cfgNow().lanes; }
// Every watch threshold reads hot, except pollMs: setInterval's period
// really is fixed at start, and the boot line says so.
const Wn = () => cfgNow().watch ?? W;
const TIER_RANK = { soft: 1, urgent: 2 };
function middayCheck(s, entries) {
  const mc = lanesNow()?.[s.lane]?.middayCycle;
  if (!mc) return;
  const ctx = contextOf(s, entries);
  if (!ctx) return;
  const tier = ctx.ratio >= (mc.urgentPct ?? 0.95) ? 'urgent' : ctx.ratio >= (mc.softPct ?? 0.85) ? 'soft' : null;
  if (!tier || TIER_RANK[tier] <= (TIER_RANK[state.midday[s.sid]] ?? 0)) return;
  const r = spawnSync(process.execPath, [NIGHTSHIFT, '--midday', s.lane, tier, '--pct', ctx.ratio.toFixed(3), '--session', s.sid], {
    env: envWithConfig(CFG.__configFile),
    encoding: 'utf8', timeout: 20_000,
  });
  const said = `${(r.stdout ?? '').trim()} ${(r.stderr ?? '').trim()}`.trim();
  if (r.status === 0) {
    state.midday[s.sid] = tier;
    log(`MIDDAY ${tier}: ${s.lane} (${s.sid.slice(0, 8)}…) at ${Math.round(ctx.ratio * 100)}% — ${said}`);
  } else {
    log(`midday ${tier} for ${s.lane} not rung (exit ${r.status ?? r.error?.code}): ${said}`);
  }
}

// ── due notes: segment-due and l3-due (one function's two tiers) ──────────
// The day's detail and the ladder's shape both die at unplanned seams: a
// session that idles into an orphan fold banks no segment (two live
// specimens, 10/14 and 10/16), and L2 rungs pile unfolded until someone
// happens to count them. Each tier here notices and says so AMBER — the
// agent's own stream, never a banner (Ra's tier ruling, 10/12) — plus ONE
// spool note per due-state, the bell's own medium: the lane's watcher
// delivers it and the lane acts at its own seam, or doesn't. The watch
// still never touches a session; a note is an invitation, not an act.
function dueNote(lane, slug, text) {
  // Due notes live apart from the spool (10/18): a watcher wakes for one
  // that lands while it's armed, and one left waiting no longer makes every
  // re-arm exit at once (bell-watcher.sh). P.due is resolved absolute by
  // config.mjs.
  const dir = join(P.due ?? join(CFG.weftRoot, 'doorbell', 'due'), lane);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-watch-${slug}.txt`;
  // Staged as a DOTFILE: bell-watcher's `ls` (no -a) can't see it, so a
  // watcher polling between the write and the rename can never pick a name
  // that is about to disappear (opus's knife on #11).
  writeFileSync(join(dir, `.${name}.tmp`), text + '\n');
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
}

// Opt-in per lane: lanes.<id>.segmentNoteEveryTokens. The trigger is the
// DISTANCE from the last ring, not band boundaries: the knob promises one
// note per `every` tokens of growth, and a boundary can't keep that promise
// unless rings happen to land on it (the second and third live rings proved
// it, 10/17 eve: a mid-band ring at 892k, then a boundary at 901k — 9k of
// growth re-ringing; opus's knife on #21 named the trigger as the bug the
// figure fix had only described). So: the first sight of a session
// BASELINES its tokens without ringing — a wake's tail is carried context,
// not new growth — and each `every` tokens of growth since the LAST RING
// rings once, with the exact figure, never less than `every` apart in
// tokens. Deliberately no time floor: heavy burn is exactly when the day's
// detail is most at risk, and a time floor would hold a real seam back.
// A shrunken context (a fold mid-day) rebaselines. A pre-#21 bare-band
// entry reads as its boundary's tokens and converges in one ring.
function segmentDueCheck(now, s, entries) {
  const every = lanesNow()?.[s.lane]?.segmentNoteEveryTokens;
  if (!Number.isFinite(every) || every <= 0) return;
  const ctx = contextOf(s, entries);
  if (!ctx) return;
  const prevEntry = state.due.seg[s.sid];
  const prev = typeof prevEntry === 'number' ? { tokens: prevEntry * every } : prevEntry;
  if (prev === undefined || ctx.tokens < prev.tokens) { state.due.seg[s.sid] = { tokens: ctx.tokens }; return; }
  if (ctx.tokens - prev.tokens < every) return;
  const grewK = Math.round((ctx.tokens - prev.tokens) / 1000);
  state.due.seg[s.sid] = { tokens: ctx.tokens };
  const kTok = Math.round(ctx.tokens / 1000);
  log(`SEGMENT DUE: ${s.lane} (${s.sid.slice(0, 8)}…) at ~${kTok}k (+~${grewK}k since the last ring)`);
  emit({ at: new Date(now).toISOString(), kind: 'segment-due', lane: s.lane, session: s.sid, tokens: ctx.tokens, grewTokens: ctx.tokens - prev.tokens });
  dueNote(s.lane, 'segment-due', `[watch] Segment seam for the ${s.lane} lane: this session has grown another ~${grewK}k tokens since this watch last rang (to ~${kTok}k; it can't see whether you've banked since). At the next clean stopping point, bank a segment (${join(CFG.weftRoot, 'segments', s.lane)}/) so the day's detail survives whatever ends the session early — then delete this note. The next ${Math.round(every / 1000)}k of growth rings once, the same way.`);
}

// Opt-in for the hub: watch.l3HorizonDays. L2 rungs whose INDEX rows carry
// no parent are unfolded — the index is what the machinery reads; rung
// frontmatter is the human copy and may lag (the both-places note, 10/16).
// Dates come from the rung id (…-L2-YYYY-MM-DD[-lane[-n]]…), the one field
// every row carries, and the ladder folds PER LANE (CONN-20: each lane
// writes its own past), so unfolded rungs group by the id's lane token; a
// token that names no configured lane, or none, belongs to defaultLane.
// Due means a whole foldable arc exists BEYOND the days still being lived:
// span ≥ 2×horizon, so folding a finished arc (and keeping the lived
// horizon unfolded) goes quiet instead of re-ringing at once (opus's
// knife on #11). Told once per (lane, oldest unfolded rung).
function l3DueCheck(now) {
  const horizon = cfgNow().watch?.l3HorizonDays ?? 0;
  if (!Number.isFinite(horizon) || horizon <= 0) return;
  let idx;
  try { idx = JSON.parse(readFileSync(join(CFG.weftRoot, 'ladder', 'index.json'), 'utf8')); } catch { return; }
  const parts = (e) => /-L2-(\d{4}-\d{2}-\d{2})(?:-([a-z][a-z0-9]*))?/.exec(e?.id ?? '');
  const fallback = CFG.defaultLane ?? Object.keys(CFG.lanes ?? {})[0];
  if (!fallback) return;
  const byLane = new Map();
  for (const e of idx.entries ?? []) {
    if ((e.level ?? 'L2') !== 'L2' || e.parent) continue;
    const m = parts(e);
    if (!m) continue;
    const lane = m[2] && CFG.lanes?.[m[2]] ? m[2] : fallback;
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push({ id: e.id, day: m[1] });
  }
  if (typeof state.due.l3 !== 'object' || state.due.l3 === null) state.due.l3 = {};
  for (const lane of Object.keys(state.due.l3)) if (!byLane.has(lane)) delete state.due.l3[lane];
  for (const [lane, rungs] of byLane) {
    const days = rungs.map((r) => r.day).sort();
    const spanDays = Math.round((Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86_400_000);
    if (rungs.length < 2 || spanDays < 2 * horizon) { delete state.due.l3[lane]; continue; }
    const oldest = rungs.map((r) => r.id).sort()[0];
    if (state.due.l3[lane] === oldest) continue;
    state.due.l3[lane] = oldest;
    log(`L3 DUE (${lane}): ${rungs.length} unfolded L2 rungs spanning ${spanDays} days (oldest ${oldest})`);
    emit({ at: new Date(now).toISOString(), kind: 'l3-due', lane, unfolded: rungs.length, spanDays, oldest });
    dueNote(lane, 'l3-due', `[watch] The ${lane} lane's ladder is due a fold up: ${rungs.length} L2 rungs with no parent span ${spanDays} days (oldest ${oldest}), twice the ${horizon}-day horizon — a whole foldable arc exists beyond the days still being lived. When there's a quiet hour, propose the L3 fold — then delete this note. It rings again only if the due state clears and recurs.`);
  }
}

// ── wake cost (fix 4) ────────────────────────────────────────────────────
const COST_LOOKBACK_MS = 3 * 24 * 3600_000;
/**
 * The file's first `maxLines` complete lines, read in chunks with no byte cap:
 * one transcript entry can be hundreds of KB (a screenshot in a tail's first
 * entries; 448KB measured by Fable on 10/9), and a fixed window would cut it
 * mid-line and silently never cost that wake.
 */
function headLines(path, maxLines) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const out = [];
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (out.length < maxLines) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) { if (carry.length) out.push(carry.toString('utf8')); break; }
      pos += n;
      let buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      let nl;
      while (out.length < maxLines && (nl = buf.indexOf(10)) !== -1) { out.push(buf.subarray(0, nl).toString('utf8')); buf = buf.subarray(nl + 1); }
      carry = Buffer.from(buf);
    }
    return out;
  } finally { closeSync(fd); }
}
// The harness writes a few uuid-less metadata lines before the first entry
// (last-prompt, ai-title, mode…), and a forked wake puts the tail's first
// entry within its first handful of lines (index 4 on fae38e0a, 10/9).
const HEAD_LINES = 64;
const firstUuid = (path) => {
  for (const l of headLines(path, HEAD_LINES)) { try { const u = JSON.parse(l).uuid; if (u) return u; } catch {} }
  return null;
};
const headHas = (path, uuid) => headLines(path, HEAD_LINES).some((l) => { try { return JSON.parse(l).uuid === uuid; } catch { return false; } });
const usageTokens = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

// The head witness (item 2 of the compatibility guard). Since Claude Code 2.1.300 a
// session's transcript carries an `api-request-shape` entry whose `shape.system`
// holds the system blocks as sent. wake.sh appends the checkpoint with
// `--system-prompt-snapshot off`; with the flag ignored, a resumed conversation
// would send its RECORDED prompt (the previous wake's) and the checkpoint would
// silently not arrive. So: the share of the head's own lines found verbatim in the
// recorded prompt. No shape entry is "no witness" (older versions, or a version
// that stopped writing it), never "stale".
function systemOf(wokenPath, sid) {
  let text;
  try { text = readFileSync(wokenPath, 'utf8'); } catch { return null; }
  for (const l of text.split('\n')) {
    if (!l.includes('"api-request-shape"')) continue; // cheap filter before parsing a long line
    let e; try { e = JSON.parse(l); } catch { continue; }
    // This session's own entry: a forked tail could carry another session's.
    if (e.type !== 'api-request-shape' || e.sessionId !== sid || !Array.isArray(e.shape?.system)) continue;
    return { at: Date.parse(e.timestamp), version: e.version ?? null, text: e.shape.system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') };
  }
  return null;
}
const lineShare = (ref, sys) => {
  const lines = ref.split('\n').filter((l) => l.trim());
  return lines.length ? Math.round((lines.filter((l) => sys.includes(l)).length / lines.length) * 1000) / 1000 : null;
};
// A stale prompt IS the previous wake's own prompt (measured 10/25: a resume+fork launched with new text,
// snapshot on, records the old). So a head's lines that were already in that prompt cannot tell fresh from
// stale, and a quiet day (a dark lane, a zero-turn day) leaves most of the checkpoint unchanged: scoring all
// the lines let a stale prompt clear 0.9 on exactly the day nobody looks (Opus, 10/25: 0.68 of 10/20's lines
// were already in 10/19's checkpoint). Only the DISCRIMINATING lines count: those of today's head absent from
// the previous prompt. Fewer than this many and nothing is claimed.
const MIN_DISCRIMINATING = 5;
/** The prompt the folded (previous) session was sent when it woke: its own first api-request-shape. */
function previousPrompt(source) {
  const id = String(source ?? '').replace(/^jsonl:/, '');
  if (!id) return null;
  for (const dir of [P.transcripts, P.transcriptArchive]) {
    if (!dir) continue;
    const f = join(dir, `${id}.jsonl`);
    if (existsSync(f)) { const s = systemOf(f, id); if (s) return s.text; }
  }
  return null;
}
/** What the wake's head should have been against what the session sent. Pure of state. */
function headWitness({ wokenPath, sid, lane, tail, foldAt, source }) {
  const shape = systemOf(wokenPath, sid);
  if (!shape) return { status: 'none' };
  // The head wake.sh saved when it launched, if it is this wake's (written after the fold,
  // before the first request); else the checkpoint the receipt names, if the receipt is still
  // this wake's and the file has not been touched since the first request.
  let ref = null, refKind = null;
  try {
    const kept = join(P.wakecycle, `last-head.${lane}`);
    const mt = statSync(kept).mtimeMs;
    if (mt >= foldAt && mt <= shape.at) { ref = readFileSync(kept, 'utf8'); refKind = 'saved-head'; }
  } catch {}
  if (ref === null) {
    try {
      const nw = JSON.parse(readFileSync(join(P.wakecycle, `next-wake.${lane}.json`), 'utf8'));
      if (nw.sessionId !== tail || !nw.checkpoint) return { status: 'skipped', why: 'the receipt has moved on and no saved head is this wake\'s' };
      if (statSync(nw.checkpoint).mtimeMs > shape.at) return { status: 'skipped', why: 'the checkpoint was edited after the first request' };
      ref = readFileSync(nw.checkpoint, 'utf8'); refKind = 'checkpoint';
    } catch { return { status: 'skipped', why: 'no saved head and no readable receipt' }; }
  }
  const share = lineShare(ref, shape.text);
  if (share === null) return { status: 'skipped', why: 'the head is empty' };
  // fresh: the share of the discriminating lines found in what was sent; null when it cannot be told.
  let fresh = null, disc = null;
  const prev = previousPrompt(source);
  if (prev !== null) {
    const d = ref.split('\n').filter((l) => l.trim() && !prev.includes(l));
    disc = d.length;
    if (d.length >= MIN_DISCRIMINATING) fresh = Math.round((d.filter((l) => shape.text.includes(l)).length / d.length) * 1000) / 1000;
  }
  return { status: 'measured', share, fresh, disc, ref: refKind, version: shape.version };
}

function wakeCostCheck(now) {
  let rows = [];
  try { rows = readFileSync(P.folds, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return; }
  const costed = new Set(state.costed);
  // A tail some agent's wake receipt still names stays eligible however old
  // its fold (a vacation hold, a long-disarmed agent); the lookback only
  // retires tails that a later fold has replaced (Fable's read, 10/9).
  const current = new Set();
  try {
    for (const f of readdirSync(P.wakecycle)) {
      if (!/^next-wake\..+\.json$/.test(f)) continue;
      try { const id = JSON.parse(readFileSync(join(P.wakecycle, f), 'utf8')).sessionId; if (id) current.add(id); } catch {}
    }
  } catch {}
  let registry = [];
  try { registry = readdirSync(P.wakecycle).filter((f) => f.startsWith('lane.')).map((f) => ({ sid: f.slice(5), mtime: statSync(join(P.wakecycle, f)).mtimeMs, file: join(P.wakecycle, f) })); } catch { return; }
  for (const row of rows) {
    const foldAt = Date.parse(row.at);
    if (!row.tail || costed.has(row.tail) || !(current.has(row.tail) || now - foldAt < COST_LOOKBACK_MS)) continue;
    const tailPath = join(P.transcripts, `${row.tail}.jsonl`);
    const anchor = firstUuid(tailPath);
    if (!anchor) continue;
    const woken = registry.filter((r) => r.mtime > foldAt && r.sid !== row.tail).sort((a, b) => a.mtime - b.mtime)
      .find((r) => headHas(join(P.transcripts, `${r.sid}.jsonl`), anchor));
    if (!woken) continue;
    const wokenPath = join(P.transcripts, `${woken.sid}.jsonl`);
    let mtime = 0;
    try { mtime = statSync(wokenPath).mtimeMs; } catch { continue; }
    if (state.costSeen[row.tail] === mtime) continue; // nothing new since the last read
    state.costSeen[row.tail] = mtime;
    const copied = new Set();
    try { for (const l of readFileSync(tailPath, 'utf8').split('\n')) { try { const u = JSON.parse(l).uuid; if (u) copied.add(u); } catch {} } } catch { continue; }
    let first = null;
    for (const l of readFileSync(wokenPath, 'utf8').split('\n')) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== 'assistant' || copied.has(e.uuid) || e.isApiErrorMessage) continue;
      const t = usageTokens(e.message?.usage);
      if (t > 0) { first = { at: e.timestamp, tokens: t, model: e.message?.model, version: typeof e.version === 'string' ? e.version : null }; break; }
    }
    if (!first) continue; // no real reply yet (or a dead wake: deadwake.mjs's business)
    let lane = null;
    try { lane = JSON.parse(readFileSync(woken.file, 'utf8')).lane ?? null; } catch {}
    const witness = headWitness({ wokenPath, sid: woken.sid, lane, tail: row.tail, foldAt, source: row.source });
    const record = { at: first.at, lane, tail: row.tail, session: woken.sid, source: row.source ?? null, estTokens: row.est_tokens ?? null, firstRequestTokens: first.tokens, ...(first.version ? { version: first.version } : {}), ...(witness.status === 'measured' ? { headMatch: witness.share, headRef: witness.ref, ...(witness.fresh !== null ? { headFresh: witness.fresh } : {}), ...(witness.disc !== null ? { headDisc: witness.disc } : {}) } : {}) };
    // The version that WOKE on the folded tail is the one that has to read its
    // format, so the row is the receipt that this version woke clean (the first
    // real reply came back). A version no earlier row has seen is told once,
    // amber, after the fact: the output check stays the gate. The first version
    // ever recorded only seeds the baseline. Newness is set membership, never a
    // comparison with the last row (a rollback is not new); `previous` is only
    // a label for "what ran last". A wake that dies before a real reply leaves
    // no row, so its version stays unseen and the next clean wake on it fires:
    // "woke clean" is the meaning.
    let seenVersions = [];
    try { seenVersions = readFileSync(P.wakeCosts, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).version; } catch { return null; } }).filter(Boolean); } catch {}
    try { appendFileSync(P.wakeCosts, JSON.stringify(record) + '\n'); } catch (e) { log(`wake-cost write failed: ${e.message}`); continue; }
    emit({ ...record, kind: 'wake-cost' });
    if (witness.status === 'measured') {
      const warn = Wn().headMatchWarn; // 0 is off: a share is never negative, so nothing is under it
      if (witness.fresh === null) {
        // Nothing to tell fresh from stale: most of the head was already in the previous prompt (or there is no
        // previous prompt to compare). Claim nothing; the full share is on the row for forensics.
        log(`wake head not scored for ${lane ?? '?'} (${woken.sid.slice(0, 8)}…): ${witness.disc === null ? 'no previous prompt to compare against' : `only ${witness.disc} lines differ from the previous wake's prompt (needs ${MIN_DISCRIMINATING})`}`);
      } else if (witness.fresh < warn) {
        emit({ at: first.at, kind: 'head-not-in-prompt', lane, session: woken.sid, share: witness.fresh, shareAll: witness.share, discriminating: witness.disc, ref: witness.ref, warnAt: warn, alarm: false });
        log(`HEAD NOT IN PROMPT: ${lane ?? '?'} (${woken.sid.slice(0, 8)}…) sent a system prompt carrying ${Math.round(witness.fresh * 100)}% of the ${witness.disc} lines of the ${witness.ref === 'saved-head' ? 'head wake.sh built' : 'checkpoint'} that were not in the previous wake's prompt (warns under ${Math.round(warn * 100)}%): the snapshot flag may have stopped working`);
      }
    } else if (witness.status === 'none') {
      const v = first.version ?? '?';
      state.unwitnessed ??= {};
      if (!state.unwitnessed[v]) { state.unwitnessed[v] = true; log(`wake head not witnessed: ${lane ?? '?'} woke on claude ${v} with no api-request-shape in its transcript (older versions do not write one); nothing to compare, so nothing is claimed`); }
    } else {
      log(`wake head not checked for ${lane ?? '?'} (${woken.sid.slice(0, 8)}…): ${witness.why}`);
    }
    if (first.version && seenVersions.length && !seenVersions.includes(first.version)) {
      emit({ at: first.at, kind: 'claude-version-new', lane, session: woken.sid, version: first.version, previous: seenVersions.at(-1), alarm: false });
      log(`CLAUDE VERSION NEW: ${lane ?? '?'} woke on ${first.version}, first time a wake has run it (last recorded: ${seenVersions.at(-1)})`);
    }
    // The estimate and the harness part ways by the ladder, the system prompt and
    // the checkpoint, which the fold doesn't count and which grow every day
    // (first requests ran 168k on 10/18 and 319k on 10/24 while the folds got
    // smaller). So the warning is on the request itself against the window: a
    // wake that already costs wakeCostWarn of it leaves the agent that much less
    // before the midday bell. Amber, never a notification: an early heads-up for
    // the L3 fold or a smaller ladder, not an emergency.
    const wakeWindow = windowFor(lane, first.model);
    const warn = Wn().wakeCostWarn;
    if (wakeWindow && warn > 0 && first.tokens / wakeWindow >= warn) {
      emit({ at: first.at, kind: 'wake-cost-high', lane, session: woken.sid, firstRequestTokens: first.tokens, window: wakeWindow, ratio: Math.round((first.tokens / wakeWindow) * 1000) / 1000, warnAt: warn, alarm: false });
      log(`WAKE COST HIGH: ${lane ?? '?'} first request ${first.tokens} is ${Math.round((first.tokens / wakeWindow) * 100)}% of its ${wakeWindow} window (warns at ${Math.round(warn * 100)}%)`);
    }
    log(`WAKE COST: ${lane ?? '?'} woke from ${row.tail.slice(0, 8)}… as ${woken.sid.slice(0, 8)}…: first request ${first.tokens} tokens, fold estimated ${row.est_tokens ?? '?'}`);
    state.costed.push(row.tail);
    delete state.costSeen[row.tail];
  }
  state.costed = state.costed.slice(-200);
}

// A fold that didn't happen (10/21): sleep.mjs's refused trim (trim-failed,
// #30) and the nightshift's failed emergency fold (orphan-fold-failed) are
// written to the event stream by processes that can't notify anyone. The
// watch reads the stream on from where it stopped and tells each lane's
// failure once: a refused trim and the orphan fold that then fails on the
// same trim are one episode, which the lane's next good fold ends. The first
// read starts at the end, so a restart tells nothing old; a stream that
// shrank (replaced) is read from the start.
const FOLD_FAILED = new Set(['trim-failed', 'orphan-fold-failed']);
const FOLD_FAIL_ENDS = new Set(['folded', 'orphan-fold-done', 'fold-forced', 'wake-confirmed']);
function foldFailureCheck() {
  let size;
  try { size = statSync(P.events).size; } catch { return; }
  if (state.eventsAt === null || state.eventsAt === undefined) { state.eventsAt = size; return; }
  if (size < state.eventsAt) state.eventsAt = 0;
  if (size === state.eventsAt) return;
  const fd = openSync(P.events, 'r');
  let text;
  try {
    const buf = Buffer.alloc(size - state.eventsAt);
    readSync(fd, buf, 0, buf.length, state.eventsAt);
    text = buf.toString('utf8');
  } finally { closeSync(fd); }
  // Only whole lines: a line still being written is read next time.
  const end = text.lastIndexOf('\n') + 1;
  if (end === 0) return;
  state.eventsAt += Buffer.byteLength(text.slice(0, end));
  state.foldFail ??= {};
  for (const line of text.slice(0, end).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.lane) continue;
    // The same ends as the card's (gui/assemble.mjs): any fold, or a wake into a new session.
    if (FOLD_FAIL_ENDS.has(e.kind)) { delete state.foldFail[e.lane]; continue; }
    if (!FOLD_FAILED.has(e.kind) || state.foldFail[e.lane]) continue;
    state.foldFail[e.lane] = e.at ?? true;
    const a = agentLabel(e.lane);
    const title = e.kind === 'trim-failed' ? 'Fold refused' : 'Emergency fold failed';
    log(`FOLD FAILED: ${e.lane} — ${e.kind}${e.cause ? `: ${String(e.cause).slice(0, 200)}` : ''}`);
    notify({
      // The cause a notify command gets is the failure's own: trim's reason, or the orphan fold's exit.
      kind: e.kind, cause: e.kind === 'trim-failed' ? String(e.cause ?? '').replace(/^trim: OUTPUT CHECK FAILED, nothing written\.\s*/, '') : `exit ${e.exit ?? '?'}${e.error ? ` (${e.error})` : ''}`,
      lane: e.lane, session: e.session, title,
      text: e.kind === 'trim-failed'
        ? `${cap(a)}'s fold was refused: the trimmer's check didn't pass, so nothing was written and the session is still whole. The card and the log say why. A Claude Code update that changed the transcript format is the usual cause.`
        : `The nightshift's emergency fold for ${a} failed, so the session is still unfolded. The log says why.`,
    });
  }
}

function check() {
  const now = Date.now();
  const before = JSON.stringify(state);
  const live = liveSessions();
  const seen = new Set();
  for (const s of live) {
    const entries = tailEntries(join(P.transcripts, `${s.sid}.jsonl`));
    spiralCheck(now, s, entries);
    try { middayCheck(s, entries); } catch (e) { log(`midday check failed: ${e.message}`); }
    try { segmentDueCheck(now, s, entries); } catch (e) { log(`segment-due check failed: ${e.message}`); }
    for (const [cause, { key, detail }] of stuckCauses(now, s, entries)) {
      const k = `${s.sid}\u0000${cause}`;
      seen.add(k);
      if (state.active[k] === key) continue; // this episode is already told
      state.active[k] = key;
      // A full-ish context is a forecast, not a diagnosis (Ra, 10/12): it's
      // told as context-high, a warning, and only a stalled midday cycle makes
      // it an alarm. "Stuck" stays for the causes where the agent can't act.
      const kind = cause === 'context' ? 'context-high' : 'stuck';
      log(`${kind === 'stuck' ? 'STUCK' : 'CONTEXT HIGH'}: ${s.lane} (${s.sid.slice(0, 8)}…) — ${cause}`);
      emit({ at: new Date(now).toISOString(), kind, cause, lane: s.lane, session: s.sid, ...detail, alarm: kind === 'stuck' || !!detail.cycleStalled });
      const [title, text] = STUCK[cause](agentLabel(s.lane), detail);
      // Red interrupts; amber doesn't (Ra, 10/12). The one amber that still
      // notifies is watch.notifyAmberUncycled's, transitional by name.
      const amber = kind === 'context-high' && !detail.cycleStalled;
      if (!amber || (Wn().notifyAmberUncycled && !lanesNow()?.[s.lane]?.middayCycle)) notify({ kind, cause, lane: s.lane, session: s.sid, title, text });
    }
  }
  // An episode that ended while its session lives gets a clear; a gone
  // session's episodes lapse (its window closing ends the card).
  const liveSids = new Set(live.map((s) => s.sid));
  for (const k of Object.keys(state.active)) {
    if (seen.has(k)) continue;
    const [sid, cause] = k.split('\u0000');
    delete state.active[k];
    if (!liveSids.has(sid)) continue;
    const lane = live.find((s) => s.sid === sid)?.lane;
    const kind = cause === 'context' ? 'context-high-cleared' : 'stuck-cleared';
    log(`${cause === 'context' ? 'CONTEXT HIGH' : 'STUCK'} cleared: ${lane} (${sid.slice(0, 8)}…) — ${cause}`);
    emit({ at: new Date(now).toISOString(), kind, cause, lane, session: sid });
  }
  for (const sid of Object.keys(state.spiral)) if (!liveSids.has(sid)) delete state.spiral[sid];
  for (const sid of Object.keys(state.midday)) if (!liveSids.has(sid)) delete state.midday[sid];
  for (const sid of Object.keys(state.due.seg)) if (!liveSids.has(sid)) delete state.due.seg[sid];
  try { l3DueCheck(now); } catch (e) { log(`l3-due check failed: ${e.message}`); }
  try { wakeCostCheck(now); } catch (e) { log(`wake-cost check failed: ${e.message}`); }
  try { foldFailureCheck(); } catch (e) { log(`fold-failure check failed: ${e.message}`); }
  if (JSON.stringify(state) !== before) saveState();
}

log(`watch up — ${CFG.__configFile ?? 'defaults'}; poll ${W.pollMs / 1000}s; notify: ${[CFG.notify?.macos && 'banner', CFG.notify?.command && 'command'].filter(Boolean).join(' + ') || 'events only'}`);
check();
if (ONCE) {
  await Promise.all(pending);
} else {
  setInterval(() => { try { check(); } catch (e) { log(`check failed: ${e.stack ?? e.message}`); } }, W.pollMs);
}
