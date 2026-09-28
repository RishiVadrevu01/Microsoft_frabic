'use strict';
/*
 * The human approval step. The engine drafts; a named person decides.
 *
 * Guardrails (all enforced here, not in the browser):
 *  - the decider must be a person's name, never the engine that proposed the plan
 *  - approving a different quantity than drafted needs a reason
 *  - declining or deferring needs a reason; the planner may name the funnel they dispute
 *  - approval must be a whole number of racks
 *  - spend over the budget needs a reason; an order above the policy threshold needs a second, different named person (approval.js)
 *  - every record is hash-chained to the one before it, so the log cannot be edited quietly
 *  - every record keeps what it was based on: the dataset, the forecast, a fingerprint of the plan (basis.js)
 * Approving places an order into the supply pipeline, so the plan then shows it as in flight. An approval that is waiting for a
 * second person places nothing: the plan still shows the need until they countersign.
 */

const crypto = require('node:crypto');
const { HttpError } = require('./store');
const { decisionBasis } = require('./basis');
const { approvalCheck, pendingApproval, costOf } = require('./approval');
const { cu, usd } = require('./format');

const DECISIONS = ['approve', 'decline', 'defer'];

function decide(store, poolId, body) {
  const { verdict } = store.assessment(poolId);
  const data = store.data();
  const policy = data.policy;

  const decision = String(body.decision || '');
  if (!DECISIONS.includes(decision)) throw new HttpError(400, `decision must be one of ${DECISIONS.join(', ')}`);

  const by = String(body.decided_by || '').trim();
  if (by.length < 2 || by.length > 60) throw new HttpError(400, 'decided_by must be the name of the person deciding (2 to 60 characters).');
  if (policy.decisions.blocked_deciders.includes(by.toLowerCase())) {
    throw new HttpError(400, 'The engine that drafted the plan cannot approve it. A person has to decide.');
  }

  if (!verdict.order.needed) throw new HttpError(409, 'There is no open order on this pool, so there is nothing to decide.');

  const reason = String(body.reason || '').trim();
  if (reason.length > 400) throw new HttpError(400, 'reason is limited to 400 characters.');

  const flaggedIds = verdict.trace.filter((t) => t.status === 'flagged').map((t) => t.id);
  const disputed = body.disputed_funnel ? String(body.disputed_funnel) : null;
  if (disputed && !flaggedIds.includes(disputed)) throw new HttpError(400, `disputed_funnel must be one of the funnels flagged on this pool: ${flaggedIds.join(', ')}`);

  const drafted = {
    state: verdict.state, quantity_cu: verdict.order.quantity_cu, cost_usd: verdict.order.cost_usd, order_sku: verdict.what.order_sku,
    raise_on: verdict.dates.raise_on, lands_on: verdict.dates.lands_on, driver: verdict.driver ? verdict.driver.id : null,
  };

  // ---- governance (approval.js): the budget, and a second person for a large order
  const records = store.state().decisions;
  const pending = pendingApproval(records, poolId);
  const limit = policy.approval;
  let quantity = null;
  let override = false;
  let approval = null;
  let check = null;
  let countersigns = null;
  let cancels = null;
  if (decision === 'approve' && pending) {
    // The second person agrees to what was approved. They do not change it.
    if (by.toLowerCase() === pending.decided_by.toLowerCase()) throw new HttpError(400, `${pending.decided_by} gave the first approval. A different named person has to countersign it.`);
    const asked = body.quantity_cu == null || body.quantity_cu === '' ? pending.quantity_cu : Number(body.quantity_cu);
    if (asked !== pending.quantity_cu) throw new HttpError(409, `An approval of ${cu(pending.quantity_cu)} is waiting for a second person. Countersign that quantity, or decline it and start again.`);
    quantity = pending.quantity_cu;
    override = pending.override;
    countersigns = pending.decision_id;
    check = approvalCheck(store, poolId, quantity);
    approval = { required: 2, state: 'complete', threshold_usd: limit.second_approver_above_usd, first_by: pending.decided_by, first_decision: pending.decision_id };
  } else if (decision === 'approve') {
    check = approvalCheck(store, poolId, body.quantity_cu);      // also refuses a quantity that is not whole racks
    quantity = check.quantity_cu;
    override = quantity !== drafted.quantity_cu;
    if (override && reason.length < 5) throw new HttpError(400, 'You changed the drafted quantity. Say why in the reason field (at least 5 characters).');
    if (check.budget.over_budget_usd > 0 && reason.length < 5) {
      throw new HttpError(400, `This order takes committed spend to ${usd(check.budget.after_usd)}, ${usd(check.budget.over_budget_usd)} over the ${usd(limit.budget_usd)} budget. Say why in the reason field (at least 5 characters).`);
    }
    approval = check.needs_second_approver
      ? { required: 2, state: 'awaiting-second', threshold_usd: limit.second_approver_above_usd, reason: `An order of ${usd(check.cost_usd)} is above ${usd(limit.second_approver_above_usd)}` }
      : { required: 1, state: 'complete', threshold_usd: limit.second_approver_above_usd };
  } else {
    if (reason.length < 5) throw new HttpError(400, `A reason is needed to ${decision} (at least 5 characters).`);
    if (pending) cancels = pending.decision_id;        // declining or deferring withdraws the approval that was waiting
  }

  const prev = records.at(-1);
  const core = {
    decision_id: store.nextId('decision'), pool_id: poolId, decision, decided_by: by, decided_at: new Date().toISOString(),
    reason: reason || null, disputed_funnel: disputed, quantity_cu: quantity, override, drafted,
    as_of: data.as_of, policy_version: policy.policy_version, basis: decisionBasis(data, store.state(), verdict),
    ...(check ? { cost_usd: check.cost_usd, approval, budget: { budget_usd: limit.budget_usd, committed_before_usd: check.budget.committed_usd, over_budget_usd: check.budget.over_budget_usd } } : {}),
    ...(countersigns ? { countersigns } : {}),
    ...(cancels ? { cancels } : {}),
    prev_hash: prev ? prev.hash : '0'.repeat(64),
  };
  const record = { ...core, hash: crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex') };

  let order = null;
  if (decision === 'approve' && approval.state === 'complete') {
    order = {
      order_id: store.nextId('order'), pool_id: poolId, sku_id: verdict.what.order_sku, cu: quantity,
      placed_on: verdict.dates.raise_on, lands_on: verdict.dates.lands_on, status: 'approved-not-placed',
    };
    record.order_id = order.order_id;
  }
  store.recordDecision(record, order);
  return { record, order };
}

// Recompute the chain to prove the log was not edited.
function verifyChain(records) {
  let prev = '0'.repeat(64);
  for (const r of records) {
    const { hash, order_id, ...core } = r;
    if (core.prev_hash !== prev) return { ok: false, broken_at: r.decision_id };
    if (crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex') !== hash) return { ok: false, broken_at: r.decision_id };
    prev = hash;
  }
  return { ok: true, records: records.length };
}

function stats(records) {
  const count = (d) => records.filter((r) => r.decision === d).length;
  // An approval waiting for a second person is not yet an approval: it counts once, when it is countersigned.
  const approved = records.filter((r) => r.decision === 'approve' && !(r.approval && r.approval.state === 'awaiting-second'));
  const disputed = {};
  for (const r of records) if (r.disputed_funnel) disputed[r.disputed_funnel] = (disputed[r.disputed_funnel] || 0) + 1;
  const waiting = [...new Set(records.map((r) => r.pool_id))].map((id) => pendingApproval(records, id)).filter(Boolean);
  return {
    total: records.length,
    approved: approved.length, declined: count('decline'), deferred: count('defer'), awaiting_second: waiting.length,
    overrides: records.filter((r) => r.override && !(r.approval && r.approval.state === 'awaiting-second')).length,
    approved_cu: approved.reduce((a, r) => a + r.quantity_cu, 0),
    approved_cost_usd: approved.reduce((a, r) => a + costOf(r), 0),
    disputed_funnels: Object.entries(disputed).map(([funnel, n]) => ({ funnel, count: n })).sort((a, b) => b.count - a.count),
  };
}

module.exports = { decide, verifyChain, stats, DECISIONS };
