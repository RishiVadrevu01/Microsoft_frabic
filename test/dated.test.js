'use strict';
/*
 * DATED DEMAND IN THE ACTUALS: requests, contracts and events that fall due become usage, or do not.
 *
 * The way to test a rule about "what an item adds" is to build the same world twice, once with the item and once without,
 * and compare: the difference is exactly what the item did, with the trend, the noise and every other item held equal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { P, DATA_DIR, freshStore } = require('./helpers');
const { loadRaw, indexData, clone, integrity } = require('../server/lib/data');
const { buildContext } = require('../server/lib/context');
const { assessPool } = require('../server/lib/verdict');
const { advance, datedDemand, UPTAKE, SEASONAL_REALIZED } = require('../server/lib/clock');
const { buildOutcome } = require('../server/lib/outcome');
const { buildRequester } = require('../server/lib/requester');
const { buildRequest } = require('../server/lib/requests');

const raw = loadRaw(DATA_DIR);
const world = (weeks, edit) => { const w = clone(raw); if (edit) edit(w); const report = advance(w, weeks); return { w, report, data: indexData(w) }; };
const readings = (w, poolId) => w.utilization.find((u) => u.pool_id === poolId).series.slice(52).map((p) => p.utilized_units);
const minus = (a, b) => a.map((x, i) => x - b[i]);
const zeros = (n) => new Array(n).fill(0);
const dropRequest = (id) => (w) => { w.requests = w.requests.filter((r) => r.request_id !== id); };
const dropContract = (id) => (w) => { w.contracts = w.contracts.filter((c) => c.contract_id !== id); };
const dropEvent = (id) => (w) => { w.events = w.events.filter((e) => e.event_id !== id); };
const itemOf = (id, pool) => datedDemand(clone(raw)).find((it) => it.id === id && (!pool || it.pool_id === pool));

// ---------------------------------------------------------------- what is decided, and that it is fixed
test('every shipped request, contract and event meets a fixed fate, and a settled item says what became of it', () => {
  const { report } = world(26);
  const got = Object.fromEntries(report.dated.map((d) => [d.id, [d.happened, d.realized_cu]]));
  assert.deepEqual(got, {
    'REQ-1001': [true, 466], 'REQ-1002': [false, 0], 'REQ-1003': [true, 275], 'REQ-1004': [false, 0], 'REQ-2001': [false, 0],
    'REQ-3001': [true, 267], 'REQ-4001': [true, 308], 'REQ-5001': [true, 217], 'REQ-6001': [false, 0],
    'CON-0101': [true, 296], 'CON-0203': [true, 914], 'CON-0304': [true, 186],
    'EVT-S02': [true, 1279], 'EVT-T02': [true, 214],
  });
  assert.equal(report.dated.length, 14, 'EVT-S01 (5 Apr 2027) and EVT-G01 (1 Aug 2027) have not fallen due within 26 weeks');
  const one = report.dated.find((d) => d.id === 'REQ-1001');
  assert.deepEqual([one.kind, one.pool_id, one.team, one.date, one.in_effect_on, one.asked_cu, one.plan_cu, one.realized_cu],
    ['request', P.eus, 'contoso-lakehouse', '2026-11-16', '2026-11-16', 480, 288, 466], 'the plan counted 480 x 0.8 x 0.75 = 288 of it; 466 showed up');
  const spike = report.dated.find((d) => d.id === 'EVT-S02');
  assert.deepEqual([spike.kind, spike.shape, spike.asked_cu, spike.plan_cu, spike.uplift_pct, spike.realized_uplift_pct], ['event', 'seasonal', null, null, 0.2, +(0.2 * itemOf('EVT-S02').factor).toFixed(4)], 'a spike is a rate, not a size');
  assert.equal(spike.realized_uplift_pct, 0.2028, 'this one came in slightly above the 20% it was planned at');
});

test('approved and completed requests are history: their usage is already in the readings, so they are never realized again', () => {
  const ids = datedDemand(clone(raw)).filter((it) => it.kind === 'request').map((it) => it.id);
  assert.deepEqual(ids.sort(), ['REQ-1001', 'REQ-1002', 'REQ-1003', 'REQ-1004', 'REQ-2001', 'REQ-3001', 'REQ-4001', 'REQ-5001', 'REQ-6001']);
  const { w } = world(26);
  for (const id of ['REQ-0801', 'REQ-0802', 'REQ-0803']) assert.deepEqual(w.requests.find((r) => r.request_id === id), raw.requests.find((r) => r.request_id === id), `${id} is untouched`);
});

test('the draws are fair: a request goes live about as often as it says, and how much shows up stays inside its range', () => {
  const w = clone(raw);
  w.requests = []; w.contracts = []; w.events = [];
  const N = 4000;
  for (let i = 0; i < N; i++) w.requests.push({ request_id: `REQ-T${i}`, team: 't', title: 't', pool_id: P.eus, cu: 1000, needed_by: '2026-11-16', win_probability: 0.3, source: 'sales-pipeline', priority: 'low', workload: 'general', status: 'pending' });
  for (let i = 0; i < 1000; i++) w.contracts.push({ contract_id: `CON-T${i}`, customer: 'c', pool_id: P.eus, committed_cu: 1500, provisioned_cu: 500, effective_date: '2026-11-16', term_months: 12, hard: true });
  const items = datedDemand(w);
  const reqs = items.filter((it) => it.kind === 'request');
  const live = reqs.filter((it) => it.happens).length / N;
  assert.ok(Math.abs(live - 0.3) < 0.03, `${live} is about 0.3`);
  for (const it of reqs) assert.ok(it.size >= 1000 * UPTAKE.request[0] - 1 && it.size <= 1000 * UPTAKE.request[1] + 1, `${it.size} is 60% to 100% of the ask`);
  const mean = reqs.reduce((a, it) => a + it.size, 0) / N;
  assert.ok(Math.abs(mean - 800) < 12, `the average request brings about 80% of its ask: ${mean}`);
  const cons = items.filter((it) => it.kind === 'contract');
  assert.ok(cons.every((it) => it.happens), 'a contract always takes effect');
  for (const it of cons) assert.ok(it.size >= 1000 * UPTAKE.contract[0] - 1 && it.size <= 1000 * UPTAKE.contract[1] + 1, `${it.size} is 70% to 100% of the 1,000 it had left to add`);
  const spike = itemOf('EVT-S02');
  assert.ok(spike.factor >= SEASONAL_REALIZED[0] && spike.factor <= SEASONAL_REALIZED[1]);
});

test('advancing 26 weeks and advancing 8 give the same first 8 weeks, dated demand included', () => {
  const eight = world(8); const all = world(26);
  for (const key of ['actuals', 'organic', 'dated_by_pool', 'unserved', 'capacity']) {
    for (const id of Object.keys(all.report[key])) assert.deepEqual(eight.report[key][id], all.report[key][id].slice(0, 8), `${key} / ${id}`);
  }
});

// ---------------------------------------------------------------- what each kind adds
test('a request that goes live adds exactly what showed up, in full, from the week it is needed and not before', () => {
  const a = world(12); const b = world(12, dropRequest('REQ-1001'));
  assert.deepEqual(minus(readings(a.w, P.eus), readings(b.w, P.eus)), [...zeros(7), 466, 466, 466, 466, 466], 'REQ-1001 is needed 16 Nov, the 8th reading');
  const rec = a.w.requests.find((r) => r.request_id === 'REQ-1001');
  assert.deepEqual([rec.status, rec.live_on, rec.realized_cu], ['live', '2026-11-16', 466]);
  for (const id of raw.pools.map((p) => p.pool_id).filter((id) => id !== P.eus)) {
    const x = minus(readings(a.w, id), readings(b.w, id));
    assert.deepEqual(x, zeros(12), `${id} is not affected by a request for East US`);
  }
});

test('a request that lapses changes nothing but its own status', () => {
  const a = world(16); const b = world(16, dropRequest('REQ-1002'));
  for (const p of raw.pools) assert.deepEqual(readings(a.w, p.pool_id), readings(b.w, p.pool_id), p.pool_id);
  const rec = a.w.requests.find((r) => r.request_id === 'REQ-1002');
  assert.deepEqual([rec.status, rec.lapsed_on, rec.live_on, rec.realized_cu], ['lapsed', '2027-01-11', undefined, undefined]);
});

test('a request still ahead of the clock is left pending', () => {
  const { w } = world(10);
  assert.equal(w.requests.find((r) => r.request_id === 'REQ-1003').status, 'pending', 'needed 14 Dec, the 12th week');
  assert.equal(w.requests.find((r) => r.request_id === 'REQ-5001').status, 'live', 'needed 30 Nov, the 10th week');
});

test('a contract that takes effect adds what it still had to add, from its effective date, and is then fully provisioned', () => {
  const a = world(16); const b = world(16, dropContract('CON-0101'));
  assert.deepEqual(minus(readings(a.w, P.eus), readings(b.w, P.eus)), [...zeros(14), 296, 296], 'effective 4 Jan, the 15th reading');
  const c = a.w.contracts.find((x) => x.contract_id === 'CON-0101');
  assert.deepEqual([c.provisioned_cu, c.committed_cu, c.realized_cu, c.in_effect_on], [2000, 2000, 296, '2027-01-04']);
  const trace = assessPool(a.data, P.eus).verdict.trace.find((t) => t.number === 12);
  assert.equal(trace.status, 'quiet', 'the contract funnel has nothing left to add for East US');
  const untouched = a.w.contracts.find((x) => x.contract_id === 'CON-0203');
  assert.equal(untouched.provisioned_cu, 400, 'a contract that has not taken effect is left alone');
});

test('a seasonal spike raises the pool only while it runs, by the uplift it really had', () => {
  const a = world(14); const b = world(14, dropEvent('EVT-S02'));
  const spike = itemOf('EVT-S02');
  const diff = minus(readings(a.w, P.weuAmd), readings(b.w, P.weuAmd));
  const expected = a.report.organic[P.weuAmd].map((trend, i) => (i + 1 === 12 || i + 1 === 13 ? Math.round(trend * 0.2 * spike.factor) : 0));
  assert.deepEqual(diff, expected, 'weeks 12 and 13 (14 and 21 Dec), nothing before or after');
  assert.ok(diff[11] > 1000 && diff[12] > 1000);
  assert.equal(world(12).report.dated.find((d) => d.id === 'EVT-S02').in_progress, true, 'still running at the end of week 12');
  assert.equal(world(13).report.dated.find((d) => d.id === 'EVT-S02').in_progress, false);
});

test('a demand step from an event adds its size from its date', () => {
  const a = world(20); const b = world(20, dropEvent('EVT-T02'));
  assert.deepEqual(minus(readings(a.w, P.brs), readings(b.w, P.brs)), [...zeros(18), 214, 214], 'Brazil South sovereign features GA, 1 Feb 2027, the 19th reading');
});

test('events that are not demand do not move usage', () => {
  const a = world(26); const b = world(26, (w) => { w.events = w.events.filter((e) => e.signal === 'seasonal' || e.effect === 'demand' || e.effect === 'relocate-in'); });
  for (const p of raw.pools) assert.deepEqual(readings(a.w, p.pool_id), readings(b.w, p.pool_id), `${p.pool_id}: a new SKU, a market shift and a competitor's price cut are not usage`);
});

// ---------------------------------------------------------------- nothing is counted twice
test('once settled, an item leaves what is still to come: the pipeline, the contract step and the event step', () => {
  const seed = indexData(clone(raw));
  const a = world(8);
  assert.equal(buildContext(seed, P.eus).pipelineAt(52), 1249.5, '288 + 144 + 577.5 + 240, each at its likelihood less the overlap discount');
  assert.equal(buildContext(a.data, P.eus).pipelineAt(52), 961.5, 'REQ-1001 (288) has left the pipeline: it is in the readings now');

  const late = world(26);
  assert.equal(buildContext(seed, P.brs).knownAddsAt(52), 250 + 900, 'a sized launch and a mandated relocation');
  assert.equal(buildContext(late.data, P.brs).knownAddsAt(52), 900, 'the launch has happened; the relocation is still to come');
  for (const r of late.w.requests.filter((x) => x.status === 'pending')) assert.ok(r.needed_by > late.w.as_of, `${r.request_id} is still ahead of the clock`);
  for (const c of late.w.contracts) assert.ok(c.effective_date > late.w.as_of ? c.provisioned_cu < c.committed_cu : c.provisioned_cu === c.committed_cu, c.contract_id);
});

// What the forecast makes of a step that has happened is tested in shifts.test.js. Here: it still moves the plan, by what the
// step is worth, and no more.
test('a step that has happened still moves the plan by what it is worth: East US at 8 weeks needs one rack more with REQ-1001 live', () => {
  const size = (edit) => { const x = world(8, edit); return assessPool(x.data, P.eus).verdict.order.quantity_cu; };
  const withIt = size();
  const without = size((w) => { w.requests.find((r) => r.request_id === 'REQ-1001').win_probability = 0.05; });
  assert.equal(itemOf('REQ-1001').happens, true);
  assert.deepEqual([withIt, without], [5184, 4800]);
  assert.equal(withIt - without, 384, 'one rack of 384 CU for a 466 CU step, not the 1,920 CU that reading it as faster growth added');
});

// ---------------------------------------------------------------- the teams, the pool's limit, the past
test('a team whose request went live holds and uses what it asked for; a team with no reservation gets one', () => {
  const { w } = world(12);
  const lake = w.allocations.find((a) => a.pool_id === P.eus && a.reserved_by === 'contoso-lakehouse');
  const before = raw.allocations.find((a) => a.pool_id === P.eus && a.reserved_by === 'contoso-lakehouse');
  assert.ok(lake.utilized_units >= 466 + 1000, `it uses its own trend share plus the 466 that went live: ${lake.utilized_units}`);
  assert.ok(lake.allocated_units >= before.allocated_units && lake.allocated_units >= lake.utilized_units - 1, 'what it uses is reserved for it, as far as the pool has room');
  const newcomer = w.allocations.find((a) => a.pool_id === P.sea && a.reserved_by === 'adatum-onboarding');
  assert.ok(newcomer, 'REQ-4001 has no reservation in Southeast Asia, so it gets one');
  assert.deepEqual([newcomer.utilized_units, newcomer.allocated_units, newcomer.low_use_weeks], [308, 308, 0]);
  assert.deepEqual(integrity(w), [], 'and the reservations still add up to the latest reading');
});

test('a pool cannot use more than has landed: the reading stops at its capacity, the rest is reported as unserved, and a landed order lifts it', () => {
  const edit = (w) => {
    w.requests.push({ request_id: 'REQ-BIG', team: 'big-team', title: 'Too big', pool_id: P.jpe, cu: 20000, needed_by: '2026-10-05', win_probability: 1, source: 'sales-pipeline', priority: 'high', workload: 'general', status: 'pending', submitted_on: '2026-09-21' });
    w.supply.push({ order_id: 'ORD-T1', pool_id: P.jpe, sku_id: w.pools.find((p) => p.pool_id === P.jpe).sku_id, cu: 480, placed_on: '2026-09-21', lands_on: '2026-10-19', status: 'ordered' });
  };
  const { w, report } = world(10, edit);
  const landed = report.arrivals.find((a) => a.order_id === 'ORD-T1');
  const cap0 = raw.pools.find((p) => p.pool_id === P.jpe).capacity_units;
  const landedWeek = Math.round((Date.parse(landed.landed_on) - Date.parse('2026-09-21')) / 604800000);
  const r = readings(w, P.jpe);
  assert.equal(r[0], report.actuals[P.jpe][0].utilized_units);
  r.forEach((x, i) => {
    const cap = report.capacity[P.jpe][i];
    assert.equal(cap, i + 1 >= landedWeek ? cap0 + landed.units_added : cap0, `week ${i + 1}: capacity steps up on the week the order lands (${landed.landed_on})`);
    if (i + 1 >= 2) assert.equal(x, cap, `week ${i + 1}: the pool is full, so the reading is its capacity`);
  });
  assert.ok(report.unserved[P.jpe].slice(1).every((x) => x > 0), 'demand was turned away every week after week 1');
  assert.equal(report.unserved[P.jpe][0], 0);
  assert.ok(report.unserved[P.jpe][9] < report.unserved[P.jpe][2], 'and less once the order landed');
  assert.deepEqual(integrity(w), []);
  const alloc = w.allocations.filter((a) => a.pool_id === P.jpe);
  assert.ok(alloc.reduce((a, x) => a + x.allocated_units, 0) <= w.pools.find((p) => p.pool_id === P.jpe).capacity_units, 'the pool never promises more than it has');
  assert.equal(alloc.find((a) => a.reserved_by === 'big-team').utilized_units > 0, true);
});

test('a request made after the lab moved never rewrites a week that has been lived: it counts from the next reading', () => {
  const store = freshStore();
  store.advanceTime(5);
  const before = readings({ utilization: store.data().utilization }, P.jpe);
  const req = buildRequest(store, { pool_id: P.jpe, team: 'late-team', title: 'Needed today', cu: 300, needed_by: store.data().as_of, win_probability: 1 });
  assert.equal(req.needed_by, '2026-10-26');
  store.addRequest(req);
  assert.deepEqual(readings({ utilization: store.data().utilization }, P.jpe), before, 'the five weeks already lived are exactly as they were');
  assert.equal(store.data().requests.find((r) => r.request_id === req.request_id).status, 'pending', 'and it is still pending: nothing has fallen due');
  store.advanceTime(1);
  const rec = store.data().requests.find((r) => r.request_id === req.request_id);
  assert.deepEqual([rec.status, rec.live_on, rec.realized_cu >= 180 && rec.realized_cu <= 300], ['live', '2026-11-02', true], 'needed on the day it was made, it is live from the first reading after');
  const after = readings({ utilization: store.data().utilization }, P.jpe);
  assert.deepEqual(after.slice(0, 5), before);
});

test('a scenario cannot change what has already happened, and nothing is left half applied', () => {
  const store = freshStore();
  store.advanceTime(9);
  assert.doesNotThrow(() => store.applyScenario('quota-surge-eastus'), 'its first request is due in week 10: still ahead');
  assert.ok(store.state().scenarios.includes('quota-surge-eastus'));
  store.advanceTime(1);

  const other = freshStore();
  other.advanceTime(10);
  assert.throws(() => other.applyScenario('quota-surge-eastus'), (e) => e.status === 409 && /would change what has already happened/.test(e.message), 'REQ-9001 falls due in week 10, which has been lived');
  assert.deepEqual(other.state().scenarios, [], 'the scenario was not kept');
  assert.equal(other.data().as_of, '2026-11-30');
  assert.equal(other.data().requests.some((r) => r.request_id === 'REQ-9001'), false);
  assert.doesNotThrow(() => other.applyScenario('contract-pulled-forward-weu-gpu'), 'the contract moves to 7 Dec, week 11: still ahead of a lab at week 10');

  const eleven = freshStore();
  eleven.advanceTime(11);
  assert.throws(() => eleven.applyScenario('contract-pulled-forward-weu-gpu'), /would change what has already happened/, 'but a lab at week 11 has lived through 7 Dec');

  const later = freshStore();
  later.advanceTime(26);
  for (const id of ['incident-storm-weu', 'reclaim-sweep-weu']) assert.doesNotThrow(() => later.applyScenario(id), `${id} changes today, not the past`);
});

// ---------------------------------------------------------------- what the outcome says about it
test('the outcome sets what the plan counted against what showed up, and tells the trend model apart from the plan', () => {
  const store = freshStore();
  store.advanceTime(26);
  const o = buildOutcome(store);
  assert.equal(o.dated.length, 14);
  assert.deepEqual(o.dated.map((d) => d.in_effect_on), [...o.dated.map((d) => d.in_effect_on)].sort(), 'in the order they fell due');
  assert.deepEqual(o.dated.find((d) => d.id === 'REQ-1001').region, 'East US');
  assert.deepEqual(o.summary.dated, { fell_due: 14, happened: 10, did_not: 4, requests: 9, requests_live: 5, plan_cu: 3969, asked_cu: 6140, realized_cu: 3143 });
  assert.deepEqual([o.summary.unserved_cu_weeks, o.summary.pools_full], [66, 1]);
  const eus = o.pools.find((p) => p.pool_id === P.eus);
  assert.deepEqual([eus.unserved.weeks, eus.unserved.peak_cu, eus.unserved.cu_weeks], [1, 66, 66], 'East US ran full for one week and turned 66 CU away');
  assert.deepEqual(eus.dated.map((d) => d.id).sort(), ['CON-0101', 'REQ-1001', 'REQ-1002', 'REQ-1003', 'REQ-1004']);
  for (const p of o.pools) for (const r of p.chart.rows) {
    assert.equal(r.trend.actual - r.trend.known_cu + r.dated_cu - r.unserved_cu, r.actual, `${p.pool_id} week ${r.week}: the actual is the trend, plus what fell due, less what could not be served (the steps already in the plan's history are part of the trend it is held to)`);
    if (r.unserved_cu > 0) assert.equal(r.actual, r.capacity, 'a full pool reads its capacity');
  }
  assert.ok(o.summary.mape_pct > o.summary.trend_mape_pct, 'the plan was further off than the trend alone: it guessed about requests');
  const brs = o.pools.find((p) => p.pool_id === P.brs);
  assert.deepEqual([brs.forecast.read_key, brs.forecast.trend.read_key], ['close', 'band'], 'the plan counted the launch that happened; the trend model alone did not know about it');
});

test('the Product Team view understands a request that went live and one that did not go ahead', () => {
  const store = freshStore();
  store.advanceTime(26);
  const all = buildRequester(store, { org: 'contoso' });
  for (const o of all.filters.options.orgs) for (const r of buildRequester(store, { org: o.key }).filters.options.requests) {
    assert.doesNotThrow(() => buildRequester(store, { org: o.key, request: r.request_id }), `${o.key} / ${r.request_id}`);
  }
  const counts = all.requests.counts;
  assert.deepEqual([counts.live, counts.lapsed, counts.approved, counts.completed, counts.at_risk + counts.in_review], [4, 3, 2, 1, 0], 'nothing is left pending for this org after 26 weeks');
  const live = buildRequester(store, { org: 'contoso', request: 'REQ-1001' });
  assert.equal(live.recommendation.state, 'live');
  assert.equal(live.recommendation.headline, 'Live since 16 Nov 2026: 466 CU of the 480 CU asked for is in use in East US.');
  assert.equal(live.kpis.request_status.note, 'In use since 16 Nov 2026');
  assert.deepEqual(live.timeline.map((e) => e.key), ['submitted', 'live']);
  assert.equal(live.requests.rows.find((r) => r.request_id === 'REQ-1001').recommended.label, 'In use');
  const lapsed = buildRequester(store, { org: 'contoso', request: 'REQ-1002' });
  assert.equal(lapsed.recommendation.headline, 'Did not go ahead: the 11 Jan 2027 need date passed and the 1,100 CU was never used.');
  assert.equal(lapsed.requests.rows.find((r) => r.request_id === 'REQ-1002').status_label, 'Did not go ahead');
  assert.equal(lapsed.timeline.at(-1).state, 'risk');
});
