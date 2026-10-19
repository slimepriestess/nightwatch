// Dead-wake resolution: which session should a fold actually read?
//
// A DEAD WAKE is a session woken from a tail that never managed a real turn:
// every assistant entry of its own is synthetic or an API error, and the
// newest says the prompt is too long. Folding it carries its corpse forward:
// its kept tail holds the harness's session-start head, the next resume adds
// another, and each refold is worse than the last (2026-10-08, see
// anima_dev/nightwatch_incident_2026-10-08_prompt_too_long.md).
//
// So a fold of a dead wake reads the session the dead wake came from instead:
// the dead wake's tail is the fold row whose tail entries are ALL present in
// it (forks keep every uuid), and that row's source is the session before.
// Repeat while that one is dead too. A session that did real work after
// waking is never walked past: its own turns are the record, even if it
// later hit the limit.
//
// Pure reads; never writes. Returns { sid, skipped: [dead sids], why }.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readEntries(path) {
  const out = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

function isApiError(e) {
  return e?.isApiErrorMessage === true || e?.message?.model === '<synthetic>';
}

function saysTooLong(e) {
  const c = e?.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join(' ') : '';
  return /prompt is too long/i.test(text);
}

// Can this session take a prompt at all? Its newest reply says the prompt is
// too long → no bell or poke can reach it. (Any history: unlike the walk in
// resolveFoldSource, this asks only about now.)
export function cannotAnswer(path) {
  try {
    return saysTooLong(readEntries(path).filter((e) => e.type === 'assistant').at(-1));
  } catch { return false; }
}

export function resolveFoldSource(sessionId, { transcripts, foldsPath, maxHops = 8 }) {
  const skipped = [];
  let sid = sessionId;
  let folds = [];
  try {
    folds = readFileSync(foldsPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r?.tail && r?.source);
  } catch {}
  for (let hop = 0; hop < maxHops; hop++) {
    const path = join(transcripts, `${sid}.jsonl`);
    if (!existsSync(path)) return { sid, skipped, why: skipped.length ? `stopped: no transcript for ${sid}` : 'no transcript' };
    const entries = readEntries(path);
    const newestAssistant = entries.filter((e) => e.type === 'assistant').at(-1);
    if (!newestAssistant || !saysTooLong(newestAssistant)) return { sid, skipped, why: skipped.length ? 'reached a live session' : 'not a dead wake' };
    const have = new Set(entries.map((e) => e.uuid).filter(Boolean));
    const firstId = entries.find((e) => e.uuid)?.uuid;
    // The parent tail: the fork copied it from this session's first entry on,
    // so it starts where this session starts and lies wholly inside it. A
    // tail cut FROM this session also lies inside it (it's a suffix), so
    // rows sourced from this session never count, and the start must match.
    let parent = null;
    for (let i = folds.length - 1; i >= 0; i--) {
      const tailPath = join(transcripts, `${folds[i].tail}.jsonl`);
      if (folds[i].tail === sid || folds[i].source === `jsonl:${sid}` || !existsSync(tailPath)) continue;
      const tailIds = readEntries(tailPath).map((e) => e.uuid).filter(Boolean);
      if (tailIds.length && tailIds[0] === firstId && tailIds.every((u) => have.has(u))) { parent = { row: folds[i], ids: new Set(tailIds) }; break; }
    }
    if (!parent) return { sid, skipped, why: 'prompt too long, but no fold row matches its tail: folding it as-is' };
    const own = entries.filter((e) => e.type === 'assistant' && !parent.ids.has(e.uuid));
    if (own.some((e) => !isApiError(e))) return { sid, skipped, why: 'did real work after waking: its own turns are the record' };
    skipped.push(sid);
    sid = String(parent.row.source).replace(/^jsonl:/, '');
  }
  return { sid, skipped, why: `stopped after ${maxHops} hops` };
}

// A RESUMED session lives on under a new id. Picking the running session
// from Claude Code's session list (/resume, or the picker a stray arrow key
// opens) copies the conversation into a new transcript and ends the old one
// with {"type":"continued-in","continuedInSessionId":...}. The bell still
// reaches the process, but the registry still names the old id, so a fold of
// it trims a transcript that stopped at the resume and loses everything said
// after (2026-10-19, marginalia's hub: the goodnight and the whole sleep
// ritual). So a fold follows the chain to its newest file first. A hop whose
// file is missing stops the walk where the record still is.
//
// A pointer is followed only when its target plausibly CONTAINS the file that
// points at it (the 10/19 review's P1/P2/P4: an empty target, a shorter one,
// or a stale pointer would otherwise fold LESS than the record under a clean
// row). What the real chains show (dea6fefc → aa4affc0, 3e621b0b → 1f4cab04):
// the new file carries every user-row uuid of the old one, in order; it does
// NOT always carry the old file's last uuid (a move mid-turn rewrites the
// in-flight assistant row under a new uuid); its raw row count can be SMALLER
// (fewer api-request rows), so counting rows would refuse the real incident;
// and it never repeats the continued-in row. So the test is: every user-row
// uuid of the pointing file appears in the target, in the same order, and the
// target's newest timestamp is not older than the pointing file's. A refusal
// stops the walk where the record is and says why.
//
// Pure reads; never writes. Returns { sid, followed: [earlier sids],
// refused: null | { from, to, why } }.
export function containsResume(fromEntries, toEntries) {
  const index = new Map();
  toEntries.forEach((e, i) => { if (e.uuid && !index.has(e.uuid)) index.set(e.uuid, i); });
  let at = -1;
  for (const e of fromEntries) {
    if (e.type !== 'user' || !e.uuid) continue;
    const i = index.get(e.uuid);
    if (i === undefined) return { ok: false, why: `it lacks the pointing file's prompt ${e.uuid}` };
    if (i < at) return { ok: false, why: `it holds the pointing file's prompts out of order (${e.uuid})` };
    at = i;
  }
  const newest = (es) => es.reduce((m, e) => { const t = Date.parse(e.timestamp ?? ''); return Number.isFinite(t) && t > m ? t : m; }, -Infinity);
  const from = newest(fromEntries), to = newest(toEntries);
  if (from > to) return { ok: false, why: `it is older (newest entry ${Number.isFinite(to) ? new Date(to).toISOString() : 'none'} < ${new Date(from).toISOString()})` };
  return { ok: true, why: '' };
}

export function followContinued(sessionId, { transcripts, maxHops = 8 }) {
  const followed = [];
  let sid = sessionId;
  for (let hop = 0; hop < maxHops; hop++) {
    const path = join(transcripts, `${sid}.jsonl`);
    if (!existsSync(path)) break;
    const entries = readEntries(path);
    const next = entries.filter((e) => e.type === 'continued-in').at(-1)?.continuedInSessionId;
    if (!next || next === sid || followed.includes(next) || !existsSync(join(transcripts, `${next}.jsonl`))) break;
    const plausible = containsResume(entries, readEntries(join(transcripts, `${next}.jsonl`)));
    if (!plausible.ok) return { sid, followed, refused: { from: sid, to: next, why: plausible.why } };
    followed.push(sid);
    sid = next;
  }
  return { sid, followed, refused: null };
}

// The transcript a session is LIVING in now: the end of its continued-in
// chain (same rules as above). For the readers that judge a running session
// by its file (nightshift's quiet, context, cannot-answer and API-error
// checks): after a resume the old file stops growing at once, so read by the
// registered id it looks quiet while the conversation is busy elsewhere.
export function liveTranscriptPath(sessionId, transcripts) {
  try { return join(transcripts, `${followContinued(sessionId, { transcripts }).sid}.jsonl`); }
  catch { return join(transcripts, `${sessionId}.jsonl`); }
}

// CLI, for the recovery recipe and the bench:
//   node deadwake.mjs <session-id>   → prints the resolution as JSON
if (process.argv[1] && process.argv[1].endsWith('deadwake.mjs')) {
  const { loadConfig } = await import('./config.mjs');
  const CFG = loadConfig();
  const sid = process.argv[2];
  if (!sid) { console.error('usage: deadwake.mjs <session-id>'); process.exit(2); }
  console.log(JSON.stringify(resolveFoldSource(sid, { transcripts: CFG.paths.transcripts, foldsPath: join(CFG.paths.ladder, 'folds.jsonl') }), null, 2));
}
