'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { P, dataset, verdictOf, freshStore } = require('./helpers');
const { summarize } = require('../server/lib/summary');

const data = dataset();
const v = (pool, overrides) => verdictOf(data, pool, overrides);

test('baseline story: one overdue, two order-now, two plan, one calm', () => {
  const states = Object.fromEntries(data.pools.map((p) => [p.pool_id, v(p.pool_id).state]));
  assert.deepEqual(states, {
    [P.eus]: 'OVERDUE', [P.weuAmd]: 'OK', [P.weuGpu]: 'ORDER NOW', [P.sea]: 'ORDER NOW', [P.jpe]: 'PLAN', [P.brs]: 'PLAN',
  });
});

test('golden order quantities and dates for the shipped dataset', () => {
  const g = (pool) => { const x = v(pool); return [x.order.quantity_cu, x.dates.needed_by, x.dates.raise_by, x.lead.weeks, x.driver && x.driver.id]; };
  assert.deepEqual(g(P.eus), [4032, '2026-12-28', '2026-08-10', 20, 'demand']);
  assert.deepEqual(g(P.weuGpu), [1344, '2027-02-15', '2026-10-05', 19, 'customer-contract']);
  assert.deepEqual(g(P.sea), [1728, '2027-02-22', '2026-10-05', 20, 'reliability']);
  assert.deepEqual(g(P.jpe), [2592, '2027-04-05', '2026-11-23', 19, 'seasonal']);
  assert.deepEqual(g(P.brs), [1920, '2027-08-01', '2027-03-14', 20, 'geopolitical']);
  assert.deepEqual(g(P.weuAmd), [0, null, null, 20, null]);
});

test('the engine is deterministic: the same data gives byte-identical plans', () => {
  const a = JSON.stringify(data.pools.map((p) => v(p.pool_id)));
  const b = JSON.stringify(dataset().pools.map((p) => verdictOf(dataset(), p.pool_id)));
  assert.equal(a, b);
});

test('raise-by is the need-by date minus the lead time, in whole days', () => {
  for (const p of data.pools) {
    const x = v(p.pool_id);
    if (!x.order.needed || x.dates.order_by && x.dates.order_by < x.dates.raise_by) continue;
    const expected = new Date(`${x.dates.needed_by}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() - x.lead.weeks * 7);
    assert.equal(x.dates.raise_by, expected.toISOString().slice(0, 10), p.pool_id);
  }
});

test('lead time = the largest "set" value plus every "add" (AMD: quote 14, observed p80 20; GPU: 19)', () => {
  const x = v(P.eus);
  assert.equal(x.lead.weeks, x.lead.breakdown.reduce((a, l) => a + l.weeks, 0));
  const gpu = v(P.weuGpu);
  assert.equal(gpu.lead.weeks, 19);
  assert.deepEqual(gpu.lead.breakdown.map((l) => l.weeks), [19]);
  const risky = verdictOf(dataset((raw) => { raw.vendors.find((s) => s.vendor_id === 'vendor-northwind').risk_score = 0.6; }), P.eus);
  assert.equal(risky.lead.weeks, 24, 'a vendor risk score of 0.5 or more adds four weeks');
  assert.deepEqual(risky.lead.breakdown.map((l) => l.weeks), [20, 4]);
});

test('orders are whole racks and never below the vendor minimum', () => {
  for (const p of data.pools) {
    const x = v(p.pool_id);
    if (!x.order.needed) continue;
    assert.equal(x.order.quantity_cu % x.what.order_unit_cu, 0, `${p.pool_id} not a whole number of racks`);
    assert.ok(x.order.quantity_cu >= x.what.vendor_min_cu);
    assert.equal(x.order.cost_usd, x.order.quantity_cu * x.what.unit_cost_usd);
  }
});

test('an end-of-life SKU is ordered as its successor, converted at the equivalence factor', () => {
  const x = v(P.eus);
  assert.equal(x.what.order_sku, 'FAB-AMD-GENOA-96');
  assert.equal(x.what.replaces, true);
  assert.equal(x.what.factor, 1.35);
  assert.ok(x.order.equivalent_cu > x.order.quantity_cu);
  assert.equal(x.order.equivalent_cu, x.order.quantity_cu * 1.35);
});

test('an active SKU is ordered as itself at factor 1', () => {
  const x = v(P.sea);
  assert.equal(x.what.order_sku, 'FAB-AMD-GENOA-96');
  assert.equal(x.what.replaces, false);
  assert.equal(x.what.factor, 1);
});

test('the order arithmetic table ends on the quantity ordered', () => {
  for (const p of data.pools) {
    const x = v(p.pool_id);
    if (!x.order.needed) { assert.equal(x.order.components.length, 0); continue; }
    assert.equal(x.order.components.at(-1).value, x.order.quantity_cu);
  }
});

test('capacity lands after it is needed on an overdue pool, and the plan says by how long', () => {
  const x = v(P.eus);
  assert.equal(x.dates.overdue_days, 42);
  assert.equal(x.dates.short_weeks, 6);
  assert.match(x.reasons.join(' '), /lands 6 weeks after it is needed/);
});

test('a pool with in-flight supply counts it: East US in-flight order shrinks the need', () => {
  const without = dataset((raw) => { raw.supply = raw.supply.filter((s) => s.pool_id !== P.eus); });
  assert.ok(verdictOf(without, P.eus).order.quantity_cu > v(P.eus).order.quantity_cu);
});

test('the earliest need-by date wins: a nearer contract takes over from the demand crossing', () => {
  const nearer = dataset((raw) => {
    raw.contracts.find((c) => c.contract_id === 'CON-0101').effective_date = '2026-11-02';
    raw.contracts.find((c) => c.contract_id === 'CON-0101').committed_cu = 4000;
  });
  const x = verdictOf(nearer, P.eus);
  assert.equal(x.driver.id, 'customer-contract');
  assert.equal(x.dates.needed_by, '2026-11-02');
});

test('what-if: a shorter lead time moves the raise-by date later and changes nothing else', () => {
  const base = v(P.eus);
  const alt = v(P.eus, { lead_time_weeks: 8 });
  assert.equal(alt.lead.weeks, 8);
  assert.ok(alt.dates.raise_by > base.dates.raise_by);
  assert.equal(alt.dates.needed_by, base.dates.needed_by);
  assert.equal(alt.state, 'PLAN');
});

test('what-if: zero growth removes the demand crossing; a higher floor delays it', () => {
  const flat = v(P.eus, { growth_pts_per_week: 0 });
  assert.notEqual(flat.driver && flat.driver.id, 'demand');
  const looser = v(P.eus, { floor_pct: 0.95 });
  assert.ok(looser.dates.needed_by > v(P.eus).dates.needed_by);
});

test('what-if: a bigger conversion ratio shrinks the successor order', () => {
  assert.ok(v(P.eus, { conversion_factor: 2 }).order.quantity_cu < v(P.eus).order.quantity_cu);
});

test('what-if never changes the stored data', () => {
  const store = freshStore();
  const before = JSON.stringify(store.verdicts());
  store.whatIf(P.eus, { lead_time_weeks: 3, growth_pts_per_week: 2 });
  assert.equal(JSON.stringify(store.verdicts()), before);
});

test('"good for 3, 6, 12 months?" answers come from the pool horizons', () => {
  const s = summarize(data.pools.map((p) => v(p.pool_id)), data);
  assert.deepEqual(s.horizons.map((h) => h.weeks), [13, 26, 52]);
  assert.deepEqual(s.horizons.map((h) => h.answer), ['Act', 'At risk', 'At risk']);
  assert.match(s.headline, /^No\. 1 of 6 pools is already past/);
  assert.equal(s.actions[0].pool_id, P.eus);
  assert.equal(s.actions.at(-1).pool_id, P.weuAmd);
  assert.equal(s.kpis.open_actions, 5);
  assert.equal(s.kpis.order_cu, 4032 + 1344 + 1728 + 2592 + 1920);
});

test('an estate with no pressure answers yes to all three horizons', () => {
  const calm = dataset((raw) => {
    raw.requests = []; raw.contracts = []; raw.events = []; raw.incidents = []; raw.dependencies = raw.dependencies.map((d) => ({ ...d, failover_pool_id: 'x' }));
    raw.performance = raw.performance.map((p) => ({ ...p, p95_latency_ms: p.p95_baseline_ms, queue_depth_p95: 1 }));
    for (const u of raw.utilization) {
      const last = u.series.at(-1).utilized_units;
      u.series.forEach((pt) => { pt.utilized_units = Math.round(last * 0.4); });
    }
    for (const a of raw.allocations) a.utilized_units = Math.round(a.utilized_units * 0.4 / 1);
    for (const p of raw.pools) {
      const rows = raw.allocations.filter((a) => a.pool_id === p.pool_id);
      const target = raw.utilization.find((u) => u.pool_id === p.pool_id).series.at(-1).utilized_units;
      const sum = rows.reduce((x, r) => x + r.utilized_units, 0);
      rows[rows.length - 1].utilized_units += target - sum;
      rows.forEach((r) => { r.allocated_units = Math.max(r.allocated_units, r.utilized_units); });
    }
  });
  const s = summarize(calm.pools.map((p) => verdictOf(calm, p.pool_id)), calm);
  assert.ok(s.horizons.every((h) => h.at_risk.length === 0), JSON.stringify(s.horizons.map((h) => h.at_risk)));
});
