/**
 * Transcript archive — a persona's raw past, kept in their own hub.
 *
 * Every `jsonl:<session>` source a rung or fold row names points into Claude
 * Code's transcript folder, which Claude Code prunes after cleanupPeriodDays
 * (30 by default). Our own hub only kept its full history because one
 * machine's settings say 3650. A fresh install would lose a persona's
 * sources a month after they were written, silently, and the ladder would
 * keep pointing at them. So at every fold, sleep.mjs copies the session that
 * actually folded into paths.transcriptArchive, inside the hub: portable
 * with it, and outside anything Claude Code cleans up.
 *
 * Plain jsonl, one file per session, named as Claude Code names it. A
 * transcript only grows, so a newer copy of the same session holds
 * everything an older one did, and re-archiving overwrites. The one
 * exception is a source that SHRANK (rewritten by something other than
 * Claude Code appending): then the larger old copy is kept aside under a
 * timestamped name instead of being lost.
 *
 * Writes are stage-then-rename, so a crash mid-copy leaves the previous
 * archive whole and never a half file under the real name.
 *
 * A session's subagents (an Agent-tool fork, a reader, a scorer) write
 * their own transcripts beside it, in <session>/subagents/agent-<id>.jsonl,
 * each with an agent-<id>.meta.json that says what kind of agent it was
 * ("agentType": "fork"). A fork that writes its own rung names that file as
 * its source, so those are archived too, to <archive>/<session>/subagents/,
 * the same layout Claude Code uses, by the same rules (#59). The session's
 * own transcript is copied first, and a subagent file that can't be copied
 * (unreadable, gone, not a file) is reported in subagentErrors, never
 * thrown: one bad file must not cost the session, or any later fold, its
 * own archive.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Copy one session's transcript, and its subagents', into the archive. Returns what it did. */
export function archiveTranscript(sid, { transcripts, archive }) {
  const src = join(transcripts, `${sid}.jsonl`);
  if (!existsSync(src)) return { sid, skipped: 'no transcript' };
  mkdirSync(archive, { recursive: true });
  const own = copyGrown(src, join(archive, `${sid}.jsonl`));
  return { sid, ...own, ...archiveSubagents(sid, { transcripts, archive }) };
}

/**
 * Copy src over dest unless they're already the same size. A dest LARGER
 * than src is renamed aside (<name>.<time>.<ext>) first, never overwritten.
 */
function copyGrown(src, dest) {
  const srcSize = statSync(src).size;
  let keptAside = null;
  if (existsSync(dest)) {
    const destSize = statSync(dest).size;
    if (destSize === srcSize) return { path: dest, bytes: srcSize, unchanged: true };
    if (destSize > srcSize) {
      keptAside = dest.replace(/(\.[a-z]+)$/, `.${new Date().toISOString().replace(/[:.]/g, '-')}$1`);
      renameSync(dest, keptAside);
    }
  }
  const tmp = `${dest}.partial-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
  return { path: dest, bytes: statSync(dest).size, ...(keptAside ? { keptAside } : {}) };
}

/**
 * The session's subagent transcripts and their meta files, each copied by
 * copyGrown under its own try. Returns { subagents, subagentErrors }, each
 * only when non-empty.
 */
function archiveSubagents(sid, { transcripts, archive }) {
  const from = join(transcripts, sid, 'subagents');
  const subagents = [], subagentErrors = [];
  try {
    if (!existsSync(from)) return {};
    const names = readdirSync(from).filter((f) => /^agent-[\w-]+\.(jsonl|meta\.json)$/.test(f));
    const to = join(archive, sid, 'subagents');
    for (const f of names) {
      try {
        if (!statSync(join(from, f)).isFile()) throw new Error('not a file');
        mkdirSync(to, { recursive: true });
        subagents.push({ file: f, ...copyGrown(join(from, f), join(to, f)) });
      } catch (e) { subagentErrors.push({ file: f, error: e.message }); }
    }
  } catch (e) { subagentErrors.push({ file: 'subagents/', error: e.message }); }
  return { ...(subagents.length ? { subagents } : {}), ...(subagentErrors.length ? { subagentErrors } : {}) };
}

/**
 * Bring every archived session up to date with its source. The folding
 * session keeps writing after its fold (the ritual rewrites the checkpoint
 * after sleep.mjs), so the copy taken at the fold misses its last turns;
 * the next fold catches them up here. A session whose source is gone
 * (pruned) keeps its archive as it is: that is what the archive is for.
 */
export function catchUpArchive({ transcripts, archive }) {
  if (!existsSync(archive)) return [];
  // A copy that crashed mid-way leaves <sid>.jsonl.partial-<pid>. Remove
  // those whose process is gone, and only those: both lanes fold at the same
  // bell, so another fold's copy may be in flight right now.
  sweepPartials(archive);
  const done = [];
  for (const f of readdirSync(archive)) {
    const m = f.match(/^([0-9a-f-]{36})\.jsonl$/);
    if (!m) continue;
    // Each session under its own try: one that can't be caught up is
    // reported, and the rest (and the folding session's own copy) go on.
    try {
      // The sweep under its own try too: a damaged <sid>/subagents in the
      // archive (unreadable, or a file) is reported, and the session's own
      // catch-up below still runs.
      const sweep = [];
      try { sweepPartials(join(archive, m[1], 'subagents')); } catch (e) { sweep.push({ file: 'subagents/ (archive)', error: e.message }); }
      const withSweep = (r) => (sweep.length ? { ...r, subagentErrors: [...sweep, ...(r.subagentErrors ?? [])] } : r);
      const src = join(transcripts, f);
      if (!existsSync(src)) { if (sweep.length) done.push(withSweep({ sid: m[1] })); continue; }
      if (statSync(src).size > statSync(join(archive, f)).size) { done.push(withSweep(archiveTranscript(m[1], { transcripts, archive }))); continue; }
      // A background subagent can outlive its session's last turn, so its
      // transcript may grow while the main one doesn't.
      const { subagents = [], subagentErrors } = archiveSubagents(m[1], { transcripts, archive });
      const changed = subagents.filter((x) => !x.unchanged);
      const r = withSweep({ sid: m[1], ...(changed.length ? { subagents: changed } : {}), ...(subagentErrors ? { subagentErrors } : {}) });
      if (changed.length || r.subagentErrors) done.push(r);
    } catch (e) { done.push({ sid: m[1], error: e.message }); }
  }
  return done;
}

function sweepPartials(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const m = f.match(/\.partial-(\d+)$/);
    if (m && !alive(Number(m[1]))) rmSync(join(dir, f), { force: true });
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
