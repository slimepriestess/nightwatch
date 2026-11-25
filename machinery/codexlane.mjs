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

/** A registry entry's provider, or null when the hub never registered the session. */
export function registeredProvider(wakecycle, sessionId) {
  try { return JSON.parse(readFileSync(join(wakecycle, `lane.${sessionId}`), 'utf8')).provider ?? 'claude-code'; } catch { return null; }
}

/** The codex sessions this hub registered that are running now: [{pid, sessionId, provider: 'codex'}]. */
export function codexLiveSessions(wakecycle, { commandOf = psCommand, alive = isAlive } = {}) {
  const out = [];
  let files = [];
  try { files = readdirSync(wakecycle).filter((f) => f.startsWith('lane.')); } catch { return out; }
  for (const f of files) {
    let e;
    try { e = JSON.parse(readFileSync(join(wakecycle, f), 'utf8')); } catch { continue; }
    if (e?.provider !== 'codex') continue;
    const pid = Number(e.pid);
    if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) continue;
    // a recycled pid is some other program by now: only a codex session's command counts (the registry keeps past entries)
    if (!isCodexSession(commandOf(pid))) continue;
    out.push({ pid, sessionId: f.slice('lane.'.length), provider: 'codex' });
  }
  return out;
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
  const r = run(codexBin, ['queue', '--thread', sessionId, '--message', `${BELL_PREFIX} ${text}`], { env, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, status: r.status ?? null, error: r.error?.message ?? null, stderr: String(r.stderr ?? '').trim().slice(-300) };
}
