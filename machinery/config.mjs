#!/usr/bin/env node
/**
 * Nightwatch config — one file, one truth (item E).
 *
 * Every piece of the wake machinery (nightshift.mjs, sleep.mjs, trim.mjs,
 * wake.sh, register-lane.sh) reads its paths and knobs from here instead of
 * carrying its own copy. The 10/5 wake failure is the reason this file
 * exists: two files both plausibly named "the checkpoint" lived at two
 * plausible paths, a 2am session archived the live one, and both lanes
 * burned every launch attempt. A path that two scripts must agree on
 * belongs in one place with one name.
 *
 * Resolution order, least to most specific:
 *   1. DEFAULTS below (what every hub starts from; they name no hub),
 *   2. the config file $NIGHTWATCH_CONFIG (or $WEFT_CONFIG) names. With none
 *      named there is no hub: loadConfig() refuses, and only the viewer runs
 *      on hublessConfig(),
 *   3. environment variables (the pre-E spellings keep working),
 *   4. explicit CLI flags on the individual tools (--lane, --target-tokens).
 *
 * Shell consumers use the CLI:
 *   node config.mjs get paths.checkpoint     → one value, one line
 *   node config.mjs get lanes.fable.targetTokens
 *   node config.mjs show                     → full resolved config (JSON)
 *   node config.mjs doctor                   → path existence report, exit 1 on a miss
 */
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();

/** This machine's time zone (the IANA name, as the OS reports it): the default a hub's bell and wake are read in. A
 *  hub's config pins its own (Set up writes this machine's), so moving a laptop across zones doesn't move its night. */
export const machineZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** What every hub starts from: one lane and the schedule this house proved
 *  across its first clean cycles. No hub root: a config's own folder is its
 *  hub (loadConfigFrom), and with no config named there is no hub at all
 *  (loadConfig refuses; the viewer asks for hublessConfig). Nothing here
 *  names any one house's folders (issue #7). */
export const DEFAULTS = {
  weftRoot: null,
  // the machine's own zone, never one house's (a hub in Berlin rang its bell at 02:00 Pacific)
  timezone: machineZone(),
  schedule: {
    sleep: '02:00',
    wake: '08:00',
    quietMs: 2 * 60_000,
    pollMs: 60_000,
    wakeRetries: 3,
    wakeConfirmMs: 5 * 60_000,
    orphanQuietMs: 20 * 60_000,
    orphanGraceMs: 45 * 60_000,
    windowGapMs: 16 * 3600_000,
    // Sleep now with less than this many tokens left in the window folds
    // without a bell: the ritual a bell asks for needs room (at 98% the note
    // pushed a session to 100%, where it could answer nothing, nightwatch#56).
    // Tokens, not a share: the ritual's own growth, measured over 114 sleep
    // bells (Sonnet's read of #58), is a median 8,475 and at most 23,405
    // tokens, the same on any window; this is about 1.5x that maximum.
    sleepNowRoomTokens: 35_000,
  },
  models: {
    bell: 'claude-haiku-4-5-20251001',
  },
  defaultLane: 'main',
  lanes: {
    main: { targetTokens: 250_000, switchboard: true },
  },
  // The stuck/spiral watch (watch.mjs, its own daemon per hub). Defaults are
  // the calibrations this house paid for: two exhausted-retry error lines
  // with the newest still an error is a spiral (Ra, 9/30; each line is ~10
  // retries); context warns at 85% of the window and re-arms below 80%.
  watch: {
    pollMs: 60_000,
    spiralWindowMs: 60 * 60_000,
    spiralThreshold: 2,
    spiralCooldownMs: 30 * 60_000,
    classifierWindowMs: 30 * 60_000,
    classifierThreshold: 2,
    waitingMs: 15 * 60_000,
    contextWarn: 0.85,
    contextRearm: 0.80,
    // A wake whose first request is this share of the window warns (amber, no
    // banner): the ladder and system prompt the fold can't trim keep growing.
    // 0 turns it off.
    wakeCostWarn: 0.5,
    // A woken session whose recorded system prompt carries less than this share of
    // the checkpoint's lines is told (amber): the snapshot flag may have stopped
    // working. 0 turns the event off (the share is still recorded).
    headMatchWarn: 0.9,
    // TRANSITIONAL (Ra, 10/12), not policy: amber is the agent's normal
    // operating stream and never needs the keeper, so amber alerts don't
    // notify. While the house is still being built, a lane WITHOUT the midday
    // cycle has no automatic answer to a filling context; its keeper still is
    // one, so its amber context warning leaks a notification. Set false for the
    // doctrine as ruled; remove once every lane cycles.
    notifyAmberUncycled: true,
  },
  // Where a watch alert goes besides the app's own card (events.jsonl, always
  // written). macos: a Notification Center banner. command: an executable
  // (no shell) run per alert with the message on stdin and NIGHTWATCH_ALERT_*
  // in its environment; how a house wires a chat DM, a pager, anything.
  notify: {
    macos: true,
    command: '',
  },
  viewer: {
    // The GUI's HTTP port. 7350 is the code default's history; 7352 is ours
    // because 7350 is squatted by a long-lived local service (bun, 9/2).
    // NIGHTWATCH_PORT still overrides for one-off runs.
    port: 7352,
  },
  paths: {
    // Relative entries resolve against weftRoot; absolute entries stand.
    checkpoint: 'checkpoint.md', // THE canonical checkpoint. The only one.
    ladder: 'ladder',
    folds: 'ladder/folds.jsonl',
    wakecycle: 'wakecycle',
    nightshiftLog: 'nightshift.log',
    events: 'events.jsonl', // machine-readable twin of the log; the GUI's API
    watchLog: 'watch.log',
    watchState: 'wakecycle/watch-state.json',
    // Each wake's real first request beside its fold's estimate (watch.mjs),
    // joinable with folds.jsonl by tail: the estimate's nightly calibration.
    wakeCosts: 'ladder/wake-costs.jsonl',
    // Claude Code's live session status files (pid, sessionId, status).
    sessions: join(HOME, '.claude', 'sessions'),
    armedFile: 'wakecycle/nightshift.armed',
    stateFile: 'wakecycle/nightshift.state.json',
    spool: 'doorbell/spool',
    // The watch's due notes (segment-due, l3-due): apart from the spool, so a
    // note that waits for a seam never silences a watcher (bell-watcher.sh).
    due: 'doorbell/due',
    // Claude Code keeps a project's transcripts in a folder named after the
    // folder it runs in (transcriptsFor). Unset, it's derived from workdir
    // when a config loads, so the two can't drift apart.
    transcripts: null,
    // The hub's own copy of every folded session (archive.mjs): the ladder's
    // jsonl: sources, kept where Claude Code's cleanup can't reach them.
    transcriptArchive: 'archive/transcripts',
    claudeBin: join(HOME, '.local', 'bin', 'claude'),
    // The directory sessions launch in (their project dir). A hub works from
    // itself unless its config says otherwise (ours says ~/origin).
    // Unset, it's the hub's own folder (loadConfigFrom), as Set up writes it.
    workdir: null,
    // Where the machinery CODE lives. 'wakecycle' (relative to weftRoot) is
    // the sealed layout — code beside state, our legacy hub. Set up points
    // new hubs at the installed app's machinery/ (absolute), one version
    // for every hub (multi-persona plan, 10/7).
    machinery: 'wakecycle',
    // Claude Code's per-session sockets: /tmp on macOS, the user's runtime
    // dir on Linux/WSL (seen 10/16: /run/user/1000/cc-socks). The viewer's
    // liveness reads it; pointed at /tmp on Linux every lane read "waking".
    sockDir: process.platform === 'linux'
      ? join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'cc-socks')
      : '/tmp/cc-socks',
    bridgeSockDir: join(HOME, '.claude', 'mcpl-bridge'),
  },
};

function deepMerge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Env overrides keep their pre-E spellings so an existing launchd plist or
 *  shell profile keeps working unchanged. */
function applyEnv(cfg) {
  const env = process.env;
  if (env.WEFT_NIGHT_SLEEP) cfg.schedule.sleep = env.WEFT_NIGHT_SLEEP;
  if (env.WEFT_NIGHT_WAKE) cfg.schedule.wake = env.WEFT_NIGHT_WAKE;
  if (env.WEFT_NIGHT_QUIET_MS) cfg.schedule.quietMs = Number(env.WEFT_NIGHT_QUIET_MS);
  if (env.WEFT_ORPHAN_QUIET_MS) cfg.schedule.orphanQuietMs = Number(env.WEFT_ORPHAN_QUIET_MS);
  if (env.WEFT_ORPHAN_GRACE_MS) cfg.schedule.orphanGraceMs = Number(env.WEFT_ORPHAN_GRACE_MS);
  if (env.WEFT_NIGHT_BELL_MODEL) cfg.models.bell = env.WEFT_NIGHT_BELL_MODEL;
  if (env.WEFT_CLAUDE_BIN) cfg.paths.claudeBin = env.WEFT_CLAUDE_BIN;
  return cfg;
}

let cached = null;
/** Bust the cache and re-read — the daemon's hot reload (10/6): the app
 *  writes weft.config.json and a boot-frozen schedule would ignore it
 *  until the next crash-restart. */
export function reloadConfig() {
  cached = null;
  return loadConfig();
}
/**
 * The hub config the environment names. NIGHTWATCH_CONFIG is the name;
 * WEFT_CONFIG is read too, permanently: installed jobs, hooks, units and the
 * ritual lines in checkpoints and bell notes carry it, and nothing rewrites
 * them (issue #7). Both set to the same file (compared by real path) is
 * fine, as every migration passes through it. Both set to different files
 * is refused, naming both: a precedence rule would hide a split. '' counts
 * as unset. Returns the path, or undefined.
 */
export function configEnv(env = process.env) {
  const a = env.NIGHTWATCH_CONFIG || undefined;
  const b = env.WEFT_CONFIG || undefined;
  if (a && b && a !== b) {
    const real = (p) => { try { return realpathSync(p); } catch { return p; } };
    if (real(a) !== real(b)) {
      throw new Error(`NIGHTWATCH_CONFIG (${a}) and WEFT_CONFIG (${b}) name different files; set one, or both to the same file`);
    }
  }
  return a ?? b;
}

/** An environment for a child that names this config: the new name set, the
 *  old one dropped, so the child never sees two spellings of one file. */
export function envWithConfig(file, env = process.env) {
  const { WEFT_CONFIG, ...rest } = env;
  return file ? { ...rest, NIGHTWATCH_CONFIG: file } : rest;
}

/** The hub config, or null when none is named. The one reader that may
 *  run without a hub (the viewer, before anything is set up) asks this; every
 *  other caller asks loadConfig(), which refuses. */
export function loadConfigOrNone() {
  if (cached) return cached;
  // A config named but unusable is an ERROR, never a fallback: the silent
  // DEFAULTS fallback meant a typo'd path quietly acted on OUR hub, and on a
  // fresh machine pointed at nothing (opus's lane-creation read, 10/7).
  // '' counts as unset (an empty env assignment is how "no config" looks in
  // shell), but a non-empty path must exist.
  const envFile = configEnv();
  if (envFile !== undefined && !existsSync(envFile)) {
    throw new Error(`${process.env.NIGHTWATCH_CONFIG ? 'NIGHTWATCH_CONFIG' : 'WEFT_CONFIG'} points at a missing file: ${envFile}`);
  }
  // NIGHTWATCH_CONFIG (or WEFT_CONFIG) names the hub; nothing else does.
  // There is no lookup in a default folder and no machine-wide fallback: a
  // script run outside every hub without a config named gets no hub, never
  // whichever hub this machine happens to hold, so a bench can't land on a
  // real hub by omission (issues #5 and #7). The registry lists hubs for the
  // viewer; it never chooses one for a script.
  if (envFile === undefined) return null;
  cached = loadConfigFrom(envFile);
  return cached;
}
export function loadConfig() {
  const cfg = loadConfigOrNone();
  if (!cfg) {
    throw new Error("no hub config named: set NIGHTWATCH_CONFIG to your hub's nightwatch.config.json (Set up writes one into every hub)");
  }
  return cfg;
}

/**
 * Resolve EXACTLY this config file: no cache, no env override, no fallback
 * chain. The multiplexer loads N hubs in one process through this (opus,
 * 10/7); loadConfig() delegates here so there is one resolver. Relative
 * paths resolve against the file's weftRoot — or, when the file names no
 * weftRoot, against the file's own folder (a hub's config sits in its hub).
 */
export function loadConfigFrom(file) {
  let cfg = structuredClone(DEFAULTS);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // A torn config must fail LOUDLY, not fall back silently: the machinery
    // would otherwise run a night on defaults that disagree with the house.
    throw new Error(`weft config at ${file} is not valid JSON: ${e.message}`);
  }
  // A config's lane list REPLACES the default single lane — merging would
  // leave a phantom "main" lane beside the real ones, and a phantom lane
  // name is exactly the class of ambiguity this file exists to kill.
  if (parsed.lanes) cfg.lanes = {};
  cfg = deepMerge(cfg, parsed);
  if (!parsed.weftRoot) cfg.weftRoot = dirname(realpathSync(file));
  cfg.__configFile = file;
  applyEnv(cfg);
  // A hub works from itself unless its config says otherwise.
  if (!cfg.paths.workdir) cfg.paths.workdir = cfg.weftRoot;
  // Resolve relative paths against weftRoot, exactly once, here.
  for (const [k, v] of Object.entries(cfg.paths)) {
    if (typeof v === 'string' && !isAbsolute(v)) cfg.paths[k] = join(cfg.weftRoot, v);
  }
  if (!cfg.paths.transcripts) cfg.paths.transcripts = transcriptsFor(cfg.paths.workdir);
  return cfg;
}

/** Claude Code's longest project-folder name before it cuts the name and adds a hash (2.1.306: `D0`/`N`). */
export const PROJECT_DIR_MAX = 200;
/** Where Claude Code keeps the transcripts of sessions run in `workdir`: a
 *  folder named after it, every character but letters and digits made a '-'
 *  (/Users/jane.doe/My Hubs/lark → -Users-jane-doe-My-Hubs-lark). A name past
 *  PROJECT_DIR_MAX is cut there and given '-' and a hash of the whole path,
 *  which this can't recompute: it finds the one folder that starts with the
 *  cut name, and until a session has made it, names the cut form (doctor
 *  says it's missing). `projects` is for tests. */
export function transcriptsFor(workdir, projects = join(HOME, '.claude', 'projects')) {
  const name = String(workdir).replace(/[^A-Za-z0-9]/g, '-');
  if (name.length <= PROJECT_DIR_MAX) return join(projects, name);
  const cut = name.slice(0, PROJECT_DIR_MAX);
  let found = [];
  try { found = readdirSync(projects).filter((d) => d.startsWith(`${cut}-`)); } catch { /* no projects folder yet */ }
  return join(projects, found.length === 1 ? found[0] : cut);
}

/** A config naming no hub, for the one reader that must run without one:
 *  the viewer on a machine with nothing set up yet, which shows Set up.
 *  Hub-relative paths are null, so nothing reads or writes a hub; the
 *  machine-wide ones (Claude Code's sockets, its binary) stand. */
export function hublessConfig() {
  // The default lane shape stays, as the viewer has always rendered a fresh
  // machine (its activity series are built per lane): with no hub's files
  // behind it, the page shows Set up.
  const cfg = structuredClone(DEFAULTS);
  cfg.__configFile = null;
  for (const [k, v] of Object.entries(cfg.paths)) if (typeof v === 'string' && !isAbsolute(v)) cfg.paths[k] = null;
  return cfg;
}

// The switchboard lane is the one whose session routes bells and DMs for
// the house (lanes[].switchboard: true). Falls back to defaultLane so a
// config without the flag still has a single answer. One truth, asked of
// the config — never a lane name spelled in a daemon (E-polish, 10/6).
// A lane's context window: its own `contextWindow`, else by the model family
// that answered. Shared by the watch and Sleep now (nightwatch#56).
export function windowForLane(cfg, lane, model) {
  const own = cfg.lanes?.[lane]?.contextWindow;
  if (own) return own;
  if (!model) return null;
  if (/haiku/.test(model)) return 200_000;
  if (/^claude-(fable|mythos|opus|sonnet)-/.test(model)) return 1_000_000;
  return null;
}

/** The newest real reply's input side against the lane's window, or null. */
export function contextOfEntries(cfg, lane, entries) {
  const reply = [...entries].reverse().find((e) => e?.type === 'assistant' && e.message?.usage && !e.isApiErrorMessage);
  const u = reply?.message?.usage;
  const window = windowForLane(cfg, lane, reply?.message?.model);
  if (!u || !window) return null;
  const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { ratio: tokens / window, tokens, window };
}

export function switchboardLane(cfg) {
  for (const [name, lc] of Object.entries(cfg.lanes)) if (lc && lc.switchboard) return name;
  return cfg.defaultLane;
}

export function laneConfig(cfg, lane) {
  const lc = cfg.lanes[lane];
  if (!lc) {
    const known = Object.keys(cfg.lanes).join(', ');
    throw new Error(`agent "${lane}" is not in the config (known: ${known}). ` +
      `Add it to ${cfg.__configFile ?? 'weft.config.json'} or pass a known agent.`);
  }
  return { targetTokens: 250_000, switchboard: false, ...lc };
}

/**
 * Why wake.sh would refuse this wakePrompt, or null if it is fine. THE one
 * implementation: wake.sh's inline snippet, creation (nightwatch.mjs), the
 * set verb (typeCheck below) and the preflight's wakePromptLines
 * (versioncheck.mjs) all call it, so the rules cannot drift apart.
 */
export function wakePromptProblem(v) {
  if (typeof v !== 'string') return `it is ${Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : 'a ' + typeof v}, not text`;
  if (!v.trim()) return 'it is empty (use null for "no prompt")';
  if (/^\s*-/.test(v)) return 'it starts with "-", which claude would read as a flag';
  if (!/\s/.test(v.trim())) return 'it is a single bare word, which claude could run as a subcommand';
  return null;
}

// ------------------------------------------------------------- set / unset
// The app's save buttons call these (Nightwatch write side, 10/6): edits go
// to the CONFIG FILE (the overrides), never the resolved config. Atomic
// (tmp + rename), whitelisted key paths, per-key type checks, and the
// loader's own consistency rules re-checked on the RESULT before a byte
// lands — a config this machinery can't boot from must be unwritable.
const LANE_KEYS = {
  targetTokens: 'number', emergencyTargetTokens: 'number', contextWindow: 'number',
  switchboard: 'boolean', cwdMarker: 'string', runtime: 'string', modelName: 'string',
  // The pinned model id (exact, e.g. claude-opus-5-5): every wake passes it,
  // so the model never changes out from under the agent (Ra's ruling 2,
  // 10/6). modelName above stays the human-facing display label.
  model: 'string',
  // The first prompt a wake sends (wake.sh): present = the woken session
  // starts its own morning. Absent = no prompt, the session waits for a human.
  // Its own spec type: the set verb must refuse what wake.sh would (a value
  // that lands by `set` and dies at 08:00 costs a silent morning).
  wakePrompt: 'wakePrompt',
  schedule: { sleep: 'time', wake: 'time' },
  // The midday cycle (Ra, 10/12): present = on for this lane. A soft bell at
  // softPct of the window (no timer: the agent's own fold is its "ready"),
  // an urgent one at urgentPct that forces the fold after urgentMin.
  middayCycle: { softPct: 'number', urgentPct: 'number', urgentMin: 'number' },
  // The segment-due note (watch.mjs): present = on for this lane, ringing
  // once per this many tokens of growth. Absent = off.
  segmentNoteEveryTokens: 'number',
};
const ALLOWED = {
  weftRoot: 'string', timezone: 'string', defaultLane: 'string',
  // pronouns: only ever set by the persona themself (Ra, 10/8: nobody assigns them).
  persona: { name: 'string', pronouns: 'string' },
  schedule: Object.fromEntries(Object.keys(DEFAULTS.schedule).map((k) => [k, k === 'sleep' || k === 'wake' ? 'time' : 'number'])),
  models: { bell: 'string' },
  // l3HorizonDays: the l3-due note (watch.mjs), off unless set. It isn't in
  // DEFAULTS.watch because absent is how "off" reads there.
  watch: { ...Object.fromEntries(Object.keys(DEFAULTS.watch).map((k) => [k, 'number'])), l3HorizonDays: 'number' },
  notify: { macos: 'boolean', command: 'string' },
  viewer: { port: 'number' },
  paths: Object.fromEntries(Object.keys(DEFAULTS.paths).map((k) => [k, 'string'])),
  lanes: { '*': LANE_KEYS },
};

function keySpec(parts) {
  let node = ALLOWED;
  for (const p of parts) {
    if (typeof node !== 'object' || node === null) return null; // deeper than the schema goes
    node = node[p] ?? node['*'];
    if (node === undefined) return null;
  }
  return node; // a type string, or an object (settable wholesale for lanes)
}

function typeCheck(spec, value, path) {
  if (typeof spec === 'object') {
    // An object key (a whole lane, a lane's schedule): validate each member.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} takes an object`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = spec[k] ?? spec['*'];
      if (sub === undefined) throw new Error(`unknown key ${path}.${k}`);
      typeCheck(sub, v, `${path}.${k}`);
    }
    return;
  }
  if (spec === 'time') {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new Error(`${path} takes "HH:MM" (24h), got ${JSON.stringify(value)}`);
    }
  } else if (spec === 'wakePrompt') {
    const why = wakePromptProblem(value);
    if (why) throw new Error(`${path}: wake.sh would refuse this (${why})`);
  } else if (typeof value !== spec) {
    throw new Error(`${path} takes a ${spec}, got ${JSON.stringify(value)}`);
  }
}

/** The consistency rules a written file must satisfy — the same ones doctor
 *  shouts about, enforced BEFORE the write instead of at 2am. */
function assertConsistent(raw) {
  const lanes = raw.lanes ?? DEFAULTS.lanes;
  const names = Object.keys(lanes);
  if (names.length === 0) throw new Error('refusing: the config would declare no agents');
  const dl = raw.defaultLane ?? DEFAULTS.defaultLane;
  if (!names.includes(dl)) throw new Error(`refusing: defaultLane "${dl}" would not be a configured agent (${names.join(', ')})`);
}

export function configEdit(op, keyPath, value) {
  const file = configEnv();
  if (!file) throw new Error("no hub config named: set NIGHTWATCH_CONFIG to the hub's config file to edit it");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const parts = keyPath.split('.');
  if (op === 'set') {
    const spec = keySpec(parts);
    if (spec === null || spec === undefined) throw new Error(`unknown key: ${keyPath}`);
    typeCheck(spec, value, keyPath);
    let node = raw;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts[parts.length - 1]] = value;
  } else { // unset
    if (keySpec(parts) === null) throw new Error(`unknown key: ${keyPath}`);
    let node = raw;
    const walk = [];
    for (const p of parts.slice(0, -1)) {
      if (node?.[p] === undefined) return file; // nothing to unset
      walk.push([node, p]);
      node = node[p];
    }
    delete node[parts[parts.length - 1]];
    // Prune now-empty parents so "unset lanes.x.schedule" leaves no husk.
    for (let i = walk.length - 1; i >= 0; i--) {
      const [parent, key] = walk[i];
      if (typeof parent[key] === 'object' && parent[key] !== null && Object.keys(parent[key]).length === 0) delete parent[key];
    }
  }
  assertConsistent(raw);
  const tmp = join(dirname(file), `.weft.config.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------- CLI mode
// Real-path identity, not a basename suffix match: a suffix match runs the
// CLI inside any importer that happens to be named config.mjs, and — worse —
// goes silent when invoked through a differently-named symlink, which hands
// wake.sh an empty value under set -e (E review, finding 5).
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* argv[1] unresolvable — a module import, not a CLI call */ }
if (invokedDirectly) {
  const [cmd, arg] = process.argv.slice(2);
  // with no hub named, say so in words (doctor is what a fresh install runs first), never as a stack trace
  if (!loadConfigOrNone()) {
    console.error("No hub config named. Set NIGHTWATCH_CONFIG to your hub's nightwatch.config.json (Set up writes one into every hub), then run this again.");
    process.exit(2);
  }
  const cfg = loadConfig();
  if (cmd === 'get' && arg) {
    const val = arg.split('.').reduce((o, k) => (o ?? {})[k], cfg);
    if (val === undefined) {
      console.error(`no such key: ${arg}`);
      process.exit(1);
    }
    console.log(typeof val === 'object' ? JSON.stringify(val) : String(val));
  } else if (cmd === 'show') {
    console.log(JSON.stringify(cfg, null, 2));
  } else if (cmd === 'doctor') {
    let bad = 0;
    for (const [k, p] of Object.entries(cfg.paths)) {
      if (k === 'sockDir' || k === 'bridgeSockDir' || k === 'events' || k === 'transcriptArchive') continue; // runtime-created
      const ok = existsSync(p);
      console.log(`${ok ? 'ok     ' : 'MISSING'} paths.${k} = ${p}`);
      if (!ok) bad++;
    }
    // Lane-consistency asserts (E review, finding 6): each of these turns a
    // 2am throw inside the ritual into a config-time one-liner.
    const laneNames = Object.keys(cfg.lanes);
    if (laneNames.length === 0) { console.log('BAD     lanes: config declares no agents'); bad++; }
    if (!laneNames.includes(cfg.defaultLane)) {
      console.log(`BAD     defaultLane "${cfg.defaultLane}" is not a configured agent (${laneNames.join(', ') || 'none'})`);
      bad++;
    }
    try {
      const armed = readFileSync(cfg.paths.armedFile, 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      for (const a of armed) {
        if (!laneNames.includes(a)) { console.log(`BAD     armed agent "${a}" is not in the config — its 02:00 fold would throw`); bad++; }
      }
    } catch { /* nothing armed — fine */ }
    console.log(`config file: ${cfg.__configFile ?? '(none — single-lane defaults)'}`);
    console.log(`lanes: ${laneNames.join(', ')} (default: ${cfg.defaultLane})`);
    process.exit(bad ? 1 : 0);
  } else if ((cmd === 'set' || cmd === 'unset') && arg) {
    // set <key> <json-or-string> | unset <key> — the app's save buttons.
    try {
      let value;
      if (cmd === 'set') {
        const rawVal = process.argv[4];
        if (rawVal === undefined) { console.error('set needs a value'); process.exit(2); }
        try { value = JSON.parse(rawVal); } catch { value = rawVal; } // bare strings welcome
      }
      const file = configEdit(cmd, arg, value);
      console.log(`${cmd} ${arg} → ${file}`);
    } catch (e) {
      console.error(`refused: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error('usage: config.mjs get <dot.path> | show | doctor | set <key> <value> | unset <key>');
    process.exit(2);
  }
}
