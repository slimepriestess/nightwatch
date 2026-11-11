/**
 * Doctor's Claude Code version check (item 1 of the compatibility guard).
 *
 * The question: has the version wake.sh would run ever woken on a folded
 * tail? Wake-cost rows carry the `version` of the session that woke (watch.mjs,
 * #41), so the answer is set membership against those rows. Never red: a
 * version no wake has run is not broken, the output check in trim.mjs (#30)
 * is the gate, and red stays the word for "something is wrong now". Before
 * any row carries a version (a fresh hub, or the days before the first wake
 * after #41) there is nothing to compare, and that is said neutrally.
 *
 * The binary is resolved the way wake.sh does (paths.claudeBin when it is
 * there and executable, else the PATH's `claude`) and the path is named in the
 * line, because a Doctor that checks a different binary than the wakes run is a
 * green about something else (the 10/16 trap: a shell's claude is not
 * necessarily the one the wakes use).
 *
 * When paths.claudeBin isn't usable, the fallback has to look `claude` up the
 * way the wake WINDOW's shell does, not Doctor's: on macOS the window is
 * Terminal's interactive login shell (`$SHELL -ilc`), which reads ~/.zshrc,
 * where ~/.local/bin usually goes on PATH; `sh -lc` and `zsh -lc` do not, and
 * on this machine find the old Homebrew cask (2.1.267) instead of the live
 * 2.1.310 (Opus measured it, 10/25). On Linux and WSL the window runs
 * `sh -lc` with the node and configured-claude directories prefixed
 * (platform.mjs withToolPath). The line says which shell looked.
 *
 * Line words follow the preflight's frozen vocabulary where one fits and add
 * two: `ok`, and `WARN` (amber) / `note` (neutral). Pure functions, I/O
 * injected, so the tests need no real claude.
 *
 * Written by: claude-sonnet-5-5, 2026-10-25.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platformKind, daemonJob } from './platform.mjs';

/**
 * The command that finds `claude` the way the wake window's shell would.
 * Pure: returns { bin, args, label }. `label` is what the Doctor line says
 * about who looked, so it never implies more fidelity than it has.
 */
export function lookupCommand({ kind = platformKind(), shell = process.env.SHELL, nodePath = process.execPath, claudeBin } = {}) {
  if (kind === 'darwin') {
    const bin = shell && shell.startsWith('/') ? shell : '/bin/zsh';
    return { bin, args: ['-ilc', 'command -v claude'], label: `looked up by \`${bin.split('/').pop()} -ilc\`, the shell Terminal's wake window runs` };
  }
  if (kind === 'linux' || kind === 'wsl') {
    const dirs = [...new Set([dirname(nodePath), ...(claudeBin ? [dirname(claudeBin)] : [])])];
    return { bin: '/bin/sh', args: ['-lc', `PATH="${dirs.join(':')}:$PATH"; command -v claude`], label: 'looked up by `sh -lc` with the node and configured-claude directories first, as the wake window runs' };
  }
  return { bin: '/bin/sh', args: ['-lc', 'command -v claude'], label: "PATH as Doctor's shell sees it (not necessarily the wake window's)" };
}

/** wake.sh: the configured claude when it is there and executable, PATH's otherwise. */
export function resolveClaude({ claudeBin, isExecutable, lookupPath }) {
  if (claudeBin && isExecutable(claudeBin)) return { path: claudeBin, via: 'paths.claudeBin' };
  const found = lookupPath();
  return found ? { path: found, via: 'PATH' } : { path: null, via: null };
}

/** "2.1.310 (Claude Code)" → "2.1.310"; anything else → null. */
export function parseVersion(text) {
  const m = /^\s*(\d+\.\d+\.\d+)\b/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** The distinct `version`s on wake-cost rows, in file order. A torn line is skipped. */
export function seenVersions(jsonlText) {
  const out = [];
  for (const l of String(jsonlText ?? '').split('\n')) {
    if (!l.trim()) continue;
    let v;
    try { v = JSON.parse(l).version; } catch { continue; }
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The preflight lines. io: { claudeBin, isExecutable(path), lookupPath(),
 * runVersion(path) → stdout text | null, wakeCostsText }.
 */
export function claudeVersionLines(io) {
  const bin = resolveClaude(io);
  if (!bin.path) {
    return [`WARN    claude: no paths.claudeBin (${io.claudeBin ?? 'unset'}) that is executable, and none on this process's PATH; wake.sh looks in the same two places from its own shell, so this may be only where Doctor runs from`];
  }
  const where = `${bin.path} (via ${bin.via}${bin.via === 'PATH' && io.lookupLabel ? `; ${io.lookupLabel}` : ''})`;
  const out = io.runVersion(bin.path);
  const installed = parseVersion(out);
  if (!installed) {
    return [`WARN    claude ${where}: could not read a version from \`--version\` (${JSON.stringify(String(out ?? '').trim().slice(0, 60))})`];
  }
  const seen = seenVersions(io.wakeCostsText);
  if (!seen.length) {
    return [`note    claude ${installed} ${where}: no wake record carries a version yet, so there is no baseline to compare against (the first wake after the version record lands seeds it)`];
  }
  if (seen.includes(installed)) {
    return [`ok      claude ${installed} ${where} has woken on a folded tail before`];
  }
  return [`WARN    claude ${installed} ${where} has not woken on a folded tail yet (woken: ${seen.join(', ')}); not a fault, the output check is the gate`];
}

/**
 * The flags wake.sh passes, and how `claude --help` lists each. Not every flag is its own line there:
 * `--append-system-prompt-file` appears only as `--append-system-prompt[-file]` in the --bare text (checked
 * 10/25 on 2.1.310 against a working install), so a naive "is every flag listed" would WARN on a healthy
 * machine. It is checked as the family name, and the line says so.
 *
 * A flag counts only where it is DEFINED: in the option column, which commander indents by 2 (optionally
 * after a short alias, as in `-r, --resume [value]`). Description text wraps onto continuation lines indented
 * by ~40, and those name flags too: on the real 2.1.310 help `--resume` leads continuation lines at 37 and 79
 * and `--append-system-prompt` at 56 and 240, so "any leading whitespace" stayed green for those two after
 * the flag itself was removed (Opus found it by deleting each definition line from the real help). Up to 6
 * columns tolerates a small format shift; a larger one makes the check WARN, which is the loud direction.
 */
const defined = (flag) => new RegExp(`^ {1,6}(?:-\\w, )?${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'm');
export const WAKE_FLAGS = [
  { flag: '--system-prompt-snapshot', re: defined('--system-prompt-snapshot') },
  { flag: '--resume', re: defined('--resume') },
  { flag: '--fork-session', re: defined('--fork-session') },
  { flag: '--model', re: defined('--model') },
  { flag: '--append-system-prompt[-file]', re: defined('--append-system-prompt') },
];

/**
 * Does the claude wake.sh would run still list the flags it passes? Offline (`--help` calls no API), so it
 * warns BEFORE 08:00 about a flag that would otherwise show up as WAKE FAILED after the launch. Amber, never
 * red; and a flag listed but ignored is not seen here at all (the head witness, in the watch, is that check).
 * io: the resolveClaude inputs plus runHelp(path) → stdout | null.
 */
export function flagLines(io) {
  const bin = resolveClaude(io);
  if (!bin.path) return []; // claudeVersionLines already said claude could not be found
  const where = `${bin.path} (via ${bin.via}${bin.via === 'PATH' && io.lookupLabel ? `; ${io.lookupLabel}` : ''})`;
  const help = io.runHelp(bin.path);
  if (!help) return [`WARN    claude ${where}: could not read \`--help\`, so the flags wake.sh passes were not checked`];
  const missing = WAKE_FLAGS.filter(({ re }) => !re.test(help)).map(({ flag }) => flag);
  if (missing.length) {
    return [`WARN    claude ${where}: \`--help\` no longer lists ${missing.join(', ')}, which wake.sh passes; a removed or renamed flag fails the wake at launch (WAKE FAILED), so this is the warning before 08:00`];
  }
  return [`ok      claude ${where}: \`--help\` still lists the flags wake.sh passes (${WAKE_FLAGS.map(({ flag }) => flag).join(', ')}; the last is listed as a family)`];
}

/**
 * The node the background jobs run on, against the floor CI certifies.
 *
 * The tests, the second reads and CI all run Node 22; the launchd/systemd jobs ran whatever the plist named
 * (Homebrew's Node 20 until 10/25). Nothing certified that runtime: a 22-only construct landing in
 * machinery code would break the daemons and not CI. This reports it, amber and never red (the daemon runs,
 * it is just uncertified), naming the binary and the job file it came from.
 *
 * The jobs are found by WHAT THEY RUN, not by label: any job file whose script is this machinery directory's
 * nightshift.mjs or watch.mjs. This house's own jobs use the legacy labels (com.weft.nightshift,
 * com.weft.spiralwatch) that daemonJob does not write for new hubs (house.nightwatch.<slug>[.watch]), and
 * this hub has no installed.json; reading by script covers both.
 *
 * NODE_FLOOR is CI's node-version (.github/workflows/linux.yml); a test fails if the two drift.
 */
export const NODE_FLOOR = 22;
const JOB_SCRIPTS = { nightshift: 'nightshift.mjs', watch: 'watch.mjs' };

/** The two quoted-or-bare words of a systemd ExecStart=, i.e. [node, script]; null if it is not that shape. */
export function parseExecWords(text) {
  const m = /^ExecStart=(.*)$/m.exec(String(text ?? ''));
  if (!m) return null;
  const words = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] ?? x[2]).replace(/%%/g, '%'));
  return words.length ? words : null;
}
export function parseExecStart(text) {
  const words = parseExecWords(text);
  return words && words.length >= 2 ? [words[0], words[1]] : null;
}

/**
 * The job files in `dir` that run this machinery's nightshift or watch, with the node each names.
 * io: { kind, dir, machineryDir, readdir(dir) → names, readFile(path) → text, readPlist(path) → argv[] | null,
 *       realpath(path) → path }.
 */
export function nodeJobs(io) {
  const want = new Map(Object.entries(JOB_SCRIPTS).map(([job, f]) => [io.realpath(join(io.machineryDir, f)), job]));
  const found = [];
  let names = [];
  try { names = io.readdir(io.dir); } catch { return found; }
  for (const name of names) {
    let argv = null;
    const file = join(io.dir, name);
    try {
      if (io.kind === 'darwin' && name.endsWith('.plist')) argv = io.readPlist(file);
      else if ((io.kind === 'linux' || io.kind === 'wsl') && name.endsWith('.service')) argv = parseExecWords(io.readFile(file));
    } catch { argv = null; }
    if (!Array.isArray(argv) || argv.length < 2) continue;
    // The script is the first word after the launcher that is one of ours: `node s.mjs`, but also
    // `/usr/bin/env node s.mjs`, where the second word is not the script.
    const at = argv.findIndex((w, i) => i > 0 && want.has(io.realpath(w)));
    if (at < 0) continue;
    const launcher = argv.slice(0, at);
    // A node that is not an absolute path (`node`, `./node`) or that goes through `env` is resolved by the
    // JOB's own PATH when it runs, not by Doctor's: running `node -v` here would report Doctor's node.
    const bare = !String(argv[0]).startsWith('/') || /(^|\/)env$/.test(argv[0]);
    found.push({ job: want.get(io.realpath(argv[at])), file: name, node: argv[0], bare, launcher: launcher.join(' ') });
  }
  return found.sort((a, b) => a.job.localeCompare(b.job) || a.file.localeCompare(b.file));
}

/** The preflight lines for the background jobs' node. io adds runNode(path) → stdout | null to nodeJobs's. */
export function nodeLines(io) {
  if (!['darwin', 'linux', 'wsl'].includes(io.kind)) return ["note    node: this platform's background job files are not read here, so the node they run is not compared with the floor"];
  const jobs = nodeJobs(io);
  if (!jobs.length) return [`note    node: no background job for this machinery (${io.machineryDir}) was found in ${io.dir}, so there is no node to compare with the floor of ${NODE_FLOOR}`];
  return jobs.map(({ job, file, node, bare, launcher }) => {
    if (bare) return `WARN    node: the ${job} job's command is \`${launcher}\` (from ${file}), which its own PATH resolves when it runs, so Doctor cannot say which node it runs; name an absolute node path in the job to check it`;
    const v = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(io.runNode(node) ?? '').trim());
    if (!v) return `WARN    node: the ${job} job's node ${node} (from ${file}) could not be run for a version`;
    const where = `node ${v[1]}.${v[2]}.${v[3]} (${node}, from ${file})`;
    return Number(v[1]) >= NODE_FLOOR
      ? `ok      node: the ${job} job runs on ${where}, at or above the ${NODE_FLOOR} floor CI certifies`
      : `WARN    node: the ${job} job runs on ${where}, below the ${NODE_FLOOR} floor CI certifies; it runs, but nothing certifies this runtime`;
  });
}

/** Real I/O for nodeLines. `kind` and `machineryDir` default to this machine and this directory. */
export function nodeRealIo({ kind = platformKind(), machineryDir = dirname(fileURLToPath(import.meta.url)), spawn = spawnSync } = {}) {
  // daemonJob is pure; its installDir is where this platform's job files live (NW_INSTALL_DIR is the bench seam).
  const dir = daemonJob({ slug: 'x', hub: '/x', machineryDir: '/x', configPath: '/x' }, kind).installDir;
  return {
    kind, dir, machineryDir,
    readdir: (d) => readdirSync(d),
    readFile: (f) => readFileSync(f, 'utf8'),
    realpath: (p) => { try { return realpathSync(p); } catch { return p; } },
    readPlist: (f) => {
      const r = spawn('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) return null;
      try { return JSON.parse(r.stdout).ProgramArguments ?? null; } catch { return null; }
    },
    runNode: (p) => { const r = spawn(p, ['-v'], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout : null; },
  };
}

/** Real I/O for the nightshift's preflight. */
export function realIo({ claudeBin, wakeCostsPath, kind, shell, nodePath, spawn = spawnSync }) {
  const look = lookupCommand({ kind, shell, nodePath, claudeBin });
  return {
    claudeBin,
    lookupLabel: look.label,
    isExecutable: (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } },
    lookupPath: () => {
      // An interactive shell can print rc noise: the answer is the last line that is a path.
      const r = spawn(look.bin, look.args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const found = String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
      return r.status === 0 && found ? found : null;
    },
    runVersion: (p) => {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 ? r.stdout : null;
    },
    runHelp: (p) => {
      const r = spawnSync(p, ['--help'], { encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 && r.stdout ? r.stdout : null;
    },
    wakeCostsText: existsSync(wakeCostsPath) ? readFileSync(wakeCostsPath, 'utf8') : '',
  };
}

// ------------------------------------------------- wakePrompt (lane mornings)

/**
 * The first prompt a lane created by Set up / Add agent wakes on, unless the
 * spec says otherwise (a string of its own, or null for no prompt). Exists
 * because of the dark Saturday (10/31): a hub where only one lane had a
 * wakePrompt woke three sessions that sat turn-less all day — the daemon did
 * its half, and nothing asked the sessions to move. Machine-voiced by the
 * wake.sh contract: it is the harness talking, never the persona or a person.
 */
export const DEFAULT_WAKE_PROMPT = '[nightwatch] The scheduled wake: no one is at the keyboard yet. Arm your bell watcher, read any notes in your spool, then pick up your standing work.';

// The one implementation lives in config.mjs (beside LANE_KEYS, called by
// the set verb, creation, wake.sh's snippet and wakePromptLines below), so
// the rules cannot drift between writers. Re-exported for callers here.
export { wakePromptProblem } from './config.mjs';
import { wakePromptProblem } from './config.mjs';

/**
 * Doctor/preflight lines, one per lane: does its morning wake self-propelled?
 * Amber, never red — a missing prompt costs a quiet day, not a night (the
 * alert-taxonomy rule: red means something is wrong NOW).
 */
export function wakePromptLines(cfg) {
  const out = [];
  for (const [id, lane] of Object.entries(cfg?.lanes ?? {})) {
    const v = lane?.wakePrompt;
    if (v === undefined || v === null || v === '') {
      out.push(`WARN    lane ${id}: no wakePrompt — the daemon will wake a session that waits silently at the input until a human types (set lanes.${id}.wakePrompt; Set up and Add agent give new lanes a default)`);
      continue;
    }
    const why = wakePromptProblem(v);
    if (why) out.push(`WARN    lane ${id}: wakePrompt would be refused at wake (${why}), so the wake would go on without a prompt — fix lanes.${id}.wakePrompt`);
    else out.push(`ok      lane ${id}: wakes with a first prompt`);
  }
  return out;
}
