'use strict';
/*
 * The unified planning timeline (stage 3 of the architecture): everything the funnels and the plan engine read about
 * "demand at week h" and "capacity at week h", defined once, week by week, for one pool.
 *
 *   demand    the forecast (p50, p80), plus the request pipeline, plus dated step-ups, plus a seasonal spike
 *   capacity  installed capacity, plus supply as it lands
 *
 * h is whole weeks from `as_of` (0 to HORIZON_WEEKS). h = 0 is the latest reading. Beyond the horizon a series clamps to
 * its last week (the forecast) or is computed directly (the dated ones), exactly as before this module existed.
 *
 * "The demand we plan for" used to be defined in three places that did not say so. They are the same building blocks with
 * three different rules about what counts, and they now live side by side here:
 *
 *   base_p80   what the FUNNELS test against the working ceiling to find a date.   organic p80 + pipeline
 *   sizing     what the PLAN ENGINE orders for, at the end of the cover window.    organic p80 + pipeline + every add_demand
 *              a funnel proposed that starts by then. A `temporary` buffer counts even when its event has already ended by
 *              then, because the order is sized to be safe when the event arrives, not to be tight afterwards.
 *   coverage   what decides how long an order lasts (covered_until).               base_p80 + the permanent add_demand
 *              proposals that have started; temporary buffers are excluded, because they are not there to stay.
 *   plan_p80   what the FLEET VIEWS show as the demand for week h.                 base_p80 + dated step-ups + a seasonal
 *              spike only while its event is running.
 *
 * So sizing and plan_p80 agree except where a temporary buffer has ended (Japan East: a 3-week launch, over by week 31,
 * counted in an order sized at week 54) and where a funnel chose not to propose a dated add. test/contracts.test.js pins
 * both the agreement and the difference.
 */

const { HORIZON_WEEKS, forecastSeries, quantile } = require('./forecast');

const inRange = (h) => Number.isInteger(h) && h >= 0 && h <= HORIZON_WEEKS;
// Whole weeks 0..HORIZON_WEEKS are computed once; anything else is computed directly, so behaviour is identical for every input.
const memo = (fn) => {
  const cache = new Array(HORIZON_WEEKS + 1);
  return (h) => {
    if (!inRange(h)) return fn(h);
    if (!(h in cache)) cache[h] = fn(h);
    return cache[h];
  };
};

/** Capacity as supply lands: installed units, plus every order in flight that has landed by week h, in this pool's units. */
function capacityPath({ pool, inflight, equiv, dateOf }) {
  const usableAt = (h) => {
    const date = dateOf(h);
    const landed = inflight.filter((s) => s.lands_on <= date).reduce((a, s) => a + s.cu * equiv(s), 0);
    return pool.capacity_units + landed;
  };
  return { usableAt: memo(usableAt) };
}

/** Demand as the forecast, the pipeline, the dated adds and the seasonal spike. */
function demandPath({ fc, values, fitValuesUpTo = (n) => values.slice(0, n), latest, requests, contracts, events, policy, asOf, dateOf, hOf }) {
  const idx = (h) => Math.min(h, HORIZON_WEEKS) - 1;
  const p50At = memo((h) => (h <= 0 ? latest : fc.p50[idx(h)]));
  const upperAt = memo((h) => (h <= 0 ? latest : fc.upper[idx(h)]));
  // How far the p80 path sits above the middle, in units: z x sigma at that week. The only uncertain part of demand: the
  // pipeline, contracts and events are dated and add up exactly. aggregate.js combines pools through these spreads.
  const spreadAt = memo((h) => (h <= 0 ? 0 : fc.upper[idx(h)] - fc.p50[idx(h)]));

  const discount = 1 - policy.pipeline.overlap_discount;
  const pipelineAt = memo((h) => requests.filter((r) => hOf(r.needed_by) <= h).reduce((a, r) => a + r.cu * r.win_probability * discount, 0));
  const demandBase = memo((h) => upperAt(h) + pipelineAt(h));

  // Dated step-ups the funnels know about: contract commitments not yet provisioned, and sized relocations and regional launches.
  const knownAddsAt = memo((h) => {
    const date = dateOf(h);
    const fromContracts = contracts.filter((c) => c.effective_date <= date).reduce((a, c) => a + Math.max(0, c.committed_cu - c.provisioned_cu), 0);
    // An event that has already happened is in the readings now (or did not happen), so it is no longer a step to come.
    const fromEvents = events
      .filter((e) => e.date >= asOf && e.date <= date && e.magnitude_cu && (e.effect === 'relocate-in' || (e.signal === 'strategic' && e.effect === 'demand')))
      .reduce((a, e) => a + e.magnitude_cu, 0);
    return fromContracts + fromEvents;
  });
  // A seasonal spike, only while its event is running.
  const seasonalSpikeAt = memo((h) => events
    .filter((e) => e.signal === 'seasonal' && e.date >= asOf)
    .reduce((a, e) => { const start = hOf(e.date); return h >= start && h < start + e.duration_weeks ? a + (p50At(h) + pipelineAt(h)) * e.uplift_pct : a; }, 0));

  // The same forecast as it stood `compare_weeks` ago: fitted only on usage that existed then, every other record held as
  // it is now. It answers "how much did the last quarter of usage move the picture" without pretending we kept snapshots.
  let prior = null;
  const compare = policy.overview.compare_weeks;
  const priorFit = () => { if (!prior) prior = forecastSeries(fitValuesUpTo(values.length - compare), policy.forecast); return prior; };
  const priorIdx = (h) => Math.min(h + compare, HORIZON_WEEKS) - 1;
  const priorUpperAt = (h) => priorFit().upper[priorIdx(h)];
  const priorSpreadAt = (h) => { const f = priorFit(); return f.upper[priorIdx(h)] - f.p50[priorIdx(h)]; };

  const planDemandAt = (h, { prior: usePrior = false } = {}) => (usePrior ? priorUpperAt(h) + pipelineAt(h) : demandBase(h)) + knownAddsAt(h) + seasonalSpikeAt(h);
  return { p50At, upperAt, spreadAt, pipelineAt, demandBase, knownAddsAt, seasonalSpikeAt, priorUpperAt, priorSpreadAt, planDemandAt };
}

const ADD_DEMAND = 'add_demand';

/**
 * The demand an order is sized for at the end of its cover window: the funnels' proposals decide which dated adds count.
 * @param {object} ctx planning context
 * @param {object[]} props every proposal from every funnel
 */
function sizingDemand(ctx, props, coverEnd) {
  const organic = ctx.upperAt(coverEnd);
  const pipe = ctx.pipelineAt(coverEnd);
  const started = props.filter((p) => p.kind === ADD_DEMAND && ctx.hOf(p.at) <= coverEnd);
  const hard = started.filter((p) => !p.temporary);
  const temp = started.filter((p) => p.temporary);
  const hardTotal = hard.reduce((a, p) => a + p.cu, 0);
  const tempTotal = temp.reduce((a, p) => a + p.cu, 0);
  return { organic, pipe, hard, temp, hardTotal, tempTotal, totalDemand: organic + pipe + hardTotal + tempTotal };
}

/** The demand that decides how long an order lasts: base p80 plus the permanent adds that have started. */
function coverageDemand(ctx, props, h) {
  const hardAdds = props.filter((p) => p.kind === ADD_DEMAND && !p.temporary && ctx.hOf(p.at) <= h).reduce((a, p) => a + p.cu, 0);
  return ctx.demandBase(h) + hardAdds;
}

const round = (x) => +x.toFixed(3);

/** Each series, what it means, where it comes from and who reads it. Used by the contract document. */
const SERIES = [
  { key: 'organic_p50', means: 'The forecast middle path of utilization.', from: 'utilization.json, through the forecast', read_by: 'seasonal funnel (10, its base), fleet views' },
  { key: 'organic_p80', means: 'The forecast planning path: the middle plus z x sigma (z 0.8416, about 80% sure to be reached).', from: 'utilization.json, through the forecast', read_by: 'plan engine (sizing), funnels through base_p80' },
  { key: 'spread', means: 'organic_p80 minus organic_p50: the only uncertain part of demand.', from: 'the forecast', read_by: 'aggregate.js, to combine pools' },
  { key: 'pipeline', means: 'Pending requests due by week h, at their likelihood, less the overlap discount.', from: 'requests.json (pending only)', read_by: 'base_p80, sizing, seasonal funnel (10)' },
  { key: 'dated_adds', means: 'Contract commitments not yet provisioned, plus sized relocations and regional launches, effective by week h.', from: 'contracts.json, events.json', read_by: 'fleet views (the plan engine gets the same steps from funnels 5, 12 and 14)' },
  { key: 'seasonal_spike', means: 'A seasonal uplift on (p50 + pipeline), only while its event is running.', from: 'events.json (seasonal)', read_by: 'fleet views (the plan engine gets a temporary buffer from funnel 10)' },
  { key: 'base_p80', means: 'organic_p80 + pipeline.', from: 'derived', read_by: 'funnels 1, 3, 5, 10, 12, 14' },
  { key: 'plan_p80', means: 'base_p80 + dated_adds + seasonal_spike: the demand the fleet views show.', from: 'derived', read_by: 'Overview, Product Team view' },
  { key: 'installed', means: 'Installed capacity of the pool.', from: 'infrastructure.json', read_by: 'everything' },
  { key: 'landed', means: 'Orders in flight that have landed by week h, converted to this pool\'s units.', from: 'supply_pipeline.json, sku_catalogue.json (equivalence factor)', read_by: 'usable' },
  { key: 'usable', means: 'installed + landed: the capacity that will exist at week h.', from: 'derived', read_by: 'funnels 1, 3, 5, 10, 12, 14; plan engine (sizing and cover)' },
];

/** The timeline as a plain object: one row per week, and the rules the plan was built with. */
function describeTimeline(ctx) {
  const obs = (ctx.vendor && ctx.vendor.observed_lead_weeks) || [];
  const points = Array.from({ length: HORIZON_WEEKS + 1 }, (_, h) => ({
    week: h, date: ctx.dateOf(h),
    demand: {
      organic_p50: round(ctx.p50At(h)), organic_p80: round(ctx.upperAt(h)), spread: round(ctx.spreadAt(h)), pipeline: round(ctx.pipelineAt(h)),
      dated_adds: round(ctx.knownAddsAt(h)), seasonal_spike: round(ctx.seasonalSpikeAt(h)), base_p80: round(ctx.demandBase(h)), plan_p80: round(ctx.planDemandAt(h)),
    },
    capacity: { installed: ctx.pool.capacity_units, landed: round(ctx.usableAt(h) - ctx.pool.capacity_units), usable: round(ctx.usableAt(h)) },
  }));
  return {
    contract: 'planning-timeline/1', pool_id: ctx.pool.pool_id, as_of: ctx.asOf, unit: 'CU', horizon_weeks: HORIZON_WEEKS,
    forecast: { contract: ctx.fc.contract, model: ctx.fc.model, input_hash: ctx.fc.input_hash, upper_quantile: ctx.fc.interval.upper_quantile },
    policy_version: ctx.policy.policy_version,
    rules: { floor_pct: ctx.floor, cover_weeks: ctx.policy.cover_weeks, buffer_pct: ctx.policy.buffer_pct },
    lead: {
      quoted_weeks: ctx.vendor ? ctx.vendor.quoted_lead_weeks : null,
      observed_p80_weeks: obs.length >= ctx.policy.lead_time.observed_min_samples ? +quantile(obs, 0.8).toFixed(1) : null,
      default_weeks: ctx.policy.lead_time.default_weeks,
    },
    order: {
      sku_id: ctx.orderSku.sku_id, factor: ctx.factor, order_unit_cu: ctx.orderSku.order_unit_cu, vendor_min_cu: ctx.orderSku.vendor_min_cu,
      unit_cost_usd: ctx.orderSku.unit_cost_usd, lifecycle: ctx.sku.status,
    },
    in_flight: ctx.inflight.map((s) => ({ order_id: s.order_id, cu: s.cu, sku_id: s.sku_id, lands_on: s.lands_on, status: s.status })),
    points,
  };
}

module.exports = { capacityPath, demandPath, sizingDemand, coverageDemand, describeTimeline, SERIES, HORIZON_WEEKS };
