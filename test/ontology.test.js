'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildOntology } = require('../server/lib/ontology');
const { buildOverview } = require('../server/lib/overview');
const { catalogue, reservations } = require('../server/lib/funnels');
const { decide } = require('../server/lib/decisions');
const { createApp } = require('../server/app');
const { P, freshStore } = require('./helpers');

const ontology = (store = freshStore()) => buildOntology(store);
const pool = (o, id) => o.pools.find((p) => p.pool_id === id);
const value = (o, poolId, layer, key) => pool(o, poolId).layers[layer].values.find((v) => v.key === key);

const ORDER = ['infrastructure', 'allocation', 'utilization', 'gap-waste', 'sku-lifecycle', 'reliability', 'planning-horizon'];

test('the ontology has the seven layers of the requirements, in order, four recorded and three derived', () => {
  const o = ontology();
  assert.equal(o.source, 'synthetic');
  assert.deepEqual(o.layers.map((l) => l.id), ORDER);
  assert.deepEqual(o.layers.map((l) => l.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(o.layers.filter((l) => l.kind === 'derived').map((l) => l.id), ['gap-waste', 'reliability', 'planning-horizon']);
  for (const l of o.layers) {
    assert.ok(l.question.length > 10, `${l.id} asks a question`);
    if (l.kind === 'derived') assert.ok(l.derived_from, `${l.id} says what it is derived from`);
  }
});

test('every pool has every layer, each with a headline that is one of its values', () => {
  const o = ontology();
  assert.equal(o.pools.length, 6);
  for (const p of o.pools) {
    assert.deepEqual(Object.keys(p.layers), ORDER);
    for (const l of o.layers) {
      const built = p.layers[l.id];
      assert.ok(built.values.length >= 5, `${p.pool_id} ${l.id} has values`);
      assert.ok(built.headline && built.values.includes(built.headline), `${p.pool_id} ${l.id} headline is one of its values`);
      for (const v of built.values) {
        assert.ok(v.key && v.label && v.unit, `${l.id}: ${JSON.stringify(v)} is complete`);
        assert.ok(v.value === null || ['number', 'string'].includes(typeof v.value), `${l.id}.${v.key} is plain`);
      }
    }
  }
});

test('the layers agree with the records and the engine, pool by pool', () => {
  const store = freshStore();
  const o = ontology(store);
  for (const a of store.all()) {
    const v = a.verdict, id = v.pool_id;
    assert.equal(value(o, id, 'infrastructure', 'installed_cu').value, a.ctx.pool.capacity_units);
    assert.equal(value(o, id, 'infrastructure', 'segments').value, a.ctx.pool.segments.length);
    assert.equal(value(o, id, 'allocation', 'allocated_cu').value, a.ctx.allocations.reduce((s, r) => s + r.allocated_units, 0));
    assert.equal(value(o, id, 'allocation', 'reservations').value, a.ctx.allocations.length);
    assert.equal(value(o, id, 'utilization', 'utilized_cu').value, a.ctx.latest);
    assert.equal(value(o, id, 'utilization', 'utilization').value, v.capacity.utilization_of_usable);
    assert.equal(value(o, id, 'gap-waste', 'unused_cu').value, v.capacity.allocated - v.capacity.utilized);
    assert.equal(value(o, id, 'gap-waste', 'reclaim_cu').value, v.reclaim.cu);
    assert.equal(value(o, id, 'sku-lifecycle', 'status').value, a.ctx.sku.status);
    assert.equal(value(o, id, 'sku-lifecycle', 'order_sku').value, v.what.order_sku);
    assert.equal(value(o, id, 'planning-horizon', 'state').value, v.state);
    assert.equal(value(o, id, 'planning-horizon', 'lead_weeks').value, v.lead.weeks);
    assert.equal(value(o, id, 'planning-horizon', 'order_cu').value, v.order.needed ? v.order.quantity_cu : 0);
    assert.equal(value(o, id, 'planning-horizon', 'needed_by').value, v.dates.needed_by);
  }
});

test('allocation adds up: reserved plus not yet reserved is the usable capacity', () => {
  const o = ontology();
  const store = freshStore();
  for (const a of store.all()) {
    const id = a.verdict.pool_id;
    assert.equal(value(o, id, 'allocation', 'allocated_cu').value + value(o, id, 'allocation', 'free_cu').value, a.verdict.capacity.usable_now, id);
  }
});

test('the health layer shows the very score the Reliability funnel flags on', () => {
  const store = freshStore();
  const o = ontology(store);
  for (const a of store.all()) {
    const f = a.results.find((r) => r.id === 'reliability');
    const shown = f.evidence.find((e) => e.label === 'Severity-weighted score').value;
    const score = value(o, a.verdict.pool_id, 'reliability', 'score').value;
    assert.ok(shown.startsWith(score.toFixed(1)), `${a.verdict.pool_id}: funnel says ${shown}, layer says ${score}`);
  }
  assert.equal(value(o, P.sea, 'reliability', 'health').value, 'flagged critical');
  assert.equal(value(o, P.sea, 'reliability', 'worst_segment').value, 'sea-fabric-2');
  assert.equal(value(o, P.eus, 'reliability', 'health').value, 'within normal range');
});

test('the baseline story reads straight off the layers', () => {
  const o = ontology();
  assert.equal(value(o, P.eus, 'planning-horizon', 'state').value, 'OVERDUE');
  assert.equal(value(o, P.eus, 'planning-horizon', 'order_cu').value, 4032);
  assert.equal(value(o, P.eus, 'planning-horizon', 'raise_by').note, '42 days overdue');
  assert.equal(value(o, P.eus, 'sku-lifecycle', 'status').value, 'eol');
  assert.equal(value(o, P.eus, 'sku-lifecycle', 'replaced_by').value, 'FAB-AMD-GENOA-96');
  assert.equal(value(o, P.eus, 'sku-lifecycle', 'order_sku').value, 'FAB-AMD-GENOA-96');
  assert.equal(value(o, P.eus, 'sku-lifecycle', 'factor').value, 1.35);
  assert.match(value(o, P.eus, 'sku-lifecycle', 'factor').note, /1 CU of FAB-AMD-GENOA-96 counts as 1.35 CU of FAB-INTEL-ICX-64/);
  assert.equal(value(o, P.weuAmd, 'planning-horizon', 'state').value, 'OK');
  assert.equal(value(o, P.weuAmd, 'planning-horizon', 'needed_by').value, null, 'a pool with no need has no date, not an invented one');
  assert.equal(value(o, P.weuGpu, 'sku-lifecycle', 'replaced_by').value, null);
});

test('reclaim: idle capacity below the flag threshold is shown but not counted, so the total matches the Overview', () => {
  const store = freshStore();
  const o = ontology(store);
  const overview = buildOverview(store, {});
  for (const a of store.all()) {
    const id = a.verdict.pool_id;
    const freeable = value(o, id, 'gap-waste', 'reclaimable_cu').value;
    const counted = value(o, id, 'gap-waste', 'reclaim_cu').value;
    assert.equal(freeable, reservations(a.ctx).reduce((s, r) => s + r.reclaimable, 0));
    assert.ok(counted === 0 || counted === freeable, `${id}: counted is all or nothing`);
  }
  assert.equal(value(o, P.sea, 'gap-waste', 'reclaimable_cu').value, 269);
  assert.equal(value(o, P.sea, 'gap-waste', 'reclaim_cu').value, 0);
  assert.equal(o.pools.reduce((s, p) => s + p.layers['gap-waste'].values.find((v) => v.key === 'reclaim_cu').value, 0), overview.kpis.reclaim.cu);
  assert.equal(o.pools.reduce((s, p) => s + p.layers['gap-waste'].values.find((v) => v.key === 'reclaim_usd').value, 0), overview.kpis.reclaim.value_usd);
});

test('utilization carries its history and the ceiling, for a chart drawn from these numbers alone', () => {
  const o = ontology();
  const s = pool(o, P.eus).layers.utilization.spark;
  assert.equal(s.values.length, 52);
  assert.equal(s.capacity_cu, 9600);
  assert.equal(s.ceiling_cu, 8160, '85% of 9,600 CU');
  assert.equal(s.values[s.values.length - 1], value(o, P.eus, 'utilization', 'utilized_cu').value);
  assert.ok(!pool(o, P.eus).layers.allocation.spark, 'only utilization has a history');
});

test('each layer names the file it comes from, and every funnel that reads that file is listed as a reader', () => {
  const o = ontology();
  const cat = catalogue();
  assert.deepEqual(o.layers.find((l) => l.id === 'planning-horizon').files, []);
  assert.equal(o.layers.find((l) => l.id === 'planning-horizon').funnels.length, 14);
  assert.ok(o.layers.find((l) => l.id === 'planning-horizon').all_funnels);
  for (const l of o.layers) {
    const readers = new Set(l.funnels.map((f) => f.id));
    for (const f of l.funnels) assert.ok(cat.some((c) => c.id === f.id && c.number === f.number && c.name === f.name), `${l.id}: ${f.id} is a real funnel`);
    for (const file of l.files.map((x) => x.file)) {
      for (const c of cat.filter((x) => x.sources.some((s) => s.file === file))) assert.ok(readers.has(c.id), `${l.id} reads ${file}, which funnel ${c.number} (${c.name}) reads, so it must be listed`);
    }
  }
  assert.deepEqual(o.layers.find((l) => l.id === 'allocation').funnels.map((f) => f.number), [4]);
  assert.deepEqual(o.layers.find((l) => l.id === 'utilization').funnels.map((f) => f.number), [1]);
});

test('every file a layer names is a real data file', () => {
  const fs = require('node:fs');
  const { DATA_DIR } = require('./helpers');
  for (const l of ontology().layers) for (const f of l.files) assert.ok(fs.existsSync(path.join(DATA_DIR, f.file)), `${l.id}: ${f.file}`);
});

test('the values are live: a scenario changes them, and only for the pools it touches', () => {
  const store = freshStore();
  const before = ontology(store);
  store.applyScenario('incident-storm-weu');
  const after = ontology(store);
  assert.ok(value(after, P.weuAmd, 'reliability', 'score').value > value(before, P.weuAmd, 'reliability', 'score').value);
  assert.equal(value(before, P.weuAmd, 'reliability', 'health').value, 'within normal range');
  assert.match(value(after, P.weuAmd, 'reliability', 'health').value, /^flagged/);
  assert.notEqual(value(after, P.weuAmd, 'planning-horizon', 'state').value, 'OK');
  assert.equal(value(after, P.eus, 'planning-horizon', 'order_cu').value, value(before, P.eus, 'planning-horizon', 'order_cu').value, 'an unrelated pool is untouched');
});

test('an approved order shows up as an order in flight on the infrastructure layer', () => {
  const store = freshStore();
  const before = value(ontology(store), P.eus, 'infrastructure', 'in_flight_cu').value;
  const drafted = store.assessment(P.eus).verdict.order.quantity_cu;
  decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  const after = value(ontology(store), P.eus, 'infrastructure', 'in_flight_cu').value;
  assert.equal(after, before + drafted);
  assert.equal(value(ontology(store), P.eus, 'planning-horizon', 'order_cu').value, 0, 'the approved order covers the need');
});

async function withServer(fn) {
  const store = freshStore();
  const server = createApp({ store, webRoot: path.join(__dirname, '..', 'web') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (url) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`); return { status: res.status, json: await res.json() }; };
  try { await fn({ call }); } finally { await new Promise((r) => server.close(r)); }
}

test('API: /api/ontology serves the same payload the module builds', () => withServer(async ({ call }) => {
  const res = await call('/api/ontology');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, JSON.parse(JSON.stringify(ontology())));
  assert.equal(res.json.layers.length, 7);
  assert.equal(res.json.pools.length, 6);
}));
