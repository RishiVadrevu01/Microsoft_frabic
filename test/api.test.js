'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../server/app');
const { P, freshStore } = require('./helpers');

const WEB = path.join(__dirname, '..', 'web');

async function withServer(fn) {
  const store = freshStore();
  const server = createApp({ store, webRoot: WEB });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, raw) => {
    const res = await fetch(base + url, {
      method, headers: body || raw ? { 'Content-Type': 'application/json' } : {}, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  try { await fn({ call, store }); } finally { await new Promise((r) => server.close(r)); }
}

test('health reports a synthetic dataset and the counts', () => withServer(async ({ call }) => {
  const { status, json } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.source, 'synthetic');
  assert.equal(json.pools, 6);
  assert.equal(json.funnels, 14);
  assert.equal(json.as_of, '2026-09-21');
}));

test('summary answers the 3/6/12 month question and ranks the actions', () => withServer(async ({ call }) => {
  const { json } = await call('GET', '/api/summary');
  assert.equal(json.source, 'synthetic');
  assert.equal(json.horizons.length, 3);
  assert.equal(json.actions[0].pool_id, P.eus);
  assert.match(json.headline, /^No\./);
  assert.equal(json.kpis.open_actions, 5);
}));

test('pool detail carries the chart, the trace of all 14 funnels and the order arithmetic', () => withServer(async ({ call }) => {
  const { status, json } = await call('GET', `/api/pools/${P.eus}`);
  assert.equal(status, 200);
  assert.equal(json.verdict.trace.length, 14);
  assert.equal(json.chart.p50.length, 53);
  assert.equal(json.chart.history.length, 52);
  assert.ok(json.chart.markers.some((m) => m.kind === 'raise'));
  assert.ok(json.verdict.order.components.length > 5);
  assert.equal(json.lifecycle.order_sku, 'FAB-AMD-GENOA-96');
}));

test('the planning timeline is one call per pool: 105 weekly rows, the rules, and the forecast it was built on', () => withServer(async ({ call }) => {
  const { status, json } = await call('GET', `/api/pools/${P.eus}/timeline`);
  assert.equal(status, 200);
  assert.equal(json.contract, 'planning-timeline/1');
  assert.equal(json.pool_id, P.eus);
  assert.equal(json.points.length, 105);
  assert.equal(json.points[0].date, '2026-09-21');
  assert.equal(json.forecast.contract, 'forecast/1');
  assert.match(json.forecast.input_hash, /^[0-9a-f]{16}$/);
  const detail = await call('GET', `/api/pools/${P.eus}`);
  assert.equal(detail.json.verdict.forecast.input_hash, json.forecast.input_hash, 'the plan and the timeline name the same forecast');
  assert.equal((await call('GET', '/api/pools/pool-nowhere/timeline')).status, 404);
}));

test('advancing the lab over HTTP: the outcome before and after, the limits, and reset', () => withServer(async ({ call }) => {
  const before = await call('GET', '/api/outcome');
  assert.equal(before.status, 200);
  assert.equal(before.json.advanced_weeks, 0);
  assert.equal(before.json.summary, null);
  assert.equal(before.json.limit.max_weeks, 26);
  assert.equal((await call('GET', '/api/health')).json.advanced_weeks, 0);

  for (const bad of [{}, { weeks: 0 }, { weeks: 2.5 }, { weeks: 'x' }]) assert.equal((await call('POST', '/api/lab/advance', bad)).status, 400, JSON.stringify(bad));
  const tooFar = await call('POST', '/api/lab/advance', { weeks: 27 });
  assert.equal(tooFar.status, 409);
  assert.match(tooFar.json.error, /at most \(26 in all\)/);

  const ok = await call('POST', '/api/lab/advance', { weeks: 8 });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.advanced, ok.json.from, ok.json.to], [8, '2026-09-21', '2026-11-16']);
  assert.deepEqual(ok.json.arrivals.map((a) => a.order_id), ['ORD-2026-0440']);
  assert.deepEqual(ok.json.slips.map((a) => a.order_id), ['ORD-2026-0412']);
  assert.ok(ok.json.changes.some((c) => c.changed), 'some plan moved');
  assert.equal(ok.json.outcome.advanced_weeks, 8);
  assert.equal(ok.json.outcome.pools.length, 6);
  assert.equal(ok.json.outcome.summary.readings, 48);

  const health = await call('GET', '/api/health');
  assert.equal(health.json.advanced_weeks, 8);
  assert.equal(health.json.as_of, '2026-11-16');
  assert.equal((await call('GET', '/api/peak')).json.available, false, 'the busiest-hour check steps aside');
  assert.equal((await call('GET', `/api/pools/${P.eus}/timeline`)).json.as_of, '2026-11-16', 'the planning timeline is as of the new today');

  const reset = await call('POST', '/api/lab/reset', {});
  assert.equal(reset.status, 200);
  assert.equal((await call('GET', '/api/health')).json.as_of, '2026-09-21');
  assert.equal((await call('GET', '/api/outcome')).json.advanced_weeks, 0);
}));

test('unknown pool and unknown endpoint are clean JSON errors', () => withServer(async ({ call }) => {
  const a = await call('GET', '/api/pools/pool-nowhere');
  assert.equal(a.status, 404);
  assert.match(a.json.error, /Unknown pool/);
  const b = await call('GET', '/api/nothing');
  assert.equal(b.status, 404);
  const c = await call('DELETE', '/api/summary');
  assert.equal(c.status, 405);
}));

test('recompute is a what-if: it returns before and after and changes nothing', () => withServer(async ({ call }) => {
  const { status, json } = await call('POST', '/api/recompute', { pool_id: P.eus, lead_time_weeks: 8 });
  assert.equal(status, 200);
  assert.equal(json.baseline.state, 'OVERDUE');
  assert.equal(json.whatif.state, 'PLAN');
  assert.ok(json.diff.some((r) => r.label === 'State' && r.changed));
  const again = await call('GET', '/api/summary');
  assert.equal(again.json.actions[0].state, 'OVERDUE');
}));

test('recompute rejects values outside the sane range', () => withServer(async ({ call }) => {
  for (const body of [{ lead_time_weeks: 0 }, { lead_time_weeks: 500 }, { growth_pts_per_week: 99 }, { floor_pct: 2 }, { conversion_factor: 'x' }]) {
    const r = await call('POST', '/api/recompute', { pool_id: P.eus, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
}));

test('funnels endpoint returns the 14x6 matrix, the requirement text of each funnel, and the feed health', () => withServer(async ({ call }) => {
  const { json } = await call('GET', '/api/funnels');
  assert.equal(json.funnels.length, 14);
  assert.equal(json.pools.length, 6);
  assert.ok(json.funnels.every((f) => f.pools.length === 6));
  assert.equal(json.funnels.filter((f) => f.standard).length, 2);
  assert.ok(json.funnels.every((f) => f.detects && f.primary_sources && f.accelerates));
  assert.equal(json.groups, undefined, 'the extension grouping is gone');
  assert.equal(json.feeds.length, 13);
  assert.ok(json.feeds.some((f) => f.stale));
  assert.equal((await call('GET', '/api/signals')).status, 404, 'the old route is gone');
}));

test('lifecycle endpoint lists the SKU chain with equivalence factors', () => withServer(async ({ call }) => {
  const { json } = await call('GET', '/api/lifecycle');
  const icx = json.skus.find((s) => s.sku_id === 'FAB-INTEL-ICX-64');
  assert.equal(icx.status, 'eol');
  assert.equal(icx.replaced_by_sku, 'FAB-AMD-GENOA-96');
  assert.deepEqual(icx.pools, [P.eus]);
}));

test('conversion endpoint returns pre and post headroom', () => withServer(async ({ call }) => {
  const { status, json } = await call('POST', '/api/conversion', { pool_id: P.eus, ratio: 1.35, swap_units: 1920 });
  assert.equal(status, 200);
  assert.ok(json.post.usable > json.pre.usable);
  const bad = await call('POST', '/api/conversion', { pool_id: P.weuGpu });
  assert.equal(bad.status, 400);
}));

test('submit a request end to end: validation, then assessment and a what-changed card', () => withServer(async ({ call }) => {
  const bad = await call('POST', '/api/requests', { pool_id: P.eus, team: 'x', title: 'y', cu: 5, needed_by: '2027-01-01' });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/requests', { pool_id: P.weuAmd, team: 'contoso-test', title: 'Warehouse scale-out', cu: 9000, needed_by: '2026-12-01', priority: 'high' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.request.status, 'pending');
  assert.ok(ok.json.what_changed.some((r) => r.label === 'State' && r.changed));
  const list = await call('GET', '/api/requests');
  assert.ok(list.json.requests.some((r) => r.request_id === ok.json.request.request_id));
}));

test('the requester view over HTTP: defaults, filters, horizons and refusals', () => withServer(async ({ call }) => {
  const a = await call('GET', '/api/requester');
  assert.equal(a.status, 200);
  assert.equal(a.json.view, 'requester');
  assert.equal(a.json.source, 'synthetic');
  assert.equal(a.json.filters.org, 'contoso');
  assert.equal(a.json.selected.request_id, 'REQ-1004');
  assert.equal(a.json.forecast.points.length, 13);
  assert.equal(a.json.kpis.additional_required.cu, 93);

  const b = await call('GET', '/api/requester?org=northwind&horizon=13');
  assert.equal(b.status, 200);
  assert.equal(b.json.requester.label, 'Northwind');
  assert.equal(b.json.forecast.points.length, 4);

  const c = await call('GET', '/api/requester?org=contoso&request=REQ-0801&region=north-america');
  assert.equal(c.json.selected.status, 'completed');

  for (const [q, re] of [['org=nobody', /org must be one of/], ['request=REQ-9', /request must be one of/], ['region=mars', /region must be all or one of/], ['horizon=7', /horizon must be one of 13, 26, 52/]]) {
    const bad = await call('GET', `/api/requester?${q}`);
    assert.equal(bad.status, 400, q);
    assert.match(bad.json.error, re, q);
  }
}));

test('a request submitted with business context shows up in the requester view, and the same fields are refused when wrong', () => withServer(async ({ call }) => {
  const body = {
    pool_id: P.weuAmd, team: 'fabrikam-bi', title: 'BI refresh', cu: 300, needed_by: '2026-12-15',
    org: 'Fabrikam', environment: 'production', use_case: 'Nightly finance models.', revenue_at_risk_usd: 900000, sla_impact: 'high', strategic_importance: 'critical',
  };
  const bad = await call('POST', '/api/requests', { ...body, sla_impact: 'extreme' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /sla_impact must be one of/);
  const ok = await call('POST', '/api/requests', body);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.request.org, 'Fabrikam');
  assert.equal(ok.json.request.submitted_on, '2026-09-21');
  assert.deepEqual(ok.json.requester, { org: 'fabrikam', label: 'Fabrikam' }, 'the response says which organisation it was filed under');
  const unnamed = await call('POST', '/api/requests', { pool_id: P.weuAmd, team: 'tailspin-ops', title: 'Ops tooling', cu: 50, needed_by: '2026-12-01' });
  assert.deepEqual(unnamed.json.requester, { org: 'tailspin', label: 'Tailspin' }, 'with no organisation it is the first word of the team');
  const v = await call('GET', '/api/requester?org=fabrikam');
  assert.equal(v.json.selected.request_id, ok.json.request.request_id);
  assert.equal(v.json.kpis.business_impact.usd, 900000);
  assert.equal(v.json.business_impact.rows.find((r) => r.key === 'strategic').value, 'Critical');
}));

test('a decision over HTTP: refusals carry a reason, then approval places the order', () => withServer(async ({ call }) => {
  const url = `/api/pools/${P.eus}/decision`;
  const noName = await call('POST', url, { decision: 'approve' });
  assert.equal(noName.status, 400);
  const engine = await call('POST', url, { decision: 'approve', decided_by: 'engine' });
  assert.equal(engine.status, 400);
  assert.match(engine.json.error, /cannot approve/);
  const ok = await call('POST', url, { decision: 'approve', decided_by: 'Asha Rao' });
  assert.equal(ok.status, 200);
  assert.match(ok.json.order.order_id, /^ORD-LAB-/);
  const log = await call('GET', '/api/decisions');
  assert.equal(log.json.records.length, 1);
  assert.equal(log.json.chain.ok, true);
  assert.equal(log.json.stats.approved, 1);
  const summary = await call('GET', '/api/summary');
  assert.equal(summary.json.actions.find((a) => a.pool_id === P.eus).decision.decided_by, 'Asha Rao');
}));

test('lab flow: apply a scenario, see what changed, check the exercise, reset', () => withServer(async ({ call }) => {
  const applied = await call('POST', '/api/lab/scenarios/quota-surge-eastus/apply');
  assert.equal(applied.status, 200);
  assert.equal(applied.json.focus, P.eus);
  const focus = applied.json.changes.find((c) => c.pool_id === P.eus);
  assert.ok(focus.changed);
  assert.ok(focus.rows.some((r) => r.label === 'Order' && r.changed));
  const again = await call('POST', '/api/lab/scenarios/quota-surge-eastus/apply');
  assert.equal(again.status, 409);
  const check = await call('POST', '/api/lab/check/lab-4', {});
  assert.equal(check.json.passed, true);
  const lab = await call('GET', '/api/lab');
  assert.equal(lab.json.progress.done, 1);
  assert.ok(lab.json.scenarios.find((s) => s.id === 'quota-surge-eastus').applied);
  const reset = await call('POST', '/api/lab/reset', {});
  assert.equal(reset.status, 200);
  const s = await call('GET', '/api/summary');
  assert.equal(s.json.kpis.open_actions, 5);
}));

test('the browser gets the page and its assets; a path outside web/ does not leak', () => withServer(async ({ call }) => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  for (const p of ['/app/styles.css', '/app/app.js', '/vendor/angular.min.js']) assert.equal((await call('GET', p)).status, 200, p);
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/server/index.js', '/app/../../package.json']) {
    const r = await call('GET', p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!/fabric-capacity-poc-lab/.test(r.text) || r.status !== 200, p);
  }
}));

test('malformed and oversized bodies are refused cleanly', () => withServer(async ({ call }) => {
  const bad = await call('POST', '/api/recompute', undefined, '{not json');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /valid JSON/);
  const big = await call('POST', '/api/recompute', undefined, JSON.stringify({ pool_id: P.eus, pad: 'x'.repeat(70 * 1024) }));
  assert.equal(big.status, 413);
}));
