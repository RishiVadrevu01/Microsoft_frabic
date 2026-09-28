'use strict';
/*
 * Synthetic estate generator.
 *
 * Deterministic (seeded PRNG): running `npm run seed` twice produces the same
 * bytes. Every file carries source: "synthetic" and the loader refuses anything
 * else, so nothing here can be mistaken for real Microsoft data.
 *
 * Six pools, each scripted so a different signal is the reason to act. The
 * numbers describe the SHAPE of a real estate (capacity units, weekly
 * utilisation, lead times, incidents). They are not measurements.
 */

const fs = require('node:fs');
const path = require('node:path');
const { mulberry32, normal } = require('../server/lib/rng');
const { addWeeks, addDays } = require('../server/lib/dates');

const AS_OF = '2026-09-21';            // a Monday; the engine's "today"
const WEEKS = 52;                       // weeks of utilisation history
const DATASET_VERSION = '2026.09.0';
const HISTORY_START = addWeeks(AS_OF, -(WEEKS - 1));

const envelope = (records, extra = {}) => ({
  source: 'synthetic',
  dataset_version: DATASET_VERSION,
  ...extra,
  records,
});

// ------------------------------------------------------------------ policy
const policy = {
  source: 'synthetic',
  dataset_version: DATASET_VERSION,
  policy_version: '2026.09.0',
  approved_by: 'awaits review (synthetic lab policy, not a Microsoft policy)',
  floor_pct: { general: 0.85, gpu: 0.8 },
  cover_weeks: 26,
  buffer_pct: 0.1,
  due_soon_weeks: 4,
  plan_weeks: 26,
  horizons_weeks: [13, 26, 52],
  forecast: { window_weeks: 26, backtest_horizon_weeks: 8, holt_margin: 0.1, p_upper_z: 0.8416 },
  pipeline: { overlap_discount: 0.25 },
  lead_time: {
    default_weeks: 16,
    observed_min_samples: 3,
    vendor_risk_flag: 0.5,
    vendor_risk_buffer_weeks: 4,
  },
  reliability: {
    window_days: 90,
    weights: { 1: 8, 2: 4, 3: 1.5, 4: 0.5 },
    flag_score: 12,
    critical_score: 24,
    replace_within_weeks: { critical: 22, high: 30 },
  },
  performance: { latency_ratio_flag: 1.3, latency_ratio_high: 1.6, queue_ratio_flag: 0.8, knee_margin: 0.03 },
  cost: { low_use_ratio: 0.5, low_use_weeks: 8, keep_margin: 0.25, flag_share_of_usable: 0.05 },
  dependency: { tier1_min: 3 },
  sustainability: { target_gco2_per_cu_hour: 150 },
  security: { horizon_weeks: 52, migration_weeks: 12 },
  seasonal: { horizon_weeks: 52 },
  feeds: { stale_multiplier: 2 },
  // Overview: a region is Healthy below region_watch, At Risk above region_at_risk, Watch between.
  // compare_weeks is the look-back for the 'vs last quarter' comparisons.
  overview: { region_watch: 0.8, region_at_risk: 0.95, compare_weeks: 13 },
  demand_severity_weeks: { critical: 13, high: 26, medium: 52 },
  decisions: { blocked_deciders: ['engine', 'system', 'planner-engine', 'capacity-planner-engine'] },
  // Governance on an approval. The lab has no sign-in and no budget system, so both numbers are synthetic and only illustrate the
  // control: `budget_usd` is what the approvals may commit in the period (going over needs a reason), and an order costing more than
  // `second_approver_above_usd` needs a second, different named person. Names are typed, not verified.
  approval: { budget_usd: 8000000, budget_label: 'FY27 Q2 capacity budget (synthetic)', second_approver_above_usd: 1500000 },
};

// ------------------------------------------------------------------ SKUs
const skus = [
  { sku_id: 'FAB-INTEL-SKX-48', label: 'Intel Skylake-class 48-core', sku_class: 'general-compute-intel', status: 'eol',
    eol_date: '2025-06-30', last_time_buy: '2024-12-31', replaced_by_sku: 'FAB-INTEL-ICX-64', capacity_equivalence_factor: 1.22,
    order_unit_cu: 192, vendor_min_cu: 384, unit_cost_usd: 210, gco2_per_cu_hour: 250, security_support_ends: '2025-12-31', vendor_id: 'vendor-tailspin' },
  { sku_id: 'FAB-INTEL-ICX-64', label: 'Intel Ice Lake-class 64-core', sku_class: 'general-compute-intel', status: 'eol',
    eol_date: '2027-03-31', last_time_buy: '2026-12-31', replaced_by_sku: 'FAB-AMD-GENOA-96', capacity_equivalence_factor: 1.35,
    order_unit_cu: 192, vendor_min_cu: 384, unit_cost_usd: 265, gco2_per_cu_hour: 210, security_support_ends: '2027-06-30', vendor_id: 'vendor-tailspin' },
  { sku_id: 'FAB-AMD-GENOA-96', label: 'AMD Genoa-class 96-core', sku_class: 'general-compute-amd', status: 'active',
    replaced_by_sku: 'FAB-AMD-GEN6-128', capacity_equivalence_factor: 1.25,
    order_unit_cu: 192, vendor_min_cu: 384, unit_cost_usd: 310, gco2_per_cu_hour: 120, security_support_ends: '2030-12-31', vendor_id: 'vendor-northwind' },
  { sku_id: 'FAB-AMD-GEN6-128', label: 'AMD next-gen 128-core', sku_class: 'general-compute-amd', status: 'planned',
    available_from: '2027-03-15', order_unit_cu: 192, vendor_min_cu: 384, unit_cost_usd: 345, gco2_per_cu_hour: 95,
    security_support_ends: '2033-12-31', vendor_id: 'vendor-northwind' },
  { sku_id: 'FAB-GPU-V100-8', label: 'GPU node, 8x V100-class', sku_class: 'gpu-training', status: 'eol',
    eol_date: '2024-12-31', last_time_buy: '2024-03-31', replaced_by_sku: 'FAB-GPU-A100-8', capacity_equivalence_factor: 2.1,
    order_unit_cu: 96, vendor_min_cu: 192, unit_cost_usd: 2100, gco2_per_cu_hour: 420, security_support_ends: '2025-12-31', vendor_id: 'vendor-fabrikam' },
  { sku_id: 'FAB-GPU-A100-8', label: 'GPU node, 8x A100-class', sku_class: 'gpu-training', status: 'eol',
    eol_date: '2026-03-31', last_time_buy: '2025-09-30', replaced_by_sku: 'FAB-GPU-H100-8', capacity_equivalence_factor: 1.8,
    order_unit_cu: 96, vendor_min_cu: 192, unit_cost_usd: 3100, gco2_per_cu_hour: 410, security_support_ends: '2028-06-30', vendor_id: 'vendor-fabrikam' },
  { sku_id: 'FAB-GPU-H100-8', label: 'GPU node, 8x H100-class', sku_class: 'gpu-training', status: 'active',
    order_unit_cu: 96, vendor_min_cu: 192, unit_cost_usd: 4200, gco2_per_cu_hour: 400, security_support_ends: '2031-12-31', vendor_id: 'vendor-fabrikam' },
  { sku_id: 'FAB-GPU-L40S-8', label: 'GPU node, 8x L40S-class (inference)', sku_class: 'gpu-inference', status: 'active',
    order_unit_cu: 96, vendor_min_cu: 192, unit_cost_usd: 1350, gco2_per_cu_hour: 180, security_support_ends: '2031-12-31', vendor_id: 'vendor-fabrikam' },
];

// ------------------------------------------------------------------ vendors
const vendors = [
  { vendor_id: 'vendor-tailspin', name: 'Tailspin Server Co.', sku_ids: ['FAB-INTEL-SKX-48', 'FAB-INTEL-ICX-64'],
    quoted_lead_weeks: 16, observed_lead_weeks: [17, 19, 18, 21], risk_score: 0.35 },
  { vendor_id: 'vendor-northwind', name: 'Northwind Systems', sku_ids: ['FAB-AMD-GENOA-96', 'FAB-AMD-GEN6-128'],
    quoted_lead_weeks: 14, observed_lead_weeks: [15, 18, 17, 21, 19, 20], risk_score: 0.35 },
  { vendor_id: 'vendor-fabrikam', name: 'Fabrikam Accelerated Systems', sku_ids: ['FAB-GPU-V100-8', 'FAB-GPU-A100-8', 'FAB-GPU-H100-8', 'FAB-GPU-L40S-8'],
    quoted_lead_weeks: 16, observed_lead_weeks: [17, 18, 17, 20], risk_score: 0.45 },
];

// ------------------------------------------------------------------ pools
// lat and lon place each pool's data centre for the Overview map: the city of its Azure region, illustrative.
const pools = [
  { pool_id: 'pool-eastus-01-intel-icx', datacenter_id: 'dc-eus-2', region: 'eastus', region_label: 'East US', geo: 'north-america', lat: 36.7, lon: -78.4,
    sku_id: 'FAB-INTEL-ICX-64', sku_class: 'general-compute-intel', workload_type: 'general-compute',
    capacity_units: 9600, rack_count: 50,
    segments: [{ segment_id: 'eus-fabric-1', units: 4800 }, { segment_id: 'eus-fabric-2', units: 4800 }] },
  { pool_id: 'pool-westeurope-01-amd-genoa', datacenter_id: 'dc-weu-1', region: 'westeurope', region_label: 'West Europe', geo: 'europe', lat: 52.4, lon: 4.9,
    sku_id: 'FAB-AMD-GENOA-96', sku_class: 'general-compute-amd', workload_type: 'general-compute',
    capacity_units: 12288, rack_count: 64,
    segments: [{ segment_id: 'weu-fabric-1', units: 6144 }, { segment_id: 'weu-fabric-2', units: 6144 }] },
  { pool_id: 'pool-westeurope-02-gpu-h100', datacenter_id: 'dc-weu-2', region: 'westeurope', region_label: 'West Europe', geo: 'europe', lat: 52.4, lon: 4.9,
    sku_id: 'FAB-GPU-H100-8', sku_class: 'gpu-training', workload_type: 'ai-training',
    capacity_units: 4608, rack_count: 48,
    segments: [{ segment_id: 'weu-gpu-1', units: 2304 }, { segment_id: 'weu-gpu-2', units: 2304 }] },
  { pool_id: 'pool-southeastasia-01-amd-genoa', datacenter_id: 'dc-sea-1', region: 'southeastasia', region_label: 'Southeast Asia', geo: 'asia-pacific', lat: 1.3, lon: 103.8,
    sku_id: 'FAB-AMD-GENOA-96', sku_class: 'general-compute-amd', workload_type: 'general-compute',
    capacity_units: 7680, rack_count: 40,
    segments: [{ segment_id: 'sea-fabric-1', units: 3072 }, { segment_id: 'sea-fabric-2', units: 1536 }, { segment_id: 'sea-fabric-3', units: 3072 }] },
  { pool_id: 'pool-japaneast-01-gpu-l40s', datacenter_id: 'dc-jpe-1', region: 'japaneast', region_label: 'Japan East', geo: 'asia-pacific', lat: 35.7, lon: 139.7,
    sku_id: 'FAB-GPU-L40S-8', sku_class: 'gpu-inference', workload_type: 'ai-inference',
    capacity_units: 3840, rack_count: 40,
    segments: [{ segment_id: 'jpe-gpu-1', units: 1920 }, { segment_id: 'jpe-gpu-2', units: 1920 }] },
  { pool_id: 'pool-brazilsouth-01-amd-genoa', datacenter_id: 'dc-brs-1', region: 'brazilsouth', region_label: 'Brazil South', geo: 'latin-america', lat: -23.5, lon: -46.6,
    sku_id: 'FAB-AMD-GENOA-96', sku_class: 'general-compute-amd', workload_type: 'general-compute',
    capacity_units: 3072, rack_count: 16,
    segments: [{ segment_id: 'brs-fabric-1', units: 1536 }, { segment_id: 'brs-fabric-2', units: 1536 }] },
];

// ------------------------------------------------------------------ utilisation
// Piecewise-linear growth + a gentle yearly wave + noise, pinned so the latest
// week lands on a round, explainable number.
const utilSpec = {
  'pool-eastus-01-intel-icx':        { seed: 101, base: 4100, slopes: [[25, 40], [51, 88]], season: 60, noise: 45, latest: 7388 },
  'pool-westeurope-01-amd-genoa':    { seed: 102, base: 5300, slopes: [[51, 12]], season: 120, noise: 55, latest: 5912 },
  'pool-westeurope-02-gpu-h100':     { seed: 103, base: 2350, slopes: [[51, 8.4]], season: 50, noise: 35, latest: 2778 },
  'pool-southeastasia-01-amd-genoa': { seed: 104, base: 3400, slopes: [[51, 17]], season: 80, noise: 50, latest: 4267 },
  'pool-japaneast-01-gpu-l40s':      { seed: 105, base: 1350, slopes: [[51, 15]], season: 60, noise: 40, latest: 2115 },
  'pool-brazilsouth-01-amd-genoa':   { seed: 106, base: 1550, slopes: [[51, 7]], season: 40, noise: 30, latest: 1915 },
};

function utilisationSeries(poolId) {
  const spec = utilSpec[poolId];
  const rand = mulberry32(spec.seed);
  const vals = [];
  let level = spec.base;
  for (let t = 0; t < WEEKS; t++) {
    const seg = spec.slopes.find(([until]) => t <= until) || spec.slopes[spec.slopes.length - 1];
    if (t > 0) level += seg[1];
    const wave = spec.season * Math.sin((2 * Math.PI * t) / 52 + 1.1);
    vals.push(level + wave + normal(rand) * spec.noise);
  }
  const shift = spec.latest - vals[WEEKS - 1];
  return vals.map((v, t) => ({
    week_start: addWeeks(HISTORY_START, t),
    utilized_units: Math.round(v + shift),
  }));
}

const utilization = pools.map((p) => ({ pool_id: p.pool_id, series: utilisationSeries(p.pool_id) }));
const latestOf = (poolId) => utilization.find((u) => u.pool_id === poolId).series.at(-1).utilized_units;

// ------------------------------------------------------------------ allocations
// share of the latest utilisation, and how much each team has reserved relative
// to what it actually uses. low_use_weeks > 0 marks a reclaim candidate.
const allocSpec = {
  'pool-eastus-01-intel-icx': [
    ['contoso-lakehouse', 0.23, 1.1, 0], ['contoso-warehouse', 0.32, 1.1, 0], ['contoso-realtime', 0.17, 1.12, 0],
    ['contoso-data-eng', 0.085, 2.9, 14], ['contoso-data-science', 0.105, 1.08, 0], ['contoso-platform', 0.09, 1.2, 0],
  ],
  'pool-westeurope-01-amd-genoa': [
    ['contoso-search', 0.06, 3.4, 20], ['contoso-bi-archive', 0.05, 2.7, 16], ['contoso-warehouse', 0.34, 1.2, 0],
    ['contoso-lakehouse', 0.25, 1.15, 0], ['contoso-realtime', 0.18, 1.2, 0], ['contoso-platform', 0.12, 1.25, 0],
  ],
  'pool-westeurope-02-gpu-h100': [
    ['contoso-foundation-models', 0.5, 1.1, 0], ['contoso-fine-tuning', 0.3, 1.15, 0], ['contoso-research', 0.2, 1.9, 9],
  ],
  'pool-southeastasia-01-amd-genoa': [
    ['contoso-warehouse', 0.36, 1.18, 0], ['contoso-lakehouse', 0.27, 1.16, 0], ['contoso-realtime', 0.2, 1.2, 0],
    ['contoso-platform', 0.11, 1.3, 0], ['contoso-data-eng', 0.06, 2.3, 10],
  ],
  'pool-japaneast-01-gpu-l40s': [
    ['contoso-vision-inference', 0.45, 1.2, 0], ['contoso-copilot-serving', 0.4, 1.15, 0], ['contoso-batch-scoring', 0.15, 1.3, 0],
  ],
  'pool-brazilsouth-01-amd-genoa': [
    ['contoso-warehouse', 0.4, 1.2, 0], ['contoso-lakehouse', 0.35, 1.2, 0], ['contoso-platform', 0.25, 1.3, 0],
  ],
};

const allocations = [];
for (const p of pools) {
  const latest = latestOf(p.pool_id);
  const rows = allocSpec[p.pool_id];
  let used = 0;
  rows.forEach(([team, share, ratio, lowWeeks], i) => {
    const util = i === rows.length - 1 ? latest - used : Math.round(latest * share);
    used += util;
    allocations.push({
      pool_id: p.pool_id,
      reserved_by: team,
      allocated_units: Math.round((util * ratio) / 10) * 10,
      utilized_units: util,
      allocation_date: addWeeks(AS_OF, -(20 + i * 7)),
      low_use_weeks: lowWeeks,
    });
  });
}

// ------------------------------------------------------------------ supply pipeline (in flight)
const supply = [
  { order_id: 'ORD-2026-0412', pool_id: 'pool-eastus-01-intel-icx', sku_id: 'FAB-INTEL-ICX-64', cu: 1152,
    placed_on: addWeeks(AS_OF, -16), lands_on: addWeeks(AS_OF, 7), status: 'in-transit' },
  { order_id: 'ORD-2026-0431', pool_id: 'pool-westeurope-02-gpu-h100', sku_id: 'FAB-GPU-H100-8', cu: 480,
    placed_on: addWeeks(AS_OF, -12), lands_on: addWeeks(AS_OF, 12), status: 'ordered' },
  { order_id: 'ORD-2026-0440', pool_id: 'pool-southeastasia-01-amd-genoa', sku_id: 'FAB-AMD-GENOA-96', cu: 384,
    placed_on: addWeeks(AS_OF, -10), lands_on: addWeeks(AS_OF, 5), status: 'in-transit' },
];

// ------------------------------------------------------------------ incidents
const ago = (days) => addDays(AS_OF, -days);
const incidents = [];
const inc = (poolId, segment, sev, daysAgo, mttr, title) => incidents.push({
  incident_id: `INC-${String(incidents.length + 1).padStart(4, '0')}`, pool_id: poolId,
  sku_id: pools.find((p) => p.pool_id === poolId).sku_id, fabric_segment: segment, severity: sev, opened_on: ago(daysAgo), mttr_hours: mttr, title,
});
// East US: minor noise
inc('pool-eastus-01-intel-icx', 'eus-fabric-1', 3, 22, 4.5, 'Elevated queue wait on scheduler');
inc('pool-eastus-01-intel-icx', 'eus-fabric-2', 3, 51, 3.2, 'Node drain took longer than expected');
inc('pool-eastus-01-intel-icx', 'eus-fabric-1', 4, 70, 1.0, 'Transient metrics gap');
// West Europe AMD: quiet
inc('pool-westeurope-01-amd-genoa', 'weu-fabric-1', 4, 40, 1.4, 'Single node reboot');
// West Europe GPU
inc('pool-westeurope-02-gpu-h100', 'weu-gpu-1', 3, 30, 5.0, 'GPU driver reset on two nodes');
inc('pool-westeurope-02-gpu-h100', 'weu-gpu-2', 3, 64, 3.8, 'Interconnect flap');
// Southeast Asia: the reliability story, concentrated in one fabric segment
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 1, 6, 9.5, 'Storage fabric brownout, customer-visible');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 1, 27, 11.0, 'Top-of-rack switch failure cascade');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 2, 9, 6.0, 'Packet loss between racks');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 2, 19, 7.2, 'Repeated node fencing');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 2, 44, 5.5, 'Firmware rollback');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 3, 12, 3.0, 'Cooling alarm on two racks');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 3, 33, 4.0, 'Disk failure burst');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 3, 52, 2.5, 'Slow boot on new nodes');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 3, 75, 3.5, 'Power supply swap');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-2', 4, 15, 1.0, 'Telemetry agent crash');
inc('pool-southeastasia-01-amd-genoa', 'sea-fabric-1', 4, 60, 1.2, 'Single node reboot');
// Japan East
inc('pool-japaneast-01-gpu-l40s', 'jpe-gpu-1', 3, 18, 4.0, 'Inference queue backlog');
inc('pool-japaneast-01-gpu-l40s', 'jpe-gpu-2', 3, 58, 3.5, 'Model server OOM on burst');
// Brazil South
inc('pool-brazilsouth-01-amd-genoa', 'brs-fabric-1', 4, 37, 1.1, 'Single node reboot');

// ------------------------------------------------------------------ demand pipeline (requests)
// A request is what a team asks for. The first fields are what the planner needs. The rest is what the requester
// states about it, for the Product Team view: who is asking (org), when, what for, and what rides on it (revenue,
// a customer commitment, SLA impact, strategic importance). Requests that are already approved or completed are
// history: only "pending" requests count as demand, so history changes no plan.
const requests = [
  { request_id: 'REQ-1001', team: 'contoso-lakehouse', title: 'Lakehouse GA launch', pool_id: 'pool-eastus-01-intel-icx', cu: 480,
    needed_by: '2026-11-16', win_probability: 0.8, source: 'growth-forecast', priority: 'high', workload: 'analytics', status: 'pending',
    org: 'Contoso', submitted_on: ago(28), environment: 'production',
    use_case: 'Capacity for the Lakehouse general-availability launch: ingestion, storage and interactive queries for new tenants.',
    revenue_at_risk_usd: 4200000, customer_commitment: 'General availability on 16 Nov 2026', sla_impact: 'medium', strategic_importance: 'high' },
  { request_id: 'REQ-1002', team: 'contoso-copilot', title: 'Copilot in Fabric', pool_id: 'pool-eastus-01-intel-icx', cu: 1100,
    needed_by: '2027-01-11', win_probability: 0.7, source: 'growth-forecast', priority: 'high', workload: 'ai-assist', status: 'pending',
    org: 'Contoso', submitted_on: ago(19), environment: 'production',
    use_case: 'Serving capacity for Copilot in Fabric in East US: peak-hour inference and index refresh for new tenants.',
    revenue_at_risk_usd: 12000000, customer_commitment: 'Q1 2027 general availability', sla_impact: 'high', strategic_importance: 'critical' },
  { request_id: 'REQ-1003', team: 'contoso-realtime', title: 'Real-Time Analytics onboarding', pool_id: 'pool-eastus-01-intel-icx', cu: 320,
    needed_by: '2026-12-14', win_probability: 0.6, source: 'onboarding-queue', priority: 'medium', workload: 'streaming', status: 'pending',
    org: 'Contoso', submitted_on: ago(12), environment: 'production',
    use_case: 'Onboarding of real-time analytics tenants: event ingestion and streaming queries.',
    revenue_at_risk_usd: 1800000, customer_commitment: 'Preview customers live by mid-December', sla_impact: 'medium', strategic_importance: 'medium' },
  { request_id: 'REQ-1004', team: 'contoso-warehouse', title: 'Warehouse migration, wave 2', pool_id: 'pool-eastus-01-intel-icx', cu: 640,
    needed_by: '2027-01-25', win_probability: 0.5, source: 'sales-pipeline', priority: 'medium', workload: 'warehouse', status: 'pending',
    org: 'Contoso', submitted_on: ago(9), environment: 'production',
    use_case: 'The second wave of moving legacy warehouse customers onto Fabric: more concurrency for the warehouse in East US.',
    revenue_at_risk_usd: 3100000, customer_commitment: 'Enterprise agreement ramp from 4 Jan 2027', sla_impact: 'high', strategic_importance: 'high' },
  { request_id: 'REQ-2001', team: 'northwind-bi', title: 'Northwind BI consolidation', pool_id: 'pool-westeurope-01-amd-genoa', cu: 500,
    needed_by: '2027-02-01', win_probability: 0.6, source: 'sales-pipeline', priority: 'low', workload: 'bi', status: 'pending',
    org: 'Northwind', submitted_on: ago(6), environment: 'production',
    use_case: 'Consolidation of regional BI workloads onto one shared capacity.',
    revenue_at_risk_usd: 900000, customer_commitment: 'Year-end reporting cycle', sla_impact: 'low', strategic_importance: 'medium' },
  { request_id: 'REQ-3001', team: 'contoso-fine-tuning', title: 'Foundation model fine-tune', pool_id: 'pool-westeurope-02-gpu-h100', cu: 300,
    needed_by: '2026-12-01', win_probability: 0.7, source: 'growth-forecast', priority: 'high', workload: 'ai-training', status: 'pending',
    org: 'Contoso', submitted_on: ago(15), environment: 'production',
    use_case: 'Fine-tuning runs for the next foundation-model release: long GPU jobs.',
    revenue_at_risk_usd: 6500000, customer_commitment: 'Model release in Q1 2027', sla_impact: 'medium', strategic_importance: 'critical' },
  { request_id: 'REQ-4001', team: 'adatum-onboarding', title: 'Adatum onboarding', pool_id: 'pool-southeastasia-01-amd-genoa', cu: 400,
    needed_by: '2026-12-07', win_probability: 0.6, source: 'onboarding-queue', priority: 'medium', workload: 'warehouse', status: 'pending',
    org: 'Adatum', submitted_on: ago(10), environment: 'production',
    use_case: 'Onboarding of Adatum tenants under the enterprise agreement.',
    revenue_at_risk_usd: 1400000, customer_commitment: 'Enterprise agreement step-up on 1 Dec 2026', sla_impact: 'high', strategic_importance: 'high' },
  { request_id: 'REQ-5001', team: 'contoso-vision-inference', title: 'Vision inference rollout', pool_id: 'pool-japaneast-01-gpu-l40s', cu: 250,
    needed_by: '2026-11-30', win_probability: 0.7, source: 'onboarding-queue', priority: 'medium', workload: 'ai-inference', status: 'pending',
    org: 'Contoso', submitted_on: ago(8), environment: 'production',
    use_case: 'Rollout of vision-inference endpoints to new customers in Japan.',
    revenue_at_risk_usd: 2300000, customer_commitment: 'Regional launch on 30 Nov 2026', sla_impact: 'medium', strategic_importance: 'high' },
  { request_id: 'REQ-6001', team: 'contoso-sovereign', title: 'Sovereign analytics pilot', pool_id: 'pool-brazilsouth-01-amd-genoa', cu: 200,
    needed_by: '2027-01-18', win_probability: 0.5, source: 'sales-pipeline', priority: 'medium', workload: 'analytics', status: 'pending',
    org: 'Contoso', submitted_on: ago(5), environment: 'staging',
    use_case: 'Pilot of in-region sovereign analytics ahead of general availability.',
    revenue_at_risk_usd: 700000, customer_commitment: 'Sovereign controls GA on 1 Feb 2027', sla_impact: 'medium', strategic_importance: 'medium' },
  // history: already decided, so they are not demand
  { request_id: 'REQ-0801', team: 'contoso-warehouse', title: 'Warehouse concurrency uplift', pool_id: 'pool-eastus-01-intel-icx', cu: 600,
    needed_by: ago(35), win_probability: 1, source: 'growth-forecast', priority: 'medium', workload: 'warehouse', status: 'completed',
    org: 'Contoso', submitted_on: ago(132), decided_on: ago(117), delivered_on: ago(42), environment: 'production',
    use_case: 'More concurrent queries for the warehouse ahead of the summer reporting peak.' },
  { request_id: 'REQ-0802', team: 'contoso-fine-tuning', title: 'Fine-tune evaluation cluster', pool_id: 'pool-westeurope-02-gpu-h100', cu: 200,
    needed_by: addDays(AS_OF, 21), win_probability: 1, source: 'growth-forecast', priority: 'medium', workload: 'ai-training', status: 'approved',
    org: 'Contoso', submitted_on: ago(33), decided_on: ago(19), environment: 'production',
    use_case: 'A small GPU cluster to evaluate fine-tuned models before release.' },
  { request_id: 'REQ-0803', team: 'contoso-platform', title: 'Telemetry platform refresh', pool_id: 'pool-southeastasia-01-amd-genoa', cu: 300,
    needed_by: addDays(AS_OF, 35), win_probability: 1, source: 'onboarding-queue', priority: 'low', workload: 'analytics', status: 'approved',
    org: 'Contoso', submitted_on: ago(26), decided_on: ago(12), environment: 'production',
    use_case: 'Refresh of the telemetry pipeline that feeds capacity monitoring.' },
];
// ------------------------------------------------------------------ contracts
const contracts = [
  { contract_id: 'CON-0101', customer: 'Litware Global (enterprise agreement)', pool_id: 'pool-eastus-01-intel-icx',
    committed_cu: 2000, provisioned_cu: 1700, effective_date: '2027-01-04', term_months: 36, hard: true },
  { contract_id: 'CON-0203', customer: 'Fabrikam AI Labs (committed-use)', pool_id: 'pool-westeurope-02-gpu-h100',
    committed_cu: 1600, provisioned_cu: 400, effective_date: '2027-02-15', term_months: 24, hard: true },
  { contract_id: 'CON-0304', customer: 'Adatum Corporation (enterprise agreement)', pool_id: 'pool-southeastasia-01-amd-genoa',
    committed_cu: 900, provisioned_cu: 700, effective_date: '2026-12-01', term_months: 36, hard: true },
];

// ------------------------------------------------------------------ external events
// One record type for the softer signals; `signal` says which funnel reads it.
const events = [
  { event_id: 'EVT-S01', signal: 'seasonal', scope: { pool_id: 'pool-japaneast-01-gpu-l40s' }, date: '2027-04-05', duration_weeks: 3,
    uplift_pct: 0.45, confidence: 0.8, title: 'Contoso AI Summit launch', detail: 'Product launch calendar: inference traffic is expected to spike for about three weeks.' },
  { event_id: 'EVT-S02', signal: 'seasonal', scope: { pool_id: 'pool-westeurope-01-amd-genoa' }, date: '2026-12-14', duration_weeks: 2,
    uplift_pct: 0.2, confidence: 0.9, title: 'Year-end reporting peak', detail: 'Historical curve: finance workloads peak in the last two weeks of the year.' },
  { event_id: 'EVT-T01', signal: 'strategic', scope: { sku_class: 'general-compute-amd' }, date: '2027-03-15', effect: 'hardware-gen',
    confidence: 0.9, title: 'Next-generation AMD SKU available', detail: 'Orders placed after this date can target FAB-AMD-GEN6-128 at 25% more capacity per unit.' },
  { event_id: 'EVT-T02', signal: 'strategic', scope: { pool_id: 'pool-brazilsouth-01-amd-genoa' }, date: '2027-02-01', effect: 'demand', magnitude_cu: 250,
    confidence: 0.7, title: 'Brazil South sovereign features GA', detail: 'Region roadmap: general availability of in-region sovereign controls brings new tenants.' },
  { event_id: 'EVT-C01', signal: 'competitive', scope: { region: 'japaneast' }, date: ago(12),
    confidence: 0.4, title: 'Competitor announces inference price cut', detail: 'Account-team intel, unverified: customers may shift batch inference between clouds.' },
  { event_id: 'EVT-X01', signal: 'technology-shift', scope: { sku_class_group: 'gpu' }, date: '2027-06-30',
    confidence: 0.75, title: 'Estate mix shifting toward AI', detail: 'Workload-mix trend: GPU share of estate demand rising from 22% to 35% over twelve months.', from_share: 0.22, to_share: 0.35 },
  { event_id: 'EVT-G01', signal: 'geopolitical', scope: { pool_id: 'pool-brazilsouth-01-amd-genoa' }, date: '2027-08-01', effect: 'relocate-in', magnitude_cu: 900,
    confidence: 1.0, title: 'Data-residency mandate takes effect', detail: 'Regulatory tracker: regulated workloads must be hosted in-region; about 900 CU relocates into this pool.' },
];

// ------------------------------------------------------------------ dependencies
const dependencies = [
  { pool_id: 'pool-eastus-01-intel-icx', failover_pool_id: null,
    critical_services: [{ name: 'Lakehouse control plane', tier: 1 }, { name: 'OneLake gateway', tier: 1 }, { name: 'Capacity metrics service', tier: 1 }, { name: 'Notebook runtime', tier: 2 }] },
  { pool_id: 'pool-westeurope-01-amd-genoa', failover_pool_id: null, critical_services: [{ name: 'Warehouse engine', tier: 1 }, { name: 'BI semantic models', tier: 2 }] },
  { pool_id: 'pool-westeurope-02-gpu-h100', failover_pool_id: null, critical_services: [{ name: 'Model training scheduler', tier: 1 }] },
  { pool_id: 'pool-southeastasia-01-amd-genoa', failover_pool_id: null,
    critical_services: [{ name: 'Regional control plane', tier: 1 }, { name: 'Warehouse engine', tier: 1 }, { name: 'Real-time ingestion', tier: 1 }, { name: 'OneLake gateway', tier: 1 }, { name: 'Notebook runtime', tier: 2 }] },
  { pool_id: 'pool-japaneast-01-gpu-l40s', failover_pool_id: null, critical_services: [{ name: 'Inference gateway', tier: 1 }] },
  { pool_id: 'pool-brazilsouth-01-amd-genoa', failover_pool_id: null, critical_services: [{ name: 'Regional control plane', tier: 1 }, { name: 'Warehouse engine', tier: 2 }] },
];

// ------------------------------------------------------------------ performance
const performance = [
  { pool_id: 'pool-eastus-01-intel-icx', p95_latency_ms: 224, p95_baseline_ms: 200, queue_depth_p95: 18, queue_depth_limit: 60, knee_util_pct: 0.88 },
  { pool_id: 'pool-westeurope-01-amd-genoa', p95_latency_ms: 141, p95_baseline_ms: 140, queue_depth_p95: 6, queue_depth_limit: 60, knee_util_pct: 0.9 },
  { pool_id: 'pool-westeurope-02-gpu-h100', p95_latency_ms: 331, p95_baseline_ms: 280, queue_depth_p95: 12, queue_depth_limit: 40, knee_util_pct: 0.85 },
  { pool_id: 'pool-southeastasia-01-amd-genoa', p95_latency_ms: 262, p95_baseline_ms: 205, queue_depth_p95: 31, queue_depth_limit: 60, knee_util_pct: 0.86 },
  { pool_id: 'pool-japaneast-01-gpu-l40s', p95_latency_ms: 178, p95_baseline_ms: 125, queue_depth_p95: 27, queue_depth_limit: 40, knee_util_pct: 0.82 },
  { pool_id: 'pool-brazilsouth-01-amd-genoa', p95_latency_ms: 167, p95_baseline_ms: 160, queue_depth_p95: 7, queue_depth_limit: 60, knee_util_pct: 0.88 },
];

// ------------------------------------------------------------------ feeds
const feed = (feed_id, name, owner_team, cadence_days, age_days) => ({
  feed_id, name, owner_team, cadence_days, last_delivered: ago(age_days),
});
const feeds = [
  feed('telemetry-utilization', 'Utilization telemetry', 'Fabric SRE', 7, 2),
  feed('telemetry-performance', 'Latency and queue telemetry', 'Fabric SRE', 7, 3),
  feed('incident-log', 'Incident and SEV log', 'Fabric SRE', 1, 1),
  feed('service-dependency-map', 'Service dependency map', 'Service architecture', 30, 12),
  feed('power-carbon', 'Power and carbon accounting', 'Datacenter operations', 30, 20),
  feed('vendor-lead-times', 'Vendor lead times and risk', 'Supply chain', 14, 6),
  feed('security-notices', 'Vendor security and end-of-support notices', 'Hardware security engineering', 30, 9),
  feed('launch-calendar', 'Launch and seasonal calendar', 'Product marketing ops', 14, 5),
  feed('hardware-roadmap', 'Hardware and region roadmap', 'Hardware engineering PM', 30, 18),
  feed('market-intel', 'Market and competitor intel', 'Product marketing ops', 14, 41),
  feed('contracts-register', 'Enterprise agreement register', 'Commercial operations', 30, 10),
  feed('regulatory-tracker', 'Regulatory and trade tracker', 'Legal and regulatory affairs', 30, 15),
  feed('lifecycle-catalogue', 'SKU lifecycle catalogue', 'Hardware engineering PM', 30, 14),
];

// ------------------------------------------------------------------ write
const OUT = __dirname;
const files = {
  'meta.json': { source: 'synthetic', dataset_version: DATASET_VERSION, as_of: AS_OF, history_weeks: WEEKS,
    notice: 'All data in this folder is synthetic. It mirrors the structure of a capacity-planning estate; it is not Microsoft data.' },
  'policy.json': policy,
  'infrastructure.json': envelope(pools),
  'utilization.json': envelope(utilization),
  'allocations.json': envelope(allocations),
  'sku_catalogue.json': envelope(skus),
  'vendors.json': envelope(vendors),
  'supply_pipeline.json': envelope(supply),
  'incidents.json': envelope(incidents),
  'requests.json': envelope(requests),
  'contracts.json': envelope(contracts),
  'events.json': envelope(events),
  'dependencies.json': envelope(dependencies),
  'performance.json': envelope(performance),
  'feeds.json': envelope(feeds),
};

if (require.main === module) {
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
  }
  console.log(`seed: wrote ${Object.keys(files).length} files to ${OUT} (as_of ${AS_OF}, dataset ${DATASET_VERSION})`);
}

module.exports = { files, AS_OF, DATASET_VERSION };
