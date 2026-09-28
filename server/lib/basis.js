'use strict';
/*
 * What a decision was based on. A decision record already keeps the plan as it was drafted (state, quantity, cost, dates).
 * This adds the rest of what a later reader needs to reconstruct the moment: which dataset and which forecast, exactly, and a
 * fingerprint of the whole plan. Without it, "the forecast the planner saw" cannot be recovered afterwards, because the engine
 * refits on every load. It is part of the record, so it is covered by the hash chain: editing it breaks the chain.
 */

const crypto = require('node:crypto');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * A fingerprint of a plan: the same data and settings always give the same one, and any change to the state, the order, the
 * dates, the lead time, the forecast it was built on, the capacity or what any funnel said gives a different one.
 */
function planHash(v) {
  return sha(JSON.stringify({
    pool_id: v.pool_id, state: v.state, priority: v.priority,
    order: { needed: v.order.needed, quantity_cu: v.order.quantity_cu, cost_usd: v.order.cost_usd, sku: v.what.order_sku },
    dates: { needed_by: v.dates.needed_by, raise_by: v.dates.raise_by, raise_on: v.dates.raise_on, lands_on: v.dates.lands_on, covered_until: v.dates.covered_until },
    lead_weeks: v.lead.weeks,
    forecast: v.forecast.input_hash,
    capacity: { installed: v.capacity.installed, usable_now: v.capacity.usable_now },
    funnels: v.trace.map((t) => [t.number, t.status, t.severity]),
  }));
}

/** The basis stored on a decision record. */
function decisionBasis(data, state, v) {
  return {
    dataset_version: data.meta.dataset_version,
    advanced_weeks: state.advance.weeks,
    forecast: { contract: v.forecast.contract, model: v.forecast.model, input_hash: v.forecast.input_hash },
    plan_hash: planHash(v),
    lead_weeks: v.lead.weeks,
    driver: v.driver ? v.driver.id : null,
    funnels: v.trace.map((t) => [t.number, t.status, t.severity]),
  };
}

module.exports = { planHash, decisionBasis };
