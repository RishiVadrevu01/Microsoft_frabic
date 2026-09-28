'use strict';
/*
 * HTTP layer. node:http only: a small hand-written router, JSON in and out,
 * static files with a path-traversal guard. The browser holds no capacity
 * logic; everything it shows comes from these endpoints.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./lib/store');
const { summarize, brief, diffVerdicts } = require('./lib/summary');
const { poolDetail } = require('./lib/detail');
const { catalogue } = require('./lib/funnels');
const { assessRequests, buildRequest } = require('./lib/requests');
const { decide, verifyChain, stats } = require('./lib/decisions');
const { latestByPool } = require('./lib/ledger');
const { conversion } = require('./lib/conversion');
const { buildLab, checkLab } = require('./lib/lab');
const { createExplainer } = require('./lib/explain');
const { buildOverview, actionQueue, GEO, SKU_GROUPS, HORIZONS } = require('./lib/overview');
const { buildPlanning } = require('./lib/planning');
const { buildOntology } = require('./lib/ontology');
const { peakOverview } = require('./lib/peak');
const { buildRequester, orgKeyOf, orgLabelOf, HORIZONS: REQUESTER_HORIZONS } = require('./lib/requester');
const { buildOutcome } = require('./lib/outcome');
const { approvalCheck, budgetOf } = require('./lib/approval');
const { buildOptions } = require('./lib/options');
const { advisorFacts } = require('./lib/advisor');
const scenarios = require('./lib/scenarios');
const { buildActionSignals, buildSignalDetail } = require('./lib/signals');

const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// Bodies over MAX_BODY are discarded as they arrive and answered with 413 once the
// client has finished sending (so it can read the reply). A hard cap stops a client
// that never stops sending.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY * 16) { req.destroy(); return; }
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body is too large.')); return; }
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

const number = (v, name, min, max) => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}.`);
  return n;
};

// `explainer` is the optional plain-words writer (see lib/explain.js). Without one the
// lab uses rules-based text only, so nothing else depends on an AI service.
function createApp({ store, webRoot, explainer = createExplainer() }) {
  const poolLabel = (v) => `${v.region_label} · ${v.sku_id}`;

  // ------------------------------------------------------------------ handlers
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', () => {
    const data = store.data();
    return {
      status: 'ok', source: 'synthetic', dataset_version: data.meta.dataset_version, policy_version: data.policy.policy_version,
      as_of: data.as_of, pools: data.pools.length, funnels: catalogue().length, scenarios_applied: store.state().scenarios.length,
      decisions: store.state().decisions.length, advanced_weeks: store.state().advance.weeks, peak_profile: store.peak().available, node: process.version,
    };
  });

  route('GET', '/api/summary', () => ({
    ...summarize(store.verdicts(), store.data(), latestByPool(store.state().decisions)),
    action_count: actionQueue(store).counts.all,
  }));

  // The horizon, SKU group and region a planning page is filtered by, checked once for every route that takes them.
  const planningFilters = (query) => {
    const horizon = query.get('horizon') == null ? 52 : Number(query.get('horizon'));
    if (!HORIZONS.includes(horizon)) throw new HttpError(400, `horizon must be one of ${HORIZONS.join(', ')} (weeks).`);
    const sku = query.get('sku') || 'all';
    if (!(sku in SKU_GROUPS)) throw new HttpError(400, `sku must be one of ${Object.keys(SKU_GROUPS).join(', ')}.`);
    const region = query.get('region') || 'all';
    if (region !== 'all' && !(region in GEO)) throw new HttpError(400, `region must be all or one of ${Object.keys(GEO).join(', ')}.`);
    return { horizon, sku, region };
  };

  // The Infrastructure Capacity Overview (the balance and its decisions), one call for the whole screen.
  route('GET', '/api/overview', ({ query }) => buildOverview(store, planningFilters(query)));

  // PLANNING: supply and demand as two views of one plan, and the balance between them (server/lib/planning.js).
  route('GET', '/api/planning', ({ query }) => buildPlanning(store, planningFilters(query)));

  // Every action a planner has to take, ranked. Optional ?category=procurement|allocation|other.
  route('GET', '/api/actions', ({ query }) => {
    const category = query.get('category');
    if (category && !['procurement', 'allocation', 'other'].includes(category)) throw new HttpError(400, 'category must be procurement, allocation or other.');
    const q = actionQueue(store);
    return { ...q, items: category ? q.items.filter((i) => i.category === category) : q.items };
  });

  // Action Queue Signals: dynamic calculations from pool models for each signal
  route('GET', '/api/action-signals', () => buildActionSignals(store));
  route('GET', '/api/action-signals/:id', ({ params }) => buildSignalDetail(store, params.id));

  // The Product Team (Requester) view: one requester's requests and, for the selected one, what can be served,
  // when, at what cost and what to do about the rest. ?org=&request=&region=&horizon=13|26|52
  route('GET', '/api/requester', ({ query }) => {
    const horizon = query.get('horizon') == null ? 52 : Number(query.get('horizon'));
    if (!REQUESTER_HORIZONS.includes(horizon)) throw new HttpError(400, `horizon must be one of ${REQUESTER_HORIZONS.join(', ')} (weeks).`);
    return buildRequester(store, { org: query.get('org') || undefined, request: query.get('request') || undefined, region: query.get('region') || 'all', horizon });
  });

  // The seven ontology layers, with each layer's live value for every pool.
  route('GET', '/api/ontology', () => buildOntology(store));

  // The peak check: each pool's plan against its busiest hour, not just its weekly mean. Optional (needs the
  // peak profile from `npm run ml`); without it this says why it is unavailable and nothing else changes.
  route('GET', '/api/peak', () => {
    const p = store.peak();
    if (!p.available) return { available: false, reason: p.reason };
    return { ...peakOverview(store, store.all()), as_of: p.as_of, generated_from: p.generated_from, pools: [...p.pools.values()] };
  });

  route('GET', '/api/pools', () => store.verdicts().map(brief));

  route('GET', '/api/pools/:id', ({ params }) => poolDetail(store, params.id));

  // The unified planning timeline for one pool: demand and capacity week by week, and the rules the plan was built with.
  route('GET', '/api/pools/:id/timeline', ({ params }) => store.assessment(params.id).ctx.timeline());

  route('POST', '/api/recompute', ({ body }) => {
    const overrides = {
      growth_pts_per_week: number(body.growth_pts_per_week, 'growth_pts_per_week', -5, 10),
      lead_time_weeks: number(body.lead_time_weeks, 'lead_time_weeks', 1, 104),
      floor_pct: number(body.floor_pct, 'floor_pct', 0.3, 0.99),
      conversion_factor: number(body.conversion_factor, 'conversion_factor', 0.5, 5),
    };
    for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete overrides[k];
    const base = store.assessment(body.pool_id).verdict;
    const alt = store.whatIf(body.pool_id, overrides).verdict;
    return { pool_id: body.pool_id, overrides, baseline: brief(base), whatif: brief(alt), diff: diffVerdicts(base, alt), components: alt.order.components, lead: alt.lead, dates: alt.dates };
  });

  route('GET', '/api/funnels', () => {
    const all = store.all();
    const cat = catalogue();
    const feedCtx = all[0].ctx;
    return {
      pools: all.map((a) => ({ pool_id: a.verdict.pool_id, label: poolLabel(a.verdict), state: a.verdict.state })),
      funnels: cat.map((c) => ({
        ...c,
        pools: all.map((a) => {
          const t = a.verdict.trace.find((x) => x.number === c.number);
          return { pool_id: a.verdict.pool_id, status: t.status, severity: t.severity, context_only: t.context_only, headline: t.headline, effects: t.effects };
        }),
      })),
      feeds: store.data().feeds.map((f) => feedCtx.feedStatus(f.feed_id)),
    };
  });

  route('GET', '/api/lifecycle', () => {
    const data = store.data();
    const pools = store.all();
    return {
      skus: data.skus.map((s) => ({
        ...s,
        pools: data.pools.filter((p) => p.sku_id === s.sku_id).map((p) => p.pool_id),
        vendor: data.vendorById[s.vendor_id].name,
      })),
      pools: pools.map((a) => ({ pool_id: a.verdict.pool_id, label: poolLabel(a.verdict), sku_id: a.verdict.sku_id, order_sku: a.verdict.what.order_sku, factor: a.verdict.what.factor, lifecycle: a.verdict.what.lifecycle })),
    };
  });

  route('POST', '/api/conversion', ({ body }) => conversion(store, body));

  route('GET', '/api/requests', () => {
    const rows = [];
    for (const a of store.all()) {
      for (const r of assessRequests(a.ctx, a.verdict)) rows.push({ ...r, pool_label: poolLabel(a.verdict) });
    }
    rows.sort((x, y) => x.needed_by.localeCompare(y.needed_by));
    return { requests: rows, pools: store.verdicts().map((v) => ({ pool_id: v.pool_id, label: poolLabel(v) })) };
  });

  route('POST', '/api/requests', ({ body }) => {
    const req = buildRequest(store, body);
    const { before, after } = store.addRequest(req);
    const b = before.find((v) => v.pool_id === req.pool_id);
    const a = after.find((v) => v.pool_id === req.pool_id);
    const assessment = assessRequests(store.assessment(req.pool_id).ctx, a).find((r) => r.request_id === req.request_id);
    // `requester` says which organisation the request was filed under, so a screen can open it in the Product Team view.
    return { request: req, assessment, what_changed: diffVerdicts(b, a), pool_id: req.pool_id, requester: { org: orgKeyOf(req), label: orgLabelOf(req) } };
  });

  route('POST', '/api/pools/:id/decision', ({ params, body }) => {
    const { record, order } = decide(store, params.id, body);
    return { record, order, verdict: brief(store.assessment(params.id).verdict) };
  });

  route('GET', '/api/decisions', () => {
    const records = store.state().decisions;
    return { records: records.slice().reverse(), stats: stats(records), chain: verifyChain(records), budget: budgetOf(store) };
  });

  // The planner: the executable options for this pool's open order, each measured by re-running the plan, and the rule that recommends one.
  route('GET', '/api/pools/:id/options', ({ params }) => buildOptions(store, params.id));

  // What approving this pool's order (at this quantity) would need: the budget, and whether a second person must countersign.
  route('GET', '/api/pools/:id/approval', ({ params, query }) => approvalCheck(store, params.id, query.get('quantity_cu')));

  route('GET', '/api/policy', () => store.data().policy);

  // Plain-words explanation of a pool's plan. Read-only: it never changes the plan.
  route('GET', '/api/ai/status', () => explainer.status());
  // The advisor is also given what changed, the options, the approval rules and the ranking (advisor.js): facts to copy, never things to decide.
  route('POST', '/api/pools/:id/explain', async ({ params, body }) => explainer.explain(store.assessment(params.id).verdict, { refresh: body.refresh === true, facts: advisorFacts(store, params.id) }));

  route('GET', '/api/lab', () => buildLab(store));
  route('POST', '/api/lab/check/:id', ({ params, body }) => checkLab(store, params.id, body));
  route('POST', '/api/lab/scenarios/:id/apply', ({ params }) => {
    const s = scenarios.list().find((x) => x.id === params.id);
    const { before, after } = store.applyScenario(params.id);
    const changes = after.map((v) => {
      const b = before.find((x) => x.pool_id === v.pool_id);
      return { pool_id: v.pool_id, label: poolLabel(v), rows: diffVerdicts(b, v), changed: diffVerdicts(b, v).some((r) => r.changed) };
    });
    return { scenario: s, focus: s.pool_id, changes };
  });
  // OUTCOME and FEEDBACK: move the lab's "today" forward, then set what was generated against what was predicted and planned.
  route('GET', '/api/outcome', () => buildOutcome(store));
  route('POST', '/api/lab/advance', ({ body }) => {
    const was = store.data().as_of;
    const { before, after, clock } = store.advanceTime(body.weeks);
    const changes = after.map((v) => {
      const b = before.find((x) => x.pool_id === v.pool_id);
      return { pool_id: v.pool_id, label: poolLabel(v), rows: diffVerdicts(b, v), changed: diffVerdicts(b, v).some((r) => r.changed) };
    });
    // the requests, contracts and events that fell due in THIS advance (clock is the whole replay from the shipped date)
    const fellDue = clock.dated.filter((d) => d.in_effect_on > was);
    return { advanced: Number(body.weeks), from: clock.from, to: clock.to, arrivals: clock.arrivals, slips: clock.slips, fell_due: fellDue, changes, outcome: buildOutcome(store) };
  });
  route('POST', '/api/lab/reset', ({ body }) => { store.reset({ progress: Boolean(body.progress) }); return { ok: true, summary: store.state().scenarios }; });

  // ------------------------------------------------------------------ static files
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(webRoot, `.${decodeURIComponent(rel)}`);
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Method not allowed'); return; }
        serveStatic(req, res, url.pathname);
        return;
      }
      const match = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).find((x) => x.m && x.r.method === req.method);
      if (!match) {
        const pathKnown = routes.some((r) => r.re.test(url.pathname));
        send(res, pathKnown ? 405 : 404, { error: pathKnown ? 'Method not allowed' : `No such endpoint: ${url.pathname}` });
        return;
      }
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m[i + 1])]));
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await match.r.handler({ params, body, query: url.searchParams }));
    } catch (err) {
      if (err instanceof HttpError) { send(res, err.status, { error: err.message }); return; }
      console.error(err);
      send(res, 500, { error: 'Internal error while computing the plan.' });
    }
  });

  return server;
}

module.exports = { createApp };
