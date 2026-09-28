'use strict';
/*
 * The contract between the 14 funnels and the plan engine (verdict.js), in one place.
 *
 * A funnel is handed the planning context and returns a RESULT:
 *     { status, flagged, severity, headline, evidence[], proposals[], context_only }
 * and each PROPOSAL in it is one of the kinds below. The plan engine reads nothing else from a funnel.
 *
 * This was implicit until now, and what it cost was silent: compose() skips a proposal whose kind it does not know, so a
 * mistyped kind quietly removed a funnel's need-by date from the plan. runFunnels() now checks every result against this
 * file before the plan engine sees it, and a funnel that breaks the contract is shown as "could not be computed" (the
 * same as one that throws), never trusted halfway. docs/CONTRACTS.md is generated from this file, so the document and the
 * check cannot disagree.
 */

const { checkRecord } = require('./validate');

const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];
const STATUSES = ['quiet', 'flagged', 'no-data'];

// `effect: 'plan'` means the plan engine turns it into a date, a size, a lead time, a ceiling or a reclaim figure.
// `effect: 'guidance'` is shown to the planner as advice and changes no number.
const PROPOSAL_KINDS = {
  capacity: {
    effect: 'plan', fields: { needed_by: 'date', note: 'string?' },
    means: 'Capacity must be in place by this date. The earliest one across all funnels is the plan\'s need-by date.',
  },
  replace: {
    effect: 'plan', fields: { needed_by: 'date', cu: 'positive', segment: 'string?', note: 'string?' },
    means: 'Retire a failing segment and stand up this many units of replacement. It is also a need-by date, and its units are added to the order.',
  },
  deadline: {
    effect: 'plan', fields: { by: 'date', note: 'string?' },
    means: 'A mandatory date with no size attached (for example security support ending). It keeps the pool on watch and marks the horizons "act".',
  },
  lead: {
    effect: 'plan', fields: { mode: ['set', 'add'], weeks: 'positive', note: 'string' },
    means: '"set" replaces the vendor\'s quoted lead time with this many weeks (the largest wins). "add" adds weeks of cover on top.',
  },
  add_demand: {
    effect: 'plan', fields: { cu: 'positive', at: 'date', label: 'string', temporary: 'boolean?' },
    means: 'Demand that steps in on this date and is added to the order\'s sizing, on top of the forecast. `temporary` marks a buffer (a seasonal spike) that is sized for even after the event has ended by the end of the cover window.',
  },
  floor: {
    effect: 'plan', fields: { floor_pct: 'share', note: 'string?' },
    means: 'A working ceiling lower than policy (strain begins earlier). The lowest one sizes the order.',
  },
  reclaim: {
    effect: 'plan', fields: { cu: 'positive', value_usd: 'nonneg', from: { $each: 'string' } },
    means: 'Idle reserved capacity that could be freed instead of bought.',
  },
  priority: {
    effect: 'plan', fields: { level: SEVERITIES.slice(1), note: 'string?' },
    means: 'Raises the priority of the action by one step. It sets no date and no size.',
  },
  mix_shift: {
    effect: 'guidance', fields: { from: 'share', to: 'share', note: 'string' },
    means: 'Advice about what to buy: the mix of SKU classes is moving.',
  },
  what_hint: {
    effect: 'guidance', fields: { date: 'date', note: 'string' },
    means: 'Advice about what to buy: a hardware generation is coming.',
  },
  retire: {
    effect: 'guidance', fields: { to_sku: 'string', note: 'string' },
    means: 'Advice to retire this SKU in favour of a named successor.',
  },
};

const RESULT_FIELDS = {
  status: STATUSES, flagged: 'boolean', severity: SEVERITIES, headline: 'string',
  evidence: { $each: { label: 'string', value: 'string' } }, proposals: 'array', context_only: 'boolean',
};

/** What is wrong with one proposal, or an empty list. */
function proposalProblems(p) {
  const spec = p && PROPOSAL_KINDS[p.kind];
  if (!spec) return [`proposal of unknown kind "${p && p.kind}"`];
  return checkRecord(p, spec.fields, `${p.kind} proposal`);
}

/** What is wrong with one funnel's result, or an empty list. */
function resultProblems(out) {
  if (!out || typeof out !== 'object') return ['result is not an object'];
  const problems = checkRecord(out, RESULT_FIELDS, 'result');
  if (problems.length) return problems;
  if (out.flagged !== (out.status === 'flagged')) problems.push('status and flagged disagree');
  if (out.status !== 'flagged' && out.severity !== 'none') problems.push('a funnel that is not flagged must have severity none');
  if (out.status !== 'flagged' && out.proposals.length) problems.push('only a flagged funnel may propose anything');
  if (out.context_only && (!out.flagged || out.proposals.length)) problems.push('a context-only funnel must be flagged and propose nothing');
  for (const p of out.proposals) problems.push(...proposalProblems(p));
  return problems;
}

const isKnownKind = (kind) => Object.prototype.hasOwnProperty.call(PROPOSAL_KINDS, kind);

module.exports = { PROPOSAL_KINDS, RESULT_FIELDS, SEVERITIES, STATUSES, proposalProblems, resultProblems, isKnownKind };
