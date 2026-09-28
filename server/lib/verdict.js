'use strict';
/*
 * Composition: 14 independent funnels' proposals become ONE decision per pool.
 * One rule per dimension, so every number can be explained in a sentence:
 *
 *   when      the EARLIEST need-by date any funnel proposes, minus the lead time
 *   lead time the vendor's quote, replaced by what it really delivers, plus risk buffers
 *   how much  demand at the end of the cover window / floor, less capacity that will
 *             exist by then (installed + in flight), plus replacements,
 *             plus a buffer, rounded up to whole racks and the vendor minimum
 *   what      the order SKU: a successor if the pool's SKU is end-of-life
 *   priority  the most severe funnel that drives an action
 *
 * Nothing here is a model. It is arithmetic over the proposals, so the same data
 * always gives the same plan.
 */

const { addWeeks, daysBetween, fmt } = require('./dates');
const { cu, pct, num } = require('./format');
const { runFunnels, SEV_RANK } = require('./funnels');
const { buildContext, HORIZON_WEEKS } = require('./context');
const { isKnownKind } = require('./contracts');
const { sizingDemand, coverageDemand } = require('./timeline');
const { describe: describeShifts } = require('./shifts');

const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];
const maxSev = (a, b) => (SEV_RANK[a] >= SEV_RANK[b] ? a : b);
const bump = (s) => SEVERITIES[Math.min(SEVERITIES.length - 1, SEVERITIES.indexOf(s) + 1)];
const earliest = (items, key) => items.reduce((best, x) => (!best || x[key] < best[key] || (x[key] === best[key] && x.funnel_number < best.funnel_number) ? x : best), null);
const HORIZON_LABELS = { 13: '3 months', 26: '6 months', 52: '12 months' };

function compose(ctx, results) {
  const P = ctx.policy;
  const props = [];
  for (const r of results) {
    for (const p of r.proposals) {
      // runFunnels() has already refused anything outside the contract; this is for a caller that hands compose results directly.
      if (!isKnownKind(p.kind)) throw new Error(`Funnel ${r.number} proposed "${p.kind}", which is not part of the funnel-to-plan contract (docs/CONTRACTS.md).`);
      props.push({ ...p, funnel: r.id, funnel_name: r.name, funnel_number: r.number });
    }
  }
  const flagged = results.filter((r) => r.flagged);

  // ---- lead time
  const vendor = ctx.vendor;
  const base = vendor ? vendor.quoted_lead_weeks : P.lead_time.default_weeks;
  const sets = props.filter((p) => p.kind === 'lead' && p.mode === 'set');
  const adds = props.filter((p) => p.kind === 'lead' && p.mode === 'add');
  const setMax = sets.reduce((m, p) => (p.weeks > m.weeks ? p : m), { weeks: base, funnel_name: null });
  let lead = Math.max(base, setMax.weeks);
  let leadBreakdown = [{
    label: setMax.funnel_name ? `${setMax.funnel_name}: ${setMax.note}` : `vendor quote (${vendor ? vendor.name : 'default'})`,
    weeks: lead, funnel: setMax.funnel || null,
  }];
  for (const a of adds) { lead += a.weeks; leadBreakdown.push({ label: `${a.funnel_name}: ${a.note}`, weeks: a.weeks, funnel: a.funnel }); }
  if (Number.isFinite(ctx.overrides.lead_time_weeks)) {
    lead = ctx.overrides.lead_time_weeks;
    leadBreakdown = [{ label: 'Lead time set by hand (what-if)', weeks: lead, funnel: null }];
  }

  // ---- dates
  const needCandidates = props.filter((p) => (p.kind === 'capacity' || p.kind === 'replace') && p.needed_by);
  const neededPick = earliest(needCandidates, 'needed_by');
  const neededBy = neededPick ? neededPick.needed_by : null;
  const mandatoryPick = earliest(props.filter((p) => p.kind === 'deadline'), 'by');

  // ---- sizing
  // How many weeks past landing an order should cover. Policy sets it; an override lets the planner ask "what if I ordered for less now"
  // (options.js), and is never set unless asked.
  const coverWeeks = Number.isFinite(ctx.overrides.cover_weeks) && ctx.overrides.cover_weeks > 0 ? ctx.overrides.cover_weeks : P.cover_weeks;
  const floorEff = Math.min(ctx.floor, ...props.filter((p) => p.kind === 'floor').map((p) => p.floor_pct));
  const target = ctx.orderSku;
  const factor = ctx.factor;
  const replaceUnits = props.filter((p) => p.kind === 'replace').reduce((a, p) => a + p.cu, 0);

  function size(raiseDate) {
    const landsOn = addWeeks(raiseDate, lead);
    const hLand = ctx.hOf(landsOn);
    const coverEnd = Math.min(hLand + coverWeeks, HORIZON_WEEKS);
    // The demand an order is sized for: the rule (and how it differs from the fleet views' demand) is in timeline.js.
    const { organic, pipe, hard, temp, hardTotal, tempTotal, totalDemand } = sizingDemand(ctx, props, coverEnd);
    const required = totalDemand / floorEff;
    const have = ctx.usableAt(coverEnd);
    const shortfall = neededBy ? Math.max(0, required - have) : 0;
    const needUnits = neededBy ? shortfall + replaceUnits : 0;
    const targetUnits = needUnits / factor;
    let qty = 0;
    if (needUnits > 0) {
      qty = Math.ceil((targetUnits * (1 + P.buffer_pct)) / target.order_unit_cu) * target.order_unit_cu;
      qty = Math.max(qty, target.vendor_min_cu);
    }
    return { landsOn, hLand, coverEnd, organic, pipe, hard, temp, hardTotal, tempTotal, totalDemand, required, have, shortfall, needUnits, targetUnits, qty };
  }

  const raiseBy = neededBy ? addWeeks(neededBy, -lead) : null;
  const raiseDate = raiseBy && raiseBy > ctx.asOf ? raiseBy : ctx.asOf;
  const sized = size(raiseDate);
  const orderEq = sized.qty * factor;
  const cost = sized.qty * target.unit_cost_usd;
  const hasOrder = sized.qty > 0;

  // ---- covered until
  let coveredUntil = null;
  if (hasOrder) {
    // Counted from the day the order lands: any shortfall before that is reported as short_weeks.
    for (let h = sized.hLand; h <= HORIZON_WEEKS; h++) {
      if (coverageDemand(ctx, props, h) >= floorEff * (ctx.usableAt(h) + orderEq)) { coveredUntil = ctx.dateOf(h); break; }
    }
  }

  // ---- state
  const raiseDays = raiseBy ? daysBetween(ctx.asOf, raiseBy) : null;
  // With nothing to order, a pool is still on WATCH if something dated or a priority flag is on its calendar.
  const dated = props.some((p) => ['capacity', 'deadline', 'replace', 'priority'].includes(p.kind));
  let state;
  if (hasOrder) {
    if (raiseDays < 0) state = 'OVERDUE';
    else if (raiseDays <= P.due_soon_weeks * 7) state = 'ORDER NOW';
    else if (raiseDays <= P.plan_weeks * 7) state = 'PLAN';
    else state = 'WATCH';
  } else {
    state = dated ? 'WATCH' : 'OK';
  }

  // ---- priority
  let sev = 'none';
  for (const r of flagged) {
    if (!r.context_only && r.proposals.some((p) => ['capacity', 'replace', 'deadline', 'priority'].includes(p.kind))) sev = maxSev(sev, r.severity);
  }
  if (state === 'OVERDUE') sev = maxSev(sev, 'high');
  if (state === 'ORDER NOW') sev = maxSev(sev, 'medium');
  if (props.some((p) => p.kind === 'priority') && SEV_RANK[sev] >= SEV_RANK.low) sev = bump(sev);
  const priority = sev === 'none' ? 'low' : sev;

  // ---- horizons: "are we good for 3, 6, 12 months?"
  const shortDate = hasOrder ? neededBy : null;
  const horizons = P.horizons_weeks.map((w) => {
    const end = addWeeks(ctx.asOf, w);
    let status = 'good';
    if (shortDate && shortDate <= end) status = 'at-risk';
    else if (hasOrder && raiseBy && raiseBy <= end) status = 'act';
    else if (mandatoryPick && mandatoryPick.by <= end) status = 'act';
    return { weeks: w, label: HORIZON_LABELS[w] || `${w} weeks`, status };
  });

  // ---- reclaim
  const reclaimP = props.find((p) => p.kind === 'reclaim');
  const reclaim = { cu: reclaimP ? reclaimP.cu : 0, value_usd: reclaimP ? reclaimP.value_usd : 0, from: reclaimP ? reclaimP.from : [] };

  // ---- the why-now trace: what each funnel did to the plan
  const effects = {};
  const say = (id, text) => { (effects[id] = effects[id] || []).push(text); };
  for (const p of props) {
    if ((p.kind === 'capacity' || p.kind === 'replace') && p.needed_by) {
      say(p.funnel, p === neededPick ? `Sets the need-by date (${fmt(p.needed_by)}), the earliest of all funnels.` : `Needs capacity by ${fmt(p.needed_by)} (a later date than the one driving the plan).`);
    } else if (p.kind === 'deadline') say(p.funnel, `Mandatory: migration must start by ${fmt(p.by)}.`);
    else if (p.kind === 'lead') say(p.funnel, p.mode === 'set' ? `Sets lead time to ${p.weeks} weeks.` : `Adds ${p.weeks} weeks of lead-time cover.`);
    else if (p.kind === 'add_demand') say(p.funnel, `Adds ${cu(p.cu)} of ${p.temporary ? 'temporary ' : ''}demand from ${fmt(p.at)}.`);
    else if (p.kind === 'floor') say(p.funnel, `Lowers the working ceiling to ${pct(p.floor_pct)}.`);
    else if (p.kind === 'reclaim') say(p.funnel, `Frees up to ${cu(p.cu)} without buying anything.`);
    else if (p.kind === 'priority') say(p.funnel, 'Raises the priority of the action.');
    else if (p.kind === 'retire') say(p.funnel, `Suggests retiring this SKU for ${p.to_sku}.`);
    else if (p.kind === 'mix_shift' || p.kind === 'what_hint') say(p.funnel, p.note ? `Advises: ${p.note}.` : 'Informs what to buy.');
  }
  const trace = results.map((r) => ({
    number: r.number, id: r.id, name: r.name, tag: r.tag, standard: r.standard,
    status: r.status, severity: r.severity, context_only: r.context_only, headline: r.headline,
    evidence: r.evidence,
    effects: effects[r.id]
      || (r.context_only && r.flagged ? ['Context only: recorded, but it does not change the plan.']
        : r.flagged ? ['Flag only: shown to the planner, but it proposes nothing that changes this plan.'] : []),
    detects: r.detects, primary_sources: r.primary_sources, accelerates: r.accelerates, sources: r.sources, feed: r.feed, stale: r.stale,
    ...(r.error ? { error: r.error } : {}),      // a funnel that failed or broke its contract says why
  }));

  // ---- the order arithmetic, line by line
  const components = [];
  if (hasOrder) {
    components.push({ label: 'Organic demand at the end of the cover window (p80)', value: sized.organic, unit: 'CU' });
    if (sized.pipe) components.push({ label: 'Customer pipeline, probability-weighted', value: sized.pipe, unit: 'CU' });
    for (const p of sized.hard) components.push({ label: `Step-up: ${p.label}`, value: p.cu, unit: 'CU', funnel: p.funnel_name });
    for (const p of sized.temp) components.push({ label: `Temporary buffer: ${p.label}`, value: p.cu, unit: 'CU', funnel: p.funnel_name });
    components.push({ label: 'Total demand', value: sized.totalDemand, unit: 'CU', total: true });
    components.push({ label: `Capacity needed to stay under the ${pct(floorEff)} ceiling`, value: sized.required, unit: 'CU', total: true });
    components.push({ label: 'Less: capacity that will exist by then (installed and in flight)', value: -sized.have, unit: 'CU' });
    if (replaceUnits) components.push({ label: 'Plus: replacement of a failing segment', value: replaceUnits, unit: 'CU' });
    components.push({ label: `Need, in ${ctx.sku.sku_id} units`, value: sized.needUnits, unit: 'CU', total: true });
    if (factor !== 1) components.push({ label: `Converted to ${target.sku_id} (1 unit = ${factor} ${ctx.sku.sku_id} units)`, value: sized.targetUnits, unit: 'CU' });
    components.push({ label: `Plus ${pct(P.buffer_pct)} buffer, rounded up to racks of ${target.order_unit_cu} (minimum ${target.vendor_min_cu})`, value: sized.qty, unit: 'CU', total: true });
  }

  // ---- narrative
  const driverFunnel = neededPick ? results.find((r) => r.id === neededPick.funnel) : null;
  let headline;
  if (hasOrder) {
    const when = raiseDays < 0 ? `today (${-raiseDays} days overdue)` : `by ${fmt(raiseBy)}`;
    headline = `Order ${num(sized.qty)} CU of ${target.sku_id} ${when}.`;
  } else if (state === 'WATCH') {
    headline = 'No order is needed yet, but something is on the calendar.';
  } else {
    headline = 'No order is needed in the next 12 months.';
  }
  const reasons = [];
  if (hasOrder && driverFunnel) reasons.push(`${driverFunnel.name} sets the date: ${driverFunnel.headline}`);
  if (hasOrder) reasons.push(`Lead time is ${lead} weeks: ${leadBreakdown.map((l) => `${l.weeks} from ${l.label}`).join(', plus ')}.`);
  if (hasOrder && sized.landsOn > neededBy) {
    const wk = Math.round(daysBetween(neededBy, sized.landsOn) / 7);
    reasons.push(`Even if ordered ${raiseDays < 0 ? 'today' : 'on time'}, capacity lands ${wk} week${wk === 1 ? '' : 's'} after it is needed.`);
  }
  if (!hasOrder && reclaim.cu) reasons.push(`${cu(reclaim.cu)} of idle reservations could be reclaimed instead of bought.`);
  if (!hasOrder && !reasons.length) reasons.push('Utilization, contracts and events all fit inside the capacity that will exist.');

  return {
    pool_id: ctx.pool.pool_id, region: ctx.pool.region, region_label: ctx.pool.region_label, datacenter_id: ctx.pool.datacenter_id,
    sku_id: ctx.sku.sku_id, sku_label: ctx.sku.label, sku_class: ctx.pool.sku_class, workload_type: ctx.pool.workload_type,
    state, priority,
    capacity: {
      installed: ctx.pool.capacity_units, usable_now: ctx.usable0, allocated: ctx.allocatedNow, free_now: ctx.freeNow,
      utilized: ctx.latest, utilization_of_usable: ctx.latest / ctx.usable0, floor_pct: ctx.floor, working_floor_pct: floorEff,
    },
    forecast: {
      model: ctx.fc.model, why: [ctx.fc.why, describeShifts(ctx.shifts)].filter(Boolean).join(' '), slope_per_week: ctx.fc.slope_per_week,
      // the steps and spikes the records name that were looked for in the history before fitting: which were taken out, and which were left and why
      level_shifts: ctx.shifts,
      slope_pts_per_week: (ctx.fc.slope_per_week / Math.max(1, ctx.usable0)) * 100, backtest: ctx.fc.backtest, overridden: ctx.fc.overridden,
      // which forecast this plan was built on: its shape version, the interval its p80 path is, and a fingerprint of the exact history and settings
      contract: ctx.fc.contract, interval: ctx.fc.interval, input: ctx.fc.input, input_hash: ctx.fc.input_hash,
    },
    dates: {
      needed_by: neededBy, need_driver: neededPick ? neededPick.funnel : null, mandatory_by: mandatoryPick ? mandatoryPick.by : null,
      raise_by: raiseBy, raise_on: hasOrder ? raiseDate : null,
      lands_on: hasOrder ? sized.landsOn : null, covered_until: coveredUntil,
      overdue_days: hasOrder && raiseDays < 0 ? -raiseDays : 0,
      short_weeks: hasOrder && sized.landsOn > neededBy ? Math.round(daysBetween(neededBy, sized.landsOn) / 7) : 0,
    },
    lead: { weeks: lead, breakdown: leadBreakdown },
    what: {
      order_sku: target.sku_id, order_label: target.label, from_sku: ctx.sku.sku_id, factor, replaces: target.sku_id !== ctx.sku.sku_id,
      unit_cost_usd: target.unit_cost_usd, order_unit_cu: target.order_unit_cu, vendor_min_cu: target.vendor_min_cu,
      lifecycle: ctx.sku.status, hints: props.filter((p) => p.kind === 'what_hint' || p.kind === 'mix_shift').map((p) => ({ funnel: p.funnel_name, note: p.note })),
    },
    order: {
      needed: hasOrder, quantity_cu: sized.qty, equivalent_cu: orderEq, cost_usd: cost, need_units: sized.needUnits, replacement_units: replaceUnits,
      cover_until_week: sized.coverEnd, components,
      in_flight: ctx.inflight.map((s) => ({ order_id: s.order_id, cu: s.cu, sku_id: s.sku_id, lands_on: s.lands_on, status: s.status })),
    },
    horizons,
    // Standard demand-driven planning (demand, performance) versus a funnel-triggered override (everything else).
    driver: driverFunnel ? {
      id: driverFunnel.id, number: driverFunnel.number, name: driverFunnel.name, headline: driverFunnel.headline,
      standard: driverFunnel.standard, kind: driverFunnel.standard ? 'Standard demand-driven planning' : `Funnel-triggered: ${driverFunnel.name}`,
    } : null,
    reclaim,
    headline, reasons,
    flagged_count: flagged.length,
    quiet_count: results.filter((r) => r.status === 'quiet').length,
    trace,
    funnels_summary: results.map((r) => ({ number: r.number, id: r.id, status: r.status, severity: r.severity, context_only: r.context_only })),
  };
}

function assessPool(data, poolId, overrides = {}) {
  const ctx = buildContext(data, poolId, overrides);
  const results = runFunnels(ctx);
  const verdict = compose(ctx, results);
  return { ctx, results, verdict };
}

module.exports = { compose, assessPool, HORIZON_LABELS };
