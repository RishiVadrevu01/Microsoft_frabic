'use strict';
/*
 * The data contracts between OBSERVE -> FORECAST -> PLANNING CONTEXT -> the 14 funnels -> the plan engine
 * (docs/CONTRACTS.md). Each test either pins a claim the document makes, or shows that a break which used to be silent
 * (a NaN that became "no order needed", a mistyped proposal that dropped a date) is now refused or shown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { P, DATA_DIR, freshStore, tempDataDir, dataset } = require('./helpers');
const { loadRaw, indexData } = require('../server/lib/data');
const { buildContext } = require('../server/lib/context');
const { runFunnels, REGISTRY } = require('../server/lib/funnels');
const { compose, assessPool } = require('../server/lib/verdict');
const { forecastSeries, FORECAST_CONTRACT, HORIZON_WEEKS } = require('../server/lib/forecast');
const { PROPOSAL_KINDS, resultProblems, proposalProblems } = require('../server/lib/contracts');
const { sizingDemand, coverageDemand } = require('../server/lib/timeline');
const golden = require('./fixtures/planning-golden.json');
const { build: buildGolden, SAMPLE_WEEKS } = require('../scripts/make-golden');

const data = indexData(loadRaw(DATA_DIR));
const POOLS = data.pools.map((p) => p.pool_id);

// A copy of data/ with one file edited, loaded through the real loader.
function loadWith(file, edit) {
  const dir = tempDataDir();
  const f = path.join(dir, file);
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  edit(body.records || body, body);
  fs.writeFileSync(f, JSON.stringify(body));
  return () => loadRaw(dir);
}
const refuses = (file, edit, re) => assert.throws(loadWith(file, edit), re);

// ---------------------------------------------------------------- 1. OBSERVE: what the engine will accept
test('the shipped dataset meets every input rule', () => {
  assert.doesNotThrow(() => loadRaw(DATA_DIR));
});

test('an event missing a number its funnel needs is refused at load, where it used to become "no order needed"', () => {
  const ev = (signal) => (recs) => recs.find((e) => e.signal === signal);
  refuses('events.json', (r) => { delete ev('geopolitical')(r).magnitude_cu; }, /events\.json\[\d+\]\.magnitude_cu is required/);
  refuses('events.json', (r) => { delete ev('seasonal')(r).uplift_pct; }, /events\.json\[\d+\]\.uplift_pct is required/);
  refuses('events.json', (r) => { delete ev('seasonal')(r).duration_weeks; }, /events\.json\[\d+\]\.duration_weeks is required/);
  refuses('events.json', (r) => { delete ev('technology-shift')(r).from_share; }, /events\.json\[\d+\]\.from_share is required/);
  refuses('events.json', (r) => { r.find((e) => e.signal === 'strategic' && e.effect === 'demand').magnitude_cu = 'lots'; }, /magnitude_cu must be number/);
  refuses('events.json', (r) => { delete r.find((e) => e.signal === 'strategic' && e.effect === 'demand').magnitude_cu; }, /magnitude_cu is required/);
});

test('an event with an unknown effect, a confidence outside 0 to 1, or a scope that reaches nothing is refused', () => {
  refuses('events.json', (r) => { r.find((e) => e.signal === 'geopolitical').effect = 'relocate-out'; }, /effect must be one of relocate-in/);
  refuses('events.json', (r) => { r[0].confidence = 1.4; }, /confidence must be between 0 and 1/);
  refuses('events.json', (r) => { r[0].scope = {}; }, /scope needs one of/);
  refuses('events.json', (r) => { r[0].scope = { region: 'atlantis' }; }, /its scope matches no pool/);
});

test('history that is negative, or a record with a value that would divide by zero, is refused', () => {
  refuses('utilization.json', (r) => { r[0].series[10].utilized_units = -400; }, /utilization\.json\[0\]\.series\[10\]\.utilized_units must be 0 or more/);
  refuses('utilization.json', (r) => { r[0].series[10].utilized_units = 'n/a'; }, /utilized_units must be number/);
  refuses('performance.json', (r) => { r[0].p95_baseline_ms = 0; }, /p95_baseline_ms must be above 0/);
  refuses('performance.json', (r) => { r[0].queue_depth_limit = 0; }, /queue_depth_limit must be above 0/);
  refuses('utilization.json', (r) => { r[0].series.splice(0, 30); }, /only 22 weeks of history \(need at least 26\)/);
});

test('the shape inside a list is checked too: services, segments and lead-time samples', () => {
  refuses('dependencies.json', (r) => { r[0].critical_services = [{ name: 'x' }]; }, /critical_services\[0\]\.tier is required/);
  refuses('dependencies.json', (r) => { r[0].critical_services[0].tier = 9; }, /tier must be one of 1, 2, 3/);
  refuses('vendors.json', (r) => { r[0].observed_lead_weeks = ['fast', 'slow']; }, /observed_lead_weeks\[0\] must be number/);
  refuses('vendors.json', (r) => { r[0].risk_score = 1.5; }, /risk_score must be between 0 and 1/);
  refuses('infrastructure.json', (r) => { delete r[0].segments[0].units; }, /segments\[0\]\.units is required/);
});

test('policy.json is checked field by field, and paired values must be in order', () => {
  refuses('policy.json', (_, b) => { delete b.forecast.p_upper_z; }, /policy\.json\.forecast\.p_upper_z is required/);
  refuses('policy.json', (_, b) => { b.floor_pct.gpu = 2; }, /floor_pct\.gpu must be between 0 and 1/);
  refuses('policy.json', (_, b) => { delete b.lead_time; }, /policy\.json\.lead_time is required/);
  refuses('policy.json', (_, b) => { b.overview.region_watch = 0.97; }, /region_watch must be below region_at_risk/);
  refuses('policy.json', (_, b) => { b.reliability.flag_score = 30; }, /flag_score must be below critical_score/);
  refuses('policy.json', (_, b) => { b.demand_severity_weeks.critical = 40; }, /critical, high and medium must not decrease/);
  refuses('meta.json', (_, b) => { b.as_of = 'yesterday'; }, /meta\.json\.as_of must be date/);
});

test('cross-file rules: a successor needs a factor, a failover is another pool, an order cannot land before it is placed', () => {
  refuses('sku_catalogue.json', (r) => { delete r.find((s) => s.replaced_by_sku).capacity_equivalence_factor; }, /has a successor but no capacity_equivalence_factor/);
  refuses('dependencies.json', (r) => { r[0].failover_pool_id = r[0].pool_id; }, /failover_pool_id .* must be another pool/);
  refuses('dependencies.json', (r) => { r[0].failover_pool_id = 'pool-nowhere'; }, /must be another pool in the estate/);
  refuses('supply_pipeline.json', (r) => { r[0].lands_on = '2020-01-01'; }, /lands 2020-01-01, before it was placed/);
});

// ---------------------------------------------------------------- 2. FORECAST
test('the forecast has the documented shape for every pool, and says which data and settings it came from', () => {
  for (const id of POOLS) {
    const { fc } = buildContext(data, id);
    assert.equal(fc.contract, FORECAST_CONTRACT);
    assert.equal(fc.contract, 'forecast/1');
    for (const k of ['p50', 'upper', 'lower']) {
      assert.equal(fc[k].length, HORIZON_WEEKS, `${id}: ${k} covers ${HORIZON_WEEKS} weeks`);
      assert.ok(fc[k].every(Number.isFinite), `${id}: ${k} is finite`);
    }
    assert.ok(fc.p50.every((v, i) => fc.lower[i] <= v + 1e-9 && v <= fc.upper[i] + 1e-9), `${id}: lower <= p50 <= upper`);
    assert.equal(fc.horizon_weeks, HORIZON_WEEKS);
    assert.equal(fc.interval.upper_quantile, 0.8, 'z 0.8416 is the 0.80 quantile');
    assert.equal(fc.interval.z, data.policy.forecast.p_upper_z);
    assert.equal(fc.input.weeks, 52);
    assert.match(fc.input_hash, /^[0-9a-f]{16}$/);
  }
});

test('the fingerprint is the same for the same input and changes with the history, the settings or a hand-set slope', () => {
  const values = data.utilByPool[P.eus].map((p) => p.utilized_units);
  const cfg = data.policy.forecast;
  const base = forecastSeries(values, cfg).input_hash;
  assert.equal(forecastSeries([...values], { ...cfg }).input_hash, base, 'deterministic');
  const moved = [...values]; moved[20] += 1;
  assert.notEqual(forecastSeries(moved, cfg).input_hash, base, 'one changed reading');
  assert.notEqual(forecastSeries(values, { ...cfg, p_upper_z: 1.28 }).input_hash, base, 'a changed setting');
  assert.notEqual(forecastSeries(values, cfg, { slope: 12 }).input_hash, base, 'a hand-set slope');
  assert.equal(assessPool(data, P.eus).verdict.forecast.input_hash, buildContext(data, P.eus).fc.input_hash, 'the plan carries it');
});

test('the accessors behave as documented at the edges: h 0 is the latest reading, later weeks clamp, earlier weeks read as now', () => {
  const ctx = buildContext(data, P.eus);
  assert.equal(ctx.p50At(0), ctx.latest);
  assert.equal(ctx.upperAt(0), ctx.latest);
  assert.equal(ctx.upperAt(-3), ctx.latest);
  assert.equal(ctx.upperAt(HORIZON_WEEKS), ctx.upperAt(HORIZON_WEEKS + 400), 'clamps at the last week');
  assert.equal(ctx.p50At(1), ctx.fc.p50[0], 'week 1 is index 0');
});

// ---------------------------------------------------------------- 3. PLANNING CONTEXT
test('the planning layer reproduces the pinned numbers: every accessor, every plan, under six what-if overrides', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildGolden(SAMPLE_WEEKS))), golden, 'run `node scripts/make-golden.js` only if a change to the numbers is intended');
});

test('baseline plans are unchanged: state and order for every pool', () => {
  const now = Object.fromEntries(POOLS.map((id) => { const v = assessPool(data, id).verdict; return [id, `${v.state}/${v.order.quantity_cu}`]; }));
  assert.deepEqual(now, {
    [P.eus]: 'OVERDUE/4032', [P.weuAmd]: 'OK/0', [P.weuGpu]: 'ORDER NOW/1344', [P.sea]: 'ORDER NOW/1728', [P.jpe]: 'PLAN/2592', [P.brs]: 'PLAN/1920',
  });
});

test('the timeline is 105 weekly rows whose columns add up as documented', () => {
  for (const id of POOLS) {
    const ctx = buildContext(data, id);
    const t = ctx.timeline();
    assert.equal(t.contract, 'planning-timeline/1');
    assert.equal(t.pool_id, id);
    assert.equal(t.points.length, HORIZON_WEEKS + 1);
    assert.deepEqual(t.points.map((p) => p.week), Array.from({ length: HORIZON_WEEKS + 1 }, (_, i) => i));
    assert.equal(t.points[0].date, data.as_of);
    assert.equal(t.forecast.input_hash, ctx.fc.input_hash, 'it names the forecast it was built on');
    const near = (a, b, why) => assert.ok(Math.abs(a - b) < 0.01, `${id}: ${why} (${a} vs ${b})`);
    let lastUsable = 0;
    for (const p of t.points) {
      near(p.demand.base_p80, p.demand.organic_p80 + p.demand.pipeline, `week ${p.week}: base_p80 = organic_p80 + pipeline`);
      near(p.demand.plan_p80, p.demand.base_p80 + p.demand.dated_adds + p.demand.seasonal_spike, `week ${p.week}: plan_p80`);
      near(p.demand.spread, p.demand.organic_p80 - p.demand.organic_p50, `week ${p.week}: spread`);
      near(p.capacity.usable, p.capacity.installed + p.capacity.landed, `week ${p.week}: usable = installed + landed`);
      assert.ok(p.capacity.usable >= lastUsable, 'supply only lands, so usable never falls');
      lastUsable = p.capacity.usable;
    }
  }
});

test('the timeline header states the rules, the lead time, the order SKU and the supply in flight', () => {
  const t = buildContext(data, P.eus).timeline();
  assert.equal(t.rules.floor_pct, 0.85);
  assert.equal(t.rules.cover_weeks, data.policy.cover_weeks);
  assert.equal(t.lead.quoted_weeks, 14);
  assert.ok(t.lead.observed_p80_weeks > t.lead.quoted_weeks, 'the vendor really takes longer than it quotes');
  assert.equal(t.order.sku_id, 'FAB-AMD-GENOA-96');
  assert.ok(t.order.factor > 1);
  assert.deepEqual(t.in_flight.map((o) => o.order_id), ['ORD-2026-0412']);
  const landing = t.points.find((p) => p.capacity.landed > 0);
  assert.equal(landing.date >= t.in_flight[0].lands_on, true);
});

test('the three definitions of demand agree, except where a temporary buffer has ended', () => {
  for (const id of POOLS) {
    const { ctx, results, verdict: v } = assessPool(data, id);
    if (!v.order.needed) continue;
    const props = results.flatMap((r) => r.proposals.map((p) => ({ ...p, funnel: r.id })));
    const h = v.order.cover_until_week;
    const sz = sizingDemand(ctx, props, h);
    assert.equal(sz.totalDemand, v.order.components.find((c) => c.label === 'Total demand').value, `${id}: the order is sized on exactly this`);
    assert.equal(sz.hardTotal, ctx.knownAddsAt(h), `${id}: the funnels propose exactly the dated step-ups the timeline knows`);
    // sizing = plan_p80 + temporary buffers - the seasonal spike the fleet views show while an event runs
    assert.ok(Math.abs(sz.totalDemand - (ctx.planDemandAt(h) + sz.tempTotal - ctx.seasonalSpikeAt(h))) < 1e-6, `${id}: sizing = plan_p80 + temporary buffers - seasonal spike`);
    assert.equal(coverageDemand(ctx, props, h), ctx.demandBase(h) + sz.hardTotal, `${id}: coverage leaves temporary buffers out`);
    if (id !== P.jpe) assert.equal(sz.tempTotal, 0, `${id}: no temporary buffer, so sizing equals plan_p80`);
  }
  const { ctx, results, verdict: v } = assessPool(data, P.jpe);
  const sz = sizingDemand(ctx, results.flatMap((r) => r.proposals), v.order.cover_until_week);
  const event = ctx.events.find((e) => e.signal === 'seasonal');
  assert.ok(sz.tempTotal > 1000, 'Japan East carries a launch buffer');
  assert.ok(v.order.cover_until_week >= ctx.hOf(event.date) + event.duration_weeks, 'the event is over by the end of the cover window');
  assert.equal(ctx.seasonalSpikeAt(v.order.cover_until_week), 0, 'so the fleet view no longer counts it');
  assert.ok(Math.abs(sz.totalDemand - ctx.planDemandAt(v.order.cover_until_week) - sz.tempTotal) < 1e-6, 'and the two differ by exactly the buffer');
});

// ---------------------------------------------------------------- 4. THE 14 FUNNELS
test('every funnel result over every pool meets the funnel-to-plan contract, and every proposal kind is in use', () => {
  const kinds = new Set();
  let n = 0;
  for (const id of POOLS) {
    for (const r of runFunnels(buildContext(data, id))) {
      n += 1;
      assert.deepEqual(resultProblems(r), [], `${id} funnel ${r.number}`);
      assert.equal(r.error, undefined, `${id} funnel ${r.number} ran cleanly`);
      for (const p of r.proposals) kinds.add(p.kind);
    }
  }
  assert.equal(n, 84);
  assert.deepEqual([...kinds].sort(), Object.keys(PROPOSAL_KINDS).sort(), 'no dead kind in the contract, no kind outside it');
});

test('which funnels read the forecast is what the document says: 1, 3, 5, 10, 12, 14; the other eight read only records', () => {
  const touched = Object.fromEntries(REGISTRY.map((f) => [f.number, new Set()]));
  for (const id of POOLS) {
    const ctx = buildContext(data, id);
    for (const f of REGISTRY) f.evaluate(new Proxy(ctx, { get(t, k, r) { if (typeof k === 'string') touched[f.number].add(k); return Reflect.get(t, k, r); } }));
  }
  const forecastMembers = ['fc', 'p50At', 'upperAt', 'pipelineAt', 'demandBase', 'knownAddsAt', 'seasonalSpikeAt', 'planDemandAt', 'spreadAt', 'crossing'];
  const readers = REGISTRY.filter((f) => forecastMembers.some((k) => touched[f.number].has(k))).map((f) => f.number);
  assert.deepEqual(readers, [1, 3, 5, 10, 12, 14]);
  for (const f of REGISTRY) assert.ok(!touched[f.number].has('planDemandAt'), `funnel ${f.number} uses base_p80, never the fleet views' demand`);
});

test('a funnel that hands the plan engine a mistyped proposal is shown as broken, and the plan is built from the rest', () => {
  const funnel1 = REGISTRY[0];
  const original = funnel1.evaluate;
  try {
    funnel1.evaluate = (ctx) => { const r = original(ctx); return { ...r, proposals: r.proposals.map((p) => ({ ...p, kind: 'capcity' })) }; };
    const { verdict: v } = assessPool(data, P.eus);
    const t = v.trace.find((x) => x.number === 1);
    assert.equal(t.status, 'no-data');
    assert.match(t.error, /unknown kind "capcity"/);
    assert.match(t.headline, /breaks its contract/);
    assert.equal(v.trace.length, 14, 'the other thirteen still run');
    assert.ok(v.order.needed, 'the plan still comes out');
  } finally { funnel1.evaluate = original; }
});

test('every way a result can break the contract is caught, with the reason', () => {
  const good = { status: 'flagged', flagged: true, severity: 'high', headline: 'h', evidence: [{ label: 'a', value: 'b' }], proposals: [{ kind: 'capacity', needed_by: '2026-12-01' }], context_only: false };
  assert.deepEqual(resultProblems(good), []);
  const bad = (change, re) => assert.match(resultProblems({ ...good, ...change }).join(' | '), re);
  bad({ status: 'maybe' }, /status must be one of/);
  bad({ flagged: false }, /status and flagged disagree/);
  bad({ severity: 'severe' }, /severity must be one of/);
  bad({ evidence: [{ label: 'a', value: 5 }] }, /evidence\[0\]\.value must be string/);
  bad({ status: 'quiet', flagged: false, severity: 'high' }, /not flagged must have severity none/);
  bad({ status: 'quiet', flagged: false, severity: 'none' }, /only a flagged funnel may propose/);
  bad({ context_only: true }, /context-only funnel must be flagged and propose nothing/);
  bad({ proposals: [{ kind: 'capcity', needed_by: '2026-12-01' }] }, /unknown kind "capcity"/);
  bad({ proposals: [{ kind: 'capacity', needed_by: 'soon' }] }, /needed_by must be date/);
  bad({ proposals: [{ kind: 'replace', needed_by: '2026-12-01', cu: NaN }] }, /cu must be number/);
  bad({ proposals: [{ kind: 'add_demand', cu: 100, at: '2026-12-01' }] }, /label is required/);
  bad({ proposals: [{ kind: 'lead', mode: 'set', weeks: 20 }] }, /note is required/);
  bad({ proposals: [{ kind: 'lead', mode: 'sometimes', weeks: 20, note: 'x' }] }, /mode must be one of set, add/);
  bad({ proposals: [{ kind: 'floor', floor_pct: 85, note: 'x' }] }, /floor_pct must be between 0 and 1/);
  bad({ proposals: [{ kind: 'reclaim', cu: 10, value_usd: 5 }] }, /from is required/);
  assert.deepEqual(proposalProblems({ kind: 'mix_shift', from: 0.3, to: 0.5, note: 'x' }), []);
  assert.match(resultProblems(null)[0], /not an object/);
});

test('compose refuses a proposal outside the contract instead of skipping it', () => {
  const { ctx, results } = assessPool(data, P.eus);
  const broken = results.map((r) => (r.number === 1 ? { ...r, proposals: r.proposals.map((p) => ({ ...p, kind: 'capcity' })) } : r));
  assert.throws(() => compose(ctx, broken), /Funnel 1 proposed "capcity", which is not part of the funnel-to-plan contract/);
});

test('the contract check does not change what a healthy pool decides: a funnel-by-funnel replay gives the same plan', () => {
  const { ctx, results, verdict } = assessPool(data, P.jpe);
  const again = compose(ctx, results.map((r) => ({ ...r })));
  assert.deepEqual(again.order, verdict.order);
  assert.deepEqual(again.dates, verdict.dates);
});

// ---------------------------------------------------------------- 5. it follows the lab, and the API
test('the timeline follows the lab: an approved order shows as supply landing, a scenario moves demand', () => {
  const store = freshStore();
  const before = store.assessment(P.eus).ctx.timeline();
  store.applyScenario('quota-surge-eastus');
  const after = store.assessment(P.eus).ctx.timeline();
  assert.ok(after.points[52].demand.pipeline > before.points[52].demand.pipeline || after.points[52].demand.plan_p80 !== before.points[52].demand.plan_p80, 'a quota surge changes the demand the timeline carries');
  assert.equal(after.forecast.input_hash, before.forecast.input_hash, 'scenarios add demand records, not history, so it is the same forecast');
});

test('a forecast that is refit on different history says so: a demand scale changes the fingerprint', () => {
  const a = buildContext(data, P.eus).fc.input_hash;
  const b = buildContext(data, P.eus, { demand_scale: 1.15 }).fc.input_hash;
  assert.notEqual(a, b);
});

test('dataset() still builds an edited dataset for the other tests', () => {
  const d = dataset((raw) => { raw.requests[0].cu += 1; });
  assert.ok(d.requests[0].cu > 0);
});
