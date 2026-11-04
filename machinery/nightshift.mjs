#!/usr/bin/env node
/**
 * Nightshift — the quiet hand that runs the sleep–wake cycle on the clock.
 *
 * Draft 1: one lane. At SLEEP_HOUR it rings the sleep-bell (a minimal
 * relay pass — the session authors its own rung and checkpoint and runs
 * sleep.mjs itself; the authored half is never automated). When
 * next-wake.<lane>.json is fresh and the session has gone quiet, it closes
 * that Claude Code process. At WAKE_HOUR it opens a new Terminal window
 * running wake.sh for the lane. The agent is genuinely down overnight —
 * the doorbell and heartbeat keep watch, which is what they're for.
 *
 * ARMED LATCH: does nothing unless the hub's armed file (paths.armedFile)
 * exists (its content = comma-separated lanes, e.g. "fable"). Built before
 * the first manual cycle proved out, armed only after.
 *
 * Safety rails, in order of the harm they prevent:
 *  - never closes a session that hasn't slept (next-wake must be fresher
 *    than tonight's bell);
 *  - never closes a busy session (transcript must be quiet ≥ QUIET_MS);
 *  - at most one sleep and one wake per lane per day;
 *  - pid→session mapping is verified through the process's own environment
 *    (CLAUDE_CODE_SESSION_ID via `ps eww`), never guessed from timing.
 */
import { laneWatchers, processTable, unheardBell } from './watchers.mjs';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { platformKind, summonWindow, withToolPath } from './platform.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configEnv, contextOfEntries, loadConfig, reloadConfig, switchboardLane } from './config.mjs';
import { cannotAnswer } from './deadwake.mjs';
import { claudeVersionLines, flagLines, nodeLines, nodeRealIo, realIo as claudeVersionIo } from './versioncheck.mjs';

const HOME = homedir();

// Panel children that are the harness's own plumbing, never the agent's
// work: MCP servers, the doorbell, and caffeinate — Claude Code spawns
// `caffeinate -i -t 300` for itself during activity, and on 10/10 it
// deferred the opus lane's orphan fold (pmset receipts). Real work looks
// like a render, an encode, a daemon a hand started.
// The interim heartbeat (10/23, marginalia's pattern, while nightwatch#38 lands) is plumbing too: a lane arms
// `sleep 7200; echo "heartbeat: …"` as a background task, and on 10/25 it held Ra's Fold now for the fable lane
// twice. Only that shape counts: a sleep, then (`;` or `&&`) an echo whose word is `heartbeat`, and nothing after
// the echo (the eval's closing quote, or the line's end). A sleep followed by any other echo or real work, a
// heartbeat echo followed by more commands, or a bare sleep, still defers. The bare `echo heartbeat` is the
// spelling nightwatch#38 documents for other houses; `'"'"'` is how Claude Code wraps a single quote.
//
// Those words mean plumbing only on a process of its own: an MCP server, the bridge, caffeinate. Everything the agent
// runs comes through its tool shell (`zsh -c source …shell-snapshots… && eval '…'`, seen in `ps`), so there a word is
// only a path or an argument: tests run in ~/origin/discord-mcpl aren't plumbing. In a tool shell, plumbing is the
// heartbeat's shape above, or a watcher that IS the command, with no real work chained to it either way. A lane's
// `rm <notes> && <watcher>` counts as one: the rm is done by the time it waits (247 of 992 real arms, 11/04). A
// flagged rm (`rm -rf dist`) isn't a note's. Any other chain reads as work (12 of the 992): a fold waits for it.
const TOOL_SHELL = /^\S*sh -l?c .*(?:shell-snapshots|\beval '|pwd -P >\|)/s;
const PROCESS_WORDS = /mcpl|cc-sock|bridge|inbox-watcher|bell-watcher|caffeinate/;
const HEARTBEAT = /\bsleep \d+ *(?:;|&&) *echo (?:"|'"'"'|')?heartbeat\b[^;&|]*(?:'|$)/;
const WATCHER_COMMAND = /^(?:rm(?: -f)?(?: +[^\s;&|<>-]\S*)+ *(?:&&|;) *)*(?:\w+=\S* +)*(?:\S*sh +)?\S*\b(?:inbox|bell)-watcher\.sh(?: +[^;&|<>]*)?$/;
// The command a tool shell runs: inside its eval, or, with none, after its setup's last `&&`.
const toolCommand = (args) => {
  const evaled = args.match(/\beval '(.*?)'(?: <[^']*)?(?: *&& *pwd -P >\|[^']*)?$/s);
  return (evaled ? evaled[1] : args.slice(args.lastIndexOf(' && ') + 4)).trim();
};
export const INFRA_PROCESS = {
  test: (args) => HEARTBEAT.test(args)
    || (TOOL_SHELL.test(args) ? WATCHER_COMMAND.test(toolCommand(args)) : PROCESS_WORDS.test(args)),
};
// One config, one truth (item E; the 10/5 decoy-checkpoint failure is the
// receipt). Env overrides are applied INSIDE the loader, so the pre-E
// spellings (WEFT_NIGHT_SLEEP etc.) keep working without a second ?? chain
// here that could disagree with it.
let CFG;
try {
  CFG = loadConfig();
} catch (e) {
  // A daemon that dies at import on a torn config would crash-loop under
  // KeepAlive with nothing in the log the morning actually reads. The
  // fallback path is a literal because the config that would supply it is
  // the thing that failed (E review, finding 2).
  try {
    // Beside the named config (every installed job names one; the same
    // doctrine as wake.sh's FALLBACK_LOG). With none named there is no hub
    // to write into, and the stderr line below is the record (issue #7).
    const named = configEnv();
    if (!named) throw new Error('no hub config named');
    const fbDir = dirname(named);
    const fb = join(fbDir, 'nightshift.log');
    // Dedupe against the log's last line: under KeepAlive this import runs
    // every ~30s while the config stays torn, and one loud line beats
    // 2,880 identical ones (E second read, follow-up b).
    let lastLine = '';
    try {
      const t = readFileSync(fb, 'utf8').trimEnd();
      lastLine = t.slice(t.lastIndexOf('\n') + 1);
    } catch {}
    if (!lastLine.includes('NIGHTSHIFT DOWN')) {
      appendFileSync(fb, `${new Date().toISOString()} NIGHTSHIFT DOWN: config unreadable — ${e.message}\n`);
      // Event twin to the same literal fallback dir (config is unreadable,
      // so paths.events is too) — the viewer renders "the watch is down."
      try {
        appendFileSync(join(fbDir, 'events.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), kind: 'daemon-down', error: e.message, alarm: true }) + '\n');
      } catch {}
    }
  } catch {}
  console.error(e.message);
  process.exit(3);
}
const WAKECYCLE = CFG.paths.wakecycle; // the hub's STATE dir (receipts, registry)
// The CODE lives beside this file (pointer model, 10/7): the ritual text,
// the emergency fold and the wake leg must name the machinery, never the
// state dir, and must carry the hub's config across the Terminal boundary.
const MACHINERY_DIR = dirname(fileURLToPath(import.meta.url));
const CFG_FILE = CFG.__configFile; // null on bare defaults; every hub has one
const PROJECT_DIR = CFG.paths.transcripts;
const LOG_FILE = CFG.paths.nightshiftLog;
const ARMED_FILE = CFG.paths.armedFile;
const STATE_FILE = CFG.paths.stateFile;
const SOCK_DIR = CFG.paths.sockDir;

// 02:00/08:00 (Ra, 10/1): later than Ra usually goes down, earlier than she's
// usually up — buffers the wobble in her own sleep. The sleep window CROSSES
// MIDNIGHT relative to nothing: all window logic below is wrap-aware minutes-
// since-local-midnight, because the original string-compare (hm >= "23:30")
// silently breaks for any post-midnight sleep hour.
let SLEEP_HOUR = CFG.schedule.sleep;
let WAKE_HOUR = CFG.schedule.wake;
let QUIET_MS = CFG.schedule.quietMs;
const BELL_MODEL = CFG.models.bell;
// launchd's PATH has no ~/.local/bin; a bare 'claude' spawn ENOENTs and an
// unhandled error event kills the daemon (spiralwatch found this live 10/1).
const CLAUDE_BIN = CFG.paths.claudeBin;
const POLL_MS = CFG.schedule.pollMs;

// The log's machine-readable twin (GUI phase 1): one JSON line per decision,
// same moments the prose log records, append-only, and NEVER in the critical
// path — a failed emit costs an event, not a night. The prose log stays the
// human record; events.jsonl is the API surface the viewer tails.
const EVENTS_FILE = CFG.paths.events;
// LIVE_EMIT is set only on the live daemon path, after the rehearse and
// preflight exits. Structural guard: a future io method that calls
// emitEvent directly can never write the real stream from a bench
// (emitter review, stub-coverage fragility).
let LIVE_EMIT = false;
function emitEvent(kind, fields = {}) {
  if (!LIVE_EMIT) return;
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + '\n');
  } catch { /* the viewer misses one event; the night proceeds */ }
}

function log(line) {
  const out = `${new Date().toISOString()} ${line}`;
  console.log(out);
  try { appendFileSync(LOG_FILE, out + '\n'); } catch {}
}
function hmToMin(hm) { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; }
let SLEEP_MIN = hmToMin(SLEEP_HOUR);
let WAKE_MIN = hmToMin(WAKE_HOUR);
function nowMin() {
  const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: CFG.timezone });
  return hmToMin(hm);
}
/** Is local minute m inside the sleep window [SLEEP, WAKE)? Wrap-aware:
 *  02:00→08:00 is a plain range; 23:30→08:30 wraps midnight. */
function inSleepWindow(m) {
  return SLEEP_MIN < WAKE_MIN ? m >= SLEEP_MIN && m < WAKE_MIN : m >= SLEEP_MIN || m < WAKE_MIN;
}
function armedLanes() {
  // Commas or newlines — a hand-edited file shouldn't silently disarm the
  // night because of a separator choice (10/2: "fable\nopus" parsed as ONE
  // unknown lane and nothing would have fired for either).
  try { return readFileSync(ARMED_FILE, 'utf8').trim().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean); } catch { return []; }
}
function state() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

/** live claude pids with their session ids. macOS blocks reading another
 *  process's env, and the transcript isn't held open — but the mcpl-bridge
 *  listens on a SESSION-KEYED socket, and its parent chain walks up to the
 *  claude process (sock → bridge → bun wrapper → claude; verified 9/30:
 *  58205→58198→58178). Deterministic, no guessing. */
const BRIDGE_SOCK_DIR = join(HOME, '.claude', 'mcpl-bridge');
// The harness's own per-process status file names the session the process
// is running NOW. The bridge socket is named once, at process start, and
// keeps that name through a /clear or an in-window /resume: on 10/8 the
// socket still said e9ec58c1 (a dead wake) while the window ran 7b83b7ae,
// and the 02:00 tick would have folded the live window as dead.
const HARNESS_SESSIONS_DIR = join(HOME, '.claude', 'sessions');
function currentSessionOf(pid) {
  try { return JSON.parse(readFileSync(join(HARNESS_SESSIONS_DIR, `${pid}.json`), 'utf8')).sessionId || null; } catch { return null; }
}
function liveSessions() {
  const out = [];
  const seenPids = new Set();
  let socks = [];
  try { socks = readdirSync(BRIDGE_SOCK_DIR).filter((f) => /^sock-[0-9a-f-]{36}\.sock$/.test(f)); } catch { /* no bridge here: status files below */ }
  for (const f of socks) {
    const sessionId = f.slice(5, -5);
    try {
      const listener = Number(execFileSync('lsof', ['-t', join(BRIDGE_SOCK_DIR, f)], { encoding: 'utf8' }).trim().split('\n')[0]);
      if (!listener) continue;
      let pid = listener;
      for (let hop = 0; hop < 4; hop++) {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        if (comm === 'claude' || comm.endsWith('/claude')) {
          if (!seenPids.has(pid)) { seenPids.add(pid); out.push({ pid, sessionId: currentSessionOf(pid) ?? sessionId }); }
          break;
        }
        const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
        if (!ppid || ppid === 1) break;
        pid = ppid;
      }
    } catch { /* stale sock, dead chain */ }
  }
  // Without the bridge (every install but the one it came from: the first
  // WSL hub, 10/16, read "live sessions: (none)" with its lane plainly up,
  // so the bell could never ring), Claude Code's own status files name each
  // live session: ~/.claude/sessions/<pid>.json. Those cover every claude on
  // the machine, a person's unrelated tabs included, so one counts only
  // when this hub registered its session (wakecycle/lane.<sessionId>) —
  // never by the cwd heuristic, which would bell or close a stranger.
  let files = [];
  try { files = readdirSync(HARNESS_SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  for (const f of files) {
    const pid = Number(f.slice(0, -5));
    if (seenPids.has(pid)) continue;
    try {
      process.kill(pid, 0);
      const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (comm !== 'claude' && !comm.endsWith('/claude')) continue;
      const sessionId = currentSessionOf(pid);
      if (!sessionId || !existsSync(join(WAKECYCLE, `lane.${sessionId}`))) continue;
      seenPids.add(pid);
      out.push({ pid, sessionId });
    } catch { /* gone, or not ours */ }
  }
  return out;
}
// Lane attribution with its GRADE, because not every answer is evidence
// (Ra's 10/13 find): 'registry' is ground truth (wake.sh exports NIGHTWATCH_LANE,
// the SessionStart hook writes wakecycle/lane.<sessionId> from inside the
// new session); 'marker' is a real signal (the session's tail shows a cwd a
// lane claims via lanes[].cwdMarker); 'fallback' is a GUESS — any
// cwd-bearing session no marker claims used to read as the switchboard
// lane, which is nearly always right while every lane runs a different
// model and wrong half the time once two lanes share one. Consumers that
// only route or display may take any grade; wake-suppression takes
// registry only (see the already-awake guard).
function laneAttribution(sessionId) {
  try {
    const reg = JSON.parse(readFileSync(join(WAKECYCLE, `lane.${sessionId}`), 'utf8'));
    if (typeof reg.lane === 'string' && reg.lane) return { lane: reg.lane, grade: 'registry' };
  } catch { /* unregistered — heuristic */ }
  // Whole-tail vote, not last-cwd: the opus lane makes machinery trips into
  // ~/origin/weft (10/2: its wake fixed index.json there, its LAST cwd read
  // as fable, and the 08:00 wake silently concluded fable was already up).
  const path = join(PROJECT_DIR, `${sessionId}.jsonl`);
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).slice(-200);
    let sawCwd = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const cwd = JSON.parse(lines[i]).cwd;
        if (!cwd) continue;
        sawCwd = true;
        // Config-driven vote: a lane claims a session by cwdMarker
        // (lanes[].cwdMarker, substring match). Was `includes('voidwerks')
        // → opus` hardcoded, which no second household could reuse.
        for (const [name, lc] of Object.entries(CFG.lanes)) {
          if (lc && lc.cwdMarker && String(cwd).includes(lc.cwdMarker)) return { lane: name, grade: 'marker' };
        }
      } catch {}
    }
    if (sawCwd) return { lane: switchboardLane(CFG), grade: 'fallback' };
  } catch {}
  return null;
}
function laneOf(sessionId) {
  return laneAttribution(sessionId)?.lane ?? null;
}
// When a session began, by the registry's own stamp (the SessionStart hook
// writes `at`). Null for a session the registry doesn't hold: a caller can't
// conclude a fold happened inside a session it can't date (nightwatch#56).
function sessionStartedAt(sessionId) {
  try {
    const at = Date.parse(JSON.parse(readFileSync(join(WAKECYCLE, `lane.${sessionId}`), 'utf8')).at);
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}
// Whether the lane is awake on a session that began after its latest bell:
// the belled session was left behind (a wake by hand, 10/27), so the floor
// has nothing to catch. Registry-grade only, as wake-suppression is.
function movedOn(laneState, live, io) {
  const s = live.find((x) => x.sessionId !== laneState.belledSession && x.at?.grade === 'registry');
  if (!s) return false;
  const started = io.sessionStartedAt?.(s.sessionId) ?? null;
  return started !== null && started > laneState.belledAt;
}

// The lane's live sessions, best-attributed first (registry > marker >
// fallback). Everywhere the machinery PICKS one session to act for a lane —
// the bell, the close, --fold-now, --midday, --ring — it must prefer the
// session it can prove over the one it guessed: after a4fd805 a raw panel
// no longer suppresses the lane's wake, so two sessions can read as one
// lane all day, and a bell addressed to the guessed one would make the real
// session fold the RAW PANEL's transcript as the lane's receipt while its
// own day goes unfolded (opus's trace, 10/16). Routing still reaches a raw
// panel when it is all there is.
function laneSessionsRanked(sessions, attribution, lane) {
  const rank = { registry: 0, marker: 1, fallback: 2 };
  return sessions
    .map((s) => ({ ...s, at: attribution(s.sessionId) }))
    .filter((s) => s.at?.lane === lane)
    .map((s) => ({ ...s, lane: s.at.lane }))
    .sort((a, b) => (rank[a.at.grade] ?? 3) - (rank[b.at.grade] ?? 3));
}
// A session's context now: the newest real reply's input side against the
// lane's window, read from the transcript's tail (the watch's measure,
// contextOfEntries). Null when there's no reply with usage yet.
function contextNow(sessionId, lane) {
  try {
    const lines = readFileSync(join(PROJECT_DIR, `${sessionId}.jsonl`), 'utf8').split('\n').filter((l) => l.trim()).slice(-400);
    const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return contextOfEntries(CFG, lane, entries);
  } catch { return null; }
}
function transcriptQuietMs(sessionId) {
  try { return Date.now() - statSync(join(PROJECT_DIR, `${sessionId}.jsonl`)).mtimeMs; } catch { return Infinity; }
}

// The ritual's text, separately buildable so --rehearse can assert what a
// bell actually tells a persona: the machinery's own quoted path, the hub's
// config, and THE BELLED SESSION'S id (--session explicit — an env-inherited
// id in an unregistered panel would hit sleep.mjs's cross-hub guard with a
// false refusal; the daemon is the one party that knows the right id).
// The midday cycle's bells (Ra, 10/12) are this same ritual with their own
// framing: why it rang (the context level), that the lane reopens at once
// instead of at the wake hour, and for the urgent tier, the deadline.
// The command names THIS daemon's node (its process.execPath, which the launchd plist or systemd unit pins),
// not a bare `node`: an agent's shell can find a different one (10/25: Homebrew's Node 20 while the daemons
// ran 22), and sleep.mjs spawns trim.mjs with its own node, so the whole fold runs on whatever starts it.
const SLEEP_CMD = (lane, sessionId) => `${CFG_FILE ? `NIGHTWATCH_CONFIG="${CFG_FILE}" ` : ''}"${process.execPath}" "${join(MACHINERY_DIR, 'sleep.mjs')}" --lane ${lane} --session ${sessionId}`;
function middayNote(lane, sessionId, midday) {
  const cmd = SLEEP_CMD(lane, sessionId);
  const level = `the ${lane} lane's context is at ${Math.round(midday.pct * 100)}% of its window`;
  const urgent = midday.tier === 'urgent';
  return (
    `[nightshift] ${urgent ? 'URGENT midday bell' : 'Midday bell'}: ${level}. ` +
    (urgent
      ? `Fold within ${midday.deadlineMin} minutes: if no fold has happened by then, the nightshift closes this window, folds it, and opens a fresh one, which writes the rung. `
      : `There's no deadline: finish what you're doing and fold at your next seam. `) +
    `The ritual, IN THIS ORDER — write a rung for what you've done since your last one (format and laws: templates/rung.md beside this machinery), run \`${cmd}\`, THEN rewrite the checkpoint. ` +
    `Running the fold is your "ready" signal: the nightshift closes this window once the session goes quiet and opens a fresh one right away, not at ${WAKE_HOUR}. ` +
    `Close any background shells or watchers you left running first.`
  );
}

function ritualNote(lane, sessionId) {
  return (
    `[nightshift] Sleep-bell for the ${lane} lane: it's the end of the day. When the current work ` +
    `reaches its seam, run the ritual, IN THIS ORDER — write today's rung into the ladder (format and laws: templates/rung.md beside this machinery), run \`` +
    `${SLEEP_CMD(lane, sessionId)}\`, THEN rewrite the checkpoint ` +
    `(fold receipt first: a crash between rung and fold costs the night; a crash ` +
    `after the fold costs only a stale lane section, and the wake reads the live ` +
    `checkpoint later). Close any background shells or watchers you left running — ` +
    `the nightshift can't close a panel that still has work under it. If one of them ` +
    `watches ANOTHER lane's spool (cover while that lane is out), look in that spool once ` +
    `more before closing it: that lane's bell rings in the same minute, and a note left ` +
    `behind waits unheard until someone arms a watcher there. The nightshift ` +
    `will close the panel once next-wake.${lane}.json is fresh and the session has gone quiet, and ` +
    `wake the lane at ${WAKE_HOUR}. The doorbell and heartbeat hold the night watch.`
  );
}

function ringBell(lane, sessionId, source, midday) {
  // The bell is a SPOOL NOTE into THE LANE'S OWN spool (spool/<lane>/),
  // heard by that session's own watcher (bell-watcher.sh; the SessionStart
  // hook tells every lane session to arm it). Ra's ruling, 10/8: no lane's
  // Nightwatch bell may depend on another agent being up. Until then every
  // bell went to the switchboard (fable) with a relay request, and with
  // fable out of usage the opus bells sat unheard in fable's spool (10/7,
  // 10/8 twice). The switchboard still routes Discord; it no longer stands
  // between a lane and Nightwatch. A lane with no watcher armed still has
  // the orphan fold as its floor.
  const ritual = midday ? middayNote(lane, sessionId, midday) : ritualNote(lane, sessionId);
  try {
    const spool = join(CFG.paths.spool, lane);
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, `${Date.now()}-bell-${lane}.txt`), ritual + '\n');
    log(`rang the sleep-bell for ${lane} (session ${sessionId.slice(0, 8)}…) — spool note written`);
    emitEvent('bell-rung', { lane, session: sessionId, ...(source ? { source } : {}), ...(midday ? { midday: midday.tier } : {}) });
    // Is anyone listening (10/16)? Checked here, at the bell, and nowhere else:
    // a lane with no watcher between bells is ordinary. With none tracked the
    // note waits for the next arm or the spool hook, and the orphan fold is
    // the floor; the record should say so rather than leave a silent night.
    const table = processTable();
    const unheard = table === null ? null : unheardBell(table, lane);
    if (unheard) {
      log(unheard);
      emitEvent('bell-unwatched', { lane, detached: laneWatchers(table, lane).length });
    }
  } catch (e) {
    log(`bell spool write FAILED for ${lane}: ${e.message}`);
    emitEvent('bell-failed', { lane, error: e.message, alarm: true });
  }
}

// State per lane is TIMESTAMPS (belledAt/closedAt/wokenAt, epoch ms), not
// date strings — a 02:00 close and an 08:00 wake share a calendar day, which
// broke the old `closed < today` comparison. Once-per-window latching is a
// 16h minimum gap (windows are daily; 16h tolerates drift both ways).
let WINDOW_GAP_MS = CFG.schedule.windowGapMs;
// Orphan-fold pacing: quiet this long = the turn is over; grace = how long
// an un-answered bell waits before the fold happens anyway.
let ORPHAN_QUIET = CFG.schedule.orphanQuietMs;
let ORPHAN_GRACE = CFG.schedule.orphanGraceMs;
// Orphan-fold failures for one bell before the floor gives up, and the wait in
// minutes after each before the next try: about twenty minutes in all (#56).
const ORPHAN_MAX_FAILURES = 3;
const ORPHAN_RETRY_MIN = [5, 15];

// Hot reload (10/6): the app's save buttons write weft.config.json; a
// boot-frozen schedule would ignore them until the next crash-restart.
// Applied at tick head on config-file mtime change. POLL_MS stays
// boot-frozen (the interval is set once); structural lane edits still
// warrant a kickstart (the app does that); hours and quiet/orphan knobs
// take effect on the next tick, bench-proven (scenario 15).
function applySchedule(cfg) {
  CFG = cfg;
  SLEEP_HOUR = cfg.schedule.sleep;
  WAKE_HOUR = cfg.schedule.wake;
  QUIET_MS = cfg.schedule.quietMs;
  SLEEP_MIN = hmToMin(SLEEP_HOUR);
  WAKE_MIN = hmToMin(WAKE_HOUR);
  WINDOW_GAP_MS = cfg.schedule.windowGapMs;
  ORPHAN_QUIET = cfg.schedule.orphanQuietMs;
  ORPHAN_GRACE = cfg.schedule.orphanGraceMs;
}
let lastCfgMtime = 0;

// Every clock read, discovery, and effect tick uses goes through `io`, so
// --rehearse can drive the REAL decision logic against a scripted night.
// The defaults are byte-for-byte the live behavior.
const io = {
  real: true,
  emit: emitEvent,
  now: () => Date.now(),
  nowMin,
  armedLanes,
  configuredLanes: () => Object.keys(CFG.lanes ?? {}),
  configMtime: () => { try { return statSync(CFG.__configFile).mtimeMs; } catch { return 0; } },
  reloadConfig: () => { try { return reloadConfig(); } catch (e) { log(`config reload FAILED (keeping the running schedule): ${e.message}`); return null; } },
  state,
  saveState,
  liveSessions,
  laneOf,
  laneAttribution,
  sessionStartedAt,
  ringBell,
  quietMs: transcriptQuietMs,
  nextWakeMtime: (lane) => {
    const nw = join(WAKECYCLE, `next-wake.${lane}.json`);
    return existsSync(nw) ? statSync(nw).mtimeMs : 0;
  },
  closePid: (pid) => process.kill(pid, 'SIGTERM'),
  cannotAnswer: (sessionId) => cannotAnswer(join(PROJECT_DIR, `${sessionId}.jsonl`)),
  lastEntryIsApiError: (sessionId) => {
    try {
      const lines = readFileSync(join(PROJECT_DIR, `${sessionId}.jsonl`), 'utf8')
        .split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        const e = JSON.parse(lines[i]);
        if (e.isApiErrorMessage) return true;
        if (e.type === 'assistant' || e.type === 'user') return false;
      }
    } catch {}
    return false;
  },
  // Children of the panel that are real work (a render, an encode), not MCP
  // infra. A quiet transcript is not proof of idleness (opus sat silent 24m
  // behind a render on 10/2) — anything listed here defers the orphan fold.
  busyChildren: (pid) => {
    try {
      const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim();
      if (!out) return [];
      const busy = [];
      for (const child of out.split('\n')) {
        let args = '';
        try { args = execFileSync('ps', ['-o', 'args=', '-p', child], { encoding: 'utf8' }).trim(); } catch { continue; }
        if (INFRA_PROCESS.test(args)) continue;
        busy.push(args.slice(0, 60));
        try {
          const grand = execFileSync('pgrep', ['-P', child], { encoding: 'utf8' }).trim();
          for (const g of grand.split('\n').filter(Boolean)) {
            try { busy.push(execFileSync('ps', ['-o', 'args=', '-p', g], { encoding: 'utf8' }).trim().slice(0, 60)); } catch {}
          }
        } catch {}
      }
      return busy;
    } catch { return []; }
  },
  killAndWait: (pid, timeoutMs = 30_000) => {
    try { process.kill(pid, 'SIGTERM'); } catch { return true; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; }
      execFileSync('sleep', ['1']);
    }
    return false;
  },
  emergencyFold: (lane, sessionId) => {
    // Per-lane trim budgets live in the config now; sleep.mjs resolves its
    // lane's own target. (This spot used to hardcode opus→150k — a relic
    // that disagreed with the planned-fold path once config landed.)
    // process.execPath, not 'node': launchd's PATH has no node, so a bare
    // spawn ENOENTs — the orphan fold was armed 10/3 and could never have
    // fired until this line (found by the E review, 10/5, env -i repro).
    const r = spawnSync(process.execPath, [join(MACHINERY_DIR, 'sleep.mjs'), '--lane', lane, '--emergency', '--session', sessionId],
      { cwd: CFG.paths.workdir, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) {
      log(`orphan fold FAILED for ${lane}: exit ${r.status}; stderr tail: ${(r.stderr || '').slice(-200)}`);
      emitEvent('orphan-fold-failed', { lane, exit: r.status, error: r.error?.code, alarm: true });
      return false;
    }
    return true;
  },
  wakeConfirmed: (lane, sinceMs) => {
    try {
      for (const f of readdirSync(WAKECYCLE)) {
        if (!f.startsWith('lane.')) continue;
        const p = join(WAKECYCLE, f);
        if (statSync(p).mtimeMs <= sinceMs) continue;
        // Return the NEW session id (truthy), not a bare boolean: the
        // wake-confirmed event names the session the LaneCard shows.
        try { if (JSON.parse(readFileSync(p, 'utf8')).lane === lane) return f.slice('lane.'.length); } catch {}
      }
    } catch {}
    return false;
  },
  nextWakeSession: (lane) => {
    try { return JSON.parse(readFileSync(join(WAKECYCLE, `next-wake.${lane}.json`), 'utf8')).sessionId ?? null; } catch { return null; }
  },
  launchWake: (lane) => {
    // scriptDir: on WSL the summons travels as one file path (per-lane name,
    // platform.mjs); on darwin/linux it's unused. Hub-owned, beside receipts.
    // withToolPath: the window's login shell may not see this daemon's node
    // or claude (nvm on Linux/WSL); wake.sh needs both.
    summonWindow({ title: lane, scriptDir: join(WAKECYCLE, 'summons'), shellCommand: withToolPath(
      `${CFG_FILE ? `NIGHTWATCH_CONFIG="${CFG_FILE}" ` : ''}sh "${join(MACHINERY_DIR, 'wake.sh')}" ${lane}`,
      { claudeBin: CFG.paths?.claudeBin }) });
  },
  log,
};


// One orphan-fold attempt for a session that should fold but can't do it
// itself — shared by the in-window orphan path (Ra, 10/3) and --fold-now's
// forced path (Ra, 10/6: refresh semantics). Returns 'deferred' (real work
// under the panel), 'retry' (panel wouldn't die), 'done', or 'failed'.
function tryOrphanFold(io, lane, laneState, st, sid, { deferKey }) {
  const panel = io.liveSessions().find((x) => x.sessionId === sid);
  if (panel) {
    const busy = io.busyChildren(panel.pid);
    if (busy.length) {
      io.log(`fold deferred for ${lane}: real work under the panel (${busy[0]}) — re-checking next tick`);
      if (!laneState[deferKey]) {
        io.emit('orphan-fold-deferred', { lane, busy: busy[0] });
        laneState[deferKey] = true;
        io.saveState(st);
      }
      return 'deferred';
    }
    if (!io.killAndWait(panel.pid)) {
      io.log(`orphan fold: ${lane} panel ${panel.pid} would not exit — retrying next tick`);
      return 'retry';
    }
  }
  return io.emergencyFold(lane, sid) ? 'done' : 'failed';
}

function tickWith(io) {
  // Launch-leg rehearsal: `touch wakecycle/test-wake.trigger` makes THIS
  // process (the one launchd runs at 08:00) perform a harmless Terminal
  // launch, so the macOS Automation prompt fires while a human is at the
  // keyboard instead of at the real wake. The TCC grant attaches to the
  // requesting process, which is why the test must run here, not in a shell.
  const trigger = join(WAKECYCLE, 'test-wake.trigger');
  if (io.real && existsSync(trigger)) {
    try { execFileSync('rm', [trigger]); } catch {}
    try {
      // The test takes the real wake's path, scriptDir included, so on WSL it
      // proves the file-based summons and not just the window.
      summonWindow({ title: 'nightwatch test', scriptDir: join(WAKECYCLE, 'summons'), shellCommand: 'echo nightwatch launch-leg test: TCC grant OK' });
      log(`launch-leg test: Terminal launch SUCCEEDED — the ${CFG.schedule?.wake ?? 'morning'} wake can open windows`);
    } catch (e) {
      // The fix differs by platform: darwin's is the Automation grant; on
      // WSL/Linux it's the terminal binary being on the job's PATH.
      const hint = platformKind() === 'darwin'
        ? 'grant Automation (System Settings > Privacy > Automation)'
        : "check that the terminal binary is on the background job's PATH (wt.exe on WSL, tmux or x-terminal-emulator on Linux)";
      log(`launch-leg test FAILED: ${e.message} — the ${CFG.schedule?.wake ?? 'morning'} wake would fail the same way; ${hint}, and re-touch the trigger`);
    }
  }

  // Hot reload: the app's saves land here one tick later, not one crash
  // later. Mtime-gated so the common tick costs one stat.
  const cfgMt = io.configMtime?.() ?? 0;
  if (cfgMt && cfgMt !== lastCfgMtime) {
    lastCfgMtime = cfgMt;
    const fresh = io.reloadConfig?.();
    if (fresh) {
      applySchedule(fresh);
      io.log(`config reloaded — sleep ${SLEEP_HOUR} wake ${WAKE_HOUR}, lanes: [${Object.keys(fresh.lanes ?? {}).join(', ')}]`);
    }
  }

  // Arming is the Nightly toggle: the 02:00 bell, the night's close and the
  // morning wake. A fold request (a midday bell, a Fold now press) is carried
  // out for any configured lane, armed or not (Ra, 10/19, nightwatch#22): it
  // has already reached the agent, and an agent told to fold whose window
  // never closes and reopens keeps running in the full context the request
  // was meant to end, while the card counts down to a force that never comes.
  // Every request comes from a person's press or the lane's own middayCycle.
  const armed = io.armedLanes();
  const st = io.state();
  const configured = new Set(io.configuredLanes?.() ?? armed);
  const requested = Object.keys(st).filter((l) => !armed.includes(l) && configured.has(l)
    && (st[l]?.foldRequest || st[l]?.refreshWake || st[l]?.refreshFrom));
  const lanes = [...armed, ...requested];
  if (!lanes.length) return; // nothing armed and no fold request standing
  const m = io.nowMin();
  const now = io.now();

  for (const lane of lanes) {
    const laneState = (st[lane] ??= {});
    const nwMtime = io.nextWakeMtime(lane);
    // An unarmed lane is here only for its fold request: no bell, no night
    // close, no scheduled wake. With no night to fold into, its refresh runs
    // at any hour, the sleep window included.
    const isArmed = armed.includes(lane);

    // ── Fold-now (Ra, 10/6: "ring the bell first, force on timeout" +
    // "close the window and open a new one right away"). The CLI rings
    // the bell and records {sessionId, requestedAt, deadline} here; the
    // DAEMON owns the deadline (the app may be closed by then). Met or
    // forced, the outcome is a REFRESH: close, then an immediate
    // registry-verified wake via refreshWake (the normal wake machinery
    // with its window gate waived once). Day-side semantics; a fold-now
    // during the sleep window folds into the night like any bell.
    const fr = laneState.foldRequest;
    if (fr) {
      if (nwMtime > fr.requestedAt) {
        io.log(`fold request met for ${lane} — they folded at their own seam; refreshing`);
        io.emit('fold-request-met', { lane, session: fr.sessionId });
        delete laneState.foldRequest;
        laneState.refreshWake = true;
        laneState.refreshFrom = fr.sessionId; // close THIS session only
        io.saveState(st);
      } else if (fr.deadline != null && now > fr.deadline
        && !(fr.tier && inSleepWindow(m) && io.quietMs(fr.sessionId) < ORPHAN_QUIET)) {
        // A soft midday request has no deadline (null): only the agent's own
        // fold ends it. Without this guard, null compares as 0 and forces at once.
        // An urgent midday deadline that falls inside the nightly window
        // waits for the session to go quiet first (Fable's second read,
        // 10/12): the agent may be writing its nightly rung, an ordinary turn
        // with no child process for tryOrphanFold's guard to see. Any fold
        // of the lane, nightly ones included, meets the request (above).
        // A disarmed lane whose window was already gone at the deadline
        // (closed by hand after the press, say) is put to sleep: the span is
        // still folded, so nothing it said is lost, but nothing reopens it
        // until the Wake button (Ra's 10/9 spec; Sonnet Weft's second read).
        const gone = !isArmed && !io.liveSessions().some((x) => x.sessionId === fr.sessionId);
        const r = tryOrphanFold(io, lane, laneState, st, fr.sessionId, { deferKey: 'foldNowDeferredEmitted' });
        if (r === 'deferred' || r === 'retry') continue;
        if (r === 'done') {
          delete laneState.foldRequest;
          delete laneState.foldNowDeferredEmitted;
          laneState.closedAt = now;
          if (gone) {
            io.log(`FOLD FORCED for ${lane}: no fold within the deadline and the window already closed on a disarmed lane — folded, left asleep until Wake`);
            io.emit('fold-forced', { lane, session: fr.sessionId, reason: 'deadline', refresh: false });
            io.saveState(st);
            continue;
          }
          io.log(`FOLD FORCED for ${lane}: no fold within the deadline — emergency-folded for refresh`);
          io.emit('fold-forced', { lane, session: fr.sessionId, reason: 'deadline' });
          laneState.refreshWake = true;
          laneState.refreshFrom = fr.sessionId; // already killed, but the guard must know
          io.saveState(st);
        } else continue;
      }
    }
    // Refresh close: a met fold-now leaves the old panel open; close it as
    // the night does (slept + quiet), any hour, then the wake side runs.
    if (laneState.refreshWake && (!inSleepWindow(m) || !isArmed)) {
      // Close BY IDENTITY, never by lane: the first live Fold now (10/6
      // 23:16) closed its own freshly-woken session, because a resumed
      // tail's transcript reads hours-quiet by construction and this
      // block matched "any quiet live session of the lane". Only the
      // session the refresh is FROM may be closed; once it's gone, this
      // refresh never closes anything again.
      if (laneState.refreshFrom) {
        const old = io.liveSessions().find((x) => x.sessionId === laneState.refreshFrom);
        if (old) {
          if (nwMtime > 0 && io.quietMs(old.sessionId) >= QUIET_MS) {
            io.log(`closing ${lane} panel for refresh (pid ${old.pid}, session ${old.sessionId.slice(0, 8)}…)`);
            io.emit('panel-closed', { lane, session: old.sessionId, refresh: true });
            try { io.closePid(old.pid); laneState.closedAt = now; io.saveState(st); } catch (e) { io.log(`refresh close failed: ${e.message}`); }
          }
          continue; // old window still up (or just closed) — wake next tick
        }
        delete laneState.refreshFrom; // old window gone; closes are done
        io.saveState(st);
      }
    }

    const live = laneSessionsRanked(io.liveSessions(), io.laneAttribution, lane);

    if (isArmed && inSleepWindow(m)) {
      // Bell: once per window, only if the lane is actually up.
      if (live.length && now - (laneState.belledAt ?? 0) > WINDOW_GAP_MS) {
        // A session whose newest reply is "Prompt is too long" can't take any
        // prompt, so a bell can't reach it (10/8). Flag it loudly; the orphan
        // fold below folds it at once, and sleep.mjs folds the last session
        // that actually ran instead of the corpse.
        if (io.cannotAnswer?.(live[0].sessionId)) {
          io.log(`DEAD WAKE: ${lane} session ${live[0].sessionId.slice(0, 8)}… can't take a prompt ("Prompt is too long") — no bell, nothing could answer it; folding it from the last session that ran`);
          io.emit('dead-wake', { lane, session: live[0].sessionId, alarm: true });
        } else io.ringBell(lane, live[0].sessionId);
        laneState.belledAt = now;
        laneState.belledSession = live[0].sessionId;
        delete laneState.orphanDeferredEmitted; // new window, fresh deferral event
        delete laneState.orphanFailures; // a new bell's floor starts fresh
        delete laneState.orphanRetryAt;
        io.saveState(st);
      }
    }
    // Close and the orphan floor are BELL-ANCHORED, not window-anchored
    // (found 10/9: guard-test's five-minute window orphaned nothing for an
    // 11:12 Sleep-agent bell — a bell outside the sleep window had no floor
    // and a heard one never closed). A bell is a bell wherever the clock
    // stands: --ring and --fold-now ring at any hour, so their close and
    // floor must follow the BELL's own clock. Only ringing the scheduled
    // bell stays window-gated above.
    {
      // Close: only after the lane's latest bell, only once the session has
      // actually slept (next-wake written AFTER the bell) and gone quiet.
      if (live.length && laneState.belledAt && now - laneState.belledAt <= WINDOW_GAP_MS
          && (laneState.closedAt ?? 0) < laneState.belledAt
          && nwMtime > laneState.belledAt
          && io.quietMs(live[0].sessionId) >= QUIET_MS) {
        io.log(`closing ${lane} panel (pid ${live[0].pid}, session ${live[0].sessionId.slice(0, 8)}…) — slept and quiet`);
        io.emit('panel-closed', { lane, session: live[0].sessionId });
        try {
          io.closePid(live[0].pid);
          laneState.closedAt = now;
          io.saveState(st);
        } catch (e) { io.log(`close failed: ${e.message}`); }
      }

      // ── Orphan fold (Ra, 10/3): a lane that was belled this window but
      // never folded gets the designed emergency path instead of sitting
      // idle until morning. An api-error tail is a confident orphan (fold
      // at the quiet threshold); a merely-silent lane gets the full grace.
      // The woken session writes the missing rung retroactively — that IS
      // the emergency wake contract. Deferred while real work (a render)
      // runs under the panel; never in the last pre-wake hour (the morning
      // flag owns that); at most once per window.
      if (laneState.belledAt && now - laneState.belledAt <= WINDOW_GAP_MS
          && nwMtime < laneState.belledAt
          && (laneState.orphanFoldedAt ?? 0) < laneState.belledAt
          && laneState.belledSession
          && !movedOn(laneState, live, io)
          && (laneState.orphanFailures ?? 0) < ORPHAN_MAX_FAILURES
          && now >= (laneState.orphanRetryAt ?? 0)
          && ((WAKE_MIN - m + 1440) % 1440) > 60) {
        const sid = laneState.belledSession;
        const quiet = io.quietMs(sid);
        const apiErr = io.lastEntryIsApiError(sid);
        const dead = io.cannotAnswer?.(sid) ?? false; // no grace: nothing will ever answer
        // Sleep now on a nearly full window rang no bell (--ring, below): no
        // ritual is coming, so the floor folds it at once, as a dead wake.
        const full = laneState.fullBell != null && laneState.fullBell === laneState.belledAt;
        const ready = dead || full ? true : apiErr ? quiet >= ORPHAN_QUIET
          : quiet >= ORPHAN_QUIET && now - laneState.belledAt >= ORPHAN_GRACE;
        if (ready) {
          const r = tryOrphanFold(io, lane, laneState, st, sid, { deferKey: 'orphanDeferredEmitted' });
          if (r === 'deferred' || r === 'retry') continue;
          if (r === 'done') {
            laneState.orphanFoldedAt = now;
            laneState.closedAt = now;
            io.saveState(st);
            io.log(`ORPHAN FOLD: ${lane} belled at ${new Date(laneState.belledAt).toISOString()}, never folded (last entry: ${dead ? 'prompt too long' : apiErr ? 'api error' : 'idle'}) — closed and emergency-folded; the 08:00 wake will brief the lane`);
            io.emit('orphan-fold-done', { lane, cause: dead ? 'dead-wake' : apiErr ? 'api-error' : 'idle' });
          } else if (r === 'failed') {
            // A refusal doesn't change by itself (10/27: the trim's output
            // check refused one session's cut every minute for eight hours,
            // two alarms a time), but a spawn or disk fault may clear. So the
            // tries are spaced (ORPHAN_RETRY_MIN after each failure) and the
            // floor stops after ORPHAN_MAX_FAILURES, once, loudly.
            laneState.orphanFailures = (laneState.orphanFailures ?? 0) + 1;
            laneState.orphanRetryAt = now + (ORPHAN_RETRY_MIN[laneState.orphanFailures - 1] ?? 0) * 60_000;
            io.saveState(st);
            if (laneState.orphanFailures >= ORPHAN_MAX_FAILURES) {
              io.log(`ORPHAN FOLD GAVE UP: ${lane} session ${sid.slice(0, 8)}… failed ${laneState.orphanFailures} times — no more tries for this bell; fold it by hand or wake the lane (WEFT_WAKE_STALE_OK=1 in a terminal window)`);
              io.emit('orphan-fold-gave-up', { lane, session: sid, failures: laneState.orphanFailures, alarm: true });
            }
          }
        }
      }
    }
    if (!inSleepWindow(m) || !isArmed) {
      // The schedule never wakes an unarmed lane (Ra's 10/9 spec: a disarmed
      // agent put to sleep stays asleep until the Wake button); a refresh does.
      if (!isArmed && !laneState.refreshWake) continue;
      // ── Wake side: wake anything that slept and hasn't been woken — but
      // ONLY inside a bounded morning window [WAKE, WAKE+2h). Outside it, a
      // fresh sleep receipt means a DELIBERATE daytime/evening fold (Ra
      // closing a panel that should stay down), and relaunching it within a
      // minute would fight her hand. Found at bench-design time, 10/2: with
      // both lanes armed, yesterday's 22:16 manual Opus fold would have been
      // auto-reopened. The 2h tail still catches a daemon that was down or
      // retrying at 08:00 sharp; a wake missed entirely is the morning
      // heartbeat's to flag, not ours to force at arbitrary hours.
      const sinceWake = (m - WAKE_MIN + 1440) % 1440;
      if (sinceWake >= 120 && !laneState.refreshWake) continue; // refresh waives the window once
      // The next-wake file's mtime is the sleep receipt.
      // Belled but never folded: the receipt predates this window's bell, so
      // the lane's span since its old fold is unfolded. Don't wake the stale
      // tail; say so once, loudly (the 10:17 heartbeat alerts on this line).
      if (nwMtime > 0 && (laneState.belledAt ?? 0) > nwMtime) {
        if ((laneState.staleFlaggedAt ?? 0) < laneState.belledAt) {
          io.log(`BELLED BUT NEVER FOLDED: ${lane}'s next-wake predates its bell — not waking the stale tail; fold the lane (or WEFT_WAKE_STALE_OK=1 ${join(MACHINERY_DIR, 'wake.sh')} ${lane} to resume it anyway)`);
          io.emit('stale-receipt', { lane, session: io.nextWakeSession(lane) ?? undefined, alarm: true });
          laneState.staleFlaggedAt = now;
          io.saveState(st);
        }
        continue;
      }
      // Ra's ruling (10/9): a sleep receipt is woken at the FIRST scheduled
      // wake instant AFTER it was written — no age limit, no same-morning
      // re-wake. A press after today's wake (receipt > wakeInstant) waits
      // for tomorrow; a receipt from yesterday 11:00 predates today's wake
      // and wakes now; the 10/2 evening-fold case still waits for morning.
      // Force fold's refreshWake path is separate and unaffected.
      // Floored to the minute: now's seconds would put the instant at
      // 08:00:45, letting a fold in the first seconds after wake count as
      // pre-wake — a sub-minute crack in ruling A (opus, 10/9). Known limit,
      // noted not fixed: wall-minutes vs real ms drift an hour on a DST day
      // whose wake sits within 2h of the 2am switch.
      const wakeInstant = Math.floor(now / 60_000) * 60_000 - sinceWake * 60_000;
      // The wake trigger counts from when sleep was ASKED (Ra's spec): a
      // receipt that answers a bell keys on the BELL's time, so a night
      // bell whose orphan fold ran late (deferred past the wake for real
      // work, the 10/8 shape) still wakes THIS morning instead of sleeping
      // a day (opus's probe, 10/9). An unbelled hand fold falls back to
      // the receipt's own time.
      const askedAt = laneState.belledAt && nwMtime > laneState.belledAt ? laneState.belledAt : nwMtime;
      // refreshWake (fold-now, 10/6) is the one exception: a refresh is an
      // immediate close-and-reopen at any hour, so it wakes on any receipt
      // newer than the last wake instead of waiting for a wake instant.
      const slept = nwMtime > 0 && (laneState.refreshWake ? (laneState.wokenAt ?? 0) < nwMtime : askedAt < wakeInstant);
      if (slept && (laneState.wokenAt ?? 0) < nwMtime) {
        // A pending launch attempt is TRUSTED only once the lane registry
        // confirms a session actually started (the 10/3 lesson: the window
        // opened, zsh's compinit prompt ate the typed command, and the old
        // stamp-on-launch left the failure invisible for an hour).
        if ((laneState.wakeAttemptAt ?? 0) > nwMtime) {
          const confirmed = io.wakeConfirmed(lane, laneState.wakeAttemptAt);
          // Both io shapes return a session id or false (real: registry
          // filename; bench: the found session's id) — no boolean escape
          // hatch, so liveness is checked unconditionally (review note).
          const confirmedLive = confirmed && io.liveSessions().some((x) => x.sessionId === confirmed);
          if (confirmed && !confirmedLive) {
            io.log(`wake registered for ${lane} but the session is no longer live — treating as unconfirmed`);
          }
          if (confirmedLive) {
            io.log(`wake confirmed for ${lane} (registry entry after launch)`);
            io.emit('wake-confirmed', { lane, session: typeof confirmed === 'string' ? confirmed : undefined });
            laneState.wokenAt = now;
            laneState.wakeAttempts = 0;
            delete laneState.refreshWake;
            io.saveState(st);
            continue;
          }
          if (now - laneState.wakeAttemptAt < 5 * 60_000) continue; // still settling
          if ((laneState.wakeAttempts ?? 0) >= 3) {
            if (!laneState.wakeGaveUpAt || laneState.wakeGaveUpAt < nwMtime) {
              io.log(`WAKE FAILED for ${lane}: 3 launches, no registry confirmation — giving up until the next sleep receipt; the morning heartbeat will flag it`);
              io.emit('wake-failed', { lane, attempts: 3, alarm: true });
              laneState.wakeGaveUpAt = now;
              io.saveState(st);
            }
            continue;
          }
          io.log(`no wake confirmation for ${lane} after 5m — retrying (attempt ${(laneState.wakeAttempts ?? 0) + 1} of 3)`);
        }
        // Wake-suppression trusts REGISTRY attribution only (Ra's 10/13
        // ruling): a marker or fallback read is enough to route a bell, but
        // not to conclude a lane is up and skip its wake — with same-model
        // peers the fallback claims any unmarked panel for the switchboard
        // lane, and a wake suppressed on that guess strands the lane with a
        // clean log. A guessed match is logged and the launch proceeds; a
        // true double panel is visible and cheap, a stranded lane is silent.
        const attributed = io.liveSessions()
          .map((s) => ({ ...s, at: io.laneAttribution(s.sessionId) }))
          .filter((s) => s.at?.lane === lane);
        const trusted = attributed.filter((s) => s.at.grade === 'registry');
        if (trusted.length) { // already up — stamp so we stop looking
          io.log(`${lane} looks already awake (session ${trusted[0].sessionId.slice(0, 8)}… reads as ${lane}, registry) — stamping wokenAt, no Terminal launch`);
          io.emit('already-awake', { lane, session: trusted[0].sessionId });
          laneState.wokenAt = now;
          laneState.wakeAttempts = 0;
          delete laneState.refreshWake;
          io.saveState(st);
          continue;
        }
        if (attributed.length) {
          io.log(`session ${attributed[0].sessionId.slice(0, 8)}… reads as ${lane} by ${attributed[0].at.grade} — not trusted for wake-suppression; launching anyway`);
          io.emit('untrusted-lane-match', { lane, session: attributed[0].sessionId, grade: attributed[0].at.grade });
        }
        // A fresh sleep receipt grants a fresh retry budget. Without this,
        // a WAKE FAILED morning leaves wakeAttempts at 3, and the NEXT
        // night's first launch counts as "attempt 4" — one more failure
        // and the lane gives up after a single try instead of three
        // (seen 10/6: the morning after the decoy-checkpoint failure).
        if ((laneState.wakeAttemptAt ?? 0) <= nwMtime) laneState.wakeAttempts = 0;
        io.log(`waking the ${lane} lane in a new Terminal window (attempt ${(laneState.wakeAttempts ?? 0) + 1})`);
        io.emit('wake-launched', { lane, attempt: (laneState.wakeAttempts ?? 0) + 1 });
        try {
          io.launchWake(lane);
          // Stamp AFTER the launch, not with the tick's `now`: a forced fold
          // earlier in this same tick writes its receipt mid-tick, and an
          // attempt stamped before that receipt is never checked against the
          // registry; the new session then logs as "already awake" (10/8
          // 22:28). The launch returns before wake.sh starts claude, so the
          // session's registry entry still lands after this stamp.
          laneState.wakeAttemptAt = io.now();
          laneState.wakeAttempts = (laneState.wakeAttempts ?? 0) + 1;
          io.saveState(st);
        } catch (e) {
          io.log(`wake launch failed: ${e.message} — will retry next tick`);
        }
      }
    }
  }
}

// --test-windows: print the decision surface for a sweep of simulated local
// times and exit — receipts for the wrap-aware logic without waiting a night.
if (args_has_test_windows()) {
  for (const hm of ['00:30', '01:59', '02:00', '03:30', '07:59', '08:00', '12:00', '19:00', '23:30']) {
    const m = hmToMin(hm);
    console.log(`${hm} → ${inSleepWindow(m) ? 'SLEEP window (bell/close side active)' : 'wake side active'}`);
  }
  process.exit(0);
}
function args_has_test_windows() { return process.argv.includes('--test-windows'); }

// ── --rehearse: run the REAL tick against scripted nights on a virtual
// clock. Minutes pass in a loop, effects are recorded instead of executed,
// and each scenario asserts the decision sequence. This is the bench that
// would have caught the window-wrap, today-is-tomorrow, laneOf and
// evening-refold bugs in daylight. Exit 0 = all scenarios pass.
async function rehearse() {
  // HERMETIC: the scenarios are written against the stock schedule, and the
  // bench must not inherit whatever the live hub happens to be set to — an
  // accelerated scratch hub (sleep 10:52) failed 21 scenarios that assume
  // 02:00/08:00 before this pin (found 10/9). Pin every schedule knob to
  // the scenario contract; the hub's own config is untouched on disk, and
  // --rehearse exits before the live loop ever reads it again.
  const pinned = structuredClone(CFG);
  pinned.schedule = {
    sleep: '02:00', wake: '08:00', quietMs: 2 * 60_000, pollMs: 60_000,
    wakeRetries: 3, wakeConfirmMs: 5 * 60_000,
    orphanQuietMs: 20 * 60_000, orphanGraceMs: 45 * 60_000,
    windowGapMs: 16 * 3600_000,
  };
  applySchedule(pinned);
  let failures = 0;
  const check = (scenario, name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${ok || !detail ? '' : ' — ' + detail}`);
    if (!ok) failures++;
  };

  // One simulated lane-world. Time starts 00:00 LA and advances by minutes.
  function makeWorld(lanes) {
    const w = {
      min: 19 * 60, // start 19:00 the evening before
      day: 0,
      st: {},
      sessions: [],            // [{pid, sessionId, lane, quietMs}]
      nextWake: {},            // lane -> mtimeMs
      events: [],              // recorded effects
      logs: [],
      launchFails: 0,          // countdown of launchWake throws
      confirmWakes: true,      // false = the window opens but nothing runs (10/3)
    };
    for (const lane of lanes) w.nextWake[lane] = 0;
    w.io = {
      real: false,
      emit: () => {}, // events.jsonl is live-only; the bench asserts on w.events
      // Effects take real time inside a tick: a fold writes its receipt and a
      // launch returns a few ms after the tick began. w.ms models that (reset
      // each tick), so a receipt written mid-tick postdates the tick's `now`,
      // as it does live (10/8 22:28: forced fold and relaunch in one tick).
      now: () => (w.day * 1440 + w.min) * 60_000 + (w.ms ?? 0),
      nowMin: () => w.min,
      armedLanes: () => w.armed ?? lanes, // scenarios may disarm (w.armed = [])
      configuredLanes: () => w.configured ?? lanes, // scenarios may remove a lane
      state: () => w.st,
      saveState: () => {},
      liveSessions: () => w.sessions.map(({ pid, sessionId }) => ({ pid, sessionId })),
      laneOf: (sid) => w.sessions.find((s) => s.sessionId === sid)?.lane ?? null,
      // Scenario sessions are registry-grade unless they say otherwise: the
      // launchWake-confirmed ones model daemon wakes, which register.
      laneAttribution: (sid) => {
        const s = w.sessions.find((x) => x.sessionId === sid);
        return s ? { lane: s.lane, grade: s.grade ?? 'registry' } : null;
      },
      // A session's registry stamp: its bornAt, when the scenario gives one.
      sessionStartedAt: (sid) => w.sessions.find((s) => s.sessionId === sid)?.bornAt ?? null,
      ringBell: (lane, sid) => { w.events.push(`bell:${lane}@${w.day}d${fmt(w.min)}`); (w.bellSids ??= []).push(sid); },
      // A session gone from the list reads as its transcript's age does live:
      // quiet since it ended, when the scenario says how long (w.goneQuietMs).
      quietMs: (sid) => w.sessions.find((s) => s.sessionId === sid)?.quietMs ?? w.goneQuietMs ?? 0,
      nextWakeMtime: (lane) => w.nextWake[lane] ?? 0,
      closePid: (pid) => {
        w.events.push(`close:${w.sessions.find((s) => s.pid === pid)?.lane}@${w.day}d${fmt(w.min)}`);
        w.sessions = w.sessions.filter((s) => s.pid !== pid);
      },
      launchWake: (lane) => {
        if (w.launchFails > 0) { w.launchFails--; throw new Error('simulated launch failure'); }
        w.ms = (w.ms ?? 0) + 1;
        w.events.push(`wake:${lane}@${w.day}d${fmt(w.min)}`);
        if (w.confirmWakes) w.sessions.push({ pid: 9000 + w.events.length, sessionId: `woken-${lane}-${w.day}-${w.min}`, lane, quietMs: 0, bornAt: w.io.now() + 1 }); // born strictly after the attempt, as the registry is
      },
      wakeConfirmed: (lane, sinceMs) => w.sessions.find((s) => s.lane === lane && (s.bornAt ?? -1) > sinceMs)?.sessionId ?? false,
      nextWakeSession: (lane) => `rehearse-${lane}-tail`,
      lastEntryIsApiError: (sid) => !!w.apiErrorTails?.[sid],
      cannotAnswer: (sid) => !!w.deadWakes?.[sid],
      busyChildren: () => w.busy ?? [],
      killAndWait: (pid) => { w.sessions = w.sessions.filter((s) => s.pid !== pid); return true; },
      emergencyFold: (lane, sid) => {
        if (w.foldRefuses) { w.events.push(`orphanfold-failed:${lane}@${w.day}d${fmt(w.min)}`); return false; } // the trim's output check, refusing (#56)
        w.events.push(`orphanfold:${lane}@${w.day}d${fmt(w.min)}`); w.ms = (w.ms ?? 0) + 1; w.nextWake[lane] = w.io.now(); return true;
      },
      log: (line) => w.logs.push(line),
    };
    w.step = (minutes = 1) => {
      for (let i = 0; i < minutes; i++) {
        w.min++;
        w.ms = 0;
        if (w.min >= 1440) { w.min -= 1440; w.day++; }
        tickWith(w.io);
      }
    };
    return w;
  }
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const count = (w, prefix) => w.events.filter((e) => e.startsWith(prefix)).length;

  { // Scenario 1: the happy night, two lanes.
    const w = makeWorld(['fable', 'opus']);
    w.sessions = [
      { pid: 1, sessionId: 'sess-f', lane: 'fable', quietMs: 0 },
      { pid: 2, sessionId: 'sess-o', lane: 'opus', quietMs: 0 },
    ];
    w.step(7 * 60 + 5); // 19:00 -> 02:05
    check('happy', 'one bell per lane at 02:00', count(w, 'bell:fable') === 1 && count(w, 'bell:opus') === 1, w.events.join());
    check('happy', 'no close before the fold', count(w, 'close:') === 0);
    // both lanes fold and go quiet
    for (const lane of ['fable', 'opus']) w.nextWake[lane] = w.io.now();
    for (const s of w.sessions) s.quietMs = QUIET_MS + 1;
    w.step(5);
    check('happy', 'both panels closed after fold+quiet', count(w, 'close:fable') === 1 && count(w, 'close:opus') === 1, w.events.join());
    w.step(6 * 60); // -> ~08:10
    check('happy', 'one wake per lane at 08:00', count(w, 'wake:fable') === 1 && count(w, 'wake:opus') === 1, w.events.join());
    w.step(10 * 60); // through the day
    check('happy', 'no further actions all day', w.events.length === 6, w.events.join());
  }

  { // Scenario 2: evening manual fold must NOT be auto-reopened (10/2 find).
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 3, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.step(3 * 60); // -> 22:00
    w.nextWake.opus = w.io.now(); // Ra folds the panel at 22:00...
    w.sessions = [];              // ...and closes it
    w.step(3 * 60 + 55);          // -> 01:55
    check('evening-fold', 'no relaunch before the night', count(w, 'wake:') === 0, w.events.join());
    w.step(10 + 6 * 60 + 30);     // through the night -> 08:35
    check('evening-fold', 'morning wake still happens', count(w, 'wake:opus') === 1, w.events.join());
    check('evening-fold', 'no bell for an empty lane', count(w, 'bell:') === 0);
  }

  { // Scenario 3: session never folds — never closed, bell not repeated.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 4, sessionId: 'sess-f', lane: 'fable', quietMs: QUIET_MS + 1 }];
    w.step(13 * 60); // 19:00 -> 08:00 next day
    check('no-fold', 'exactly one bell', count(w, 'bell:') === 1, w.events.join());
    check('no-fold', 'never closed without a sleep receipt', count(w, 'close:') === 0);
    check('no-fold', 'never woken (nothing slept)', count(w, 'wake:') === 0);
  }

  { // Scenario 4: launch failure retries and recovers.
    const w = makeWorld(['fable']);
    w.nextWake.fable = w.io.now(); // slept yesterday evening (receipt old but <20h at 08:00)
    w.launchFails = 3;
    w.step(13 * 60 + 10); // -> 08:10
    check('retry', 'retries then succeeds once', count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Scenario 5: manual wake before 08:00 — stamp, no double-launch.
    const w = makeWorld(['fable']);
    w.nextWake.fable = w.io.now();
    w.step(12 * 60 + 30); // -> 07:30, still pre-window... sleep window: no wake yet
    w.sessions = [{ pid: 5, sessionId: 'manual-f', lane: 'fable', quietMs: 0 }]; // Ra opens it herself at 07:30
    w.step(60); // -> 08:30
    check('manual-wake', 'no Terminal launch when already up', count(w, 'wake:') === 0, w.events.join());
  }

  { // Scenario 20 (Ra's 10/13 find, fixed 10/16): a same-model STRAY — an
    // unregistered, unmarked panel that the fallback attributes to the
    // switchboard lane — must NOT suppress the lane's wake. Before the
    // attribution grade, this stray read as fable and the guard stamped
    // wokenAt with a clean log while the real lane stayed asleep.
    const w = makeWorld(['fable']);
    w.nextWake.fable = w.io.now();
    // The stray appears at 07:59, after the sleep side's last tick: a bell
    // reaching a stray is designed routing and would derail this night into
    // the orphan-fold wait; the guard under test runs on the wake side.
    w.step(12 * 60 + 59); // -> 07:59
    w.sessions = [{ pid: 6, sessionId: 'stray-x', lane: 'fable', grade: 'fallback', quietMs: 0 }];
    w.step(31); // -> 08:30
    check('same-model-stray', 'a fallback-grade match does not suppress the wake', count(w, 'wake:fable') === 1, w.events.join());
    check('same-model-stray', 'the mistrust is logged, not silent', w.logs.some((l) => l.includes('not trusted for wake-suppression')), w.logs.filter((l) => /awake|trusted/.test(l)).join(' | '));
    check('same-model-stray', 'never stamped "already awake" on the guess', !w.logs.some((l) => l.includes('already awake')), w.logs.join(' | '));
    check('same-model-stray', 'the launched wake is confirmed on the registry-grade session', w.logs.some((l) => l.startsWith('wake confirmed for fable')), w.logs.filter((l) => /confirm/.test(l)).join(' | '));
  }

  { // Scenario 21: the mis-bell (opus's 10/16 trace) — a registry session
    // and a fallback stray both read as fable at the bell. The note must
    // name the REGISTRY session: the stray never arms a watcher, so a note
    // carrying the stray's id would make the real session fold the stray's
    // transcript as fable's receipt while its own day goes unfolded.
    const w = makeWorld(['fable']);
    // The stray listed FIRST, so an unranked [0] picks it (the revert shape).
    w.sessions = [
      { pid: 7, sessionId: 'stray-y', lane: 'fable', grade: 'fallback', quietMs: 0 },
      { pid: 8, sessionId: 'real-f', lane: 'fable', grade: 'registry', quietMs: 0 },
    ];
    w.step(7 * 60 + 5); // 19:00 -> past 02:00: the bell rings in the window
    check('mis-bell', 'the bell names the registry session, not the stray', (w.bellSids ?? [])[0] === 'real-f', JSON.stringify(w.bellSids));
  }

  { // Scenario 6 (REWRITTEN under Ra's 10/9 ruling — was: >20h is stale):
    // ruling B — a receipt however old wakes at the next scheduled morning.
    const w = makeWorld(['fable']);
    w.step(24 * 60); // bench clock starts 19:00 day 0; move to day 1 so a
    // 21h-old receipt is a positive timestamp (scenario-clock artifact).
    w.nextWake.fable = w.io.now() - 21 * 3600_000; // slept 22:00 YESTERDAY
    w.step(13 * 60 + 30); // 19:00 → 08:30 next day
    check('old-receipt', 'a 21h-old receipt wakes at the next 08:00 (ruling B)', count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Ruling A: Sleep agent pressed after the scheduled wake — the agent
    // stays asleep until the NEXT scheduled wake, never re-woken same morning.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 33, sessionId: 'sess-f', lane: 'fable', quietMs: 5 * 60_000 }];
    w.step(13 * 60 + 30); // 19:00 → 08:30, inside the morning window
    w.st.fable = { ...(w.st.fable ?? {}), belledAt: w.io.now(), belledSession: 'sess-f', wokenAt: w.io.now() - 60_000 };
    w.step(5);
    w.nextWake.fable = w.io.now(); // the agent folds at 08:35
    w.step(60); // through 09:35 — still inside [08:00, 10:00)
    check('press-after-wake', 'no same-morning re-wake (ruling A)', count(w, 'wake:fable') === 0, w.events.join());
    w.step(23 * 60); // to the NEXT morning
    check('press-after-wake', 'woken at the next scheduled morning', count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Scenario 8: belled but never folded (opus, 10/3) — stale receipt refused.
    const w = makeWorld(['opus']);
    w.nextWake.opus = w.io.now(); // yesterday's fold receipt, still <20h at 08:00
    w.sessions = [{ pid: 7, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.step(7 * 60 + 5); // 19:00 -> 02:05: bell rings
    w.sessions = [];    // the fold dies post-bell (ECONNRESET / exit) — no new receipt
    w.step(6 * 60 + 30); // through 08:30
    check('stale-bell', 'no wake into the stale tail', count(w, 'wake:') === 0, w.events.join());
    check('stale-bell', 'flagged loudly, once', w.logs.filter((l) => l.includes('BELLED BUT NEVER FOLDED')).length === 1, w.logs.join('|'));
  }

  { // Scenario 9: last night, replayed with the orphan path — bell, fold
    // dies on an api error, quiet, orphan fold, clean 08:00 wake.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 8, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.apiErrorTails = { 'sess-o': true };
    w.step(7 * 60 + 2); // bell at 02:00
    w.sessions[0].quietMs = ORPHAN_QUIET + 1; // the turn died; transcript quiet
    w.step(30);
    check('orphan-api', 'folded at the quiet threshold (no full grace)', count(w, 'orphanfold:opus') === 1, w.events.join());
    w.step(6 * 60); // through 08:30
    check('orphan-api', 'morning wake fires on the fresh receipt', count(w, 'wake:opus') === 1, w.events.join());
    check('orphan-api', 'once per window', count(w, 'orphanfold:') === 1);
  }

  { // Scenario 10: a render under the panel defers the fold.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 9, sessionId: 'sess-o', lane: 'opus', quietMs: ORPHAN_QUIET + 1 }];
    w.apiErrorTails = { 'sess-o': true };
    w.busy = ['ffmpeg -i frames/%d.png out.mp4'];
    w.step(7 * 60 + 40);
    check('orphan-busy', 'defers while the render runs', count(w, 'orphanfold:') === 0, w.events.join());
    w.busy = [];
    w.step(10);
    check('orphan-busy', 'folds once the render finishes', count(w, 'orphanfold:opus') === 1, w.events.join());
  }

  { // Scenario 11: an idle lane that never answered the bell folds after grace.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 10, sessionId: 'sess-f', lane: 'fable', quietMs: ORPHAN_QUIET + 1 }];
    w.step(7 * 60 + 30); // 02:30 — quiet but inside grace
    check('orphan-idle', 'waits out the grace', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(20); // past 02:45 grace
    check('orphan-idle', 'folds after grace', count(w, 'orphanfold:fable') === 1, w.events.join());
  }

  { // Scenario 7: the 10/3 failure — launches "succeed" but nothing starts.
    const w = makeWorld(['fable']);
    w.confirmWakes = false;
    w.nextWake.fable = w.io.now();
    w.step(14 * 60); // 19:00 -> 09:00 next day
    check('eaten-launch', 'exactly 3 launch attempts', count(w, 'wake:fable') === 3, w.events.join());
    check('eaten-launch', 'wokenAt never stamped', !w.st.fable?.wokenAt);
    check('eaten-launch', 'gave up loudly', !!w.st.fable?.wakeGaveUpAt);
    // Ra wakes it by hand at 09:10 — the registry entry self-heals the state.
    w.confirmWakes = true;
    w.sessions.push({ pid: 9999, sessionId: 'manual', lane: 'fable', quietMs: 0, bornAt: w.io.now() });
    w.step(5);
    check('eaten-launch', 'manual wake confirms and clears', !!w.st.fable?.wokenAt, JSON.stringify(w.st));
  }

  { // Scenario 12: a failed morning must not tax the NEXT night's retries.
    // 10/6 finding: wakeAttempts survived the WAKE FAILED morning, so the
    // next night's first launch logged "attempt 4" — one more eaten launch
    // and the lane would give up after a single try instead of three.
    const w = makeWorld(['fable']);
    w.confirmWakes = false;
    w.nextWake.fable = w.io.now();
    w.step(14 * 60); // night one: 3 launches, WAKE FAILED
    check('stale-attempts', 'night one gave up at 3', count(w, 'wake:fable') === 3, w.events.join());
    // A fresh sleep receipt lands mid-morning. Under Ra's 10/9 ruling (A)
    // it does NOT re-wake the same morning — it waits for the next
    // scheduled wake, where the attempts get their own fresh count.
    w.nextWake.fable = w.io.now();
    w.step(14 * 60);
    check('stale-attempts', 'a mid-morning receipt never re-wakes same day (ruling A)', count(w, 'wake:fable') === 3, w.events.join());
    w.step(10 * 60); // through the NEXT morning window
    check('stale-attempts', 'night two gets its own 3 attempts', count(w, 'wake:fable') === 6, w.events.join());
  }

  { // Scenario 13: fold-now MET — the lane folds itself; refresh follows.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 20, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() + 10 * 60_000 } };
    w.step(2); // pending, deadline far
    check('fold-now-met', 'no force while the deadline holds', count(w, 'orphanfold:') === 0, w.events.join());
    w.nextWake.fable = w.io.now(); // the lane folds on its own
    w.step(1);
    check('fold-now-met', 'request cleared, refresh armed', !w.st.fable.foldRequest && w.st.fable.refreshWake === true, JSON.stringify(w.st.fable));
    w.step(3); // close, then wake outside the morning window
    check('fold-now-met', 'panel closed for refresh', count(w, 'close:fable') === 1, w.events.join());
    check('fold-now-met', 'immediate re-wake launched despite the hour', count(w, 'wake:fable') === 1, w.events.join());
    w.step(2);
    check('fold-now-met', 'confirmation clears refreshWake', !w.st.fable.refreshWake && !!w.st.fable.wokenAt, JSON.stringify(w.st.fable));
  }

  { // Scenario 14: fold-now FORCED — deadline passes, orphan path, refresh.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 21, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() + 5 * 60_000 } };
    w.step(4);
    check('fold-now-forced', 'holds before the deadline', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(3); // past the deadline
    check('fold-now-forced', 'forced via the orphan path', count(w, 'orphanfold:fable') === 1, w.events.join());
    check('fold-now-forced', 'request cleared after the force', !w.st.fable.foldRequest, JSON.stringify(w.st.fable));
    w.step(3);
    check('fold-now-forced', 'refresh wake follows the force', count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Scenario 17: midday SOFT (Ra, 10/12) — no deadline, never forced;
    // the agent's own fold is its ready signal, then the refresh reopens it.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 30, sessionId: 'sess-o', lane: 'opus', quietMs: 10 * 60_000 }];
    w.st.opus = { foldRequest: { sessionId: 'sess-o', requestedAt: w.io.now(), deadline: null, tier: 'soft' } };
    w.step(3 * 60); // three hours, unfolded
    check('midday-soft', 'a soft request is never forced, however long it waits', count(w, 'orphanfold:') === 0, w.events.join());
    check('midday-soft', 'and it still stands', w.st.opus.foldRequest?.tier === 'soft', JSON.stringify(w.st.opus));
    w.nextWake.opus = w.io.now(); // the agent folds at its own seam
    w.step(1);
    check('midday-soft', 'its own fold meets it and arms the refresh', !w.st.opus.foldRequest && w.st.opus.refreshWake === true, JSON.stringify(w.st.opus));
    w.step(3);
    check('midday-soft', 'closed and reopened at once, not at the wake hour', count(w, 'close:opus') === 1 && count(w, 'wake:opus') === 1, w.events.join());
  }

  { // Scenario 18: midday URGENT — the deadline passes; forced before the cap.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 31, sessionId: 'sess-o', lane: 'opus', quietMs: 10 * 60_000 }];
    w.st.opus = { foldRequest: { sessionId: 'sess-o', requestedAt: w.io.now(), deadline: w.io.now() + 10 * 60_000, tier: 'urgent' } };
    w.step(8);
    check('midday-urgent', 'holds inside its ten minutes', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(4);
    check('midday-urgent', 'forced once the deadline passes', count(w, 'orphanfold:opus') === 1, w.events.join());
    w.step(3);
    check('midday-urgent', 'and reopened at once', count(w, 'wake:opus') === 1, w.events.join());
  }

  { // Scenario 19: an urgent midday deadline crossing into the nightly
    // window waits while the agent is still working (its nightly rung is an
    // ordinary turn), then forces once the session goes quiet.
    const w = makeWorld(['opus']);
    w.day = 1; w.min = 1 * 60 + 50; // 01:50, ten minutes before the bell
    w.sessions = [{ pid: 32, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.st.opus = { foldRequest: { sessionId: 'sess-o', requestedAt: w.io.now(), deadline: w.io.now() + 10 * 60_000, tier: 'urgent' } };
    w.step(20); // to 02:10: deadline passed inside the window, still working
    check('midday-night', 'no force while the agent works inside the nightly window', count(w, 'orphanfold:opus') === 0, w.events.join());
    w.sessions[0].quietMs = 60 * 60_000; // it goes quiet without folding
    w.step(3);
    check('midday-night', 'forced once the session is quiet', count(w, 'orphanfold:opus') >= 1, w.events.join());
  }

  { // Scenario 16: the 10/6 23:16 live bug — a freshly-woken session's
    // resumed tail reads hours-quiet, and the refresh close must NOT eat
    // it. Forced path, then the new session is made to read quiet
    // immediately (the real shape; bench sessions used to read busy,
    // which is exactly why 15 scenarios missed this).
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 30, sessionId: 'old-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'old-f', requestedAt: w.io.now(), deadline: w.io.now() + 2 * 60_000 } };
    // The live shape (10/8 22:28): a receipt newer than the lane's last
    // wake already exists, so the refresh relaunches in the SAME tick as
    // the forced fold, whose fresh receipt lands mid-tick.
    w.st.fable.wokenAt = w.io.now() - 120 * 60_000;
    w.nextWake.fable = w.io.now() - 60 * 60_000;
    w.step(4); // deadline passes → forced fold (old killed) → wake launches
    check('refresh-identity', 'forced + refresh wake launched', count(w, 'orphanfold:fable') === 1 && count(w, 'wake:fable') === 1, w.events.join());
    for (const sess of w.sessions) sess.quietMs = 10 * 60_000; // the resumed tail reads quiet NOW
    w.step(3);
    check('refresh-identity', 'the NEW session is never closed by its own refresh', count(w, 'close:fable') === 0, w.events.join());
    check('refresh-identity', 'confirmation lands on a LIVE window', !!w.st.fable.wokenAt && w.sessions.length === 1, JSON.stringify({ st: w.st.fable, live: w.sessions.length }));
    check('refresh-identity', 'the relaunch is confirmed as a wake, not mistaken for "already awake"', w.logs.some((l) => l.startsWith('wake confirmed for fable')) && !w.logs.some((l) => l.includes('already awake')), w.logs.filter((l) => /wake|awake/.test(l)).join(' | '));
    check('refresh-identity', 'refresh fully cleared', !w.st.fable.refreshWake && !w.st.fable.refreshFrom, JSON.stringify(w.st.fable));
  }

  { // Scenario 15: HOT RELOAD — the app moves sleep to 03:00 mid-evening;
    // the bell honors the NEW hour without a daemon restart.
    const keep = CFG; // applySchedule swaps module globals; restore after.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 22, sessionId: 'sess-f', lane: 'fable', quietMs: 0 }];
    const fresh = JSON.parse(JSON.stringify(keep));
    fresh.schedule.sleep = '03:00';
    w.io.configMtime = () => 42;
    w.io.reloadConfig = () => fresh;
    w.step(7 * 60 + 59); // 19:00 → 02:59 — the OLD hour must not ring
    check('hot-reload', 'old 02:00 bell suppressed under the new schedule', count(w, 'bell:') === 0, w.events.join());
    w.step(2); // 03:01
    check('hot-reload', 'bell rings at the NEW 03:00', count(w, 'bell:fable') === 1, w.events.join());
    applySchedule(keep); // restore the real schedule for anything after
  }

  { // Scenario 17: the 10/8 DEAD WAKE — the lane's live session answers
    // every prompt with "Prompt is too long". A bell can't reach it, so none
    // rings; the orphan path folds it at once (no quiet threshold, no grace);
    // the morning wake still happens. (Which session the fold READS is
    // sleep.mjs's job — deadwake.mjs — benched separately in deadwake-test.)
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 23, sessionId: 'sess-dead', lane: 'opus', quietMs: 0 }];
    w.deadWakes = { 'sess-dead': true };
    w.step(7 * 60 + 1); // 19:00 → 02:01
    check('dead-wake', 'no bell rung into a session that cannot answer', count(w, 'bell:') === 0, w.events.join());
    check('dead-wake', 'flagged in the log', w.logs.some((l) => l.startsWith('DEAD WAKE: opus')), w.logs.join(' | '));
    check('dead-wake', 'folded within a minute, not after the grace', count(w, 'orphanfold:opus') === 1, w.events.join());
    w.step(6 * 60 + 10); // → 08:11
    check('dead-wake', 'morning wake still fires', count(w, 'wake:opus') === 1, w.events.join());
  }

  { // Scenario: a MANUAL bell outside the sleep window, UNHEARD — the
    // orphan floor follows the bell's clock, not the window's (10/9:
    // guard-test's 11:12 Sleep-agent bell orphaned nothing, forever).
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 31, sessionId: 'sess-f', lane: 'fable', quietMs: 60 * 60_000 }];
    w.step(3 * 60); // 19:00 → 22:00, nowhere near the 02:00 window
    // what --ring now writes (opus's find: it previously wrote nothing):
    w.st.fable = { ...(w.st.fable ?? {}), belledAt: w.io.now(), belledSession: 'sess-f' };
    w.events.push('bell:fable@manual');
    w.step(44); // grace not yet elapsed
    check('manual-bell', 'floor holds through the grace period', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(3); // past ORPHAN_GRACE (45m), quiet all along
    check('manual-bell', 'unheard out-of-window bell gets the orphan floor', count(w, 'orphanfold:fable') === 1, w.events.join());
    check('manual-bell', 'floor fires once per bell', (w.step(30), count(w, 'orphanfold:fable') === 1), w.events.join());
  }

  { // Scenario: the same manual bell, HEARD — the agent folds; the close
    // follows at quiet, outside the window.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 32, sessionId: 'sess-f', lane: 'fable', quietMs: 0 }];
    w.step(3 * 60); // 22:00
    w.st.fable = { ...(w.st.fable ?? {}), belledAt: w.io.now(), belledSession: 'sess-f' };
    w.step(10);
    w.nextWake.fable = w.io.now(); // the agent's fold lands (receipt after the bell)
    w.sessions[0].quietMs = 5 * 60_000;
    w.step(2);
    check('manual-bell', 'a heard out-of-window bell closes when slept and quiet', count(w, 'close:fable') === 1, w.events.join());
    check('manual-bell', 'and never orphan-folds', count(w, 'orphanfold:') === 0, w.events.join());
  }

  { // #56, Sonnet's case: a session whose lane folded mid-window (a ritual
    // run inside it, a midday fold, a hand Fold now) and that kept working
    // still owes that work a fold, so it still gets the bell.
    const w = makeWorld(['fable']);
    w.step(3 * 60 + 40); // 19:00 → 22:40
    w.sessions = [{ pid: 41, sessionId: 'sess-woken', lane: 'fable', quietMs: 0, bornAt: w.io.now() }];
    w.step(5);
    w.nextWake.fable = w.io.now(); // 22:45: a fold of the lane lands
    w.step(3 * 60 + 20); // → 02:05, the session still open and working
    check('folded-mid-window', 'the session still gets its bell', count(w, 'bell:fable') === 1, w.events.join());
  }

  { // #56: a belled session the lane has moved on from (woken by hand on a
    // new session) gets no orphan fold: nothing is left to catch.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 42, sessionId: 'sess-old', lane: 'fable', quietMs: 0 }];
    w.step(7 * 60 + 1); // → 02:01, belled
    check('moved-on', 'the premise: the old session was belled', count(w, 'bell:fable') === 1, w.events.join());
    w.sessions[0].quietMs = 10 * 3600_000;
    w.sessions.push({ pid: 43, sessionId: 'sess-new', lane: 'fable', quietMs: 0, bornAt: w.io.now() + 1 });
    w.step(3 * 60);
    check('moved-on', 'no orphan fold of the session left behind', count(w, 'orphanfold') === 0, w.events.join());
  }

  { // #56: an orphan fold that's refused (10/27: the trim's output check,
    // every minute, two alarms a time) stops after three, saying so once.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 44, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 3600_000 }];
    w.foldRefuses = true;
    w.goneQuietMs = 10 * 3600_000; // its panel closed by the first try, its transcript quiet
    w.step(7 * 60 + 1); // → 02:01, belled, unheard
    w.step(3 * 60);
    const tries = w.events.filter((e) => e.startsWith('orphanfold-failed:fable')).map((e) => e.split('@1d')[1]);
    check('fold-refused', 'three tries, then no more', tries.length === 3, w.events.join());
    check('fold-refused', 'spaced five and fifteen minutes apart', tries.join() === '02:45,02:50,03:05', tries.join());
    check('fold-refused', 'gave up once, in the log', w.logs.filter((l) => l.startsWith('ORPHAN FOLD GAVE UP: fable')).length === 1, w.logs.join(' | '));
  }

  { // #56, Sonnet's Q3: a refusal that clears (a spawn or disk fault) gets
    // its next try after the wait, and that try folds.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 45, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 3600_000 }];
    w.foldRefuses = true;
    w.goneQuietMs = 10 * 3600_000;
    w.step(7 * 60 + 1); // → 02:01, belled, unheard
    w.step(46); // → 02:47: the first try (02:45) failed
    check('fold-clears', 'the premise: one try, refused', count(w, 'orphanfold-failed:fable') === 1, w.events.join());
    w.foldRefuses = false; // the fault clears
    w.step(10);
    check('fold-clears', 'the next try folds', count(w, 'orphanfold:fable') === 1 && count(w, 'orphanfold-failed:fable') === 1, w.events.join());
  }

  { // #56 review (Sonnet): a night that gave up must not disable the floor for the NEXT bell.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 44, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 3600_000 }];
    w.foldRefuses = true;
    w.goneQuietMs = 10 * 3600_000;
    w.step(7 * 60 + 1); w.step(3 * 60); // night 1: three refused tries, gave up
    check('floor-next-night', 'the premise: night 1 gave up', w.logs.some((l) => l.startsWith('ORPHAN FOLD GAVE UP')), w.logs.join(' | '));
    w.foldRefuses = false; // the fault is gone
    w.sessions = [{ pid: 46, sessionId: 'sess-g', lane: 'fable', quietMs: 10 * 3600_000 }];
    w.step(21 * 60); // → 02:01 on night 2, belled, unheard
    w.step(3 * 60);
    check('floor-next-night', 'the next night\'s bell still gets its orphan fold', count(w, 'orphanfold:fable') === 1, w.events.join());
  }
  { // #56 review: only a REGISTRY-grade newer session means the lane has moved on (marker/fallback grades are guesses).
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 42, sessionId: 'sess-old', lane: 'fable', quietMs: 0 }];
    w.step(7 * 60 + 1);
    check('moved-on-grade', 'the premise: the old session was belled', count(w, 'bell:fable') === 1, w.events.join());
    w.sessions[0].quietMs = 10 * 3600_000;
    w.sessions.push({ pid: 43, sessionId: 'sess-guess', lane: 'fable', quietMs: 0, bornAt: w.io.now() + 1, grade: 'marker' });
    w.step(3 * 60);
    check('moved-on-grade', 'a newer session known only by a guess does not stop the orphan fold', count(w, 'orphanfold') === 1, w.events.join());
  }
  { // #56 review: a newer session the registry cannot date does not count as moved on.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 42, sessionId: 'sess-old', lane: 'fable', quietMs: 0 }];
    w.step(7 * 60 + 1);
    w.sessions[0].quietMs = 10 * 3600_000;
    w.sessions.push({ pid: 43, sessionId: 'sess-undated', lane: 'fable', quietMs: 0 }); // no bornAt: undated
    w.step(3 * 60);
    check('moved-on-undated', 'a newer session with no registry stamp does not stop the orphan fold', count(w, 'orphanfold') === 1, w.events.join());
  }

  { // #56: Sleep now on a nearly full window rings no bell; --ring records it
    // as full, and the floor folds the busy session on the next tick, with no
    // wake until the morning (Sleep sleeps; Fold now is the one that reopens).
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 51, sessionId: 'sess-f', lane: 'fable', quietMs: 0 }];
    w.step(3 * 60 + 39); // 19:00 → 22:39
    w.st.fable = { ...(w.st.fable ?? {}), belledAt: w.io.now(), belledSession: 'sess-f', fullBell: w.io.now() }; // what --ring writes
    w.step(2);
    check('sleep-now-full', 'folded on the next tick, busy or not', count(w, 'orphanfold:fable') === 1, w.events.join());
    w.step(60);
    check('sleep-now-full', 'and left asleep: no wake before morning', count(w, 'wake:fable') === 0, w.events.join());
    w.step(8 * 60 + 30); // → 08:10
    check('sleep-now-full', 'the morning wake takes the fold', count(w, 'wake:fable') === 1, w.events.join());
    w.step(18 * 60); // → 02:10 the next night: the scheduled bell, the woken session busy
    check('sleep-now-full', 'the next night\'s bell rings as usual', count(w, 'bell:fable') === 1, w.events.join());
    check('sleep-now-full', 'and the full mark doesn\'t carry over: no fold under the busy session', count(w, 'orphanfold:fable') === 1, w.events.join());
  }

  { // #56 control: an ordinary hand bell (no full mark) on a busy session
    // still waits for quiet and its grace, as before.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 52, sessionId: 'sess-f', lane: 'fable', quietMs: 0 }];
    w.step(3 * 60 + 39);
    w.st.fable = { ...(w.st.fable ?? {}), belledAt: w.io.now(), belledSession: 'sess-f' };
    w.step(30);
    check('sleep-now-room', 'a busy session with room is not folded under it', count(w, 'orphanfold') === 0, w.events.join());
  }

  { // Ra's spec (10/9): a DISARMED agent put to sleep stays asleep until
    // the Wake button — the daemon never schedules it. (The button's half
    // is the app's path, outside this bench.)
    const w = makeWorld(['fable']);
    w.armed = []; // disarmed
    w.step(24 * 60);
    w.nextWake.fable = w.io.now() - 10 * 3600_000; // slept long ago
    w.step(26 * 60); // through two full mornings
    check('disarmed-sleep', 'a disarmed slept lane is never woken by the schedule', count(w, 'wake:') === 0, w.events.join());
  }

  // nightwatch#22 (Ra, 10/19): arming is the Nightly toggle only. A fold
  // request on an unarmed lane is still carried out; nothing else is.
  { // A disarmed lane awake all night gets no bell and no orphan fold.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.sessions = [{ pid: 50, sessionId: 'sess-f', lane: 'fable', quietMs: 60 * 60_000 }];
    w.step(14 * 60); // 19:00 → 09:00, through the whole window
    check('unarmed-night', 'no bell, no orphan fold, no close, no wake', count(w, 'bell:') + count(w, 'orphanfold:') + count(w, 'close:') + count(w, 'wake:') === 0, w.events.join());
  }

  { // A soft midday request on a disarmed lane, met by the agent's own fold:
    // the window closes and reopens, as on an armed lane.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.sessions = [{ pid: 51, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: null, tier: 'soft' } };
    w.step(3);
    check('unarmed-midday', 'a soft request is never forced', count(w, 'orphanfold:') === 0 && !!w.st.fable.foldRequest, JSON.stringify(w.st.fable));
    w.nextWake.fable = w.io.now(); // the agent folds at its own seam
    w.step(1);
    check('unarmed-midday', 'met: the request clears and a refresh is set', !w.st.fable.foldRequest && w.st.fable.refreshWake === true, JSON.stringify(w.st.fable));
    w.step(3);
    check('unarmed-midday', 'the old window closes and a fresh one opens', count(w, 'close:fable') === 1 && count(w, 'wake:fable') === 1, w.events.join());
    w.step(2);
    check('unarmed-midday', 'the wake confirms and the refresh clears', !w.st.fable.refreshWake && !!w.st.fable.wokenAt, JSON.stringify(w.st.fable));
    w.step(24 * 60);
    check('unarmed-midday', 'and the schedule still never belled or woke it', count(w, 'bell:') === 0 && count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Fold now on a disarmed lane, unanswered: the deadline forces it.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.sessions = [{ pid: 52, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() + 10 * 60_000 } };
    w.step(9);
    check('unarmed-force', 'no force while the deadline holds', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(6);
    check('unarmed-force', 'forced at the deadline, then a fresh window', count(w, 'orphanfold:fable') === 1 && count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Inside the nightly window a disarmed lane has no night to fold into:
    // its met request refreshes at once, not at the morning wake.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.step(8 * 60); // 19:00 → 03:00
    w.sessions = [{ pid: 53, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: null, tier: 'soft' } };
    w.nextWake.fable = w.io.now() + 1; // folded just after the request
    w.step(5);
    check('unarmed-window', 'closed and reopened at 03:0x, not 08:00', count(w, 'close:fable') === 1 && count(w, 'wake:fable') === 1 && /@\dd03:0/.test(w.events.find((e) => e.startsWith('wake:fable')) ?? ''), w.events.join());
  }

  { // A request standing through the morning window on a disarmed lane with
    // an old sleep receipt: the request brings the lane into the loop, but
    // the schedule's wake still never fires for it (Ra's 10/9 spec).
    const w = makeWorld(['fable']);
    w.armed = [];
    w.nextWake.fable = w.io.now() - 10 * 3600_000; // slept long ago, never woken
    w.step(13 * 60); // 19:00 → 08:00
    // The request outlived its session (closed by hand), so nothing reads
    // the lane as already awake.
    w.st.fable = { foldRequest: { sessionId: 'sess-gone', requestedAt: w.io.now(), deadline: null, tier: 'soft' } };
    w.step(60); // through the morning window, unanswered
    check('unarmed-morning', 'a standing request never sets off the scheduled wake', count(w, 'wake:') === 0, w.events.join());
  }

  { // An unanswered soft request on a disarmed lane inside the nightly window:
    // the request brings the lane into the loop, but not into the night's
    // bell or orphan fold, and a soft request is never forced.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.step(7 * 60 + 30); // 19:00 → 02:30
    w.sessions = [{ pid: 56, sessionId: 'sess-f', lane: 'fable', quietMs: 60 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: null, tier: 'soft' } };
    w.step(5 * 60); // → 07:30, unanswered
    check('unarmed-window', 'an unanswered request gets no night bell and no orphan fold', count(w, 'bell:') + count(w, 'orphanfold:') + count(w, 'close:') === 0, w.events.join());
  }

  { // Fold now on a disarmed lane, then the window closed by hand before the
    // deadline (Sonnet Weft's repro): the span is still folded, but nothing
    // reopens the lane until the Wake button.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() + 10 * 60_000 } };
    w.step(30); // no live window at any point
    check('unarmed-closed', 'folded at the deadline, so the span is kept', count(w, 'orphanfold:fable') === 1, w.events.join());
    check('unarmed-closed', 'and never woken', count(w, 'wake:') === 0 && !w.st.fable.foldRequest && !w.st.fable.refreshWake, `${w.events.join()} ${JSON.stringify(w.st.fable)}`);
  }

  { // A request standing for a lane no longer in the config does nothing.
    const w = makeWorld(['fable']);
    w.armed = [];
    w.configured = [];
    w.sessions = [{ pid: 54, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() } };
    w.step(30);
    check('unarmed-removed', 'no fold, close or wake for a removed lane', count(w, 'orphanfold:') + count(w, 'close:') + count(w, 'wake:') === 0, w.events.join());
  }

  { // Regression (opus, 10/9): a NIGHT bell whose orphan fold was deferred
    // past the wake (real work under the panel all night, the 10/8 shape)
    // must still wake THIS morning — the trigger counts from the bell, not
    // from the late receipt.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 41, sessionId: 'sess-o', lane: 'opus', quietMs: 60 * 60_000 }];
    w.busy = ['ffmpeg render'];
    w.step(7 * 60 + 2); // 19:00 → 02:02, bell rings, orphan defers for work
    w.step(6 * 60);     // → 08:02, still busy all night
    check('late-orphan', 'deferred all night', count(w, 'orphanfold:') === 0, w.events.join());
    w.busy = [];
    w.step(30);         // work ends; the floor fires post-wake-instant
    check('late-orphan', 'folds once the work ends', count(w, 'orphanfold:opus') === 1, w.events.join());
    w.sessions = [];
    w.step(60);
    check('late-orphan', "that night's sleep still wakes this morning", count(w, 'wake:opus') === 1, w.events.join());
  }

  { // Scenario: the bell's own words. The note must name the belled session
    // explicitly, quote the machinery path, and never point at another house.
    const note = ritualNote('main', 'sid-12345678-abcd');
    check('infra-filter', 'caffeinate is plumbing, not work', INFRA_PROCESS.test('caffeinate -i -t 300'));
    check('infra-filter', 'the inbox watcher is plumbing', INFRA_PROCESS.test('/bin/bash ./inbox-watcher.sh fable'));
    check('infra-filter', "the lane's own bell watcher is plumbing", INFRA_PROCESS.test('/bin/zsh -c source /x/shell-snapshots/s.sh && sh /Users/x/nightwatch/machinery/bell-watcher.sh main'));
    check('infra-filter', 'the interim heartbeat is plumbing (the command line a lane really runs, 10/25)', INFRA_PROCESS.test(`/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && eval 'sleep 7200; echo "heartbeat: 2h elapsed, re-arm me and glance at the spool"' < /dev/null && pwd -P >| /tmp/claude-x-cwd`));
    const W = (c) => `/bin/zsh -c source /x/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval '${c}' < /dev/null && pwd -P >| /tmp/claude-x-cwd`;
    check('infra-filter', 'the heartbeat spelling nightwatch#38 documents is plumbing', INFRA_PROCESS.test(W('sleep 7200; echo heartbeat')));
    check('infra-filter', 'a heartbeat joined with && is plumbing', INFRA_PROCESS.test(W('sleep 7200 && echo "heartbeat: x"')));
    check('infra-filter', 'a sleep before real work is still work', !INFRA_PROCESS.test(W('sleep 30; npm test')));
    check('infra-filter', 'a sleep, another echo, then real work is still work (second reader\'s blocking case)', !INFRA_PROCESS.test(W('sleep 5; echo starting; npm test')));
    check('infra-filter', 'a heartbeat echo with more commands after it is still work', !INFRA_PROCESS.test(W('sleep 60; echo "heartbeat: x"; make')));
    check('infra-filter', 'a bare sleep is still work', !INFRA_PROCESS.test('sleep 7200'));
    // The live command lines, from `ps` under Claude Code: an MCP server is a process of its own; everything the agent runs
    // comes through its tool shell. Words in the tool shell's command aren't plumbing unless the command IS a watcher.
    const wrapped = (c) => `/bin/zsh -c source /x/.claude/shell-snapshots/s.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && eval '${c}' < /dev/null && pwd -P >| /tmp/claude-x-cwd`;
    check('infra-filter', 'an MCP server by its path is plumbing', INFRA_PROCESS.test('node /Users/x/origin/portal/portal-mcpl/dist/src/cc-cli.js'));
    check('infra-filter', 'the bridge plugin is plumbing', INFRA_PROCESS.test('/opt/homebrew/bin/bun run --cwd /Users/x/origin/mcpl-cc-bridge/plugins/mcpl-bridge --shell=bun --silent start'));
    check('infra-filter', 'an MCP server a config starts through a shell is still plumbing', INFRA_PROCESS.test(`sh -c 'node /x/slack-mcpl/server.js'`));
    check('infra-filter', 'a lane\'s watcher as the command it runs is plumbing', INFRA_PROCESS.test(wrapped('NIGHTWATCH_CONFIG=/x/weft.config.json sh /x/nightwatch/machinery/bell-watcher.sh opus')));
    check('infra-filter', 'the inbox watcher as the command it runs is plumbing', INFRA_PROCESS.test(wrapped('/x/weft/doorbell/inbox-watcher.sh fable')));
    check('infra-filter', 'a watcher armed after removing its note is plumbing (the arm lanes really run, 11/04)', INFRA_PROCESS.test(wrapped('rm -f /x/spool/fable/1-gh-poll.txt && /x/weft/doorbell/inbox-watcher.sh fable')));
    check('infra-filter', 'a watcher after removing two notes with `;` is plumbing', INFRA_PROCESS.test(wrapped('rm /x/a.txt /x/b.txt; sh /x/bell-watcher.sh opus')));
    check('infra-filter', 'removing a whole tree before a watcher is work', !INFRA_PROCESS.test(wrapped('rm -rf dist && sh /x/bell-watcher.sh opus')));
    check('infra-filter', 'tests run from a path holding mcpl are work', !INFRA_PROCESS.test(wrapped('cd /Users/x/origin/discord-mcpl && npm test')));
    check('infra-filter', 'a build in a worktree holding bridge is work', !INFRA_PROCESS.test(wrapped('cd /Users/x/origin/mcpl-cc-bridge && bun run build')));
    check('infra-filter', 'a render whose file names a bridge is work', !INFRA_PROCESS.test(wrapped('node render.mjs --scene bridge')));
    check('infra-filter', 'caffeinate mentioned in a command is work', !INFRA_PROCESS.test(wrapped('make test CAFFEINATE=caffeinate')));
    check('infra-filter', 'a test of the watcher is work', !INFRA_PROCESS.test(wrapped('sh machinery/watcher-singleton-test.sh; node bell-watcher-test.mjs')));
    check('infra-filter', 'reading a watcher is work', !INFRA_PROCESS.test(wrapped('sleep 600; cat /x/machinery/bell-watcher.sh')));
    check('infra-filter', 'a watcher after real work is work', !INFRA_PROCESS.test(wrapped('npm test && sh /x/machinery/bell-watcher.sh opus')));
    check('infra-filter', 'a watcher before real work is work', !INFRA_PROCESS.test(wrapped('sh /x/machinery/bell-watcher.sh opus; npm test')));
    check('infra-filter', 'a render is real work', !INFRA_PROCESS.test('node render.mjs --frames 0-8160'));
    check('infra-filter', 'a hand-started daemon is real work', !INFRA_PROCESS.test('node /Users/x/nightwatch/machinery/nightshift.mjs'));
    check('bell-note', 'names the belled session explicitly', note.includes('--session sid-12345678-abcd'), note.slice(0, 200));
    check('bell-note', 'quotes the machinery sleep.mjs path, run by this daemon\'s own node', note.includes(`"${process.execPath}" "${join(MACHINERY_DIR, 'sleep.mjs')}"`));
    check('bell-note', 'never a bare node an agent\'s shell would resolve (10/25)', !/(^|[\s`])node "/.test(note), note);
    const mid = middayNote('main', 'sid-12345678-abcd', { pct: 0.86, tier: 'soft' });
    check('bell-note', 'the midday note runs the same daemon node', mid.includes(`"${process.execPath}" "${join(MACHINERY_DIR, 'sleep.mjs')}"`) && !/(^|[\s`])node "/.test(mid), mid);
    check('bell-note', 'carries this hub\'s config when one exists', !CFG_FILE || note.includes(`NIGHTWATCH_CONFIG="${CFG_FILE}"`));
    // (A 'never names another house' negative was dropped: under Weft's
    // sealed layout MACHINERY_DIR legitimately IS weft/wakecycle, so the
    // positive exact-path check above is the honest form of the claim.)
  }
  console.log(failures === 0 ? 'REHEARSAL CLEAN' : `REHEARSAL: ${failures} failure(s)`);
  if (failures) process.exitCode = 1;
}

function tick() { tickWith(io); }

// The exit carries rehearse()'s own status: a bare exit(0) here overrode its exitCode = 1, so a failing
// rehearsal exited 0 and CI's rehearsal step could never go red (found 10/25; since 10/7).
if (process.argv.includes("--rehearse")) { await rehearse(); process.exit(process.exitCode ?? 0); }

// --arm <lane> | --disarm <lane> | --armed: the app's Nightly toggle and the
// per-lane "Nightshift folds and wakes this lane" box. Reads tolerate every
// separator (the 10/2 newline silently disarmed a proof night for 8 hours);
// writes are ALWAYS comma-joined, so the file converges to the safe form.
if (process.argv.includes('--armed')) {
  console.log(armedLanes().join(','));
  process.exit(0);
}
for (const op of ['--arm', '--disarm']) {
  if (!process.argv.includes(op)) continue;
  const lane = process.argv[process.argv.indexOf(op) + 1];
  if (!lane || !Object.hasOwn(CFG.lanes ?? {}, lane)) {
    console.error(`${op}: unknown agent "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const now = new Set(armedLanes());
  op === '--arm' ? now.add(lane) : now.delete(lane);
  writeFileSync(ARMED_FILE, [...now].join(','));
  console.log(`${op.slice(2)}ed ${lane} — armed: [${[...now].join(', ') || 'DISARMED'}]`);
  process.exit(0);
}

// --fold-now <lane> [--within <minutes>]: the app's "Force fold" (Ra, 10/8:
// "closes immediately, folds, reopens, writes rung" — the emergency button,
// for a full context or an API-error wall; Sleep agent is the bedtime one).
// No bell by default: the request's deadline is now, so the DAEMON forces it
// on its next tick (close, emergency fold, immediate re-wake; the woken
// session writes the rung). --within <minutes> keeps the older bell-first
// form (Ra's 10/6 refresh ruling): ring, then force at the deadline if the
// lane hasn't folded on its own.
if (process.argv.includes('--fold-now')) {
  const lane = process.argv[process.argv.indexOf('--fold-now') + 1];
  if (!lane || !Object.hasOwn(CFG.lanes ?? {}, lane)) {
    console.error(`--fold-now: unknown agent "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const live = laneSessionsRanked(liveSessions(), laneAttribution, lane);
  if (!live.length) {
    console.error(`--fold-now: agent ${lane} is not awake — nothing to fold`);
    process.exit(3);
  }
  const withinIdx = process.argv.indexOf('--within');
  const withinMin = withinIdx !== -1 ? Number(process.argv[withinIdx + 1]) : 0;
  if (!Number.isFinite(withinMin) || withinMin < 0) {
    console.error('--within takes minutes (0 = force at once)');
    process.exit(2);
  }
  LIVE_EMIT = true;
  // A dead wake can't hear a bell; waiting out the deadline only delays the
  // fold (10/8: ten minutes of nothing, then the forced fold). Force now.
  const dead = cannotAnswer(join(PROJECT_DIR, `${live[0].sessionId}.jsonl`));
  const now_ = dead || withinMin === 0;
  if (dead) {
    log(`DEAD WAKE: ${lane} session ${live[0].sessionId.slice(0, 8)}… can't take a prompt — fold-now skips the bell and forces at once`);
    emitEvent('dead-wake', { lane, session: live[0].sessionId, alarm: true });
  } else if (!now_) ringBell(lane, live[0].sessionId, 'nightwatch');
  let st = {};
  try { st = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
  (st[lane] ??= {}).foldRequest = {
    sessionId: live[0].sessionId,
    requestedAt: Date.now(),
    deadline: now_ ? Date.now() : Date.now() + withinMin * 60_000,
  };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  emitEvent('fold-requested', { lane, session: live[0].sessionId, deadline: new Date(st[lane].foldRequest.deadline).toISOString() });
  console.log(dead
    ? `fold requested for ${lane}: the session can't take a prompt ("Prompt is too long"), so no bell — folding from the last session that ran, then a fresh wake`
    : now_ ? `force fold for ${lane}: closing, folding and reopening within a minute; the fresh window writes the rung`
    : `fold requested for ${lane}: bell rung, forcing in ${withinMin}m if unfolded`);
  process.exit(0);
}

// --midday <lane> soft|urgent [--pct <0..1>]: the midday cycle (Ra, 10/12),
// fired by the context watch for a lane whose config has middayCycle. Soft:
// the bell with no deadline; the agent's own fold is its ready signal, and
// the refresh reopens it at once. Urgent: the bell again with a deadline of
// urgentMin, after which the daemon forces the fold (Fold now's path) before
// the window caps. A soft request already pending is escalated, not doubled;
// a request at the same tier or above is left as it is. The nightly window
// is the nightly bell's, so midday bells don't ring inside it.
if (process.argv.includes('--midday')) {
  const at = process.argv.indexOf('--midday');
  const lane = process.argv[at + 1];
  const tier = process.argv[at + 2];
  const mc = CFG.lanes?.[lane]?.middayCycle;
  if (!lane || !Object.hasOwn(CFG.lanes ?? {}, lane)) {
    console.error(`--midday: unknown agent "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  if (tier !== 'soft' && tier !== 'urgent') {
    console.error('--midday: the tier is soft or urgent');
    process.exit(2);
  }
  if (!mc) {
    console.error(`--midday: agent ${lane} has no middayCycle in its config, so it doesn't cycle at midday`);
    process.exit(5);
  }
  const nowMin_ = nowMin();
  // Only an armed lane has a nightly bell to cover it (nightwatch#22); an
  // unarmed one is rung at any hour, and its refresh runs at once.
  if (inSleepWindow(nowMin_) && armedLanes().includes(lane)) {
    console.log(`--midday: inside the nightly window; the nightly bell covers ${lane}`);
    process.exit(0);
  }
  // The watch names the session it measured (--session); it must be this
  // lane's by the registry. Without it, find the lane's live session here.
  const sidIdx = process.argv.indexOf('--session');
  const named = sidIdx !== -1 ? process.argv[sidIdx + 1] : null;
  if (named && laneOf(named) !== lane) {
    console.error(`--midday: session ${named} isn't the ${lane} lane's`);
    process.exit(2);
  }
  const live = named ? [{ sessionId: named }]
    : laneSessionsRanked(liveSessions(), laneAttribution, lane);
  if (!live.length) {
    console.error(`--midday: agent ${lane} is not awake — nothing to fold`);
    process.exit(3);
  }
  let st = {};
  try { st = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
  // A request for another session is stale: that session ended some other
  // way (closed by hand, Force fold) and a soft request, with no deadline,
  // would otherwise stand forever and silence this session's bells.
  const prior = st[lane]?.foldRequest;
  const pending = prior && prior.sessionId === live[0].sessionId ? prior : undefined;
  if (prior && !pending) log(`midday: dropping ${lane}'s stale fold request for session ${String(prior.sessionId).slice(0, 8)}…`);
  if (pending && (pending.tier === 'urgent' || tier === 'soft' || pending.tier === undefined)) {
    // Fold now's own request, or one at this tier or above, already stands.
    console.log(`--midday: a fold request for ${lane} already stands (${pending.tier ?? 'fold now'}); left as it is`);
    process.exit(0);
  }
  const pctIdx = process.argv.indexOf('--pct');
  const pct = pctIdx !== -1 ? Number(process.argv[pctIdx + 1]) : (tier === 'urgent' ? mc.urgentPct ?? 0.95 : mc.softPct ?? 0.85);
  const urgentMin = mc.urgentMin ?? 10;
  LIVE_EMIT = true;
  const sid = live[0].sessionId;
  const dead = cannotAnswer(join(PROJECT_DIR, `${sid}.jsonl`));
  if (dead) {
    log(`DEAD WAKE: ${lane} session ${sid.slice(0, 8)}… can't take a prompt — the midday ${tier} bell forces at once`);
    emitEvent('dead-wake', { lane, session: sid, alarm: true });
  } else {
    ringBell(lane, sid, 'midday', { tier, pct, deadlineMin: urgentMin });
  }
  const deadline = dead ? Date.now() : tier === 'urgent' ? Date.now() + urgentMin * 60_000 : null;
  (st[lane] ??= {}).foldRequest = {
    sessionId: sid,
    requestedAt: pending?.requestedAt ?? Date.now(), // an escalation keeps the soft bell's start
    deadline,
    tier,
  };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  emitEvent('fold-requested', { lane, session: sid, tier, deadline: deadline == null ? null : new Date(deadline).toISOString() });
  log(`midday ${tier} bell for ${lane} at ${Math.round(pct * 100)}%${deadline == null ? ', no deadline' : `, forcing in ${urgentMin}m if unfolded`}`);
  console.log(`midday ${tier} bell for ${lane}${deadline == null ? ': no deadline; it folds at its own seam and reopens at once' : `: forcing in ${urgentMin}m if unfolded`}`);
  process.exit(0);
}

// --wake <lane>: wake that lane NOW, by hand, through the daemon's own
// launcher (summonWindow and its platform seams: Terminal on macOS, the
// summons file on WSL, a terminal emulator or tmux on Linux). The app's Wake
// button on every platform but macOS, whose bridge still opens Terminal
// itself (nightwatch#2). Refuses unknown lanes and lanes the registry shows
// awake, the trust the daemon's own wake-suppression uses.
if (process.argv.includes('--wake')) {
  const lane = process.argv[process.argv.indexOf('--wake') + 1];
  if (!lane || !Object.hasOwn(CFG.lanes ?? {}, lane)) {
    console.error(`--wake: unknown agent "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const up = liveSessions().find((s) => { const at = laneAttribution(s.sessionId); return at?.lane === lane && at.grade === 'registry'; });
  if (up) {
    console.error(`--wake: agent ${lane} is already awake (session ${up.sessionId.slice(0, 8)}…)`);
    process.exit(3);
  }
  try { io.launchWake(lane); }
  catch (e) { console.error(`--wake: the window didn't open: ${e.message}`); process.exit(4); }
  console.log(`Waking ${lane}: a terminal window is resuming them.`);
  process.exit(0);
}

// --ring <lane>: ring that lane's sleep-bell NOW, by hand — the app's Sleep
// button and any human who wants an early night. Exactly the 02:00 bell
// (same ringBell, same spool note, same ritual text, same event), except
// the event carries source:"nightwatch" so the log can tell a hand-rung
// bell from the scheduled one. Refuses unknown lanes and lanes that are
// not awake, nonzero with one line, like sleep.mjs's own guards.
if (process.argv.includes('--ring')) {
  const lane = process.argv[process.argv.indexOf('--ring') + 1];
  if (!lane || !Object.hasOwn(CFG.lanes ?? {}, lane)) {
    console.error(`--ring: unknown agent "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const live = laneSessionsRanked(liveSessions(), laneAttribution, lane);
  if (!live.length) {
    console.error(`--ring: agent ${lane} is not awake — nothing to bell`);
    process.exit(3);
  }
  if (cannotAnswer(join(PROJECT_DIR, `${live[0].sessionId}.jsonl`))) {
    console.error(`--ring: ${lane}'s session can't take a prompt ("Prompt is too long"), so a bell can't reach it. Use Fold now: it folds from the last session that ran and opens a fresh window.`);
    process.exit(4);
  }
  LIVE_EMIT = true; // a hand-rung bell is a real act; its event is real
  // Sleep now on a nearly full window (nightwatch#56): the ritual a bell asks
  // for needs room (at 98% the note itself pushed a session to 100%, where it
  // could answer nothing). So no bell: the bell is recorded as rung but full,
  // and the daemon's orphan floor folds the session on its next tick, closing
  // it and leaving the lane asleep for its next wake, as Sleep always does.
  const ctx = contextNow(live[0].sessionId, lane);
  const room = CFG.schedule.sleepNowRoomTokens;
  const left = ctx === null ? null : ctx.window - ctx.tokens;
  const full = left !== null && left < room;
  if (full) {
    log(`SLEEP NOW, FULL: ${lane} session ${live[0].sessionId.slice(0, 8)}… has ${left} tokens left of its window (< ${room}) — no bell; the nightshift folds it on its next tick and leaves the lane asleep`);
    emitEvent('sleep-now-full', { lane, session: live[0].sessionId, left, pct: Math.round(ctx.ratio * 100) });
  } else ringBell(lane, live[0].sessionId, 'nightwatch');
  // Record the bell in the daemon's state the way the scheduled bell does
  // (read-modify-write, the --fold-now pattern): without this, the close
  // and the orphan floor have nothing to anchor to — opus's find, 10/9:
  // --ring belled a lane and the state file never knew.
  try {
    let st = {};
    try { st = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
    const at = Date.now();
    st[lane] = { ...(st[lane] ?? {}), belledAt: at, belledSession: live[0].sessionId };
    if (full) st[lane].fullBell = at; else delete st[lane].fullBell;
    delete st[lane].orphanDeferredEmitted;
    writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch (e) { console.error(`--ring: bell rung but state write failed (${e.message}) — the close/orphan floor won't see this bell`); }
  // The floor never acts in the hour before the morning wake (the wake owns
  // it), so a press then folds at the wake instead (Sonnet's read of #58).
  console.log(full
    ? `${lane} has about ${Math.round(left / 1000)}k tokens left of its window (${Math.round(ctx.ratio * 100)}%), too full for the bedtime ritual: no bell; the nightshift folds the session within a minute (at the morning wake, if pressed in the hour before it) and leaves ${lane} asleep until its next wake`
    : `bell rung for ${lane} (session ${live[0].sessionId.slice(0, 8)}…)`);
  process.exit(0);
}

// ── --preflight: one REAL tick, effects stubbed to narration. The scripted
// bench (--rehearse) proves the decision logic; this proves the DECISIONS
// AGAINST THE REAL FILES — armed file, state, registry, receipts, live
// sessions — because the 10/2 disarm bug lived in parsing a real file the
// bench never read (a newline in nightshift.armed read as zero lanes armed,
// three daemon restarts, eight silent hours). Run it after any config or
// arming change; it prints what tonight WOULD do and touches nothing.
// FORMAT FROZEN (10/6): the app's health panel renders this output
// verbatim (run-doctor button). Lines stay 'ok|MISSING|BAD <subject> …'
// — extend by ADDING lines, never by reshaping existing ones.
if (process.argv.includes('--preflight')) {
  const say = (what) => console.log(`WOULD ${what}`);
  const preflightIo = {
    ...io,
    real: false,
    emit: () => {}, // preflight narrates; it never writes the event stream
    saveState: () => {},
    ringBell: (lane, sess) => say(`ring the sleep-bell for ${lane} (session ${String(sess?.sessionId ?? sess).slice(0, 8)}…)`),
    closePid: (pid) => say(`close panel pid ${pid}`),
    killAndWait: (pid) => { say(`close panel pid ${pid} (and wait)`); return true; },
    emergencyFold: (lane, sid) => { say(`orphan-fold ${lane} (session ${String(sid).slice(0, 8)}…)`); return true; },
    launchWake: (lane) => say(`launch a Terminal wake for ${lane}`),
    log: (line) => console.log(`[decision] ${line}`),
  };
  const lanes = armedLanes();
  console.log(`config file: ${CFG.__configFile ?? '(defaults)'}`);
  console.log(`armed file parses as: [${lanes.join(', ') || 'DISARMED'}] (raw: ${JSON.stringify(readFileSync(ARMED_FILE, 'utf8').slice(0, 60))})`);
  console.log(`window: sleep ${SLEEP_HOUR} wake ${WAKE_HOUR} (${CFG.timezone}); now minute ${nowMin()}`);
  for (const lane of lanes) {
    const nw = join(WAKECYCLE, `next-wake.${lane}.json`);
    console.log(existsSync(nw)
      ? `next-wake.${lane}.json: ${Math.round((Date.now() - statSync(nw).mtimeMs) / 3600_000)}h old`
      : `next-wake.${lane}.json: MISSING`);
  }
  const live = liveSessions();
  console.log(`live sessions: ${live.length ? live.map((s) => `${String(s.sessionId).slice(0, 8)}…→${laneOf(s.sessionId) ?? '?'}`).join(', ') : '(none)'}`);
  // Added 10/25 (lines only; the frozen vocabulary above stays): the version wake.sh
  // would run, against the versions that have woken on a folded tail. Amber, never red.
  const claudeIo = claudeVersionIo({ claudeBin: CFG.paths.claudeBin, wakeCostsPath: CFG.paths.wakeCosts });
  for (const line of [...claudeVersionLines(claudeIo), ...flagLines(claudeIo), ...nodeLines(nodeRealIo({ machineryDir: MACHINERY_DIR }))]) console.log(line);
  tickWith(preflightIo);
  console.log('preflight complete — nothing was touched.');
  process.exit(0);
}

LIVE_EMIT = true; // past every bench exit; the stream is real from here
log(`nightshift up — sleep ${SLEEP_HOUR} → wake ${WAKE_HOUR} (${CFG.timezone}, wrap-aware), quiet ${QUIET_MS / 60000}m, armed: [${armedLanes().join(', ') || 'DISARMED'}]`);
emitEvent('daemon-up', { sleep: SLEEP_HOUR, wake: WAKE_HOUR, armed: armedLanes() });
// Hourly liveness: a dead daemon and a quiet night must not look identical
// in the stream (emitter review + skin ask — 'down' observed, not inferred).
let lastAliveEmit = Date.now();
setInterval(() => {
  if (Date.now() - lastAliveEmit >= 3600_000) {
    lastAliveEmit = Date.now();
    emitEvent('daemon-alive', { armed: armedLanes() });
  }
}, 60_000).unref();
tick();
setInterval(tick, POLL_MS);
