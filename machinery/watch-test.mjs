#!/usr/bin/env node
// The stuck/spiral watch, end to end: watch.mjs --once against a scratch hub
// (its own config, transcripts, session status files, registry, events,
// state), banners off, notify.command pointed at a recorder script. Nothing
// real is read or written. Run: node machinery/watch-test.mjs
//
// Written by: claude-opus-5-5, 2026-10-09 (cases from weft's stuck-test.mjs, 10/8)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, chmodSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'watch-test-'));
const dirs = { projects: join(root, 'projects'), sessions: join(root, 'sessions'), wakecycle: join(root, 'wakecycle'), ladder: join(root, 'ladder') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const EVENTS = join(root, 'events.jsonl');
const SENT = join(root, 'sent.jsonl');
const recorder = join(root, 'recorder.sh');
writeFileSync(recorder, `#!/bin/sh
body=$(cat)
printf '%s\\n' "$(node -e 'const e=process.env;console.log(JSON.stringify({kind:e.NIGHTWATCH_ALERT_KIND,cause:e.NIGHTWATCH_ALERT_CAUSE,lane:e.NIGHTWATCH_ALERT_LANE,session:e.NIGHTWATCH_ALERT_SESSION,title:e.NIGHTWATCH_ALERT_TITLE,persona:e.NIGHTWATCH_PERSONA,body:process.argv[1]}))' "$body")" >> "${SENT}"
`);
chmodSync(recorder, 0o755);
const config = (extra = {}) => {
  const file = join(root, 'nightwatch.config.json');
  writeFileSync(file, JSON.stringify({
    weftRoot: root, persona: { name: 'Lark' },
    lanes: { fable: { targetTokens: 250000 }, opus: { targetTokens: 250000, name: 'Heron' } },
    notify: { macos: false, command: recorder },
    paths: { transcripts: dirs.projects, sessions: dirs.sessions },
    ...extra,
  }));
  return file;
};
const CONFIG = config();

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const reply = (text, extra = {}) => ({ type: 'assistant', uuid: `u${++seq}`, timestamp: iso(now - 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 20_000, output_tokens: 5 } }, ...extra });
const apiError = (text, error, minsAgo = 0.5) => ({ type: 'assistant', uuid: `u${++seq}`, timestamp: iso(now - minsAgo * 60_000), isApiErrorMessage: true, error, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } });
const denial = (minsAgo, reason) => ({ type: 'user', uuid: `u${++seq}`, timestamp: iso(now - minsAgo * 60_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. More text.` }] } });
const write = (sid, entries) => writeFileSync(join(dirs.projects, `${sid}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const append = (sid, e) => appendFileSync(join(dirs.projects, `${sid}.jsonl`), JSON.stringify(e) + '\n');
let pid = 0;
const session = (sid, lane, { status = 'idle', statusAt = now } = {}) => {
  writeFileSync(join(dirs.sessions, `${++pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, kind: 'interactive', status, statusUpdatedAt: statusAt, updatedAt: statusAt }));
  if (lane) writeFileSync(join(dirs.wakecycle, `lane.${sid}`), JSON.stringify({ lane }));
};

session('s-login', 'fable'); write('s-login', [reply('hi'), apiError('Failed to authenticate: OAuth session expired and could not be refreshed', 'authentication_failed')]);
session('s-usage', 'fable'); write('s-usage', [reply('hi'), apiError("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", 'rate_limit')]);
session('s-offline', 'opus'); write('s-offline', [reply('hi'), apiError("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'server_error')]);
session('s-cut', 'opus'); write('s-cut', [reply('hi'), apiError('API Error: Unable to connect to API (EPROTO)', 'server_error')]);
session('s-refused', 'opus'); write('s-refused', [reply('hi'), apiError('API Error: Unable to connect to API (ECONNREFUSED)', 'server_error')]);
session('s-slept', 'opus'); write('s-slept', [reply('hi'), apiError('API Error: Your computer went to sleep mid-response. The response above may be incomplete.', 'server_error')]);
session('s-classifier', 'fable'); write('s-classifier', [reply('hi'), denial(20, '[Irreversible Local Destruction]'), denial(5, 'Blocked by classifier'), reply('ok')]);
session('s-context', 'opus'); write('s-context', [{ ...reply('big'), message: { ...reply('big').message, usage: { input_tokens: 100, cache_read_input_tokens: 880_000, cache_creation_input_tokens: 2_000, output_tokens: 5 } } }]);
session('s-waiting', 'fable', { status: 'waiting', statusAt: now - 20 * 60_000 }); write('s-waiting', [reply('may I?')]);
session('s-toolong', 'opus'); write('s-toolong', [reply('hi'), apiError('Prompt is too long', 'invalid_request'), apiError('Prompt is too long', 'invalid_request')]);
session('s-spiral', 'opus'); write('s-spiral', [reply('hi'), apiError('API Error: Connection dropped (ECONNRESET)', 'server_error', 9), apiError('API Error: Connection dropped (ECONNRESET)', 'server_error', 2)]);
session('s-plainapi', 'opus'); write('s-plainapi', [reply('hi'), apiError('API Error: Connection dropped (ECONNRESET)', 'server_error')]);
session('s-recovered', 'opus'); write('s-recovered', [apiError('API Error: Overloaded', 'server_error', 9), apiError('API Error: Overloaded', 'server_error', 5), reply('back')]);
session('s-fine', 'opus'); write('s-fine', [reply('all good')]);
// Another hub's agent: live on this machine, absent from THIS hub's registry.
session('s-otherhub', null); write('s-otherhub', [reply('hi'), apiError('Login expired · Please run /login', 'authentication_failed')]);
// Folded already: the window can outlive its fold for a moment.
session('s-folded', 'fable'); write('s-folded', [reply('hi'), apiError('Login expired · Please run /login', 'authentication_failed')]);
writeFileSync(join(dirs.ladder, 'folds.jsonl'), JSON.stringify({ source: 'jsonl:s-folded', tail: 'x-tail' }) + '\n');

const tick = (file = CONFIG) => execFileSync(process.execPath, [join(HERE, 'watch.mjs'), '--once'], { env: { ...process.env, WEFT_CONFIG: file }, stdio: 'ignore', timeout: 60_000 });
const lines = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const stuckBy = (evs) => Object.fromEntries(evs.filter((e) => e.kind === 'stuck').map((e) => [e.session, `${e.lane}:${e.cause}`]).sort(([a], [b]) => (a < b ? -1 : 1)));

tick();
const first = lines(EVENTS);
check('each stuck state is told once, under its own agent', stuckBy(first), {
  's-classifier': 'fable:classifier', 's-cut': 'opus:request-cut', 's-login': 'fable:login', 's-offline': 'opus:offline', 's-refused': 'opus:offline', 's-slept': 'opus:slept',
  's-toolong': 'opus:too-long', 's-usage': 'fable:usage-limit', 's-waiting': 'fable:waiting',
});
// A full-ish context is a warning, not a stuck state (Ra, 10/12).
check('85% context is told as context-high, a warning and not an alarm', first.filter((e) => e.kind === 'context-high').map((e) => [e.session, e.alarm]), [['s-context', false]]);
check('a spiral (two errors, newest still one) is a spiral-alarm', first.filter((e) => e.kind === 'spiral-alarm').map((e) => `${e.session}:${e.errors}`), ['s-spiral:2']);
check('one plain error, a recovered session and a fine one say nothing', ['s-plainapi', 's-recovered', 's-fine'].filter((s) => first.some((e) => e.session === s)), []);
check("another hub's agent and a folded session say nothing", ['s-otherhub', 's-folded'].filter((s) => first.some((e) => e.session === s)), []);
check('a too-full session is a stuck state, not a spiral', first.filter((e) => e.kind === 'spiral-alarm' && e.session === 's-toolong').length, 0);
check('every stuck and spiral event is an alarm', first.filter((e) => e.kind !== 'context-high').every((e) => e.alarm === true), true);
check('the classifier event counts the denials', first.find((e) => e.cause === 'classifier')?.count, 2);
check('the context event carries the ratio', Math.round((first.find((e) => e.cause === 'context')?.ratio ?? 0) * 100), 88);

const sent = lines(SENT);
check('the notify command gets one message per alert', sent.length, first.length);
check('it gets the kind, cause, agent, session, title and persona in its environment',
  sent.find((m) => m.session === 's-login') && (({ kind, cause, lane, title, persona }) => ({ kind, cause, lane, title, persona }))(sent.find((m) => m.session === 's-login')),
  { kind: 'stuck', cause: 'login', lane: 'fable', title: 'Logged out', persona: 'Lark' });
check('the message body arrives on stdin', /^Lark \(fable\) is logged out/.test(sent.find((m) => m.session === 's-login')?.body ?? ''), true);
check('the words say "agent", never "lane", and no "it"/"its"',
  sent.filter((m) => /\blanes?\b|\b[Ii]ts?\b/.test(m.body)).map((m) => m.body.slice(0, 60)), []);

tick();
check('a second tick (a restart, even) re-announces nothing', [lines(EVENTS).length, lines(SENT).length], [first.length, sent.length]);

append('s-offline', reply('back online'));
const ctx = (input) => ({ ...reply('x'), message: { ...reply('x').message, usage: { input_tokens: 0, cache_read_input_tokens: input, output_tokens: 1 } } });
append('s-context', ctx(820_000)); // between the re-arm line and the warning: the same episode
tick();
check("a lane's configured name replaces the key in its labels", /Lark \(Heron\)/.test(lines(SENT).find((l) => l.kind === 'stuck' && l.cause === 'request-cut')?.body ?? ''), true);
check('a cut-off request dates its figure', /on 10\/25.*4-5 MB/.test(lines(SENT).find((l) => l.kind === 'stuck' && l.cause === 'request-cut')?.body ?? ''), true);
check('a cut-off request names the fold, not the network', [/Force fold/.test(lines(SENT).find((l) => l.kind === 'stuck' && l.cause === 'request-cut')?.body ?? ''), /connection or DNS/.test(lines(SENT).find((l) => l.kind === 'stuck' && l.cause === 'request-cut')?.body ?? '')], [true, false]);
check('recovery clears offline, once, and sends nothing', [lines(EVENTS).slice(first.length).map((e) => `${e.kind}:${e.cause}`), lines(SENT).length - sent.length], [['stuck-cleared:offline'], 0]);
append('s-context', ctx(500_000));
tick();
check('context clears only below the re-arm line', lines(EVENTS).slice(first.length + 1).map((e) => `${e.kind}:${e.cause}`), ['context-high-cleared:context']);

// Wake cost (fix 4): the session woken from a fold's tail, found by the
// tail's entries in its transcript, records its first real request beside
// the fold's estimate. A decoy registered after the fold and a dead wake
// record nothing.
const fold = (tail, est) => appendFileSync(join(dirs.ladder, 'folds.jsonl'), JSON.stringify({ at: iso(now - 2 * 3600_000), reason: 'sleep', source: `jsonl:src-${tail}`, est_tokens: est, tail }) + '\n');
const copiedReply = (uuid) => ({ type: 'assistant', uuid, timestamp: iso(now - 3 * 3600_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'from yesterday' }], usage: { input_tokens: 0, cache_read_input_tokens: 937_000, output_tokens: 1 } } }); // a pre-10/8 tail's stale copied usage
const tailEntries = [{ type: 'user', uuid: 'tail-u1', timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: 'yesterday' } }, copiedReply('tail-a1')];
write('t-good', tailEntries);
write('w-good', [{ type: 'last-prompt' }, ...tailEntries, { type: 'user', uuid: 'w-u1', timestamp: iso(now - 50 * 60_000), message: { role: 'user', content: 'morning' } },
  // Claude Code's own synthetic replies carry all-zero usage and aren't errors: not a request.
  { type: 'assistant', uuid: 'w-syn', timestamp: iso(now - 50 * 60_000), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } } },
  { type: 'assistant', uuid: 'w-a1', timestamp: iso(now - 49 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'awake' }], usage: { input_tokens: 3, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 15_796, output_tokens: 40 } } }]);
write('w-decoy', [{ type: 'assistant', uuid: 'd-a1', timestamp: iso(now - 30 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'unrelated' }], usage: { input_tokens: 999, output_tokens: 1 } } }]);
const deadTail = [{ type: 'user', uuid: 'dt-u1', timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: 'x' } }];
write('t-dead', deadTail);
write('w-dead', [...deadTail, apiError('Prompt is too long', 'invalid_request')]);
for (const [sid, lane] of [['w-decoy', 'opus'], ['w-good', 'opus'], ['w-dead', 'fable']]) writeFileSync(join(dirs.wakecycle, `lane.${sid}`), JSON.stringify({ lane }));
fold('t-good', 252_417);
fold('t-dead', 250_000);
const eventsBefore = lines(EVENTS).length;
tick();
const costs = lines(join(root, 'ladder', 'wake-costs.jsonl'));
check('the woken session records its first real request beside the estimate',
  costs.map(({ lane, tail, session, source, estTokens, firstRequestTokens }) => ({ lane, tail, session, source, estTokens, firstRequestTokens })),
  [{ lane: 'opus', tail: 't-good', session: 'w-good', source: 'jsonl:src-t-good', estTokens: 252_417, firstRequestTokens: 205_799 }]);
check('the record is stamped with the reply\'s own time', costs[0]?.at, iso(now - 49 * 60_000));
check('and lands as a wake-cost event', lines(EVENTS).slice(eventsBefore).filter((e) => e.kind === 'wake-cost').map((e) => `${e.tail}:${e.firstRequestTokens}`), ['t-good:205799']);
tick();
check('a second tick records nothing twice', lines(join(root, 'ladder', 'wake-costs.jsonl')).length, 1);

// A 600KB first entry (a screenshot in the tail's head) is read whole, not
// cut at a byte window (Fable's measurement: 448KB in a real transcript).
const shot = 'iVBORw0KGgo' + 'A'.repeat(600_000);
const bigTail = [{ type: 'user', uuid: 'big-u1', timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] } }];
write('t-big', bigTail);
write('w-big', [{ type: 'last-prompt' }, ...bigTail, { type: 'assistant', uuid: 'wb-a1', timestamp: iso(now - 40 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, cache_read_input_tokens: 170_000 } } }]);
writeFileSync(join(dirs.wakecycle, 'lane.w-big'), JSON.stringify({ lane: 'fable' }));
fold('t-big', 240_000);
// A fold older than the lookback still counts while an agent's wake receipt
// names its tail (a vacation hold); one a later fold replaced does not.
const oldFold = (tail, est) => appendFileSync(join(dirs.ladder, 'folds.jsonl'), JSON.stringify({ at: iso(now - 5 * 24 * 3600_000), reason: 'sleep', source: `jsonl:src-${tail}`, est_tokens: est, tail }) + '\n');
for (const [t, w] of [['t-held', 'w-held'], ['t-stale', 'w-stale']]) {
  const te = [{ type: 'user', uuid: `${t}-u1`, timestamp: iso(now - 5 * 24 * 3600_000), message: { role: 'user', content: 'old' } }];
  write(t, te);
  write(w, [...te, { type: 'assistant', uuid: `${w}-a1`, timestamp: iso(now - 20 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'back' }], usage: { input_tokens: 7, cache_read_input_tokens: 99_000 } } }]);
  writeFileSync(join(dirs.wakecycle, `lane.${w}`), JSON.stringify({ lane: 'opus' }));
  oldFold(t, 200_000);
}
writeFileSync(join(dirs.wakecycle, 'next-wake.opus.json'), JSON.stringify({ lane: 'opus', sessionId: 't-held' }));
tick();
const costs2 = lines(join(root, 'ladder', 'wake-costs.jsonl')).map((c) => `${c.tail}:${c.firstRequestTokens}`);
check('a 600KB first entry is still costed', costs2.includes('t-big:170005'), true);
check("an old fold still named by a wake receipt is costed; a replaced one isn't", [costs2.includes('t-held:99007'), costs2.some((c) => c.startsWith('t-stale'))], [true, false]);

// Wake cost high: a first request at or past watch.wakeCostWarn (default 0.5)
// of the lane's window is one amber event, never a notification. The window
// is the model's (1M for ours, 200k for haiku), unknown models have none.
check('a wake well under the warn share raises nothing (t-good: 205,799 of 1M)', lines(EVENTS).filter((e) => e.kind === 'wake-cost-high').length, 0);
const wakeWith = (t, w, lane, model, tokens, estimate, version) => {
  const te = [{ type: 'user', uuid: `${t}-u1`, timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: t } }];
  write(t, te);
  write(w, [...te, { type: 'assistant', uuid: `${w}-a1`, timestamp: iso(now - 20 * 60_000), message: { role: 'assistant', model, content: [{ type: 'text', text: 'up' }], usage: { input_tokens: 1, cache_read_input_tokens: tokens - 1 } }, ...(version ? { version } : {}) }]);
  writeFileSync(join(dirs.wakecycle, `lane.${w}`), JSON.stringify({ lane }));
  fold(t, estimate);
};
wakeWith('t-hi', 'w-hi', 'opus', 'claude-opus-5-5', 520_000, 200_000);
wakeWith('t-edge', 'w-edge', 'fable', 'claude-fable-5-1', 499_999, 200_000);
wakeWith('t-haiku', 'w-haiku', 'fable', 'claude-haiku-4-5', 120_000, 100_000);
wakeWith('t-unk', 'w-unk', 'sonnet', 'some-future-model', 900_000, 200_000);
tick();
const highs = lines(EVENTS).filter((e) => e.kind === 'wake-cost-high');
check('over the share: one event naming the request, the window and the share, amber',
  highs.filter((e) => e.session === 'w-hi').map(({ lane, firstRequestTokens, window, ratio, warnAt, alarm }) => ({ lane, firstRequestTokens, window, ratio, warnAt, alarm })),
  [{ lane: 'opus', firstRequestTokens: 520_000, window: 1_000_000, ratio: 0.52, warnAt: 0.5, alarm: false }]);
check('just under the share raises nothing', highs.some((e) => e.session === 'w-edge'), false);
check("the share is of the model's own window (haiku: 120k of 200k)", highs.filter((e) => e.session === 'w-haiku').map((e) => e.ratio), [0.6]);
check('a model with no known window raises nothing, however big', highs.some((e) => e.session === 'w-unk'), false);
tick();
check('a second tick raises nothing twice', lines(EVENTS).filter((e) => e.kind === 'wake-cost-high').length, highs.length);
check('every wake still lands its wake-cost row', ['t-hi:520000', 't-edge:499999', 't-haiku:120000', 't-unk:900000'].every((c) => lines(join(root, 'ladder', 'wake-costs.jsonl')).map((r) => `${r.tail}:${r.firstRequestTokens}`).includes(c)), true);
// The edge and the knob. Exactly on the share warns (>=); the share is the
// config's, hot per tick; 0 turns the warning off; and it never sends a banner.
const cfgWarn = (name, wakeCostWarn) => { const f = join(root, `${name}.config.json`); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(CONFIG, 'utf8')), watch: { ...(JSON.parse(readFileSync(CONFIG, 'utf8')).watch ?? {}), wakeCostWarn } })); return f; };
wakeWith('t-bound', 'w-bound', 'opus', 'claude-opus-5-5', 500_000, 200_000);
tick();
check('exactly on the share warns', lines(EVENTS).filter((e) => e.kind === 'wake-cost-high' && e.session === 'w-bound').map((e) => e.ratio), [0.5]);
wakeWith('t-cfg', 'w-cfg', 'opus', 'claude-opus-5-5', 350_000, 200_000);
tick(cfgWarn('warn30', 0.3));
check("the share is the config's: 35% warns at 0.3 and records the share it used", lines(EVENTS).filter((e) => e.kind === 'wake-cost-high' && e.session === 'w-cfg').map((e) => [e.ratio, e.warnAt]), [[0.35, 0.3]]);
wakeWith('t-off', 'w-off', 'opus', 'claude-opus-5-5', 900_000, 200_000);
tick(cfgWarn('warn0', 0));
check('wakeCostWarn 0 turns it off (90% of the window, nothing)', lines(EVENTS).some((e) => e.kind === 'wake-cost-high' && e.session === 'w-off'), false);
check('the row still lands with the warning off', lines(join(root, 'ladder', 'wake-costs.jsonl')).some((r) => r.tail === 't-off'), true);
check('and no wake-cost warning ever sent a notification', lines(SENT).some((m) => JSON.stringify(m).includes('wake-cost')), false);

// The version that woke is the receipt that it woke clean: the row carries it,
// the first version ever recorded only seeds the baseline, and a version no
// earlier wake has run is told once, amber, never as a notification.
const versions = () => lines(join(root, 'ladder', 'wake-costs.jsonl')).filter((r) => r.tail.startsWith('t-v')).map((r) => `${r.tail}:${r.version ?? '-'}`);
const newOnes = () => lines(EVENTS).filter((e) => e.kind === 'claude-version-new').map((e) => `${e.version}<-${e.previous}`);
wakeWith('t-v1', 'w-v1', 'opus', 'claude-opus-5-5', 100_000, 100_000, '2.1.309');
tick();
check('the wake row carries the version that woke', versions(), ['t-v1:2.1.309']);
check('the first version ever recorded only seeds the baseline (no event)', newOnes(), []);
wakeWith('t-v2', 'w-v2', 'opus', 'claude-opus-5-5', 100_000, 100_000, '2.1.309');
tick();
check('a version already seen raises nothing', newOnes(), []);
wakeWith('t-v3', 'w-v3', 'opus', 'claude-opus-5-5', 100_000, 100_000, '2.1.310');
tick();
check('a version no earlier wake has run is told once, naming what came before', newOnes(), ['2.1.310<-2.1.309']);
check('as an amber event', lines(EVENTS).filter((e) => e.kind === 'claude-version-new').map((e) => e.alarm), [false]);
tick();
wakeWith('t-v4', 'w-v4', 'opus', 'claude-opus-5-5', 100_000, 100_000, '2.1.310');
wakeWith('t-v5', 'w-v5', 'opus', 'claude-opus-5-5', 100_000, 100_000);
tick();
check('and not again for the same version, nor for a reply with no version', newOnes(), ['2.1.310<-2.1.309']);
check('a reply with no version leaves the row without the key', lines(join(root, 'ladder', 'wake-costs.jsonl')).filter((r) => r.tail === 't-v5').map((r) => 'version' in r), [false]);
// Newness is set membership, never a comparison with the last row: a version
// seen earlier but not last coming back (a rollback, an older cask on PATH) is
// not new. Rows are now 2.1.309, 2.1.309, 2.1.310, 2.1.310, (none).
wakeWith('t-v6', 'w-v6', 'opus', 'claude-opus-5-5', 100_000, 100_000, '2.1.309');
tick();
check('a version seen earlier, but not last, coming back raises nothing (a rollback)', newOnes(), ['2.1.310<-2.1.309']);
check('and its row still lands with the version that woke', versions().includes('t-v6:2.1.309'), true);
check('and no version event ever sent a notification', lines(SENT).some((m) => JSON.stringify(m).includes('claude-version')), false);

// The head witness: the woken session's own api-request-shape holds the system blocks as sent; the
// head wake.sh saved (or, failing that, the receipt's checkpoint) should be in them. A stale prompt IS the
// previous wake's prompt (measured 10/25), so only the head's DISCRIMINATING lines (those not in the
// previous wake's prompt) can tell fresh from stale: a quiet day leaves most of a checkpoint unchanged.
// Everything below uses its own lane ("sonnet") so it leaves the earlier cases' files alone.
const HEADFILE = join(dirs.wakecycle, 'last-head.sonnet');
const RECEIPT = join(dirs.wakecycle, 'next-wake.sonnet.json');
const CPFILE = join(root, 'checkpoint-sonnet.md');
const mkLines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}: a distinct sentence of the checkpoint`).join('\n') + '\n';
const OLD = mkLines('standing', 20);          // what yesterday's prompt had, and still stands today
const NEW10 = mkLines('today', 10);           // what only today's head has
const TODAY = OLD + NEW10;                    // today's head: 30 lines, 10 of them discriminating
const setMtime = (f, msAgo) => utimesSync(f, new Date(now - msAgo), new Date(now - msAgo));
const shapeEntry = (sid, text, atMs = now - 25 * 60_000) => ({ type: 'api-request-shape', sessionId: sid, timestamp: iso(atMs), version: '2.1.310', shapeHash: `h-${sid}`, shape: { system: [{ type: 'text', text: 'You are Claude Code' }, { type: 'text', text }], tools: [] } });
const headCase = (id, { system, shapeSid, head = TODAY, headAgoMin = 30, receipt, cp, cpAgoMin, prev = OLD, prevWhere = 'projects', prevSid, wakePrompt }) => {
  for (const f of [HEADFILE, RECEIPT, CPFILE]) rmSync(f, { force: true });
  const t = `t-hw-${id}`, w = `w-hw-${id}`;
  const te = [{ type: 'user', uuid: `${t}-u1`, timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: t } }];
  write(t, te);
  // A wake prompt (lanes.<name>.wakePrompt) is the woken session's first user turn, after the forked tail.
  const wp = wakePrompt === undefined ? [] : [{ type: 'user', uuid: `${w}-wp`, timestamp: iso(now - 26 * 60_000), message: { role: 'user', content: wakePrompt } }];
  write(w, [...te, ...wp, ...(system === undefined ? [] : [shapeEntry(shapeSid ?? w, system)]),
    { type: 'assistant', uuid: `${w}-a1`, timestamp: iso(now - 20 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'up' }], usage: { input_tokens: 1, cache_read_input_tokens: 99_999 } }, version: '2.1.310' }]);
  // The folded (previous) session, whose own first api-request-shape is the previous wake's prompt (fold() names it src-<tail>).
  if (prev !== null) {
    const entries = [shapeEntry(prevSid ?? `src-${t}`, prev, now - 26 * 3600_000)];
    if (prevWhere === 'archive') { mkdirSync(join(root, 'archive', 'transcripts'), { recursive: true }); writeFileSync(join(root, 'archive', 'transcripts', `src-${t}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); }
    else write(`src-${t}`, entries);
  }
  writeFileSync(join(dirs.wakecycle, `lane.${w}`), JSON.stringify({ lane: 'sonnet' }));
  fold(t, 100_000);
  if (head !== null) { writeFileSync(HEADFILE, head); setMtime(HEADFILE, headAgoMin * 60_000); }
  if (cp !== undefined) { writeFileSync(CPFILE, cp); setMtime(CPFILE, cpAgoMin * 60_000); }
  if (receipt) writeFileSync(RECEIPT, JSON.stringify({ lane: 'sonnet', sessionId: receipt === 'this' ? t : 'some-later-tail', ...(cp !== undefined ? { checkpoint: CPFILE } : {}) }));
  return { t, w };
};
const rowOf = (t) => lines(join(root, 'ladder', 'wake-costs.jsonl')).find((r) => r.tail === t);
const headEvents = (w) => lines(EVENTS).filter((e) => e.kind === 'head-not-in-prompt' && e.session === w);
const has = (row, k) => row !== undefined && k in row;

let c = headCase('exact', { system: `boilerplate\n${TODAY}\nmore` }); tick();
check('a prompt carrying the whole head: headMatch 1, headFresh 1 over the 10 discriminating lines, quiet',
  [rowOf(c.t)?.headMatch, rowOf(c.t)?.headFresh, rowOf(c.t)?.headDisc, rowOf(c.t)?.headRef, headEvents(c.w).length], [1, 1, 10, 'saved-head', 0]);

// A wake prompt is a user turn, not part of the system blocks the witness reads, so turning it on moves
// neither the head's scores nor the first request's cost (Opus's ask on the wake-prompt PR).
const scoresOf = (t) => { const r = rowOf(t); return r && [r.headMatch, r.headFresh, r.headDisc, r.headRef, r.firstRequestTokens]; };
const offT = c.t;
c = headCase('exact-wp', { system: `boilerplate\n${TODAY}\nmore`, wakePrompt: '[nightwatch] woken at 10:00: arm your watcher, then read the receipts' }); tick();
check('a wake with a wakePrompt scores its head exactly as one without (headMatch, headFresh, headDisc, ref, first-request tokens), quiet',
  [scoresOf(c.t), headEvents(c.w).length], [scoresOf(offT), 0]);

// The case that motivated the change: yesterday's prompt re-sent. 20 of 30 lines match, but with a longer
// standing part the full share clears 0.9, and ONLY the discriminating share convicts.
const LONG_OLD = mkLines('standing', 90), TODAY100 = LONG_OLD + NEW10;
c = headCase('stale', { system: LONG_OLD, head: TODAY100, prev: LONG_OLD }); tick();
check('a STALE prompt (yesterday\'s) is told even though 90% of the head\'s lines match it: amber, with the discriminating share and the full one',
  [rowOf(c.t)?.headMatch, rowOf(c.t)?.headFresh, headEvents(c.w).map(({ share, shareAll, discriminating, ref, warnAt, alarm, lane }) => ({ share, shareAll, discriminating, ref, warnAt, alarm, lane }))],
  [0.9, 0, [{ share: 0, shareAll: 0.9, discriminating: 10, ref: 'saved-head', warnAt: 0.9, alarm: false, lane: 'sonnet' }]]);

const d9 = OLD + NEW10.split('\n').slice(0, 9).join('\n'), d8 = OLD + NEW10.split('\n').slice(0, 8).join('\n');
c = headCase('edge9', { system: d9 }); tick();
check('exactly on the threshold (9 of the 10 discriminating lines) is quiet', [rowOf(c.t)?.headFresh, headEvents(c.w).length], [0.9, 0]);
c = headCase('edge8', { system: d8 }); tick();
check('under it (8 of 10) is told, with the share it measured', [rowOf(c.t)?.headFresh, headEvents(c.w).map((e) => e.share)], [0.8, [0.8]]);

// A quiet day: today's head has 4 new lines and 26 already in yesterday's prompt. A stale prompt cannot be told from a fresh one.
const QUIET = OLD + mkLines('quiet', 4);
c = headCase('quiet-stale', { system: OLD, head: QUIET, prev: OLD }); tick();
check('too few discriminating lines (4, needs 5): claims nothing, though the prompt is stale; the full share and the count are on the row',
  [has(rowOf(c.t), 'headFresh'), rowOf(c.t)?.headDisc, rowOf(c.t)?.headMatch, headEvents(c.w).length], [false, 4, 0.833, 0]);
const FIVE = OLD + mkLines('five', 5);
c = headCase('five', { system: OLD, head: FIVE, prev: OLD }); tick();
check('five discriminating lines is enough to score, and a stale prompt scores 0 and is told', [rowOf(c.t)?.headDisc, rowOf(c.t)?.headFresh, headEvents(c.w).length], [5, 0, 1]);

c = headCase('noprev', { system: 'unrelated', prev: null }); tick();
check('no previous prompt to compare against (the folded session has no shape entry): the full share is recorded, nothing is scored or told',
  [rowOf(c.t)?.headMatch, has(rowOf(c.t), 'headFresh'), has(rowOf(c.t), 'headDisc'), headEvents(c.w).length], [0, false, false, 0]);

c = headCase('prev-archived', { system: LONG_OLD, head: TODAY100, prev: LONG_OLD, prevWhere: 'archive' }); tick();
check("the previous prompt is found in the transcript archive when the live folder no longer has the session", [rowOf(c.t)?.headFresh, rowOf(c.t)?.headDisc, headEvents(c.w).length], [0, 10, 1]);
c = headCase('prev-othersess', { system: 'unrelated', prev: OLD, prevSid: 'some-other-session' }); tick();
check("a shape entry in the folded session's file that belongs to another session is not the previous prompt: nothing scored", [has(rowOf(c.t), 'headFresh'), headEvents(c.w).length], [false, 0]);

c = headCase('noshape', {}); tick();
check('no api-request-shape in the woken session: no witness, so nothing is recorded or told (never "stale")', [rowOf(c.t) !== undefined, has(rowOf(c.t), 'headMatch'), headEvents(c.w).length], [true, false, 0]);

c = headCase('othersess', { system: 'unrelated', shapeSid: 'some-other-session' }); tick();
check("another session's shape entry (copied with a forked tail) is not this session's witness", [has(rowOf(c.t), 'headMatch'), headEvents(c.w).length], [false, 0]);

c = headCase('later', { system: `x\n${TODAY}`, head: mkLines('someone-elses', 3), headAgoMin: 10, receipt: 'this', cp: TODAY, cpAgoMin: 300 }); tick();
check("a saved head written after the first request is a later wake's: the receipt's checkpoint is the reference instead",
  [rowOf(c.t)?.headMatch, rowOf(c.t)?.headRef, headEvents(c.w).length], [1, 'checkpoint', 0]);

c = headCase('predates', { system: `x\n${TODAY}`, head: mkLines('previous-wake', 3), headAgoMin: 300, receipt: 'this', cp: TODAY, cpAgoMin: 300 }); tick();
check("a saved head older than the fold is the previous wake's: not used", [rowOf(c.t)?.headRef, headEvents(c.w).length], ['checkpoint', 0]);

c = headCase('edited', { system: 'unrelated', head: mkLines('x', 3), headAgoMin: 10, receipt: 'this', cp: TODAY, cpAgoMin: 5 }); tick();
check('a checkpoint edited after the first request cannot convict: skipped, nothing recorded or told', [has(rowOf(c.t), 'headMatch'), headEvents(c.w).length], [false, 0]);

c = headCase('moved', { system: 'unrelated', head: null, receipt: 'later', cp: TODAY, cpAgoMin: 300 }); tick();
check('a receipt that has moved on to a later tail, and no saved head: skipped', [has(rowOf(c.t), 'headMatch'), headEvents(c.w).length], [false, 0]);

const cfgHeadOff = (() => { const cj = JSON.parse(readFileSync(CONFIG, 'utf8')); const f = join(root, 'headoff.config.json'); writeFileSync(f, JSON.stringify({ ...cj, watch: { ...(cj.watch ?? {}), headMatchWarn: 0 } })); return f; })();
c = headCase('off', { system: LONG_OLD, head: TODAY100, prev: LONG_OLD }); tick(cfgHeadOff);
check('headMatchWarn 0 turns the event off (this prompt is stale and would be told), and the shares are still recorded', [rowOf(c.t)?.headFresh, rowOf(c.t)?.headMatch, headEvents(c.w).length], [0, 0.9, 0]);
check('no head witness event ever sent a notification', lines(SENT).some((m) => JSON.stringify(m).includes('head-not-in-prompt')), false);
// A lane's own contextWindow outranks the model's (Opus's note on #39: windowFor
// is old code, and nothing pinned this branch of it). 250k is 25% of 1M and
// stays quiet; with the lane pinned to 400k it is 62.5% and warns, naming 400k.
const cfgLaneWindow = (name, lane, contextWindow) => { const c = JSON.parse(readFileSync(CONFIG, 'utf8')); const f = join(root, `${name}.config.json`); writeFileSync(f, JSON.stringify({ ...c, lanes: { ...(c.lanes ?? {}), [lane]: { ...(c.lanes?.[lane] ?? {}), contextWindow } } })); return f; };
wakeWith('t-plain', 'w-plain', 'fable', 'claude-fable-5-1', 250_000, 200_000);
wakeWith('t-pin', 'w-pin', 'opus', 'claude-opus-5-5', 250_000, 200_000);
tick(cfgLaneWindow('lanewin', 'opus', 400_000));
check("a lane's own contextWindow is the window: 250k of a pinned 400k warns, naming 400k",
  lines(EVENTS).filter((e) => e.kind === 'wake-cost-high' && e.session === 'w-pin').map((e) => [e.window, e.ratio]), [[400_000, 0.625]]);
check('and another lane on the model default (250k of 1M) stays quiet in the same tick', lines(EVENTS).some((e) => e.kind === 'wake-cost-high' && e.session === 'w-plain'), false);

// An unnamed single-agent hub reads "the main agent"; a failing command never
// costs the event card.
const solo = join(root, 'solo');
for (const d of ['wakecycle', 'ladder']) mkdirSync(join(solo, d), { recursive: true });
const soloCfg = join(solo, 'nightwatch.config.json');
writeFileSync(soloCfg, JSON.stringify({ weftRoot: solo, lanes: { main: { targetTokens: 250000 } }, notify: { macos: false, command: join(root, 'missing.sh') }, paths: { transcripts: dirs.projects, sessions: dirs.sessions } }));
writeFileSync(join(solo, 'wakecycle', 'lane.s-login'), JSON.stringify({ lane: 'main' }));
tick(soloCfg);
const soloEvents = lines(join(solo, 'events.jsonl'));
check('a missing notify command still leaves the event', soloEvents.map((e) => `${e.session}:${e.cause}`), ['s-login:login']);
check('the failure is logged, not thrown', /notify command failed/.test(readFileSync(join(solo, 'watch.log'), 'utf8')), true);

// The midday cycle (Ra, 10/12), end to end: the watch's trigger runs the real
// nightshift --midday against this scratch hub. A lane with middayCycle gets a
// soft bell at 85% (no deadline) and an urgent one at 95% (a 10-minute
// deadline), each once; a lane without it gets nothing. The nightly window is
// set six hours away (UTC) so the test doesn't depend on when it runs.
const mid = join(root, 'mid');
for (const d of ['wakecycle', 'ladder']) mkdirSync(join(mid, d), { recursive: true });
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const midCfg = join(mid, 'nightwatch.config.json');
writeFileSync(midCfg, JSON.stringify({
  weftRoot: mid, timezone: 'UTC', schedule: { sleep: hhmm(now + 6 * 3600_000), wake: hhmm(now + 7 * 3600_000) },
  lanes: { opus: { targetTokens: 250000, middayCycle: { softPct: 0.85, urgentPct: 0.95, urgentMin: 10 } }, fable: { targetTokens: 250000 } },
  notify: { macos: false, command: recorder }, paths: { transcripts: dirs.projects, sessions: dirs.sessions },
}));
const usageAt = (tokens) => ({ ...reply('busy'), message: { ...reply('busy').message, usage: { input_tokens: 100, cache_read_input_tokens: tokens, output_tokens: 5 } } });
session('s-mid-opus'); write('s-mid-opus', [usageAt(880_000)]);
session('s-mid-fable'); write('s-mid-fable', [usageAt(880_000)]);
writeFileSync(join(mid, 'wakecycle', 'lane.s-mid-opus'), JSON.stringify({ lane: 'opus' }));
writeFileSync(join(mid, 'wakecycle', 'lane.s-mid-fable'), JSON.stringify({ lane: 'fable' }));
const midState = () => { try { return JSON.parse(readFileSync(join(mid, 'wakecycle', 'nightshift.state.json'), 'utf8')); } catch { return {}; } };
const spoolNotes = (lane) => { try { return readdirSync(join(mid, 'doorbell', 'spool', lane)).map((f) => readFileSync(join(mid, 'doorbell', 'spool', lane, f), 'utf8')); } catch { return []; } };
tick(midCfg);
const soft = midState().opus?.foldRequest;
check('midday: at 88% a cycling lane gets a soft request with no deadline', [soft?.tier, soft?.deadline, soft?.sessionId], ['soft', null, 's-mid-opus']);
check('midday: its bell says midday and promises a reopen, not 08:00', spoolNotes('opus').map((n) => /^\[nightshift\] Midday bell: the opus lane's context is at 88%/.test(n) && /opens a fresh one right away/.test(n)), [true]);
check('midday: a lane without middayCycle gets nothing', [midState().fable?.foldRequest ?? null, spoolNotes('fable').length], [null, 0]);
// The context alarm beside the bell (Ra, 10/12): on a cycling lane the soft
// bell is the response, so no alarm; a lane without the cycle keeps it.
const midCtx = (sid) => lines(join(mid, 'events.jsonl')).filter((e) => e.kind === 'context-high' && e.session === sid);
check('midday: the soft bell rings and NO context warning goes with it', midCtx('s-mid-opus').length, 0);
check('midday: a lane without the cycle still gets the context-high warning at 88%', midCtx('s-mid-fable').length, 1);
// Amber doesn't notify (Ra, 10/12), except the transitional leak: an
// uncycled lane's keeper is still its responder. With the knob off, the
// warning is still on the card and in the stream, and nothing is sent.
const sentFor = (sid) => lines(SENT).filter((m) => m.session === sid || (m.env ?? {}).NIGHTWATCH_ALERT_SESSION === sid);
check('amber: the uncycled lane leaks its warning as a notification (transitional, default on)', sentFor('s-mid-fable').length, 1);
writeFileSync(join(mid, 'quiet.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(midCfg, 'utf8')), watch: { notifyAmberUncycled: false } }));
session('s-mid-quiet'); write('s-mid-quiet', [usageAt(880_000)]);
writeFileSync(join(mid, 'wakecycle', 'lane.s-mid-quiet'), JSON.stringify({ lane: 'fable' }));
tick(join(mid, 'quiet.config.json'));
check('amber: with notifyAmberUncycled off, the warning is told and nothing is sent', [midCtx('s-mid-quiet').length, sentFor('s-mid-quiet').length], [1, 0]);
append('s-mid-opus', usageAt(960_000));
// The soft bell went out half an hour ago: the urgent deadline must count
// from the escalation, not from the soft request (Fable's second read).
{ const st0 = midState(); st0.opus.foldRequest.requestedAt -= 30 * 60_000; writeFileSync(join(mid, 'wakecycle', 'nightshift.state.json'), JSON.stringify(st0)); }
tick(midCfg);
const urgent = midState().opus?.foldRequest;
check('midday: at 96% the soft request escalates to urgent, about ten minutes out', [urgent?.tier, Math.round((urgent?.deadline - Date.now()) / 60_000)], ['urgent', 10]);
check('midday: the urgent bell names its deadline', spoolNotes('opus').filter((n) => /^\[nightshift\] URGENT midday bell/.test(n) && /Fold within 10 minutes/.test(n)).length, 1);
tick(midCfg);
check('midday: each tier rings once per session', spoolNotes('opus').length, 2);
check('midday: the urgent request stands before its deadline, still no warning', midCtx('s-mid-opus').length, 0);
// The deadline blew and the session is still going: the force didn't land,
// so now the alarm fires, and says the cycle stalled.
{ const st1 = midState(); st1.opus.foldRequest.deadline = Date.now() - 6 * 60_000; writeFileSync(join(mid, 'wakecycle', 'nightshift.state.json'), JSON.stringify(st1)); }
tick(midCfg);
check('midday: deadline blown, the context alarm fires as a stalled cycle, an alarm', midCtx('s-mid-opus').map((e) => [Math.round(e.ratio * 100), e.cycleStalled, e.alarm]), [[96, true, true]]);
// A soft request outlives a session that ended another way (closed by hand):
// the lane's next session still gets its own bell, not "already stands".
writeFileSync(join(mid, 'wakecycle', 'nightshift.state.json'), JSON.stringify({ opus: { foldRequest: { sessionId: 's-gone', requestedAt: now - 3600_000, deadline: null, tier: 'soft' } } }));
session('s-mid-next'); write('s-mid-next', [usageAt(880_000)]);
writeFileSync(join(mid, 'wakecycle', 'lane.s-mid-next'), JSON.stringify({ lane: 'opus' }));
tick(midCfg);
check("midday: a stale request from an ended session doesn't silence the next one", [midState().opus?.foldRequest?.sessionId, midState().opus?.foldRequest?.tier], ['s-mid-next', 'soft']);

// The card's midday switch (10/12) edits the config while the watch runs: the
// running watch picks it up on its next poll, no restart. A lane at 88% with
// the cycle off is left alone; switched on mid-run, it gets its soft bell.
{
  const live = join(root, 'live');
  for (const d of ['wakecycle', 'ladder']) mkdirSync(join(live, d), { recursive: true });
  const liveCfg = join(live, 'nightwatch.config.json');
  const cfgWith = (midday) => JSON.stringify({
    weftRoot: live, timezone: 'UTC', schedule: { sleep: hhmm(now + 6 * 3600_000), wake: hhmm(now + 7 * 3600_000) },
    watch: { pollMs: 300 },
    lanes: { opus: { targetTokens: 250000, ...(midday ? { middayCycle: { softPct: 0.85, urgentPct: 0.95, urgentMin: 10 } } : {}) } },
    notify: { macos: false, command: recorder }, paths: { transcripts: dirs.projects, sessions: dirs.sessions },
  });
  writeFileSync(liveCfg, cfgWith(false));
  session('s-live'); write('s-live', [usageAt(880_000)]);
  writeFileSync(join(live, 'wakecycle', 'lane.s-live'), JSON.stringify({ lane: 'opus' }));
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const w = spawn(process.execPath, [join(HERE, 'watch.mjs')], { env: { ...process.env, WEFT_CONFIG: liveCfg }, stdio: 'ignore' });
  try {
    nap(1500);
    const before = (() => { try { return JSON.parse(readFileSync(join(live, 'wakecycle', 'nightshift.state.json'), 'utf8')); } catch { return {}; } })();
    check('switch: with the cycle off, a lane at 88% gets no request', before.opus?.foldRequest ?? null, null);
    writeFileSync(liveCfg, cfgWith(true)); // the card's switch, turned on
    nap(2500);
    const after = (() => { try { return JSON.parse(readFileSync(join(live, 'wakecycle', 'nightshift.state.json'), 'utf8')); } catch { return {}; } })();
    check('switch: turned on mid-run, the running watch rings the soft bell', after.opus?.foldRequest?.tier ?? null, 'soft');
    check('switch: the watch logs the reload', /config reloaded — midday cycle on: \[opus\]/.test(readFileSync(join(live, 'watch.log'), 'utf8')), true);
  } finally { w.kill(); }
}

// ── due notes: segment-due and l3-due ──────────────────────────────────────
{
  const due = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'watch-due-'));
  for (const d of ['wakecycle', 'ladder', 'doorbell']) mkdirSync(join(due, d), { recursive: true });
  const dueCfg = join(due, 'nightwatch.config.json');
  const writeCfg = (horizon) => writeFileSync(dueCfg, JSON.stringify({
    weftRoot: due, timezone: 'UTC', defaultLane: 'fable',
    watch: { pollMs: 300, ...(horizon ? { l3HorizonDays: horizon } : {}) },
    lanes: { fable: { targetTokens: 250000, segmentNoteEveryTokens: 50_000 }, alpha: { targetTokens: 250000 }, beta: { targetTokens: 250000 } },
    notify: { macos: false, command: recorder }, paths: { transcripts: dirs.projects, sessions: dirs.sessions },
  }));
  writeCfg(0);
  const usage = (tokens) => ({ type: 'assistant', uuid: `u${++seq}`, timestamp: iso(now - 30_000), message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100, cache_read_input_tokens: tokens - 100, output_tokens: 5 } } });
  session('s-due', null); writeFileSync(join(due, 'wakecycle', 'lane.s-due'), JSON.stringify({ lane: 'fable' }));
  write('s-due', [usage(120_000)]);
  const dueEvents = () => lines(join(due, 'events.jsonl'));
  // Due notes live in due/<lane>, never in the spool a watcher treats as bells (10/18).
  const dueNotes = (lane) => existsSync(join(due, 'doorbell', 'due', lane)) ? readdirSync(join(due, 'doorbell', 'due', lane)) : [];
  const spoolOf = (lane) => existsSync(join(due, 'doorbell', 'spool', lane)) ? readdirSync(join(due, 'doorbell', 'spool', lane)) : [];
  tick(dueCfg);
  check('segment-due: the first sight of a session baselines without ringing', dueEvents().filter((e) => e.kind === 'segment-due').length, 0);
  append('s-due', usage(180_000));
  tick(dueCfg);
  check('segment-due: a band crossing rings once', dueEvents().filter((e) => e.kind === 'segment-due').length, 1);
  check('segment-due: one due note, named for the watch', dueNotes('fable').filter((f) => f.includes('watch-segment-due')).length, 1);
  check('segment-due: nothing in the spool, where a watcher would take it for a bell', spoolOf('fable').length, 0);
  check('segment-due: the growth figure is the real tokens since the last ring, not the band', (() => {
    const f = dueNotes('fable').find((n) => n.includes('watch-segment-due'));
    const text = readFileSync(join(due, 'doorbell', 'due', 'fable', f), 'utf8');
    return [/grown another ~60k/.test(text), /to ~180k/.test(text), /another ~180k/.test(text)];
  })(), [true, true, false]);
  tick(dueCfg);
  check('segment-due: no growth, no re-ring', dueEvents().filter((e) => e.kind === 'segment-due').length, 1);
  append('s-due', usage(238_000));
  tick(dueCfg);
  check('segment-due: the next full helping of growth rings again', dueEvents().filter((e) => e.kind === 'segment-due').length, 2);
  // The live specimen (892k→901k): a band boundary crossed with under-knob
  // growth since the last ring must NOT re-ring.
  append('s-due', usage(252_000)); // +14k since the 238k ring, over the 250k line
  tick(dueCfg);
  check('segment-due: a boundary crossed with under-knob growth stays quiet (the 892k→901k specimen)', dueEvents().filter((e) => e.kind === 'segment-due').length, 2);
  append('s-due', usage(345_000)); // a big jump in one poll (a huge tool result)
  tick(dueCfg);
  check('segment-due: a big jump rings once and states the exact growth since the last ring', (() => {
    const notes = dueNotes('fable').filter((n) => n.includes('watch-segment-due')).sort();
    const text = readFileSync(join(due, 'doorbell', 'due', 'fable', notes[notes.length - 1]), 'utf8');
    return [dueEvents().filter((e) => e.kind === 'segment-due').length, /grown another ~107k/.test(text), /to ~345k/.test(text)];
  })(), [3, true, true]);

  // Restart keeps the band: every tick here is a FRESH process reading the
  // persisted state, so the baseline/band logic surviving between ticks IS
  // the watch-restarted-mid-session case, pinned as law (opus's knife).
  const wstate = () => JSON.parse(readFileSync(join(due, 'wakecycle', 'watch-state.json'), 'utf8'));
  check('segment-due: a fresh process keeps the last ring\'s tokens (restart-safe by state)', typeof wstate().due.seg['s-due'].tokens, 'number');

  // l3-due: per LANE, due at 2x the horizon. alpha's unfolded rungs span 8
  // days (due at horizon 4); beta's span 2 (quiet); a rung with no lane
  // token belongs to the default lane.
  const entry = (day, lane, parent) => ({ id: `lark-L2-${day}${lane ? `-${lane}` : ''}`, file: `L2/${day}.md`, level: 'L2', ...(parent ? { parent } : {}) });
  const writeIndex = (entries) => writeFileSync(join(due, 'ladder', 'index.json'), JSON.stringify({ entries }, null, 2));
  const alphaSpread = [entry('2026-10-01', 'alpha'), entry('2026-10-05', 'alpha'), entry('2026-10-09', 'alpha')];
  writeIndex([...alphaSpread, entry('2026-10-08', 'beta'), entry('2026-10-10', 'beta')]);
  tick(dueCfg);
  check('l3-due: off without a horizon', dueEvents().filter((e) => e.kind === 'l3-due').length, 0);
  writeCfg(4);
  tick(dueCfg);
  check('l3-due: past 2x the horizon it rings once, per lane, to that lane', dueEvents().filter((e) => e.kind === 'l3-due').map((e) => e.lane), ['alpha']);
  check('l3-due: the note lands in that lane\'s due/', dueNotes('alpha').some((f) => f.includes('watch-l3-due')), true);
  check('l3-due: and not in its spool', spoolOf('alpha').length, 0);
  check('l3-due: a lane under the horizon stays quiet', dueNotes('beta').length, 0);
  tick(dueCfg);
  check('l3-due: the same due-state is already told', dueEvents().filter((e) => e.kind === 'l3-due').length, 1);
  // Fold the finished arc, keep the lived week: quiet, not an instant re-ring.
  writeIndex([entry('2026-10-01', 'alpha', 'lark-L3-x'), entry('2026-10-05', 'alpha', 'lark-L3-x'), entry('2026-10-09', 'alpha'), entry('2026-10-12', 'alpha')]);
  tick(dueCfg);
  check('l3-due: folding the arc goes quiet, no instant re-ring on the lived days', dueEvents().filter((e) => e.kind === 'l3-due').length, 1);
  writeIndex([...alphaSpread]);
  tick(dueCfg);
  check('l3-due: a recurrence rings again', dueEvents().filter((e) => e.kind === 'l3-due').length, 2);
  check('l3-due: a rung with no lane token belongs to the default lane', (() => { writeIndex([entry('2026-10-01'), entry('2026-10-10')]); tick(dueCfg); return dueEvents().filter((e) => e.kind === 'l3-due').map((e) => e.lane); })(), ['alpha', 'alpha', 'fable']);
  rmSync(due, { recursive: true, force: true });
}

// ── the l3 horizon hot-reloads in a RUNNING watch (opus's enable nit) ──────
// Every tick() above is a fresh process, so it cannot see a stale module
// constant; only a long-running watch can. Same pattern as the midday
// switch test: start the daemon, flip the config, expect the ring.
{
  const hot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'watch-hot-'));
  for (const d of ['wakecycle', 'ladder', 'doorbell']) mkdirSync(join(hot, d), { recursive: true });
  const hotCfg = join(hot, 'nightwatch.config.json');
  const hotWrite = (horizon) => writeFileSync(hotCfg, JSON.stringify({
    weftRoot: hot, timezone: 'UTC', defaultLane: 'fable',
    watch: { pollMs: 300, ...(horizon ? { l3HorizonDays: horizon } : {}) },
    lanes: { fable: { targetTokens: 250000 } },
    notify: { macos: false, command: recorder }, paths: { transcripts: dirs.projects, sessions: dirs.sessions },
  }));
  hotWrite(0);
  writeFileSync(join(hot, 'ladder', 'index.json'), JSON.stringify({ entries: [
    { id: 'lark-L2-2026-10-01', file: 'L2/a.md', level: 'L2' },
    { id: 'lark-L2-2026-10-09', file: 'L2/b.md', level: 'L2' },
  ] }));
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const hw = spawn(process.execPath, [join(HERE, 'watch.mjs')], { env: { ...process.env, WEFT_CONFIG: hotCfg }, stdio: 'ignore' });
  try {
    nap(1200);
    const evs = () => lines(join(hot, 'events.jsonl')).filter((e) => e.kind === 'l3-due');
    check('hot: with no horizon the running watch stays quiet', evs().length, 0);
    hotWrite(4); // the enable, mid-run: 8-day span ≥ 2×4
    nap(2000);
    check('hot: setting l3HorizonDays mid-run rings without a restart', evs().length, 1);
    // Ra's transitional amber knob (10/12), the switch most likely to be
    // flipped while the daemon runs: a context crossing AFTER the mid-run
    // flip must notify, through the same hot path.
    session('s-hotamber', null); writeFileSync(join(hot, 'wakecycle', 'lane.s-hotamber'), JSON.stringify({ lane: 'fable' }));
    write('s-hotamber', [usageAt(100_000)]);
    nap(800);
    const sent = () => lines(SENT).filter((e) => e.session === 's-hotamber');
    check('hot: under the threshold, knob off, nothing notifies', sent().length, 0);
    writeFileSync(hotCfg, JSON.stringify({ ...JSON.parse(readFileSync(hotCfg, 'utf8')), watch: { pollMs: 300, l3HorizonDays: 4, notifyAmberUncycled: true } }));
    nap(800);
    append('s-hotamber', usageAt(880_000));
    nap(1500);
    check('hot: notifyAmberUncycled flipped mid-run notifies the next crossing, no restart', sent().map((e) => e.kind), ['context-high']);
  } finally { hw.kill(); }
  rmSync(hot, { recursive: true, force: true });
}

// nightwatch#22: inside the nightly window an armed lane's nightly bell covers
// it, so --midday stands aside; an unarmed lane has no nightly bell, so it is
// rung, and the daemon carries the request out.
{
  const win = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'watch-win-'));
  for (const d of ['wakecycle', 'ladder']) mkdirSync(join(win, d), { recursive: true });
  const winCfg = join(win, 'nightwatch.config.json');
  writeFileSync(winCfg, JSON.stringify({
    weftRoot: win, timezone: 'UTC', schedule: { sleep: hhmm(now - 3600_000), wake: hhmm(now + 3600_000) },
    lanes: { opus: { targetTokens: 250000, middayCycle: { softPct: 0.85, urgentPct: 0.95, urgentMin: 10 } } },
    notify: { macos: false, command: recorder }, paths: { transcripts: dirs.projects, sessions: dirs.sessions },
  }));
  session('s-win-opus'); write('s-win-opus', [usageAt(880_000)]);
  writeFileSync(join(win, 'wakecycle', 'lane.s-win-opus'), JSON.stringify({ lane: 'opus' }));
  const env = { ...process.env, NIGHTWATCH_CONFIG: winCfg };
  for (const k of ['WEFT_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
  const midday = () => spawnSync(process.execPath, [join(HERE, 'nightshift.mjs'), '--midday', 'opus', 'soft', '--session', 's-win-opus'], { env, encoding: 'utf8', timeout: 20_000 });
  const winState = () => { try { return JSON.parse(readFileSync(join(win, 'wakecycle', 'nightshift.state.json'), 'utf8')); } catch { return {}; } };
  const unarmed = midday();
  check('window: an unarmed lane is rung inside the nightly window', [unarmed.status, winState().opus?.foldRequest?.tier], [0, 'soft']);
  rmSync(join(win, 'wakecycle', 'nightshift.state.json'), { force: true });
  writeFileSync(join(win, 'wakecycle', 'nightshift.armed'), 'opus\n');
  const armedRun = midday();
  check('window: an armed lane stands aside for its nightly bell', [armedRun.status, /nightly bell covers/.test(armedRun.stdout), winState().opus?.foldRequest ?? null], [0, true, null]);
  rmSync(win, { recursive: true, force: true });
}

// A fold that didn't happen (10/21): a refused trim (trim-failed, sleep.mjs) or a failed emergency
// fold (orphan-fold-failed, nightshift) is told once per lane per episode, read from the event stream
// on from where the watch stopped. A hub of its own: no sessions, so nothing else notifies.
{
  const ff = join(root, 'foldfail');
  mkdirSync(join(ff, 'wakecycle'), { recursive: true });
  const ffCfg = join(ff, 'nightwatch.config.json');
  writeFileSync(ffCfg, JSON.stringify({
    weftRoot: ff, persona: { name: 'Lark' }, lanes: { fable: { targetTokens: 250000 }, opus: { targetTokens: 250000 } },
    notify: { macos: false, command: recorder }, paths: { transcripts: join(ff, 'projects'), sessions: join(ff, 'sessions') },
  }));
  mkdirSync(join(ff, 'projects')); mkdirSync(join(ff, 'sessions'));
  const ffEvents = join(ff, 'events.jsonl');
  const add = (e) => appendFileSync(ffEvents, JSON.stringify({ at: iso(Date.now()), ...e }) + '\n');
  const told = () => { const before = lines(SENT).length; tick(ffCfg); return lines(SENT).slice(before); };
  add({ kind: 'trim-failed', lane: 'fable', alarm: true, cause: 'from before the watch first read' });
  check('fold failure: the first read starts at the end, so nothing old is told', told().length, 0);
  add({ kind: 'trim-failed', lane: 'fable', session: 's-f1', alarm: true, cause: 'trim: OUTPUT CHECK FAILED, nothing written. 1 kept entries point at a parent that is not in the tail' });
  let sent = told();
  check('fold failure: a refused trim is told once, as itself', sent.map((m) => [m.kind, m.lane, m.title]), [['trim-failed', 'fable', 'Fold refused']]);
  check('fold failure: the notify command gets trim\'s own reason, without its prefix', sent[0]?.cause, '1 kept entries point at a parent that is not in the tail');
  add({ kind: 'orphan-fold-failed', lane: 'fable', exit: 1, alarm: true });
  check('fold failure: the orphan fold failing on the same trim is the same episode, not told again', told().length, 0);
  add({ kind: 'orphan-fold-failed', lane: 'opus', exit: 1, alarm: true });
  sent = told();
  check('fold failure: another lane\'s failure is its own episode', sent.map((m) => [m.kind, m.lane, m.title]), [['orphan-fold-failed', 'opus', 'Emergency fold failed']]);
  check('fold failure: an orphan fold\'s cause is its exit', sent[0]?.cause, 'exit 1');
  add({ kind: 'folded', lane: 'fable', tail: 't' });
  add({ kind: 'trim-failed', lane: 'fable', alarm: true, cause: 'x' });
  check('fold failure: after a good fold, the next refusal is told', told().map((m) => m.lane), ['fable']);
  // A lane rescued by hand (a confirmed wake into a new session) ends its episode as its card ends (Fable's read on #34).
  add({ kind: 'wake-confirmed', lane: 'fable' });
  add({ kind: 'trim-failed', lane: 'fable', alarm: true, cause: 'w' });
  check('fold failure: after a confirmed wake, the next refusal is told', told().map((m) => m.lane), ['fable']);
  // opus's episode ends first, so the half-written failure is new news and must be told once it's whole
  // (read early, it would be skipped as unparseable and lost: the offset moves past it).
  add({ kind: 'orphan-fold-done', lane: 'opus' });
  const half = JSON.stringify({ at: iso(Date.now()), kind: 'trim-failed', lane: 'opus', alarm: true, cause: 'z' });
  appendFileSync(ffEvents, half.slice(0, 20));
  check('fold failure: a line still being written waits for its end', told().length, 0);
  appendFileSync(ffEvents, half.slice(20) + '\n');
  check('fold failure: and is told once it ends', told().map((m) => m.lane), ['opus']);
  writeFileSync(ffEvents, JSON.stringify({ at: iso(Date.now()), kind: 'orphan-fold-done', lane: 'opus' }) + '\n' + JSON.stringify({ at: iso(Date.now()), kind: 'trim-failed', lane: 'opus', alarm: true, cause: 'y' }) + '\n');
  check('fold failure: a stream that shrank is read from its start', told().map((m) => m.lane), ['opus']);
}

// A passing run leaves nothing behind; a failing one keeps its scratch hub
// to look at (Ra, 10/11: tests clean up after themselves).
if (fail) console.log(`${pass} passed, ${fail} failed  (scratch kept: ${root})`);
else { rmSync(root, { recursive: true, force: true }); console.log(`${pass} passed, ${fail} failed`); }
process.exit(fail ? 1 : 0);
