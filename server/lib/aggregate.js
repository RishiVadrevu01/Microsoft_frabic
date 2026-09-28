'use strict';
/*
 * Combining pools into regions and a total.
 *
 * Every pool plans at p80: the middle of its forecast plus z standard deviations. Adding the pools' p80s
 * to get a region or a total is wrong, and always in the same direction. For a group of pools to be short
 * at their combined p80 they would all have to miss on the high side together; pools whose errors do not
 * move together partly cancel, so the group's p80 sits below the sum of its members' p80s.
 *
 * So the group is combined as one distribution, in the same units the pools were planned in:
 *
 *     group demand = sum of the pools' demand  -  sum of their spreads  +  the group's own spread
 *     group spread = sqrt( sum over pairs of  R(i,j) x spread(i) x spread(j) )
 *
 * where a pool's "spread" is how far its p80 path sits above its middle (z x sigma), and R is how much two
 * pools' forecast errors move together. The dated parts of demand (pipeline, contracts, launches) are not
 * uncertain in this sense and add up exactly, so only the spread is combined.
 *
 * R is measured, not assumed: the correlation of each pair's week-to-week movements over the whole
 * history. It is floored at zero (a group is never credited with errors that offset one another, which the
 * data cannot really promise) and, when there is too little history to measure, every pair is assumed to
 * move together, which gives back the plain sum. Two consequences hold by construction and are tested:
 *   - one pool on its own is unchanged;
 *   - a region can never be worse than the plain sum, and never better than treating its pools as unrelated,
 *     and regions add up to the total the same way (a hierarchy that agrees with itself at every level).
 *
 * Nothing here changes a pool's own plan, dates or orders. Shortfall stays counted per pool: a surplus in one
 * pool cannot cover a deficit in another.
 */

const MIN_MOVEMENTS = 12;                 // fewer weekly movements than this and the correlation is not measured

const round = (x) => Math.round(x);

/** Pearson correlation of two equal-length series (0 if either does not vary). */
function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * How much pools' weekly movements go the same way, floored at zero.
 * @param {{id:string, values:number[]}[]} pools weekly utilised units, oldest first
 */
function movementCorrelation(pools) {
  const moves = pools.map((p) => p.values.slice(1).map((v, i) => v - p.values[i]));
  const m = Math.min(...moves.map((x) => x.length));
  const ids = pools.map((p) => p.id);
  const measured = m >= MIN_MOVEMENTS;
  const matrix = pools.map((_, i) => pools.map((__, j) => {
    if (i === j) return 1;
    if (!measured) return 1;
    return Math.max(0, pearson(moves[i].slice(-m), moves[j].slice(-m)));
  }));
  const pairs = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push(matrix[i][j]);
  return {
    ids, matrix, movements: measured ? m : 0, measured,
    average: pairs.length ? pairs.reduce((s, v) => s + v, 0) / pairs.length : 0,
    largest: pairs.length ? Math.max(...pairs) : 0,
  };
}

/** The spread of a group given each member's spread and how their errors move together. */
function combinedSpread(spreads, R) {
  let v = 0;
  for (let i = 0; i < spreads.length; i++) for (let j = 0; j < spreads.length; j++) v += R[i][j] * spreads[i] * spreads[j];
  return Math.sqrt(Math.max(0, v));
}

/**
 * Builds the tool for one set of pool assessments (the store's `all()`): the measured correlation, and
 * `combine`, which answers "what do we plan for across these pools, h weeks out".
 * @param {{ctx:object, verdict:object}[]} all every pool in the estate
 */
function createAggregator(all) {
  const corr = movementCorrelation(all.map((a) => ({ id: a.verdict.pool_id, values: a.ctx.values })));
  const at = new Map(corr.ids.map((id, i) => [id, i]));

  /**
   * @param {{ctx:object, verdict:object}[]} entries the pools to combine (any subset of `all`)
   * @param {number} h weeks ahead
   * @param {{prior?:boolean}} [opts] prior = the same question as the forecast stood a quarter ago
   */
  function combine(entries, h, { prior = false } = {}) {
    const plan = entries.map((a) => a.ctx.planDemandAt(h, { prior }));
    const spread = entries.map((a) => (prior ? a.ctx.priorSpreadAt(h) : a.ctx.spreadAt(h)));
    const idx = entries.map((a) => at.get(a.verdict.pool_id));
    const R = idx.map((i) => idx.map((j) => corr.matrix[i][j]));
    const sumPlan = plan.reduce((s, v) => s + v, 0);
    const sumSpread = spread.reduce((s, v) => s + v, 0);
    const own = combinedSpread(spread, R);
    return {
      plan: sumPlan - sumSpread + own,                 // the demand we plan for, combined
      p50: sumPlan - sumSpread,                        // the middle of it
      sum_of_pool_p80: sumPlan,                        // what adding the pools' p80s would give
      spread: own,
      sum_of_spreads: sumSpread,
      diversification: sumSpread - own,                // how much lower than the plain sum, in units
    };
  }

  return { corr, combine };
}

const cache = new WeakMap();
/** One aggregator per set of assessments, so a page that asks many times measures the correlation once. */
function aggregatorFor(all) {
  if (!cache.has(all)) cache.set(all, createAggregator(all));
  return cache.get(all);
}

module.exports = { movementCorrelation, combinedSpread, createAggregator, aggregatorFor, pearson, MIN_MOVEMENTS, round };
