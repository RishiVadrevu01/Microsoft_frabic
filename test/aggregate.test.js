'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { movementCorrelation, combinedSpread, createAggregator, aggregatorFor, pearson, MIN_MOVEMENTS } = require('../server/lib/aggregate');
const { forecastSeries } = require('../server/lib/forecast');
const { buildOverview } = require('../server/lib/overview');
const { mulberry32, normal } = require('../server/lib/rng');
const { P, freshStore } = require('./helpers');

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const walk = (n, seed, step = 10) => { const r = mulberry32(seed); let v = 1000; return Array.from({ length: n }, () => (v += step + 30 * normal(r))); };

// ---------------------------------------------------------------- the correlation
test('correlation: pools that move together score high, pools that do not score near zero, and it is never below zero', () => {
  const a = walk(52, 1);
  const same = a.map((v) => 2 * v + 500);                                    // the same movements, scaled
  const mirror = a.map((v) => 5000 - v);                                     // the opposite movements
  const other = walk(52, 99);
  const c = movementCorrelation([{ id: 'a', values: a }, { id: 'same', values: same }, { id: 'mirror', values: mirror }, { id: 'other', values: other }]);
  assert.ok(c.measured);
  assert.ok(close(c.matrix[0][1], 1, 1e-9), 'the same movements');
  assert.equal(c.matrix[0][2], 0, 'opposite movements are floored at zero: no credit for errors that offset');
  assert.ok(c.matrix[0][3] >= 0 && c.matrix[0][3] < 0.5);
  for (const row of c.matrix) assert.ok(row.every((x) => x >= 0 && x <= 1 + 1e-12));
  assert.ok(c.matrix.every((row, i) => row.every((x, j) => close(x, c.matrix[j][i]))), 'symmetric');
  assert.ok(c.matrix.every((row, i) => row[i] === 1), 'a pool is fully correlated with itself');
  assert.equal(c.movements, 51);
});

test('correlation: a level shift is not a shared movement, and a flat series is uncorrelated with everything', () => {
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), 0);
  const flat = Array(30).fill(500);
  const c = movementCorrelation([{ id: 'flat', values: flat }, { id: 'w', values: walk(30, 3) }]);
  assert.equal(c.matrix[0][1], 0);
});

test('correlation: with too little history to measure, pools are assumed to move together, which gives back the plain sum', () => {
  const c = movementCorrelation([{ id: 'a', values: walk(MIN_MOVEMENTS, 1) }, { id: 'b', values: walk(MIN_MOVEMENTS, 2) }]);
  assert.equal(c.measured, false);
  assert.equal(c.matrix[0][1], 1);
  assert.equal(c.movements, 0);
});

// ---------------------------------------------------------------- the combined spread
test('combined spread: fully related pools add, unrelated pools add in quadrature, and one pool is itself', () => {
  const s = [300, 400, 1200];
  const ones = s.map(() => s.map(() => 1));
  const eye = s.map((_, i) => s.map((__, j) => (i === j ? 1 : 0)));
  assert.ok(close(combinedSpread(s, ones), 1900));
  assert.ok(close(combinedSpread(s, eye), Math.sqrt(300 ** 2 + 400 ** 2 + 1200 ** 2)));
  assert.equal(combinedSpread([777], [[1]]), 777);
  assert.equal(combinedSpread([], []), 0);
  const between = s.map((_, i) => s.map((__, j) => (i === j ? 1 : 0.4)));
  const v = combinedSpread(s, between);
  assert.ok(v > combinedSpread(s, eye) && v < combinedSpread(s, ones), 'more relatedness, wider spread');
});

// ---------------------------------------------------------------- on the lab's own estate
test('one pool on its own is exactly its own plan, whatever else is in the estate', () => {
  const store = freshStore();
  const agg = aggregatorFor(store.all());
  for (const a of store.all()) {
    for (const h of [0, 13, 26, 52]) {
      assert.ok(close(agg.combine([a], h).plan, a.ctx.planDemandAt(h), 1e-6), `${a.verdict.pool_id} at ${h}`);
      assert.ok(close(agg.combine([a], h, { prior: true }).plan, a.ctx.planDemandAt(h, { prior: true }), 1e-6), `${a.verdict.pool_id} a quarter ago`);
    }
  }
});

test('a group is never above the plain sum of its pools, and never below treating them as unrelated', () => {
  const store = freshStore();
  const all = store.all();
  const agg = aggregatorFor(all);
  for (const h of [13, 26, 52]) {
    const c = agg.combine(all, h);
    const indep = c.p50 + Math.sqrt(all.reduce((s, a) => s + a.ctx.spreadAt(h) ** 2, 0));
    assert.ok(c.plan <= c.sum_of_pool_p80 + 1e-6, `${h}: ${c.plan} vs ${c.sum_of_pool_p80}`);
    assert.ok(c.plan >= indep - 1e-6, `${h}: related pools cannot be tighter than unrelated ones`);
    assert.ok(c.diversification > 0, 'six distinct pools do diversify');
    assert.ok(close(c.plan, c.p50 + c.spread), 'the plan is the middle plus the combined spread');
    assert.ok(close(c.sum_of_pool_p80 - c.diversification, c.plan, 1e-6), 'the plan is the plain sum less what diversification saves');
  }
  assert.equal(agg.combine(all, 0).diversification, 0, 'today there is nothing uncertain to combine');
});

test('the hierarchy agrees with itself: regions add up to the total in the middle, and their ranges combine to the total\'s', () => {
  const store = freshStore();
  const all = store.all();
  const agg = aggregatorFor(all);
  const byGeo = {};
  for (const a of all) (byGeo[a.ctx.pool.geo] ||= []).push(a);
  for (const h of [26, 52]) {
    const total = agg.combine(all, h);
    const regions = Object.values(byGeo).map((pools) => agg.combine(pools, h));
    assert.ok(close(regions.reduce((s, r) => s + r.p50, 0), total.p50, 1e-6), 'the middles add exactly');
    const sumSpreads = regions.reduce((s, r) => s + r.spread, 0);
    const quad = Math.sqrt(regions.reduce((s, r) => s + r.spread ** 2, 0));
    assert.ok(total.spread <= sumSpreads + 1e-6, 'the total is never wider than its regions added');
    assert.ok(total.spread >= quad - 1e-6, 'and never tighter than its regions taken as unrelated');
    assert.ok(total.plan <= regions.reduce((s, r) => s + r.plan, 0) + 1e-6, 'so the total p80 is at most the regions\' p80s added');
  }
});

test('the correlation is measured from the data, and is small on this estate', () => {
  const store = freshStore();
  const { corr } = aggregatorFor(store.all());
  assert.ok(corr.measured && corr.movements === 51);
  assert.ok(corr.average >= 0 && corr.average < 0.15, `average ${corr.average}`);
  assert.equal(corr.ids.length, 6);
  assert.strictEqual(aggregatorFor(store.all()), aggregatorFor(store.all()), 'measured once per set of assessments');
});

// ---------------------------------------------------------------- what the Overview shows
test('the Overview total is the combined forecast, lower than adding the pools by exactly the diversification', () => {
  const store = freshStore();
  const o = buildOverview(store, {});
  const t = o.kpis.total_demand;
  const plain = store.all().reduce((s, a) => s + a.ctx.planDemandAt(52), 0);
  assert.equal(t.sum_of_pool_p80, Math.round(plain), 'adding the pools\' p80s is still reported');
  assert.ok(t.value < t.sum_of_pool_p80);
  assert.ok(Math.abs(t.sum_of_pool_p80 - t.diversification_cu - t.value) <= 1, 'value = sum of p80s - diversification');
  assert.ok(t.p50 < t.value);
  assert.match(t.definition, /combined as one forecast, not by adding each pool's p80/);
  assert.equal(o.aggregation.measured, true);
  assert.equal(o.aggregation.movements, 51);
});

test('shortfall and every pool\'s own plan are unchanged by combining: a surplus in one pool still cannot cover another', () => {
  const store = freshStore();
  const o = buildOverview(store, {});
  const expected = store.all().reduce((s, a) => s + Math.max(0, a.ctx.planDemandAt(52) - a.verdict.capacity.working_floor_pct * a.ctx.usableAt(52)), 0);
  assert.equal(o.kpis.projected_shortfall.value, Math.round(expected));
  const v = Object.fromEntries(store.all().map((a) => [a.verdict.pool_id, a.verdict]));
  assert.equal(v[P.eus].order.quantity_cu, 4032);
  assert.equal(v[P.eus].state, 'OVERDUE');
});

test('regions with one pool are unchanged; regions with several are combined, and the forecast chart uses the same total', () => {
  const store = freshStore();
  const o = buildOverview(store, {});
  const by = Object.fromEntries(o.regions.map((r) => [r.key, r]));
  for (const k of ['north-america', 'latin-america']) assert.equal(by[k].demand_cu, by[k].sum_of_pool_p80_cu, `${k} has one pool`);
  for (const k of ['europe', 'asia-pacific']) assert.ok(by[k].demand_cu < by[k].sum_of_pool_p80_cu, `${k} has two pools that diversify`);
  const last = o.forecast.points.at(-1);
  assert.equal(last.demand, o.kpis.total_demand.value, 'the last chart point is the 12-month total');
  assert.ok(o.forecast.points.every((p, i) => i === 0 || p.demand >= o.forecast.points[i - 1].demand * 0.97), 'a smooth path');
  const first = o.forecast.points[0];
  assert.equal(first.demand, Math.round(store.all().reduce((s, a) => s + a.ctx.planDemandAt(0), 0)), 'today there is nothing to combine');
});

test('filtering to one pool gives exactly that pool\'s own demand', () => {
  const store = freshStore();
  const o = buildOverview(store, { region: 'north-america' });
  assert.equal(o.kpis.total_demand.value, Math.round(store.all().find((a) => a.verdict.pool_id === P.eus).ctx.planDemandAt(52)));
  assert.equal(o.kpis.total_demand.diversification_cu, 0);
});

// ---------------------------------------------------------------- does it actually get the answer right?
// Simulated estates with a known error structure, forecast with the lab's own straight-line model at rolling
// origins. If the combined p80 is right, the actual total falls below it about 80% of the time whatever the
// pools' relationship; adding p80s over-covers when errors are unrelated; and assuming pools are unrelated
// under-covers when they share shocks. (Holt is switched off: its interval widens like sqrt(h) and is far too wide on
// a series that is truly a straight line, which would hide what is being tested.)
const CFG = { window_weeks: 26, backtest_horizon_weeks: 8, holt_margin: 0.999, p_upper_z: 0.8416 };
function estate(seed, pools, weeks, shared) {
  const rand = mulberry32(seed);
  const shock = Array.from({ length: weeks }, () => normal(rand));
  return Array.from({ length: pools }, (_, p) => Array.from({ length: weeks }, (__, t) => 2000 + 700 * p + (8 + 4 * p) * t + (40 + 12 * p) * (Math.sqrt(shared) * shock[t] + Math.sqrt(1 - shared) * normal(rand))));
}
function coverage(shared) {
  const horizon = 8;
  let n = 0; let sum = 0; let combined = 0; let unrelated = 0;
  for (let seed = 500; seed < 524; seed++) {
    const series = estate(seed, 8, 160, shared);
    for (let o = 70; o <= 160 - horizon; o += 6) {
      const fits = series.map((v) => forecastSeries(v.slice(0, o), CFG));
      const spread = fits.map((f) => f.upper[horizon - 1] - f.p50[horizon - 1]);
      const mid = fits.reduce((s, f) => s + f.p50[horizon - 1], 0);
      const actual = series.reduce((s, v) => s + v[o + horizon - 1], 0);
      const R = movementCorrelation(series.map((v, i) => ({ id: String(i), values: v.slice(0, o) }))).matrix;
      n++;
      sum += actual <= mid + spread.reduce((s, x) => s + x, 0);
      combined += actual <= mid + combinedSpread(spread, R);
      unrelated += actual <= mid + Math.sqrt(spread.reduce((s, x) => s + x * x, 0));
    }
  }
  return { sum: sum / n, combined: combined / n, unrelated: unrelated / n, n };
}

test('the combined p80 covers about 80% of outcomes whether pools\' errors are unrelated or move together', () => {
  const independent = coverage(0);
  const shared = coverage(0.6);
  for (const [label, c] of [['unrelated', independent], ['shared', shared]]) {
    assert.ok(c.combined > 0.72 && c.combined < 0.9, `${label}: the combined p80 covered ${c.combined.toFixed(3)} of ${c.n}`);
  }
  assert.ok(independent.sum > independent.combined + 0.1, `adding p80s over-covers when errors are unrelated: ${independent.sum.toFixed(3)} against ${independent.combined.toFixed(3)}`);
  assert.ok(shared.unrelated < shared.combined - 0.08, `assuming unrelated pools under-covers when they share shocks: ${shared.unrelated.toFixed(3)} against ${shared.combined.toFixed(3)}`);
});
