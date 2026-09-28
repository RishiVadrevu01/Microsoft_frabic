'use strict';
/*
 * The AI advisor's facts (advisor.js): what changed, the options, the approval and budget rules, why this priority. All of it is
 * produced by the engine, the planner and the governance rules and handed over as strings, so the existing check that every figure
 * in the advisor's text is in the plan covers it. The advisor explains; it never ranks, chooses or computes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { P, freshStore } = require('./helpers');
const { advisorFacts, whatChanged } = require('../server/lib/advisor');
const { buildPacket, ruleText, verifyText, allText, createExplainer, SYSTEM } = require('../server/lib/explain');
const { buildOptions } = require('../server/lib/options');
const { decide } = require('../server/lib/decisions');
const { summarize } = require('../server/lib/summary');
const { createApp } = require('../server/app');

const asha = (extra) => ({ decision: 'approve', decided_by: 'Asha Rao', ...extra });
const ben = (extra) => ({ decision: 'approve', decided_by: 'Ben Ortiz', ...extra });
const POOLS = [P.eus, P.weuAmd, P.weuGpu, P.sea, P.jpe, P.brs];

async function stubAzure(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const out = await respond(seen.at(-1), seen.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const packetOf = (call) => JSON.parse(call.body.messages[1].content.replace(/^Plan facts \(JSON\):\n/, ''));
const wrap = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
const config = (url) => ({ enabled: true, endpoint: url, host: url.replace('http://', ''), apiKey: 'k', deployment: 'stub-gpt', apiVersion: '2024-10-21' });

test('the facts for an open order: the options, how one is recommended, what approving needs, the budget, the ranking, the cost of waiting', () => {
  const f = advisorFacts(freshStore(), P.weuGpu);
  assert.deepEqual(Object.keys(f), ['what_changed', 'options', 'how_recommended', 'approval_needed', 'budget', 'if_it_changed', 'cost_of_waiting', 'priority_explained']);
  assert.deepEqual(f.options.map((o) => [o.option, o.recommended, o.order, o.cost]), [
    ['Order as drafted', true, '1,344 CU', '$5.64M'],
    ['Order 1,056 CU now, size the rest later', false, '1,056 CU', '$4.44M'],
    ['Wait 4 weeks', false, 'none', '$0'],
  ]);
  assert.deepEqual(f.options[0].approver_needs, ['a second, different named person']);
  assert.deepEqual(f.options[2].approver_needs, ['nothing to approve']);
  assert.equal(f.options[0].then, 'no further order in the next 12 months');
  assert.match(f.how_recommended, /^Order what closes the gap if the budget allows it/);
  assert.match(f.approval_needed, /An order of \$5\.64M is above \$1\.50M, so a second, different named person has to countersign it/);
  assert.equal(f.budget, 'FY27 Q2 capacity budget (synthetic): $0 committed of $8.00M, $8.00M left. Both the budget and the thresholds are synthetic.');
  assert.equal(f.if_it_changed.length, 2);
  assert.match(f.if_it_changed[0], /^If the vendor met its quoted lead time \(16 weeks, not 19\): an order of 1,344 CU, to be raised by 26 Oct 2026, landing 15 Feb 2027\.$/);
  assert.match(f.cost_of_waiting, /Capacity would land 15 Mar 2027, 4 weeks after it is needed instead of 0/);
});

test('the options it is given are the planner\'s, not its own: the same ones, in the same order, with the same figures', () => {
  const store = freshStore();
  for (const id of POOLS) {
    const f = advisorFacts(store, id);
    const o = buildOptions(store, id);
    if (!o.needed) { assert.equal(f.options, undefined, `${id}: nothing to order, no options`); continue; }
    assert.deepEqual(f.options.map((x) => x.option), o.options.map((x) => x.title), id);
    assert.equal(f.options.filter((x) => x.recommended).length, 1, `${id}: exactly one recommended, by the rule`);
    assert.equal(f.options.find((x) => x.recommended).option, o.options.find((x) => x.recommended).title);
  }
});

test('the ranking is the engine\'s: the advisor is told the position and how it is decided, and it matches the queue', () => {
  const store = freshStore();
  const open = store.verdicts().filter((v) => v.order.needed).map((v) => v.pool_id);
  const ranked = summarize(store.verdicts(), store.data(), {}).actions.map((a) => a.pool_id).filter((id) => open.includes(id));
  const ord = ['1st', '2nd', '3rd', '4th', '5th'];
  ranked.forEach((id, i) => {
    const f = advisorFacts(store, id);
    assert.match(f.priority_explained, new RegExp(`Of ${open.length} open orders this ranks ${ord[i]}`), id);
    assert.match(f.priority_explained, /The ranking is fixed by the engine\./);
  });
  assert.match(advisorFacts(store, P.eus).priority_explained, /^Priority P0 \(critical\)\. Of 5 open orders this ranks 1st, by state \(OVERDUE\)/);
  assert.match(advisorFacts(store, P.weuGpu).priority_explained, /ranks 2nd, by state \(ORDER NOW\)/);
});

test('a pool with nothing to order gets what changed and nothing about options', () => {
  const f = advisorFacts(freshStore(), P.weuAmd);
  assert.deepEqual(Object.keys(f), ['what_changed']);
});

test('what changed: nothing yet, an approval and its order, a waiting approval, a decline that still stands, and a decline that has been overtaken', () => {
  const none = whatChanged(freshStore(), P.eus, freshStore().assessment(P.eus).verdict);
  assert.deepEqual(none, ['Nothing has been decided on this pool and the lab has not been moved, so there is nothing to compare this plan with.']);

  const a = freshStore();
  decide(a, P.eus, asha());
  assert.deepEqual(advisorFacts(a, P.eus).what_changed, ['Asha Rao approved 4,032 CU on 21 Sep 2026. Order ORD-LAB-0001 is approved and not yet placed, landing 8 Feb 2027.']);

  const w = freshStore();
  decide(w, P.weuGpu, asha());
  assert.match(advisorFacts(w, P.weuGpu).what_changed[0], /^Asha Rao approved 1,344 CU on 21 Sep 2026\. It is waiting for a second, different named person\.$/);

  const d = freshStore();
  decide(d, P.sea, { decision: 'decline', decided_by: 'Asha Rao', reason: 'Wait for the reliability review' });
  assert.deepEqual(advisorFacts(d, P.sea).what_changed, ['Asha Rao declined on 21 Sep 2026. The plan has not changed since.']);

  d.applyScenario('incident-storm-weu');
  assert.match(advisorFacts(d, P.jpe).what_changed[0], /^Nothing has been decided/, 'a scenario elsewhere leaves another pool\'s history alone');
  assert.equal(advisorFacts(d, P.sea).what_changed[0], 'Asha Rao declined on 21 Sep 2026. The plan has not changed since.', 'and one that does not touch this pool leaves its plan the same');

  // a decline that events have overtaken: the plan moved after it, and the advisor says how
  const e = freshStore();
  decide(e, P.eus, { decision: 'decline', decided_by: 'Asha Rao', reason: 'Wait for the quarter budget' });
  e.applyScenario('quota-surge-eastus');
  const line = advisorFacts(e, P.eus).what_changed[0];
  assert.match(line, /^Asha Rao declined on 21 Sep 2026\. Since then the plan has changed: /);
  assert.match(line, /the drafted order was 4,032 CU and is now 5,376 CU/);
});

test('what changed after the lab moves: the plan then and now, from the record written down when it moved', () => {
  const store = freshStore();
  store.advanceTime(8);
  const lines = advisorFacts(store, P.eus).what_changed;
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'Since the lab moved on 8 weeks (from 21 Sep 2026 to 16 Nov 2026): the plan read OVERDUE with an order of 4,032 CU landing 8 Feb 2027, and now reads OVERDUE with an order of 5,184 CU landing 5 Apr 2027.');
  const both = freshStore();
  decide(both, P.eus, asha());
  both.advanceTime(2);
  const l2 = advisorFacts(both, P.eus).what_changed;
  assert.equal(l2.length, 2, 'the decision, then the clock');
  assert.match(l2[0], /^Asha Rao approved 4,032 CU on 21 Sep 2026\. Order ORD-LAB-0001 is placed with the vendor, landing 8 Feb 2027\.$/);
});

test('without facts the packet is exactly what it was, so nothing else in the explainer moves', () => {
  const v = freshStore().assessment(P.eus).verdict;
  const plain = buildPacket(v);
  for (const k of ['what_changed', 'options', 'how_recommended', 'approval_needed', 'budget', 'if_it_changed', 'cost_of_waiting', 'priority_explained']) assert.equal(k in plain, false, k);
  const rich = buildPacket(v, advisorFacts(freshStore(), P.eus));
  for (const [k, val] of Object.entries(plain)) assert.deepEqual(rich[k], val, `${k} is unchanged`);
});

test('the rules-based text names the recommendation and the alternatives, puts approval and waiting under risks, and passes the figures check in every state', () => {
  const store = freshStore();
  const v = store.assessment(P.weuGpu).verdict;
  const packet = buildPacket(v, advisorFacts(store, P.weuGpu));
  const t = ruleText(packet);
  assert.match(t.summary, /The plan recommends "Order as drafted": 1,344 CU for \$5\.64M, landing 15 Feb 2027\. The alternatives are "Order 1,056 CU now, size the rest later" \(1,056 CU, \$4\.44M\)\.$/);
  assert.ok(t.risks.some((r) => /second, different named person has to countersign it/.test(r)));
  assert.ok(t.risks.some((r) => /^Waiting: Nothing is ordered today/.test(r)));
  assert.match(t.request_body, /A second, different named person|second, different named person has to countersign/);

  // every pool, in four different states of the lab: the text the advisor falls back to is always checkable
  const states = [freshStore(), (() => { const s = freshStore(); decide(s, P.eus, asha()); decide(s, P.weuGpu, asha()); decide(s, P.weuGpu, ben()); return s; })(), (() => { const s = freshStore(); s.advanceTime(6); return s; })(), (() => { const s = freshStore(); s.applyScenario('quota-surge-eastus'); return s; })()];
  for (const [i, s] of states.entries()) {
    for (const id of POOLS) {
      const pk = buildPacket(s.assessment(id).verdict, advisorFacts(s, id));
      assert.deepEqual(verifyText(allText(ruleText(pk)), pk), [], `state ${i}, ${id}`);
    }
  }
});

test('the changed-since sentence only appears in the summary when something was compared', () => {
  const store = freshStore();
  const quiet = ruleText(buildPacket(store.assessment(P.eus).verdict, advisorFacts(store, P.eus)));
  assert.equal(/What changed:/.test(quiet.summary), false);
  decide(store, P.eus, asha());
  store.advanceTime(1);
  const after = ruleText(buildPacket(store.assessment(P.eus).verdict, advisorFacts(store, P.eus)));
  assert.match(after.summary, /What changed: Asha Rao approved 4,032 CU on 21 Sep 2026/);
});

test('the model is told the rules for the new facts, and cannot rank or choose', () => {
  assert.match(SYSTEM, /7\. The facts may include what_changed, options, how_recommended, approval_needed, budget, if_it_changed, cost_of_waiting and priority_explained/);
  assert.match(SYSTEM, /Say which option is marked recommended and why, using how_recommended/);
  assert.match(SYSTEM, /8\. Naming an option that is in the facts is allowed; suggesting a date, quantity or SKU that is not in the facts is not/);
  assert.match(SYSTEM, /never choose between options, rank anything, or recommend an option that is not marked recommended/);
  assert.match(SYSTEM, /The budget and thresholds are synthetic/);
  assert.match(SYSTEM, /Never suggest a different date, quantity or SKU/, 'the original rule stands');
});

test('the model receives the facts, an answer that uses them is accepted, and one that invents an option is withheld', async () => {
  const store = freshStore();
  const seenPackets = [];
  const stub = await stubAzure((call) => {
    const p = packetOf(call);
    seenPackets.push(p);
    const alt = p.options.find((o) => !o.recommended && o.order !== 'none');
    return wrap({ summary: `${p.headline} The recommended option is ${p.options.find((o) => o.recommended).option}. An alternative is ${alt.option}, at ${alt.cost}.`, why_now: [p.what_sets_the_date], risks: [p.approval_needed], request_title: `Request for ${p.pool}`, request_body: 'See the plan.' });
  });
  try {
    const ex = createExplainer({ config: config(stub.url) });
    const r = await ex.explain(store.assessment(P.weuGpu).verdict, { facts: advisorFacts(store, P.weuGpu) });
    assert.equal(r.ai.status, 'used', JSON.stringify(r.ai.problems));
    assert.match(r.text.summary, /An alternative is Order 1,056 CU now, size the rest later, at \$4\.44M/);
    const sent = seenPackets[0];
    assert.deepEqual(sent.options.map((o) => o.recommended), [true, false, false]);
    assert.match(sent.priority_explained, /ranks 2nd/);
    assert.equal(sent.budget.includes('synthetic'), true);
    assert.equal(r.packet.options.length, 3, 'the packet the person can inspect has them too');
  } finally { await stub.close(); }

  const liar = await stubAzure((call) => { const p = packetOf(call); return wrap({ summary: `${p.headline} A better option is to order 900 CU for $3.90M.`, why_now: ['Demand is strong.'], risks: [], request_title: 'Request', request_body: 'Please order 900 CU.' }); });
  try {
    const r = await createExplainer({ config: config(liar.url) }).explain(store.assessment(P.weuGpu).verdict, { facts: advisorFacts(store, P.weuGpu) });
    assert.equal(r.ai.status, 'withheld');
    assert.ok(r.ai.problems.some((x) => /900/.test(x)) && r.ai.problems.some((x) => /3\.90/.test(x)), r.ai.problems.join(' | '));
    assert.equal(r.source, 'rules');
    assert.match(r.text.summary, /The plan recommends "Order as drafted"/, 'the rules text, with the planner\'s real options, is shown instead');
  } finally { await liar.close(); }
});

test('the choice cannot be moved by the advisor: asking it changes nothing in the lab', async () => {
  const store = freshStore();
  const before = JSON.stringify(store.state());
  const stub = await stubAzure((call) => { const p = packetOf(call); return wrap({ summary: p.headline, why_now: [], risks: [], request_title: 'r', request_body: 'r' }); });
  try {
    const server = createApp({ store, webRoot: path.join(__dirname, '..', 'web'), explainer: createExplainer({ config: config(stub.url) }) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/pools/${P.weuGpu}/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const json = await res.json();
    await new Promise((r) => server.close(r));
    assert.equal(res.status, 200);
    assert.equal(json.packet.options.filter((o) => o.recommended).length, 1);
    assert.match(json.packet.what_changed[0], /Nothing has been decided/);
    assert.equal(JSON.stringify(store.state()), before);
  } finally { await stub.close(); }
});
