'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildOverview, actionQueue } = require('../server/lib/overview');
const { createApp } = require('../server/app');
const { P, freshStore } = require('./helpers');

const overview = (q, store = freshStore()) => buildOverview(store, q);
const byId = (store) => Object.fromEntries(store.all().map((a) => [a.verdict.pool_id, a]));

test('the overview carries every widget of the wireframe, from one call', () => {
  const o = overview();
  assert.equal(o.view, 'provider');
  assert.equal(o.source, 'synthetic');
  for (const k of ['total_demand', 'projected_shortfall', 'regions_at_risk', 'reclaim', 'investment', 'critical_signals']) assert.ok(o.kpis[k], `kpi ${k}`);
  for (const k of ['regions', 'forecast', 'constraints', 'recommendations', 'inventory', 'signals', 'optimization', 'procurement', 'action_queue', 'filters', 'headline']) assert.ok(o[k], k);
  assert.match(o.headline, /^No\. 1 of 6 pools is already past/);
});

test('every KPI ships its own definition, so a screen can explain the number', () => {
  const o = overview();
  for (const [name, k] of Object.entries(o.kpis)) assert.ok(k.definition && k.definition.length > 40, `${name} needs a definition`);
});

test('shortfall is counted per pool: it equals the sum of each pool\'s demand above its own effective capacity', () => {
  const store = freshStore();
  const o = overview({}, store);
  const expected = store.all().reduce((s, a) => s + Math.max(0, a.ctx.planDemandAt(52) - a.verdict.capacity.working_floor_pct * a.ctx.usableAt(52)), 0);
  assert.equal(o.kpis.projected_shortfall.value, Math.round(expected));
  assert.ok(o.kpis.projected_shortfall.value > 0);
  assert.ok(Math.abs(o.kpis.projected_shortfall.share_of_demand - o.kpis.projected_shortfall.value / o.kpis.total_demand.value) < 1e-3, 'the share is computed from unrounded figures');
});

test('total demand is the demand the pools plan for at 12 months, combined as one forecast (see aggregate.test.js)', () => {
  const store = freshStore();
  const all = store.all();
  const plain = all.reduce((s, a) => s + a.ctx.planDemandAt(52), 0);
  const t = overview({}, store).kpis.total_demand;
  assert.equal(t.sum_of_pool_p80, Math.round(plain));
  assert.ok(t.value < Math.round(plain), 'the p80 of the total is below the sum of the pools\' p80s');
  assert.ok(t.value > all.reduce((s, a) => s + a.ctx.p50At(52), 0), 'and above the sum of their middles');
});

test('"vs last quarter" is a real recomputation from older usage, not a made-up percentage', () => {
  const o = overview();
  const d = o.kpis.total_demand.delta_pct;
  assert.ok(d > 0 && d < 1, `demand delta ${d}`);
  assert.match(o.kpis.total_demand.definition, /fitted 13 weeks ago/);
  const store = freshStore();
  const a = store.all()[0];
  assert.notEqual(a.ctx.planDemandAt(52), a.ctx.planDemandAt(52, { prior: true }), 'the older forecast must differ from today\'s');
});

test('the planning demand adds contracts, relocations and a running seasonal spike', () => {
  const store = freshStore();
  const a = byId(store);
  const gpu = a[P.weuGpu].ctx;
  assert.equal(gpu.knownAddsAt(0), 0);
  assert.equal(gpu.knownAddsAt(30), 1200, 'the Fabrikam commitment (1,600 less 400 provisioned) has started by then');
  assert.ok(gpu.planDemandAt(30) > gpu.demandBase(30));
  const jpe = a[P.jpe].ctx;
  assert.equal(jpe.seasonalSpikeAt(10), 0);
  assert.ok(jpe.seasonalSpikeAt(28) > 1000, 'the launch spike is on while the event runs');
  assert.equal(jpe.seasonalSpikeAt(40), 0, 'and gone after it');
});

test('regions group pools by geography and use the wireframe thresholds (80% and 95%)', () => {
  const o = overview();
  assert.deepEqual(o.regions.map((r) => r.key), ['north-america', 'europe', 'asia-pacific', 'latin-america']);
  const by = Object.fromEntries(o.regions.map((r) => [r.key, r]));
  assert.equal(by['north-america'].status, 'at-risk');
  assert.equal(by.europe.status, 'healthy');
  assert.equal(by['asia-pacific'].status, 'watch');
  for (const r of o.regions) {
    const expected = r.utilization > 0.95 ? 'at-risk' : r.utilization >= 0.8 ? 'watch' : 'healthy';
    assert.equal(r.status, expected, r.key);
    assert.ok(Math.abs(r.utilization - r.demand_cu / r.capacity_cu) < 1e-3);
  }
  assert.deepEqual(o.kpis.regions_at_risk, { at_risk: 3, total: 4, critical: 2, definition: o.kpis.regions_at_risk.definition });
  assert.equal(by['asia-pacific'].pools.length, 2);
});

test('the forecast has one point per month, effective capacity is provisioned times the ceiling, and the peak is reported', () => {
  const store = freshStore();
  for (const [horizon, months] of [[13, 3], [26, 6], [52, 12]]) {
    const f = overview({ horizon }, store).forecast;
    assert.equal(f.months, months);
    assert.equal(f.points.length, months + 1);
    assert.equal(f.points[0].date, '2026-09-21');
  }
  const f = overview({}, store).forecast;
  const ceiling = store.all().reduce((s, a) => s + a.verdict.capacity.working_floor_pct * a.ctx.usableAt(0), 0);
  assert.equal(f.points[0].effective, Math.round(ceiling));
  assert.ok(f.points.every((p) => p.effective < p.provisioned));
  assert.equal(f.points[0].shortfall, 0, 'nothing is short today');
  assert.equal(f.peak_shortfall.cu, Math.max(...f.points.map((p) => p.shortfall)));
  assert.equal(f.points.at(-1).shortfall, overview({}, store).kpis.projected_shortfall.value, 'the last point is the 12-month KPI');
  for (let i = 1; i < f.points.length; i++) assert.ok(f.points[i].date > f.points[i - 1].date);
});

test('provisioned capacity in the forecast steps up when an in-flight order lands', () => {
  const f = overview().forecast.points;
  assert.ok(f.at(-1).provisioned > f[0].provisioned, 'orders already in flight raise capacity over the year');
});

test('constraints are derived from the funnels that set each plan; a calm pool contributes none', () => {
  const o = overview();
  assert.ok(o.constraints.length > 0 && o.constraints.length <= 5);
  const types = new Set(o.constraints.map((c) => c.type));
  assert.ok([...types].every((t) => ['Physical capacity', 'SKU availability', 'Reliability replacement', 'Data residency', 'Contract commitment', 'Event peak', 'Performance strain', 'Region growth', 'Security support'].includes(t)), [...types].join(', '));
  assert.ok(o.constraints.every((c) => c.region !== 'West Europe' || c.resource !== 'FAB-AMD-GENOA-96'), 'the OK pool has no constraint');
  assert.ok(types.has('SKU availability'), 'a vendor slower than it quotes is a SKU availability constraint');
});

test('recommendations lead with the most urgent pool and carry the wireframe\'s fields', () => {
  const o = overview();
  assert.equal(o.recommendations.length, 3);
  const r = o.recommendations[0];
  assert.equal(r.pool_id, P.eus);
  assert.equal(r.severity, 'critical');
  assert.equal(r.kind, 'procure');
  assert.equal(r.title, 'Procure 4,032 CU of FAB-AMD-GENOA-96 for East US');
  assert.match(r.rationale, /Lead time \(20 weeks\) is longer than the time left before capacity is needed \(14 weeks\)/);
  assert.equal(r.converging, 7);
  assert.equal(r.shortfall_cu, 4837);
  assert.equal(r.need_by, '2026-12-28');
  assert.equal(r.weeks_left, 14);
  assert.equal(r.cost_usd, 1249920);
  const reliability = o.recommendations.find((x) => x.pool_id === P.sea);
  assert.equal(reliability.kind, 'replace');
  assert.match(reliability.title, /^Replace sea-fabric-2 \(1,536 CU\) in Southeast Asia$/);
  assert.equal(reliability.impact, 'Service risk');
});

test('confidence is only ever a number where a record carries one; otherwise it says what the plan rests on', () => {
  const o = overview({}, freshStore());
  for (const r of o.recommendations) {
    assert.ok(r.confidence.label.length > 5);
    assert.equal(r.confidence.value, null, `${r.pool_id}: no probability should be invented for a ${r.confidence.basis}-driven plan`);
  }
  const jpe = overview({ region: 'asia-pacific' }).recommendations.find((r) => r.pool_id === P.jpe);
  assert.equal(jpe.driver.id, 'seasonal');
  assert.equal(jpe.confidence.value, 0.8, 'the seasonal record states 80%');
  assert.equal(jpe.confidence.basis, 'record');
});

test('inventory is by SKU: totals include orders in flight, and the tabs are only those with data', () => {
  const o = overview();
  const genoa = o.inventory.rows.find((r) => r.sku_id === 'FAB-AMD-GENOA-96');
  assert.equal(genoa.total_capacity, 12288 + 7680 + 384 + 3072);
  assert.equal(genoa.pools, 3);
  assert.equal(genoa.status, 'Constrained');
  assert.equal(o.inventory.rows.find((r) => r.sku_id === 'FAB-GPU-L40S-8').status, 'Watch');
  assert.deepEqual(o.inventory.groups.map((g) => g.key), ['all', 'gpu', 'compute']);
  assert.ok(o.inventory.rows.every((r) => r.lead_weeks > 0 && r.utilization > 0 && r.utilization < 1));
});

test('the signals table lists flagged funnel results only, ranked P0 first, and never competitive intel', () => {
  const o = overview();
  assert.ok(o.signals_total >= o.signals.length);
  assert.ok(o.signals.every((s) => ['P0', 'P1', 'P2'].includes(s.priority) && s.action));
  assert.ok(o.signals.every((s) => s.funnel_id !== 'competitive'));
  const ranks = o.signals.map((s) => ({ P0: 0, P1: 1, P2: 2 }[s.priority]));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const reliability = o.signals.find((s) => s.funnel_id === 'reliability');
  assert.equal(reliability.priority, 'P0');
  assert.equal(reliability.impact_cu, 1536);
  assert.equal(reliability.action, 'Replace');
  assert.ok(o.kpis.critical_signals.count <= o.signals_total);
});

test('optimization lists idle reservations by saving; procurement lists drafts then what is in flight', () => {
  const o = overview();
  assert.deepEqual(o.optimization.map((x) => x.region), ['West Europe', 'East US']);
  assert.equal(o.optimization[0].excess_cu, 1196);
  assert.equal(o.kpis.reclaim.cu, 1196 + 1035);
  const dates = o.procurement.map((p) => p.date);
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(o.procurement.some((p) => p.status === 'Not started' && p.date_kind === 'need_by'));
  assert.ok(o.procurement.some((p) => p.status === 'In transit' && p.date_kind === 'lands'));
});

test('approving an order moves it to "Approved" in procurement and out of the open actions', () => {
  const { decide } = require('../server/lib/decisions');
  const store = freshStore();
  const before = overview({}, store);
  decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  const after = overview({}, store);
  assert.ok(after.kpis.investment.usd < before.kpis.investment.usd, 'the approved order is no longer an open gap');
  assert.ok(after.procurement.some((p) => p.pool_id === P.eus && p.status === 'Approved'));
  assert.ok(after.action_queue.counts.procurement < before.action_queue.counts.procurement);
});

test('the action queue is ranked by priority then date, and its counts add up', () => {
  const store = freshStore();
  const q = actionQueue(store);
  assert.equal(q.counts.all, q.items.length);
  assert.equal(q.counts.all, q.counts.procurement + q.counts.allocation + q.counts.other);
  const rank = { P0: 0, P1: 1, P2: 2 };
  for (let i = 1; i < q.items.length; i++) {
    const a = q.items[i - 1]; const b = q.items[i];
    assert.ok(rank[a.priority] < rank[b.priority] || (rank[a.priority] === rank[b.priority] && (a.due || '9999') <= (b.due || '9999')), `${a.title} before ${b.title}`);
  }
  assert.ok(q.items.every((i) => i.title && i.category && i.priority));
});

test('filters scope everything: GPU only, one region, both, and an empty result', () => {
  const store = freshStore();
  const gpu = overview({ sku: 'gpu' }, store);
  assert.deepEqual(gpu.inventory.rows.map((r) => r.sku_id).sort(), ['FAB-GPU-H100-8', 'FAB-GPU-L40S-8']);
  assert.equal(gpu.regions.map((r) => r.pools.length).reduce((a, b) => a + b, 0), 2);
  assert.match(gpu.headline, /^Not yet\. 1 of 2 pools needs an order placed now/);

  const eu = overview({ region: 'europe' }, store);
  assert.deepEqual(eu.regions.map((r) => r.key), ['europe']);
  assert.equal(eu.kpis.regions_at_risk.total, 1);
  assert.equal(eu.recommendations.length, 1);

  const both = overview({ sku: 'gpu', region: 'europe' }, store);
  assert.deepEqual(both.inventory.rows.map((r) => r.sku_id), ['FAB-GPU-H100-8']);

  const none = overview({ sku: 'gpu', region: 'latin-america' }, store);
  assert.equal(none.headline, 'No pools match these filters.');
  assert.equal(none.kpis.total_demand.value, 0);
  assert.equal(none.forecast.peak_shortfall, null);
  assert.equal(none.regions.length, 0);
});

test('the overview follows the lab: a quota surge raises demand, shortfall and the critical signals', () => {
  const store = freshStore();
  const before = overview({}, store);
  store.applyScenario('quota-surge-eastus');
  const after = overview({}, store);
  assert.ok(after.kpis.total_demand.value > before.kpis.total_demand.value);
  assert.ok(after.kpis.projected_shortfall.value > before.kpis.projected_shortfall.value);
  assert.ok(after.recommendations[0].quantity_cu > before.recommendations[0].quantity_cu);
});

test('an incident storm turns a calm region\'s pool into a recommendation without changing its utilization', () => {
  const store = freshStore();
  const before = overview({ region: 'europe', sku: 'compute' }, store);
  assert.equal(before.recommendations.length, 0);
  store.applyScenario('incident-storm-weu');
  const after = overview({ region: 'europe', sku: 'compute' }, store);
  assert.equal(after.recommendations.length, 1);
  assert.equal(after.recommendations[0].kind, 'replace');
  assert.equal(after.regions[0].status, before.regions[0].status);
});

test('the overview is deterministic', () => {
  assert.equal(JSON.stringify(overview()), JSON.stringify(overview()));
});

// ---------------------------------------------------------------- over HTTP
async function withServer(fn) {
  const store = freshStore();
  const server = createApp({ store, webRoot: path.join(__dirname, '..', 'web') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (url) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`); return { status: res.status, json: await res.json() }; };
  try { await fn({ call }); } finally { await new Promise((r) => server.close(r)); }
}

test('API: /api/overview serves the screen, validates its filters, and /api/actions filters by category', () => withServer(async ({ call }) => {
  const ok = await call('/api/overview');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.kpis.critical_signals.count, overview().kpis.critical_signals.count);
  const scoped = await call('/api/overview?horizon=26&sku=gpu&region=europe');
  assert.equal(scoped.json.filters.horizon, 26);
  assert.equal(scoped.json.forecast.months, 6);
  assert.equal(scoped.json.recommendations.length, 1);
  for (const bad of ['?horizon=7', '?horizon=abc', '?sku=storage', '?region=mars']) assert.equal((await call(`/api/overview${bad}`)).status, 400, bad);

  const all = await call('/api/actions');
  assert.equal(all.json.items.length, all.json.counts.all);
  const proc = await call('/api/actions?category=procurement');
  assert.ok(proc.json.items.length > 0 && proc.json.items.every((i) => i.category === 'procurement'));
  assert.equal((await call('/api/actions?category=lunch')).status, 400);

  const summary = await call('/api/summary');
  assert.equal(summary.json.action_count, all.json.counts.all, 'the header count comes from the same queue');
}));
