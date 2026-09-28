'use strict';
/*
 * PLANNING: the one place where supply and demand meet.
 *
 *   SUPPLY VIEW      Capacity available   Pool capacity   Utilization   Headroom       Health           Cost
 *   DEMAND VIEW      Product demand       Workload forecast   Growth    Pipeline       Business events  Capacity requests
 *                                     both feed
 *   BALANCE / PLAN   each pool's supply against its demand at a horizon, and the plan that closes the gap
 *
 * It replaces the split between the Central Capacity (provider) and Product Team (requester) views: they were two people's
 * views of the same numbers, and here they are two sides of one plan. Nothing in this file is a new model. Every figure is
 * arithmetic over what the engine already computed for the pool pages (the same assessments, the same timeline), so this page
 * cannot disagree with them: the product demand here is the Overview's total demand, and the balance's shortfall is the
 * Overview's projected shortfall (test/planning.test.js pins both).
 *
 * Definitions worth knowing (each is also returned beside its figure):
 *   supply at a horizon   installed usable capacity plus every order in flight that lands by then, in each pool's own units
 *   demand at a horizon   the demand we plan for: forecast p80, weighted pipeline, dated step-ups, a seasonal spike while it
 *                         runs (the timeline's plan_p80). A region or the total is combined as one distribution, not by
 *                         adding each pool's p80
 *   working ceiling       the share of capacity a pool may run at; capacity beyond it is the reserve
 *   balance               supply at the ceiling less demand, per pool. Negative is a shortfall, and a surplus in one pool
 *                         cannot cover a shortfall in another
 */

const { addWeeks } = require('./dates');
const { assessRequests } = require('./requests');
const { classify } = require('./requester');
const { incidentHealth } = require('./funnels');
const { aggregatorFor } = require('./aggregate');
const { scopeOf, GEO, SKU_GROUPS, HORIZONS } = require('./overview');
const { cu, usd, pct } = require('./format');

const HEALTH_FUNNELS = ['reliability', 'performance', 'dependency'];
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);
const round = (x) => Math.round(x);
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
const ratio = (now, before) => (before > 0 ? now / before - 1 : null);

const tile = (key, label, value, unit, note, definition, extra = {}) => ({ key, label, value, unit, note, definition, ...extra });

/**
 * @param {object} store the lab store
 * @param {{horizon?:13|26|52, sku?:string, region?:string}} [q]
 */
function buildPlanning(store, q = {}) {
  const data = store.data();
  const asOf = data.as_of;
  const P = data.policy;
  const H = HORIZONS.includes(q.horizon) ? q.horizon : 52;
  const sku = q.sku in SKU_GROUPS ? q.sku : 'all';
  const region = q.region in GEO ? q.region : 'all';
  const horizonLabel = `${(H / 13) * 3} months`;
  const { everything, scope } = scopeOf(store, { sku, region });
  const agg = aggregatorFor(everything);
  const n = scope.length;
  const regions = new Set(scope.map((a) => a.ctx.pool.geo)).size;

  // ================================================================ SUPPLY
  const supplyRows = scope.map((a) => {
    const c = a.ctx; const v = a.verdict;
    const ceiling = v.capacity.working_floor_pct * c.usable0;
    const inc = incidentHealth(c);
    return {
      pool_id: v.pool_id, region: v.region_label, sku_id: v.sku_id, geo: c.pool.geo,
      installed_cu: round(c.usable0), in_flight_cu: round(sum(c.inflight, (s) => s.cu * c.equiv(s))), landing_cu: round(c.usableAt(H) - c.usable0),
      free_cu: round(v.capacity.free_now), used_cu: round(c.latest), utilization: c.latest / c.usable0,
      ceiling_pct: v.capacity.working_floor_pct, headroom_cu: round(Math.max(0, ceiling - c.latest)), above_ceiling: c.latest > ceiling,
      health: a.results.filter((r) => HEALTH_FUNNELS.includes(r.id) && r.flagged && !r.context_only).map((r) => r.name),
      incidents_90d: inc.recent.length, sev12_90d: inc.sev12,
      value_usd: round(c.usable0 * c.sku.unit_cost_usd), reclaim_usd: round(v.reclaim.value_usd), order_usd: v.order.needed ? round(v.order.cost_usd) : 0,
    };
  });
  // Totals come from the exact figures, not from summing the rounded rows, so they agree with the other pages to the unit.
  const usable = sum(scope, (a) => a.ctx.usable0);
  const used = sum(scope, (a) => a.ctx.latest);
  const freeNow = round(sum(scope, (a) => a.verdict.capacity.free_now));
  const landing = round(sum(scope, (a) => a.ctx.usableAt(H) - a.ctx.usable0));
  const headroom = round(sum(scope, (a) => Math.max(0, a.verdict.capacity.working_floor_pct * a.ctx.usable0 - a.ctx.latest)));
  const inFlight = round(sum(scope, (a) => sum(a.ctx.inflight, (s) => s.cu * a.ctx.equiv(s))));
  const above = supplyRows.filter((r) => r.above_ceiling).length;
  const unhealthy = supplyRows.filter((r) => r.health.length);
  const incidents = sum(supplyRows, (r) => r.incidents_90d);
  const busiest = [...supplyRows].sort((x, y) => y.utilization - x.utilization)[0];
  const supplyTiles = [
    tile('available', 'Capacity available', freeNow, 'cu',
      landing > 0 ? `${cu(landing)} more lands within ${horizonLabel}` : `Nothing lands within ${horizonLabel}`,
      'Capacity that is installed, usable and not reserved by any team today. Supply already ordered is shown in the note: it lands within the horizon.',
      { share: usable > 0 ? freeNow / usable : 0 }),
    tile('pool_capacity', 'Pool capacity', round(usable), 'cu',
      `${plural(n, 'pool')} in ${plural(regions, 'region')}${inFlight > 0 ? `, ${cu(inFlight)} more in flight` : ''}`,
      'Installed usable capacity across the pools in scope, in Capacity Units (each pool in its own SKU\'s units, as everywhere in the lab).'),
    tile('utilization', 'Utilization', usable > 0 ? used / usable : 0, 'pct',
      busiest ? `Busiest: ${busiest.region} at ${pct(busiest.utilization)}` : 'No pools in scope',
      'What teams use today as a share of usable capacity, across the pools in scope (the latest weekly reading).'),
    tile('headroom', 'Headroom', headroom, 'cu',
      `${pct(usable > 0 ? headroom / usable : 0)} of capacity is below the working ceilings${above ? `; ${plural(above, 'pool')} already above ${above === 1 ? 'its' : 'their'} ceiling` : ''}`,
      'Capacity left before each pool reaches its working ceiling (85% for general compute, 80% for GPU, lower where users already feel strain), added up per pool: a pool above its ceiling contributes nothing, it does not borrow from another.'),
    tile('health', 'Health', unhealthy.length, 'count_of',
      `${plural(incidents, 'incident')} in the last 90 days${sum(supplyRows, (r) => r.sev12_90d) ? `, ${sum(supplyRows, (r) => r.sev12_90d)} of them severity 1 or 2` : ''}`,
      'Pools flagged by the reliability, performance or dependency funnels. Incidents are those recorded in the last 90 days.',
      { of: n }),
    tile('cost', 'Cost', round(sum(scope, (a) => a.ctx.usable0 * a.ctx.sku.unit_cost_usd)), 'usd',
      `${usd(sum(scope, (a) => a.verdict.reclaim.value_usd))} of it idle and reclaimable; ${usd(sum(scope, (a) => (a.verdict.order.needed ? a.verdict.order.cost_usd : 0)))} to buy what the plans call for`,
      'Installed capacity valued at purchase cost. A one-off figure, not an annual one: the lab has no operating-cost data. The note adds the idle reservations that could be reclaimed and the cost of the orders the plans draft.'),
  ];

  // ================================================================ DEMAND
  const dateH = addWeeks(asOf, H);
  const totalNow = agg.combine(scope, H);
  const totalThen = agg.combine(scope, H, { prior: true });
  const p50 = sum(scope, (a) => a.ctx.p50At(H));
  const slope = sum(scope, (a) => a.ctx.fc.slope_per_week);
  const pipeline = sum(scope, (a) => a.ctx.pipelineAt(H));
  const pending = scope.flatMap((a) => a.ctx.requests.map((r) => ({ r, a })));
  const dueByH = pending.filter(({ r, a }) => a.ctx.hOf(r.needed_by) <= H);
  const asked = sum(pending, ({ r }) => r.cu);
  const atRisk = pending.filter(({ r, a }) => {
    const s = assessRequests(a.ctx, a.verdict).find((x) => x.request_id === r.request_id);
    return s && classify(r, s, a, asOf).atRisk;
  }).length;

  // Every dated business event and contract in the window, once (an event reaching several pools is listed once).
  const eventItems = [];
  const seen = new Set();
  for (const a of scope) {
    const c = a.ctx;
    for (const k of c.contracts) {
      if (k.effective_date < asOf || k.effective_date > dateH) continue;
      const add = Math.max(0, k.committed_cu - k.provisioned_cu);
      eventItems.push({ kind: 'contract', id: k.contract_id, title: k.customer.split(' (')[0], date: k.effective_date, cu: add, uplift_pct: null, region: a.verdict.region_label, pool_id: a.verdict.pool_id, effect: add > 0 ? `${cu(add)} more committed` : 'already provisioned' });
    }
    for (const e of c.events) {
      if (seen.has(e.event_id) || e.date < asOf || e.date > dateH) continue;
      seen.add(e.event_id);
      const step = e.magnitude_cu && (e.effect === 'demand' || e.effect === 'relocate-in');
      eventItems.push({
        kind: e.signal === 'seasonal' ? 'seasonal' : step ? 'step' : 'signal', id: e.event_id, title: e.title, date: e.date,
        cu: step ? e.magnitude_cu : null, uplift_pct: e.signal === 'seasonal' ? e.uplift_pct : null, confidence: e.confidence, region: a.verdict.region_label, pool_id: a.verdict.pool_id,
        effect: e.signal === 'seasonal' ? `+${Math.round(e.uplift_pct * 100)}% for ${plural(e.duration_weeks, 'week')}` : step ? `${cu(e.magnitude_cu)} of new demand` : 'informs the plan; adds no demand itself',
      });
    }
  }
  eventItems.sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
  const steps = sum(scope, (a) => a.ctx.knownAddsAt(H));
  const nextEvent = eventItems[0];
  const demandTiles = [
    tile('product_demand', 'Product demand', round(totalNow.plan), 'cu', ratio(totalNow.plan, totalThen.plan) == null ? `At ${horizonLabel}` : `At ${horizonLabel}, against last quarter's view`,
      `The demand we plan for at ${horizonLabel} across ${plural(n, 'pool')}: the p80 forecast, weighted pipeline, dated step-ups and any seasonal spike then. The pools are combined as one forecast, not by adding each p80, which would overstate it by ${cu(totalNow.diversification)}. Change is against the same forecast fitted ${P.overview.compare_weeks} weeks ago.`,
      { delta_pct: ratio(totalNow.plan, totalThen.plan) }),
    tile('workload_forecast', 'Workload forecast', round(p50), 'cu', `Middle path at ${horizonLabel}; p80 ${cu(p50 + totalNow.spread)} (the pools combined as one forecast)`,
      'The statistical forecast on its own, before the pipeline and dated adds: the middle path of usage at the horizon, and how far the planning path (p80) sits above it.',
      { p80: round(p50 + totalNow.spread) }),
    tile('growth', 'Growth', round(slope), 'cu_week', `${pct(usable > 0 ? (slope * 13) / usable : 0, 1)} of capacity per quarter`,
      'How fast usage is growing now: the slope of each pool\'s forecast (its fitted trend), added up. It is a trend, so a one-off step that has already happened is read as growth too.'),
    tile('pipeline', 'Pipeline', round(pipeline), 'cu', `${plural(dueByH.length, 'pending request')} due within ${horizonLabel}, ${cu(sum(dueByH, ({ r }) => r.cu))} asked`,
      `Pending requests due within ${horizonLabel}, each at its likelihood of going ahead and less the overlap discount (${Math.round(P.pipeline.overlap_discount * 100)}%), because some of it is already in the trend. Requests that have gone live or lapsed are not pipeline.`),
    tile('events', 'Business events', eventItems.length, 'count',
      eventItems.length ? `${cu(steps)} of dated step-ups; next: ${nextEvent.title}, ${nextEvent.date}` : `Nothing dated within ${horizonLabel}`,
      `Contracts and events dated within ${horizonLabel}: contract commitments not yet provisioned, sized launches and relocations, seasonal spikes, and events that inform the plan without adding demand. The note gives the CU the plan counts as dated step-ups.`,
      { step_cu: round(steps) }),
    tile('requests', 'Capacity requests', pending.length, 'count', `${cu(asked)} asked${atRisk ? `, ${atRisk} at risk of arriving late` : ', none at risk'}`,
      'Requests waiting for a decision. At risk means the part that needs a new order would arrive after it is needed.',
      { asked_cu: round(asked), at_risk: atRisk }),
  ];
  const demandRows = scope.map((a) => {
    const c = a.ctx; const v = a.verdict;
    const mine = c.requests;
    return {
      pool_id: v.pool_id, region: v.region_label, sku_id: v.sku_id, geo: c.pool.geo,
      demand_cu: round(c.planDemandAt(H)), p50_cu: round(c.p50At(H)), growth_cu_week: round(c.fc.slope_per_week), pipeline_cu: round(c.pipelineAt(H)),
      steps_cu: round(c.knownAddsAt(H)), requests: mine.length, asked_cu: round(sum(mine, (r) => r.cu)),
    };
  });

  // ================================================================ BALANCE / PLAN
  const balanceRows = scope.map((a) => {
    const c = a.ctx; const v = a.verdict;
    const supply = c.usableAt(H);
    const ceiling = v.capacity.working_floor_pct * supply;
    const demand = c.planDemandAt(H);
    const share = supply > 0 ? demand / supply : 0;
    return {
      pool_id: v.pool_id, region: v.region_label, sku_id: v.sku_id, geo: c.pool.geo,
      supply_cu: round(supply), ceiling_cu: round(ceiling), demand_cu: round(demand), balance_cu: round(ceiling - demand), demand_share: share,
      status: demand > ceiling ? 'short' : share >= P.overview.region_watch ? 'tight' : 'ok',
      state: v.state, order: v.order.needed ? { quantity_cu: v.order.quantity_cu, cost_usd: round(v.order.cost_usd), raise_by: v.dates.raise_by, lands_on: v.dates.lands_on, sku: v.what.order_sku } : null,
      headline: v.headline,
    };
  }).sort((x, y) => x.balance_cu - y.balance_cu);
  const short = balanceRows.filter((r) => r.balance_cu < 0);
  // from the exact figures, as the Overview does, so the two pages agree to the unit (summing rounded rows would not)
  const shortTotal = round(sum(scope, (a) => Math.max(0, a.ctx.planDemandAt(H) - a.verdict.capacity.working_floor_pct * a.ctx.usableAt(H))));
  const orders = balanceRows.filter((r) => r.order);
  const orderCu = sum(orders, (r) => r.order.quantity_cu);
  const orderUsd = sum(orders, (r) => r.order.cost_usd);
  const overdue = scope.filter((a) => a.verdict.state === 'OVERDUE').length;
  const total = {
    supply_cu: sum(balanceRows, (r) => r.supply_cu), ceiling_cu: sum(balanceRows, (r) => r.ceiling_cu), demand_cu: round(totalNow.plan),
    shortfall_cu: shortTotal, surplus_cu: round(sum(scope, (a) => Math.max(0, a.verdict.capacity.working_floor_pct * a.ctx.usableAt(H) - a.ctx.planDemandAt(H)))),
    pools_short: short.length, pools: n, order_cu: orderCu, order_usd: orderUsd, pools_ordering: orders.length, overdue,
  };
  const headline = !n ? 'No pools match these filters.'
    : `At ${horizonLabel}, demand of ${cu(total.demand_cu)} against supply of ${cu(total.supply_cu)} (${cu(total.ceiling_cu)} at the working ceilings). ${short.length
      ? `${plural(short.length, 'pool')} of ${n} would be short by ${cu(shortTotal)} in all, and a surplus elsewhere cannot cover that.`
      : `Every pool stays under its working ceiling.`} ${orders.length
      ? `The plans order ${cu(orderCu)} for ${usd(orderUsd)}${overdue ? `, ${overdue} of them already overdue` : ''}.`
      : 'No order is needed.'}`;

  // The answer-first line for each view, in plain words, from the same figures as the tiles.
  const supplyHeadline = !n ? 'No pools match these filters.'
    : `Today ${cu(usable)} is installed across ${plural(n, 'pool')}: ${pct(usable > 0 ? used / usable : 0)} is in use, ${cu(freeNow)} is unreserved and ${cu(headroom)} is left before the working ceilings.${landing > 0 ? ` ${cu(landing)} more lands within ${horizonLabel}.` : ''}`;
  const delta = ratio(totalNow.plan, totalThen.plan);
  const demandHeadline = !n ? 'No pools match these filters.'
    : `Demand at ${horizonLabel} is ${cu(totalNow.plan)}${delta == null ? '' : `, ${Math.abs(delta * 100).toFixed(0)}% ${delta >= 0 ? 'up' : 'down'} on last quarter's view`}. ${cu(pipeline)} of it is pipeline and ${cu(steps)} is dated step-ups; ${plural(pending.length, 'request')} ${pending.length === 1 ? 'is' : 'are'} waiting for a decision (${cu(asked)}${atRisk ? `, ${atRisk} at risk` : ''}).`;

  return {
    as_of: asOf, view: 'planning', source: 'synthetic',
    filters: {
      horizon: H, sku, region,
      options: {
        horizons: HORIZONS.map((w) => ({ weeks: w, label: `${(w / 13) * 3} months` })),
        skus: Object.entries(SKU_GROUPS).map(([key, label]) => ({ key, label })),
        regions: [{ key: 'all', label: 'All regions' }, ...Object.keys(GEO).filter((k) => everything.some((a) => a.ctx.pool.geo === k)).map((key) => ({ key, label: GEO[key] }))],
      },
    },
    horizon_label: horizonLabel,
    supply: { headline: supplyHeadline, tiles: supplyTiles, rows: supplyRows },
    demand: { headline: demandHeadline, tiles: demandTiles, rows: demandRows, events: eventItems },
    balance: { headline, tight_from: P.overview.region_watch, total, rows: balanceRows },
  };
}

module.exports = { buildPlanning, HEALTH_FUNNELS };
