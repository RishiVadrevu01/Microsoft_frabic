'use strict';
/*
 * The decision snapshot: what a decision was based on, kept in the record and covered by the hash chain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { P, freshStore } = require('./helpers');
const { decide, verifyChain } = require('../server/lib/decisions');
const { planHash } = require('../server/lib/basis');
const { assessPool } = require('../server/lib/verdict');
const crypto = require('node:crypto');

test('a decision keeps the dataset, the forecast, the plan fingerprint and what every funnel said', () => {
  const store = freshStore();
  const at = store.assessment(P.eus).verdict;
  const { record } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  const b = record.basis;
  assert.equal(b.dataset_version, '2026.09.0');
  assert.equal(b.advanced_weeks, 0);
  assert.deepEqual(b.forecast, { contract: 'forecast/1', model: at.forecast.model, input_hash: at.forecast.input_hash });
  assert.equal(b.plan_hash, planHash(at), 'the fingerprint is of the plan the person saw, not the one after their order');
  assert.equal(b.lead_weeks, at.lead.weeks);
  assert.equal(b.driver, at.driver.id);
  assert.equal(b.funnels.length, 14);
  assert.deepEqual(b.funnels[0], [1, 'flagged', 'high']);
});

test('the fingerprint changes when anything the plan is made of changes, and not otherwise', () => {
  const store = freshStore();
  const v = store.assessment(P.eus).verdict;
  assert.equal(planHash(v), planHash(store.assessment(P.eus).verdict), 'the same plan, the same fingerprint');
  const data = store.data();
  const lead = assessPool(data, P.eus, { lead_time_weeks: 8 }).verdict;
  const floor = assessPool(data, P.eus, { floor_pct: 0.9 }).verdict;
  const grow = assessPool(data, P.eus, { growth_pts_per_week: 1.5 }).verdict;
  const hashes = new Set([planHash(v), planHash(lead), planHash(floor), planHash(grow)]);
  assert.equal(hashes.size, 4, 'a shorter lead time, a higher ceiling and faster growth are each a different plan');
  assert.notEqual(planHash(v), planHash(store.assessment(P.weuAmd).verdict));
  assert.match(planHash(v), /^[0-9a-f]{16}$/);
});

test('after the plan moves, the record still says what it was when the decision was taken', () => {
  const store = freshStore();
  const before = planHash(store.assessment(P.eus).verdict);
  const { record } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  assert.notEqual(planHash(store.assessment(P.eus).verdict), before, 'approving changes the plan: the order is now in flight');
  assert.equal(record.basis.plan_hash, before);
  assert.equal(store.state().decisions[0].basis.plan_hash, before);
});

test('the basis is inside the hash chain: editing it is caught, and records without one still verify', () => {
  const store = freshStore();
  decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  decide(store, P.sea, { decision: 'decline', decided_by: 'Asha Rao', reason: 'Wait for the reliability review' });
  const records = store.state().decisions;
  assert.deepEqual(verifyChain(records), { ok: true, records: 2 });

  const edited = JSON.parse(JSON.stringify(records));
  edited[0].basis.plan_hash = '0000000000000000';
  assert.equal(verifyChain(edited).ok, false);
  assert.equal(verifyChain(edited).broken_at, 'DEC-0001');
  const wiped = JSON.parse(JSON.stringify(records));
  delete wiped[1].basis;
  assert.equal(verifyChain(wiped).broken_at, 'DEC-0002', 'removing it is an edit too');

  // a log written before the basis existed: hashed without it, and still valid
  const old = []; let prev = '0'.repeat(64);
  for (const id of ['DEC-0001', 'DEC-0002']) {
    const core = { decision_id: id, pool_id: P.eus, decision: 'decline', decided_by: 'Asha Rao', reason: 'older record', prev_hash: prev };
    const hash = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
    old.push({ ...core, hash }); prev = hash;
  }
  assert.deepEqual(verifyChain(old), { ok: true, records: 2 });
});

test('a decision taken after the lab has moved says how far, and which forecast it saw', () => {
  const store = freshStore();
  const seedHash = store.assessment(P.eus).verdict.forecast.input_hash;
  store.advanceTime(4);
  const { record } = decide(store, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  assert.equal(record.basis.advanced_weeks, 4);
  assert.equal(record.as_of, '2026-10-19');
  assert.notEqual(record.basis.forecast.input_hash, seedHash, 'refit on four more weeks of history');
  assert.equal(record.basis.forecast.input_hash, store.assessment(P.eus).verdict.forecast.input_hash, 'approving an order does not change the forecast, only the plan');
});

test('the outcome ledger fingerprints each plan it writes down', () => {
  const store = freshStore();
  const expected = planHash(store.assessment(P.eus).verdict);
  store.advanceTime(2);
  assert.equal(store.state().ledger[0].pools[P.eus].plan.hash, expected);
});
