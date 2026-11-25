// Leg 4: a codex plan's windows (codexlane.mjs codexUsageOf), read from REAL rollouts written by codex-cli 0.171.0
// (testdata/codex/*.jsonl, scrubbed; their token_count rows keep rate_limits whole). The watch writes what this returns
// to paths.usageCodex; watch-test.mjs's codex block runs that end to end. No codex runs here and nothing is spent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexUsageOf } from './codexlane.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'codex');
const rows = (f) => readFileSync(join(FX, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}  ${e.message}`); }
}
const tc = (rl, ts = '2026-11-25T00:00:00.000Z') => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });

check('a real rollout: the newest token_count\'s windows, in usage.json\'s schema, tagged openai', () => {
  assert.deepEqual(codexUsageOf(rows('witness-good.jsonl')), {
    at: '2026-11-25T21:54:57.785Z', provider: 'openai', source: 'rollout', plan_type: 'plus',
    rate_limits: { five_hour: { used_percentage: 2, resets_at: 1795661041 }, seven_day: { used_percentage: 1, resets_at: 1796066226 } },
  });
});

check('the newest reading wins over an older one in the same file', () => {
  const r = [...rows('two-turns.jsonl'), tc({ primary: { used_percent: 55, window_minutes: 300, resets_at: 1 } }, '2026-11-26T00:00:00.000Z')];
  const u = codexUsageOf(r);
  assert.equal(u.at, '2026-11-26T00:00:00.000Z');
  assert.deepEqual(u.rate_limits, { five_hour: { used_percentage: 55, resets_at: 1 } });
});

check('a token_count without windows is passed over for an older one that has them', () => {
  const r = [...rows('two-turns.jsonl'), tc(null), tc({ limit_id: 'codex' })];
  assert.equal(codexUsageOf(r).at, '2026-11-23T20:10:45.158Z');
});

check('a window of another length keeps its own name, never a guessed one', () => {
  const u = codexUsageOf([tc({ primary: { used_percent: 7, window_minutes: 1440, resets_at: 9 } })]);
  assert.deepEqual(u.rate_limits, { '1440m': { used_percentage: 7, resets_at: 9 } });
});

check('no token_count at all is null, not an empty reading', () => {
  assert.equal(codexUsageOf(rows('two-turns.jsonl').filter((r) => r.payload?.type !== 'token_count')), null);
  assert.equal(codexUsageOf([]), null);
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
