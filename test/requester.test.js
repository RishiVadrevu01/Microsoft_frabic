'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { P, freshStore } = require('./helpers');
const { buildRequester, HORIZONS } = require('../server/lib/requester');
const { assessRequests, buildRequest } = require('../server/lib/requests');
const { decide } = require('../server/lib/decisions');
const { daysBetween } = require('../server/lib/dates');

const view = (store, q) => buildRequester(store, q);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// The planner's own assessment of one pending request, to hold the requester's view against.
function assessed(store, requestId) {
  const r = store.data().requests.find((x) => x.request_id === requestId);
  const a = store.assessment(r.pool_id);
  const asmt = assessRequests(a.ctx, a.verdict).find((s) => s.request_id === requestId);
  return { r, a, asmt };
}

// A request that queues behind everything in East US, where nothing is free, nothing is reclaimable and the only supply
// in flight is spoken for: none of it can be served before the drafted order lands.
const lastInQueue = (store, cuAsked) => {
  store.addRequest(buildRequest(store, { pool_id: P.eus, team: 'litware-late', title: 'Late in the queue', cu: cuAsked, needed_by: '2027-01-26', win_probability: 1, org: 'Litware' }));
  return view(store, { org: 'litware' });
};

// ---------------------------------------------------------------- who is asking, and what they see first
test('the first view is the org with a request at risk, with that request selected', () => {
  const o = view(freshStore());
  assert.equal(o.view, 'requester');
  assert.equal(o.source, 'synthetic');
  assert.equal(o.filters.org, 'contoso');
  assert.equal(o.requester.label, 'Contoso');
  assert.equal(o.selected.request_id, 'REQ-1004');
  assert.equal(o.selected.status, 'at-risk');
  assert.deepEqual(o.filters.options.horizons.map((h) => h.weeks), HORIZONS);
});

test('orgs with something at risk come first, then whoever asks for the most, and each count matches the table', () => {
  const store = freshStore();
  const { orgs } = view(store).filters.options;
  assert.deepEqual(orgs.map((x) => x.key), ['contoso', 'adatum', 'northwind']);
  for (const org of orgs) {
    const o = view(store, { org: org.key });
    assert.equal(o.requests.counts.all, org.requests, `${org.key}: requests`);
    assert.equal(o.requests.counts.at_risk, org.at_risk, `${org.key}: at risk`);
  }
  assert.ok(orgs[0].at_risk > 0 && orgs[1].at_risk === 0);
});

test('an org with nothing at risk opens on its first request in need-by order', () => {
  const o = view(freshStore(), { org: 'northwind' });
  assert.equal(o.requests.counts.at_risk, 0);
  assert.equal(o.selected.request_id, o.requests.rows[0].request_id);
  assert.equal(o.selected.status, 'in-review');
});

// ---------------------------------------------------------------- the table
test('the table lists every request the org made, worst first, and history adds no demand', () => {
  const store = freshStore();
  const o = view(store, { org: 'contoso' });
  const c = o.requests.counts;
  assert.equal(c.all, 10);
  assert.equal(c.at_risk + c.in_review + c.approved + c.completed + c.declined, c.all);
  assert.equal(o.requests.rows[0].status, 'at-risk');
  const order = { 'at-risk': 0, 'in-review': 1, approved: 2, completed: 3, declined: 4 };
  const ranks = o.requests.rows.map((r) => order[r.status]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'rows are grouped by how urgent they are');
  for (const r of o.requests.rows.filter((x) => x.status === 'approved' || x.status === 'completed')) {
    assert.equal(r.additional_cu, 0, `${r.request_id} is history`);
  }
  for (const a of store.all()) assert.ok(a.ctx.requests.every((r) => r.status === 'pending'), 'only pending requests are demand');
});

test('every row agrees with the planner: additional is what needs a new order, at risk is when that arrives late', () => {
  const store = freshStore();
  let checked = 0;
  for (const org of view(store).filters.options.orgs) {
    for (const row of view(store, { org: org.key }).requests.rows.filter((r) => r.status === 'at-risk' || r.status === 'in-review')) {
      const { r, a, asmt } = assessed(store, row.request_id);
      assert.equal(row.additional_cu, asmt.needs_order, `${r.request_id}: additional`);
      assert.equal(row.requested_cu, r.cu);
      const lands = a.verdict.dates.lands_on;
      const late = asmt.needs_order > 0 && a.verdict.order.needed && lands > r.needed_by;
      assert.equal(row.status === 'at-risk', late, `${r.request_id}: at risk`);
      checked += 1;
    }
  }
  assert.equal(checked, store.data().requests.filter((r) => r.status === 'pending').length, 'every pending request in the dataset was checked');
});

test('the recommended column follows what each request needs', () => {
  const rows = Object.fromEntries(view(freshStore()).requests.rows.map((r) => [r.request_id, r.recommended]));
  assert.equal(rows['REQ-1004'].kind, 'phase');
  assert.equal(rows['REQ-1001'].kind, 'reallocate');
  assert.match(rows['REQ-1001'].label, /^Reallocate 220 CU$/);
  assert.equal(rows['REQ-0801'].kind, 'done');
  assert.equal(rows['REQ-0802'].kind, 'proceed');
  assert.equal(rows['REQ-3001'].kind, 'proceed');
});

// ---------------------------------------------------------------- the at-risk request, end to end
test('REQ-1004: 93 CU has nowhere to come from before it is needed and the drafted order lands two weeks late', () => {
  const store = freshStore();
  const o = view(store);
  const { r, a, asmt } = assessed(store, 'REQ-1004');
  assert.equal(asmt.needs_order, 93);
  assert.equal(asmt.from_in_flight, 547);
  assert.equal(o.kpis.additional_required.cu, 93);
  assert.equal(o.kpis.additional_required.of_cu, 640);
  assert.equal(o.kpis.additional_required.by, r.needed_by);
  assert.equal(o.kpis.request_status.key, 'at-risk');
  const lateDays = daysBetween(r.needed_by, a.verdict.dates.lands_on);
  assert.ok(lateDays > 0);
  const order = o.timeline.find((e) => e.key === 'remaining');
  assert.equal(order.state, 'risk');
  assert.match(order.detail, new RegExp(`${Math.ceil(lateDays / 7)} weeks? after it is needed`));
  assert.equal(o.forecast.callout.lands_on, a.verdict.dates.lands_on);
});

test('the phases add up to the ask, arrive in order, and the timeline shows each one', () => {
  const store = freshStore();
  const o = view(store);
  const { r, asmt } = assessed(store, 'REQ-1004');
  const keys = o.timeline.map((e) => e.key);
  assert.deepEqual(keys, ['submitted', 'review', 'inflight', 'remaining', 'expected']);
  assert.equal(o.timeline[0].state, 'done');
  assert.equal(o.timeline[1].state, 'current');
  const exp = o.timeline.at(-1).detail;
  assert.match(exp, /^Phase 1: 9 Nov 2026 \(547 CU\) · Phase 2: 8 Feb 2027 \(93 CU\)$/);
  assert.equal(asmt.from_free + asmt.from_reclaim + asmt.from_in_flight + asmt.needs_order, r.cu);
  const bars = o.cost.bars;
  assert.equal(bars[1].cu + bars[2].cu, r.cu, 'phase 1 and phase 2 make up the whole ask');
});

// ---------------------------------------------------------------- KPIs
test('KPIs: usage is the team\'s own, demand is that usage grown at the pool forecast plus the ask, cost is the ordered part', () => {
  const store = freshStore();
  const o = view(store);
  const { r, a, asmt } = assessed(store, 'REQ-1004');
  const held = store.data().allocations.filter((al) => al.reserved_by === r.team && al.pool_id === r.pool_id);
  const used = sum(held, (al) => al.utilized_units);
  const allocated = sum(held, (al) => al.allocated_units);
  assert.equal(o.kpis.current_usage.cu, used);
  assert.equal(o.kpis.current_usage.allocated_cu, allocated);
  assert.ok(Math.abs(o.kpis.current_usage.share_of_allocated - used / allocated) < 1e-9);
  const demand = used * (a.ctx.upperAt(52) / a.ctx.latest) + r.cu;
  assert.equal(o.kpis.total_demand.cu, Math.round(demand));
  assert.equal(o.kpis.est_cost.usd, Math.round((asmt.needs_order / a.ctx.factor) * a.ctx.orderSku.unit_cost_usd));
  assert.equal(o.cost.new_spend_usd, o.kpis.est_cost.usd);
  assert.equal(o.kpis.business_impact.usd, r.revenue_at_risk_usd);
  assert.equal(o.kpis.business_impact.label, 'Revenue at risk');
  assert.equal(o.kpis.business_impact.stated_by, 'the requester');
  for (const key of ['current_usage', 'total_demand', 'additional_required', 'request_status', 'business_impact', 'est_cost']) {
    assert.ok(o.kpis[key].definition.length > 20, `${key} says what it means`);
  }
});

test('demand change is the same forecast a quarter ago; a team with no usage in the pool has nothing to compare', () => {
  const store = freshStore();
  const withUsage = view(store).kpis.total_demand;
  assert.equal(typeof withUsage.delta_pct, 'number');
  assert.ok(Math.abs(withUsage.delta_pct) < 1, 'a change, not a level');
  const none = view(store, { org: 'contoso', request: 'REQ-1002' }).kpis;        // contoso-copilot holds nothing in East US
  assert.equal(none.current_usage.holds_capacity_here, false);
  assert.equal(none.current_usage.share_of_allocated, null);
  assert.equal(none.total_demand.delta_pct, null);
  assert.equal(none.total_demand.cu, 1100, 'only the ask');
});

// ---------------------------------------------------------------- the recommendation
test('the recommendation says what to do, why, what it changes and the next steps, and claims no probability', () => {
  const o = view(freshStore());
  const rec = o.recommendation;
  assert.equal(rec.state, 'at-risk');
  assert.match(rec.headline, /^Phase it: 547 CU when supply already ordered lands 9 Nov 2026 and 93 CU when the drafted order lands 8 Feb 2027/);
  assert.ok(rec.why.length >= 3 && rec.impact.length >= 2 && rec.next_steps.length >= 3);
  assert.match(rec.impact[0], /Meets 547 CU of 640 CU \(85%\)/);
  assert.ok(rec.next_steps.some((s) => /move the need date to 8 Feb 2027/i.test(s)));
  assert.ok(rec.next_steps.some((s) => /West Europe/.test(s)), 'a region with room today is offered');
  assert.match(rec.basis, /claims no probability/);
  assert.equal('confidence' in rec, false);
  assert.ok(!/\d+\s*%\s*confiden/i.test(JSON.stringify(rec)), 'no invented confidence figure');
});

test('the one-line answer says yes, partly or not in time, in words a requester can act on', () => {
  const store = freshStore();
  assert.equal(view(store).recommendation.answer, 'Partly. 547 CU of 640 CU is in place by the 25 Jan 2027 need date; the last 93 CU lands 2 weeks late, on 8 Feb 2027.');
  assert.equal(view(store, { org: 'contoso', request: 'REQ-1001' }).recommendation.answer, 'Yes. All 480 CU can be in place by the 16 Nov 2026 need date, with no new order.');
  assert.match(lastInQueue(freshStore(), 500).recommendation.answer, /^Not in time\. Nothing can be served before 8 Feb 2027, \d+ weeks? after the 26 Jan 2027 need date\.$/);
  assert.match(view(store, { org: 'contoso', request: 'REQ-0801' }).recommendation.answer, /^Delivered 10 Aug 2026/);
});

test('when everything fits now the recommendation is to proceed and no order is asked for', () => {
  const o = view(freshStore(), { org: 'contoso', request: 'REQ-1001' });
  assert.equal(o.recommendation.state, 'in-review');
  assert.match(o.recommendation.headline, /^Serve 480 CU now \(260 CU free, 220 CU from idle reservations\)\. No purchase is needed\.$/);
  assert.equal(o.kpis.additional_required.has_need, false);
  assert.equal(o.kpis.est_cost.usd, 0);
  assert.ok(o.recommendation.next_steps.some((s) => /reallocation of 220 CU with contoso-data-eng/.test(s)));
  assert.equal(o.timeline.find((e) => e.key === 'remaining'), undefined);
  assert.equal(o.forecast.callout, null);
});

test('a request that is approved, completed or declined has a plain status, no options and no callout', () => {
  const store = freshStore();
  const done = view(store, { org: 'contoso', request: 'REQ-0801' });
  assert.equal(done.selected.status, 'completed');
  assert.match(done.recommendation.headline, /^Delivered 10 Aug 2026: 600 CU in East US\.$/);
  assert.deepEqual(done.timeline.map((e) => e.key), ['submitted', 'decided', 'delivered']);
  assert.equal(done.options.length, 0);
  assert.equal(done.forecast.callout, null);
  assert.equal(done.kpis.request_status.note, 'Delivered 10 Aug 2026');
  assert.equal(done.kpis.business_impact.label, 'Revenue this request supports');
  const approved = view(store, { org: 'contoso', request: 'REQ-0802' });
  assert.equal(approved.selected.status, 'approved');
  assert.match(approved.recommendation.headline, /^Approved on 2 Sep 2026/);
  assert.deepEqual(approved.timeline.map((e) => e.key), ['submitted', 'decided', 'expected']);
  assert.ok(approved.forecast.points.every((p) => p.capacity === approved.forecast.points[0].capacity), 'nothing new to add to the capacity line');
});

// ---------------------------------------------------------------- the chart
test('forecast: demand grows from usage, steps up at the need date, and capacity steps up as each phase lands', () => {
  const store = freshStore();
  const o = view(store);
  const { r, a } = assessed(store, 'REQ-1004');
  const f = o.forecast;
  assert.equal(f.months, 12);
  assert.equal(f.points.length, 13);
  assert.equal(f.points[0].demand, o.kpis.current_usage.cu, 'today, demand is what is used');
  assert.equal(f.points.at(-1).demand, o.kpis.total_demand.cu, 'the last point is the headline demand');
  assert.equal(f.points[0].capacity, o.kpis.current_usage.allocated_cu, 'today, capacity is what the team holds');
  assert.equal(f.points.at(-1).capacity, o.kpis.current_usage.allocated_cu + r.cu, 'in the end the whole ask is held');
  for (let i = 1; i < f.points.length; i++) {
    assert.ok(f.points[i].capacity >= f.points[i - 1].capacity, 'capacity never falls');
    assert.ok(f.points[i].usage >= f.points[i - 1].usage, 'usage grows at the middle forecast');
    assert.ok(f.points[i].demand >= f.points[i].usage, 'the demand line sits above the usage line');
  }
  const hNeed = a.ctx.hOf(r.needed_by);
  const before = f.points.filter((p) => p.week < hNeed).at(-1);
  const after = f.points.find((p) => p.week >= hNeed);
  assert.ok(after.demand - before.demand > r.cu * 0.9, 'the ask lands in demand from the need date');
  assert.equal(f.callout.week, hNeed);
  assert.equal(f.callout.date, r.needed_by);
  assert.equal(f.callout.cu, 93);
  assert.match(f.callout.text, /^Need additional capacity by 25 Jan 2027 \(93 CU\)$/);
});

test('the chart horizon is 3, 6 or 12 months of the same points', () => {
  const store = freshStore();
  const full = view(store, { horizon: 52 }).forecast;
  for (const [weeks, months] of [[13, 3], [26, 6], [52, 12]]) {
    const f = view(store, { horizon: weeks }).forecast;
    assert.equal(f.months, months);
    assert.equal(f.points.length, months + 1);
    assert.deepEqual(f.points, full.points.slice(0, months + 1), 'a shorter horizon is a prefix, not a different forecast');
  }
});

test('the weekly series carries the steps exactly: the ask lands in demand on its need week, capacity on each landing week', () => {
  const store = freshStore();
  const o = view(store);
  const { r, a } = assessed(store, 'REQ-1004');
  const w = o.forecast.weekly;
  assert.equal(w.length, 53, 'week 0 to week 52');
  assert.deepEqual(w.map((p) => p.week), Array.from({ length: 53 }, (_, i) => i));
  for (const p of o.forecast.points) assert.deepEqual({ ...p, month: undefined }, { ...w[p.week], month: undefined }, 'the monthly points are the same values');
  const hNeed = a.ctx.hOf(r.needed_by);
  assert.ok(w[hNeed].demand - w[hNeed - 1].demand > r.cu * 0.9, 'demand steps by the ask on the need week');
  assert.ok(w[hNeed - 1].demand - w[hNeed - 2].demand < r.cu * 0.1, 'and not before it: the week before rises only by the team\'s own growth');
  const steps = w.filter((p, i) => i > 0 && p.capacity !== w[i - 1].capacity);
  assert.deepEqual(steps.map((p) => p.date), ['2026-11-09', '2027-02-08'].map((d) => a.ctx.dateOf(a.ctx.hOf(d))), 'capacity steps on the two landing weeks');
  assert.deepEqual(steps.map((p) => p.capacity - w[p.week - 1].capacity), [547, 93], 'by the supply already ordered, then by the drafted order');
  assert.equal(view(store, { horizon: 13 }).forecast.weekly.length, 14);
});

// ---------------------------------------------------------------- options, cost, risks
test('options: exactly one is recommended and it is first; the rule is phase when part arrives in time', () => {
  const store = freshStore();
  const o = view(store);
  assert.equal(o.options.filter((x) => x.recommended).length, 1);
  assert.equal(o.options[0].recommended, true);
  assert.equal(o.options[0].key, 'phase');
  const keys = o.options.map((x) => x.key);
  assert.ok(keys.includes('early-only') && keys.includes('move-date'));
  assert.ok(keys.every((k) => k !== `region-${P.eus}`), 'the request\'s own pool is not an alternative');
  const early = o.options.find((x) => x.key === 'early-only');
  assert.equal(early.capacity_cu, 547);
  assert.equal(early.est_cost_usd, 0);
  assert.equal(o.options.find((x) => x.key === 'phase').est_cost_usd, o.kpis.est_cost.usd);
  for (const alt of o.options.filter((x) => x.key.startsWith('region-'))) assert.equal(alt.est_cost_usd, 0);
});

test('when nothing arrives in time and another region has room, the recommendation is to place it there', () => {
  const store = freshStore();
  const o = lastInQueue(store, 500);
  const { asmt } = assessed(store, o.selected.request_id);
  assert.equal(asmt.from_free + asmt.from_reclaim + asmt.from_in_flight, 0, 'nothing is left for it');
  assert.equal(o.selected.status, 'at-risk');
  assert.match(o.recommendation.headline, /^Nothing can be served before 8 Feb 2027, \d+ weeks? after the 26 Jan 2027 need date\./);
  assert.equal(o.options.filter((x) => x.recommended).length, 1);
  assert.match(o.options[0].key, /^region-/);
  assert.equal(o.options[0].capacity_cu, 500, 'the region covers all of it');
  assert.ok(o.options.some((x) => x.key === 'move-date'));
  assert.equal(o.options.some((x) => x.key === 'early-only'), false, 'there is no earlier part to take');
  assert.equal(o.cost.bars[1].cu, 0);
  assert.equal(o.cost.bars[2].cu, 500);
});

test('when no region can take all of it either, the recommendation is to move the date', () => {
  const o = lastInQueue(freshStore(), 5000);
  assert.equal(o.selected.status, 'at-risk');
  assert.equal(o.options.filter((x) => x.recommended).length, 1);
  assert.equal(o.options[0].key, 'move-date');
  const regions = o.options.filter((x) => x.key.startsWith('region-'));
  assert.ok(regions.length > 0 && regions.every((x) => x.impact === 'Partial' && x.capacity_cu < 5000));
});

test('cost: existing capacity is valued but is not new spend; only the ordered part is', () => {
  const store = freshStore();
  const o = view(store);
  const { a } = assessed(store, 'REQ-1004');
  const [held, early, order] = o.cost.bars;
  assert.equal(held.kind, 'existing');
  assert.equal(early.kind, 'existing');
  assert.equal(order.kind, 'new');
  assert.equal(held.usd, Math.round(held.cu * a.ctx.sku.unit_cost_usd));
  assert.equal(order.usd, o.cost.new_spend_usd);
  assert.ok(Math.abs(o.cost.share_needing_order - 93 / 640) < 1e-9);
  assert.match(o.cost.note, /not annual/);
  assert.match(o.kpis.est_cost.definition, /not an annual figure/);
});

test('risks: this request first, then what the pool\'s funnels flag; highest severity first, at most five shown', () => {
  const o = view(freshStore());
  assert.equal(o.risks.items[0].key, 'late');
  assert.equal(o.risks.items[0].severity, 'High');
  assert.ok(o.risks.items.length <= 5 && o.risks.total >= o.risks.items.length);
  const rank = { High: 0, Medium: 1, Low: 2 };
  const sev = o.risks.items.map((x) => rank[x.severity]);
  assert.deepEqual(sev, [...sev].sort((x, y) => x - y));
  const funnelRisks = o.risks.items.filter((x) => x.funnel);
  assert.ok(funnelRisks.length >= 3);
  assert.ok(funnelRisks.every((x) => x.funnel >= 1 && x.funnel <= 14));
  assert.ok(o.risks.items.some((x) => x.key === 'competing') || o.risks.total > 5);
});

// ---------------------------------------------------------------- details, drivers, business, utilization
test('details, drivers and business impact are the record, or derived from the plan; nothing is invented', () => {
  const store = freshStore();
  const o = view(store);
  const { r } = assessed(store, 'REQ-1004');
  const d = Object.fromEntries(o.details.rows.map((x) => [x.key, x.value]));
  assert.equal(d.environment, 'Production');
  assert.equal(d.region, 'East US');
  assert.equal(d.workload, 'Data warehouse');
  assert.equal(d.requested, '640 CU');
  assert.equal(d.additional, '93 CU');
  assert.equal(d.need_by, '25 Jan 2027');
  assert.equal(d.source, 'Sales pipeline');
  assert.equal(o.details.use_case, r.use_case);
  const b = Object.fromEntries(o.business_impact.rows.map((x) => [x.key, x.value]));
  assert.equal(b.commitment, r.customer_commitment);
  assert.equal(b.sla, 'High');
  assert.equal(b.strategic, 'High');
  assert.equal(o.business_impact.stated_by, 'the requester');
  assert.equal(sum(o.drivers, (x) => x.share_pct), 100, 'driver shares add up to exactly 100');
  assert.ok(o.drivers.every((x) => x.share_pct > 0));
  assert.deepEqual(o.drivers.map((x) => x.share_pct), o.drivers.map((x) => x.share_pct).sort((x, y) => y - x));
  assert.ok(o.drivers.some((x) => x.key === 'sales-pipeline'));
});

test('utilization is what the team uses of what it reserved, and where else it holds capacity', () => {
  const o = view(freshStore());
  const u = o.utilization;
  assert.equal(u.used_cu + u.unused_cu, u.allocated_cu);
  assert.ok(Math.abs(u.used_share - u.used_cu / u.allocated_cu) < 1e-9);
  assert.equal(u.pool.region, 'East US');
  assert.ok(u.elsewhere.length >= 1 && u.elsewhere.every((e) => e.pool_id !== P.eus && e.allocated_cu > 0));
});

// ---------------------------------------------------------------- filters and errors
test('the region filter narrows the table but the request options still cover the whole org', () => {
  const store = freshStore();
  const all = view(store, { org: 'contoso' });
  const eu = view(store, { org: 'contoso', region: 'europe' });
  assert.ok(eu.requests.rows.length > 0 && eu.requests.rows.length < all.requests.rows.length);
  assert.ok(eu.requests.rows.every((r) => r.geo === 'europe'));
  assert.equal(eu.requests.counts.all, eu.requests.rows.length);
  assert.equal(eu.filters.options.requests.length, all.requests.rows.length);
  assert.equal(eu.selected.request_id, eu.requests.rows[0].request_id, 'the selection moves into the region');
  assert.deepEqual(eu.filters.options.regions.map((x) => x.key), all.filters.options.regions.map((x) => x.key));
  assert.equal(all.filters.options.regions[0].key, 'all');
});

test('a request can be chosen by id, even outside the region filter; bad choices are refused with a reason', () => {
  const store = freshStore();
  const pick = view(store, { org: 'contoso', request: 'REQ-3001', region: 'north-america' });
  assert.equal(pick.selected.request_id, 'REQ-3001');
  const refuse = (q, re) => assert.throws(() => view(store, q), (e) => e.status === 400 && re.test(e.message));
  refuse({ org: 'nobody' }, /org must be one of contoso, adatum, northwind/);
  refuse({ org: 'northwind', request: 'REQ-1004' }, /request must be one of REQ-2001 for this org/);
  refuse({ region: 'mars' }, /region must be all or one of/);
});

test('the view is deterministic and never changes the lab', () => {
  const store = freshStore();
  const before = JSON.stringify(store.state());
  const a = JSON.stringify(view(store));
  const b = JSON.stringify(view(store));
  assert.equal(a, b);
  assert.equal(JSON.stringify(store.state()), before);
  assert.deepEqual(store.verdicts().map((v) => v.pool_id), store.baseline().map((v) => v.pool_id));
});

// ---------------------------------------------------------------- it follows the lab
test('a scenario in the Lab moves the requester\'s view with it', () => {
  const base = view(freshStore());
  const store = freshStore();
  store.applyScenario('quota-surge-eastus');
  const o = view(store);
  assert.notEqual(o.requests.counts.at_risk, base.requests.counts.at_risk, 'a quota surge puts more requests at risk');
  assert.ok(o.requests.counts.at_risk > base.requests.counts.at_risk);
  for (const row of o.requests.rows.filter((x) => x.status === 'at-risk' || x.status === 'in-review')) {
    const { asmt } = assessed(store, row.request_id);
    assert.equal(row.additional_cu, asmt.needs_order, `${row.request_id} still agrees with the planner`);
  }
});

test('approving the drafted order turns the late part into an order already placed: same date, no longer new spend', () => {
  const store = freshStore();
  const before = view(store);
  decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  const o = view(store);
  assert.equal(o.selected.request_id, 'REQ-1004');
  assert.equal(o.kpis.additional_required.cu, before.kpis.additional_required.cu, 'the ask is served no earlier');
  assert.equal(o.forecast.callout.lands_on, before.forecast.callout.lands_on);
  assert.equal(before.kpis.est_cost.usd > 0, true);
  assert.equal(o.kpis.est_cost.usd, 0, 'an order already placed is not new spend');
  assert.match(o.recommendation.headline, /the order already placed lands 8 Feb 2027/);
  assert.ok(o.recommendation.why.some((s) => /already placed for this pool lands 8 Feb 2027, after the need date/.test(s)));
  assert.ok(o.recommendation.next_steps.some((s) => /the order already placed for this team/.test(s)));
  assert.equal(o.selected.status, 'at-risk', 'still late: the order lands after the need date');
});

// ---------------------------------------------------------------- requests made through the API
test('a new request keeps what the requester says about it and joins the org named on it', () => {
  const store = freshStore();
  const req = buildRequest(store, {
    pool_id: P.eus, team: 'fabrikam-bi', title: 'BI refresh', cu: 300, needed_by: '2026-12-15', priority: 'high',
    org: 'Fabrikam', environment: 'staging', use_case: 'Nightly refresh of the finance models.', revenue_at_risk_usd: 1250000.4,
    customer_commitment: 'Year-end close', sla_impact: 'medium', strategic_importance: 'high',
  });
  assert.equal(req.submitted_on, store.data().as_of);
  assert.equal(req.revenue_at_risk_usd, 1250000);
  store.addRequest(req);
  const o = view(store, { org: 'fabrikam' });
  assert.equal(o.requester.label, 'Fabrikam');
  assert.equal(o.requests.counts.all, 1);
  assert.equal(o.selected.request_id, req.request_id);
  const d = Object.fromEntries(o.details.rows.map((x) => [x.key, x.value]));
  assert.equal(d.environment, 'Staging');
  assert.equal(d.submitted, '21 Sep 2026');
  assert.equal(o.details.use_case, 'Nightly refresh of the finance models.');
  assert.equal(o.business_impact.rows.find((x) => x.key === 'sla').value, 'Medium');
});

test('a request with no org is filed under the first word of its team, and blank business fields read "Not stated"', () => {
  const store = freshStore();
  const req = buildRequest(store, { pool_id: P.weuAmd, team: 'tailspin-ops', title: 'Ops tooling', cu: 100, needed_by: '2026-12-01' });
  store.addRequest(req);
  const o = view(store, { org: 'tailspin' });
  assert.equal(o.requester.label, 'Tailspin');
  assert.equal(o.kpis.business_impact.usd, null);
  assert.deepEqual(o.business_impact.rows.map((x) => x.value).slice(1), ['Not stated', 'Not stated', 'Not stated']);
  assert.equal(o.details.use_case, null);
  assert.equal(o.details.rows.find((x) => x.key === 'environment').value, 'Not stated', 'an environment nobody gave is not guessed');
});

test('the optional business fields are checked, with a reason', () => {
  const store = freshStore();
  const base = { pool_id: P.eus, team: 'ab', title: 'abc', cu: 10, needed_by: '2027-01-01' };
  const bad = (extra, re) => assert.throws(() => buildRequest(store, { ...base, ...extra }), re);
  bad({ org: 'x' }, /org must be 2 to 40/);
  bad({ environment: 'moon' }, /environment must be one of production, staging, development/);
  bad({ use_case: 'x'.repeat(401) }, /use_case must be 400 characters/);
  bad({ revenue_at_risk_usd: -1 }, /revenue_at_risk_usd must be a number between 0/);
  bad({ revenue_at_risk_usd: 'lots' }, /revenue_at_risk_usd must be a number/);
  bad({ customer_commitment: 'x'.repeat(121) }, /customer_commitment must be 120/);
  bad({ sla_impact: 'extreme' }, /sla_impact must be one of low, medium, high/);
  bad({ strategic_importance: 'low' }, /strategic_importance must be one of medium, high, critical/);
  const blank = buildRequest(store, { ...base, org: '', use_case: '', sla_impact: null });
  assert.equal('org' in blank, false, 'blank optional fields are left out, not stored empty');
  assert.equal('sla_impact' in blank, false);
});
