// Nightwatch runtime: the viewer half of the contract (CONTRACT.md).
//
// The fixture is a DOM contract; this file makes it an app. It implements
// every interaction the contract assigns to "the viewer": lane accordions,
// the view menu, the deck's log toggle, log filters, the timeline's range,
// the skin selector, live refresh, clocks and countdowns. Skins never see
// it; they only style the attributes it writes.
//
// Two modes, picked by how the page was loaded:
//   file://  (stills, fixture review): interactions work, nothing persists,
//            nothing refreshes, nothing is disabled, so stills are unchanged.
//   served   (gui/server.mjs, later the Tauri shell): view state persists per
//            viewer, data refreshes in place, and write actions route to
//            window.NW_HOST.act() when a host provides one. Phase 1 has none,
//            so they render disabled with a "read-only for now" tip.
//
// Event delegation on document throughout: refresh swaps whole sections, and
// delegated handlers survive that without rebinding.
(() => {
  'use strict';
  const doc = document, root = doc.documentElement;
  const SERVED = location.protocol === 'http:' || location.protocol === 'https:';
  const app = () => doc.querySelector('.nw-app');
  const $ = (sel, el = doc) => el.querySelector(sel);
  const $$ = (sel, el = doc) => [...el.querySelectorAll(sel)];

  // ---------------------------------------------------------------- state
  // Per-viewer conveniences only. Storage can throw (private windows, blocked
  // site data); every access is guarded and the page works without it.
  const KEY = 'nightwatch.view.v1';
  const load = () => { if (!SERVED) return {}; try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const state = load();
  const save = () => { if (!SERVED) return; try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

  // Actions that change the world. Everything else is view.
  const WRITES = new Set(['open-terminal', 'hide-terminal', 'wake', 'sleep', 'emergency-fold', 'wake-all', 'sleep-all', 'fold-all',
    'toggle-nightly', 'arm-lane', 'toggle-midday', 'save-lane', 'remove-lane', 'save-settings', 'restore-checkpoint', 'retry-wake',
    'restart-daemon', 'run-doctor', 'remove-orphan', 'confirm', 'hide-window']);
  // Lane creation (10/6): flow buttons, each needing one host capability.
  // plan = the machinery's dry run, apply = the build (nightwatch.mjs).
  const NEEDS = { setup: 'plan', 'add-persona': 'plan', 'setup-next': 'plan', 'plan-lane': 'plan', 'check-import': 'inspect-import',
    'create-persona': 'apply', 'create-lane': 'apply' };
  const host = () => window.NW_HOST && typeof window.NW_HOST.act === 'function' ? window.NW_HOST : null;
  // App-level settings has no panel in the phase-1 page yet; it reads as
  // not-yet rather than broken.
  const NOT_YET = new Set([]); // everything has its flow now: per-persona settings and Add persona (10/7)

  // A host wires actions one at a time (NW_HOST.can); everything it can't do
  // yet, or everything at all in a plain browser tab, stays read-only. A
  // button the emitter already disabled for its lane's state stays disabled.
  const canDo = (a) => { const h = host(); return !!h && (typeof h.can !== 'function' || h.can(NEEDS[a] ?? a)); };
  function markReadOnly(scope = doc) {
    if (!SERVED) return;
    const h = host();
    root.dataset.readonly = h ? 'partial' : 'true';
    for (const b of $$('[data-action]', scope)) {
      const a = b.dataset.action;
      if (!(WRITES.has(a) || NOT_YET.has(a) || a in NEEDS) || b.tagName === 'HEADER') continue;
      if (b.dataset.gated === 'true') continue; // its gate checkbox owns the state
      if (b.dataset.roTip || ((WRITES.has(a) || a in NEEDS) && canDo(a))) continue;
      b.setAttribute('aria-disabled', 'true');
      b.dataset.roTip = '1';
      const tip = b.dataset.tip ? `${b.dataset.tip.replace(/\.$/, '')}. ` : '';
      b.dataset.tip = h ? `${tip}Not wired in the app yet.` : `${tip}Read-only for now: Nightwatch shows the house, it doesn't drive it yet.`;
    }
  }

  // ---------------------------------------------------------------- acting
  // Every action that changes the house asks first, in plain words, and says
  // what happened after. The dialog and the status line use the contract's
  // .nw-confirm and a viewer-chrome .nw-toast.
  const CONFIRM = {
    // A leftover from the Doctor's sweep (10/16): a background job or hub
    // entry whose hub is gone. One at a time, never in a batch.
    'remove-orphan': (lane, btn) => btn?.dataset.volumes === 'true'
      ? { title: 'Remove a leftover on an external drive?', verb: 'Remove anyway', icon: 'x', danger: true,
          body: `${btn.dataset.orphanName}: its hub is on a drive that may just be unplugged. If the drive comes back, the hub will need setting up again. Remove it only if that drive is gone for good.` }
      : { title: 'Remove this leftover?', verb: 'Remove', icon: 'x',
          body: `${btn?.dataset.orphanName}: its hub no longer exists, so it can't do anything. Removing it stops the background job (if it is one) and deletes it; nothing else is touched.` },
    wake: (lane) => ({ title: `Wake ${lane} now?`, verb: 'Wake', icon: 'sun',
      body: `Opens a Terminal window that resumes ${lane} from their last sleep, the same way the 08:00 wake does. If ${lane} is already awake, nothing happens.` }),
    'retry-wake': (lane) => ({ title: `Try waking ${lane} again?`, verb: 'Retry wake', icon: 'retry',
      body: `Opens a Terminal window that resumes ${lane} from their last sleep. If the checkpoint is still missing, restore it first or this attempt fails the same way.` }),
    'wake-all': () => ({ title: 'Wake every sleeping agent?', verb: 'Wake all', icon: 'play',
      body: 'Each sleeping agent gets their own Terminal window, resuming from their last sleep. Agents already awake are left alone.' }),
    'sleep-all': () => ({ title: 'Ring every awake agent\'s bell?', verb: 'Ring all bells', icon: 'pause',
      body: 'Every awake agent gets the 02:00 note: write the day\'s rung, then fold. Each finishes the step they\'re on first.' }),
    'restore-checkpoint': () => ({ title: 'Restore the checkpoint?', verb: 'Restore', icon: 'restore',
      body: 'Copies the newest timestamped archive back to the checkpoint path. Only runs if the checkpoint is missing; it never replaces one that exists.' }),
    'restart-daemon': () => ({ title: 'Restart the nightshift?', verb: 'Restart', icon: 'retry',
      body: 'Relaunches the background job that rings bells and wakes agents. Agents keep running; only the watcher restarts.' }),
    'emergency-fold': (lane) => ({ title: `Force-fold ${lane}?`, verb: 'Force fold', icon: 'fold', danger: true,
      body: `Closes ${lane}'s window now, folds them, and opens a fresh one straight away. The fresh window writes the rung for the day. For a full context or an API-error wall; for a normal bedtime, use Sleep agent.` }),
    'fold-all': () => ({ title: 'Force-fold every awake agent?', verb: 'Force-fold all', icon: 'fold', danger: true,
      body: 'Each awake agent is closed now, folded, and reopened fresh; each fresh window writes their own rung. Agents that are asleep are left alone.' }),
    'remove-lane': (lane) => ({ title: `Remove ${lane} from Nightwatch?`, verb: 'Remove', icon: 'x',
      body: `The nightshift stops belling and waking ${lane}, and they leave this window. Their transcripts, ladder and receipts stay on disk.` }),
    'toggle-nightly': (lane, btn) => btn?.getAttribute('aria-pressed') === 'true'
      ? { title: 'Turn the nightly cycle off?', verb: 'Turn off', icon: 'repeat',
          body: 'No agent will be belled, folded or woken tonight until you turn it back on. Agents keep running as they are.' }
      : { title: 'Turn the nightly cycle on?', verb: 'Turn on', icon: 'repeat',
          body: 'Every agent will be belled at their sleep time and woken at their wake time.' },
    // One lane's nightly switch: the bell slot on its card (Ra, 10/8).
    'arm-lane': (lane, btn) => btn?.getAttribute('aria-pressed') === 'true'
      ? { title: `Disarm ${lane}?`, verb: 'Disarm', icon: 'bell-off',
          body: `${lane} won't be belled, folded or woken tonight, or any night, until you arm them again. They keep running as they are now.` }
      : { title: `Arm ${lane}?`, verb: 'Arm', icon: 'bell',
          body: `${lane} will be belled at their sleep time and woken at their wake time, starting tonight.` },
    // The midday cycle's switch (Ra, 10/12), beside the bell.
    'toggle-midday': (lane, btn) => btn?.getAttribute('aria-pressed') === 'true'
      ? { title: `Turn off ${lane}'s midday cycle?`, verb: 'Turn off', icon: 'cycle',
          body: `${lane} won't be asked to fold during the day. They fold only at their nightly bell, however full their window gets.` }
      : { title: `Turn on ${lane}'s midday cycle?`, verb: 'Turn on', icon: 'cycle',
          body: `When ${lane}'s context reaches 85% of their window, they're asked to fold at their own seam and reopen right away. At 95%, the fold happens within ten minutes.` },
    sleep: (lane) => ({ title: `Put ${lane} to sleep?`, verb: 'Sleep agent', icon: 'moon',
      body: `Sends ${lane} the same note the 02:00 bell sends: write the day's rung, then fold. They finish the step they're on first, so nothing is cut off mid-thought.` }),
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function ask({ title, body, verb, icon, danger = false }) {
    return new Promise((done) => {
      $('.nw-app > .nw-confirm')?.remove();
      const d = doc.createElement('div');
      d.className = 'nw-confirm'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-label', title);
      const ic = icon ? `<svg class="nw-icon" aria-hidden="true"><use href="#i-${icon}"/></svg>` : '';
      d.innerHTML = `<p data-part="title">${ic} ${esc(title)}</p><p data-part="body">${esc(body)}</p>`
        + `<div data-part="buttons"><button type="button" data-part="no">Cancel</button>`
        + `<button type="button" data-part="yes" ${danger ? 'data-danger="true"' : 'data-primary="true"'}>${ic}<span>${esc(verb)}</span></button></div>`;
      const close = (yes) => { d.remove(); doc.removeEventListener('keydown', key, true); done(yes); };
      const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
      d.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) close(b.dataset.part === 'yes'); });
      doc.addEventListener('keydown', key, true);
      (app() || doc.body).append(d);
      $('[data-part="yes"]', d).focus();
    });
  }
  let toastTimer;
  function toast(text, failed = false) {
    let t = $('.nw-app > .nw-toast');
    if (!t) { t = doc.createElement('p'); t.className = 'nw-toast'; t.setAttribute('role', 'status'); (app() || doc.body).append(t); }
    t.textContent = text; t.dataset.status = failed ? 'failed' : 'ok'; t.hidden = !text;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, failed ? 12000 : 6000);
  }
  // What each save sends: exactly its own panel's fields (k as the user
  // typed it; the host converts and validates).
  const PAYLOAD = {
    'remove-orphan': (btn) => ({ id: btn.dataset.orphanId }),
    'save-lane': (btn) => {
      const p = btn.closest('[data-part="settings"]');
      return {
        targetK: Number($('input[type="number"]', p)?.value),
        inherit: $('[data-schedule-toggle]', p)?.checked ?? true,
        sleep: $('[data-part="sleep"] input', p)?.value ?? '',
        wake: $('[data-part="wake"] input', p)?.value ?? '',
        armed: $('[data-part="armed"] input', p)?.checked ?? true,
      };
    },
    'save-settings': (btn) => {
      const p = btn.closest('.nw-settings');
      const [sleep, wake] = $$('[data-part="schedule"] input[type="time"]', p).map((i) => i.value);
      return { sleep, wake, lanes: $$('table[data-part="lanes"] tbody tr[data-lane]', p).map((tr) => ({
        id: tr.dataset.lane, targetK: Number($('input[type="number"]', tr)?.value), armed: $('input[type="checkbox"]', tr)?.checked ?? true })) };
    },
    'toggle-nightly': (btn) => ({ on: btn.getAttribute('aria-pressed') !== 'true' }),
    'arm-lane': (btn) => ({ on: btn.getAttribute('aria-pressed') !== 'true' }),
    'toggle-midday': (btn) => ({ on: btn.getAttribute('aria-pressed') !== 'true' }),
  };
  // The terminal button is a toggle (Ra, 10/7): while the lane's Terminal
  // window is open (not minimized), it hides it; otherwise it brings it to the
  // front. The host reports the real state on every refresh, so a window
  // minimized by hand flips the button back. What the button does is its
  // data-action, so read-only marking and the host checks see the true verb.
  const terminalOpen = {};
  function paintTerminal(lane) {
    const b = $(`.nw-app > .nw-lanes .nw-lane[data-lane="${CSS.escape(lane)}"] :is([data-action="open-terminal"], [data-action="hide-terminal"])`);
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    const open = !!terminalOpen[lane];
    b.dataset.action = open ? 'hide-terminal' : 'open-terminal';
    b.setAttribute('aria-label', open ? 'Hide terminal' : 'Open terminal');
    b.setAttribute('aria-pressed', String(open));
    b.dataset.tip = open ? "Minimize this agent's terminal window" : "Bring this agent's terminal to the front";
    b.querySelector('use')?.setAttribute('href', open ? '#i-terminal-hide' : '#i-terminal');
  }
  // What the host needs to find a lane: its own name and its persona's hub.
  // The page keys a lane as data-lane, which is "<persona>/<lane>" when
  // several personas share the page (gui/hubs.mjs); the host wants the bare
  // name plus the hub it lives in. No hub: the app's own (single-hub) hub.
  function laneRef(el) {
    const laneEl = el?.closest('[data-lane]');
    return { lane: laneEl ? (laneEl.dataset.name ?? laneEl.dataset.lane) : null, hub: el?.closest('.nw-persona, .nw-settings')?.dataset.hub ?? null };
  }
  async function syncTerminals() {
    const h = host(); if (!h || !canDo('terminal-state')) return;
    for (const b of $$('.nw-app > .nw-lanes .nw-lane[data-lane] :is([data-action="open-terminal"], [data-action="hide-terminal"]):not([aria-disabled="true"])')) {
      const lane = b.closest('[data-lane]').dataset.lane;
      try { const s = await h.act('terminal-state', laneRef(b)); terminalOpen[lane] = s === 'front' || s === 'open'; }
      catch { terminalOpen[lane] = false; }
      paintTerminal(lane);
    }
  }

  // The Doctor's sweep (10/16): leftovers that outlived their hub, read
  // fresh on each Check again and listed beside the health items. Built with
  // textContent only, since a finding names paths from the user's disk. A
  // job the sweep couldn't read is listed with no button: it's never removed
  // from here.
  const icon = (name) => {
    const svg = doc.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'nw-icon'); svg.setAttribute('data-icon', name); svg.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS(SVGNS, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use);
    return svg;
  };
  const MISSING = { hub: 'its hub folder is gone', config: 'its hub has no config', machinery: 'its Nightwatch code is gone', unparseable: "Nightwatch can't read it; check it by hand" };
  async function renderSweep(doc_) {
    const ul = doc_.querySelector('ul'); if (!ul || !canDo('sweep')) return;
    ul.querySelectorAll('[data-part="orphan"]').forEach((li) => li.remove());
    const row = (status, iconName, text) => {
      const li = doc.createElement('li'); li.dataset.part = 'orphan'; li.dataset.status = status;
      li.append(icon(iconName), ` ${text}`); ul.append(li); return li;
    };
    let report;
    try { report = JSON.parse(await host().act('sweep')); }
    catch (err) { row('warn', 'warn', `Couldn't check for leftovers: ${String(err?.message ?? err)}`); return; }
    if (report?.version !== 1 || !Array.isArray(report.findings)) { row('warn', 'warn', 'The leftover check answered in a format this window doesn\'t know; update the app.'); return; }
    if (!report.findings.length) { row('ok', 'check', 'No leftovers from removed hubs'); return; }
    for (const f of report.findings) {
      const name = f.kind === 'job' ? `Background job ${f.label ?? f.id}` : `Hub entry ${f.hub}`;
      const why = (f.missing ?? []).map((m) => MISSING[m] ?? m).join('; ');
      const li = row('warn', 'warn', `${name}: ${why}${f.hub && f.kind === 'job' ? ` (${f.hub})` : ''}${f.volumes ? ', on a drive that may just be unplugged' : ''}`);
      if (!f.removable) continue;
      const b = doc.createElement('button'); b.type = 'button'; b.dataset.action = 'remove-orphan'; b.dataset.part = 'fix';
      b.dataset.orphanId = f.id; b.dataset.orphanName = name; b.dataset.volumes = String(!!f.volumes);
      const label = doc.createElement('span'); label.textContent = 'Remove';
      b.append(icon('x'), label); li.append(b);
    }
  }

  async function perform(a, btn) {
    const lane = btn.closest('[data-lane]')?.dataset.lane ?? null; // the page's key, for page state
    const ref = laneRef(btn);                                       // what the host is told
    const data = PAYLOAD[a]?.(btn);
    const c = CONFIRM[a]?.(ref.lane, btn);
    if (c && !(await ask(c))) return;
    btn.setAttribute('aria-busy', 'true');
    try {
      const msg = await host().act(a, { ...ref, data });
      if (a === 'run-doctor') {
        // The nightshift's dry run reads best as written: into the health
        // panel, verbatim, not a toast.
        const doc_ = btn.closest('.nw-settings')?.querySelector('[data-part="doctor"]');
        if (doc_) {
          let pre = doc_.querySelector('[data-part="preflight"]');
          if (!pre) { pre = doc.createElement('pre'); pre.dataset.part = 'preflight'; doc_.append(pre); }
          pre.textContent = msg;
          await renderSweep(doc_);
        }
      } else if (a === 'remove-orphan') {
        if (msg) toast(msg);
        const doc_ = btn.closest('[data-part="doctor"]');
        if (doc_) await renderSweep(doc_);
      } else if (msg) toast(msg);
      if ((a === 'open-terminal' || a === 'hide-terminal') && lane) { terminalOpen[lane] = a === 'open-terminal'; paintTerminal(lane); }
      setTimeout(() => refresh({ force: true }), 4000);
    } catch (err) {
      toast(String(err?.message ?? err), true);
    } finally {
      btn.removeAttribute('aria-busy');
    }
  }

  // ---------------------------------------------------------------- view
  const VIEW_ATTR = { controls: 'showControls', timeline: 'showTimeline', log: 'showLog', 'log-tall': 'logTall', 'fable-usage': 'showFableUsage' };
  function setView(view, on, persist = true) {
    const a = app(); if (!a || !(view in VIEW_ATTR)) return;
    a.dataset[VIEW_ATTR[view]] = String(on);
    const box = $(`[data-view-toggle="${view}"]`); if (box) box.checked = on;
    if (view === 'log' || view === 'timeline') $$(`.nw-controls [data-action="toggle-${view}"]`).forEach((b) => b.setAttribute('aria-pressed', String(on)));
    if (view === 'fable-usage') syncUsage();
    if (persist) { (state.view ??= {})[view] = on; save(); }
  }

  // Plan usage on the persona card (11/19): one window shows at a time and its
  // label flips to the next. The choice is remembered per persona; a window
  // that disappears (a refresh without it, or a Fable window the Settings
  // toggle hides) hands over to the first one still shown.
  const usageShown = (g) => $$('[data-part="usage"] > [data-part="usage-window"]', g)
    .filter((w) => !(w.dataset.fable === 'true' && app()?.dataset.showFableUsage === 'false'));
  function setUsage(g, key, persist = true) {
    const shown = usageShown(g); if (!shown.length) return;
    const pick = shown.find((w) => w.dataset.window === key) ?? shown[0];
    for (const w of $$('[data-part="usage"] > [data-part="usage-window"]', g)) w.dataset.current = String(w === pick);
    if (persist) { (state.usage ??= {})[g.dataset.persona] = pick.dataset.window; save(); }
    return pick;
  }
  function syncUsage() {
    for (const g of $$('.nw-persona')) if ($('[data-part="usage"]', g)) setUsage(g, state.usage?.[g.dataset.persona] ?? $('[data-part="usage-window"][data-current="true"]', g)?.dataset.window, false);
  }
  function setRadio(group, value, persist = true) {
    const a = app(); if (!a) return;
    if (group === 'timeline-mode') a.dataset.timelineMode = value;
    else if (group === 'layout') { a.dataset.layout = value; syncLayoutOptions(); }
    else if (group === 'skin') return setSkin(value, persist);
    else if (group === 'theme') setTheme(value);
    const r = $(`[name="${group}"][value="${value}"]`); if (r) r.checked = true;
    if (persist) { (state.view ??= {})[group] = value; save(); }
  }
  // Two head menus (10/6): View, and Look (appearance + skin). One open at a
  // time; setMenu(false) closes both.
  function setMenu(open, which = 'view') {
    for (const m of $$('.nw-head [data-part="view-menu"]')) {
      const on = open && (m.dataset.menu ?? 'view') === which;
      m.dataset.open = String(on);
      $$(`[data-action="${m.dataset.menu ?? 'view'}-menu"]`).forEach((b) => b.setAttribute('aria-expanded', String(on)));
    }
  }
  const menuOpen = (which) => $(`.nw-head [data-part="view-menu"][data-menu="${which}"]`)?.dataset.open === 'true';

  // ---------------------------------------------------------------- appearance
  // View menu > Appearance (Ra, 10/6): match the system (the default), or
  // always light, or always dark. The skin draws both looks under
  // :root[data-theme]; "system" leaves the attribute off. A skin with one
  // look (Amber is always dark) says so instead of seeming to ignore you.
  // Whether the window is the active one (10/6): macOS stops the Glass frost
  // sampling the desktop when it isn't, so skins can firm up their panes.
  const markActive = () => { root.dataset.windowActive = String(doc.hasFocus()); };
  addEventListener('focus', markActive); addEventListener('blur', markActive); markActive();

  function setTheme(v) {
    if (v === 'light' || v === 'dark') root.dataset.theme = v; else delete root.dataset.theme;
  }
  // Menu options that don't apply are HIDDEN, not greyed (Ra, 10/6). Minimal
  // always runs the log down the side; Moonlamp and Brassworks
  // (--nw-layouts: own) have their own layout, so neither the long log nor
  // Vertical applies there; the long log only means anything in Horizontal.
  const showItem = (label, on) => { const li = label?.closest('li'); if (li) li.hidden = !on; };
  function syncLayoutOptions(skinChanged = false) {
    const cs = getComputedStyle(root), own = cs.getPropertyValue('--nw-layouts').trim() === 'own';
    const always = cs.getPropertyValue('--nw-log-tall').trim() === 'always';
    const a = app();
    // A skin without Vertical shows Horizontal, without forgetting the
    // choice: back on a skin that has it, it returns.
    if (a && own && a.dataset.layout === 'column') a.dataset.layout = 'row';
    else if (a && !own && skinChanged && state.view?.layout === 'column') a.dataset.layout = 'column';
    showItem($('.nw-head [data-view="layout"][data-value="column"]'), !own);
    // Where a skin puts the persona's name beside their row (10/7): a gutter
    // inside the app's edge (the solid skins), a tab hanging off it (Glass),
    // or the skin's own arrangement (Moonlamp, Brassworks).
    if (a) a.dataset.personaLabel = own ? 'own' : (cs.getPropertyValue('--nw-persona-label').trim() || 'gutter');
    showItem($('.nw-head [data-view="log-tall"]'), !own && !always && (a?.dataset.layout ?? 'row') === 'row');
  }
  function syncTheme() {
    // Everything here reads the skin's own custom properties, so a stylesheet
    // that hasn't loaded yet would answer with the defaults (10/7: Glass read
    // as "gutter" on a cold load). Run again once it has.
    const link = $('#skin');
    if (link && !link.sheet) link.addEventListener('load', syncTheme, { once: true });
    syncLayoutOptions(true); // runs on boot and on every skin load
    const both = getComputedStyle(root).getPropertyValue('--nw-appearances').trim() === 'both';
    for (const l of $$('.nw-head [data-part="view-menu"] [data-view="theme"]')) showItem(l, both);
    for (const li of $$('.nw-head [data-part="view-menu"] :is([data-part="theme-heading"], [data-part="theme-separator"])')) li.hidden = !both;
  }

  // ---------------------------------------------------------------- skins
  // The <link id="skin"> swap is the whole mechanism; the URL and storage
  // remember the choice so a reload or a relaunch keeps it.
  function setSkin(name, persist = true) {
    if (!/^[a-z0-9_-]+$/i.test(name)) return;
    const link = $('#skin');
    if (link) {
      // Appearance options depend on the new skin's own stylesheet: re-read once it has loaded.
      link.addEventListener('load', syncTheme, { once: true });
      link.href = `${name}/skin.css`;
    }
    root.dataset.skin = name;
    const r = $(`[name="skin"][value="${name}"]`); if (r) r.checked = true;
    if (persist) {
      state.skin = name; save();
      try { const u = new URL(location.href); u.searchParams.set('skin', name); history.replaceState(null, '', u); } catch {}
    }
  }

  // ---------------------------------------------------------------- lanes
  function setLaneOpen(lane, open, persist = true) {
    lane.dataset.open = String(open);
    const t = $('[data-part="toggle"]', lane);
    if (t) { t.setAttribute('aria-expanded', String(open)); t.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${lane.dataset.lane}`); }
    if (persist && lane.dataset.lane) { (state.lanes ??= {})[lane.dataset.lane] = open; save(); }
  }
  // Only a red card holds its lane open; an amber one waits to be looked at (Ra, 10/12).
  const hasLiveAlarm = (lane) => !!$('.nw-alert[data-acked="false"]:not([data-level="warn"])', lane);
  // A persona folds like a lane (10/7): their name and a one-line summary stay,
  // their cards and Add agent tuck away. Remembered per persona; a persona with
  // an un-acked alarm on any card never stays folded.
  function setPersonaOpen(g, open, persist = true) {
    g.dataset.open = String(open);
    const b = $('[data-part="show-agents"]', g);
    if (b) { b.setAttribute('aria-pressed', String(open)); b.setAttribute('aria-label', open ? 'Hide agents' : 'Show agents'); }
    if (persist && g.dataset.persona) { (state.personas ??= {})[g.dataset.persona] = open; save(); }
  }
  // The persona card's caret folds only the card's own body (lights and
  // buttons); the agents are the show/hide button's (Ra, 10/7).
  function setPersonaCardOpen(g, open, persist = true) {
    const card = $(':scope > [data-part="persona-card"]', g); if (!card) return;
    card.dataset.cardOpen = String(open);
    $(':scope > [data-part="persona-name"]', card)?.setAttribute('aria-expanded', String(open));
    if (persist && g.dataset.persona) { (state.personaCards ??= {})[g.dataset.persona] = open; save(); }
  }

  // ---------------------------------------------------------------- log
  function applyFilters(scope = doc) {
    const log = $('.nw-log', scope) || $('.nw-log'); if (!log) return;
    const off = new Set($$('[data-part="filters"] label[data-kind]', log).filter((l) => !$('input', l).checked).map((l) => l.dataset.kind));
    const only = log.dataset.laneOnly || '';
    for (const row of $$('li.nw-event', log)) row.hidden = off.has(row.dataset.kind) || (only && row.dataset.lane !== only);
    // A day header with no visible rows under it hides too.
    let day = null, any = false;
    for (const li of $$('ol[data-part="events"] > li', log)) {
      if (li.classList.contains('nw-day')) { if (day) day.hidden = !any; day = li; any = false; }
      else if (!li.hidden) any = true;
    }
    if (day) day.hidden = !any;
  }
  function restoreFilters() {
    if (!state.filters) return;
    for (const l of $$('.nw-log [data-part="filters"] label[data-kind]')) {
      if (l.dataset.kind in state.filters) $('input', l).checked = state.filters[l.dataset.kind];
    }
  }

  // ---------------------------------------------------------------- range
  async function setRange(range, persist = true) {
    const tl = $('.nw-timeline'); if (!tl) return;
    for (const b of $$('[data-part="range"] [data-range]', tl)) b.setAttribute('aria-checked', String(b.dataset.range === range));
    tl.dataset.range = range;
    if (persist) { state.range = range; save(); }
    if (SERVED) await refresh({ only: 'timeline' });
  }

  // ---------------------------------------------------------------- clocks
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function span(ms) {
    if (ms <= 0) return 'now';
    const m = Math.round(ms / 60000), h = Math.floor(m / 60);
    return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
  }
  function usageIn(ms) {
    if (ms <= 0) return 'now';
    const m = Math.round(ms / 60000), h = Math.floor(m / 60);
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
  }
  function tick() {
    if (!SERVED) return;
    for (const c of $$('time[data-part="usage-reset"][datetime]')) {
      const t = Date.parse(c.getAttribute('datetime'));
      if (!Number.isNaN(t)) c.textContent = usageIn(t - Date.now());
    }
    const now = new Date();
    for (const c of $$('time[data-part="clock"]')) { c.textContent = hhmm(now); c.setAttribute('datetime', now.toISOString()); }
    for (const c of $$('time[data-part="countdown"][datetime]')) {
      const t = Date.parse(c.getAttribute('datetime'));
      if (!Number.isNaN(t)) c.textContent = span(t - now);
    }
    // ...and the lane's time up (or time in its state) counts the other way.
    for (const c of $$('time[data-part="elapsed"][datetime]')) {
      const t = Date.parse(c.getAttribute('datetime'));
      if (!Number.isNaN(t)) c.textContent = now - t > 0 ? span(now - t) : '0m';
    }
    // The glance copy of a lane's countdown has no data-part; it shares the datetime.
    for (const c of $$('[data-part="glance"] time[datetime]')) {
      const t = Date.parse(c.getAttribute('datetime'));
      if (!Number.isNaN(t)) c.textContent = span(t - now);
    }
  }

  // ---------------------------------------------------------------- refresh
  // Fetch the page again and swap the data regions in place, then re-apply
  // the viewer's state. Skipped while the person is mid-interaction (a menu,
  // a form, a focused field), so a refresh never takes a click away.
  const busy = () => {
    const a = doc.activeElement;
    // Live regions only: the hidden test sheet (.nw-gallery) holds an open
    // settings panel and an open add form on purpose, and must not count.
    const live = '.nw-app > .nw-lanes';
    return $('.nw-head [data-part="view-menu"][data-open="true"]') || $(`${live} [data-part="settings"][data-open="true"]`)
      || $(`${live} .nw-add[data-open="true"]`) || $('.nw-app > .nw-setup[data-open="true"]')
      || (a && a.closest && !a.closest('.nw-gallery') && a.closest('.nw-app form, .nw-app select, .nw-app textarea, .nw-app input:not([type="checkbox"]):not([type="radio"])'));
  };
  let inflight = null;
  async function refresh({ only = null, force = false } = {}) {
    if (!SERVED || inflight) return;
    if (!force && !only && busy()) return;
    const u = new URL(location.href);
    const range = $('.nw-timeline')?.dataset.range; if (range) u.searchParams.set('range', range);
    inflight = fetch(u, { cache: 'no-store' }).then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((html) => {
        const next = new DOMParser().parseFromString(html, 'text/html');
        const swap = (sel) => { const a = $(sel), b = $(sel, next); if (a && b) a.replaceWith(doc.adoptNode(b)); };
        if (only === 'timeline') swap('.nw-app > .nw-timeline');
        else {
          for (const sel of ['.nw-head [data-part="schedule"]', '.nw-head .nw-glyph', '.nw-app > .nw-alarms',
            '.nw-app > .nw-lanes', '.nw-app > .nw-controls [data-part="display"]', '.nw-app > .nw-controls [data-part="transport"]', '.nw-app > .nw-timeline', '.nw-app > .nw-log']) swap(sel);
          // The settings dialog shows armed state, schedules and fold targets
          // that change outside the app (Ra, 10/8: a lane disarmed from the
          // terminal still showed armed, and saving that stale form would
          // have re-armed it). Re-render it while it's closed; an open dialog
          // is left alone so nobody's edit is swapped out under them.
          if ($('.nw-app > .nw-settings')?.dataset.open !== 'true') swap('.nw-app > .nw-settings');
        }
        root.dataset.stale = 'false';
        reapply();
      })
      .catch(() => { root.dataset.stale = 'true'; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // Re-apply viewer state after first load and after every swap.
  let rangeSynced = null;
  function reapply() {
    // The panel toggles show what is open now, defaults included (Ra, 10/7:
    // they came up dark with both panels open until clicked twice). The page
    // arrives unpressed, and a refresh re-renders the deck.
    const a = app();
    if (a) for (const v of ['timeline', 'log']) $$(`.nw-app > .nw-controls [data-action="toggle-${v}"]`).forEach((b) => b.setAttribute('aria-pressed', a.dataset[VIEW_ATTR[v]] === 'true' ? 'true' : 'false'));
    // The viewer's "Got it"s first: a refresh re-renders every alert un-acked,
    // and an alert this viewer dismissed must not force its lane open again
    // (Ra, 10/7: the lane kept springing open every 30s).
    for (const id of state.acked ?? []) {
      for (const al of $$(`.nw-app > .nw-lanes .nw-alert[data-ack-id="${CSS.escape(id)}"], .nw-app > .nw-alarms > .nw-alarm[data-ack-id="${CSS.escape(id)}"]`)) al.dataset.acked = 'true';
    }
    for (const lane of $$('.nw-app > .nw-lanes .nw-lane[data-lane]')) {
      // An un-acked alarm always opens its lane (contract v0.4): trouble never
      // hides behind a closed card, whatever the viewer last chose.
      if (hasLiveAlarm(lane)) setLaneOpen(lane, true, false);
      else if (state.lanes && lane.dataset.lane in state.lanes) setLaneOpen(lane, state.lanes[lane.dataset.lane], false);
    }
    for (const g of $$('.nw-app > .nw-lanes > .nw-persona')) {
      if ($$(':scope > .nw-lane[data-lane]', g).some(hasLiveAlarm)) setPersonaOpen(g, true, false);
      else if (state.personas && g.dataset.persona in state.personas) setPersonaOpen(g, state.personas[g.dataset.persona], false);
      if (state.personaCards && g.dataset.persona in state.personaCards) setPersonaCardOpen(g, state.personaCards[g.dataset.persona], false);
    }
    syncUsage();
    // A restart serves the default range while the buttons remember the saved
    // one (Ra, 10/7: "24h" lit over an 8h timeline until clicked). If what was
    // served isn't what's remembered, fetch the remembered range once.
    const served = $('.nw-timeline')?.dataset.range;
    if (state.range) for (const b of $$('.nw-timeline [data-part="range"] [data-range]')) b.setAttribute('aria-checked', String(b.dataset.range === state.range));
    if (state.range && $('.nw-timeline')) $('.nw-timeline').dataset.range = state.range;
    if (SERVED && state.range && served && served !== state.range && rangeSynced !== state.range) {
      rangeSynced = state.range;
      setTimeout(async () => { try { await inflight; } catch {} refresh({ only: 'timeline' }); }, 0); // after any refresh in flight
    }
    restoreFilters(); applyFilters();
    markReadOnly(); tick();
    for (const lane of Object.keys(terminalOpen)) paintTerminal(lane); // a swap re-rendered the buttons
    syncTerminals();
  }

  // ---------------------------------------------------------------- tips
  // A tip draws above its element unless that would run into the head bar
  // (Ra, 10/7: the top card's tips in Vertical); then it draws below.
  doc.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]'); if (!el || el.closest('.nw-head')) return;
    const limit = $('.nw-app > .nw-head')?.getBoundingClientRect().bottom ?? 0;
    const below = el.getBoundingClientRect().top - 48 < Math.max(limit, 0);
    if (below) el.dataset.tipPos = 'below'; else delete el.dataset.tipPos;
    // A tip stays inside its card: drawn centred, then slid just far enough
    // to clear the card's side edges. The neighbouring panel paints over
    // anything that crosses (Ra, 10/9: in Vertical the timeline hid half of
    // the Sleep and Logs tips; Logs' tip is too wide to anchor at either edge
    // of its button). Measured one frame later, once :hover has drawn the tip
    // at its real width.
    delete el.dataset.tipAlign;
    requestAnimationFrame(() => {
      const s = getComputedStyle(el, '::after');
      let w = parseFloat(s.width);
      if (!w) return;
      if (s.boxSizing !== 'border-box') w += parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
      const box = (el.closest('.nw-lane, .nw-persona, .nw-alarm') ?? el.closest('.nw-app > *'))?.getBoundingClientRect();
      if (!box) return;
      const r = el.getBoundingClientRect();
      const centred = r.left + r.width / 2 - w / 2;
      const inset = 4;
      // Clamp into the card; a tip wider than the card starts at its left edge.
      const left = Math.max(box.left + inset, Math.min(centred, box.right - inset - w));
      if (Math.abs(left - centred) < 0.5) return;
      el.style.setProperty('--tip-dx', `${Math.round(left - r.left)}px`);
      el.dataset.tipAlign = 'shift';
    });
  });

  // ---------------------------------------------------------------- events
  doc.addEventListener('click', (e) => {
    const t = e.target;
    const btn = t.closest('[data-action]');
    // Choosing anything in a head menu closes it (Ra, 10/7): a menu left open
    // hangs in the air while the layout it just changed moves under it. On the
    // click, not the change: re-picking the current choice fires no change.
    if (t.closest?.('.nw-head [data-part="view-menu"] :is(label, button)')) setMenu(false);
    // Outside clicks close the view menu.
    if (!t.closest('[data-part="view-menu"]') && !t.closest('[data-action="view-menu"], [data-action="look-menu"], [data-action="app-menu"]')) setMenu(false);
    if (!btn) return;
    const a = btn.dataset.action;

    // A header is a toggle, but its inner buttons keep their own meaning.
    if (a === 'toggle-lane' && t.closest('button, a, input, select, label') && !t.closest('[data-part="toggle"]')) return;

    if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    if (FLOW.has(a)) {
      if (!(a in NEEDS) || canDo(a)) flow(a, btn);
      return;
    }
    if (WRITES.has(a)) {
      if (canDo(a)) perform(a, btn);
      return;
    }
    switch (a) {
      case 'toggle-persona-card': {
        const g = btn.closest('.nw-persona'); const c = g && $(':scope > [data-part="persona-card"]', g);
        if (c) setPersonaCardOpen(g, c.dataset.cardOpen !== 'true');
        break;
      }
      case 'flip-usage': {
        const g = btn.closest('.nw-persona'); if (!g) break;
        const shown = usageShown(g), at = shown.indexOf(btn.closest('[data-part="usage-window"]'));
        const next = shown[(at + 1) % shown.length];
        if (next) { setUsage(g, next.dataset.window); $('[data-part="usage-label"]', next)?.focus?.(); }
        break;
      }
      case 'toggle-persona': {
        const g = btn.closest('.nw-persona'); if (g) setPersonaOpen(g, g.dataset.open !== 'true');
        break;
      }
      case 'toggle-lane': {
        const lane = btn.closest('.nw-lane'); if (lane) setLaneOpen(lane, lane.dataset.open !== 'true');
        break;
      }
      // Settings are per persona (Ra, 10/7): the gear on a persona's card opens
      // that persona's panel. The head's entry (shown only by skins without
      // persona cards) opens the first persona's.
      case 'persona-settings': case 'app-settings': case 'close-settings': {
        const panels = $$('.nw-app > .nw-settings');
        const want = a === 'close-settings' ? null
          : a === 'persona-settings' ? panels.find((p) => p.dataset.persona === btn.closest('.nw-persona')?.dataset.persona)
          : panels[0];
        const open = !!want && want.dataset.open !== 'true';
        for (const p of panels) p.dataset.open = String(open && p === want);
        setMenu(false);
        break;
      }
      case 'view-menu': setMenu(!menuOpen('view'), 'view'); break;
      case 'look-menu': setMenu(!menuOpen('look'), 'look'); break;
      case 'app-menu': setMenu(!menuOpen('app'), 'app'); break;
      case 'toggle-log': setView('log', app()?.dataset.showLog !== 'true'); break;
      case 'toggle-timeline': setView('timeline', app()?.dataset.showTimeline !== 'true'); break;
      case 'copy-session': {
        // Local, not a house action: the id goes to the clipboard and nowhere else.
        // navigator.clipboard needs a secure context (localhost is one); the
        // textarea copy is the fallback for a page served any other way.
        const sid = btn.dataset.session; if (!sid) break;
        const fallback = () => { const t = doc.createElement('textarea'); t.value = sid; t.style.cssText = 'position:fixed;opacity:0'; doc.body.append(t); t.select(); const ok = doc.execCommand('copy'); t.remove(); return ok; };
        (navigator.clipboard?.writeText(sid) ?? Promise.reject()).then(() => true, () => fallback())
          .then((ok) => toast(ok ? `Copied session ID ${sid.slice(0, 8)}…` : 'Could not copy the session ID', !ok));
        break;
      }
      case 'collapse-all':
        for (const lane of $$('.nw-app > .nw-lanes .nw-lane[data-lane]')) if (!hasLiveAlarm(lane)) setLaneOpen(lane, false);
        setMenu(false);
        break;
      case 'lane-settings': {
        const lane = btn.closest('.nw-lane'), s = lane && $('[data-part="settings"]', lane);
        if (!s) break;
        const open = s.dataset.open !== 'true';
        s.dataset.open = String(open); btn.setAttribute('aria-expanded', String(open));
        if (!open) for (const g of $$('[data-gate]', s)) { g.checked = false; g.dispatchEvent(new Event('change', { bubbles: true })); }
        if (open) setLaneOpen(lane, true);
        break;
      }
      case 'add-lane': {
        const slot = btn.closest('.nw-add'); if (!slot) break;
        const open = slot.dataset.open !== 'true';
        slot.dataset.open = String(open); btn.setAttribute('aria-expanded', String(open));
        break;
      }
      case 'cancel': {
        const slot = btn.closest('.nw-add');
        if (slot) { slot.dataset.open = 'false'; $('[data-action="add-lane"]', slot)?.setAttribute('aria-expanded', 'false'); }
        const dlg = btn.closest('.nw-confirm'); if (dlg) dlg.hidden = true;
        break;
      }
      case 'reset-log': {
        // Restore defaults (Ra, 10/7: a lane's Logs button narrowed the log
        // with no way back): every lane, and each kind as it first rendered.
        const log = $('.nw-app > .nw-log'); if (!log) break;
        log.dataset.laneOnly = '';
        for (const l of $$('[data-part="filters"] label[data-kind]', log)) { const i = $('input', l); i.checked = i.defaultChecked; }
        state.filters = {}; save();
        applyFilters();
        break;
      }
      case 'show-log': {
        // A lane's Logs button: show the log narrowed to that lane. Showing
        // the log again from the deck clears the narrowing.
        const lane = btn.closest('.nw-lane')?.dataset.lane;
        setView('log', true);
        const log = $('.nw-app > .nw-log');
        // The heading names the lane as the timeline does ("Lark · main" when
        // several personas share the page; the bare name otherwise).
        if (log) {
          log.dataset.laneOnly = lane ?? '';
          log.dataset.laneLabel = (lane && $(`.nw-app > .nw-timeline .nw-strip[data-lane="${CSS.escape(lane)}"]`)?.dataset.label) || lane || '';
          applyFilters(); log.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        break;
      }
      case 'ack': {
        // Hides the alert on this screen only (its tip says so); the house
        // still knows.
        // Lane alerts (.nw-alert) and app-level alarms (.nw-alarm) alike; an
        // alarm's ack-id names one episode (kind:lastAlive), so a new outage
        // after a recovery shows again.
        const al = btn.closest('.nw-alert, .nw-alarm'); if (!al) break;
        al.dataset.acked = 'true';
        if (al.dataset.ackId) { (state.acked ??= []).push(al.dataset.ackId); state.acked = state.acked.slice(-50); save(); }
        break;
      }
    }
  });

  doc.addEventListener('click', (e) => {
    const r = e.target.closest('.nw-timeline [data-part="range"] [data-range]');
    if (r) setRange(r.dataset.range);
  });

  doc.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-view-toggle]')) {
      const v = t.dataset.viewToggle;
      if (v === 'on-top') { setOnTop(t.checked); return; }
      if (v === 'log') { const log = $('.nw-app > .nw-log'); if (log) log.dataset.laneOnly = ''; applyFilters(); }
      setView(v, t.checked);
    } else if (t.matches('[data-part="view-menu"] input[type="radio"]')) {
      setRadio(t.name, t.value);
    } else if (t.matches('[data-schedule-toggle]')) {
      // "Use global nightshift settings" (Ra, 10/6). Ticked: the lane follows
      // the global schedule, so its fields show the global times and lock.
      // Unticked: the lane keeps its own timer, editable. (Saving the choice
      // comes with settings-save; this is the panel's own behaviour.)
      const set = t.closest('[data-part="settings"]'); if (!set) return;
      const globalTimes = $$('.nw-head [data-part="schedule"] time').map((e) => e.getAttribute('datetime'));
      for (const [i, part] of [[0, 'sleep'], [1, 'wake']]) {
        const input = $(`[data-part="${part}"] input`, set); if (!input) continue;
        input.disabled = t.checked;
        if (t.checked && globalTimes[i]) input.value = globalTimes[i];
      }
    } else if (t.matches('.nw-add [data-field="inherit"]')) {
      // Add agent's schedule: ticked follows the global times, locked.
      const slot = t.closest('.nw-add');
      const globalTimes = $$('.nw-head [data-part="schedule"] time').map((x) => x.getAttribute('datetime'));
      ['sleep', 'wake'].forEach((n, i) => { const f = field(slot, n); if (!f) return; f.disabled = t.checked; if (t.checked && globalTimes[i]) f.value = globalTimes[i]; });
    } else if (t.matches('.nw-add [data-field="provider"]')) {
      // Runs on (codex lane leg 6): each runtime has its own models, and a codex agent starts fresh (lane-add
      // refuses adopting into codex), so "an existing Claude Code session" is set back and disabled.
      const slot = t.closest('.nw-add'), codex = t.value === 'codex';
      const mc = $('[data-part="model-claude"]', slot), mx = $('[data-part="model-codex"]', slot);
      if (mc) mc.hidden = codex;
      if (mx) mx.hidden = !codex;
      const first = field(slot, 'first'), adoptOpt = first && $('option[value="adopt"]', first);
      if (adoptOpt) adoptOpt.disabled = codex;
      if (codex && first && first.value === 'adopt') { first.value = 'fresh'; const row = $('[data-part="adopt"]', slot); if (row) row.hidden = true; }
    } else if (t.matches('.nw-add [data-field="first"]')) {
      const slot = t.closest('.nw-add'), row = $('[data-part="adopt"]', slot);
      if (row) row.hidden = t.value !== 'adopt';
      if (t.value === 'adopt') fillSessions(slot);
    } else if (t.matches('[data-gate]')) {
      // A danger action behind a checkbox (Ra, 10/6: Remove must not be one
      // stray click away). Ticking enables the button only if the host can do it.
      const scope = t.closest('[data-part="settings"]') || doc;
      const b = $(`[data-action="${t.dataset.gate}"]`, scope);
      if (b) b.setAttribute('aria-disabled', String(!(t.checked && canDo(t.dataset.gate))));
    } else if (t.closest('.nw-log [data-part="filters"]')) {
      const l = t.closest('label[data-kind]');
      if (l) { (state.filters ??= {})[l.dataset.kind] = t.checked; save(); }
      applyFilters();
    }
  });

  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setMenu(false); for (const p of $$('.nw-app > :is(.nw-settings, .nw-setup)[data-open="true"]')) p.dataset.open = 'false'; return; }
    // Headers are toggles; make them keyboard toggles too.
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('header[data-action="toggle-lane"]')) {
      e.preventDefault(); e.target.click();
    }
  });

  // ---------------------------------------------------------------- lane creation
  // Set up (a new persona) and Add agent (a new lane), 10/6. Both build one
  // spec (anima_dev/nightwatch_lane_creation.md, "the contract"); the
  // preview is the machinery's own dry run of it, so it can't promise
  // anything the build won't do. Checks here are for plain words before the
  // host sees anything; the machinery validates again.
  const field = (el, name) => $(`[data-field="${name}"]`, el);
  const val = (el, name) => (field(el, name)?.value ?? '').trim();
  // A step with `consent` runs only when the person ticks it (the transcript
  // retention change, Ra 10/11): it renders as a checkbox, unticked, named
  // by the spec field the build reads. Every other step is what Confirm does.
  const stepsHtml = (steps) => steps.map((st) => st.consent
    // The box sits in the verb's own cell: every skin lays a step out as a
    // grid of exactly these three children, so wrapping two of them would
    // collapse the grid (it did, in all seven, on the first try).
    ? `<li data-verb="${esc(String(st.verb).toLowerCase())}" data-consent="${esc(st.consent)}"><b><label><input type="checkbox" data-field="${esc(st.consent)}"> ${esc(st.verb)}</label></b> <code>${esc(st.what)}</code> <span>${esc(st.detail ?? '')}</span></li>`
    : `<li data-verb="${esc(String(st.verb).toLowerCase())}"><b>${esc(st.verb)}</b> <code>${esc(st.what)}</code> <span>${esc(st.detail ?? '')}</span></li>`).join('');
  const parse = (msg) => { try { return JSON.parse(msg); } catch { throw new Error(`The machinery answered in a shape the app doesn't read: ${String(msg).slice(0, 120)}`); } };
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  function showError(el, text) { const p = $('[data-part="error"]', el); if (p) { p.textContent = text ?? ''; p.hidden = !text; } }
  function targetOk(el) {
    const k = Number(val(el, 'targetK'));
    return Number.isInteger(k) && k >= 10 && k <= 2000 ? k : null;
  }
  async function whileBusy(btn, fn) {
    btn.setAttribute('aria-busy', 'true');
    try { return await fn(); } finally { btn.removeAttribute('aria-busy'); }
  }

  function laneSpec(slot) {
    const id = val(slot, 'id');
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) throw new Error('Agent names are lowercase letters, numbers and dashes, starting with a letter (for example "scout").');
    const taken = $$('.nw-app > .nw-lanes .nw-lane[data-lane]').map((l) => l.dataset.lane);
    if (taken.includes(id)) throw new Error(`There's already an agent called "${id}".`);
    const k = targetOk(slot);
    if (k === null) throw new Error('The fold target must be a whole number of k between 10 and 2000.');
    const inherit = field(slot, 'inherit')?.checked ?? true;
    const sleep = val(slot, 'sleep'), wake = val(slot, 'wake');
    if (!inherit && !(TIME.test(sleep) && TIME.test(wake))) throw new Error('Sleep and wake need times like 02:00.');
    const codex = val(slot, 'provider') === 'codex';
    const adopt = val(slot, 'first') === 'adopt';
    const sessionId = val(slot, 'session');
    if (codex && adopt) throw new Error('A Codex agent starts from a fresh session.');
    if (adopt && !sessionId) throw new Error('Pick the running session to adopt, or start from a fresh session.');
    return { op: 'lane-add', lane: {
      id, ...(codex ? { provider: 'codex', model: val(slot, 'codexModel') } : { model: val(slot, 'model') }),
      targetTokens: k * 1000, armed: field(slot, 'armed')?.checked ?? true,
      schedule: inherit ? null : { sleep, wake },
      firstSession: adopt ? { kind: 'adopt', sessionId } : { kind: 'fresh' } } };
  }

  // A new persona's first lane is "main": a neutral body name, since the
  // persona may not have a name of their own yet.
  const setupState = { import: null };
  function personaSpec(dlg) {
    return { op: 'init', hub: val(dlg, 'hub'),
      persona: { name: val(dlg, 'name') || null, about: val(dlg, 'about'), person: val(dlg, 'person') },
      schedule: { sleep: val(dlg, 'sleep'), wake: val(dlg, 'wake') },
      lane: { id: 'main', model: val(dlg, 'model'), targetTokens: (targetOk(dlg) ?? 250) * 1000,
        armed: field(dlg, 'armed')?.checked ?? true, schedule: null, firstSession: { kind: 'fresh' } },
      import: setupState.import,
      // Only a ticked box raises the setting; a preview without the step (the
      // value is already high enough) leaves this false, and the build agrees.
      retention: { keepTranscripts: field(dlg, 'keepTranscripts')?.checked === true } };
  }
  function checkWho(dlg) {
    if (!val(dlg, 'about')) return 'Write a paragraph about who they are. It seeds their identity file.';
    if (!val(dlg, 'person')) return 'Add your name, so they know who you are.';
    const hub = val(dlg, 'hub');
    if (!hub || /\/$/.test(hub)) return 'Give their folder a name, for example ~/Nightwatch/lark.';
    return null;
  }
  function checkNights(dlg) {
    if (!(TIME.test(val(dlg, 'sleep')) && TIME.test(val(dlg, 'wake')))) return 'Sleep and wake need times like 02:00.';
    if (targetOk(dlg) === null) return 'The fold target must be a whole number of k between 10 and 2000.';
    return null;
  }
  const setStep = (dlg, step) => { dlg.dataset.step = step; showError(dlg, ''); };

  async function preview(el, spec, btn) {
    // A lane-add runs in the persona it was opened from (their hub); Set up makes a new hub, named in the spec.
    const plan = parse(await whileBusy(btn, () => host().act('plan', { data: spec, hub: el.closest('.nw-persona')?.dataset.hub ?? null })));
    const steps = Array.isArray(plan) ? plan : plan.steps;
    if (!Array.isArray(steps) || !steps.length) throw new Error('The dry run came back empty, so there is nothing to preview.');
    $('[data-part="steps"]', el).innerHTML = stepsHtml(steps);
  }

  async function flow(a, btn) {
    const dlg = $('.nw-app > .nw-setup');
    const slot = btn.closest('.nw-add');
    try {
      switch (a) {
        // The floating + (Add persona) is Set up: a new persona is a new hub (Ra, 10/7).
        case 'setup': case 'add-persona':
          if (!dlg) return;
          setupState.import = null; setStep(dlg, 'who'); dlg.dataset.open = 'true';
          field(dlg, 'about')?.focus(); return;
        case 'close-setup': if (dlg) dlg.dataset.open = 'false'; return;
        case 'setup-import': setStep(dlg, 'import'); field(dlg, 'from')?.focus(); return;
        case 'setup-back':
          setStep(dlg, { import: 'who', nights: 'who', preview: 'nights' }[dlg.dataset.step] ?? 'who'); return;
        case 'check-import': {
          const from = val(dlg, 'from');
          if (!from) throw new Error('Type the folder to import.');
          const r = parse(await whileBusy(btn, () => host().act('inspect-import', { data: { from } })));
          const li = (st, ic, text) => `<li data-status="${st}"><svg class="nw-icon" aria-hidden="true"><use href="#i-${ic}"/></svg> ${esc(text)}</li>`;
          const found = $('[data-part="found"]', dlg);
          if (!r.identity) {
            found.innerHTML = li('failed', 'x', 'No identity.md in this folder, so there is nothing to import yet.');
            setupState.import = null; return;
          }
          found.innerHTML = li('ok', 'check', 'identity.md')
            + (r.name ? li('ok', 'check', `name.txt: ${r.name}`) : li('missing', 'minus', 'No name yet: they can choose one themselves'))
            + (r.memory ? li('ok', 'check', `memory/: ${r.memory} file${r.memory === 1 ? '' : 's'}`) : li('missing', 'minus', 'No memory folder'))
            + (r.rungs ? li('ok', 'check', `ladder: ${r.rungs} rung${r.rungs === 1 ? '' : 's'}`) : li('missing', 'minus', 'No ladder rungs'));
          setupState.import = { from };
          if (r.name) field(dlg, 'name').value = r.name;
          if (typeof r.about === 'string') field(dlg, 'about').value = r.about;
          return;
        }
        case 'setup-next': {
          const step = dlg.dataset.step;
          if (step === 'import') {
            if (!setupState.import) throw new Error('Check the folder first.');
            setStep(dlg, 'who'); return;
          }
          if (step === 'who') { const err = checkWho(dlg); if (err) throw new Error(err); setStep(dlg, 'nights'); return; }
          if (step === 'nights') {
            const err = checkNights(dlg); if (err) throw new Error(err);
            await preview(dlg, personaSpec(dlg), btn);
            setStep(dlg, 'preview');
          }
          return;
        }
        case 'create-persona': {
          const msg = await whileBusy(btn, () => host().act('apply', { data: personaSpec(dlg) }));
          dlg.dataset.open = 'false';
          toast(msg || 'Set up. Their first session is opening in Terminal.');
          setTimeout(() => refresh({ force: true }), 4000);
          return;
        }
        case 'plan-lane': {
          showError(slot, '');
          await preview(slot, laneSpec(slot), btn);
          slot.dataset.step = 'preview'; return;
        }
        case 'plan-back': slot.dataset.step = 'form'; return;
        case 'create-lane': {
          const msg = await whileBusy(btn, () => host().act('apply', { data: laneSpec(slot), hub: slot.closest('.nw-persona')?.dataset.hub ?? null }));
          slot.dataset.step = 'form'; slot.dataset.open = 'false';
          $('[data-action="add-lane"]', slot)?.setAttribute('aria-expanded', 'false');
          toast(msg || 'Added. Their first session is opening in Terminal.');
          setTimeout(() => refresh({ force: true }), 4000);
          return;
        }
      }
    } catch (err) {
      const where = slot ?? dlg;
      const text = String(err?.message ?? err);
      if (where) showError(where, text); else toast(text, true);
    }
  }
  const FLOW = new Set(['setup', 'add-persona', 'close-setup', 'setup-import', 'setup-back', 'check-import', 'setup-next',
    'create-persona', 'plan-lane', 'plan-back', 'create-lane']);

  // The adopt picker: live Claude Code sessions no lane has claimed.
  async function fillSessions(slot) {
    const sel = field(slot, 'session'); if (!sel) return;
    const h = host();
    if (!h || (typeof h.can === 'function' && !h.can('list-unclaimed'))) {
      sel.innerHTML = '<option value="">Not available in this window</option>'; return;
    }
    sel.innerHTML = '<option value="">Looking for sessions…</option>';
    try {
      const list = parse(await h.act('list-unclaimed', {}));
      sel.innerHTML = list.length
        ? '<option value="">Choose a session…</option>' + list.map((x) =>
          `<option value="${esc(x.sessionId)}">${esc(String(x.sessionId).slice(0, 8))}… · ${esc(x.cwd ?? '')}${x.model ? ` · ${esc(x.model)}` : ''}</option>`).join('')
        : '<option value="">No unclaimed sessions are running</option>';
    } catch (err) { sel.innerHTML = `<option value="">${esc(String(err?.message ?? err))}</option>`; }
  }

  // ---------------------------------------------------------------- hit areas
  // In the app the window is a transparent rectangle; the host makes it
  // click-through wherever the pointer isn't over a module, so the desktop
  // behind stays usable. This tells the host where the modules are.
  const HIT_SEL = ['.nw-app > .nw-head', '.nw-app > .nw-controls', '.nw-app > .nw-timeline', '.nw-app > .nw-log',
    '.nw-app > .nw-lanes .nw-lane', '.nw-app > .nw-lanes .nw-persona > [data-part="persona-card"]', '.nw-app > .nw-lanes > .nw-add-persona', '.nw-app > .nw-alarms > *', '.nw-app > .nw-confirm', '.nw-app > .nw-toast:not([hidden])',
    '.nw-head [data-part="view-menu"][data-open="true"]', '.nw-app > .nw-settings[data-open="true"]',
    '.nw-app > .nw-setup[data-open="true"]'].join(', ');
  let lastHit = '', hitQueued = false;
  function reportHits() {
    if (hitQueued) return;
    hitQueued = true;
    requestAnimationFrame(() => {
      hitQueued = false;
      // Mid-drag the whole window is live, or a fast pointer would outrun the
      // head's reported box and the window would let go of the drag.
      const rects = dragging ? [[0, 0, innerWidth, innerHeight]]
        : $$(HIT_SEL).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height)
          .map((r) => [r.x, r.y, r.width, r.height].map((n) => Math.round(n)));
      const key = JSON.stringify(rects);
      if (key !== lastHit) { lastHit = key; host().hitRects(rects); }
    });
  }
  function watchHits() {
    if (!host() || typeof host().hitRects !== 'function') return;
    const ro = new ResizeObserver(reportHits);
    const observeAll = () => { ro.disconnect(); const a = app(); if (a) ro.observe(a); $$(HIT_SEL).forEach((e) => ro.observe(e)); };
    new MutationObserver(() => { observeAll(); reportHits(); })
      .observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-open', 'hidden', 'data-show-controls', 'data-show-timeline', 'data-show-log', 'data-layout', 'data-timeline-mode', 'data-skin'] });
    addEventListener('resize', reportHits);
    observeAll(); reportHits();
    // Skin stylesheets load async; report again once they've applied.
    $('#skin')?.addEventListener('load', reportHits);
  }

  // ------------------------------------------------------- activity cursor
  // Hovering the timeline's output graph draws a dot on the curve under the
  // pointer, labelled with the rate there in tokens per minute (Ra, 10/9).
  // The dot lives inside the graph's own svg, so every skin's scaling and
  // Vertical's turned graph carry it for free; a zero-length round-capped
  // line with a non-scaling stroke stays round under the svg's stretch. The
  // label is HTML beside it, anchored at the dot. While the cursor shows,
  // the graph's static tip steps aside (it said the same thing, less well).
  const SVGNS = 'http://www.w3.org/2000/svg';
  const rate = (n) => n < 1000 ? `${Math.round(n)}` : n < 10_000 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n / 1e3)}k`;
  let cursorOn = null;
  function cursorOff() {
    const a = cursorOn; cursorOn = null; if (!a) return;
    $(':scope > svg [data-part="cursor"]', a)?.remove();
    $(':scope > [data-part="cursor-label"]', a)?.remove();
    delete a.dataset.cursor;
    if (a.dataset.tipRest != null) { a.dataset.tip = a.dataset.tipRest; delete a.dataset.tipRest; }
  }
  // The curve's height at svg x: the path is monotone in x, so a search on
  // its length finds the point exactly as drawn.
  function curveAt(path, x) {
    let lo = 0, hi = path.getTotalLength();
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (path.getPointAtLength(m).x < x) lo = m; else hi = m; }
    return path.getPointAtLength((lo + hi) / 2);
  }
  doc.addEventListener('pointermove', (e) => {
    const a = e.target.closest?.('.nw-timeline [data-part="activity"]');
    if (a !== cursorOn) cursorOff();
    if (!a) return;
    const svg = $(':scope > svg', a), line = svg && $('[data-part="line"]', svg);
    const series = (a.dataset.series ?? '').split(',').map(Number);
    const peak = Math.max(...series), bm = Number(a.dataset.bucketMin) || 10;
    if (!line || !(peak > 0)) return; // a quiet night has no curve worth reading
    const r = svg.getBoundingClientRect(); if (!r.width || !r.height) return;
    const turned = app()?.dataset.layout === 'column'; // Vertical: time runs up the screen
    const t = turned ? (r.bottom - e.clientY) / r.height : (e.clientX - r.left) / r.width;
    // The curve runs between the first and last bucket centres.
    const x = Math.min(1000 * (1 - .5 / series.length), Math.max(1000 * .5 / series.length, 1000 * t));
    const p = curveAt(line, x);
    if (cursorOn !== a) {
      cursorOn = a;
      if (a.dataset.tip != null) { a.dataset.tipRest = a.dataset.tip; delete a.dataset.tip; }
      a.dataset.cursor = 'on'; // skins hide the peak chip under it
    }
    let dot = $('[data-part="cursor"]', svg);
    if (!dot) { dot = doc.createElementNS(SVGNS, 'line'); dot.setAttribute('data-part', 'cursor'); dot.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(dot); }
    for (const [k, v] of [['x1', p.x], ['x2', p.x], ['y1', p.y], ['y2', p.y]]) dot.setAttribute(k, v.toFixed(2));
    let label = $(':scope > [data-part="cursor-label"]', a);
    if (!label) { label = doc.createElement('span'); label.dataset.part = 'cursor-label'; label.setAttribute('aria-hidden', 'true'); a.append(label); }
    // Tokens per minute: the curve's height over the series' scale, per bucket minute.
    const perMin = Math.max(0, (40 - p.y) / 34) * peak / bm;
    label.textContent = `${rate(perMin)}/min`;
    // Anchor in the graph's own (unturned) box: the svg's layout box inside
    // the padding, which getBoundingClientRect can't give once it's rotated.
    const cs = getComputedStyle(a);
    const left = parseFloat(cs.paddingLeft) + (p.x / 1000) * svg.clientWidth;
    const top = parseFloat(cs.paddingTop) + (p.y / 40) * svg.clientHeight;
    label.style.left = `${left}px`; label.style.top = `${top}px`;
    label.dataset.turned = turned ? 'true' : 'false';
  });
  doc.addEventListener('pointerleave', cursorOff);
  doc.addEventListener('pointerout', (e) => { if (cursorOn && !cursorOn.contains(e.relatedTarget)) cursorOff(); });

  // ------------------------------------------------------- measured layout
  // Things CSS can't measure (Ra, 10/7 round 5). Horizontal: the persona's
  // spine is positioned down the row's edge, so it can't size the row; when
  // the cards are short (all folded) its lights and buttons would spill below
  // it. The row gets a min-height of the spine's own height. Vertical: the
  // floating + sits level with the middle of the last persona card; and the
  // timeline and the log share one region, so whichever is open fills all of
  // it (the turned output graph needs the timeline's body as a length).
  let personaQueued = false;
  function fillColumn(a) {
    a.style.removeProperty('--tl-body'); a.style.removeProperty('--nw-log-min');
    if (a.dataset.layout !== 'column') return;
    const tlOn = a.dataset.showTimeline === 'true', logOn = a.dataset.showLog === 'true';
    if (tlOn === logOn) return; // both open share it as drawn; both closed, the column ends at the deck
    const tl = $(':scope > .nw-timeline', a), lanes = $(':scope > .nw-lanes', a); if (!tl || !lanes) return;
    // The pair's natural region: the timeline as drawn, a gap, the log's minimum.
    if (!tlOn) a.dataset.showTimeline = 'true';
    const tlH = tl.offsetHeight, tlTop = tl.getBoundingClientRect().top;
    const body = parseFloat(getComputedStyle(a).getPropertyValue('--tl-body')) || 360;
    if (!tlOn) a.dataset.showTimeline = 'false';
    const gap = parseFloat(getComputedStyle(a).rowGap) || 0, logMin = 160;
    const region = Math.max(tlH + gap + logMin, lanes.getBoundingClientRect().bottom - tlTop);
    if (tlOn) a.style.setProperty('--tl-body', Math.round(body + region - tlH) + 'px');
    else a.style.setProperty('--nw-log-min', Math.round(region) + 'px');
  }
  function layoutPersonas() {
    if (personaQueued) return;
    personaQueued = true;
    requestAnimationFrame(() => {
      personaQueued = false;
      const a = app(); if (!a) return;
      fillColumn(a);
      for (const g of $$('.nw-lanes > .nw-persona', a)) {
        const card = $(':scope > [data-part="persona-card"]', g);
        let min = '';
        if (card && getComputedStyle(card).position === 'absolute') {
          const prev = card.style.bottom; card.style.bottom = 'auto';
          min = card.offsetHeight + 'px';
          card.style.bottom = prev;
        }
        if (g.style.minHeight !== min) g.style.minHeight = min;
      }
      const plus = $(':scope > .nw-lanes > .nw-add-persona', a);
      const last = $$(':scope > .nw-lanes > .nw-persona > [data-part="persona-card"]', a).pop();
      const y = plus && last && a.dataset.layout === 'column' ? Math.max(0, Math.round((last.offsetHeight - plus.offsetHeight) / 2)) + 'px' : '';
      if (plus && plus.style.getPropertyValue('--nw-add-persona-y') !== y) plus.style.setProperty('--nw-add-persona-y', y);
      // Glass's hanging tab (Horizontal): the + sits centred under the last tab, whose width only layout knows.
      if (plus && last && a.dataset.personaLabel === 'hang' && !['column', 'stack'].includes(a.dataset.layout)) {
        const cur = parseFloat(plus.style.getPropertyValue('--nw-add-persona-x')) || 0;
        const c = last.getBoundingClientRect(), p = plus.getBoundingClientRect();
        const x = Math.round(cur + (c.left + c.width / 2) - (p.left + p.width / 2)) + 'px';
        if (plus.style.getPropertyValue('--nw-add-persona-x') !== x) plus.style.setProperty('--nw-add-persona-x', x);
      } else if (plus) plus.style.removeProperty('--nw-add-persona-x');
    });
  }
  function watchPersonas() {
    const ro = new ResizeObserver(layoutPersonas);
    const observeAll = () => { ro.disconnect(); $$('.nw-persona > [data-part="persona-card"], .nw-app > .nw-lanes').forEach((e) => ro.observe(e)); };
    new MutationObserver((recs) => {
      // fillColumn flips data-show-timeline for a moment to measure; ignore its own flips.
      // A there-and-back pair nets to nothing: the first record's old value is still the value now.
      if (recs.every((r) => r.attributeName === 'data-show-timeline') && recs[0].oldValue === recs[0].target.dataset.showTimeline) return;
      observeAll(); layoutPersonas();
    })
      .observe(doc.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-open', 'data-card-open', 'data-layout', 'data-skin', 'data-show-timeline', 'data-show-log'] });
    addEventListener('resize', layoutPersonas);
    $('#skin')?.addEventListener('load', layoutPersonas);
    observeAll(); layoutPersonas();
  }

  // ---------------------------------------------------------------- window
  // Keep on top is the viewer's choice, off by default (Ra, 10/6: the widget
  // must not be glued above every window). The host applies it.
  function setOnTop(on, persist = true) {
    const box = $('[data-view-toggle="on-top"]'); if (box) box.checked = on;
    if (typeof host()?.onTop === 'function') host().onTop(on);
    if (persist) { state.onTop = on; save(); }
  }
  // ---------------------------------------------------------------- canvas
  // In the app the window covers the screen's usable area and the app sits
  // inside it (Ra, 10/6: sizing the window to the panels kept cutting menus
  // off). Dragging the head moves the app; where it was dropped is
  // remembered. Clamped so the head can never leave the screen.
  let dragging = false;
  // 112px in from the left: room for a hanging persona tab (Glass's is two columns wide since 10/7).
  const DEFAULT_POS = [112, 24];
  function placeApp(x, y, persist = false) {
    const a = app(); if (!a) return;
    const w = a.offsetWidth;
    x = Math.round(Math.min(Math.max(x, 120 - w), innerWidth - 120));
    y = Math.round(Math.min(Math.max(y, 0), innerHeight - 40));
    a.style.setProperty('--nw-x', `${x}px`); a.style.setProperty('--nw-y', `${y}px`);
    if (persist) { state.pos = [x, y]; save(); }
    reportHits();
  }
  function watchDrag() {
    const head = $('.nw-app > .nw-head'); if (!head) return;
    head.removeAttribute('data-tauri-drag-region'); // that would drag the whole screen-sized window
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input, select, textarea, label, menu')) return;
      const r = app().getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId); head.dataset.dragging = ''; dragging = true; reportHits();
      const move = (ev) => placeApp(ev.clientX - dx + scrollX, ev.clientY - dy + scrollY);
      const up = () => {
        head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up);
        delete head.dataset.dragging; dragging = false;
        const st = getComputedStyle(app());
        placeApp(parseFloat(st.getPropertyValue('--nw-x')) || 0, parseFloat(st.getPropertyValue('--nw-y')) || 0, true);
      };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    // The canvas follows the screen (Dock, resolution); keep the app on it.
    addEventListener('resize', () => placeApp(...(state.pos ?? DEFAULT_POS)));
  }

  // ---------------------------------------------------------------- boot
  // A toggle's tip says its state and what a press does (Ra, 10/7): buttons
  // carry both texts (data-tip-on / data-tip-off) and follow aria-pressed.
  function syncTip(b) {
    const t = b.getAttribute('aria-pressed') === 'true' ? b.dataset.tipOn : b.dataset.tipOff;
    if (t != null && b.dataset.tip !== t) b.dataset.tip = t;
  }
  function watchTips() {
    $$('[data-tip-on]').forEach(syncTip);
    new MutationObserver((recs) => { for (const r of recs) if (r.target.dataset?.tipOn != null) syncTip(r.target); })
      .observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    new MutationObserver(() => $$('[data-tip-on]').forEach(syncTip)).observe(doc.body, { subtree: true, childList: true });
  }
  function boot() {
    watchPersonas();
    watchTips();
    // Lane headers take focus so the keyboard can reach the accordion.
    for (const h of $$('header[data-action="toggle-lane"]')) if (!h.hasAttribute('tabindex')) h.tabIndex = 0;
    if (SERVED) {
      // Inside the app (window.NW_SHELL) the window is transparent and the
      // desktop shows through; only a plain browser tab needs a ground.
      root.dataset.shell = window.NW_SHELL || (host() ? 'host' : 'browser');
      // The fake desktop is for stills; a served page never paints it, even
      // from an old bookmark that still says ?desk=1.
      root.dataset.desk = '0';
      try { const u = new URL(location.href); if (u.searchParams.has('desk')) { u.searchParams.delete('desk'); history.replaceState(null, '', u); } } catch {}
      // Stored choices win over the page's defaults; the URL's ?skin= wins
      // over storage, because a link someone sent should show what it says.
      const q = new URLSearchParams(location.search);
      const skin = q.get('skin') || state.skin;
      // Skins can scope rules to themselves (Minimal's rectangle), so the
      // default skin must be named too, not only a chosen one.
      if (!root.dataset.skin) { const m = $('#skin')?.getAttribute('href')?.match(/([a-z0-9_-]+)\/skin\.css/i); if (m) root.dataset.skin = m[1]; }
      if (skin) setSkin(skin, false);
      for (const [view, on] of Object.entries(state.view ?? {})) {
        if (view in VIEW_ATTR) setView(view, on, false);
        else setRadio(view, on, false);
      }
      if (!state.view?.theme) setRadio('theme', 'system', false);
      syncTheme();
      reapply();
      watchHits();
      if (root.dataset.shell === 'tauri') { watchDrag(); placeApp(...(state.pos ?? DEFAULT_POS)); }
      // On top: the viewer's stored choice, else off.
      setOnTop(state.onTop ?? false, false);
      setInterval(tick, 15_000);
      setInterval(() => refresh(), 30_000);
      // Interaction state in near-real time (Ra, 10/8): a closed window, a
      // fold, an arm toggled from the terminal should reach the buttons in
      // seconds, not at the next 30s tick. The server's /key is a cheap
      // fingerprint of exactly that state; only a change costs a refresh. A
      // change seen while someone is mid-edit stays pending and is retried.
      let lastKey = null;
      setInterval(async () => {
        if (doc.hidden || inflight) return;
        try {
          const k = await (await fetch('/key', { cache: 'no-store' })).text();
          if (lastKey !== null && k !== lastKey) {
            if (busy()) return;
            await refresh();
          }
          lastKey = k;
        } catch { /* server away: the 30s refresh marks the page stale */ }
      }, 3_000);
      doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    } else {
      // The fixture still checks the skin radio that matches ?skin=.
      const r = $(`[name="skin"][value="${root.dataset.skin}"]`); if (r) r.checked = true;
      // ?theme=light|dark poses a still in one look; default is the system's.
      setRadio('theme', new URLSearchParams(location.search).get('theme') || 'system', false);
      syncTheme();
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();

  // For the shell and for tests: the same verbs the clicks use.
  window.NW_RUNTIME = { setSkin, setView, setRadio, setRange, setLaneOpen, refresh, applyFilters };
})();
