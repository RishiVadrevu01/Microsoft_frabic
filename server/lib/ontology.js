'use strict';
/*
 * The seven-layer ontology from the Engineering Requirements (section 5.1), with the live value of
 * each layer for each pool. Nothing here is new data: every value is read from a record or from the
 * plan the engine already produced, so this page cannot disagree with the pool pages or the Overview.
 *
 * Four layers are recorded as-is (infrastructure, allocation, utilization, SKU lifecycle). Three are
 * derived: gap/waste from allocation minus utilization, health from incidents, and the planning
 * horizon from the 14 funnels composed. Each layer says which file it comes from and which funnels read it.
 */

const { REGISTRY, catalogue, reservations, incidentHealth } = require('./funnels');
const { GEO } = require('./overview');
const { num, pct } = require('./format');

const val = (key, label, value, unit, note) => ({ key, label, value: value === undefined ? null : value, unit, ...(note ? { note } : {}) });
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

const LAYERS = [
  {
    id: 'infrastructure', name: 'Infrastructure', kind: 'recorded', headline: 'installed_cu',
    question: 'What capacity exists, where, and on what hardware?',
    files: [['infrastructure.json', 'datacenter_id, region, sku_id, capacity_units, rack_count, segments']],
    funnels: ['reliability'],
    note: 'The base every date and quantity is measured against. The Reliability funnel proposes replacing whole fabric segments.',
    build: ({ ctx, verdict: v }) => [
      val('datacenter', 'Data centre', ctx.pool.datacenter_id, 'text'),
      val('region', 'Region', ctx.pool.region_label, 'text', GEO[ctx.pool.geo]),
      val('sku', 'SKU', ctx.pool.sku_id, 'text'),
      val('installed_cu', 'Installed capacity', ctx.pool.capacity_units, 'cu'),
      val('racks', 'Racks', ctx.pool.rack_count, 'count'),
      val('segments', 'Fabric segments', ctx.pool.segments.length, 'count', ctx.pool.segments.map((s) => `${s.segment_id} ${num(s.units)} CU`).join(', ')),
      val('in_flight_cu', 'Orders in flight', sum(v.order.in_flight, (o) => o.cu), 'cu', v.order.in_flight.map((o) => `${o.order_id} lands ${o.lands_on}`).join(', ')),
    ],
  },
  {
    id: 'allocation', name: 'Allocation', kind: 'recorded', headline: 'allocated_cu',
    question: 'Who has reserved it?',
    files: [['allocations.json', 'reserved_by, allocated_units, allocation_date']],
    funnels: ['cost-efficiency'],
    build: ({ ctx, verdict: v }) => {
      const rs = ctx.allocations;
      const largest = rs.reduce((b, r) => (!b || r.allocated_units > b.allocated_units ? r : b), null);
      const oldest = rs.reduce((b, r) => (b == null || r.allocation_date < b ? r.allocation_date : b), null);
      return [
        val('allocated_cu', 'Reserved by teams', v.capacity.allocated, 'cu'),
        val('allocated_share', 'Share of installed capacity', v.capacity.allocated / v.capacity.installed, 'pct'),
        val('free_cu', 'Not yet reserved', v.capacity.free_now, 'cu'),
        val('reservations', 'Reservations', rs.length, 'count'),
        val('largest_cu', 'Largest reservation', largest ? largest.allocated_units : null, 'cu', largest ? largest.reserved_by : undefined),
        val('oldest', 'Oldest reservation made', oldest, 'date'),
      ];
    },
  },
  {
    id: 'utilization', name: 'Utilization', kind: 'recorded', headline: 'utilization',
    question: 'How much of it is really used?',
    files: [['utilization.json', 'week_start, utilized_units'], ['infrastructure.json', 'workload_type']],
    funnels: ['demand'],
    build: ({ ctx, verdict: v }) => ({
      values: [
        val('workload', 'Workload type', ctx.pool.workload_type, 'text'),
        val('utilized_cu', 'In use now', v.capacity.utilized, 'cu'),
        val('utilization', 'Share of usable capacity', v.capacity.utilization_of_usable, 'pct'),
        val('ceiling_pct', 'Working ceiling the plan uses', v.capacity.working_floor_pct, 'pct'),
        val('peak_cu', 'Peak in the history', Math.max(...ctx.values), 'cu'),
        val('history_weeks', 'Weeks of history', ctx.values.length, 'count'),
      ],
      spark: { values: ctx.values, capacity_cu: v.capacity.installed, ceiling_cu: Math.round(v.capacity.working_floor_pct * v.capacity.usable_now) },
    }),
  },
  {
    id: 'gap-waste', name: 'Gap / Waste', kind: 'derived', headline: 'reclaim_cu',
    question: 'How much is reserved but idle, and could be given back instead of bought?',
    derived_from: 'Allocation minus utilization: a reservation is idle when it uses little of what it holds for weeks on end.',
    files: [], funnels: ['cost-efficiency'],
    note: 'A pool counts as a reclaim opportunity only when the idle capacity is a meaningful share of what it can use. Below that it is shown here and left out of the plan.',
    build: ({ ctx, verdict: v }) => {
      const rs = reservations(ctx);
      const idle = rs.filter((r) => r.idle);
      const cp = ctx.policy.cost;
      return [
        val('unused_cu', 'Reserved but not in use', v.capacity.allocated - v.capacity.utilized, 'cu'),
        val('idle_reservations', 'Idle reservations', idle.length, 'count', idle.map((r) => r.reserved_by).join(', ')),
        val('reclaimable_cu', 'Idle capacity that could be freed', sum(rs, (r) => r.reclaimable), 'cu'),
        val('reclaim_cu', 'Counted as a reclaim opportunity', v.reclaim.cu, 'cu', `counted from ${num(cp.flag_share_of_usable * ctx.usable0)} CU (${pct(cp.flag_share_of_usable)} of usable)`),
        val('reclaim_usd', 'Value at purchase cost', v.reclaim.value_usd, 'usd'),
      ];
    },
  },
  {
    id: 'sku-lifecycle', name: 'SKU lifecycle and substitution', kind: 'recorded', headline: 'status',
    question: 'Is the hardware still orderable, and what replaces it?',
    files: [['sku_catalogue.json', 'status, eol_date, replaced_by_sku, capacity_equivalence_factor, security_support_ends']],
    funnels: ['sustainability', 'security-compliance'],
    note: 'It also decides which SKU an order is placed for and at what equivalence factor. That is plan composition, not a funnel.',
    build: ({ ctx, verdict: v }) => [
      val('status', 'Lifecycle status', ctx.sku.status, 'lifecycle'),
      val('eol_date', 'End of life', ctx.sku.eol_date, 'date'),
      val('security_ends', 'Vendor security support ends', ctx.sku.security_support_ends, 'date'),
      val('replaced_by', 'Successor SKU', ctx.sku.replaced_by_sku, 'text'),
      val('order_sku', 'A new order is placed as', v.what.order_sku, 'text'),
      val('factor', 'Equivalence factor', v.what.factor, 'factor', v.what.order_sku !== ctx.pool.sku_id ? `1 CU of ${v.what.order_sku} counts as ${v.what.factor} CU of ${ctx.pool.sku_id}` : undefined),
    ],
  },
  {
    id: 'reliability', name: 'Reliability / health score', kind: 'derived', headline: 'score',
    question: 'Is the hardware behaving, whatever the utilization says?',
    derived_from: 'Recent incidents, weighted by severity and scored per fabric segment.',
    files: [['incidents.json', 'severity, fabric_segment, opened_on, mttr_hours']], funnels: ['reliability'],
    build: ({ ctx, results }) => {
      const h = incidentHealth(ctx);
      const f = results.find((r) => r.id === 'reliability');
      return [
        val('score', `Severity-weighted score (last ${h.rp.window_days} days)`, h.score, 'score', `flagged from ${h.rp.flag_score}, critical from ${h.rp.critical_score}`),
        val('health', 'Health', f.flagged ? `flagged ${f.severity}` : 'within normal range', 'text'),
        val('incidents', 'Incidents in that window', h.recent.length, 'count', `${h.sev12} of severity 1 or 2`),
        val('mttr_hours', 'Average time to mitigate', h.mttr, 'hours'),
        val('worst_segment', 'Worst fabric segment', h.worst ? h.worst[0] : null, 'text', h.worst ? `score ${h.worst[1].toFixed(1)}` : undefined),
      ];
    },
  },
  {
    id: 'planning-horizon', name: 'Planning horizon', kind: 'derived', headline: 'state', all: true,
    question: 'When must we order, how much, and by when?',
    derived_from: 'The 14 funnels composed into one plan per pool: the earliest date wins, the lead time is what the vendor really delivers, and the sizes add up.',
    files: [],
    build: ({ verdict: v }) => [
      val('state', 'Plan state', v.state, 'state'),
      val('needed_by', 'Capacity needed by', v.dates.needed_by, 'date', v.dates.needed_by && v.driver ? `set by ${v.driver.name}` : undefined),
      val('raise_by', 'Order must be placed by', v.dates.raise_by, 'date', v.dates.overdue_days > 0 ? `${v.dates.overdue_days} days overdue` : undefined),
      val('lead_weeks', 'Lead time', v.lead.weeks, 'weeks'),
      val('order_cu', 'Recommended order', v.order.needed ? v.order.quantity_cu : 0, 'cu', v.order.needed ? v.what.order_sku : undefined),
      val('order_cost_usd', 'Order cost', v.order.needed ? v.order.cost_usd : 0, 'usd'),
      val('covered_until', 'The order then covers demand until', v.dates.covered_until, 'date'),
    ],
  },
];

/** The seven layers and their live values for every pool. */
function buildOntology(store) {
  const cat = catalogue();
  const funnelRef = (id) => { const c = cat.find((x) => x.id === id); return { number: c.number, id: c.id, name: c.name }; };
  const layers = LAYERS.map((L, i) => ({
    n: i + 1, id: L.id, name: L.name, kind: L.kind, question: L.question, headline: L.headline,
    derived_from: L.derived_from || null,
    files: L.files.map(([file, fields]) => ({ file, fields })),
    funnels: (L.all ? REGISTRY.map((f) => f.id) : L.funnels).map(funnelRef),
    all_funnels: Boolean(L.all),
    note: L.note || null,
  }));
  const pools = store.all().map((a) => {
    const v = a.verdict;
    const byLayer = {};
    for (const L of LAYERS) {
      const built = L.build(a);
      const values = Array.isArray(built) ? built : built.values;
      byLayer[L.id] = { headline: values.find((x) => x.key === L.headline), values, ...(built.spark ? { spark: built.spark } : {}) };
    }
    return { pool_id: v.pool_id, label: `${v.region_label} · ${v.sku_id}`, region: v.region_label, sku_id: v.sku_id, state: v.state, layers: byLayer };
  });
  return { view: 'ontology', source: 'synthetic', as_of: store.data().as_of, layers, pools };
}

module.exports = { buildOntology, LAYERS };
