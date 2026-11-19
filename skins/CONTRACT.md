# Nightwatch skin contract, draft 0.10

`fixture.html` is the contract: every component as markup, with the classes, `data-part`s, `data-*` states and
numeric custom properties a skin may hang styles on. A skin is a stylesheet plus optional assets and a
`manifest.json`. It can't add or remove elements, so a hook a skin needs and can't find is a contract amendment.

Two skins have bent it so far:
- `minimal/` checks the shapes.
- `wacky/` ("Moonlamp") checks they still work when the layout gets strange: a radial night, round cards, a
  receipt-tape fold list.

Stills are in `stills/`.

## What held

- **`--t` is layout-agnostic.** The same hook drives a left offset in minimal and an angle on a clock dial in
  Moonlamp. Neither skin parses a time string.
- **`--fill`, `--kept` and `--est` work as numbers,** so a skin can draw them as a bar, a ring, or a colour shift,
  with no rule per value.
- **`data-state` on LaneCard is enough** to give every state a distinct look in both skins: awake, belled,
  folding, sleeping, waking, orphaned, failed, down.

## Amendments made (in the fixture now)

1. **`data-short` on the AlarmBanner's `ack` button.** A round button can't hold "Acknowledge", so skins can
   show `attr(data-short)` instead. The full word stays as the accessible name.
2. **LaneCard states `belled` and `down`.** `belled` is the time between the bell and the fold; it's the most
   anxious part of the night and deserves its own look. `down` means the daemon itself is down; until the event
   stream can say so, the viewer has to infer it.
3. **NightStrip node statuses: `ok`, `failed`, `deferred`, `pending` and `manual`,** not just the happy chain. A
   real night has three failed launches and a wake by hand.

## Rules for skin authors (learned the hard way)

- **Never transform `.nw-strip` or `.nw-node`.** Any `transform`, `rotate` or `scale` makes the element the
  containing block for its `::before`, and the timeline dots fall off the track into their own chips. Moonlamp's
  first render had an empty dial because of this.
- **Expect clusters.** Events bunch at the bell (02:00–02:08) and at the wake (08:00–08:16). A proportional
  layout must let dots overlap, and labels must lay out somewhere else: as chips in normal flow, or as a legend.
- **The popover answers "is everyone OK?"** Both skins hide the folds table and the visualizer there, and
  collapse the night to dots.

## v0.4: floating, accordion, view menu (Ra, round 4)

- **The app floats; nothing paints the page.** In the app the window is transparent and frameless, so the
  desktop shows wherever no module is. Skins never style `html`/`body` backgrounds. They style `.nw-app` and its
  modules, and the silhouette is whatever the modules make. `?desk=1` paints a fake desktop for stills only.
  Window side (Fable's scaffold): Tauri `transparent: true`, `decorations: false`, and `.nw-head` carries
  `data-tauri-drag-region`. Transparent pixels still catch clicks on some platforms, so the shell will need
  click-through outside modules.
- **Lanes are accordions.** `article.nw-lane[data-open]`. The header is the toggle (`header[data-action=
  "toggle-lane"]`, plus `button[data-part="toggle"][aria-expanded]`). Everything below the header sits in
  `[data-part="body"]`. The header's `[data-part="glance"]` holds `[data-part="mini"]` (`--fill`, `data-level`) and
  the next countdown, so a closed lane still answers "how full, how long". **The viewer opens any lane with an
  un-acked alarm**: trouble never hides behind a closed card.
- **View state lives on `.nw-app`:** `data-show-night`, `data-show-folds`, `data-night-mode="expanded|compressed"`,
  `data-layout="row|stack"`. The default is cards only. `menu[data-part="view-menu"][data-open]` in `.nw-head`
  writes them (checkboxes `data-view-toggle`, radios `name="night-mode"` / `name="layout"`).
- **Both night views are in the DOM.** `ol.nw-strip[data-mode="expanded"]` per lane, plus one
  `ol.nw-strip[data-lane="all"][data-mode="compressed"]`. In it, identical events merge into one node with
  `data-lanes`, lane chips (`[data-part="lanes"] i[data-lane]`), `data-all="true"` when every lane shares it, and
  `--stack` (0, 1, 2…) for near neighbours. Skins pick the view with CSS. Minimal stacks beads under the track;
  Moonlamp steps them inward on the dial. Both are width-independent, which a sideways fan isn't.
- **Gauge glyph note:** at a glance, the context gauge (a half-dial) reads as a clipped icon. It's drawn whole.
  Kept for now; a skin may swap the visual.

## The snapshot (data half of the contract, pinned at v0.9, 10/6)

`gui/emitter.mjs` renders a page, or one section, from one snapshot object. `gui/server.mjs` assembles it from the
house's files today; the app will assemble the same object (gui/assemble.mjs) and render in the webview. Any
assembler must produce exactly this shape. Positional tuples are listed in order.

- `version`: `"0.9"`. `NOW`: ISO instant. `TZ`: IANA zone (optional; the emitter falls back to its default).
- `LANES`: one object per lane: `id`, `model` (display name), `modelId`, `role` (`switchboard` | `lane`), `state`
  (awake | belled | folding | waking | sleeping | failed | orphaned | down), `session` (8-char id or `—`),
  `since` = `[iso, display]`, `next` = `[what, iso, display]` or null, `ctx` (tokens the API last saw), `window`
  (the model's context window), `target` (fold target), `open` (bool), `series` (24 × output tokens per 10 min,
  oldest first), and optionally `armed: false`, `alert` (`{kind, title, cause, at: [iso, display], fixes: [[icon,
  action, label, tip]…]}`).
- `NIGHT`: `{lane: [node…]}`, node = `[kind, status, t (0..1), "HH:MM", tip, count]`.
- `LOG`: `[[dayLabel, [row…]]…]`, newest day first; row = `["HH:MM", lane, kind, status, what, fold|null,
  count]`; fold = `{reason, kept: [kept, total], est, target, tail}`.
- `ACTIVITY`: every lane's output tokens per bucket across the interval (any length; 48 for 8h).
- `TIMELINE`: `{range, from, to, label, ticks: [[t, label]…], sleep: [from_t, to_t] (most recent night;
  fallback), sleep_bands: [[from_t, to_t]…]}`. `t` is always 0..1 across `[from, to]`.
- `DECK`: `{next_at: iso, countdown: "Xh YYm"}`. `SKINS`: `[[name, title]…]`, from each skin's manifest.

### v0.9.1 (10/6): the head tells the truth

The head used to be frozen testimony: the glyph always said "running · last heartbeat 12:41" and the schedule
always 02:00/08:00, even with the daemon dead. Three keys, always emitted (defaults included):
- `SCHEDULE`: `{sleep: "HH:MM", wake: "HH:MM"}` from weft.config.json. Drives the head's schedule, the deck's
  Nightly tip and the bell-time words.
- `DAEMON`: `{phase, lastAlive: iso|null, lastAliveHm}`. `phase` precedence is
  **down > alarm > belled > night > day**: down = no daemon-up/daemon-alive event newer than 70 min (an hourly
  beat plus slack), or none ever ("No nightshift heartbeat yet", never a fall-through to day); alarm = any lane
  `failed` or `orphaned` (the same facts the cards show, so glyph and cards can't disagree; acks are per viewer,
  so they never feed the phase); belled = any lane belled; night = inside the sleep window. The glyph carries
  `data-phase`, plus an `aria-label` and `data-tip` that say the same thing.
- `ALARMS`: app-level alarms (things no card owns; today only `daemon-down`), each
  `{kind, title, cause, at: [iso, display], fixes: [[icon, action, label, tip]…], ackId}` →
  `div.nw-alarm[role=alert][data-kind][data-acked][data-ack-id]` in `.nw-alarms`, with the same ack button lane
  alerts carry. `ackId` = `kind:lastAlive` (or `kind:never`), so acking hides one outage and the next shows again.
  The runtime acks `.nw-alarm` and `.nw-alert` alike; every skin dims an acked alarm.

Parity: gui/test/parity.mjs, 7 cases (adds daemon_down: custom schedule, down phase, full alarm card).

### v0.9.2 (10/6): persona, runtime, per-lane schedule (anima_dev/nightwatch_hub_design.md)

- Every lane carries `persona: {id, name}`, `runtime` (`"claude-code"` today; data gathering and actions
  dispatch on it, so the page stays runtime-blind) and its RESOLVED `schedule: {inherit, sleep, wake}`. Top
  level: `PERSONAS: [{id, name}]` (one today; grouping comes with the hub).
- The card's model line leads with the persona: `[data-part="model"] > [data-part="persona"]`, "Weft · Fable 5";
  it truncates before the state badge.
- Lane settings: `label[data-part="global-schedule"] > input[data-schedule-toggle]` ("Use global nightshift
  settings", checked = inherit), then `label[data-part="sleep"]` / `[data-part="wake"]` time inputs, disabled while
  inheriting. The runtime re-fills them with the head's global times on re-tick. Saving is settings-save's job.
- Remove is gated: `label[data-part="confirm-remove"] > input[data-gate="remove-lane"]` must be ticked before
  `[data-action="remove-lane"][data-gated]` enables (and only if the host can remove); closing settings re-arms it.
  Disabled buttons in settings and the add form look disabled in every skin.

### App settings panel (10/6)

`section.nw-settings[role=dialog][data-open]` lives in `.nw-app` (after the log); the page places it as a floating
panel (viewer chrome) and each skin draws its surface. Opened by `app-settings` (deck button, view menu item),
closed by `close-settings`, Escape, or the toggle; it joins the hit areas while open. Everything in it comes from the
snapshot: `[data-part="schedule"]` (global times, `[data-part="tz"]`), `table[data-part="lanes"]` (persona · lane,
model, fold target, schedule `global` | `own HH:MM–HH:MM`, armed), and `[data-part="doctor"]`, a health check DERIVED
from facts the head and cards already show: the daemon line (`glyph_tip`, with a restart fix when down), one
`li[data-status=failed]` per lane alert carrying its first fix, one `li[data-status=warn]` per lane past its fold
target, else "No lane needs a hand". `run-doctor` and `save-settings` stay read-only until the nightshift's
`--preflight` and `config.mjs set` land.

## v0.10: the host acts (Ra, 10/6: Node is fine, tray + window, Wake first)

- **`window.NW_HOST = { can(action), act(action, {lane}) → Promise<message> }`.** The app (app/, Tauri) defines it
  before the page loads; `can` names what's wired. Buttons for anything else get `aria-disabled` with "Not wired in
  the app yet"; a plain browser tab has no host and stays fully read-only. Wired so far: `hide-window`, `wake`, `sleep` (rings the bell through `nightshift.mjs --ring <lane>`), `retry-wake` (= wake), `open-terminal` (the lane's Terminal tab, found by its tty), `wake-all` and `sleep-all` (each lane through its own guards, the summary names every refusal), `restore-checkpoint` (only when the checkpoint is missing, only from a timestamped archive), `restart-daemon` (launchctl kickstart). Settings writes (10/6, via Fable's `config.mjs set/unset` and `nightshift.mjs --arm/--disarm`; the app never writes those files itself): `save-lane` {targetK, inherit, sleep, wake, armed}, `save-settings` {sleep, wake, lanes:[{id, targetK, armed}]}, `toggle-nightly` {on} (asks first; the deck's pressed state = any lane armed), `remove-lane` (gated + asks; disarm, then unset). `NW_HOST.act(action, {lane, data})`. Fold now (Ra's refresh ruling): `emergency-fold` / `fold-all` call `nightshift.mjs --fold-now <lane>` (bell now; the daemon owns a 10-minute deadline, forces the fold if needed, then closes and wakes fresh), both ask first in danger red. `run-doctor` shows `--preflight`'s dry run verbatim in `.nw-settings [data-part="preflight"]`. Lanes carry `foldRequest: {phase: 'requested', deadline} | {phase: 'refreshing', forced}` (assemble, from fold-requested / fold-request-met / fold-forced / wake-confirmed), and the card shows `li[data-part="fold-request"]` with a ticking countdown. Schedule saves no longer restart the daemon (hot reload); remove-lane still does.
- **Every action that changes the house asks first.** The runtime builds a `.nw-confirm` (title, body, buttons with
  `data-part="no"|"yes"`) in `.nw-app`; Escape or Cancel backs out. The result, or the refusal, shows in
  `.nw-app > .nw-toast[data-status="ok|failed"]`. Placement of both is viewer chrome in the fixture; skins may style them.
- **`window.NW_SHELL = 'tauri'`** marks the app: `html[data-shell="tauri"]`, no browser ground, the window is
  transparent. `html[data-readonly]` is `true` (no host) or `partial` (host, some actions wired).
- **Click-through:** `NW_HOST.hitRects([[x,y,w,h]…])` takes the visible modules' rects (CSS px, viewport). The runtime
  re-reports on resize, accordion, menu, dialog and refresh; the app makes the window ignore the mouse whenever the
  pointer is over none of them, so the transparent rest of the window doesn't block the desktop. A skin whose modules
  draw outside their own boxes (a lamp hanging off a card) should keep those parts decorative.
- **Wake, app side:** checks the lane against weft.config.json, refuses if a live `claude --resume` holds the lane's
  receipt session (or the session it was folded from), then runs wake.sh in Terminal exactly as the nightshift
  does at 08:00.

## v0.9: context against the window (Ra, 10/5 evening)

- **`--fill` is now context ÷ the model's context window** (1M for Fable, Opus and Sonnet; 200k for Haiku; a lane can
  pin `contextWindow` in config). It was context ÷ fold target, which pegged every busy lane at the top.
- **`--target` (0..1) is the fold target's place on that bar**, on `[data-part="context"]` and `[data-part="mini"]`.
  Minimal (and Glass, Amber, Metal through the build) draws it as a thin tick. Moonlamp and Brassworks don't draw it
  yet.
- **`data-level` still keys off the fold target** (high at 80% of it, over past it), because that's the line that means
  "fold soon". The readout is % of the window; the tip gives both.

## v0.8: the runtime and the skin selector (Ra's wiring ask, 10/5 evening)

- **`runtime.js` is the viewer half of this contract.** The fixture had no event handlers; it posed stills from
  the query string. Every behaviour this file assigns to "the viewer" now lives in `skins/runtime.js`, loaded by
  the page itself: lane accordions (header and chevron, keyboard too), the view menu, the deck's log toggle, log
  filters (`[hidden]` per kind, empty day headers hide), a lane's Logs button (narrows the log to that lane), range
  radios, alert acks (`.nw-alert[data-ack-id]`, this screen only), live clocks and countdowns (from `datetime`).
  Skins never need to know it exists; they style the same attributes as before.
- **Two modes.** Over `file://` (stills, fixture review) controls work but nothing persists, refreshes or disables,
  so stills are unchanged. Served (gui/server.mjs, then Tauri), view state persists per viewer, data refreshes in
  place every 30 s and on focus (whole sections swap, then the viewer's choices are re-applied; skipped while a menu,
  form or field is in use), and write actions go to `window.NW_HOST.act(action, {lane})`. With no host (phase 1)
  they get `aria-disabled` and a "read-only for now" tip, and `html[data-readonly]` is set.
- **An un-acked alarm still opens its lane on every refresh,** whatever the viewer last chose.
- **The skin selector is part of the view menu:** `[data-part="skin-heading"]`, then one
  `label[role="menuitemradio"][data-view="skin"]` with `input[name="skin"]` per installed skin, titled from its
  `manifest.json`. Choosing one swaps `link#skin` and `html[data-skin]`; `?skin=` in the URL beats the remembered
  choice. Skins style the heading (it's a label, not an item).
- **`html[data-shell="browser"]`:** a served page in an ordinary browser window can't be transparent, so the
  runtime sets this and the fixture paints a plain dark ground behind the app. Viewer chrome, not skin surface;
  the Tauri shell drops it.
- **Write actions, for reference:** open-terminal, wake, sleep, emergency-fold, wake-all, sleep-all, fold-all,
  toggle-nightly, save-lane, remove-lane, create-lane, save-settings, restore-checkpoint, retry-wake,
  restart-daemon, run-doctor, setup, confirm, hide-window. `app-settings` is view-only but has no panel in the page
  yet, so it also reads as not-yet.

## v0.7.1: a nicer activity graph (Ra, round 9)

`[data-part="activity"]` now carries a monotone smooth curve (Fritsch–Carlson, so zero runs stay flat at zero),
a vertical-gradient fill (`#nw-activity-fill`, whose `stop[data-part="fill-top|fill-bottom"]` colours skins set),
hour gridlines (`g[data-part="grid"]`), the scheduled sleep window (`span[data-part="sleep"]` with `--from`/`--to`)
and the peak (`span[data-part="peak"]` with `--t`/`--v`). The last two are HTML, not svg, so their text isn't
stretched by `preserveAspectRatio="none"`.

Trap: **`clip-path` on a node clips its children too.** Amber's diamonds hid the `×3` count badges until the shape
moved to a `::before`.

## v0.7: the core module (Ra, round 8)

- **The head plus three panels (deck, timeline, log) is the core module,** and it's the default view. Cards-only
  (timeline and log off) folds the deck into the horizontal transport bar. In minimal and its themes, **the
  timeline sets the row's height:** the deck stretches to match (its readout grows), and the log contributes no
  height (`height: 0; min-height: 100%`) and scrolls inside, with a fade at the bottom. No panel leaves dead space.
- **`[data-part="activity"]` in the timeline:** every lane's output tokens per 10-minute bucket, summed, on the same
  `--t` axis as the strips. It's an svg with `path[data-part="area"]`, `path[data-part="line"]` and
  `g[data-part="bars"]` (with `--v`), plus `data-series`. The fixture's values are marked `data-illustrative`; the
  viewer computes the real ones from transcripts. It fills what was the timeline's dead zone with the night's shape.
- **Empty states:** `p[data-part="empty"][hidden]` in the timeline and log, and `[data-empty="true"]` on the panel
  when shown. **Fresh install** (`?fresh=1`, `.nw-app[data-fresh="true"]`): the core module keeps its shape with
  empty states, the deck is in setup mode, and there's no lane row at all. Adding the first agent is part of Set up.
- **Skin trap (Brushed Metal):** a custom property built from another one (`--gel: … var(--g) …`) resolves where
  it's declared. On `:root` it fixes `--g`'s root value, and every element inherits the finished gradient. To make
  a recipe that each element re-tints, declare it on `*`.

Skins now: `minimal/`, `wacky/` (Moonlamp), `glass/`, `amber/` (the obelisk), `steampunk/` (Brassworks,
parked for a rethink), `metal/` (Brushed Metal).

## v0.6: the deck (Ra, round 7)

- **`section.nw-controls`, the main controls for every lane at once** (the mp3 player's transport). It holds:
  - `[data-part="display"]` (`summary`, `next`, and `counts` as `li[data-state]` with `--n`);
  - `[data-part="transport"]` (`[data-part="primary"]`, then `sleep-all` and `fold-all`);
  - `[data-part="toggles"]` (`toggle-nightly`, `toggle-log`, `app-settings`, each with `aria-pressed`).

  `data-setup="true"` is the first-run state: no lanes, and the primary slot holds `data-action="setup"` (install a
  persona) instead of `wake-all`. `?fresh=1` renders it in place. `data-show-controls` is on by default; it's the
  one panel that's part of "cards only".
- **The panel row shares the lane columns** in minimal and its themes. The app grid is
  `repeat(4, lane) rail` and `.nw-lanes` is a subgrid, so the deck sits over lane 1, the timeline over lanes 2–3,
  and the log over lane 4 plus the rail. With timeline and log hidden, the deck spans the row as a horizontal
  transport bar.
- **Themes are built, not copied.** `glass/`, `amber/` and `steampunk/` keep a `theme.css` (tokens, a `@@BASE@@`
  marker, overrides), and `build_skins.py` splices minimal's layout into each skin.css. Layout fixes land everywhere
  at once.

Lessons from this round, for skin authors:
- **A container query can't restyle its own container,** only descendants. The deck's wide layout keys off the
  app's `data-show-*` attributes instead.
- **`:is()` takes its strongest argument's specificity.** The base meter rule `:is([…] [data-part="bar"], […]
  svg:not(.nw-icon))` outranks a plain theme rule on the bar. Themes raise theirs (Brassworks prefixes `.nw-app`).
- **Layout variables need fallbacks** (`var(--nw-rail-w, 44px)`), because a theme's own `:root` may not define
  them, and an undefined one silently invalidates the whole grid.

## v0.5: timeline, log, matched meters (Ra, round 6)

- **"Last night" is now the Timeline:** `section.nw-timeline[data-range]` with `[data-part="range"]` radio buttons
  (8h, 24h, 3d, 7d). The viewer re-renders the strips and axis for the chosen interval. `--t` is still 0..1 across
  `[data-from, data-to]`, so skins don't change per range. App attributes are `data-show-timeline` and
  `data-timeline-mode`.
- **The fold table is now the Log:** `section.nw-log` contains `[data-part="filters"]` (one `label[data-kind]` with a
  checkbox per event kind) and `ol[data-part="events"]` (`li.nw-day` headers, then `li.nw-event[data-kind][data-lane]
  [data-status]`). Fold events carry `[data-part="detail"]` with kept/est/tail and `--kept`/`--est`. **Filtering is
  app logic:** the viewer sets `[hidden]` on rows whose kind is off, so a skin needs no rule per kind. Heartbeats
  start hidden.
- **Throughput can match the context meter:** its svg holds both the `polyline` and `g[data-part="bars"]` (one
  `rect` per bucket, with `--v`), plus a `[data-part="value"]` readout (the last bucket). A skin draws whichever
  matches its context meter. Minimal, Glass and Amber use bars in the same track as context; Moonlamp uses the line
  in a bezel that matches its tube.
- **Glass trap:** a `filter` on any ancestor makes it a backdrop root, and every `backdrop-filter` under it blurs
  nothing. Glass gives each pane its own shadow instead of using an app-level drop-shadow.

Skins now: `minimal/`, `wacky/` (Moonlamp), `glass/`, `amber/`, `steampunk/` (Brassworks). Glass and Amber are built on minimal's layout and
re-themed, which shows how much of a skin is tokens and surfaces.

## More rules for skin authors

- **Positioned ancestors break anchored drawings.** Moonlamp draws each node's dot as a `::before` anchored to
  `.nw-night`. Every node carries `data-tip`, and the usual tooltip rule `[data-tip] { position: relative }` turned
  each node into the anchor, so the dots landed in the lane row. If a skin anchors pseudo-elements to a
  container, reset `position: static` on everything in between.
- **No transitions on state you screenshot.** Headless Chrome caught a 150 ms chevron rotation mid-turn. Fine in
  the app, misleading in stills.

## Proposed, needs the viewer or daemon side (not done)

- **Group repeated nodes** (`launch ×3`) with a count, emitted by the viewer. Three identical failed launches are
  one fact.
- **A daemon liveness signal** (see the events review), so `down` is an observed state, not an inferred one.
- **A `since` timestamp on LaneCard as a datetime,** not prose, so skins can render it relative ("3h ago").

Written by: claude-opus-5-5, 2026-10-05 (v0.1–v0.4)

## v0.10: lane creation (10/6)

- `.nw-app > .nw-setup[data-open][data-step="who|import|nights|preview"]`: the Set up dialog, one per page, after
  `.nw-settings`. Children carry `data-step`; the base CSS shows the one matching the dialog. Fields are
  `[data-field="name|about|person|model|hub|from|sleep|wake|targetK|armed"]`. `[data-part="progress"]`,
  `[data-part="found"]` (import results, `li[data-status="ok|missing|failed"]`), `[data-part="steps"]`,
  `[data-part="error"]`. Buttons: `setup`, `close-setup`, `setup-import`, `check-import`, `setup-back`,
  `setup-next`, `create-persona`.
- `.nw-add[data-step="form|preview"]`: the Add agent slot. Fields `[data-field="id|model|inherit|sleep|wake|targetK|first|session|armed"]`;
  `[data-part="own-schedule"]`, `[data-part="adopt"]` (shown for "adopt"), `[data-part="preview"]` with
  `[data-part="steps"]`. Buttons: `plan-lane`, `plan-back`, `create-lane`.
- Preview steps are `li[data-verb]` > `b` (verb) + `code` (what) + `span` (detail), rendered from the machinery's
  dry run (`NW_HOST.act('plan', {data: spec})`), never written by the page. The spec and the CLI shapes are in
  anima_dev/nightwatch_lane_creation.md ("the contract").
- Host capabilities: `plan`, `apply`, `inspect-import`, `list-unclaimed`. A host without `plan` leaves Set up shut.
- A step the machinery marks `consent: "<field>"` runs only when the person ticks it (10/16, transcript retention):
  the runtime renders it as `li[data-verb][data-consent="<field>"]` with an unticked `input[type=checkbox][data-field="<field>"]`
  inside a `label` inside the `b`, so the step keeps the same `b` + `code` + `span` children every skin lays out as a grid.
  The spec sends the field as `retention.keepTranscripts` (a boolean, `false` unless ticked).
- Skins: hand-built skins style `.nw-setup` and `.nw-add [data-part="preview"]` themselves (Moonlamp and Brassworks
  do); themed skins inherit Minimal's. In Minimal's rack, an open add slot in the rail cell (4 or 9 lanes) widens
  the rail to a lane.

## v0.11: appearance, and a throughput strip that follows the range (10/6)

- `html[data-theme="light"|"dark"]`, or no attribute for "match the system". View menu radios `name="theme"`
  (`system|light|dark`), remembered per viewer; the fixture takes `?theme=`. A skin with both looks declares
  `:root { --nw-appearances: both }` and writes its dark rules for `@media (prefers-color-scheme: dark)
  :root:not([data-theme="light"])` AND `:root[data-theme="dark"]` (Minimal and Glass do). Skins without the marker
  have one look, and the radios show as disabled with a tip saying so.
- `ACTIVITY` is 48 equal buckets over `TIMELINE.from..to`; `TIMELINE.bucket_min` gives their size (10 at 8h, 30 at
  24h, 90 at 3d, 210 at 7d; absent = 10). The strip's tips name the real bucket.

## v0.12: two head menus, and the app on a canvas (10/6)

- Head menus: `menu[data-part="view-menu"][data-menu="view"]` (panels, layout, keep on top, settings) and
  `[data-menu="look"]` (appearance, skin), opened by `[data-action="view-menu"]` / `[data-action="look-menu"]`
  (both `data-part="menu-button"`). Skins style both through the shared part name. `.nw-app > .nw-head` gets
  `z-index: 20`, so a skin that makes modules stacking contexts (backdrop-filter) can't bury its own menus.
- In the app (`html[data-shell="tauri"]`) the window is a transparent canvas over the display's usable area. Nothing
  is measured or fitted: `.nw-app` is absolutely positioned at `--nw-x/--nw-y`, dragging the head (not its buttons)
  moves it, the spot is remembered per viewer and clamped so the head stays on screen. While dragging, the page
  reports the whole window as one hit area. Confirm dialogs and toasts position against the app. `NW_HOST.fit` is
  gone; until the page reports hit areas, the window is click-through.

## v0.13: layout options (10/6)

- `.nw-app[data-layout="column"]` (View > "Panels beside a column of lanes"): two columns, controls / timeline /
  log on the left, lanes in one column on the right. The timeline runs vertically, now at the top: nodes and axis
  ticks at `top: (1 - --t)`; the activity strip is laid out horizontally and turned -90deg. Built in Minimal's
  layout (Glass, Amber, Metal inherit it). Side-by-side rules are now written `:not([data-layout="stack"],
  [data-layout="column"])`.
- `.nw-app[data-log-tall="true"]` (View > "Log runs down the side"): side by side with the log shown, the log
  spans down beside the lanes (lanes in three columns). Minimal always does this (`--nw-log-tall: always`) and
  fills unused lane cells with a sunk panel. Skins with `--nw-layouts: own` (Moonlamp, Brassworks) offer
  neither option; the runtime shows them disabled and shows side by side without forgetting the choice.
- The app is moved by `transform` on its own layer (`will-change`), not `left/top` (ghost edges, Amber).

## v0.14 (10/6)

- Layouts are named Horizontal (`row`), Vertical (`column`), Stacked (`stack`). Menu options that don't apply are
  HIDDEN (`li[hidden]`), not disabled: Appearance (with `[data-part="theme-heading"]` and
  `[data-part="theme-separator"]`) in one-look skins; Vertical in `--nw-layouts: own` skins; "Log runs down the
  side" outside Horizontal and in skins where it isn't a choice.
- `.nw-timeline > [data-part="sleep-bands"]` carries the same `[data-part="sleep"]` bands as the graph; hidden by
  default, drawn across the lane lines in Vertical. Skins style both through
  `.nw-timeline :is([data-part="activity"], [data-part="sleep-bands"]) [data-part="sleep"]`.
- `html[data-window-active="true"|"false"]` follows the window's focus. Glass makes its panes near-opaque when the
  window is inactive (macOS stops the frost sampling the desktop then).

## v0.15 (10/7)

- Lane `activity` (snapshot, optional): `working | idle | waiting`, from Claude Code's per-session status
  (`~/.claude/sessions/<pid>.json`, `status: busy | idle | shell | waiting`; shell counts as idle). Internal to
  Claude Code, not a published API: absent when unreadable, and the card shows no light. Emitted as
  `.nw-lane[data-activity]`; the state tip gains " · working (running inference)" and so on. Skins: working
  breathes the state light (`nw-working`), waiting takes the bell colour, reduced motion gets a ring instead.
- The deck's primary slot follows the house: `wake-all` while any lane can wake (sleeping/failed/orphaned), else
  `sleep-all` takes the big slot and the small pause is dropped. `[data-part="transport"][data-all-awake]`.
  Transport layouts must tolerate two or three buttons. The runtime's refresh now swaps the transport too.
- The runtime fetches the remembered range on boot when the served timeline differs (the restart bug).

## v0.16: persona rows (10/7)

- `.nw-lanes` holds one `section.nw-persona[data-persona]` per persona, in the order the personas first appear.
  Each holds `h2[data-part="persona-name"]`, that persona's `.nw-lane` cards, and its own
  `.nw-add[data-persona]` slot. Cards no longer carry `[data-part="persona"]`. Select lanes with a descendant
  selector (`.nw-lanes .nw-lane`), never `.nw-lanes > .nw-lane`.
- Skins set `--nw-persona-label`: `gutter` (Minimal, Amber, Metal: a spine inside the app's left edge; the first
  column widens by `--nw-gutter-w` via `--nw-col1`, and the group's left padding insets first-column cards on
  every row, through subgrid) or `hang` (Glass: a tab outside the left edge, the grid untouched). The runtime
  mirrors it to `.nw-app[data-persona-label]`, and to `own` for `--nw-layouts: own` skins, whose groups are
  `display: contents` for now.
- Vertical: one column per persona, name on top. Stacked: a heading over each group.
- Hit regions include each persona name (Glass's tab sits outside the app box; the host accepts it).
- (10/7, later) Persona names take their material from `--nw-persona-bg`, `--nw-persona-outline`,
  `--nw-persona-shadow`, `--nw-persona-r` and `--nw-persona-blur` (Glass: a pane; Metal: brushed with a bevel;
  Amber: the obelisk gloss). The type is bolder than the card's model line.
- Cards drop `[data-part="session"]` and `[data-part="since"]` for `li[data-part="uptime"]` holding
  `time[data-part="elapsed"][datetime=<since>]`, which counts up (the runtime ticks it beside the bell's
  countdown). The session id appears nowhere on a card. Lane settings carry
  `[data-part="session-row"] button[data-action="copy-session"][data-session=<full id>]`, a local action (not a
  house write). The snapshot gains `LANES[].sessionId` (the full id).
- (10/7, round 3) Bell tips are local time. The facts row is centred. Horizontal persona labels stay upright; only
  their inner `span` turns sideways (so the label's tip reads normally). The terminal button toggles
  `data-action` between `open-terminal` and `hide-terminal` (icon `terminal-hide`, `aria-pressed`) from the host's
  `terminal-state` (front | open | hidden | missing), re-read on every refresh; the host gained `hide-terminal`
  and `terminal-state`. The log has `[data-part="filters"] [data-action="reset-log"]` (restore defaults: every
  lane, default kinds), and `.nw-log[data-lane-only]` names the lane in the heading.
- (10/7, round 4) The persona label is `h2[data-part="persona-name"][data-action="toggle-persona"][aria-expanded]`
  holding `[data-part="persona-avatar"]` (initial, `--persona-hue` from the id: sum of char codes × 47 mod 360),
  `[data-part="label"]` (the name; the only part that turns sideways in Horizontal) and a `chev` icon.
  `.nw-persona[data-open]` folds: cards and Add agent hide and `p[data-part="persona-summary"]` ("3 agents · 2
  awake · 1 failed") shows, in the persona material. The runtime remembers the fold per persona; a live alarm on
  any card unfolds it. The summary is a hit region. Glass Vertical: the head plus left column are one pane, and
  the persona columns float 8px off. The settings buttons' skin rules cover `[data-part="session-row"]`.
  The uptime tip is "Up since: HH:MM" (or "<State> since: …").
- (10/7, consistency pass) `.nw-persona[data-state]` is its agents' combined state (first present of failed,
  orphaned, belled, folding, awake, waking, sleeping, down) and maps to `--state` exactly as a card's does; the
  persona's accent, tint and badge colour come from it. The badge takes each skin's own avatar rule
  (`:is(.nw-lane [data-part="avatar"], .nw-persona [data-part="persona-avatar"])`, both entries at equal weight;
  Amber's is its glow bar). Persona materials are declared on `.nw-persona`, not `:root`. `--nw-spine-top`
  aligns the Horizontal badge with the cards' avatars per skin. The chevron follows the cards (up open, down
  folded); a folded persona is one card wide in Horizontal and full width in Vertical. The `--persona-hue` badge
  colour is gone.
- (10/7, from fable) Meter `data-level` is re-based on WINDOW fraction (ok <75%, high >=75%, over >=90%); the
  target tick is the nightly fold's trim-to size, not a trigger. Value names unchanged.
- (10/7, persona card) `.nw-persona` holds `article[data-part="persona-card"][data-card-open]`: its header
  `h2[data-part="persona-name"][data-action="toggle-persona-card"]` (badge, label, `persona-toggle` caret, which
  folds only the card body) and `[data-part="persona-body"]`: `ul[data-part="persona-agents"]` (one `li` per lane
  with `data-lane`, `data-state` and `data-activity`: a light in the state's colour, breathing while working),
  then `[data-part="persona-buttons"]`: `button[data-part="show-agents"][data-action="toggle-persona"]`
  (eye / eye-off; `.nw-persona[data-open]` hides the agent cards and Add agent, never the persona card) and
  `button[data-action="persona-settings"]` (not yet wired). After the last persona:
  `button.nw-add-persona[data-action="add-persona"]` (not yet wired). `persona-summary` is gone: hidden agents
  leave the card in its own shape (a spine in Horizontal, a card in Vertical). The runtime remembers both folds
  per persona. Hit regions: the persona card and the +.
- (10/7, round 5) Persona card: the name has no tip (the lights carry the detail). The body is a tray
  (`--nw-persona-tray`) under a seam. Horizontal: the spine has two columns, the header and then the tray
  (`--nw-gutter-w`: Minimal 65, Metal 69, Amber 57; Glass's hanging tab takes `--nw-spine-pad-x`), and the
  runtime gives each persona row a min-height of its spine. Vertical: no extra gap under the card; the floating +
  is centred on the last persona card (`--nw-add-persona-y`, set by the runtime). Alarm nodes (`data-alarm`)
  paint over routine ones. The app's first-run position is 112px in (room for Glass's tab).
- (10/7) Timeline and Log are deck buttons (`data-action="toggle-timeline"` / `"toggle-log"`, aria-pressed
  mirrors `data-show-*`); the View menu no longer has those checkboxes. Vertical: the two share one region, and
  whichever is open fills it (the runtime sets `--tl-body`, or `--nw-log-min`). With both closed, the column
  ends at the deck.
- (10/7, round 6) The head has a third menu, `[data-menu="app"]` (gear, `data-action="app-menu"`), holding "Schedule
  and health check…" (`app-settings`) and Keep on top. Both left the View menu, and Settings left the deck.
  Nightly is now an icon-only transport button after stop (`[data-part="transport"] [data-action="toggle-nightly"]`).
  Pressed transport buttons use the toggles' pressed style. Picking anything in a head menu closes it, on the click,
  so re-picking the current choice closes it too. The Horizontal spine has no caret, and its tray always shows.
  Metal: with no app alarms, the head reaches over the empty alarms row's gaps, so no slit shows. "Log runs down the
  side" is now "Extend log".
- (10/7) The deck is now the display plus one transport: primary, pause, stop, Nightly (repeat), then
  `[data-part="panel-toggle"]` Timeline and Log, all icon-only. The `toggles` row is gone. The square buttons
  are fixed 34px, in one flex row that wraps when the deck runs out of room (Ra: no forced second line). Vertical
  fits all six in every skin; Horizontal fits four or five on the first line. Toggle buttons
  carry `data-tip-on` and `data-tip-off`, and the runtime keeps `data-tip` in step with `aria-pressed`
  (Nightly: "Nightly cycle is on: … Press to turn it off.").

## v0.17: plan usage on the persona card (Ra, 11/19)

- **Data.** `persona.usage` (assembled by gui/assemble.mjs from machinery/usage-tee.mjs's file; absent when there is
  no tee file, which is every install until the statusLine entry is placed): `{provider, at, stale, model,
  windows: [{key, pct, resetsAt, expired, usedUsd?, limitUsd?, period?}]}`, windows in canonical order (`five_hour`,
  `seven_day`, `spend_limit`, then anything else by key). The usage is the account's, so it rides the persona;
  hubs.mjs spreads it into every lane's persona.
- **Markup.** In `[data-part="persona-body"]`, between the agent lights and the buttons:
  `div[data-part="usage"][data-provider][data-stale]` holding one `div[data-part="usage-window"]` per window, with
  `data-window` (the key), `data-current` (exactly one is `true`), `data-level` (`ok`, `high` at 80%, `over` at
  100%, `none` when expired or with no percentage), `data-expired`, `data-fable` (a key matching /fable/i) and
  `--fill` (0..1). Inside: the label (`button[data-part="usage-label"][data-action="flip-usage"]` when there is more
  than one window, else a `span`: "5h", "Wk", "$", or the key humanized), `span[data-part="bar"][role="meter"]`,
  `span[data-part="value"]` ("42%", "reset" or "—") and `time[data-part="usage-reset"][datetime]` (the time to the
  reset, in days once it's a day out: "3d 19h"). Each window's `data-tip` says what it is, when it resets, and, when
  `stale`, when it was last read and why it may have moved. No data means no `[data-part="usage"]` at all, never an
  empty bar.
- **No separate Fable pool is drawn.** On Max-style plans Fable draws the same weekly limit (faster, capped at half
  of it); there's no Fable window in Claude Code's data today. A window whose key names Fable is drawn like any
  other and carries `data-fable`. The Settings menu's `label[data-view="fable-usage"] >
  input[data-view-toggle="fable-usage"]` (default on) sets `.nw-app[data-show-fable-usage]`; skins hide
  `[data-fable="true"]` windows when it's `false`.
- **Runtime.** The label flips to the next shown window (focus follows); the choice is remembered per persona
  (`state.usage`) and put back after every refresh; hiding Fable moves a card off a Fable window and flipping skips
  it. `time[data-part="usage-reset"]` ticks with the others.
- **Skins.** Minimal draws it in the context meter's language, in the plan's own colours (blue, amber at 80%, red at
  the limit; never the persona's state colour, which can be red for an unrelated failed lane), dims a stale block,
  and leaves an expired window's track empty. In the Horizontal spine (Ra, 11/19: it must never lengthen the
  column past the cards) the bar curls into a 22px ring beside the agent lights, centred on the first light; the label
  in its centre is the flip button, and the percentage and the reset time move to the tip. The spine widens by
  `--nw-usage-gutter` (12px; Concrete 25px) only while some persona shows usage; Glass's hanging tab grows on its
  own. Measured with every card folded, the ring adds 0px to any persona row in Minimal, Glass, Amber and Concrete.
  Glass, Amber, Metal, Brassworks and Concrete take it through build_skins.py. Moonlamp hides persona cards, so it
  shows no usage.
