'use strict';
// Loads the synthetic dataset from data/*.json, validates it, and checks that
// the records agree with each other (reservations add up to the pool's usage,
// every reference resolves, the SKU successor chain has no loop).

const fs = require('node:fs');
const path = require('node:path');
const { validateFile, validateSingleton, SCHEMAS } = require('./validate');
const { addWeeks, isDate } = require('./dates');
const { inScope } = require('./context');

const RECORD_FILES = {
  pools: 'infrastructure.json',
  allocations: 'allocations.json',
  skus: 'sku_catalogue.json',
  vendors: 'vendors.json',
  supply: 'supply_pipeline.json',
  incidents: 'incidents.json',
  requests: 'requests.json',
  contracts: 'contracts.json',
  events: 'events.json',
  dependencies: 'dependencies.json',
  performance: 'performance.json',
  feeds: 'feeds.json',
};

const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function integrity(raw) {
  const errors = [];
  const poolIds = new Set(raw.pools.map((p) => p.pool_id));
  const skuIds = new Set(raw.skus.map((s) => s.sku_id));
  const vendorIds = new Set(raw.vendors.map((v) => v.vendor_id));
  if (poolIds.size !== raw.pools.length) errors.push('infrastructure: duplicate pool_id');

  // Policy values that only make sense in relation to one another. The funnels compare against these, so a swapped pair
  // would flag everything, or nothing, without any error.
  const P = raw.policy;
  if (!(P.overview.region_watch < P.overview.region_at_risk)) errors.push('policy.overview: region_watch must be below region_at_risk');
  if (!(P.reliability.flag_score < P.reliability.critical_score)) errors.push('policy.reliability: flag_score must be below critical_score');
  if (!(P.performance.latency_ratio_flag <= P.performance.latency_ratio_high)) errors.push('policy.performance: latency_ratio_flag must not exceed latency_ratio_high');
  if (!(P.approval.second_approver_above_usd <= P.approval.budget_usd)) errors.push('policy.approval: second_approver_above_usd must not exceed budget_usd');
  const dsw = P.demand_severity_weeks;
  if (!(dsw.critical <= dsw.high && dsw.high <= dsw.medium)) errors.push('policy.demand_severity_weeks: critical, high and medium must not decrease');

  for (const [key, label] of [['allocations', 'allocation'], ['supply', 'supply order'], ['incidents', 'incident'], ['requests', 'request'],
    ['contracts', 'contract'], ['dependencies', 'dependency'], ['performance', 'performance record']]) {
    for (const rec of raw[key]) if (!poolIds.has(rec.pool_id)) errors.push(`${label} refers to unknown pool ${rec.pool_id}`);
  }
  for (const s of raw.skus) {
    if (!vendorIds.has(s.vendor_id)) errors.push(`sku ${s.sku_id} refers to unknown vendor ${s.vendor_id}`);
    if (s.replaced_by_sku && !skuIds.has(s.replaced_by_sku)) errors.push(`sku ${s.sku_id} is replaced by unknown ${s.replaced_by_sku}`);
    if (s.status === 'eol' && !s.replaced_by_sku) errors.push(`sku ${s.sku_id} is end-of-life but has no successor`);
    // Without a factor the conversion would quietly treat one successor unit as one old unit.
    if (s.replaced_by_sku && !(s.capacity_equivalence_factor > 0)) errors.push(`sku ${s.sku_id} has a successor but no capacity_equivalence_factor`);
    // successor chain must terminate
    const seen = new Set([s.sku_id]);
    let cur = s;
    while (cur && cur.replaced_by_sku) {
      if (seen.has(cur.replaced_by_sku)) { errors.push(`sku ${s.sku_id}: successor chain loops`); break; }
      seen.add(cur.replaced_by_sku);
      cur = raw.skus.find((x) => x.sku_id === cur.replaced_by_sku);
    }
  }
  for (const p of raw.pools) {
    if (!skuIds.has(p.sku_id)) errors.push(`pool ${p.pool_id} uses unknown sku ${p.sku_id}`);
    const seg = p.segments.reduce((a, s) => a + s.units, 0);
    if (seg !== p.capacity_units) errors.push(`pool ${p.pool_id}: segments add to ${seg}, capacity is ${p.capacity_units}`);
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) errors.push(`pool ${p.pool_id}: lat ${p.lat}, lon ${p.lon} is not a place on Earth`);

    const util = raw.utilization.find((u) => u.pool_id === p.pool_id);
    if (!util) { errors.push(`pool ${p.pool_id} has no utilization series`); continue; }
    const s = util.series;
    const minWeeks = raw.policy.forecast.window_weeks;
    if (s.length < minWeeks) errors.push(`pool ${p.pool_id}: only ${s.length} weeks of history (need at least ${minWeeks})`);
    if (s.at(-1).week_start !== raw.as_of) errors.push(`pool ${p.pool_id}: history ends ${s.at(-1).week_start}, as_of is ${raw.as_of}`);
    s.forEach((pt, i) => {
      if (i > 0 && pt.week_start !== addWeeks(s[i - 1].week_start, 1)) errors.push(`pool ${p.pool_id}: weeks are not consecutive at ${pt.week_start}`);
      if (!isDate(pt.week_start) || !Number.isFinite(pt.utilized_units)) errors.push(`pool ${p.pool_id}: bad point at index ${i}`);
    });

    const allocs = raw.allocations.filter((a) => a.pool_id === p.pool_id);
    if (allocs.length) {
      const used = allocs.reduce((a, r) => a + r.utilized_units, 0);
      const alloc = allocs.reduce((a, r) => a + r.allocated_units, 0);
      if (Math.abs(used - s.at(-1).utilized_units) > 1) errors.push(`pool ${p.pool_id}: reservations use ${used} but the latest reading is ${s.at(-1).utilized_units}`);
      if (alloc > p.capacity_units) errors.push(`pool ${p.pool_id}: reservations add to ${alloc}, more than capacity ${p.capacity_units}`);
    }
  }
  for (const v of raw.vendors) for (const id of v.sku_ids) if (!skuIds.has(id)) errors.push(`vendor ${v.vendor_id} lists unknown sku ${id}`);
  for (const d of raw.dependencies) {
    if (d.failover_pool_id && (!poolIds.has(d.failover_pool_id) || d.failover_pool_id === d.pool_id)) errors.push(`dependency for ${d.pool_id}: failover_pool_id ${d.failover_pool_id} must be another pool in the estate`);
  }
  for (const e of raw.events) {
    // An event that reaches no pool is dead data: it is read by no funnel, and nothing says so.
    if (!raw.pools.some((p) => inScope(e.scope, p))) errors.push(`event ${e.event_id}: its scope matches no pool`);
  }
  for (const o of raw.supply) if (o.lands_on < o.placed_on) errors.push(`order ${o.order_id}: lands ${o.lands_on}, before it was placed ${o.placed_on}`);
  for (const r of raw.requests) {
    if (r.sla_impact && !['low', 'medium', 'high'].includes(r.sla_impact)) errors.push(`request ${r.request_id}: sla_impact must be low, medium or high`);
    if (r.strategic_importance && !['medium', 'high', 'critical'].includes(r.strategic_importance)) errors.push(`request ${r.request_id}: strategic_importance must be medium, high or critical`);
    if (r.environment && !['production', 'staging', 'development'].includes(r.environment)) errors.push(`request ${r.request_id}: environment must be production, staging or development`);
    if (r.submitted_on && r.submitted_on > raw.as_of) errors.push(`request ${r.request_id}: submitted ${r.submitted_on}, after the dataset date ${raw.as_of}`);
    if (r.decided_on && r.submitted_on && r.decided_on < r.submitted_on) errors.push(`request ${r.request_id}: decided before it was submitted`);
    if (r.delivered_on && (!r.decided_on || r.delivered_on < r.decided_on)) errors.push(`request ${r.request_id}: delivered before it was decided`);
    if (r.status === 'completed' && !r.delivered_on) errors.push(`request ${r.request_id}: a completed request needs delivered_on`);
    if (['approved', 'completed', 'declined'].includes(r.status) && !r.decided_on) errors.push(`request ${r.request_id}: a ${r.status} request needs decided_on`);
  }
  return errors;
}

function loadRaw(dir) {
  const errors = [];
  const meta = readJson(dir, 'meta.json');
  errors.push(...validateSingleton('meta.json', meta));
  const policy = readJson(dir, 'policy.json');
  errors.push(...validateSingleton('policy.json', policy));

  const raw = { meta, policy, as_of: meta.as_of };
  for (const [key, file] of Object.entries(RECORD_FILES)) {
    const body = readJson(dir, file);
    errors.push(...validateFile(file, body));
    raw[key] = body.records || [];
  }
  const util = readJson(dir, 'utilization.json');
  errors.push(...validateFile('utilization.json', util));
  raw.utilization = util.records || [];

  if (!errors.length) errors.push(...integrity(raw));
  if (errors.length) throw new Error(`Dataset is not valid:\n - ${errors.join('\n - ')}`);
  return raw;
}

// Lookup tables. Rebuilt after any change to the raw arrays.
function indexData(raw) {
  const by = (arr, key) => Object.fromEntries(arr.map((r) => [r[key], r]));
  return {
    ...raw,
    poolById: by(raw.pools, 'pool_id'),
    skuById: by(raw.skus, 'sku_id'),
    vendorById: by(raw.vendors, 'vendor_id'),
    utilByPool: Object.fromEntries(raw.utilization.map((u) => [u.pool_id, u.series])),
    perfByPool: by(raw.performance, 'pool_id'),
    depByPool: by(raw.dependencies, 'pool_id'),
    feedById: by(raw.feeds, 'feed_id'),
  };
}

const clone = (raw) => structuredClone(raw);

module.exports = { loadRaw, indexData, clone, integrity, RECORD_FILES, SCHEMAS };
