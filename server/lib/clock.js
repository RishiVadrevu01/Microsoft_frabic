'use strict';
/*
 * The simulation clock: what happens when the lab's "today" moves forward.
 *
 * The engine never reads the wall clock; "today" is `as_of`. Advancing it is a transformation of the WORKING COPY of the
 * data (the seed is never written), and it is a pure function of (the data, the number of weeks): the same data and the
 * same weeks always give the same world, and advancing 4 weeks then 4 more is the same as advancing 8. The store replays it
 * from the seed on every build, so there is nothing to save but the number of weeks.
 *
 * What moves, and how:
 *   utilization   each pool gets `weeks` new ACTUAL readings, generated. Each reading is the pool's own trend, plus whatever
 *                 dated demand has fallen due, capped at what the pool can hold that week.
 *                   trend    the same straight-line fit the forecast starts from, with a hidden growth surprise for that
 *                            pool, plus noise at the size of its own historical noise.
 *                   dated    a request, a contract or an event that falls due becomes usage, or does not (see below).
 *                 The generator never sees the forecast, so the forecast can be wrong.
 *   reservations  each team keeps its share of the pool's usage, so the records still add up to the latest reading. A team
 *                 whose request went live holds what it now uses.
 *   supply        an approved order is placed on its date. An order that has reached its planned date lands, or slips, by
 *                 however far the vendor's own delivery history says arrivals stray from the typical one. Landed orders add
 *                 capacity to the pool.
 *   requests,     the ones that fell due are settled, so nothing is counted twice: a request that went live leaves the
 *   contracts     pipeline (its usage is in the readings now) or lapses; a contract that took effect is fully provisioned.
 *   incidents,    carried forward unchanged in age: the lab does not invent new incidents or feed deliveries, and without
 *   feed dates    this the reliability window would empty and every feed would go stale, just because time passed.
 *
 * DATED DEMAND. What the plan counts is what the funnels and the timeline read; what happens is decided here, by draws the
 * plan never sees, from a fixed salt and the record's own id, so the same record always meets the same fate:
 *   request    goes live with the probability it was given; if it does, 60% to 100% of what it asked for shows up, in full,
 *              from the week it is needed (never from before it was submitted). If not, it lapses.
 *   contract   always takes effect; 70% to 100% of what it still had to add shows up, in full, from its effective date.
 *   event      a demand step (a sized relocation or regional launch) happens with the event's confidence; 70% to 100% of
 *              its size shows up from its date. A seasonal spike happens with the event's confidence; while it runs the
 *              pool's usage is raised by 70% to 130% of the stated uplift. Other events (a new SKU, a market shift, a
 *              competitor's price cut) do not move usage.
 *   unrecorded a scenario can add usage that nobody asked for and no record names (`w.unrecorded`). It always happens, in
 *              full, from its date. The plan cannot know about it: it is only in the readings.
 * A pool cannot use more than it has: a reading is capped at the capacity that has landed by that week, and what could not
 * be served is reported as `unserved`. The actuals are generated: they show how the feedback loop works, not how accurate
 * the forecast would be on real usage.
 */

const { addWeeks, daysBetween } = require('./dates');
const { linearFit } = require('./forecast');
const { conversionFactor, inScope } = require('./context');

const MAX_WEEKS = 26;
const SURPRISE_MIN = -0.25;      // the pool's real growth is between 25% below and 35% above the fitted trend
const SURPRISE_MAX = 0.35;
// How much of what was asked for really shows up, as a share of it (lowest, highest).
const UPTAKE = { request: [0.6, 1], contract: [0.7, 1], event: [0.7, 1] };
const SEASONAL_REALIZED = [0.7, 1.3];      // a seasonal spike comes in at this share of its stated uplift

// A stable pseudo-random number from a text key (FNV-1a, then one mulberry32 step): no state, so week k never depends on
// how many weeks were asked for.
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function unit(key) {
  let t = (hash(key) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const normal = (key) => Math.sqrt(-2 * Math.log(Math.max(1e-12, unit(`${key}|a`)))) * Math.cos(2 * Math.PI * unit(`${key}|b`));
const between = ([lo, hi], key) => lo + (hi - lo) * unit(key);

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);

/** The generator for one pool: `at(k)` is the actual trend reading k weeks after the seed's last reading. */
function truthFor(w, poolId, series0) {
  const salt = `actuals/1|${w.meta.dataset_version}|${poolId}`;
  const window = Math.min(w.policy.forecast.window_weeks, series0.length);
  const fit = linearFit(series0.slice(-window).map((p) => p.utilized_units));
  const surprise = SURPRISE_MIN + (SURPRISE_MAX - SURPRISE_MIN) * unit(`${salt}|surprise`);
  return {
    surprise, slope: fit.slope, noise_sd: fit.resid_sd,
    at: (k) => Math.max(0, Math.round(fit.fitted_last + fit.slope * (1 + surprise) * k + normal(`${salt}|${k}`) * fit.resid_sd)),
  };
}

/** How many weeks the working copy may advance in total. Dated demand no longer limits it: it is realized. */
function advanceLimit() {
  return { max_weeks: MAX_WEEKS, reason: `${MAX_WEEKS} weeks is the most this lab generates. Contracts, events and requests that fall due inside them are realized in the actuals.` };
}

/**
 * Every dated item that could become usage, decided once from the data as it stands at the seed date: whether it happens,
 * how much of it shows up, and from which week (1 is the first new reading). Nothing here depends on how many weeks are
 * asked for, which is what keeps the first weeks the same however far the lab goes.
 * @param {object} w raw-shaped working data at the seed date
 */
function datedDemand(w) {
  const from = w.as_of;
  // Salt 1 sent only 1 of the shipped 9 requests live, a draw about 1 in 650 against the 5.7 expected. The generator is fine
  // (over 3,000 salts the mean was 5.69, with no correlation between neighbouring ids); that salt was simply unlucky, and
  // a lab whose pipeline nearly all vanishes is not a fair sample. The rule, fixed before any other salt was looked at:
  // take the first salt whose count is within one standard deviation (1.3) of the expected. That was salt 2 (5 of 9).
  const salt = `dated/2|${w.meta.dataset_version}`;
  const weekOf = (date) => Math.max(0, Math.ceil(daysBetween(from, date) / 7));
  const discount = w.policy.pipeline.overlap_discount;
  const items = [];

  for (const r of w.requests) {
    if (r.status !== 'pending') continue;     // approved and completed requests are history: their usage is already in the readings
    // A request made after the lab moved only affects readings after the day it was made, so the past is never rewritten.
    const madeIn = r.submitted_on && r.submitted_on > from ? Math.round(daysBetween(from, r.submitted_on) / 7) : 0;
    items.push({
      kind: 'request', id: r.request_id, title: r.title, pool_id: r.pool_id, team: r.team, date: r.needed_by, week: Math.max(1, weekOf(r.needed_by), madeIn + 1),
      happens: unit(`${salt}|${r.request_id}|happens`) < r.win_probability,
      asked_cu: r.cu, size: Math.round(r.cu * between(UPTAKE.request, `${salt}|${r.request_id}|uptake`)), plan_cu: r.cu * r.win_probability * (1 - discount), record: r,
    });
  }

  for (const c of w.contracts) {
    const incr = Math.max(0, c.committed_cu - c.provisioned_cu);
    if (!incr) continue;
    items.push({
      kind: 'contract', id: c.contract_id, title: c.customer, pool_id: c.pool_id, date: c.effective_date, week: Math.max(1, weekOf(c.effective_date)),
      happens: true, asked_cu: incr, size: Math.round(incr * between(UPTAKE.contract, `${salt}|${c.contract_id}|uptake`)), plan_cu: incr, record: c,
    });
  }

  // Usage nobody asked for and no record mentions (a scenario adds these to the working data). It always happens, in full, and
  // nothing the plan reads knows about it: it can only be found in the readings.
  for (const u of w.unrecorded || []) {
    items.push({ kind: 'unrecorded', shape: 'step', id: u.id, title: u.title, pool_id: u.pool_id, date: u.date, week: Math.max(1, weekOf(u.date)), happens: true, asked_cu: 0, size: u.cu, plan_cu: 0 });
  }

  for (const e of w.events) {
    const seasonal = e.signal === 'seasonal';
    const step = !seasonal && e.magnitude_cu && (e.effect === 'demand' || e.effect === 'relocate-in');
    if ((!seasonal && !step) || e.date < from) continue;
    const happens = unit(`${salt}|${e.event_id}|happens`) < e.confidence;
    for (const p of w.pools.filter((x) => inScope(e.scope, x))) {
      const key = `${salt}|${e.event_id}|${p.pool_id}`;
      items.push(seasonal
        ? { kind: 'event', shape: 'seasonal', id: e.event_id, title: e.title, pool_id: p.pool_id, date: e.date, week: Math.max(1, weekOf(e.date)), happens, duration_weeks: e.duration_weeks, uplift_pct: e.uplift_pct, factor: between(SEASONAL_REALIZED, `${key}|factor`) }
        : { kind: 'event', shape: 'step', id: e.event_id, title: e.title, pool_id: p.pool_id, date: e.date, week: Math.max(1, weekOf(e.date)), happens, asked_cu: e.magnitude_cu, size: Math.round(e.magnitude_cu * between(UPTAKE.event, `${key}|uptake`)), plan_cu: e.magnitude_cu });
    }
  }
  return items;
}

const isSpike = (it) => it.shape === 'seasonal';
/** The step-ups in effect by week k, in CU: what has gone live, taken effect or been realized as a step. */
const stepsAt = (items, k) => sum(items.filter((it) => it.happens && !isSpike(it) && it.week <= k), (it) => it.size);
/** The seasonal uplift running in week k, on a base that already has the steps in it. */
const spikeAt = (items, k, base) => sum(items.filter((it) => it.happens && isSpike(it) && it.week <= k && k < it.week + it.duration_weeks), (it) => base * it.uplift_pct * it.factor);

/**
 * Advance a working copy of the raw data by `weeks`, in place. Returns what happened.
 * @param {object} w raw-shaped working data (see data.loadRaw), as at the seed date
 */
function advance(w, weeks) {
  const from = w.as_of;
  const to = addWeeks(from, weeks);
  const skuById = Object.fromEntries(w.skus.map((s) => [s.sku_id, s]));
  const vendorById = Object.fromEntries(w.vendors.map((v) => [v.vendor_id, v]));
  const poolById = Object.fromEntries(w.pools.map((p) => [p.pool_id, p]));
  const report = { weeks, from, to, actuals: {}, organic: {}, steps_by_pool: {}, dated_by_pool: {}, unserved: {}, capacity: {}, generated_with: {}, arrivals: [], slips: [], placed: [], dated: [] };

  const items = datedDemand(w);                                            // decided before anything below changes the data
  const capacity0 = Object.fromEntries(w.pools.map((p) => [p.pool_id, p.capacity_units]));

  // ---- supply: an approved order is placed on its date; then it arrives or slips. It comes first because a pool can only
  // be as full as what has landed.
  for (const s of w.supply) {
    if (s.status === 'approved-not-placed' && s.placed_on <= to) {
      s.status = 'ordered';
      report.placed.push({ order_id: s.order_id, pool_id: s.pool_id, placed_on: s.placed_on });
    }
    if (s.status === 'racked' || s.lands_on <= from) continue;
    const pool = poolById[s.pool_id];
    const orderSku = skuById[s.sku_id] || skuById[pool.sku_id];
    const vendor = vendorById[orderSku.vendor_id];
    const samples = (vendor && vendor.observed_lead_weeks) || [];
    // how far this order strays from the plan: the vendor's own history against its typical delivery
    const slip = samples.length ? Math.round(samples[hash(`${s.order_id}|slip`) % samples.length] - median(samples)) : 0;
    const planned = s.lands_on;
    const earliest = addWeeks(from, 1);
    const actual = addWeeks(planned, slip) < earliest ? earliest : addWeeks(planned, slip);
    if (actual <= to) {
      const units = Math.round(s.cu * conversionFactor(skuById[pool.sku_id], orderSku, skuById));
      pool.capacity_units += units;
      pool.segments.push({ segment_id: `arrived-${s.order_id}`, units });
      pool.rack_count += Math.round(s.cu / orderSku.order_unit_cu);
      Object.assign(s, { status: 'racked', planned_lands_on: planned, lands_on: actual, landed_on: actual, slip_weeks: Math.round(daysBetween(planned, actual) / 7) });
      report.arrivals.push({ order_id: s.order_id, pool_id: s.pool_id, sku_id: s.sku_id, cu: s.cu, units_added: units, planned_lands_on: planned, landed_on: actual, slip_weeks: s.slip_weeks });
    } else if (planned <= to) {
      // The planned day has passed and it has not arrived: the vendor gives a new date, which is now what the plan sees.
      Object.assign(s, { planned_lands_on: planned, lands_on: actual, slip_weeks: Math.round(daysBetween(planned, actual) / 7) });
      report.slips.push({ order_id: s.order_id, pool_id: s.pool_id, sku_id: s.sku_id, cu: s.cu, planned_lands_on: planned, lands_on: actual, slip_weeks: s.slip_weeks });
    }
  }
  const capacityAt = (poolId, k) => capacity0[poolId] + sum(report.arrivals.filter((a) => a.pool_id === poolId && a.landed_on <= addWeeks(from, k)), (a) => a.units_added);

  // ---- utilization: generated actuals, then the teams keep their shares of them
  for (const u of w.utilization) {
    const series0 = u.series.slice();
    const truth = truthFor(w, u.pool_id, series0);
    const mine = items.filter((it) => it.pool_id === u.pool_id);
    const made = []; const organic = []; const stepsList = []; const dated = []; const unserved = []; const capacity = [];
    for (let k = 1; k <= weeks; k++) {
      const trend = truth.at(k);
      const steps = stepsAt(mine, k);
      const extra = Math.round(steps + spikeAt(mine, k, trend + steps));
      const cap = capacityAt(u.pool_id, k);
      const reading = Math.min(cap, trend + extra);
      made.push({ week_start: addWeeks(from, k), utilized_units: reading });
      organic.push(trend); stepsList.push(steps); dated.push(extra); unserved.push(trend + extra - reading); capacity.push(cap);
    }
    u.series.push(...made);
    Object.assign(report.actuals, { [u.pool_id]: made });
    Object.assign(report.organic, { [u.pool_id]: organic });
    Object.assign(report.steps_by_pool, { [u.pool_id]: stepsList });      // the persistent step-ups alone, in CU (a seasonal spike is in dated_by_pool but not here)
    Object.assign(report.dated_by_pool, { [u.pool_id]: dated });
    Object.assign(report.unserved, { [u.pool_id]: unserved });
    Object.assign(report.capacity, { [u.pool_id]: capacity });
    report.generated_with[u.pool_id] = { surprise: +truth.surprise.toFixed(4), slope_per_week: +truth.slope.toFixed(3), noise_sd: +truth.noise_sd.toFixed(2) };
    const latest = made.length ? made.at(-1).utilized_units : series0.at(-1).utilized_units;
    keepShares(w, u.pool_id, latest, mine.filter((it) => it.kind === 'request' && it.happens && it.week <= weeks), poolById[u.pool_id], from);
  }

  // ---- what fell due is settled, and told: so nothing is counted twice, and the outcome can say what became of it
  for (const it of items.filter((x) => x.week <= weeks)) {
    const on = addWeeks(from, it.week);
    let realized = it.happens && !isSpike(it) ? it.size : 0;
    if (isSpike(it) && it.happens) {
      // a spike's size is its largest week among the weeks lived
      const pool = items.filter((x) => x.pool_id === it.pool_id);
      for (let k = it.week; k <= Math.min(weeks, it.week + it.duration_weeks - 1); k++) {
        realized = Math.max(realized, Math.round((report.organic[it.pool_id][k - 1] + stepsAt(pool, k)) * it.uplift_pct * it.factor));
      }
    }
    const inProgress = isSpike(it) && it.happens && it.week + it.duration_weeks > weeks + 1;
    if (it.kind === 'request') Object.assign(it.record, it.happens ? { status: 'live', live_on: on, realized_cu: it.size } : { status: 'lapsed', lapsed_on: on });
    if (it.kind === 'contract') Object.assign(it.record, { provisioned_cu: it.record.committed_cu, in_effect_on: on, realized_cu: it.size });
    report.dated.push({
      kind: it.kind, shape: it.shape || null, id: it.id, title: it.title, pool_id: it.pool_id, team: it.team || null, date: it.date, in_effect_on: on,
      happened: it.happens, in_progress: inProgress, asked_cu: it.asked_cu == null ? null : it.asked_cu, plan_cu: it.plan_cu == null ? null : Math.round(it.plan_cu),
      realized_cu: realized, uplift_pct: isSpike(it) ? it.uplift_pct : null, realized_uplift_pct: isSpike(it) && it.happens ? +(it.uplift_pct * it.factor).toFixed(4) : null,
    });
  }

  // ---- held in age: recent incidents and feed deliveries
  for (const i of w.incidents) i.opened_on = addWeeks(i.opened_on, weeks);
  for (const f of w.feeds) f.last_delivered = addWeeks(f.last_delivered, weeks);

  w.as_of = to;
  w.meta.as_of = to;
  return report;
}

/**
 * The teams keep their shares of the pool's newest reading. What a request that went live added belongs to the team that
 * asked for it (which then holds it); the rest, the trend and everything not tied to a team, is shared out as before.
 */
function keepShares(w, poolId, latest, live, pool, from) {
  const allocs = w.allocations.filter((a) => a.pool_id === poolId);
  if (!allocs.length) return;
  // what each asking team now uses, never more than the pool's reading
  const want = new Map();
  for (const it of live) want.set(it.team, (want.get(it.team) || 0) + it.size);
  const wanted = sum([...want.values()]);
  const scale = wanted > latest ? latest / wanted : 1;
  const own = new Map([...want].map(([team, cu]) => [team, Math.round(cu * scale)]));
  const ownTotal = sum([...own.values()]);
  if (ownTotal > latest) [...own].sort((a, b) => b[1] - a[1]).slice(0, 1).forEach(([team, cu]) => own.set(team, cu - (ownTotal - latest)));
  const shared = latest - sum([...own.values()]);

  const total = sum(allocs, (r) => r.utilized_units);
  if (total > 0) {
    for (const a of allocs) a.utilized_units = Math.round((a.utilized_units * shared) / total);
    const gap = shared - sum(allocs, (r) => r.utilized_units);
    allocs.reduce((big, a) => (a.utilized_units > big.utilized_units ? a : big)).utilized_units += gap;
  }
  for (const [team, cu] of own) {
    if (cu <= 0) continue;
    let rec = allocs.find((a) => a.reserved_by === team);
    if (!rec) {
      rec = { pool_id: poolId, reserved_by: team, allocated_units: 0, utilized_units: 0, allocation_date: addWeeks(from, 1), low_use_weeks: 0 };
      w.allocations.push(rec);
    }
    rec.utilized_units += cu;
  }
  // what a team uses above its reservation is reserved for it, as far as the pool has room to promise
  for (const rec of w.allocations.filter((a) => a.pool_id === poolId && a.reserved_by && own.has(a.reserved_by))) {
    const room = pool.capacity_units - sum(w.allocations.filter((a) => a.pool_id === poolId), (a) => a.allocated_units);
    rec.allocated_units += Math.max(0, Math.min(room, rec.utilized_units - rec.allocated_units));
  }
}

module.exports = { advance, advanceLimit, truthFor, datedDemand, MAX_WEEKS, SURPRISE_MIN, SURPRISE_MAX, UPTAKE, SEASONAL_REALIZED };
