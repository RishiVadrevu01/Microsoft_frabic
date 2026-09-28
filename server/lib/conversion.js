'use strict';
/*
 * Conversion calculator (the Build Brief's "Intel to AMD migration scenario").
 * A successor SKU is worth `ratio` units of the SKU it replaces. Swapping M old
 * units for M new units, rack for rack, therefore adds M x (ratio - 1) of
 * usable capacity; buying only M / ratio new units keeps capacity constant.
 * Returns pre- and post-migration headroom against the pool's working ceiling.
 */

const { HttpError } = require('./store');
const { cu, pct, usd } = require('./format');

function conversion(store, body) {
  const { ctx, verdict } = store.assessment(body.pool_id);
  const data = store.data();
  const from = ctx.sku;
  const to = from.replaced_by_sku ? data.skuById[from.replaced_by_sku] : null;
  if (!to) throw new HttpError(400, `${from.sku_id} has no successor SKU, so there is nothing to convert to.`);

  const ratio = body.ratio == null || body.ratio === '' ? from.capacity_equivalence_factor : Number(body.ratio);
  if (!(ratio >= 0.5 && ratio <= 5)) throw new HttpError(400, 'ratio must be between 0.5 and 5.');
  const swap = body.swap_units == null || body.swap_units === '' ? Math.min(ctx.pool.capacity_units, Math.round(ctx.usable0)) : Number(body.swap_units);
  if (!Number.isInteger(swap) || swap < 1 || swap > ctx.pool.capacity_units) throw new HttpError(400, `swap_units must be a whole number between 1 and ${ctx.pool.capacity_units}.`);

  const floor = verdict.capacity.working_floor_pct;
  const used = ctx.latest;
  const usablePre = ctx.usable0;
  const usablePost = usablePre + swap * (ratio - 1);
  const headroom = (usable) => floor * usable - used;
  const neutralUnits = swap / ratio;

  return {
    pool_id: ctx.pool.pool_id,
    from_sku: from.sku_id, to_sku: to.sku_id, ratio, swap_units: swap,
    pre: { usable: usablePre, utilization: used / usablePre, headroom: headroom(usablePre) },
    post: { usable: usablePost, utilization: used / usablePost, headroom: headroom(usablePost) },
    capacity_gain_cu: swap * (ratio - 1),
    swap_cost_usd: swap * to.unit_cost_usd,
    neutral: { new_units: neutralUnits, cost_usd: neutralUnits * to.unit_cost_usd },
    explain: `Swapping ${cu(swap)} of ${from.sku_id} for the same number of ${to.sku_id} units, rack for rack, adds ${cu(swap * (ratio - 1))} `
      + `(each new unit is worth ${ratio} old units) and costs about ${usd(swap * to.unit_cost_usd)}. `
      + `To keep capacity exactly the same you would buy only ${cu(neutralUnits)} (${usd(neutralUnits * to.unit_cost_usd)}). `
      + `Utilization moves from ${pct(used / usablePre, 1)} to ${pct(used / usablePost, 1)} of usable capacity.`,
  };
}

module.exports = { conversion };
