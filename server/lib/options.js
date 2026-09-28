'use strict';
/*
 * The planner (stage 7): turn the plan engine's one recommendation into the executable options a person can choose between.
 *
 * Every number here is the plan engine's own. An option that places an order is measured by re-running the plan with that order
 * hypothetically in flight (what the plan would say the moment it were approved), so the preview of an option is exactly what
 * approving it produces (test/options.test.js checks this against a real approval). Nothing is estimated and nothing comes from
 * a model. Each option also says what it would need of the approver (approval.js): a second person, a reason for going over budget.
 *
 * The rule for what is recommended is stated with the options, because a recommendation the reader cannot check is only an opinion:
 *   1. order what closes the gap, if the budget allows;
 *   2. if it does not, the most whole racks the budget allows, and say what is left;
 *   3. never wait. Waiting is shown so its cost can be seen, not to be chosen.
 */

const { assessPool } = require('./verdict');
const { approvalCheck, budgetOf, pendingApproval } = require('./approval');
const { addWeeks, daysBetween, fmt } = require('./dates');
const { cu, usd } = require('./format');

const WAIT_WEEKS = 4;
const RULE = 'Order what closes the gap if the budget allows it. If it does not, order the most whole racks the budget allows and say what is left. Never wait: waiting is shown so its cost can be seen, not to be chosen.';

const weeksBetween = (a, b) => (a && b ? Math.round(daysBetween(a, b) / 7) : null);

/** What the plan says once a hypothetical order of `qty` is in flight: the real plan engine, run again. */
function afterOrder(data, v, poolId, qty) {
  const order = { order_id: 'OPTION', pool_id: poolId, sku_id: v.what.order_sku, cu: qty, placed_on: v.dates.raise_on, lands_on: v.dates.lands_on, status: 'approved-not-placed' };
  const a = assessPool({ ...data, supply: [...data.supply, order] }, poolId).verdict;
  return {
    state: a.state,
    needs_next_order: a.order.needed,
    next_order: a.order.needed ? { quantity_cu: a.order.quantity_cu, cost_usd: a.order.cost_usd, raise_by: a.dates.raise_by, raise_on: a.dates.raise_on, lands_on: a.dates.lands_on } : null,
    covered_until: a.dates.covered_until,
  };
}

/** The same plan under an assumption the planner may want to test: what the order, the dates and the state would be. */
function sensitivity(data, v, poolId, overrides) {
  const s = assessPool(data, poolId, overrides).verdict;
  return {
    state: s.state, quantity_cu: s.order.quantity_cu, cost_usd: s.order.cost_usd, raise_by: s.dates.raise_by, lands_on: s.dates.lands_on,
    quantity_change_cu: s.order.quantity_cu - v.order.quantity_cu, lands_change_weeks: weeksBetween(v.dates.lands_on, s.dates.lands_on),
    state_changes: s.state !== v.state,
  };
}

function buildOptions(store, poolId) {
  const { ctx, verdict: v } = store.assessment(poolId);
  const data = store.data();
  const budget = budgetOf(store);
  const base = { pool_id: poolId, region: v.region_label, sku_id: v.what.order_sku, rule: RULE, budget: { ...budget, synthetic: true } };
  if (!v.order.needed) return { ...base, needed: false, pending: null, notes: [], options: [], sensitivities: [] };

  const pending = pendingApproval(store.state().decisions, poolId);
  const unit = v.what.unit_cost_usd;
  const rack = v.what.order_unit_cu;
  const min = v.what.vendor_min_cu;
  const drafted = v.order.quantity_cu;
  const lateBy = v.dates.short_weeks || 0;
  const options = [];

  // what one option would need from the approver, and whether the budget allows it
  const govern = (qty) => {
    const c = approvalCheck(store, poolId, qty);
    return { needs_second_approver: c.needs_second_approver, over_budget_usd: c.budget.over_budget_usd, budget_after_usd: c.budget.after_usd, second_approver_above_usd: c.second_approver_above_usd };
  };
  const orderNow = (key, title, qty, summary, tradeoff) => {
    const after = afterOrder(data, v, poolId, qty);
    return { key, title, summary, tradeoff, places_order: true, quantity_cu: qty, cost_usd: qty * unit, raise_on: v.dates.raise_on, lands_on: v.dates.lands_on, weeks_late: lateBy, after, governance: govern(qty) };
  };
  const notes = [];
  const sizedFor = (weeks) => `Sized to cover ${weeks} weeks after landing`;

  // 1. as drafted
  const asDrafted = orderNow('as-drafted', 'Order as drafted', drafted, '', 'Closes the gap in one order.');
  asDrafted.covers_until = v.dates.covered_until;
  asDrafted.summary = `${cu(drafted)} of ${v.what.order_sku} (${usd(asDrafted.cost_usd)}), landing ${fmt(v.dates.lands_on)}. ${sizedFor(data.policy.cover_weeks)}${v.dates.covered_until ? `: demand stays covered until ${fmt(v.dates.covered_until)}` : ''}.`;
  options.push(asDrafted);

  // 2. phase it: size for half the cover window, and say when the rest has to be ordered. Not offered when that only makes a late pool later:
  //    if the second order would already have been due, all phasing does is add an overdue order.
  const phaseWeeks = Math.max(1, Math.round(data.policy.cover_weeks / 2));
  const phased = assessPool(data, poolId, { cover_weeks: phaseWeeks }).verdict;
  if (phased.order.needed && phased.order.quantity_cu > 0 && phased.order.quantity_cu < drafted) {
    const o = orderNow('phase', `Order ${cu(phased.order.quantity_cu)} now, size the rest later`, phased.order.quantity_cu, '', '');
    const next = o.after.next_order;
    if (next && next.raise_by <= data.as_of) {
      notes.push(`Phasing is not offered: the second order, ${cu(next.quantity_cu)}, would already have been due on ${fmt(next.raise_by)}. This pool is late, so ordering less now only adds a second late order.`);
    } else {
      o.covers_until = phased.dates.covered_until;
      o.tradeoff = next ? 'Less cash now. It needs a second order, with its own approval and its own lead time.' : 'Less cash now, sized for a shorter window. The plan still needs no further order in the next 12 months.';
      o.summary = `${sizedFor(phaseWeeks)} instead of ${data.policy.cover_weeks}: ${cu(o.quantity_cu)} (${usd(o.cost_usd)}), landing ${fmt(v.dates.lands_on)}. ${next ? `The next order, ${cu(next.quantity_cu)}, has to be raised by ${fmt(next.raise_by)}.` : 'The plan then needs no further order in the next 12 months.'}`;
      options.push(o);
    }
  }

  // 3. fit the budget: only offered when the drafted order does not fit
  const remaining = budget.remaining_usd;
  if (asDrafted.cost_usd > remaining) {
    const fit = Math.floor(Math.max(0, remaining) / unit / rack) * rack;
    if (fit >= min && fit > 0 && fit < drafted) {
      const o = orderNow('fit-budget', 'Order what the budget allows', fit, '', 'Stays inside the budget. The gap is not closed: a further order is still needed.');
      o.covers_until = null;
      o.summary = `${cu(fit)} (${usd(o.cost_usd)}), the most whole racks of ${rack} that fit the ${usd(remaining)} left.${o.after.next_order ? ` ${cu(o.after.next_order.quantity_cu)} is still needed, to be raised by ${fmt(o.after.next_order.raise_by)}.` : ''}`;
      options.push(o);
    } else {
      notes.push(`The ${usd(Math.max(0, remaining))} left in the budget cannot buy the vendor's minimum order of ${cu(min)}, so no order fits it.`);
    }
  }

  // 4. wait: shown so that its cost can be seen
  const landsLater = addWeeks(v.dates.lands_on, WAIT_WEEKS);
  options.push({
    key: 'wait', title: `Wait ${WAIT_WEEKS} weeks`, places_order: false, quantity_cu: 0, cost_usd: 0, raise_on: null, lands_on: landsLater, weeks_late: lateBy + WAIT_WEEKS,
    summary: `Nothing is ordered today. Capacity would land ${fmt(landsLater)}, ${lateBy + WAIT_WEEKS} weeks after it is needed instead of ${lateBy}. The order is sized again when it is placed.`,
    tradeoff: 'Costs nothing today and makes the shortfall longer. It is what happens if nobody decides.',
    after: { state: v.state, needs_next_order: true, next_order: null, covered_until: null },
    governance: { needs_second_approver: false, over_budget_usd: 0, budget_after_usd: budget.committed_usd, second_approver_above_usd: data.policy.approval.second_approver_above_usd },
  });

  // the recommendation, by the stated rule
  const fitsBudget = (o) => o.governance.over_budget_usd === 0;
  const pick = fitsBudget(asDrafted) ? 'as-drafted' : options.some((o) => o.key === 'fit-budget') ? 'fit-budget' : 'as-drafted';
  for (const o of options) { o.recommended = o.key === pick; o.fits_budget = fitsBudget(o); }
  const ordered = [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];

  // what would change the answer: the same plan, under two assumptions the planner is likely to ask about
  const sens = [];
  const quoted = ctx.vendor ? ctx.vendor.quoted_lead_weeks : null;
  if (quoted && quoted !== v.lead.weeks) sens.push({ key: 'lead-at-quote', ask: `If the vendor met its quoted lead time (${quoted} weeks, not ${v.lead.weeks})`, ...sensitivity(data, v, poolId, { lead_time_weeks: quoted }) });
  if (v.forecast.slope_pts_per_week > 0) sens.push({ key: 'growth-plus-25', ask: 'If usage kept growing 25% faster than the forecast', ...sensitivity(data, v, poolId, { growth_pts_per_week: v.forecast.slope_pts_per_week * 1.25 }) });

  return { ...base, needed: true, pending: pending ? { decision_id: pending.decision_id, decided_by: pending.decided_by, quantity_cu: pending.quantity_cu } : null, drafted_quantity_cu: drafted, notes, options: ordered, sensitivities: sens };
}

module.exports = { buildOptions, afterOrder, RULE, WAIT_WEEKS };
