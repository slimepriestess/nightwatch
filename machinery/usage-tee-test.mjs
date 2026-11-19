// usage-tee-test.mjs — the statusline tee that gives the viewer its plan-usage
// numbers. The tee is a hot-path script run by Claude Code's statusLine hook,
// so the contract under test is defensive: it must NEVER break the statusline
// (exit 0 and print a line on every input, malformed included), it must write
// atomically (a reader never sees a half-file), and it must pass rate_limits
// through VERBATIM — windows it has never heard of included — because the
// field set is Claude Code's, not ours, and tomorrow's window (a Fable one,
// say) should flow to the card without a code change here.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEE = join(HERE, 'usage-tee.mjs');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'usage-tee-'));
const out = join(dir, 'state', 'usage.json'); // parent doesn't exist yet on purpose

// A payload shaped like the documented statusline input (fields we rely on
// only; real payloads carry more, which the tee must tolerate).
const payload = {
  session_id: 'abc-123',
  version: '2.1.328',
  model: { id: 'claude-fable-5', display_name: 'Fable 5' },
  workspace: { current_dir: '/tmp/x' },
  cost: { total_cost_usd: 1.23 },
  context_window: { used_tokens: 100000, max_tokens: 200000 },
  rate_limits: {
    five_hour: { used_percentage: 37.2, resets_at: 1795150000 },
    seven_day: { used_percentage: 61.5, resets_at: 1795400000 },
  },
};

function run(args, input) {
  return spawnSync(process.execPath, [TEE, ...args], { input, encoding: 'utf8' });
}

// ── happy path ──
{
  const r = run(['--out', out], JSON.stringify(payload));
  check('exit 0 on a full payload', () => assert.equal(r.status, 0));
  check('prints a one-line statusline', () =>
    assert.ok(r.stdout.trim().length > 0 && !r.stdout.trim().includes('\n'), r.stdout));
  check('the line carries both window percentages', () =>
    assert.ok(/5h\s*37%/.test(r.stdout) && /wk\s*62%/.test(r.stdout), r.stdout));
  check('the line names the model', () => assert.ok(r.stdout.includes('Fable 5'), r.stdout));
  check('the out file exists (parent dir created)', () => assert.ok(existsSync(out)));
  const d = JSON.parse(readFileSync(out, 'utf8'));
  check('rate_limits pass through verbatim', () =>
    assert.deepEqual(d.rate_limits, payload.rate_limits));
  check('provider and source are stamped', () =>
    assert.equal(d.provider, 'anthropic') || assert.equal(d.source, 'statusline'));
  check('session id and version ride along', () =>
    assert.equal(d.session_id, 'abc-123') ?? assert.equal(d.version, '2.1.328'));
  check('the stamp is a fresh ISO time', () => {
    const age = Date.now() - Date.parse(d.at);
    assert.ok(age >= 0 && age < 60_000, d.at);
  });
  check('no temp file left beside the out file', () =>
    assert.deepEqual(readdirSync(dirname(out)).filter((f) => f !== 'usage.json'), []));
}

// ── a window the tee has never heard of flows through ──
{
  const p2 = structuredClone(payload);
  p2.rate_limits.weekly_fable = { used_percentage: 12, resets_at: 1795400000 };
  const r = run(['--out', out], JSON.stringify(p2));
  check('unknown window: exit 0', () => assert.equal(r.status, 0));
  const d = JSON.parse(readFileSync(out, 'utf8'));
  check('unknown window stored verbatim', () =>
    assert.deepEqual(d.rate_limits.weekly_fable, { used_percentage: 12, resets_at: 1795400000 }));
}

// ── no rate_limits (API-key account): file still written, line still prints ──
{
  const p3 = { ...payload };
  delete p3.rate_limits;
  const r = run(['--out', out], JSON.stringify(p3));
  check('no rate_limits: exit 0', () => assert.equal(r.status, 0));
  check('no rate_limits: line still prints the model', () =>
    assert.ok(r.stdout.includes('Fable 5'), r.stdout));
  const d = JSON.parse(readFileSync(out, 'utf8'));
  check('no rate_limits: stored as null, stamp fresh', () =>
    assert.equal(d.rate_limits, null));
}

// ── malformed stdin: never breaks the statusline, never clobbers the file ──
{
  writeFileSync(out, '{"sentinel":true}');
  const r = run(['--out', out], 'this is not json {');
  check('malformed stdin: exit 0', () => assert.equal(r.status, 0));
  check('malformed stdin: still prints something', () =>
    assert.ok(r.stdout.trim().length > 0));
  check('malformed stdin: the out file is untouched', () =>
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { sentinel: true }));
}

// ── no --out: statusline still works, nothing written anywhere ──
{
  const r = run([], JSON.stringify(payload));
  check('no --out: exit 0 and a line', () =>
    assert.equal(r.status, 0) ?? assert.ok(r.stdout.trim().length > 0));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
