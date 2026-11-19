// The frozen fixture snapshot — build_fixture.py's module data as one
// importable object, so the frozen fixture.html and the stills keep
// building from node once the python retires, and mergeSnapshot() has a
// base for partial live snapshots. Pure data; no node imports.
//
// Snapshot: Mon 2026-10-05 13:10 PT. fable and opus are REAL (their
// throughput series are real 10-minute output-token buckets from their
// transcripts). scout and scribe are ILLUSTRATIVE lanes, there to show
// Ra's scenario: four agents, one in trouble, the trouble on its own card.
//
// Written by: claude-fable-5, 2026-10-06 (data lifted verbatim from
// build_fixture.py, claude-opus-5-5's frozen snapshot of 2026-10-05).

export const FIXTURE = {
  NOW: '2026-10-05T13:10-07:00',
  TZ: 'America/Los_Angeles',
  TIMELINE: {
    range: '8h', from: '2026-10-05T01:30-07:00', to: '2026-10-05T09:30-07:00', label: 'Oct 5, 01:30 – 09:30',
    ticks: [[.0625, '02'], [.3125, '04'], [.5625, '06'], [.8125, '08']], sleep: [.0625, .8125],
  },
  DECK: { next_at: '2026-10-06T02:00-07:00', countdown: '12h 50m' },
  // v0.9.1 defaults, chosen to reproduce the pre-v0.9.1 frozen bytes.
  SCHEDULE: { sleep: '02:00', wake: '08:00' },
  DAEMON: { phase: 'day', lastAlive: null, lastAliveHm: '12:41', down: false },
  ALARMS: [],
  // Per-lane targets mirror weft.config.json (lanes.<name>.targetTokens).
  LANES: [
    { id: 'fable', activity: 'working', model: 'Fable 5', modelId: 'claude-fable-5', role: 'switchboard', state: 'awake',
      persona: { id: 'weft', name: 'Weft', usage: { provider: 'anthropic', at: '2026-10-05T20:08:00.000Z', stale: false, model: 'claude-fable-5', windows: [{ key: 'five_hour', pct: 42, resetsAt: '2026-10-05T22:30:00.000Z', expired: false }, { key: 'seven_day', pct: 63, resetsAt: '2026-10-09T16:00:00.000Z', expired: false }] } }, runtime: 'claude-code', schedule: { inherit: true, sleep: '02:00', wake: '08:00' },
      session: '94914e2c', since: ['2026-10-05T09:02-07:00', '09:02'], next: ['bell', '2026-10-06T02:00-07:00', '12h 50m'],
      ctx: 212_000, target: 250_000, open: true,
      series: [0, 0, 0, 0, 0, 0, 0, 49903, 18641, 41302, 5642, 30905, 58099, 5053, 40245, 39060, 39117, 1666, 5902, 64976, 5082, 29230, 25912, 4840] },
    { id: 'opus', activity: 'idle', model: 'Opus 5.5', modelId: 'claude-opus-5-5', role: 'music videos', state: 'awake',
      persona: { id: 'weft', name: 'Weft' }, runtime: 'claude-code', schedule: { inherit: true, sleep: '02:00', wake: '08:00' },
      foldRequest: { phase: 'requested', deadline: '2026-10-05T13:17-07:00' },
      session: 'db3eedeb', since: ['2026-10-05T12:29-07:00', '12:29, emergency wake'], next: ['bell', '2026-10-06T02:00-07:00', '12h 50m'],
      ctx: 118_000, target: 250_000,
      series: [0, 0, 0, 0, 0, 0, 0, 5381, 0, 0, 0, 0, 41769, 1130, 0, 0, 64965, 25789, 0, 648, 140495, 2520, 0, 6072] },
    { id: 'scout', model: 'Haiku 4.5', modelId: 'claude-haiku-4-5', role: 'inbox triage', state: 'sleeping',
      persona: { id: 'lark', name: 'Lark' }, runtime: 'claude-code', schedule: { inherit: false, sleep: '12:00', wake: '18:00' },
      session: '—', since: ['2026-10-05T12:00-07:00', '12:00, folded'], next: ['wake', '2026-10-05T18:00-07:00', '4h 50m'],
      ctx: 0, target: 120_000, series: Array(24).fill(0), armed: false },
    { id: 'scribe', model: 'Sonnet 5.5', modelId: 'claude-sonnet-5-5', role: 'docs', state: 'failed',
      persona: { id: 'weft', name: 'Weft' }, runtime: 'claude-code', schedule: { inherit: true, sleep: '02:00', wake: '08:00' },
      session: '—', since: ['2026-10-05T08:16-07:00', '08:16'], next: null,
      ctx: 0, target: 200_000, series: Array(24).fill(0), open: true,
      alert: { kind: 'wake-failed', at: ['2026-10-05T08:16-07:00', '08:16'],
        title: 'Morning wake failed',
        cause: 'Checkpoint missing at ~/origin/weft/checkpoint.md. 3 launches, no session registered.',
        fixes: [['restore', 'restore-checkpoint', 'Restore checkpoint', 'Put back the newest archived checkpoint (ladder/checkpoints/2026-10-05-0201.md)'],
          ['retry', 'retry-wake', 'Retry wake', 'Launch the agent again now'],
          ['log', 'show-log', 'Show log', 'Open the nightshift log at this failure']] } },
  ],
  // NightStrip: repeated nodes are GROUPED: three failed launches are one
  // fact with data-count="3".
  NIGHT: {
    fable: [['bell', 'ok', .064, '02:00', 'Bell rung (spool note)', 1], ['fold', 'ok', .066, '02:01', 'Folded, 389/437 kept', 1],
      ['close', 'ok', .080, '02:08', 'Panel closed, slept and quiet', 1],
      ['launch', 'failed', .813, '08:00', '3 launches 08:00–08:11, none registered', 3],
      ['wake-failed', 'failed', .846, '08:16', 'Wake failed: checkpoint missing', 1],
      ['wake', 'manual', .942, '09:02', 'Woken by hand', 1]],
    opus: [['bell', 'ok', .064, '02:00', 'Bell relayed by fable', 1], ['fold', 'ok', .066, '02:01', 'Folded, 404/556 kept', 1],
      ['close', 'ok', .080, '02:08', 'Panel closed, slept and quiet', 1],
      ['launch', 'failed', .813, '08:00', '3 launches 08:00–08:11, none registered', 3],
      ['wake-failed', 'failed', .846, '08:16', 'Wake failed: checkpoint missing', 1],
      ['wake', 'manual', .978, '09:19', 'Woken by hand', 1]],
  },
  // Activity across the timeline's interval: every lane's output tokens per
  // 10-minute bucket, summed, on the same --t axis as the strips.
  ACTIVITY: [21000, 34000, 12000, 8000, 3000, ...Array(38).fill(0), 18000, 41000, 26000, 37000, 22000],
  LOG: [
    ['Oct 5', [
      ['12:29', 'opus', 'fold', 'ok', 'Emergency fold', { reason: 'emergency', kept: [759, 1051], est: 685_808, target: 250_000, tail: '056b5609' }, 1],
      ['12:29', 'opus', 'wake', 'ok', 'Emergency wake', null, 1],
      ['12:00', 'nightshift', 'heartbeat', 'ok', 'Nightshift alive', null, 1],
      ['11:00', 'nightshift', 'heartbeat', 'ok', 'Nightshift alive', null, 1],
      ['09:19', 'opus', 'wake', 'manual', 'Woken by hand', null, 1],
      ['09:02', 'fable', 'wake', 'manual', 'Woken by hand', null, 1],
      ['08:16', 'scribe', 'wake-failed', 'failed', 'Wake failed: checkpoint missing', null, 1],
      ['08:16', 'opus', 'wake-failed', 'failed', 'Wake failed: checkpoint missing', null, 1],
      ['08:16', 'fable', 'wake-failed', 'failed', 'Wake failed: checkpoint missing', null, 1],
      ['08:00', 'opus', 'launch', 'failed', 'Launched 08:00–08:11, none registered', null, 3],
      ['08:00', 'fable', 'launch', 'failed', 'Launched 08:00–08:11, none registered', null, 3],
      ['02:08', 'opus', 'close', 'ok', 'Panel closed, slept and quiet', null, 1],
      ['02:08', 'fable', 'close', 'ok', 'Panel closed, slept and quiet', null, 1],
      ['02:01', 'opus', 'fold', 'ok', 'Folded', { reason: 'sleep', kept: [404, 556], est: 1_292_655, target: 250_000, tail: 'fe60cd9d' }, 1],
      ['02:01', 'fable', 'fold', 'ok', 'Folded', { reason: 'sleep', kept: [389, 437], est: 256_935, target: 250_000, tail: '81033de6' }, 1],
      ['02:00', 'opus', 'bell', 'ok', 'Bell (relayed by fable)', null, 1],
      ['02:00', 'fable', 'bell', 'ok', 'Bell rung', null, 1],
    ]],
    ['Oct 4', [
      ['02:02', 'fable', 'fold', 'ok', 'Folded', { reason: 'sleep', kept: [169, 2191], est: 286_929, target: 250_000, tail: '3f85b6bb' }, 1],
    ]],
  ],
  // Installed skins in SKIN_ORDER, titled from their manifests (what the
  // python reads from disk; the harness cross-checks this stays true).
  SKINS: [['minimal', 'Minimal'], ['glass', 'Glass'], ['amber', 'Amber'], ['metal', 'Brushed Metal'],
    ['wacky', 'Moonlamp'], ['steampunk', 'Brassworks'], ['concrete', 'Concrete']],
};
