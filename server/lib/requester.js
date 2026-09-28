'use strict';
/*
 * The Product Team (Requester) view: "my capacity requests, and will I get what I asked for?"
 *
 * The Central Capacity view answers "are we good?" for the whole estate. This answers the same question
 * for one requester: their requests, and for the one selected, how much of it can be served, when, at what
 * cost, and what to do about the rest. Nothing here is a new model. Every figure is one of three things:
 *
 *   a record        what the requester states (org, use case, revenue at risk, SLA impact), what the team holds
 *                   (its reservations), the request itself
 *   the assessment  the same arithmetic the planner uses for a queue of requests (requests.js): served in
 *                   need-by order from free capacity, then idle reservations, then supply already in flight,
 *                   then a new order, which is what is left
 *   the plan        the pool's own verdict: whether an order is drafted, when it lands, what drives the date
 *
 * A request is served in PHASES: what is available now (free capacity and idle reservations), what lands from
 * supply that is already ordered, and what needs a new order. The recommendation, the options, the timeline and
 * the cost all read from those phases, so they cannot disagree with one another.
 *
 * The recommendation, the options and the risks are RULES over those, written out in words. There is no
 * confidence percentage: the engine does not produce one, so none is shown, and it says what the advice rests on.
 *
 * Definitions worth knowing (each is also returned beside its number):
 *   at risk       the part of the ask that needs a new order would arrive after the need date
 *   additional    the part of the ask with no capacity today (it needs an order)
 *   demand        the team's usage in that pool, grown at the pool's forecast (p80), plus the ask from its need date.
 *                 The ask is counted in full: the requester says they need it. The planner's view weights it by
 *                 win probability; this one does not.
 *   cost          purchase cost at the SKU's unit cost. Existing capacity is valued but is not new spend. This is a
 *                 one-off purchase, not an annual run-rate: the lab has no operating-cost data.
 */

const { addWeeks, daysBetween, fmt } = require('./dates');
const { assessRequests } = require('./requests');
const { HttpError } = require('./store');
const { cu, usd } = require('./format');

const HORIZONS = [13, 26, 52];
const GEO_LABEL = { 'north-america': 'North America', europe: 'Europe', 'asia-pacific': 'Asia Pacific', 'latin-america': 'Latin America', 'middle-east': 'Middle East' };
const WORKLOAD = { analytics: 'Analytics', 'ai-assist': 'AI assistant', streaming: 'Streaming analytics', warehouse: 'Data warehouse', bi: 'Business intelligence', 'ai-training': 'AI training', 'ai-inference': 'AI inference', general: 'General' };
const SOURCE = { 'onboarding-queue': 'Onboarding queue', 'sales-pipeline': 'Sales pipeline', 'growth-forecast': 'Growth forecast' };
const DRIVER = { 'onboarding-queue': 'Customer onboarding', 'sales-pipeline': 'New business (sales pipeline)', 'growth-forecast': 'Product growth (forecast)' };
const STATUS_LABEL = { 'at-risk': 'At risk', 'in-review': 'In review', approved: 'Approved', completed: 'Completed', declined: 'Declined', live: 'Live', lapsed: 'Did not go ahead' };
const SEV_LABEL = { critical: 'High', high: 'High', medium: 'Medium', low: 'Low', none: 'Low' };
const SEV_RANK = { High: 0, Medium: 1, Low: 2 };

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const label = (map, key) => map[key] || cap(String(key || '').replace(/-/g, ' '));
const round = (x) => Math.round(x);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4]}`;
const weeksLabel = (n) => `${n} week${n === 1 ? '' : 's'}`;
const joinAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Who is asking: the org on the record, or the first word of the team name for a request made through the API. */
const orgLabelOf = (r) => r.org || cap(String(r.team).split('-')[0]);
const orgKeyOf = (r) => orgLabelOf(r).toLowerCase();

// Percentages that add up to exactly 100 (largest remainder).
function shares(values) {
  const total = sum(values, (v) => v);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - sum(out, (v) => v);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out;
}

/** What the engine's assessment of one pending request means for the requester. */
function classify(r, asmt, a, asOf) {
  const v = a.verdict;
  const needs = asmt.needs_order;
  let expected = null;
  let via = null;       // what the last part waits for: the drafted order, an order already placed, or one not yet placed
  if (needs > 0) {
    const placed = a.ctx.inflight.map((s) => s.lands_on).filter((d) => d > r.needed_by).sort()[0];
    if (v.order.needed && v.dates.lands_on) { expected = v.dates.lands_on; via = 'drafted'; }
    else if (placed) { expected = placed; via = 'placed'; }
    else { expected = addWeeks(asmt.order_by && asmt.order_by > asOf ? asmt.order_by : asOf, v.lead.weeks); via = 'new'; }
  }
  const lateDays = expected && expected > r.needed_by ? daysBetween(r.needed_by, expected) : 0;
  const lateWeeks = Math.ceil(lateDays / 7);
  return { needs, expected, via, lateWeeks, atRisk: needs > 0 && lateDays > 0 };
}

/** The ways the ask gets served, in the order they arrive: now, from supply already ordered, from a new order. */
function phasesOf(r, asmt, c, ctx, asOf) {
  const phases = [];
  if (asmt.from_free + asmt.from_reclaim > 0) phases.push({ kind: 'now', cu: asmt.from_free + asmt.from_reclaim, date: asOf, free: asmt.from_free, reclaim: asmt.from_reclaim });
  if (asmt.from_in_flight > 0) {
    const landing = ctx.inflight.filter((s) => s.lands_on <= r.needed_by).map((s) => s.lands_on).sort()[0] || r.needed_by;
    phases.push({ kind: 'inflight', cu: asmt.from_in_flight, date: landing });
  }
  if (c.needs > 0) phases.push({ kind: 'order', cu: c.needs, date: c.expected, late_weeks: c.lateWeeks, via: c.via });
  return phases;
}

const statusOf = (r, c) => (r.status === 'pending' ? (c.atRisk ? 'at-risk' : 'in-review') : r.status);

function recommendedFor(r, asmt, c) {
  if (r.status === 'approved') return { kind: 'proceed', label: 'Proceed as planned' };
  if (r.status === 'completed') return { kind: 'done', label: 'Delivered' };
  if (r.status === 'live') return { kind: 'done', label: 'In use' };
  if (r.status === 'declined' || r.status === 'lapsed') return { kind: 'none', label: '—' };
  const early = asmt.from_free + asmt.from_reclaim + asmt.from_in_flight;
  if (c.needs === 0 && asmt.from_reclaim > 0) return { kind: 'reallocate', label: `Reallocate ${cu(asmt.from_reclaim)}` };
  if (c.needs === 0 && asmt.from_in_flight > 0) return { kind: 'wait', label: 'Proceed: supply lands in time' };
  if (c.needs === 0) return { kind: 'proceed', label: 'Proceed as planned' };
  if (c.atRisk && early > 0) return { kind: 'phase', label: 'Phase deployment' };
  if (c.atRisk) return { kind: 'move-date', label: `Move the date to ${fmt(c.expected)}` };
  return { kind: 'proceed', label: 'Proceed: capacity lands in time' };
}

/**
 * @param {object} store the lab store
 * @param {{org?:string, request?:string, region?:string, horizon?:13|26|52}} [q]
 */
function buildRequester(store, q = {}) {
  const data = store.data();
  const asOf = data.as_of;
  const all = store.all();
  const byPool = new Map(all.map((a) => [a.verdict.pool_id, a]));
  const horizon = HORIZONS.includes(q.horizon) ? q.horizon : 52;
  const region = q.region && q.region !== 'all' ? q.region : 'all';
  if (region !== 'all' && !GEO_LABEL[region]) throw new HttpError(400, `region must be all or one of ${Object.keys(GEO_LABEL).join(', ')}.`);

  // ---- every pending request, assessed the way the planner assesses it
  const assessed = new Map();
  for (const a of all) {
    for (const s of assessRequests(a.ctx, a.verdict)) {
      const req = data.requests.find((r) => r.request_id === s.request_id);
      assessed.set(s.request_id, { asmt: s, a, c: classify(req, s, a, asOf) });
    }
  }
  const infoOf = (r) => assessed.get(r.request_id) || null;

  // ---- who is asking
  const orgs = new Map();
  for (const r of data.requests) {
    const key = orgKeyOf(r);
    const o = orgs.get(key) || { key, label: orgLabelOf(r), count: 0, at_risk: 0 };
    o.count += 1;
    const x = infoOf(r);
    if (x && x.c.atRisk) o.at_risk += 1;
    orgs.set(key, o);
  }
  // Someone with a request at risk first, then whoever asks for the most.
  const orgList = [...orgs.values()].sort((x, y) => Number(y.at_risk > 0) - Number(x.at_risk > 0) || y.count - x.count || x.label.localeCompare(y.label));
  if (!orgList.length) throw new HttpError(404, 'There are no requests in this dataset.');
  const orgKey = q.org ? String(q.org).toLowerCase() : orgList[0].key;
  if (!orgs.has(orgKey)) throw new HttpError(400, `org must be one of ${orgList.map((o) => o.key).join(', ')}.`);
  const mine = data.requests.filter((r) => orgKeyOf(r) === orgKey);

  // ---- the requests table
  const rowOf = (r) => {
    const a = byPool.get(r.pool_id);
    const x = infoOf(r);
    const pending = r.status === 'pending';
    const status = pending ? statusOf(r, x.c) : r.status;
    return {
      request_id: r.request_id, title: r.title, team: r.team, workload: r.workload, workload_label: label(WORKLOAD, r.workload),
      pool_id: r.pool_id, region: a.verdict.region_label, geo: a.ctx.pool.geo, sku_id: a.verdict.sku_id,
      requested_cu: r.cu, additional_cu: pending ? x.c.needs : 0, need_by: r.needed_by,
      status, status_label: STATUS_LABEL[status] || cap(status), recommended: pending ? recommendedFor(r, x.asmt, x.c) : recommendedFor(r, null, null),
      priority: r.priority, submitted_on: r.submitted_on || null,
    };
  };
  const urgency = (row) => ({ 'at-risk': 0, 'in-review': 1, approved: 2, live: 3, completed: 4, declined: 5, lapsed: 5 }[row.status]);
  const allRows = mine.map(rowOf).sort((x, y) => urgency(x) - urgency(y) || x.need_by.localeCompare(y.need_by) || x.request_id.localeCompare(y.request_id));
  const rows = allRows.filter((row) => region === 'all' || row.geo === region);
  const count = (s) => rows.filter((row) => row.status === s).length;
  const counts = { all: rows.length, at_risk: count('at-risk'), in_review: count('in-review'), approved: count('approved'), live: count('live'), completed: count('completed'), declined: count('declined'), lapsed: count('lapsed') };

  // ---- the selected request
  let selected = q.request ? mine.find((r) => r.request_id === q.request) : null;
  if (q.request && !selected) throw new HttpError(400, `request must be one of ${mine.map((r) => r.request_id).join(', ')} for this org.`);
  if (!selected) { const first = rows[0] || allRows[0]; selected = first ? mine.find((r) => r.request_id === first.request_id) : null; }
  const detail = selected ? buildDetail(data, all, byPool, assessed, selected, horizon) : null;

  const regionOptions = [{ key: 'all', label: 'All regions' }, ...Object.keys(GEO_LABEL).filter((g) => allRows.some((row) => row.geo === g)).map((key) => ({ key, label: GEO_LABEL[key] }))];
  return {
    as_of: asOf, view: 'requester', source: 'synthetic',
    filters: {
      org: orgKey, request: selected ? selected.request_id : null, region, horizon,
      options: {
        orgs: orgList.map((o) => ({ key: o.key, label: o.label, requests: o.count, at_risk: o.at_risk })),
        requests: allRows.map((row) => ({ request_id: row.request_id, title: row.title, status: row.status, region: row.region })),
        regions: regionOptions,
        horizons: HORIZONS.map((w) => ({ weeks: w, label: `${w / 13 * 3} months` })),
      },
    },
    requester: { key: orgKey, label: orgs.get(orgKey).label, requests: mine.length },
    requests: { counts, rows, definition: 'At risk: the part of the request that needs a new order would arrive after it is needed. In review: waiting for a decision and on track. Approved, completed, live and lapsed requests are history, not demand: a live request is in the usage now, and a lapsed one did not go ahead.' },
    ...(detail || {}),
  };
}

// ------------------------------------------------------------------ everything about one request
function buildDetail(data, all, byPool, assessed, r, horizon) {
  const asOf = data.as_of;
  const a = byPool.get(r.pool_id);
  const { ctx, verdict: v } = a;
  const x = assessed.get(r.request_id) || null;
  const pending = r.status === 'pending';
  const asmt = x ? x.asmt : null;
  const c = x ? x.c : null;
  const regionName = v.region_label;
  const poolLabel = `${regionName} · ${v.sku_id}`;

  // ---- what the team holds in this pool
  const held = data.allocations.filter((al) => al.reserved_by === r.team && al.pool_id === r.pool_id);
  const allocated = sum(held, (al) => al.allocated_units);
  const used = sum(held, (al) => al.utilized_units);
  const elsewhere = data.allocations.filter((al) => al.reserved_by === r.team && al.pool_id !== r.pool_id)
    .map((al) => ({ pool_id: al.pool_id, region: byPool.get(al.pool_id).verdict.region_label, allocated_cu: al.allocated_units, used_cu: al.utilized_units }));
  const share = ctx.latest > 0 ? used / ctx.latest : 0;
  const g80 = (h) => (h <= 0 ? 1 : ctx.upperAt(h) / ctx.latest);
  const g50 = (h) => (h <= 0 ? 1 : ctx.p50At(h) / ctx.latest);

  // ---- what the assessment says about the ask, in phases
  const ask = r.cu;
  const free = asmt ? asmt.from_free : 0;
  const reclaim = asmt ? asmt.from_reclaim : 0;
  const inflight = asmt ? asmt.from_in_flight : 0;
  const now = free + reclaim;
  const early = now + inflight;                             // in hand by the need date
  const needs = c ? c.needs : 0;
  const expected = c ? c.expected : null;
  const lateWeeks = c ? c.lateWeeks : 0;
  const atRisk = c ? c.atRisk : false;
  const status = pending ? (atRisk ? 'at-risk' : 'in-review') : r.status;
  const phases = pending ? phasesOf(r, asmt, c, ctx, asOf) : [];
  const orderSku = ctx.orderSku;
  // An order already placed is committed spend, not new; only a drafted or not-yet-placed order is.
  const newSpend = needs > 0 && c.via !== 'placed' ? (needs / ctx.factor) * orderSku.unit_cost_usd : 0;
  const reclaimTeams = v.reclaim.from.join(', ');
  const queue = assessRequests(ctx, v);
  const others = queue.filter((s) => s.request_id !== r.request_id);
  const rank = queue.findIndex((s) => s.request_id === r.request_id) + 1;

  // ---- the alternatives: other pools of the same kind with room today, after their own queues
  const alternatives = all.filter((o) => o.verdict.pool_id !== r.pool_id && o.ctx.group === ctx.group).map((o) => {
    const takenByQueue = sum(assessRequests(o.ctx, o.verdict), (s) => s.from_free);
    return { pool_id: o.verdict.pool_id, region: o.verdict.region_label, sku_id: o.verdict.sku_id, free_cu: Math.max(0, round(o.ctx.freeNow - takenByQueue)) };
  }).filter((o) => o.free_cu >= Math.max(1, Math.round(ask * 0.25))).sort((p, q) => q.free_cu - p.free_cu);

  // ---- KPI strip
  const demand52 = used * g80(52) + (pending ? ask : 0);
  const demandThen = share * ctx.priorUpperAt(52) + (pending ? ask : 0);           // the same question, on the forecast as it stood a quarter ago
  const demandChange = used > 0 && demandThen > 0 ? demand52 / demandThen - 1 : null;      // no usage in the pool, nothing to compare
  const kpis = {
    current_usage: {
      cu: used, allocated_cu: allocated, share_of_allocated: allocated > 0 ? used / allocated : null, holds_capacity_here: allocated > 0, elsewhere,
      definition: `What ${r.team} uses today of the ${cu(allocated)} it has reserved in ${regionName}.`,
    },
    total_demand: {
      cu: round(demand52), delta_pct: demandChange,
      definition: `The team's usage in ${regionName}, grown at that pool's forecast (p80), plus the ask from ${fmt(r.needed_by)}. The ask is counted in full. Change is against the same forecast fitted ${data.policy.overview.compare_weeks} weeks ago.`,
    },
    additional_required: {
      cu: needs, by: r.needed_by, of_cu: ask, has_need: needs > 0,
      definition: 'The part of the ask with no capacity today: free capacity and idle reservations are used first, then supply already in flight, and what is left needs a new order.',
    },
    request_status: {
      key: status, label: STATUS_LABEL[status] || cap(status),
      note: status === 'at-risk' ? 'Needs action' : status === 'in-review' ? 'Waiting for a decision' : status === 'approved' ? 'Approved' : status === 'completed' ? `Delivered ${fmt(r.delivered_on)}` : status === 'live' ? `In use since ${fmt(r.live_on)}` : status === 'lapsed' ? 'Did not go ahead' : 'Declined',
      definition: 'At risk when the part of the ask that needs a new order would arrive after the need date.',
    },
    business_impact: {
      usd: r.revenue_at_risk_usd != null ? r.revenue_at_risk_usd : null,
      label: status === 'at-risk' ? 'Revenue at risk' : 'Revenue this request supports', stated_by: 'the requester',
      definition: 'As stated by the requester on the request. The lab does not estimate revenue.',
    },
    est_cost: {
      usd: round(newSpend), basis: needs > 0 ? `one-off purchase of ${cu(needs)} of ${orderSku.sku_id}` : 'no purchase: served from capacity that exists or is already ordered',
      definition: 'Purchase cost of the ordered part at the SKU unit cost. Free capacity, idle reservations and supply already ordered are not new spend. This is not an annual figure: the lab has no operating-cost data.',
    },
  };

  // ---- the forecast, by month: demand, usage and the capacity you can count on
  const months = horizon === 13 ? 3 : horizon === 26 ? 6 : 12;
  const hNeed = ctx.hOf(r.needed_by);
  const phaseAt = (kind) => { const p = phases.find((ph) => ph.kind === kind); return p ? ctx.hOf(p.date) : null; };
  const hInflight = phaseAt('inflight');
  const hOrder = phaseAt('order');
  const at = (h) => {
    const capacity = allocated + (pending ? now + (hInflight != null && h >= hInflight ? inflight : 0) + (hOrder != null && h >= hOrder ? needs : 0) : 0);
    return { week: h, date: addWeeks(asOf, h), demand: round(used * g80(h) + (pending && h >= hNeed ? ask : 0)), usage: round(used * g50(h)), capacity: round(capacity) };
  };
  // Every week, for the chart: the ask arrives on its need date and capacity lands on its landing date, so a coarser
  // grid would blur exactly the steps the chart is there to show. The monthly points are the same values, for the table.
  const weekly = Array.from({ length: horizon + 1 }, (_, h) => at(h));
  const points = Array.from({ length: months + 1 }, (_, i) => ({ month: i, ...weekly[Math.round((i * 52) / 12)] }));
  const forecast = {
    months, horizon_weeks: horizon, points, weekly,
    callout: pending && needs > 0 ? { date: r.needed_by, week: hNeed, cu: needs, text: `Need additional capacity by ${fmt(r.needed_by)} (${cu(needs)})`, lands_on: expected } : null,
    definition: 'Forecast demand is the team\'s usage grown at the pool\'s p80 forecast, with the ask added from its need date. Current usage grows at the middle forecast. The capacity line is what the team holds plus what the assessment can serve; it steps up as each phase is expected to land.',
  };

  const ctxIn = { r, v, status, ask, phases, now, free, reclaim, inflight, early, needs, expected, lateWeeks, atRisk, pending, regionName, reclaimTeams, others, rank, queue, newSpend, alternatives, asOf };
  const recommendation = recommend(ctxIn);
  const timeline = buildTimeline({ ...ctxIn, results: a.results });

  // ---- the details
  const details = {
    rows: [
      { key: 'environment', label: 'Environment', value: r.environment ? cap(r.environment) : 'Not stated' },
      { key: 'region', label: 'Region', value: regionName },
      { key: 'workload', label: 'Workload type', value: label(WORKLOAD, r.workload) },
      { key: 'requested', label: 'Requested capacity', value: cu(ask) },
      { key: 'additional', label: 'Additional required', value: pending ? cu(needs) : cu(0), emphasis: needs > 0 ? 'bad' : null },
      { key: 'need_by', label: 'Need by', value: fmt(r.needed_by) },
      { key: 'priority', label: 'Business priority', value: cap(r.priority), emphasis: r.priority === 'high' ? 'bad' : null },
      { key: 'source', label: 'Request source', value: label(SOURCE, r.source) },
      { key: 'submitted', label: 'Submitted', value: r.submitted_on ? fmt(r.submitted_on) : 'Not recorded' },
    ],
    use_case: r.use_case || null,
    team: r.team, request_id: r.request_id, title: r.title, pool_id: r.pool_id, pool_label: poolLabel,
  };

  // ---- what is driving the demand: shares of the team's growth over 12 months
  const seasonal = share * Math.max(0, ...Array.from({ length: 53 }, (_, h) => ctx.seasonalSpikeAt(h)));
  const parts = [
    { key: 'existing', label: 'Growth of existing workloads', cu: Math.max(0, used * (g80(52) - 1)) },
    { key: r.source, label: DRIVER[r.source] || label(SOURCE, r.source), cu: pending ? ask : 0 },
    { key: 'seasonal', label: 'Seasonal demand', cu: seasonal },
  ].filter((p) => p.cu > 0);
  const pcts = shares(parts.map((p) => p.cu));
  const drivers = parts.map((p, i) => ({ ...p, cu: round(p.cu), share_pct: pcts[i] })).sort((m, n) => n.share_pct - m.share_pct);

  // ---- what rides on it
  const business = {
    rows: [
      { key: 'revenue', label: status === 'at-risk' ? 'Revenue at risk' : 'Revenue supported', value: r.revenue_at_risk_usd != null ? usd(r.revenue_at_risk_usd) : 'Not stated', usd: r.revenue_at_risk_usd != null ? r.revenue_at_risk_usd : null },
      { key: 'commitment', label: 'Customer commitment', value: r.customer_commitment || 'Not stated' },
      { key: 'sla', label: 'SLA impact', value: r.sla_impact ? cap(r.sla_impact) : 'Not stated' },
      { key: 'strategic', label: 'Strategic importance', value: r.strategic_importance ? cap(r.strategic_importance) : 'Not stated' },
    ],
    stated_by: 'the requester',
  };

  // ---- where the team stands in the pool
  const utilization = {
    used_cu: used, allocated_cu: allocated, unused_cu: Math.max(0, allocated - used), used_share: allocated > 0 ? used / allocated : null, holds_capacity_here: allocated > 0,
    pool: { region: regionName, sku_id: v.sku_id, free_cu: round(ctx.freeNow) }, elsewhere,
  };

  const options = pending ? buildOptions(ctxIn) : [];

  // ---- what it costs
  const unit = ctx.sku.unit_cost_usd;
  const cost = {
    bars: pending ? [
      { key: 'holding', label: 'What you hold', cu: allocated, usd: round(allocated * unit), kind: 'existing' },
      { key: 'early', label: 'Phase 1: capacity that exists or is ordered', cu: early, usd: round(early * unit), kind: 'existing' },
      { key: 'order', label: 'Phase 2: new order', cu: needs, usd: round(newSpend), kind: 'new' },
    ] : [{ key: 'holding', label: 'What you hold', cu: allocated, usd: round(allocated * unit), kind: 'existing' }],
    new_spend_usd: round(newSpend), share_needing_order: ask > 0 ? needs / ask : 0, unit_cost_usd: unit, order_unit_cost_usd: orderSku.unit_cost_usd, order_sku: orderSku.sku_id,
    note: 'Existing capacity is valued at its purchase cost but is not new spend. Only the ordered part is. One-off purchase, not annual: the lab has no operating-cost data.',
  };

  // ---- risks and dependencies: this request first, then what the pool's funnels are flagging
  const risks = [];
  if (pending && atRisk) risks.push({ key: 'late', title: 'Capacity lands after it is needed', detail: `${cu(needs)} is expected ${fmt(expected)}, ${weeksLabel(lateWeeks)} after the ${fmt(r.needed_by)} need date.`, severity: 'High' });
  if (pending && others.length) {
    const total = sum(others, (s) => s.cu);
    risks.push({ key: 'competing', title: 'Competing requests', detail: `${others.length} other request${others.length === 1 ? '' : 's'} in ${regionName} ask for ${cu(total)} in all. They are served in need-by order and this one is ${ordinal(rank)} of ${queue.length}.`, severity: others.length >= 3 ? 'Medium' : 'Low' });
  }
  for (const f of a.results.filter((res) => res.flagged && !res.context_only)) {
    risks.push({ key: f.id, title: f.name, detail: f.headline, severity: SEV_LABEL[f.severity] || 'Low', funnel: f.number });
  }
  risks.sort((m, n) => SEV_RANK[m.severity] - SEV_RANK[n.severity]);

  return {
    selected: { request_id: r.request_id, title: r.title, team: r.team, status, pool_id: r.pool_id, region: regionName },
    kpis, recommendation, forecast, timeline, details, drivers, business_impact: business, utilization, options, cost,
    risks: { total: risks.length, items: risks.slice(0, 5) },
  };
}

// ------------------------------------------------------------------ the phases, in words
const ORDER_WORDS = { drafted: 'the drafted order', placed: 'the order already placed', new: 'a new order' };
function phaseText(p) {
  if (p.kind === 'now') {
    const from = p.free > 0 && p.reclaim > 0 ? ` (${cu(p.free)} free, ${cu(p.reclaim)} from idle reservations)` : p.reclaim > 0 ? ' from idle reservations' : ' from free capacity';
    return `${cu(p.cu)} now${from}`;
  }
  if (p.kind === 'inflight') return `${cu(p.cu)} when supply already ordered lands ${fmt(p.date)}`;
  return `${cu(p.cu)} when ${ORDER_WORDS[p.via] || 'a new order'} lands ${fmt(p.date)}`;
}

// ------------------------------------------------------------------ the recommendation, in words
function recommend(p) {
  const { r, v, status, ask, phases, now, free, reclaim, inflight, early, needs, expected, lateWeeks, atRisk, pending, regionName, reclaimTeams, others, rank, queue, newSpend, alternatives } = p;
  const basis = 'Rules over this pool\'s plan and its request queue. The engine claims no probability.';
  if (!pending) {
    const decided = r.decided_on ? ` on ${fmt(r.decided_on)}` : '';
    const headline = status === 'completed' ? `Delivered ${fmt(r.delivered_on)}: ${cu(ask)} in ${regionName}.`
      : status === 'approved' ? `Approved${decided}: ${cu(ask)} in ${regionName} is planned for ${fmt(r.needed_by)}.`
        : status === 'live' ? `Live since ${fmt(r.live_on)}: ${cu(r.realized_cu)} of the ${cu(ask)} asked for is in use in ${regionName}.`
          : status === 'lapsed' ? `Did not go ahead: the ${fmt(r.needed_by)} need date passed and the ${cu(ask)} was never used.`
            : `Declined${decided}.`;
    return { state: status, label: STATUS_LABEL[status], answer: headline, headline, why: [], impact: [], next_steps: [], basis };
  }
  const texts = phases.map((ph) => phaseText(ph));
  const via = (phases.find((ph) => ph.kind === 'order') || {}).via;
  const earlyShare = ask > 0 ? Math.round((early / ask) * 100) : 0;

  // The one-line answer to "will it arrive when it is needed?", for the top of the page.
  const need = fmt(r.needed_by);
  const answer = needs === 0 ? `Yes. All ${cu(ask)} can be in place by the ${need} need date, with no new order.`
    : !atRisk ? `Yes, in time. ${cu(needs)} depends on ${ORDER_WORDS[via]} landing ${fmt(expected)}, before the ${need} need date.`
      : early > 0 ? `Partly. ${cu(early)} of ${cu(ask)} is in place by the ${need} need date; the last ${cu(needs)} lands ${weeksLabel(lateWeeks)} late, on ${fmt(expected)}.`
        : `Not in time. Nothing can be served before ${fmt(expected)}, ${weeksLabel(lateWeeks)} after the ${need} need date.`;

  let headline;
  if (needs === 0) {
    headline = phases.length === 1 ? `Serve ${texts[0]}. No purchase is needed.`
      : `Serve ${joinAnd(texts)}. It all arrives in time for the ${fmt(r.needed_by)} need date and nothing new needs ordering.`;
  } else if (!atRisk) {
    headline = `Serve ${joinAnd(texts)}. All of it arrives before the ${fmt(r.needed_by)} need date.`;
  } else if (early > 0) {
    headline = `Phase it: ${joinAnd(texts)}. The last ${cu(needs)} lands ${weeksLabel(lateWeeks)} after the ${fmt(r.needed_by)} need date.`;
  } else {
    headline = `Nothing can be served before ${fmt(expected)}, ${weeksLabel(lateWeeks)} after the ${fmt(r.needed_by)} need date. Move the date, or place it elsewhere.`;
  }

  const why = [];
  if (free > 0) why.push(`${cu(free)} is free and unreserved in ${regionName} today.`);
  if (reclaim > 0) why.push(`${cu(reclaim)} sits in idle reservations (${reclaimTeams}) and could be reallocated.`);
  const inflightPhase = phases.find((ph) => ph.kind === 'inflight');
  if (inflightPhase) why.push(`${cu(inflight)} of supply already ordered for this pool lands ${fmt(inflightPhase.date)}, before the need date.`);
  if (via === 'drafted') why.push(`The pool plan orders ${cu(v.order.quantity_cu)} of ${v.what.order_sku}, landing ${fmt(v.dates.lands_on)}.`);
  else if (via === 'placed') why.push(`An order already placed for this pool lands ${fmt(expected)}, after the need date.`);
  else if (via === 'new') why.push(`No order is drafted for this pool yet, so a new one would be placed today and land about ${fmt(expected)}.`);
  if (v.driver && needs > 0) why.push(`The pool is ${v.state}: ${v.driver.headline}`);
  if (others.length) why.push(`${others.length} other request${others.length === 1 ? '' : 's'} in this pool are served first or alongside; this one is ${ordinal(rank)} of ${queue.length} in need-by order.`);
  if (!why.length) why.push('Nothing else competes for this capacity.');

  const impact = [];
  if (needs === 0) impact.push(`Meets the full ${cu(ask)} by ${fmt(r.needed_by)}.`);
  else impact.push(`Meets ${cu(early)} of ${cu(ask)} (${earlyShare}%) by the ${fmt(r.needed_by)} need date.`);
  if (atRisk) impact.push(early > 0
    ? `The last ${cu(needs)} is ${weeksLabel(lateWeeks)} late if nothing changes; phasing puts ${earlyShare}% of the ask to work in time instead of waiting for all of it.`
    : `All ${cu(needs)} is ${weeksLabel(lateWeeks)} late if nothing changes.`);
  impact.push(newSpend > 0 ? `No new spend for the earlier phases; about ${usd(newSpend)} for the ordered ${cu(needs)} (its share of ${via === 'drafted' ? 'the drafted' : 'a new'} order).` : 'No new spend: it uses capacity that already exists or is already ordered.');

  const steps = [];
  const earlyTexts = phases.filter((ph) => ph.kind !== 'order').map((ph) => phaseText(ph));
  if (needs === 0) {
    steps.push('Approve the request as it stands.');
    if (reclaim > 0) steps.push(`Agree the reallocation of ${cu(reclaim)} with ${reclaimTeams}.`);
  } else {
    if (earlyTexts.length) steps.push(`Approve the earlier phases: ${joinAnd(earlyTexts)}.`);
    steps.push(`Ask Central Capacity to hold ${cu(needs)} of ${via === 'new' ? 'the order still to be placed' : ORDER_WORDS[via]} for this team, landing ${fmt(expected)}.`);
    if (atRisk) steps.push(`Or move the need date to ${fmt(expected)} or later.`);
    if (alternatives.length) {
      const alt = alternatives[0];
      steps.push(`Or place ${cu(Math.min(ask, alt.free_cu))} in ${alt.region}, where ${cu(alt.free_cu)} is free today, if the workload can run there.`);
    }
  }
  return { state: status, label: STATUS_LABEL[status], answer, headline, why, impact, next_steps: steps, basis };
}

// ------------------------------------------------------------------ the timeline
function buildTimeline(p) {
  const { r, v, status, ask, phases, needs, expected, lateWeeks, atRisk, pending, asOf, results } = p;
  const ev = [];
  // Why it is late, in the pool's own words: a slow vendor is usually the reason, and the supply-chain funnel says so.
  const supply = results.find((res) => res.id === 'supply-chain' && res.flagged);
  const why = supply ? supply.headline : v.driver ? v.driver.headline : null;
  const submitted = r.submitted_on || asOf;
  ev.push({ key: 'submitted', title: 'Request submitted', detail: fmt(submitted), state: 'done' });
  if (!pending) {
    if (r.decided_on) ev.push({ key: 'decided', title: status === 'declined' ? 'Declined' : `Approved (${cu(ask)})`, detail: `Central Capacity, ${fmt(r.decided_on)}`, state: status === 'declined' ? 'risk' : 'done' });
    if (status === 'approved') ev.push({ key: 'expected', title: 'Expected availability', detail: `${cu(ask)} by ${fmt(r.needed_by)}`, state: 'future' });
    if (status === 'completed') ev.push({ key: 'delivered', title: 'Delivered', detail: `${cu(ask)} on ${fmt(r.delivered_on)}`, state: 'done' });
    if (status === 'live') ev.push({ key: 'live', title: 'Went live', detail: `${cu(r.realized_cu)} of the ${cu(ask)} asked for, from ${fmt(r.live_on)}`, state: 'done' });
    if (status === 'lapsed') ev.push({ key: 'lapsed', title: 'Did not go ahead', detail: `Needed by ${fmt(r.needed_by)}; it was never used`, state: 'risk' });
    return ev;
  }
  ev.push({ key: 'review', title: 'Under review', detail: 'Central Capacity is assessing it against free capacity, idle reservations and the plan', state: 'current' });
  for (const ph of phases) {
    if (ph.kind === 'now') ev.push({ key: 'now', title: `Can be served now (${cu(ph.cu)})`, detail: [ph.free > 0 ? `${cu(ph.free)} free` : null, ph.reclaim > 0 ? `${cu(ph.reclaim)} from idle reservations` : null].filter(Boolean).join(', '), state: 'done' });
    else if (ph.kind === 'inflight') ev.push({ key: 'inflight', title: `Supply already on its way (${cu(ph.cu)})`, detail: `Lands ${fmt(ph.date)}, before it is needed`, state: 'future' });
    else ev.push({
      key: 'remaining', title: `${atRisk ? 'Remaining' : 'Still to arrive'} ${cu(needs)}`,
      detail: atRisk ? `At risk: lands ${weeksLabel(lateWeeks)} after it is needed${why ? `. ${why}` : ''}` : `Expected ${fmt(expected)}, in time`,
      state: atRisk ? 'risk' : 'future',
    });
  }
  ev.push({ key: 'expected', title: 'Expected availability', detail: phases.map((ph, i) => `Phase ${i + 1}: ${fmt(ph.date)} (${cu(ph.cu)})`).join(' · ') || `${cu(ask)} by ${fmt(r.needed_by)}`, state: 'future' });
  return ev;
}

// ------------------------------------------------------------------ the alternatives
function buildOptions(p) {
  const { v, ask, phases, early, needs, expected, lateWeeks, atRisk, newSpend, alternatives, asOf } = p;
  const weeksTo = (date) => Math.max(0, Math.ceil(daysBetween(asOf, date) / 7));
  const leadOf = (list) => [...new Set(list.map((ph) => (ph.kind === 'now' ? 'Now' : weeksLabel(weeksTo(ph.date)))))].join(', then ');
  const rows = [];
  const primary = needs === 0 ? 'proceed' : early > 0 ? 'phase' : 'wait';
  const note = phases.map((ph) => phaseText(ph)).join('; ');
  if (needs === 0) {
    rows.push({ key: primary, option: 'Proceed as requested', capacity_cu: ask, lead: leadOf(phases), est_cost_usd: 0, impact: 'Meets demand', note });
  } else {
    rows.push({
      key: primary, capacity_cu: ask, lead: leadOf(phases), est_cost_usd: round(newSpend), note,
      option: early > 0 ? (atRisk ? 'Phase it: earlier phases, then the order' : 'Serve it in phases as capacity lands') : 'Wait for the order',
      impact: atRisk ? (early > 0 ? 'Reduces risk' : 'Late') : 'Meets demand',
    });
    if (early > 0 && atRisk) rows.push({ key: 'early-only', option: 'Take only what arrives in time', capacity_cu: early, lead: leadOf(phases.filter((ph) => ph.kind !== 'order')), est_cost_usd: 0, impact: 'Partial', note: `${cu(needs)} of the ask is not served.` });
    if (atRisk) rows.push({ key: 'move-date', option: `Move the need date to ${fmt(expected)}`, capacity_cu: ask, lead: `Until ${fmt(expected)}`, est_cost_usd: round(newSpend), impact: 'Meets demand, later', note: `${weeksLabel(lateWeeks)} later than asked.` });
  }
  for (const alt of alternatives.slice(0, 2)) {
    rows.push({
      key: `region-${alt.pool_id}`, option: `Place it in ${alt.region}`, capacity_cu: Math.min(ask, alt.free_cu), lead: 'Now', est_cost_usd: 0,
      impact: alt.free_cu >= ask ? 'Meets demand' : 'Partial', note: `${cu(alt.free_cu)} is free today. The workload must be able to run there.`,
    });
  }
  // The rule: if it is on time as it stands, do that. If it is late, phase it when part arrives in time; otherwise a
  // region that covers all of it; otherwise move the date.
  const pick = !atRisk ? primary
    : early > 0 ? primary
      : (rows.find((o) => o.key.startsWith('region-') && o.capacity_cu >= ask) || {}).key || 'move-date';
  return rows.map((o) => ({ ...o, recommended: o.key === pick })).sort((x, y) => Number(y.recommended) - Number(x.recommended));
}

module.exports = { buildRequester, orgKeyOf, orgLabelOf, HORIZONS, GEO_LABEL, label, WORKLOAD, phasesOf, classify };
