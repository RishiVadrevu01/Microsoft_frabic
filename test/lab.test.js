'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { P, freshStore } = require('./helpers');
const { decide, verifyChain, stats } = require('../server/lib/decisions');
const { buildRequest, assessRequests } = require('../server/lib/requests');
const { buildLab, checkLab } = require('../server/lib/lab');
const { conversion } = require('../server/lib/conversion');
const scenarios = require('../server/lib/scenarios');

const byPool = (store) => Object.fromEntries(store.verdicts().map((v) => [v.pool_id, v]));

// ---------------------------------------------------------------- scenarios
test('every scenario changes the plan the way its description says', () => {
  const base = byPool(freshStore());

  const s1 = freshStore(); s1.applyScenario('quota-surge-eastus');
  assert.ok(byPool(s1)[P.eus].order.quantity_cu > base[P.eus].order.quantity_cu);

  const s2 = freshStore(); s2.applyScenario('incident-storm-weu');
  assert.equal(base[P.weuAmd].state, 'OK');
  assert.notEqual(byPool(s2)[P.weuAmd].state, 'OK');
  assert.equal(byPool(s2)[P.weuAmd].driver.id, 'reliability');
  assert.equal(byPool(s2)[P.weuAmd].capacity.free_now, base[P.weuAmd].capacity.free_now);

  const s3 = freshStore(); s3.applyScenario('vendor-delay-amd');
  assert.ok(byPool(s3)[P.sea].lead.weeks > base[P.sea].lead.weeks);
  assert.ok(byPool(s3)[P.eus].lead.weeks > base[P.eus].lead.weeks);

  const s4 = freshStore(); s4.applyScenario('contract-pulled-forward-weu-gpu');
  assert.equal(base[P.weuGpu].state, 'ORDER NOW');
  assert.equal(byPool(s4)[P.weuGpu].state, 'OVERDUE');
  assert.equal(byPool(s4)[P.weuGpu].driver.id, 'customer-contract');
  assert.ok(byPool(s4)[P.weuGpu].order.quantity_cu > base[P.weuGpu].order.quantity_cu);

  const s5 = freshStore(); s5.applyScenario('launch-spike-japan');
  const comp = (vv) => vv.order.components.find((c) => /Temporary buffer/.test(c.label)).value;
  assert.ok(comp(byPool(s5)[P.jpe]) > comp(base[P.jpe]));

  const s6 = freshStore(); s6.applyScenario('reclaim-sweep-weu');
  assert.ok(base[P.weuAmd].reclaim.cu > 0);
  assert.equal(byPool(s6)[P.weuAmd].reclaim.cu, 0);
  assert.ok(byPool(s6)[P.weuAmd].capacity.free_now > base[P.weuAmd].capacity.free_now);
});

test('every listed scenario is registered and applies cleanly', () => {
  for (const s of scenarios.list()) {
    const store = freshStore();
    store.applyScenario(s.id);
    assert.deepEqual(store.state().scenarios, [s.id]);
  }
});

test('applying a scenario twice is refused, and an unknown one is a 404', () => {
  const store = freshStore();
  store.applyScenario('quota-surge-eastus');
  assert.throws(() => store.applyScenario('quota-surge-eastus'), (e) => e.status === 409);
  assert.throws(() => store.applyScenario('nope'), (e) => e.status === 404);
});

test('reset returns to the exact baseline and never touches the seed', () => {
  const store = freshStore();
  const before = JSON.stringify(store.verdicts());
  store.applyScenario('quota-surge-eastus');
  store.applyScenario('incident-storm-weu');
  assert.notEqual(JSON.stringify(store.verdicts()), before);
  store.reset();
  assert.equal(JSON.stringify(store.verdicts()), before);
  assert.equal(JSON.stringify(freshStore().verdicts()), before);
});

// ---------------------------------------------------------------- requests
test('the request waterfall never hands out more than exists', () => {
  const store = freshStore();
  for (const a of store.all()) {
    const rows = assessRequests(a.ctx, a.verdict);
    assert.ok(rows.reduce((s, r) => s + r.from_free, 0) <= a.ctx.freeNow + 1e-9);
    assert.ok(rows.reduce((s, r) => s + r.from_reclaim, 0) <= a.verdict.reclaim.cu + 1e-9);
    for (const r of rows) assert.equal(r.from_free + r.from_reclaim + r.from_in_flight + r.needs_order, r.cu);
  }
});

test('East US: free capacity goes first, then reclaim, then in-flight, then a new order', () => {
  const store = freshStore();
  const a = store.assessment(P.eus);
  const rows = assessRequests(a.ctx, a.verdict);
  assert.equal(rows[0].from_free, a.ctx.freeNow);
  assert.ok(rows.some((r) => r.fit === 'reclaim'));
  assert.ok(rows.some((r) => r.fit === 'in-flight'));
  assert.ok(rows.some((r) => r.fit === 'order' && r.plan_timing));
});

test('submitting a request adds demand and changes the plan; bad input is refused with a reason', () => {
  const store = freshStore();
  const req = buildRequest(store, { pool_id: P.weuAmd, team: 'contoso-test', title: 'Big warehouse', cu: 9000, needed_by: '2026-12-01', priority: 'high' });
  assert.match(req.request_id, /^REQ-7001$/);
  const { before, after } = store.addRequest(req);
  const b = before.find((v) => v.pool_id === P.weuAmd);
  const c = after.find((v) => v.pool_id === P.weuAmd);
  assert.equal(b.order.needed, false);
  assert.equal(c.order.needed, true);

  const bad = (body, re) => assert.throws(() => buildRequest(store, { pool_id: P.eus, team: 'ab', title: 'abc', cu: 10, needed_by: '2027-01-01', ...body }), re);
  bad({ pool_id: 'pool-x' }, /pool_id must be/);
  bad({ cu: 0 }, /cu must be a whole number/);
  bad({ cu: 1.5 }, /cu must be a whole number/);
  bad({ needed_by: '2026-01-01' }, /before the dataset date/);
  bad({ needed_by: 'soon' }, /YYYY-MM-DD/);
  bad({ needed_by: '2031-01-01' }, /24-month/);
  bad({ priority: 'urgent' }, /priority must be/);
  bad({ team: '' }, /team must be/);
  bad({ win_probability: 5 }, /win_probability/);
});

// ---------------------------------------------------------------- decisions
test('the engine cannot approve its own plan; an unnamed decider is refused', () => {
  const store = freshStore();
  assert.throws(() => decide(store, P.eus, { decision: 'approve', decided_by: 'engine' }), /cannot approve it/);
  assert.throws(() => decide(store, P.eus, { decision: 'approve', decided_by: 'Planner-Engine' }), /cannot approve it/);
  assert.throws(() => decide(store, P.eus, { decision: 'approve', decided_by: '' }), /name of the person/);
  assert.equal(store.state().decisions.length, 0);
});

test('approving as drafted places the order and the plan then shows it in flight', () => {
  const store = freshStore();
  const before = store.assessment(P.eus).verdict;
  const { record, order } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  assert.equal(record.decision, 'approve');
  assert.equal(record.quantity_cu, before.order.quantity_cu);
  assert.equal(record.override, false);
  assert.equal(order.status, 'approved-not-placed');
  assert.equal(order.lands_on, before.dates.lands_on);
  const after = store.assessment(P.eus).verdict;
  assert.equal(after.order.needed, false, 'the approved order should cover the need');
  assert.ok(after.order.in_flight.some((o) => o.order_id === order.order_id));
});

test('a changed quantity needs a reason and must be whole racks; a smaller order leaves a residual need', () => {
  const store = freshStore();
  const drafted = store.assessment(P.eus).verdict.order.quantity_cu;
  assert.throws(() => decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: drafted - 192 }), /Say why/);
  assert.throws(() => decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: drafted - 100, reason: 'budget cap' }), /multiple of 192/);
  assert.throws(() => decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: -192, reason: 'budget cap' }), /positive whole number/);
  const { record } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: drafted - 192 * 5, reason: 'budget cap for this quarter' });
  assert.equal(record.override, true);
  const after = store.assessment(P.eus).verdict;
  assert.equal(after.order.needed, true, 'a smaller order should leave part of the need');
  assert.ok(after.order.quantity_cu < drafted);
});

test('declining or deferring needs a reason and may name a disputed funnel that is really flagged', () => {
  const store = freshStore();
  assert.throws(() => decide(store, P.eus, { decision: 'decline', decided_by: 'Asha Rao' }), /reason is needed/);
  assert.throws(() => decide(store, P.eus, { decision: 'decline', decided_by: 'Asha Rao', reason: 'forecast too high', disputed_funnel: 'competitive' }), /must be one of the funnels flagged/);
  const { record } = decide(store, P.eus, { decision: 'decline', decided_by: 'Asha Rao', reason: 'forecast too high', disputed_funnel: 'demand' });
  assert.equal(record.disputed_funnel, 'demand');
  assert.equal(store.state().orders.length, 0, 'declining places no order');
  assert.equal(stats(store.state().decisions).disputed_funnels[0].funnel, 'demand');
});

test('there is nothing to decide on a pool with no open order; unknown values are refused', () => {
  const store = freshStore();
  assert.throws(() => decide(store, P.weuAmd, { decision: 'approve', decided_by: 'Asha Rao' }), (e) => e.status === 409);
  assert.throws(() => decide(store, P.eus, { decision: 'maybe', decided_by: 'Asha Rao' }), /decision must be one of/);
  assert.throws(() => decide(store, 'pool-x', { decision: 'approve', decided_by: 'Asha Rao' }), (e) => e.status === 404);
});

test('the decision log is hash-chained and any edit is detected', () => {
  const store = freshStore();
  decide(store, P.eus, { decision: 'decline', decided_by: 'Asha Rao', reason: 'not this quarter' });
  decide(store, P.sea, { decision: 'defer', decided_by: 'Asha Rao', reason: 'wait for the vendor quote' });
  const log = store.state().decisions;
  assert.deepEqual(verifyChain(log), { ok: true, records: 2 });
  assert.equal(log[1].prev_hash, log[0].hash);
  const tampered = JSON.parse(JSON.stringify(log));
  tampered[0].reason = 'edited afterwards';
  assert.equal(verifyChain(tampered).ok, false);
});

// ---------------------------------------------------------------- conversion
test('conversion: a rack-for-rack swap gains capacity; buying M/ratio keeps it constant', () => {
  const store = freshStore();
  const c = conversion(store, { pool_id: P.eus, ratio: 1.35, swap_units: 1920 });
  assert.equal(c.to_sku, 'FAB-AMD-GENOA-96');
  assert.ok(Math.abs(c.capacity_gain_cu - 1920 * 0.35) < 1e-9);
  assert.ok(c.post.headroom > c.pre.headroom);
  assert.ok(Math.abs(c.neutral.new_units - 1920 / 1.35) < 1e-9);
  assert.throws(() => conversion(store, { pool_id: P.eus, ratio: 9 }), /ratio must be/);
  assert.throws(() => conversion(store, { pool_id: P.weuGpu, swap_units: 10 }), (e) => e.status === 400 && /no successor/.test(e.message));
  assert.throws(() => conversion(store, { pool_id: P.eus, swap_units: 0 }), /swap_units must be/);
});

// ---------------------------------------------------------------- lab guide
test('the lab has seven exercises whose expected values come from the engine', () => {
  const lab = buildLab(freshStore());
  assert.equal(lab.exercises.length, 7);
  assert.deepEqual(lab.exercises.map((e) => e.level), ['Crawl', 'Crawl', 'Walk', 'Walk', 'Walk', 'Run', 'Run']);
  assert.match(lab.exercises[0].expect, /No\. 1 of 6 pools/);
  assert.equal(lab.progress.done, 0);
  assert.equal(lab.scenarios.length, 6);
});

test('lab 1: the right answer passes and is remembered; the wrong one gets a hint', () => {
  const store = freshStore();
  const wrong = checkLab(store, 'lab-1', { choice: P.weuAmd });
  assert.equal(wrong.passed, false);
  assert.equal(buildLab(store).progress.done, 0);
  const right = checkLab(store, 'lab-1', { choice: P.eus });
  assert.equal(right.passed, true);
  assert.equal(buildLab(store).progress.done, 1);
});

test('lab 2 and 3 answers are computed from the live engine', () => {
  const store = freshStore();
  assert.equal(checkLab(store, 'lab-2', { choice: 'demand' }).passed, true);
  assert.equal(checkLab(store, 'lab-2', { choice: 'security-compliance' }).passed, false);
  assert.equal(checkLab(store, 'lab-3', { choice: 'PLAN' }).passed, true);
  assert.equal(checkLab(store, 'lab-3', { choice: 'OVERDUE' }).passed, false);
});

test('labs 4 to 7 verify what the person actually did', () => {
  const store = freshStore();
  assert.equal(checkLab(store, 'lab-4', {}).passed, false);
  store.applyScenario('quota-surge-eastus');
  assert.equal(checkLab(store, 'lab-4', {}).passed, true);

  assert.equal(checkLab(store, 'lab-5', {}).passed, false);
  store.applyScenario('incident-storm-weu');
  assert.equal(checkLab(store, 'lab-5', {}).passed, true);

  assert.equal(checkLab(store, 'lab-6', {}).passed, false);
  const drafted = store.assessment(P.eus).verdict.order.quantity_cu;
  decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: drafted - 192, reason: 'phase the order' });
  assert.equal(checkLab(store, 'lab-6', {}).passed, true);

  assert.equal(checkLab(store, 'lab-7', {}).passed, false);
  store.reset();
  assert.equal(checkLab(store, 'lab-7', {}).passed, true);
  assert.equal(buildLab(store).progress.done, 4, 'progress survives a data reset');
  store.reset({ progress: true });
  assert.equal(buildLab(store).progress.done, 0);
});

test('an unknown exercise is a 404', () => {
  assert.throws(() => checkLab(freshStore(), 'lab-99', {}), (e) => e.status === 404);
});
