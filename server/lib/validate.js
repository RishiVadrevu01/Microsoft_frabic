'use strict';
/*
 * The input contract (OBSERVE). A small declarative schema check: every field the engine reads is declared here, so a
 * bad file fails loudly at boot with the file and field named, instead of producing a wrong plan later. The failure this
 * exists to prevent: a missing number becomes NaN, NaN compares false, and a funnel quietly proposes nothing.
 *
 * A field spec is
 *   a type name          'string' | 'number' | 'integer' | 'boolean' | 'date' | 'array' | 'object'
 *                        'nonneg' (number, 0 or more) | 'positive' (number above 0) | 'share' (number from 0 to 1)
 *                        'posint' (whole number above 0) | 'nonnegint' (whole number, 0 or more)
 *   an array of values   one of these exact values
 *   { $each: spec }      an array whose every element meets spec
 *   { field: spec, ... } a nested record
 * and any of the first two may end in "?" to be optional.
 */

const { isDate } = require('./dates');

const num = (v) => typeof v === 'number' && Number.isFinite(v);
// Each rule returns null when the value is fine, or what is wrong. The wording of the original types is unchanged.
const RULES = {
  string: (v) => (typeof v === 'string' && v.length > 0 ? null : 'must be string'),
  number: (v) => (num(v) ? null : 'must be number'),
  integer: (v) => (Number.isInteger(v) ? null : 'must be integer'),
  boolean: (v) => (typeof v === 'boolean' ? null : 'must be boolean'),
  date: (v) => (isDate(v) ? null : 'must be date'),
  array: (v) => (Array.isArray(v) ? null : 'must be array'),
  object: (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? null : 'must be object'),
  nonneg: (v) => (!num(v) ? 'must be number' : v >= 0 ? null : 'must be 0 or more'),
  positive: (v) => (!num(v) ? 'must be number' : v > 0 ? null : 'must be above 0'),
  share: (v) => (!num(v) ? 'must be number' : v >= 0 && v <= 1 ? null : 'must be between 0 and 1'),
  posint: (v) => (!Number.isInteger(v) ? 'must be integer' : v > 0 ? null : 'must be above 0'),
  nonnegint: (v) => (!Number.isInteger(v) ? 'must be integer' : v >= 0 ? null : 'must be 0 or more'),
};

function checkField(value, spec) {
  let optional = false;
  if (typeof spec === 'string' && spec.endsWith('?')) { optional = true; spec = spec.slice(0, -1); }
  if (value === undefined || value === null) return optional ? null : 'is required';
  if (Array.isArray(spec)) return spec.includes(value) ? null : `must be one of ${spec.join(', ')}`;
  const rule = RULES[spec];
  if (!rule) return `unknown type ${spec}`;
  return rule(value);
}

/** Every problem with `value` against `spec`, each starting with where it is. */
function checkSpec(value, spec, where) {
  if (typeof spec === 'string' || Array.isArray(spec)) {
    const problem = checkField(value, spec);
    return problem ? [`${where} ${problem}`] : [];
  }
  if (value === undefined || value === null) return [`${where} is required`];
  if ('$each' in spec) {
    if (!Array.isArray(value)) return [`${where} must be array`];
    return value.flatMap((item, i) => checkSpec(item, spec.$each, `${where}[${i}]`));
  }
  const notObject = RULES.object(value);
  if (notObject) return [`${where} ${notObject}`];
  return Object.entries(spec).flatMap(([name, s]) => checkSpec(value[name], s, `${where}.${name}`));
}

function checkRecord(record, fields, where) {
  return Object.entries(fields).flatMap(([name, spec]) => checkSpec(record[name], spec, `${where}.${name}`));
}

const SEVERITY = [1, 2, 3, 4];
const SCHEMAS = {
  'infrastructure.json': { pool_id: 'string', datacenter_id: 'string', region: 'string', region_label: 'string',
    geo: ['north-america', 'europe', 'asia-pacific', 'latin-america', 'middle-east'], lat: 'number', lon: 'number', sku_id: 'string',
    sku_class: 'string', workload_type: ['general-compute', 'ai-training', 'ai-inference'], capacity_units: 'posint',
    rack_count: 'posint', segments: { $each: { segment_id: 'string', units: 'posint' } } },
  'allocations.json': { pool_id: 'string', reserved_by: 'string', allocated_units: 'posint', utilized_units: 'nonnegint',
    allocation_date: 'date', low_use_weeks: 'nonnegint' },
  'sku_catalogue.json': { sku_id: 'string', label: 'string', sku_class: 'string', status: ['active', 'eol', 'planned'],
    replaced_by_sku: 'string?', capacity_equivalence_factor: 'positive?', order_unit_cu: 'posint', vendor_min_cu: 'posint',
    unit_cost_usd: 'positive', gco2_per_cu_hour: 'nonneg', security_support_ends: 'date', vendor_id: 'string',
    eol_date: 'date?', last_time_buy: 'date?', available_from: 'date?' },
  'vendors.json': { vendor_id: 'string', name: 'string', sku_ids: { $each: 'string' }, quoted_lead_weeks: 'positive',
    observed_lead_weeks: { $each: 'positive' }, risk_score: 'share' },
  'supply_pipeline.json': { order_id: 'string', pool_id: 'string', sku_id: 'string', cu: 'posint', placed_on: 'date', lands_on: 'date',
    status: ['approved-not-placed', 'ordered', 'in-transit', 'racked'] },
  'incidents.json': { incident_id: 'string', pool_id: 'string', sku_id: 'string', fabric_segment: 'string', severity: SEVERITY,
    opened_on: 'date', mttr_hours: 'nonneg', title: 'string' },
  'requests.json': { request_id: 'string', team: 'string', title: 'string', pool_id: 'string', cu: 'posint', needed_by: 'date',
    win_probability: 'share', source: ['onboarding-queue', 'sales-pipeline', 'growth-forecast'],
    priority: ['high', 'medium', 'low'], workload: 'string', status: ['pending', 'approved', 'declined', 'completed', 'live', 'lapsed'],
    // what the requester states, for the Product Team view (all optional: a request made through the API may carry none)
    org: 'string?', submitted_on: 'date?', decided_on: 'date?', delivered_on: 'date?', environment: 'string?', use_case: 'string?',
    revenue_at_risk_usd: 'nonneg?', customer_commitment: 'string?', sla_impact: 'string?', strategic_importance: 'string?',
    // written by the lab clock when a pending request falls due: it went live (and how much of it showed up) or it lapsed
    live_on: 'date?', realized_cu: 'nonnegint?', lapsed_on: 'date?' },
  'contracts.json': { contract_id: 'string', customer: 'string', pool_id: 'string', committed_cu: 'nonnegint', provisioned_cu: 'nonnegint',
    effective_date: 'date', term_months: 'posint', hard: 'boolean',
    // written by the lab clock when the contract takes effect
    in_effect_on: 'date?', realized_cu: 'nonnegint?' },
  'events.json': { event_id: 'string', signal: ['seasonal', 'strategic', 'competitive', 'technology-shift', 'geopolitical'],
    scope: 'object', date: 'date', confidence: 'share', title: 'string', detail: 'string' },
  'dependencies.json': { pool_id: 'string', failover_pool_id: 'string?', critical_services: { $each: { name: 'string', tier: [1, 2, 3] } } },
  'performance.json': { pool_id: 'string', p95_latency_ms: 'positive', p95_baseline_ms: 'positive', queue_depth_p95: 'nonneg',
    queue_depth_limit: 'positive', knee_util_pct: 'share' },
  'feeds.json': { feed_id: 'string', name: 'string', owner_team: 'string', cadence_days: 'posint', last_delivered: 'date' },
  'utilization.json': { pool_id: 'string', series: { $each: { week_start: 'date', utilized_units: 'nonneg' } } },
};

// What each kind of event must carry for the funnel that reads it. Without these a funnel computes with `undefined`,
// gets NaN, and proposes nothing, so the plan quietly loses the event. `scope` needs at least one selector.
const SCOPE_KEYS = ['estate', 'pool_id', 'region', 'sku_class', 'sku_class_group'];
const EVENT_RULES = {
  seasonal: { duration_weeks: 'posint', uplift_pct: 'positive' },
  strategic: { effect: ['hardware-gen', 'demand'] },
  competitive: {},
  'technology-shift': { from_share: 'share', to_share: 'share' },
  geopolitical: { effect: ['relocate-in'], magnitude_cu: 'positive' },
};
function eventRules(e, where) {
  const errors = [];
  if (e.scope && typeof e.scope === 'object' && !SCOPE_KEYS.some((k) => k in e.scope)) errors.push(`${where}.scope needs one of ${SCOPE_KEYS.join(', ')}`);
  const need = EVENT_RULES[e.signal];
  if (need) errors.push(...checkRecord(e, need, where));
  if (e.signal === 'strategic' && e.effect === 'demand') errors.push(...checkRecord(e, { magnitude_cu: 'positive' }, where));
  return errors;
}
const RECORD_RULES = { 'events.json': eventRules };

// The two files that are one object, not a list of records.
const SINGLETONS = {
  'meta.json': { as_of: 'date', history_weeks: 'posint?' },
  'policy.json': {
    policy_version: 'string', approved_by: 'string',
    floor_pct: { general: 'share', gpu: 'share' },
    cover_weeks: 'posint', buffer_pct: 'nonneg', due_soon_weeks: 'posint', plan_weeks: 'posint', horizons_weeks: { $each: 'posint' },
    forecast: { window_weeks: 'posint', backtest_horizon_weeks: 'posint', holt_margin: 'share', p_upper_z: 'positive' },
    pipeline: { overlap_discount: 'share' },
    lead_time: { default_weeks: 'posint', observed_min_samples: 'posint', vendor_risk_flag: 'share', vendor_risk_buffer_weeks: 'nonnegint' },
    reliability: { window_days: 'posint', weights: { 1: 'nonneg', 2: 'nonneg', 3: 'nonneg', 4: 'nonneg' }, flag_score: 'positive', critical_score: 'positive',
      replace_within_weeks: { critical: 'posint', high: 'posint' } },
    performance: { latency_ratio_flag: 'positive', latency_ratio_high: 'positive', queue_ratio_flag: 'share', knee_margin: 'share' },
    cost: { low_use_ratio: 'share', low_use_weeks: 'posint', keep_margin: 'nonneg', flag_share_of_usable: 'share' },
    dependency: { tier1_min: 'posint' },
    sustainability: { target_gco2_per_cu_hour: 'positive' },
    security: { horizon_weeks: 'posint', migration_weeks: 'posint' },
    seasonal: { horizon_weeks: 'posint' },
    feeds: { stale_multiplier: 'positive' },
    overview: { region_watch: 'share', region_at_risk: 'share', compare_weeks: 'posint' },
    demand_severity_weeks: { critical: 'posint', high: 'posint', medium: 'posint' },
    decisions: { blocked_deciders: { $each: 'string' } },
    approval: { budget_usd: 'positive', budget_label: 'string', second_approver_above_usd: 'positive' },
  },
};

// Every record file must declare itself synthetic. This is the guard the
// requirements ask for: real data can never slip in unlabeled.
function validateEnvelope(name, body) {
  const errors = [];
  if (!body || typeof body !== 'object') return [`${name}: not a JSON object`];
  if (body.source !== 'synthetic') errors.push(`${name}: source must be "synthetic" (got ${JSON.stringify(body.source)})`);
  if (!body.dataset_version) errors.push(`${name}: dataset_version is required`);
  return errors;
}

function validateFile(name, body) {
  const errors = validateEnvelope(name, body);
  const schema = SCHEMAS[name];
  if (schema && Array.isArray(body.records)) {
    body.records.forEach((rec, i) => {
      const where = `${name}[${i}]`;
      const problems = checkRecord(rec, schema, where);
      errors.push(...problems);
      // A conditional rule only makes sense on a record that is otherwise well formed.
      if (!problems.length && RECORD_RULES[name]) errors.push(...RECORD_RULES[name](rec, where));
    });
  } else if (schema) {
    errors.push(`${name}: records array is missing`);
  }
  return errors;
}

/** meta.json and policy.json: the envelope, then every field the engine reads. */
function validateSingleton(name, body) {
  const errors = validateEnvelope(name, body);
  const spec = SINGLETONS[name];
  if (spec && body && typeof body === 'object') errors.push(...checkRecord(body, spec, name));
  return errors;
}

module.exports = { validateFile, validateEnvelope, validateSingleton, checkRecord, checkSpec, SCHEMAS, SINGLETONS, EVENT_RULES, SCOPE_KEYS };
