// Nightwatch DOM emitter — the JS port of skins/build_fixture.py (Phase B).
//
// PURE and BROWSER-SAFE: no node imports, no disk, no clock. Everything
// arrives in the snapshot: NOW, TZ, TIMELINE, DECK, LANES, NIGHT, LOG,
// ACTIVITY, SKINS ([[name, title]…], what the python read from manifests).
// The Tauri webview imports this file directly; server.mjs renders whole
// pages through it; the stills keep building from gui/fixture-data.mjs.
//
// ACCEPTANCE IS BYTE PARITY with build_fixture.py (the frozen fixture plus
// live snapshots at every range and a quiet night), so the formatting
// helpers below replicate PYTHON semantics exactly — html.escape's five
// entities, and round-half-even for both `round()` and `:.Nf` (JS toFixed
// rounds ties up; python banker's-rounds them: 0.0625 → ".062" not ".063").
// Section renderers (renderLanes, renderTimeline, …) exist so the app's
// refresh can re-render one region in place; renderGallery is separate so
// the app never ships the hidden test sheet (contract v0.8's lesson).
//
// Written by: claude-fable-5, 2026-10-06. Contract v0.9/0.10 (opus's half).

// ---------------------------------------------------------------- parity helpers
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// python f"{x:.Nf}": round the double's exact decimal expansion, half-even.
// toFixed(20) is exact for our magnitudes; the string round does the ties.
export function pyFixed(x, n) {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0);
  let s = Math.abs(x).toFixed(20);
  let [int, fracPart] = s.split('.');
  if (fracPart.length <= n) return (neg ? '-' : '') + int + (n ? '.' + fracPart.padEnd(n, '0') : '');
  const keep = fracPart.slice(0, n), rest = fracPart.slice(n);
  let roundUp;
  const first = rest[0];
  if (first < '5') roundUp = false;
  else if (first > '5' || /[1-9]/.test(rest.slice(1))) roundUp = true;
  else { // exact tie: round half to even
    const last = n ? keep[n - 1] : int[int.length - 1];
    roundUp = (Number(last) % 2) === 1;
  }
  let digits = int + keep;
  if (roundUp) {
    let arr = digits.split(''), i = arr.length - 1;
    while (i >= 0) { if (arr[i] === '9') { arr[i] = '0'; i--; } else { arr[i] = String(Number(arr[i]) + 1); break; } }
    if (i < 0) arr.unshift('1');
    digits = arr.join('');
  }
  const cut = digits.length - n;
  const out = n ? digits.slice(0, cut) + '.' + digits.slice(cut) : digits;
  return (neg && !/^0(\.0*)?$/.test(out) ? '-' : '') + out;
}

// python round(x) to int: half to even.
export function pyRound(x) {
  const fl = Math.floor(x), diff = x - fl;
  if (diff > 0.5) return fl + 1;
  if (diff < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

// python str() of a JSON number: ints print bare, floats shortest-roundtrip.
// JS String() is the same algorithm for both (JSON numbers that were ints in
// the file parse to integral doubles and print bare in py3 too, via int).
const num = (x) => String(x);

export function frac(t) {
  // 0.0625 -> ".0625", the way the stills were always written
  let s = pyFixed(t, 4).replace(/0+$/, '').replace(/\.$/, '');
  return s.startsWith('0.') ? s.slice(1) : s;
}

export function k(n) {
  return n >= 1e6 ? pyFixed(n / 1e6, 2).replace(/0+$/, '').replace(/\.$/, '') + 'M' : `${pyRound(n / 1e3)}k`;
}

export function k1(n) {
  // meter readouts: one decimal under 10k (4.8k), whole k above
  return n < 10_000 ? `${pyFixed(n / 1e3, 1)}k` : k(n);
}

// %H:%M in the snapshot's zone (python: local(iso).strftime("%H:%M")).
function hmLocal(iso, tz) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz })
    .format(new Date(iso.replace('Z', '+00:00')));
}

// ---------------------------------------------------------------- icons
// 24px stroke icons, currentColor. Skins can restyle them (colour, size) or
// hide them; they can't add new ones. A missing icon is a contract amendment.
export const ICONS = {
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  id: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h4M8 14h8"/>',
  since: '<path d="M4 12h12"/><path d="M12 8l4 4-4 4"/><path d="M20 6v12"/>',
  uptime: '<circle cx="12" cy="13.5" r="7"/><path d="M12 13.5V10M10 3h4M12 3v3.5M18.5 7l-1.6 1.6"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><path d="M4 4l16 16"/>',
  'terminal-hide': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10l4 4 4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  fold: '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4"/><path d="M4 17l8 4 8-4"/>',
  log: '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
  gear: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/><path d="M12 8v4l3 2"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  'bell-off': '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/>',
  launch: '<path d="M5 19l4-4"/><path d="M14 4c3 0 6 3 6 6l-7 7-6-6z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  minus: '<path d="M5 12h14"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  cycle: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
  repeat: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0 0 21 9.7C21 5.9 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  folder: '<path d="M3 7h6l2 2h10v9H3z"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  wand: '<path d="M4 20L15 9"/><path d="M15 4v2M19 8h2M18 5l1.5-1.5M12 6l-1-1M18 11l1 1"/>',
};

const icon = (name) => `<svg class="nw-icon" data-icon="${name}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function sprite() {
  const syms = Object.entries(ICONS).map(([n, p]) =>
    `<symbol id="i-${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round">${p}</symbol>`).join('');
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${syms}</svg>`;
}

// ---------------------------------------------------------------- pieces
const STATE_TIP = {
  awake: 'Awake', belled: 'Bell rung, fold due', folding: 'Folded; the window closes once the session goes quiet',
  sleeping: 'Asleep until their wake time', waking: 'Waking, waiting for the session to register',
  orphaned: 'Orphan-folded after their session died; emergency wake next', failed: 'Needs a hand',
  down: "The nightshift itself isn't running",
};
// The working/idle light (10/7), from Claude Code's own session status.
const ACTIVITY_TIP = { working: 'working (running inference)', idle: 'idle (session open)', waiting: 'needs you (a permission prompt or a question)' };
// The stage as a word on the card (Ra, 10/12): data-state stays the
// machinery's vocabulary for the skins; the word and its tip are the
// keeper's. A midday fold reads Cycling from bell to reopen; a Force fold
// reads Reopening; a bell whose rung has landed reads Rung's in. One short
// vocabulary for every skin (Ra, 10/12): each word fits the narrowest card
// (Glass) without truncating the model name, measured.
const STATE_WORD = {
  awake: 'Awake', belled: 'Bell rung', folding: 'Folded', sleeping: 'Asleep', waking: 'Waking',
  orphaned: 'Orphaned', failed: 'Needs you', down: 'Down',
};
const STAGE_TIP = {
  cycling: 'Midday fold: folding at their own seam, then reopening right away',
  refreshing: 'Closed, folding, and reopening now',
  rung: 'Rung written; the fold is next',
};
function stage(L) {
  const alive = L.state === 'awake' || L.state === 'belled' || L.state === 'folding';
  if (L.foldRequest?.tier && (alive || L.foldRequest.phase === 'refreshing')) return 'cycling';
  if (L.foldRequest?.phase === 'refreshing') return 'refreshing';
  if (L.state === 'belled' && L.rungWritten) return 'rung';
  return null;
}
const STAGE_WORD = { cycling: 'Cycling', refreshing: 'Reopening', rung: "Rung's in" };
const state_word = (L) => { const s = stage(L); return s ? STAGE_WORD[s] : (STATE_WORD[L.state] ?? L.state); };
const state_tip = (L) => { const s = stage(L); return (s ? STAGE_TIP[s] : STATE_TIP[L.state]) + (L.activity && ACTIVITY_TIP[L.activity] ? ` · ${ACTIVITY_TIP[L.activity]}` : ''); };

// Which actions make sense in which state. A disabled button stays in the DOM
// (skins lay out a stable toolbar) with aria-disabled and a tip saying why.
function actions(lane) {
  const s = lane.state;
  const awake = s === 'awake' || s === 'belled' || s === 'folding';
  const wakeable = s === 'sleeping' || s === 'failed' || s === 'orphaned';
  return [
    ['terminal', 'open-terminal', 'Open terminal', awake, awake ? "Bring this agent's terminal to the front" : 'No live session'],
    ['sun', 'wake', 'Wake', wakeable, wakeable ? 'Wake now' : 'Already awake'],
    ['moon', 'sleep', 'Sleep agent', awake, awake ? 'Rings the bell to fold this agent, then closes the window' : 'Not awake'],
    ['fold', 'emergency-fold', 'Force fold', awake, awake ? 'Closes them now, folds them, and reopens them; the fresh window writes the rung. For a full context or an API-error wall' : 'Nothing to fold'],
    ['log', 'show-log', 'Logs', true, "This agent's events and log lines"],
    ['gear', 'lane-settings', 'Agent settings', true, 'Model, hours, fold target'],
  ];
}

function spark(series, w = 120, h = 28) {
  const peak = Math.max(...series) || 1;
  const n = series.length;
  const pts = series.map((v, i) => `${pyFixed(i * w / (n - 1), 1)},${pyFixed(h - 2 - (v / peak) * (h - 4), 1)}`).join(' ');
  const total = series.reduce((a, b) => a + b, 0);
  return [pts, peak, total];
}

function spark_bars(series, w = 120, h = 28) {
  // The same series as columns, for skins that draw throughput in the
  // context meter's language (a filled track). Each <rect> carries --v (0..1).
  const peak = Math.max(...series) || 1;
  const n = series.length, slot = w / n;
  return series.map((v, i) =>
    `<rect x="${pyFixed(i * slot + slot * .15, 2)}" width="${pyFixed(slot * .7, 2)}" y="${pyFixed(h - (v / peak) * h, 2)}" height="${pyFixed((v / peak) * h, 2)}" style="--v: ${pyFixed(v / peak, 3)}"/>`).join('');
}

function time_el(dt_disp, cls = '') {
  const [dt, disp] = dt_disp;
  return `<time datetime="${dt}"${cls}>${esc(disp)}</time>`;
}

const MODELS = ['Fable 5', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5'];
// Models a NEW lane can pin (exact ids; the wake passes --model). Lane
// creation, 10/6: a lane's model never changes out from under it.
const NEW_MODELS = [['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']];
const model_opts = () => NEW_MODELS.map(([id, t]) => `<option value="${id}">${t}</option>`).join('');

// The preview's steps, from the machinery's dry run (nightwatch.mjs plan):
// the app shows exactly what apply will do (contract v0.10). The runtime
// renders host output with its own copy of this; the gallery uses the
// doc's example.
const PREVIEW_EXAMPLE = [
  { verb: 'Create', what: '~/Nightwatch/lark/', detail: 'the hub' },
  { verb: 'Write', what: 'identity.md', detail: 'from “About them” and the standard welcome' },
  { verb: 'Write', what: 'checkpoint.md', detail: 'one section, for this agent' },
  { verb: 'Create', what: 'ladder/ and memory/', detail: 'empty; they fill these from their first night' },
  { verb: 'Write', what: 'nightwatch.config.json', detail: 'persona (unnamed), 1 agent, 02:00 → 08:00, 250k' },
  { verb: 'Install', what: 'the nightshift', detail: 'rings the bell at night and wakes them in the morning' },
  { verb: 'Install', what: 'the session hook', detail: 'so the nightshift can tell which session is theirs' },
  { verb: 'Open', what: 'a Terminal window', detail: 'Claude Code (claude-opus-5-5), fresh session' },
];
const steps_html = (steps) => steps.map((st) =>
  `<li data-verb="${esc(st.verb.toLowerCase())}"><b>${esc(st.verb)}</b> <code>${esc(st.what)}</code> <span>${esc(st.detail)}</span></li>`).join('');

function schedule_fields(L) {
  // Per-lane schedule (Ra, 10/6): "Use global nightshift settings" is the
  // default; unticked, the lane keeps its own timer. The snapshot carries the
  // RESOLVED times, so the fields always show what this lane will really do.
  const sc = L.schedule ?? {};
  const inherit = sc.inherit ?? true;
  const dis = inherit ? ' disabled' : '';
  return `<label data-part="global-schedule"><input type="checkbox" data-schedule-toggle${inherit ? ' checked' : ''}>`
    + `<span>Use global nightshift settings</span></label>\n`
    + `        <label data-part="sleep">${icon('moon')}<span>Sleep</span><input type="time" value="${esc(sc.sleep ?? '')}"${dis}></label>\n`
    + `        <label data-part="wake">${icon('sun')}<span>Wake</span><input type="time" value="${esc(sc.wake ?? '')}"${dis}></label>`;
}

// A pending Fold now, narrated on the card; the countdown ticks in the runtime.
function fold_request(L, nowIso) {
  const fr = L.foldRequest;
  if (!fr) return '';
  const what = fr.tier ? 'Midday fold' : 'Force fold';
  if (fr.phase === 'requested') {
    // A soft midday request (Ra, 10/12) has no deadline: no countdown, no force.
    if (!fr.deadline) {
      return `<li data-part="fold-request" data-phase="requested" data-tip="Midday fold: ${esc(laneName(L))} folds at their own seam, then reopens right away">${icon('fold')}`
        + `<span>Midday fold · at their own seam</span></li>`;
    }
    const mins = Math.max(0, Math.floor((Date.parse(fr.deadline) - Date.parse(nowIso)) / 60000));
    return `<li data-part="fold-request" data-phase="requested" data-tip="${what}: if ${esc(laneName(L))} hasn't folded by then, they're folded anyway">${icon('fold')}`
      + `<span>${fr.tier ? 'Midday fold' : 'Bell rung'} · forcing in </span><time data-part="countdown" datetime="${esc(fr.deadline)}">${mins}m</time></li>`;
  }
  return `<li data-part="fold-request" data-phase="refreshing" data-tip="${what}: folded; the window closes and a fresh one opens">${icon('fold')}`
    + `<span>Folded${fr.forced ? ' (forced)' : ''} · waking fresh</span></li>`;
}

// Persona rows (Ra, 10/7): the lanes are grouped by persona, each group with
// its name and its own Add agent slot, in the order the personas first appear.
// A skin decides where the name sits (a gutter inside the app's edge, or a tab
// hanging off it); the cards no longer repeat it.
const PERSONA_STATE_ORDER = ['failed', 'orphaned', 'belled', 'folding', 'awake', 'waking', 'sleeping', 'down'];
function persona_groups(ctx) {
  const groups = new Map();
  for (const L of ctx.LANES) {
    const p = L.persona ?? { id: 'persona', name: 'Persona' };
    if (!groups.has(p.id)) groups.set(p.id, { p, lanes: [] });
    groups.get(p.id).lanes.push(L);
  }
  if (groups.size === 0) return add_slot(false, ctx.SCHEDULE);
  return [...groups.values()].map(({ p, lanes }) => {
    // The persona carries their agents' state the way a card carries its own
    // (Ra, 10/7: the accent bar is mechanical): trouble first, then a bell, a
    // fold, anyone awake; asleep only when everyone is. Skins colour its
    // accent and badge from it exactly as they do a card's.
    const pstate = PERSONA_STATE_ORDER.find((st) => lanes.some((L) => L.state === st)) ?? 'sleeping';
    // The persona card (Ra, 10/7): a header (badge, name, the caret that folds
    // the card's own body) and a body: one light per agent, a show/hide-agents
    // button and the persona's settings. Hidden agents leave the card standing.
    const dots = lanes.map((L) => `<li data-lane="${esc(L.id)}" data-state="${L.state}"${L.activity ? ` data-activity="${L.activity}"` : ''}` +
      ` data-tip="${esc(laneName(L))}: ${L.state}${L.activity ? ` · ${L.activity}` : ''}"></li>`).join('');
    const nm = esc(p.name);
    return `<section class="nw-persona" data-persona="${esc(p.id)}"${p.hub ? ` data-hub="${esc(p.hub)}"` : ''} data-state="${pstate}" data-open="true" aria-label="${nm}">` +
      `<article data-part="persona-card" data-card-open="true">` +
      `<h2 data-part="persona-name" data-action="toggle-persona-card" aria-expanded="true">` +
      `<span data-part="persona-avatar" aria-hidden="true">${esc(p.name.charAt(0).toUpperCase())}</span>` +
      `<span data-part="label">${nm}</span><span data-part="persona-toggle" aria-hidden="true">${icon('chev')}</span></h2>` +
      `<div data-part="persona-body"><ul data-part="persona-agents" aria-label="${nm}'s agents">${dots}</ul>` +
      `<div data-part="persona-buttons"><button type="button" data-action="toggle-persona" data-part="show-agents" aria-pressed="true" aria-label="Hide agents" data-tip="Show or hide ${nm}'s agent cards">${icon('eye')}${icon('eye-off')}</button>` +
      `<button type="button" data-action="persona-settings" aria-label="Persona settings" data-tip="${nm}'s settings">${icon('gear')}</button></div></div></article>` +
      lanes.map((L) => lane_card(L, ctx.NOW, ctx.TZ)).join('') + add_slot(false, ctx.SCHEDULE, 'form', [], p.id) + '</section>';
  }).join('') +
    // Add persona: a small floating + after the last persona (Ra, 10/7).
    `<button type="button" class="nw-add-persona" data-action="add-persona" aria-label="Add persona" data-tip="Add a persona">${icon('plus')}</button>`;
}

// The session id isn't shown anywhere (Ra, 10/7: rarely relevant); it's one
// click away here for whoever needs it. The full id when the snapshot has it.
function copy_session(L) {
  const sid = L.sessionId ?? L.session;
  if (!sid || sid === '—') return '';
  return `<div data-part="session-row"><button type="button" data-action="copy-session" data-session="${esc(sid)}" data-tip="${['awake', 'belled', 'folding'].includes(L.state) ? "Copy this agent's current session ID" : "Copy the ID of this agent's last active session"}">${icon('id')}<span>Copy session ID</span></button></div>`;
}

function lane_settings(L) {
  // The lane's own settings expand out of its column (Ra, 10/5). Global
  // schedule is a default; each lane can override its hours here.
  const opts = MODELS.map((m) => `<option${m === L.model ? ' selected' : ''}>${m}</option>`).join('');
  const open_ = L.settingsOpen ? 'true' : 'false';
  return `<section data-part="settings" data-open="${open_}" aria-label="${esc(laneName(L))} settings">
        <label>${icon('id')}<span>Model</span><select>${opts}</select></label>
        ${schedule_fields(L)}
        <label>${icon('gauge')}<span>Fold at</span><input type="number" value="${Math.floor(L.target / 1000)}"><i>k</i></label>
        ${copy_session(L)}
        <label data-part="armed"><input type="checkbox"${(L.armed ?? true) ? ' checked' : ''}><span>Nightshift folds and wakes this lane</span></label>
        <label data-part="confirm-remove"><input type="checkbox" data-gate="remove-lane"><span>Allow removing this lane</span></label>
        <div data-part="buttons"><button type="button" data-action="remove-lane" data-danger="true" aria-disabled="true" data-gated="true" data-tip="Stop managing this agent. Their transcripts and ladder stay on disk. Tick the box above to allow it.">${icon('x')}<span>Remove</span></button>
          <button type="button" data-action="save-lane" data-primary="true">${icon('check')}<span>Save</span></button></div>
      </section>`;
}

// Add agent (lane creation, 10/6): the form, then a preview of exactly
// what will be written (data-step="form" | "preview"), then one confirm.
function add_slot(open_ = false, sc = { sleep: '02:00', wake: '08:00' }, step = 'form', steps = [], persona = null) {
  return `
    <article class="nw-lane nw-add" data-state="add" data-open="${open_ ? 'true' : 'false'}" data-step="${step}"${persona ? ` data-persona="${esc(persona)}"` : ''}>
      <button type="button" data-action="add-lane" data-part="add" aria-expanded="${open_ ? 'true' : 'false'}">${icon('plus')}<span>Add agent</span></button>
      <form data-part="add-form" aria-label="New agent">
        <label><span>Lane name</span><input type="text" data-field="id" placeholder="e.g. scout" autocomplete="off" spellcheck="false"></label>
        <label><span>Model</span><select data-field="model">${model_opts()}</select></label>
        <label data-part="global-schedule"><input type="checkbox" data-field="inherit" checked><span>Use global nightshift settings</span></label>
        <div data-part="own-schedule"><label>${icon('moon')} Sleep <input type="time" data-field="sleep" value="${esc(sc.sleep)}" disabled></label>
          <label>${icon('sun')} Wake <input type="time" data-field="wake" value="${esc(sc.wake)}" disabled></label></div>
        <label><span>Fold target</span><input type="number" data-field="targetK" value="250" min="10" max="2000" step="10"><span data-part="unit">k</span></label>
        <label><span>Start from</span><select data-field="first"><option value="fresh">A fresh session</option><option value="adopt">An existing Claude Code session (advanced)</option></select></label>
        <label data-part="adopt" hidden><span>Session</span><select data-field="session"><option value="">Looking for sessions…</option></select></label>
        <label data-part="armed"><input type="checkbox" data-field="armed" checked><span>Nightshift folds and wakes this lane</span></label>
        <p data-part="error" role="alert" hidden></p>
        <div data-part="buttons"><button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="plan-lane" data-primary="true">${icon('next')}<span>Preview</span></button></div>
      </form>
      <section data-part="preview" aria-label="What adding this agent will do">
        <h4>This will</h4>
        <ol data-part="steps">${steps_html(steps)}</ol>
        <div data-part="buttons"><button type="button" data-action="plan-back">Back</button>
          <button type="button" data-action="create-lane" data-primary="true">${icon('plus')}<span>Add and wake</span></button></div>
      </section>
    </article>`;
}

// Set up (a new persona, 10/6): who they'll be, their nights, a preview;
// or an import first, which pre-fills "who". The name is optional: a
// persona may name themselves later, by their own hand.
function setup_dialog(sc, open_ = false, step = 'who', steps = []) {
  return `
  <section class="nw-setup" aria-label="set up a persona" data-open="${open_ ? 'true' : 'false'}" data-step="${step}" role="dialog">
    <h3 data-part="heading">${icon('wand')} Set up a persona<button type="button" data-action="close-setup" data-part="close" aria-label="Close set up">${icon('x')}</button></h3>
    <ol data-part="progress"><li data-step="who">Who they'll be</li><li data-step="nights">Their nights</li><li data-step="preview">Preview</li></ol>
    <fieldset data-step="who">
      <label><span>Name</span><input type="text" data-field="name" placeholder="Leave empty to let them choose" autocomplete="off"></label>
      <label data-part="about"><span>About them</span><textarea data-field="about" rows="4" placeholder="Who they are and why they exist, in a paragraph. This seeds their identity file."></textarea></label>
      <label><span>Your name</span><input type="text" data-field="person" placeholder="So they know who you are" autocomplete="off"></label>
      <label><span>Model</span><select data-field="model">${model_opts()}</select></label>
      <label><span>Folder</span><input type="text" data-field="hub" value="~/Nightwatch/" spellcheck="false"></label>
      <button type="button" data-action="setup-import" data-part="import-link">${icon('folder')}<span>Import an existing persona instead…</span></button>
    </fieldset>
    <fieldset data-step="import">
      <p data-part="hint">Choose a folder with an <code>identity.md</code>. A <code>name.txt</code>, a <code>memory/</code> folder and ladder rungs are optional, and anything missing stays missing.</p>
      <label><span>Folder</span><input type="text" data-field="from" placeholder="/path/to/persona" spellcheck="false"></label>
      <button type="button" data-action="check-import">${icon('check')}<span>Check folder</span></button>
      <ul data-part="found"></ul>
    </fieldset>
    <fieldset data-step="nights">
      <div data-part="schedule"><label>${icon('moon')} Sleep <input type="time" data-field="sleep" value="${esc(sc.sleep)}"></label>
        <label>${icon('sun')} Wake <input type="time" data-field="wake" value="${esc(sc.wake)}"></label></div>
      <label><span>Fold target</span><input type="number" data-field="targetK" value="250" min="10" max="2000" step="10"><span data-part="unit">k</span></label>
      <label data-part="armed"><input type="checkbox" data-field="armed" checked><span>Nightshift folds and wakes them</span></label>
    </fieldset>
    <section data-step="preview" aria-label="What setting up will do">
      <h4>This will</h4>
      <ol data-part="steps">${steps_html(steps)}</ol>
    </section>
    <p data-part="error" role="alert" hidden></p>
    <div data-part="buttons"><button type="button" data-action="setup-back">Back</button>
      <button type="button" data-action="setup-next" data-primary="true">${icon('next')}<span>Next</span></button>
      <button type="button" data-action="create-persona" data-primary="true">${icon('wand')}<span>Create and wake them</span></button></div>
  </section>`;
}

// Context windows by model (Anthropic's model table, 2026-09-25). The bar
// fills against the window; the fold target is a tick on it (--target).
// SEMANTICS (Ra, 10/7): targetTokens is where the nightly fold trims the
// tail back TO, not a threshold folding happens AT — nothing in the
// machinery folds by size. So the colour level keys on WINDOW headroom
// (the thing that can actually run out), and the tick is a floor marker:
// "tonight's fold brings the bar back to about here."
const WINDOWS = {
  'Fable 5': 1_000_000, 'Fable 5.1': 1_000_000, 'Opus 5.5': 1_000_000, 'Opus 5': 1_000_000,
  'Sonnet 5.5': 1_000_000, 'Sonnet 5': 1_000_000, 'Haiku 4.5': 200_000,
};

// The deck's two clocks (Ra, 10/7, after DJ software): time UP counts up from
// when the lane woke, beside the bell's countdown. A lane in any other state
// counts its time in that state. The session id lives behind the lane's
// Copy session ID button (settings) instead.
function elapsed(sinceIso, nowIso) {
  const ms = Date.parse(nowIso) - Date.parse(sinceIso);
  if (!(ms > 0)) return '0m';
  const m = pyRound(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
function uptime_li(L, nowIso) {
  const up = L.state === 'awake' || L.state === 'belled' || L.state === 'folding';
  const disp = nowIso ? elapsed(L.since[0], nowIso) : '';
  // The number is on the card already; the tip gives the start, like the bell's ("Next bell: 02:00").
  const tip = up ? `Up since: ${L.since[1]}` : `${L.state.charAt(0).toUpperCase()}${L.state.slice(1)} since: ${L.since[1]}`;
  return `<li data-part="uptime" data-tip="${esc(tip)}">${icon(up ? 'sun' : 'moon')}<time datetime="${L.since[0]}" data-part="elapsed">${esc(disp)}</time></li>`;
}

function lane_card(L, nowIso = null, tz = undefined) {
  const window_ = L.window || WINDOWS[L.model] || L.target;
  const fill = window_ ? L.ctx / window_ : 0;
  const of_target = L.target ? L.ctx / L.target : 0;
  const tgt = window_ ? L.target / window_ : 1;
  const level = fill >= 0.9 ? 'over' : fill >= 0.75 ? 'high' : 'ok';
  const [pts, peak, total] = spark(L.series);
  const alarm = 'alert' in L && L.alert != null;
  // An amber card waits to be looked at (Ra, 10/12); only a red one opens its card.
  const red = alarm && L.alert.level !== 'warn';
  let nxt = '';
  if (L.next) {
    const [what, dt, disp] = L.next;
    // Local time, like every other clock here (Ra, 10/7: the raw ISO slice read as UTC).
    // The slot is the lane's nightly switch (Ra, 10/8): lit while armed, a
    // click disarms; disarmed it's a crossed bell, unlit, "none", and a click
    // arms it. No time = nothing scheduled.
    nxt = !dt ? `<li data-part="next" data-action="arm-lane" aria-pressed="false" data-tip="Disarmed: no bell or wake scheduled. Click to arm.">${icon('bell-off')}<span>${esc(disp)}</span></li>`
      : `<li data-part="next" data-action="arm-lane" aria-pressed="true" data-tip="${what === 'fold' ? `Folds by ${hmLocal(dt, tz)} if they haven't folded themselves` : `Next ${what}: ${hmLocal(dt, tz)}`}. Click to disarm.">${icon('bell')}` +
      `<time datetime="${dt}" data-part="countdown">${esc(disp)}</time></li>`;
  }
  // The midday cycle's switch (Ra, 10/12), beside the bell: lit while the
  // lane folds itself midday (soft bell, then urgent), a click turns it off
  // or on. Off, the lane only folds at its nightly bell.
  const mc = L.midday;
  const pct = (v, d) => Math.round((v ?? d) * 100);
  const mid = mc
    ? `<li data-part="midday" data-action="toggle-midday" aria-pressed="true" data-tip="Midday cycle on: a soft bell at ${pct(mc.softPct, 0.85)}% of the window, an urgent one at ${pct(mc.urgentPct, 0.95)}%. Click to turn off.">${icon('cycle')}</li>`
    : `<li data-part="midday" data-action="toggle-midday" aria-pressed="false" data-tip="Midday cycle off: they fold only at the nightly bell. Click to turn on.">${icon('cycle')}</li>`;
  // Accordion. The viewer opens any lane with an un-acked alarm: trouble
  // never hides behind a closed card.
  const open_ = (L.open || red) ? 'true' : 'false';
  let glance_next = '';
  if (L.next) {
    const [what, dt, disp] = L.next;
    glance_next = `${icon(what === 'bell' ? 'bell' : what === 'fold' ? 'fold' : 'sun')}<time datetime="${dt}">${esc(disp)}</time>`;
  }
  let alert = '';
  if (alarm) {
    const a = L.alert;
    const fixes = a.fixes.map(([ic, act, lbl, tip]) =>
      `<button type="button" data-action="${act}" data-part="fix" data-tip="${esc(tip)}">${icon(ic)}<span>${esc(lbl)}</span></button>`).join('');
    // An amber card (level warn, Ra 10/12) is important, not urgent: role
    // status, not alert, so a screen reader doesn't interrupt for it either.
    const warn = a.level === 'warn';
    alert = `<div class="nw-alert" role="${warn ? 'status' : 'alert'}"${warn ? ' data-level="warn"' : ''} data-kind="${a.kind}" data-acked="false" data-ack-id="${esc(L.id)}:${a.kind}:${esc(String(a.at[0]))}">` +
      `${icon(a.icon ?? 'warn')}<p data-part="title">${esc(a.title)}</p>` +
      `<p data-part="cause">${esc(a.cause)}</p>` +
      `${time_el(a.at, ' data-part="time"')}` +
      `<div data-part="fixes">${fixes}</div>` +
      `<button type="button" data-action="ack" data-part="ack" data-short="OK" ` +
      `data-tip="Hide it here. This only hides it on this screen; the heartbeat still DMs Ra in the morning.">${icon('check')}<span>Got it</span></button>` +
      `</div>`;
  }
  const acts = actions(L).map(([ic, act, lbl, ok, tip]) =>
    `<button type="button" data-action="${act}" aria-label="${esc(lbl)}" data-tip="${esc(tip)}"` +
    `${ok ? '' : ' aria-disabled="true"'}${act === 'emergency-fold' ? ' data-danger="true"' : ''}` +
    `${act === 'lane-settings' ? (L.settingsOpen ? ' aria-expanded="true"' : ' aria-expanded="false"') : ''}>${icon(ic)}</button>`).join('');
  const ctx_disp = L.ctx ? `~${k(L.ctx)} of ${k(window_)}` : `— of ${k(window_)}`;
  return `
    <article class="nw-lane" data-lane="${L.id}"${L.name ? ` data-name="${esc(L.name)}"` : ''} data-state="${L.state}" data-open="${open_}"${stage(L) ? ` data-stage="${stage(L)}"` : ''}${alarm ? ' data-alarm="true"' : ''}${L.role === 'switchboard' ? ' data-switchboard="true"' : ''}${L.activity ? ` data-activity="${L.activity}"` : ''}>
      <header data-action="toggle-lane">
        <span data-part="avatar" data-model="${L.modelId}" aria-hidden="true">${esc(laneName(L)[0].toUpperCase())}</span>
        <div data-part="ident"><h2 data-part="name">${esc(laneName(L))}</h2>
        <span data-part="model" data-tip="${esc(L.modelId)}">${esc(L.model)}</span></div>
        <span data-part="glance" aria-hidden="true"><span data-part="mini" data-level="${level}" style="--fill: ${pyFixed(Math.min(fill, 1.2), 3)}; --target: ${pyFixed(Math.min(tgt, 1), 3)}"></span>${glance_next}</span>
        <span data-part="state" data-tip="${esc(state_tip(L))}"><i aria-hidden="true"></i><span>${esc(state_word(L))}</span></span>
        <button type="button" data-part="toggle" aria-expanded="${open_}" aria-controls="body-${L.id}" aria-label="${open_ === 'true' ? 'Collapse' : 'Expand'} ${esc(laneName(L))}">${icon('chev')}</button>
      </header>
      <div data-part="body" id="body-${L.id}">
      <ul data-part="facts">
        ${uptime_li(L, nowIso)}
        ${nxt}${mid}
        ${nowIso ? fold_request(L, nowIso) : ''}
      </ul>
      <div data-part="meters">
        <div data-part="context" data-level="${level}" style="--fill: ${pyFixed(Math.min(fill, 1.2), 3)}; --target: ${pyFixed(Math.min(tgt, 1), 3)}" role="meter" aria-valuenow="${pyFixed(fill, 2)}"
             aria-label="Context used of the model's window" data-tip="Context ${ctx_disp} (${pyRound(fill * 100)}% of the window). The tick is tonight's fold target: the fold trims the tail back to ~${k(L.target)}${L.ctx && of_target <= 1 ? ' (already under it)' : ''}.">${icon('gauge')}<span data-part="bar"></span><span data-part="value">${pyRound(fill * 100)}%</span></div>
        <div data-part="throughput" data-tip="Output tokens per 10 minutes, last 4 hours (peak ${peak > 1 ? k(peak) : 0}, total ${total ? k(total) : 0})"
             data-series="${L.series.map(num).join(',')}" data-bucket-min="10"${total ? '' : ' data-empty="true"'}>${icon('bolt')}<svg viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/><g data-part="bars">${spark_bars(L.series)}</g></svg><span data-part="value" data-tip="Last 10 minutes">${L.series[L.series.length - 1] ? k1(L.series[L.series.length - 1]) : '0'}</span></div>
      </div>
      ${alert}
      <nav data-part="actions" aria-label="${esc(laneName(L))} actions">${acts}</nav>
      ${lane_settings(L)}
      </div>
    </article>`;
}

// NightStrip: repeated nodes are GROUPED (one fact with data-count="3").
const NODE_ICON = { bell: 'bell', fold: 'fold', close: 'moon', launch: 'launch', 'wake-failed': 'warn', wake: 'sun', context: 'gauge' };

function node_li(ctx, [kind, st, t, tm, tip, c], lanes = null, stack = 0) {
  let lane_attr = lanes ? ` data-lanes="${lanes.join(' ')}"` : '';
  if (lanes && lanes.length === Object.keys(ctx.NIGHT).length) {
    lane_attr += ' data-all="true"'; // every lane: skins may omit the lane chips
  }
  const chips = lanes ? '<span data-part="lanes">' + lanes.map((l) => `<i data-lane="${l}">${l[0].toUpperCase()}</i>`).join('') + '</span>' : '';
  return `<li class="nw-node" data-kind="${kind}" data-status="${st}"${kind === 'wake-failed' ? ' data-alarm="true"' : ''}` +
    `${c > 1 ? ` data-count="${c}"` : ''}${lane_attr} style="--t: ${num(t)}; --stack: ${stack}" data-tip="${esc(tip)}">` +
    `${icon(NODE_ICON[kind])}<time>${tm}</time>${c > 1 ? `<span data-part="count">×${c}</span>` : ''}${chips}</li>`;
}

// A lane's name on its card, and its label where every lane is listed at
// once (timeline rows, log): the same unless several personas share the page
// (gui/hubs.mjs qualifies ids as "<persona>/<lane>" then).
const laneName = (L) => L.given ?? L.name ?? L.id;
function laneLabel(ctx, id) {
  const L = ctx.LANES.find((x) => x.id === id);
  if (L) return L.label ?? L.given ?? L.id;
  const i = id.indexOf('/');
  const p = i < 0 ? null : ctx.LANES.map((x) => x.persona).find((x) => x && x.id === id.slice(0, i));
  return p ? `${p.name} · ${id.slice(i + 1)}` : id;
}

function combined_nodes(ctx) {
  // Compressed view: ONE track for every lane. Identical events (same kind,
  // status and minute) merge into one node that names its lanes; near
  // neighbours get a --stack index so skins can fan them apart.
  const merged = new Map();
  for (const [lane, nodes] of Object.entries(ctx.NIGHT)) {
    for (const [kind, st, t, tm, tip, c] of nodes) {
      const key = `${kind}\u0000${st}\u0000${tm}`;
      if (merged.has(key)) merged.get(key).lanes.push(lane);
      else merged.set(key, { kind, st, t, tm, tip, c, lanes: [lane] });
    }
  }
  const out = [];
  let prev_t = -1, stack = 0;
  for (const n of [...merged.values()].sort((a, b) => a.t - b.t)) {
    stack = n.t - prev_t < 0.05 ? stack + 1 : 0;
    prev_t = n.t;
    const tip = n.tip + ` (${n.lanes.join(', ')})`;
    out.push(node_li(ctx, [n.kind, n.st, n.t, n.tm, tip, n.c], n.lanes, stack));
  }
  return out.join('');
}

const RANGES = [['8h', 'Last 8 hours'], ['24h', 'Last 24 hours'], ['3d', 'Last 3 days'], ['7d', 'Last 7 days']];

function range_buttons(current = '8h') {
  // The viewer re-renders strips and axis for the chosen interval; --t is
  // always 0..1 across [data-from, data-to], so skins never change.
  return RANGES.map(([r, tip]) =>
    `<button type="button" role="radio" data-range="${r}" aria-checked="${r === current ? 'true' : 'false'}" data-tip="${tip}">${r}</button>`).join('');
}

function monotone_path(pts) {
  // Fritsch-Carlson monotone cubic: smooth, but never overshoots, so a run
  // of zero buckets stays flat at zero instead of dipping below the axis.
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[d.length - 1]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
    } else {
      const a = m[i] / d[i], b = m[i + 1] / d[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * d[i]; m[i + 1] = t * b * d[i];
      }
    }
  }
  let out = `M${pyFixed(xs[0], 1)},${pyFixed(ys[0], 1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    out += ` C${pyFixed(xs[i] + dx, 1)},${pyFixed(ys[i] + m[i] * dx, 1)} ${pyFixed(xs[i + 1] - dx, 1)},${pyFixed(ys[i + 1] - m[i + 1] * dx, 1)} ${pyFixed(xs[i + 1], 1)},${pyFixed(ys[i + 1], 1)}`;
  }
  return out;
}

function peak_at(ctx, pt) {
  // The peak bucket's centre in local time, to the nearest 10 minutes.
  const a = Date.parse(ctx.TIMELINE.from.replace('Z', '+00:00'));
  const b = Date.parse(ctx.TIMELINE.to.replace('Z', '+00:00'));
  const t = new Date(a + (b - a) * pt + 5 * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ctx.TZ })
    .formatToParts(t);
  const h = parts.find((p) => p.type === 'hour').value;
  const mnt = Math.floor(Number(parts.find((p) => p.type === 'minute').value) / 10) * 10;
  return `${h}:${String(mnt).padStart(2, '0')}`;
}

function sleep_bands(ctx) {
  // One band per night in the interval (TIMELINE.sleep_bands); a single
  // TIMELINE.sleep pair is the older shape. Bands too narrow for the word
  // keep it as a tip instead, so 7d doesn't print "asleep" seven times.
  const T = ctx.TIMELINE;
  const bands = T.sleep_bands || (T.sleep ? [T.sleep] : []);
  let out = '';
  for (const [a, b] of bands) {
    const word = b - a >= .1 ? 'asleep' : '';
    out += `<span data-part="sleep" style="--from: ${frac(a)}; --to: ${frac(b)}"` +
      `${word ? '' : ' data-narrow="true" data-tip="Asleep"'}>${word}</span>`;
  }
  return out;
}

// The strip's bucket, in words: 48 buckets over the range (10 minutes at 8h,
// 3.5 hours at 7d). TIMELINE.bucket_min; older snapshots had 10 implicitly.
const bucket_words = (m) => m < 60 ? `${m} minutes` : `${+(m / 60).toFixed(1)} hour${m === 60 ? '' : 's'}`;

function activity(ctx) {
  const bm = ctx.TIMELINE.bucket_min ?? 10;
  // The night's shape. Same --t axis as the strips; svg coordinates are
  // 0..1000 across the interval, 0..40 down. Fixture-supplied pieces:
  //   grid    hour lines (skins colour them)
  //   fill    a vertical gradient (skins set the two stops' colours)
  //   area / line   a monotone smooth curve
  //   sleep   the scheduled sleep window, as HTML so its label isn't stretched
  //   peak    the busiest bucket, as HTML, with --t and --v (0..1)
  // A quiet night (every bucket 0) is real live data: scale by 1, hide the peak.
  const A = ctx.ACTIVITY;
  const n = A.length;
  let peak = Math.max(...A);
  const quiet = peak <= 0;
  peak = peak > 0 ? peak : 1;
  const pts = A.map((v, i) => [1000 * (i + .5) / n, 40 - 34 * v / peak]);
  const line = monotone_path(pts);
  const area = `M${pyFixed(pts[0][0], 1)},40 L` + line.slice(1) + ` L${pyFixed(pts[pts.length - 1][0], 1)},40 Z`;
  const bars = A.map((v, i) =>
    `<rect x="${pyFixed(1000 * i / n, 1)}" width="${pyFixed(1000 / n * .7, 1)}" y="${pyFixed(40 - 34 * v / peak, 1)}" height="${pyFixed(34 * v / peak, 1)}" style="--v: ${pyFixed(v / peak, 3)}"/>`).join('');
  const grid = Array.from({ length: 8 }, (_, h) => 62.5 + 125 * h).map((x) =>
    `<line x1="${pyFixed(x, 1)}" x2="${pyFixed(x, 1)}" y1="0" y2="40"/>`).join('');
  // On a quiet series peak was substituted with 1 for scaling, which is not
  // in the list — index() must not go hunting for it (the python learned
  // this on the first quiet morning; the peak chip is hidden anyway).
  const pi = quiet ? 0 : A.indexOf(peak);
  const pt = (pi + .5) / n;
  return `<div data-part="activity" data-illustrative="true" data-bucket-min="${bm}" data-series="${A.map(num).join(',')}" ` +
    `data-tip="Output tokens, all agents, per ${bucket_words(bm)}">` +
    `<svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><linearGradient id="nw-activity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" data-part="fill-top"/><stop offset="1" data-part="fill-bottom"/></linearGradient></defs>` +
    `<g data-part="grid">${grid}</g><path data-part="area" fill="url(#nw-activity-fill)" d="${area}"/><path data-part="line" d="${line}"/>` +
    `<g data-part="bars">${bars}</g></svg>` +
    sleep_bands(ctx) +
    `<span data-part="peak"${quiet ? ' hidden' : ''} style="--t: ${pyFixed(pt, 3)}; --v: 1" data-tip="Peak: ${k(peak)} tokens in ${bucket_words(bm)}, around ${peak_at(ctx, pt)}">${k(pyRound(peak / bm))}/min</span></div>`;
}

function night(ctx) {
  // Both views are in the DOM; the app's data-timeline-mode picks one, so a
  // skin can switch with CSS alone (and animate the switch if it likes).
  let strips = '';
  for (const [lane, nodes] of Object.entries(ctx.NIGHT)) {
    strips += `<ol class="nw-strip" data-lane="${lane}" data-label="${esc(laneLabel(ctx, lane))}" data-mode="expanded">${nodes.map((nd) => node_li(ctx, nd)).join('')}</ol>`;
  }
  strips += `<ol class="nw-strip" data-lane="all" data-mode="compressed">${combined_nodes(ctx)}</ol>`;
  strips += activity(ctx);
  const T = ctx.TIMELINE;
  return `
  <section class="nw-timeline" aria-label="timeline" data-range="${T.range}" data-from="${T.from}" data-to="${T.to}">
    <h3 data-part="heading">Timeline <span>${esc(T.label)}</span></h3>
    <div data-part="range" role="radiogroup" aria-label="Interval shown">${range_buttons(T.range)}</div>
    <div data-part="axis" aria-hidden="true">${T.ticks.map(([t, lb]) => `<span style="--t: ${frac(t)}">${esc(lb)}</span>`).join('')}</div>
    <div data-part="sleep-bands" aria-hidden="true">${sleep_bands(ctx)}</div>
    ${strips}
    <p data-part="empty" hidden>No nights yet. Your agents' sleep and wake will draw here.</p>
  </section>`;
}

// The log: every event the nightshift emits (events.jsonl), newest first,
// with fold rows carrying their numbers. Filtering is app logic: the viewer
// sets [hidden] on rows whose kind is switched off, so skins need no rule per
// kind. Heartbeats start hidden, which is the filter doing its job.
const LOG_KINDS = [['bell', 'bell', 'Bells', true], ['fold', 'fold', 'Folds', true], ['close', 'moon', 'Closes', true],
  ['launch', 'launch', 'Launches', true], ['wake', 'sun', 'Wakes', true], ['wake-failed', 'warn', 'Failures', true],
  ['context', 'gauge', 'Context', true], ['heartbeat', 'check', 'Heartbeats', false]];
const LOG_ICON = { bell: 'bell', fold: 'fold', close: 'moon', launch: 'launch', wake: 'sun', 'wake-failed': 'warn', context: 'gauge', heartbeat: 'check' };

function log(ctx) {
  const shown = Object.fromEntries(LOG_KINDS.map(([kind, , , on]) => [kind, on]));
  const filters = LOG_KINDS.map(([kind, ic, label, on]) =>
    `<label data-kind="${kind}" data-tip="Show or hide ${label.toLowerCase()}"><input type="checkbox"${on ? ' checked' : ''}>${icon(ic)}<span>${label}</span></label>`).join('');
  let rows = '';
  for (const [day, events] of ctx.LOG) {
    rows += `<li class="nw-day" data-part="day">${day}</li>`;
    for (const [tm, lane, kind, st, what, fold, c] of events) {
      let detail = '', attrs = '';
      if (fold) {
        const [kp, tot] = fold.kept;
        const est = fold.est, tg = fold.target;
        attrs = ` data-reason="${fold.reason}" data-level="${est / tg > 1.5 ? 'over' : 'ok'}"` +
          ` style="--kept: ${pyFixed(kp / tot, 3)}; --est: ${pyFixed(est / tg, 2)}"`;
        detail = `<span data-part="detail"><span data-part="kept" data-tip="${kp} of ${tot} entries kept">${kp}/${tot}</span>` +
          `<span data-part="est" data-tip="Estimated ${k(est)} tokens against a ${k(tg)} target">${k(est)}</span>` +
          `<code data-part="tail">${fold.tail}</code></span>`;
      }
      const hidden = shown[kind] ? '' : ' hidden';
      rows += `<li class="nw-event" data-kind="${kind}" data-lane="${lane}" data-status="${st}"` +
        `${kind === 'wake-failed' ? ' data-alarm="true"' : ''}${c > 1 ? ` data-count="${c}"` : ''}${attrs}${hidden}>` +
        `<time data-part="time">${tm}</time><span data-part="lane">${esc(laneLabel(ctx, lane))}</span>${icon(LOG_ICON[kind])}` +
        `<span data-part="what">${esc(what)}${c > 1 ? ` <b data-part="count">×${c}</b>` : ''}</span>${detail}</li>`;
    }
  }
  return `
  <section class="nw-log" aria-label="event log">
    <h3 data-part="heading">Log</h3>
    <div data-part="filters" role="group" aria-label="Show these events">${filters}<button type="button" data-action="reset-log" data-part="reset" aria-label="Show everything" data-tip="Back to the default view: every agent, the usual kinds of event">${icon('repeat')}</button></div>
    <ol data-part="events">${rows}</ol>
    <p data-part="empty" hidden>Nothing yet. Every bell, fold and wake will be written here.</p>
  </section>`;
}

function settings(ctx) {
  // Settings, one panel per persona (Ra, 10/7: "per persona"; the gear on the
  // persona's card opens it): that persona's schedule, their lanes' targets and
  // nightly switches, and their own nightshift's health. Everything from the
  // snapshot, nothing frozen; the health check is derived from facts the head
  // and cards already show, so the panel can never disagree with them.
  const groups = new Map();
  for (const L of ctx.LANES) {
    const p = L.persona ?? { id: 'persona', name: 'Persona' };
    if (!groups.has(p.id)) groups.set(p.id, { p, lanes: [] });
    groups.get(p.id).lanes.push(L);
  }
  if (!groups.size) return settings_panel(ctx, null, []);
  return [...groups.values()].map(({ p, lanes }) => settings_panel(ctx, p, lanes)).join('');
}

function settings_panel(ctx, p, lanesOf) {
  const sc = p?.schedule ?? ctx.SCHEDULE;
  const D = p?.daemon ?? ctx.DAEMON;
  const lanes = lanesOf.map((L) => {
    const own = L.schedule && L.schedule.inherit === false;
    return `<tr data-lane="${esc(L.id)}"><td>${esc(laneName(L))}</td>` +
      `<td>${esc(L.model)}</td>` +
      `<td><input type="number" value="${Math.floor(L.target / 1000)}" aria-label="${esc(laneName(L))} fold target (k tokens)"> k</td>` +
      `<td>${own ? `own ${esc(L.schedule.sleep)}–${esc(L.schedule.wake)}` : 'shared'}</td>` +
      `<td><input type="checkbox"${(L.armed ?? true) ? ' checked' : ''} aria-label="${esc(laneName(L))} armed"></td></tr>`;
  }).join('');
  const items = [];
  items.push(D.down
    ? `<li data-status="failed">${icon('warn')} ${esc(daemon_tip(D))}` +
      `<button type="button" data-action="restart-daemon" data-part="fix">${icon('retry')}<span>Restart it</span></button></li>`
    : `<li data-status="ok">${icon('check')} ${esc(daemon_tip(D))}</li>`);
  let laneTrouble = 0;
  for (const L of lanesOf) {
    if (!L.alert) continue;
    laneTrouble++;
    const fix = L.alert.fixes?.[0];
    const amber = L.alert.level === 'warn';
    items.push(`<li data-status="${amber ? 'warn' : 'failed'}" data-lane="${esc(L.id)}">${icon(amber ? 'gauge' : 'warn')} ${esc(laneName(L))}: ${esc(L.alert.title)}` +
      (fix ? `<button type="button" data-action="${fix[1]}" data-part="fix">${icon(fix[0])}<span>${esc(fix[2])}</span></button>` : '') + `</li>`);
  }
  for (const L of lanesOf) {
    // Size only matters against the WINDOW (the fold target is where the
    // nightly fold trims back TO, not a line to act at — Ra, 10/7).
    const w = L.window || WINDOWS[L.model] || 0;
    if (!(w && L.ctx / w >= 0.9)) continue;
    laneTrouble++;
    items.push(`<li data-status="warn" data-lane="${esc(L.id)}">${icon('gauge')} ${esc(laneName(L))} is at ${pyRound(L.ctx / w * 100)}% of their context window — a Force fold would trim them to ~${k(L.target)}</li>`);
  }
  if (!laneTrouble) items.push(`<li data-status="ok">${icon('check')} No agent needs a hand</li>`);
  const who = p ? esc(p.name) : 'Settings';
  return `
  <section class="nw-settings"${p ? ` data-persona="${esc(p.id)}"` : ''}${p?.hub ? ` data-hub="${esc(p.hub)}"` : ''} aria-label="${p ? `${who} settings` : 'settings'}" data-open="false" role="dialog">
    <h3 data-part="heading">${icon('gear')} ${who}<button type="button" data-action="close-settings" data-part="close" aria-label="Close settings">${icon('x')}</button></h3>
    <div data-part="schedule"><span data-part="label">Nightshift</span>
      <label>${icon('moon')} Sleep <input type="time" value="${esc(sc.sleep)}"></label>
      <label>${icon('sun')} Wake <input type="time" value="${esc(sc.wake)}"></label>
      <span data-part="tz">${esc(ctx.TZ ?? '')}</span>
    </div>
    <table data-part="lanes"><thead><tr><th>lane</th><th>model</th><th>fold target</th><th>schedule</th><th>armed</th></tr></thead><tbody>${lanes}</tbody></table>
    <div data-part="doctor">
      <h4>${icon('check')} Health check</h4>
      <ul>${items.join('')}</ul>
    </div>
    <div data-part="buttons"><button type="button" data-action="run-doctor">${icon('retry')}<span>Check again</span></button>
      <button type="button" data-action="save-settings" data-primary="true">${icon('check')}<span>Save</span></button></div>
  </section>`;
}

// The skin selector is part of the view menu (contract v0.8): one radio per
// installed skin, titled from its manifest. The runtime swaps the stylesheet.
// The installed list arrives in the snapshot (SKINS: [[name, title]…]) —
// this module never reads disk.
function skin_items(ctx) {
  return `<li role="none" data-part="skin-heading">${icon('panels')}<span>Skin</span></li>` + ctx.SKINS.map(([n, t]) =>
    `<li role="none"><label role="menuitemradio" data-view="skin" data-value="${n}">` +
    `<input type="radio" name="skin" value="${n}"><span>${esc(t)}</span></label></li>`).join('');
}

function view_menu(ctx) {
  // Top-level view menu (Ra, 10/5): the default is cards only; everything
  // else is opt-in. Checked state mirrors .nw-app's data-show-* attributes.
  const chk = (view, label, ic) =>
    `<li role="none"><label role="menuitemcheckbox" data-view="${view}">` +
    `<input type="checkbox" data-view-toggle="${view}">${icon(ic)}<span>${label}</span></label></li>`;
  const radio = (group, val, label) =>
    `<li role="none"><label role="menuitemradio" data-view="${group}" data-value="${val}">` +
    `<input type="radio" name="${group}" value="${val}"><span>${label}</span></label></li>`;
  return `<menu data-part="view-menu" data-menu="view" role="menu" aria-label="View">
      ${chk('controls', 'Controls', 'play')}
      ${radio('timeline-mode', 'expanded', 'One row per agent')}
      ${radio('timeline-mode', 'compressed', 'All agents on one track')}
      ${chk('log-tall', 'Extend log', 'log')}
      <li role="separator"></li>
      ${radio('layout', 'row', 'Horizontal')}
      ${radio('layout', 'column', 'Vertical')}
      ${radio('layout', 'stack', 'Stacked')}
      <li role="none"><button type="button" role="menuitem" data-action="collapse-all">${icon('chev')}<span>Collapse all lanes</span></button></li>
    </menu>`;
}

// The Settings menu (Ra, 10/7): a third menu beside View and Look for what is
// neither layout nor skin, so the deck keeps three buttons.
function app_menu() {
  return `<menu data-part="view-menu" data-menu="app" role="menu" aria-label="Settings">
      <li role="none" data-part="settings-entry"><button type="button" role="menuitem" data-action="app-settings">${icon('gear')}<span>Schedule and health check…</span></button></li>
      <li role="separator" data-part="settings-entry"></li>
      <li role="none"><label role="menuitemcheckbox" data-view="on-top"><input type="checkbox" data-view-toggle="on-top">${icon('pin')}<span>Keep on top</span></label></li>
    </menu>`;
}

// The Look menu (Ra, 10/6: one long menu ran off the screen; "a second menu
// next to the first"): appearance and skin, its own button beside View. It
// shares the View menu's part name, so every skin's menu styling applies;
// data-menu tells the two apart.
function look_menu(ctx) {
  const radio = (group, val, label) =>
    `<li role="none"><label role="menuitemradio" data-view="${group}" data-value="${val}">` +
    `<input type="radio" name="${group}" value="${val}"><span>${label}</span></label></li>`;
  return `<menu data-part="view-menu" data-menu="look" role="menu" aria-label="Look">
      <li role="none" data-part="theme-heading">${icon('sun')}<span>Appearance</span></li>
      ${radio('theme', 'system', 'Match the system')}
      ${radio('theme', 'light', 'Light')}
      ${radio('theme', 'dark', 'Dark')}
      <li role="separator" data-part="theme-separator"></li>
      ${skin_items(ctx)}
    </menu>`;
}

function deck_display(ctx, setup) {
  // The deck's readout alone, separable so the app can refresh it in place.
  if (setup) {
    return '<p data-part="summary">No agents yet</p>' +
      '<p data-part="next">Set up a persona to begin</p>' +
      '<ul data-part="counts"></ul>';
  }
  // Counts derive from the lanes: belled/waking/folding are awake-ish,
  // orphaned is trouble, down is asleep. Zero counts are left out.
  const group = { awake: 'awake', belled: 'awake', waking: 'awake', folding: 'awake',
    sleeping: 'sleeping', down: 'sleeping', failed: 'failed', orphaned: 'failed' };
  let counts = ['awake', 'sleeping', 'failed'].map((st) => [st, ctx.LANES.filter((L) => group[L.state] === st).length]);
  counts = counts.filter(([, n]) => n);
  const nb = ctx.DECK.next_at;
  return `<p data-part="summary"><b>${ctx.LANES.length}</b> agent${ctx.LANES.length === 1 ? '' : 's'}</p>` +
    `<p data-part="next">Next bell <time datetime="${nb}">${hmLocal(nb, ctx.TZ)}</time> · in <time data-part="countdown" datetime="${nb}">${esc(ctx.DECK.countdown)}</time></p>` +
    '<ul data-part="counts">' + counts.map(([st, n]) =>
      `<li data-state="${st}" style="--n: ${n}" data-tip="${n} ${st}"><b>${n}</b><span>${st}</span></li>`).join('') + '</ul>';
}

function controls(ctx, setup = false) {
  // The deck: Nightwatch's main controls, for every lane at once (Ra, 10/5:
  // "the main controls on an mp3 player"). On a fresh install there are no
  // lanes yet, and Set up takes the play button's slot.
  const display = deck_display(ctx, setup);
  // With nothing left to wake, the big button becomes Sleep all (Ra, 10/7):
  // play turns into pause, as on any player, instead of a prominent Wake all
  // that can't do anything sitting beside a small pause.
  const allAwake = !setup && ctx.LANES.length > 0 && !ctx.LANES.some((L) => ['sleeping', 'failed', 'orphaned'].includes(L.state));
  const sleepTip = "Ring every awake agent's bell: rung, fold, close";
  const primary = setup
    ? `<button type="button" data-action="setup" data-part="primary" data-tip="Install a persona: name, model, where their memory lives">${icon('wand')}<span>Set up</span></button>`
    : allAwake
      ? `<button type="button" data-action="sleep-all" data-part="primary" data-tip="${esc(sleepTip)}">${icon('pause')}<span>Sleep all</span></button>`
      : `<button type="button" data-action="wake-all" data-part="primary" data-tip="Wake every sleeping agent now">${icon('play')}<span>Wake all</span></button>`;
  const pause = allAwake ? '' : `<button type="button" data-action="sleep-all" aria-label="Sleep all" data-tip="${esc(sleepTip)}"${setup ? ' aria-disabled="true"' : ''}>${icon('pause')}</button>`;
  return `
  <section class="nw-controls" aria-label="controls" data-setup="${setup ? 'true' : 'false'}">
    <div data-part="display" role="status">${display}</div>
    <div data-part="transport" data-all-awake="${allAwake ? 'true' : 'false'}">
      ${primary}
      ${pause}
      <button type="button" data-action="fold-all" aria-label="Force-fold all" data-danger="true" data-tip="Force-fold every awake agent (asks first)"${setup ? ' aria-disabled="true"' : ''}>${icon('stop')}</button>
      <button type="button" data-action="toggle-nightly" aria-pressed="${!setup && ctx.LANES.some((L) => L.armed !== false) ? 'true' : 'false'}" aria-label="Nightly cycle" data-tip-on="Nightly cycle is on: bell ${ctx.SCHEDULE.sleep}, wake ${ctx.SCHEDULE.wake}. Press to turn it off." data-tip-off="Nightly cycle is off. Press to turn it on (bell ${ctx.SCHEDULE.sleep}, wake ${ctx.SCHEDULE.wake})." data-tip="${!setup && ctx.LANES.some((L) => L.armed !== false) ? `Nightly cycle is on: bell ${ctx.SCHEDULE.sleep}, wake ${ctx.SCHEDULE.wake}. Press to turn it off.` : `Nightly cycle is off. Press to turn it on (bell ${ctx.SCHEDULE.sleep}, wake ${ctx.SCHEDULE.wake}).`}">${icon('repeat')}</button>
      <button type="button" data-part="panel-toggle" data-action="toggle-timeline" aria-pressed="false" aria-label="Timeline" data-tip-on="Hide the timeline" data-tip-off="Show the timeline" data-tip="Show the timeline">${icon('clock')}</button>
      <button type="button" data-part="panel-toggle" data-action="toggle-log" aria-pressed="false" aria-label="Log" data-tip-on="Hide the log" data-tip-off="Show the log" data-tip="Show the log">${icon('log')}</button>
    </div>
  </section>`;
}

function confirm() {
  return `
  <div class="nw-confirm" role="alertdialog" aria-label="Confirm emergency fold" data-action="emergency-fold" data-lane="opus">
    <p data-part="title">${icon('fold')} Force-fold opus?</p>
    <p data-part="body">This folds the session as it stands, without waiting for a rung. The agent's next wake starts with an emergency note so they can write the missing rung themself. Nothing in the transcript is deleted.</p>
    <div data-part="buttons"><button type="button" data-action="cancel">Cancel</button>
      <button type="button" data-action="confirm" data-danger="true">${icon('fold')}<span>Force fold</span></button></div>
  </div>`;
}

// App-level alarms (v0.9.1): only what no card owns — the daemon itself.
// Shape pinned to the gallery's markup plus the lane alert's ack button
// (an outage you can't acknowledge isn't a card, it's a wall). ackId is
// per-episode, so acking one outage never hides the next.
const ALARM_ARIA = {
  day: 'day; the watch is running', night: 'night; the watch is running',
  belled: 'bell rung; folds due', alarm: 'alarm; an agent needs a hand',
  down: 'the nightshift is not running',
};

function app_alarms(ctx) {
  return (ctx.ALARMS ?? []).map((a) => {
    const fixes = a.fixes.map(([ic, act, lbl, tip]) =>
      `<button type="button" data-action="${act}" data-part="fix" data-tip="${esc(tip)}">${icon(ic)}<span>${esc(lbl)}</span></button>`).join('');
    return `<div class="nw-alarm" role="alert" data-kind="${a.kind}" data-acked="false" data-ack-id="${esc(a.ackId)}">` +
      `${icon(a.kind === 'daemon-down' ? 'down' : 'warn')}<p data-part="title">${esc(a.title)}</p>` +
      `<p data-part="cause">${esc(a.cause)}</p>` +
      `${time_el(a.at, ' data-part="time"')}` +
      `<div data-part="fixes">${fixes}</div>` +
      `<button type="button" data-action="ack" data-part="ack" data-short="OK" ` +
      `data-tip="Hide it here. This only hides it on this screen; the heartbeat still DMs Ra in the morning.">${icon('check')}<span>Got it</span></button>` +
      `</div>`;
  }).join('');
}

function glyph_tip(ctx) { return daemon_tip(ctx.DAEMON); }
function daemon_tip(D) {
  if (D.down) return D.lastAliveHm ? `NIGHTSHIFT DOWN — no heartbeat since ${D.lastAliveHm}` : 'NIGHTSHIFT DOWN — no heartbeat yet';
  return `Nightshift running · last heartbeat ${D.lastAliveHm}`;
}

function gallery(ctx) {
  const gallery_states = [['belled', 243_000], ['folding', 250_000], ['waking', 30_000], ['orphaned', 150_000], ['down', 0]]
    .map(([st, c]) => lane_card({ id: st, model: 'Opus 5.5', modelId: 'claude-opus-5-5', role: '', state: st, session: '—',
      since: ['2026-10-05T02:00-07:00', '02:00'], next: null, ctx: c, target: 250_000, series: Array(24).fill(0), open: true }))
    .join('');
  return `<section class="nw-gallery" aria-label="state gallery">
    <h3 data-part="heading">Skin test sheet: every state once (not part of the app)</h3>
    ${gallery_states}
    ${lane_card({ ...(ctx.LANES[1] ?? ctx.LANES[0]), id: 'settings', open: true, settingsOpen: true }, ctx.NOW, ctx.TZ)}
    ${add_slot(true, ctx.SCHEDULE)}
    ${add_slot(true, ctx.SCHEDULE, 'preview', PREVIEW_EXAMPLE)}
    ${setup_dialog(ctx.SCHEDULE, true, 'who')}
    ${setup_dialog(ctx.SCHEDULE, true, 'preview', PREVIEW_EXAMPLE)}
    ${controls(ctx, true)}
    ${confirm()}
    <div class="nw-alarms" data-part="app-alarm-demo">
      <div class="nw-alarm" role="alert" data-kind="daemon-down" data-acked="false">
        ${icon('down')}<p data-part="title">The nightshift isn't running</p>
        <p data-part="cause">No heartbeat since 01:12. Bells, folds and wakes are all paused.</p>
        <div data-part="fixes"><button type="button" data-action="restart-daemon" data-part="fix">${icon('retry')}<span>Restart it</span></button>
          <button type="button" data-action="show-log" data-part="fix">${icon('log')}<span>Show log</span></button></div>
      </div>
    </div>
    <div class="nw-glyphs" aria-label="status glyph states">
      <span class="nw-glyph" data-phase="day"></span><span class="nw-glyph" data-phase="night"></span>
      <span class="nw-glyph" data-phase="belled"></span><span class="nw-glyph" data-phase="alarm"></span><span class="nw-glyph" data-phase="down"></span>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- exports
// Section renderers: each takes the full snapshot and returns one region's
// markup, so the app's refresh can replace a region without a page fetch.
export const renderLanes = (snap) => persona_groups(snap);
export const renderDeckDisplay = (snap) => deck_display(snap, false);
export const renderControls = (snap, setup = false) => controls(snap, setup);
export const renderTimeline = (snap) => night(snap);
export const renderLog = (snap) => log(snap);
export const renderSettings = (snap) => settings(snap);
export const renderViewMenu = (snap) => view_menu(snap);
export const renderHeadClock = (snap) => hmLocal(snap.NOW, snap.TZ);
export const renderAppAlarms = (snap) => app_alarms(snap);
export const renderGallery = (snap) => gallery(snap);

export function renderPage(snap) {
  const ctx = snap;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nightwatch fixture</title>
<!-- GENERATED by build_fixture.py: edit that, not this. Contract v0.7; see CONTRACT.md. -->
<link id="skin" rel="stylesheet" href="">
<script src="runtime.js" defer></script>
<script>
  const q = new URLSearchParams(location.search);
  const skin = q.get('skin') || 'minimal';
  document.getElementById('skin').href = \`\${skin}/skin.css\`;
  const d = document.documentElement.dataset;
  d.skin = skin;
  d.surface = q.get('surface') || 'window';
  d.gallery = q.get('gallery') === '1' ? '1' : '0';
  d.tips = q.get('tips') === '1' ? '1' : '0';   // stills only: show one tip as if hovered
  d.desk = q.get('desk') === '1' ? '1' : '0';   // stills only: a fake desktop behind the floating app
  // View state the app owns (the view menu writes these). Defaults = cards only.
  window.NW_VIEW = { controls: q.get('controls') !== '0', timeline: q.get('timeline') !== '0', log: q.get('log') !== '0',
    timelineMode: q.get('tlmode') || 'expanded', layout: q.get('layout') || 'row',
    onTop: true, menu: q.get('menu') === '1' };
</script>
<style>
  /* FIXTURE ONLY: the desktop the app floats over. Skins never style html/body
     backgrounds: in the app the window is transparent and this is the user's
     real desktop. */
  html[data-desk="1"] body { min-height: 100vh; margin: 0; padding: 40px;
    background:
      radial-gradient(38% 30% at 78% 18%, #ff9a6acc, transparent 70%),
      radial-gradient(30% 34% at 12% 72%, #e86bb0aa, transparent 70%),
      radial-gradient(26% 22% at 46% 46%, #7ee0c688, transparent 70%),
      radial-gradient(120% 90% at 20% 10%, #6f86b8 0%, #3c4f7d 38%, #1d2440 100%); }
  html[data-desk="1"] .nw-app { position: relative; z-index: 1; }
  /* VIEWER CHROME, not skin surface: a served page in an ordinary browser
     window can't be transparent (the Tauri shell can), so runtime.js sets
     data-shell="browser" and the window gets a plain dark ground. */
  /* VIEWER CHROME: the app's confirm dialog floats over everything (skins
     style .nw-confirm's look; this only places it), and the status line. */
  .nw-app > .nw-confirm { position: fixed; z-index: 50; left: 50%; top: 96px; transform: translateX(-50%);
    width: min(420px, calc(100vw - 32px)); box-shadow: 0 18px 60px #0008; }
  .nw-app > .nw-settings[data-open="false"] { display: none; }
  .nw-lane [data-part="next"][data-action], .nw-lane [data-part="midday"] { cursor: pointer; }
  /* The midday switch lights and dims exactly like the bell (Ra, 10/12); each skin's
     lit-bell colour rule names it too. */
  .nw-lane [data-part="next"][aria-pressed="false"], .nw-lane [data-part="midday"][aria-pressed="false"] { opacity: .45; text-shadow: none; }
  .nw-app > .nw-settings { position: fixed; z-index: 45; left: 50%; top: 72px; transform: translateX(-50%);
    width: min(600px, calc(100vw - 32px)); max-height: calc(100vh - 100px); overflow: auto; box-shadow: 0 18px 60px #0008; }
  /* In the app the window FITS its content, so a viewport-capped panel was circular: capped to the short
     closed-app window, measured short, never grown, bottom buttons out of reach (Ra, 10/6). There it takes its
     natural height and the window grows to it; on a too-short screen the page scrolls, so it scrolls with it. */
  html[data-shell="tauri"] .nw-app > .nw-settings { position: absolute; max-height: none; overflow: visible; }
  /* Lane creation (10/6): which step shows is structure, not look, so it
     lives here for every skin. Set up floats like settings. */
  .nw-app > .nw-setup[data-open="false"] { display: none; }
  .nw-app > .nw-setup { position: fixed; z-index: 46; left: 50%; top: 72px; transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 100px); overflow: auto; box-shadow: 0 18px 60px #0008; }
  html[data-shell="tauri"] .nw-app > .nw-setup { position: absolute; max-height: none; overflow: visible; }
  .nw-setup > [data-step] { display: none; }
  .nw-setup[data-step="who"] > [data-step="who"], .nw-setup[data-step="import"] > [data-step="import"],
  .nw-setup[data-step="nights"] > [data-step="nights"], .nw-setup[data-step="preview"] > [data-step="preview"] { display: grid; }
  .nw-setup[data-step="who"] [data-action="setup-back"], .nw-setup[data-step="preview"] [data-action="setup-next"],
  .nw-setup:not([data-step="preview"]) [data-action="create-persona"] { display: none; }
  .nw-add[data-step="preview"] > [data-part="add-form"], .nw-add[data-step="form"] > [data-part="preview"],
  .nw-add[data-open="false"] > [data-part="preview"] { display: none; }
  [data-part="error"][hidden], .nw-add [data-part="adopt"][hidden] { display: none; }
  .nw-head [data-part="view-menu"] li[hidden] { display: none !important; }
  .nw-timeline > [data-part="sleep-bands"] { display: none; } /* the vertical layout draws it across the lanes (10/6) */
  .nw-app > .nw-toast { position: fixed; z-index: 49; left: 50%; bottom: 18px; transform: translateX(-50%); margin: 0;
    max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 8px; font: 13px system-ui; color: #eee; background: #1d2027ee; box-shadow: 0 8px 30px #0007; }
  .nw-app > .nw-toast[data-status="failed"] { background: #5a1f1fee; }
  /* In the app the window is a transparent canvas over the screen's usable area (10/6), and the app sits in
     it where the viewer last dragged it (runtime.js placeApp). Floating parts position against the app, not
     the screen-sized window. The page scrolls only if the app is taller than the screen. */
  html[data-shell="tauri"] body { margin: 0; padding: 0; min-height: 100vh; overflow: auto; }
  /* Moved by transform on its own compositing layer, not left/top: a repainted move left ghost edges of a
     skin's big drop-shadow filter behind in the transparent window (Amber, 10/6). */
  html[data-shell="tauri"] .nw-app { position: absolute; left: 0; top: 0; transform: translate(var(--nw-x, 112px), var(--nw-y, 24px)); will-change: transform; }
  html[data-shell="tauri"] .nw-app > :is(.nw-confirm, .nw-toast) { position: absolute; }
  html[data-shell="tauri"] .nw-head { cursor: grab; }
  html[data-shell="tauri"] .nw-head[data-dragging] { cursor: grabbing; }
  html[data-shell="browser"] body { margin: 0; padding: 16px; min-height: 100vh; box-sizing: border-box;
    background: radial-gradient(120% 90% at 30% 0%, #2a2f3a 0%, #16181d 60%, #101114 100%); }
</style>
</head>
<body>
${sprite()}
<div class="nw-app" data-show-controls="true" data-show-timeline="true" data-show-log="true" data-timeline-mode="expanded" data-layout="row">
  <header class="nw-head" data-tauri-drag-region>
    <span class="nw-glyph" data-phase="${ctx.DAEMON.phase}" role="img" aria-label="${ALARM_ARIA[ctx.DAEMON.phase]}" data-tip="${glyph_tip(ctx)}"></span>
    <h1 data-part="title">Nightwatch</h1>
    <span data-part="schedule" data-tip="Tonight's schedule: the sleep-bell rings at ${ctx.SCHEDULE.sleep} and agents wake at ${ctx.SCHEDULE.wake}. Change it in a persona's settings (the gear on their card).">${icon('moon')}<time datetime="${ctx.SCHEDULE.sleep}">${ctx.SCHEDULE.sleep}</time>${icon('sun')}<time datetime="${ctx.SCHEDULE.wake}">${ctx.SCHEDULE.wake}</time></span>
    <time data-part="clock" datetime="${ctx.NOW}">${hmLocal(ctx.NOW, ctx.TZ)}</time>
    <button type="button" data-action="look-menu" data-part="menu-button" data-menu="look" aria-haspopup="menu" aria-expanded="false" aria-label="Look" data-tip="Appearance and skin">${icon('palette')}</button>
    <button type="button" data-action="view-menu" data-part="menu-button" aria-haspopup="menu" aria-expanded="false" aria-label="View" data-tip="Show or hide panels">${icon('panels')}</button>
    <button type="button" data-action="app-menu" data-part="menu-button" data-menu="app" aria-haspopup="menu" aria-expanded="false" aria-label="Settings" data-tip="Settings">${icon('gear')}</button>
    <button type="button" data-action="hide-window" data-part="hide" aria-label="Hide to menu bar" data-tip="Hide to the menu bar. The nightshift keeps watching.">${icon('minus')}</button>
    ${view_menu(ctx)}
    ${look_menu(ctx)}
    ${app_menu()}
  </header>

  <!-- App-level alarms are ONLY for things no card owns (the daemon itself).
       Lane trouble lives on the lane's card. Empty in this snapshot. -->
  <div class="nw-alarms">${app_alarms(ctx)}</div>

  <section class="nw-lanes" aria-label="lanes">${persona_groups(ctx)}
  </section>
  ${controls(ctx)}
  ${night(ctx)}
  ${log(ctx)}
  ${settings(ctx)}
  ${setup_dialog(ctx.SCHEDULE)}
  <!-- FIXTURE ONLY (?gallery=1): one of every state, so a skin proves it can
       draw each. Not part of the app. -->
  ${gallery(ctx)}
</div>
<script>
  // Mirror NW_VIEW onto the app and menu, the way the viewer will.
  const app = document.querySelector('.nw-app'), v = window.NW_VIEW;
  app.dataset.showControls = v.controls; app.dataset.showTimeline = v.timeline; app.dataset.showLog = v.log;
  document.querySelectorAll('.nw-controls [data-action="toggle-log"]').forEach((b) => b.setAttribute('aria-pressed', v.log));
  document.querySelectorAll('.nw-controls [data-action="toggle-timeline"]').forEach((b) => b.setAttribute('aria-pressed', v.timeline));
  app.dataset.timelineMode = v.timelineMode; app.dataset.layout = v.layout;
  const m = document.querySelector('[data-part="view-menu"]');
  m.dataset.open = v.menu; document.querySelector('[data-action="view-menu"]').setAttribute('aria-expanded', v.menu);
  m.querySelector('[data-view-toggle="controls"]').checked = v.controls;
  document.querySelector('[data-view-toggle="on-top"]').checked = v.onTop;
  m.querySelector(\`[name="timeline-mode"][value="\${v.timelineMode}"]\`).checked = true;
  m.querySelector(\`[name="layout"][value="\${v.layout}"]\`).checked = true;
  // ?fresh=1: the first-run look. The core module (head, deck, timeline,
  // log) keeps its shape with empty states; there is no lane row at all, since
  // adding the first agent is part of Set up.
  if (q.get('fresh') === '1') {
    app.dataset.fresh = 'true';
    const deck = document.querySelector('.nw-app > .nw-controls');
    deck.replaceWith(document.querySelector('.nw-gallery .nw-controls[data-setup="true"]').cloneNode(true));
    document.querySelector('.nw-app > .nw-lanes').remove();
    const tl = document.querySelector('.nw-app > .nw-timeline');
    tl.dataset.empty = 'true'; tl.querySelectorAll('.nw-strip, [data-part="activity"]').forEach(e => e.remove());
    tl.querySelector('[data-part="heading"] span').textContent = '';
    tl.querySelector('[data-part="empty"]').hidden = false;
    const lg = document.querySelector('.nw-app > .nw-log');
    lg.dataset.empty = 'true'; lg.querySelector('[data-part="events"]').replaceChildren();
    lg.querySelector('[data-part="empty"]').hidden = false;
    document.querySelector('.nw-head .nw-glyph').dataset.phase = 'down';
  }
</script>
</body>
</html>
`;
}

// Merge a (possibly partial) live snapshot over a base — apply_snapshot's
// twin: absent keys keep the base's value, so a partial snapshot still
// renders a whole page.
export function mergeSnapshot(base, snap) {
  const out = { ...base };
  for (const key of ['NOW', 'TZ', 'LANES', 'NIGHT', 'LOG', 'ACTIVITY', 'TIMELINE', 'DECK', 'SKINS', 'SCHEDULE', 'DAEMON', 'ALARMS']) {
    if (snap && key in snap) out[key] = snap[key];
  }
  return out;
}
