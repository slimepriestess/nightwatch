// codexlane.mjs — what the nightshift needs to see and ring a codex lane (anima_dev/nightwatch_codex_lane_plan.md,
// leg 2b). The nightshift's own readers are Claude Code's: its live sessions come from Claude Code's sockets and status
// files, and its quiet from a Claude transcript, so a codex session would never read as up and would read as quiet
// forever. This module answers the same three questions for a codex session, from the codex side:
//   - live: the hub's registry (wakecycle/lane.<sessionId>, written by register-lane.sh from Codex's SessionStart)
//     names the session, its pid is alive, and that pid's command is a codex SESSION, never the app-server daemon
//     (which outlives the session it served: leg 2's end-to-end, 11/24);
//   - quiet: how long the session's rollout file under its lane's CODEX_HOME has gone unwritten;
//   - the bell: `codex queue --thread <id>` with the lane's CODEX_HOME, and ONLY to a live session (Ra, 11/23: a queued
//     message to a session nobody runs would wait to reach some later one; never `--resume`). The message is user-role
//     in Codex, so it carries a machine prefix saying who sent it (Ra: user-role is fine when flagged, as AGENTS.md is).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const expandHome = (p) => String(p).replace(/^~(?=\/)/, homedir());

/** The rollout for a session id under <codexHome>/sessions (sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl), newest
 *  name first; a compressed one (.jsonl.zst) is returned as found. null when there is none. */
export function findRollout(codexHome, sid) {
  const root = join(expandHome(codexHome), 'sessions');
  const hits = [];
  const walk = (d, depth) => {
    let es = [];
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory() && depth < 3) walk(join(d, e.name), depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && (e.name.endsWith(`-${sid}.jsonl`) || e.name.endsWith(`-${sid}.jsonl.zst`))) hits.push(join(d, e.name));
    }
  };
  walk(root, 0);
  return hits.sort().pop() ?? null;
}

/** Is this command line a codex session: its executable is codex, and it isn't the app-server daemon. */
export function isCodexSession(command) {
  const cmd = String(command ?? '').trim();
  return basename(cmd.split(/\s+/)[0] ?? '') === 'codex' && !/\sapp-server(\s|$)/.test(cmd);
}

const psCommand = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// When the process began, epoch ms (`ps -o lstart=`: local time, to the second); null when ps can't say.
const psStarted = (pid) => { try { const t = Date.parse(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()); return Number.isFinite(t) ? t : null; } catch { return null; } };
// lstart is to the second, and the hook writes `at` to the second just after the process started
const START_SLACK_MS = 5_000;

/** The codex sessions this hub registered that are running now: [{pid, sessionId, provider: 'codex', at}]. A row's pid
 *  counts only while it runs a codex session that began no later than the row was written: the registry keeps past
 *  entries, and a pid recycled onto ANOTHER codex session would otherwise read as this one (Sonnet's #89 read). Two
 *  rows on one pid (a second session in the same process): the newest row is the session. */
export function codexLiveSessions(wakecycle, { commandOf = psCommand, alive = isAlive, startedOf = psStarted } = {}) {
  const byPid = new Map();
  let files = [];
  try { files = readdirSync(wakecycle).filter((f) => f.startsWith('lane.')); } catch { return []; }
  for (const f of files) {
    let e;
    try { e = JSON.parse(readFileSync(join(wakecycle, f), 'utf8')); } catch { continue; }
    if (e?.provider !== 'codex') continue;
    const pid = Number(e.pid), at = Date.parse(e.at);
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(at) || !alive(pid)) continue;
    if (!isCodexSession(commandOf(pid))) continue;
    const started = startedOf(pid);
    if (started === null || started > at + START_SLACK_MS) continue;   // a process younger than its row is another one
    const prev = byPid.get(pid);
    if (!prev || at > prev.at) byPid.set(pid, { pid, sessionId: f.slice('lane.'.length), provider: 'codex', at });
  }
  return [...byPid.values()];
}

/** What a codex lane's bell does: queue it, skip it (the session isn't running: Ra, 11/23, never to a session nobody
 *  runs), or fail (no codexHome to queue in). `live` is codexLiveSessions' answer, read at the queue. */
export function codexBellPlan({ sessionId, codexHome, live }) {
  if (!live.some((s) => s.sessionId === sessionId)) return { act: 'skip', why: 'not-live' };
  if (!codexHome) return { act: 'fail', why: 'no codexHome' };
  return { act: 'queue' };
}

/** How long the session's rollout has gone unwritten, in ms; null when no rollout is found (unknown, not quiet). */
export function codexQuietMs(codexHome, sessionId, now = Date.now()) {
  const p = findRollout(codexHome, sessionId);
  if (!p) return null;
  try { return Math.max(0, now - statSync(p).mtimeMs); } catch { return null; }
}

export const BELL_PREFIX = '[nightwatch bell, sent by the machinery]';

/** The codex to run: the configured one, else the one beside this node (the npm install puts it there, and launchd's
 *  PATH has neither), else PATH's. */
export function codexBinFor(configured, nodePath = process.execPath) {
  if (configured && existsSync(expandHome(configured))) return expandHome(configured);
  const beside = join(dirname(nodePath), 'codex');
  return existsSync(beside) ? beside : 'codex';
}

/** Queue a bell to a codex session's thread. The caller has checked the session is live. */
export function queueBell({ codexBin, codexHome, sessionId, text, nodePath = process.execPath, run = spawnSync }) {
  const env = { ...process.env, CODEX_HOME: expandHome(codexHome), PATH: `${dirname(nodePath)}:${process.env.PATH ?? ''}` };
  const r = run(codexBin, ['queue', '--thread', sessionId, '--message', `${BELL_PREFIX} ${text}`], { env, encoding: 'utf8', timeout: 10_000 });   // inside the tick: a hung codex holds the night
  return { ok: r.status === 0, status: r.status ?? null, error: r.error?.message ?? null, stderr: String(r.stderr ?? '').trim().slice(-300) };
}

/**
 * Leg 3's witness: did a codex wake's head carry its checkpoint, and is it the only head? Read from the woken rollout
 * itself, after its first turn. wake.sh hands Codex the head as `-c developer_instructions=<the file's text>`, and
 * Codex records it as one developer content part, byte for byte (codex debug prompt-input, 11/25). Presence alone is
 * not enough: in leg 3's probe a rollout held the checkpoint beside a doubled head (an old one kept by the fold) and the
 * model answered, twice, that it had none. So the witness asks two things:
 *   - the saved head appears as an exact developer content part in the rows the wake appended (index >= appendedFrom,
 *     the fold's kept count);
 *   - the file holds exactly one head: one additional_tools item and one full world_state (counted in rows and inside
 *     compacted replacement histories). On every good wake of the probe both were 1; on the doubled one, both 2.
 * Returns { status: 'pending' | 'ok' | 'missing' | 'doubled', ... }; 'pending' until the appended rows hold a finished
 * turn. 'doubled' outranks 'missing': a doubled head is the case where presence lies.
 */
export function codexHeadWitness({ rows, appendedFrom, head }) {
  const appended = rows.slice(appendedFrom);
  const done = appended.some((r) => r?.type === 'event_msg' && r.payload?.type === 'task_complete');
  if (!done) return { status: 'pending' };
  const devParts = (it) => (it?.type === 'message' && it.role === 'developer' && Array.isArray(it.content)
    ? it.content.map((c) => c?.text).filter((t) => typeof t === 'string') : []);
  const seen = appended.filter((r) => r?.type === 'response_item').flatMap((r) => devParts(r.payload)).filter((t) => t === head).length;
  let tools = 0;
  let fullStates = 0;
  for (const r of rows) {
    if (r?.type === 'world_state' && r.payload?.full === true) fullStates++;
    const items = r?.type === 'response_item' ? [r.payload]
      : r?.type === 'compacted' && Array.isArray(r.payload?.replacement_history) ? r.payload.replacement_history : [];
    for (const it of items) if (it?.type === 'additional_tools') tools++;
  }
  const facts = { seen, tools, fullStates };
  if (tools > 1 || fullStates > 1) return { status: 'doubled', ...facts };
  if (seen === 0) return { status: 'missing', ...facts };
  return { status: 'ok', ...facts };
}
