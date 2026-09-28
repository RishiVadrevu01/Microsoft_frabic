'use strict';
/*
 * Governance on an approval (stage 8): what the policy asks of an approval before it becomes an order.
 *
 *   budget            the approvals may commit `policy.approval.budget_usd` in the period. Going over is allowed, on a reason:
 *                     the person who knows why should say why, and it is on the record.
 *   second approver   an order costing more than `second_approver_above_usd` needs a second, DIFFERENT named person to
 *                     countersign it. Until they do, no order is placed and the plan still shows the need.
 *
 * The lab has no sign-in, so a "named person" is a name that was typed, and "different" means a different name. This is a
 * control on the record and the workflow, not authentication. Both numbers are synthetic (data/seed.js says so).
 *
 * One function, `approvalCheck`, answers "what would this approval need?" for the screen and for the write path alike, so what
 * the person is told before they decide is exactly what is enforced when they do.
 */

const { HttpError } = require('./store');
const { cu, usd } = require('./format');
const { fmt } = require('./dates');

/** The approval on this pool that is waiting for a second person, if there is one. */
function pendingApproval(records, poolId) {
  const mine = records.filter((r) => r.pool_id === poolId);
  const closed = new Set(mine.flatMap((r) => [r.countersigns, r.cancels]).filter(Boolean));
  return mine.filter((r) => r.approval && r.approval.state === 'awaiting-second' && !closed.has(r.decision_id)).at(-1) || null;
}

const costOf = (r) => (Number.isFinite(r.cost_usd) ? r.cost_usd : r.quantity_cu * (r.drafted.cost_usd / r.drafted.quantity_cu));

/** The budget as it stands: what completed approvals have committed, and what is waiting for a second person. */
function budgetOf(store) {
  const a = store.data().policy.approval;
  const records = store.state().decisions;
  const committed = records.filter((r) => r.decision === 'approve' && r.order_id).reduce((s, r) => s + costOf(r), 0);
  const waiting = [...new Set(records.map((r) => r.pool_id))].map((id) => pendingApproval(records, id)).filter(Boolean);
  const pending = waiting.reduce((s, r) => s + costOf(r), 0);
  return {
    label: a.budget_label, budget_usd: a.budget_usd, committed_usd: committed, pending_usd: pending,
    remaining_usd: a.budget_usd - committed, waiting: waiting.map((r) => ({ decision_id: r.decision_id, pool_id: r.pool_id, decided_by: r.decided_by, quantity_cu: r.quantity_cu, cost_usd: costOf(r) })),
  };
}

/**
 * What approving `quantityCu` (default: the drafted quantity) on this pool would need.
 * @returns {object} cost, whether a second person is needed, the budget before and after, what is waiting, and sentences for the screen
 */
function approvalCheck(store, poolId, quantityCu) {
  const { verdict } = store.assessment(poolId);
  const a = store.data().policy.approval;
  const unit = verdict.what.unit_cost_usd;
  const pending = pendingApproval(store.state().decisions, poolId);
  // With nothing asked, the quantity in question is the one waiting for a second person if there is one, else the drafted quantity.
  const qty = quantityCu == null || quantityCu === '' ? (pending ? pending.quantity_cu : verdict.order.quantity_cu) : Number(quantityCu);
  if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, 'quantity_cu must be a positive whole number.');
  const rack = verdict.what.order_unit_cu;
  if (verdict.order.needed && qty % rack !== 0) throw new HttpError(400, `quantity_cu must be a whole number of racks (a multiple of ${rack}).`);

  const cost = qty * unit;
  const budget = budgetOf(store);
  const after = budget.committed_usd + cost;
  const over = Math.max(0, after - a.budget_usd);
  const needsSecond = cost > a.second_approver_above_usd;

  const notes = [];
  if (pending) {
    notes.push(`${pending.decided_by} approved ${cu(pending.quantity_cu)} (${usd(costOf(pending))}) on ${fmt(pending.as_of)} and it is waiting for a second, different named person. Countersign that quantity, or decline it.`);
  } else {
    if (needsSecond) notes.push(`An order of ${usd(cost)} is above ${usd(a.second_approver_above_usd)}, so a second, different named person has to countersign it. No order is placed until they do.`);
    if (over > 0) notes.push(`This takes committed spend to ${usd(after)}, ${usd(over)} over the ${usd(a.budget_usd)} budget. A reason is required.`);
    else notes.push(`${usd(budget.committed_usd)} of the ${usd(a.budget_usd)} budget is committed; this order would leave ${usd(a.budget_usd - after)}.`);
  }
  return {
    pool_id: poolId, quantity_cu: qty, unit_cost_usd: unit, cost_usd: cost,
    needs_second_approver: needsSecond, second_approver_above_usd: a.second_approver_above_usd,
    budget: { ...budget, after_usd: after, over_budget_usd: over, synthetic: true },
    pending: pending ? { decision_id: pending.decision_id, decided_by: pending.decided_by, decided_at: pending.decided_at, quantity_cu: pending.quantity_cu, cost_usd: costOf(pending), reason_for_second: pending.approval.reason } : null,
    notes,
    caveat: 'The lab has no sign-in: a named person is a name that was typed, and different means a different name.',
  };
}

module.exports = { approvalCheck, budgetOf, pendingApproval, costOf };
