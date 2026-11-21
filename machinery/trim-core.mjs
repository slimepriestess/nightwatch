/**
 * The trimmer's core: what is the same for any runtime's transcript.
 *
 * Given a transcript's raw lines and a provider adapter (providers/<name>.mjs), it keeps the newest
 * ~target tokens of rows, opened at the seam whose kept estimate lands closest to the target, under an
 * image budget, and asks the adapter whether the tail it built would resume. It never serializes a row
 * itself: a row nothing edits keeps its raw line byte for byte, and every edit is the adapter's. Rows
 * are weighed by their raw lines and the cut is a line index, so one row is always one line.
 *
 * The adapter supplies: parse(line), weigh(line), drop(row) (never kept, never weighed), inert(row)
 * (kept, never weighed, never sent), isSeam(row), order(rows, cut), keep(rows, lines, order),
 * mayCarryImages(line), stripImages(row, take, budget), validate(keptLines, ctx), timestampOf(row).
 *
 * Moved out of trim.mjs (PR A of anima_dev/nightwatch_providers_design.md) with no change in behavior:
 * every archived transcript folds to the same bytes, report and exit before and after.
 */

// Per-line token estimate: chars/4 for text, with long base64 runs (image
// blobs in tool results, screenshots, data URIs) billed at the vision rate
// instead of the byte rate. A 200KB screenshot is ~273k base64 chars —
// chars/4 says 68k tokens, the provider's vision cost caps near 1,600. The
// raw-byte rule inflated image-heavy folds 4–6x three nights running
// (1.15M/333 and 1.29M/404 entries on the MV lane vs ~287k text folds),
// which starves the kept tail: the walk hits target in a handful of
// screenshot entries and drops conversation that would actually fit.
// min(1600, chars/4) never bills a small blob above the old estimate.
const BLOB_RUN = /[A-Za-z0-9+/]{4000,}={0,2}/g;
export function estLine(l) {
  let blobChars = 0;
  let blobTokens = 0;
  for (const m of l.matchAll(BLOB_RUN)) {
    blobChars += m[0].length;
    blobTokens += Math.min(1600, Math.ceil(m[0].length / 4));
  }
  return Math.ceil((l.length - blobChars) / 4) + blobTokens;
}

const OVERSHOOT = 1.25;

/**
 * Trim a transcript. `warn` receives each stderr line in order. Returns
 * { refused: { exit, message } } when there is nothing to cut at or the tail fails the adapter's check,
 * or { keptLines, report facts } otherwise. Writing the file is the caller's.
 */
export function trimTail({ lines, adapter, target, imageBudget, warn }) {
  const entries = lines.map((l) => adapter.parse(l));
  const torn = entries.filter((e) => e === null).length;
  if (torn) warn(`warning: ${torn} unparseable line(s) will be dropped`);

  // Walk from the end, accumulating the estimate per raw line (includes tool
  // results and metadata — the honest weight of what resumes), remembering the
  // suffix estimate AT each index so seams can be compared afterwards.
  let est = 0;
  let cut = lines.length; // index of first KEPT line
  const suffixEst = new Array(lines.length + 1).fill(0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!adapter.drop(entries[i]) && !adapter.inert(entries[i])) est += adapter.weigh(lines[i]);
    suffixEst[i] = est;
    if (est >= target && cut === lines.length) cut = i;
  }
  if (cut === lines.length) cut = 0; // whole session fits
  // The tail must OPEN at a seam (a human prompt, or a peer's cross-session
  // message — Ra's ruling, 10/9). Among all seams, take the one whose kept
  // estimate lands CLOSEST to the target: the old nearest-backward rule kept
  // everything since the human's last morning prompt on a lane-to-lane
  // afternoon (the live 958k-est overshoot at opus's 10/9 fold), when a peer
  // seam within sight of the target existed. Ties prefer the larger tail
  // (fold-TO keeps at least the tide line where it can).
  const walkCut = cut;
  let promptIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (!adapter.isSeam(entries[i])) continue;
    const dist = Math.abs(suffixEst[i] - target);
    if (dist < bestDist || (dist === bestDist && i < promptIdx)) {
      bestDist = dist;
      promptIdx = i;
    }
  }
  if (promptIdx === -1) return { refused: { exit: 1, message: 'no human prompt found anywhere — refusing to cut' } };
  cut = promptIdx;

  const { order, movedIn } = adapter.order(entries, cut);
  const { kept: keptRows, counts } = adapter.keep(entries, lines, order);
  const kept = keptRows.map((r) => r.line);
  let keptEst = 0;
  for (const r of keptRows) if (!adapter.inert(r.entry)) keptEst += adapter.weigh(r.line);

  // IMAGE BUDGET (10/25): every image a kept entry carries is sent again with every request the woken
  // session makes, as base64. Thirty photos read in one afternoon (~19 MB) left the fable lane's session
  // failing every request with "Unable to connect to API (EPROTO)", and a fold that kept them would have
  // carried the same weight into the wake. So the kept tail holds the NEWEST images up to IMAGE_BUDGET bytes
  // of base64 and replaces each older one with a line of text saying what was there. The words around an
  // image survive; only its pixels go. Newest first, because a recent screenshot is the likeliest to matter.
  // The fill is greedy, on purpose: an image bigger than what's left of the budget goes, and an older one that
  // still fits stays, so one oversized photo can't push every smaller, older screenshot out with it.
  let imageBytes = 0;
  const imagesStripped = { count: 0, bytes: 0 };
  const take = (bytes) => {
    if (imageBytes + bytes <= imageBudget) { imageBytes += bytes; return true; }
    imagesStripped.count++; imagesStripped.bytes += bytes;
    return false;
  };
  for (let k = kept.length - 1; k >= 0; k--) {
    if (!adapter.mayCarryImages(kept[k])) continue;
    let e; try { e = JSON.parse(kept[k]); } catch { continue; }
    // The request log (api-request-blob and kin) is never sent on resume: its copies neither count against
    // the budget nor take a place in it (a log copy once used up the whole budget and a real image went).
    if (adapter.inert(e)) continue;
    const edited = adapter.stripImages(e, take, imageBudget);
    if (edited) kept[k] = JSON.stringify(edited);
  }
  if (imagesStripped.count) {
    keptEst = 0;
    for (const l of kept) { let e = null; try { e = JSON.parse(l); } catch {} if (!adapter.inert(e)) keptEst += adapter.weigh(l); }
  }

  const problems = adapter.validate(kept, { movedIn });
  if (problems.length) return { refused: { exit: 1, message: `trim: OUTPUT CHECK FAILED, nothing written. ${problems.join('; ')}.` } };

  // Overshoot (incident fix 5, 10/8): the walk stops at the target, but the
  // tail has to start at a human prompt, and the nearest one can sit far back
  // (288k kept against a 150k target at 22:28 on 10/8, unreported). Say so.
  // Whether a cut may land on an assistant-turn boundary instead is a separate
  // design question: the tail still has to open with a valid user turn.
  const overshoot = keptEst > target * OVERSHOOT
    ? { ratio: Math.round((keptEst / target) * 100) / 100, extendedEntries: Math.max(0, walkCut - cut), walkCutAt: adapter.timestampOf(entries[walkCut]) }
    : null;
  if (overshoot) {
    warn(`trim: OVERSHOOT, kept ~${keptEst} tokens against a ${target} target (${overshoot.ratio}x): the nearest human prompt before the cut was ${overshoot.extendedEntries} entries further back.`);
  }

  return {
    keptLines: kept,
    facts: {
      entries, cut, torn, counts, movedIn, imagesStripped, overshoot, target,
      keptEntries: kept.length, totalEntries: lines.length, estTokens: keptEst,
    },
  };
}
