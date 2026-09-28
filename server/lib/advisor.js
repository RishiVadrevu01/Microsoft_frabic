'use strict';
/*
 * The AI advisor's facts (stage 6). The advisor explains; it does not compute. Everything it is told here was already produced by
 * the engine, the planner (options.js) or the governance rules (approval.js), and is handed over as a string to copy, so the
 * existing check (explain.js) that every date, SKU and number in its text appears in the facts covers all of it.
 *
 * The questions a person asks of a plan, and where each answer comes from:
 *   Why now?                 the funnels and what sets the date        (already in the packet)
 *   What changed?            the last decision on this pool and the plan's fingerprint (basis.js), and what the lab's clock did
 *   Alternatives?            the planner's options and the rule that recommends one
 *   What if?                 the same plan under two assumptions
 *   Risk / financial impact  the approval and budget rules, the cost of waiting
 *   Prioritize?              NOT decided here. The ranking is deterministic (summary.js); the advisor may only explain it.
 */

const { buildOptions } = require('./options');
const { approvalCheck } = require('./approval');
const { planHash } = require('./basis');
const { summarize } = require('./summary');
const { fmt } = require('./dates');
const { cu, usd } = require('./format');

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4]}`;
const PTAG = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P2', none: 'P2' };
const VERB = { approve: 'approved', decline: 'declined', defer: 'deferred' };
const ORDER_STATUS = { 'approved-not-placed': 'approved and not yet placed', ordered: 'placed with the vendor', 'in-transit': 'in transit', racked: 'arrived' };

/** What is different from the last time someone looked: the last decision on this pool, and how far the lab's clock has moved. */
function whatChanged(store, poolId, v) {
  const state = store.state();
  const data = store.data();
  const lines = [];
  const last = state.decisions.filter((d) => d.pool_id === poolId).at(-1);
  if (last) {
    const who = `${last.decided_by} ${VERB[last.decision]}${last.quantity_cu ? ` ${cu(last.quantity_cu)}` : ''} on ${fmt(last.as_of)}`;
    if (last.approval && last.approval.state === 'awaiting-second') {
      lines.push(`${who}. It is waiting for a second, different named person.`);
    } else if (last.order_id) {
      const o = data.supply.find((s) => s.order_id === last.order_id);
      lines.push(`${who}. Order ${last.order_id} is ${o ? `${ORDER_STATUS[o.status] || o.status}, landing ${fmt(o.lands_on)}` : 'in flight'}.`);
    } else {
      const same = last.basis && last.basis.plan_hash === planHash(v);
      if (same) lines.push(`${who}. The plan has not changed since.`);
      else {
        const d = last.drafted;
        const diffs = [];
        if (d.state !== v.state) diffs.push(`the state was ${d.state} and is now ${v.state}`);
        if (d.quantity_cu !== v.order.quantity_cu) diffs.push(`the drafted order was ${cu(d.quantity_cu)} and is now ${cu(v.order.quantity_cu)}`);
        if (d.lands_on !== v.dates.lands_on) diffs.push(`it was to land ${fmt(d.lands_on)} and is now to land ${fmt(v.dates.lands_on)}`);
        lines.push(`${who}. Since then the plan has changed: ${diffs.length ? diffs.join('; ') : 'the evidence behind it has moved'}.`);
      }
    }
  }
  if (state.advance.weeks > 0 && state.ledger.length) {
    const then = state.ledger[0].pools[poolId].plan;
    lines.push(`Since the lab moved on ${state.advance.weeks} week${state.advance.weeks === 1 ? '' : 's'} (from ${fmt(state.ledger[0].origin_as_of)} to ${fmt(data.as_of)}): the plan read ${then.state}${then.order_needed ? ` with an order of ${cu(then.quantity_cu)} landing ${fmt(then.lands_on)}` : ' with no order needed'}, and now reads ${v.state}${v.order.needed ? ` with an order of ${cu(v.order.quantity_cu)} landing ${fmt(v.dates.lands_on)}` : ' with no order needed'}.`);
  }
  if (!lines.length) lines.push('Nothing has been decided on this pool and the lab has not been moved, so there is nothing to compare this plan with.');
  return lines.slice(0, 3);
}

/** The facts the advisor may use beyond the plan itself. */
function advisorFacts(store, poolId) {
  const { verdict: v } = store.assessment(poolId);
  const facts = { what_changed: whatChanged(store, poolId, v) };
  if (!v.order.needed) return facts;

  const o = buildOptions(store, poolId);
  const c = approvalCheck(store, poolId, null);
  const needsOf = (opt) => {
    if (!opt.places_order) return ['nothing to approve'];
    const n = [];
    if (opt.governance.needs_second_approver) n.push('a second, different named person');
    if (opt.governance.over_budget_usd > 0) n.push(`a reason, because it is ${usd(opt.governance.over_budget_usd)} over the budget`);
    return n.length ? n : ['one approver, within the budget'];
  };
  facts.options = o.options.map((opt) => ({
    option: opt.title, recommended: opt.recommended, order: opt.places_order ? cu(opt.quantity_cu) : 'none', cost: opt.places_order ? usd(opt.cost_usd) : '$0', lands: fmt(opt.lands_on),
    then: !opt.places_order ? 'the shortfall grows' : opt.after.next_order ? `still needs ${cu(opt.after.next_order.quantity_cu)} by ${fmt(opt.after.next_order.raise_by)}` : 'no further order in the next 12 months',
    approver_needs: needsOf(opt),
  }));
  if (o.notes.length) facts.options_not_offered = o.notes;
  facts.how_recommended = o.rule;
  facts.approval_needed = c.notes.join(' ');
  facts.budget = `${c.budget.label}: ${usd(c.budget.committed_usd)} committed of ${usd(c.budget.budget_usd)}, ${usd(c.budget.remaining_usd)} left. Both the budget and the thresholds are synthetic.`;
  if (o.sensitivities.length) facts.if_it_changed = o.sensitivities.map((s) => `${s.ask}: an order of ${cu(s.quantity_cu)}, to be raised by ${fmt(s.raise_by)}, landing ${fmt(s.lands_on)}.`);
  const wait = o.options.find((x) => x.key === 'wait');
  if (wait) facts.cost_of_waiting = wait.summary;

  // The ranking is the engine's, not the advisor's. It is given so the advisor can say why, never to change it.
  const ranked = summarize(store.verdicts(), store.data(), {}).actions;
  const openIds = store.verdicts().filter((x) => x.order.needed).map((x) => x.pool_id);
  const position = ranked.filter((a) => openIds.includes(a.pool_id)).findIndex((a) => a.pool_id === poolId) + 1;
  facts.priority_explained = `Priority ${PTAG[v.priority]} (${v.priority}). Of ${openIds.length} open order${openIds.length === 1 ? '' : 's'} this ranks ${ordinal(position)}, by state (${v.state}), then priority, then how soon the order has to be raised. The ranking is fixed by the engine.`;
  return facts;
}

module.exports = { advisorFacts, whatChanged };
