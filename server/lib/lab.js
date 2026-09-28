'use strict';
/*
 * The guided lab: seven short exercises, each with a checkpoint the SERVER
 * verifies from the real state. Expected numbers are computed from the engine
 * when the page loads, so the guide can never drift away from the data.
 *
 * Levels follow the crawl / walk / run ladder from the capacity-planning
 * roadmap: read the answer (crawl), change something and watch it react (walk),
 * decide with guardrails and reset (run).
 */

const { summarize } = require('./summary');
const { fmt } = require('./dates');
const { cu } = require('./format');
const scenarios = require('./scenarios');
const { HttpError } = require('./store');

const EUS = 'pool-eastus-01-intel-icx';
const WEU_AMD = 'pool-westeurope-01-amd-genoa';

const label = (v) => `${v.region_label} · ${v.sku_id}`;

function makeEnv(store) {
  const verdicts = store.verdicts();
  const byId = Object.fromEntries(verdicts.map((v) => [v.pool_id, v]));
  const baseById = Object.fromEntries(store.baseline().map((v) => [v.pool_id, v]));
  const data = store.data();
  const summary = summarize(verdicts, data);
  return { store, verdicts, byId, baseById, data, summary, state: store.state() };
}

const go = (hash, text) => ({ type: 'go', hash, label: text });

const LABS = [
  {
    id: 'lab-1', level: 'Crawl', title: 'Read the answer', minutes: 2,
    goal: 'Answer "are we good for the next 3, 6 and 12 months?" and name the most urgent pool, without clicking around.',
    build(env) {
      return {
        steps: [
          { text: 'Open the Capacity Planning page and read the headline and the three horizon cards.', action: go('#/planning', 'Open Capacity Planning') },
          { text: 'Look at the ranked action list. The first card is the pool that needs a decision first.' },
        ],
        quiz: { prompt: 'Which pool is at the top of the action list?', options: env.verdicts.map((v) => ({ id: v.pool_id, label: label(v) })) },
        expect: `The headline reads: "${env.summary.headline}"`,
      };
    },
    check(env, body) {
      const top = env.summary.actions[0];
      const passed = body.choice === top.pool_id;
      return {
        passed,
        message: passed
          ? `Correct. ${label(top)} is ${top.state}: ${top.reasons[0]}`
          : 'Not quite. Ranking goes by state first (overdue, order now, plan), then priority, then raise-by date. Look at the first card again.',
      };
    },
  },
  {
    id: 'lab-2', level: 'Crawl', title: 'Ask "why now?"', minutes: 3,
    goal: 'Trace a decision back to the funnel that caused it. Every flagged item must be traceable.',
    build(env) {
      const v = env.byId[EUS];
      const flagged = v.trace.filter((t) => t.status === 'flagged' && !t.context_only);
      return {
        steps: [
          { text: 'Open the East US pool and scroll to "Why now: what each funnel did".', action: go(`#/pools/${EUS}`, 'Open East US') },
          { text: 'Each flagged funnel says what it did to the plan. Find the one that sets the need-by date.' },
        ],
        quiz: { prompt: 'Which funnel sets the need-by date for East US?', options: flagged.map((t) => ({ id: t.id, label: `#${t.number} ${t.name}` })) },
        expect: `East US needs ${v.dates.needed_by ? fmt(v.dates.needed_by) : 'no date'} capacity; ${v.flagged_count} of 14 funnels are flagged.`,
      };
    },
    check(env, body) {
      const v = env.byId[EUS];
      const passed = Boolean(v.driver) && body.choice === v.driver.id;
      return {
        passed,
        message: passed
          ? `Correct. ${v.driver.name} sets the date: ${v.driver.headline} Other funnels adjust the lead time, the size and the priority.`
          : 'Not quite. Look for the line that says "Sets the need-by date". Only one funnel gets it: the earliest.',
      };
    },
  },
  {
    id: 'lab-3', level: 'Walk', title: 'Change one assumption', minutes: 3,
    goal: 'Use the what-if panel to see how much of the urgency is really the lead time.',
    build(env) {
      const v = env.byId[EUS];
      return {
        steps: [
          { text: 'Open East US and find the "What if" panel. Set the lead time to 8 weeks and recompute.', action: go(`#/pools/${EUS}`, 'Open East US') },
          { text: 'Nothing is saved: a what-if never changes the data. Reset the slider to get back to the real value.' },
        ],
        quiz: { prompt: 'With an 8-week lead time, what state does East US show?', options: ['OVERDUE', 'ORDER NOW', 'PLAN', 'WATCH', 'OK'].map((s) => ({ id: s, label: s })) },
        expect: `Today the lead time is ${v.lead.weeks} weeks and the state is ${v.state}.`,
      };
    },
    check(env, body) {
      const alt = env.store.whatIf(EUS, { lead_time_weeks: 8 }).verdict;
      const passed = body.choice === alt.state;
      return {
        passed,
        message: passed
          ? `Correct: ${alt.state}. The raise-by date moves from ${fmt(env.byId[EUS].dates.raise_by)} to ${fmt(alt.dates.raise_by)}. Most of the urgency was the lead time, not the demand.`
          : 'Not quite. Try it in the what-if panel and read the state chip.',
      };
    },
  },
  {
    id: 'lab-4', level: 'Walk', title: 'Inject a quota surge', minutes: 3,
    goal: 'Watch the customer pipeline change a plan before utilization moves at all.',
    build(env) {
      const s = scenarios.list().find((x) => x.id === 'quota-surge-eastus');
      const v = env.byId[EUS];
      return {
        steps: [
          { text: `Apply the scenario: ${s.title}.`, action: { type: 'scenario', id: s.id, label: 'Apply scenario' } },
          { text: 'Read the "What changed" card that appears. Then open East US and look at the order arithmetic.', action: go(`#/pools/${EUS}`, 'Open East US') },
        ],
        expect: `Before: order ${cu(env.baseById[EUS].order.quantity_cu)}. Now: order ${cu(v.order.quantity_cu)}.`,
      };
    },
    check(env) {
      const applied = env.state.scenarios.includes('quota-surge-eastus');
      const before = env.baseById[EUS].order.quantity_cu;
      const now = env.byId[EUS].order.quantity_cu;
      return {
        passed: applied,
        message: applied
          ? `Applied. The East US order went from ${cu(before)} to ${cu(now)}. Utilization did not change; the pipeline did.`
          : 'Apply the scenario first (use the button in this step), then check again.',
      };
    },
  },
  {
    id: 'lab-5', level: 'Walk', title: 'Utilization is not the whole story', minutes: 3,
    goal: 'See a half-empty pool become urgent because one funnel overrides headroom.',
    build(env) {
      const s = scenarios.list().find((x) => x.id === 'incident-storm-weu');
      const v = env.byId[WEU_AMD];
      return {
        steps: [
          { text: `Apply the scenario: ${s.title}.`, action: { type: 'scenario', id: s.id, label: 'Apply scenario' } },
          { text: 'Open West Europe AMD. Utilization is still low. Find the funnel that changed the verdict.', action: go(`#/pools/${WEU_AMD}`, 'Open West Europe AMD') },
        ],
        expect: `West Europe AMD is at ${Math.round(v.capacity.utilization_of_usable * 100)}% utilization and its state is ${v.state}.`,
      };
    },
    check(env) {
      const applied = env.state.scenarios.includes('incident-storm-weu');
      const was = env.baseById[WEU_AMD].state;
      const now = env.byId[WEU_AMD].state;
      const passed = applied && was === 'OK' && now !== 'OK';
      return {
        passed,
        message: passed
          ? `Correct. West Europe AMD went from ${was} to ${now} with no change in headroom: reliability can override capacity.`
          : applied ? `The scenario is applied but the pool is still ${now}. Reset the lab and try again.` : 'Apply the scenario first, then check again.',
      };
    },
  },
  {
    id: 'lab-6', level: 'Run', title: 'Decide with guardrails', minutes: 4,
    goal: 'Approve an order as a named person, change the quantity, and see why the system demands a reason.',
    build(env) {
      const v = env.byId[EUS];
      return {
        steps: [
          { text: 'Open East US and find the Decision panel. Enter your name.', action: go(`#/pools/${EUS}`, 'Open East US') },
          { text: `The plan drafts ${cu(v.order.quantity_cu)}. Try approving 192 CU less without a reason, and read the refusal. Then add a reason and approve.` },
          { text: 'The order enters the supply pipeline, and the pool now shows it as in flight.' },
        ],
        expect: `Drafted: ${cu(v.order.quantity_cu)} of ${v.what.order_sku}, ${v.state}.`,
      };
    },
    check(env) {
      const d = env.state.decisions.filter((x) => x.pool_id === EUS && x.decision === 'approve' && x.override && x.reason);
      const last = d.at(-1);
      return {
        passed: Boolean(last),
        message: last
          ? `Recorded ${last.decision_id} by ${last.decided_by}: approved ${cu(last.quantity_cu)} instead of the drafted ${cu(last.drafted.quantity_cu)}. Reason: "${last.reason}". Order ${last.order_id} is in flight.`
          : 'No approval with a changed quantity and a reason is recorded for East US yet.',
      };
    },
  },
  {
    id: 'lab-7', level: 'Run', title: 'Reset and compare', minutes: 1,
    goal: 'Return to the shipped baseline. Everything you did was on a working copy.',
    build() {
      return {
        steps: [{ text: 'Reset the lab data. Lab progress stays; the scenarios, requests and decisions you added are cleared.', action: { type: 'reset', label: 'Reset lab data' } }],
        expect: 'After the reset Capacity Planning shows the baseline again.',
      };
    },
    check(env) {
      const s = env.state;
      const clean = !s.scenarios.length && !s.requests.length && !s.decisions.length && !s.orders.length;
      const passed = s.resets >= 1 && clean;
      return { passed, message: passed ? 'Clean. The seed files were never touched, so the baseline is exactly as shipped.' : 'Reset the lab data using the button in this step.' };
    },
  },
];

function buildLab(store) {
  const env = makeEnv(store);
  const state = env.state;
  const exercises = LABS.map((lab, i) => ({
    id: lab.id, number: i + 1, level: lab.level, title: lab.title, minutes: lab.minutes, goal: lab.goal,
    ...lab.build(env), completed: Boolean(state.completed[lab.id]),
  }));
  return {
    progress: { done: exercises.filter((e) => e.completed).length, total: exercises.length },
    exercises,
    scenarios: scenarios.list().map((s) => ({ ...s, applied: state.scenarios.includes(s.id), pool_label: label(env.byId[s.pool_id]) })),
    state: { scenarios: state.scenarios, requests: state.requests.length, decisions: state.decisions.length, resets: state.resets },
  };
}

function checkLab(store, id, body = {}) {
  const lab = LABS.find((l) => l.id === id);
  if (!lab) throw new HttpError(404, `Unknown exercise ${id}`);
  const env = makeEnv(store);
  const result = lab.check(env, body);
  store.latch(id, result.passed);
  return result;
}

module.exports = { buildLab, checkLab };
