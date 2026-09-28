'use strict';
/*
 * KNOWN EFFECTS IN THE HISTORY: a step that has happened, or a spike that has come and gone, must not be read as growth.
 *
 * The estimator is tested on synthetic series first, where the truth is known (a straight line, noise of a known size, a step
 * or a spike of a known size at a known week), then on the lab's own cases: the ones this replaces a known limit for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { P, DATA_DIR } = require('./helpers');
const { loadRaw, indexData, clone } = require('../server/lib/data');
const { buildContext } = require('../server/lib/context');
const { assessPool } = require('../server/lib/verdict');
const { advance } = require('../server/lib/clock');
const { forecastSeries, linearFit } = require('../server/lib/forecast');
const { shiftCandidates, adjustForLevelShifts, describe, excess, SIGMAS } = require('../server/lib/shifts');
const { addWeeks } = require('../server/lib/dates');
const { buildOutcome } = require('../server/lib/outcome');
const { freshStore } = require('./helpers');

const raw = loadRaw(DATA_DIR);

// ---------------------------------------------------------------- a synthetic history, with the truth known
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
const N = 52;
const WEEKS = Array.from({ length: N }, (_, i) => addWeeks('2026-01-05', i));
/** 52 weekly readings: 5,000 rising 40 a week, noise of sd 20, plus whatever `add(i)` says. */
function history(add = () => 0, seed = 7) {
  const r = rng(seed);
  return WEEKS.map((_, i) => Math.round(5000 + 40 * i + 20 * gauss(r) + add(i)));
}
const step = (id, i, extra = {}) => ({ shape: 'step', kind: 'request', id, date: WEEKS[i], label: id, ...extra });
const spike = (id, i, weeks) => ({ shape: 'spike', kind: 'event', id, date: WEEKS[i], weeks, label: id });
const slopeOf = (y) => linearFit(y.slice(-26)).slope;

test('with nothing named, the history goes through exactly as it is', () => {
  const y = history((i) => (i >= 40 ? 600 : 0));
  const out = adjustForLevelShifts(WEEKS, y, []);
  assert.deepEqual(out.values, y, 'a step that no record names is not looked for');
  assert.deepEqual(out.steps, []);
  assert.ok(slopeOf(y) > 60, `and it is still read as growth: ${slopeOf(y).toFixed(0)} a week against a true 40`);
});

test('a step the records name is measured from the series, taken out, and the trend is the true one again', () => {
  const y = history((i) => (i >= 40 ? 600 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [step('REQ-X', 40)]);
  const s = out.steps[0];
  assert.deepEqual([s.applied, s.shape, s.ids, s.reading, s.week_start], [true, 'step', ['REQ-X'], 40, WEEKS[40]]);
  assert.ok(Math.abs(s.size_cu - 600) < 80, `measured ${s.size_cu} for a true 600`);
  assert.ok(s.sigmas >= SIGMAS);
  for (let j = 0; j < 40; j++) assert.ok(Math.abs(out.values[j] - (y[j] + s.size_cu)) <= 0.5, 'every earlier reading is raised by the step (the size reported is rounded to a whole CU)');
  for (let j = 40; j < N; j++) assert.equal(out.values[j], y[j], 'and the readings from the step on are untouched, so the last one is what was read');
  assert.ok(Math.abs(slopeOf(out.values) - 40) < 8, `trend ${slopeOf(out.values).toFixed(1)} a week, close to the true 40 (it was ${slopeOf(y).toFixed(0)})`);
});

test('a step at the very last reading can be measured from that one reading', () => {
  const y = history((i) => (i >= N - 1 ? 600 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [step('REQ-LAST', N - 1)]);
  assert.equal(out.steps[0].applied, true);
  assert.ok(Math.abs(out.steps[0].size_cu - 600) < 100, `${out.steps[0].size_cu}`);
  assert.equal(out.values[N - 1], y[N - 1]);
});

test('a named step that is not there is left alone, and says why', () => {
  const y = history();
  const out = adjustForLevelShifts(WEEKS, y, [step('REQ-GHOST', 40)]);
  assert.equal(out.steps[0].applied, false);
  assert.match(out.steps[0].reason, /^it is not clearly above the noise \(-?\d\.\d against 3 standard deviations\)$/);
  assert.deepEqual(out.values, y);
});

test('with too little history before it there is no trend to measure against, so it is left alone and says so', () => {
  const y = history((i) => (i >= 3 ? 600 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [step('REQ-EARLY', 3)]);
  assert.deepEqual([out.steps[0].applied, out.steps[0].reason, out.steps[0].size_cu], [false, 'there is too little history before it to see a trend', null]);
  assert.deepEqual(out.values, y);
});

test('something dated after the last reading is not in the history yet, so it is not looked for', () => {
  const y = history();
  const out = adjustForLevelShifts(WEEKS, y, [{ shape: 'step', kind: 'event', id: 'EVT-FUTURE', date: '2030-01-07', label: 'later' }]);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(out.values, y);
});

test('two steps in the same reading are one jump, measured once', () => {
  const y = history((i) => (i >= 40 ? 600 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [step('REQ-A', 40), step('CON-B', 40, { kind: 'contract' })]);
  assert.equal(out.steps.length, 1);
  assert.deepEqual([out.steps[0].ids, out.steps[0].kinds.sort()], [['CON-B', 'REQ-A'], ['contract', 'request']]);
  assert.ok(Math.abs(out.steps[0].size_cu - 600) < 80, `${out.steps[0].size_cu}: the jump, not twice the jump`);
});

test('oldest first: a later step is measured on a history with the earlier one already out, or it would drown in that step\'s noise', () => {
  const y = history((i) => (i >= 30 ? 500 : 0) + (i >= 40 ? 400 : 0));
  const later = [40, 41, 42];
  assert.ok(Math.abs(excess(y, 40, later).sigmas) < SIGMAS, 'measured on the raw history the later step looks like noise, because the earlier one is in its window');
  const out = adjustForLevelShifts(WEEKS, y, [step('REQ-2', 40), step('REQ-1', 30)]);
  assert.deepEqual(out.steps.map((s) => [s.ids[0], s.applied]), [['REQ-1', true], ['REQ-2', true]], 'taken in date order whatever order they are listed in');
  assert.ok(Math.abs(out.steps[0].size_cu - 500) < 80 && Math.abs(out.steps[1].size_cu - 400) < 80, out.steps.map((s) => s.size_cu).join(', '));
  assert.ok(Math.abs(slopeOf(out.values) - 40) < 8);
});

test('a step down (a contract ending) is taken out too', () => {
  const y = history((i) => (i >= 40 ? -500 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [step('CON-END', 40, { kind: 'contract' })]);
  assert.equal(out.steps[0].applied, true);
  assert.ok(out.steps[0].size_cu < -400 && out.steps[0].size_cu > -600, `${out.steps[0].size_cu}`);
  assert.ok(Math.abs(slopeOf(out.values) - 40) < 8);
});

test('a spike: the weeks it covered come back to the trend, and the rest of the history is untouched', () => {
  const y = history((i) => (i === 45 || i === 46 ? 1000 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [spike('EVT-S', 45, 2)]);
  const s = out.steps[0];
  assert.deepEqual([s.applied, s.shape, s.weeks], [true, 'spike', 2]);
  assert.ok(Math.abs(s.size_cu - 1000) < 80, `${s.size_cu}`);
  for (let j = 0; j < N; j++) {
    if (j === 45 || j === 46) assert.ok(Math.abs(out.values[j] - (y[j] - s.size_cu)) <= 0.5, `week ${j} comes down by the spike (the size reported is rounded to a whole CU)`);
    else assert.equal(out.values[j], y[j], `week ${j} is not touched`);
  }
  assert.ok(linearFit(y.slice(-26)).resid_sd > 250, 'raw, the spike inflates the noise the forecast reasons with');
  assert.ok(linearFit(out.values.slice(-26)).resid_sd < 40, 'taken out, the noise is the true one again');
});

test('a spike still running counts only the weeks that have happened', () => {
  const y = history((i) => (i >= N - 1 ? 1000 : 0));
  const out = adjustForLevelShifts(WEEKS, y, [spike('EVT-S', N - 1, 3)]);
  assert.deepEqual([out.steps[0].applied, out.steps[0].weeks], [true, 1], 'three weeks long, one week so far');
  assert.ok(Math.abs(out.values[N - 1] - (5000 + 40 * (N - 1))) < 100, 'the last reading comes back to the trend');
});

test('a spike that did not happen is left alone', () => {
  const y = history();
  const out = adjustForLevelShifts(WEEKS, y, [spike('EVT-NO', 45, 2)]);
  assert.equal(out.steps[0].applied, false);
  assert.deepEqual(out.values, y);
});

// ---------------------------------------------------------------- which records name something
test('only what a record dates is a candidate: a live request, a contract in effect, a sized launch, a seasonal event', () => {
  const list = shiftCandidates({
    requests: [
      { request_id: 'R1', status: 'live', live_on: '2026-11-16', title: 'a' }, { request_id: 'R2', status: 'pending', title: 'b' },
      { request_id: 'R3', status: 'lapsed', lapsed_on: '2026-11-16', title: 'c' }, { request_id: 'R4', status: 'completed', delivered_on: '2026-08-10', title: 'd' },
    ],
    contracts: [{ contract_id: 'C1', in_effect_on: '2027-01-04', customer: 'Litware Global (enterprise agreement)' }, { contract_id: 'C2', effective_date: '2027-02-15', customer: 'later (x)' }],
    events: [
      { event_id: 'E1', signal: 'strategic', effect: 'demand', magnitude_cu: 250, date: '2027-02-01', title: 'launch' },
      { event_id: 'E2', signal: 'geopolitical', effect: 'relocate-in', magnitude_cu: 900, date: '2027-08-01', title: 'move' },
      { event_id: 'E3', signal: 'strategic', effect: 'hardware-gen', date: '2027-03-15', title: 'new SKU' },
      { event_id: 'E4', signal: 'competitive', date: '2026-09-09', title: 'price cut' },
      { event_id: 'E5', signal: 'seasonal', duration_weeks: 2, uplift_pct: 0.2, date: '2026-12-14', title: 'peak' },
    ],
  });
  assert.deepEqual(list.map((c) => [c.shape, c.id]), [['step', 'R1'], ['step', 'C1'], ['step', 'E1'], ['step', 'E2'], ['spike', 'E5']]);
  assert.equal(list.find((c) => c.id === 'C1').label, 'Litware Global');
  assert.equal(list.find((c) => c.id === 'E5').weeks, 2);
});

test('the shipped history has no such record, so no pool\'s history changes and every plan is what it always was', () => {
  const data = indexData(clone(raw));
  for (const p of data.pools) {
    const ctx = buildContext(data, p.pool_id);
    assert.deepEqual(ctx.shifts, [], p.pool_id);
    assert.deepEqual(ctx.values, data.utilByPool[p.pool_id].map((s) => s.utilized_units), `${p.pool_id}: the forecast is fitted on the readings as they are`);
  }
  const v = assessPool(data, P.eus).verdict;
  assert.equal(v.forecast.why, buildContext(data, P.eus).fc.why, 'and the plan says nothing about it');
  assert.deepEqual(v.forecast.level_shifts, []);
  assert.equal(v.trace.find((t) => t.number === 1).evidence.some((e) => /Taken out/.test(e.label)), false);
});

test('the noise floor: on the shipped history, a named effect at a date with nothing there clears 3 sigma only about one time in fifty', () => {
  const data = indexData(clone(raw));
  let tests = 0; let cleared = 0;
  for (const p of data.pools) {
    const y = data.utilByPool[p.pool_id].map((s) => s.utilized_units);
    for (let i = 8; i < y.length; i++) {
      const m = excess(y, i, [i, Math.min(y.length - 1, i + 1), Math.min(y.length - 1, i + 2)].filter((k, at, a) => a.indexOf(k) === at));
      if (!m) continue;
      tests += 1; if (Math.abs(m.sigmas) >= SIGMAS) cleared += 1;
    }
  }
  assert.ok(tests > 200);
  assert.ok(cleared / tests < 0.04, `${cleared} of ${tests} (${(cleared / tests * 100).toFixed(1)}%) clear ${SIGMAS} sigma with nothing there`);
});

// ---------------------------------------------------------------- the lab's own cases
const world = (weeks, edit) => { const w = clone(raw); if (edit) edit(w); advance(w, weeks); return indexData(w); };
const dropRequestStep = (id) => (w) => { w.requests.find((r) => r.request_id === id).win_probability = 0.05; };

test('East US at 8 weeks: REQ-1001 going live no longer speeds the trend up; the plan asks for one rack more, not four', () => {
  const step = buildContext(world(8), P.eus);
  const none = buildContext(world(8, dropRequestStep('REQ-1001')), P.eus);
  const found = step.shifts.filter((s) => s.applied);
  assert.deepEqual(found.map((s) => s.ids), [['REQ-1001']]);
  assert.ok(found[0].size_cu > 400 && found[0].size_cu < 560, `measured ${found[0].size_cu} for what generated 466`);
  assert.ok(Math.abs(step.fc.slope_per_week - none.fc.slope_per_week) / none.fc.slope_per_week < 0.1, `trend ${step.fc.slope_per_week.toFixed(1)} against ${none.fc.slope_per_week.toFixed(1)} without the step (it was 128 against 94)`);
  assert.ok(step.p50At(1) - step.latest > 0 && step.p50At(1) - step.latest < 2 * step.fc.slope_per_week, 'next week is forecast a little above the level just read');
  const orders = [world(8), world(8, dropRequestStep('REQ-1001'))].map((d) => assessPool(d, P.eus).verdict.order.quantity_cu);
  assert.deepEqual(orders, [5184, 4800]);
});

test('West Europe H100 right after its contract: the forecast starts where usage is, not 538 CU below it', () => {
  const ctx = buildContext(world(21), P.weuGpu);
  const none = buildContext(world(21, (w) => { w.contracts = w.contracts.filter((c) => c.contract_id !== 'CON-0203'); }), P.weuGpu);
  assert.equal(ctx.latest, 4173);
  assert.ok(Math.abs(ctx.p50At(1) - ctx.latest) < 100, `next week ${Math.round(ctx.p50At(1))} against the 4,173 just read (it was 3,635)`);
  assert.ok(ctx.fc.slope_per_week < 30 && Math.abs(ctx.fc.slope_per_week - none.fc.slope_per_week) < 10, `trend ${ctx.fc.slope_per_week.toFixed(1)} a week against ${none.fc.slope_per_week.toFixed(1)} without the contract (it was 65)`);
  const c = ctx.shifts.find((s) => s.ids.includes('CON-0203'));
  assert.ok(c.applied && c.size_cu > 800 && c.size_cu < 1000, `the contract measured ${c.size_cu} for what generated 914`);
});

test('West Europe AMD in its seasonal spike: it does not order 6,144 CU on a pool at half use, and afterwards the noise is back to normal', () => {
  const at12 = world(12); const at12none = world(12, (w) => { w.events = w.events.filter((e) => e.event_id !== 'EVT-S02'); });
  const v = assessPool(at12, P.weuAmd).verdict;
  assert.equal(v.order.needed, false, 'the spike is a spike');
  const a = buildContext(at12, P.weuAmd); const b = buildContext(at12none, P.weuAmd);
  assert.ok(Math.abs(a.upperAt(26) - b.upperAt(26)) / b.upperAt(26) < 0.08, `p80 at 26 weeks ${Math.round(a.upperAt(26))} against ${Math.round(b.upperAt(26))} without the event (it was 11,672 against 7,145)`);
  const spikes = a.shifts.filter((s) => s.shape === 'spike');
  assert.deepEqual(spikes.map((s) => [s.ids, s.applied, s.weeks]), [[['EVT-S02'], true, 1]], 'one week of it so far, and it is out');
  const later = buildContext(world(17), P.weuAmd); const laterNone = buildContext(world(17, (w) => { w.events = w.events.filter((e) => e.event_id !== 'EVT-S02'); }), P.weuAmd);
  assert.ok(later.fc.resid_sd < 1.3 * laterNone.fc.resid_sd, `noise ${later.fc.resid_sd.toFixed(0)} against ${laterNone.fc.resid_sd.toFixed(0)} without it (it was 335 against 72)`);
  assert.ok(later.shifts.find((s) => s.shape === 'spike').weeks === 2, 'the whole spike, once it is over');
});

test('nothing the plan could not know is used: change what the lab generated for a step, and the forecast does not move', () => {
  const a = world(21);
  const b = world(21);
  for (const r of b.requests) if (r.realized_cu != null) r.realized_cu *= 5;
  for (const c of b.contracts) if (c.realized_cu != null) c.realized_cu *= 5;
  assert.ok(b.requests.some((r) => r.realized_cu != null) && b.contracts.some((c) => c.realized_cu != null), 'there is something to change');
  for (const id of [P.eus, P.weuGpu, P.sea, P.jpe]) assert.deepEqual(buildContext(a, id).fc.p50, buildContext(b, id).fc.p50, id);
});

test('only what a record names is looked for: take the go-live date off the request and its step is read as growth again', () => {
  const w = clone(raw); advance(w, 8);
  const named = buildContext(indexData(w), P.eus);
  delete w.requests.find((r) => r.request_id === 'REQ-1001').live_on;
  const unnamed = buildContext(indexData(w), P.eus);
  assert.equal(named.shifts.filter((s) => s.applied).length, 1);
  assert.deepEqual(unnamed.shifts, []);
  assert.ok(unnamed.fc.slope_per_week > 1.25 * named.fc.slope_per_week, `${unnamed.fc.slope_per_week.toFixed(0)} against ${named.fc.slope_per_week.toFixed(0)}: the records are what tell the engine it was a step`);
});

test('the forecast as it stood 13 weeks ago uses only the steps that had happened by then', () => {
  const data = world(26);
  const ctx = buildContext(data, P.eus);
  const series = data.utilByPool[P.eus];
  const n = series.length - 13;
  const cand = shiftCandidates({ requests: data.requests.filter((r) => r.pool_id === P.eus), contracts: data.contracts.filter((c) => c.pool_id === P.eus), events: ctx.events });
  const then = forecastSeries(adjustForLevelShifts(series.slice(0, n).map((s) => s.week_start), series.slice(0, n).map((s) => s.utilized_units), cand).values, data.policy.forecast);
  assert.equal(ctx.priorUpperAt(10), then.upper[Math.min(10 + 13, 104) - 1]);
  const examined = adjustForLevelShifts(series.slice(0, n).map((s) => s.week_start), series.slice(0, n).map((s) => s.utilized_units), cand).steps;
  assert.deepEqual(examined.map((s) => s.ids[0]), ['REQ-1001', 'REQ-1003'], 'REQ-1001 and REQ-1003 had gone live by then; CON-0101 (4 Jan) had not, so it is not even looked for');
  assert.deepEqual(examined.map((s) => s.applied), [true, false]);
});

test('the limit of what can be seen: a step under about 3 noise deviations is left as noise, and East US\'s two smaller ones are (275 and 296 CU against a deviation near 100)', () => {
  const ctx = buildContext(world(26), P.eus);
  const by = Object.fromEntries(ctx.shifts.map((s) => [s.ids[0], s]));
  assert.deepEqual([by['REQ-1001'].applied, by['REQ-1003'].applied, by['CON-0101'].applied], [true, false, false]);
  for (const id of ['REQ-1003', 'CON-0101']) {
    assert.ok(by[id].sigmas > 2 && by[id].sigmas < SIGMAS, `${id}: ${by[id].sigmas} standard deviations, under the ${SIGMAS} it takes`);
    assert.match(by[id].reason, /not clearly above the noise/);
  }
  assert.ok(by['REQ-1003'].size_cu > 150 && by['CON-0101'].size_cu > 250, 'they were measured about right; it is the noise around them that is too big to be sure');
});

test('the plan says what was taken out: on the pool, in the why, and in the evidence of the demand funnel', () => {
  const data = world(21);
  const v = assessPool(data, P.weuGpu).verdict;
  const applied = v.forecast.level_shifts.filter((s) => s.applied);
  assert.deepEqual(applied.map((s) => s.ids), [['REQ-3001'], ['CON-0203']]);
  assert.match(v.forecast.why, /Before fitting, 2 known effects were taken out of the history: REQ-3001 \(a step of \+\d+ CU from 2026-12-07\); CON-0203 \(a step of \+\d+ CU from 2027-02-15\)\.$/);
  const ev = v.trace.find((t) => t.number === 1).evidence.find((e) => e.label === 'Taken out of the history first');
  assert.match(ev.value, /^2 known effects were taken out of the history: REQ-3001/);
  assert.match(describe([{ shape: 'spike', ids: ['EVT-S02'], size_cu: 1249, weeks: 2, week_start: '2026-12-14', applied: true }]), /^Before fitting, one known effect was taken out of the history: EVT-S02 \(a spike of \+1,249 CU for 2 weeks from 2026-12-14\)\.$/);
  assert.equal(describe([{ applied: false }]), '');
});

test('the Outcome holds the trend model to the trend plus the steps already in its history, so a step is not counted against it', () => {
  const store = freshStore();
  for (const w of [8, 8, 10]) store.advanceTime(w);
  const o = buildOutcome(store);
  const eus = o.pools.find((p) => p.pool_id === P.eus);
  const late = eus.chart.rows.filter((r) => r.made_at_week >= 8);
  assert.ok(late.length > 0 && late.every((r) => r.trend.known_cu > 300), 'once REQ-1001 is in the history the trend is held to a level that includes it');
  for (const p of o.pools) assert.ok(Math.abs(p.forecast.trend.bias_pct) < 4, `${p.region_label}: the trend model alone is ${p.forecast.trend.bias_pct.toFixed(1)}% off on average over 26 weeks`);
});
