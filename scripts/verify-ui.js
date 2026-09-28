'use strict';
/*
 * End-to-end check of the browser UI. Starts the lab in-process on a random port
 * with an in-memory store, drives headless Chrome over the DevTools protocol,
 * clicks through every page and flow, and asserts on what the person would see.
 *
 *   npm run verify:ui                 run all checks
 *   npm run verify:ui -- --shots out  also save a full-page screenshot of every page
 *
 * Needs Node 22+ (global WebSocket) and Chrome or Edge. Set CHROME_PATH to override.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { createStore } = require('../server/lib/store');
const { createApp } = require('../server/app');
const { createExplainer } = require('../server/lib/explain');

const ROOT = path.resolve(__dirname, '..');
const shotsDir = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const problems = [];

async function main() {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22 or newer is required (global WebSocket).');
  const chromePath = CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('Chrome or Edge not found. Set CHROME_PATH.');

  // A local stand-in for Azure OpenAI: faithful for every pool except Japan East, where it
  // invents a figure, so the browser can show both the "AI used" and "AI text withheld" states.
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const packet = JSON.parse(JSON.parse(body).messages[1].content.replace(/^Plan facts \(JSON\):\n/, ''));
      const bad = /Japan East/.test(packet.pool);
      const answer = {
        summary: `In plain words: ${packet.headline}${bad ? ' Consider 9,999 CU instead.' : ''}`,
        why_now: packet.flagged_funnels.slice(0, 2).map((s) => s.headline), risks: [],
        request_title: `Request for ${packet.pool}`, request_body: packet.order ? `Please order ${packet.order.quantity} of ${packet.order.sku}.` : 'No request is needed.',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const explainer = createExplainer({ config: { enabled: true, endpoint: stubUrl, host: stubUrl.replace('http://', ''), apiKey: 'ui-test-key', deployment: 'stub-gpt', apiVersion: '2024-10-21' } });

  // The peak check is optional (it needs `npm run ml`). With the profile on disk the main lab has it on and the checks
  // below cover it; the second lab has none, which covers the "off" state.
  const PEAK_PROFILE = path.join(ROOT, 'ml', 'out', 'peak_profile.json');
  const havePeak = fs.existsSync(PEAK_PROFILE);
  if (!havePeak) console.log('note: ml/out/peak_profile.json is missing, so the peak-check screens are not exercised. Run npm run ml.');
  const store = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null, peakProfilePath: havePeak ? PEAK_PROFILE : null });
  const server = createApp({ store, webRoot: path.join(ROOT, 'web'), explainer });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A second lab with no AI configured, to check the "rules-based text" state.
  const serverOff = createApp({ store: createStore({ dataDir: path.join(ROOT, 'data'), statePath: null }), webRoot: path.join(ROOT, 'web') });
  await new Promise((r) => serverOff.listen(0, '127.0.0.1', r));
  const baseOff = `http://127.0.0.1:${serverOff.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

  const cleanup = async () => {
    try { chrome.kill(); } catch { /* already gone */ }
    await new Promise((r) => server.close(r));
    await new Promise((r) => serverOff.close(r));
    await new Promise((r) => stub.close(r));
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* profile still locked, harmless */ }
  };

  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('Chrome did not start its debugging port.');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value || a.description).join(' ')}`);
      // A 400 is the API refusing a guardrail on purpose (the test provokes it); anything else is a problem.
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '') && !/status of 400/.test(m.params.entry.text)) problems.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

    const js = async (fn, ...args) => {
      const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitFor = async (fn, what, ...args) => {
      for (let i = 0; i < 80; i++) { if (await js(fn, ...args)) return; await sleep(100); }
      throw new Error(`timed out waiting for: ${what}`);
    };
    const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  -> ${detail}`}`); };
    const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, e.message); } };
    const go = async (hash) => { await send('Page.navigate', { url: `${base}/#${hash}` }); await sleep(150); };
    const text = (sel) => js((s) => (document.querySelector(s) ? document.querySelector(s).innerText : null), sel);
    const count = (sel) => js((s) => document.querySelectorAll(s).length, sel);
    const click = (sel) => js((s) => { const e = document.querySelector(s); if (!e) throw new Error(`no element ${s}`); e.click(); return true; }, sel);
    const clickText = (tag, label) => js((t, l) => { const e = [...document.querySelectorAll(t)].find((x) => x.textContent.trim() === l); if (!e) throw new Error(`no ${t} "${l}"`); e.click(); return true; }, tag, label);
    const setVal = (sel, val) => js((s, v) => { const e = document.querySelector(s); if (!e) throw new Error(`no element ${s}`); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; }, sel, String(val));
    const pick = (sel, label) => js((s, l) => { const e = document.querySelector(s); const i = [...e.options].findIndex((o) => o.textContent.trim().startsWith(l)); if (i < 0) throw new Error(`no option ${l}`); e.selectedIndex = i; e.dispatchEvent(new Event('change', { bubbles: true })); return true; }, sel, label);
    const shot = async (name, width = 1440) => {
      if (!shotsDir) return;
      fs.mkdirSync(shotsDir, { recursive: true });
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      const { contentSize } = await send('Page.getLayoutMetrics');
      await send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(6000, Math.ceil(contentSize.height)), deviceScaleFactor: 1, mobile: width < 700 });
      await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    console.log(`UI checks against ${base} with ${path.basename(chromePath)}\n`);

    // ------------------------------------------------------------------ overview
    await step('overview: the wireframe renders, with every figure from the API', async () => {
      await go('/overview');
      await waitFor(() => document.querySelectorAll('.kpi').length === 6 && document.querySelector('cap-overview-chart svg') && document.querySelectorAll('.rec').length >= 2, 'the overview widgets');
      const api = await (await fetch(`${base}/api/overview`)).json();
      const N = (x) => Math.round(x).toLocaleString('en-US');
      check('overview: headline answers the question', /^No\. 1 of 6 pools/.test(await text('.ovanswer__text')), await text('.ovanswer__text'));
      check('overview: 3, 6 and 12 month answers', (await count('.ovanswer .chip')) === 3);
      check('overview: six KPI cards worded as the wireframe', await js(() => { const l = [...document.querySelectorAll('.kpi__label')].map((x) => x.innerText.trim()); return ['Total demand (12M)', 'Projected shortfall', 'Regions at risk', 'Projected reclaim value', 'Est. capacity investment', 'Critical signals'].every((s, i) => l[i].startsWith(s)); }));
      check('overview: KPI values are the API values', await js((a) => { const v = [...document.querySelectorAll('.kpi__value')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()); return v[0].startsWith(a.d) && v[1].startsWith(a.s) && v[2].startsWith(a.r) && v[3].startsWith(a.c) && v[5] === a.k; }, { d: N(api.kpis.total_demand.value), s: N(api.kpis.projected_shortfall.value), r: `${api.kpis.regions_at_risk.at_risk} / ${api.kpis.regions_at_risk.total}`, c: N(api.kpis.reclaim.cu), k: String(api.kpis.critical_signals.count) }));
      check('overview: every KPI explains how it is calculated', await js(() => [...document.querySelectorAll('.kpi .info')].length === 6 && [...document.querySelectorAll('.kpi .info')].every((b) => (b.title || '').length > 40)));
      check('overview: the regions card splits at risk from on watch, so 3 / 4 is not contradicted', await js((k) => new RegExp(`^${k.critical} at risk, ${k.at_risk - k.critical} on watch$`).test(document.querySelectorAll('.kpi')[2].querySelector('.kpi__note').innerText.trim()), api.kpis.regions_at_risk));
      check('overview: deltas are real (demand up, shortfall up)', await js(() => { const d = [...document.querySelectorAll('.kpi .delta')].map((x) => x.innerText); return d.length === 2 && /▲ \+\d+%/.test(d[0]) && /▲ \+\d+%/.test(d[1]); }));
      check('overview: four regions, each with a status in words', await js(() => { const t = [...document.querySelectorAll('.geotile')].map((x) => x.innerText); return t.length === 4 && /At risk/.test(t[0]) && /Healthy/.test(t[1]) && /Watch/.test(t[2]); }));
      check('overview: the regions are on a world map: an outline of the land, and a dot per region', await js(() => { const m = document.querySelector('.worldmap'); const d = m && m.querySelector('.worldmap__land'); return !!d && d.getAttribute('d').length > 20000 && /^0 0 1000 \d+$/.test(m.querySelector('svg').getAttribute('viewBox')) && m.querySelectorAll('.geotile .geotile__dot').length === 4; }));
      check('overview: each dot sits where the API puts its region, on the same projection as the outline', await js((regions) => { const dots = [...document.querySelectorAll('.worldmap .geotile')]; return dots.length === regions.length && regions.every((r, i) => Math.abs(parseFloat(dots[i].style.left) - r.map.x * 100) < 0.05 && Math.abs(parseFloat(dots[i].style.top) - r.map.y * 100) < 0.05); }, api.regions));
      check('overview: the dot takes the region\'s status colour and the label says it in words', await js(() => { const t = [...document.querySelectorAll('.worldmap .geotile')]; const col = (e) => getComputedStyle(e.querySelector('.geotile__dot')).backgroundColor; return t.length === 4 && col(t[0]) !== col(t[1]) && col(t[1]) !== col(t[2]) && col(t[0]) === col(t[3]) && /At risk/.test(t[0].querySelector('.geotile__label').innerText); }));
      check('overview: the map credits its source', /Natural Earth/.test(await text('.ov-reg .panel__note')));
      check('overview: the forecast draws demand, capacity lines, shortfall bars and the peak call-out', await js(() => { const c = document.querySelector('cap-overview-chart'); return c.querySelector('.ol-dem') && c.querySelector('.ol-prov') && c.querySelector('.ol-eff') && c.querySelectorAll('.ob-bar').length >= 6 && /Projected shortfall 7,294 CU \(Sep 2027\)/.test(c.querySelector('.ob-calltext').textContent); }));
      check('overview: the lines are smooth curves, with no marker dot on the end', await js(() => { const c = document.querySelector('cap-overview-chart'); return ['.ol-dem', '.ol-prov', '.ol-eff'].every((s) => /^M[\d. ]+( C[\d. ]+)+$/.test(c.querySelector(s).getAttribute('d'))) && !c.querySelector('.ol-dot'); }));
      check('overview: the three lines differ by pattern as well as colour: solid, dashed and dotted', await js(() => { const c = document.querySelector('cap-overview-chart'); const st = (s) => getComputedStyle(c.querySelector(s)); return st('.ol-dem').strokeDasharray === 'none' && st('.ol-prov').strokeDasharray !== 'none' && st('.ol-eff').strokeDasharray !== 'none' && st('.ol-prov').strokeDasharray !== st('.ol-eff').strokeDasharray && new Set([st('.ol-dem').stroke, st('.ol-prov').stroke, st('.ol-eff').stroke]).size === 3; }));
      check('overview: the legend keys are the same three patterns and the red bar', await js(() => { const k = (s) => document.querySelector('.ov-fc .legend ' + s); const b = (s) => getComputedStyle(k(s)).borderTopStyle; return b('.key--dem') === 'solid' && b('.key--prov') === 'dashed' && b('.key--eff') === 'dotted' && !!k('.key--bar'); }));
      check('overview: bars get stronger as the shortfall grows', await js(() => { const bars = [...document.querySelectorAll('cap-overview-chart .ob-bar')].map((b) => ({ h: b.getBBox().height, o: parseFloat(b.style.opacity) })).sort((x, y) => x.h - y.h); return bars.length >= 6 && bars.every((b, i) => i === 0 || b.o >= bars[i - 1].o - 1e-9) && bars.at(-1).o === 1 && bars[0].o < 0.6; }));
      check('overview: the peak month is bold red on the axis, and the call-out has two lines with the figure in red', await js(() => { const c = document.querySelector('cap-overview-chart'); const peak = c.querySelector('.axis text.peak'); const lines = c.querySelectorAll('.ob-calltext text'); return !!peak && peak.textContent === 'Sep' && lines.length === 2 && /Projected shortfall/.test(lines[0].textContent) && c.querySelector('.ob-callnum').textContent === '7,294 CU' && getComputedStyle(c.querySelector('.ob-callnum')).fill === getComputedStyle(peak).fill; }));
      await js(() => { const hit = document.querySelector('cap-overview-chart .hit'); const r = hit.getBoundingClientRect(); hit.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.6, clientY: r.top + 30, bubbles: true })); });
      const tip = await text('cap-overview-chart .chart-tip');
      check('overview: the tooltip lists all four series for a month', /Forecast demand/.test(tip) && /Provisioned capacity/.test(tip) && /Effective capacity/.test(tip) && /Shortfall/.test(tip), tip);
      check('overview: constraints, recommendations, signals and procurement all have rows (inventory and optimization moved to the supply view)', await js(() => {
        const rows = (cls) => document.querySelectorAll('.' + cls + ' tbody tr').length;
        return rows('ov-con') === 5 && document.querySelectorAll('.rec').length === 2 && rows('ov-sig') === 6 && rows('ov-proc') === 5 && rows('ov-inv') === 0 && rows('ov-opt') === 0;
      }));
      check('overview: recommendations lead with East US and say what kind of planning set them', await js(() => { const r = [...document.querySelectorAll('.rec')]; return /Procure 4,032 CU of FAB-AMD-GENOA-96 for East US/.test(r[0].innerText) && /Standard demand-driven planning/.test(r[0].innerText) && /Funnel-triggered: Customer Contract & Commitment/.test(r[1].innerText) && /converging funnels/.test(r[0].innerText); }));
      check('overview: the recommendation states no invented probability', !/\d+% confidence/i.test(await text('.rec')));
      check('overview: the header Actions button and rail show the queue size', await js((k) => document.querySelector('.btn--actions .badge').innerText.trim() === String(k) && /13/.test(document.querySelector('.rail a[href="#/actions"]').innerText), api.action_queue.counts.all));
      check('overview: Capacity Planning is one page with three views, and the address of the two-view design still works', await js(() => { const t = [...document.querySelectorAll('.viewtab')]; return t.length === 3 && t.map((x) => x.innerText.trim()).join('|') === 'Balance / plan|Supply view|Demand view' && t.map((x) => x.getAttribute('href')).join('|') === '#/planning|#/planning/supply|#/planning/demand' && t[0].classList.contains('viewtab--active') && location.hash === '#/planning'; }));
      check('overview: the rail has one Capacity Planning entry and no Overview entry', await js(() => { const l = [...document.querySelectorAll('.rail a')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()); return l[0] === 'Capacity Planning' && !l.some((x) => /^Overview/.test(x)) && document.querySelector('.rail a.is-active').innerText.trim() === 'Capacity Planning'; }));
      check('overview: the planning horizon table has exhaustion date, lead time and order, by urgency', await js(() => { const card = document.getElementById('pools-head').closest('section'); const th = [...card.querySelectorAll('th')].map((x) => x.innerText.trim().toLowerCase()); const rows = card.querySelectorAll('tbody tr'); return th.includes('capacity needed by') && th.includes('lead time') && th.includes('order cu') && rows.length === 6 && /East US/.test(rows[0].innerText); }));
      check('overview: synthetic label is always visible', /Synthetic data/i.test(await text('.appbar')));
      await shot('overview');
    });
    await step('overview: tabs, filters and search all respond', async () => {
      await clickText('button', '6 months');
      await waitFor(() => document.querySelectorAll('cap-overview-chart .axis text').length >= 7 && document.querySelectorAll('cap-overview-chart .ob-bar').length > 0, 'six-month chart');
      check('overview: the 6-month tab redraws the chart with 6 months', await js(() => document.querySelectorAll('cap-overview-chart .axis text').length === 4 + 7 || document.querySelectorAll('cap-overview-chart .axis text').length >= 7));
      await pick('select[aria-label="Horizon"]', 'Next 12 months');
      await waitFor(() => /Projected shortfall 7,294 CU/.test(document.querySelector('cap-overview-chart .ob-calltext')?.textContent || ''), 'back to 12 months');
      await clickText('button', 'Procurement (5)');
      await waitFor(() => document.querySelectorAll('.queue li').length === 5, 'procurement queue');
      check('overview: the action queue tabs filter to procurement', await js(() => [...document.querySelectorAll('.queue li')].every((l) => /Procure|Replace/.test(l.innerText))));
      await pick('select[aria-label="SKUs"]', 'GPU');
      await waitFor(() => /Not yet\. 1 of 2 pools/.test(document.querySelector('.ovanswer__text')?.innerText || ''), 'GPU filter');
      check('overview: the SKU filter scopes the headline, KPIs, recommendations and the balance to the two GPU pools', await js(() => document.querySelectorAll('.rec').length === 2 && /H100/.test(document.querySelector('.rec').innerText) && document.querySelectorAll('[aria-labelledby="bal-head"] .tblwrap tbody tr').length === 2 && /GPU-H100|GPU-L40S/.test(document.querySelector('#bal-head').closest('section').innerText)));
      await pick('select[aria-label="Regions"]', 'Europe');
      await waitFor(() => document.querySelectorAll('.geotile').length === 1, 'one region');
      check('overview: the region filter narrows the map to that region', await js(() => /Europe/.test(document.querySelector('.geotile').innerText)));
      await pick('select[aria-label="SKUs"]', 'All SKUs');
      await pick('select[aria-label="Horizon"]', 'Next 3 months');
      // 4 month labels (Sep to Dec) and 5 value labels (0 to 20K)
      await waitFor(() => document.querySelectorAll('cap-overview-chart .axis text').length === 4 + 5 && /Europe/.test(document.querySelector('.ov-fc h3')?.innerText || ''), 'Europe over 3 months');
      check('overview: Europe over 3 months has no shortfall, so no call-out and no bars, and the space for one is not left empty', await js(() => { const c = document.querySelector('cap-overview-chart'); const vb = c.querySelector('svg').getAttribute('viewBox').split(' ').map(Number); return !c.querySelector('.ob-callout') && c.querySelectorAll('.ob-bar').length === 0 && vb[3] < 300 && !c.querySelector('.axis text.peak'); }));
      check('overview: Europe\'s axis is scaled to Europe (0 to 20K), not the whole estate', await js(() => [...document.querySelectorAll('cap-overview-chart .axis text')].map((t) => t.textContent).slice(0, 5).join(',') === '0,5K,10K,15K,20K'));
      await pick('select[aria-label="Horizon"]', 'Next 12 months');
      await waitFor(() => document.querySelectorAll('cap-overview-chart .axis text').length > 8, 'back to 12 months');
      await pick('select[aria-label="SKUs"]', 'All SKUs');
      await pick('select[aria-label="Regions"]', 'All regions');
      await waitFor(() => document.querySelectorAll('.geotile').length === 4, 'filters cleared');
      await setVal('.searchbox input', 'brazil');
      await waitFor(() => document.querySelectorAll('.searchbox__list li').length >= 1, 'search hits');
      check('overview: search finds a pool by region name', /Brazil South/.test(await text('.searchbox__list')));
      await js(() => document.querySelector('.searchbox input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await waitFor(() => /pools\/pool-brazilsouth/.test(location.hash), 'navigated to Brazil South');
      check('overview: Enter in the search box opens the pool', true);
      await go('/overview');
      await waitFor(() => document.querySelectorAll('.kpi').length === 6, 'overview again');
    });
    await step('overview: the total is one combined forecast, and the busiest-hour check sits beside the plan', async () => {
      await go('/overview');
      await waitFor(() => document.querySelectorAll('.kpi').length === 6 && document.querySelectorAll('.rec').length >= 2, 'the overview');
      const api = await (await fetch(`${base}/api/overview`)).json();
      const N = (x) => Math.round(x).toLocaleString('en-US');
      const td = api.kpis.total_demand;
      check('overview: the total-demand card shows the combined figure, not the sum of the pools\' p80s', await js((t, plain) => { const c = document.querySelectorAll('.kpi')[0].innerText; return c.includes(t) && !c.includes(plain); }, N(td.value), N(td.sum_of_pool_p80)), `${N(td.value)} against ${N(td.sum_of_pool_p80)}`);
      check('overview: it says how far below adding the pools\' p80s that is', await js((d) => new RegExp(`${d} CU below adding the pools`).test(document.querySelectorAll('.kpi')[0].innerText), N(td.diversification_cu)));
      check('overview: the region tiles say pools are combined, not added', /combined as one forecast, not by adding their p80s/.test(await text('.ov-reg .panel__note')));
      if (havePeak) {
        await waitFor(() => document.querySelectorAll('.ov-peak tbody tr').length === 6, 'the busiest-hour table');
        const pk = api.peak;
        const eus = pk.rows.find((r) => r.pool_id === 'pool-eastus-01-intel-icx');
        check('overview: the busiest-hour card has a row for each pool, the ones that matter first', await js((rows) => { const tr = [...document.querySelectorAll('.ov-peak tbody tr')]; return tr.length === 6 && rows.every((r, i) => tr[i].innerText.includes(r.region)); }, pk.rows));
        check('overview: its headline figures are the API\'s', await js((s) => { const f = document.querySelector('.ov-peak .facts').innerText; return f.includes(`${s.over_ceiling_now} of ${s.pools} pools`) && f.includes(`${Math.round(s.extra_cu).toLocaleString('en-US')} CU`); }, pk.summary));
        check('overview: a pool over its ceiling at the peak is marked, though its weekly mean is not', await js((weeks) => { const r = [...document.querySelectorAll('.ov-peak tbody tr')].find((x) => /East US/.test(x.innerText)); return !!r.querySelector('.peakcell--over') && new RegExp(`${weeks} weeks over`).test(r.innerText); }, eus.weeks_over));
        check('overview: a plan that moves shows both states', await js((rows) => { const moved = rows.find((r) => r.changes_state); const tr = [...document.querySelectorAll('.ov-peak tbody tr')].find((x) => x.innerText.includes(moved.region)); return tr.innerText.includes(moved.mean_state) && tr.innerText.includes(moved.peak_state); }, pk.rows));
        check('overview: it says this is a check and the ceiling question is a policy decision', /nothing above changes/.test(await text('.ov-peak')) && /policy decision/.test(await text('.ov-peak')));
        await shot('overview-peak');
      }
    });
    // ------------------------------------------------------------------ planning: the balance, the supply view and the demand view
    await step('planning: the balance says where supply and demand do not meet, pool by pool, from the API', async () => {
      await go('/planning');
      await waitFor(() => document.querySelectorAll('[aria-labelledby="bal-head"] .tblwrap tbody tr').length === 6 && document.querySelector('cap-overview-chart svg'), 'the balance');
      const api = await (await fetch(`${base}/api/planning`)).json();
      const N = (x) => Math.round(x).toLocaleString('en-US');
      await js(() => { window.N = (x) => Math.round(x).toLocaleString('en-US'); return true; });      // the same formatter, for the checks that run in the page
      check('balance: the sentence under the title is the API\'s', await js((h) => document.querySelector('#bal-head').closest('section').querySelector('.panel__hint').innerText.trim() === h, api.balance.headline));
      check('balance: one row per pool, the one furthest short first, each with its own supply, demand and balance', await js((rows) => { const tr = [...document.querySelectorAll('[aria-labelledby="bal-head"] .tblwrap tbody tr')]; return tr.length === rows.length && rows.every((r, i) => tr[i].innerText.includes(r.region) && tr[i].innerText.includes(N(r.supply_cu)) && tr[i].innerText.includes(N(r.demand_cu)) && tr[i].innerText.includes(N(Math.abs(r.balance_cu)))); }, api.balance.rows));
      check('balance: East US is first, short by 4,650 CU, and its plan is to order 4,032 CU', await js(() => { const t = document.querySelector('[aria-labelledby="bal-head"] .tblwrap tbody tr').innerText.replace(/\s+/g, ' '); return /East US/.test(t) && /-4,650/.test(t) && /short/.test(t) && /OVERDUE/.test(t) && /Order 4,032 CU by 10 Aug 2026/.test(t); }));
      check('balance: a short pool says so in words and shape, not colour alone; a pool with room says that', await js(() => { const p = [...document.querySelectorAll('[aria-labelledby="bal-head"] .tblwrap .balpill')]; return /-4,650/.test(p[0].innerText) && p[0].classList.contains('balpill--short') && /short/.test(p[0].parentElement.innerText) && p.at(-1).classList.contains('balpill--ok') && /room to spare/.test(p.at(-1).parentElement.innerText) && getComputedStyle(p[0], '::before').clipPath !== 'none' && getComputedStyle(p.at(-1), '::before').clipPath === 'none'; }));
      check('balance: each bar puts the ceiling and the demand where the numbers are, and is described for a screen reader', await js((rows) => { const bars = [...document.querySelectorAll('[aria-labelledby="bal-head"] .tblwrap .balbar')]; const top = Math.max(...rows.map((r) => Math.max(r.supply_cu, r.demand_cu))); return bars.length === rows.length && rows.every((r, i) => { const w = (c, p) => parseFloat(bars[i].querySelector(c).style[p]); return Math.abs(w('.balbar__supply', 'width') - r.supply_cu / top * 100) < 1 && Math.abs(w('.balbar__ceiling', 'left') - r.ceiling_cu / top * 100) < 1 && Math.abs(w('.balbar__demand', 'left') - Math.min(100, r.demand_cu / top * 100)) < 1 && bars[i].getAttribute('role') === 'img' && bars[i].getAttribute('aria-label').includes(N(r.demand_cu)); }); }, api.balance.rows));
      await js(() => { document.querySelector('[aria-labelledby="bal-head"] .tblwrap tbody tr').click(); return true; });
      await waitFor(() => /pools\/pool-eastus/.test(location.hash), 'the East US plan');
      check('balance: clicking a pool opens its plan', /pools\/pool-eastus-01-intel-icx/.test(await js(() => location.hash)));
      await go('/planning');
      await waitFor(() => document.querySelectorAll('[aria-labelledby="bal-head"] .tblwrap tbody tr').length === 6, 'the balance again');
      await pick('select[aria-label="Horizon"]', 'Next 3 months');
      const a3 = await (await fetch(`${base}/api/planning?horizon=13`)).json();
      await waitFor(() => /at 3 months/.test(document.querySelector('#bal-head').closest('section').querySelector('.card__head').innerText), 'the 3-month balance');
      check('balance: at 3 months the balance is read at 3 months, and it is the API\'s sentence for 3 months', await js((h) => document.querySelector('#bal-head').closest('section').querySelector('.panel__hint').innerText.trim() === h, a3.balance.headline) && a3.balance.headline !== api.balance.headline);
      await pick('select[aria-label="Horizon"]', 'Next 12 months');
      await waitFor(() => /at 12 months/.test(document.querySelector('#bal-head').closest('section').querySelector('.card__head').innerText), 'back to 12 months');
      await shot('planning-balance');
    });

    await step('planning: the supply view has its six figures, the pools behind them, and the inventory it took over', async () => {
      await go('/planning/supply');
      await waitFor(() => document.querySelectorAll('.kpis .kpi').length === 6 && document.getElementById('sp-head') && document.querySelectorAll('.ov-inv tbody tr').length > 0, 'the supply view');
      const api = await (await fetch(`${base}/api/planning`)).json();
      const N = (x) => Math.round(x).toLocaleString('en-US');
      await js(() => { window.N = (x) => Math.round(x).toLocaleString('en-US'); return true; });
      check('supply: the Supply view tab is the open one, on its own address', await js(() => { const t = [...document.querySelectorAll('.viewtab')]; return t[1].classList.contains('viewtab--active') && /Supply view/.test(t[1].innerText) && location.hash === '#/planning/supply' && /^Capacity Planning$/.test(document.querySelector('h1').innerText.trim()); }));
      check('supply: the answer line is the API\'s', await text('.ovanswer__text') === api.supply.headline && /^Today 41,088 CU is installed across 6 pools/.test(api.supply.headline), await text('.ovanswer__text'));
      check('supply: six figures, in the order of the design', await js(() => [...document.querySelectorAll('.kpis .kpi__label')].map((x) => x.innerText.replace(/\s*i$/, '').trim()).join('|') === 'Capacity available|Pool capacity|Utilization|Headroom|Health|Cost'));
      check('supply: each figure is the API\'s, with its note', await js((tiles) => { const c = [...document.querySelectorAll('.kpis .kpi')]; return tiles.length === 6 && tiles.every((t, i) => c[i].innerText.includes(t.note) && c[i].querySelector('.info').title === t.definition); }, api.supply.tiles));
      check('supply: the big numbers read as their unit: CU, a percentage, a pool count, dollars', await js((v) => { const b = [...document.querySelectorAll('.kpis .kpi__value')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()); return b[0] === `${v.available} CU` && b[1] === `${v.capacity} CU` && b[2] === `${v.util}%` && b[3] === `${v.headroom} CU` && b[4] === `${v.health} / 6 pools` && /^\$34\.22M$/.test(b[5]); },
        { available: N(api.supply.tiles[0].value), capacity: N(api.supply.tiles[1].value), util: Math.round(api.supply.tiles[2].value * 100), headroom: N(api.supply.tiles[3].value), health: api.supply.tiles[4].value }));
      check('supply: one row per pool with installed capacity, what lands, utilization, headroom, health and value', await js((rows) => { const tr = [...document.getElementById('sp-head').closest('section').querySelectorAll('tbody tr')]; return tr.length === rows.length && rows.every((r, i) => tr[i].innerText.includes(r.region) && tr[i].innerText.includes(N(r.installed_cu)) && tr[i].innerText.includes(N(r.headroom_cu)) && tr[i].innerText.includes(Math.round(r.utilization * 100) + '%') && tr[i].innerText.includes(`${r.incidents_90d} incident`)); }, api.supply.rows));
      check('supply: the inventory and the optimization opportunities are here now, not on the balance', await js(() => document.querySelectorAll('.ov-inv tbody tr').length === 4 && document.querySelectorAll('.ov-opt tbody tr').length === 2 && !document.getElementById('bal-head')));
      await clickText('button', 'GPU');
      await waitFor(() => document.querySelectorAll('.ov-inv tbody tr').length === 2, 'GPU inventory');
      check('supply: the inventory GPU tab shows the two GPU SKUs', await js(() => [...document.querySelectorAll('.ov-inv tbody tr')].every((r) => /GPU/.test(r.innerText))));
      await pick('select[aria-label="SKUs"]', 'GPU');
      const gpu = await (await fetch(`${base}/api/planning?sku=gpu`)).json();
      await waitFor(() => document.getElementById('sp-head').closest('section').querySelectorAll('tbody tr').length === 2, 'the GPU pools');
      check('supply: the SKU filter narrows the figures and the pools to the two GPU pools', await js((g) => { const b = [...document.querySelectorAll('.kpis .kpi__value')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()); return b[1] === `${g.capacity} CU` && /^Today 8,448 CU/.test(document.querySelector('.ovanswer__text').innerText); }, { capacity: N(gpu.supply.tiles[1].value) }));
      await pick('select[aria-label="SKUs"]', 'All SKUs');
      await pick('select[aria-label="Horizon"]', 'Next 6 months');
      await waitFor(() => /lands by 6 months/i.test(document.getElementById('sp-head').closest('section').innerText), 'the 6-month supply');
      const h26 = await (await fetch(`${base}/api/planning?horizon=26`)).json();
      check('supply: the horizon moves what lands and its note', await js((n) => document.querySelectorAll('.kpis .kpi')[0].innerText.includes(n), h26.supply.tiles[0].note));
      await pick('select[aria-label="Horizon"]', 'Next 12 months');
      await shot('planning-supply');
    });

    await step('planning: the demand view has its six figures, the demand by pool, the business events, and the request behind them', async () => {
      await go('/planning/demand');
      await waitFor(() => document.getElementById('dv-head') && document.querySelectorAll('.kpis .kpi').length === 12 && document.querySelector('cap-team-chart svg .ol-dem') && document.querySelectorAll('[aria-labelledby="dp-head"] .tblwrap tbody tr').length === 6, 'the demand view');
      const api = await (await fetch(`${base}/api/planning`)).json();
      const ov = await (await fetch(`${base}/api/overview`)).json();
      const N = (x) => Math.round(x).toLocaleString('en-US');
      await js(() => { window.N = (x) => Math.round(x).toLocaleString('en-US'); return true; });
      check('demand: the answer line is the API\'s, and it is the portfolio, not one request', await js((h) => document.querySelector('#dv-head + .ovanswer__text').innerText.trim() === h, api.demand.headline) && /^Demand at 12 months is 39,334 CU/.test(api.demand.headline));
      check('demand: six figures, in the order of the design', await js(() => [...document.querySelectorAll('.kpis')[0].querySelectorAll('.kpi__label')].map((x) => x.innerText.replace(/\s*i$/, '').trim()).join('|') === 'Product demand|Workload forecast|Growth|Pipeline|Business events|Capacity requests'));
      check('demand: each figure is the API\'s, with its note and its definition', await js((tiles) => { const c = [...document.querySelectorAll('.kpis')[0].querySelectorAll('.kpi')]; return tiles.length === 6 && tiles.every((t, i) => c[i].innerText.includes(t.note) && c[i].querySelector('.info').title === t.definition); }, api.demand.tiles));
      check('demand: Product demand is the same number as the balance\'s Total demand, and carries its change against last quarter', await js((v, d) => { const c = document.querySelectorAll('.kpis')[0].querySelectorAll('.kpi')[0]; return c.innerText.includes(v) && /▲ \+\d+%/.test(c.querySelector('.delta').innerText) && d > 0; }, N(ov.kpis.total_demand.value), api.demand.tiles[0].delta_pct));
      check('demand: the requests figure counts what is waiting and says how many are at risk', await js(() => { const c = document.querySelectorAll('.kpis')[0].querySelectorAll('.kpi')[5]; return /9/.test(c.querySelector('.kpi__value').innerText) && /4,190 CU asked, 1 at risk/.test(c.innerText) && c.querySelector('.kpi__icon--bad'); }));
      check('demand: demand by pool has a row for each pool, with the East US pipeline and four requests', await js((rows) => { const tr = [...document.querySelectorAll('[aria-labelledby="dp-head"] .tblwrap tbody tr')]; return tr.length === rows.length && rows.every((r, i) => tr[i].innerText.includes(r.region) && tr[i].innerText.includes(N(r.demand_cu))) && /4 \(2,540 CU\)/.test(tr[0].innerText); }, api.demand.rows));
      check('demand: the business events are listed once each, in date order, contracts and events together', await js((ev) => { const tr = [...document.getElementById('ev-head').closest('section').querySelectorAll('tbody tr')]; return tr.length === ev.length && ev.every((e, i) => tr[i].innerText.includes(e.title) && tr[i].innerText.includes(e.effect)) && /Adatum Corporation/.test(tr[0].innerText); }, api.demand.events));
      const below = await js(() => ({ head: document.querySelector('.ovsection h2').innerText.replace(/\s+/g, ' ').trim(), figures: document.querySelectorAll('[aria-label="Key figures for this request"] .kpi').length, asks: document.getElementById('tq-head').innerText.trim() }));
      check('demand: the request the team asked about is one section down, with its own answer and six figures', /capacity request/i.test(below.head) && /requests from contoso/i.test(below.head) && below.figures === 6 && /^will req-1004 /i.test(below.asks), JSON.stringify(below));
      await pick('select[aria-label="Horizon"]', 'Next 3 months');
      await waitFor(() => document.getElementById('ev-head').closest('section').querySelectorAll('tbody tr').length === 2, 'the 3-month events');
      check('demand: at 3 months only the 1 Dec contract and the 14 Dec spike are dated', await js(() => [...document.getElementById('ev-head').closest('section').querySelectorAll('tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ')).every((t, i) => (i === 0 ? /Adatum/.test(t) : /Year-end reporting peak/.test(t)))));
      await pick('select[aria-label="Horizon"]', 'Next 12 months');
      await waitFor(() => document.getElementById('ev-head').closest('section').querySelectorAll('tbody tr').length === 9, 'the 12-month events');
      await pick('select[aria-label="Regions"]', 'Europe');
      await waitFor(() => document.querySelectorAll('[aria-labelledby="dp-head"] .tblwrap tbody tr').length === 2 && [...document.querySelectorAll('.tm-req tbody tr')].every((x) => /West Europe/.test(x.innerText)), 'Europe');
      const eur = await (await fetch(`${base}/api/planning?region=europe`)).json();
      check('demand: the region filter narrows the portfolio figures and the request table together', await js((e) => document.querySelectorAll('[aria-labelledby="dp-head"] .tblwrap tbody tr').length === 2 && document.querySelectorAll('.kpis')[0].querySelectorAll('.kpi')[5].innerText.includes(e.note) && [...document.querySelectorAll('.tm-req tbody tr')].every((x) => /West Europe/.test(x.innerText)), eur.demand.tiles[5]));
      await pick('select[aria-label="Regions"]', 'All regions');
      await shot('planning-demand');
    });

    // ------------------------------------------------------------------ product team (requester)
    await step('team: the requester view opens on the request at risk, with every figure from the API', async () => {
      await go('/team');
      await waitFor(() => /^Partly\./.test((document.querySelector('#tq-head + .ovanswer__text') || {}).innerText || '') && document.querySelectorAll('[aria-label="Key figures for this request"] .kpi').length === 6 && document.querySelector('cap-team-chart svg .ol-dem'), 'the requester view');
      const api = await (await fetch(`${base}/api/requester`)).json();
      const N = (x) => Math.round(x).toLocaleString('en-US');
      check('team: the request view is the Demand view of Capacity Planning, and the rail shows it', /^Capacity Planning$/.test(await text('h1')) && await js(() => document.querySelector('.rail a[href="#/planning"]').classList.contains('is-active') && location.hash === '#/planning/demand'));
      check('team: the Demand view tab is the open one', await js(() => { const t = [...document.querySelectorAll('.viewtab')]; return t.length === 3 && t[2].classList.contains('viewtab--active') && /Demand view/.test(t[2].innerText) && !t[0].classList.contains('viewtab--active'); }));
      check('team: the answer line is the API\'s and says how much arrives in time', await text('#tq-head + .ovanswer__text') === api.recommendation.answer && /547 CU of 640 CU/.test(api.recommendation.answer), await text('#tq-head + .ovanswer__text'));
      check('team: it opens on the org with a request at risk, and that request', await js((a) => { const sel = (q) => { const x = document.querySelector(q); return x.options[x.selectedIndex].textContent.trim(); }; return /^Contoso \(1 at risk\)$/.test(sel('.ovsection select[aria-label="Team"]')) && sel('.ovsection select[aria-label="Request"]').startsWith(a.selected.request_id) && sel('.pagehead select[aria-label="Regions"]') === 'All regions'; }, api));
      check('team: six KPI cards worded as the wireframe', await js(() => { const l = [...document.querySelectorAll('[aria-label="Key figures for this request"] .kpi .kpi__label')].map((x) => x.innerText.trim()); return l.length === 6 && ['Current usage', 'Total demand (12M)', 'Additional required', 'Request status', 'Revenue at risk', 'Est. cost'].every((s, i) => l[i].startsWith(s)); }));
      const k = api.kpis;
      check('team: the KPI values are the API\'s', await js((v) => { const c = [...document.querySelectorAll('[aria-label="Key figures for this request"] .kpi')].map((x) => x.innerText); return c[0].includes(v.use) && c[0].includes(v.share) && c[1].includes(v.demand) && c[2].includes(v.add) && /At risk/.test(c[3]) && /\$3\.10M/.test(c[4]) && /\$21K/.test(c[5]); },
        { use: N(k.current_usage.cu), share: `${Math.round(k.current_usage.share_of_allocated * 100)}% of ${N(k.current_usage.allocated_cu)} CU allocated`, demand: N(k.total_demand.cu), add: N(k.additional_required.cu) }));
      check('team: every KPI says how it is worked out', await js(() => [...document.querySelectorAll('[aria-label="Key figures for this request"] .kpi .info')].length === 6 && [...document.querySelectorAll('[aria-label="Key figures for this request"] .kpi .info')].every((b) => (b.title || '').length > 40)));
      check('team: the recommendation has why, impact and next steps, and claims no probability', await js((r) => { const c = document.querySelector('.tm-rec'); const h = [...c.querySelectorAll('h4')].map((x) => x.innerText.trim().toLowerCase()); return h.join() === 'why,impact,next steps' && c.innerText.includes(r.headline) && c.querySelectorAll('ol li').length === r.next_steps.length && !/\d+\s*%\s*confiden/i.test(c.innerText) && /claims no probability/.test(c.innerText); }, api.recommendation));
      check('team: the timeline shows every step, with the late part marked at risk', await js((t) => { const li = [...document.querySelectorAll('.tline__item')]; return li.length === t.length && li.some((x) => x.classList.contains('tline__item--risk') && /Remaining 93 CU/.test(x.innerText)) && li[0].classList.contains('tline__item--done'); }, api.timeline));
      check('team: the chart draws demand, usage and capacity, and calls out the need date', await js(() => { const s = document.querySelector('cap-team-chart svg'); return !!s.querySelector('.ol-dem') && !!s.querySelector('.ot-use') && !!s.querySelector('.ol-prov') && /Need additional capacity/.test(s.innerHTML) && /25 Jan 2027 \(93 CU\)/.test(s.innerHTML); }));
      check('team: capacity is a step line and demand a curve', await js(() => /^M[\d. ]+( [HV][\d. ]+)+$/.test(document.querySelector('cap-team-chart .ol-prov').getAttribute('d')) && /C/.test(document.querySelector('cap-team-chart .ol-dem').getAttribute('d'))));
      await js(() => { const h = document.querySelector('cap-team-chart .hit'); const r = h.getBoundingClientRect(); h.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.8, clientY: r.top + 20, bubbles: true })); });
      check('team: hovering the chart lists all three series for a week', await js(() => { const t = document.querySelector('cap-team-chart .chart-tip'); return t.style.display === 'block' && t.querySelectorAll('.chart-tip__row').length === 3 && /Capacity you can count on/.test(t.innerText); }));
      check('team: the chart legend names the three lines', await js(() => { const l = [...document.querySelectorAll('.tm-fc .legend span')].map((x) => x.innerText.trim()); return l.join('|') === 'Forecast demand|Current usage (trend)|Capacity you can count on'; }));
      check('team: the table under the chart has the monthly values', await js((p) => { const rows = document.querySelectorAll('.tm-fc .tableview tbody tr'); return rows.length === p.length && rows[p.length - 1].textContent.includes(Math.round(p[p.length - 1].demand).toLocaleString('en-US')); }, api.forecast.points));   // closed <details>: textContent, not innerText
      check('team: the requests table lists every request, at risk first, the open one highlighted', await js((a) => { const tr = [...document.querySelectorAll('.tm-req tbody tr')]; return tr.length === a.requests.counts.all && /At risk/.test(tr[0].innerText) && tr[0].classList.contains('is-selected') && tr.filter((x) => x.classList.contains('is-selected')).length === 1 && /REQ-1004/.test(tr[0].innerText); }, api));
      check('team: the tabs carry the counts', await js((c) => [...document.querySelectorAll('.tm-req .tab2')].map((x) => x.innerText.trim()).join('|') === `All (${c.all})|At risk (${c.at_risk})|In review (${c.in_review})|Approved (${c.approved})|Completed (${c.completed})`, api.requests.counts));
      check('team: options recommend exactly one, first, and it is phasing', await js(() => { const tr = [...document.querySelectorAll('.tm-opt tbody tr')]; return tr.length >= 4 && tr.filter((x) => /Recommended/.test(x.innerText)).length === 1 && /Recommended/.test(tr[0].innerText) && /Phase it/.test(tr[0].innerText); }));
      check('team: cost shows what is held, what exists and what is new, and says it is not annual', await js((c) => { const li = document.querySelectorAll('.tm-cost .tm-bars li'); const t = document.querySelector('.tm-cost').innerText; return li.length === 3 && t.includes('New spend') && /\$21K/.test(t) && /not annual/.test(t) && c.bars.length === 3; }, api.cost));
      check('team: risks lead with this request, then the pool\'s funnels', await js(() => { const li = [...document.querySelectorAll('.tm-risk li')]; return li.length >= 3 && /Capacity lands after it is needed/.test(li[0].innerText) && /High/.test(li[0].innerText); }));
      check('team: utilization is a ring with the share in the middle', await js((u) => { const s = document.querySelector('.tm-ring'); return !!s && s.querySelector('.tm-ring__used').getAttribute('stroke-dasharray').split(' ').length === 2 && s.querySelector('.tm-ring__pct').textContent.trim() === Math.round(u.used_share * 100) + '%'; }, api.utilization));
      check('team: drivers add up to 100%', await js(() => [...document.querySelectorAll('.tm-drv .tm-bars__row .num')].reduce((s, e) => s + parseInt(e.innerText, 10), 0) === 100));
      check('team: business impact and details come from the record', await js((r) => { const b = document.querySelector('.tm-biz').innerText; const d = document.querySelector('.tm-det').innerText; return b.includes(r.business_impact.rows[1].value) && /As stated by the requester/.test(b) && d.includes('Production') && d.includes('East US') && d.includes(r.details.use_case); }, api));
      check('team: Create new request goes to the request form', await js(() => document.querySelector('.pagehead a.btn--primary').getAttribute('href') === '#/requests'));
      check('team: it is labelled synthetic', /Synthetic data/i.test(await text('.appbar')));
      await shot('team');
    });
    await step('team: choosing a request, a tab, a region and a horizon changes the view', async () => {
      await go('/team');
      await waitFor(() => /^Partly\./.test((document.querySelector('#tq-head + .ovanswer__text') || {}).innerText || ''), 'the requester view');
      await clickText('.tm-req .tab2', 'At risk (1)');
      check('team: the At risk tab keeps only the request at risk', await count('.tm-req tbody tr') === 1);
      await clickText('.tm-req .tab2', 'All (10)');
      await js(() => { const tr = [...document.querySelectorAll('.tm-req tbody tr')].find((x) => /REQ-1001/.test(x.innerText)); tr.click(); return true; });
      await waitFor(() => /^Yes\. All 480 CU/.test((document.querySelector('#tq-head + .ovanswer__text') || {}).innerText || ''), 'REQ-1001 answer');
      check('team: clicking a row opens that request, whose answer is yes', await js(() => /REQ-1001/.test(document.querySelector('.tm-det').innerText) && document.querySelector('.tm-req tr.is-selected').innerText.includes('REQ-1001') && !document.querySelector('.tm-tl .tline__item--risk')));
      check('team: nothing to order means no callout and no cost', await js(() => !/Need additional capacity/.test(document.querySelector('cap-team-chart svg').innerHTML) && /\$0/.test(document.querySelectorAll('[aria-label="Key figures for this request"] .kpi')[5].innerText) && /Nothing needs ordering/.test(document.querySelectorAll('[aria-label="Key figures for this request"] .kpi')[2].innerText)));
      await pick('.ovsection select[aria-label="Request"]', 'REQ-0801');
      await waitFor(() => /^Delivered/.test((document.querySelector('#tq-head + .ovanswer__text') || {}).innerText || ''), 'the completed request');
      check('team: a delivered request has a plain status and no options', await js(() => /Completed/.test(document.querySelectorAll('[aria-label="Key figures for this request"] .kpi')[3].innerText) && /Nothing to decide/.test(document.querySelector('.tm-opt').innerText) && /Delivered/.test(document.querySelector('.tm-tl').innerText)));
      await pick('.pagehead select[aria-label="Regions"]', 'Europe');
      await waitFor(() => document.querySelectorAll('.tm-req tbody tr').length === 2, 'Europe rows');
      check('team: the region filter narrows the table and moves the selection into that region', await js(() => [...document.querySelectorAll('.tm-req tbody tr')].every((x) => /West Europe/.test(x.innerText)) && /West Europe/.test(document.querySelector('.tm-fc h3').innerText)));
      await pick('.pagehead select[aria-label="Regions"]', 'All regions');
      await pick('.ovsection select[aria-label="Team"]', 'Northwind');
      await waitFor(() => document.querySelectorAll('.tm-req tbody tr').length === 1 && /Northwind/.test(document.querySelector('.ovsection').innerText), 'Northwind');
      check('team: another team has its own requests, and the page\'s region filter still applies', await js(() => /REQ-2001/.test(document.querySelector('.tm-req').innerText) && document.querySelector('.pagehead select[aria-label="Regions"]').selectedIndex === 0));
      await pick('.ovsection select[aria-label="Team"]', 'Contoso');
      await waitFor(() => /^Partly\./.test((document.querySelector('#tq-head + .ovanswer__text') || {}).innerText || ''), 'back on Contoso');
      await clickText('.tm-fc .tab2', '3 months');
      await waitFor(() => document.querySelector('.tm-fc .panel__note') && /beyond this view/.test(document.querySelector('.tm-fc').innerText), 'the 3-month view');
      check('team: a 3-month view says the need date is beyond it instead of drawing it', await js(() => !/Need additional capacity/.test(document.querySelector('cap-team-chart svg').innerHTML) && document.querySelectorAll('.tm-fc .tableview tbody tr').length === 4));
      await clickText('.tm-fc .tab2', '12 months');
      await waitFor(() => /Need additional capacity/.test((document.querySelector('cap-team-chart svg') || { innerHTML: '' }).innerHTML), 'the 12-month view');
      check('team: back to 12 months, the callout returns', true);
    });
    await step('action queue: every action, ranked, with category tabs', async () => {
      await click('.btn--actions');
      await waitFor(() => /actions/.test(location.hash) && document.querySelectorAll('.tbl tbody tr').length >= 13, 'the queue');
      check('action queue: 13 actions, P0 first', (await count('.tbl tbody tr')) === 13 && await js(() => document.querySelector('.tbl tbody tr .ptag').innerText.trim() === 'P0'));
      await clickText('button', 'Allocation (5)');
      await waitFor(() => document.querySelectorAll('.tbl tbody tr').length === 5, 'allocation tab');
      check('action queue: the Allocation tab lists reclaim and reallocation only', await js(() => [...document.querySelectorAll('.tbl tbody tr')].every((r) => /Reclaim|Reallocate/.test(r.innerText))));
      await shot('action-queue');
      await go('/overview');
      await waitFor(() => document.querySelectorAll('.rec').length >= 2, 'overview again');
    });

    // ------------------------------------------------------------------ pool page
    await step('pool: opens from the action card', async () => {
      await clickText('a.btn', 'Review the plan');
      await waitFor(() => /pools\/pool-eastus/.test(location.hash) && document.querySelector('.answer__text') && /Order 4,032/.test(document.querySelector('.answer__text').innerText), 'East US plan');
      check('pool: plan headline and lead time shown', /Order 4,032 CU of FAB-AMD-GENOA-96 today/.test(await text('.answer__text')));
    });
    await step('pool: chart draws series and markers, and hover shows a tooltip', async () => {
      await waitFor(() => document.querySelectorAll('.chart svg path').length > 8, 'chart paths');
      check('chart: history, forecast, usable and ceiling lines exist', (await count('.chart .l-hist, .chart .l-fc, .chart .l-usable, .chart .l-ceiling')) === 4);
      check('chart: three keyed markers plus event markers', (await count('.chart g[class^="mk-"]')) >= 4);
      await js(() => {
        const hit = document.querySelector('.chart .hit'); const r = hit.getBoundingClientRect();
        hit.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.7, clientY: r.top + 40, bubbles: true }));
      });
      const tip = await text('.chart-tip');
      check('chart: tooltip lists every series at that week', /Forecast/.test(tip) && /Capacity/.test(tip) && /Working ceiling/.test(tip), tip);
      check('chart: markers are also listed in words', (await count('.chart-notes li')) >= 4);
      check('chart: a table view exists', (await count('details.tableview')) === 1);
    });
    await step('pool: why-now lists the flagged signals and the one that sets the date', async () => {
      check('trace: 7 flagged funnels for East US', (await count('.trace .sig')) === 7, String(await count('.trace .sig')));
      check('trace: the demand signal is marked "Sets the date"', /Demand[\s\S]*Sets the date/.test(await text('.trace .sig')));
      await click('.sig__toggle');
      await waitFor(() => document.querySelectorAll('.trace .evidence').length >= 1, 'evidence panel');
      check('trace: evidence names its source records and feed owner', /Reads[\s\S]*feed[\s\S]*owned by/.test(await text('.trace .evidence')));
      await click('input[ng-model="vm.showAll"]');
      await waitFor(() => document.querySelectorAll('.trace .sig').length === 14, 'all 14 funnels');
      check('trace: "show all" reveals all 14 funnels', true);
    });
    if (havePeak) {
      await step('pool: the busiest-hour panel shows the ladder and both plans side by side', async () => {
        const pk = (await (await fetch(`${base}/api/pools/pool-eastus-01-intel-icx`)).json()).peak_check;
        const N = (x) => Math.round(x).toLocaleString('en-US');
        await waitFor(() => document.querySelector('#peakp-head') && document.querySelector('.ladder__mean'), 'the busiest-hour panel');
        const panel = await js(() => document.querySelector('.peakpanel').innerText);
        check('busiest hour: the panel says what the API says', panel.replace(/\s+/g, ' ').includes(pk.headline), panel.slice(0, 160));
        check('busiest hour: the ladder draws the mean, the busiest hour past the ceiling, the ceiling and next week\'s forecast', await js(() => !!document.querySelector('.ladder__mean') && !!document.querySelector('.ladder__peak--over') && !!document.querySelector('.ladder__ceiling') && !!document.querySelector('.ladder__next')));
        check('busiest hour: the marks sit where the shares are', await js((a) => { const w = (sel, prop) => parseFloat(document.querySelector(sel).style[prop]); return Math.abs(w('.ladder__mean', 'width') - a.mean * 100) < 0.05 && Math.abs(w('.ladder__ceiling', 'left') - a.ceiling * 100) < 0.05 && Math.abs(w('.ladder__next', 'left') - a.next * 100) < 0.05; }, { mean: pk.now.mean_share, ceiling: pk.now.ceiling_pct, next: pk.next_week.share_p80 }));
        check('busiest hour: the two plans sit side by side, the order and its difference shown', await js((p, m, k) => { const rows = [...document.querySelectorAll('.peakcmp tbody tr')]; return rows.length === 5 && rows[0].innerText.includes(p.mean_basis.state) && rows[3].innerText.includes(m) && rows[3].innerText.includes(k) && rows[3].innerText.includes(`+${p.extra_cu.toLocaleString('en-US')}`); }, pk.plan, N(pk.plan.mean_basis.order_cu), N(pk.plan.peak_basis.order_cu)));
        check('busiest hour: it says the plan is unchanged and the ceiling question is for planners', /the plan above is unchanged/.test(panel) && /for planners to decide/.test(panel));
        check('busiest hour: the pool\'s own plan is still the weekly-mean plan', /Order 4,032 CU of FAB-AMD-GENOA-96 today/.test(await text('.answer__text')));
        await shot('pool-peak');
      });
    }
    await step('pool: the plain-words explanation is written, checked and copyable', async () => {
      check('ai: the panel says the model cannot change the plan', /cannot change a date, quantity or SKU/.test(await text('#ai-head + .panel__hint')));
      await clickText('button', 'Explain this plan');
      await waitFor(() => /AI, figures checked/.test(document.querySelector('.pill--low')?.innerText || '') || /AI, figures checked/.test(document.body.innerText), 'AI badge');
      const panel = await js(() => [...document.querySelectorAll('.panel')].find((p) => p.querySelector('#ai-head')).innerText);
      check('ai: a faithful answer is shown with its badge', /AI, figures checked/.test(panel) && /In plain words: Order 4,032 CU of FAB-AMD-GENOA-96/.test(panel));
      check('ai: a request draft with a copy button is offered', /Request draft/i.test(panel) && /Copy the draft/.test(panel));
      check('ai: the key never reaches the browser', !(await js(() => document.documentElement.outerHTML.includes('ui-test-key'))));
      await shot('pool-ai');
    });
    await step('pool: an answer with an invented figure is withheld in the browser', async () => {
      await go('/pools/pool-japaneast-01-gpu-l40s');
      await waitFor(() => /Japan East/.test(document.querySelector('h1')?.innerText || '') && document.querySelector('.answer__text'), 'Japan East plan');
      await clickText('button', 'Explain this plan');
      await waitFor(() => /AI text withheld/.test(document.body.innerText), 'withheld badge');
      const panel = await js(() => [...document.querySelectorAll('.panel')].find((p) => p.querySelector('#ai-head')).innerText);
      check('ai: the withheld notice names the problem and shows rules-based text instead', /withheld because it contained 1 figure/.test(panel) && /Rules-based text/.test(panel) && !/9,999/.test(panel.split('What the model saw')[0]), panel.slice(0, 200));
      await go('/pools/pool-eastus-01-intel-icx');
      await waitFor(() => /East US/.test(document.querySelector('h1')?.innerText || '') && document.querySelector('.answer__text'), 'back to East US');
    });
    await step('pool: with AI switched off the explanation is rules-based and says nothing leaves the machine', async () => {
      await send('Page.navigate', { url: `${baseOff}/#/pools/pool-eastus-01-intel-icx` });
      await waitFor(() => document.querySelector('.answer__text') && /Order 4,032/.test(document.querySelector('.answer__text').innerText), 'plan on the AI-off lab');
      check('ai off: the panel explains why and promises nothing leaves the machine', /AI is not configured[\s\S]*Nothing leaves this machine/.test(await js(() => [...document.querySelectorAll('.panel')].find((p) => p.querySelector('#ai-head')).innerText)));
      await clickText('button', 'Explain this plan');
      await waitFor(() => /AI not configured/.test(document.body.innerText), 'rules badge');
      check('ai off: rules-based text is still written', /Capacity request: 4,032 CU of FAB-AMD-GENOA-96/.test(await js(() => [...document.querySelectorAll('.panel')].find((p) => p.querySelector('#ai-head')).innerText)));
      await send('Page.navigate', { url: `${base}/#/pools/pool-eastus-01-intel-icx` });
      await waitFor(() => document.querySelector('.answer__text') && /Order 4,032/.test(document.querySelector('.answer__text').innerText), 'back on the AI lab');
    });
    await step('peak: with no profile the check says why, and nothing else changes', async () => {
      await send('Page.navigate', { url: `${baseOff}/#/overview` });
      // wait for rendered text, not just elements: before AngularJS compiles, the raw template (all its ng-if blocks) is in the page
      await waitFor(() => /No\. 1 of 6 pools/.test(document.querySelector('.ovanswer__text')?.innerText || '') && /No peak profile/.test(document.querySelector('.ov-peak')?.innerText || ''), 'the overview without a profile');
      const offText = await text('.ov-peak');
      check('peak off: the Overview says the check is off and how to turn it on', /The peak check is off: No peak profile\. Run npm run ml/.test(offText), String(offText).slice(0, 200));
      check('peak off: there is no table of figures', (await count('.ov-peak tbody tr')) === 0 && (await count('.ov-peak .facts')) === 0, `rows ${await count('.ov-peak tbody tr')}, facts ${await count('.ov-peak .facts')}`);
      const offHead = await text('.ovanswer__text');
      check('peak off: the rest of the Overview is the same', /No\. 1 of 6 pools/.test(offHead) && (await count('.rec')) >= 2, String(offHead));
      await send('Page.navigate', { url: `${baseOff}/#/pools/pool-eastus-01-intel-icx` });
      await waitFor(() => document.querySelector('.peakpanel') && /Order 4,032/.test(document.querySelector('.answer__text')?.innerText || ''), 'the pool page without a profile');
      check('peak off: the pool page says so, and the plan is the same', /The peak check is off/.test(await text('.peakpanel')) && (await count('.ladder')) === 0);
      await send('Page.navigate', { url: `${base}/#/pools/pool-eastus-01-intel-icx` });
      await waitFor(() => document.querySelector('.answer__text') && /Order 4,032/.test(document.querySelector('.answer__text').innerText), 'back on the main lab');
    });
    await step('pool: what-if recomputes without saving', async () => {
      await setVal('#wi-l', 8);
      await waitFor(() => document.querySelector('.is-changed') && /PLAN/.test(document.body.innerText.split('What if')[1] || ''), 'what-if diff');
      check('what-if: an 8-week lead time turns OVERDUE into PLAN', true);
      const summary = await (await fetch(`${base}/api/summary`)).json();
      check('what-if: nothing was saved', summary.actions[0].state === 'OVERDUE');
    });
    await step('pool: decision guardrails refuse, then approve places an order', async () => {
      await setVal('#dec-by', 'engine');
      await clickText('button', 'Approve');
      await waitFor(() => /cannot approve/.test((document.querySelector('.msgbar--danger') || {}).innerText || ''), 'engine refusal');
      check('decision: the engine cannot approve its own plan', true);
      await setVal('#dec-by', 'Asha Rao');
      await setVal('#dec-qty', 3840);
      await clickText('button', 'Approve');
      await waitFor(() => /Say why/.test((document.querySelector('.msgbar--danger') || {}).innerText || ''), 'reason refusal');
      check('decision: a changed quantity needs a reason', true);
      await setVal('#dec-reason', 'Phase the order to fit the quarter budget');
      await clickText('button', 'Approve');
      await waitFor(() => /ORD-LAB-0001/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'approval message');
      check('decision: approval records the decision and places order ORD-LAB-0001', true);
      await waitFor(() => document.querySelectorAll('.panel--critical, .panel--high, .panel--medium, .panel--good, .panel--accent').length > 0 && /Approved by Asha Rao/.test(document.body.innerText), 'approved pill');
      check('decision: the pool now shows who approved it', true);
      await shot('pool-east-us');
    });

    // ------------------------------------------------------------------ requests
    await step('requests: submit a request and see what changed', async () => {
      await go('/requests');
      await waitFor(() => document.querySelectorAll('.tbl tbody tr').length >= 9 && document.querySelector('#rq-title'), 'request table');
      await pick('#rq-pool', 'West Europe');
      await setVal('#rq-title', 'Warehouse scale-out');
      await setVal('#rq-cu', 9000);
      await clickText('button', 'Submit request');
      await waitFor(() => /What changed/.test(document.body.innerText) && document.querySelector('.tbl tr.is-changed'), 'what-changed card');
      check('requests: the what-changed card shows the pool state moving', await js(() => [...document.querySelectorAll('tr.is-changed')].some((tr) => /State/.test(tr.innerText) && /OK/.test(tr.innerText))));
      check('requests: the new request joins the pipeline table', /Warehouse scale-out/.test(await js(() => [...document.querySelectorAll('.tbl')].pop().innerText)));
      await shot('requests');
    });
    await step('team: the request just submitted, and the approval before it, show up for the requester', async () => {
      await go('/team');
      await waitFor(() => document.querySelectorAll('.tm-req tbody tr').length > 0 && document.querySelector('cap-team-chart svg .ol-dem'), 'the requester view');
      const api = await (await fetch(`${base}/api/requester?org=contoso`)).json();
      const mine = api.requests.rows.find((r) => r.title === 'Warehouse scale-out');
      check('team: a request submitted on the Requests page is in its team\'s table', !!mine && await js((r) => [...document.querySelectorAll('.tm-req tbody tr')].some((x) => x.innerText.includes(r.request_id) && x.innerText.includes('Warehouse scale-out') && x.innerText.includes(r.status_label)), mine));
      check('team: it is filed under the org named by its team, and counted', await js((c) => document.querySelector('.tm-req .tab2').innerText.trim() === `All (${c})`, api.requests.counts.all) && api.requests.counts.all === 11);
      check('team: the page answer follows the approved East US order (the same API the plan uses)', await text('#tq-head + .ovanswer__text') === api.recommendation.answer);
    });
    await step('requests: the optional business context is kept, linked to the Capacity Planning demand view, and shown as stated', async () => {
      await go('/requests');
      await waitFor(() => document.querySelector('#rq-title') && document.querySelector('.rqctx'), 'the request form');
      check('requests: the business context sits under an optional heading, closed until wanted', await js(() => { const d = document.querySelector('.rqctx'); return d.tagName === 'DETAILS' && !d.open && /optional/i.test(d.querySelector('summary').innerText); }));
      await pick('#rq-pool', 'West Europe');
      await setVal('#rq-team', 'fabrikam-bi');
      await setVal('#rq-title', 'Finance model refresh');
      await setVal('#rq-cu', 120);
      await click('.rqctx summary');
      await setVal('#rq-org', 'Fabrikam');
      await pick('#rq-env', 'Staging');
      await pick('#rq-sla', 'Medium');
      await pick('#rq-strat', 'High');
      await setVal('#rq-rev', 750000);
      await setVal('#rq-commit', 'Year-end close');
      await setVal('#rq-use', 'Nightly refresh of the finance models.');
      await clickText('button', 'Submit request');
      await waitFor(() => /What changed/.test(document.body.innerText) && document.querySelector('a[href^="#/planning/demand?org=fabrikam"]'), 'the confirmation with its link');
      check('requests: the confirmation links to the new request in the Capacity Planning demand view', await js(() => /request=REQ-\d+$/.test(document.querySelector('a[href^="#/planning/demand?org=fabrikam"]').getAttribute('href'))));
      check('requests: what is particular to one request is cleared for the next, including the organisation; the team stays', await js(() => document.querySelector('#rq-use').value === '' && document.querySelector('#rq-rev').value === '' && document.querySelector('#rq-org').value === '' && document.querySelector('#rq-env').value === '' && document.querySelector('#rq-sla').value === '' && document.querySelector('#rq-team').value === 'fabrikam-bi'));
      await click('a[href^="#/planning/demand?org=fabrikam"]');
      await waitFor(() => /Fabrikam/.test((document.querySelector('.ovsection') || {}).innerText || '') && document.querySelector('cap-team-chart svg .ol-dem'), 'the Fabrikam team page');
      check('team: the link opens that team and that request, and the address is left clean', await js(() => /Finance model refresh/i.test(document.querySelector('#tq-head').innerText) && location.hash === '#/planning/demand' && document.querySelector('.tm-req tbody tr.is-selected') && !/\?/.test(location.hash)));
      check('team: what the requester stated is shown as stated', await js(() => { const d = document.querySelector('.tm-det').innerText; const b = document.querySelector('.tm-biz').innerText; return /Staging/.test(d) && d.includes('Nightly refresh of the finance models.') && /Year-end close/.test(b) && /Medium/.test(b) && /High/.test(b) && /\$750K/.test(document.querySelectorAll('[aria-label="Key figures for this request"] .kpi')[4].innerText); }));
      await go('/requests');
      await waitFor(() => document.querySelector('#rq-title'), 'the form again');
      await setVal('#rq-team', 'tailspin-ops');
      await setVal('#rq-title', 'Ops tooling');
      await setVal('#rq-cu', 50);
      await clickText('button', 'Submit request');
      await waitFor(() => document.querySelector('a[href^="#/planning/demand?org=tailspin"]'), 'the second confirmation');
      await click('a[href^="#/planning/demand?org=tailspin"]');
      await waitFor(() => /Tailspin/.test((document.querySelector('.ovsection') || {}).innerText || '') && document.querySelector('.tm-det'), 'the Tailspin team page');
      const blank = await js(() => ({ det: document.querySelector('.tm-det').innerText, biz: document.querySelector('.tm-biz').innerText, kpi: document.querySelectorAll('[aria-label="Key figures for this request"] .kpi')[4].innerText, head: document.querySelector('.ovsection').innerText }));
      check('team: what was left blank reads Not stated, never a guess', ((blank.det + blank.biz).match(/Not stated/g) || []).length === 5 && /Not stated/.test(blank.kpi) && !/Production|\$0/.test(blank.det + blank.kpi), JSON.stringify(blank));
    });

    // ------------------------------------------------------------------ signals
    await step('funnels: a card per funnel, the 14 x 6 matrix and feed health', async () => {
      await go('/funnels');
      await waitFor(() => document.querySelectorAll('.mcell').length >= 84 && document.querySelectorAll('.scn').length >= 14, 'funnel cards and matrix');
      check('funnels: 14 funnel cards', (await count('.scn')) === 14, String(await count('.scn')));
      check('funnels: 84 cells (14 funnels x 6 pools)', (await count('.matrix tbody .mcell')) === 84, String(await count('.matrix tbody .mcell')));
      check('funnels: no extension groups, just the 14 rows', (await count('.matrix tbody tr')) === 14 && (await count('.matrix tr.grp')) === 0);
      check('funnels: the reliability card names the pool it flags', await js(() => { const c = [...document.querySelectorAll('.scn')].find((x) => /Reliability/.test(x.querySelector('h4').innerText)); return /Southeast Asia/.test(c.innerText) && /critical/.test(c.innerText); }));
      check('funnels: a card counts every pool it flags, not just the top three shown', await js(() => { const c = [...document.querySelectorAll('.scn')].find((x) => /Supply Chain/.test(x.querySelector('h4').innerText)); return /6 flagged \(top 3 shown\), 0 quiet, 0 without a record/.test(c.innerText); }));
      check('funnels: demand and performance are marked standard, the rest override', await js(() => { const cards = [...document.querySelectorAll('.scn')]; const std = cards.filter((c) => /standard/.test(c.querySelector('.pill').innerText)).length; return std === 2 && cards.length - std === 12; }));
      check('funnels: stale feeds are marked', (await count('.pill--high')) >= 2);
      await shot('funnels');
    });

    // ------------------------------------------------------------------ ontology
    await step('ontology: seven layers, with the live value of each for every pool', async () => {
      await go('/ontology');
      await waitFor(() => document.querySelectorAll('.ontmatrix tbody tr').length === 7 && document.querySelectorAll('.ontcard').length === 7 && document.querySelector('.spark__line'), 'the ontology page');
      const api = await (await fetch(`${base}/api/ontology`)).json();
      check('ontology: seven layers by six pools', await js(() => document.querySelectorAll('.ontmatrix tbody tr').length === 7 && document.querySelectorAll('.ontmatrix thead th').length === 7 && document.querySelectorAll('.ontmatrix tbody .ontcell').length === 42));
      check('ontology: four recorded and three derived', await js(() => { const k = [...document.querySelectorAll('.ontmatrix tbody tr td:first-child .pill')].map((x) => x.innerText.trim()); return k.length === 7 && k.filter((x) => x === 'recorded').length === 4 && k.filter((x) => x === 'derived').length === 3; }));
      const N = (x) => Math.round(x).toLocaleString('en-US');
      const first = api.pools[0].layers;
      const seen = await js(() => [...document.querySelectorAll('.ontmatrix tbody tr')].map((r) => r.querySelector('.ontcell').innerText.replace(/\s+/g, ' ').trim()));
      const want = [`${N(first.infrastructure.headline.value)} CU`, `${N(first.allocation.headline.value)} CU`, `${Math.round(first.utilization.headline.value * 100)}%`, `${N(first['gap-waste'].headline.value)} CU`, 'End of life', first.reliability.headline.value.toFixed(1), first['planning-horizon'].headline.value];
      check('ontology: the first pool\'s matrix cells are the API values', JSON.stringify(seen) === JSON.stringify(want), `${JSON.stringify(seen)} vs ${JSON.stringify(want)}`);
      const chips = await js(() => [...document.querySelectorAll('.ontmatrix tbody tr:last-child .chip')].map((c) => c.innerText.trim()));
      check('ontology: the plan state uses the same chip as the rest of the lab', chips.join(',') === api.pools.map((p) => p.state).join(','), chips.join(','));
      const urgent = (await (await fetch(`${base}/api/summary`)).json()).actions[0];
      const heading = await text('#ontpool-head');
      check('ontology: the most urgent pool is selected first, with all seven layers', heading === `${urgent.region_label} · ${urgent.sku_id}` && (await count('.ontcard')) === 7 && (await count('.ontmatrix th.is-selected')) === 1, `heading "${heading}", most urgent ${urgent.region_label} · ${urgent.sku_id}`);
      check('ontology: utilization draws 52 weeks against the ceiling', await js(() => document.querySelector('.spark__line').getAttribute('points').split(' ').length === 52 && !!document.querySelector('.spark__ceiling')));
      check('ontology: each derived card says what it is derived from; each card names its readers', await js(() => { const c = [...document.querySelectorAll('.ontcard')]; return c.filter((x) => /Derived from:/.test(x.textContent)).length === 3 && c.every((x) => /Read by:/.test(x.textContent)) && /all 14 funnels/.test(c[6].textContent); }));
      check('ontology: the source file of each recorded layer is named (engineering view)', await js(() => /infrastructure\.json/.test(document.querySelectorAll('.ontcard')[0].textContent) && /incidents\.json/.test(document.querySelectorAll('.ontcard')[5].textContent)));
      await clickText('button.ontpick', 'Southeast Asia');
      await waitFor(() => /Southeast Asia/.test(document.querySelector('#ontpool-head').innerText), 'the second pool selected');
      check('ontology: selecting a pool shows its layers (Southeast Asia: critical health, worst segment named)', await js(() => { const c = document.querySelectorAll('.ontcard')[5].innerText; return /flagged critical/.test(c) && /sea-fabric-2/.test(c) && /35\.0/.test(c); }));
      check('ontology: idle capacity below the flag threshold is shown but not counted', await js(() => { const c = document.querySelectorAll('.ontcard')[3].innerText.replace(/\s+/g, ' '); return /Idle capacity that could be freed 269 CU/.test(c) && /Counted as a reclaim opportunity 0 CU/.test(c); }));
      await js(() => { document.querySelectorAll('button.ontpick')[2].click(); return true; });
      await waitFor(() => /West Europe · FAB-GPU-H100-8/.test(document.querySelector('#ontpool-head').innerText), 'the West Europe GPU pool');
      check('ontology: a SKU with no successor shows a dash, not an invented value', await js(() => /Successor SKU\s*—/.test(document.querySelectorAll('.ontcard')[4].innerText.replace(/\s+/g, ' ')) && /Recommended order\s*1,344 CU/.test(document.querySelectorAll('.ontcard')[6].innerText.replace(/\s+/g, ' '))));
      check('ontology: the rail links to the page', await js(() => !!document.querySelector('.rail a[href="#/ontology"]') && document.querySelector('.rail a.is-active').innerText.trim() === 'Ontology'));
      await setVal('.searchbox input', 'ontol');
      await waitFor(() => document.querySelectorAll('.searchbox__list li').length >= 1, 'search hit');
      check('ontology: the search box finds the page', /Ontology/.test(await text('.searchbox__list')));
      await setVal('.searchbox input', '');
      await js(() => { document.querySelector('button.ontpick').click(); return true; });
      await shot('ontology');
    });

    // ------------------------------------------------------------------ lifecycle
    await step('lifecycle: catalogue and conversion calculator', async () => {
      await go('/lifecycle');
      await waitFor(() => document.querySelectorAll('.tbl tbody tr').length >= 8 && document.querySelectorAll('.tile').length === 4, 'calculator');
      check('lifecycle: eight SKUs in the catalogue', (await count('.panel:first-of-type .tbl tbody tr')) === 8);
      await setVal('#cv-ratio', 1.5);
      await waitFor(() => /worth 1\.5 old units/.test(document.body.innerText), 'recalculated');
      check('lifecycle: changing the ratio recalculates', true);
      await shot('lifecycle');
    });

    // ------------------------------------------------------------------ decisions
    await step('decisions: the log shows the approval and the chain verifies', async () => {
      await go('/decisions');
      await waitFor(() => document.querySelectorAll('.tbl tbody tr').length >= 1, 'log row');
      check('decisions: the approval is in the log with its reason', /Asha Rao/.test(await text('.tbl')) && /Phase the order/.test(await text('.tbl')));
      check('decisions: log integrity reads Verified', /Verified/.test(await text('.fleet')));
      await shot('decisions');
    });

    // ------------------------------------------------------------------ lab
    await step('lab: exercises, quiz check, scenario and reset', async () => {
      await go('/lab');
      await waitFor(() => document.querySelectorAll('.ex').length === 7, 'seven exercises');
      check('lab: warns when the data is not at the baseline', /not at the shipped baseline/.test(await text('.msgbar')));
      await clickText('button', 'Reset lab data');
      await waitFor(() => !/not at the shipped baseline/.test(document.body.innerText), 'baseline restored');
      check('lab: seven exercises across crawl, walk and run', (await count('.ex')) === 7);
    });
    await step('lab: a wrong answer gets a hint, the right one is remembered', async () => {
      await js(() => { const ex = document.querySelector('.ex'); ex.querySelectorAll('input[type=radio]')[1].click(); });
      await js(() => [...document.querySelector('.ex').querySelectorAll('button')].find((b) => /Check my answer/.test(b.textContent)).click());
      await waitFor(() => /Not quite/.test(document.querySelector('.ex .verdict')?.innerText || ''), 'hint');
      check('lab 1: a wrong answer explains how the ranking works', true);
      await js(() => {
        const ex = document.querySelector('.ex');
        const radios = [...ex.querySelectorAll('label')].find((l) => /East US/.test(l.textContent)).querySelector('input'); radios.click();
      });
      await js(() => [...document.querySelector('.ex').querySelectorAll('button')].find((b) => /Check my answer/.test(b.textContent)).click());
      await waitFor(() => /Correct/.test(document.querySelector('.ex .verdict')?.innerText || ''), 'success');
      check('lab 1: the right answer passes', true);
      await waitFor(() => /1 of 7/.test(document.body.innerText), 'progress');
      check('lab: progress updates to 1 of 7', true);
    });
    await step('lab: applying a scenario shows what changed and lab 4 verifies it', async () => {
      await js(() => [...document.querySelectorAll('.scn')].find((s) => /quota surge/i.test(s.innerText)).querySelector('button').click());
      await waitFor(() => /What changed after/.test(document.body.innerText), 'change card');
      check('scenario: the what-changed card lists East US before and after', /East US/.test(await text('.panel:last-of-type')));
      await js(() => [...document.querySelectorAll('.ex')][3].querySelector('.btn--primary').click());
      await waitFor(() => /Applied\. The East US order went from/.test(document.querySelectorAll('.ex')[3].querySelector('.verdict')?.innerText || ''), 'lab 4 pass');
      check('lab 4: the checkpoint verifies the scenario and quotes real numbers', true);
      await shot('lab');
    });
    await step('lab: reset clears data but keeps progress', async () => {
      await clickText('button', 'Reset lab data');
      await waitFor(() => !/Applied/.test([...document.querySelectorAll('.scn')].map((s) => s.innerText).join(' ')), 'scenarios cleared');
      const s = await (await fetch(`${base}/api/summary`)).json();
      check('reset: baseline restored (5 open orders, East US overdue)', s.kpis.open_actions === 5 && s.actions[0].state === 'OVERDUE');
      check('reset: lab progress is kept', /2 of 7|1 of 7/.test(await text('#lab-head')));
    });

    // ------------------------------------------------------------------ outcome and feedback (the lab has just been reset, so this starts from the shipped data)
    await step('outcome: advance the lab and see what really happened against what was predicted', async () => {
      const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await go('/outcome');
      await waitFor(() => /What happens when you advance/.test(document.body.innerText) && /21 Sep 2026/.test((document.querySelector('.outtime') || {}).innerText || ''), 'the outcome page before advancing');
      check('outcome: the rail marks the page and it is called Outcome & Feedback', /Outcome & Feedback/.test(await text('h1')) && await js(() => document.querySelector('.rail a[href="#/outcome"]').classList.contains('is-active')));
      check('outcome: before moving, it says how far the lab can go and why', await js(() => { const t = document.querySelector('.outtime').innerText; return /21 Sep 2026/.test(t) && /Nothing has moved/.test(t) && /can advance 26 more weeks/.test(t) && /Contracts, events and requests that fall due inside them are realized in the actuals/.test(t); }));
      check('outcome: it offers 1, 4 and 13 weeks and the limit', await js(() => [...document.querySelectorAll('.outtime button')].map((b) => b.innerText.trim()).join('|') === 'Advance 1 week|Advance 4 weeks|Advance 13 weeks|Advance to the limit (26 weeks)'));
      check('outcome: it explains the steps, says what falls due becomes usage, and that the readings are generated', await js(() => { const t = document.body.innerText; return /The forecast is written down first/.test(t) && /fall due become usage, or do not/.test(t) && /Supply arrives, or slips/.test(t) && /generated, so this shows how the loop works/.test(t); }));
      check('outcome: no app-bar marker while nothing has moved', await count('.pill--advanced') === 0);

      await clickText('button', 'Advance 4 weeks');
      await waitFor(() => /Advanced 4 weeks to 19 Oct 2026/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'the first advance');
      check('outcome: the app bar says the lab has moved, on every page', await js(() => /Advanced 4 weeks/.test(document.querySelector('.pill--advanced').innerText) && /as of 19 Oct 2026/.test(document.querySelector('.appbar__context').innerText)));
      await clickText('button', 'Advance 4 weeks');
      await waitFor(() => /Advanced 4 weeks to 16 Nov 2026/.test((document.querySelector('.msgbar--success') || {}).innerText || '') && document.querySelectorAll('.fbcard cap-feedback-chart svg .fb-act').length === 6, 'the second advance and its six charts');
      const api = await (await fetch(`${base}/api/outcome`)).json();
      const s = api.summary;
      const N = (x) => Math.round(x).toLocaleString('en-US');

      check('outcome: the message says what happened, in counts, including what fell due', await js((t) => { const m = document.querySelector('.msgbar--success').innerText; return m.includes(t) && /Fell due: 1 request went live\./.test(m); }, '1 order arrived, 1 slipped'));
      check('outcome: six cards worded and valued from the API, and none is left alone on a second row', await js((a) => { const cards = [...document.querySelectorAll('.kpis .kpi')]; const c = cards.map((x) => x.innerText); const tops = new Set(cards.map((x) => Math.round(x.getBoundingClientRect().top))); return c.length === 6 && tops.size === 1 && ['Plan held', 'Plan error', 'Orders arrived', 'Fell due', 'Plans changed', 'Ordered, now against then'].every((l, i) => c[i].includes(l)) && c[0].includes(`${a.within_p80} / ${a.readings}`) && c[1].includes(a.mape.toFixed(2)) && c[1].includes(`trend alone: ${a.trend.toFixed(2)}%`) && c[2].includes(String(a.arrivals)) && c[3].includes(`${a.happened} / ${a.fell_due}`) && c[4].includes(`${a.changed} / ${a.pools}`); },
        { within_p80: s.within_p80, readings: s.readings, mape: s.mape_pct, trend: s.trend_mape_pct, arrivals: s.arrivals, changed: s.plans_changed, pools: s.pools, happened: s.dated.happened, fell_due: s.dated.fell_due }));
      check('outcome: the fell-due card says what the plan counted and what showed up', await js(() => { const c = [...document.querySelectorAll('.kpis .kpi')].find((x) => /Fell due/.test(x.innerText)); return /1 \/ 1/.test(c.innerText) && /the plan counted 288 CU, 466 CU showed up/.test(c.innerText); }));      check('outcome: the plan-held and error cards say how they are worked out', await js(() => [...document.querySelectorAll('.kpis .kpi .info')].filter((b) => (b.title || '').length > 60).length >= 3));
      check('outcome: a chart per pool with a marker for every generated week', await js(() => [...document.querySelectorAll('.fbcard')].length === 6 && [...document.querySelectorAll('.fbcard')].every((c) => c.querySelectorAll('svg .fb-dot, svg .fb-out').length === 8 && c.querySelector('svg .fb-p50') && c.querySelector('svg .fb-p80') && c.querySelector('svg .fb-hist'))));
      check('outcome: each chart is labelled, says how the plan did and how the trend alone did', await js(() => [...document.querySelectorAll('.fbcard')].every((c) => /ran (above|below)|Close to|more often than expected/.test(c.querySelector('.fbread').innerText) && /Error/.test(c.querySelector('.fbcard__stats').innerText) && /at or under p80/.test(c.querySelector('.fbcard__stats').innerText) && /Trend alone: error \d+\.\d\d%/.test(c.querySelector('.fbcard__stats--sub').innerText) && /actual usage against the demand the plan counted/.test(c.querySelector('svg').getAttribute('aria-label')))));
      await js(() => { const h = document.querySelector('.fbcard cap-feedback-chart .hit'); const r = h.getBoundingClientRect(); h.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.95, clientY: r.top + 20, bubbles: true })); });
      check('outcome: hovering a week gives the actual, the planned demand and the gap', await js(() => { const t = document.querySelector('.fbcard cap-feedback-chart .chart-tip'); return t.style.display === 'block' && /Actual/.test(t.innerText) && /Planned middle/.test(t.innerText) && /Planned p80/.test(t.innerText) && /\(\+?-?\d+\.\d%\)/.test(t.innerText); }));
      check('outcome: what fell due lists REQ-1001, what the plan counted, what showed up, and that it went live', await js(() => { const sec = document.querySelector('#fd-head').closest('section'); const tr = sec.querySelectorAll('tbody tr'); const t = tr[0].innerText; return tr.length === 1 && /16 Nov 2026/.test(t) && /REQ-1001/.test(t) && /East US/.test(t) && /288 CU \(asked 480\)/.test(t) && /466 CU/.test(t) && /Went live/.test(t); }));
      check('outcome: the table under the charts has every pool and week', await js((n) => document.querySelectorAll('.fbgrid ~ .tableview tbody tr').length === n, s.readings));
      check('outcome: the eighth week of East US is held against the forecast made after the fourth', await js((row) => { const tr = [...document.querySelectorAll('.fbgrid ~ .tableview tbody tr')].filter((x) => /East US/.test(x.textContent)); return tr.length === 8 && tr[7].textContent.includes(row.actual) && tr[7].textContent.includes(row.p50) && tr[7].textContent.includes(row.p80); },
        { actual: N(api.pools.find((p) => p.pool_id === 'pool-eastus-01-intel-icx').chart.rows[7].actual), p50: N(api.pools.find((p) => p.pool_id === 'pool-eastus-01-intel-icx').chart.rows[7].p50), p80: N(api.pools.find((p) => p.pool_id === 'pool-eastus-01-intel-icx').chart.rows[7].p80) }));
      check('outcome: supply shows the order that arrived (a week late, adding capacity) and the one that slipped', await js(() => { const t = [...document.querySelectorAll('.out-supply table')].map((x) => x.innerText); return /ORD-2026-0440/.test(t[0]) && /1 week late/.test(t[0]) && /\+384 CU/.test(t[0]) && /ORD-2026-0412/.test(t[1]) && /3 weeks late/.test(t[1]) && /ORD-2026-0431/.test(t[1]) && /On plan/.test(t[1]); }));
      check('outcome: with nothing decided, it says so and points at the pool page', await js(() => /You have not approved an order/.test(document.querySelector('.out-supply').innerText)));
      check('outcome: plans then and now, with the waiting cost on East US', await js(() => { const tr = [...document.querySelectorAll('#pl-head')][0].closest('section').querySelectorAll('tbody tr'); const eus = [...tr].find((x) => /East US/.test(x.innerText)); return tr.length === 6 && /4,032/.test(eus.innerText) && /5,184 \(\+1,152\)/.test(eus.innerText) && /8 Feb 2027/.test(eus.innerText) && /5 Apr 2027/.test(eus.innerText) && /\+8 wk/.test(eus.innerText) && eus.classList.contains('is-changed'); }));
      check('outcome: the way the actuals were made is disclosed, with the growth surprise each pool was given', await js(() => { const d = [...document.querySelectorAll('details')].find((x) => /How the actuals were generated/.test(x.querySelector('summary').textContent)); const t = d.textContent; return /generated/.test(t) && /nothing about it is measured/.test(t) && d.querySelectorAll('tbody tr').length === 6 && /%/.test(d.querySelector('tbody tr').textContent); }));
      await shot('outcome');

      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await sleep(400);
      check('outcome: the chart lines have their own dark colours', await js(() => { const c = (s, p) => getComputedStyle(document.querySelector(s))[p]; return c('.fbcard .fb-act', 'stroke') !== c('.fbcard .fb-p50', 'stroke') && c('.fbcard .fb-p50', 'stroke') !== c('.fbcard .fb-p80', 'stroke'); }));
      await shot('outcome-dark');
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
      check('phone: the outcome page, with its charts, fits a 390px screen', (await js(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, `overflow ${await js(() => document.documentElement.scrollWidth - window.innerWidth)}px`);
      await shot('outcome-phone', 390);
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

      // 13 more weeks: everything that falls due in the next quarter, and the lab is then 21 weeks on
      await clickText('button', 'Advance 13 weeks');
      await waitFor(() => /Advanced 13 weeks to 15 Feb 2027/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'the advance of 13 weeks');
      check('outcome: 13 more weeks and the message counts what fell due in them, in words', await js(() => /Fell due: 4 requests went live, 4 did not go ahead, 3 contracts took effect, 2 events happened\./.test(document.querySelector('.msgbar--success').innerText)));
      const mid = await (await fetch(`${base}/api/outcome`)).json();
      check('outcome: the fell-due table lists every one, in the API\'s date order, with what became of each', await js((ids) => { const tr = [...document.querySelector('#fd-head').closest('section').querySelectorAll('tbody tr')]; const all = tr.map((x) => x.innerText).join(' '); return tr.length === ids.length && ids.every((id, i) => tr[i].innerText.includes(id)) && /Did not go ahead/.test(all) && /Went live/.test(all) && /Took effect/.test(all) && /Happened/.test(all); }, mid.dated.map((d) => d.id)));
      check('outcome: 14 items have fallen due by week 21, in date order', mid.dated.length === 14 && mid.dated.every((d, i) => i === 0 || mid.dated[i - 1].in_effect_on <= d.in_effect_on), `${mid.dated.length} fallen due`);
      check('outcome: a request that did not go ahead is marked as changed, and says nothing showed up', await js(() => { const tr = [...document.querySelector('#fd-head').closest('section').querySelectorAll('tbody tr')].find((x) => /REQ-1002/.test(x.innerText)); return Boolean(tr) && tr.classList.contains('is-changed') && /Did not go ahead/.test(tr.innerText) && /nothing/.test(tr.innerText) && /578 CU \(asked 1,100\)/.test(tr.innerText); }));

      await clickText('button', 'Advance to the limit (5 weeks)');
      await waitFor(() => /Advanced 5 weeks to 22 Mar 2027/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'the advance to the limit');
      check('outcome: at the limit it offers no more and says why', await js(() => document.querySelectorAll('.outtime button').length === 0 && /cannot advance any further/.test(document.querySelector('.outtime').innerText) && /26 weeks is the most this lab generates/.test(document.querySelector('.outtime').innerText)));
      check('outcome: a refused advance is a plain message, not a crash', (await post('/api/lab/advance', { weeks: 1 })).status === 409);
      check('outcome: 3 orders arrived, and their average slip is one decimal (1.3 weeks), not 1.3333333333333333', await js(() => { const c = [...document.querySelectorAll('.kpis .kpi')].find((x) => /Orders arrived/.test(x.innerText)); return /3\s+1\.3 weeks late on average/.test(c.innerText.replace(/\n+/g, ' ')) && !/\d\.\d{3,}/.test(c.innerText); }));
      check('outcome: a pool that filled up shows its capacity and says how much demand it turned away', await js(() => {
        const cards = [...document.querySelectorAll('.fbcard')];
        const eus = cards.find((c) => /East US/.test(c.innerText));
        const others = cards.filter((c) => c !== eus);
        return /Full for 1 week: 66 CU of demand turned away/.test(eus.querySelector('.fbfull').innerText) && Boolean(eus.querySelector('svg .fb-cap')) && others.every((c) => !c.querySelector('.fbfull') && !c.querySelector('svg .fb-cap')) && /Capacity \(pool full\)/.test(document.querySelector('#fb-head').closest('section').querySelector('.legend').innerText);
      }));
      await shot('outcome-limit');

      await go('/overview');
      await waitFor(() => /as of 22 Mar 2027/.test((document.querySelector('.appbar__context') || {}).innerText || '') && document.querySelectorAll('.kpi').length === 6 && document.querySelector('.ovanswer__text') && document.querySelector('cap-overview-chart svg'), 'the overview after advancing');
      check('outcome: the other pages show the world as of the new date (the busiest-hour card steps aside and says why)', await js(() => /advanced 26 weeks/.test(document.body.innerText) && document.querySelectorAll('.ov-peak tbody tr').length === 0));

      // a pool whose history has a step in it says what was taken out before the forecast was fitted
      await go('/pools/pool-eastus-01-intel-icx');
      await waitFor(() => document.querySelector('.answer__text') && [...document.querySelectorAll('dt')].some((x) => x.innerText.trim() === 'Forecast'), 'the East US plan after 26 weeks');
      const why = await js(() => [...document.querySelectorAll('dt')].find((x) => x.innerText.trim() === 'Forecast').nextElementSibling.innerText.replace(/\s+/g, ' '));
      check('outcome: the pool page says which known effect was taken out of the history before fitting, and how big it was measured to be', /Before fitting, one known effect was taken out of the history: REQ-1001 \(a step of \+\d{3} CU from 2026-11-16\)\.$/.test(why), why);
      await shot('pool-known-effects');

      await post('/api/lab/reset', {});
      await go('/outcome');
      await waitFor(() => /Nothing has moved/.test(document.body.innerText), 'the reset outcome page');
      check('outcome: reset puts today back and the marker goes', await js(() => /21 Sep 2026/.test(document.querySelector('.outtime').innerText) && !document.querySelector('.pill--advanced')));
    });

    // ------------------------------------------------------------------ governance: the budget and the second approver (the lab is reset again at the end)
    await step('governance: a large order needs a second named person, and the page says so before anyone decides', async () => {
      const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const H100 = '/pools/pool-westeurope-02-gpu-h100';
      await go(H100);
      await waitFor(() => document.querySelector('.apprbox') && /second, different named person/.test(document.querySelector('.apprbox').innerText), 'the approval box');
      check('governance: before deciding, the page says a second person is needed and what the budget would be', await js(() => { const t = document.querySelector('.apprbox').innerText; return /What this approval needs/.test(t) && /\$5\.64M is above \$1\.50M|above \$1\.50M/.test(t) && /\$0 of the \$8\.00M budget is committed; this order would leave \$2\.36M/.test(t) && /synthetic/.test(t) && /no sign-in/.test(t); }));
      check('governance: the budget is drawn as committed, this order and the limit, not only in words', await js(() => { const b = document.querySelector('.budgetbar'); return b.querySelectorAll('.budgetbar__fill').length === 3 && !!b.querySelector('.budgetbar__limit') && /budget/.test(b.getAttribute('aria-label')) && document.querySelectorAll('.apprbox .legend span').length === 3; }));
      await shot('governance-before');
      await setVal('#dec-qty', 288);
      await waitFor(() => !/second, different named person/.test(document.querySelector('.apprbox').innerText) && /this order would leave \$6\.79M/.test(document.querySelector('.apprbox').innerText), 'the box for a smaller quantity');
      check('governance: a smaller quantity is priced again, and 288 CU is under the threshold', await js(() => /\$0 of the \$8\.00M budget is committed; this order would leave \$6\.79M/.test(document.querySelector('.apprbox').innerText)));
      await setVal('#dec-qty', 1344);
      await waitFor(() => /a second, different named person has to countersign/.test(document.querySelector('.apprbox').innerText), 'the box again for the drafted quantity');

      await setVal('#dec-by', 'Asha Rao');
      await clickText('button', 'Approve');
      await waitFor(() => /waits for a second, different named person\. No order has been placed yet/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'the first approval');
      await waitFor(() => /Waiting for a second approver/.test((document.querySelector('.apprbox') || {}).innerText || ''), 'the waiting state');
      check('governance: the first approval places nothing, the header says who is waited on, and the plan still shows the need', await js(() => /Awaiting a second approver \(Asha Rao approved\)/.test(document.querySelector('.pagehead, .main').innerText) && /ORDER NOW/i.test(document.body.innerText) && !/is now in flight/.test(document.body.innerText)));
      check('governance: the button becomes Countersign and the quantity is fixed to what was approved', await js(() => [...document.querySelectorAll('.btnrow button')].some((b) => b.innerText.trim() === 'Countersign') && document.querySelector('#dec-qty').disabled && document.querySelector('#dec-qty').value === '1344'));
      check('governance: while it waits the bar shows this order in blue and nothing committed, and the box names who approved', await js(() => {
        const w = (sel) => parseFloat(document.querySelector(sel).style.width || '0');
        return w('.budgetbar__fill--committed') === 0 && w('.budgetbar__fill--order') > 50 && w('.budgetbar__fill--over') === 0 && /Asha Rao approved 1,344 CU \(\$5\.64M\)/.test(document.querySelector('.apprbox').innerText) && /waiting for a second, different named person/.test(document.querySelector('.apprbox').innerText);
      }));

      await shot('governance-waiting');
      await clickText('button', 'Countersign');
      await waitFor(() => /different named person has to countersign it/.test((document.querySelector('.msgbar--danger') || {}).innerText || ''), 'the refusal of the same person');
      check('governance: the same name cannot countersign, and is told why', true);
      await setVal('#dec-by', 'Ben Ortiz');
      await clickText('button', 'Countersign');
      await waitFor(() => /countersigning DEC-0001\)?\. Order ORD-LAB-0001 for 1,344 CU is now in flight/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'the countersignature');
      check('governance: a different named person countersigns, and only then is the order placed', true);
      const detail = await (await fetch(`${base}/api/pools/pool-westeurope-02-gpu-h100`)).json();
      check('governance: the order is in flight, the plan no longer shows a need, and there is nothing left to approve', detail.verdict.order.in_flight.some((o) => o.order_id === 'ORD-LAB-0001') && detail.verdict.order.needed === false && detail.approval === null);

      await go('/decisions');
      await waitFor(() => document.querySelectorAll('.tbl tbody tr').length === 2, 'the decision log');
      check('governance: the log shows both records, who countersigned whom, and the budget', await js(() => { const t = document.querySelector('.tbl').innerText; const f = document.querySelector('.fleet').innerText; return /approve \(1 of 2\)/.test(t) && /countersign/.test(t) && /Countersigns DEC-0001, first approved by Asha Rao/.test(t) && /1 approved/.test(f) && /\$5\.64M/.test(f) && /of \$8\.00M \(FY27 Q2 capacity budget \(synthetic\)\)/.test(f) && /Verified/.test(f); }));
      // the planner's options: with East US and H100 approved, $6.89M of the $8.00M budget is committed
      await post('/api/pools/pool-eastus-01-intel-icx/decision', { decision: 'approve', decided_by: 'Asha Rao' });
      await go('/pools/pool-japaneast-01-gpu-l40s');
      await waitFor(() => document.querySelectorAll('.optcard').length === 4 && /Order what the budget allows/.test(document.querySelector('.optlist').innerText), 'the options for Japan East');
      check('options: the recommendation is the most the budget allows, it comes first, and it says what is left to do', await js(() => { const r = [...document.querySelectorAll('.optcard')]; return /Order what the budget allows/.test(r[0].innerText) && /Recommended/.test(r[0].innerText) && r.filter((x) => /Recommended/.test(x.innerText)).length === 1 && /768 CU/.test(r[0].innerText) && /Still needs 1,728 CU by 23 Nov 2026/.test(r[0].innerText) && /One approver, in budget/.test(r[0].innerText); }));
      check('options: the order as drafted is marked over budget by how much, and as needing a second approver', await js(() => { const r = [...document.querySelectorAll('.optcard')].find((x) => /Order as drafted/.test(x.innerText)); return /Over budget by \$2\.39M/.test(r.innerText) && /Second approver/.test(r.innerText) && /2,592 CU/.test(r.innerText); }));
      check('options: waiting is shown with its cost and offers nothing to approve', await js(() => { const r = [...document.querySelectorAll('.optcard')].find((x) => /Wait 4 weeks/.test(x.innerText)); return /The shortfall grows/.test(r.innerText) && /Nothing to approve/.test(r.innerText) && r.querySelectorAll('button').length === 0 && !/Recommended/.test(r.innerText); }));
      check('options: the rule that recommends one is stated on the page, and what would change the answer is listed', await js(() => /Order what closes the gap if the budget allows it/.test(document.body.innerText) && /What would change the answer/.test(document.body.innerText) && /If usage kept growing 25% faster than the forecast/.test(document.body.innerText)));
      await shot('options');
      await js(() => { document.querySelector('.optcard:first-child button').click(); return true; });
      await waitFor(() => document.querySelector('#dec-qty').value === '768' && /this order would leave \$68K/.test(document.querySelector('.apprbox').innerText), 'the decision filled in from the option');
      check('options: choosing one fills in the quantity and its reason, and the approval box prices it', await js(() => document.querySelector('#dec-reason').value === 'Chose the planner\'s option: Order what the budget allows.' && !/second, different named person/.test(document.querySelector('.apprbox').innerText)));
      await setVal('#dec-by', 'Asha Rao');
      await clickText('button', 'Approve');
      await waitFor(() => /Order ORD-LAB-0003 for 768 CU is now in flight \(you changed the drafted quantity\)/.test((document.querySelector('.msgbar--success') || {}).innerText || ''), 'the approval of the option');
      const jpe = await (await fetch(`${base}/api/pools/pool-japaneast-01-gpu-l40s`)).json();
      check('options: what was approved is what the option said (768 CU in flight), and the pool now needs the 1,728 CU it left', jpe.verdict.order.in_flight.some((o) => o.order_id === 'ORD-LAB-0003' && o.cu === 768) && jpe.verdict.order.needed === true && jpe.verdict.order.quantity_cu === 1728 && jpe.verdict.dates.raise_by === '2026-11-23');
      await waitFor(() => /cannot buy the vendor's minimum order of \d+ CU, so no order fits it/.test(document.body.innerText), 'the options after the budget is used up');
      check('options: once the budget is used up, it says no order fits, and the drafted order is recommended with its overspend', await js(() => { const r = [...document.querySelectorAll('.optcard')]; return r.length === 3 && /Order as drafted/.test(r[0].innerText) && /Recommended/.test(r[0].innerText) && /Over budget by/.test(r[0].innerText); }));

      await go(H100);
      await waitFor(() => document.querySelector('.panel--accent'), 'the pool again');
      await shot('governance');
      await post('/api/lab/reset', {});
    });

    // ------------------------------------------------------------------ audiences, theme, phone width
    await step('audience: the executive view hides working detail', async () => {
      await go('/pools/pool-eastus-01-intel-icx');
      await waitFor(() => document.querySelector('.answer__text'), 'pool');
      await pick('select[ng-model="vm.audience"]', 'Executive');
      await waitFor(() => document.body.classList.contains('aud-executive'), 'executive class');
      const hidden = await js(() => [...document.querySelectorAll('[aud]')].every((e) => (e.getAttribute('aud').includes('executive') ? true : getComputedStyle(e).display === 'none')));
      check('audience: everything not marked executive is hidden', hidden);
      await pick('select[ng-model="vm.audience"]', 'Engineering');
    });
    await step('theme: dark mode swaps the surface tokens', async () => {
      const light = await js(() => getComputedStyle(document.body).backgroundColor);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await sleep(200);
      const dark = await js(() => getComputedStyle(document.body).backgroundColor);
      check('theme: light and dark backgrounds differ', light !== dark, `${light} vs ${dark}`);
      await shot('pool-dark');
      // The lab was reset a few steps ago, which removed the request this page last had open: it must fall back, not error.
      await go('/team');
      await waitFor(() => document.querySelector('cap-team-chart svg .ol-dem') && document.querySelectorAll('.tm-req tbody tr').length > 0, 'the requester view in dark mode');
      check('team: a request that no longer exists (the lab was reset) falls back to the default instead of an error', await js(() => !document.querySelector('.msgbar--danger') && /REQ-1004/.test(document.querySelector('.tm-req tr.is-selected').innerText) && document.querySelectorAll('.tm-req tbody tr').length === 10));
      check('theme: the requester view has its own dark colours for the chart and the status pills', await js(() => { const c = (s, p) => getComputedStyle(document.querySelector(s))[p]; return c('cap-team-chart .ol-dem', 'stroke') !== c('cap-team-chart .ol-prov', 'stroke') && c('cap-team-chart .ot-use', 'stroke') !== c('cap-team-chart .ol-dem', 'stroke') && getComputedStyle(document.querySelector('.tm-req .rqpill--at-risk')).backgroundColor !== 'rgb(253, 243, 244)'; }));
      check('team: the requests table fits its card without a sideways scroll', await js(() => { const w = document.querySelector('.tm-req .tblwrap'); return w.scrollWidth <= w.clientWidth + 1; }), await js(() => { const w = document.querySelector('.tm-req .tblwrap'); return `${w.scrollWidth} in ${w.clientWidth}`; }));
      await shot('team-dark');
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    });
    await step('phone width: no horizontal page scroll', async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
      for (const hash of ['/planning', '/planning/supply', '/planning/demand', '/pools/pool-eastus-01-intel-icx', '/funnels', '/ontology', '/lab']) {
        await go(hash); await sleep(700);
        const over = await js(() => document.documentElement.scrollWidth - window.innerWidth);
        check(`phone: ${hash} fits a 390px screen`, over <= 1, `overflow ${over}px`);
      }
      await go('/planning'); await sleep(900);
      await shot('overview-phone', 390);
      await go('/planning/supply'); await sleep(900);
      await shot('supply-phone', 390);
      await go('/planning/demand'); await sleep(900);
      await shot('team-phone', 390);
    });

    check('no console errors or exceptions during the whole run', problems.length === 0, problems.slice(0, 3).join(' | '));
    ws.close();
  } catch (e) {
    check('run completed', false, e.message);
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (failed.length) { console.log('Failed:\n - ' + failed.map((f) => f.name).join('\n - ')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
