#!/usr/bin/env node
// Fake-io probes for gui/assemble.mjs — the derivations that have bitten.
// Pure io injection means no scratch dirs, no live files, no daemons.
//
//   node gui/test/assemble-probes.mjs
//
// Written by: claude-fable-5, 2026-10-06
import { readFileSync } from 'node:fs';
import { assemble } from '../assemble.mjs';

const cfg = {
  timezone: 'America/Los_Angeles', defaultLane: 'fable',
  schedule: { sleep: '02:00', wake: '08:00' },
  lanes: { fable: { targetTokens: 250_000, switchboard: true } },
  paths: { events: '/ev', wakecycle: '/wc', transcripts: '/tx', armedFile: '/armed', folds: '/folds' },
};
const NOW = Date.now();
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` — ${detail}`}`);
  if (!pass) failures++;
};

// A transcript line carrying one API reply's usage.
const usageLine = (id, agoMs, ctxTokens, outTokens) => JSON.stringify({
  timestamp: iso(agoMs),
  message: { id, model: 'claude-fable-5', usage: { input_tokens: ctxTokens, output_tokens: outTokens } },
});

// ---- probes 1–4: DAEMON phase derivation (v0.9.1, first landed inline)
{
  const io = (events) => ({
    readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable' : null,
    readDir: () => [], stat: () => null, readTail: () => null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  });
  const beat = (agoMs) => JSON.stringify({ at: iso(agoMs), kind: 'daemon-alive', armed: ['fable'] });

  let s = assemble(cfg, io(beat(2 * 3600e3)), '8h');
  check('stale heartbeat → down, per-episode ackId',
    s.DAEMON.phase === 'down' && s.ALARMS[0]?.ackId.startsWith('daemon-down:2'),
    JSON.stringify([s.DAEMON.phase, s.ALARMS[0]?.ackId]));

  s = assemble(cfg, io(''), '8h');
  check('no heartbeat ever → down, honest cause',
    s.DAEMON.phase === 'down' && s.ALARMS[0]?.cause.startsWith('No nightshift heartbeat yet'),
    JSON.stringify([s.DAEMON.phase, s.ALARMS[0]?.cause]));

  s = assemble(cfg, io(beat(60e3)), '8h');
  check('fresh heartbeat → day, no alarms', s.DAEMON.phase === 'day' && s.ALARMS.length === 0,
    JSON.stringify([s.DAEMON.phase, s.ALARMS.length]));

  const failed = [beat(60e3), JSON.stringify({ at: iso(30e3), kind: 'wake-failed', lane: 'fable', alarm: true })].join('\n');
  s = assemble(cfg, io(failed), '8h');
  check('failed lane → phase alarm (derived from LANES)',
    s.DAEMON.phase === 'alarm' && s.LANES[0].state === 'failed' && s.LANES[0].alert?.kind === 'wake-failed',
    JSON.stringify([s.DAEMON.phase, s.LANES[0].state]));
}

// ---- probe 5: fork-wake stats source (10/6 phantom-833k bug).
// A --resume <tail> --fork-session wake shows the TAIL sid in ps, but the
// live session writes the REGISTRY sid's transcript. Label AND stats must
// both follow the registry sid when its pid is alive; the frozen tail's
// transcript is last night's context, which nothing writes any more.
{
  const REG = 'aaaaaaaa-1111-1111-1111-111111111111'; // live session (registry, pid alive)
  const TAIL = 'bbbbbbbb-2222-2222-2222-222222222222'; // frozen tail (ps --resume arg)
  const transcripts = {
    [`/tx/${REG}.jsonl`]: usageLine('msg_fresh', 5 * 60e3, 552_000, 900),
    [`/tx/${TAIL}.jsonl`]: usageLine('msg_stale', 14 * 3600e3, 833_000, 50_000),
  };
  const io = {
    readText: (p) => p === '/ev' ? JSON.stringify({ at: iso(60e3), kind: 'daemon-alive', armed: ['fable'] })
      : p === '/armed' ? 'fable'
        : p === `/wc/lane.${REG}` ? JSON.stringify({ lane: 'fable', pid: 100 })
          : transcripts[p] ?? null,
    readDir: (p) => p === '/wc' ? [`lane.${REG}`] : [],
    stat: (p) => transcripts[p] ? { size: transcripts[p].length, mtimeMs: NOW - 60e3 } : (p.startsWith('/wc/') ? { size: 1, mtimeMs: NOW - 3600e3 } : null),
    readTail: (p) => transcripts[p] ?? null,
    livePids: () => [100],
    psCommand: (pid) => pid === 100 ? `claude --resume ${TAIL} --fork-session` : null,
    now: () => NOW,
  };
  const s = assemble(cfg, io, '8h');
  const L = s.LANES[0];
  check('fork-wake: label follows the registry sid', L.session === REG.slice(0, 8),
    `session=${L.session}`);
  check('fork-wake: STATS follow the registry sid too (not the frozen tail)',
    L.ctx === 552_000, `ctx=${L.ctx} (833000 = reading the tail again)`);
  check('fork-wake: throughput series is the live transcript\'s',
    L.series.reduce((a, b) => a + b, 0) === 900, `series total=${L.series.reduce((a, b) => a + b, 0)}`);
}


// ---- probes: Fold now narration (Ra's refresh ruling, 10/6; claude-opus-5-5)
{
  const io = (events) => ({
    readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable' : null,
    readDir: () => [], stat: () => null, readTail: () => null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  });
  const ev = (agoMs, kind, extra = {}) => JSON.stringify({ at: iso(agoMs), kind, lane: 'fable', ...extra });
  const alive = JSON.stringify({ at: iso(30e3), kind: 'daemon-alive', armed: ['fable'] });
  const deadline = new Date(NOW + 7 * 60e3).toISOString();
  let s = assemble(cfg, io([alive, ev(180e3, 'fold-requested', { deadline })].join('\n')), '8h');
  check('fold-requested alone → pending with its deadline',
    s.LANES[0].foldRequest?.phase === 'requested' && s.LANES[0].foldRequest?.deadline === deadline, JSON.stringify(s.LANES[0].foldRequest));
  s = assemble(cfg, io([alive, ev(180e3, 'fold-requested', { deadline }), ev(60e3, 'fold-forced', { reason: 'deadline' })].join('\n')), '8h');
  check('forced, not yet woken → refreshing (forced)',
    s.LANES[0].foldRequest?.phase === 'refreshing' && s.LANES[0].foldRequest?.forced === true, JSON.stringify(s.LANES[0].foldRequest));
  // nightwatch#22: a force on a disarmed lane whose window was already closed
  // folds and reopens nothing, so the card shows no refresh.
  s = assemble(cfg, io([alive, ev(180e3, 'fold-requested', { deadline }), ev(60e3, 'fold-forced', { reason: 'deadline', refresh: false })].join('\n')), '8h');
  check('forced with refresh: false (disarmed, window gone) → no refresh shown', s.LANES[0].foldRequest === undefined, JSON.stringify(s.LANES[0].foldRequest));
  s = assemble(cfg, io([alive, ev(180e3, 'fold-requested', { deadline }), ev(90e3, 'fold-request-met'), ev(20e3, 'wake-confirmed')].join('\n')), '8h');
  check('met then woken → no narration left', s.LANES[0].foldRequest === undefined, JSON.stringify(s.LANES[0].foldRequest));
}


// ---- probe: every lane keeps its timeline row in a quiet range (10/6; claude-opus-5-5)
{
  const cfg2 = { ...cfg, lanes: { fable: { targetTokens: 250_000, switchboard: true }, opus: { targetTokens: 250_000 } } };
  const io = (events) => ({
    readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable,opus' : null,
    readDir: () => [], stat: () => null, readTail: () => null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  });
  const ev = JSON.stringify({ at: iso(30 * 60e3), kind: 'bell-rung', lane: 'opus' });
  const old = JSON.stringify({ at: iso(10 * 3600e3), kind: 'wake-confirmed', lane: 'fable' });
  const s = assemble(cfg2, io([old, ev].join('\n')), '8h');
  check('8h: a lane with no event in range still has its row', JSON.stringify(Object.keys(s.NIGHT)) === '["fable","opus"]' && s.NIGHT.fable.length === 0,
    JSON.stringify(Object.keys(s.NIGHT)));
}


// ---- probes: the throughput strip follows the selected range (10/6; claude-opus-5-5)
{
  const cfg3 = { ...cfg, lanes: { fable: { targetTokens: 250_000, switchboard: true }, opus: { targetTokens: 250_000 } } };
  const line = (id, agoMs, out) => JSON.stringify({ timestamp: iso(agoMs), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out } } });
  const files = {
    '/tx/old.jsonl': [line('r1', 20 * 3600e3, 100), line('r2', 2 * 3600e3, 10)].join('\n') + '\n',
    // a fork-session wake copies r2 into the new file; it must count once
    '/tx/new.jsonl': [line('r2', 2 * 3600e3, 10), line('r3', 30 * 60e3, 1)].join('\n') + '\n',
    '/tx/stranger.jsonl': line('x1', 30 * 60e3, 5000) + '\n',
    '/wc/lane.new': JSON.stringify({ lane: 'opus', pid: 1 }),
  };
  const io = {
    readText: (p) => p === '/ev' ? JSON.stringify({ at: iso(60e3), kind: 'folded', lane: 'opus', tail: 'old' }) : p === '/armed' ? 'fable,opus' : files[p] ?? null,
    readDir: (d) => Object.keys(files).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1)),
    stat: (p) => files[p] != null ? { size: files[p].length, mtimeMs: NOW - 60e3 } : null,
    readTail: (p, n) => files[p] != null ? files[p].slice(-n) : null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  };
  const s8 = assemble(cfg3, io, '8h'), s24 = assemble(cfg3, io, '24h');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  check('8h strip: 10-minute buckets, the copied reply counted once, strangers left out', s8.TIMELINE.bucket_min === 10 && sum(s8.ACTIVITY) === 11, JSON.stringify([s8.TIMELINE.bucket_min, sum(s8.ACTIVITY)]));
  check('24h strip: 30-minute buckets, reaches back to the 20h-old reply', s24.TIMELINE.bucket_min === 30 && sum(s24.ACTIVITY) === 111 && s24.ACTIVITY.length === 48, JSON.stringify([s24.TIMELINE.bucket_min, sum(s24.ACTIVITY)]));
}

// ---- spiralwatch canary card (Ra, 10/7): spiral-alarm events become lane
// alerts; an episode ends when the session folds/re-wakes/closes; a
// wake-failed outranks it.
{
  const ev = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
  const spiral = { at: iso(30 * 60e3), kind: 'spiral-alarm', lane: 'fable', session: 'sess-x', errors: 4, windowMin: 60, alarm: true };
  const io = (events) => ({
    readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable' : null,
    readDir: () => [], stat: () => null, readTail: () => null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  });
  const live = assemble(cfg, io(ev([spiral])), '8h');
  const L = live.LANES.find((x) => x.id === 'fable');
  check('spiral-alarm event raises the lane alert card', L?.alert?.kind === 'spiral-alarm' && /4 API errors in 60m/.test(L.alert.cause) && L.alert.at[0] === spiral.at, JSON.stringify(L?.alert ?? null));
  const endedS = assemble(cfg, io(ev([spiral, { at: iso(10 * 60e3), kind: 'folded', lane: 'fable', tail: 't' }])), '8h');
  check('a later fold ends the spiral episode (no card)', endedS.LANES.find((x) => x.id === 'fable')?.alert == null, JSON.stringify(endedS.LANES.find((x) => x.id === 'fable')?.alert ?? null));
  const both = assemble(cfg, io(ev([spiral, { at: iso(5 * 60e3), kind: 'wake-failed', lane: 'fable', cause: 'checkpoint missing', alarm: true }])), '8h');
  const Lb = both.LANES.find((x) => x.id === 'fable');
  check('wake-failed outranks the spiral card', Lb?.alert?.kind === 'wake-failed', JSON.stringify(Lb?.alert?.kind ?? null));
}

// ---- stuck-state cards (Ra, 10/8): spiralwatch's `stuck` episodes become
// lane alerts; a clear or a fold ends them; the most urgent open cause wins;
// wake failures and spirals outrank them; the log names the cause.
{
  const ev = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
  const io = (events) => ({
    readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable' : null,
    readDir: () => [], stat: () => null, readTail: () => null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  });
  const stuck = (cause, agoMin, extra = {}) => ({ at: iso(agoMin * 60e3), kind: 'stuck', cause, lane: 'fable', session: 'sess-x', alarm: true, ...extra });
  const alertOf = (rows) => assemble(cfg, io(ev(rows)), '8h').LANES.find((x) => x.id === 'fable')?.alert ?? null;
  // Every cause the watch can name draws a card here, or its alert never reaches the app.
  const watchCauses = [...readFileSync(new URL('../../machinery/watch.mjs', import.meta.url), 'utf8').match(/const STUCK = \{([\s\S]*?)\n\};/)[1].matchAll(/^ {2}'?([\w-]+)'?: \(/gm)].map((m) => m[1]);
  check('the watch names at least the causes known today', watchCauses.length >= 9, watchCauses.join());
  for (const cause of watchCauses) {
    // A cause in STUCK_ORDER with no card throws. This runs first so the failure names it, before a later probe hits the same throw.
    let drawn = null;
    try { drawn = alertOf([stuck(cause, 20, { ratio: 0.9, count: 5, forMs: 60000 })]); } catch (err) { drawn = null; }
    check(`the watch's cause ${cause} draws a card`, drawn != null, cause);
  }
  const off = alertOf([stuck('offline', 20)]);
  check('a stuck episode raises its card', off?.kind === 'stuck-offline' && off.title === "Can't reach the API" && off.at[0] === iso(20 * 60e3), JSON.stringify(off));
  const cut = alertOf([stuck('request-cut', 20)]);
  check('a cut-off request raises its own card, naming the fold', cut?.kind === 'stuck-request-cut' && cut.title === 'Requests cut off' && /Fold now/.test(cut.cause) && !/retry on their own/.test(cut.cause), JSON.stringify(cut));
  check('a cut-off request outranks offline', alertOf([stuck('offline', 30), stuck('request-cut', 20)])?.kind === 'stuck-request-cut', 'order');
  const login = alertOf([stuck('login', 20)]);
  check('a fix that happens in the window offers to open it', login?.fixes?.[0]?.[1] === 'open-terminal', JSON.stringify(login?.fixes));
  check('a clear ends the episode', alertOf([stuck('offline', 20), { at: iso(5 * 60e3), kind: 'stuck-cleared', cause: 'offline', lane: 'fable' }]) == null, 'card stayed');
  check('a fold ends every episode', alertOf([stuck('offline', 20), stuck('context', 15, { ratio: 0.9 }), { at: iso(5 * 60e3), kind: 'folded', lane: 'fable', tail: 't' }]) == null, 'card stayed');
  const urgent = alertOf([stuck('context', 30, { ratio: 0.9 }), stuck('login', 20)]);
  check('the most urgent open cause wins (login over context)', urgent?.kind === 'stuck-login', JSON.stringify(urgent?.kind));
  const cleared = alertOf([stuck('context', 30, { ratio: 0.9 }), stuck('login', 20), { at: iso(5 * 60e3), kind: 'stuck-cleared', cause: 'login', lane: 'fable' }]);
  check('clearing the urgent one shows the next (context, from an older stuck/context stream)', cleared?.kind === 'context-high' && /90%/.test(cleared.cause), JSON.stringify(cleared));
  // context-high (10/12): the warning's own kind opens and closes the same card;
  // a stalled midday cycle says so in the title.
  const hi = (agoMin, extra = {}) => ({ at: iso(agoMin * 60e3), kind: 'context-high', cause: 'context', lane: 'fable', session: 'sess-x', ratio: 0.88, alarm: false, ...extra });
  const warn = alertOf([hi(20)]);
  check('a context-high event raises the "Context high" card', warn?.kind === 'context-high' && warn.title === 'Context high', JSON.stringify(warn));
  check('its clear ends it', alertOf([hi(20), { at: iso(5 * 60e3), kind: 'context-high-cleared', cause: 'context', lane: 'fable' }]) == null, 'card stayed');
  const stalled = alertOf([hi(10, { ratio: 0.96, cycleStalled: true, alarm: true })]);
  // Its marks (Ra, 10/12): an amber context node and log row, red when stalled.
  const marks = (rows) => { const s = assemble(cfg, io(ev(rows)), '8h'); return [s.NIGHT.fable.map((n) => [n[0], n[1], n[4]]), s.LOG.flatMap(([, r]) => r).filter((r) => r[2] === 'context').map((r) => [r[3], r[4]])]; };
  check('context-high draws an amber node and log row with its percentage', JSON.stringify(marks([hi(20)])) === JSON.stringify([[['context', 'warn', 'Context high, 88%']], [['warn', 'Context high, 88%']]]), JSON.stringify(marks([hi(20)])));
  check('a stalled one draws red', JSON.stringify(marks([hi(10, { ratio: 0.96, cycleStalled: true, alarm: true })])[0]) === JSON.stringify([['context', 'failed', 'Midday fold stalled, 96%']]), JSON.stringify(marks([hi(10, { ratio: 0.96, cycleStalled: true, alarm: true })])));
  check('a stalled midday cycle titles the card so', stalled?.title === 'Midday fold stalled' && /midday cycle hasn't folded them/.test(stalled.cause), JSON.stringify(stalled));
  const spiralFirst = alertOf([stuck('offline', 20), { at: iso(10 * 60e3), kind: 'spiral-alarm', lane: 'fable', session: 'sess-x', errors: 3, windowMin: 60, alarm: true }]);
  check('a spiral outranks a stuck card', spiralFirst?.kind === 'spiral-alarm', JSON.stringify(spiralFirst?.kind));
  const tips = assemble(cfg, io(ev([stuck('offline', 20), { at: iso(5 * 60e3), kind: 'stuck-cleared', cause: 'offline', lane: 'fable' }])), '8h').LOG.flatMap(([, rows]) => rows.map((r) => JSON.stringify(r)));
  check('the log names the cause both ways', tips.some((t) => t.includes('Stuck (offline)')) && tips.some((t) => t.includes('Recovered (offline)')), JSON.stringify(tips).slice(0, 300));
}

// ---- the midnight hour reads 00, never 24 (en-US with hour12:false wrote "24:32"; Ra saw it in the log, 10/7)
{
  const io = { readText: (p) => p === '/ev' ? JSON.stringify({ at: '2026-10-07T07:32:00Z', kind: 'daemon-alive', armed: ['fable'] }) : null,
    readDir: () => [], stat: () => null, readTail: () => null, livePids: () => [], psCommand: () => null, now: () => NOW };
  const times = assemble(cfg, io, '7d').LOG.flatMap(([, rows]) => rows.map((r) => r[0]));
  check('a 00:32 event is stamped 00:32 in the log, not 24:32', times.includes('00:32') && !times.some((t) => t.startsWith('24')), JSON.stringify(times));
}

// ---- probes: liveness from the harness status files (10/8, claude-opus-5-5).
// Three real shapes: a window Ra closed (its transcript still warm) must read
// asleep at once; a /clear'd window (command line still says the old tail)
// shows the session running now; a stray non-lane claude wakes nothing.
{
  const LIVE = { ...cfg, paths: { ...cfg.paths, claudeSessions: '/cs' }, lanes: { fable: { targetTokens: 250_000, switchboard: true }, opus: { targetTokens: 250_000 } } };
  const OLD = 'cccccccc-3333-3333-3333-333333333333';   // dead wake: registered, its window now closed
  const NEW = 'dddddddd-4444-4444-4444-444444444444';   // the /clear'd session, registered by the hook
  const TAIL = 'eeeeeeee-5555-5555-5555-555555555555';  // what the window's command line still names
  const STRAY = 'ffffffff-6666-6666-6666-666666666666'; // someone's unrelated session
  const world = ({ files, dirs, pids, ps }) => ({
    readText: (p) => p === '/ev' ? JSON.stringify({ at: iso(60e3), kind: 'daemon-alive', armed: ['opus'] }) : p === '/armed' ? 'opus' : files[p] ?? null,
    readDir: (p) => dirs[p] ?? [],
    stat: (p) => files[p] != null ? { size: files[p].length, mtimeMs: NOW - 60e3 } : null, // every transcript warm: written a minute ago
    readTail: (p) => files[p] ?? null,
    livePids: () => pids, psCommand: (pid) => ps[pid] ?? null, now: () => NOW,
  });
  const lane = (s, id) => s.LANES.find((l) => l.id === id);

  // 1. Closed window: registry pid 200 is gone; its transcript was written a minute ago.
  let s = assemble(LIVE, world({
    files: { [`/wc/lane.${OLD}`]: JSON.stringify({ lane: 'opus', pid: 200 }), [`/tx/${OLD}.jsonl`]: usageLine('m1', 60e3, 100_000, 10) },
    dirs: { '/wc': [`lane.${OLD}`] }, pids: [], ps: {},
  }), '8h');
  check('liveness: a closed window is asleep at once, warm transcript or not', lane(s, 'opus')?.state !== 'awake',
    `state=${lane(s, 'opus')?.state}`);

  // 2. /clear: pid 300's command line still names TAIL; its status file names NEW.
  s = assemble(LIVE, world({
    files: {
      [`/wc/lane.${OLD}`]: JSON.stringify({ lane: 'opus', pid: 300 }), [`/wc/lane.${NEW}`]: JSON.stringify({ lane: 'opus', pid: 300 }),
      '/cs/300.json': JSON.stringify({ pid: 300, sessionId: NEW, status: 'busy' }),
      [`/tx/${NEW}.jsonl`]: usageLine('m2', 60e3, 200_000, 20),
    },
    dirs: { '/wc': [`lane.${OLD}`, `lane.${NEW}`], '/cs': ['300.json'] }, pids: [300], ps: { 300: `claude --resume ${TAIL} --fork-session` },
  }), '8h');
  check('liveness: after /clear the card shows the session running now', lane(s, 'opus')?.state === 'awake' && lane(s, 'opus')?.session === NEW.slice(0, 8),
    `state=${lane(s, 'opus')?.state} session=${lane(s, 'opus')?.session}`);

  // 3. A stray claude (status file, unknown sid, plain command line) wakes no lane.
  s = assemble(LIVE, world({
    files: { '/cs/400.json': JSON.stringify({ pid: 400, sessionId: STRAY, status: 'idle' }), [`/tx/${STRAY}.jsonl`]: usageLine('m3', 60e3, 50_000, 5) },
    dirs: { '/cs': ['400.json'] }, pids: [400], ps: { 400: 'claude' },
  }), '8h');
  check('liveness: an unrelated claude session wakes no lane (not even the switchboard)',
    s.LANES.every((l) => l.state !== 'awake'), s.LANES.map((l) => `${l.id}=${l.state}`).join(' '));
}

// ---- probes: the card's clock and next slot follow the lane's state, and a
// finished refresh leaves the card (Ra, 10/8, claude-opus-5-5).
{
  const LC = { ...cfg, paths: { ...cfg.paths, claudeSessions: '/cs' }, lanes: { fable: { targetTokens: 250_000, switchboard: true }, opus: { targetTokens: 250_000 } } };
  const SF = 'aaaa0000-0000-0000-0000-000000000001', SO = 'bbbb0000-0000-0000-0000-000000000002', SN = 'cccc0000-0000-0000-0000-000000000003';
  const world = ({ events, armed, files = {}, mt = {}, pids = [], dirs = {} }) => ({
    readText: (p) => p === '/ev' ? events.map((e) => JSON.stringify(e)).join('\n') : p === '/armed' ? armed : files[p] ?? null,
    readDir: (p) => dirs[p] ?? [], readTail: (p) => files[p] ?? null,
    stat: (p) => mt[p] != null ? { size: 1, mtimeMs: mt[p] } : files[p] != null ? { size: files[p].length, mtimeMs: NOW - 60e3 } : null,
    livePids: () => pids, psCommand: () => null, now: () => NOW,
  });
  const L = (s, id) => s.LANES.find((l) => l.id === id);
  const beat = { at: iso(60e3), kind: 'daemon-alive', armed: ['opus'] };
  // fable: woke 37h ago, folded 10h ago, closed, DISARMED. opus: awake on SO, registered 3h ago, armed.
  const base = {
    events: [beat, { at: iso(10 * 3600e3), kind: 'folded', lane: 'fable', session: SF, tail: 'x' }],
    armed: 'opus',
    files: { [`/wc/lane.${SF}`]: JSON.stringify({ lane: 'fable', pid: 1 }), [`/wc/lane.${SO}`]: JSON.stringify({ lane: 'opus', pid: 2 }),
      '/cs/2.json': JSON.stringify({ pid: 2, sessionId: SO, status: 'idle' }) },
    mt: { [`/wc/lane.${SF}`]: NOW - 37 * 3600e3, [`/wc/lane.${SO}`]: NOW - 3 * 3600e3 },
    dirs: { '/wc': [`lane.${SF}`, `lane.${SO}`], '/cs': ['2.json'] }, pids: [2],
  };
  let s = assemble(LC, world(base), '8h');
  check('clock: an asleep lane counts from its fold, not its last wake', L(s, 'fable').since[0] === iso(10 * 3600e3), L(s, 'fable').since[0]);
  check('clock: an awake lane counts from when its session started', L(s, 'opus').since[0] === new Date(NOW - 3 * 3600e3).toISOString(), L(s, 'opus').since[0]);
  check('next: a disarmed lane has nothing scheduled', JSON.stringify(L(s, 'fable').next) === JSON.stringify(['wake', '', 'none']), JSON.stringify(L(s, 'fable').next));
  check('next: an armed awake lane shows its bell', L(s, 'opus').next[0] === 'bell' && L(s, 'opus').next[1] !== '', JSON.stringify(L(s, 'opus').next));
  s = assemble(LC, world({ ...base, armed: 'fable,opus' }), '8h');
  check('next: an armed asleep lane shows its wake', L(s, 'fable').next[0] === 'wake' && L(s, 'fable').next[1] !== '', JSON.stringify(L(s, 'fable').next));

  // The 10/8 card: fold-forced, then already-awake (no wake-confirmed ever).
  const forced = [beat, { at: iso(6 * 3600e3), kind: 'fold-requested', lane: 'opus', session: SN, deadline: iso(6 * 3600e3 - 600e3) },
    { at: iso(5.8 * 3600e3), kind: 'fold-forced', lane: 'opus', session: SN }];
  s = assemble(LC, world({ ...base, events: [...forced, { at: iso(5.7 * 3600e3), kind: 'already-awake', lane: 'opus' }] }), '8h');
  check('refresh: already-awake ends "waking fresh"', !L(s, 'opus').foldRequest, JSON.stringify(L(s, 'opus').foldRequest));
  s = assemble(LC, world({ ...base, events: forced }), '8h');
  check('refresh: running a different session than the folded one ends it too', !L(s, 'opus').foldRequest, JSON.stringify(L(s, 'opus').foldRequest));
  s = assemble(LC, world({ ...base, events: forced, files: { ...base.files, '/cs/2.json': JSON.stringify({ pid: 2, sessionId: SN, status: 'idle' }), [`/wc/lane.${SN}`]: JSON.stringify({ lane: 'opus', pid: 2 }) }, dirs: { ...base.dirs, '/wc': [...base.dirs['/wc'], `lane.${SN}`] } }), '8h');
  check('refresh: still the folded session, nothing confirmed → still refreshing', L(s, 'opus').foldRequest?.phase === 'refreshing', JSON.stringify(L(s, 'opus').foldRequest));
  s = assemble(LC, world({ ...base, events: [beat, { at: iso(3600e3), kind: 'fold-requested', lane: 'opus', session: SO, deadline: iso(3000e3) }] }), '8h');
  check('request: a request 50m past its deadline with no outcome is no longer pending', !L(s, 'opus').foldRequest, JSON.stringify(L(s, 'opus').foldRequest));
}

// ---- probe: a fold that overshot its target says so in the log (fix 5, 10/9).
{
  const LC = { ...cfg, lanes: { opus: { targetTokens: 150_000 } } };
  const ev = [{ at: iso(3600e3), kind: 'folded', lane: 'opus', session: 's', tail: 't', kept: 900, total: 2000, est: 288_000, target: 150_000, overshoot: { ratio: 1.92, extendedEntries: 40 } },
    { at: iso(1800e3), kind: 'folded', lane: 'opus', session: 's2', tail: 't2', kept: 500, total: 900, est: 140_000, target: 150_000 }];
  const s = assemble(LC, { readText: (p) => p === '/ev' ? ev.map((e) => JSON.stringify(e)).join('\n') : null, readDir: () => [], readTail: () => null, stat: () => null, livePids: () => [], psCommand: () => null, now: () => NOW }, '8h');
  const tips = s.LOG.flatMap(([, rows]) => rows).filter((r) => r[2] === 'fold').map((r) => r[4]);
  check('log: an overshooting fold names its ratio', tips.some((t) => /1\.92x its target/.test(t)), JSON.stringify(tips));
  check('log: a fold within its target says nothing extra', tips.filter((t) => /its target/.test(t)).length === 1, JSON.stringify(tips));
}

// ---- probe: a wake launched beside a panel that only guesses its lane (10/16).
// nightshift emits untrusted-lane-match when a marker- or fallback-grade
// session reads as the lane and the wake launches anyway; an unlisted kind
// renders hidden, so without its row the log would never show the stray.
{
  const LC = { ...cfg, lanes: { fable: {} } };
  const ev = [{ at: iso(1800e3), kind: 'untrusted-lane-match', lane: 'fable', session: 'stray-x', grade: 'fallback' }];
  const s = assemble(LC, { readText: (p) => p === '/ev' ? ev.map((e) => JSON.stringify(e)).join('\n') : null, readDir: () => [], readTail: () => null, stat: () => null, livePids: () => [], psCommand: () => null, now: () => NOW }, '8h');
  const rows = s.LOG.flatMap(([, r]) => r).filter((r) => r[1] === 'fable');
  check('log: an untrusted lane match shows, as a launch, naming its grade',
    rows.some((r) => r[2] === 'launch' && /unregistered panel/.test(r[4]) && /by fallback/.test(r[4])), JSON.stringify(rows));
  check('log: and it is drawn amber, not routine', rows.some((r) => r[2] === 'launch' && r[3] === 'warn'), JSON.stringify(rows));
}

// ---- probe: a bell nobody tracked was listening for (10/16) shows, amber.
{
  const LC = { ...cfg, lanes: { opus: {} } };
  const ev = [{ at: iso(1800e3), kind: 'bell-unwatched', lane: 'opus', detached: 0 }];
  const s = assemble(LC, { readText: (p) => p === '/ev' ? ev.map((e) => JSON.stringify(e)).join('\n') : null, readDir: () => [], readTail: () => null, stat: () => null, livePids: () => [], psCommand: () => null, now: () => NOW }, '8h');
  const rows = s.LOG.flatMap(([, r]) => r).filter((r) => r[1] === 'opus');
  check('log: an unwatched bell shows as a bell, amber, saying why', rows.some((r) => r[2] === 'bell' && r[3] === 'warn' && /no tracked watcher/.test(r[4])), JSON.stringify(rows));
}

// ---- the fold-cycle stage on a live lane (opus, 10/9). The card's state
// comes from lifecycle events only; a fold leaves 'folding' until the close.
{
  const REG = 'cccccccc-3333-3333-3333-333333333333';
  const live = (lines) => ({
    readText: (p) => p === '/ev' ? [JSON.stringify({ at: iso(10 * 60e3), kind: 'daemon-alive', armed: ['fable'] }), ...lines.map((l) => JSON.stringify(l))].join('\n')
      : p === '/armed' ? 'fable'
        : p === `/wc/lane.${REG}` ? JSON.stringify({ lane: 'fable', pid: 300 }) : null,
    readDir: (p) => p === '/wc' ? [`lane.${REG}`] : [],
    stat: (p) => p.startsWith('/wc/') ? { size: 1, mtimeMs: NOW - 3600e3 } : null,
    readTail: () => null, livePids: () => [300], psCommand: () => null, now: () => NOW,
  });
  const bell = { at: iso(5 * 60e3), kind: 'bell-rung', lane: 'fable', session: REG };
  const stuck = { at: iso(2 * 60e3), kind: 'stuck', lane: 'fable', state: 'context', ratio: 0.86 };
  let L = assemble(cfg, live([bell, stuck]), '8h').LANES[0];
  check('stage: a stuck event after the bell keeps the lane belled', L.state === 'belled', `state=${L.state}`);
  L = assemble(cfg, live([bell, { at: iso(3 * 60e3), kind: 'folded', lane: 'fable', session: REG }, stuck]), '8h').LANES[0];
  check('stage: folded with the window still open reads folding', L.state === 'folding', `state=${L.state}`);
  L = assemble(cfg, live([bell, { at: iso(3 * 60e3), kind: 'folded', lane: 'fable', session: REG }, { at: iso(60e3), kind: 'wake-confirmed', lane: 'fable', session: REG }]), '8h').LANES[0];
  check('stage: a confirmed wake after the fold reads awake again', L.state === 'awake', `state=${L.state}`);
  // The daemon's reports don't wipe the stage they report on (10/10 receipts:
  // already-awake landed 36s after Fable's fold; stale-receipt after a bell).
  const folded = { at: iso(3 * 60e3), kind: 'folded', lane: 'fable', session: REG };
  L = assemble(cfg, live([bell, folded, { at: iso(2 * 60e3), kind: 'already-awake', lane: 'fable' }]), '8h').LANES[0];
  check('stage: already-awake after the fold keeps folding', L.state === 'folding', `state=${L.state}`);
  L = assemble(cfg, live([bell, { at: iso(2 * 60e3), kind: 'stale-receipt', lane: 'fable' }]), '8h').LANES[0];
  check('stage: stale-receipt after the bell keeps belled', L.state === 'belled', `state=${L.state}`);
  // One countdown per card, the next thing that happens (opus, 10/15): not
  // tomorrow's bell while tonight's fold or the morning wake is pending.
  const grace = cfg.schedule?.orphanGraceMs ?? 45 * 60e3;
  L = assemble(cfg, live([bell]), '8h').LANES[0];
  check('countdown: a belled lane counts to the floor (the bell plus the orphan grace)',
    L.next?.[0] === 'fold' && Date.parse(L.next[1]) === Date.parse(bell.at) + grace, `next=${JSON.stringify(L.next)}`);
  L = assemble(cfg, live([bell, folded]), '8h').LANES[0];
  check('countdown: folded with the window open counts to the wake, not the next bell', L.next?.[0] === 'wake', `next=${JSON.stringify(L.next)}`);
  L = assemble(cfg, live([{ at: iso(grace + 60e3), kind: 'bell-rung', lane: 'fable', session: REG }]), '8h').LANES[0];
  check('countdown: past the floor it reads now', L.next?.[0] === 'fold' && L.next[2] === 'now', `next=${JSON.stringify(L.next)}`);
  L = assemble(cfg, live([{ at: iso(6 * 60e3), kind: 'fold-requested', lane: 'fable', session: REG, tier: 'soft', deadline: null }, bell]), '8h').LANES[0];
  check('countdown: a midday bell keeps the bell slot (its own line narrates the fold)', L.next?.[0] === 'bell', `next=${JSON.stringify(L.next)} fr=${JSON.stringify(L.foldRequest)}`);
  L = assemble(cfg, live([]), '8h').LANES[0];
  check('countdown: an awake lane still counts to the bell', L.state === 'awake' && L.next?.[0] === 'bell', `state=${L.state} next=${JSON.stringify(L.next)}`);
  // Closed: already-awake still counts, so a hand-rescued lane that later
  // closes reads sleeping, not failed.
  const dead = (lines) => ({ ...live(lines), livePids: () => [] });
  L = assemble(cfg, dead([{ at: iso(4 * 60e3), kind: 'wake-failed', lane: 'fable' }, { at: iso(2 * 60e3), kind: 'already-awake', lane: 'fable' }]), '8h').LANES[0];
  check('stage: a closed lane whose failed wake was rescued is not failed', L.state !== 'failed', `state=${L.state}`);
}

// ---- trim-failed (10/21): sleep.mjs's refused trim (the output check) is drawn on the lane's night
// as a red mark whose tip carries the cause. The red card for it is the block after this one.
{
  const events = [
    JSON.stringify({ at: iso(60e3), kind: 'daemon-alive', armed: ['fable'] }),
    JSON.stringify({ at: iso(30e3), kind: 'trim-failed', lane: 'fable', alarm: true, cause: 'trim: OUTPUT CHECK FAILED, nothing written. 1 kept entries point at a parent that is not in the tail' }),
  ].join('\n');
  const io = { readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable' : null, readDir: () => [], stat: () => null, readTail: () => null, livePids: () => [], psCommand: () => null, now: () => NOW };
  const node = assemble(cfg, io, '8h').NIGHT.fable?.find((n) => /Fold skipped/.test(n[4]));
  check('trim-failed draws a failed mark on the lane night, with its cause in the tip',
    node?.[0] === 'wake-failed' && node?.[1] === 'failed' && /not in the tail/.test(node?.[4] ?? ''), JSON.stringify(node ?? null));
}

// ---- a fold that didn't happen (10/21, the banner after #30): a refused trim (trim-failed) or a
// failed emergency fold (orphan-fold-failed) is a red card on its lane and puts the head in alarm;
// a later fold, a successful orphan fold or a wake ends it; the lane keeps its stage.
{
  const ev = (rows) => [JSON.stringify({ at: iso(60e3), kind: 'daemon-alive', armed: ['fable'] }), ...rows.map((r) => JSON.stringify(r))].join('\n');
  const io = (events) => ({
    readText: (p) => p === '/ev' ? events : p === '/armed' ? 'fable' : null,
    readDir: () => [], stat: () => null, readTail: () => null, livePids: () => [], psCommand: () => null, now: () => NOW,
  });
  const refused = { at: iso(40 * 60e3), kind: 'trim-failed', lane: 'fable', session: 's-1', alarm: true, cause: 'trim: OUTPUT CHECK FAILED, nothing written. 1 kept entries point at a parent that is not in the tail: a resume would load only the turns after the gap' };
  let s = assemble(cfg, io(ev([refused])), '8h');
  let L = s.LANES.find((x) => x.id === 'fable');
  check('a refused trim raises the lane\'s red card, its reason without the trimmer\'s prefix',
    L?.alert?.kind === 'trim-failed' && L.alert.title === 'Fold refused' && /not in the tail/.test(L.alert.cause) && !/OUTPUT CHECK FAILED/.test(L.alert.cause) && !L.alert.level && L.alert.at[0] === refused.at,
    JSON.stringify(L?.alert ?? null));
  check('a refused trim puts the head in alarm', s.DAEMON.phase === 'alarm', `phase=${s.DAEMON.phase}`);
  for (const [kind, extra] of [['folded', { tail: 't' }], ['orphan-fold-done', {}], ['fold-forced', {}], ['wake-confirmed', {}]]) {
    s = assemble(cfg, io(ev([refused, { at: iso(20 * 60e3), kind, lane: 'fable', ...extra }])), '8h');
    L = s.LANES.find((x) => x.id === 'fable');
    // A successful orphan fold leaves the lane orphaned, which is an alarm of its own (an unauthored fold).
    const phaseOk = kind === 'orphan-fold-done' ? L?.state === 'orphaned' : s.DAEMON.phase !== 'alarm';
    check(`a later ${kind} ends the refused-fold card${kind === 'orphan-fold-done' ? ' (the lane reads orphaned)' : ' and the alarm'}`, L?.alert == null && phaseOk, JSON.stringify([L?.alert ?? null, L?.state, s.DAEMON.phase]));
  }
  s = assemble(cfg, io(ev([{ at: iso(25 * 3600e3), kind: 'trim-failed', lane: 'fable', alarm: true, cause: 'x' }])), '8h');
  check('a refusal more than a day old no longer shows (the next bell raises it again)', s.LANES.find((x) => x.id === 'fable')?.alert == null, JSON.stringify(s.LANES[0]?.alert ?? null));
  const orphan = { at: iso(10 * 60e3), kind: 'orphan-fold-failed', lane: 'fable', exit: 1, alarm: true };
  L = assemble(cfg, io(ev([refused, orphan])), '8h').LANES.find((x) => x.id === 'fable');
  check('a refused trim then its failed orphan fold make one card, the newest',
    L?.alert?.kind === 'orphan-fold-failed' && L.alert.title === 'Emergency fold failed' && /exited 1/.test(L.alert.cause), JSON.stringify(L?.alert ?? null));
  L = assemble(cfg, io(ev([refused, { at: iso(5 * 60e3), kind: 'wake-failed', lane: 'fable', cause: 'checkpoint missing', alarm: true }])), '8h').LANES.find((x) => x.id === 'fable');
  check('wake-failed outranks the refused-fold card', L?.alert?.kind === 'wake-failed', JSON.stringify(L?.alert?.kind ?? null));
  // On a live lane the refusal comes after the bell: the card keeps the belled stage, with the red card on it.
  const REG = 'dddddddd-4444-4444-4444-444444444444';
  const live = (lines) => ({
    readText: (p) => p === '/ev' ? ev(lines) : p === '/armed' ? 'fable' : p === `/wc/lane.${REG}` ? JSON.stringify({ lane: 'fable', pid: 300 }) : null,
    readDir: (p) => p === '/wc' ? [`lane.${REG}`] : [],
    stat: (p) => p.startsWith('/wc/') ? { size: 1, mtimeMs: NOW - 3600e3 } : null,
    readTail: () => null, livePids: () => [300], psCommand: () => null, now: () => NOW,
  });
  L = assemble({ ...cfg, paths: { ...cfg.paths, wakecycle: '/wc' } }, live([{ at: iso(5 * 60e3), kind: 'bell-rung', lane: 'fable', session: REG }, { ...refused, at: iso(2 * 60e3), session: REG }]), '8h').LANES.find((x) => x.id === 'fable');
  check('a refused fold leaves a live lane belled, with the red card', L?.state === 'belled' && L?.alert?.kind === 'trim-failed', JSON.stringify([L?.state, L?.alert?.kind ?? null]));
}


// ---- probe: a lane's configured display name reaches its card (11/13)
{
  const io = {
    readText: (p) => p === '/armed' ? 'fable' : null,
    readDir: () => [], stat: () => null, readTail: () => null,
    livePids: () => [], psCommand: () => null, now: () => NOW,
  };
  const named = { ...cfg, lanes: { fable: { targetTokens: 250_000, switchboard: true, given: 'Heron' } } };
  const blank = { ...cfg, lanes: { fable: { targetTokens: 250_000, switchboard: true, given: '  ' } } };
  const withGiven = assemble(named, io, '8h').LANES.find((x) => x.id === 'fable');
  const without = assemble(cfg, io, '8h').LANES.find((x) => x.id === 'fable');
  const blanked = assemble(blank, io, '8h').LANES.find((x) => x.id === 'fable');
  check('lanes.<id>.given reaches the card; absence and a blank string leave none, and name stays untouched',
    withGiven?.given === 'Heron' && withGiven?.name === undefined && without?.given === undefined && blanked?.given === undefined,
    JSON.stringify([withGiven?.given ?? null, withGiven?.name ?? null, without?.given ?? null, blanked?.given ?? null]));
}

console.log(failures === 0 ? 'PROBES CLEAN' : `PROBES: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
