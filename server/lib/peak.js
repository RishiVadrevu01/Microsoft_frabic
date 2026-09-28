'use strict';
/*
 * The peak check: is the plan safe on the BUSIEST HOUR, not just on the weekly mean?
 *
 * The lab plans on weekly readings, and a weekly reading is a mean. Capacity has to cover the busiest hour of
 * the week, which runs above the mean by a factor that is measured from hourly data (ml/, see peak_profile.json):
 * about 1.06 for a flat AI-training pool and about 1.18 for a business-hours pool. A pool at 77% of capacity on
 * the weekly mean is at about 91% at its peak, above an 85% working ceiling, and nothing on the weekly view says so.
 *
 * The check does two things and changes nothing:
 *   1. It measures where the busiest hour sits against the working ceiling: now, for how many weeks it has been
 *      over, and (from the model's forecast) next week.
 *   2. It plans the pool a second time with the same engine, reading the history as the busiest hour instead of
 *      the mean, and sets the two plans side by side: dates, order and cost.
 *
 * Whether the working ceiling is meant for the busiest hour (the usual meaning) or already allows for it is a
 * policy question. The check shows what each answer costs; it does not decide. It is not a funnel (the lab has
 * exactly 14) and never alters a verdict, a date or an order.
 *
 * The profile is optional. Without it, or if it does not match the dataset, the check says so and the rest
 * of the lab is untouched.
 */

const fs = require('node:fs');
const { assessPool } = require('./verdict');
const { weeksBetween } = require('./dates');

const RATIO_MIN = 1.0;
const RATIO_MAX = 2.0;
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const num = (x) => Math.round(x).toLocaleString('en-US');
const usd = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
};
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Reads and validates a peak profile against the dataset it must describe.
 * @param {string} file path to peak_profile.json
 * @param {object} raw the raw dataset (data.loadRaw)
 * @returns {{available:true, profile:object, byPool:object}|{available:false, reason:string}}
 */
function loadPeakProfile(file, raw) {
  if (!file || !fs.existsSync(file)) return { available: false, reason: 'No peak profile. Run npm run ml to build one from the hourly corpus.' };
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { available: false, reason: `The peak profile could not be read: ${e.message}` }; }
  const errors = [];
  if (p.source !== 'synthetic') errors.push('it is not labelled synthetic');
  if (p.as_of !== raw.as_of) errors.push(`it was built for ${p.as_of} but the dataset is as of ${raw.as_of}`);
  const byPool = Object.fromEntries((p.pools || []).map((x) => [x.pool_id, x]));
  for (const pool of raw.pools) {
    const pp = byPool[pool.pool_id];
    if (!pp) { errors.push(`${pool.pool_id} is missing`); continue; }
    const series = raw.utilization.find((u) => u.pool_id === pool.pool_id).series;
    if (!finite(pp.busiest_hour_ratio) || pp.busiest_hour_ratio < RATIO_MIN || pp.busiest_hour_ratio > RATIO_MAX) errors.push(`${pool.pool_id}: busiest_hour_ratio must be between ${RATIO_MIN} and ${RATIO_MAX}`);
    if (!Array.isArray(pp.weekly_ratio) || pp.weekly_ratio.length !== series.length || !pp.weekly_ratio.every((r) => finite(r) && r >= RATIO_MIN && r <= 3)) errors.push(`${pool.pool_id}: weekly_ratio must have one ratio for each of the ${series.length} weekly readings`);
    if (!pp.history || Math.abs(pp.history.mean_last_week - series.at(-1).utilized_units) > 0.5) errors.push(`${pool.pool_id}: it was built on a weekly reading of ${pp.history && pp.history.mean_last_week} but the dataset says ${series.at(-1).utilized_units}`);
    const nw = pp.next_week;
    if (!nw || ![nw.mean_p50, nw.busiest_p80, nw.busiest_p95].every((x) => finite(x) && x > 0) || nw.busiest_p80 < nw.mean_p50 || nw.busiest_p95 < nw.busiest_p80) errors.push(`${pool.pool_id}: the next-week forecast is not usable`);
  }
  if (errors.length) return { available: false, reason: `The peak profile does not match this dataset (${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `; and ${errors.length - 3} more` : ''}). Run npm run ml to rebuild it.` };
  return { available: true, profile: p, byPool };
}

const planOf = (v) => ({
  state: v.state, order_needed: v.order.needed, order_cu: v.order.needed ? v.order.quantity_cu : 0, order_sku: v.what.order_sku,
  cost_usd: v.order.needed ? v.order.cost_usd : 0, needed_by: v.dates.needed_by, raise_by: v.dates.raise_by, overdue_days: v.dates.overdue_days, lead_weeks: v.lead.weeks,
  utilization_now: v.capacity.utilization_of_usable,
});

function checkFor(data, a, pp) {
  const { ctx, verdict: v } = a;
  const id = v.pool_id;
  const usable = ctx.usable0;
  const ceilingPct = v.capacity.working_floor_pct;
  const ceiling = ceilingPct * usable;
  const series = data.utilByPool[id];

  // ---- where the busiest hour sits now
  const ratioNow = pp.weekly_ratio.at(-1);
  const meanNow = ctx.latest;
  const busiestNow = meanNow * ratioNow;
  const histCeiling = ceilingPct * ctx.pool.capacity_units;             // installed capacity is constant through the history
  let weeksOver = 0;
  for (let k = series.length - 1; k >= 0; k--) { if (series[k].utilized_units * pp.weekly_ratio[k] > histCeiling) weeksOver++; else break; }
  const now = {
    mean_units: meanNow, busiest_units: busiestNow, usable_units: usable, ceiling_pct: ceilingPct, ceiling_units: ceiling,
    mean_share: meanNow / usable, busiest_share: busiestNow / usable, over_ceiling: busiestNow > ceiling, over_by_units: Math.max(0, busiestNow - ceiling),
    weeks_over: weeksOver, over_since: weeksOver ? series[series.length - weeksOver].week_start : null,
    mean_over_ceiling: meanNow > ceiling,
  };

  // ---- what the model says about next week
  const nw = pp.next_week;
  const nextWeek = {
    mean_p50: nw.mean_p50, busiest_p80: nw.busiest_p80, busiest_p95: nw.busiest_p95,
    busiest_at_utc: nw.busiest_p80_at_utc, busiest_local_hour: nw.busiest_p80_local_hour,
    share_p80: nw.busiest_p80 / usable, share_p95: nw.busiest_p95 / usable,
    over_ceiling: nw.busiest_p80 > ceiling, over_ceiling_p95: nw.busiest_p95 > ceiling,
    starts_utc: nw.starts_utc,
  };

  // ---- the same engine, planning on the busiest hour
  const mean = planOf(v);
  const peak = planOf(assessPool(data, id, { demand_scale: pp.busiest_hour_ratio }).verdict);
  const earlier = mean.needed_by && peak.needed_by ? Math.round(weeksBetween(peak.needed_by, mean.needed_by) * 10) / 10 : null;
  const plan = {
    factor: pp.busiest_hour_ratio, factor_sd: pp.busiest_hour_ratio_sd, weeks_measured: pp.weeks,
    mean_basis: mean, peak_basis: peak,
    extra_cu: peak.order_cu - mean.order_cu, extra_usd: peak.cost_usd - mean.cost_usd,
    weeks_earlier: earlier, changes_state: peak.state !== mean.state, newly_needed: !mean.order_needed && peak.order_needed,
  };
  plan.impact = plan.newly_needed ? 'newly-needed' : plan.changes_state || plan.extra_cu > 0 || (earlier != null && earlier > 0) ? 'bigger' : 'same';

  const label = `${v.region_label} · ${v.sku_id}`;
  const opening = now.over_ceiling
    ? `On its busiest hour ${v.region_label} runs at ${pct(now.busiest_share)} of capacity, above the ${pct(ceilingPct)} working ceiling${weeksOver > 1 ? ` (${weeksOver} weeks running)` : ''}, while its weekly mean is ${pct(now.mean_share)}.`
    : `On its busiest hour ${v.region_label} runs at ${pct(now.busiest_share)} of capacity, within the ${pct(ceilingPct)} working ceiling (its weekly mean is ${pct(now.mean_share)}).`;
  const closing = plan.impact === 'same'
    ? 'Planning on the busiest hour would not change this pool\'s plan.'
    : plan.newly_needed
      ? `Planned on the busiest hour it would need an order of ${num(peak.order_cu)} CU (${usd(peak.cost_usd)}) that the weekly view does not ask for.`
      : `Planned on the busiest hour the order is ${num(peak.order_cu)} CU instead of ${num(mean.order_cu)} (${num(Math.abs(plan.extra_cu))} CU ${plan.extra_cu >= 0 ? 'more' : 'fewer'}, ${usd(Math.abs(plan.extra_usd))} ${plan.extra_usd >= 0 ? 'more' : 'less'})${earlier > 0 ? `, needed ${earlier} weeks sooner` : ''}${plan.changes_state ? `, and the state moves from ${mean.state} to ${peak.state}` : ''}.`;
  return { available: true, pool_id: id, label, now, next_week: nextWeek, plan, headline: `${opening} ${closing}` };
}

/** Totals over a set of pools' checks. */
function summarizeChecks(list) {
  const sumIf = (f) => list.reduce((s, c) => s + f(c), 0);
  return {
    pools: list.length,
    over_ceiling_now: list.filter((c) => c.now.over_ceiling).length,
    mean_over_ceiling_now: list.filter((c) => c.now.mean_over_ceiling).length,
    over_ceiling_next_week: list.filter((c) => c.next_week.over_ceiling).length,
    change_state: list.filter((c) => c.plan.changes_state).length,
    newly_needed: list.filter((c) => c.plan.newly_needed).length,
    mean_basis_order_cu: sumIf((c) => c.plan.mean_basis.order_cu), peak_basis_order_cu: sumIf((c) => c.plan.peak_basis.order_cu),
    mean_basis_cost_usd: sumIf((c) => c.plan.mean_basis.cost_usd), peak_basis_cost_usd: sumIf((c) => c.plan.peak_basis.cost_usd),
    extra_cu: sumIf((c) => c.plan.extra_cu), extra_usd: sumIf((c) => c.plan.extra_usd),
  };
}

/**
 * The check for every pool, and a summary. `all` are the store's assessments, `data` the indexed working dataset.
 */
function buildPeakChecks(data, all, loaded) {
  const pools = new Map(all.map((a) => [a.verdict.pool_id, checkFor(data, a, loaded.byPool[a.verdict.pool_id])]));
  return { available: true, as_of: data.as_of, source: 'synthetic', profile_version: loaded.profile.profile_version, generated_from: loaded.profile.generated_from, pools, summary: summarizeChecks([...pools.values()]) };
}

const IMPACT_RANK = { 'newly-needed': 0, bigger: 1, same: 2 };

/**
 * The compact form the Overview shows: one row per pool in scope, the ones that matter first, and totals.
 * @param {object} store the lab store
 * @param {object[]} scope the pool assessments the Overview is showing
 */
function peakOverview(store, scope) {
  const p = store.peak();
  if (!p.available) return { available: false, reason: p.reason };
  const checks = scope.map((a) => p.pools.get(a.verdict.pool_id));
  const rows = checks.map((c, i) => ({
    pool_id: c.pool_id, label: c.label, region: scope[i].verdict.region_label, sku_id: scope[i].verdict.sku_id,
    mean_share: c.now.mean_share, busiest_share: c.now.busiest_share, ceiling_pct: c.now.ceiling_pct, over_ceiling: c.now.over_ceiling, weeks_over: c.now.weeks_over,
    next_week_share_p80: c.next_week.share_p80, next_week_over: c.next_week.over_ceiling,
    factor: c.plan.factor, mean_state: c.plan.mean_basis.state, peak_state: c.plan.peak_basis.state, changes_state: c.plan.changes_state,
    mean_order_cu: c.plan.mean_basis.order_cu, peak_order_cu: c.plan.peak_basis.order_cu, order_sku: c.plan.peak_basis.order_sku,
    extra_cu: c.plan.extra_cu, extra_usd: c.plan.extra_usd, weeks_earlier: c.plan.weeks_earlier, impact: c.plan.impact,
  // The ones that matter first: a pool that needs an order it does not have, then one already over its ceiling at
  // the peak, then one whose state moves, then by what the difference costs.
  })).sort((x, y) => IMPACT_RANK[x.impact] - IMPACT_RANK[y.impact] || Number(y.over_ceiling) - Number(x.over_ceiling)
    || Number(y.changes_state) - Number(x.changes_state) || y.extra_usd - x.extra_usd || y.busiest_share - x.busiest_share);
  return {
    available: true, source: 'synthetic', profile_version: p.profile_version, summary: summarizeChecks(checks), rows,
    definition: 'How each pool\'s plan changes if the working ceiling is applied to its busiest hour instead of its weekly mean. The busiest hour is the weekly mean times a ratio measured from hourly data. Nothing here changes a plan: it shows what each reading of the ceiling would ask for.',
  };
}

/** One pool's check, or why there is none. */
function peakFor(store, poolId) {
  const p = store.peak();
  if (!p.available) return { available: false, reason: p.reason };
  return p.pools.get(poolId) || { available: false, reason: 'This pool is not in the peak profile.' };
}

module.exports = { loadPeakProfile, buildPeakChecks, checkFor, summarizeChecks, peakOverview, peakFor, RATIO_MIN, RATIO_MAX };
