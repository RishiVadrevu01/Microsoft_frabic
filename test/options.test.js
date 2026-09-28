'use strict';
/*
 * The planner (options.js): the executable options for an open order. Every number is the plan engine's own, and an option's
 * preview must be what approving it then produces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { P, freshStore, tempDataDir } = require('./helpers');
const { buildOptions, RULE, WAIT_WEEKS } = require('../server/lib/options');
const { decide } = require('../server/lib/decisions');
const { assessPool } = require('../server/lib/verdict');
const { createStore } = require('../server/lib/store');
const { addWeeks } = require('../server/lib/dates');

const asha = (extra) => ({ decision: 'approve', decided_by: 'Asha Rao', ...extra });
const ben = (extra) => ({ decision: 'approve', decided_by: 'Ben Ortiz', ...extra });
const byKey = (o) => Object.fromEntries(o.options.map((x) => [x.key, x]));

// Approve a quantity all the way (a second person if one is needed), as a person would.
function approveFully(store, poolId, qty, drafted) {
  const body = { ...(qty !== drafted ? { quantity_cu: qty, reason: 'Taking the option the planner offered' } : {}) };
  const first = decide(store, poolId, asha(body));
  if (first.record.approval.state === 'awaiting-second') decide(store, poolId, ben());
}

test('East US: as drafted or wait; phasing is not offered because the second order would already be late, and it says so', () => {
  const o = buildOptions(freshStore(), P.eus);
  assert.equal(o.needed, true);
  assert.deepEqual(o.options.map((x) => x.key), ['as-drafted', 'wait']);
  const a = byKey(o)['as-drafted'];
  assert.equal(a.recommended, true);
  assert.equal(a.quantity_cu, 4032);
  assert.equal(a.cost_usd, 1249920);
  assert.equal(a.lands_on, '2027-02-08');
  assert.equal(a.covers_until, '2027-09-20', 'the plan\'s own statement of how long the order lasts');
  assert.match(a.summary, /^4,032 CU of FAB-AMD-GENOA-96 \(\$1\.25M\), landing 8 Feb 2027\. Sized to cover 26 weeks after landing: demand stays covered until 20 Sep 2027\.$/);
  assert.equal(o.notes.length, 1);
  assert.match(o.notes[0], /Phasing is not offered: the second order, 960 CU, would already have been due on 10 Aug 2026/);
  assert.equal(o.rule, RULE);
});

test('waiting is shown so its cost can be seen: it lands later, the shortfall is longer, and it is never the recommendation', () => {
  const store = freshStore();
  const v = store.assessment(P.eus).verdict;
  const w = byKey(buildOptions(store, P.eus))['wait'];
  assert.equal(w.places_order, false);
  assert.deepEqual([w.quantity_cu, w.cost_usd, w.recommended], [0, 0, false]);
  assert.equal(w.lands_on, addWeeks(v.dates.lands_on, WAIT_WEEKS));
  assert.equal(w.weeks_late, v.dates.short_weeks + WAIT_WEEKS, 'six weeks late becomes ten');
  assert.match(w.summary, /10 weeks after it is needed instead of 6/);
  assert.equal(w.governance.needs_second_approver, false, 'doing nothing needs no approval');
});

test('H100: as drafted, a phased alternative that costs less, and what each needs from the approver', () => {
  const o = buildOptions(freshStore(), P.weuGpu);
  assert.deepEqual(o.options.map((x) => x.key), ['as-drafted', 'phase', 'wait']);
  const { 'as-drafted': a, phase: p } = byKey(o);
  assert.deepEqual([a.quantity_cu, a.recommended, a.governance.needs_second_approver], [1344, true, true]);
  assert.equal(p.quantity_cu, 1056);
  assert.ok(p.cost_usd < a.cost_usd);
  assert.equal(p.cost_usd, 1056 * 4200);
  assert.equal(p.lands_on, a.lands_on, 'the same order date and lead time, so the same landing');
  assert.equal(p.governance.needs_second_approver, true, '$4.44M is still above the threshold');
  assert.match(p.summary, /Sized to cover 13 weeks after landing instead of 26: 1,056 CU \(\$4\.44M\)/);
  assert.match(p.summary, /The plan then needs no further order in the next 12 months\./);
  assert.match(p.tradeoff, /sized for a shorter window/);
});

test('an option\'s preview is what approving it then produces: the plan is the same, order for order', () => {
  for (const [poolId, keys] of [[P.eus, ['as-drafted']], [P.weuGpu, ['as-drafted', 'phase']], [P.jpe, ['as-drafted', 'phase']]]) {
    const opts = buildOptions(freshStore(), poolId);
    for (const key of keys) {
      const o = byKey(opts)[key];
      const store = freshStore();
      approveFully(store, poolId, o.quantity_cu, opts.drafted_quantity_cu);
      const now = store.assessment(poolId).verdict;
      const label = `${poolId} ${key}`;
      assert.equal(now.state, o.after.state, `${label}: state`);
      assert.equal(now.order.needed, o.after.needs_next_order, `${label}: still needs an order?`);
      if (o.after.next_order) {
        assert.equal(now.order.quantity_cu, o.after.next_order.quantity_cu, `${label}: next order size`);
        assert.equal(now.dates.raise_by, o.after.next_order.raise_by, `${label}: next order raise-by`);
        assert.equal(now.dates.lands_on, o.after.next_order.lands_on, `${label}: next order lands`);
      }
      assert.equal(store.state().orders.at(-1).cu, o.quantity_cu, `${label}: the order that was placed`);
      assert.equal(store.state().orders.at(-1).lands_on, o.lands_on, `${label}: and when it lands`);
    }
  }
});

test('when the budget cannot take the drafted order the recommendation is the most the budget allows, with what is left', () => {
  const store = freshStore();
  approveFully(store, P.eus, 4032, 4032);          // $1.25M
  approveFully(store, P.weuGpu, 1344, 1344);       // + $5.64M = $6.89M of $8.00M
  const o = buildOptions(store, P.jpe);
  assert.equal(Math.round(o.budget.remaining_usd), 1105280);
  assert.deepEqual(o.options.map((x) => x.key), ['fit-budget', 'as-drafted', 'phase', 'wait'], 'the recommended one is first');
  const { 'fit-budget': f, 'as-drafted': a, phase: p } = byKey(o);
  assert.equal(f.recommended, true);
  assert.equal(f.quantity_cu, 768);
  assert.equal(f.quantity_cu % 96, 0, 'whole racks');
  assert.ok(f.cost_usd <= o.budget.remaining_usd, 'it fits');
  assert.ok(f.cost_usd + 1350 * 96 > o.budget.remaining_usd, 'and one more rack would not');
  assert.equal(f.fits_budget, true);
  assert.equal(f.governance.needs_second_approver, false, '$1.04M is under the threshold');
  assert.deepEqual([f.after.next_order.quantity_cu, f.after.next_order.raise_by], [1728, '2026-11-23'], 'the gap it leaves, and when it must be closed');
  assert.match(f.summary, /768 CU \(\$1\.04M\), the most whole racks of 96 that fit the \$1\.11M left\. 1,728 CU is still needed, to be raised by 23 Nov 2026\./);
  assert.equal(a.fits_budget, false);
  assert.equal(Math.round(a.governance.over_budget_usd), 2393920);
  assert.equal(Math.round(p.governance.over_budget_usd), 1875520);
  assert.equal(o.options.filter((x) => x.recommended).length, 1);

  // and the preview is what happens
  const after = freshStore();
  approveFully(after, P.eus, 4032, 4032); approveFully(after, P.weuGpu, 1344, 1344);
  approveFully(after, P.jpe, 768, 2592);
  const now = after.assessment(P.jpe).verdict;
  assert.deepEqual([now.order.needed, now.order.quantity_cu, now.dates.raise_by], [true, 1728, '2026-11-23']);
});

test('the recommendation follows the rule when there is room: as drafted, whatever else is offered', () => {
  const o = buildOptions(freshStore(), P.jpe);
  assert.equal(o.options.find((x) => x.recommended).key, 'as-drafted');
  assert.ok(o.options.every((x) => x.fits_budget), 'everything fits an untouched $8M budget');
  assert.equal(o.options.some((x) => x.key === 'fit-budget'), false, 'not offered when it is not needed');
  assert.equal(o.options.filter((x) => x.recommended).length, 1);
});

test('when the budget left cannot buy the vendor\'s minimum, no order fits and it says so, and the drafted order is still recommended', () => {
  const dir = tempDataDir();
  const f = path.join(dir, 'policy.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  body.approval.budget_usd = 20000; body.approval.second_approver_above_usd = 10000;
  fs.writeFileSync(f, JSON.stringify(body));
  const o = buildOptions(createStore({ dataDir: dir, statePath: null }), P.eus);
  assert.equal(o.options.some((x) => x.key === 'fit-budget'), false);
  assert.ok(o.notes.some((n) => /left in the budget cannot buy the vendor's minimum order of \d+ CU, so no order fits it/.test(n)), o.notes.join(' | '));
  const a = o.options.find((x) => x.recommended);
  assert.equal(a.key, 'as-drafted');
  assert.equal(a.fits_budget, false, 'and it says it is over: the approver will need a reason');
});

test('a pool with nothing to order has no options, and says the budget anyway', () => {
  const o = buildOptions(freshStore(), P.weuAmd);
  assert.deepEqual([o.needed, o.options, o.sensitivities, o.notes], [false, [], [], []]);
  assert.equal(o.budget.budget_usd, 8000000);
});

test('what would change the answer is the same plan under an assumption, not an estimate', () => {
  const store = freshStore();
  const o = buildOptions(store, P.eus);
  const v = store.assessment(P.eus).verdict;
  const lead = o.sensitivities.find((s) => s.key === 'lead-at-quote');
  const direct = assessPool(store.data(), P.eus, { lead_time_weeks: 14 }).verdict;
  assert.match(lead.ask, /If the vendor met its quoted lead time \(14 weeks, not 20\)/);
  assert.deepEqual([lead.state, lead.quantity_cu, lead.raise_by, lead.lands_on], [direct.state, direct.order.quantity_cu, direct.dates.raise_by, direct.dates.lands_on]);
  assert.equal(lead.quantity_change_cu, direct.order.quantity_cu - v.order.quantity_cu);
  assert.ok(lead.lands_change_weeks < 0, 'a shorter lead time lands sooner');
  const grow = o.sensitivities.find((s) => s.key === 'growth-plus-25');
  const g = assessPool(store.data(), P.eus, { growth_pts_per_week: v.forecast.slope_pts_per_week * 1.25 }).verdict;
  assert.deepEqual([grow.quantity_cu, grow.raise_by], [g.order.quantity_cu, g.dates.raise_by]);
  assert.ok(grow.quantity_change_cu > 0, 'faster growth needs a bigger order');
  assert.equal(store.state().decisions.length, 0, 'asking changes nothing');
});

test('a waiting approval is named, so the screen can say the options are moot until it is settled', () => {
  const store = freshStore();
  decide(store, P.weuGpu, asha());
  const o = buildOptions(store, P.weuGpu);
  assert.deepEqual(o.pending, { decision_id: 'DEC-0001', decided_by: 'Asha Rao', quantity_cu: 1344 });
  assert.equal(buildOptions(freshStore(), P.weuGpu).pending, null);
});

test('the cover-weeks override behind phasing is inert unless asked for, and asking for less orders less', () => {
  const store = freshStore();
  const data = store.data();
  const base = assessPool(data, P.weuGpu).verdict;
  assert.equal(assessPool(data, P.weuGpu, { cover_weeks: NaN }).verdict.order.quantity_cu, base.order.quantity_cu);
  assert.equal(assessPool(data, P.weuGpu, { cover_weeks: 0 }).verdict.order.quantity_cu, base.order.quantity_cu, 'zero or less is ignored');
  assert.equal(assessPool(data, P.weuGpu, { cover_weeks: data.policy.cover_weeks }).verdict.order.quantity_cu, base.order.quantity_cu, 'the policy value is the default');
  assert.ok(assessPool(data, P.weuGpu, { cover_weeks: 13 }).verdict.order.quantity_cu < base.order.quantity_cu);
  assert.ok(assessPool(data, P.weuGpu, { cover_weeks: 52 }).verdict.order.quantity_cu > base.order.quantity_cu);
});

test('the options are computed from the lab as it stands: a scenario changes them, and asking never changes the lab', () => {
  const store = freshStore();
  const before = JSON.stringify(store.state());
  buildOptions(store, P.eus);
  assert.equal(JSON.stringify(store.state()), before);
  store.applyScenario('quota-surge-eastus');
  const o = buildOptions(store, P.eus);
  const a = byKey(o)['as-drafted'];
  assert.equal(a.quantity_cu, 5376);
  assert.equal(a.governance.needs_second_approver, true, '$1.67M is now above the threshold');
});

test('over HTTP: one call per pool, and an unknown pool is a 404', async () => {
  const { createApp } = require('../server/app');
  const server = createApp({ store: freshStore(), webRoot: path.join(__dirname, '..', 'web') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/pools/${P.weuGpu}/options`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.options.map((x) => x.key), ['as-drafted', 'phase', 'wait']);
    assert.equal(json.rule, RULE);
    assert.equal(json.budget.synthetic, true);
    assert.equal((await fetch(`${base}/api/pools/pool-nowhere/options`)).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});
