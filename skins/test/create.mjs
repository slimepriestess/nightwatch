// Nightwatch lane-creation test (10/6): drives Set up, Import and Add agent on the FIXTURE with a stand-in
// NW_HOST over CDP and checks the specs the runtime hands the machinery (anima_dev/nightwatch_lane_creation.md,
// "the contract"), its plain-words checks, and the preview it renders from the dry run. Run:
//   node --experimental-websocket skins/test/create.mjs
// Written by: claude-opus-5-5, 2026-10-06
import { launchChrome } from './chrome.mjs';
import { rmSync } from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:7352/';
const PORT = 9337;
const { ch, prof } = launchChrome({ port: PORT }); // killed and removed on every way out (chrome.mjs)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tab;
for (let i = 0; i < 50 && !tab; i++) {
  try { tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return `THREW: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`;
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__calls=[];window.__errs=[];window.NW_SHELL='tauri';\nwindow.NW_HOST={can:a=>['plan','apply','inspect-import','list-unclaimed'].includes(a),act:(a,o)=>{__calls.push([a,o.data??null]);\n if(a==='plan')return Promise.resolve(JSON.stringify({steps:[{verb:'Create',what:o.data.hub??('agent '+o.data.lane.id),detail:'the hub'},{verb:'Open',what:'a Terminal window',detail:'fresh session'}].concat(o.data.op==='init'?[{verb:'Raise',what:'transcript retention, 30 → 3650 days',detail:'machine-wide',consent:'keepTranscripts'}]:[])}));\n if(a==='apply')return Promise.resolve('Created.');\n if(a==='inspect-import')return Promise.resolve(JSON.stringify(o.data.from==='/good'?{identity:true,about:'I am Lark.',name:'Lark',memory:3,rungs:0}:{identity:false}));\n if(a==='list-unclaimed')return Promise.resolve(JSON.stringify([{sessionId:'abcdef1234567890',cwd:'~/origin',model:'Opus 5.5'}]));\n return Promise.reject('unexpected '+a)}};\naddEventListener('error',e=>__errs.push(e.message+' @'+e.lineno));addEventListener('unhandledrejection',e=>__errs.push('rej '+e.reason))" });
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500); };
let pass = 0, fail = 0;
const check = async (name, expr, want) => {
  const got = await ev(expr); const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing'; e.click(); return 'clicked'})()`);
const set = (sel, v) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing'; if(e.type==='checkbox'){e.checked=${JSON.stringify(v)}}else{e.value=${JSON.stringify(v)}} e.dispatchEvent(new Event('change',{bubbles:true})); return 'set'})()`);
const D = '.nw-app > .nw-setup', F = (n) => `${D} [data-field="${n}"]`;
const step = `document.querySelector('${D}').dataset.step`, err = `document.querySelector('${D} [data-part="error"]').hidden ? null : document.querySelector('${D} [data-part="error"]').textContent`;
const lastCall = (a) => `(__calls.filter(c=>c[0]==='${a}').at(-1)||[])[1]`;
const tick = () => sleep(150);

// ---- Set up: who → nights → preview → create
await go(new URL('../fixture.html?skin=minimal&fresh=1', import.meta.url).href);
await check('no boot errors', 'window.__errs', []);
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await check('Set up opens on "who"', `[document.querySelector('${D}').dataset.open, ${step}]`, ['true', 'who']);
await click(`${D} [data-action="setup-next"]`); await tick();
await check('empty "about" is refused in plain words, nothing sent', `[${step}, ${err}, __calls.length]`, ['who', 'Write a paragraph about who they are. It seeds their identity file.', 0]);
await set(F('about'), 'A careful reader who likes trains.'); await set(F('person'), 'Sam');
await click(`${D} [data-action="setup-next"]`); await tick();
await check('a folder with no name is refused', err, 'Give their folder a name, for example ~/Nightwatch/lark.');
await set(F('hub'), '~/Nightwatch/moth');
await click(`${D} [data-action="setup-next"]`); await tick();
await check('then "their nights"', `[${step}, ${err}]`, ['nights', null]);
await click(`${D} [data-action="setup-next"]`); await tick();
await check('Next asks the dry run, then shows its steps', `[${step}, document.querySelectorAll('${D} [data-part="steps"] li').length, document.querySelector('${D} [data-part="steps"] li code').textContent]`,
  ['preview', 3, '~/Nightwatch/moth']);
await check('the spec: unnamed persona, pinned model, global schedule, fresh main agent', lastCall('plan'),
  { op: 'init', hub: '~/Nightwatch/moth', persona: { name: null, about: 'A careful reader who likes trains.', person: 'Sam' },
    schedule: { sleep: '02:00', wake: '08:00' },
    lane: { id: 'main', model: 'claude-fable-5-1', targetTokens: 250000, armed: true, schedule: null, firstSession: { kind: 'fresh' } }, import: null,
    retention: { keepTranscripts: false } });
// The retention change (Ra, 10/11) is the one step that waits on a box: unticked, and only it has one.
await check('a consent step renders as an unticked box; no other step has one',
  `[...document.querySelectorAll('${D} [data-part="steps"] li')].map(l=>[l.dataset.consent??null, l.querySelector('input[type=checkbox]')?.checked ?? null])`,
  [[null, null], [null, null], ['keepTranscripts', false]]);
// Every skin lays a step out as a grid of exactly b + code + span; wrapping any two collapses it (it did, 10/16).
await check('the consent step keeps the three children every skin lays out', `[...document.querySelector('${D} [data-part="steps"] li[data-consent]').children].map(c=>c.tagName)`, ['B', 'CODE', 'SPAN']);
await click(`${D} [data-part="steps"] li[data-consent] b label`); await tick();
await check('clicking the verb ticks the box', `document.querySelector('${D} [data-part="steps"] li[data-consent] input').checked`, true);
await click(`${D} [data-part="steps"] li[data-consent] b label`); await tick();
await check('only the preview step shows Create', `[...document.querySelectorAll('${D} [data-part="buttons"] button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>b.dataset.action)`, ['setup-back', 'create-persona']);
await click(`${D} [data-action="setup-back"]`); await tick();
await check('Back from preview → nights', step, 'nights');
await click(`${D} [data-action="setup-next"]`); await tick();
await click(`${D} [data-action="create-persona"]`); await tick();
await check('Create sends the same spec to apply, closes, says so', `[JSON.stringify(${lastCall('apply')})===JSON.stringify(${lastCall('plan')}), document.querySelector('${D}').dataset.open, document.querySelector('.nw-app > .nw-toast')?.textContent]`, [true, 'false', 'Created.']);
// Ticked, apply carries it, and that is the only difference from the preview's spec.
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await set(F('about'), 'A careful reader who likes trains.'); await set(F('person'), 'Sam'); await set(F('hub'), '~/Nightwatch/moth');
await click(`${D} [data-action="setup-next"]`); await tick();
await click(`${D} [data-action="setup-next"]`); await tick();
await click(`${D} [data-part="steps"] li[data-consent] input`); await tick();
await click(`${D} [data-action="create-persona"]`); await tick();
await check('ticked, apply asks for it and nothing else changes', `(a=>(p=>[a.retention.keepTranscripts, JSON.stringify({...a, retention: null})===JSON.stringify({...p, retention: null})])(${lastCall('plan')}))(${lastCall('apply')})`, [true, true]);

// ---- Import: a folder checked first; anything missing stays missing
await ev('window.__calls=[]');
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await click(`${D} [data-action="setup-import"]`); await tick();
await check('import step', step, 'import');
await set(F('from'), '/bad'); await click(`${D} [data-action="check-import"]`); await tick();
await check('no identity.md: said plainly', `document.querySelector('${D} [data-part="found"] li[data-status="failed"]')?.textContent.trim()`, 'No identity.md in this folder, so there is nothing to import yet.');
await click(`${D} [data-action="setup-next"]`); await tick();
await check('cannot continue unchecked', err, 'Check the folder first.');
await set(F('from'), '/good'); await click(`${D} [data-action="check-import"]`); await tick();
await check('found list, missing items honest', `[...document.querySelectorAll('${D} [data-part="found"] li')].map(l=>[l.dataset.status,l.textContent.trim()])`,
  [['ok', 'identity.md'], ['ok', 'name.txt: Lark'], ['ok', 'memory/: 3 files'], ['missing', 'No ladder rungs']]);
await click(`${D} [data-action="setup-next"]`); await tick();
await check('then "who", pre-filled', `[${step}, document.querySelector('${F('name')}').value, document.querySelector('${F('about')}').value]`, ['who', 'Lark', 'I am Lark.']);
await set(F('person'), 'Sam'); await set(F('hub'), '~/Nightwatch/lark');
await click(`${D} [data-action="setup-next"]`); await tick(); await click(`${D} [data-action="setup-next"]`); await tick();
await check('the spec carries the import and their own name', `(s=>[s.import, s.persona.name])(${lastCall('plan')})`, [{ from: '/good' }, 'Lark']);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await tick();
await check('Escape closes Set up', `document.querySelector('${D}').dataset.open`, 'false');
await ev(`NW_HOST.can=()=>false`);
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await check('a host that can\'t plan never opens it', `document.querySelector('${D}').dataset.open`, 'false');
await ev(`NW_HOST.can=a=>['plan','apply','inspect-import','list-unclaimed'].includes(a)`);

// ---- Add agent: form → preview → create
const A = '.nw-app > .nw-lanes .nw-persona:first-child > .nw-add', AF = (n) => `${A} [data-field="${n}"]`;
const aerr = `(p=>p.hidden?null:p.textContent)(document.querySelector('${A} [data-part="error"]'))`;
await go(new URL('../fixture.html?skin=minimal', import.meta.url).href);
await ev('window.__calls=[]');
await click(`${A} [data-action="add-lane"]`); await tick();
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('a bad agent name is refused', aerr, 'Agent names are lowercase letters, numbers and dashes, starting with a letter (for example "scout").');
await set(AF('id'), 'opus'); await click(`${A} [data-action="plan-lane"]`); await tick();
await check('a taken agent name is refused', aerr, 'There\'s already an agent called "opus".');
await set(AF('id'), 'lark'); await set(AF('model'), 'claude-sonnet-5-5');
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('preview step, from the dry run', `[document.querySelector('${A}').dataset.step, document.querySelector('${A} [data-part="steps"] li code').textContent, ${aerr}]`, ['preview', 'agent lark', null]);
await check('agent spec: pinned model, global schedule, fresh', lastCall('plan'),
  { op: 'lane-add', lane: { id: 'lark', model: 'claude-sonnet-5-5', targetTokens: 250000, armed: true, schedule: null, firstSession: { kind: 'fresh' } } });
await click(`${A} [data-action="plan-back"]`); await tick();
await set(AF('inherit'), false); await tick();
await check('own schedule unlocks', `[document.querySelector('${AF('sleep')}').disabled, document.querySelector('${AF('wake')}').disabled]`, [false, false]);
await set(AF('sleep'), '03:00'); await set(AF('wake'), '09:30');
await set(AF('first'), 'adopt'); await sleep(300);
await check('adopt lists unclaimed sessions', `[document.querySelector('${A} [data-part="adopt"]').hidden, [...document.querySelector('${AF('session')}').options].map(o=>o.textContent)]`,
  [false, ['Choose a session…', 'abcdef12… · ~/origin · Opus 5.5']]);
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('adopt needs a choice', aerr, 'Pick the running session to adopt, or start from a fresh session.');
await set(AF('session'), 'abcdef1234567890');
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('spec: own times, adopted session', `(l=>[l.schedule, l.firstSession])(${lastCall('plan')}.lane)`, [{ sleep: '03:00', wake: '09:30' }, { kind: 'adopt', sessionId: 'abcdef1234567890' }]);
await click(`${A} [data-action="create-lane"]`); await tick();
await check('Add and wake applies, closes the slot', `[${lastCall('apply')}.lane.id, document.querySelector('${A}').dataset.open, document.querySelector('${A}').dataset.step]`, ['lark', 'false', 'form']);
// Runs on (codex lane leg 6's picker, 11/25): a Codex agent has its own models and starts fresh.
await go(new URL('../fixture.html?skin=minimal', import.meta.url).href);
await ev('window.__calls=[]');
await click(`${A} [data-action="add-lane"]`); await tick();
// Whether each model row is DRAWN, not just flagged: the skin's label display beat [hidden] once (a still caught it).
const modelsShown = `[getComputedStyle(document.querySelector('${A} [data-part="model-claude"]')).display === 'none', getComputedStyle(document.querySelector('${A} [data-part="model-codex"]')).display === 'none']`;
await check('the form opens on Claude Code, the Codex models hidden', `[document.querySelector('${AF('provider')}').value, ...${modelsShown}]`, ['claude-code', false, true]);
await set(AF('first'), 'adopt'); await sleep(300);
await set(AF('provider'), 'codex'); await tick();
await check('Codex shows its own models, sets Start from back to fresh and disables adopting',
  `[...${modelsShown}, document.querySelector('${AF('first')}').value, document.querySelector('${AF('first')} option[value="adopt"]').disabled, document.querySelector('${A} [data-part="adopt"]').hidden]`,
  [true, false, 'fresh', true, true]);
await set(AF('id'), 'wren'); await set(AF('codexModel'), 'gpt-6.2-astra');
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('a Codex agent\'s spec: provider codex, its Codex model, fresh', lastCall('plan'),
  { op: 'lane-add', lane: { id: 'wren', provider: 'codex', model: 'gpt-6.2-astra', targetTokens: 250000, armed: true, schedule: null, firstSession: { kind: 'fresh' } } });
await click(`${A} [data-action="plan-back"]`); await tick();
await ev(`document.querySelector('${AF('first')}').value='adopt'`); await click(`${A} [data-action="plan-lane"]`); await tick();
await check('Codex with adopt forced past the form is still refused, in words', aerr, 'A Codex agent starts from a fresh session.');
await ev(`document.querySelector('${AF('first')}').value='fresh'`);
await set(AF('provider'), 'claude-code'); await tick();
await check('back to Claude Code: its models again, adopting allowed again', `[...${modelsShown}, document.querySelector('${AF('first')} option[value="adopt"]').disabled]`, [false, true, false]);
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('and its spec carries no provider (the config\'s own default)', `(l=>['provider' in l, l.model])(${lastCall('plan')}.lane)`, [false, 'claude-fable-5-1']);
// The floating + (Add persona) opens Set up: a new persona is a new hub (Ra, 10/7).
await go(new URL('../fixture.html?skin=minimal', import.meta.url).href);
await ev(`document.querySelector('.nw-app > .nw-lanes > .nw-add-persona').click()`); await sleep(300);
await check('the floating + opens Set up on "who"', `(d=>[d.dataset.open, d.dataset.step])(document.querySelector('.nw-app > .nw-setup'))`, ['true', 'who']);
await ev(`document.querySelector('.nw-app > .nw-setup [data-action="close-setup"]').click()`);
await check('no errors along the way', 'window.__errs', []);

console.log(`\n${pass} passed, ${fail} failed`);
await Promise.race([send('Browser.close'), sleep(1000)]); ws.close(); ch.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
