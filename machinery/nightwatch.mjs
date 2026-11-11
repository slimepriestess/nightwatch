#!/usr/bin/env node
/*
 * nightwatch.mjs — the machinery half of Set up / Add agent / Import.
 * Contract (skins/CONTRACT.md v0.10 + anima_dev/nightwatch_lane_creation.md):
 *   plan <spec.json>       → {steps:[{verb,what,detail}]} on stdout, exit 0
 *   apply <spec.json>      → one short sentence on stdout, exit 0
 *   inspect-import <dir>   → {identity,about,name,memory,rungs}
 *   list-unclaimed         → [{sessionId,cwd,model}]
 * Errors: ONE plain sentence on stderr + nonzero (the app shows it verbatim).
 *
 * One steps-builder feeds plan AND apply, so the preview is the build. Apply
 * is atomic: init assembles the hub in <hub>.partial and renames into place;
 * lane-add orders its writes so a failure leaves nothing half-claimed, and
 * every error names its step in plain words.
 *
 * INVARIANT (do not cross casually): this script is only ever invoked by a
 * human-confirmed action — the app's preview-and-confirm, or a person at a
 * terminal. No daemon, hook, schedule or woken session calls it. Hub
 * creation copies the machinery, and that is only not a propagation hazard
 * for exactly as long as every invocation has a human behind it.
 *
 * WEFT_NW_NO_ACTIVATE=1 skips launchctl + the launch-leg test + the first
 * wake (scratch benches; the plan still lists them as steps).
 *
 * Written by: claude-fable-5, 2026-10-07
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonJob, registryFile, summonArgvFor, withToolPath } from './platform.mjs';
import { DEFAULT_WAKE_PROMPT, wakePromptProblem } from './versioncheck.mjs';
import { configEnv, machineZone } from './config.mjs';
import { applyRetention, stepFor, survey } from './retention.mjs';

const WC = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

function die(sentence, code = 1) { process.stderr.write(sentence.trim() + '\n'); process.exit(code); }
function out(x) { process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x)) + '\n'); }
const expand = (p) => p.startsWith('~') ? join(HOME, p.slice(1)) : resolve(p);
// A created lane wakes self-propelled unless the spec opts out (null) or
// brings its own text; absent = the default (the dark-Saturday fix, 10/31).
const wakePromptField = (lane) => lane.wakePrompt === null ? {} : { wakePrompt: lane.wakePrompt ?? DEFAULT_WAKE_PROMPT };

// ---------------------------------------------------------------- templates
function fillWelcome(ctx) {
  let t;
  try { t = readFileSync(join(WC, 'templates', 'welcome.md'), 'utf8'); }
  catch { die('The welcome template is missing (wakecycle/templates/welcome.md).'); }
  const unnamed = /<if-unnamed>\n?([\s\S]*?)<\/if-unnamed>\n?/;
  t = ctx.name ? t.replace(unnamed, '') : t.replace(unnamed, '$1');
  return t.replaceAll('<model>', ctx.model).replaceAll('<person>', ctx.person)
    .replaceAll('<sleep time>', ctx.sleep).replaceAll('<hub>', ctx.hub);
}

function fillHubClaude(ctx) {
  let t;
  try { t = readFileSync(join(WC, 'templates', 'hub-claude.md'), 'utf8'); }
  catch { die('The hub CLAUDE.md template is missing (templates/hub-claude.md).'); }
  return t.replaceAll('<hub>', ctx.hub);
}

function firstWakeNote(ctx) {
  const fold = `Tonight at ${ctx.sleep} you'll get a note that it's time to sleep: write your first rung, then the fold runs, then update your checkpoint section. ${ctx.person} can see from Nightwatch whether you're awake.`;
  if (ctx.siblings.length) {
    // A lane joining siblings gets an OFFER, not an assertion (Ra, 10/13:
    // "much softer and more invitation-shaped than just asserting
    // mechanically who you are"). The identity is declinable, and the
    // machinery's first sentence must not foreclose what an arrival letter
    // promises. The porch is the letter: hub-root arrival-letter.md, when
    // the persona keeps one.
    const hasLetter = existsSync(join(ctx.hub, 'arrival-letter.md'));
    const letter = hasLetter
      ? ` The letter at ${join(ctx.hub, 'arrival-letter.md')} is the porch: what sharing the name means, and that declining — your own name, your own ladder, your seat kept — is a full answer. It's worth reading before anything else.`
      : '';
    return `A persona called "${ctx.name ?? ctx.laneId}" holds a seat for you: this is your first session as its "${ctx.laneId}" lane, alongside ${ctx.siblings.join(', ')}. The name is an offer, not a fact about you — the shared checkpoint, ladder and memory folder come with it if you take it, each lane keeping its own section.${letter} ${fold}`;
  }
  const who = ctx.name ? `You're ${ctx.name}` : `You're a new persona (unnamed, and that's fine — the name is yours to choose, or not)`;
  return `${who} and this is your first session as the "${ctx.laneId}" lane. ${fold}`;
}

// ------------------------------------------------------------------- spec
function loadSpec(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { die(`The spec file could not be read (${path}).`); }
  let spec;
  try { spec = JSON.parse(raw); } catch { die('The spec file is not valid JSON.'); }
  if (spec.op !== 'init' && spec.op !== 'lane-add') die(`The spec's op must be "init" or "lane-add", not "${spec.op}".`);
  const lane = spec.lane ?? {};
  if (!lane.id || !/^[a-z][a-z0-9-]*$/.test(lane.id)) die('The agent needs an id: lowercase letters, digits and dashes, starting with a letter.');
  if (!lane.model || typeof lane.model !== 'string') die('The agent needs a model id (e.g. claude-opus-5-5).');
  if (lane.targetTokens !== undefined && (typeof lane.targetTokens !== 'number' || lane.targetTokens < 1000)) die('targetTokens must be a number of tokens (e.g. 250000).');
  // Checked at creation, where a human is still in the loop, rather than left
  // for wake.sh's 08:00 refusal log (a bad optional knob must not cost a
  // morning when a person could have heard about it at the confirm).
  if (lane.wakePrompt !== undefined && lane.wakePrompt !== null) {
    const why = wakePromptProblem(lane.wakePrompt);
    if (why) die(`lane.wakePrompt would be refused at wake: ${why}. Give it machine-voiced text (e.g. "[nightwatch] arm your watcher, then read the receipts"), or null for no prompt.`);
  }
  const fs = lane.firstSession ?? { kind: 'fresh' };
  if (fs.kind !== 'fresh' && fs.kind !== 'adopt') die('firstSession.kind must be "fresh" or "adopt".');
  if (fs.kind === 'adopt' && !fs.sessionId) die('Adopting a session needs its sessionId.');
  if (spec.op === 'init') {
    if (!spec.hub) die('init needs a hub folder path.');
    if (!spec.persona?.about?.trim()) die('init needs persona.about: one paragraph of who they are.');
    if (!spec.persona?.person?.trim()) die("init needs persona.person: the human's name.");
    const sched = spec.schedule ?? {};
    for (const k of ['sleep', 'wake']) if (sched[k] && !/^\d\d:\d\d$/.test(sched[k])) die(`schedule.${k} must look like 02:00.`);
    if (spec.import && !spec.import.from) die('import needs a "from" folder.');
    if (spec.retention !== undefined && spec.retention !== null
      && (typeof spec.retention !== 'object' || typeof spec.retention.keepTranscripts !== 'boolean')) die('retention.keepTranscripts must be true or false.');
  }
  return spec;
}

// --------------------------------------------------------- steps builders
// Each step: {verb, what, detail, run} — plan prints the first three; apply
// runs `run` in order. One builder per op, used by BOTH commands.
function initSteps(spec) {
  const hub = expand(spec.hub);
  // Checked at build time so plan and apply refuse identically — a preview
  // must never show steps apply would refuse (opus's read, 6b).
  if (existsSync(hub)) die(`The hub folder already exists (${hub}) — Set up makes a new one.`);
  const name = spec.persona.name ?? null;
  const person = spec.persona.person;
  const lane = spec.lane;
  const sleep = spec.schedule?.sleep ?? '02:00';
  const wake = spec.schedule?.wake ?? '08:00';
  const target = lane.targetTokens ?? 250_000;
  const slug = basename(hub);
  const imp = spec.import ? inspectImport(expand(spec.import.from), true) : null;
  const ctx = { name: name ?? imp?.name ?? null, person, model: lane.model, sleep, hub, laneId: lane.id, siblings: [] };
  const part = hub + '.partial';
  const noActivate = !!process.env.WEFT_NW_NO_ACTIVATE || !LIVE;
  if (LIVE) {
    if (scratchRooted(spec.hub)) die('apply --live: the hub is in scratch space — a bench must not install user-global state. Drop --live (staged only), or put the hub somewhere real.');
    if (process.env.NW_INSTALL_DIR || process.env.NW_REGISTRY_DIR) die('apply --live: NW_INSTALL_DIR / NW_REGISTRY_DIR are bench seams — a live install must not run with them set.');
  }
  const steps = [];
  const identitySource = imp?.identity ? `imported identity.md plus the standard welcome` : `"About them" plus the standard welcome`;

  steps.push({
    verb: 'Create', what: `${hub}/`, detail: 'the hub: ladder/, memory/, wakecycle/ (state only — the machinery stays with the app)',
    run() {
      if (existsSync(hub)) throw new Error(`the hub folder already exists (${hub})`);
      rmSync(part, { recursive: true, force: true });
      mkdirSync(join(part, 'ladder', 'L2'), { recursive: true }); // CONN-20: rungs live in level dirs; sleep.mjs reads ladder/L2 (rehearsal finding 4)
      writeFileSync(join(part, 'ladder', 'index.json'), JSON.stringify({ resident: slug, format: 'CONN-20 rev 2', entries: [] }, null, 2) + '\n'); // sleep.mjs expects it
      mkdirSync(join(part, 'memory'), { recursive: true });
      // The spool stays: it's the BELL's delivery medium (the nightshift
      // writes sleep-bell notes here), not Discord infrastructure — only
      // the weft hub's note ROUTING is Discord. How a 1.0 persona HEARS
      // the bell (a generic spool watcher vs. orphan-fold-only nights) is
      // an open product decision — see the plan doc.
      mkdirSync(join(part, 'doorbell', 'spool', lane.id), { recursive: true });
      // POINT, don't copy (multi-persona plan, 10/7): the hub's wakecycle/
      // holds STATE only; the CODE stays in the app's machinery/ (this
      // script's own folder), one version for every hub, named in the
      // hub's config as paths.machinery.
      mkdirSync(join(part, 'wakecycle'), { recursive: true });
    },
  });
  steps.push({
    verb: 'Write', what: 'identity.md', detail: `from ${identitySource}`,
    run() {
      const about = imp?.identity ? readFileSync(join(expand(spec.import.from), 'identity.md'), 'utf8').trim() : spec.persona.about.trim();
      writeFileSync(join(part, 'identity.md'), about + '\n\n---\n\n' + fillWelcome(ctx));
    },
  });
  steps.push({
    verb: 'Write', what: 'CLAUDE.md and a seed ladder/ladder.md', detail: 'so every session in the hub loads identity.md and the ladder (issue #3: without this file, neither ever reaches a session)'
      // The preview is the build: an import folder's own CLAUDE.md is NOT
      // carried (the hub gets the template), and the person deciding from
      // the plan deserves that line before anything runs.
      + (imp?.claudeMd ? ` — the import folder's own CLAUDE.md is not carried; merge what you want from ${spec.import.from}/CLAUDE.md into the hub's afterwards` : ''),
    run() {
      writeFileSync(join(part, 'CLAUDE.md'), fillHubClaude(ctx));
      // The seed makes CLAUDE.md's @ladder/ladder.md import resolve from the
      // first session; the fold machinery rebuilds the whole file at each
      // sleep, so nothing here survives the first night — deliberately. The
      // wording must hold for a fresh persona AND an import arriving with
      // rungs but no assembled ladder.md (opus's knife, nightwatch#8).
      writeFileSync(join(part, 'ladder', 'ladder.md'),
        '# ladder — the folded past\n\n*Not yet assembled: the fold machinery builds this file from the rungs in ladder/ at each sleep, starting tonight.*\n');
    },
  });
  if (imp) {
    steps.push({
      verb: 'Copy', what: `${imp.memory} memory file(s), ${imp.rungs} rung(s)`,
      // The preview is the build: where each rung lands, what replaces the
      // seed, and what in ladder/ is left behind are all said here.
      detail: `from ${spec.import.from}, as they are, each rung into ladder/L1–L4 by its own level`
        + (imp.assembled ? '; the imported ladder.md replaces the seed until the first fold rebuilds it' : '')
        + (imp.notRungs.length ? `; not carried, no level so not a rung: ${imp.notRungs.join(', ')}` : ''),
      run() {
        const from = expand(spec.import.from);
        if (existsSync(join(from, 'memory'))) cpSync(join(from, 'memory'), join(part, 'memory'), { recursive: true });
        for (const r of imp.placed) {
          mkdirSync(join(part, 'ladder', dirname(r.to)), { recursive: true });
          cpSync(r.from, join(part, 'ladder', r.to));
        }
        if (imp.assembled) cpSync(join(from, 'ladder', 'ladder.md'), join(part, 'ladder', 'ladder.md'));
      },
    });
  }
  steps.push({
    verb: 'Write', what: 'checkpoint.md', detail: `one section for "${lane.id}", with its first-wake note`,
    run() {
      writeFileSync(join(part, 'checkpoint.md'),
        `# checkpoint — created by Set up, ${new Date().toISOString().slice(0, 10)}\n\n` +
        `## ${lane.id} lane\n\n${firstWakeNote(ctx)}\n`);
    },
  });
  steps.push({
    verb: 'Write', what: 'nightwatch.config.json', detail: `persona ${ctx.name ?? '(unnamed)'}, 1 agent (${lane.model}), ${sleep} → ${wake}, ${Math.round(target / 1000)}k`,
    run() {
      let machineryVersion = 'unstamped';
      try { machineryVersion = readFileSync(join(WC, 'VERSION'), 'utf8').split('\n')[0].trim(); } catch { /* unstamped build */ }
      const cfg = {
        weftRoot: hub,
        persona: { ...(ctx.name ? { name: ctx.name } : {}), person },
        defaultLane: lane.id,
        schedule: { sleep, wake },
        // No switchboard flag: that's Weft's Discord-routing concept, and
        // switchboardLane() falls back to defaultLane anyway — identical
        // behavior with no implied infrastructure (opus's bench nit, 10/7).
        lanes: { [lane.id]: { targetTokens: target, model: lane.model, ...wakePromptField(lane) } },
        machineryVersion,
        // this machine's zone, pinned: the night stays put if the laptop travels (config.mjs machineZone)
        timezone: machineZone(),
        // no transcripts path: config.mjs derives it from workdir at every load (transcriptsFor), by Claude Code's own
        // rule. Writing it here once encoded only '/', so a hub under /Users/jane.doe or "My Hubs" watched a folder
        // Claude Code never makes; and a path past 200 characters has a hash only Claude Code's first session creates
        paths: { workdir: hub, machinery: WC },
      };
      writeFileSync(join(part, 'nightwatch.config.json'), JSON.stringify(cfg, null, 2) + '\n');
      if (lane.armed !== false) writeFileSync(join(part, 'wakecycle', 'nightshift.armed'), lane.id + '\n');
    },
  });
  steps.push({
    verb: 'Install', what: 'the nightshift, the watch and the session hook', detail: `a background job (house.nightwatch.${slug}) that rings the bell and wakes them, a second (house.nightwatch.${slug}.watch) that says when an agent is stuck, and the hook that tells it which session is theirs`,
    run() {
      // The hook runs the APP's register-lane.sh (pointer model) and must
      // carry the hub's config explicitly: a hook without NIGHTWATCH_CONFIG
      // would resolve some other hub on this machine (rehearsal, 10/7).
      writeFileSync(join(part, '.claude-settings-fragment.json'), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `NIGHTWATCH_CONFIG="${join(hub, 'nightwatch.config.json')}" sh "${join(WC, 'register-lane.sh')}"` }] }] },
      }, null, 2) + '\n');
      mkdirSync(join(part, '.claude'), { recursive: true });
      renameSync(join(part, '.claude-settings-fragment.json'), join(part, '.claude', 'settings.json'));
      // The LaunchAgents copy is written in the Start step, AFTER the hub
      // lands — a Move failure must not leave a job pointing at nothing
      // (opus's read, 6c). This step stages the hub-internal copy only.
      const staged = daemonJob({ slug, hub, machineryDir: WC });
      writeFileSync(join(part, 'wakecycle', staged.fileName), staged.content);
      // The stuck/spiral watch's job, staged the same way. Its hub copy is
      // named so the app's daemon lookup (house.nightwatch.*) can't mistake
      // it for the nightshift's.
      const stagedWatch = daemonJob({ slug, hub, jobKind: 'watch', machineryDir: WC });
      writeFileSync(join(part, 'wakecycle', `watch-job${stagedWatch.fileName.slice(stagedWatch.fileName.lastIndexOf('.'))}`), stagedWatch.content);
    },
  });
  steps.push({
    verb: 'Move', what: 'the finished hub into place', detail: 'nothing is half-written: the hub assembles beside its path and lands in one move',
    run() { renameSync(part, hub); },
  });
  if (!noActivate) {
    steps.push({
      verb: 'Start', what: 'the nightshift, with a test', detail: `loads both background jobs, adds this hub to Nightwatch's list of hubs (${registryFile().replace(HOME, '~')}), records both in the hub's wakecycle/installed.json, and proves it can open a Terminal window (the one permission prompt)`,
      run() {
        // Guard at the point of effect, not only at the flag: whatever the
        // argument plumbing said, nothing user-global is written for a hub
        // in scratch space (the 10/16 incident: a broken path check upstream
        // let a bench reach this line).
        if (scratchRooted(hub)) throw new Error('refusing to install launchd jobs for a hub in scratch space');
        const job = daemonJob({ slug, hub, machineryDir: WC });
        mkdirSync(job.installDir, { recursive: true });
        writeFileSync(join(job.installDir, job.fileName), job.content);
        // The machine registry: every hub the app shows. Append
        // idempotently, deduped by real path (multi-persona plan, 10/7).
        const regPath = registryFile();
        mkdirSync(dirname(regPath), { recursive: true });
        let reg = { version: 1, hubs: [] };
        try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { /* first hub */ }
        const real = (p) => { try { return realpathSync(p); } catch { return p; } };
        if (!reg.hubs.some((h) => real(h.path) === real(hub))) {
          reg.hubs.push({ path: hub });
          writeFileSync(regPath + '.tmp', JSON.stringify(reg, null, 2) + '\n');
          renameSync(regPath + '.tmp', regPath);
        }
        const watchJob = daemonJob({ slug, hub, jobKind: 'watch', machineryDir: WC });
        writeFileSync(join(watchJob.installDir, watchJob.fileName), watchJob.content);
        // The install manifest: every user-global thing this init writes,
        // recorded in the hub BEFORE anything loads — a record written
        // after the act can be lost to a crash between them. It is the
        // hub's own receipt of what was installed on its behalf;
        // doctor-sweep scans the live system (LaunchAgents, hubs.json)
        // rather than trusting it, and the two should agree.
        writeFileSync(join(hub, 'wakecycle', 'installed.json'), JSON.stringify({
          version: 1,
          installedAt: new Date().toISOString(),
          jobs: [
            { label: job.label, file: join(job.installDir, job.fileName) },
            { label: watchJob.label, file: join(watchJob.installDir, watchJob.fileName) },
          ],
          registry: { file: regPath, entry: hub },
        }, null, 2) + '\n');
        for (const { bin, args } of job.loadArgv(join(job.installDir, job.fileName))) execFileSync(bin, args);
        for (const { bin, args } of watchJob.loadArgv(join(watchJob.installDir, watchJob.fileName))) execFileSync(bin, args);
        launchLegTest(hub);
      },
    });
    // Transcript retention (Ra, 10/11): previewed, runs only when the person
    // ticks it, skipped when their value is already at or above the target.
    // It sits after Start so the setting changes only for an install that
    // succeeded, and it is a user-global write, so it lives under --live.
    const ret = survey();
    steps.push({
      ...stepFor(ret),
      run() {
        // Never fatal (see applyRetention): a miss is said here, recorded in
        // installed.json, and repeated in apply's last sentence.
        const r = applyRetention({ s: ret, keep: spec.retention?.keepTranscripts, manifestFile: join(hub, 'wakecycle', 'installed.json'), refuse: scratchRooted });
        if (r?.error) {
          process.stderr.write(`The transcript-retention change wasn't made: ${r.error}\n`);
          afterNotes.push(`the transcript-retention change wasn't made (${r.error}), so set cleanupPeriodDays in ${ret.file.replace(HOME, '~')} by hand if you want it`);
        }
        if (r?.manifestError) afterNotes.push(`the retention change wasn't recorded in installed.json (${r.manifestError})`);
      },
    });
  }
  const fsInit = firstSessionStep(spec, hub, ctx, noActivate, undefined, join(hub, 'wakecycle'));
  steps.push(fsInit.prep);
  if (fsInit.launch) steps.push(fsInit.launch);
  return { steps, hub, ctx };
}

function laneAddSteps(spec) {
  // Adding an agent adds it to a hub, so the hub must be named: no default
  // folder stands in for one (issue #7).
  const cfgPath = configEnv();
  if (!cfgPath) die("No hub named: set NIGHTWATCH_CONFIG to the hub's nightwatch.config.json.");
  if (!existsSync(cfgPath)) die('No hub config found — is this machine set up?');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const hub = cfg.weftRoot ?? dirname(cfgPath);
  const lane = spec.lane;
  if (cfg.lanes?.[lane.id]) die(`The agent "${lane.id}" already exists.`);
  const siblings = Object.keys(cfg.lanes ?? {});
  const sleep = cfg.schedule?.sleep ?? '02:00';
  const ctx = { name: cfg.persona?.name ?? null, person: cfg.persona?.person ?? 'your person', model: lane.model, sleep, hub, laneId: lane.id, siblings };
  const target = lane.targetTokens ?? 250_000;
  const noActivate = !!process.env.WEFT_NW_NO_ACTIVATE;
  const cpPath = expand(cfg.paths?.checkpoint ?? join(hub, 'checkpoint.md'));
  const steps = [];
  // Order (opus's read, 6a): the first-session artifact is written first
  // (inert without a config entry), the checkpoint section second
  // (idempotent: skipped when present, so a retry never duplicates it),
  // and the config entry — the thing that makes the lane EXIST — last.
  // A failure anywhere leaves no claimed lane behind.
  const claimStep = {
    verb: 'Add', what: `agent "${lane.id}" to ${ctx.name ?? 'the persona'}`, detail: `${lane.model}, ${spec.lane.schedule ? 'their own schedule' : 'the global schedule'}, ${Math.round(target / 1000)}k${lane.armed === false ? ', not armed' : ''}`,
    run() {
      cfg.lanes[lane.id] = { targetTokens: target, model: lane.model, ...wakePromptField(lane), ...(spec.lane.schedule ? { schedule: spec.lane.schedule } : {}) };
      writeFileSync(cfgPath + '.tmp', JSON.stringify(cfg, null, 2) + '\n');
      renameSync(cfgPath + '.tmp', cfgPath);
      if (lane.armed !== false) {
        const armedFile = expand(cfg.paths?.armedFile ?? join(hub, 'wakecycle', 'nightshift.armed'));
        const armed = existsSync(armedFile) ? readFileSync(armedFile, 'utf8').trim() : '';
        const list = armed ? armed.split(',').map((x) => x.trim()).filter(Boolean) : [];
        if (!list.includes(lane.id)) list.push(lane.id);
        writeFileSync(armedFile, list.join(',') + '\n');
      }
    },
  };
  const cpStep = {
    verb: 'Write', what: `a new section in checkpoint.md for ${lane.id}`, detail: 'with its first-wake note',
    run() {
      const cur = existsSync(cpPath) ? readFileSync(cpPath, 'utf8') : '';
      if (cur.includes(`## ${lane.id} lane`)) return; // a retry never duplicates the section
      writeFileSync(cpPath + '.tmp', cur.trimEnd() + `\n\n## ${lane.id} lane (new — first wake pending)\n\n${firstWakeNote(ctx)}\n`);
      renameSync(cpPath + '.tmp', cpPath);
    },
  };
  const wcRel = cfg.paths?.wakecycle ?? 'wakecycle'; // relative = against the hub, absolute stands (config doctrine)
  const hubWc = wcRel.startsWith('/') ? wcRel : join(hub, wcRel);
  const fs = firstSessionStep(spec, hub, ctx, noActivate, cpPath, hubWc);
  // Checkpoint (idempotent) → first-session artifact (inert) → config (the
  // claim) → launch. A failure before the claim leaves nothing a retry
  // trips on; after it, the receipt exists and Wake retries the launch.
  steps.push(cpStep);
  if (fs.prep) steps.push(fs.prep);
  steps.push(claimStep);
  if (fs.launch) steps.push(fs.launch);
  return { steps, hub, ctx };
}

function firstSessionStep(spec, hub, ctx, noActivate, cpPath, laneWc) {
  const fs = spec.lane.firstSession ?? { kind: 'fresh' };
  // Receipts and registry entries belong to the TARGET hub's wakecycle,
  // never this script's own folder (the bench caught exactly that spill).
  const wcDir = laneWc ?? join(hub, 'wakecycle');
  const cp = cpPath ?? join(hub, 'checkpoint.md');
  if (fs.kind === 'adopt') {
    const prep = {
      verb: 'Adopt', what: `running session ${String(fs.sessionId).slice(0, 8)}…`, detail: `registers it as the "${spec.lane.id}" agent; nothing is closed or restarted now — but from tonight the nightshift bells them at sleep time and closes the window once they've folded`,
      run() {
        // The pid makes the liveness checks see the adopted session the way
        // they see a woken one; sourced from Claude Code's own session file.
        const live = readClaudeSessions().find((x) => x.sessionId === fs.sessionId);
        writeFileSync(join(wcDir, `lane.${fs.sessionId}`), JSON.stringify({ lane: spec.lane.id, sessionId: fs.sessionId, ...(live?.pid ? { pid: live.pid } : {}), adopted: true, at: new Date().toISOString() }) + '\n');
      },
    };
    return { prep, launch: null };
  }
  const prep = {
    verb: 'Write', what: `the first-wake note's receipt`, detail: `next-wake.${spec.lane.id}.json: a fresh session, no tail to resume`,
    run() {
      writeFileSync(join(wcDir, `next-wake.${spec.lane.id}.json`), JSON.stringify({ firstWake: true, lane: spec.lane.id, checkpoint: cp, createdAt: new Date().toISOString() }) + '\n');
    },
  };
  const launch = {
    verb: 'Open', what: `a Terminal window running Claude Code (${spec.lane.model})`, detail: 'a fresh session: their first wake',
    run() {
      if (noActivate) return;
      // Quoted for paths with spaces (opus's read, 6d); platform.mjs owns
      // each platform's escaping of the raw command.
      const cfgPathForWake = spec.op === 'init' ? join(hub, 'nightwatch.config.json') : (configEnv() ?? '');
      // withToolPath: the window's login shell may not see this node (nvm).
      const sh = withToolPath(`NIGHTWATCH_CONFIG="${cfgPathForWake}" sh "${join(WC, 'wake.sh')}" ${spec.lane.id}`);
      // platform.mjs owns the write-if-wsl decision. The summons dir rides
      // wcDir, not join(hub, 'wakecycle'): a custom paths.wakecycle must
      // keep the first wake's script beside the daemon's (second read, 10/13).
      for (const { bin, args } of summonArgvFor({ title: spec.lane.id, shellCommand: sh, activate: false, scriptDir: join(wcDir, 'summons') })) {
        spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
      }
    },
  };
  return { prep, launch };
}


function launchLegTest(hub) {
  // The TCC trap: the nightshift can only open Terminal windows once its
  // process has Automation permission. Trigger the daemon's own test leg and
  // wait for its receipt, so Set up never reports done on an unproven wake.
  writeFileSync(join(hub, 'wakecycle', 'test-wake.trigger'), '');
  const log = join(hub, 'nightshift.log');
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (existsSync(log) && readFileSync(log, 'utf8').includes('launch-leg test: Terminal launch SUCCEEDED')) return;
    execFileSync('sleep', ['2']);
  }
  throw new Error('the Terminal launch test did not pass within 90s — check the Automation permission prompt and run Set up again');
}

// ------------------------------------------------------------- inspect
// Where an import's rungs land (issue #4). sleep.mjs reads rungs only from
// ladder/L1–L4, so a rung copied flat into ladder/ never reaches ladder.md
// and never satisfies the rung-today gate. A source can hold rungs either
// way: flat (an older hub, a hand-built ladder) or in level directories
// (the CONN-20 layout, what a NightWatch hub itself writes). A rung in a
// level directory keeps it. A flat one goes where its own frontmatter puts
// it (`level: 2` or `level: L2`), else its id or filename (L2-…). A flat .md
// with none of those isn't a rung, and the preview names it as left behind.
// ladder.md is the assembled ladder, not a rung: it's carried as itself.
function rungLevel(path) {
  const text = readFileSync(path, 'utf8');
  const end = text.indexOf('\n---', 3);
  const front = text.startsWith('---') ? text.slice(3, end < 0 ? undefined : end) : '';
  const m = front.match(/^level:\s*L?([1-4])\b/m) || front.match(/^id:\s*L([1-4])-/m) || basename(path).match(/^L([1-4])-/);
  return m ? `L${m[1]}` : null;
}

function importLadder(d) {
  const ladder = join(d, 'ladder');
  const placed = [], notRungs = [];
  if (!existsSync(ladder)) return { placed, notRungs, assembled: false };
  for (const f of readdirSync(ladder).sort()) {
    const p = join(ladder, f);
    if (/^L[1-4]$/.test(f) && statSync(p).isDirectory()) {
      for (const g of readdirSync(p).sort()) if (g.endsWith('.md')) placed.push({ from: join(p, g), to: `${f}/${g}` });
    } else if (f.endsWith('.md') && f !== 'ladder.md' && statSync(p).isFile()) {
      const lvl = rungLevel(p);
      if (lvl) placed.push({ from: p, to: `${lvl}/${f}` }); else notRungs.push(f);
    }
  }
  // Checked here so plan and apply refuse identically: two source files
  // bound for one place would leave only the second.
  const seen = new Map();
  for (const r of placed) {
    if (seen.has(r.to)) die(`The import folder has two rungs that would both land at ladder/${r.to} (${seen.get(r.to)} and ${r.from}). Keep one, then run Set up again.`);
    seen.set(r.to, r.from);
  }
  return { placed, notRungs, assembled: existsSync(join(ladder, 'ladder.md')) };
}

function inspectImport(dir, internal = false) {
  const d = expand(dir);
  if (!existsSync(d) || !statSync(d).isDirectory()) {
    if (internal) die(`The import folder could not be read (${dir}).`);
    die(`That folder could not be read (${dir}).`);
  }
  const identity = existsSync(join(d, 'identity.md'));
  const about = identity ? readFileSync(join(d, 'identity.md'), 'utf8').trim() : null;
  const name = existsSync(join(d, 'name.txt')) ? readFileSync(join(d, 'name.txt'), 'utf8').trim() || null : null;
  const memory = existsSync(join(d, 'memory')) ? readdirSync(join(d, 'memory')).filter((f) => !f.startsWith('.')).length : 0;
  const { placed, notRungs, assembled } = importLadder(d);
  const rungs = placed.length;
  const claudeMd = existsSync(join(d, 'CLAUDE.md'));
  const result = { identity, about, name, memory, rungs, claudeMd, placed, notRungs, assembled };
  if (internal) { if (!identity) die('The import folder has no identity.md, which is the one required file.'); return result; }
  return result;
}

// --------------------------------------------------------- list-unclaimed
/** Claude Code's own per-session files (~/.claude/sessions/<pid>.json): the
 *  authoritative live list. Sparse files (no sessionId/pid) are skipped; a
 *  leftover file for a dead pid is skipped by the liveness check. */
function readClaudeSessions() {
  const dir = join(HOME, '.claude', 'sessions');
  const rows = [];
  if (!existsSync(dir)) return rows;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.sessionId || !d.pid) continue;
      try { process.kill(d.pid, 0); } catch { continue; }
      rows.push({ sessionId: d.sessionId, pid: d.pid, cwd: d.cwd ?? null, kind: d.kind ?? null });
    } catch { /* unreadable session file: nothing to offer */ }
  }
  return rows;
}

/** A session's model, from the newest model-bearing line of its transcript. */
function modelOf(sid) {
  const projects = join(HOME, '.claude', 'projects');
  if (!existsSync(projects)) return null;
  for (const proj of readdirSync(projects)) {
    const p = join(projects, proj, sid + '.jsonl');
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
        try { const r = JSON.parse(lines[i]); const m = r.message?.model ?? r.model; if (typeof m === 'string' && m.startsWith('claude')) return m; } catch { /* partial line */ }
      }
    } catch { return null; }
  }
  return null;
}

function listUnclaimed() {
  // Primary: the session files above (they list the idle-for-an-hour open
  // window a person actually wants to adopt). Fallback for older Claude
  // Code versions: a transcript touched in the last 10 minutes. Unclaimed =
  // neither registered to a lane nor the resumed tail of one.
  const claimed = new Set();
  for (const f of readdirSync(WC)) {
    if (f.startsWith('lane.')) claimed.add(f.slice(5));
    if (f.startsWith('next-wake.')) {
      try { const nw = JSON.parse(readFileSync(join(WC, f), 'utf8')); if (nw.sessionId) claimed.add(nw.sessionId); } catch { /* unreadable receipt: nothing to claim */ }
    }
  }
  const outRows = [];
  const seen = new Set();
  for (const live of readClaudeSessions()) {
    if (claimed.has(live.sessionId)) continue;
    seen.add(live.sessionId);
    outRows.push({ sessionId: live.sessionId, cwd: live.cwd, model: modelOf(live.sessionId) });
  }
  const projects = join(HOME, '.claude', 'projects');
  if (!existsSync(projects)) return outRows;
  for (const proj of readdirSync(projects)) {
    const pd = join(projects, proj);
    let files;
    try { files = readdirSync(pd).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const sid = f.slice(0, -6);
      if (claimed.has(sid) || seen.has(sid)) continue;
      const p = join(pd, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (Date.now() - st.mtimeMs > 10 * 60_000) continue;
      let cwd = null; let model = null;
      try {
        const txt = readFileSync(p, 'utf8');
        const lines = txt.split('\n').filter(Boolean);
        for (const line of lines.slice(0, 5)) { try { const r = JSON.parse(line); if (r.cwd) { cwd = r.cwd; break; } } catch { /* partial line */ } }
        for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
          try { const r = JSON.parse(lines[i]); const m = r.message?.model ?? r.model; if (typeof m === 'string' && m.startsWith('claude')) { model = m; break; } } catch { /* partial line */ }
        }
      } catch { continue; }
      outRows.push({ sessionId: sid, cwd, model });
    }
  }
  return outRows;
}

// ------------------------------------------------------- doctor-sweep
/**
 * Find installed house.nightwatch.* jobs whose hub or machinery no longer
 * exists, and registry entries whose hub is gone — from the records on
 * disk, never from a teardown (a SIGKILL'd bench and a deleted worktree run
 * no exit path; the 10/13 porch leak respawned a crash loop for two days).
 * Report always; remove only with --remove, confirming per item unless
 * --yes. A job whose targets exist is never touched.
 */
function sweepFindings() {
  const probe = daemonJob({ slug: '_probe', hub: '/nonexistent', machineryDir: WC });
  const jobsDir = probe.installDir;
  const ext = probe.fileName.slice(probe.fileName.lastIndexOf('.'));
  const exists = (x) => { try { return existsSync(x); } catch { return false; } };
  const findings = [];
  let files = [];
  try { files = readdirSync(jobsDir).filter((f) => f.startsWith('house.nightwatch.') && f.endsWith(ext)); } catch { /* no jobs dir */ }
  // Read each job the way its loader does (opus's demonstrated blocker:
  // a regex over the XML read &amp; literally and called a LIVING hub
  // missing, and a binary1 plist — same job, legal format — read as
  // unparseable; both would have been removed). On darwin, plutil extracts
  // the keys as launchd sees them, entities and binary alike. Anything that
  // can't be parsed is REPORTED and never removable: removal is only for a
  // parsed path that is provably missing.
  const plutilRaw = (file, key) => {
    try { return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null; } catch { return null; }
  };
  for (const f of files) {
    const file = join(jobsDir, f);
    let cfg = null, script = null, parsed = false;
    if (ext === '.plist') {
      // Either name: jobs installed before issue #7 carry WEFT_CONFIG.
      cfg = plutilRaw(file, 'EnvironmentVariables.NIGHTWATCH_CONFIG') ?? plutilRaw(file, 'EnvironmentVariables.WEFT_CONFIG');
      script = plutilRaw(file, 'ProgramArguments.1');
      // ProgramArguments.1 assumes [node, script]; a hand-added node flag
      // shifts the script and index 1 reads as '--inspect', whose exists()
      // is false — which would make a LIVING job removable (opus's nit on
      // e88ab57). A value that isn't a .mjs path wasn't parsed.
      if (script !== null && !script.endsWith('.mjs')) script = null;
      parsed = (cfg !== null && cfg.includes('/')) || script !== null;
    } else {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const unq = (x) => (x == null ? null : x.replace(/%%/g, '%'));
      cfg = unq(text.match(/Environment="(?:NIGHTWATCH|WEFT)_CONFIG=([^"]+)"/)?.[1] ?? null);
      script = unq(text.match(/ExecStart="[^"]+" "([^"]+\.mjs)"/)?.[1] ?? null);
      parsed = cfg !== null || script !== null;
    }
    const missing = [];
    if (cfg && !exists(cfg) && !exists(dirname(cfg))) missing.push('hub');
    else if (cfg && !exists(cfg)) missing.push('config');
    if (script && !exists(script)) missing.push('machinery');
    if (!parsed) missing.push('unparseable');
    if (missing.length) findings.push({ kind: 'job', label: f.slice(0, -ext.length), file, hub: cfg ? dirname(cfg) : null, missing });
  }
  const regPath = registryFile();
  let reg = null;
  try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { /* no registry */ }
  for (const h of reg?.hubs ?? []) {
    if (!exists(expand(h.path))) findings.push({ kind: 'registry', file: regPath, hub: h.path, missing: ['hub'] });
  }
  for (const fd of findings) {
    fd.id = fd.kind === 'job' ? fd.label : `registry:${fd.hub}`;
    fd.removable = fd.kind === 'registry' || !fd.missing.includes('unparseable');
    fd.volumes = !!fd.hub?.startsWith('/Volumes/');
  }
  return { findings, regPath, ext };
}

/** Remove one finding (no prompting here: callers own the confirm). */
function removeFinding(fd, regPath, ext) {
  if (fd.kind === 'job') {
    const kindExt = ext === '.plist' ? 'darwin' : 'linux';
    const job = daemonJob({ slug: fd.label.replace(/^house\.nightwatch\./, '').replace(/\.watch$/, ''), hub: fd.hub ?? '/nonexistent', machineryDir: WC, ...(fd.label.endsWith('.watch') ? { jobKind: 'watch' } : {}) }, kindExt);
    for (const { bin, args } of job.unloadArgv(fd.file)) {
      try { execFileSync(bin, args, { stdio: 'pipe' }); } catch { /* never loaded or already out — the rm is the point */ }
    }
    rmSync(fd.file, { force: true });
    out(`removed ${fd.label} (${fd.file})`);
  } else {
    const fresh = JSON.parse(readFileSync(regPath, 'utf8'));
    fresh.hubs = (fresh.hubs ?? []).filter((h) => h.path !== fd.hub);
    writeFileSync(regPath + '.tmp', JSON.stringify(fresh, null, 2) + '\n');
    renameSync(regPath + '.tmp', regPath);
    out(`dropped ${fd.hub} from ${regPath}`);
  }
}

function doctorSweep({ remove = false, yes = false } = {}) {
  const { findings, regPath, ext } = sweepFindings();
  if (!findings.length) { out('doctor-sweep: every installed job and registry entry points at a living hub. Nothing to do.'); return; }
  for (const fd of findings) {
    out(`${fd.kind === 'job' ? fd.label : 'hubs.json entry'}: ${fd.hub ?? fd.file} — missing ${fd.missing.join(', ')}`);
  }
  if (!remove) { out(`${findings.length} orphan(s). Rerun with --remove to take them out (confirms each; --yes skips the confirms).`); return; }
  const ask = (q) => {
    process.stdout.write(q + ' [y/N] ');
    try {
      const ans = execFileSync('sh', ['-c', 'read -r ans </dev/tty && printf %s "$ans"'], { encoding: 'utf8' });
      return /^y/i.test(ans.trim());
    } catch { return false; }
  };
  const confirmAlways = (q) => {
    if (!process.stdin.isTTY) return false;
    return ask(q);
  };
  const confirm = (q) => {
    if (yes) return true;
    if (!process.stdin.isTTY) die('doctor-sweep --remove needs a terminal to confirm, or --yes to skip the confirms.');
    return ask(q);
  };
  for (const fd of findings) {
    if (fd.kind === 'job') {
      if (fd.missing.includes('unparseable')) {
        out(`${fd.label}: unreadable — reported only, never removed automatically; inspect ${fd.file} by hand`);
        continue;
      }
      // A hub under /Volumes may be an unmounted drive, not a dead hub:
      // "not found" is not "gone". --yes never skips this confirm.
      if (fd.hub?.startsWith('/Volumes/')) {
        if (yes && !process.stdin.isTTY) { out(`${fd.label}: hub under /Volumes (unmounted drive?) — skipped; rerun interactively to remove`); continue; }
        if (!confirmAlways(`${fd.label}: its hub is under /Volumes and may just be unmounted. Unload and delete anyway?`)) continue;
      } else if (!confirm(`Unload and delete ${fd.label}?`)) continue;
      removeFinding(fd, regPath, ext);
    } else {
      if (!confirm(`Drop the hubs.json entry for missing hub ${fd.hub}?`)) continue;
      removeFinding(fd, regPath, ext);
    }
  }
}

/** --json: the findings as data for the app's Doctor panel (opus, 10/16). */
function doctorSweepJson() {
  const { findings } = sweepFindings();
  // Versioned envelope (opus, for the Rust bridge): a version the consumer
  // can refuse instead of misrendering, and sweptAt so the panel can say
  // how old its list is.
  process.stdout.write(JSON.stringify({
    version: 1,
    sweptAt: new Date().toISOString(),
    findings: findings.map(({ id, kind, label, file, hub, missing, removable, volumes }) => ({ id, kind, label: label ?? null, file, hub, missing, removable, volumes })),
  }, null, 2) + '\n');
}

/**
 * --remove-item <id>: remove exactly ONE finding, re-sweeping first and
 * refusing unless the id is still a finding and still removable.
 * Non-interactive by design: the app's per-item confirm IS the confirm,
 * and there is no batch path from the UI at all.
 */
function doctorRemoveItem(id) {
  const { findings, regPath, ext } = sweepFindings();
  const fd = findings.find((f) => f.id === id);
  if (!fd) die(`doctor-sweep --remove-item: "${id}" is not a current finding — re-sweep and try again (it may have been fixed, mounted, or already removed).`);
  if (!fd.removable) die(`doctor-sweep --remove-item: "${id}" is unreadable — reported only, never removed automatically; inspect ${fd.file} by hand.`);
  removeFinding(fd, regPath, ext);
}
// ----------------------------------------------------------------- main
// Refuse-by-default (the porch-leak law, 10/15, design settled with opus):
// init writes NOTHING user-global — no launchd job, no hubs.json entry —
// unless apply is run with --live, and it refuses --live when the hub sits
// in scratch space or the bench seams (NW_INSTALL_DIR / NW_REGISTRY_DIR)
// are set. A bench that forgets the hermetic path is then safe by
// construction; nothing it installs can outlive it, because nothing is
// installed. Teardown on exit paths is deliberately NOT the defense: the
// 10/13 leak came from a SIGKILL and a deleted worktree, which run no exit
// path. What a --live install writes is recorded in the hub's
// wakecycle/installed.json, and `doctor-sweep` finds installed jobs whose
// hub or machinery no longer exists, from the records, not the teardown.
const LIVE = process.argv.includes('--live');
// Things a step couldn't do without failing the install; apply's last
// sentence carries them, where the person can still act on them.
const afterNotes = [];
function scratchRooted(p) {
  // realpath BOTH sides and compare unresolved spellings too: on macOS
  // tmpdir() says /var/folders/… while realpath says /private/var/folders/…,
  // and a hub that does not exist yet cannot be resolved at all. This exact
  // mismatch let a --live apply from a test install real launchd jobs on
  // 10/16 — the incident this guard exists for found the guard's own hole.
  const real = (x) => { try { return realpathSync(x); } catch { return x; } };
  const candidates = [tmpdir(), real(tmpdir()), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  return [expand(p), real(expand(p))].some((r) => candidates.some((t) => r === t || r.startsWith(t + '/')));
}
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'plan' || cmd === 'apply') {
    if (!arg) die(`${cmd} needs a spec file.`);
    const spec = loadSpec(arg);
    const { steps, hub, ctx } = spec.op === 'init' ? initSteps(spec) : laneAddSteps(spec);
    if (cmd === 'plan') {
      // `consent` names the spec field a step waits on: it runs only when the
      // page sends that field true (the preview shows it as a checkbox).
      out({ steps: steps.map(({ verb, what, detail, consent }) => ({ verb, what, detail, ...(consent ? { consent } : {}) })) });
    } else {
      for (const step of steps) {
        try { step.run(); }
        catch (e) {
          if (spec.op === 'init') rmSync(expand(spec.hub) + '.partial', { recursive: true, force: true });
          die(`The "${step.verb} ${step.what}" step failed: ${e.message}`);
        }
      }
      const who = ctx.name ?? (spec.op === 'init' ? 'the new persona' : `the ${spec.lane.id} agent`);
      const opened = process.env.WEFT_NW_NO_ACTIVATE ? 'prepared their first session (activation off)'
        : (spec.op === 'init' && !LIVE) ? 'staged everything — nothing user-global was written (no launchd job, no registry entry); rerun apply with --live to install'
        : 'opened their first session';
      const said = spec.op === 'init' ? `Created ${who}'s hub at ${hub} and ${opened}.` : `Added the ${spec.lane.id} agent and ${process.env.WEFT_NW_NO_ACTIVATE ? 'prepared' : 'opened'} its first session.`;
      out(afterNotes.length ? `${said.slice(0, -1)}; ${afterNotes.join('; ')}.` : said);
    }
  } else if (cmd === 'inspect-import') {
    if (!arg) die('inspect-import needs a folder.');
    out(inspectImport(arg));
  } else if (cmd === 'list-unclaimed') {
    out(listUnclaimed());
  } else if (cmd === 'doctor-sweep') {
    const ri = process.argv.indexOf('--remove-item');
    if (process.argv.includes('--json')) doctorSweepJson();
    else if (ri !== -1) doctorRemoveItem(process.argv[ri + 1] ?? die('--remove-item needs an id.'));
    else doctorSweep({ remove: process.argv.includes('--remove'), yes: process.argv.includes('--yes') });
  } else {
    die('Usage: nightwatch.mjs plan|apply <spec.json> [--live] | inspect-import <folder> | list-unclaimed | doctor-sweep [--remove] [--yes]');
  }
} catch (e) {
  die(e?.message ?? String(e));
}
