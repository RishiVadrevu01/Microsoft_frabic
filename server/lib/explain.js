'use strict';
/*
 * The plain-words explainer: the only place a language model is used, and it sits
 * AFTER the decision. The engine has already fixed every date, quantity, cost and
 * SKU. The model may only re-tell that plan in ordinary language and draft the
 * request text; it is never asked to choose, adjust or recompute anything.
 *
 * Three safeguards keep it honest:
 *   1. It is given a packet of facts already written as strings to copy verbatim.
 *   2. Its answer is CHECKED: every date, SKU and number in the text must appear in
 *      the packet. Text that fails is withheld and the rules-based text is shown.
 *   3. If the model is not configured, is unreachable, or answers badly, the
 *      rules-based text is shown. The lab works fully without it.
 *
 * Nothing is sent until a person clicks the button, and only the synthetic plan
 * facts for one pool are sent.
 */

const crypto = require('node:crypto');
const { fmt } = require('./dates');
const { cu, usd, pct } = require('./format');

const SEV = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DATE_RE = new RegExp(`\\b\\d{1,2} (?:${MONTHS}) \\d{4}\\b`, 'g');
const SKU_RE = /\bFAB-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;
// Figures written in words are converted to digits and checked like any other number.
// "one" is left alone (it is ordinary prose: "one planner"). Big words cannot be checked.
const UNITS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_NUM_RE = new RegExp(`\\b(?:(?:${Object.keys(TENS).join('|')})(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|${Object.keys(UNITS).join('|')})\\b`, 'gi');
const BIG_WORD_RE = /\b(?:hundred|thousand|million|billion)\b/gi;
const wordValue = (w) => w.toLowerCase().split(/[- ]/).reduce((sum, part) => sum + (TENS[part] || UNITS[part] || (part === 'one' ? 1 : 0)), 0);

// ------------------------------------------------------------------ the fact packet
function buildPacket(v, facts = null) {
  const d = v.dates;
  const driverId = v.driver ? v.driver.id : null;
  const flagged = v.trace
    .filter((t) => t.status === 'flagged' && !t.context_only)
    .sort((a, b) => (b.id === driverId) - (a.id === driverId) || SEV[b.severity] - SEV[a.severity] || a.number - b.number);
  return {
    pool: `${v.region_label} (${v.sku_id})`,
    state: v.state,
    priority: v.priority,
    headline: v.headline,
    utilization: `${pct(v.capacity.utilization_of_usable)} of usable capacity`,
    horizons: v.horizons.map((h) => `next ${h.label}: ${h.status === 'at-risk' ? 'at risk' : h.status}`),
    order: v.order.needed ? {
      quantity: cu(v.order.quantity_cu),
      sku: v.what.order_sku,
      replaces_end_of_life_sku: v.what.replaces ? v.what.from_sku : null,
      cost: usd(v.order.cost_usd),
      place_order: d.overdue_days ? `today, ${fmt(d.raise_on)} (it was due ${fmt(d.raise_by)}, ${d.overdue_days} days ago)` : `by ${fmt(d.raise_by)}`,
      capacity_needed_by: fmt(d.needed_by),
      capacity_lands: fmt(d.lands_on),
      weeks_capacity_lands_late: d.short_weeks || 0,
      covered_until: d.covered_until ? fmt(d.covered_until) : 'beyond 24 months',
      lead_time: `${v.lead.weeks} weeks`,
    } : null,
    what_sets_the_date: v.driver ? `${v.driver.name}: ${v.driver.headline}` : null,
    planning_basis: v.driver ? v.driver.kind : null,
    funnels_flagged: `${v.flagged_count} of 14`,
    flagged_funnels: flagged.slice(0, 8).map((t) => ({ number: t.number, name: t.name, headline: t.headline, effects: t.effects })),
    context_only_funnels: v.trace.filter((t) => t.status === 'flagged' && t.context_only).map((t) => ({ name: t.name, headline: t.headline })),
    idle_capacity: v.reclaim.cu ? `${cu(v.reclaim.cu)} of idle reservations, worth about ${usd(v.reclaim.value_usd)}` : null,
    stale_inputs: v.trace.filter((t) => t.stale).map((t) => t.name),
    forecast_model: v.forecast.model,
    // What changed, the options, the approval and budget rules, and the ranking: produced by the engine, the planner and the
    // governance rules (advisor.js), handed over as strings to copy. Absent when the caller gives none.
    ...(facts || {}),
  };
}

// ------------------------------------------------------------------ rules-based text (always available)
function ruleText(p) {
  const why = [];
  if (p.what_sets_the_date) why.push(p.what_sets_the_date);
  for (const s of p.flagged_funnels) {
    const line = s.headline;
    if (!why.some((w) => w.endsWith(line))) why.push(line);
    if (why.length >= 4) break;
  }
  const risks = [];
  if (p.order && p.order.weeks_capacity_lands_late) risks.push(`Even if ordered on time, capacity lands ${p.order.weeks_capacity_lands_late} weeks after it is needed.`);
  if (p.stale_inputs.length) risks.push(`Some inputs are stale: ${p.stale_inputs.join(', ')}.`);
  // what approving needs, and what waiting costs, when the advisor has been given them
  if (p.approval_needed) risks.push(p.approval_needed);
  if (p.cost_of_waiting) risks.push(`Waiting: ${p.cost_of_waiting}`);
  for (const c of p.context_only_funnels.slice(0, 2)) risks.push(`Recorded for context only: ${c.headline}`);
  const o = p.order;
  const rec = (p.options || []).find((x) => x.recommended);
  const others = (p.options || []).filter((x) => !x.recommended && x.order !== 'none');
  // The summary answers "what changed?" and "what should we do?" from the facts, in that order, without deciding anything.
  const lead = o
    ? `${p.headline} ${p.what_sets_the_date ? `${p.what_sets_the_date}` : ''}`.trim()
    : `${p.headline} ${p.idle_capacity ? `There is ${p.idle_capacity} that could be reclaimed instead of bought.` : ''}`.trim();
  const changed = p.what_changed && p.what_changed[0] && !/^Nothing has been decided/.test(p.what_changed[0]) ? ` What changed: ${p.what_changed[0]}` : '';
  const recommendation = rec ? ` The plan recommends "${rec.option}": ${rec.order} for ${rec.cost}, landing ${rec.lands}.${others.length ? ` The alternatives are ${others.map((x) => `"${x.option}" (${x.order}, ${x.cost})`).join(' and ')}.` : ''}` : '';
  return {
    summary: `${lead}${changed}${recommendation}`,
    why_now: why.slice(0, 4),
    risks: risks.slice(0, 3),
    request_title: o ? `Capacity request: ${o.quantity} of ${o.sku} for ${p.pool}` : `No capacity request needed for ${p.pool}`,
    request_body: o
      ? `Please approve an order of ${o.quantity} of ${o.sku} for ${p.pool}, estimated at ${o.cost}. Place the order ${o.place_order}. Capacity is needed by ${o.capacity_needed_by} and would land ${o.capacity_lands}, with a lead time of ${o.lead_time}. `
        + `${p.what_sets_the_date ? `Basis: ${p.what_sets_the_date} ` : ''}${o.replaces_end_of_life_sku ? `The pool runs ${o.replaces_end_of_life_sku}, which is end of life, so the order is for its successor. ` : ''}`
        + `Utilization is ${p.utilization}; ${p.funnels_flagged} funnels are flagged.`
        + `${p.approval_needed ? ` ${p.approval_needed}` : ''}`
      : `No order is needed. ${p.headline}`,
  };
}

// ------------------------------------------------------------------ figures check
function tokens(text) {
  const dates = text.match(DATE_RE) || [];
  const skus = text.match(SKU_RE) || [];
  const rest = text.replace(DATE_RE, ' ').replace(SKU_RE, ' ');
  const nums = (rest.match(NUM_RE) || []).map((n) => n.replace(/,/g, '').replace(/\.$/, ''));
  return { dates, skus, nums, words: rest.match(WORD_NUM_RE) || [], bigWords: rest.match(BIG_WORD_RE) || [] };
}

/** Every date, SKU and number in the text must appear in the packet. Returns the problems found. */
function verifyText(text, packet) {
  const facts = JSON.stringify(packet);
  const allowed = tokens(facts);
  const allowedDates = new Set(allowed.dates);
  const allowedSkus = new Set(allowed.skus);
  // Numbers inside dates (the day, the year) are allowed as numbers too, so "in 2027" is fine.
  const allowedNums = new Set([...allowed.nums, ...(facts.match(NUM_RE) || []).map((n) => n.replace(/,/g, '').replace(/\.$/, ''))]);
  const got = tokens(text);
  const problems = [];
  for (const d of new Set(got.dates)) if (!allowedDates.has(d)) problems.push(`date "${d}" is not in the plan`);
  for (const s of new Set(got.skus)) if (!allowedSkus.has(s)) problems.push(`SKU "${s}" is not in the plan`);
  for (const n of new Set(got.nums)) if (!allowedNums.has(n)) problems.push(`figure "${n}" is not in the plan`);
  for (const w of new Set(got.words.map((x) => x.toLowerCase()))) {
    if (!allowedNums.has(String(wordValue(w)))) problems.push(`figure "${w}" (${wordValue(w)}) is not in the plan`);
  }
  for (const w of new Set(got.bigWords.map((x) => x.toLowerCase()))) problems.push(`"${w}" is a figure written in words, which cannot be checked`);
  return problems;
}

const allText = (t) => [t.summary, ...t.why_now, ...t.risks, t.request_title, t.request_body].join('\n');

// ------------------------------------------------------------------ the model call
const SYSTEM = [
  'You explain a capacity plan that a deterministic engine has already computed. You do not decide anything.',
  'Rules:',
  '1. Use only the facts in the JSON you are given. The word "funnel" means one of the 14 independent capacity-planning checks (demand, reliability, and so on).',
  '2. Copy every date, quantity (CU), cost, SKU id, percentage and number of weeks exactly as written. Never round, convert, add up, recompute or invent a figure.',
  '3. Write every figure as digits, never as words.',
  '4. Never suggest a different date, quantity or SKU from the plan. If something looks wrong, say the planner should review it.',
  '5. Plain words for a capacity planner or an executive. No jargon, no markdown, no numbered lists inside a sentence.',
  '6. summary: 2 or 3 sentences. why_now: up to 4 short sentences, the reasons in order of importance. risks: up to 3 short sentences, or an empty list. request_title and request_body: a draft for the planner to send. If there is no order, say in one sentence that no request is needed and why.',
  '7. The facts may include what_changed, options, how_recommended, approval_needed, budget, if_it_changed, cost_of_waiting and priority_explained. Use them. Say in one sentence what changed if what_changed says something did. Say which option is marked recommended and why, using how_recommended, and name the alternatives and what an approver would need (a second person, a reason for going over budget). Put approval and waiting in risks.',
  '8. Naming an option that is in the facts is allowed; suggesting a date, quantity or SKU that is not in the facts is not (rule 4). You never choose between options, rank anything, or recommend an option that is not marked recommended. The ranking in priority_explained is fixed by the engine: you may explain it, not change it. The budget and thresholds are synthetic; say so if you mention them.',
  'Return JSON only.',
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'why_now', 'risks', 'request_title', 'request_body'],
  properties: {
    summary: { type: 'string' },
    why_now: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    request_title: { type: 'string' },
    request_body: { type: 'string' },
  },
};

function friendly(status) {
  if (status === 401 || status === 403) return 'The Azure OpenAI key was rejected (HTTP ' + status + '). Check AZURE_OPENAI_API_KEY.';
  if (status === 404) return 'The deployment was not found (HTTP 404). Check AZURE_OPENAI_CHAT_DEPLOYMENT and the endpoint.';
  if (status === 429) return 'Azure OpenAI is rate limiting this deployment (HTTP 429). Try again shortly.';
  return `Azure OpenAI returned HTTP ${status}.`;
}

// An error whose message is safe and useful to show the person as it is.
const known = (message) => Object.assign(new Error(message), { known: true });

function parseAnswer(content) {
  let j;
  try { j = JSON.parse(content); } catch { throw known('The model did not return valid JSON.'); }
  const str = (v, max) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null);
  const list = (v, n, max) => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length <= max) ? v.map((x) => x.trim()).filter(Boolean).slice(0, n) : null);
  const out = { summary: str(j.summary, 900), why_now: list(j.why_now, 4, 400), risks: list(j.risks, 3, 400), request_title: str(j.request_title, 200), request_body: str(j.request_body, 1400) };
  if (Object.values(out).some((x) => x === null)) throw known('The model answer was missing a field or too long.');
  return out;
}

function createExplainer({ config, fetchImpl = globalThis.fetch, timeoutMs = 25000, maxPerMinute = 20 } = {}) {
  const cfg = config || { enabled: false, reason: 'not configured' };
  const cache = new Map();
  const calls = [];

  async function callModel(packet) {
    const now = Date.now();
    while (calls.length && now - calls[0] > 60000) calls.shift();
    if (calls.length >= maxPerMinute) throw known('Too many AI calls in the last minute. Wait a little.');
    calls.push(now);
    const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': cfg.apiKey },
        body: JSON.stringify({
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Plan facts (JSON):\n${JSON.stringify(packet, null, 1)}` }],
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: 'json_schema', json_schema: { name: 'plan_explanation', strict: true, schema: SCHEMA } },
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw known(friendly(res.status));
      const body = await res.json();
      const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      if (!content) throw known('The model returned no content.');
      return parseAnswer(content);
    } catch (err) {
      if (err.name === 'AbortError') throw known(`The model did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      if (err.known) throw err;
      throw known('Could not reach Azure OpenAI. Check the network and AZURE_OPENAI_ENDPOINT.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status: () => (cfg.enabled
      ? { configured: true, mode: 'azure-openai', model: cfg.deployment, host: cfg.host }
      : { configured: false, mode: 'rules-only', reason: cfg.reason }),

    async explain(verdict, { refresh = false, facts = null } = {}) {
      const packet = buildPacket(verdict, facts);
      const hash = crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex').slice(0, 16);
      const rules = ruleText(packet);
      const base = { pool_id: verdict.pool_id, packet_hash: hash, packet, rules_text: rules };

      if (!cfg.enabled) return { ...base, source: 'rules', text: rules, ai: { status: 'off', message: `AI is not configured: ${cfg.reason}. Showing rules-based text.` } };
      if (!refresh && cache.has(hash)) return { ...cache.get(hash), ai: { ...cache.get(hash).ai, cached: true } };

      const started = Date.now();
      let result;
      try {
        const text = await callModel(packet);
        const problems = verifyText(allText(text), packet);
        result = problems.length
          ? { ...base, source: 'rules', text: rules, ai: { status: 'withheld', model: cfg.deployment, problems, message: `The AI text was withheld because it contained ${problems.length} figure${problems.length === 1 ? '' : 's'} that ${problems.length === 1 ? 'is' : 'are'} not in the plan. Showing rules-based text.`, withheld_text: text } }
          : { ...base, source: 'ai', text, ai: { status: 'used', model: cfg.deployment, message: 'Written by AI. Every date, SKU and number was checked against the plan.', latency_ms: Date.now() - started } };
        cache.set(hash, result);
      } catch (err) {
        result = { ...base, source: 'rules', text: rules, ai: { status: 'error', model: cfg.deployment, message: `${err.message} Showing rules-based text.` } };
      }
      return result;
    },
  };
}

module.exports = { createExplainer, buildPacket, ruleText, verifyText, tokens, allText, SCHEMA, SYSTEM };
