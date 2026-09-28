'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRaw } = require('../server/lib/data');
const { files } = require('../data/seed');
const { DATA_DIR, tempDataDir } = require('./helpers');

test('the seed files on disk are exactly what the generator produces (deterministic)', () => {
  for (const [name, body] of Object.entries(files)) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(body)), `${name} drifted from seed.js; run npm run seed`);
  }
});

test('every data file is labelled synthetic', () => {
  for (const name of Object.keys(files)) {
    const body = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    assert.equal(body.source, 'synthetic', `${name} must say source: "synthetic"`);
  }
});

test('the dataset loads and has six pools with 52 weeks of history each', () => {
  const raw = loadRaw(DATA_DIR);
  assert.equal(raw.pools.length, 6);
  for (const u of raw.utilization) assert.equal(u.series.length, 52);
  assert.equal(raw.as_of, '2026-09-21');
});

test('a file that is not labelled synthetic is refused', () => {
  const dir = tempDataDir();
  const f = path.join(dir, 'incidents.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  body.source = 'production';
  fs.writeFileSync(f, JSON.stringify(body));
  assert.throws(() => loadRaw(dir), /source must be "synthetic"/);
});

test('a field of the wrong type is refused with the file and field named', () => {
  const dir = tempDataDir();
  const f = path.join(dir, 'requests.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  body.records[0].cu = 'lots';
  fs.writeFileSync(f, JSON.stringify(body));
  assert.throws(() => loadRaw(dir), /requests\.json\[0\]\.cu must be integer/);
});

test('the request history is consistent, and the business fields a requester states are checked', () => {
  const raw = loadRaw(DATA_DIR);
  const history = raw.requests.filter((r) => r.status !== 'pending');
  assert.ok(history.length >= 3 && history.some((r) => r.status === 'completed'), 'the dataset carries requests that are already decided');
  for (const r of history) assert.ok(r.decided_on && r.decided_on >= r.submitted_on, `${r.request_id}: decided after it was submitted`);
  for (const r of raw.requests) assert.ok(r.submitted_on <= raw.as_of, `${r.request_id}: not submitted in the future`);

  const edit = (fn) => { const dir = tempDataDir(); const f = path.join(dir, 'requests.json'); const body = JSON.parse(fs.readFileSync(f, 'utf8')); fn(body.records); fs.writeFileSync(f, JSON.stringify(body)); return dir; };
  const pending = (recs) => recs.find((r) => r.status === 'pending');
  const done = (recs) => recs.find((r) => r.status === 'completed');
  assert.throws(() => loadRaw(edit((r) => { pending(r).sla_impact = 'extreme'; })), /sla_impact must be low, medium or high/);
  assert.throws(() => loadRaw(edit((r) => { pending(r).strategic_importance = 'low'; })), /strategic_importance must be medium, high or critical/);
  assert.throws(() => loadRaw(edit((r) => { pending(r).environment = 'moon'; })), /environment must be production, staging or development/);
  assert.throws(() => loadRaw(edit((r) => { pending(r).revenue_at_risk_usd = -5; })), /revenue_at_risk_usd must be 0 or more/);
  assert.throws(() => loadRaw(edit((r) => { pending(r).submitted_on = '2027-01-01'; })), /after the dataset date/);
  assert.throws(() => loadRaw(edit((r) => { const c = done(r); c.decided_on = '2000-01-01'; })), /decided before it was submitted/);
  assert.throws(() => loadRaw(edit((r) => { const c = done(r); c.delivered_on = '2000-01-01'; })), /delivered before it was decided/);
  assert.throws(() => loadRaw(edit((r) => { delete done(r).delivered_on; })), /a completed request needs delivered_on/);
  assert.throws(() => loadRaw(edit((r) => { delete done(r).decided_on; delete done(r).delivered_on; })), /needs decided_on/);
});

test('every pool has a location, and a place that is not on Earth is refused', () => {
  const raw = loadRaw(DATA_DIR);
  for (const p of raw.pools) assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180, `${p.pool_id}: ${p.lat}, ${p.lon}`);
  const edit = (fn) => { const dir = tempDataDir(); const f = path.join(dir, 'infrastructure.json'); const body = JSON.parse(fs.readFileSync(f, 'utf8')); fn(body.records); fs.writeFileSync(f, JSON.stringify(body)); return dir; };
  assert.throws(() => loadRaw(edit((r) => { delete r[0].lat; })), /infrastructure\.json\[0\]\.lat/);
  assert.throws(() => loadRaw(edit((r) => { r[1].lon = 'west'; })), /infrastructure\.json\[1\]\.lon must be number/);
  assert.throws(() => loadRaw(edit((r) => { r[2].lat = 95; })), /not a place on Earth/);
  assert.throws(() => loadRaw(edit((r) => { r[3].lon = -200; })), /not a place on Earth/);
});

test('reservations that do not add up to the pool reading are refused', () => {
  const dir = tempDataDir();
  const f = path.join(dir, 'allocations.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  body.records[0].utilized_units += 500;
  fs.writeFileSync(f, JSON.stringify(body));
  assert.throws(() => loadRaw(dir), /reservations use/);
});

test('a reference to a pool that does not exist is refused', () => {
  const dir = tempDataDir();
  const f = path.join(dir, 'incidents.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  body.records[0].pool_id = 'pool-nowhere';
  fs.writeFileSync(f, JSON.stringify(body));
  assert.throws(() => loadRaw(dir), /unknown pool pool-nowhere/);
});

test('an end-of-life SKU without a successor is refused', () => {
  const dir = tempDataDir();
  const f = path.join(dir, 'sku_catalogue.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete body.records.find((s) => s.sku_id === 'FAB-INTEL-ICX-64').replaced_by_sku;
  fs.writeFileSync(f, JSON.stringify(body));
  assert.throws(() => loadRaw(dir), /end-of-life but has no successor/);
});

test('the SKU lifecycle has several end-of-life SKUs each mapped to a successor with an equivalence factor', () => {
  const raw = loadRaw(DATA_DIR);
  const eol = raw.skus.filter((s) => s.status === 'eol');
  assert.ok(eol.length >= 3);
  for (const s of eol) {
    assert.ok(s.replaced_by_sku, `${s.sku_id} needs a successor`);
    assert.ok(s.capacity_equivalence_factor > 1, `${s.sku_id} needs an equivalence factor above 1`);
  }
});
