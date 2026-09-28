'use strict';
/*
 * OUTCOME and FEEDBACK (stages 10 and 11): the simulation clock, the ledger of what was predicted, and the comparison.
 * The clock is a pure function of (data, weeks); the actuals are generated; nothing here may touch the shipped seed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { P, DATA_DIR, freshStore, tempDataDir } = require('./helpers');
const { loadRaw, indexData, clone, integrity } = require('../server/lib/data');
const { buildContext } = require('../server/lib/context');
const { assessPool } = require('../server/lib/verdict');
const { advance, advanceLimit, MAX_WEEKS, SURPRISE_MIN, SURPRISE_MAX } = require('../server/lib/clock');
const { buildOutcome, readOf } = require('../server/lib/outcome');
const { decide } = require('../server/lib/decisions');
const { createStore } = require('../server/lib/store');
const { addWeeks } = require('../server/lib/dates');

const raw = loadRaw(DATA_DIR);
const advanced = (weeks, edit) => { const w = clone(raw); if (edit) edit(w); const report = advance(w, weeks); return { w, report, data: indexData(w) }; };
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

// ---------------------------------------------------------------- the clock
test('advancing is a pure function of the data and the weeks, and 4 weeks then 4 more is the same as 8', () => {
  const a = advanced(8); const b = advanced(8); const four = advanced(4);
  assert.deepEqual(a.report, b.report, 'the same weeks always give the same world');
  assert.deepEqual(a.w, b.w);
  for (const id of Object.keys(a.report.actuals)) {
    assert.deepEqual(four.report.actuals[id], a.report.actuals[id].slice(0, 4), `${id}: the first 4 weeks do not depend on how many were asked for`);
  }
});

test('the seed is never touched', () => {
  const before = JSON.stringify(loadRaw(DATA_DIR));
  advanced(10);
  assert.equal(JSON.stringify(loadRaw(DATA_DIR)), before);
  assert.equal(JSON.stringify(raw), before, 'the loaded copy is unchanged too');
});

test('an advanced dataset still meets every input rule, for every number of weeks the lab allows', () => {
  for (let weeks = 1; weeks <= MAX_WEEKS; weeks++) {
    const { w } = advanced(weeks);
    assert.deepEqual(integrity(w), [], `${weeks} weeks: consecutive weeks ending on the new date, reservations adding up to the latest reading, segments adding up to capacity`);
    assert.equal(w.as_of, addWeeks(raw.as_of, weeks));
    assert.equal(w.meta.as_of, w.as_of);
    for (const u of w.utilization) {
      assert.equal(u.series.length, 52 + weeks);
      assert.ok(u.series.every((p) => p.utilized_units >= 0 && Number.isInteger(p.utilized_units)), `${u.pool_id}: readings are whole and not negative`);
    }
  }
});

test('the actuals are generated without seeing the forecast: changing how the forecast is fitted changes nothing', () => {
  const a = advanced(6);
  const b = advanced(6, (w) => { w.policy.forecast.p_upper_z = 2.3; w.policy.forecast.holt_margin = 0.5; w.policy.forecast.backtest_horizon_weeks = 4; });
  assert.deepEqual(b.report.actuals, a.report.actuals);
});

test('each pool gets its own growth surprise inside the documented range, and it is not the same for every pool', () => {
  const { report } = advanced(3);
  const s = Object.values(report.generated_with).map((g) => g.surprise);
  assert.ok(s.every((x) => x >= SURPRISE_MIN && x <= SURPRISE_MAX), `all within ${SURPRISE_MIN} to ${SURPRISE_MAX}: ${s}`);
  assert.ok(new Set(s).size > 3, 'the pools do not all get the same surprise');
});

test('each team keeps its share of the pool: reservations follow the new reading (with no dated demand to attribute)', () => {
  const { w } = advanced(8, (x) => { x.requests = x.requests.filter((r) => r.status !== 'pending'); x.contracts = []; x.events = []; });
  for (const p of raw.pools) {
    const before = raw.allocations.filter((a) => a.pool_id === p.pool_id);
    const after = w.allocations.filter((a) => a.pool_id === p.pool_id);
    const latest = w.utilization.find((u) => u.pool_id === p.pool_id).series.at(-1).utilized_units;
    assert.equal(after.reduce((a, r) => a + r.utilized_units, 0), latest);
    const total0 = before.reduce((a, r) => a + r.utilized_units, 0);
    for (let i = 0; i < before.length; i++) {
      assert.ok(Math.abs(after[i].utilized_units / latest - before[i].utilized_units / total0) < 0.002, `${p.pool_id}: ${after[i].reserved_by} keeps its share`);
      assert.equal(after[i].allocated_units, before[i].allocated_units, 'what was reserved does not change');
    }
  }
});

test('supply: an order lands or slips by the vendor\'s own history, and a landed order adds capacity to its pool', () => {
  const { w, report, data } = advanced(8);
  const landed = report.arrivals.find((a) => a.order_id === 'ORD-2026-0440');
  assert.deepEqual([landed.planned_lands_on, landed.landed_on, landed.slip_weeks, landed.units_added], ['2026-10-26', '2026-11-02', 1, 384]);
  const sea = data.poolById[P.sea];
  assert.equal(sea.capacity_units, raw.pools.find((p) => p.pool_id === P.sea).capacity_units + 384);
  assert.ok(sea.segments.some((s) => s.segment_id === 'arrived-ORD-2026-0440' && s.units === 384));
  const rec = w.supply.find((s) => s.order_id === 'ORD-2026-0440');
  assert.deepEqual([rec.status, rec.planned_lands_on, rec.landed_on], ['racked', '2026-10-26', '2026-11-02']);

  const slipped = report.slips.find((s) => s.order_id === 'ORD-2026-0412');
  assert.deepEqual([slipped.planned_lands_on, slipped.lands_on, slipped.slip_weeks], ['2026-11-09', '2026-11-30', 3], 'its planned day has passed; the vendor gives a new date, and that is what the plan sees');
  assert.ok(data.supply.find((s) => s.order_id === 'ORD-2026-0412').lands_on > data.as_of, 'it is still in flight');
  assert.equal(report.arrivals.concat(report.slips).some((o) => o.order_id === 'ORD-2026-0431'), false, 'an order that is not due yet is left alone');
  assert.equal(data.poolById[P.eus].capacity_units, raw.pools.find((p) => p.pool_id === P.eus).capacity_units, 'a slipped order adds nothing yet');
});

test('an approved order is placed on its date, then it is the vendor\'s to deliver', () => {
  const store = freshStore();
  const { order } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  assert.equal(order.status, 'approved-not-placed');
  store.advanceTime(1);
  const rec = store.data().supply.find((s) => s.order_id === order.order_id);
  assert.equal(rec.status, 'ordered');
  assert.equal(store.clock().placed.map((p) => p.order_id).join(), order.order_id);
});

test('incidents and feed deliveries keep their age, so the reliability window does not empty just because time passed', () => {
  const { data } = advanced(10);
  const seedAges = raw.incidents.map((i) => i.opened_on).map((d) => d);
  assert.equal(data.incidents.length, raw.incidents.length);
  assert.deepEqual(data.incidents.map((i) => i.opened_on), seedAges.map((d) => addWeeks(d, 10)));
  const seed = indexData(clone(raw));
  const health = (d, id) => assessPool(d, id).verdict.trace.find((t) => t.number === 2).status;
  assert.equal(health(data, P.sea), health(seed, P.sea), 'Southeast Asia is still flagged by the reliability funnel');
  const stale = (d) => d.feeds.filter((f) => buildContext(d, P.eus).feedStatus(f.feed_id).stale).map((f) => f.feed_id);
  assert.deepEqual(stale(data), stale(seed), 'the same feeds are stale');
});

// ---------------------------------------------------------------- how far the clock may go
test('the lab may advance 26 weeks: dated demand no longer stops it, it is realized (see dated.test.js)', () => {
  const lim = advanceLimit();
  assert.equal(lim.max_weeks, MAX_WEEKS);
  assert.equal(MAX_WEEKS, 26);
  assert.match(lim.reason, /^26 weeks is the most this lab generates\. Contracts, events and requests that fall due inside them are realized in the actuals\.$/);
  assert.equal('first_dated_demand' in lim, false, 'nothing is left to stop at');
});

test('advanceTime refuses what it cannot do, with the reason', () => {
  const store = freshStore();
  for (const bad of [0, -2, 1.5, 'lots', null]) assert.throws(() => store.advanceTime(bad), (e) => e.status === 400 && /whole number of 1 or more/.test(e.message));
  assert.throws(() => store.advanceTime(27), (e) => e.status === 409 && /can advance 26 more weeks at most \(26 in all\).*realized in the actuals/.test(e.message));
  store.advanceTime(25);
  assert.throws(() => store.advanceTime(2), (e) => e.status === 409 && /1 more week at most/.test(e.message));
  store.advanceTime(1);
  assert.throws(() => store.advanceTime(1), (e) => e.status === 409 && /cannot advance any further \(26 weeks in all\)/.test(e.message));
  assert.equal(store.data().as_of, '2027-03-22');
});

// ---------------------------------------------------------------- the store keeps it
test('the clock survives a restart, and reset puts "today" back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-clock-')), 'state.json');
  const a = createStore({ dataDir: DATA_DIR, statePath: file });
  a.advanceTime(3); a.advanceTime(2);
  const b = createStore({ dataDir: DATA_DIR, statePath: file });
  assert.equal(b.state().advance.weeks, 5);
  assert.equal(b.state().ledger.length, 2);
  assert.equal(b.data().as_of, '2026-10-26');
  assert.deepEqual(b.verdicts().map((v) => [v.state, v.order.quantity_cu]), a.verdicts().map((v) => [v.state, v.order.quantity_cu]), 'the same world after a restart');
  b.reset();
  assert.equal(b.state().advance.weeks, 0);
  assert.equal(b.state().ledger.length, 0);
  assert.equal(b.data().as_of, '2026-09-21');
  assert.equal(createStore({ dataDir: DATA_DIR, statePath: file }).data().as_of, '2026-09-21');
});

test('a state file from before the clock existed, or a damaged one, opens as not advanced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-clock-'));
  const write = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(body)); return f; };
  const old = createStore({ dataDir: DATA_DIR, statePath: write('old.json', { scenarios: [], requests: [], decisions: [], orders: [], completed: { 1: true }, resets: 2 }) });
  assert.deepEqual([old.state().advance, old.state().ledger, old.state().resets], [{ weeks: 0 }, [], 2]);
  const noLedger = createStore({ dataDir: DATA_DIR, statePath: write('noledger.json', { advance: { weeks: 4 }, ledger: [] }) });
  assert.equal(noLedger.state().advance.weeks, 0, 'weeks with no record of what was predicted cannot be compared, so they are dropped');
  const junk = createStore({ dataDir: DATA_DIR, statePath: write('junk.json', { advance: { weeks: 'many' }, ledger: 5 }) });
  assert.equal(junk.data().as_of, '2026-09-21');
});

test('the busiest-hour check is switched off once the lab has moved on, and says why', () => {
  const store = freshStore();
  store.advanceTime(2);
  const p = store.peak();
  assert.equal(p.available, false);
  assert.match(p.reason, /advanced 2 weeks/);
});

// ---------------------------------------------------------------- OUTCOME and FEEDBACK
test('before the lab moves there is nothing to compare, and it says how far it can go', () => {
  const o = buildOutcome(freshStore());
  assert.equal(o.advanced_weeks, 0);
  assert.equal(o.summary, null);
  assert.deepEqual(o.pools, []);
  assert.equal(o.limit.max_weeks, 26);
  assert.equal(o.limit.remaining, 26);
  assert.deepEqual(o.dated, []);
  assert.ok(o.notes.length >= 3 && o.notes.some((n) => /generated/.test(n)) && o.notes.some((n) => /fall due are realized/.test(n)));
});

test('the ledger records what was predicted when the lab moved, and the comparison is that record subtracted from what was generated', () => {
  const store = freshStore();
  const seed = indexData(clone(raw));
  store.advanceTime(4);
  const ledger0 = store.state().ledger[0];
  assert.equal(ledger0.origin_weeks, 0);
  assert.equal(ledger0.origin_as_of, '2026-09-21');
  for (const p of raw.pools) {
    const fc = buildContext(seed, p.pool_id).fc;
    const snap = ledger0.pools[p.pool_id].forecast;
    assert.equal(snap.input_hash, fc.input_hash, `${p.pool_id}: the snapshot names the forecast it recorded`);
    assert.deepEqual(snap.p50, fc.p50.slice(0, 52).map(Math.round));
    // and the demand the plan counted: the forecast with the pipeline, the dated adds and the seasonal spike on top
    const ctx = buildContext(seed, p.pool_id);
    const weeks52 = Array.from({ length: 52 }, (_, i) => i + 1);
    assert.deepEqual(ledger0.pools[p.pool_id].demand.p50, weeks52.map((h) => Math.round(ctx.p50At(h) + ctx.pipelineAt(h) + ctx.knownAddsAt(h) + ctx.seasonalSpikeAt(h))), `${p.pool_id}: plan demand, middle path`);
    assert.deepEqual(ledger0.pools[p.pool_id].demand.p80, weeks52.map((h) => Math.round(ctx.planDemandAt(h))), `${p.pool_id}: plan demand, p80 path`);
  }

  const o = buildOutcome(store);
  assert.equal(o.advanced_weeks, 4);
  for (const pool of o.pools) {
    const series = store.data().utilByPool[pool.pool_id];
    const fc = buildContext(seed, pool.pool_id).fc;
    pool.chart.rows.forEach((r, i) => {
      assert.equal(r.actual, series[52 + i].utilized_units);
      assert.equal(r.p50, ledger0.pools[pool.pool_id].demand.p50[i], 'an actual is held against the demand the plan counted');
      assert.equal(r.p80, ledger0.pools[pool.pool_id].demand.p80[i]);
      assert.equal(r.error, r.actual - r.p50);
      assert.equal(r.within_p80, r.actual <= r.p80);
      // nothing falls due in the first 4 weeks, so the plan's demand IS the forecast, and the trend part is the whole actual
      assert.equal(buildContext(seed, pool.pool_id).pipelineAt(4), 0, 'no request is due within 4 weeks');
      assert.equal(r.p50, Math.round(fc.p50[i]));
      assert.deepEqual([r.trend.p50, r.trend.p80, r.trend.actual, r.dated_cu], [Math.round(fc.p50[i]), Math.round(fc.upper[i]), r.actual, 0]);
    });
    const rows = pool.chart.rows;
    assert.ok(Math.abs(pool.forecast.mape_pct - mean(rows.map((r) => Math.abs(r.actual - r.p50) / r.p50 * 100))) < 1e-9, `${pool.pool_id}: MAPE`);
    assert.equal(pool.forecast.within_p80 + pool.forecast.above_p80, 4);
    assert.equal(pool.chart.history.length, 26);
    assert.equal(pool.chart.history.at(-1).week_start, '2026-09-21', 'the history ends where the lab was');
  }
  assert.equal(o.summary.readings, 24);
  assert.equal(o.summary.within_p80, o.pools.reduce((a, p) => a + p.forecast.within_p80, 0));
});

test('after two advances each week is held against the forecast made most recently before it, and the second forecast has seen the first actuals', () => {
  const store = freshStore();
  store.advanceTime(4); store.advanceTime(4);
  const o = buildOutcome(store);
  const eus = o.pools.find((p) => p.pool_id === P.eus);
  assert.deepEqual(eus.chart.rows.map((r) => r.made_at_week), [0, 0, 0, 0, 4, 4, 4, 4]);
  const [s0, s1] = store.state().ledger;
  assert.notEqual(s0.pools[P.eus].forecast.input_hash, s1.pools[P.eus].forecast.input_hash, 'refit on more history, so a different forecast');
  assert.equal(eus.chart.rows[4].p50, s1.pools[P.eus].forecast.p50[0], 'week 5 is the first week ahead of the second snapshot');
  assert.equal(eus.forecast.now_input_hash === s1.pools[P.eus].forecast.input_hash, false, 'the forecast has moved again since the second snapshot');
});

test('waiting has a cost: with nothing done for 8 weeks East US\'s order grows and lands later', () => {
  const store = freshStore();
  store.advanceTime(8);
  const o = buildOutcome(store);
  const eus = o.pools.find((p) => p.pool_id === P.eus);
  assert.deepEqual([eus.plan.then.state, eus.plan.then.quantity_cu, eus.plan.then.lands_on], ['OVERDUE', 4032, '2027-02-08']);
  assert.deepEqual([eus.plan.now.state, eus.plan.now.quantity_cu, eus.plan.now.lands_on], ['OVERDUE', 5184, '2027-04-05']);
  assert.equal(eus.plan.quantity_change_cu, 1152, 'three racks more to wait 8 weeks, of which one is REQ-1001 having gone live');
  assert.equal(eus.plan.lands_later_weeks, 8, 'eight weeks of waiting, eight weeks later');
  assert.equal(eus.plan.changed, true);
  assert.equal(store.data().requests.find((r) => r.request_id === 'REQ-1001').status, 'live', 'it fell due on 16 Nov, the last day of these 8 weeks');
  assert.equal(o.summary.plans_changed, 5, 'every pool but West Europe AMD, which had no order and still has none');
  const sea0 = o.pools.find((p) => p.pool_id === P.sea);
  assert.deepEqual([sea0.plan.then.state, sea0.plan.now.state, sea0.plan.quantity_change_cu], ['ORDER NOW', 'ORDER NOW', 0]);
  assert.equal(sea0.plan.changed, true, 'same state and size, but it now lands 8 weeks later and the pool gained the order that arrived');
  assert.equal(o.pools.find((p) => p.pool_id === P.weuAmd).plan.changed, false);
  assert.equal(o.summary.ordered_now_cu > o.summary.ordered_then_cu, true);
  const sea = o.pools.find((p) => p.pool_id === P.sea);
  assert.equal(sea.plan.capacity_added_cu, 384, 'the order that arrived shows as capacity');
});

test('a pool is read as close, above, below, or outside its band, by the average miss and by how often it broke p80', () => {
  assert.equal(readOf(0.6, 1, 8).read_key, 'close');
  assert.equal(readOf(0.6, 2, 8).read_key, 'close', 'two weeks in eight is a quarter, near the one in five that a p80 path should be exceeded');
  assert.equal(readOf(0.6, 3, 8).read_key, 'band', 'three in eight is more than a third: close on average, but the band was too narrow');
  assert.equal(readOf(-0.3, 3, 4).read_key, 'band');
  assert.equal(readOf(3.5, 0, 8).read_key, 'above');
  assert.equal(readOf(-3.5, 0, 8).read_key, 'below');
  assert.equal(readOf(3.5, 5, 8).read_key, 'above', 'a large average miss is said first');
  const o = buildOutcome(Object.assign(freshStore(), {}));
  assert.equal(o.pools.length, 0);
  const store = freshStore(); store.advanceTime(8);
  const eus = buildOutcome(store).pools.find((p) => p.pool_id === P.eus);
  assert.deepEqual([eus.forecast.read_key, eus.forecast.above_p80], ['band', 4], 'East US is under 1% off on average yet above the demand the plan counted in 4 of 8 weeks: it says so, instead of "close"');
  assert.ok(Math.abs(eus.forecast.bias_pct) <= 3);
  assert.deepEqual([eus.forecast.trend.read_key, eus.forecast.trend.above_p80], ['band', 3], 'the trend model alone, held against the trend part of the actuals, has its own reading');
});

test('supply and decisions in the outcome: what arrived, what slipped, and what became of an approved order', () => {
  const store = freshStore();
  const { order } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  store.advanceTime(8);
  const o = buildOutcome(store);
  assert.deepEqual(o.arrivals.map((a) => [a.order_id, a.slip_weeks, a.units_added]), [['ORD-2026-0440', 1, 384]]);
  const slipped = o.in_flight.find((x) => x.order_id === 'ORD-2026-0412');
  assert.deepEqual([slipped.planned_lands_on, slipped.lands_on, slipped.slip_weeks, slipped.slipped], ['2026-11-09', '2026-11-30', 3, true]);
  assert.equal(o.in_flight.find((x) => x.order_id === 'ORD-2026-0431').slipped, false, 'not due yet: still on plan');
  const d = o.decisions[0];
  assert.deepEqual([d.decision_id, d.order_id, d.quantity_cu, d.order_status], ['DEC-0001', order.order_id, 4032, 'ordered']);
  assert.equal(d.landed_on, null);
  assert.equal(o.pools.find((p) => p.pool_id === P.eus).plan.then.state, 'WATCH', 'the approved order had covered the need when the lab moved');
});

test('the comparison follows the lab: a new request after advancing is dated from the new "today"', () => {
  const store = freshStore();
  store.advanceTime(5);
  const { buildRequest } = require('../server/lib/requests');
  assert.throws(() => buildRequest(store, { pool_id: P.eus, team: 'ab', title: 'abc', cu: 10, needed_by: '2026-10-20' }), /before the dataset date 2026-10-26/);
  const req = buildRequest(store, { pool_id: P.weuAmd, team: 'contoso-test', title: 'After the move', cu: 300, needed_by: '2027-01-11' });
  assert.equal(req.submitted_on, '2026-10-26');
});
