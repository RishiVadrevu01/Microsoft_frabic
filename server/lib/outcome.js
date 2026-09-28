'use strict';
/*
 * OUTCOME and FEEDBACK (stages 10 and 11): what actually happened after the lab's "today" moved, set against what was
 * predicted and planned when it moved.
 *
 * Every time the lab advances, the store records a SNAPSHOT of what it predicted and planned at that moment: for each pool
 * the forecast paths (with the fingerprint of the data they were fitted on), the DEMAND the plan counted (the forecast plus
 * the pipeline, the dated step-ups and the seasonal spike), the plan itself (state, order, dates), and the supply in flight.
 * That ledger is what makes the comparison possible later: the engine refits on every load, so without it there would be
 * nothing left to compare the actuals with. Nothing here uses a model; it is subtraction.
 *
 * What an actual is held against is the demand the PLAN counted, because that is what the orders were sized for. The trend
 * model on its own (the forecast without the pipeline and the dated demand) is held against the trend part of the actuals,
 * which is the trend plus the steps that had already happened when the plan was written (they are in the history the forecast
 * was fitted on, and it starts from the level they took usage to), and reported beside it, so a forecast that was wrong can be told apart from a plan that guessed wrong about a request.
 *
 * The actuals are generated (clock.js), so the numbers show how the loop works, not how accurate the forecast would be on
 * real usage.
 */

const { daysBetween } = require('./dates');
const { planHash } = require('./basis');

const FORECAST_WEEKS = 52;
const HISTORY_TAIL = 26;
const BIAS_BAND_PCT = 3;      // within 3% of the middle path on average counts as close

/** What is predicted and planned right now, for the ledger. */
function takeSnapshot(data, all, originWeeks) {
  const pools = {};
  for (const { ctx, verdict: v } of all) {
    const weeks = Array.from({ length: FORECAST_WEEKS }, (_, i) => i + 1);
    pools[v.pool_id] = {
      forecast: {
        model: v.forecast.model, input_hash: v.forecast.input_hash,
        p50: ctx.fc.p50.slice(0, FORECAST_WEEKS).map(Math.round), upper: ctx.fc.upper.slice(0, FORECAST_WEEKS).map(Math.round),
      },
      // what the plan counted as demand: the middle path with the pipeline, the dated adds and the seasonal spike on top, and
      // the same on the p80 path (the timeline's plan_p80)
      demand: {
        p50: weeks.map((h) => Math.round(ctx.p50At(h) + ctx.pipelineAt(h) + ctx.knownAddsAt(h) + ctx.seasonalSpikeAt(h))),
        p80: weeks.map((h) => Math.round(ctx.planDemandAt(h))),
      },
      plan: {
        state: v.state, order_needed: v.order.needed, quantity_cu: v.order.quantity_cu, cost_usd: v.order.cost_usd,
        needed_by: v.dates.needed_by, raise_by: v.dates.raise_by, lands_on: v.dates.lands_on, covered_until: v.dates.covered_until, headline: v.headline,
        hash: planHash(v),
      },
      capacity: { installed: v.capacity.installed, usable_now: v.capacity.usable_now },
      in_flight: v.order.in_flight.map((o) => ({ order_id: o.order_id, cu: o.cu, lands_on: o.lands_on })),
    };
  }
  return { origin_weeks: originWeeks, origin_as_of: data.as_of, pools };
}

// A pool can be close on average and still break out of its band: the p80 path should be exceeded about one week in five,
// so three or more weeks above it, and over a third of the readings, is a forecast whose band was too narrow.
function readOf(bias, above, n) {
  if (bias > BIAS_BAND_PCT) return { read_key: 'above', read: 'Demand ran above the plan' };
  if (bias < -BIAS_BAND_PCT) return { read_key: 'below', read: 'Demand ran below the plan' };
  if (above >= 3 && above / n > 1 / 3) return { read_key: 'band', read: 'Above p80 more often than expected' };
  return { read_key: 'close', read: 'Close to the plan' };
}

const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
const weeksBetween = (a, b) => (a && b ? Math.round(daysBetween(a, b) / 7) : null);

/** The comparison for the current state of the store. */
function buildOutcome(store) {
  const state = store.state();
  const data = store.data();
  const all = store.all();
  const clock = store.clock();
  const info = store.advanceInfo();
  const weeks = state.advance.weeks;
  const base = {
    view: 'outcome', source: 'synthetic', as_of: data.as_of, origin_as_of: weeks ? state.ledger[0].origin_as_of : data.as_of,
    advanced_weeks: weeks, limit: info,
    notes: [
      'The actuals are generated: each pool follows its own recent trend with a hidden growth surprise and noise at its own historical size. They show how the loop works, not how accurate the forecast would be on real usage.',
      'Requests, contracts and events that fall due are realized in the actuals by draws the plan never sees: a request goes live with the likelihood it was given, a contract takes effect, and only part of what was asked for shows up. A pool cannot use more than has landed, so a full pool turns demand away. Incidents and feed deliveries are carried forward unchanged in age; no new ones are invented.',
      'Nothing here is a model: each figure is the recorded prediction subtracted from what was generated. Actuals are held against the demand the plan counted (forecast, pipeline, dated adds); the trend alone is held against the trend and the steps already in its history.',
    ],
  };
  if (!weeks) return { ...base, summary: null, pools: [], arrivals: [], in_flight: [], decisions: [], dated: [] };

  // ---- the plan's demand against the actual, week by week, and the trend model against the trend part
  const pools = all.map(({ verdict: v }) => {
    const series = data.utilByPool[v.pool_id];
    const seedLen = series.length - weeks;
    const rows = [];
    for (let k = 1; k <= weeks; k++) {
      const snap = [...state.ledger].reverse().find((s) => s.origin_weeks < k);
      const rec = snap.pools[v.pool_id];
      const h = k - snap.origin_weeks;
      const actual = series[seedLen + k - 1].utilized_units;
      // a snapshot from before the plan's demand was recorded falls back to the forecast alone
      const p50 = (rec.demand || { p50: rec.forecast.p50 }).p50[h - 1];
      const p80 = (rec.demand || { p80: rec.forecast.upper }).p80[h - 1];
      // What the trend model is answerable for: the trend, plus the steps that had already happened when the plan was written
      // (they are in the history it was fitted on, at the level they took usage to). Steps after that are dated demand, which
      // the plan counts separately.
      const known = clock && snap.origin_weeks > 0 ? clock.steps_by_pool[v.pool_id][snap.origin_weeks - 1] : 0;
      const trend = (clock ? clock.organic[v.pool_id][k - 1] : actual) + known;
      rows.push({
        week: k, week_start: series[seedLen + k - 1].week_start, actual, p50, p80, error: actual - p50, error_pct: (actual - p50) / p50 * 100, within_p80: actual <= p80, made_at_week: snap.origin_weeks,
        dated_cu: clock ? clock.dated_by_pool[v.pool_id][k - 1] : 0, unserved_cu: clock ? clock.unserved[v.pool_id][k - 1] : 0, capacity: clock ? clock.capacity[v.pool_id][k - 1] : null,
        trend: { actual: trend, known_cu: known, p50: rec.forecast.p50[h - 1], p80: rec.forecast.upper[h - 1], error_pct: (trend - rec.forecast.p50[h - 1]) / rec.forecast.p50[h - 1] * 100, within_p80: trend <= rec.forecast.upper[h - 1] },
      });
    }
    const then = state.ledger[0].pools[v.pool_id];
    const bias = mean(rows.map((r) => r.error_pct));
    const above = rows.filter((r) => !r.within_p80).length;
    const tBias = mean(rows.map((r) => r.trend.error_pct));
    const tAbove = rows.filter((r) => !r.trend.within_p80).length;
    const gen = clock && clock.generated_with[v.pool_id];
    const nowPlan = {
      state: v.state, order_needed: v.order.needed, quantity_cu: v.order.quantity_cu, cost_usd: v.order.cost_usd,
      needed_by: v.dates.needed_by, raise_by: v.dates.raise_by, lands_on: v.dates.lands_on, covered_until: v.dates.covered_until, headline: v.headline,
    };
    return {
      pool_id: v.pool_id, region_label: v.region_label, sku_id: v.sku_id,
      forecast: {
        model: then.forecast.model, input_hash: then.forecast.input_hash, now_model: v.forecast.model, now_input_hash: v.forecast.input_hash,
        readings: rows.length, mae_cu: mean(rows.map((r) => Math.abs(r.error))), mape_pct: mean(rows.map((r) => Math.abs(r.error_pct))), bias_pct: bias,
        above_p80: above, within_p80: rows.length - above,
        ...readOf(bias, above, rows.length),
        // the trend model on its own, against the trend part of the actuals: the trend plus the steps already in its history, before any later dated demand, any spike or the cap
        trend: { mape_pct: mean(rows.map((r) => Math.abs(r.trend.error_pct))), bias_pct: tBias, above_p80: tAbove, within_p80: rows.length - tAbove, ...readOf(tBias, tAbove, rows.length) },
      },
      chart: { history: series.slice(seedLen - HISTORY_TAIL, seedLen).map((p) => ({ week_start: p.week_start, value: p.utilized_units })), rows },
      dated: clock ? clock.dated.filter((d) => d.pool_id === v.pool_id) : [],
      unserved: clock ? { cu_weeks: clock.unserved[v.pool_id].reduce((a, x) => a + x, 0), weeks: clock.unserved[v.pool_id].filter((x) => x > 0).length, peak_cu: Math.max(0, ...clock.unserved[v.pool_id]) } : { cu_weeks: 0, weeks: 0, peak_cu: 0 },
      generated_with: gen ? { growth_surprise_pct: gen.surprise * 100, noise_sd_cu: gen.noise_sd } : null,
      plan: {
        then: then.plan, now: nowPlan,
        // changed if the state, the order, when it lands, or the capacity the pool has is different: a plan that lands eight weeks later has changed
        changed: then.plan.state !== nowPlan.state || then.plan.quantity_cu !== nowPlan.quantity_cu || then.plan.lands_on !== nowPlan.lands_on || v.capacity.installed !== then.capacity.installed,
        lands_later_weeks: weeksBetween(then.plan.lands_on, nowPlan.lands_on),
        quantity_change_cu: nowPlan.quantity_cu - then.plan.quantity_cu,
        cost_change_usd: nowPlan.cost_usd - then.plan.cost_usd,
        capacity_added_cu: v.capacity.installed - then.capacity.installed,
      },
    };
  });

  // ---- supply: what arrived, what slipped, what is still coming
  const touched = data.supply.filter((s) => s.planned_lands_on);
  const poolLabel = (id) => (data.poolById[id] ? data.poolById[id].region_label : id);
  const arrivals = touched.filter((s) => s.status === 'racked').map((s) => ({
    order_id: s.order_id, pool_id: s.pool_id, region: poolLabel(s.pool_id), sku_id: s.sku_id, cu: s.cu,
    planned_lands_on: s.planned_lands_on, landed_on: s.landed_on, slip_weeks: s.slip_weeks,
    units_added: (clock && (clock.arrivals.find((a) => a.order_id === s.order_id) || {}).units_added) || null,
  }));
  const inFlight = all.flatMap(({ verdict: v }) => v.order.in_flight.map((o) => {
    const rec = data.supply.find((s) => s.order_id === o.order_id) || {};
    return { order_id: o.order_id, pool_id: v.pool_id, region: v.region_label, sku_id: o.sku_id, cu: o.cu, lands_on: o.lands_on, planned_lands_on: rec.planned_lands_on || o.lands_on, slip_weeks: rec.slip_weeks || 0, slipped: Boolean(rec.planned_lands_on) };
  }));

  // ---- actions: each decision, and what became of its order
  const decisions = state.decisions.filter((d) => d.order_id).map((d) => {
    const s = data.supply.find((x) => x.order_id === d.order_id) || null;
    return {
      decision_id: d.decision_id, pool_id: d.pool_id, region: poolLabel(d.pool_id), decided_by: d.decided_by, order_id: d.order_id, quantity_cu: d.quantity_cu,
      drafted_lands_on: d.drafted.lands_on, order_status: s ? s.status : null, landed_on: s && s.landed_on ? s.landed_on : null, lands_on: s ? s.lands_on : null,
      slip_weeks: s && s.slip_weeks != null ? s.slip_weeks : null,
    };
  });

  // ---- the whole, in a few numbers
  const readings = pools.flatMap((p) => p.chart.rows);
  const slips = arrivals.map((a) => a.slip_weeks);
  const dated = clock ? clock.dated : [];
  // What fell due, in numbers: what the plan counted against what showed up. A seasonal spike is a rate, not a size, so it is
  // counted as an event but not added to the CU totals.
  const sized = dated.filter((d) => d.plan_cu != null);
  const summary = {
    weeks, readings: readings.length, within_p80: readings.filter((r) => r.within_p80).length,
    mape_pct: mean(pools.map((p) => p.forecast.mape_pct)), trend_mape_pct: mean(pools.map((p) => p.forecast.trend.mape_pct)),
    dated: {
      fell_due: dated.length, happened: dated.filter((d) => d.happened).length, did_not: dated.filter((d) => !d.happened).length,
      requests: dated.filter((d) => d.kind === 'request').length, requests_live: dated.filter((d) => d.kind === 'request' && d.happened).length,
      plan_cu: sized.reduce((a, d) => a + d.plan_cu, 0), asked_cu: sized.reduce((a, d) => a + d.asked_cu, 0), realized_cu: sized.reduce((a, d) => a + d.realized_cu, 0),
    },
    unserved_cu_weeks: pools.reduce((a, p) => a + p.unserved.cu_weeks, 0), pools_full: pools.filter((p) => p.unserved.weeks > 0).length,
    arrivals: arrivals.length, mean_slip_weeks: slips.length ? mean(slips) : null,
    slipped_in_flight: inFlight.filter((o) => o.slipped && o.slip_weeks !== 0).length,
    plans_changed: pools.filter((p) => p.plan.changed).length, pools: pools.length,
    ordered_then_cu: pools.reduce((a, p) => a + p.plan.then.quantity_cu, 0), ordered_now_cu: pools.reduce((a, p) => a + p.plan.now.quantity_cu, 0),
    cost_then_usd: pools.reduce((a, p) => a + p.plan.then.cost_usd, 0), cost_now_usd: pools.reduce((a, p) => a + p.plan.now.cost_usd, 0),
    overdue_then: pools.filter((p) => p.plan.then.state === 'OVERDUE').length, overdue_now: pools.filter((p) => p.plan.now.state === 'OVERDUE').length,
  };
  return { ...base, summary, pools, arrivals, in_flight: inFlight, decisions, dated: dated.map((d) => ({ ...d, region: poolLabel(d.pool_id), sku_id: data.poolById[d.pool_id].sku_id })).sort((a, b) => a.in_effect_on.localeCompare(b.in_effect_on) || a.id.localeCompare(b.id)) };
}

module.exports = { takeSnapshot, buildOutcome, readOf, FORECAST_WEEKS };
