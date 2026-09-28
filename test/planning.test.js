'use strict';
/*
 * PLANNING: supply and demand as two views of one plan, and the balance between them.
 *
 * Every figure is arithmetic over the pool assessments the rest of the lab uses, so the strongest test is agreement: the same
 * number reached by another route must be the same number (the Overview's total demand and shortfall, the pool verdicts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { P, freshStore } = require('./helpers');
const { buildPlanning } = require('./../server/lib/planning');
const { buildOverview } = require('./../server/lib/overview');
const { buildRequester } = require('./../server/lib/requester');

const tiles = (list) => Object.fromEntries(list.map((t) => [t.key, t]));
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

test('supply has six figures and demand has six, in the order of the design', () => {
  const p = buildPlanning(freshStore(), {});
  assert.deepEqual(p.supply.tiles.map((t) => t.key), ['available', 'pool_capacity', 'utilization', 'headroom', 'health', 'cost']);
  assert.deepEqual(p.supply.tiles.map((t) => t.label), ['Capacity available', 'Pool capacity', 'Utilization', 'Headroom', 'Health', 'Cost']);
  assert.deepEqual(p.demand.tiles.map((t) => t.key), ['product_demand', 'workload_forecast', 'growth', 'pipeline', 'events', 'requests']);
  assert.deepEqual(p.demand.tiles.map((t) => t.label), ['Product demand', 'Workload forecast', 'Growth', 'Pipeline', 'Business events', 'Capacity requests']);
  for (const t of [...p.supply.tiles, ...p.demand.tiles]) {
    assert.ok(t.definition.length > 40, `${t.key} says how it is worked out`);
    assert.ok(t.note.length > 3, `${t.key} has a note`);
    assert.ok(Number.isFinite(t.value), `${t.key} is a number`);
  }
  assert.equal(p.view, 'planning');
  assert.equal(p.filters.horizon, 52);
  assert.equal(p.horizon_label, '12 months');
});

test('the supply figures are the pools\' own numbers added up', () => {
  const store = freshStore();
  const all = store.all();
  const t = tiles(buildPlanning(store, {}).supply.tiles);
  assert.equal(t.available.value, Math.round(sum(all, (a) => a.verdict.capacity.free_now)));
  assert.equal(t.pool_capacity.value, Math.round(sum(all, (a) => a.verdict.capacity.usable_now)));
  assert.equal(t.pool_capacity.value, 41088);
  assert.ok(Math.abs(t.utilization.value - sum(all, (a) => a.verdict.capacity.utilized) / sum(all, (a) => a.verdict.capacity.usable_now)) < 1e-12);
  assert.equal(t.headroom.value, Math.round(sum(all, (a) => Math.max(0, a.verdict.capacity.working_floor_pct * a.verdict.capacity.usable_now - a.verdict.capacity.utilized))));
  assert.equal(t.cost.value, Math.round(sum(all, (a) => a.verdict.capacity.usable_now * a.ctx.sku.unit_cost_usd)));
  assert.equal(t.available.value, 9678);
  assert.match(t.available.note, /^2,016 CU more lands within 12 months$/, 'the two orders already in flight for 12 months');
  assert.match(t.pool_capacity.note, /^6 pools in 4 regions, 2,016 CU more in flight$/);
});

test('health counts the pools flagged by the reliability, performance or dependency funnels, and only those', () => {
  const store = freshStore();
  const flagged = store.all().filter((a) => a.verdict.trace.some((x) => [2, 3, 6].includes(x.number) && x.status === 'flagged' && !x.context_only));
  const t = tiles(buildPlanning(store, {}).supply.tiles).health;
  assert.equal(t.value, flagged.length);
  assert.equal(t.of, 6);
  assert.ok(flagged.length > 0 && flagged.length < 6, 'not a vacuous check: some pools are flagged and some are not');
  const rows = buildPlanning(store, {}).supply.rows;
  assert.deepEqual(rows.filter((r) => r.health.length).map((r) => r.pool_id).sort(), flagged.map((a) => a.verdict.pool_id).sort());
});

test('product demand and the balance agree with the Overview: same total demand, same shortfall, same supply', () => {
  const store = freshStore();
  for (const horizon of [13, 26, 52]) {
    const p = buildPlanning(store, { horizon });
    const ov = buildOverview(store, { horizon });
    const last = ov.forecast.points.at(-1);
    assert.equal(p.balance.total.demand_cu, last.demand, `${horizon} weeks: demand`);
    assert.equal(p.balance.total.supply_cu, last.provisioned, `${horizon} weeks: supply`);
    assert.equal(p.balance.total.shortfall_cu, last.shortfall, `${horizon} weeks: shortfall`);
    assert.equal(tiles(p.demand.tiles).product_demand.value, last.demand);
  }
  const p52 = buildPlanning(store, { horizon: 52 });
  const ov52 = buildOverview(store, { horizon: 52 });
  assert.equal(tiles(p52.demand.tiles).product_demand.value, ov52.kpis.total_demand.value);
  assert.equal(tiles(p52.demand.tiles).product_demand.delta_pct, ov52.kpis.total_demand.delta_pct);
  assert.equal(p52.balance.total.shortfall_cu, ov52.kpis.projected_shortfall.value);
});

test('the balance is supply at the working ceiling less demand, per pool, worst first, and each row carries that pool\'s own plan', () => {
  const store = freshStore();
  const p = buildPlanning(store, { horizon: 52 });
  assert.equal(p.balance.rows.length, 6);
  const balances = p.balance.rows.map((r) => r.balance_cu);
  assert.deepEqual(balances, [...balances].sort((a, b) => a - b), 'worst first');
  for (const r of p.balance.rows) {
    const a = store.assessment(r.pool_id);
    assert.equal(r.supply_cu, Math.round(a.ctx.usableAt(52)));
    assert.equal(r.demand_cu, Math.round(a.ctx.planDemandAt(52)));
    assert.equal(r.ceiling_cu, Math.round(a.verdict.capacity.working_floor_pct * a.ctx.usableAt(52)));
    assert.ok(Math.abs(r.balance_cu - (r.ceiling_cu - r.demand_cu)) <= 1, 'rounding only');
    assert.equal(r.status === 'short', r.balance_cu < 0, `${r.pool_id}: short exactly when demand is over the ceiling`);
    assert.equal(r.state, a.verdict.state);
    assert.deepEqual(r.order && [r.order.quantity_cu, r.order.raise_by, r.order.lands_on], a.verdict.order.needed ? [a.verdict.order.quantity_cu, a.verdict.dates.raise_by, a.verdict.dates.lands_on] : null);
  }
  const eus = p.balance.rows[0];
  assert.deepEqual([eus.pool_id, eus.status, eus.state, eus.balance_cu], [P.eus, 'short', 'OVERDUE', -4650]);
  assert.deepEqual([p.balance.total.pools_short, p.balance.total.pools_ordering, p.balance.total.overdue, p.balance.total.order_cu], [4, 5, 1, 11616]);
  assert.equal(p.balance.rows.at(-1).status, 'ok', 'West Europe AMD has room to spare');
  assert.ok(p.balance.total.surplus_cu > 0 && p.balance.total.surplus_cu !== p.balance.total.shortfall_cu, 'a surplus is reported apart from the shortfall: it does not cover it');
  assert.match(p.balance.headline, /^At 12 months, demand of 39,334 CU against supply of 43,104 CU \(36,153 CU at the working ceilings\)\. 4 pools of 6 would be short by 7,294 CU in all, and a surplus elsewhere cannot cover that\. The plans order 11,616 CU for \$11\.52M, 1 of them already overdue\.$/);
});

test('demand: the growth, the pipeline and the requests are read from the pools and the pending queue', () => {
  const store = freshStore();
  const all = store.all();
  const p = buildPlanning(store, {});
  const t = tiles(p.demand.tiles);
  assert.equal(t.growth.value, Math.round(sum(all, (a) => a.verdict.forecast.slope_per_week)));
  assert.equal(t.pipeline.value, Math.round(sum(all, (a) => a.ctx.pipelineAt(52))));
  assert.equal(t.pipeline.value, 2018);
  assert.equal(t.requests.value, 9);
  assert.equal(t.requests.asked_cu, 4190);
  assert.equal(t.requests.at_risk, 1, 'REQ-1004 is the one at risk (the shipped requester view says so)');
  assert.equal(buildRequester(store, { org: 'contoso' }).requests.counts.at_risk, 1);
  assert.equal(t.workload_forecast.value, Math.round(sum(all, (a) => a.ctx.p50At(52))));
  assert.ok(t.workload_forecast.p80 > t.workload_forecast.value && t.workload_forecast.p80 < t.product_demand.value, 'the trend alone: above its middle, below the demand with the pipeline and dated adds on top');
  assert.equal(t.events.value, p.demand.events.length);
  assert.equal(t.events.step_cu, 2850, '300 + 200 + 1,200 from contracts and 250 + 900 from launches and relocations, less nothing');
  assert.deepEqual(p.demand.rows.map((r) => [r.pool_id, r.requests]), [[P.eus, 4], [P.weuAmd, 1], [P.weuGpu, 1], [P.sea, 1], [P.jpe, 1], [P.brs, 1]], 'one row per pool, with its pending requests');
  assert.equal(sum(p.demand.rows, (r) => r.requests), 9);
  assert.equal(sum(p.demand.rows, (r) => r.asked_cu), 4190);
});

test('business events: each listed once, in date order, contracts and events together, only inside the horizon', () => {
  const store = freshStore();
  const all = buildPlanning(store, { horizon: 52 }).demand.events;
  assert.deepEqual(all.map((e) => e.id), ['CON-0304', 'EVT-S02', 'CON-0101', 'EVT-T02', 'CON-0203', 'EVT-T01', 'EVT-S01', 'EVT-X01', 'EVT-G01']);
  assert.equal(new Set(all.map((e) => e.id)).size, all.length);
  assert.deepEqual(all.map((e) => e.date), [...all.map((e) => e.date)].sort());
  assert.deepEqual(all.map((e) => e.kind), ['contract', 'seasonal', 'contract', 'step', 'contract', 'signal', 'seasonal', 'signal', 'step']);
  assert.deepEqual(buildPlanning(store, { horizon: 13 }).demand.events.map((e) => e.id), ['CON-0304', 'EVT-S02'], 'within 3 months: the 1 Dec contract and the 14 Dec spike');
  assert.equal(all.find((e) => e.id === 'EVT-T01').cu, null, 'a new SKU informs the plan and adds no demand');
  assert.equal(all.find((e) => e.id === 'CON-0203').cu, 1200, 'what the contract still has to add');
});

test('the filters select pools the way the Overview does', () => {
  const store = freshStore();
  const gpu = buildPlanning(store, { sku: 'gpu' });
  assert.deepEqual(gpu.balance.rows.map((r) => r.pool_id).sort(), [P.weuGpu, P.jpe].sort());
  assert.equal(tiles(gpu.supply.tiles).pool_capacity.value, 4608 + 3840);
  const eur = buildPlanning(store, { region: 'europe' });
  assert.deepEqual(eur.balance.rows.map((r) => r.pool_id).sort(), [P.weuAmd, P.weuGpu].sort());
  assert.equal(tiles(eur.demand.tiles).requests.value, 2, 'REQ-2001 (AMD) and REQ-3001 (H100): REQ-0802 is approved, so it is not waiting');
  assert.equal(tiles(eur.demand.tiles).requests.asked_cu, 500 + 300);
  const none = buildPlanning(store, { sku: 'gpu', region: 'latin-america' });
  assert.deepEqual([none.balance.rows.length, none.balance.headline], [0, 'No pools match these filters.']);
  assert.equal(buildPlanning(store, { horizon: 99 }).filters.horizon, 52, 'an unknown horizon falls back to 12 months (the API refuses it)');
  assert.equal(buildPlanning(store, { horizon: 26 }).horizon_label, '6 months');
});

test('once time has moved, a request that went live is no longer pipeline, and events that have happened are no longer ahead', () => {
  const store = freshStore();
  const before = buildPlanning(store, {});
  store.advanceTime(8);
  const after = buildPlanning(store, {});
  const a = tiles(after.demand.tiles);
  const b = tiles(before.demand.tiles);
  assert.equal(a.requests.value, 8, 'REQ-1001 went live on 16 Nov');
  assert.equal(a.requests.asked_cu, 4190 - 480);
  assert.ok(Math.abs(b.pipeline.value - a.pipeline.value - 288) <= 1, `REQ-1001's 480 x 0.8 x 0.75 left the pipeline: ${b.pipeline.value} to ${a.pipeline.value}`);
  assert.equal(after.as_of, '2026-11-16');

  const late = freshStore();
  late.advanceTime(26);
  const events = buildPlanning(late, {}).demand.events.map((e) => e.id);
  for (const gone of ['CON-0304', 'EVT-S02', 'CON-0101', 'EVT-T02', 'CON-0203', 'EVT-T01']) assert.equal(events.includes(gone), false, `${gone} has happened or fallen due`);
  assert.deepEqual(events, ['EVT-S01', 'EVT-X01', 'EVT-G01']);
  assert.equal(tiles(buildPlanning(late, {}).demand.tiles).requests.value, 0, 'every shipped request has been settled by 22 Mar 2027');
});

test('API: /api/planning serves the page, takes the same filters as the Overview, and refuses the ones it does not know', async () => {
  const { createApp } = require('../server/app');
  const server = createApp({ store: freshStore(), webRoot: require('node:path').join(__dirname, '..', 'web') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (u) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${u}`); return { status: res.status, json: await res.json() }; };
  try {
    const ok = await call('/api/planning');
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.supply.tiles.length, ok.json.demand.tiles.length, ok.json.balance.rows.length], [6, 6, 6]);
    const scoped = await call('/api/planning?horizon=26&sku=gpu&region=europe');
    assert.deepEqual([scoped.json.filters.horizon, scoped.json.horizon_label, scoped.json.balance.rows.length], [26, '6 months', 1]);
    for (const bad of ['?horizon=7', '?horizon=abc', '?sku=storage', '?region=mars']) assert.equal((await call(`/api/planning${bad}`)).status, 400, bad);
  } finally { await new Promise((r) => server.close(r)); }
});

test('a small check of the plain words: every note reads as a sentence with no raw numbers or keys', () => {
  const p = buildPlanning(freshStore(), {});
  for (const t of [...p.supply.tiles, ...p.demand.tiles]) {
    assert.doesNotMatch(t.note, /undefined|NaN|\[object|\d\.\d{4,}/, `${t.key}: ${t.note}`);
    assert.doesNotMatch(t.definition, /undefined|NaN|\[object/, t.key);
  }
  assert.doesNotMatch(p.balance.headline, /undefined|NaN/);
});
