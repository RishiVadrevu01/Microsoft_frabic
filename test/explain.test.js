'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { parseEnv, loadEnv, aiConfig } = require('../server/lib/env');
const { createExplainer, buildPacket, ruleText, verifyText, allText, SYSTEM } = require('../server/lib/explain');
const { createApp } = require('../server/app');
const { P, freshStore, dataset, verdictOf } = require('./helpers');

const KEY = 'test-key-do-not-leak';
const data = dataset();
const verdict = (pool) => verdictOf(data, pool);

// A local stand-in for the Azure OpenAI chat-completions endpoint.
async function stubAzure(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const call = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      seen.push(call);
      const out = await respond(call, seen.length);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json !== undefined ? out.json : {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const packetOf = (call) => JSON.parse(call.body.messages[1].content.replace(/^Plan facts \(JSON\):\n/, ''));
const wrap = (obj) => ({ json: { choices: [{ message: { content: JSON.stringify(obj) } }] } });
// A faithful "model": re-tells the packet in its own words, using only its figures.
const faithful = (call) => {
  const p = packetOf(call);
  return wrap({
    summary: `In plain words: ${p.headline}`,
    why_now: p.flagged_funnels.slice(0, 3).map((s) => s.headline),
    risks: [],
    request_title: `Request for ${p.pool}`,
    request_body: p.order ? `Please order ${p.order.quantity} of ${p.order.sku} for ${p.order.cost}, placed ${p.order.place_order}.` : 'No request is needed.',
  });
};
const config = (url, extra = {}) => ({ enabled: true, endpoint: url, host: url.replace('http://', ''), apiKey: KEY, deployment: 'stub-gpt', apiVersion: '2024-10-21', ...extra });

// ------------------------------------------------------------------ configuration
test('env parsing: comments, quotes and blank lines; the process environment wins over the file', () => {
  const v = parseEnv('# note\n\nA=1\nB = "two words"\nC=\'x\'\nno-equals\n');
  assert.deepEqual(v, { A: '1', B: 'two words', C: 'x' });
  const merged = loadEnv(path.join(__dirname, 'no-such.env'), { AZURE_OPENAI_API_KEY: 'from-shell', PATH: 'ignored' });
  assert.deepEqual(merged, { AZURE_OPENAI_API_KEY: 'from-shell' });
});

test('AI config: off without an endpoint or key, or over plain http; on with both', () => {
  assert.equal(aiConfig({}).enabled, false);
  assert.match(aiConfig({ AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/' }).reason, /API_KEY is not set/);
  assert.match(aiConfig({ AZURE_OPENAI_API_KEY: 'k' }).reason, /ENDPOINT is not set/);
  assert.match(aiConfig({ AZURE_OPENAI_ENDPOINT: 'http://evil.example.com', AZURE_OPENAI_API_KEY: 'k' }).reason, /must be https/);
  assert.match(aiConfig({ AZURE_OPENAI_ENDPOINT: 'not a url', AZURE_OPENAI_API_KEY: 'k' }).reason, /valid URL/);
  assert.equal(aiConfig({ USE_AZURE_OPENAI: 'false', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/', AZURE_OPENAI_API_KEY: 'k' }).enabled, false);
  const ok = aiConfig({ AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/some/path', AZURE_OPENAI_API_KEY: 'k' });
  assert.equal(ok.enabled, true);
  assert.equal(ok.endpoint, 'https://x.openai.azure.com');
  assert.equal(ok.deployment, 'gpt-4.1-mini');
  assert.equal(ok.apiVersion, '2024-10-21');
  assert.equal(aiConfig({ AZURE_OPENAI_ENDPOINT: 'http://127.0.0.1:9', AZURE_OPENAI_API_KEY: 'k' }).enabled, true, 'loopback http is allowed for local stand-ins');
});

// ------------------------------------------------------------------ the fact packet and the rules text
test('the rules-based text always passes its own figures check, for every pool', () => {
  for (const p of data.pools) {
    const packet = buildPacket(verdict(p.pool_id));
    const text = ruleText(packet);
    assert.deepEqual(verifyText(allText(text), packet), [], `${p.pool_id}: ${allText(text)}`);
    assert.ok(text.summary.length > 10 && text.request_title.length > 5 && text.request_body.length > 10);
  }
});

test('the packet carries the plan as strings to copy, and nothing that lets the model decide', () => {
  const packet = buildPacket(verdict(P.eus));
  assert.equal(packet.order.quantity, '4,032 CU');
  assert.equal(packet.order.sku, 'FAB-AMD-GENOA-96');
  assert.equal(packet.order.capacity_needed_by, '28 Dec 2026');
  assert.match(packet.order.place_order, /^today, 21 Sep 2026 \(it was due 10 Aug 2026, 42 days ago\)$/);
  assert.equal(packet.order.lead_time, '20 weeks');
  assert.match(packet.what_sets_the_date, /^Demand:/);
  assert.equal(buildPacket(verdict(P.weuAmd)).order, null);
  const gpu = buildPacket(verdict(P.weuGpu));
  assert.equal(gpu.planning_basis, 'Funnel-triggered: Customer Contract & Commitment');
  assert.equal(gpu.funnels_flagged, '4 of 14');
  assert.equal(packet.planning_basis, 'Standard demand-driven planning');
  assert.equal(packet.funnels_flagged, '7 of 14');
});

test('figures check: a made-up quantity, date, SKU or spelled-out figure is caught', () => {
  const packet = buildPacket(verdict(P.eus));
  const ok = 'Order 4,032 CU of FAB-AMD-GENOA-96 for $1.25M. Capacity is needed by 28 Dec 2026; lead time is 20 weeks.';
  assert.deepEqual(verifyText(ok, packet), []);
  assert.deepEqual(verifyText('Order 4032 CU', packet), [], 'digits without a comma are the same figure');
  assert.match(verifyText('Order 5,000 CU', packet)[0], /figure "5000"/);
  assert.match(verifyText('Needed by 1 Jan 2027', packet)[0], /date "1 Jan 2027"/);
  assert.match(verifyText('Use FAB-AMD-GEN6-128', packet)[0], /SKU "FAB-AMD-GEN6-128"/);
  assert.deepEqual(verifyText('It takes twenty weeks; three tier-1 services depend on it.', packet), [], 'figures in words are fine when the plan says the same');
  assert.match(verifyText('It takes thirty-seven weeks', packet)[0], /figure "thirty-seven" \(37\) is not in the plan/);
  // Known limit: it checks that a figure exists SOMEWHERE in the plan (here 30 is from "30 Jun 2027"),
  // not that it is used in the right sentence. The docs say so.
  assert.deepEqual(verifyText('It takes thirty weeks', packet), []);
  assert.match(verifyText('It takes twenty-seven weeks', packet)[0], /figure "twenty-seven" \(27\)/);
  assert.deepEqual(verifyText('7 of fourteen funnels are flagged', packet), [], '14 really is in the plan');
  assert.match(verifyText('It costs two million', packet).join(' '), /"million" is a figure written in words/);
  assert.match(verifyText('It costs $1.5M', packet).join(' '), /figure "1.5"/);
  assert.deepEqual(verifyText('One planner should review this.', packet), [], 'the word "one" is ordinary prose');
});

// ------------------------------------------------------------------ the model call
test('not configured: no call is made and the rules text is returned with the reason', async () => {
  const ex = createExplainer({ config: aiConfig({}), fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(ex.status().configured, false);
  const r = await ex.explain(verdict(P.eus));
  assert.equal(r.source, 'rules');
  assert.equal(r.ai.status, 'off');
  assert.match(r.ai.message, /not configured/);
  assert.ok(r.text.summary);
});

test('configured: the request is well formed, carries the key only in the header, and a faithful answer is used', async () => {
  const stub = await stubAzure(faithful);
  try {
    const ex = createExplainer({ config: config(stub.url) });
    assert.deepEqual(ex.status(), { configured: true, mode: 'azure-openai', model: 'stub-gpt', host: stub.url.replace('http://', '') });
    assert.ok(!JSON.stringify(ex.status()).includes(KEY), 'status must never expose the key');
    const r = await ex.explain(verdict(P.eus));
    assert.equal(r.source, 'ai');
    assert.equal(r.ai.status, 'used');
    assert.match(r.text.summary, /^In plain words: Order 4,032 CU/);
    assert.match(r.text.request_body, /4,032 CU of FAB-AMD-GENOA-96/);

    const call = stub.seen[0];
    assert.equal(call.url, '/openai/deployments/stub-gpt/chat/completions?api-version=2024-10-21');
    assert.equal(call.headers['api-key'], KEY);
    assert.ok(!JSON.stringify(call.body).includes(KEY), 'the key must not be in the body');
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.equal(call.body.messages[0].content, SYSTEM);
    assert.match(call.body.messages[0].content, /Never round, convert, add up, recompute or invent a figure/);
    assert.match(call.body.messages[0].content, /Never suggest a different date, quantity or SKU/);
    assert.equal(packetOf(call).order.quantity, '4,032 CU');
  } finally { await stub.close(); }
});

test('an answer with a figure that is not in the plan is withheld, and the rules text is shown instead', async () => {
  const stub = await stubAzure((call) => {
    const p = packetOf(call);
    return wrap({ summary: `${p.headline} Consider ordering 5,000 CU instead.`, why_now: ['Demand is strong.'], risks: [], request_title: 'Request', request_body: 'Please order 5,000 CU by 1 Jan 2027.' });
  });
  try {
    const ex = createExplainer({ config: config(stub.url) });
    const r = await ex.explain(verdict(P.eus));
    assert.equal(r.source, 'rules');
    assert.equal(r.ai.status, 'withheld');
    assert.ok(r.ai.problems.some((x) => /5000/.test(x)));
    assert.ok(r.ai.problems.some((x) => /1 Jan 2027/.test(x)));
    assert.match(r.ai.message, /withheld/);
    assert.deepEqual(r.text, r.rules_text, 'what is shown is the rules text');
    assert.match(r.ai.withheld_text.summary, /5,000 CU/, 'the withheld text is kept for the engineering view');
  } finally { await stub.close(); }
});

test('every failure falls back to the rules text with a message a person can act on', async () => {
  const cases = [
    [{ status: 401, json: {} }, /key was rejected/],
    [{ status: 404, json: {} }, /deployment was not found/],
    [{ status: 429, json: {} }, /rate limiting/],
    [{ status: 500, json: {} }, /HTTP 500/],
    [{ json: { choices: [{ message: { content: 'not json at all' } }] } }, /valid JSON/],
    [{ json: { choices: [{ message: { content: JSON.stringify({ summary: 'only this' }) } }] } }, /missing a field/],
    [{ json: { choices: [] } }, /no content/],
  ];
  for (const [answer, re] of cases) {
    const stub = await stubAzure(() => answer);
    try {
      const r = await createExplainer({ config: config(stub.url) }).explain(verdict(P.eus));
      assert.equal(r.source, 'rules');
      assert.equal(r.ai.status, 'error');
      assert.match(r.ai.message, re);
      assert.ok(!r.ai.message.includes(KEY));
      assert.ok(r.text.summary);
    } finally { await stub.close(); }
  }
});

test('a slow model times out, and an unreachable one is reported, both without breaking the page', async () => {
  const slow = await stubAzure(() => new Promise((r) => setTimeout(() => r({ json: {} }), 400)));
  try {
    const r = await createExplainer({ config: config(slow.url), timeoutMs: 50 }).explain(verdict(P.eus));
    assert.equal(r.ai.status, 'error');
    assert.match(r.ai.message, /did not answer within/);
  } finally { await slow.close(); }
  const r2 = await createExplainer({ config: config('http://127.0.0.1:1') }).explain(verdict(P.eus));
  assert.equal(r2.ai.status, 'error');
  assert.match(r2.ai.message, /Could not reach Azure OpenAI/);
  assert.ok(r2.text.summary);
});

test('the same plan is answered from cache; refresh asks again; a changed plan is a new question', async () => {
  const stub = await stubAzure(faithful);
  try {
    const ex = createExplainer({ config: config(stub.url) });
    const a = await ex.explain(verdict(P.eus));
    const b = await ex.explain(verdict(P.eus));
    assert.equal(stub.seen.length, 1);
    assert.equal(b.ai.cached, true);
    assert.equal(a.packet_hash, b.packet_hash);
    await ex.explain(verdict(P.eus), { refresh: true });
    assert.equal(stub.seen.length, 2);
    await ex.explain(verdict(P.sea));
    assert.equal(stub.seen.length, 3);
    const changed = verdictOf(dataset((raw) => { raw.vendors.find((v) => v.vendor_id === 'vendor-northwind').observed_lead_weeks = [30, 31, 32]; }), P.eus);
    const c = await ex.explain(changed);
    assert.notEqual(c.packet_hash, a.packet_hash);
    assert.equal(stub.seen.length, 4);
  } finally { await stub.close(); }
});

test('a runaway loop of clicks is capped per minute and still gets rules text', async () => {
  const stub = await stubAzure(faithful);
  try {
    const ex = createExplainer({ config: config(stub.url), maxPerMinute: 2 });
    await ex.explain(verdict(P.eus), { refresh: true });
    await ex.explain(verdict(P.eus), { refresh: true });
    const third = await ex.explain(verdict(P.eus), { refresh: true });
    assert.equal(stub.seen.length, 2);
    assert.equal(third.ai.status, 'error');
    assert.match(third.ai.message, /Too many AI calls/);
    assert.ok(third.text.summary);
  } finally { await stub.close(); }
});

// ------------------------------------------------------------------ over HTTP
test('API: status and explain work with the model on, and without it', async () => {
  const stub = await stubAzure(faithful);
  const on = createApp({ store: freshStore(), webRoot: path.join(__dirname, '..', 'web'), explainer: createExplainer({ config: config(stub.url) }) });
  const off = createApp({ store: freshStore(), webRoot: path.join(__dirname, '..', 'web') });
  await Promise.all([on, off].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const call = async (server, method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };
  try {
    const s1 = await call(on, 'GET', '/api/ai/status');
    assert.equal(JSON.parse(s1.text).configured, true);
    assert.ok(!s1.text.includes(KEY), 'the API must never return the key');
    const e1 = await call(on, 'POST', `/api/pools/${P.eus}/explain`, {});
    assert.equal(e1.status, 200);
    assert.ok(!e1.text.includes(KEY));
    assert.equal(JSON.parse(e1.text).source, 'ai');
    assert.equal((await call(on, 'POST', '/api/pools/pool-nowhere/explain', {})).status, 404);

    const s2 = await call(off, 'GET', '/api/ai/status');
    assert.equal(JSON.parse(s2.text).configured, false);
    const e2 = JSON.parse((await call(off, 'POST', `/api/pools/${P.eus}/explain`, {})).text);
    assert.equal(e2.source, 'rules');
    assert.equal(e2.ai.status, 'off');
  } finally { await Promise.all([new Promise((r) => on.close(r)), new Promise((r) => off.close(r)), stub.close()]); }
});

test('explaining never changes the plan', async () => {
  const stub = await stubAzure(faithful);
  try {
    const store = freshStore();
    const before = JSON.stringify(store.verdicts());
    const ex = createExplainer({ config: config(stub.url) });
    for (const v of store.verdicts()) await ex.explain(v);
    assert.equal(JSON.stringify(store.verdicts()), before);
    assert.equal(store.state().decisions.length, 0);
  } finally { await stub.close(); }
});
