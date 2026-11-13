#!/usr/bin/env node
// Probes for gui/hubs.mjs, the multiplexer: one page for every persona.
// Pure: snapshots in, a snapshot (and its rendered page) out.
//
//   node gui/test/hubs-probes.mjs
//
// Written by: claude-opus-5-5, 2026-10-07
import { readRegistry, configFileFor, mergeSnapshots, viewerRegistryFile } from '../hubs.mjs';
import { renderPage, mergeSnapshot } from '../emitter.mjs';
import { FIXTURE } from '../fixture-data.mjs';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` — ${detail}`}`);
  if (!pass) failures++;
};
const J = JSON.stringify;

// A small snapshot for one hub: one persona, their lanes, a night, a log.
function snap({ persona, lanes, phase = 'day', activity = [1, 2, 3], alarms = [], log }) {
  const P = { id: persona.toLowerCase(), name: persona };
  return {
    NOW: '2026-10-07T23:00:00Z', TZ: 'America/Los_Angeles',
    PERSONAS: [P],
    LANES: lanes.map((id) => ({ ...FIXTURE.LANES[0], id, persona: P, state: 'awake' })),
    NIGHT: Object.fromEntries(lanes.map((id) => [id, [['fold', 'ok', 0.5, '02:01', 'Folded', 1]]])),
    LOG: log ?? [['Oct 7', [['14:00', lanes[0], 'fold', 'ok', 'Folded', null, 1]]]],
    ACTIVITY: activity, TIMELINE: FIXTURE.TIMELINE, DECK: FIXTURE.DECK, SCHEDULE: { sleep: '02:00', wake: '08:00' },
    DAEMON: { phase, lastAlive: null, lastAliveHm: null, down: phase === 'down' }, ALARMS: alarms,
  };
}

// ---- the registry reader: hub paths in order; anything malformed reads as no hubs
check('registry: hub paths in order', J(readRegistry('{"version":1,"hubs":[{"path":"/a"},{"path":"/b"}]}')) === J(['/a', '/b']), '');
check('registry: junk, a missing file, relative paths read as nothing', J([readRegistry('nope'), readRegistry(''), readRegistry('{"hubs":[{"path":"rel"}]}')]) === J([[], [], []]), '');
{
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/x';
  try {
    check('registry: the viewer reads the platform\'s registry, not a macOS path everywhere (issue #6)',
      viewerRegistryFile({}, 'linux') === '/x/nightwatch/hubs.json', viewerRegistryFile({}, 'linux'));
  } finally { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; }
}
check('registry: NIGHTWATCH_REGISTRY still overrides it for benches', viewerRegistryFile({ NIGHTWATCH_REGISTRY: '/bench/hubs.json' }, 'linux') === '/bench/hubs.json', '');
check("config file: Set up's name first, else our legacy hub's",
  J([configFileFor('/h/', (p) => p === '/h/nightwatch.config.json'), configFileFor('/h', () => false)]) === J(['/h/nightwatch.config.json', '/h/weft.config.json']), '');

// ---- one hub: nothing changes but the persona learning their hub (a single-persona install, every fixture)
{
  const one = snap({ persona: 'Weft', lanes: ['fable', 'opus'] });
  const m = mergeSnapshots([{ root: '/hub/weft', snap: one }]);
  check('one hub: lane ids, NIGHT and LOG unchanged', J([m.LANES.map((L) => L.id), Object.keys(m.NIGHT), m.LOG]) === J([['fable', 'opus'], ['fable', 'opus'], one.LOG]), J(m.LANES.map((L) => L.id)));
  check('one hub: the persona (and their lanes) carry the hub', m.PERSONAS[0].hub === '/hub/weft' && m.LANES.every((L) => L.persona.hub === '/hub/weft'), J(m.PERSONAS));
  check('one hub: no names or labels added', m.LANES.every((L) => L.name === undefined && L.label === undefined), '');
}

// ---- two hubs, both with a lane called "main": the case the multiplexer exists for
{
  const a = snap({ persona: 'Lark', lanes: ['main'], phase: 'night', activity: [1, 1, 1], log: [['Oct 7', [['09:00', 'main', 'fold', 'ok', 'Folded', null, 1]]], ['Oct 6', [['23:00', 'nightshift', 'heartbeat', 'ok', 'alive', null, 1]]]] });
  const b = snap({ persona: 'Wren', lanes: ['main'], phase: 'down', activity: [2, 0, 5], alarms: [{ kind: 'daemon-down', title: "The nightshift isn't running", cause: 'No heartbeat yet.', at: ['2026-10-07T23:00:00Z', '16:00'], ackId: 'daemon-down:never', fixes: [] }],
    log: [['Oct 7', [['13:30', 'main', 'fold', 'ok', 'Folded', null, 1]]]] });
  const m = mergeSnapshots([{ root: '/hub/lark', snap: a }, { root: '/hub/wren', snap: b }]);
  check('two "main" lanes stay two lanes', J(m.LANES.map((L) => L.id)) === J(['lark/main', 'wren/main']), J(m.LANES.map((L) => L.id)));
  check('each keeps its bare name and gains a labelled one', J(m.LANES.map((L) => [L.name, L.label])) === J([['main', 'Lark · main'], ['main', 'Wren · main']]), '');
  check('NIGHT is keyed by the qualified ids', J(Object.keys(m.NIGHT)) === J(['lark/main', 'wren/main']), J(Object.keys(m.NIGHT)));
  check("the logs merge: days newest first, rows newest first, each row's lane qualified",
    J(m.LOG.map(([d, rows]) => [d, rows.map((r) => [r[0], r[1]])])) === J([['Oct 7', [['13:30', 'wren/main'], ['09:00', 'lark/main']]], ['Oct 6', [['23:00', 'lark/nightshift']]]]), J(m.LOG));
  check('throughput adds up across hubs', J(m.ACTIVITY) === J([3, 1, 6]), J(m.ACTIVITY));
  check('the head shows the worst nightshift (down beats night)', m.DAEMON.phase === 'down', m.DAEMON.phase);
  check("an app alarm names its persona, and its ack id is the persona's own", m.ALARMS.length === 1 && m.ALARMS[0].title === "Wren: The nightshift isn't running" && m.ALARMS[0].ackId === 'wren:daemon-down:never', J(m.ALARMS));

  // ...and the page: two persona sections with their hubs, cards named "main", timeline rows labelled
  const html = renderPage(mergeSnapshot(FIXTURE, m));
  const sections = [...html.matchAll(/class="nw-persona" data-persona="([^"]+)" data-hub="([^"]+)"/g)].map((x) => [x[1], x[2]]);
  check('page: one section per persona, each naming its hub', J(sections) === J([['lark', '/hub/lark'], ['wren', '/hub/wren']]), J(sections));
  const cards = [...html.matchAll(/<article class="nw-lane" data-lane="([^"]+)" data-name="([^"]+)"[^>]*>[\s\S]*?<h2 data-part="name">([^<]+)<\/h2>/g)].map((x) => [x[1], x[2], x[3]]).filter(([id]) => id.includes('/')); // (the fixture's gallery samples aren't lanes)
  check('page: the cards are keyed apart but both read "main"', J(cards) === J([['lark/main', 'main', 'main'], ['wren/main', 'main', 'main']]), J(cards));
  const strips = [...html.matchAll(/class="nw-strip" data-lane="([^"]+)" data-label="([^"]+)"/g)].map((x) => x[2]);
  check('page: timeline rows say whose lane they are', J(strips) === J(['Lark · main', 'Wren · main']), J(strips));
  const b2 = { ...b, SCHEDULE: { sleep: '03:30', wake: '09:15' } };
  const html2 = renderPage(mergeSnapshot(FIXTURE, mergeSnapshots([{ root: '/hub/lark', snap: a }, { root: '/hub/wren', snap: b2 }])));
  const panels = [...html2.matchAll(/<section class="nw-settings" data-persona="([^"]+)" data-hub="([^"]+)"[\s\S]*?Sleep <input type="time" value="([^"]+)"/g)].map((x) => [x[1], x[2], x[3]]);
  check('page: one settings panel per persona, with its hub and its own schedule', J(panels) === J([['lark', '/hub/lark', '02:00'], ['wren', '/hub/wren', '03:30']]), J(panels));
  const logLanes = [...html.matchAll(/<span data-part="lane">([^<]+)<\/span>/g)].map((x) => x[1]);
  check('page: log rows say whose lane they are, nightshift included', ['Wren · main', 'Lark · main', 'Lark · nightshift'].every((l) => logLanes.includes(l)), J(logLanes));
}

// ---- two hubs with the same folder name: persona ids stay unique
{
  const m = mergeSnapshots([{ root: '/a/weft', snap: snap({ persona: 'Weft', lanes: ['fable'] }) }, { root: '/b/weft', snap: snap({ persona: 'Weft', lanes: ['fable'] }) }]);
  check('same-named personas get distinct ids (and so distinct lane keys)', J([m.PERSONAS.map((p) => p.id), m.LANES.map((L) => L.id)]) === J([['weft', 'weft-2'], ['weft/fable', 'weft-2/fable']]), J(m.LANES.map((L) => L.id)));
}


// ---- probe: a given name is display-only — it never enters the routing ref
// (11/13, the #75 second read's blocker: runtime.js laneRef sends
// data-name ?? data-lane to the host, so a given name in data-name would
// make every card button target a lane the host refuses).
{
  const given = structuredClone(FIXTURE);
  given.LANES[0] = { ...given.LANES[0], given: 'Heron' };
  const html = renderPage(given);
  check('given: the heading and avatar initial show it',
    html.includes('<h2 data-part="name">Heron</h2>') && /data-part="avatar"[^>]*>H</.test(html),
    html.match(/<h2 data-part="name">[^<]*/g)?.join() ?? 'no heading');
  check('given: the routing ref never carries it (no data-name, data-lane stays the key)',
    !html.includes('data-name="Heron"') && html.includes('data-lane="fable"'),
    html.match(/data-name="[^"]*"/g)?.join() ?? 'no data-name (good)');
  check('given: the strip label reads it',
    html.includes('data-label="Heron"'),
    html.match(/data-label="[^"]*"/g)?.join() ?? 'no strips');
  const a = snap({ persona: 'Lark', lanes: ['fable'] });
  a.LANES[0] = { ...a.LANES[0], given: 'Heron' };
  const b = snap({ persona: 'Wren', lanes: ['fable'] });
  const m = mergeSnapshots([{ root: '/hub/lark', snap: a }, { root: '/hub/wren', snap: b }]);
  check('given: a multi-hub merge keeps name = the bare key for routing, and the label carries the given name',
    m.LANES.map((L) => L.name).every((n) => n === 'fable')
      && m.LANES.find((L) => L.id === 'lark/fable')?.label === 'Lark \u00b7 Heron'
      && m.LANES.find((L) => L.id === 'wren/fable')?.label === 'Wren \u00b7 fable',
    JSON.stringify(m.LANES.map((L) => [L.id, L.name, L.label])));
}

console.log(failures === 0 ? 'HUBS PROBES CLEAN' : `HUBS PROBES: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
