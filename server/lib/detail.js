'use strict';
// Everything the pool page draws, computed once on the server so the browser
// holds no capacity logic: chart series, reservations, requests, lifecycle.

const { addWeeks } = require('./dates');
const { reservations } = require('./funnels');
const { assessRequests } = require('./requests');
const { HORIZON_WEEKS } = require('./context');
const { decisionsForPool } = require('./ledger');
const { peakFor } = require('./peak');
const { approvalCheck } = require('./approval');

const CHART_WEEKS = 52;

function lifecycleOf(ctx, data) {
  const chain = [ctx.sku.sku_id];
  let cur = ctx.sku;
  while (cur.replaced_by_sku && chain.length < 8) { cur = data.skuById[cur.replaced_by_sku]; chain.push(cur.sku_id); }
  return {
    sku_id: ctx.sku.sku_id, label: ctx.sku.label, status: ctx.sku.status, eol_date: ctx.sku.eol_date || null,
    last_time_buy: ctx.sku.last_time_buy || null, replaced_by: ctx.sku.replaced_by_sku || null,
    factor: ctx.sku.capacity_equivalence_factor || null, order_sku: ctx.orderSku.sku_id, chain,
  };
}

function poolDetail(store, poolId) {
  const { ctx, verdict } = store.assessment(poolId);
  const data = store.data();
  const H = Math.min(CHART_WEEKS, HORIZON_WEEKS);
  const point = (h, value) => ({ date: ctx.dateOf(h), value: Math.round(value) });
  const orderEq = verdict.order.equivalent_cu;
  const hLand = verdict.dates.lands_on ? ctx.hOf(verdict.dates.lands_on) : null;
  const floor = verdict.capacity.working_floor_pct;
  const range = (fn) => Array.from({ length: H + 1 }, (_, h) => fn(h));

  const markers = [];
  const d = verdict.dates;
  if (verdict.order.needed) {
    if (d.needed_by) markers.push({ kind: 'needed', date: d.needed_by, label: 'Capacity needed' });
    if (d.raise_by) markers.push({ kind: 'raise', date: d.raise_by < ctx.asOf ? ctx.asOf : d.raise_by, label: d.raise_by < ctx.asOf ? 'Order was due (overdue)' : 'Order by', actual: d.raise_by });
    if (d.lands_on) markers.push({ kind: 'lands', date: d.lands_on, label: 'Capacity lands' });
  }
  if (d.mandatory_by) markers.push({ kind: 'deadline', date: d.mandatory_by, label: 'Mandatory migration start' });
  for (const c of ctx.contracts) if (c.committed_cu > c.provisioned_cu) markers.push({ kind: 'contract', date: c.effective_date, label: c.customer.split(' (')[0] });
  for (const e of ctx.events) if (['seasonal', 'geopolitical'].includes(e.signal) && e.date >= ctx.asOf) markers.push({ kind: 'event', date: e.date, label: e.title });
  const limit = addWeeks(ctx.asOf, H);
  const visible = markers.filter((m) => m.date <= limit).sort((a, b) => a.date.localeCompare(b.date));

  const recent = ctx.incidents.filter((i) => i.opened_on >= addWeeks(ctx.asOf, -13)).sort((a, b) => b.opened_on.localeCompare(a.opened_on));

  return {
    as_of: ctx.asOf,
    verdict,
    pool: data.poolById[poolId],
    lifecycle: lifecycleOf(ctx, data),
    chart: {
      horizon_weeks: H,
      history: ctx.series.map((s) => ({ date: s.week_start, value: s.utilized_units })),
      p50: range((h) => point(h, ctx.p50At(h))),
      upper: range((h) => point(h, ctx.upperAt(h))),
      lower: range((h) => point(h, h === 0 ? ctx.latest : ctx.fc.lower[h - 1])),
      usable: range((h) => point(h, ctx.usableAt(h))),
      ceiling: range((h) => point(h, floor * ctx.usableAt(h))),
      ceiling_with_order: verdict.order.needed
        ? range((h) => point(h, floor * (ctx.usableAt(h) + (h >= hLand ? orderEq : 0))))
        : null,
      markers: visible,
    },
    reservations: reservations(ctx).map((r) => ({
      reserved_by: r.reserved_by, allocated_units: r.allocated_units, utilized_units: r.utilized_units,
      use_ratio: r.use_ratio, low_use_weeks: r.low_use_weeks, idle: r.idle, reclaimable: r.reclaimable,
    })),
    requests: assessRequests(ctx, verdict),
    supply: ctx.inflight,
    peak_check: peakFor(store, poolId),
    // what approving the drafted order would need (the browser asks again when the quantity is changed)
    approval: verdict.order.needed ? approvalCheck(store, poolId, null) : null,
    incidents: recent.slice(0, 8),
    decisions: decisionsForPool(store.state().decisions, poolId),
  };
}

module.exports = { poolDetail, lifecycleOf };
