'use strict';
/*
 * Governance on an approval (approval.js, decisions.js): a budget that asks for a reason, and a second, different named
 * person for a large order. The lab has no sign-in: "different" means a different typed name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { P, freshStore } = require('./helpers');
const { decide, verifyChain, stats } = require('../server/lib/decisions');
const { approvalCheck, budgetOf, pendingApproval } = require('../server/lib/approval');
const { latestByPool } = require('../server/lib/ledger');

const asha = (extra) => ({ decision: 'approve', decided_by: 'Asha Rao', ...extra });
const ben = (extra) => ({ decision: 'approve', decided_by: 'Ben Ortiz', ...extra });
const refuses = (fn, status, re) => assert.throws(fn, (e) => e.status === status && re.test(e.message), `expected ${status} ${re}`);

test('the policy carries a synthetic budget and a threshold, and says so', () => {
  const a = freshStore().data().policy.approval;
  assert.deepEqual([a.budget_usd, a.second_approver_above_usd], [8000000, 1500000]);
  assert.match(a.budget_label, /synthetic/);
});

test('the check answers before the decision: cost, whether a second person is needed, and what the budget would be', () => {
  const store = freshStore();
  const c = approvalCheck(store, P.eus, null);
  assert.equal(c.quantity_cu, 4032);
  assert.equal(c.cost_usd, store.assessment(P.eus).verdict.order.cost_usd, 'the drafted cost is the plan\'s own');
  assert.equal(c.needs_second_approver, false, 'East US at $1.25M is under the $1.5M threshold');
  assert.deepEqual([c.budget.budget_usd, c.budget.committed_usd, c.budget.remaining_usd, c.budget.over_budget_usd], [8000000, 0, 8000000, 0]);
  assert.match(c.notes[0], /\$0 of the \$8\.00M budget is committed; this order would leave \$6\.75M/);
  assert.match(c.caveat, /no sign-in/);

  const h100 = approvalCheck(store, P.weuGpu, null);
  assert.equal(h100.needs_second_approver, true, '$5.64M is above the threshold');
  assert.match(h100.notes[0], /above \$1\.50M, so a second, different named person has to countersign it/);
  assert.equal(approvalCheck(store, P.eus, 3840).cost_usd, 3840 * store.assessment(P.eus).verdict.what.unit_cost_usd, 'a changed quantity is priced');
});

test('the check refuses a quantity that is not whole racks, like the decision does', () => {
  const store = freshStore();
  refuses(() => approvalCheck(store, P.eus, 100), 400, /multiple of 192/);
  refuses(() => approvalCheck(store, P.eus, -192), 400, /positive whole number/);
  refuses(() => approvalCheck(store, P.eus, 'lots'), 400, /positive whole number/);
});

test('an order under the threshold is approved by one person and placed at once, as before', () => {
  const store = freshStore();
  const { record, order } = decide(store, P.eus, asha());
  assert.equal(record.approval.state, 'complete');
  assert.equal(record.approval.required, 1);
  assert.ok(order && order.order_id === record.order_id);
  assert.equal(record.cost_usd, 1249920);
  assert.equal(record.budget.over_budget_usd, 0);
  assert.equal(store.assessment(P.eus).verdict.order.needed, false, 'the order covers the need');
});

test('an order over the threshold waits for a second, different named person, and places nothing until then', () => {
  const store = freshStore();
  const before = store.assessment(P.weuGpu).verdict;
  const { record, order } = decide(store, P.weuGpu, asha());
  assert.equal(order, null, 'no order yet');
  assert.equal(record.order_id, undefined);
  assert.deepEqual([record.approval.required, record.approval.state], [2, 'awaiting-second']);
  assert.match(record.approval.reason, /An order of \$5\.64M is above \$1\.50M/);
  assert.equal(store.state().orders.length, 0);
  assert.equal(store.assessment(P.weuGpu).verdict.order.needed, before.order.needed, 'the plan still shows the need');
  assert.equal(store.assessment(P.weuGpu).verdict.state, before.state);

  const pending = pendingApproval(store.state().decisions, P.weuGpu);
  assert.equal(pending.decision_id, record.decision_id);
  assert.equal(budgetOf(store).committed_usd, 0, 'nothing is committed until it is countersigned');
  assert.equal(budgetOf(store).pending_usd, before.order.cost_usd);
  assert.equal(approvalCheck(store, P.weuGpu, null).pending.decided_by, 'Asha Rao');
  assert.match(approvalCheck(store, P.weuGpu, null).notes[0], /Asha Rao approved 1,344 CU \(\$5\.64M\) on 21 Sep 2026 and it is waiting for a second, different named person/);
  assert.equal(latestByPool(store.state().decisions)[P.weuGpu].approval_state, 'awaiting-second');
});

test('while an approval waits, the question is about that approval, not the drafted quantity', () => {
  const store = freshStore();
  decide(store, P.weuGpu, asha({ quantity_cu: 960, reason: 'Phase the order to fit the quarter' }));
  const c = approvalCheck(store, P.weuGpu, null);
  assert.equal(c.quantity_cu, 960, 'not the drafted 1,344');
  assert.equal(c.cost_usd, 960 * store.assessment(P.weuGpu).verdict.what.unit_cost_usd);
  assert.equal(c.pending.quantity_cu, 960);
  assert.equal(approvalCheck(store, P.weuGpu, 1344).quantity_cu, 1344, 'an explicit quantity is still priced as asked');
});

test('the second person must be someone else, and must agree to the quantity that was approved', () => {
  const store = freshStore();
  decide(store, P.weuGpu, asha());
  refuses(() => decide(store, P.weuGpu, asha()), 400, /Asha Rao gave the first approval\. A different named person has to countersign it/);
  refuses(() => decide(store, P.weuGpu, { decision: 'approve', decided_by: 'ASHA RAO' }), 400, /different named person/, 'a different spelling of the same name is the same name');
  refuses(() => decide(store, P.weuGpu, { decision: 'approve', decided_by: 'engine' }), 400, /cannot approve it/);
  refuses(() => decide(store, P.weuGpu, ben({ quantity_cu: 960, reason: 'smaller please' })), 409, /An approval of 1,344 CU is waiting for a second person\. Countersign that quantity, or decline it and start again/);
  assert.equal(store.state().decisions.length, 1, 'none of those left a record');
  assert.equal(store.state().orders.length, 0);
});

test('countersigning places the order for the approved quantity, records who did what, and keeps the chain', () => {
  const store = freshStore();
  const first = decide(store, P.weuGpu, asha({ quantity_cu: 960, reason: 'Phase the order to fit the quarter' })).record;
  assert.equal(first.approval.state, 'awaiting-second');
  const { record, order } = decide(store, P.weuGpu, ben());
  assert.equal(record.countersigns, first.decision_id);
  assert.deepEqual([record.approval.state, record.approval.first_by, record.approval.first_decision], ['complete', 'Asha Rao', first.decision_id]);
  assert.equal(record.quantity_cu, 960, 'the quantity the first person approved');
  assert.equal(record.override, true, 'and it is still a changed quantity, with its reason on the first record');
  assert.equal(order.cu, 960);
  assert.equal(record.order_id, order.order_id);
  assert.equal(pendingApproval(store.state().decisions, P.weuGpu), null);
  assert.deepEqual(budgetOf(store).waiting, []);
  assert.equal(budgetOf(store).committed_usd, record.cost_usd);
  assert.deepEqual(verifyChain(store.state().decisions), { ok: true, records: 2 });
  assert.equal(store.assessment(P.weuGpu).verdict.order.in_flight.some((o) => o.order_id === order.order_id), true);
});

test('declining or deferring withdraws a waiting approval', () => {
  for (const decision of ['decline', 'defer']) {
    const store = freshStore();
    const first = decide(store, P.weuGpu, asha()).record;
    refuses(() => decide(store, P.weuGpu, { decision, decided_by: 'Ben Ortiz' }), 400, /A reason is needed/);
    const { record } = decide(store, P.weuGpu, { decision, decided_by: 'Ben Ortiz', reason: 'Wait for the vendor quote' });
    assert.equal(record.cancels, first.decision_id);
    assert.equal(pendingApproval(store.state().decisions, P.weuGpu), null, decision);
    assert.equal(budgetOf(store).pending_usd, 0);
    // a fresh approval can start again
    assert.equal(decide(store, P.weuGpu, asha()).record.approval.state, 'awaiting-second');
  }
});

test('an approval waiting for a second person is not counted as approved, and is counted once when it is countersigned', () => {
  const store = freshStore();
  decide(store, P.weuGpu, asha());
  let s = stats(store.state().decisions);
  assert.deepEqual([s.total, s.approved, s.awaiting_second, s.approved_cu, s.approved_cost_usd], [1, 0, 1, 0, 0]);
  decide(store, P.weuGpu, ben());
  s = stats(store.state().decisions);
  assert.deepEqual([s.total, s.approved, s.awaiting_second, s.approved_cu], [2, 1, 0, 1344], 'two records, one approval');
  assert.equal(s.approved_cost_usd, store.state().decisions[1].cost_usd);
});

test('going over the budget needs a reason, is allowed with one, and is on the record', () => {
  const store = freshStore();
  decide(store, P.eus, asha());                                                           // $1.25M committed
  decide(store, P.weuGpu, asha()); decide(store, P.weuGpu, ben());                        // + $5.64M = $6.89M
  const c = approvalCheck(store, P.jpe, null);
  assert.equal(c.cost_usd, 3499200);
  assert.equal(Math.round(c.budget.committed_usd), 6894720);
  assert.equal(Math.round(c.budget.over_budget_usd), 2393920, '$6.89M + $3.50M against $8.00M');
  assert.match(c.notes.join(' '), /over the \$8\.00M budget\. A reason is required/);
  refuses(() => decide(store, P.jpe, asha()), 400, /over the \$8\.00M budget\. Say why in the reason field/);
  const { record } = decide(store, P.jpe, asha({ reason: 'Japan launch cannot slip; the director agreed to overspend' }));
  assert.equal(Math.round(record.budget.over_budget_usd), 2393920);
  assert.equal(record.approval.state, 'awaiting-second', '$3.50M also needs a second person');
});

test('a decision that is not an approval carries no cost or approval, and the older records still verify', () => {
  const store = freshStore();
  const { record } = decide(store, P.sea, { decision: 'decline', decided_by: 'Asha Rao', reason: 'Wait for the reliability review' });
  assert.equal(record.cost_usd, undefined);
  assert.equal(record.approval, undefined);
  assert.equal(record.basis.funnels.length, 14);
  assert.deepEqual(verifyChain(store.state().decisions), { ok: true, records: 1 });
});

test('the rules follow the lab: a scenario that makes East US\'s order bigger puts it over the threshold', () => {
  const store = freshStore();
  assert.equal(approvalCheck(store, P.eus, null).needs_second_approver, false);
  store.applyScenario('quota-surge-eastus');
  const c = approvalCheck(store, P.eus, null);
  assert.equal(Math.round(c.cost_usd), 1666560);
  assert.equal(c.needs_second_approver, true);
  assert.equal(decide(store, P.eus, asha()).order, null);
});

test('over HTTP: the preview, the two-step approval, and the budget on the decisions page', async () => {
  const { createApp } = require('../server/app');
  const path = require('node:path');
  const server = createApp({ store: freshStore(), webRoot: path.join(__dirname, '..', 'web') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json() }; };
  try {
    const pre = await call('GET', `/api/pools/${P.weuGpu}/approval`);
    assert.equal(pre.status, 200);
    assert.equal(pre.json.needs_second_approver, true);
    assert.equal((await call('GET', `/api/pools/${P.weuGpu}/approval?quantity_cu=960`)).json.quantity_cu, 960);
    assert.equal((await call('GET', `/api/pools/${P.weuGpu}/approval?quantity_cu=100`)).status, 400);
    assert.equal((await call('GET', '/api/pools/pool-nowhere/approval')).status, 404);
    const detail = await call('GET', `/api/pools/${P.weuGpu}`);
    assert.equal(detail.json.approval.needs_second_approver, true, 'the pool page carries it too');
    assert.equal((await call('GET', `/api/pools/${P.weuAmd}`)).json.approval, null, 'no open order, nothing to approve');

    const first = await call('POST', `/api/pools/${P.weuGpu}/decision`, asha());
    assert.equal(first.status, 200);
    assert.equal(first.json.order, null);
    assert.equal(first.json.record.approval.state, 'awaiting-second');
    const same = await call('POST', `/api/pools/${P.weuGpu}/decision`, asha());
    assert.equal(same.status, 400);
    assert.match(same.json.error, /different named person/);
    const mid = await call('GET', '/api/decisions');
    assert.equal(mid.json.stats.awaiting_second, 1);
    assert.equal(mid.json.budget.waiting.length, 1);
    assert.equal(mid.json.budget.committed_usd, 0);
    const second = await call('POST', `/api/pools/${P.weuGpu}/decision`, ben());
    assert.equal(second.status, 200);
    assert.match(second.json.order.order_id, /^ORD-LAB-/);
    const end = await call('GET', '/api/decisions');
    assert.deepEqual([end.json.stats.approved, end.json.stats.awaiting_second, end.json.budget.waiting.length, end.json.chain.ok], [1, 0, 0, true]);
    assert.ok(end.json.budget.committed_usd > 5000000);
  } finally { await new Promise((r) => server.close(r)); }
});
