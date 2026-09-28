'use strict';
/*
 * "How much of this fits now, and what has to be ordered?" for the requests a
 * pool has waiting. Requests are served in need-by order from four sources:
 *   1. capacity that is free today (installed, usable, not reserved)
 *   2. capacity that could be reclaimed from idle reservations
 *   3. supply already in flight (counted only if it lands before the request is needed)
 *   4. a new order, which is what is left
 * The same arithmetic the planner uses, shown one request at a time.
 */

const { addWeeks, fmt, isDate } = require('./dates');
const { cu } = require('./format');
const { HttpError } = require('./store');
const { HORIZON_WEEKS } = require('./forecast');

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const SOURCES = ['onboarding-queue', 'sales-pipeline', 'growth-forecast'];
const ENVIRONMENTS = ['production', 'staging', 'development'];
const SLA_IMPACT = ['low', 'medium', 'high'];
const STRATEGIC = ['medium', 'high', 'critical'];

// Validate a request submitted through the API and turn it into a record.
function buildRequest(store, body) {
  const data = store.data();
  const err = (m) => { throw new HttpError(400, m); };
  if (!data.poolById[body.pool_id]) err('pool_id must be one of the pools in the estate.');
  const team = String(body.team || '').trim();
  const title = String(body.title || '').trim();
  if (team.length < 2 || team.length > 60) err('team must be 2 to 60 characters.');
  if (title.length < 3 || title.length > 80) err('title must be 3 to 80 characters.');
  const units = Number(body.cu);
  if (!Number.isInteger(units) || units < 1 || units > 100000) err('cu must be a whole number between 1 and 100,000.');
  if (!isDate(body.needed_by)) err('needed_by must be a date (YYYY-MM-DD).');
  if (body.needed_by < data.as_of) err(`needed_by cannot be before the dataset date ${data.as_of}.`);
  if (body.needed_by > addWeeks(data.as_of, HORIZON_WEEKS)) err('needed_by is beyond the 24-month planning window.');
  const priority = body.priority || 'medium';
  if (!['high', 'medium', 'low'].includes(priority)) err('priority must be high, medium or low.');
  const source = body.source || 'onboarding-queue';
  if (!SOURCES.includes(source)) err(`source must be one of ${SOURCES.join(', ')}.`);
  const win = body.win_probability == null || body.win_probability === '' ? 0.8 : Number(body.win_probability);
  if (!(win >= 0.05 && win <= 1)) err('win_probability must be between 0.05 and 1.');
  const record = {
    request_id: store.nextId('request'), team, title, pool_id: body.pool_id, cu: units, needed_by: body.needed_by,
    win_probability: win, source, priority, workload: String(body.workload || 'general').slice(0, 40), status: 'pending',
  };
  // What the requester says about the request. All optional; the Product Team view shows them as stated, never estimated.
  const said = (v) => v != null && v !== '';
  if (said(body.org)) {
    const org = String(body.org).trim();
    if (org.length < 2 || org.length > 40) err('org must be 2 to 40 characters.');
    record.org = org;
  }
  if (said(body.environment)) {
    if (!ENVIRONMENTS.includes(body.environment)) err(`environment must be one of ${ENVIRONMENTS.join(', ')}.`);
    record.environment = body.environment;
  }
  if (said(body.use_case)) {
    const text = String(body.use_case).trim();
    if (text.length > 400) err('use_case must be 400 characters or fewer.');
    record.use_case = text;
  }
  if (said(body.revenue_at_risk_usd)) {
    const usd = Number(body.revenue_at_risk_usd);
    if (!Number.isFinite(usd) || usd < 0 || usd > 1e10) err('revenue_at_risk_usd must be a number between 0 and 10,000,000,000.');
    record.revenue_at_risk_usd = Math.round(usd);
  }
  if (said(body.customer_commitment)) {
    const text = String(body.customer_commitment).trim();
    if (text.length > 120) err('customer_commitment must be 120 characters or fewer.');
    record.customer_commitment = text;
  }
  if (said(body.sla_impact)) {
    if (!SLA_IMPACT.includes(body.sla_impact)) err(`sla_impact must be one of ${SLA_IMPACT.join(', ')}.`);
    record.sla_impact = body.sla_impact;
  }
  if (said(body.strategic_importance)) {
    if (!STRATEGIC.includes(body.strategic_importance)) err(`strategic_importance must be one of ${STRATEGIC.join(', ')}.`);
    record.strategic_importance = body.strategic_importance;
  }
  record.submitted_on = data.as_of;
  return record;
}

function assessRequests(ctx, verdict) {
  let free = ctx.freeNow;
  let reclaim = verdict.reclaim.cu;
  const supply = ctx.inflight
    .map((s) => ({ order_id: s.order_id, lands_on: s.lands_on, left: s.cu * ctx.equiv(s) }))
    .sort((a, b) => a.lands_on.localeCompare(b.lands_on));
  const reclaimFrom = verdict.reclaim.from.join(', ');

  const ordered = [...ctx.requests].sort((a, b) => a.needed_by.localeCompare(b.needed_by) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  return ordered.map((r) => {
    let need = r.cu;
    const takeFree = Math.min(need, free); free -= takeFree; need -= takeFree;
    const takeReclaim = Math.min(need, reclaim); reclaim -= takeReclaim; need -= takeReclaim;
    let takeSupply = 0;
    const via = [];
    for (const s of supply) {
      if (need <= 0) break;
      if (s.lands_on > r.needed_by || s.left <= 0) continue;
      const t = Math.min(need, s.left);
      s.left -= t; need -= t; takeSupply += t; via.push(s.order_id);
    }
    const orderCu = need;
    const raiseBy = orderCu > 0 ? addWeeks(r.needed_by, -verdict.lead.weeks) : null;
    const parts = [];
    if (takeFree > 0) parts.push(`${cu(takeFree)} fits in free capacity today`);
    if (takeReclaim > 0) parts.push(`${cu(takeReclaim)} fits if reclaimed from ${reclaimFrom}`);
    if (takeSupply > 0) parts.push(`${cu(takeSupply)} fits once ${via.join(', ')} lands`);
    let planTiming = null;
    if (orderCu > 0) {
      if (verdict.order.needed && verdict.dates.lands_on) {
        planTiming = verdict.dates.lands_on <= r.needed_by ? 'in-time' : 'late';
        parts.push(`${cu(orderCu)} depends on the drafted order, which lands ${fmt(verdict.dates.lands_on)}, ${planTiming === 'in-time' ? 'in time for' : 'after'} the ${fmt(r.needed_by)} need date`);
      } else {
        parts.push(`${cu(orderCu)} needs a new order, placed by ${fmt(raiseBy)}${raiseBy < ctx.asOf ? ' (already past)' : ''}`);
      }
    }
    const fit = orderCu > 0 ? 'order' : takeSupply > 0 ? 'in-flight' : takeReclaim > 0 ? 'reclaim' : 'now';
    return {
      request_id: r.request_id, team: r.team, title: r.title, pool_id: r.pool_id, cu: r.cu, needed_by: r.needed_by,
      priority: r.priority, source: r.source, win_probability: r.win_probability, workload: r.workload,
      fit, plan_timing: planTiming, text: `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()),
      from_free: takeFree, from_reclaim: takeReclaim, from_in_flight: takeSupply, needs_order: orderCu, order_by: raiseBy,
    };
  });
}

module.exports = { assessRequests, buildRequest, SOURCES };
