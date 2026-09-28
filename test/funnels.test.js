'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REGISTRY, catalogue } = require('../server/lib/funnels');
const { RECORD_FILES } = require('../server/lib/data');
const { P, DATA_DIR, dataset, verdictOf } = require('./helpers');

const data = dataset();
const flaggedNumbers = (poolId) => verdictOf(data, poolId).trace.filter((t) => t.status === 'flagged').map((t) => t.number);
const funnel = (poolId, number) => verdictOf(data, poolId).trace.find((t) => t.number === number);

// The names and order in section 3.2 of the Engineering Requirements.
const REQUIRED = ['Demand', 'Reliability / Health', 'Performance', 'Cost & Efficiency', 'Strategic', 'Dependency / Blast Radius', 'Sustainability',
  'Supply Chain / Lead Time', 'Security & Compliance', 'Seasonal / Event-Driven', 'Competitive / Market Signal', 'Customer Contract & Commitment',
  'Technology Shift', 'Geopolitical & Regulatory'];

test('there are exactly the 14 funnels of the requirements, in their order, with their names', () => {
  assert.deepEqual(REGISTRY.map((f) => f.number), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.deepEqual(REGISTRY.map((f) => f.name), REQUIRED);
  assert.equal(new Set(REGISTRY.map((f) => f.id)).size, 14);
  assert.equal(catalogue().length, 14);
});

test('the restriction is real: nothing of the eleven extension funnels is left in the data or the code', () => {
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'constraints.json')), 'constraints.json belonged to the removed funnels');
  assert.ok(!('constraints' in RECORD_FILES));
  const flat = JSON.stringify(data.events) + JSON.stringify(data.vendors) + JSON.stringify(data.pools) + JSON.stringify(data.requests) + JSON.stringify(data.feeds);
  for (const gone of ['ai-mix-shift', 'org-demand-jump', 'financial_health', 'wafer', 'deferrable_share', 'internal-initiative', 'facilities-register', 'demand-pipeline']) {
    assert.ok(!flat.includes(gone), `${gone} should be gone from the data`);
  }
  const code = REGISTRY.map((f) => f.id).join(' ');
  for (const gone of ['workforce', 'contention', 'power', 'network', 'elasticity', 'vendor-financial', 'water', 'real-estate', 'silicon', 'mix-shift', 'org-']) {
    assert.ok(!code.includes(gone), `funnel "${gone}" should be gone`);
  }
});

test('each funnel carries the requirements\' own wording: what it detects, its primary sources, what it overrides or accelerates', () => {
  const by = Object.fromEntries(catalogue().map((c) => [c.number, c]));
  assert.equal(by[1].accelerates, 'Standard planning horizon');
  assert.equal(by[1].primary_sources, 'Sales pipeline, committed-use agreements, onboarding queue, growth forecasts');
  assert.equal(by[2].accelerates, 'Replacement priority regardless of headroom');
  assert.equal(by[3].accelerates, 'Standard planning horizon');
  assert.equal(by[8].accelerates, 'Earlier order trigger ahead of exhaustion date');
  assert.equal(by[9].accelerates, 'Mandatory replacement regardless of capacity');
  assert.equal(by[11].accelerates, 'Feeds strategic planning, not automatic procurement');
  assert.equal(by[12].accelerates, 'Contractual (hard) planning trigger');
  assert.equal(by[14].accelerates, 'Mandatory relocation / rearchitecture trigger');
  for (const c of catalogue()) assert.ok(c.detects.length > 20 && c.primary_sources.length > 10, `${c.name} is missing requirement text`);
});

test('only demand and performance feed the standard planning horizon; every other funnel is an override', () => {
  assert.deepEqual(REGISTRY.filter((f) => f.standard).map((f) => f.id), ['demand', 'performance']);
});

test('exactly one funnel is a fitted model; the rest are rules and none is an LLM', () => {
  const tags = REGISTRY.map((f) => f.tag);
  assert.equal(tags.filter((t) => t === 'ML').length, 1);
  assert.equal(REGISTRY.find((f) => f.tag === 'ML').id, 'demand');
  assert.ok(tags.every((t) => t === 'ML' || t === 'RULES'));
});

test('every funnel names the records it reads and the feed (and so the owning team) behind it', () => {
  for (const f of REGISTRY) {
    assert.ok(f.sources.length > 0, `${f.id} lists no source`);
    assert.ok(data.feedById[f.feed], `${f.id} refers to unknown feed ${f.feed}`);
  }
});

test('every feed in the register is used by at least one funnel (no orphan feeds)', () => {
  const used = new Set(REGISTRY.map((f) => f.feed));
  for (const f of data.feeds) if (f.feed_id !== 'lifecycle-catalogue') assert.ok(used.has(f.feed_id), `feed ${f.feed_id} is not read by any funnel`);
});

test('for every pool every funnel returns a well-formed result', () => {
  for (const p of data.pools) {
    const v = verdictOf(data, p.pool_id);
    assert.equal(v.trace.length, 14);
    for (const t of v.trace) {
      assert.ok(['flagged', 'quiet', 'no-data'].includes(t.status), `${p.pool_id} #${t.number} status ${t.status}`);
      assert.equal(typeof t.headline, 'string');
      assert.ok(t.headline.length > 0);
      assert.ok(Array.isArray(t.evidence));
      if (t.status === 'flagged') assert.ok(t.evidence.length > 0, `flagged #${t.number} needs evidence`);
      assert.ok(t.feed && t.feed.owner_team, `#${t.number} must carry its feed owner`);
    }
  }
});

test('every flagged item is traceable: it names the funnel and says what it did to the plan', () => {
  for (const p of data.pools) {
    for (const t of verdictOf(data, p.pool_id).trace.filter((x) => x.status === 'flagged')) {
      assert.ok(t.effects.length > 0, `${p.pool_id} #${t.number} ${t.name} is flagged but says nothing about its effect`);
      assert.ok(t.sources.length > 0);
    }
  }
});

test('East US: demand, cost, dependency, sustainability, supply chain, security and contract', () => {
  assert.deepEqual(flaggedNumbers(P.eus), [1, 4, 6, 7, 8, 9, 12]);
});

test('West Europe AMD is calm: only cost, strategic and supply-chain notes', () => {
  assert.deepEqual(flaggedNumbers(P.weuAmd), [4, 5, 8]);
});

test('reliability overrides headroom: Southeast Asia is 56% used but its incident load is critical', () => {
  const v = verdictOf(data, P.sea);
  assert.ok(v.capacity.utilization_of_usable < 0.6);
  const rel = funnel(P.sea, 2);
  assert.equal(rel.status, 'flagged');
  assert.equal(rel.severity, 'critical');
  assert.equal(v.driver.id, 'reliability');
  assert.equal(v.driver.standard, false);
  assert.equal(v.driver.kind, 'Funnel-triggered: Reliability / Health');
  assert.match(rel.headline, /sea-fabric-2/);
});

test('the reliability funnel is quiet where the incident load is normal', () => {
  assert.equal(funnel(P.eus, 2).status, 'quiet');
  assert.equal(funnel(P.brs, 2).status, 'quiet');
});

test('a contract is a hard trigger: it sets the H100 pool date and the plan is funnel-triggered', () => {
  const v = verdictOf(data, P.weuGpu);
  assert.equal(v.driver.id, 'customer-contract');
  assert.equal(v.dates.needed_by, '2027-02-15');
  assert.equal(v.driver.kind, 'Funnel-triggered: Customer Contract & Commitment');
  assert.deepEqual(flaggedNumbers(P.weuGpu), [7, 8, 12, 13]);
});

test('demand-driven planning is labelled standard: East US is set by the demand funnel', () => {
  const v = verdictOf(data, P.eus);
  assert.equal(v.driver.id, 'demand');
  assert.equal(v.driver.standard, true);
  assert.equal(v.driver.kind, 'Standard demand-driven planning');
});

test('AI training pools are not offered a SKU swap by the sustainability funnel', () => {
  const s = funnel(P.weuGpu, 7);
  assert.equal(s.status, 'flagged');
  assert.match(s.headline, /AI-training pool that cannot swap/);
  assert.ok(!s.effects.some((e) => /retiring/i.test(e)));
});

test('Japan East: strain below the floor and a launch spike set the plan', () => {
  const nums = flaggedNumbers(P.jpe);
  for (const n of [3, 10]) assert.ok(nums.includes(n), `expected #${n} flagged`);
  assert.match(funnel(P.jpe, 3).headline, /1\.42x baseline/);
  assert.equal(verdictOf(data, P.jpe).driver.id, 'seasonal');
});

test('the competitive funnel is recorded but never changes the plan', () => {
  const t = funnel(P.jpe, 11);
  assert.equal(t.status, 'flagged');
  assert.equal(t.context_only, true);
  assert.match(t.effects.join(' '), /Context only/);
  const noCompetitive = dataset((raw) => { raw.events = raw.events.filter((e) => e.signal !== 'competitive'); });
  for (const p of data.pools) {
    const a = verdictOf(data, p.pool_id);
    const b = verdictOf(noCompetitive, p.pool_id);
    assert.equal(a.order.quantity_cu, b.order.quantity_cu);
    assert.equal(a.dates.raise_by, b.dates.raise_by);
    assert.equal(a.state, b.state);
  }
});

test('Brazil South: a data-residency mandate is mandatory, so it does not wait for utilization', () => {
  const v = verdictOf(data, P.brs);
  assert.equal(funnel(P.brs, 14).status, 'flagged');
  assert.equal(v.driver.id, 'geopolitical');
  assert.equal(v.dates.needed_by, '2027-08-01');
  assert.equal(v.lead.weeks, 20);
});

test('a funnel with no record for the pool says "no data", it does not pretend to be quiet', () => {
  assert.equal(funnel(P.eus, 10).status, 'no-data');
  assert.equal(funnel(P.weuAmd, 12).status, 'no-data');
});

test('a stale feed is marked on the funnels that lean on it', () => {
  const t = funnel(P.jpe, 11);
  assert.equal(t.feed.stale, true);
  assert.equal(t.stale, true);
  assert.equal(funnel(P.eus, 1).stale, false);
});

test('a broken funnel is shown as unavailable instead of taking the plan down', () => {
  const broken = dataset((raw) => { raw.dependencies = raw.dependencies.map((d) => ({ ...d, critical_services: null })); });
  const v = verdictOf(broken, P.eus);
  const dep = v.trace.find((t) => t.number === 6);
  assert.equal(dep.status, 'no-data');
  assert.match(dep.headline, /could not be computed/);
  assert.equal(v.trace.length, 14);
});

test('demand sources named in the requirements are all valid request sources', () => {
  const sources = new Set(data.requests.map((r) => r.source));
  for (const s of sources) assert.ok(['onboarding-queue', 'sales-pipeline', 'growth-forecast'].includes(s), s);
  assert.ok(sources.size >= 2, 'the demand pipeline should mix sources');
});
