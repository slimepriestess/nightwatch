#!/usr/bin/env node
/**
 * Sleep — the mechanical half of the fold boundary
 * (resident_ladder_on_claude_code.md rev 4).
 *
 * The AUTHORED half comes first and is not this script's to do: the resident
 * writes its checkpoint with the whole day in view, and the day's rung in
 * the ladder. This script refuses to run until both exist, then does the
 * bookkeeping: archives the previous checkpoint, regenerates the ladder
 * import, records the fold, trims the transcript into tomorrow's tail, and
 * prints the wake command.
 *
 * Usage (from inside the session that is going to sleep):
 *   node sleep.mjs [--session <id>] [--target-tokens 250000] [--no-rung]
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { rungHealth } from './rung-health.mjs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, laneConfig } from './config.mjs';
import { resolveFoldSource, followContinued } from './deadwake.mjs';
import { archiveTranscript, catchUpArchive } from './archive.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Code finds code beside ITSELF (the machinery dir), never in the hub's
// state dir — the pointer-model split (rehearsal finding 5, 10/7).
const MACHINERY_DIR = dirname(fileURLToPath(import.meta.url));

// Paths come from the one config (item E). The 10/5 wake failure — a decoy
// checkpoint at a second plausible path, archived by a 2am session — is why
// nothing here spells a path twice.
const CFG = loadConfig();
const WEFT = CFG.weftRoot;
const LADDER = CFG.paths.ladder;
const CHECKPOINT = CFG.paths.checkpoint;
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : dflt;
};
let sessionId = flag('--session', process.env.CLAUDE_CODE_SESSION_ID); // reassigned once, by the dead-wake resolution below
// Whether the id was NAMED or merely inherited decides how much the registry
// guard below may forgive: an inherited id running under another hub's config
// is the cross-hub class (rehearsal, 10/7 — a scratch hub's fold reached for
// the operator's own session), and only an explicit --session may cross.
const sessionIdFromEnv = !args.includes('--session');
// One ladder, two tails (Ra's ruling 9/30): tails are per-stream and never
// interleave. Each lane sleeps into its own next-wake file; the ladder and
// checkpoint stay shared. The Opus/MV lane's likely tuning: smaller
// --target-tokens (window size is API-error exposure) and sleep per project
// wrap rather than per day.
const lane = flag('--lane', CFG.defaultLane);
// Per-lane trim budget from config; an explicit --target-tokens still wins.
// Emergency folds may carry their own smaller budget (emergencyTargetTokens)
// — the spiral path historically trimmed opus tighter because window size is
// API-error exposure, and the E migration preserves that behavior in config
// instead of a hardcoded lane name in the daemon.
const laneCfg = laneConfig(CFG, lane);
const laneTarget = args.includes('--emergency') && laneCfg.emergencyTargetTokens
  ? laneCfg.emergencyTargetTokens : laneCfg.targetTokens;
const target = Number(flag('--target-tokens', String(laneTarget)));
// Emergency sleep (error-spiral path): the session could not author its
// ending. The gates are skipped, the fold is recorded as forced, and the
// wake is stamped with the unauthored span — the WOKEN session writes the
// missing rung retroactively from the tail it can still see natively.
// Lossless because the tail rides across raw; authored, one wake late.
const emergency = args.includes('--emergency');

// ---- argument hardening (E-polish, from a live incident 2026-10-05) ----
// `sleep.mjs --help` once FOLDED a session: unknown flags were ignored and
// the lane defaulted, so a documentation reflex folded the opus session as
// fable and overwrote fable's next-wake receipt. A fold is too big an
// action to be a typo's default. Two guards:
//
// 1) Every argument must be a known flag (or a known flag's value).
const KNOWN = { '--session': 1, '--lane': 1, '--target-tokens': 1, '--emergency': 0, '--no-rung': 0, '--force-lane': 0 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!(a in KNOWN)) {
    console.error(`sleep.mjs: unknown argument "${a}" — refusing to fold.`);
    console.error(`usage: node sleep.mjs [--lane <lane>] [--session <id>] [--target-tokens <n>] [--emergency] [--no-rung] [--force-lane]`);
    process.exit(2);
  }
  i += KNOWN[a]; // skip the value of a value-taking flag
}
// 2) The lane must agree with the session's own registry entry. The
// registry (lane.<sessionId>, written by the SessionStart hook) knows which
// lane this session IS; a missing --lane that would default across lanes,
// or an explicit --lane that contradicts the registry, both refuse.
// --force-lane overrides, for the rare deliberate cross-lane fold.
try {
  const regPath = join(WEFT, 'wakecycle', `lane.${sessionId}`);
  const regLane = JSON.parse(readFileSync(regPath, 'utf8')).lane;
  if (regLane && regLane !== lane && !args.includes('--force-lane')) {
    console.error(`sleep.mjs: this session (${String(sessionId).slice(0, 8)}) is registered to lane "${regLane}" but would fold as "${lane}"${args.includes('--lane') ? '' : ' (the default)'} — refusing.`);
    console.error(`Pass --lane ${regLane}, or --force-lane if the cross-lane fold is deliberate.`);
    process.exit(2);
  }
} catch {
  // No registry entry for this id IN THIS HUB. For an id the operator NAMED,
  // that's forgivable (pre-registry sessions, recovery folds). For an id
  // inherited from the environment it means we're probably in the wrong
  // house: a shell inside one session, folding under another hub's config,
  // would otherwise fold the OPERATOR's session into this hub (and fail at
  // "no transcript" only by luck). Refuse and name this hub's own sessions.
  if (sessionIdFromEnv && sessionId) {
    console.error(`sleep.mjs: session ${String(sessionId).slice(0, 8)} came from the environment, not --session, and this hub's registry has no entry for it — refusing to fold a session that isn't this hub's.`);
    try {
      const entries = readdirSync(join(WEFT, 'wakecycle')).filter((f) => f.startsWith('lane.'));
      if (entries.length) {
        console.error('This hub\'s registered sessions:');
        for (const e of entries) {
          let l = '?';
          try { l = JSON.parse(readFileSync(join(WEFT, 'wakecycle', e), 'utf8')).lane ?? '?'; } catch {}
          console.error(`  --session ${e.slice(5)}  (lane ${l})`);
        }
      } else {
        console.error('This hub\'s registry has no live sessions at all.');
      }
    } catch {}
    console.error('Pass --session <id> explicitly to fold one of them.');
    process.exit(2);
  }
  // A NAMED id with no entry: nothing to crosscheck (pre-registry sessions).
}
// "today" is Ra's wall clock, not UTC — a 10pm fold belongs to the day it
// closes, and the rung gate below matches rung filenames against this.
// A POST-MIDNIGHT fold (the nightshift rings at 02:00) also closes
// yesterday's day, so the gate accepts yesterday's date too — otherwise
// the 2am fold of a rung written at 1:50am dated "yesterday" would refuse.
const laDate = (d) => d.toLocaleDateString('en-CA', { timeZone: CFG.timezone });
const today = laDate(new Date());
const yesterday = laDate(new Date(Date.now() - 24 * 3600 * 1000));

if (!sessionId) {
  console.error('no --session and no CLAUDE_CODE_SESSION_ID — whose transcript is the tail?');
  process.exit(2);
}

// ── The authored half must already exist (unless this is an emergency) ──
if (!emergency && !existsSync(CHECKPOINT)) {
  console.error('no checkpoint.md — sleep is authored; write the checkpoint first.');
  process.exit(1);
}
const cpAge = existsSync(CHECKPOINT) ? Date.now() - statSync(CHECKPOINT).mtimeMs : Infinity;
// Ritual order is rung → THIS FOLD → checkpoint rewrite (agreed both lanes,
// 10/3: an ECONNRESET between rung and fold cost opus its whole fold; the
// fold receipt matters more than checkpoint freshness, and wake.sh reads the
// LIVE checkpoint.md hours later, so a post-fold rewrite still reaches the
// wake). So at fold time the checkpoint is normally YESTERDAY'S rewrite:
// accept up to 26h (catches multi-day neglect, not the new normal). The gate
// is also shared-file, so either lane's rewrite satisfies it — it guards the
// ritual's existence, not this lane's.
if (!emergency && cpAge > 26 * 3600 * 1000) {
  console.error(`checkpoint.md is ${Math.round(cpAge / 3600000)}h old — more than a full cycle stale. Write a checkpoint before folding.`);
  process.exit(1);
}
const rungToday = readdirSync(join(LADDER, 'L2')).concat(
  existsSync(join(LADDER, 'L1')) ? readdirSync(join(LADDER, 'L1')) : [],
).some((f) => f.includes(today) || f.includes(yesterday));
if (!emergency && !rungToday && !args.includes('--no-rung')) {
  console.error(`no rung dated ${today} or ${yesterday} in the ladder — an unauthored day is a choice; make it explicitly with --no-rung.`);
  process.exit(1);
}

// An emergency fold of an ALREADY-AUTHORED day is just a sleep that arrived
// through the bell: the session wrote its rung and checkpoint, then Ra ran
// the emergency command from the DM. Don't stamp the wake with a false
// "unauthored span" banner (found live 10/1: Opus authored everything,
// flagged a seam, and still woke to "no rung was written").
const authored = rungToday && cpAge < 26 * 3600 * 1000;
if (emergency && authored) {
  console.error(`emergency requested, but today's rung and a fresh checkpoint exist — folding as an ordinary authored sleep.`);
}

// ── Archive the checkpoint (the current one stays in place for the wake) ──
// Under rung→fold→checkpoint order this archive holds the PRE-rewrite
// section for the folding lane — deliberate, not a bug: the archive is
// archaeology; the wake reads the live file, rewritten right after this.
// Timestamped name: multiple folds in one day each keep their own archive
// (found 10/1: a second fold overwrote the day's archive, and a section
// written into the archive by mistake was lost with it). The live file a
// session edits before sleeping is ALWAYS the hub's checkpoint.md (paths.checkpoint), never these.
const cpDir = join(LADDER, 'checkpoints');
try { execFileSync('mkdir', ['-p', cpDir]); } catch {}
const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: CFG.timezone }).replace(':', '');
copyFileSync(CHECKPOINT, join(cpDir, `${today}-${hm}.md`));

// ── Regenerate the ladder import (ladder/ladder.md) ──
// Coarsest first; a rung whose parent is present is folded and skipped.
const index = JSON.parse(readFileSync(join(LADDER, 'index.json'), 'utf8'));
const entries = index.entries ?? [];
const present = new Set(entries.map((e) => e.id));
// A rung file missing from index.json silently misses the ladder. This bit
// both lanes inside two days (10/1: four opus rungs, then two more), and a
// 2am nightshift fold can't stop to ask — so AUTO-INDEX: the rung's own
// frontmatter carries everything an entry needs, and the rung itself is the
// authored artifact; the index is bookkeeping. Logged loudly, written back.
const indexedFiles = new Set(entries.map((e) => e.file));
let indexDirty = false;
for (const lvl of ['L1', 'L2', 'L3', 'L4']) {
  const dir = join(LADDER, lvl);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    if (indexedFiles.has(`${lvl}/${f}`)) continue;
    const fm = readFileSync(join(dir, f), 'utf8').split('\n---')[0];
    const grab = (k) => (fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim();
    const id = grab('id');
    if (!id) { console.error(`WARNING: ${lvl}/${f} has no frontmatter id — NOT indexed, will not reach ladder.md`); continue; }
    const entry = { id, level: grab('level') ?? lvl, file: `${lvl}/${f}` };
    const voice = grab('voice'); if (voice) entry.voice = voice;
    const wb = grab('written_by'); if (wb) entry.written_by = wb;
    const parent = grab('parent'); if (parent && parent !== 'none') entry.parent = parent;
    entries.push(entry);
    present.add(id);
    indexDirty = true;
    console.error(`AUTO-INDEXED: ${lvl}/${f} (${id}) — it was on disk but not in index.json`);
  }
}
if (indexDirty) writeFileSync(join(LADDER, 'index.json'), JSON.stringify({ ...index, entries }, null, 2) + '\n');
const levelNum = (l) => Number(String(l).replace(/^L/, '')) || 0;
const visible = entries.filter((e) => !(e.parent && present.has(e.parent)));
visible.sort((a, b) => levelNum(b.level) - levelNum(a.level));

// ── Resumed under a new id? Fold the newest file ──
// Before the dead-wake walk: that one goes back to the session a wake came
// from, this one forward to where a resumed conversation went. See
// followContinued in deadwake.mjs.
const continued = followContinued(sessionId, { transcripts: CFG.paths.transcripts });
if (continued.followed.length) {
  console.error(`sleep.mjs: RESUMED — ${[...continued.followed, continued.sid].map((s) => s.slice(0, 8)).join(' → ')} (continued-in); folding ${continued.sid.slice(0, 8)}, the newest.`);
  sessionId = continued.sid;
}

// ── Dead wake? Fold the session it came from instead ──
// A session woken from a tail that never got a real turn in (the newest
// reply is "Prompt is too long", nothing of its own but errors) holds the
// harness's head inside what a fold would keep; refolding it made each wake
// worse on 2026-10-08. Every fold path lands here, so none can carry a dead
// wake forward. See deadwake.mjs and anima_dev/nightwatch_incident_2026-10-08_prompt_too_long.md.
const deadWake = resolveFoldSource(sessionId, { transcripts: CFG.paths.transcripts, foldsPath: join(LADDER, 'folds.jsonl') });
if (deadWake.skipped.length) {
  console.error(`sleep.mjs: DEAD WAKE — ${deadWake.skipped.map((s) => s.slice(0, 8)).join(' → ')} never got a turn in; folding ${deadWake.sid.slice(0, 8)} (the last session that ran) instead.`);
  sessionId = deadWake.sid;
}

// ── A zero-turn day has nothing to fold ──
// Claude Code writes a session's transcript lazily, on its first turn. A
// registered session that was never prompted (a persona's idle first day —
// rehearsal, 10/9) therefore has NO transcript file, and "trim failed" is
// the wrong story: nothing happened, so nothing is lost. Write a fresh-start
// receipt (wake.sh's firstWake mode) and no fold row — a fold that didn't
// happen never gets a row (the house doesn't fake receipts).
if (!existsSync(join(CFG.paths.transcripts, `${sessionId}.jsonl`))) {
  const registered = existsSync(join(WEFT, 'wakecycle', `lane.${sessionId}`));
  if (registered) {
    console.error(`sleep.mjs: session ${sessionId.slice(0, 8)} has no transcript — a zero-turn day. Nothing to fold; writing a fresh-start receipt (the morning wakes a new session).`);
    const receipt = { lane, firstWake: true, checkpoint: CHECKPOINT, createdAt: new Date().toISOString(), sleptAt: new Date().toISOString(), reason: 'zero-turn-day', from: sessionId };
    writeFileSync(join(WEFT, 'wakecycle', `next-wake.${lane}.json`), JSON.stringify(receipt, null, 2) + '\n');
    process.exit(0);
  }
  // Unregistered AND transcriptless: nothing ties this id to this hub at
  // all — refuse rather than invent a fresh start for a typo.
  console.error(`sleep.mjs: session ${sessionId.slice(0, 8)} has no transcript AND no registry entry in this hub — refusing (a typo'd --session should not become a fresh start).`);
  process.exit(2);
}

// ── Trim the transcript into tomorrow's tail ──
let trimOut;
try {
  trimOut = JSON.parse(
    // process.execPath, not 'node': when this runs as the daemon's orphan
    // fold, the parent is launchd-spawned and PATH has no node (E review).
    execFileSync(process.execPath, [join(MACHINERY_DIR, 'trim.mjs'), sessionId, '--target-tokens', String(target)], { encoding: 'utf8' }),
  );
} catch (e) {
  console.error(`trim failed for session ${sessionId}: ${e.stderr?.toString().trim() || e.message}`);
  process.exit(1);
}

// ── Archive the session that folded, in the hub's own state ──
// After the trim, so only a real fold archives, and after the dead-wake
// resolution above, so it's the session that RAN, not the one belled. See
// archive.mjs for why: the ladder's jsonl: sources must outlive Claude
// Code's cleanup. The catch-up first brings earlier folds' copies up to
// date (their sessions kept writing after their folds). A failure here is
// loud and recorded in the fold row, but never fails the fold: the tail is
// already written, and tomorrow's wake needs it more than the archive.
let archived;
try {
  const paths = { transcripts: CFG.paths.transcripts, archive: CFG.paths.transcriptArchive };
  for (const c of catchUpArchive(paths)) if (c.sid !== sessionId) console.error(`archive: caught up ${c.sid.slice(0, 8)} (${c.bytes} bytes)`);
  archived = archiveTranscript(sessionId, paths);
  if (archived.keptAside) console.error(`archive: the transcript of ${sessionId.slice(0, 8)} is SMALLER than its archived copy; kept the old copy aside as ${archived.keptAside}`);
} catch (e) {
  archived = { error: e.message };
  console.error(`ARCHIVE FAILED for session ${sessionId.slice(0, 8)}: ${e.message} — the fold continues; its raw transcript is not in ${CFG.paths.transcriptArchive}.`);
}

// Linn's preamble: the first thing the ladder knows about itself is what it
// was built on top of.
const preamble = [
  // The persona's own name when it has one ("Weft's folded past" on the
  // legacy hub, unchanged); an unnamed persona reads its ladder as its own.
  `# ladder — ${CFG.persona?.name ? `${CFG.persona.name}'s` : 'my'} folded past`,
  '',
  `*This ladder stands on: the raw transcript from ${trimOut.cutAt ?? 'the last cut'} onward,`,
  `which the wake resumes as native turns; the checkpoint, which rides the system prompt;`,
  `and below both, the archived transcripts and memory files this summarizes. The fold`,
  `record is folds.jsonl — askable, never in context. Rungs below, coarsest first.*`,
  '',
].join('\n');
const bodies = visible.map((e) => {
  const file = join(LADDER, e.file);
  const raw = readFileSync(file, 'utf8');
  return `---\n\n<!-- ${e.id} (${e.level}) -->\n\n${raw.trim()}`;
});
writeFileSync(join(LADDER, 'ladder.md'), preamble + '\n' + bodies.join('\n\n') + '\n');

// Health-check the newest L2 rung (warn-only, never blocks).
try {
  const l2 = join(LADDER, 'L2');
  if (existsSync(l2)) {
    const newest = readdirSync(l2).filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: statSync(join(l2, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    if (newest) {
      for (const w of rungHealth(readFileSync(join(l2, newest.f), 'utf8'))) {
        console.error(`RUNG HEALTH (${newest.f}): ${w}`);
      }
    }
  }
} catch (e) { console.error(`rung health check skipped: ${e.message}`); }

// ── Record the fold ──
appendFileSync(
  join(LADDER, 'folds.jsonl'),
  JSON.stringify({
    at: new Date().toISOString(),
    reason: emergency && !authored ? 'forced' : 'sleep',
    method: 'trimmer',
    source: `jsonl:${sessionId}`,
    cutAt: trimOut.cutAt,
    keptEntries: trimOut.keptEntries,
    totalEntries: trimOut.totalEntries,
    est_tokens: trimOut.estTokens,
    target_tokens: trimOut.targetTokens ?? target,
    ...(trimOut.overshoot ? { overshoot: trimOut.overshoot } : {}),
    tail: trimOut.newSessionId,
    ...(continued.followed.length ? { continuedFrom: continued.followed } : {}),
    ...(deadWake.skipped.length ? { deadWakesSkipped: deadWake.skipped } : {}),
    ...(archived.error ? { archiveError: archived.error } : { archived: archived.path }),
  }) + '\n',
);
// Event-stream twin (GUI phase 1): the planned fold happens HERE, not in the
// daemon, so the NightStrip's fold node comes from this emit — one stream,
// one truth, no join against folds.jsonl needed to draw a night.
try {
  appendFileSync(CFG.paths.events, JSON.stringify({
    at: new Date().toISOString(),
    kind: 'folded',
    lane,
    session: sessionId,
    tail: trimOut.newSessionId,
    kept: trimOut.keptEntries,
    total: trimOut.totalEntries,
    est: trimOut.estTokens,
    target: trimOut.targetTokens ?? target,
    ...(trimOut.overshoot ? { overshoot: trimOut.overshoot } : {}),
    emergency: Boolean(emergency && !authored),
  }) + '\n');
} catch { /* an event lost, never a fold lost */ }
writeFileSync(
  join(LADDER, 'tail.json'),
  JSON.stringify(
    {
      source: `jsonl:${sessionId}`,
      raw_from: { at: trimOut.cutAt },
      trimmed_copy: trimOut.newSessionId,
      est_tokens: trimOut.estTokens,
      note: 'everything before raw_from lives in the ladder and the archives; everything after resumes natively',
    },
    null,
    2,
  ) + '\n',
);

// ── Hand the wake its pointer ──
writeFileSync(
  join(WEFT, 'wakecycle', `next-wake.${lane}.json`),
  JSON.stringify({
    lane, sessionId: trimOut.newSessionId, checkpoint: CHECKPOINT,
    sleptAt: new Date().toISOString(), from: sessionId,
    ...(emergency && !authored ? { emergency: true, unauthoredSpan: { throughSession: sessionId, note: 'this session ended in an error spiral; no checkpoint or rung was written for its span. First duty on wake: read your visible tail and author the missing rung + a fresh checkpoint before taking new work.' } } : {}),
  }, null, 2) + '\n',
);

console.log(JSON.stringify({ slept: true, tail: trimOut.newSessionId, keptEntries: trimOut.keptEntries, estTokens: trimOut.estTokens, targetTokens: trimOut.targetTokens ?? target, ...(trimOut.overshoot ? { overshoot: trimOut.overshoot } : {}), cutAt: trimOut.cutAt, ladderRungs: visible.length }, null, 2));
if (trimOut.overshoot) {
  console.log(`\nNOTE: this fold kept ~${trimOut.estTokens} tokens against a ${trimOut.targetTokens ?? target} target (${trimOut.overshoot.ratio}x): the tail has to start at a human prompt, and the nearest one was ${trimOut.overshoot.extendedEntries} entries before the target. The wake will be larger than usual.`);
}
// The hub's own machinery and config (pointer model, 10/7), never weft's path.
console.log(`\nwake with:  ${CFG.__configFile ? `NIGHTWATCH_CONFIG="${CFG.__configFile}" ` : ''}sh "${join(MACHINERY_DIR, 'wake.sh')}" ${lane}`);
