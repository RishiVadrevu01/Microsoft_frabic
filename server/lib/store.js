'use strict';
/*
 * The lab's working data: the untouched synthetic seed + whatever the person
 * doing the lab has done on top of it (scenarios applied, requests submitted,
 * decisions recorded). The seed files are never written. Everything the user
 * does lives in runtime/state.json, so `npm run reset` is just deleting a file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadRaw, indexData, clone } = require('./data');
const scenarios = require('./scenarios');
const { assessPool } = require('./verdict');
const { loadPeakProfile, buildPeakChecks } = require('./peak');
const { advance, advanceLimit } = require('./clock');
const { takeSnapshot } = require('./outcome');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// `advance.weeks` is how far the lab's "today" has moved (clock.js replays it from the seed); `ledger` holds what was
// predicted and planned at each point it moved (outcome.js), so the actuals can be compared with it later.
const emptyState = () => ({ scenarios: [], requests: [], decisions: [], orders: [], completed: {}, resets: 0, advance: { weeks: 0 }, ledger: [] });

function readState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return emptyState();
  try {
    const s = { ...emptyState(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
    s.scenarios = s.scenarios.filter((id) => scenarios.has(id));
    // a saved file from before the clock existed has neither field; one that is damaged is treated as not advanced
    const weeks = s.advance && Number.isInteger(s.advance.weeks) && s.advance.weeks > 0 ? s.advance.weeks : 0;
    s.advance = { weeks };
    s.ledger = weeks && Array.isArray(s.ledger) && s.ledger.length ? s.ledger : [];
    if (weeks && !s.ledger.length) s.advance = { weeks: 0 };
    return s;
  } catch {
    return emptyState();
  }
}

function createStore({ dataDir, statePath = null, peakProfilePath = null }) {
  const raw = loadRaw(dataDir);
  let state = readState(statePath);
  const peakLoaded = loadPeakProfile(peakProfilePath, raw);    // optional: without it the peak check says why it is unavailable
  let cache = null;
  let baseline = null;

  const persist = () => {
    if (!statePath) return;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };

  // The seed, then whatever the person did on top of it. `weeks` moves the lab's "today" forward (clock.js).
  function working(weeks) {
    const w = clone(raw);
    for (const id of state.scenarios) scenarios.apply(id, w);
    for (const r of state.requests) w.requests.push(clone(r));
    for (const o of state.orders) w.supply.push(clone(o));
    const clock = weeks > 0 ? advance(w, weeks) : null;
    return { w, clock };
  }
  function build() {
    const { w, clock } = working(state.advance.weeks);
    const data = indexData(w);
    cache = { data, clock, all: data.pools.map((p) => assessPool(data, p.pool_id)) };
  }
  const ensure = () => { if (!cache) build(); return cache; };
  const invalidate = () => { cache = null; persist(); };
  const limitNow = () => advanceLimit();

  return {
    HttpError,
    data: () => ensure().data,
    all: () => ensure().all,
    verdicts: () => ensure().all.map((a) => a.verdict),
    // The peak check for every pool, built on first use and dropped with the assessments when anything changes.
    peak: () => {
      const c = ensure();
      if (!c.peak) {
        // The profile was measured on the shipped history: once the lab has moved on, its ratios no longer line up with the weeks.
        if (state.advance.weeks > 0) c.peak = { available: false, reason: `The busiest-hour profile was built for the shipped dataset, and the lab has been advanced ${state.advance.weeks} week${state.advance.weeks === 1 ? '' : 's'}. Reset the lab to see it.`, pools: new Map(), summary: null };
        else c.peak = peakLoaded.available ? buildPeakChecks(c.data, c.all, peakLoaded) : { available: false, reason: peakLoaded.reason, pools: new Map(), summary: null };
      }
      return c.peak;
    },
    assessment: (poolId) => {
      const a = ensure().all.find((x) => x.verdict.pool_id === poolId);
      if (!a) throw new HttpError(404, `Unknown pool ${poolId}`);
      return a;
    },
    // A what-if: recompute one pool with overrides, without changing any state.
    whatIf: (poolId, overrides) => {
      const data = ensure().data;
      if (!data.poolById[poolId]) throw new HttpError(404, `Unknown pool ${poolId}`);
      return assessPool(data, poolId, overrides);
    },
    // The dataset as shipped, with nothing applied. Used for before/after comparisons.
    baseline: () => {
      if (!baseline) {
        const data = indexData(clone(raw));
        baseline = data.pools.map((p) => assessPool(data, p.pool_id).verdict);
      }
      return baseline;
    },
    rawMeta: () => raw.meta,
    state: () => clone(state),

    applyScenario(id) {
      if (!scenarios.has(id)) throw new HttpError(404, `Unknown scenario ${id}`);
      if (state.scenarios.includes(id)) throw new HttpError(409, 'That scenario is already applied. Reset the lab to start over.');
      const before = ensure().all.map((a) => a.verdict);
      const lived = ensure().clock;
      state.scenarios.push(id);
      // The weeks already lived through are history. A scenario that would change what happened in them (a request or a
      // contract that falls due in them, a delivery that lands or slips differently) would rewrite the past, so it is refused.
      if (state.advance.weeks > 0 && JSON.stringify(working(state.advance.weeks).clock) !== JSON.stringify(lived)) {
        state.scenarios.pop();
        throw new HttpError(409, 'That scenario would change what has already happened in the weeks the lab has advanced. Apply it before advancing, or reset the lab.');
      }
      invalidate();
      return { before, after: ensure().all.map((a) => a.verdict) };
    },

    // ---- the lab's clock (clock.js) and the record of what was predicted when it moved (outcome.js)
    clock: () => ensure().clock,
    advanceInfo: () => {
      const c = ensure();
      if (!c.info) {
        const lim = limitNow();
        c.info = { weeks: state.advance.weeks, max_weeks: lim.max_weeks, remaining: Math.max(0, lim.max_weeks - state.advance.weeks), reason: lim.reason };
      }
      return c.info;
    },
    advanceTime(weeks) {
      const n = Number(weeks);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'weeks must be a whole number of 1 or more.');
      const lim = limitNow();
      const room = lim.max_weeks - state.advance.weeks;
      if (n > room) {
        throw new HttpError(409, room <= 0
          ? `The lab cannot advance any further (${lim.max_weeks} weeks in all): ${lim.reason}`
          : `The lab can advance ${room} more week${room === 1 ? '' : 's'} at most (${lim.max_weeks} in all): ${lim.reason}`);
      }
      // Record what is predicted and planned NOW, before the world moves: this is what the actuals will be held against.
      const now = ensure();
      const before = now.all.map((a) => a.verdict);
      state.ledger.push(takeSnapshot(now.data, now.all, state.advance.weeks));
      state.advance = { weeks: state.advance.weeks + n };
      invalidate();
      return { before, after: ensure().all.map((a) => a.verdict), clock: ensure().clock };
    },

    addRequest(req) {
      const before = ensure().all.map((a) => a.verdict);
      state.requests.push(req);
      invalidate();
      return { before, after: ensure().all.map((a) => a.verdict) };
    },

    recordDecision(record, order) {
      state.decisions.push(record);
      if (order) state.orders.push(order);
      invalidate();
    },

    nextId(kind) {
      if (kind === 'request') return `REQ-${7001 + state.requests.length}`;
      if (kind === 'decision') return `DEC-${String(state.decisions.length + 1).padStart(4, '0')}`;
      if (kind === 'order') return `ORD-LAB-${String(state.orders.length + 1).padStart(4, '0')}`;
      throw new Error(`Unknown id kind ${kind}`);
    },

    latch(labId, passed) {
      if (passed && !state.completed[labId]) { state.completed[labId] = true; persist(); }
    },

    // Clears what the user did to the data. `progress` also clears lab progress.
    reset({ progress = false } = {}) {
      state = progress
        ? emptyState()
        : { ...emptyState(), completed: state.completed, resets: state.resets + 1 };
      invalidate();
    },
  };
}

module.exports = { createStore, HttpError };
