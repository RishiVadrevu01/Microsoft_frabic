'use strict';
/*
 * The Infrastructure Capacity Overview (Central Capacity / Provider view).
 *
 * One endpoint's worth of data, computed from the same pool assessments the rest of the
 * lab uses, so every widget agrees with the pool pages. Nothing here is a new model: it
 * is arithmetic over the engine's per-pool demand, capacity and verdicts.
 *
 * Definitions (each one is also returned next to its number, so a screen can explain it):
 *   demand we plan for   the p80 forecast + weighted pipeline + dated step-ups (contracts,
 *                        relocations, launches) + a seasonal spike while its event runs.
 *                        For a region or the total, pools are combined as one distribution
 *                        (aggregate.js), not by adding each pool's p80: the p80 of a group sits
 *                        below the sum of its members' p80s unless their errors move together
 *   working ceiling      the share of capacity a pool is allowed to run at (85% general,
 *                        80% GPU, lower where users already feel strain)
 *   effective capacity   provisioned capacity x working ceiling. The headroom kept back is
 *                        the reserve; this lab does not model disaster recovery separately
 *   shortfall            demand above effective capacity, counted per pool (a surplus in one
 *                        region cannot cover a deficit in another)
 *
 * The 14 funnels are the only source of "signals". Constraint types, inventory groups and
 * actions are derived from them and from the SKU catalogue; nothing is invented.
 */

const { daysBetween, addWeeks } = require('./dates');
const { assessRequests } = require('./requests');
const { latestByPool } = require('./ledger');
const { aggregatorFor } = require('./aggregate');
const { peakOverview } = require('./peak');
const { project } = require('./geo');

const GEO = { 'north-america': 'North America', europe: 'Europe', 'asia-pacific': 'Asia Pacific', 'latin-america': 'Latin America', 'middle-east': 'Middle East' };
const GEO_ORDER = ['north-america', 'europe', 'asia-pacific', 'latin-america', 'middle-east'];
const SKU_GROUPS = { all: 'All SKUs', gpu: 'GPU', compute: 'Compute' };
const HORIZONS = [13, 26, 52];
const KPI_HORIZON = 52;
const skuGroupOf = (klass) => (klass.startsWith('gpu') ? 'gpu' : 'compute');

const PRIORITY = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P2', none: 'P2' };
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };
const STATE_RANK = { OVERDUE: 5, 'ORDER NOW': 4, PLAN: 3, WATCH: 2, OK: 1 };
const IMPACT = { critical: 'High', high: 'High', medium: 'Medium', low: 'Low', none: 'Low' };

// What a funnel that sets a plan's date means, in the words of a constraint.
const CONSTRAINT_TYPE = {
  demand: 'Physical capacity', performance: 'Performance strain', reliability: 'Reliability replacement',
  'customer-contract': 'Contract commitment', seasonal: 'Event peak', geopolitical: 'Data residency',
  strategic: 'Region growth', 'security-compliance': 'Security support',
};
const ACTION_LABEL = {
  demand: 'Procure', performance: 'Increase', reliability: 'Replace', 'cost-efficiency': 'Reclaim', strategic: 'Plan',
  dependency: 'Add resilience', sustainability: 'Optimize', 'supply-chain': 'Order earlier', 'security-compliance': 'Migrate',
  seasonal: 'Reserve', competitive: 'Monitor', 'customer-contract': 'Reserve', 'technology-shift': 'Re-weight', geopolitical: 'Relocate',
};

const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const round1 = (x) => Math.round(x * 10) / 10;
const ratio = (now, before) => (before > 0 ? now / before - 1 : null);
const weeksTo = (asOf, date) => round1(daysBetween(asOf, date) / 7);

// Earliest date a funnel's own proposals need something to happen by.
function proposalDate(result) {
  const dates = result.proposals.map((p) => p.needed_by || p.by).filter(Boolean).sort();
  return dates[0] || null;
}

function impactCu(result, verdict) {
  const p = result.proposals;
  const replace = p.find((x) => x.kind === 'replace');
  if (replace) return replace.cu;
  const add = p.filter((x) => x.kind === 'add_demand').reduce((a, x) => a + x.cu, 0);
  if (add) return Math.round(add);
  const reclaim = p.find((x) => x.kind === 'reclaim');
  if (reclaim) return reclaim.cu;
  if (result.id === 'demand' && verdict.order.needed && verdict.driver && verdict.driver.id === 'demand') return verdict.order.quantity_cu;
  return null;
}

// Says how sure the data lets us be. Numbers are only given where a record carries one; the
// rest say what the recommendation rests on. (A calibrated probability would need history we
// do not have, so none is invented.)
function confidenceFor(a) {
  const { ctx, verdict, results } = a;
  const id = verdict.driver ? verdict.driver.id : null;
  const sev = results.find((r) => r.id === id);
  if (id === 'demand') return { value: null, label: `Forecast planned at the 80th percentile (${ctx.fc.model})`, basis: 'forecast' };
  if (id === 'performance') return { value: null, label: 'Measured latency and queue strain', basis: 'telemetry' };
  if (id === 'reliability') return { value: null, label: `Incident evidence: ${sev ? sev.severity : 'flagged'}`, basis: 'incidents' };
  if (id === 'customer-contract') return { value: null, label: 'Contractual hard trigger', basis: 'contract' };
  if (id === 'security-compliance') return { value: null, label: 'Mandatory: vendor support ends', basis: 'lifecycle' };
  const signal = { seasonal: 'seasonal', strategic: 'strategic', geopolitical: 'geopolitical' }[id];
  const ev = signal ? ctx.events.filter((e) => e.signal === signal).sort((x, y) => x.date.localeCompare(y.date))[0] : null;
  if (ev) return { value: ev.confidence, label: `Confidence stated in the ${signal} record`, basis: 'record' };
  return { value: null, label: 'Driven by the funnels below', basis: 'funnels' };
}

/**
 * The action queue: everything a planner has to do, ranked. Used by the overview (top rows
 * and counts) and by the Action Queue page (all rows).
 */
function actionQueue(store, scope) {
  const asOf = store.data().as_of;
  const all = scope || store.all();
  const items = [];
  for (const a of all) {
    const v = a.verdict;
    const region = v.region_label;
    if (v.order.needed) {
      const replace = v.driver && v.driver.id === 'reliability';
      items.push({
        id: `proc-${v.pool_id}`, category: 'procurement', priority: PRIORITY[v.priority], pool_id: v.pool_id, region,
        title: replace ? `Replace failing segment and order ${v.order.quantity_cu.toLocaleString('en-US')} CU (${v.what.order_sku})` : `Procure ${v.order.quantity_cu.toLocaleString('en-US')} CU (${v.what.order_sku})`,
        due: v.dates.raise_by, state: v.state, cu: v.order.quantity_cu,
      });
    }
    if (v.reclaim.cu > 0) {
      items.push({
        id: `reclaim-${v.pool_id}`, category: 'allocation', priority: 'P2', pool_id: v.pool_id, region,
        title: `Reclaim ${Math.round(v.reclaim.cu).toLocaleString('en-US')} CU of idle reservations`, due: null, cu: v.reclaim.cu,
      });
    }
    for (const r of assessRequests(a.ctx, v)) {
      if (r.fit === 'reclaim' || (r.from_reclaim > 0)) {
        items.push({
          id: `realloc-${r.request_id}`, category: 'allocation', priority: r.priority === 'high' ? 'P1' : 'P2', pool_id: v.pool_id, region,
          title: `Reallocate ${Math.round(r.from_reclaim).toLocaleString('en-US')} CU for ${r.title}`, due: r.needed_by, cu: r.from_reclaim,
        });
      }
    }
    const dep = a.results.find((r) => r.id === 'dependency');
    if (dep && dep.flagged) items.push({ id: `resilience-${v.pool_id}`, category: 'other', priority: 'P1', pool_id: v.pool_id, region, title: `Add failover for ${region}: a single point of failure`, due: null, cu: null });
    const sec = a.results.find((r) => r.id === 'security-compliance');
    const secBy = sec && sec.flagged ? proposalDate(sec) : null;
    if (secBy) items.push({ id: `migrate-${v.pool_id}`, category: 'other', priority: 'P1', pool_id: v.pool_id, region, title: `Start migration off ${v.sku_id} before vendor support ends`, due: secBy, cu: null });
  }
  items.sort((x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority] || (x.due || '9999').localeCompare(y.due || '9999'));
  const count = (c) => items.filter((i) => i.category === c).length;
  return { as_of: asOf, counts: { all: items.length, procurement: count('procurement'), allocation: count('allocation'), other: count('other') }, items };
}

/** The pools a filter selects, and every pool (the aggregator measures how pools move together over all of them). */
function scopeOf(store, { sku = 'all', region = 'all' } = {}) {
  const everything = store.all();
  return { everything, scope: everything.filter((a) => (sku === 'all' || skuGroupOf(a.ctx.pool.sku_class) === sku) && (region === 'all' || a.ctx.pool.geo === region)) };
}

/**
 * @param {object} store the lab store
 * @param {{horizon?:13|26|52, sku?:string, region?:string}} [q]
 */
function buildOverview(store, q = {}) {
  const data = store.data();
  const P = data.policy;
  const asOf = data.as_of;
  const horizon = HORIZONS.includes(q.horizon) ? q.horizon : KPI_HORIZON;
  const sku = q.sku in SKU_GROUPS ? q.sku : 'all';
  const region = q.region in GEO ? q.region : 'all';

  const { everything, scope } = scopeOf(store, { sku, region });
  const agg = aggregatorFor(everything);                     // pools combine as one distribution, measured once

  const floorOf = (a) => a.verdict.capacity.working_floor_pct;
  const cap = (a, h) => a.ctx.usableAt(h);
  const demand = (a, h, opts) => a.ctx.planDemandAt(h, opts);
  const gap = (a, h, opts) => Math.max(0, demand(a, h, opts) - floorOf(a) * cap(a, h));

  // ---- KPI strip (always at 12 months)
  const H = KPI_HORIZON;
  const totalNow = agg.combine(scope, H);
  const totalThen = agg.combine(scope, H, { prior: true });
  const demandNow = totalNow.plan;
  const demandThen = totalThen.plan;
  const shortNow = sum(scope, (a) => gap(a, H));            // shortfall stays per pool: a surplus here cannot cover a deficit there
  const shortThen = sum(scope, (a) => gap(a, H, { prior: true }));
  const regionsAll = buildRegions(scope, horizon, P.overview, agg);
  const flaggedSignals = [];
  for (const a of scope) for (const r of a.results) if (r.flagged && !r.context_only && ['critical', 'high'].includes(r.severity)) flaggedSignals.push({ pool: a.verdict.pool_id, funnel: r.id });
  const urgent = scope.filter((a) => ['OVERDUE', 'ORDER NOW'].includes(a.verdict.state));

  const kpis = {
    total_demand: {
      value: Math.round(demandNow), delta_pct: ratio(demandNow, demandThen),
      p50: Math.round(totalNow.p50), sum_of_pool_p80: Math.round(totalNow.sum_of_pool_p80), diversification_cu: Math.round(totalNow.diversification),
      definition: `Demand we plan for at 12 months across ${scope.length} pool${scope.length === 1 ? '' : 's'}: the p80 forecast, weighted customer pipeline, dated contract and relocation step-ups, and any seasonal spike then. The pools are combined as one forecast, not by adding each pool's p80: pools whose errors do not move together partly cancel, so adding them would overstate the total by ${Math.round(totalNow.diversification).toLocaleString('en-US')} CU. Change is against the same forecast fitted ${P.overview.compare_weeks} weeks ago, with every other record held as it is now.`,
    },
    projected_shortfall: {
      value: Math.round(shortNow), delta_pct: ratio(shortNow, shortThen), share_of_demand: demandNow > 0 ? shortNow / demandNow : 0,
      definition: 'Demand above effective capacity at 12 months, counted per pool (a surplus in one region cannot cover a deficit in another). Effective capacity is provisioned capacity, including orders in flight, times the working ceiling. Drafted orders are not counted.',
    },
    regions_at_risk: {
      at_risk: regionsAll.filter((r) => r.status !== 'healthy').length, total: regionsAll.length, critical: regionsAll.filter((r) => r.status === 'at-risk').length,
      definition: `Regions on Watch or At Risk, out of the regions that hold a pool. A region is Watch from ${Math.round(P.overview.region_watch * 100)}% and At Risk above ${Math.round(P.overview.region_at_risk * 100)}% projected utilization at ${horizon / 13 * 3} months; the smaller figure counts only those At Risk.`,
    },
    reclaim: {
      cu: Math.round(sum(scope, (a) => a.verdict.reclaim.cu)), value_usd: Math.round(sum(scope, (a) => a.verdict.reclaim.value_usd)),
      definition: 'Idle reserved capacity that could be reclaimed instead of bought, valued at purchase cost.',
    },
    investment: {
      usd: Math.round(sum(urgent, (a) => a.verdict.order.cost_usd)), pools: urgent.length,
      definition: 'Cost of the drafted orders for pools that are overdue or need an order now: what it takes to resolve the critical gaps.',
    },
    critical_signals: {
      count: flaggedSignals.length, funnels: new Set(flaggedSignals.map((s) => s.funnel)).size,
      definition: 'Funnel results on a pool that are flagged critical or high, counted once per funnel per pool. Competitive intel is context only and is not counted.',
    },
  };

  // ---- demand vs capacity forecast, monthly
  const months = horizon === 13 ? 3 : horizon === 26 ? 6 : 12;
  const forecast = [];
  for (let i = 0; i <= months; i++) {
    const h = Math.round((i * 52) / 12);
    const date = addWeeks(asOf, h);
    forecast.push({
      month: i, week: h, date,
      demand: Math.round(agg.combine(scope, h).plan),
      provisioned: Math.round(sum(scope, (a) => cap(a, h))),
      effective: Math.round(sum(scope, (a) => floorOf(a) * cap(a, h))),
      shortfall: Math.round(sum(scope, (a) => gap(a, h))),
    });
  }
  const peak = forecast.reduce((best, p) => (p.shortfall > (best ? best.shortfall : 0) ? p : best), null);

  // ---- top constraints, derived from the funnels that set each pool's plan
  const constraints = [];
  for (const a of scope) {
    const v = a.verdict;
    if (v.state === 'OK') continue;
    const driver = a.results.find((r) => v.driver && r.id === v.driver.id);
    if (driver) constraints.push({ pool_id: v.pool_id, region: v.region_label, resource: v.sku_id, type: CONSTRAINT_TYPE[driver.id] || driver.name, impact: IMPACT[driver.severity], lead_weeks: v.lead.weeks, funnel: driver.id });
    const supply = a.results.find((r) => r.id === 'supply-chain');
    if (supply && supply.flagged && !(driver && driver.id === 'supply-chain')) {
      constraints.push({ pool_id: v.pool_id, region: v.region_label, resource: v.what.order_sku, type: 'SKU availability', impact: IMPACT[supply.severity], lead_weeks: v.lead.weeks, funnel: 'supply-chain' });
    }
  }
  const impactRank = { High: 0, Medium: 1, Low: 2 };
  constraints.sort((x, y) => impactRank[x.impact] - impactRank[y.impact] || y.lead_weeks - x.lead_weeks);

  // ---- critical recommendations
  const ranked = [...scope].sort((x, y) => STATE_RANK[y.verdict.state] - STATE_RANK[x.verdict.state]
    || PRIORITY_RANK[PRIORITY[x.verdict.priority]] - PRIORITY_RANK[PRIORITY[y.verdict.priority]]
    || (x.verdict.dates.raise_by || '9999').localeCompare(y.verdict.dates.raise_by || '9999'));
  const recommendations = ranked.filter((a) => a.verdict.order.needed).map((a) => {
    const v = a.verdict;
    const replace = v.driver && v.driver.id === 'reliability';
    const weeksLeft = v.dates.needed_by ? weeksTo(asOf, v.dates.needed_by) : null;
    const seg = a.results.find((r) => r.id === 'reliability').proposals.find((p) => p.kind === 'replace');
    return {
      id: `rec-${v.pool_id}`, pool_id: v.pool_id, region: v.region_label, severity: v.priority, kind: replace ? 'replace' : 'procure', state: v.state,
      title: replace && seg ? `Replace ${seg.segment} (${seg.cu.toLocaleString('en-US')} CU) in ${v.region_label}` : `Procure ${v.order.quantity_cu.toLocaleString('en-US')} CU of ${v.what.order_sku} for ${v.region_label}`,
      rationale: weeksLeft != null && v.lead.weeks > weeksLeft
        ? `Lead time (${v.lead.weeks} weeks) is longer than the time left before capacity is needed (${weeksLeft} weeks).`
        : v.driver.headline,
      converging: a.results.filter((r) => r.flagged && !r.context_only).length,
      driver: v.driver ? { id: v.driver.id, name: v.driver.name, kind: v.driver.kind, headline: v.driver.headline } : null,
      confidence: confidenceFor(a),
      shortfall_cu: Math.round(v.order.need_units), quantity_cu: v.order.quantity_cu, sku: v.what.order_sku,
      need_by: v.dates.needed_by, weeks_left: weeksLeft, raise_by: v.dates.raise_by, cost_usd: v.order.cost_usd,
      impact: replace ? 'Service risk' : null,
    };
  });

  // ---- capacity supply and inventory, by SKU
  const bySku = new Map();
  for (const a of scope) {
    const v = a.verdict;
    const row = bySku.get(v.sku_id) || { sku_id: v.sku_id, label: v.sku_label, group: skuGroupOf(v.sku_class), total: 0, available: 0, utilized: 0, lead_weeks: 0, worst: 'OK', pools: [] };
    row.total += a.ctx.usableAt(0) + sum(a.ctx.inflight, (s) => s.cu * a.ctx.equiv(s));
    row.available += v.capacity.free_now; row.utilized += v.capacity.utilized;
    row.lead_weeks = Math.max(row.lead_weeks, v.lead.weeks);
    if (STATE_RANK[v.state] > STATE_RANK[row.worst]) row.worst = v.state;
    row.pools.push(v.pool_id);
    bySku.set(v.sku_id, row);
  }
  const inventoryRows = [...bySku.values()].map((r) => {
    const installed = r.pools.reduce((s, id) => s + everything.find((a) => a.verdict.pool_id === id).ctx.usableAt(0), 0);
    return {
      sku_id: r.sku_id, label: r.label, group: r.group, total_capacity: Math.round(r.total), available: Math.round(r.available),
      utilization: installed > 0 ? r.utilized / installed : 0, lead_weeks: r.lead_weeks,
      status: ['OVERDUE', 'ORDER NOW'].includes(r.worst) ? 'Constrained' : ['PLAN', 'WATCH'].includes(r.worst) ? 'Watch' : 'Available', pools: r.pools.length,
    };
  }).sort((x, y) => y.total_capacity - x.total_capacity);

  // ---- signals driving capacity decisions: flagged funnel results, ranked
  const signals = [];
  for (const a of scope) {
    const v = a.verdict;
    for (const r of a.results) {
      if (!r.flagged || r.context_only) continue;
      const date = proposalDate(r);
      signals.push({
        priority: PRIORITY[r.severity], funnel_id: r.id, funnel: r.name, number: r.number, severity: r.severity, pool_id: v.pool_id,
        resource: `${v.sku_id} | ${v.region_label}`, impact_cu: impactCu(r, v), horizon_weeks: date ? weeksTo(asOf, date) : null,
        action: ACTION_LABEL[r.id] || 'Review', headline: r.headline,
      });
    }
  }
  signals.sort((x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority] || (x.horizon_weeks == null) - (y.horizon_weeks == null) || (x.horizon_weeks || 0) - (y.horizon_weeks || 0) || x.number - y.number);

  // ---- optimization opportunities: idle reservations
  const optimization = scope.filter((a) => a.verdict.reclaim.cu > 0).map((a) => ({
    pool_id: a.verdict.pool_id, region: a.verdict.region_label, sku_id: a.verdict.sku_id,
    current: a.verdict.capacity.utilization_of_usable, excess_cu: Math.round(a.verdict.reclaim.cu), savings_usd: Math.round(a.verdict.reclaim.value_usd), action: 'Reclaim',
  })).sort((x, y) => y.savings_usd - x.savings_usd);

  // ---- upcoming procurement needs: drafted orders, then what is already in flight
  const decisions = latestByPool(store.state().decisions);
  const procurement = [];
  for (const a of scope) {
    const v = a.verdict;
    if (v.order.needed) {
      const d = decisions[v.pool_id];
      procurement.push({
        pool_id: v.pool_id, sku_id: v.what.order_sku, region: v.region_label, quantity_cu: v.order.quantity_cu, date: v.dates.needed_by, date_kind: 'need_by',
        status: d ? { approve: 'Approved', defer: 'In review', decline: 'Declined' }[d.decision] : 'Not started',
      });
    }
    for (const s of a.ctx.inflight) {
      procurement.push({ pool_id: v.pool_id, sku_id: s.sku_id, region: v.region_label, quantity_cu: s.cu, date: s.lands_on, date_kind: 'lands', status: s.status === 'approved-not-placed' ? 'Approved' : s.status === 'in-transit' ? 'In transit' : 'Ordered', order_id: s.order_id });
    }
  }
  procurement.sort((x, y) => x.date.localeCompare(y.date));

  // ---- action queue
  const queue = actionQueue(store, scope);

  return {
    as_of: asOf, view: 'provider', source: 'synthetic',
    filters: {
      horizon, sku, region,
      options: {
        horizons: HORIZONS.map((w) => ({ weeks: w, label: `${w / 13 * 3} months` })),
        skus: Object.entries(SKU_GROUPS).map(([key, label]) => ({ key, label })),
        regions: [{ key: 'all', label: 'All regions' }, ...GEO_ORDER.filter((k) => everything.some((a) => a.ctx.pool.geo === k)).map((key) => ({ key, label: GEO[key] }))],
      },
    },
    headline: summaryHeadline(scope),
    horizons: HORIZONS.map((w, i) => {
      const statuses = scope.map((a) => a.verdict.horizons[i].status);
      return { weeks: w, label: `${w / 13 * 3} months`, answer: statuses.includes('at-risk') ? 'At risk' : statuses.includes('act') ? 'Act' : 'Good' };
    }),
    kpis,
    aggregation: {
      method: 'one combined distribution',
      definition: 'Regions and the total are forecast as one distribution built from the pools, not by adding each pool\'s p80. How much two pools\' errors move together is measured from their week-to-week movements and never taken below zero. One pool on its own is unchanged.',
      movements: agg.corr.movements, measured: agg.corr.measured, average_correlation: round1(agg.corr.average * 100) / 100, largest_correlation: round1(agg.corr.largest * 100) / 100,
    },
    peak: peakOverview(store, scope),
    regions: regionsAll,
    forecast: { months, horizon_weeks: horizon, points: forecast, peak_shortfall: peak && peak.shortfall > 0 ? { cu: peak.shortfall, date: peak.date, month: peak.month } : null },
    constraints: constraints.slice(0, 5),
    recommendations: recommendations.slice(0, 3),
    inventory: { groups: Object.entries(SKU_GROUPS).map(([key, label]) => ({ key, label, count: key === 'all' ? inventoryRows.length : inventoryRows.filter((r) => r.group === key).length })).filter((g) => g.count > 0), rows: inventoryRows },
    signals: signals.slice(0, 6),
    signals_total: signals.length,
    optimization: optimization.slice(0, 4),
    procurement: procurement.slice(0, 5),
    action_queue: {
      counts: queue.counts, items: queue.items.slice(0, 5),
      by_category: Object.fromEntries(['procurement', 'allocation', 'other'].map((c) => [c, queue.items.filter((i) => i.category === c).slice(0, 5)])),
    },
  };
}

// The answer-first sentence, kept from the Overview the stakeholders asked for.
function summaryHeadline(scope) {
  const n = scope.length;
  const by = (s) => scope.filter((a) => a.verdict.state === s).length;
  const overdue = by('OVERDUE'); const now = by('ORDER NOW'); const plan = by('PLAN');
  if (!n) return 'No pools match these filters.';
  if (overdue) return `No. ${overdue} of ${n} pools ${overdue === 1 ? 'is' : 'are'} already past the date an order should have been placed, and ${now} more ${now === 1 ? 'needs' : 'need'} an order now.`;
  if (now) return `Not yet. ${now} of ${n} pools ${now === 1 ? 'needs' : 'need'} an order placed now to stay ahead of demand.`;
  if (plan) return `Yes for now. ${plan} of ${n} pools will need an order within six months.`;
  return `Yes. All ${n} pools are good for the next 12 months.`;
}

function buildRegions(scope, horizon, ov, agg) {
  const groups = new Map();
  for (const a of scope) {
    const key = a.ctx.pool.geo;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return GEO_ORDER.filter((k) => groups.has(k)).map((key) => {
    const pools = groups.get(key);
    const capacity = sum(pools, (a) => a.ctx.usableAt(horizon));
    const combined = agg.combine(pools, horizon);
    const demand = combined.plan;
    const utilization = capacity > 0 ? demand / capacity : 0;
    // A region sits at the capacity-weighted centre of its pools' data centres, in the same projection the map's
    // outline is drawn in, so it leans toward where most of its capacity is.
    const weight = sum(pools, (a) => a.ctx.pool.capacity_units);
    const lat = sum(pools, (a) => a.ctx.pool.lat * a.ctx.pool.capacity_units) / weight;
    const lon = sum(pools, (a) => a.ctx.pool.lon * a.ctx.pool.capacity_units) / weight;
    return {
      key, label: GEO[key], utilization, capacity_cu: Math.round(capacity), demand_cu: Math.round(demand), sum_of_pool_p80_cu: Math.round(combined.sum_of_pool_p80),
      lat: round1(lat * 100) / 100, lon: round1(lon * 100) / 100, map: project(lat, lon),
      status: utilization > ov.region_at_risk ? 'at-risk' : utilization >= ov.region_watch ? 'watch' : 'healthy',
      pools: pools.map((a) => ({ pool_id: a.verdict.pool_id, label: `${a.verdict.region_label} · ${a.verdict.sku_id}`, state: a.verdict.state })),
    };
  });
}

module.exports = { buildOverview, actionQueue, scopeOf, GEO, SKU_GROUPS, HORIZONS };
