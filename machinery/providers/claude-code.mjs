/**
 * The Claude Code transcript adapter for the trimmer (trim-core.mjs).
 *
 * Everything the trimmer knows about Claude Code's session transcript lives here: which rows are
 * harness rows, where a tail may open, how the uuid/parentUuid chain is kept whole across a cut, which
 * recorded fields must not travel, how images are carried, what a resumable tail must look like, and
 * how the new session is named. The core (trim-core.mjs) holds only what is the same for any runtime:
 * the suffix walk, the choice of seam nearest the target, the image budget's policy and the overshoot.
 *
 * The transcript format is the harness's own and undocumented; this adapter knows as little of it as
 * possible on purpose. If the format shifts, the next wake breaks loudly here (validate) rather than
 * corrupting anything.
 *
 * Moved out of trim.mjs whole (PR A of anima_dev/nightwatch_providers_design.md); the rules and the
 * incidents behind them are unchanged.
 */
import { join, dirname, basename } from 'node:path';

import { estLine } from '../trim-core.mjs';

export const name = 'claude-code';

/** One transcript row. A torn line is dropped like any other row, loudly (the core warns). */
export function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** A row's weight is its raw line's: the honest weight of what resumes. */
export function weigh(line) {
  return estLine(line);
}

/** The session id the transcript is named for. */
export function sessionIdOf(srcPath) {
  return basename(srcPath, '.jsonl');
}

export function timestampOf(e) {
  return e?.timestamp ?? null;
}

// Entries the harness writes at EVERY session start, whether or not a copy
// is already in the transcript: resuming a tail that carries one loads the
// head twice. Measured 2026-10-08 (anima_dev/nightwatch_incident_2026-10-08_
// prompt_too_long.md): a refold of a dead wake kept its 429KB `instructions`
// entry (CLAUDE.md + ladder + memory, ~55k tokens), the next resume added a
// fresh one, and the wake died on "Prompt is too long". `environment` and
// `total_tokens_reminder` are re-sent too, but they are small AND written
// every turn mid-session (the cwd changes, the token count): dropping them
// would edit what the model was told along the way, so they stay. The
// *_delta / skill_listing entries are not re-sent (the harness rebuilds that
// state from the transcript) and stay.
const HARNESS_LOADED = new Set(['instructions']);
/** A row the tail never keeps and the walk never weighs. */
export function drop(e) {
  return e?.type === 'attachment' && HARNESS_LOADED.has(e.attachment?.type);
}

// Entries Claude Code writes as its own request log (since 2.1.300):
// `api-request` (full request params), `api-request-blob` (the log's
// content-by-hash dedup store) and `api-request-shape` (the system-prompt
// shape). A day's transcript holds megabytes of them, but none carries a
// uuid and no entry's parentUuid points at one, so a resume never loads
// any into context (measured on two live transcripts, 10/19). They stay
// in the kept file (they are the session's own record), and they weigh
// nothing in the estimate — counting them produced the 10/16–10/18
// phantom overshoots (a 6.22x warning over a ~88k conversation). The
// list stays explicit rather than a "no uuid" rule: an unknown future
// type then defaults to counted, which can only overcount, never hide.
const REQUEST_LOG = new Set(['api-request', 'api-request-blob', 'api-request-shape']);
/** A row the tail keeps but a resume never sends: it weighs nothing and holds no image budget. */
export function inert(e) {
  return REQUEST_LOG.has(e?.type);
}

/** A genuine human prompt: typed by the person, not a tool result, not a
 *  meta/caveat wrapper. The cut must land ON one so the resumed session's
 *  first conversational turn is a human turn. */
function isHumanPrompt(e) {
  if (!e || e.type !== 'user' || e.isMeta) return false;
  if (e.userType && e.userType !== 'external') return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
  return false;
}

/** A peer's cross-session message opens an exchange the same way a human
 *  prompt does (Ra's ruling, 10/9): a tail may start on one. Without this,
 *  a cover day where the lanes talk to each other all afternoon reaches
 *  back to the human's LAST prompt and keeps everything since — the live
 *  958k-est overshoot at opus's 10/9 fold. Peer messages arrive as
 *  isMeta user turns, so isHumanPrompt alone excludes them. */
function isPeerMessage(e) {
  if (!e || e.type !== 'user' || !e.isMeta) return false;
  const c = e.message?.content;
  return typeof c === 'string' && c.includes('<cross-session-message ');
}

/** Where a cut may land: a turn that OPENS an exchange. */
export function isSeam(e) {
  return isHumanPrompt(e) || isPeerMessage(e);
}

// OUT-OF-ORDER ROWS (10/27, nightwatch#56): a session can write a row above
// the tail it resumed. A woken session's SessionStart hook attachment sat at
// row 10, parented to row 387, the resumed tail's end, and the first prompt
// after the wake was parented to it. The cut is by position, so that row fell
// before it: the prompt pointed outside the tail, and the output check below
// refused every fold of the session, rightly. A row before the cut whose
// parent is in the kept range belongs to the tail in fact: it moves in, right
// after its parent, and so does any row parented to it in turn. Measured over
// every transcript on this hub (Sonnet's read of #57: 1,140 files, 771,543
// rows), only attachments written at a session's start ever sit above their
// parent, never more than four at a cut; past MAX_MOVED_IN the output check
// refuses, so a cascade nobody foresaw is a loud refusal, not a bloated tail.
// The loop ends because each pass moves only rows not yet in the tail.
const MAX_MOVED_IN = 20;
/** The kept rows' order (indices into the transcript), from the cut. */
export function order(entries, cut) {
  const order = [];
  for (let i = cut; i < entries.length; i++) order.push(i);
  const inTail = new Set(order.map((i) => entries[i]?.uuid).filter((u) => typeof u === 'string'));
  let movedIn = 0;
  for (let grew = true; grew;) {
    grew = false;
    for (let i = 0; i < cut; i++) {
      const e = entries[i];
      if (typeof e?.uuid !== 'string' || inTail.has(e.uuid) || !e.parentUuid || !inTail.has(e.parentUuid)) continue;
      // Right after its parent, past any sibling moved there before it from
      // earlier in the file, so moved siblings keep their file order.
      let at = order.findIndex((j) => entries[j]?.uuid === e.parentUuid) + 1;
      while (at < order.length && order[at] < i && entries[order[at]]?.parentUuid === e.parentUuid) at++;
      order.splice(at, 0, i);
      inTail.add(e.uuid);
      movedIn++;
      grew = true;
    }
  }
  return { order, movedIn };
}

// STALE USAGE: every reply records the token usage of the request that made
// it. Claude Code reads the newest one as the session's current size, and on
// resume it trusted the kept tail's last figure: 937k, recorded at 93% before
// the fold. It decided the window was full and refused locally ("Prompt is
// too long", terminal_reason blocking_limit, no API call) on 2026-10-08. The
// same tail with these fields removed resumed and answered at 181,590 real
// tokens. A copied usage figure describes the session that was folded, not
// the one that resumes, so it never travels.
function withoutUsage(e) {
  if (e?.type !== 'assistant' || !e.message || !('usage' in e.message)) return null;
  const { usage, ...message } = e.message;
  return { ...e, message };
}

/**
 * The kept rows, edited: dropped rows go, and a dropped row's children are
 * re-pointed at its parent, or the harness's chain walk (leaf → parentUuid →
 * …) would stop at the gap and silently resume only the turns after it.
 * A row nothing edits keeps its line byte for byte.
 */
export function keep(entries, lines, order) {
  const droppedParent = new Map();
  for (const i of order) {
    if (drop(entries[i]) && entries[i].uuid) droppedParent.set(entries[i].uuid, entries[i].parentUuid ?? null);
  }
  const liveParent = (u) => {
    const seen = new Set();
    while (u && droppedParent.has(u) && !seen.has(u)) { seen.add(u); u = droppedParent.get(u); }
    return u ?? null;
  };
  const kept = [];
  const counts = { dropped: 0, relinked: 0, usageStripped: 0 };
  for (const i of order) {
    if (entries[i] === null) continue;
    if (drop(entries[i])) { counts.dropped++; continue; }
    let e = entries[i];
    let changed = false;
    const p = e.parentUuid;
    if (p && droppedParent.has(p)) {
      e = { ...e, parentUuid: liveParent(p) };
      counts.relinked++;
      changed = true;
    }
    const stripped = withoutUsage(e);
    if (stripped) { e = stripped; counts.usageStripped++; changed = true; }
    kept.push({ line: changed ? JSON.stringify(e) : lines[i], entry: e });
  }
  return { kept, counts };
}

// IMAGES: Claude Code carries an image as an `image` block whose base64 is in
// `source.data`, in a message's content or inside a tool_result's. The budget
// itself (newest first, greedy) is the core's.
const isImg = (b) => b && typeof b === 'object' && b.type === 'image' && typeof b.source?.data === 'string';

/** A cheap filter: no image block, nothing to weigh. */
export function mayCarryImages(line) {
  return line.includes('"image"');
}

/**
 * Walk a kept row's images newest last, asking the budget for each: `take(bytes)` says whether it stays.
 * Returns the edited row when an image went, or null when nothing changed.
 */
export function stripImages(e, take, imageBudget) {
  const content = e?.message?.content;
  if (!Array.isArray(content)) return null;
  const imagePlaceholder = (b) => ({ type: 'text', text: `[image removed at fold: ${b.source.media_type ?? 'image'}, ${Math.round(b.source.data.length / 1024)} KB of base64; a fold keeps only the newest images, ${Math.round(imageBudget / 1e6 * 10) / 10} MB in all]` });
  let changed = false;
  // Within an entry, also newest last: walk its blocks (and a tool_result's inner blocks) from the end.
  const weigh = (arr) => {
    for (let j = arr.length - 1; j >= 0; j--) {
      const b = arr[j];
      if (b?.type === 'tool_result' && Array.isArray(b.content)) { weigh(b.content); continue; }
      if (!isImg(b)) continue;
      if (take(b.source.data.length)) continue;
      arr[j] = imagePlaceholder(b);
      changed = true;
    }
  };
  weigh(content);
  if (!changed) return null;
  // The harness's own copy of a Read result (toolUseResult.file.base64) is not sent, but it is this
  // entry's record of the same pixels: it goes with them, so the kept file doesn't carry what was removed.
  if (e.toolUseResult?.type === 'image' && typeof e.toolUseResult.file?.base64 === 'string') {
    e = { ...e, toolUseResult: { ...e.toolUseResult, file: { ...e.toolUseResult.file, base64: '' } } };
  }
  return e;
}

// OUTPUT CHECK (10/21): the cut above is made by fields this script does not
// own, so it checks the tail it just built against the shape a resume needs,
// and refuses to write one that fails. Three silent failures, each reproduced
// on a scratch fixture (compat repro, 10/21), all exit 0 before this check:
//  1. uuid or parentUuid renamed: relinking no-ops (relinked 0), the chain has
//     a hole, and the harness would resume only the turns after it.
//  2. a parent that is not in the tail: the same hole by any other cause.
//  3. isMeta renamed: harness wrappers read as human prompts, and the cut can
//     land ON one. The wrappers named here carry isMeta in every transcript
//     measured on this hub (1,344 peer messages, 111 local-command-caveats,
//     9 "response cut" nudges; 0 exceptions), so one without it is drift.
//     `<local-command-stdout>` is deliberately NOT listed: it is a real
//     user-role entry with isMeta false (74 of them).
//  4. `usage` renamed: withoutUsage (above) then strips nothing, and the stale
//     figure travels, the 10/8 "Prompt is too long" refusal. The check looks
//     for the token FIELDS, not the key's name: a numeric input_tokens /
//     cache_read_input_tokens / cache_creation_input_tokens held as an object
//     key on a kept assistant entry, outside its content, means a usage record
//     survived under some other key. Keys, not text: transcripts here are full
//     of message text and tool results that NAME those fields, and user entries
//     and `content` are never scanned. Measured on this hub's archive (76,327
//     assistant entries): 0 such carriers outside `usage`. It does not catch a
//     rename of the inner field names as well.
// A check that fails exits 1 and writes nothing: a fold skipped loudly beats a
// tail that resumes wrong silently. The first kept entry may point outside the
// tail (its parent is the cut); no other entry may.
const USAGE_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
function carriesUsage(v, depth = 0) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return depth < 2 && v.slice(0, 5).some((x) => carriesUsage(x, depth + 1));
  return USAGE_FIELDS.some((k) => typeof v[k] === 'number') || (depth < 2 && Object.values(v).some((x) => carriesUsage(x, depth + 1)));
}
const META_WRAPPERS = [/^<local-command-caveat>/, /^Your response above was cut/, /^Another Claude session sent a message/];
function tailProblems(keptLines) {
  const rows = keptLines.map((l) => JSON.parse(l));
  const problems = [];
  const conv = rows.filter((e) => e.type === 'user' || e.type === 'assistant');
  const noFields = conv.filter((e) => typeof e.uuid !== 'string' || !('parentUuid' in e)).length;
  if (noFields) problems.push(`${noFields} of ${conv.length} conversation entries lack a uuid or a parentUuid field: the transcript format may have changed`);
  const ids = new Set(rows.map((e) => e.uuid).filter((u) => typeof u === 'string'));
  const holes = rows.slice(1).filter((e) => e.parentUuid && !ids.has(e.parentUuid)).length;
  if (holes) problems.push(`${holes} kept entries point at a parent that is not in the tail: a resume would load only the turns after the gap`);
  const drift = rows.filter((e) => e.type === 'user' && typeof e.message?.content === 'string' && e.isMeta !== true && META_WRAPPERS.some((re) => re.test(e.message.content))).length;
  if (drift) problems.push(`${drift} harness-wrapper entries are not marked isMeta: seam detection can no longer tell them from a human prompt`);
  const staleUsage = rows.filter((e) => e.type === 'assistant' && [
    ...Object.entries(e.message ?? {}).filter(([k]) => k !== 'content'),
    ...Object.entries(e).filter(([k]) => k !== 'message' && k !== 'wireToolInputs'),
  ].some(([, v]) => carriesUsage(v))).length;
  if (staleUsage) problems.push(`${staleUsage} kept replies still carry a token-usage record under a key the trimmer did not strip: a copied figure makes the resume refuse locally ("Prompt is too long")`);
  return problems;
}

/** What makes the kept tail unresumable, if anything; any problem blocks the write. */
export function validate(keptLines, { movedIn }) {
  const problems = tailProblems(keptLines);
  if (movedIn > MAX_MOVED_IN) problems.push(`${movedIn} rows written above the tail would move into it (more than ${MAX_MOVED_IN}; at most 4 seen on this hub): the transcript's shape may have changed`);
  return problems;
}

/**
 * The new session: the kept rows as a transcript named for a fresh id, beside the source.
 * The session id appears as `sessionId` and `session_id`; the value is the
 * old uuid, globally unique, so a plain string replace is exact.
 */
export function newSession(keptLines, { srcPath, oldId, newId }) {
  return {
    path: join(dirname(srcPath), `${newId}.jsonl`),
    text: keptLines.map((l) => l.split(oldId).join(newId)).join('\n') + '\n',
  };
}

/**
 * The report sleep.mjs, the watch and folds.jsonl read, in its fields' order.
 * claudeVersion is the `version` on the LAST kept entry that carries one (the
 * last-written, not a semver max), the version that WROTE the tail.
 */
export function report(f) {
  const cutEntry = f.entries[f.cut];
  // Last-written, not the semver max: a session resumed under an older build says so.
  const writerVersion = f.entries.slice(f.cut).reverse().find((e) => typeof e?.version === 'string' && /^\d+\.\d+\.\d+/.test(e.version))?.version ?? null;
  return {
    newSessionId: f.newId,
    path: f.path,
    keptEntries: f.keptEntries,
    totalEntries: f.totalEntries,
    estTokens: f.estTokens,
    targetTokens: f.target,
    ...(f.overshoot ? { overshoot: f.overshoot } : {}),
    ...(writerVersion ? { claudeVersion: writerVersion } : {}),
    harnessDropped: f.counts.dropped,
    tornLines: f.torn,
    relinked: f.counts.relinked,
    ...(f.movedIn ? { movedIn: f.movedIn } : {}),
    usageStripped: f.counts.usageStripped,
    ...(f.imagesStripped.count ? { imagesStripped: f.imagesStripped } : {}),
    cutAt: cutEntry?.timestamp ?? null,
    cutPrompt: String(cutEntry?.message?.content ?? '').slice(0, 120),
  };
}
