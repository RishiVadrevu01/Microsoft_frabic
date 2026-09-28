'use strict';
/*
 * Generates the two documents whose numbers must never drift from the engine:
 *   docs/FUNNELS.md       the 14 funnels, what each reads, and where each flags on the baseline
 *   docs/DEMO-SCRIPT.md   a five-minute walk through the story with the live numbers filled in
 *
 * `npm run docs` rewrites them. test/docs.test.js fails if the committed files differ
 * from what this script would produce, so the documents are tested, not just written.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadRaw, indexData } = require('../server/lib/data');
const { assessPool } = require('../server/lib/verdict');
const { summarize } = require('../server/lib/summary');
const { catalogue } = require('../server/lib/funnels');
const { fmt } = require('../server/lib/dates');
const { cu, num, usd, pct } = require('../server/lib/format');
const { createStore } = require('../server/lib/store');
const { buildOverview } = require('../server/lib/overview');
const { buildOntology } = require('../server/lib/ontology');
const { buildRequester } = require('../server/lib/requester');
const { buildPlanning } = require('../server/lib/planning');
const { SCHEMAS, SINGLETONS, EVENT_RULES } = require('../server/lib/validate');
const { PROPOSAL_KINDS, RESULT_FIELDS } = require('../server/lib/contracts');
const { SERIES, sizingDemand } = require('../server/lib/timeline');
const { buildContext } = require('../server/lib/context');
const { REGISTRY, runFunnels } = require('../server/lib/funnels');
const { decide } = require('../server/lib/decisions');
const { buildOutcome, takeSnapshot } = require('../server/lib/outcome');
const { SURPRISE_MIN, SURPRISE_MAX, MAX_WEEKS, UPTAKE, SEASONAL_REALIZED } = require('../server/lib/clock');
const { approvalCheck } = require('../server/lib/approval');
const { buildOptions } = require('../server/lib/options');
const { advisorFacts } = require('../server/lib/advisor');

const ROOT = path.resolve(__dirname, '..');

function build() {
  const data = indexData(loadRaw(path.join(ROOT, 'data')));
  const verdicts = data.pools.map((p) => assessPool(data, p.pool_id).verdict);
  const v = Object.fromEntries(verdicts.map((x) => [x.pool_id, x]));
  const summary = summarize(verdicts, data);
  const eus = v['pool-eastus-01-intel-icx'];
  const gpu = v['pool-westeurope-02-gpu-h100'];
  const sea = v['pool-southeastasia-01-amd-genoa'];
  const jpe = v['pool-japaneast-01-gpu-l40s'];
  const brs = v['pool-brazilsouth-01-amd-genoa'];
  const label = (x) => `${x.region_label} (${x.sku_id})`;
  const lead8 = assessPool(data, eus.pool_id, { lead_time_weeks: 8 }).verdict;
  const funnel = (x, n) => x.trace.find((t) => t.number === n);
  // The peak check needs the optional profile from `npm run ml`; the walk-through includes it only when it is there.
  const peakFile = path.join(ROOT, 'ml', 'out', 'peak_profile.json');
  const st = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null, peakProfilePath: fs.existsSync(peakFile) ? peakFile : null });
  const ov = buildOverview(st, {});
  const pl = buildPlanning(st, {});
  // A figure the way the screen reads it: 9,678 CU, 59%, 3 of 6 pools, $34.22M, +176 CU a week.
  const tileText = (t) => ({ cu: () => cu(t.value), pct: () => pct(t.value), usd: () => usd(t.value), count_of: () => `${t.value} of ${t.of} pools`, cu_week: () => `${t.value >= 0 ? '+' : ''}${num(t.value)} CU a week`, count: () => num(t.value) }[t.unit]());
  const k = ov.kpis;
  const onto = buildOntology(st);
  const lv = (poolId, layer, key) => onto.pools.find((p) => p.pool_id === poolId).layers[layer].values.find((x) => x.key === key).value;
  const signed = (x) => `${x >= 0 ? '+' : '-'}${Math.abs(Math.round(x * 100))}%`;
  // The demo's own sequence: approve East US's order (a rack smaller, with a reason), then let the lab move 13 weeks, and 4 more.
  const stNext = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null });
  decide(stNext, eus.pool_id, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: eus.order.quantity_cu - 192, reason: 'Phase the order to fit the quarter budget' });
  const clockInfo = stNext.advanceInfo();
  stNext.advanceTime(13); stNext.advanceTime(4);
  const oc = buildOutcome(stNext);
  const datedReq = oc.dated.find((d) => d.kind === 'request' && d.happened);
  const datedLapsed = oc.dated.find((d) => d.kind === 'request' && !d.happened);
  const ocEus = oc.pools.find((p) => p.pool_id === eus.pool_id);
  const ocBand = oc.pools.filter((p) => p.forecast.read_key === 'band');
  const ocLate = oc.pools.filter((p) => p.plan.lands_later_weeks > 0).sort((a, b) => b.plan.lands_later_weeks - a.plan.lands_later_weeks)[0];
  const arrival = oc.arrivals[0];
  const slipped = oc.in_flight.filter((o) => o.slipped && o.slip_weeks !== 0);
  // The planner and the approval rules, on the demo's own sequence: East US a rack smaller with a reason, then H100 needs two people.
  const stGov = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null });
  const h100 = v['pool-westeurope-02-gpu-h100'];
  const gOpts = buildOptions(stGov, h100.pool_id);
  const gCheck = approvalCheck(stGov, h100.pool_id, null);
  decide(stGov, eus.pool_id, { decision: 'approve', decided_by: 'Asha Rao', quantity_cu: eus.order.quantity_cu - 192, reason: 'Phase the order to fit the quarter budget' });
  decide(stGov, h100.pool_id, { decision: 'approve', decided_by: 'Asha Rao' });
  const gWaiting = approvalCheck(stGov, h100.pool_id, null).pending;
  decide(stGov, h100.pool_id, { decision: 'approve', decided_by: 'Ben Ortiz' });
  const gBudget = approvalCheck(stGov, jpe.pool_id, null);
  const jOpts = buildOptions(stGov, jpe.pool_id);
  const jRec = jOpts.options.find((o) => o.recommended);
  const jDrafted = jOpts.options.find((o) => o.key === 'as-drafted');
  const gFacts = advisorFacts(stGov, jpe.pool_id);
  const eusOpts = buildOptions(createStore({ dataDir: path.join(ROOT, 'data'), statePath: null }), eus.pool_id);
  const rq = buildRequester(st, {});
  const rk = rq.kpis;
  const phaseLine = rq.cost.bars.map((b) => `${b.label.toLowerCase()} ${cu(b.cu)}`).join(', ');

  // ------------------------------------------------------------ FUNNELS.md
  const cat = catalogue();
  const flagged = (n) => verdicts.filter((x) => funnel(x, n).status === 'flagged').map((x) => x.region_label).join(', ') || 'none';
  const funnels = [
    '# The 14 funnels',
    '',
    'Generated by `npm run docs` from the engine and the shipped baseline data. Do not edit by hand.',
    '',
    'These are the 14 capacity-planning funnels of the Engineering Requirements (section 3.2). "Detects", "Primary signal sources" and "Overrides / accelerates" are the requirements\' own wording.',
    '',
    'Each funnel is independent: it reads its own records, answers one question, and proposes a date, a size or a warning. No funnel reads another funnel\'s output. `verdict.js` composes the proposals into one decision per pool. Any funnel can flag a pool even when every other funnel says it is healthy.',
    '',
    'Tags: **ML** is a fitted statistical model (the demand forecast, backtested). **RULES** is a threshold on a record. No funnel in this lab is an LLM.',
    '',
    '**Standard** funnels (demand, performance) feed the standard planning horizon. Every other funnel is an override or an accelerator, so a plan whose date it sets is shown as *funnel-triggered* rather than standard demand-driven planning.',
    '',
    '| # | Funnel | Tag | Planning | What it detects | Primary signal sources | Overrides / accelerates | Records read | Flags today on |',
    '|--:|---|---|---|---|---|---|---|---|',
    ...cat.map((c) => `| ${c.number} | ${c.name} | ${c.tag} | ${c.standard ? 'standard' : 'override'} | ${c.detects} | ${c.primary_sources} | ${c.accelerates} | ${c.sources.map((s) => `\`${s.file}\``).join(', ')} | ${flagged(c.number)} |`),
    '',
    '## How proposals combine',
    '',
    '- **When**: the earliest need-by date any funnel proposes, minus the lead time.',
    '- **Lead time**: the vendor quote, replaced by what the vendor really delivers (observed p80), plus a buffer when vendor risk is high.',
    '- **How much**: demand at the end of the cover window divided by the working ceiling, less the capacity that will exist by then (installed and in flight), plus replacements, plus a buffer, rounded up to whole racks and the vendor minimum.',
    '- **What**: the order SKU. An end-of-life SKU is ordered as its successor, converted at the equivalence factor.',
    '- **Priority**: the most severe funnel that drives an action.',
    '- **Context only**: competitive intel (11) is recorded and shown, and never changes a date, a size or a lead time. The requirements say it "feeds strategic planning, not automatic procurement".',
    '',
  ].join('\n');

  // ------------------------------------------------------------ DEMO-SCRIPT.md
  const top = summary.actions[0];
  let sec = 0;                     // every heading takes the next number, so a section can be added without renumbering by hand
  const next = () => ++sec;
  const demo = [
    '# Five-minute demo script',
    '',
    'Generated by `npm run docs` from the engine and the shipped baseline data, so every number below is what the screen shows. `npm test` fails if this file drifts. Start clean with `npm run demo`.',
    '',
    'The story in one line: a product team asks for capacity; the system says how much fits now, what to order, when, what it costs and why; a named planner decides; the decision is recorded.',
    '',
    `## ${next()}. The answer first (Capacity Planning, Balance / plan, 90 seconds)`,
    '',
    `- Read the headline aloud: "${ov.headline}" The three chips under it answer the question directly: next 3 months **${summary.horizons[0].answer}**, 6 months **${summary.horizons[1].answer}**, 12 months **${summary.horizons[2].answer}**.`,
    `- The six KPI cards, each with an (i) that says how the number is calculated: total demand ${num(k.total_demand.value)} CU at 12 months (${signed(k.total_demand.delta_pct)} on last quarter; the pools are combined as one forecast, so this is ${num(k.total_demand.diversification_cu)} CU below the ${num(k.total_demand.sum_of_pool_p80)} CU that adding each pool's p80 would give); projected shortfall ${num(k.projected_shortfall.value)} CU (${pct(k.projected_shortfall.share_of_demand)} of demand); ${k.regions_at_risk.at_risk} of ${k.regions_at_risk.total} regions on watch or at risk; a projected reclaim value of ${usd(k.reclaim.value_usd)} (${cu(k.reclaim.cu)}) that needs no purchase; an estimated investment of ${usd(k.investment.usd)} to resolve the critical gaps; and ${k.critical_signals.count} critical signals across ${k.critical_signals.funnels} funnels.`,
    `- Capacity health by region, projected utilization at 12 months: ${ov.regions.map((r) => `${r.label} ${pct(r.utilization)} (${r.status.replace('-', ' ')})`).join(', ')}. The regions are dots on a world map, each where its pools are (weighted by capacity), with the label carrying the figures; selecting one filters the page.`,
    `- The forecast chart plots demand against provisioned and effective capacity, with shortfall bars. The call-out reads "Projected shortfall ${num(ov.forecast.peak_shortfall.cu)} CU". The 3, 6 and 12 month tabs redraw it; hover a month for all four values.`,
    `- Under the cards, **Supply against demand, by pool** is the balance itself. At 12 months demand is ${cu(pl.balance.total.demand_cu)} against ${cu(pl.balance.total.supply_cu)} of supply (${cu(pl.balance.total.ceiling_cu)} at the working ceilings), and ${pl.balance.total.pools_short} of ${pl.balance.total.pools} pools are short. Each bar shows the pool's supply, its working ceiling (the tick) and the demand we plan for (the marker). ${pl.balance.rows[0].region} (${pl.balance.rows[0].sku_id}) is furthest out, by ${cu(-pl.balance.rows[0].balance_cu)}, and its plan is to order ${cu(pl.balance.rows[0].order.quantity_cu)} by ${fmt(pl.balance.rows[0].order.raise_by)}. Balance is per pool: the ${cu(pl.balance.total.surplus_cu)} of room elsewhere cannot cover it.`,
    `- Point at the first recommendation: ${ov.recommendations[0].title}. It says what kind of planning set it: **standard demand-driven planning**, or **funnel-triggered** when another funnel overrides it. Then the constraints table and the top signals (${ov.signals_total} in all). The inventory and the optimization opportunities are on the Supply view.`,
    `- The Action Queue holds ${ov.action_queue.counts.all} actions, ranked P0 first: ${ov.action_queue.counts.procurement} procurement, ${ov.action_queue.counts.allocation} allocation, ${ov.action_queue.counts.other} other. The header Actions button opens it. The SKU and region filters rescope everything on the page, including the headline; the horizon filter changes the chart and the region health.`,
    `- Scroll to "Planning horizon by pool", which lists every pool by urgency with its exhaustion date, order and lead time. The first row: ${label(top)} is **${top.state}**. ${top.headline}`,
    '',
    `## ${next()}. Supply and demand (Capacity Planning, the Supply view and the Demand view, 90 seconds)`,
    '',
    '- Capacity Planning is one page with three views: **Balance / plan** (where you are), **Supply view** and **Demand view**. They replace the two pages a provider and a requester used to see separately, so the two sides of the plan cannot disagree. One set of filters (horizon, SKUs, regions) applies to all three, and the old Overview and Product Team addresses still open the matching view.',
    `- Click **Supply view**. Six figures, each with an (i): ${pl.supply.tiles.map((t) => `${t.label.toLowerCase()} ${tileText(t)}`).join('; ')}. Below them, every pool with its installed capacity, what lands, utilization, headroom, health and value; then the inventory by SKU and the optimization opportunities: ${ov.optimization.map((o) => `${o.action.toLowerCase()} ${cu(o.excess_cu)} in ${o.region}`).join(' and ')}.`,
    `- Click **Demand view**. Six figures: ${pl.demand.tiles.map((t) => `${t.label.toLowerCase()} ${tileText(t)}`).join('; ')}. Product demand is the same number as the balance's total demand. Below them, demand by pool, and the ${pl.demand.events.length} business events dated within 12 months: contracts, sized launches and relocations, seasonal spikes, and signals that inform the plan without adding demand.`,
    '- Change the horizon to 3 months on any view: the figures, the balance and the events all move to 3 months together.',
    '',
    `## ${next()}. Why now (${eus.region_label} pool, 90 seconds)`,
    '',
    '- Open the pool. The chart shows utilization climbing toward the working ceiling; the markers show when capacity is needed, when the order was due and when it would land.',
    `- Scroll to "Why now". ${eus.flagged_count} of 14 funnels are flagged. **${eus.driver.name}** sets the date (${fmt(eus.dates.needed_by)}): ${eus.driver.headline} The plan shows as "${eus.driver.kind}".`,
    `- The lead time is ${eus.lead.weeks} weeks, not the ${data.vendorById['vendor-northwind'].quoted_lead_weeks} the vendor quotes: the vendor's last deliveries say so (Supply Chain funnel). So the order was due ${fmt(eus.dates.raise_by)}, ${eus.dates.overdue_days} days ago.`,
    `- The pool runs an end-of-life SKU, so the order is ${eus.what.order_sku}: ${cu(eus.order.quantity_cu)} for ${usd(eus.order.cost_usd)}. Open "How the order was sized" to show the arithmetic line by line.`,
    '',
    `## ${next()}. Change one assumption (What if, 30 seconds)`,
    '',
    `- In the What-if panel set the lead time to 8 weeks. The state changes from ${eus.state} to **${lead8.state}** and the raise-by date moves from ${fmt(eus.dates.raise_by)} to ${fmt(lead8.dates.raise_by)}. Nothing is saved. The point: most of the urgency is lead time, not demand.`,
    '',
    `## ${next()}. Utilization is not the whole story (90 seconds)`,
    '',
    `- Open ${label(sea)}: only ${pct(sea.capacity.utilization_of_usable)} utilized, yet it is **${sea.state}**. A single fabric segment produces most of the incidents (Reliability funnel, ${funnel(sea, 2).severity}). The plan is a ${cu(sea.order.quantity_cu)} replacement order by ${fmt(sea.dates.raise_by)}. It shows as "${sea.driver.kind}", not as demand.`,
    `- Open ${label(gpu)}: **${gpu.driver.name}** sets the date (${fmt(gpu.dates.needed_by)}). A contract is a hard trigger, and the order is ${gpu.state}, by ${fmt(gpu.dates.raise_by)}. The Technology Shift funnel adds guidance to weight new GPU orders toward the growing class.`,
    `- Open ${label(jpe)}: ${funnel(jpe, 3).headline} A launch spike (Seasonal funnel) sets the date at ${fmt(jpe.dates.needed_by)}, and the Competitive funnel is shown but never changes the plan.`,
    `- Open ${label(brs)}: a data-residency mandate (Geopolitical funnel) moves about 900 CU into the pool from ${fmt(brs.dates.needed_by)}, so the order is ${brs.state}, by ${fmt(brs.dates.raise_by)}.`,
    '- The **Funnels** page shows all 14 at once: a card per funnel with the pools it flags, and a 14 by 6 matrix. Every flagged cell opens the pool at the funnel that triggered it.',
    '',
    `## ${next()}. The seven layers (Ontology, 60 seconds)`,
    '',
    '- Open Ontology. Every pool is described in the same seven layers, and each row answers one question. Four layers are **recorded** (read straight from a data file) and three are **derived** (worked out from the others).',
    `- Read down the ${eus.region_label} column: ${cu(lv(eus.pool_id, 'infrastructure', 'installed_cu'))} installed, ${cu(lv(eus.pool_id, 'allocation', 'allocated_cu'))} reserved by teams, ${pct(lv(eus.pool_id, 'utilization', 'utilization'))} in use, ${cu(lv(eus.pool_id, 'gap-waste', 'reclaim_cu'))} that could be given back, an end-of-life SKU, a health score of ${lv(eus.pool_id, 'reliability', 'score').toFixed(1)}, and a plan that is **${lv(eus.pool_id, 'planning-horizon', 'state')}**. That is one pool told in seven layers, and the last row is the plan you have already seen.`,
    `- Now ${sea.region_label}: only ${pct(lv(sea.pool_id, 'utilization', 'utilization'))} in use, but a health score of ${lv(sea.pool_id, 'reliability', 'score').toFixed(1)} against a critical line of ${data.policy.reliability.critical_score} (worst segment ${lv(sea.pool_id, 'reliability', 'worst_segment')}). The health layer is why utilization alone is not the story.`,
    `- Select that pool. Seven cards give every value behind the row, the file it comes from and the funnels that read it. The gap and waste card shows ${cu(lv(sea.pool_id, 'gap-waste', 'reclaimable_cu'))} of idle reservation but counts ${cu(lv(sea.pool_id, 'gap-waste', 'reclaim_cu'))} as an opportunity, because it is below the flag threshold. That is why the reclaim total on Capacity Planning still adds up.`,
    '- The values are live: apply a scenario in the Lab and this page changes with it.',
    '',
    `## ${next()}. My requests (Capacity Planning, Demand view, 90 seconds)`,
    '',
    '- On the Demand view scroll to **Capacity request**: the same estate, seen by one requesting team, with its team and request pickers. It opens on the team that has a request at risk, with that request selected.',
    `- Read the line under the title: "${rq.recommendation.answer}" That is the whole answer. ${rq.requester.label} has ${rq.requests.counts.all} requests: ${rq.requests.counts.at_risk} at risk, ${rq.requests.counts.in_review} in review, ${rq.requests.counts.approved} approved, ${rq.requests.counts.completed} completed. Approved and completed ones are history and add no demand.`,
    `- The six cards, each with an (i): current usage ${cu(rk.current_usage.cu)} (${pct(rk.current_usage.share_of_allocated)} of the ${cu(rk.current_usage.allocated_cu)} the team holds in ${rq.selected.region}); total demand ${cu(rk.total_demand.cu)} at 12 months; additional required ${cu(rk.additional_required.cu)} of the ${cu(rk.additional_required.of_cu)} asked; status **${rk.request_status.label}**; revenue at risk ${usd(rk.business_impact.usd)}, as stated by the requester; and an estimated cost of ${usd(rk.est_cost.usd)}, the ordered part only, a one-off purchase and not an annual figure.`,
    `- The recommendation says what to do and why: "${rq.recommendation.headline}" The request is served in phases: what is free or idle now, what lands from supply already ordered, and what needs a new order. It claims no probability; it says what it rests on.`,
    `- The chart plots the team's demand (the ask joins on its need date), its usage trend, and the capacity it can count on as a step line that rises on each landing date. The call-out reads "${rq.forecast.callout.text}". Hover for any week; 3, 6 and 12 months redraw it.`,
    `- Below: the timeline, the requests table (click a row to open that request), its details and use case, what drives the demand (${rq.drivers.map((d) => `${d.label.toLowerCase()} ${d.share_pct}%`).join(', ')}), the business impact the requester stated, the team's utilization, the options (one is recommended: **${rq.options[0].option}**), the cost (${phaseLine}) and the risks.`,
    '- The view is live: approve the order on the East US pool, or apply a scenario in the Lab, and it changes with it. A request submitted on the Requests page shows up here under its team: open "About this request" on the form to add an organisation, use case, revenue at risk and so on, and the confirmation links straight to it here. Anything left blank reads "Not stated".',
    '',
    ...(ov.peak.available ? [
      `## ${next()}. Is the plan safe at the busiest hour? (Peak check, 60 seconds)`,
      '',
      '- The plan is sized on weekly means, but capacity has to cover the busiest hour of the week. On the Balance / plan view, scroll to "Is the plan safe at the busiest hour?".',
      `- On the weekly mean ${ov.peak.summary.mean_over_ceiling_now === 0 ? 'no pool is' : `${ov.peak.summary.mean_over_ceiling_now} pools are`} over the working ceiling. At the busiest hour ${ov.peak.summary.over_ceiling_now} of ${ov.peak.summary.pools} ${ov.peak.summary.over_ceiling_now === 1 ? 'is' : 'are'}. ${st.peak().pools.get(eus.pool_id).headline}`,
      `- If the working ceiling is meant for the busiest hour, ${ov.peak.summary.change_state} plans change state (${ov.peak.rows.filter((r) => r.changes_state).map((r) => `${r.region}: ${r.mean_state} to ${r.peak_state}`).join(', ') || 'none'}), and the estate would order ${num(ov.peak.summary.extra_cu)} CU more, costing ${usd(ov.peak.summary.extra_usd)} more, than the weekly plan asks for.`,
      '- Open East US: the ladder shows the weekly mean, the busiest hour, the working ceiling and the hourly model\'s forecast for next week on one scale, and the table sets the two plans side by side.',
      '- Nothing on any plan changed. Whether the working ceiling applies to the busiest hour is a policy decision for planners; the check shows what each answer costs. The ratio and the forecast come from the generated hourly corpus in `ml/`.',
      '',
      `## ${next()}. The decision (60 seconds)`,
    ] : [`## ${next()}. The decision (60 seconds)`]),
    '',
    `- On the ${eus.region_label} pool, enter a name. Try approving ${cu(eus.order.quantity_cu - 192)} without a reason: the system refuses and says why. Add a reason and approve. The order ORD-LAB-0001 enters the supply pipeline and the pool shows it in flight.`,
    '- Try the name `engine`: the engine that drafted the plan cannot approve it.',
    '- Open Decisions: the record is hash-chained, and the log integrity reads Verified. Each record also keeps what it was based on: the dataset, the forecast (with a fingerprint of the exact history and settings) and a fingerprint of the plan, because the engine refits on every load and would otherwise leave nothing to check a decision against.',
    '',
    `## ${next()}. What can be done, and who has to agree (Options and approval, 90 seconds)`,
    '',
    `- On the ${eus.region_label} pool, above the Decision panel, is **Options**. ${eusOpts.options.length} options are offered: ${eusOpts.options.map((o) => `**${o.title}**`).join(' and ')}.${eusOpts.notes.length ? ` ${eusOpts.notes[0]}` : ''} Each option that places an order is measured by running the plan again with that order in flight, so what it says is what approving it produces. The rule that recommends one is on the page: ${gOpts.rule}`,
    `- Open ${label(h100)}. The options are **${gOpts.options.map((o) => `${o.title} (${o.places_order ? `${cu(o.quantity_cu)}, ${usd(o.cost_usd)}` : 'nothing'})`).join('**, **')}**. The Decision panel already says what approving needs: ${gCheck.notes[0]}`,
    `- Approve as Asha Rao. No order is placed: ${gWaiting.decided_by}'s approval of ${cu(gWaiting.quantity_cu)} is waiting, the header says so, and the plan still shows the need. Enter the same name again and it is refused; enter Ben Ortiz and click **Countersign**, and only then does the order enter the supply pipeline. Declining or deferring withdraws a waiting approval. The lab has no sign-in, so a named person is a name that was typed: this is a control on the record and the workflow, not authentication.`,
    `- The budget is synthetic (${gBudget.budget.label.replace(/ \(synthetic\)/, '')}, ${usd(gBudget.budget.budget_usd)}), and so are the thresholds. With East US and the H100 order approved, ${usd(gBudget.budget.committed_usd)} is committed. Open ${label(jpe)}: the order as drafted (${cu(jDrafted.quantity_cu)}, ${usd(jDrafted.cost_usd)}) is ${usd(jDrafted.governance.over_budget_usd)} over the budget, so the recommendation is now **${jRec.title}**: ${cu(jRec.quantity_cu)} for ${usd(jRec.cost_usd)}, the most whole racks that fit${jRec.after.next_order ? `, leaving ${cu(jRec.after.next_order.quantity_cu)} still needed by ${fmt(jRec.after.next_order.raise_by)}` : ''}. **Use this option** fills in the Decision panel. Going over the budget is allowed, on a written reason.`,
    `- **Explain this plan** is now given more to work with, all of it produced by the engine, the planner or the rules above: what changed since the last decision or since the lab moved, the options and which one the rule recommends, what approving needs, the budget, what waiting costs, and why this priority. It explains; it never ranks or chooses. The ranking is fixed by the engine, and the advisor is told so: "${gFacts.priority_explained}" Every figure in its text is still checked against the plan.`,
    '',
    `## ${next()}. What happened next (Outcome and feedback, 90 seconds)`,
    '',
    `- On the rail open **Outcome**. Today in the lab is ${fmt(data.as_of)}, and the lab can move ${clockInfo.max_weeks} weeks: ${clockInfo.reason}`,
    '- Click **Advance 13 weeks**, then **Advance 4 weeks**. Before the world moves the lab writes down, for every pool, the forecast, the demand the plan counted and the plan as they stand. That record is what the future is held against. Then each pool gets new readings, the requests, contracts and events that fall due become usage (or do not), and supply arrives or slips.',
    `- The readings are generated: each pool follows its own recent trend with a hidden growth surprise (${Math.round(SURPRISE_MIN * 100)}% to +${Math.round(SURPRISE_MAX * 100)}% against its fitted trend) and noise as large as its own history. The forecast never sees the surprise, so it can be wrong. On top of the trend, whatever falls due becomes usage, or does not (below). The loop is real; the accuracy is not evidence about real usage.`,
    `- **Planned demand against actual.** The plan's demand is the forecast with the pipeline and the dated adds on top: what the orders were sized for. ${oc.summary.within_p80} of ${oc.summary.readings} weekly readings were at or under its p80 (${pct(oc.summary.within_p80 / oc.summary.readings)}), with an average error of ${oc.summary.mape_pct.toFixed(2)}%; the trend model on its own, held against the trend and the steps already in its history, was off by ${oc.summary.trend_mape_pct.toFixed(2)}%.${ocBand.length ? ` ${ocBand.map((p) => p.region_label).join(' and ')} was ${Math.abs(ocBand[0].forecast.bias_pct).toFixed(1)}% off on average but above p80 in ${ocBand[0].forecast.above_p80} of ${ocBand[0].forecast.readings} weeks: its band was too narrow. That is the red triangles on its chart.` : ''} Each week is held against the plan recorded most recently before it, not one refitted afterwards.`,
    `- **What fell due.** ${oc.summary.dated.fell_due} requests, contracts and events fell due and ${oc.summary.dated.happened} happened. The plan counted ${cu(oc.summary.dated.plan_cu)} of them; ${cu(oc.summary.dated.realized_cu)} showed up.${datedReq ? ` ${datedReq.id} asked for ${cu(datedReq.asked_cu)}; the plan counted ${cu(datedReq.plan_cu)} (its likelihood, less the overlap discount); it went live and ${cu(datedReq.realized_cu)} showed up.` : ''}${datedLapsed ? ` ${datedLapsed.id} (${cu(datedLapsed.asked_cu)}) did not go ahead: the plan had counted ${cu(datedLapsed.plan_cu)} of it.` : ''} Whether each one happens is decided by draws the plan never sees, so the plan can be wrong. A settled item leaves the pipeline, because its usage is in the readings now. The **What fell due** card on the page lists every one.`,
    `- **Supply.** ${arrival ? `${arrival.order_id} (${arrival.region}) was due ${fmt(arrival.planned_lands_on)} and landed ${fmt(arrival.landed_on)}, ${arrival.slip_weeks === 0 ? 'on time' : `${Math.abs(arrival.slip_weeks)} week${Math.abs(arrival.slip_weeks) === 1 ? '' : 's'} ${arrival.slip_weeks > 0 ? 'late' : 'early'}`}, adding ${cu(arrival.units_added)} to the pool.` : 'No order reached its date.'}${slipped.length ? ` ${slipped.map((o) => `${o.order_id} (${o.region}) was due ${fmt(o.planned_lands_on)}; its day passed, and the vendor's new date is ${fmt(o.lands_on)}.`).join(' ')}` : ''} How far an order strays comes from the vendor's own delivery history.`,
    `- **The approved order.** ${oc.decisions.length ? `${oc.decisions[0].decision_id} was placed with the vendor on its date (status: ${oc.decisions[0].order_status}) and is not here yet. When it was written down, ${ocEus.region_label} was **${ocEus.plan.then.state}** because that order covered the need; it now reads **${ocEus.plan.now.state}**${ocEus.plan.now.order_needed ? `, needing ${cu(ocEus.plan.now.quantity_cu)} more` : ''}.` : 'None was approved.'}`,
    `- **Plans, then and now.** ${oc.summary.plans_changed} of ${oc.summary.pools} plans changed; ${oc.summary.overdue_then} pool${oc.summary.overdue_then === 1 ? ' was' : 's were'} overdue then and ${oc.summary.overdue_now} ${oc.summary.overdue_now === 1 ? 'is' : 'are'} now.${ocLate ? ` Where nothing was done, waiting shows as an order that lands later: ${ocLate.region_label}'s now lands ${fmt(ocLate.plan.now.lands_on)}, ${ocLate.plan.lands_later_weeks} weeks after ${fmt(ocLate.plan.then.lands_on)}.` : ''}`,
    '- The whole lab moves with it: every page shows the world as of the new date, an **Advanced** marker sits in the header, and the busiest-hour check steps aside (its profile was measured on the shipped history). Reset lab on the Lab page puts today back.',
    '',
    `## ${next()}. In plain words (optional, 45 seconds)`,
    '',
    '- On the East US pool click **Explain this plan**. With Azure OpenAI configured, a model re-tells the finished plan and drafts the request; without it, the same panel writes rules-based text from the same facts. Either way it now says what changed, which option the rule recommends and what the alternatives are.',
    '- Every date, SKU and number in the AI text is checked against the plan. Text that fails is withheld and the rules-based text is shown instead. The model cannot change a date, quantity or SKU.',
    '',
    `## ${next()}. Reset`,
    '',
    '- Lab page, "Reset lab data" (or `npm run reset`). The seed data is never modified, so the baseline is exactly as shipped.',
    '',
    '## What to say if asked',
    '',
    '- **Is this Microsoft data?** No. Every record is generated and labelled `source: "synthetic"`; the loader refuses anything else.',
    '- **Is it AI?** The demand forecast is a fitted model, backtested against a straight line. Every other funnel is a rule on a record, so every number is deterministic and traceable. There is no LLM in the decision path. An optional Azure OpenAI explainer re-tells the finished plan in plain words and drafts the request; it cannot change a date, quantity or SKU, and every figure in its text is checked against the plan.',
    '- **Why 14 funnels?** They are the 14 in the Engineering Requirements. Each is independent and any one can flag a pool even when the others say it is healthy.',
    '- **Why is the total lower than adding up the pools?** Each pool plans at p80. For a group to miss at its p80, its pools would have to miss on the high side together; pools whose errors do not move together partly cancel. The Overview combines the pools as one forecast, using how much their weekly movements go the same way (measured from the data, never taken below zero), so a region\'s or the total\'s p80 sits below the sum of its pools\' p80s. In a simulated test the combined p80 covers about 80% of outcomes whether the pools\' errors are unrelated or move together, while adding the p80s over-covers badly when they are unrelated. A single pool, and every pool\'s own plan, orders and shortfall, are unchanged.',
    '- **Does the plan use the busiest hour?** No. It uses weekly means, as the requirements do, and the Overview says so. The peak check shows what the plan would ask for if the working ceiling were applied to the busiest hour. It appears only when `npm run ml` has built the peak profile, and its figures come from generated hourly data.',
    '- **Where are the seven ontology layers?** On the Ontology page, with each layer\'s live value for every pool, the file it comes from and the funnels that read it. Four are recorded (infrastructure, allocation, utilization, SKU lifecycle) and three are derived (gap and waste, reliability and health, planning horizon).',
    '- **The Overview follows the customer wireframe. What is different?** Every figure comes from this lab\'s own synthetic estate, not the mockup\'s. Four regions, not eight (the data has no Middle East pools). No confidence percentage: the engine does not produce one, so a recommendation says what kind of planning set it and how many funnels converge. "Effective capacity" is provisioned capacity times the working ceiling; there is no disaster-recovery figure. Inventory covers GPU and Compute only, with no Storage or Networking. The region map is a simple world outline with a dot per region, not a street map. There is no Methodology or Settings page, and no "last 12 weeks" filter.',
    '- **The Product Team (Requester) view follows a wireframe too. What is different?** It is its own page, My Capacity Overview, built from the same records and the same request assessment as the planner. There is no AI confidence percentage: the recommendation is rules over the plan and says what it rests on. Cost is a one-off purchase cost, not the annual or monthly figure the mockup shows, because the lab has no operating-cost data. There is no "vs last month" change on current usage (no team usage history is kept), only demand against the forecast as it stood a quarter ago. Revenue at risk, customer commitment, SLA impact and strategic importance are what the requester wrote on the request, never estimated. Drivers, options and risks are derived from the plan and the funnels. Whether a workload can run in another region is not known, so the other-region options say so.',
    `- **What would it take to run on real data?** Replace the 14 files in \`data/\` with extracts in the same shape (see docs/DATA.md). The engine, the API and the screens do not change.`,
    '',
  ].join('\n');

  return { 'docs/FUNNELS.md': funnels, 'docs/DEMO-SCRIPT.md': demo, 'docs/CONTRACTS.md': contractsDoc(data, verdicts) };
}

// ------------------------------------------------------------ CONTRACTS.md
const specText = (s) => {
  if (typeof s === 'string') return s.endsWith('?') ? `${s.slice(0, -1)} (optional)` : s;
  if (Array.isArray(s)) return `one of ${s.join(' / ')}`;
  if ('$each' in s) return `list of ${specText(s.$each)}`;
  return `{ ${Object.entries(s).map(([k, v]) => `${k}: ${specText(v)}`).join(', ')} }`;
};
const fieldsText = (fields) => Object.entries(fields).map(([k, v]) => `\`${k}\`: ${specText(v)}`).join('; ');

const FORECAST_FIELDS = {
  contract: 'Shape version of this object (`forecast/1`). Bumped when a field is added, removed or changes meaning.',
  horizon_weeks: 'How many weeks ahead `p50`, `upper` and `lower` run.',
  interval: 'The band `upper` is: `upper_quantile` (about 0.8) and the multiplier `z`. A band around the middle path. It is not the probability that a plan is right.',
  input: 'What was fitted: number of weeks, the latest reading, the window, the backtest origins.',
  input_hash: 'A fingerprint of the history, the settings and any hand-set slope. Same fingerprint, same forecast.',
  model: '`linear` or `holt`, with a note when the slope was set by hand.',
  why: 'One sentence on why that model.',
  slope_per_week: 'The trend, in CU per week.',
  latest: 'The latest weekly reading, in CU.',
  p50: 'The middle path for weeks 1 to 104 (index 0 is week 1).',
  upper: 'The planning path (p80), same indexing.',
  lower: 'The lower path, same indexing. Produced, and read by nothing downstream.',
  resid_sd: 'Residual standard deviation of the fit.',
  backtest: 'The rolling-origin backtest: horizon, origins, linear and Holt error, and the model chosen.',
  overridden: 'True when a what-if set the slope.',
};
const VERDICT_FIELDS = {
  pool_id: 'The pool.', region: 'Region key.', region_label: 'Region name.', datacenter_id: 'Data centre.', sku_id: 'The pool\'s SKU.', sku_label: 'SKU name.',
  sku_class: 'SKU class.', workload_type: 'Workload type.', state: 'OK, WATCH, PLAN, ORDER NOW or OVERDUE.', priority: 'low, medium, high or critical.',
  capacity: 'Installed, usable now, allocated, free, utilized, and the working ceilings.', forecast: 'Which forecast the plan was built on (model, contract, interval, input fingerprint), and `level_shifts`: the known steps and spikes looked for in the history before fitting, which were taken out and which were left alone.',
  dates: 'Need-by, raise-by, lands-on, covered-until, days overdue, weeks short.', lead: 'Lead time in weeks and where each week came from.',
  what: 'The order SKU, the conversion, the unit cost and rack size.', order: 'Whether an order is needed, its size and cost, the arithmetic line by line, and orders in flight.',
  horizons: 'Good, act or at-risk for 3, 6 and 12 months.', driver: 'The funnel that sets the date, and whether it is standard planning or a funnel-triggered override.',
  reclaim: 'Idle reserved capacity that could be freed instead.', headline: 'The plan in a sentence.', reasons: 'Why, in sentences.', flagged_count: 'Funnels flagged.',
  quiet_count: 'Funnels quiet.', trace: 'What each of the 14 funnels did to the plan, with evidence and the feed behind it.', funnels_summary: 'One line per funnel: number, status, severity.',
};
const SNAPSHOT_FIELDS = {
  origin_weeks: 'How many weeks the lab had already advanced when this was written down (0 for the shipped date).',
  origin_as_of: 'The lab\'s "today" at that moment.',
  pools: 'One entry per pool, below.',
  forecast: 'The forecast at that moment: `model`, the fingerprint of the data it was fitted on (`input_hash`), and the middle path (`p50`) and planning path (`upper`, p80) for the next 52 weeks, rounded to whole CU.',
  demand: 'The demand the plan counted, for the next 52 weeks, rounded to whole CU: `p50` is the forecast middle path plus the pipeline, the dated adds and the seasonal spike; `p80` is the timeline\'s `plan_p80`. This is what an actual is held against.',
  plan: 'The plan at that moment: state, whether an order is needed, its size and cost, need-by, raise-by, lands-on, covered-until, and the headline.',
  capacity: 'Installed capacity and the capacity usable now.',
  in_flight: 'Each order in flight: id, CU and planned landing date.',
};
const OPTION_FIELDS = {
  key: 'A stable id: `as-drafted`, `phase`, `fit-budget`, `wait`.', title: 'The option in a few words.', summary: 'One or two sentences with the figures.', tradeoff: 'What it costs the person choosing it.',
  places_order: 'False only for `wait`.', quantity_cu: 'The order, in whole racks (0 for `wait`).', cost_usd: 'Quantity at the order SKU\'s unit cost.', raise_on: 'The day the order would be placed.', lands_on: 'When it lands.',
  weeks_late: 'Weeks after the need date that capacity lands.', after: 'What the plan says once this order is in flight: the real plan engine, run again. `state`, `needs_next_order`, `next_order` (size, raise-by, lands-on) and `covered_until`.',
  governance: 'What approving it needs: `needs_second_approver`, `over_budget_usd`, `budget_after_usd`.', covers_until: 'How long the order lasts, from the plan (absent for `wait`).',
  recommended: 'Exactly one option is true, by the stated rule.', fits_budget: 'False when approving it would go over the budget.',
};
const RECORD_FIELDS = {
  decision_id: 'Sequential id.', pool_id: 'The pool.', decision: '`approve`, `decline` or `defer`.', decided_by: 'A typed name. The lab has no sign-in.', decided_at: 'Wall-clock time of the decision.',
  reason: 'Required to change the quantity, go over the budget, decline or defer.', disputed_funnel: 'A funnel the person disputes, if any.', quantity_cu: 'What was approved (approvals only).',
  override: 'True when the quantity differs from the drafted one.', drafted: 'The plan as drafted at that moment: state, quantity, cost, SKU, dates, driver.', as_of: 'The lab\'s "today" then.',
  policy_version: 'The policy in force.', basis: 'What the decision was based on (below).', cost_usd: 'Quantity at the unit cost (approvals only).',
  approval: '`required` (1 or 2), `state` (`complete` or `awaiting-second`), the threshold, and for a countersignature who gave the first approval.', budget: 'The budget, what was committed before, and any amount over it.',
  countersigns: 'On a second approval: the id of the first.', cancels: 'On a decline or defer: the id of the waiting approval it withdrew.',
  prev_hash: 'The hash of the record before.', hash: 'SHA-256 over everything above (not `order_id`).', order_id: 'The order placed (only when the approval is complete). Not part of the hash.',
};
const BASIS_FIELDS = {
  dataset_version: 'Which dataset.', advanced_weeks: 'How far the lab had been moved.', forecast: '`contract`, `model` and `input_hash`: which forecast, exactly.',
  plan_hash: 'A fingerprint of the plan: state, order, dates, lead time, forecast, capacity and every funnel\'s status and severity.', lead_weeks: 'The lead time used.', driver: 'The funnel that set the date.', funnels: 'Number, status and severity for all 14.',
};
const SHIFT_FIELDS = {
  shape: '`step` (a permanent jump: a request that went live, a contract in effect, a sized launch or relocation) or `spike` (a seasonal event: raised for its duration, then back).',
  ids: 'The records that name it. Steps in the same weekly reading are one jump and list all their ids.', kinds: '`request`, `contract` or `event`.', labels: 'Their titles.',
  date: 'The date on the record.', week_start: 'The first weekly reading that could include it.', reading: 'That reading\'s place in the history (0 is the oldest).',
  weeks: 'Spikes only: how many weeks of it are in the history so far (a spike still running counts only the weeks that have happened).',
  size_cu: 'Its size in CU, measured from the readings (a step down is negative). Null when there was too little history to measure.',
  sigmas: 'How many standard deviations of the trend before it that size is. It counts at 3 or more.', applied: 'True when it was taken out of the history.',
  reason: 'When it was left alone: why (too little history, or not clearly above the noise).',
};
const PLANNING_ROW_FIELDS = {
  pool_id: 'The pool.', region: 'Its region.', sku_id: 'Its SKU.', geo: 'The geography the Overview groups it under.',
  supply_cu: 'Installed usable capacity plus every order in flight that lands by the horizon, in the pool\'s own units.',
  ceiling_cu: 'Supply times the pool\'s working ceiling (85% general, 80% GPU, lower where users already feel strain).',
  demand_cu: 'The demand we plan for at the horizon: the timeline\'s `plan_p80`.', balance_cu: 'Ceiling less demand. Negative is a shortfall. A surplus in one pool does not cover another.',
  demand_share: 'Demand over supply.', status: '`short` (demand over the ceiling), `tight` (at or above the watch share of supply, under the ceiling) or `ok`.',
  state: 'The pool\'s plan state.', order: 'The order that closes the gap (`quantity_cu`, `cost_usd`, `raise_by`, `lands_on`, `sku`), or null.', headline: 'The plan in a sentence.',
};
const FACT_FIELDS = {
  what_changed: 'Since the last decision on this pool (from its `basis`) and since the lab was moved (from the ledger).', options: 'The planner\'s options as strings, one marked recommended.',
  options_not_offered: 'Why an option is missing (phasing on a late pool; a budget that cannot buy the vendor\'s minimum).', how_recommended: 'The rule that recommends one.', approval_needed: 'What approving would need: a second person, a reason for the budget.',
  budget: 'Committed, total and remaining, and that both are synthetic.', if_it_changed: 'The same plan under two assumptions.', cost_of_waiting: 'What waiting four weeks does.', priority_explained: 'The rank and how it is decided. The ranking is the engine\'s; the advisor may only explain it.',
};
const LAYER = {
  forecast: ['fc', 'p50At', 'upperAt', 'pipelineAt', 'demandBase', 'knownAddsAt', 'seasonalSpikeAt', 'planDemandAt', 'spreadAt', 'crossing'],
  capacity: ['usableAt', 'usable0', 'freeNow', 'allocatedNow', 'floor', 'factor', 'orderSku', 'hOf', 'dateOf'],
};

function contractsDoc(data, verdicts) {
  const pools = data.pools.map((p) => p.pool_id);
  const usd0 = (x) => Math.round(x).toLocaleString('en-US');

  // What each funnel actually touches, found by running it against a context that records every member it reads.
  const touched = Object.fromEntries(REGISTRY.map((f) => [f.number, new Set()]));
  const emitted = Object.fromEntries(REGISTRY.map((f) => [f.number, new Set()]));
  for (const id of pools) {
    const ctx = buildContext(data, id);
    for (const f of REGISTRY) {
      f.evaluate(new Proxy(ctx, { get(t, k, r) { if (typeof k === 'string') touched[f.number].add(k); return Reflect.get(t, k, r); } }));
    }
    for (const r of runFunnels(ctx)) for (const p of r.proposals) emitted[r.number].add(p.kind);
  }
  const reads = (n, layer) => LAYER[layer].filter((k) => touched[n].has(k));
  const readsForecast = REGISTRY.filter((f) => reads(f.number, 'forecast').length).map((f) => f.number);
  const recordsOnly = REGISTRY.filter((f) => !reads(f.number, 'forecast').length).map((f) => f.number);
  const emitters = (kind) => REGISTRY.filter((f) => emitted[f.number].has(kind)).map((f) => f.number).join(', ') || 'none at baseline';

  // The forecast object as it really is, so the field list cannot drift from the code.
  const fc = buildContext(data, pools[0]).fc;
  for (const k of Object.keys(fc)) if (!FORECAST_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: the forecast has a field "${k}" the document does not describe. Add it to FORECAST_FIELDS in scripts/make-docs.js.`);
  for (const k of Object.keys(verdicts[0])) if (!VERDICT_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: the plan has a field "${k}" the document does not describe. Add it to VERDICT_FIELDS in scripts/make-docs.js.`);

  // The ledger entry as it really is, so the field list cannot drift from the code.
  const ledgerStore = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null });
  const snapshot = takeSnapshot(ledgerStore.data(), ledgerStore.all(), 0);
  for (const k of [...Object.keys(snapshot), ...Object.keys(snapshot.pools[pools[0]])]) if (!SNAPSHOT_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: the ledger snapshot has a field "${k}" the document does not describe. Add it to SNAPSHOT_FIELDS in scripts/make-docs.js.`);

  // The planner's options, the decision record and the advisor's facts, as they really are, so the field lists cannot drift from the code.
  const govStore = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null });
  const optKeys = new Set();
  for (const id of [pools[0], 'pool-westeurope-02-gpu-h100']) for (const o of buildOptions(govStore, id).options) Object.keys(o).forEach((k) => optKeys.add(k));
  decide(govStore, pools[0], { decision: 'approve', decided_by: 'Asha Rao' });
  const twoStep = decide(govStore, 'pool-westeurope-02-gpu-h100', { decision: 'approve', decided_by: 'Asha Rao' }).record;
  const counter = decide(govStore, 'pool-westeurope-02-gpu-h100', { decision: 'approve', decided_by: 'Ben Ortiz' }).record;
  const recordKeys = new Set([...Object.keys(counter), 'cancels']);
  const factKeys = new Set([...Object.keys(advisorFacts(govStore, 'pool-japaneast-01-gpu-l40s')), 'options_not_offered']);
  for (const k of optKeys) if (!OPTION_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: an option has a field "${k}" the document does not describe. Add it to OPTION_FIELDS in scripts/make-docs.js.`);
  for (const k of recordKeys) if (!RECORD_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: a decision record has a field "${k}" the document does not describe. Add it to RECORD_FIELDS in scripts/make-docs.js.`);
  for (const k of Object.keys(twoStep.basis)) if (!BASIS_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: a decision basis has a field "${k}" the document does not describe. Add it to BASIS_FIELDS in scripts/make-docs.js.`);
  for (const k of factKeys) if (!FACT_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: the advisor has a fact "${k}" the document does not describe. Add it to FACT_FIELDS in scripts/make-docs.js.`);
  const policyApproval = data.policy.approval;

  // The known effects taken out of a history, as they really are (a world 21 weeks on has steps; one 12 weeks on has a spike).
  const shiftStore = createStore({ dataDir: path.join(ROOT, 'data'), statePath: null });
  shiftStore.advanceTime(21);
  const shiftKeys = new Set();
  for (const a of shiftStore.all()) for (const s of a.ctx.shifts) Object.keys(s).forEach((k) => shiftKeys.add(k));
  for (const k of shiftKeys) if (!SHIFT_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: a level shift has a field "${k}" the document does not describe. Add it to SHIFT_FIELDS in scripts/make-docs.js.`);
  for (const k of ['shape', 'ids', 'size_cu', 'applied', 'weeks']) if (!shiftKeys.has(k)) throw new Error(`docs/CONTRACTS.md: no level shift in the demo world carries "${k}", so the document could not be checked against the code.`);

  // Planning, as it really is: the twelve figures and the balance rows, so the document cannot drift from the code.
  const planning = buildPlanning(createStore({ dataDir: path.join(ROOT, 'data'), statePath: null }), {});
  for (const k of Object.keys(planning.balance.rows[0])) if (!PLANNING_ROW_FIELDS[k]) throw new Error(`docs/CONTRACTS.md: a balance row has a field "${k}" the document does not describe. Add it to PLANNING_ROW_FIELDS in scripts/make-docs.js.`);
  const planningTiles = [...planning.supply.tiles.map((t) => ({ ...t, view: 'Supply' })), ...planning.demand.tiles.map((t) => ({ ...t, view: 'Demand' }))];

  // The one place the three demand definitions visibly differ.
  const jpe = data.pools.find((p) => p.pool_id === 'pool-japaneast-01-gpu-l40s');
  const jctx = buildContext(data, jpe.pool_id);
  const jprops = runFunnels(jctx).flatMap((r) => r.proposals.map((p) => ({ ...p, funnel: r.id })));
  const jv = verdicts.find((v) => v.pool_id === jpe.pool_id);
  const coverEnd = jv.order.cover_until_week;
  const jz = sizingDemand(jctx, jprops, coverEnd);
  const jEvent = jctx.events.find((e) => e.signal === 'seasonal');

  return [
    '# The data contracts',
    '',
    'Generated by `npm run docs` from the engine. Do not edit by hand. `npm test` fails if this file drifts from the code, and `test/contracts.test.js` checks every claim below against the running engine.',
    '',
    'The flow, and the contract at each arrow:',
    '',
    '```',
    'OBSERVE            15 files, validated at load                              server/lib/validate.js, data.js',
    '   |  (1) input contract: every field the engine reads is declared and checked',
    'FORECAST           weekly utilization -> p50 / p80 / trend                   server/lib/forecast.js',
    '   |  (2) forecast contract: forecast/1',
    'PLANNING CONTEXT   demand + capacity, week by week, one timeline           server/lib/timeline.js, context.js',
    '   |  (3) planning-timeline/1',
    '14 FUNNELS         each returns status + evidence + severity + proposals    server/lib/funnels.js',
    '   |  (4) funnel-to-plan contract: checked on every result',
    'PLAN ENGINE        composition: need date, quantity, SKU, lead time, cost   server/lib/verdict.js',
    '```',
    '',
    'Two facts about the flow that the diagram alone would hide:',
    '',
    `- **It is not a single chain.** ${readsForecast.length} of the 14 funnels (${readsForecast.join(', ')}) read the forecast, all through the demand series below. The other ${recordsOnly.length} (${recordsOnly.join(', ')}) read only records and policy, so they sit directly on OBSERVE.`,
    '- **"Demand" is not the forecast alone.** It is the forecast plus the request pipeline plus dated step-ups. That join is the planning timeline, stated once in `timeline.js`.',
    '',
    '## 1. OBSERVE: what the engine will accept',
    '',
    'Every file must say `source: "synthetic"` and carry a `dataset_version`. A file that fails any rule below stops the boot, and the error names the file and the field. Rules: `posint` a whole number above 0, `nonnegint` a whole number of 0 or more, `positive` a number above 0, `nonneg` a number of 0 or more, `share` a number from 0 to 1.',
    '',
    '| File | Fields the engine reads, and their rules |',
    '|---|---|',
    ...Object.entries(SCHEMAS).map(([file, fields]) => `| \`${file}\` | ${fieldsText(fields)} |`),
    ...Object.entries(SINGLETONS).map(([file, fields]) => `| \`${file}\` (one object) | ${fieldsText(fields)} |`),
    '',
    'Events carry different fields for different signals. A missing one used to become NaN, which compares false, so the funnel proposed nothing and the plan quietly lost the event. Now each is required:',
    '',
    '| Signal | Also required |',
    '|---|---|',
    ...Object.entries(EVENT_RULES).map(([signal, fields]) => `| ${signal} | ${Object.keys(fields).length ? fieldsText(fields) : 'nothing more'}${signal === 'strategic' ? '; `magnitude_cu` (positive) when `effect` is `demand`' : ''} |`),
    '',
    'An event\'s `scope` must name at least one of `estate`, `pool_id`, `region`, `sku_class`, `sku_class_group`, and must reach at least one pool.',
    '',
    `Across files the loader also checks: every \`pool_id\` resolves; each pool has at least ${data.policy.forecast.window_weeks} consecutive weekly readings ending on \`as_of\`; segments add up to the pool's capacity; reservations add up to the latest reading; a successor SKU has an equivalence factor; a failover pool is another pool in the estate; an order does not land before it is placed; and the policy's paired values are in order (for example \`region_watch\` below \`region_at_risk\`).`,
    '',
    'Not modelled: a per-record source or observation time. A data feed (`feeds.json`) has a last-delivered date and an owner, and staleness is judged per feed, not per record.',
    '',
    '## 2. FORECAST: what comes out',
    '',
    'Input: one pool\'s weekly `utilized_units`, oldest first, in CU, with the `policy.forecast` settings. Output, exactly these fields:',
    '',
    '| Field | Meaning |',
    '|---|---|',
    ...Object.keys(fc).map((k) => `| \`${k}\` | ${FORECAST_FIELDS[k]} |`),
    '',
    `Read through \`p50At(h)\` and \`upperAt(h)\`: \`h = 0\` is the latest reading, \`h\` from 1 to ${fc.horizon_weeks} indexes the paths, and a larger \`h\` clamps to the last week. \`upper\` is the middle path plus ${fc.interval.z} standard deviations of the fit's own error, the ${fc.interval.upper_quantile.toFixed(2)} quantile of a normal error. It is a band around the middle path, not a confidence that a plan is right; the engine produces no such probability.`,
    '',
    '**Known effects are taken out of the history first** (`server/lib/shifts.js`). A step that has already happened (a request that went live, a contract that took effect, a sized launch whose date has passed) and a seasonal spike that has come and gone must not be read as growth: left in, a step raises the trend and a spike inflates the noise for as long as it stays in the window. Where a record names one, the engine looks for it in the history and measures its size from the readings themselves: where the trend of the 12 readings before it was heading, against where the readings from then on are (the median of 3 for a step, of the weeks it covers for a spike). Nothing recorded about the size is read: the lab keeps what it generated (`realized_cu`) apart, and `test/shifts.test.js` proves the forecast does not move when it changes. It counts only if it clears the noise: 3 residual standard deviations of that trend, never less than half a percent of the level. A step is taken out by raising every earlier reading by it, so the history sits at today\'s level and the forecast starts from the level actually read; a spike by lowering the weeks it covered. They are taken oldest first, each on a history with the earlier ones already out, and steps in the same week are one jump. `input_hash` is of the history after this, so a plan names exactly what it was fitted on, and on a history with no such record it is the readings as they are and nothing changes (the golden fixture pins that). The forecast as it stood 13 weeks ago uses only the effects that had happened by then. The plan\'s `forecast.level_shifts` says what was found and what was left alone and why, one object per effect:',
    '',
    '| Field | Meaning |',
    '|---|---|',
    ...[...shiftKeys].map((k) => `| \`${k}\` | ${SHIFT_FIELDS[k]} |`),
    '',
    'What it cannot see: a step or spike that no record names is still read as growth; a step under about three noise deviations is left as noise (on the shipped data East US\'s 275 CU and 296 CU steps are, at 2.6 and 2.7); and a spike still running counts only the weeks so far.',
    '',
    '## 3. PLANNING CONTEXT: the unified planning timeline',
    '',
    '`GET /api/pools/{id}/timeline` returns it: one row per week, 0 to 104, for one pool. Every series below is a column.',
    '',
    '| Series | Meaning | From | Read by |',
    '|---|---|---|---|',
    ...SERIES.map((s) => `| \`${s.key}\` | ${s.means} | ${s.from} | ${s.read_by} |`),
    '',
    'The header carries the rules the plan is built with (working ceiling, cover window, buffer), the lead time (quoted, observed p80, default), the order SKU and its unit cost, the orders in flight, and the fingerprint of the forecast it was built on.',
    '',
    '### Three definitions of "demand at week h"',
    '',
    'They use the same building blocks with three rules about what counts. This was true before and was written down nowhere.',
    '',
    '| Name | Used for | Rule |',
    '|---|---|---|',
    '| `base_p80` | Funnels finding a date | organic p80 + pipeline |',
    '| `sizing` | The plan engine ordering, at the end of the cover window | organic p80 + pipeline + every `add_demand` a funnel proposed that starts by then. A `temporary` buffer counts even if its event has ended by then. |',
    '| `coverage` | How long an order lasts | `base_p80` + the permanent `add_demand` proposals that have started. Temporary buffers are excluded. |',
    '| `plan_p80` | The fleet views | `base_p80` + dated step-ups + a seasonal spike only while its event runs |',
    '',
    `They agree except where a temporary buffer has ended. On ${jpe.region_label} the ${jEvent.title} runs ${jEvent.duration_weeks} weeks from week ${jctx.hOf(jEvent.date)}, and is over by week ${jctx.hOf(jEvent.date) + jEvent.duration_weeks}. The order is sized at week ${coverEnd} and still counts its ${usd0(jz.tempTotal)} CU buffer: sizing is ${usd0(jz.totalDemand)} CU, and \`plan_p80\` at that week is ${usd0(jctx.planDemandAt(coverEnd))} CU. That is deliberate: the order is sized to be safe when the event arrives.`,
    '',
    '## 4. THE 14 FUNNELS: what goes in, what comes out',
    '',
    'A funnel is a function of the planning context. It never reads another funnel. What each one reads, found by running it on every pool and recording every member it touched:',
    '',
    '| # | Funnel | Reads the forecast | Capacity it reads | Records it reads |',
    '|--:|---|---|---|---|',
    ...REGISTRY.map((f) => `| ${f.number} | ${f.name} | ${reads(f.number, 'forecast').length ? `yes (${reads(f.number, 'forecast').join(', ')})` : 'no'} | ${reads(f.number, 'capacity').join(', ') || 'none'} | ${f.sources.map(([file]) => `\`${file}\``).join(', ')} |`),
    '',
    'Every funnel returns a **result**:',
    '',
    '| Field | Rule |',
    '|---|---|',
    ...Object.entries(RESULT_FIELDS).map(([k, v]) => `| \`${k}\` | ${specText(v)} |`),
    '',
    'and these rules: `flagged` is true exactly when `status` is `flagged`; a funnel that is not flagged has severity `none` and proposes nothing; a `context_only` funnel is flagged and proposes nothing (competitive intel: shown, never used).',
    '',
    'Each **proposal** is one of these kinds. The plan engine reads nothing else from a funnel. `plan` means it becomes a date, a size, a lead time, a ceiling or a reclaim figure; `guidance` is shown to the planner and changes no number.',
    '',
    '| Kind | Effect | Fields | What the plan engine does with it | Emitted at baseline by funnel |',
    '|---|---|---|---|---|',
    ...Object.entries(PROPOSAL_KINDS).map(([kind, k]) => `| \`${kind}\` | ${k.effect} | ${fieldsText(k.fields)} | ${k.means} | ${emitters(kind)} |`),
    '',
    '**What happens on a violation.** Every result is checked against the rules above before the plan engine sees it. A funnel that breaks them (an unknown kind, a missing or non-numeric field, a date that is not a date) is shown as **no data: this funnel returned output that breaks its contract**, with the reason, exactly as a funnel that throws is. Before this check, a mistyped kind was skipped and its funnel\'s need-by date silently dropped out of the plan. `compose()` itself refuses an unknown kind.',
    '',
    '## 5. PLAN ENGINE: what comes out',
    '',
    'One plan per pool, with these top-level fields:',
    '',
    '| Field | Meaning |',
    '|---|---|',
    ...Object.keys(verdicts[0]).map((k) => `| \`${k}\` | ${VERDICT_FIELDS[k]} |`),
    '',
    'The rules that make it (also in `verdict.js`): the need-by date is the earliest any funnel proposes; the lead time is the vendor\'s quote, replaced by what it really delivers, plus risk buffers; the quantity is the demand at the end of the cover window over the working ceiling, less capacity that will exist by then, plus replacements and a buffer, rounded up to whole racks; the SKU is the successor if the pool\'s is end-of-life. Nothing there is a model: the same data always gives the same plan.',
    '',
    '## 6. OUTCOME and FEEDBACK: the record that lets the future be held against the past',
    '',
    'The engine refits the forecast every time it loads, so once time has moved there is nothing left to compare the actuals with. So every time the lab advances, the store first writes down a **snapshot** of what is predicted and planned at that moment, and keeps it in `runtime/state.json` (the `ledger`). The comparison on the Outcome page (`GET /api/outcome`) is that record subtracted from what was generated. Nothing in it is a model.',
    '',
    '| Snapshot field | Meaning |',
    '|---|---|',
    ...Object.keys(snapshot).map((k) => `| \`${k}\` | ${SNAPSHOT_FIELDS[k]} |`),
    ...Object.keys(snapshot.pools[pools[0]]).map((k) => `| \`pools.{id}.${k}\` | ${SNAPSHOT_FIELDS[k]} |`),
    '',
    'Each generated week is held against the **demand the plan counted** in the most recent snapshot written before it, at the horizon it was ahead: the forecast with the pipeline, the dated adds and the seasonal spike on top, because that is what the orders were sized for. So after two advances, weeks 1 to 4 are measured against the first plan and weeks 5 to 8 against the second, which had seen the first four actuals. The trend model on its own is held against the trend part of the actuals (the trend plus the steps that had already happened when the plan was written, before any later dated demand, any spike or the cap) and reported beside it, so a forecast that was wrong can be told apart from a plan that guessed wrong about a request.',
    '',
    '**The clock** (`server/lib/clock.js`) is a pure function of the data and the number of weeks: the same weeks always give the same world, and 4 weeks then 4 more equals 8. It changes the working copy only; the shipped data is never written.',
    '',
    '| What moves | How |',
    '|---|---|',
    `| Utilization | \`weeks\` new actual readings per pool: the pool's own fitted trend, times a hidden growth surprise between ${Math.round(SURPRISE_MIN * 100)}% and +${Math.round(SURPRISE_MAX * 100)}% that the forecast never sees, plus noise as large as the pool's own history, plus whatever dated demand has fallen due (below), never more than the pool can hold that week. Generated, not measured. |`,
    '| Dated demand | A request, a contract or an event that falls due becomes usage, or does not. See the table below. |',
    '| Reservations | Each team keeps its share of the pool\'s usage, so the records still add up to the latest reading. A team whose request went live holds what it now uses, as far as the pool has room to reserve it. |',
    '| Supply | An approved order is placed on its date. An order that reaches its planned day lands, or slips, by however far the vendor\'s own delivery history strays from its typical delivery. A landed order adds capacity to its pool; a slipped one gets a new date, and that is what the plan then sees. |',
    '| Incidents and feed deliveries | Carried forward unchanged in age. The lab invents no new ones, and without this the reliability window would empty and every feed would go stale just because time passed. |',
    '',
    `**Dated demand is realized.** What the plan counts is what the funnels and the timeline read; what happens is decided in \`clock.js\` by draws the plan never sees, from a fixed salt and the record's own id, so the same record always meets the same fate and the first weeks do not depend on how many were asked for.`,
    '',
    '| Kind | Does it happen | How much shows up | From when | Then |',
    '|---|---|---|---|---|',
    `| Request (pending) | With its own \`win_probability\` | ${Math.round(UPTAKE.request[0] * 100)}% to ${Math.round(UPTAKE.request[1] * 100)}% of what it asked, in full | The week it is needed, never before it was submitted | \`live\` (with \`live_on\`, \`realized_cu\`) or \`lapsed\`; either way it leaves the pipeline. The team that asked holds what it now uses |`,
    `| Contract | Always | ${Math.round(UPTAKE.contract[0] * 100)}% to ${Math.round(UPTAKE.contract[1] * 100)}% of what it still had to add, in full | Its effective date | Fully provisioned, so its funnel has nothing left to add |`,
    `| Event, demand step (a sized relocation or regional launch) | With the event's \`confidence\` | ${Math.round(UPTAKE.event[0] * 100)}% to ${Math.round(UPTAKE.event[1] * 100)}% of its size, in full | Its date | No longer a step to come |`,
    `| Event, seasonal spike | With the event's \`confidence\` | ${Math.round(SEASONAL_REALIZED[0] * 100)}% to ${Math.round(SEASONAL_REALIZED[1] * 100)}% of the stated uplift, on the pool's usage | Only while it runs | Nothing to settle |`,
    '| Other events (new SKU, technology shift, competitor) | n/a | They do not move usage | n/a | n/a |',
    '',
    `A pool cannot use more than it has: a reading is capped at the capacity that has landed by that week, and what could not be served is reported as \`unserved\` (the Outcome page shows a full pool's capacity and the demand it turned away). Approved and completed requests are history and are never realized again. A request made after the lab moved counts only from the reading after it was made, so no week already lived through is rewritten; for the same reason a scenario that would change what has already happened (a request or contract that falls due in the lived weeks, a delivery that lands differently) is refused. The clock may advance ${MAX_WEEKS} weeks in all (\`advanceLimit\`). The busiest-hour check is switched off once the lab has moved, because its ratios were measured on the shipped weeks.`,
    '',
    '## 7. PLANNER: the options for an open order',
    '',
    '`GET /api/pools/{id}/options`. Every number is the plan engine\'s own. An option that places an order is measured by re-running the plan with that order hypothetically in flight, so an option\'s preview is exactly what approving it then produces (`test/options.test.js` checks this against a real approval). Nothing is estimated and nothing comes from a model.',
    '',
    '| Option field | Meaning |',
    '|---|---|',
    ...[...optKeys].map((k) => `| \`${k}\` | ${OPTION_FIELDS[k]} |`),
    '',
    'The options: **as drafted**; **phase** (size for half the cover window, offered only when its second order would not already be late, and only when it orders less); **fit the budget** (the most whole racks the remaining budget buys, offered only when the drafted order does not fit and the vendor\'s minimum can be bought); **wait 4 weeks** (shown so its cost can be seen; never recommended). The recommendation follows a stated rule, returned with the options: order what closes the gap if the budget allows it; if not, the most the budget allows, saying what is left; never wait. The response also carries two sensitivities: the same plan if the vendor met its quoted lead time, and if usage grew 25% faster.',
    '',
    '## 8. HUMAN / POLICY: the approval rules and the decision record',
    '',
    `The policy (\`policy.json\`, \`approval\`) is synthetic: a budget of ${usd(policyApproval.budget_usd)} (${policyApproval.budget_label}) and a threshold of ${usd(policyApproval.second_approver_above_usd)}. Spend over the budget needs a written reason. An order costing more than the threshold needs a second, **different** named person to countersign it: the first approval places nothing, and the plan still shows the need until the second person agrees to the same quantity. Declining or deferring withdraws a waiting approval. The lab has no sign-in, so a named person is a name that was typed and "different" means a different name: this is a control on the record and the workflow, not authentication. \`GET /api/pools/{id}/approval?quantity_cu=\` answers "what would this need?" for the screen and for the write path alike, so what the person is told is what is enforced.`,
    '',
    'A decision record, every field, hash-chained to the one before:',
    '',
    '| Field | Meaning |',
    '|---|---|',
    ...[...recordKeys].map((k) => `| \`${k}\` | ${RECORD_FIELDS[k]} |`),
    '',
    '`basis`, what the decision was based on. The engine refits on every load, so without it the forecast the person saw could not be recovered afterwards:',
    '',
    '| Field | Meaning |',
    '|---|---|',
    ...Object.keys(twoStep.basis).map((k) => `| \`basis.${k}\` | ${BASIS_FIELDS[k]} |`),
    '',
    'Editing any field, including the basis, breaks the chain. A log written before the basis existed still verifies.',
    '',
    '## 9. AI ADVISOR: the facts it may use',
    '',
    'The model\'s answer has not changed (summary, why now, risks, a request draft) and every date, SKU and number in it is still checked against the facts. What it is given has: strings produced by the engine, the planner and the rules above, to copy. It explains; it never ranks, chooses or computes, and the prompt says so.',
    '',
    '| Fact | Meaning |',
    '|---|---|',
    ...[...factKeys].map((k) => `| \`${k}\` | ${FACT_FIELDS[k]} |`),
    '',
    '## 10. PLANNING: supply and demand as two views of one plan',
    '',
    'Capacity Planning is one page (`#/planning`) with three views, replacing the split between a Central Capacity (provider) page and a Product Team (requester) page. They were two people\'s views of the same numbers; here they are two sides of one plan. `GET /api/planning?horizon=&sku=&region=` serves the twelve figures and the balance; the Balance and Supply views also read `GET /api/overview` for the chart, the constraints and the inventory, and the Demand view reads `GET /api/requester` for the request behind the figures. The old `#/overview` and `#/team` addresses still open the matching view.',
    '',
    '```',
    '   SUPPLY VIEW                          DEMAND VIEW',
    '   Capacity available                   Product demand',
    '   Pool capacity                        Workload forecast',
    '   Utilization                          Growth',
    '   Headroom                             Pipeline',
    '   Health                               Business events',
    '   Cost                                 Capacity requests',
    '            \\                            /',
    '             ---------- BALANCE / PLAN ----------',
    '```',
    '',
    'Nothing here is a new model: every figure is arithmetic over the pool assessments the rest of the lab uses, so the page cannot disagree with the pool pages. `test/planning.test.js` pins the agreement: Product demand is the Overview\'s total demand, and the balance\'s shortfall is the Overview\'s projected shortfall, at every horizon.',
    '',
    '| View | Figure | Unit | What it is |',
    '|---|---|---|---|',
    ...planningTiles.map((t) => `| ${t.view} | \`${t.key}\` (${t.label}) | ${t.unit} | ${t.definition} |`),
    '',
    'The balance, one row per pool at the horizon, worst first:',
    '',
    '| Field | Meaning |',
    '|---|---|',
    ...Object.keys(planning.balance.rows[0]).map((k) => `| \`${k}\` | ${PLANNING_ROW_FIELDS[k]} |`),
    '',
    'The totals combine the pools as one distribution (`aggregate.js`), not by adding each pool\'s p80, and shortfall stays counted per pool. One set of filters (horizon, SKUs, regions) applies to every view. The request pickers on the Demand view choose which request is shown below the figures.',
    '',
    '## Where each contract is enforced',
    '',
    '| Boundary | Enforced by | On a violation |',
    '|---|---|---|',
    '| OBSERVE | `validate.js` schemas and `data.js` cross-file checks, at load | The server does not start. The error names the file and field. |',
    '| FORECAST | `forecast/1`, and a fingerprint on every plan; `shifts.js`, `test/shifts.test.js` | A change of shape needs a new contract version. A history with no named effect must reach the forecast unchanged (the golden fixture), and the size of an effect must never be read from what the lab generated. |',
    '| PLANNING CONTEXT | `timeline.js`; `test/fixtures/planning-golden.json` pins every series | A refactor that moves a number fails `npm test`. |',
    '| FUNNELS to PLAN ENGINE | `contracts.js`, checked in `runFunnels` | The funnel is shown as no data, with the reason. The plan is built from the rest. |',
    '| PLANNER | `options.js`; `test/options.test.js` | An option\'s preview must equal what approving it produces, checked against a real approval. |',
    '| HUMAN / POLICY | `approval.js`, `decisions.js`, `basis.js`; `test/approval.test.js`, `test/basis.test.js` | An approval that breaks a rule is refused with the reason and leaves no record. The chain breaks on any edit. |',
    '| AI ADVISOR | `advisor.js`, `explain.js`; `test/advisor.test.js` | Text with a figure that is not in the facts is withheld and the rules-based text is shown. |',
    '| PLANNING | `planning.js`; `test/planning.test.js` | Its figures must agree with the Overview and the pool verdicts, recomputed independently. An undocumented balance field fails the docs build. |',
    '| OUTCOME and FEEDBACK | `clock.js`, `outcome.js`; `test/clock.test.js`, `test/dated.test.js` | An advanced dataset must still pass every input rule (checked for every number of weeks), and advancing must be reproducible. What each kind of dated item adds is tested as the difference between a world with it and one without. A request to go too far is refused with the reason. |',
    '',
    '## Still open',
    '',
    '- **Per-record provenance.** No record says which feed it came from or when it was observed.',
    '- **The floor funnels see.** Funnels test against the policy working ceiling; the plan engine sizes against the lowest ceiling any funnel proposes (the performance funnel can lower it). No funnel sees the composed ceiling.',
    '- **`lower` is produced and read by nothing.**',
    '- **The actuals are generated, and what happens to dated demand is drawn, not measured.** The feedback loop is real; the accuracy it measures is not evidence about real usage. Whether a request goes live, and how much of it shows up, comes from fixed draws (see `clock.js`).',
    '- **The forecast takes out only what a record names, and only what clears the noise.** A step or spike that no record names is still read as growth, and a step under about three noise deviations is left as noise: East US\'s REQ-1003 (275 CU) and CON-0101 (296 CU) were measured about right but sit at 2.6 and 2.7 deviations, so they stay in the trend as a little growth (`test/shifts.test.js` pins this). Finding unnamed jumps would need a change-point method, and is not built.',
    '',
  ].join('\n');
}

if (require.main === module) {
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  for (const [file, body] of Object.entries(build())) {
    fs.writeFileSync(path.join(ROOT, file), body);
    console.log(`docs: wrote ${file}`);
  }
}

module.exports = { build };
