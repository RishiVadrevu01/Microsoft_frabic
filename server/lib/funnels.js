'use strict';
/*
 * The 14 capacity-planning funnels (Engineering Requirements, section 3.2).
 *
 * Each funnel is independent: it reads its own records, answers one question, and
 * returns
 *     { flagged, severity, headline, evidence[], proposals[] }
 * A proposal is a typed statement about what the plan may need, for example
 * "capacity needed by <date>" or "lead time is 20 weeks". Funnels never read each
 * other's output; verdict.js composes their proposals into one decision per pool.
 * Any funnel can flag a pool even when every other funnel says it is healthy.
 *
 * Proposal kinds
 *   capacity   {needed_by}          capacity must be in place by this date
 *   replace    {needed_by, cu}      retire a segment and stand up replacement units
 *   deadline   {by}                 mandatory date with no size attached
 *   lead       {mode:'set'|'add', weeks}
 *   add_demand {cu, at, temporary?, hard?}
 *   floor      {floor_pct}          a lower working ceiling than policy
 *   reclaim    {cu, value_usd}      idle reserved capacity that could be freed
 *   priority   {level}
 *   mix_shift / what_hint / retire  (guidance about what to buy)
 *
 * Tags: [ML] uses a fitted statistical model, [RULES] is a threshold on a record.
 * No funnel here is an LLM.
 *
 * "standard" marks the two funnels the requirements describe as feeding the standard
 * planning horizon (demand and performance). Every other funnel is an override or an
 * accelerator, and the screens show that difference: a plan set by one of them is
 * "funnel-triggered", not standard demand-driven planning.
 */

const { fmt, addWeeks, daysBetween } = require('./dates');
const { cu, num, pct, pts, usd } = require('./format');
const { quantile } = require('./forecast');
const { resultProblems } = require('./contracts');
const { describe: describeShifts, applied } = require('./shifts');

const quiet = (headline, evidence = []) => ({ status: 'quiet', flagged: false, severity: 'none', headline, evidence, proposals: [], context_only: false });
const noData = (headline) => ({ status: 'no-data', flagged: false, severity: 'none', headline, evidence: [], proposals: [], context_only: false });
const flag = (severity, headline, evidence, proposals = [], contextOnly = false) => ({
  status: 'flagged', flagged: true, severity, headline, evidence, proposals, context_only: contextOnly,
});
const ev = (label, value) => ({ label, value: String(value) });
const SEV_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

// ------------------------------------------------------------------ 1 Demand [ML]
function demand(ctx) {
  const f = ctx.floor;
  const h80 = ctx.crossing((h) => ctx.demandBase(h) >= f * ctx.usableAt(h));
  const h50 = ctx.crossing((h) => ctx.p50At(h) + ctx.pipelineAt(h) >= f * ctx.usableAt(h));
  const slopePts = ctx.fc.slope_per_week / Math.max(1, ctx.usable0);
  const evidence = [
    ev('Model', ctx.fc.model),
    ev('Why this model', ctx.fc.why),
    // shown only when there was something to take out, so a plan on a history with none reads exactly as it always has
    ...(applied(ctx.shifts).length ? [ev('Taken out of the history first', describeShifts(ctx.shifts).replace(/^Before fitting, /, ''))] : []),
    ev('Growth', `${pts(slopePts)} of capacity per week`),
    ev('Latest utilization', `${num(ctx.latest)} CU (${pct(ctx.latest / ctx.usable0, 1)} of ${num(ctx.usable0)} CU)`),
    ev('Floor', `${pct(f)} of capacity`),
    ev('Customer pipeline counted', `${cu(ctx.pipelineAt(52))} (probability-weighted)`),
    ev('Floor crossed (middle estimate)', h50 == null ? 'not within 24 months' : fmt(ctx.dateOf(h50))),
    ev('Floor crossed (p80, planning)', h80 == null ? 'not within 24 months' : fmt(ctx.dateOf(h80))),
  ];
  if (h80 == null || h80 > 52) return quiet('Demand stays under the floor for the next 12 months.', evidence);
  const w = ctx.policy.demand_severity_weeks;
  const severity = h80 <= w.critical ? 'critical' : h80 <= w.high ? 'high' : 'medium';
  const when = h80 === 0 ? 'already above' : `on ${fmt(ctx.dateOf(h80))}`;
  return flag(severity, `Demand reaches the ${pct(f)} floor ${when} (p80).`, evidence,
    [{ kind: 'capacity', needed_by: ctx.dateOf(h80), note: 'demand forecast (p80) plus weighted pipeline crosses the floor' }]);
}

// ------------------------------------------------------------------ 2 Reliability / Health
// The incident picture, shared with the ontology's health layer so both show one score.
function incidentHealth(ctx) {
  const rp = ctx.policy.reliability;
  const cutoff = addWeeks(ctx.asOf, -rp.window_days / 7);
  const recent = ctx.incidents.filter((i) => i.opened_on >= cutoff && i.opened_on <= ctx.asOf);
  const bySeg = {};
  for (const i of recent) bySeg[i.fabric_segment] = (bySeg[i.fabric_segment] || 0) + (rp.weights[i.severity] || 0);
  const score = Object.values(bySeg).reduce((a, v) => a + v, 0);
  const worst = Object.entries(bySeg).sort((a, b) => b[1] - a[1])[0];
  const sev12 = recent.filter((i) => i.severity <= 2).length;
  const mttr = recent.length ? recent.reduce((a, i) => a + i.mttr_hours, 0) / recent.length : 0;
  return { rp, recent, bySeg, score, worst, sev12, mttr };
}

function reliability(ctx) {
  const { rp, recent, score, worst, sev12, mttr } = incidentHealth(ctx);
  const evidence = [
    ev('Incidents in last 90 days', recent.length),
    ev('Sev 1-2', sev12),
    ev('Severity-weighted score', `${score.toFixed(1)} (flag at ${rp.flag_score}, critical at ${rp.critical_score})`),
    ev('Average time to mitigate', `${mttr.toFixed(1)} hours`),
    ev('Worst fabric segment', worst ? `${worst[0]} (score ${worst[1].toFixed(1)})` : 'none'),
  ];
  if (score < rp.flag_score) return quiet('Incident load is within normal range.', evidence);
  const critical = score >= rp.critical_score;
  const seg = ctx.pool.segments.find((s) => s.segment_id === worst[0]);
  const weeks = critical ? rp.replace_within_weeks.critical : rp.replace_within_weeks.high;
  return flag(critical ? 'critical' : 'high',
    `Segment ${worst[0]} is producing a disproportionate share of incidents, whatever the utilization says.`,
    evidence,
    seg ? [{ kind: 'replace', needed_by: addWeeks(ctx.asOf, weeks), cu: seg.units, segment: seg.segment_id,
      note: `replace ${seg.segment_id} within ${weeks} weeks regardless of headroom` }] : []);
}

// ------------------------------------------------------------------ 3 Performance
function performance(ctx) {
  const p = ctx.perf;
  if (!p) return noData('No latency or queue record for this pool.');
  const pp = ctx.policy.performance;
  const ratio = p.p95_latency_ms / p.p95_baseline_ms;
  const qratio = p.queue_depth_p95 / p.queue_depth_limit;
  const evidence = [
    ev('p95 latency', `${p.p95_latency_ms} ms vs ${p.p95_baseline_ms} ms baseline (${ratio.toFixed(2)}x)`),
    ev('Queue depth p95', `${p.queue_depth_p95} of ${p.queue_depth_limit} (${pct(qratio)})`),
    ev('Measured strain point', `latency degrades above ${pct(p.knee_util_pct)} utilization`),
  ];
  if (ratio < pp.latency_ratio_flag && qratio < pp.queue_ratio_flag) return quiet('Latency and queues look normal.', evidence);
  const kneeFloor = Math.min(ctx.floor, p.knee_util_pct - pp.knee_margin);
  const h = ctx.crossing((x) => ctx.demandBase(x) >= kneeFloor * ctx.usableAt(x), 52);
  const proposals = [{ kind: 'floor', floor_pct: kneeFloor, note: 'strain starts below the policy floor' }];
  if (h != null) proposals.push({ kind: 'capacity', needed_by: ctx.dateOf(h), note: `demand reaches the ${pct(kneeFloor)} strain level` });
  evidence.push(ev('Working ceiling used', `${pct(kneeFloor)} (strain point minus ${pct(pp.knee_margin)} margin)`));
  return flag(ratio >= pp.latency_ratio_high ? 'high' : 'medium',
    `Users already feel strain: p95 latency is ${ratio.toFixed(2)}x baseline, below the ${pct(ctx.floor)} floor.`, evidence, proposals);
}

// ------------------------------------------------------------------ 4 Cost & efficiency
// Every reservation with how idle it is and how much of it could be reclaimed.
function reservations(ctx) {
  const cp = ctx.policy.cost;
  return ctx.allocations.map((a) => {
    const ratio = a.utilized_units / a.allocated_units;
    const idle = ratio < cp.low_use_ratio && a.low_use_weeks >= cp.low_use_weeks;
    const reclaimable = idle ? Math.max(0, a.allocated_units - Math.round(a.utilized_units * (1 + cp.keep_margin))) : 0;
    return { ...a, use_ratio: ratio, idle, reclaimable };
  });
}

function cost(ctx) {
  const cp = ctx.policy.cost;
  const candidates = reservations(ctx).filter((a) => a.reclaimable > 0);
  const total = candidates.reduce((a, r) => a + r.reclaimable, 0);
  const value = total * ctx.sku.unit_cost_usd;
  const evidence = [
    ev('Reserved / used', `${num(ctx.allocatedNow)} / ${num(ctx.latest)} CU`),
    ...candidates.map((a) => ev(a.reserved_by, `reserved ${num(a.allocated_units)}, using ${num(a.utilized_units)} for ${a.low_use_weeks} weeks: ${cu(a.reclaimable)} reclaimable`)),
  ];
  if (total < cp.flag_share_of_usable * ctx.usable0) return quiet('Reservations are close to what teams actually use.', evidence);
  const severity = total >= 0.15 * ctx.usable0 ? 'medium' : 'low';
  return flag(severity, `${cu(total)} of reserved capacity is idle (about ${usd(value)} at purchase cost).`, evidence,
    [{ kind: 'reclaim', cu: total, value_usd: value, from: candidates.map((c) => c.reserved_by) }]);
}

// ------------------------------------------------------------------ 5 Strategic
function strategic(ctx) {
  const evs = ctx.events.filter((e) => e.signal === 'strategic' && e.date >= ctx.asOf);
  if (!evs.length) return noData('No roadmap or region-launch record for this pool.');
  const proposals = [];
  const evidence = [];
  let severity = 'low';
  const headlines = [];
  for (const e of evs) {
    const h = ctx.hOf(e.date);
    evidence.push(ev(e.title, `${fmt(e.date)}: ${e.detail}`));
    if (e.effect === 'hardware-gen') {
      proposals.push({ kind: 'what_hint', date: e.date, note: e.title });
      headlines.push(`${e.title} on ${fmt(e.date)}`);
    } else if (e.effect === 'demand' && h <= 52) {
      const exceeds = ctx.demandBase(h) + e.magnitude_cu >= ctx.floor * ctx.usableAt(h);
      proposals.push({ kind: 'add_demand', cu: e.magnitude_cu, at: e.date, label: e.title });
      if (exceeds) proposals.push({ kind: 'capacity', needed_by: e.date, note: e.title });
      severity = 'medium';
      headlines.push(`${e.title}: about ${cu(e.magnitude_cu)} of new demand from ${fmt(e.date)}`);
    }
  }
  if (!proposals.length) return quiet('Roadmap events are too far out to matter.', evidence);
  return flag(severity, `${headlines.join('; ')}.`, evidence, proposals);
}

// ------------------------------------------------------------------ 6 Dependency / blast radius
function dependency(ctx) {
  const d = ctx.dep;
  if (!d) return noData('No dependency map for this pool.');
  const tier1 = d.critical_services.filter((s) => s.tier === 1);
  const min = ctx.policy.dependency.tier1_min;
  const evidence = [
    ev('Tier-1 services', `${tier1.length} (${tier1.map((s) => s.name).join(', ') || 'none'})`),
    ev('Failover pool', d.failover_pool_id || 'none'),
  ];
  if (tier1.length < min || d.failover_pool_id) return quiet('No single point of failure at this pool.', evidence);
  return flag('high', `${tier1.length} tier-1 services depend on this pool and it has no failover, even though incidents are clean.`, evidence,
    [{ kind: 'priority', level: 'high', note: 'single point of failure' }]);
}

// ------------------------------------------------------------------ 7 Sustainability
function sustainability(ctx) {
  const target = ctx.policy.sustainability.target_gco2_per_cu_hour;
  const g = ctx.sku.gco2_per_cu_hour;
  const tonnes = (g * ctx.latest * 8760) / 1e6;
  const evidence = [
    ev('Carbon intensity', `${g} gCO2e per CU-hour (target ${target})`),
    ev('Estimated yearly footprint', `${num(tonnes)} tCO2e at today's load`),
  ];
  if (g <= target) return quiet('Carbon intensity meets the target.', evidence);
  const swappable = ctx.pool.workload_type !== 'ai-training';
  const better = ctx.orderSku.sku_id !== ctx.sku.sku_id && ctx.orderSku.gco2_per_cu_hour < g ? ctx.orderSku : null;
  if (swappable && better) {
    return flag('medium', `${ctx.sku.sku_id} is power-inefficient (${g} vs target ${target}); ${better.sku_id} cuts it to ${better.gco2_per_cu_hour}.`, evidence,
      [{ kind: 'retire', to_sku: better.sku_id, note: 'retire for a more efficient SKU' }]);
  }
  return flag('low', swappable
    ? `Above the carbon target (${g} vs ${target}) with no more efficient SKU available yet. Flag only.`
    : `Above the carbon target, but this is an AI-training pool that cannot swap SKU. Flag only.`, evidence);
}

// ------------------------------------------------------------------ 8 Supply chain / lead time
function supplyChain(ctx) {
  const v = ctx.vendor;
  if (!v) return noData('No vendor record for the order SKU.');
  const lp = ctx.policy.lead_time;
  const obs = v.observed_lead_weeks || [];
  const p80 = obs.length >= lp.observed_min_samples ? quantile(obs, 0.8) : null;
  const evidence = [
    ev('Vendor', `${v.name} for ${ctx.orderSku.sku_id}`),
    ev('Quoted lead time', `${v.quoted_lead_weeks} weeks`),
    ev('Observed p80 over last deliveries', p80 == null ? 'too few deliveries' : `${p80.toFixed(1)} weeks (${obs.join(', ')})`),
    ev('Vendor risk score', v.risk_score.toFixed(2)),
  ];
  const slow = p80 != null && p80 > v.quoted_lead_weeks * 1.1;
  const risky = v.risk_score >= lp.vendor_risk_flag;
  if (!slow && !risky) return quiet('Vendor is delivering to its quoted lead time.', evidence);
  const proposals = [];
  if (slow) proposals.push({ kind: 'lead', mode: 'set', weeks: Math.ceil(p80), note: 'observed p80 replaces the quoted lead time' });
  if (risky) proposals.push({ kind: 'lead', mode: 'add', weeks: lp.vendor_risk_buffer_weeks, note: 'vendor risk buffer' });
  const heavy = slow && p80 >= v.quoted_lead_weeks * 1.25;
  return flag(heavy || risky ? 'high' : 'medium',
    slow ? `The vendor really takes about ${Math.ceil(p80)} weeks, not the ${v.quoted_lead_weeks} it quotes.` : 'Vendor risk is elevated; the order needs extra lead time.',
    evidence, proposals);
}

// ------------------------------------------------------------------ 9 Security & compliance
function security(ctx) {
  const end = ctx.sku.security_support_ends;
  const sp = ctx.policy.security;
  const weeksLeft = daysBetween(ctx.asOf, end) / 7;
  const evidence = [ev('Vendor security support ends', fmt(end)), ev('Weeks left', Math.round(weeksLeft))];
  if (weeksLeft > sp.horizon_weeks) return quiet('Security support runs well beyond the planning horizon.', evidence);
  const by = addWeeks(end, -sp.migration_weeks);
  evidence.push(ev('Migration must start by', `${fmt(by)} (${sp.migration_weeks} weeks before support ends)`));
  return flag(weeksLeft <= 26 ? 'high' : 'medium',
    `${ctx.sku.sku_id} leaves vendor security support on ${fmt(end)}; replacement is mandatory whatever the headroom.`, evidence,
    [{ kind: 'deadline', by, note: 'mandatory replacement before security support ends' }]);
}

// ------------------------------------------------------------------ 10 Seasonal / event-driven
function seasonal(ctx) {
  const evs = ctx.events.filter((e) => e.signal === 'seasonal');
  if (!evs.length) return noData('No seasonal record for this pool.');
  const H = ctx.policy.seasonal.horizon_weeks;
  const proposals = [];
  const evidence = [];
  let worst = 'none';
  const lines = [];
  for (const e of evs) {
    const h = ctx.hOf(e.date);
    if (e.date < ctx.asOf || h > H) continue;
    const base = ctx.p50At(h) + ctx.pipelineAt(h);
    const spike = base * e.uplift_pct;
    const limit = ctx.floor * ctx.usableAt(h);
    const headroom = limit - ctx.demandBase(h);
    evidence.push(ev(e.title, `${fmt(e.date)} for ${e.duration_weeks} weeks: +${pct(e.uplift_pct)} is about ${cu(spike)} on a base of ${cu(base)}; headroom then ${cu(Math.max(0, headroom))}`));
    if (spike > headroom) {
      proposals.push({ kind: 'capacity', needed_by: e.date, note: e.title });
      proposals.push({ kind: 'add_demand', cu: spike, at: e.date, temporary: true, label: e.title });
      worst = h <= 13 ? 'high' : 'medium';
      lines.push(`${e.title} (${fmt(e.date)}) adds a spike of about ${cu(spike)}, more than the ${cu(Math.max(0, headroom))} of headroom then`);
    }
  }
  if (!proposals.length) return quiet(evidence.length ? 'Known seasonal peaks fit inside existing headroom.' : 'No seasonal peak inside the next 12 months.', evidence);
  return flag(worst, `${lines.join('; ')}.`, evidence, proposals);
}

// ------------------------------------------------------------------ 11 Competitive / market
function competitive(ctx) {
  const evs = ctx.events.filter((e) => e.signal === 'competitive' && e.confidence >= 0.3);
  if (!evs.length) return noData('No market intel for this pool.');
  const e = evs[0];
  return flag(e.confidence < 0.5 ? 'low' : 'medium',
    `${e.title} (confidence ${pct(e.confidence)}). Softest funnel: it informs strategy, it never orders hardware.`,
    [ev('What was reported', e.detail), ev('Confidence', pct(e.confidence)), ev('Reported', fmt(e.date))], [], true);
}

// ------------------------------------------------------------------ 12 Customer contract
function contract(ctx) {
  if (!ctx.contracts.length) return noData('No enterprise agreement on this pool.');
  const proposals = [];
  const evidence = [];
  const lines = [];
  let severity = 'none';
  for (const c of ctx.contracts) {
    const incr = Math.max(0, c.committed_cu - c.provisioned_cu);
    const h = ctx.hOf(c.effective_date);
    evidence.push(ev(c.customer, `commits ${num(c.committed_cu)} CU from ${fmt(c.effective_date)}; ${num(c.provisioned_cu)} already provisioned, ${num(incr)} to add`));
    if (incr <= 0 || h > 52) continue;
    const headroom = ctx.floor * ctx.usableAt(h) - ctx.demandBase(h);
    const exceeds = incr > headroom;
    proposals.push({ kind: 'add_demand', cu: incr, at: c.effective_date, label: c.customer });
    if (exceeds) proposals.push({ kind: 'capacity', needed_by: c.effective_date, note: c.customer });
    const sev = exceeds ? (h <= 26 ? 'critical' : 'high') : 'medium';
    if (SEV_RANK[sev] > SEV_RANK[severity]) severity = sev;
    lines.push(`${c.customer.split(' (')[0]} needs ${cu(incr)} more from ${fmt(c.effective_date)}${exceeds ? ', more than the forecast headroom' : ', which fits the headroom'}`);
  }
  if (!proposals.length) return quiet('Contract commitments are already provisioned.', evidence);
  return flag(severity, `${lines.join('; ')}. A contract is a hard trigger.`, evidence, proposals);
}

// ------------------------------------------------------------------ 13 Technology shift
function technologyShift(ctx) {
  const evs = ctx.events.filter((e) => e.signal === 'technology-shift');
  if (!evs.length) return noData('No technology-shift record for this pool.');
  const e = evs[0];
  return flag('medium', `${e.title}: GPU share of demand is moving from ${pct(e.from_share)} to ${pct(e.to_share)}, so the SKU mix should be re-weighted.`,
    [ev('What the trend says', e.detail), ev('Confidence', pct(e.confidence)), ev('By', fmt(e.date))],
    [{ kind: 'mix_shift', from: e.from_share, to: e.to_share, note: 'weight new GPU orders toward the growing class' }]);
}

// ------------------------------------------------------------------ 14 Geopolitical & regulatory
function geopolitical(ctx) {
  const evs = ctx.events.filter((e) => e.signal === 'geopolitical' && e.date >= ctx.asOf);
  if (!evs.length) return noData('No regulatory or trade record for this pool.');
  const proposals = [];
  const evidence = [];
  const lines = [];
  for (const e of evs) {
    const h = ctx.hOf(e.date);
    evidence.push(ev(e.title, `${fmt(e.date)}: ${e.detail}`));
    if (h > 52) continue;
    if (e.effect === 'relocate-in') {
      const exceeds = ctx.demandBase(h) + e.magnitude_cu >= ctx.floor * ctx.usableAt(h);
      proposals.push({ kind: 'add_demand', cu: e.magnitude_cu, at: e.date, label: e.title });
      if (exceeds) proposals.push({ kind: 'capacity', needed_by: e.date, note: e.title });
      lines.push(`${e.title} on ${fmt(e.date)} moves about ${cu(e.magnitude_cu)} into this pool`);
    }
  }
  if (!proposals.length) return quiet('Regulatory changes are outside the planning horizon.', evidence);
  return flag('high', `${lines.join('; ')}. It is mandatory, so it does not wait for utilization.`, evidence, proposals);
}

// ------------------------------------------------------------------ registry
// `detects`, `primary_sources` and `accelerates` are the requirements' own wording (section 3.2).
const REGISTRY = [
  { number: 1, id: 'demand', name: 'Demand', tag: 'ML', standard: true, feed: 'telemetry-utilization',
    detects: 'New customer or workload requirements and forecasted growth against current allocation.',
    primary_sources: 'Sales pipeline, committed-use agreements, onboarding queue, growth forecasts', accelerates: 'Standard planning horizon',
    sources: [['utilization.json', 'series[].utilized_units'], ['requests.json', 'cu, needed_by, win_probability, source']], evaluate: demand },
  { number: 2, id: 'reliability', name: 'Reliability / Health', tag: 'RULES', feed: 'incident-log',
    detects: 'SKUs or fabric segments generating disproportionate incidents even while within capacity limits.',
    primary_sources: 'Incident/SEV logs, ticket volume, MTTR by SKU', accelerates: 'Replacement priority regardless of headroom',
    sources: [['incidents.json', 'severity, fabric_segment, opened_on, mttr_hours']], evaluate: reliability },
  { number: 3, id: 'performance', name: 'Performance', tag: 'RULES', standard: true, feed: 'telemetry-performance',
    detects: "Throughput, latency, or queueing strain that raw utilization percentages don't show.",
    primary_sources: 'Telemetry: p95/p99 latency, throughput, queue depth', accelerates: 'Standard planning horizon',
    sources: [['performance.json', 'p95_latency_ms, queue_depth_p95, knee_util_pct']], evaluate: performance },
  { number: 4, id: 'cost-efficiency', name: 'Cost & Efficiency', tag: 'RULES', feed: 'telemetry-utilization',
    detects: 'Overprovisioned or power-inefficient capacity that is reliable but financially wasteful.',
    primary_sources: 'Power draw, $/unit-of-work, idle allocation', accelerates: 'De-prioritization / reclaim candidate list',
    sources: [['allocations.json', 'allocated_units, utilized_units, low_use_weeks']], evaluate: cost },
  { number: 5, id: 'strategic', name: 'Strategic', tag: 'RULES', feed: 'hardware-roadmap',
    detects: 'Forward-looking shifts: new hardware generations, region launches, product roadmap.',
    primary_sources: 'Hardware roadmaps, region expansion plans', accelerates: 'Long-range planning horizon',
    sources: [['events.json', 'signal = strategic']], evaluate: strategic },
  { number: 6, id: 'dependency', name: 'Dependency / Blast Radius', tag: 'RULES', feed: 'service-dependency-map',
    detects: 'Single points of failure supporting many critical workloads, even with zero incidents yet.',
    primary_sources: 'Service dependency maps, workload criticality tags', accelerates: 'Priority upgrade despite clean incident history',
    sources: [['dependencies.json', 'critical_services[].tier, failover_pool_id']], evaluate: dependency },
  { number: 7, id: 'sustainability', name: 'Sustainability', tag: 'RULES', feed: 'power-carbon',
    detects: 'Hardware that is reliable but power-inefficient relative to net-zero / carbon targets.',
    primary_sources: 'Power usage effectiveness (PUE), carbon accounting', accelerates: 'Retirement priority independent of capacity',
    sources: [['sku_catalogue.json', 'gco2_per_cu_hour']], evaluate: sustainability },
  { number: 8, id: 'supply-chain', name: 'Supply Chain / Lead Time', tag: 'RULES', feed: 'vendor-lead-times',
    detects: 'Components with long or volatile lead times or elevated vendor risk.',
    primary_sources: 'Vendor lead-time data, order backlogs, vendor risk scores', accelerates: 'Earlier order trigger ahead of exhaustion date',
    sources: [['vendors.json', 'quoted_lead_weeks, observed_lead_weeks, risk_score']], evaluate: supplyChain },
  { number: 9, id: 'security-compliance', name: 'Security & Compliance', tag: 'RULES', feed: 'security-notices',
    detects: 'Hardware aging out of vendor security support windows.',
    primary_sources: 'Vendor EOL/EOS notices, patch/support status', accelerates: 'Mandatory replacement regardless of capacity',
    sources: [['sku_catalogue.json', 'security_support_ends']], evaluate: security },
  { number: 10, id: 'seasonal', name: 'Seasonal / Event-Driven', tag: 'RULES', feed: 'launch-calendar',
    detects: 'Known demand spikes tied to calendar events or product launches.',
    primary_sources: 'Historical seasonal curves, launch calendars', accelerates: 'Temporary pre-provisioning buffer',
    sources: [['events.json', 'signal = seasonal']], evaluate: seasonal },
  { number: 11, id: 'competitive', name: 'Competitive / Market Signal', tag: 'RULES', feed: 'market-intel',
    detects: 'Early, qualitative signals of surge risk from the broader market.',
    primary_sources: 'Public competitor status pages, account-team intel, industry news', accelerates: 'Feeds strategic planning, not automatic procurement',
    sources: [['events.json', 'signal = competitive']], evaluate: competitive },
  { number: 12, id: 'customer-contract', name: 'Customer Contract & Commitment', tag: 'RULES', feed: 'contracts-register',
    detects: 'Contractual capacity or growth guarantees in enterprise agreements.',
    primary_sources: 'Enterprise agreement terms, committed spend levels', accelerates: 'Contractual (hard) planning trigger',
    sources: [['contracts.json', 'committed_cu, provisioned_cu, effective_date']], evaluate: contract },
  { number: 13, id: 'technology-shift', name: 'Technology Shift', tag: 'RULES', feed: 'hardware-roadmap',
    detects: 'Structural change in what kind of capacity matters (e.g., GPU/AI demand vs. general compute).',
    primary_sources: 'Workload-type mix trends, silicon demand forecasts', accelerates: 'Re-weighting of SKU priority mix',
    sources: [['events.json', 'signal = technology-shift']], evaluate: technologyShift },
  { number: 14, id: 'geopolitical', name: 'Geopolitical & Regulatory', tag: 'RULES', feed: 'regulatory-tracker',
    detects: 'Sanctions, tariffs, or data-sovereignty laws forcing capacity relocation.',
    primary_sources: 'Regulatory tracking, trade policy, data residency requirements', accelerates: 'Mandatory relocation / rearchitecture trigger',
    sources: [['events.json', 'signal = geopolitical']], evaluate: geopolitical },
];

/** Run every funnel for one pool and attach its catalogue metadata and feed health. */
function runFunnels(ctx) {
  return REGISTRY.map((f) => {
    let out;
    try {
      out = f.evaluate(ctx);
      // The plan engine trusts nothing it is not sure of: a result that breaks the funnel-to-plan contract (docs/CONTRACTS.md)
      // is treated like a funnel that failed, so a mistyped proposal can never quietly drop out of the plan.
      const problems = resultProblems(out);
      if (problems.length) out = { ...noData(`This funnel returned output that breaks its contract: ${problems.join('; ')}`), error: problems.join('; ') };
    } catch (err) {
      // A broken funnel must not take the whole plan down; it is shown as unavailable.
      out = { ...noData(`This funnel could not be computed: ${err.message}`), error: err.message };
    }
    const feed = ctx.feedStatus(f.feed);
    return {
      id: f.id, number: f.number, name: f.name, tag: f.tag, standard: Boolean(f.standard),
      detects: f.detects, primary_sources: f.primary_sources, accelerates: f.accelerates,
      sources: f.sources.map(([file, fields]) => ({ file, fields })),
      feed,
      ...out,
      stale: Boolean(feed && feed.stale && out.flagged),
    };
  });
}

const catalogue = () => REGISTRY.map(({ number, id, name, tag, standard, detects, primary_sources, accelerates, sources, feed }) => ({
  number, id, name, tag, standard: Boolean(standard), detects, primary_sources, accelerates, feed_id: feed,
  sources: sources.map(([file, fields]) => ({ file, fields })),
}));

module.exports = { REGISTRY, runFunnels, catalogue, reservations, incidentHealth, SEV_RANK };
