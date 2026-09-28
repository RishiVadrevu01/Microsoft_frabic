'use strict';
/*
 * KNOWN EFFECTS: a step that has happened must not be read as growth, and neither must a spike that has come and gone.
 *
 * When a request goes live or a contract takes effect, a pool's usage jumps once and then carries on at its old pace. When a
 * seasonal event runs, usage is raised for a few weeks and falls back. A trend model that sees only the series cannot tell
 * either from a change in growth: it raises its slope (and, once it switches to Holt smoothing, starts from a level below the
 * one just read), and the spike inflates its estimate of the noise for as long as it stays in the window. The plan then orders
 * for growth that was never there.
 *
 * The engine does know some of these happened, because the records say so: a request has a `live_on`, a contract an
 * `in_effect_on`, a sized launch or relocation has a date that has passed, and a seasonal event has a date and a duration. So,
 * before the forecast is fitted:
 *
 *   1. each such date is looked up in the history (the first weekly reading that could include it);
 *   2. its size is MEASURED FROM THE SERIES ITSELF: where the trend of the 12 readings before it was heading, against where the
 *      readings from then on actually are (the median of 3 readings for a step, of the readings the spike covers for a spike).
 *      Nothing recorded about the size is read: a request's `realized_cu` is what the lab generated, not something a planner
 *      would know, and test/shifts.test.js proves the forecast does not change when it does;
 *   3. it counts only if it clears the noise (3 residual standard deviations of that trend, with a floor of half a percent of
 *      the level). A launch that never happened, or a request too small to see, is left alone and reported as skipped;
 *   4. an accepted STEP is taken out by raising every earlier reading by it, so the whole history sits at today's level, and an
 *      accepted SPIKE by lowering the readings it covers by its size. The trend is then fitted on that, and the forecast starts
 *      from the level usage actually runs at.
 *
 * Effects are taken oldest first, each measured on a series with the earlier ones already removed (so one does not inflate the
 * noise of the next), and steps that land in the same week are measured once, as one jump.
 *
 * Then the history is scanned for a jump that NO record names (a tenant that moved in without a request on file). It is held to a
 * higher bar, because scanning many weeks is many chances to be fooled by noise: 5 standard deviations, lasting at least 3
 * readings, and every reading since staying on the new side of the old trend (a spike that came back is not a step). So an
 * unrecorded jump is recognised about four weeks after it happens, not before.
 *
 * What this does not do: a step under the bar is left as noise, an unrecorded spike (a one-off outage) is not looked for, and a
 * spike still running counts only the weeks that have happened. On a history with no such record and no such jump nothing
 * changes: the series goes through as it is.
 */

const { linearFit } = require('./forecast');

const PRE_WEEKS = 12;          // readings before the effect that show where the trend was heading
const POST_WEEKS = 3;          // readings from a step on that show where it went
const MIN_PRE = 6;             // fewer than this before the effect and there is no trend to compare with
const SIGMAS = 3;              // an effect counts at this many standard deviations of the trend it is measured against
const FLOOR_SHARE = 0.005;     // ...and the deviation is never taken below half a percent of the level
// An unrecorded jump: nothing says where to look, so the bar is higher.
const SCAN_WEEKS = 26;         // only the recent history, which is what the forecast is fitted on
const UNRECORDED_SIGMAS = 5;   // scanning is many chances to be fooled by noise
const MIN_LASTED = 3;          // readings it must have lasted: a one-week outlier or a two-week blip is not a step
const TAIL_WEEKS = 8;          // and every reading since, up to this many, must stay on the new side of the old trend...
const TAIL_KEEP = 0.5;         // ...by at least this share of the step (a spike that came back fails this)
const MAX_UNRECORDED = 2;      // at most this many found in one history
// A step happens in one week; acceleration builds up over many. Without this test a pool that is speeding up reads as a step.
const SHARP_SHARE = 0.6;       // one week's change, beyond the usual weekly change, must account for this share of the step...
const SHARP_SIGMAS = 3;        // ...and stand this far out from how much the weekly change usually varies

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

/**
 * The dated things the records say moved a pool's usage. Only what has a date (and a duration) on the record: nothing about how big.
 * @param {{requests:object[], contracts:object[], events:object[]}} records this pool's records, in every status
 */
function shiftCandidates({ requests, contracts, events }) {
  return [
    ...requests.filter((r) => r.status === 'live' && r.live_on).map((r) => ({ shape: 'step', kind: 'request', id: r.request_id, date: r.live_on, label: r.title })),
    ...contracts.filter((c) => c.in_effect_on).map((c) => ({ shape: 'step', kind: 'contract', id: c.contract_id, date: c.in_effect_on, label: String(c.customer).split(' (')[0] })),
    ...events.filter((e) => e.magnitude_cu && (e.effect === 'demand' || e.effect === 'relocate-in')).map((e) => ({ shape: 'step', kind: 'event', id: e.event_id, date: e.date, label: e.title })),
    ...events.filter((e) => e.signal === 'seasonal' && e.duration_weeks).map((e) => ({ shape: 'spike', kind: 'event', id: e.event_id, date: e.date, weeks: e.duration_weeks, label: e.title })),
  ];
}

/** Where usage was heading before reading `i`, or why that cannot be told. */
function trendBefore(y, i) {
  const pre = y.slice(Math.max(0, i - PRE_WEEKS), i);
  if (pre.length < MIN_PRE) return null;
  return { fit: linearFit(pre), level: mean(pre) };
}

/** How far the readings `ks` sit from that trend, in CU (their median) and in standard deviations. */
function excess(y, i, ks) {
  const t = trendBefore(y, i);
  if (!t) return null;
  const size = median(ks.map((k) => y[k] - t.fit.predict(k - i + 1)));
  const sd = Math.max(t.fit.sigma(median(ks.map((k) => k - i + 1))), FLOOR_SHARE * t.level);
  return { size, sigmas: size / sd };
}

/**
 * The strongest jump in the recent history that lasted and that nothing has explained, or null. Every reading from the jump on
 * (up to TAIL_WEEKS) has to stay on the new side of where the trend before it was heading.
 */
function findUnrecordedStep(y) {
  const n = y.length;
  let best = null;
  for (let i = Math.max(MIN_PRE, n - SCAN_WEEKS); i <= n - MIN_LASTED; i++) {
    const t = trendBefore(y, i);
    if (!t) continue;
    const at = (k) => y[k] - t.fit.predict(k - i + 1);
    const first = []; for (let k = i; k < i + MIN_LASTED; k++) first.push(k);
    const size = median(first.map(at));
    if (!size) continue;
    const sd = Math.max(t.fit.sigma(median(first.map((k) => k - i + 1))), FLOOR_SHARE * t.level);
    const sigmas = size / sd;
    if (Math.abs(sigmas) < UNRECORDED_SIGMAS) continue;
    let stays = true;
    for (let k = i; k <= Math.min(n - 1, i + TAIL_WEEKS - 1); k++) if (Math.sign(at(k)) !== Math.sign(size) || Math.abs(at(k)) < TAIL_KEEP * Math.abs(size)) stays = false;
    if (stays && sharp(y, i, size) && (!best || Math.abs(sigmas) > Math.abs(best.sigmas))) best = { i, size, sigmas };
  }
  return best;
}

/** Did most of the step happen in the one week from reading i-1 to reading i, standing out from the usual week-to-week change? */
function sharp(y, i, size) {
  const before = [];
  for (let k = Math.max(1, i - PRE_WEEKS); k < i; k++) before.push(y[k] - y[k - 1]);
  if (before.length < MIN_PRE - 1) return false;
  const usual = median(before);
  const spread = Math.max(1.4826 * median(before.map((d) => Math.abs(d - usual))), FLOOR_SHARE * mean(y.slice(Math.max(0, i - PRE_WEEKS), i)));
  const jump = (y[i] - y[i - 1]) - usual;
  return Math.sign(jump) === Math.sign(size) && Math.abs(jump) >= SHARP_SHARE * Math.abs(size) && Math.abs(jump) / spread >= SHARP_SIGMAS;
}

/**
 * The history the forecast should be fitted on: the readings, with every effect the records name and the series shows taken out,
 * and then any lasting jump that nothing names.
 * @param {string[]} weeks week_start of each reading, oldest first
 * @param {number[]} values the readings
 * @param {object[]} candidates from shiftCandidates
 * @param {{unrecorded?:boolean}} [opts] `unrecorded: false` leaves out the scan for a jump no record names
 * @returns {{values:number[], steps:object[]}} `steps` says what was found and what was left alone, and why
 */
function adjustForLevelShifts(weeks, values, candidates, { unrecorded = true } = {}) {
  const y = values.slice();
  const found = [];
  const groups = new Map();                                       // steps in the same reading are one jump; a spike is its own
  for (const c of candidates) {
    const i = weeks.findIndex((w) => w >= c.date);
    if (i < 0) continue;                                          // dated after the last reading: it is not in the history yet
    const key = c.shape === 'spike' ? `spike|${i}|${c.id}` : `step|${i}`;
    if (!groups.has(key)) groups.set(key, { i, shape: c.shape, list: [] });
    groups.get(key).list.push(c);
  }
  const order = [...groups.values()].sort((a, b) => a.i - b.i || (a.shape === 'step' ? -1 : 1) - (b.shape === 'step' ? -1 : 1));
  for (const g of order) {
    const { i, shape, list } = g;
    const base = { shape, ids: list.map((c) => c.id).sort(), kinds: [...new Set(list.map((c) => c.kind))], labels: list.map((c) => c.label), date: list.map((c) => c.date).sort()[0], week_start: weeks[i], reading: i };
    const ks = [];
    const last = shape === 'spike' ? Math.min(y.length - 1, i + list[0].weeks - 1) : Math.min(y.length - 1, i + POST_WEEKS - 1);
    for (let k = i; k <= last; k++) ks.push(k);
    if (shape === 'spike') base.weeks = ks.length;
    const m = excess(y, i, ks);
    if (!m) { found.push({ ...base, size_cu: null, sigmas: null, applied: false, reason: 'there is too little history before it to see a trend' }); continue; }
    if (Math.abs(m.sigmas) < SIGMAS) {
      found.push({ ...base, size_cu: Math.round(m.size), sigmas: +m.sigmas.toFixed(1), applied: false, reason: `it is not clearly above the noise (${m.sigmas.toFixed(1)} against ${SIGMAS} standard deviations)` });
      continue;
    }
    if (shape === 'step') for (let j = 0; j < i; j++) y[j] += m.size;      // the whole history now sits at the level after the step
    else for (const k of ks) y[k] -= m.size;                               // the weeks the spike covered come back to the trend
    found.push({ ...base, size_cu: Math.round(m.size), sigmas: +m.sigmas.toFixed(1), applied: true, reason: null });
  }
  // a lasting jump that no record names: found in the readings alone, and taken out the same way
  for (let f = 0; unrecorded && f < MAX_UNRECORDED; f++) {
    const u = findUnrecordedStep(y);
    if (!u) break;
    for (let j = 0; j < u.i; j++) y[j] += u.size;
    found.push({ shape: 'step', ids: [], kinds: ['unrecorded'], labels: ['a jump no record names'], date: weeks[u.i], week_start: weeks[u.i], reading: u.i, size_cu: Math.round(u.size), sigmas: +u.sigmas.toFixed(1), applied: true, reason: null });
  }
  return { values: y, steps: found };
}

const applied = (steps) => steps.filter((s) => s.applied);
const signed = (n) => `${n >= 0 ? '+' : ''}${n.toLocaleString('en-US')}`;
/** One sentence for the plan's "why this model": what was taken out of the history, or empty. */
function describe(steps) {
  const a = applied(steps);
  if (!a.length) return '';
  return `Before fitting, ${a.length === 1 ? 'one known effect was' : `${a.length} known effects were`} taken out of the history: ${a.map((s) => (s.shape === 'spike'
    ? `${s.ids.join(' and ')} (a spike of ${signed(s.size_cu)} CU for ${s.weeks} week${s.weeks === 1 ? '' : 's'} from ${s.week_start})`
    : s.kinds.includes('unrecorded') ? `a step of ${signed(s.size_cu)} CU from ${s.week_start} that no record names (found in the readings)`
      : `${s.ids.join(' and ')} (a step of ${signed(s.size_cu)} CU from ${s.week_start})`)).join('; ')}.`;
}

module.exports = { shiftCandidates, adjustForLevelShifts, describe, applied, excess, PRE_WEEKS, POST_WEEKS, MIN_PRE, SIGMAS, FLOOR_SHARE };
