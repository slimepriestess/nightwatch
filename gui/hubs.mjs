// The multiplexer: one page for every persona on the machine.
//
// assemble(cfg, io, range) stays single-hub and pure (its probes and the
// parity cases live there). This file sits above it: it reads the machine's
// hub registry, and merges one snapshot per hub into the snapshot the
// emitter renders. Pure, like assemble: the server (and the app) do the io.
//
// Registry (machine-wide; Fable's machinery writes it, the app only reads):
//   registryFile() in machinery/platform.mjs, the one place that names it:
//   ~/Library/Application Support/Nightwatch/hubs.json on macOS,
//   $XDG_CONFIG_HOME/nightwatch/hubs.json (or ~/.config/…) elsewhere
//   {"version": 1, "hubs": [{"path": "/Users/…/origin/weft"}, {"path": "/Users/…/Nightwatch/lark"}]}
//
// Lane keys. A lane is (hub, lane). With one hub its id is the lane's own
// name, unchanged, so a single-persona install and every fixture
// look exactly as before. With several, every new persona's first lane is
// "main", so ids are qualified as "<persona>/<lane>" (unique in the page),
// the bare name rides along as `name` (cards show it), and `label` names
// the persona too ("Lark · main") for the places that list every lane at
// once: the timeline rows, the log, the settings table.
//
// Written by: claude-opus-5-5, 2026-10-07

import { registryFile } from '../machinery/platform.mjs';

/** The registry the viewer reads: NIGHTWATCH_REGISTRY when a bench sets it,
 *  else the platform's one registry file. It was a macOS path for every
 *  platform, so a Linux viewer never saw a registered hub (issue #6). */
export function viewerRegistryFile(env = process.env, kind) {
  return env.NIGHTWATCH_REGISTRY ?? registryFile(kind);
}

/** The registry's hub roots, in order; [] for a missing or unreadable file. */
export function readRegistry(text) {
  try {
    const j = JSON.parse(text);
    return (Array.isArray(j?.hubs) ? j.hubs : []).map((h) => h?.path).filter((p) => typeof p === 'string' && p.startsWith('/'));
  } catch { return []; }
}

/** A hub's config file: the name Set up writes, else our legacy hub's. */
export function configFileFor(root, exists) {
  const r = root.replace(/\/+$/, '');
  return exists(`${r}/nightwatch.config.json`) ? `${r}/nightwatch.config.json` : `${r}/weft.config.json`;
}

const PHASE_RANK = { down: 4, alarm: 3, belled: 2, night: 1, day: 0 };

/**
 * parts: [{ root, snap }] in registry order (the first is the primary hub: its
 * clock, schedule and range axis lead the page). Returns one snapshot.
 */
export function mergeSnapshots(parts) {
  if (!parts.length) throw new Error('no hubs to show');
  // Persona ids unique across hubs (two hubs could share a folder name).
  const seen = new Map();
  const tagged = parts.map(({ root, snap }) => {
    // Each persona carries their own schedule and nightshift status: their settings
    // panel shows them (the head shows the primary hub's schedule, the worst status).
    const p = { ...snap.PERSONAS[0], hub: root, schedule: snap.SCHEDULE, daemon: snap.DAEMON };
    const n = (seen.get(p.id) ?? 0) + 1; seen.set(p.id, n);
    if (n > 1) p.id = `${p.id}-${n}`;
    return { root, snap, persona: p };
  });
  if (tagged.length === 1) {
    const { snap, persona } = tagged[0];
    return { ...snap, PERSONAS: [persona], LANES: snap.LANES.map((L) => ({ ...L, persona: { ...L.persona, ...persona } })) };
  }

  const first = tagged[0].snap;
  const key = (persona, lane) => `${persona.id}/${lane}`;
  const LANES = [], NIGHT = {}, logDays = new Map(), ALARMS = [];
  let ACTIVITY = null, DAEMON = null;
  for (const { snap, persona } of tagged) {
    for (const L of snap.LANES) {
      LANES.push({ ...L, id: key(persona, L.id), name: L.id, label: `${persona.name} · ${L.given ?? L.id}`, persona: { ...L.persona, ...persona } });
    }
    for (const [lane, nodes] of Object.entries(snap.NIGHT)) NIGHT[key(persona, lane)] = nodes;
    for (const [day, rows] of snap.LOG) {
      if (!logDays.has(day)) logDays.set(day, []);
      // nightshift rows (no lane) stay attributed to their persona's nightshift
      logDays.get(day).push(...rows.map((r) => [r[0], key(persona, r[1]), ...r.slice(2)]));
    }
    ACTIVITY = ACTIVITY ? ACTIVITY.map((v, i) => v + (snap.ACTIVITY[i] ?? 0)) : [...snap.ACTIVITY];
    if (!DAEMON || PHASE_RANK[snap.DAEMON.phase] > PHASE_RANK[DAEMON.phase]) DAEMON = snap.DAEMON;
    for (const a of snap.ALARMS) ALARMS.push({ ...a, title: `${persona.name}: ${a.title}`, ackId: `${persona.id}:${a.ackId}` });
  }
  // Days newest first (as assemble emits them), rows newest first within a day.
  const year = new Date(first.NOW).getFullYear();
  const LOG = [...logDays.entries()]
    .sort(([a], [b]) => Date.parse(`${b} ${year}`) - Date.parse(`${a} ${year}`))
    .map(([day, rows]) => [day, rows.sort((x, y) => (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : 0))]);
  return {
    ...first,
    PERSONAS: tagged.map((t) => t.persona),
    LANES, NIGHT, LOG, ACTIVITY, DAEMON, ALARMS,
  };
}
