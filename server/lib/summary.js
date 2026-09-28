'use strict';
// Fleet-level answers: "Are we good for the next 3, 6 and 12 months?", the KPI
// strip, and a ranked action list. Pure arithmetic over the pool verdicts.

const { fmt } = require('./dates');
const { cu, usd } = require('./format');

const STATE_RANK = { OVERDUE: 5, 'ORDER NOW': 4, PLAN: 3, WATCH: 2, OK: 1 };
const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// Trim a full verdict to what a list needs.
function brief(v) {
  return {
    pool_id: v.pool_id, region: v.region, region_label: v.region_label, sku_id: v.sku_id, sku_class: v.sku_class,
    state: v.state, priority: v.priority, headline: v.headline, reasons: v.reasons,
    utilization_of_usable: v.capacity.utilization_of_usable, usable_now: v.capacity.usable_now, installed: v.capacity.installed,
    free_now: v.capacity.free_now,
    order_sku: v.what.order_sku, quantity_cu: v.order.quantity_cu, cost_usd: v.order.cost_usd, order_needed: v.order.needed,
    needed_by: v.dates.needed_by, raise_by: v.dates.raise_by, lands_on: v.dates.lands_on, covered_until: v.dates.covered_until,
    overdue_days: v.dates.overdue_days, lead_weeks: v.lead.weeks,
    horizons: v.horizons, driver: v.driver, flagged_count: v.flagged_count,
    reclaim_cu: v.reclaim.cu, reclaim_value_usd: v.reclaim.value_usd,
  };
}

function headlineFor(verdicts) {
  const n = verdicts.length;
  const by = (s) => verdicts.filter((v) => v.state === s).length;
  const overdue = by('OVERDUE'); const now = by('ORDER NOW'); const plan = by('PLAN');
  if (overdue) return `No. ${overdue} of ${n} pools ${overdue === 1 ? 'is' : 'are'} already past the date an order should have been placed, and ${now} more ${now === 1 ? 'needs' : 'need'} an order now.`;
  if (now) return `Not yet. ${now} of ${n} pools ${now === 1 ? 'needs' : 'need'} an order placed now to stay ahead of demand.`;
  if (plan) return `Yes for now. ${plan} of ${n} pools will need an order within six months.`;
  return `Yes. All ${n} pools are good for the next 12 months.`;
}

function summarize(verdicts, data, decisionByPool = {}) {
  const P = data.policy;
  const horizons = P.horizons_weeks.map((w, i) => {
    const groups = { good: [], act: [], 'at-risk': [] };
    for (const v of verdicts) groups[v.horizons[i].status].push(v.pool_id);
    const label = verdicts[0].horizons[i].label;
    const answer = groups['at-risk'].length ? 'At risk' : groups.act.length ? 'Act' : 'Good';
    return { weeks: w, label, answer, good: groups.good, act: groups.act, at_risk: groups['at-risk'] };
  });

  const ranked = [...verdicts].sort((a, b) =>
    STATE_RANK[b.state] - STATE_RANK[a.state]
    || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
    || (a.dates.raise_by || '9999').localeCompare(b.dates.raise_by || '9999'));

  const needing = verdicts.filter((v) => v.order.needed);
  const atRisk6 = verdicts.filter((v) => v.horizons.find((h) => h.weeks === 26).status === 'at-risk');
  const kpis = {
    total_capacity_cu: verdicts.reduce((a, v) => a + v.capacity.usable_now, 0),
    installed_cu: verdicts.reduce((a, v) => a + v.capacity.installed, 0),
    at_risk_capacity_cu: atRisk6.reduce((a, v) => a + v.capacity.usable_now, 0),
    at_risk_pools: atRisk6.length,
    open_actions: needing.length,
    order_cu: needing.reduce((a, v) => a + v.order.quantity_cu, 0),
    order_cost_usd: needing.reduce((a, v) => a + v.order.cost_usd, 0),
    reclaim_cu: verdicts.reduce((a, v) => a + v.reclaim.cu, 0),
    reclaim_value_usd: verdicts.reduce((a, v) => a + v.reclaim.value_usd, 0),
  };

  return {
    as_of: data.as_of,
    dataset_version: data.meta.dataset_version,
    policy_version: P.policy_version,
    source: 'synthetic',
    kpis,
    headline: headlineFor(verdicts),
    horizons,
    actions: ranked.map((v) => ({ ...brief(v), decision: decisionByPool[v.pool_id] || null })),
  };
}

// Before/after lines for the "what changed" card.
function diffVerdicts(before, after) {
  const row = (label, b, a) => ({ label, before: b, after: a, changed: b !== a });
  const money = (v) => (v.order.needed ? usd(v.order.cost_usd) : '—');
  const qty = (v) => (v.order.needed ? cu(v.order.quantity_cu) : 'no order');
  return [
    row('State', before.state, after.state),
    row('Order', qty(before), qty(after)),
    row('Cost', money(before), money(after)),
    row('Raise the order by', fmt(before.dates.raise_by), fmt(after.dates.raise_by)),
    row('Capacity lands', fmt(before.dates.lands_on), fmt(after.dates.lands_on)),
    row('Capacity needed by', fmt(before.dates.needed_by), fmt(after.dates.needed_by)),
    row('Priority', before.priority, after.priority),
    row('Funnels flagged', String(before.flagged_count), String(after.flagged_count)),
  ];
}

module.exports = { summarize, brief, diffVerdicts, headlineFor, STATE_RANK };
