'use strict';
/*
 * Everything the funnels need to know about one pool, in one place.
 *
 * Capacity is time-varying: orders already in flight land on known dates, so
 * usableAt(h) gives the capacity that will exist h weeks from as_of. Every funnel
 * tests demand against the capacity that will actually be there at that time.
 *
 * The week-by-week demand and capacity series are defined in timeline.js (the unified planning timeline); this file
 * gathers a pool's records, fits the forecast, and hands the funnels the same accessors as before. `ctx.timeline()` is
 * the whole timeline as a plain object.
 */

const { addWeeks, daysBetween } = require('./dates');
const { forecastSeries, HORIZON_WEEKS } = require('./forecast');
const { capacityPath, demandPath, describeTimeline } = require('./timeline');
const { shiftCandidates, adjustForLevelShifts } = require('./shifts');

const groupOf = (klass) => (klass.startsWith('gpu') ? 'gpu' : 'general');

// A retired (end-of-life) SKU is replaced by its successor for new orders.
function resolveOrderSku(sku, skuById) {
  let cur = sku;
  const seen = new Set();
  while (cur.status === 'eol' && cur.replaced_by_sku && !seen.has(cur.sku_id)) {
    seen.add(cur.sku_id);
    cur = skuById[cur.replaced_by_sku];
  }
  return cur;
}

// How many units of `from` one unit of `to` is worth, walking the successor chain.
function conversionFactor(from, to, skuById, override) {
  if (from.sku_id === to.sku_id) return 1;
  let cur = from;
  let factor = 1;
  const seen = new Set();
  while (cur && cur.replaced_by_sku && !seen.has(cur.sku_id)) {
    seen.add(cur.sku_id);
    const step = (cur === from && Number.isFinite(override)) ? override : (cur.capacity_equivalence_factor || 1);
    factor *= step;
    cur = skuById[cur.replaced_by_sku];
    if (cur && cur.sku_id === to.sku_id) return factor;
  }
  return 1;
}

const inScope = (scope, pool) => Boolean(scope) && (
  scope.estate === true
  || scope.pool_id === pool.pool_id
  || scope.region === pool.region
  || scope.sku_class === pool.sku_class
  || scope.sku_class_group === groupOf(pool.sku_class));

/**
 * @param {object} data indexed dataset (see data.indexData)
 * @param {string} poolId
 * @param {{growth_pts_per_week?:number, lead_time_weeks?:number, floor_pct?:number, conversion_factor?:number, demand_scale?:number}} [overrides]
 */
function buildContext(data, poolId, overrides = {}) {
  const policy = data.policy;
  const asOf = data.as_of;
  const pool = data.poolById[poolId];
  if (!pool) throw new Error(`Unknown pool ${poolId}`);

  const sku = data.skuById[pool.sku_id];
  const orderSku = resolveOrderSku(sku, data.skuById);
  const factor = conversionFactor(sku, orderSku, data.skuById, overrides.conversion_factor);
  const vendor = data.vendorById[orderSku.vendor_id];

  const series = data.utilByPool[poolId];
  // `demand_scale` re-reads the history as something other than the weekly mean: the peak check plans a pool
  // on its busiest hour by scaling the observed weeks by the measured busiest-hour-to-mean ratio.
  const scale = Number.isFinite(overrides.demand_scale) && overrides.demand_scale > 0 ? overrides.demand_scale : 1;
  const rawValues = series.map((s) => s.utilized_units * scale);
  const latest = rawValues[rawValues.length - 1];

  const group = groupOf(pool.sku_class);
  const basePolicyFloor = policy.floor_pct[group];
  const floor = Number.isFinite(overrides.floor_pct) ? overrides.floor_pct : basePolicyFloor;

  const allocations = data.allocations.filter((a) => a.pool_id === poolId);
  const inflight = data.supply.filter((s) => s.pool_id === poolId && s.lands_on > asOf);
  const requests = data.requests.filter((r) => r.pool_id === poolId && r.status === 'pending');
  const incidents = data.incidents.filter((i) => i.pool_id === poolId);
  const contracts = data.contracts.filter((c) => c.pool_id === poolId);
  const events = data.events.filter((e) => inScope(e.scope, pool));

  // ---- steps that have already happened are taken out of the history the forecast is fitted on (shifts.js): a request that went
  // live, a contract that took effect or a launch whose date has passed is a one-off jump, not faster growth. On a history with
  // no such record `values` is the readings themselves.
  const weekStarts = series.map((s) => s.week_start);
  const candidates = shiftCandidates({ requests: data.requests.filter((r) => r.pool_id === poolId), contracts, events });
  const shifted = adjustForLevelShifts(weekStarts, rawValues, candidates);
  const values = shifted.values;
  // the same, for the forecast as it stood n readings in: only the steps that had happened by then
  const fitValuesUpTo = (n) => adjustForLevelShifts(weekStarts.slice(0, n), rawValues.slice(0, n), candidates).values;

  const dateOf = (h) => addWeeks(asOf, h);
  const hOf = (date) => Math.max(0, Math.ceil(daysBetween(asOf, date) / 7));

  // ---- capacity over time: installed capacity plus supply as it lands
  const equiv = (order) => conversionFactor(sku, data.skuById[order.sku_id] || sku, data.skuById);
  const { usableAt } = capacityPath({ pool, inflight, equiv, dateOf });

  // ---- demand
  const slopeOverride = Number.isFinite(overrides.growth_pts_per_week)
    ? (overrides.growth_pts_per_week / 100) * Math.max(1, usableAt(0))
    : undefined;
  const fc = forecastSeries(values, policy.forecast, { slope: slopeOverride });
  const demand = demandPath({ fc, values, fitValuesUpTo, latest, requests, contracts, events, policy, asOf, dateOf, hOf });
  const { p50At, upperAt, pipelineAt, demandBase, knownAddsAt, seasonalSpikeAt, planDemandAt, spreadAt, priorUpperAt, priorSpreadAt } = demand;

  function crossing(test, to = HORIZON_WEEKS) {
    for (let h = 0; h <= to; h++) if (test(h)) return h;
    return null;
  }

  function feedStatus(feedId) {
    const f = data.feedById[feedId];
    if (!f) return null;
    const age = daysBetween(f.last_delivered, asOf);
    return {
      feed_id: f.feed_id, name: f.name, owner_team: f.owner_team, age_days: age, cadence_days: f.cadence_days,
      stale: age > f.cadence_days * policy.feeds.stale_multiplier,
    };
  }

  const usable0 = usableAt(0);
  const allocatedNow = allocations.reduce((a, r) => a + r.allocated_units, 0);

  const ctx = {
    asOf, policy, pool, sku, orderSku, factor, vendor, group,
    values, latest, series, fc, shifts: shifted.steps,
    floor, basePolicyFloor,
    allocations, inflight, requests, incidents, contracts, events,
    dep: data.depByPool[poolId], perf: data.perfByPool[poolId],
    dateOf, hOf, usableAt, usable0,
    p50At, upperAt, pipelineAt, demandBase, knownAddsAt, seasonalSpikeAt, planDemandAt, spreadAt, priorSpreadAt, priorUpperAt, crossing, feedStatus,
    allocatedNow, freeNow: Math.max(0, usable0 - allocatedNow),
    overrides,
    inScope: (scope) => inScope(scope, pool),
    equiv,
  };
  ctx.timeline = () => describeTimeline(ctx);
  return ctx;
}

module.exports = { buildContext, resolveOrderSku, conversionFactor, inScope, groupOf, HORIZON_WEEKS };
