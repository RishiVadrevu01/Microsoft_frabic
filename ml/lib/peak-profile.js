'use strict';
/*
 * The peak profile: what the hourly corpus and the hourly forecast say about each pool's BUSIEST HOUR,
 * in a small file the lab's engine can read without knowing anything about hourly data.
 *
 * The lab plans on weekly readings, and a weekly reading is a mean. Capacity has to cover the busiest hour.
 * This profile carries the two facts needed to check the plan against that:
 *
 *   busiest_hour_ratio   the busiest hour of a week divided by that week's mean, averaged over the lab's 52
 *                        weeks. A plan sized on the weekly mean is short by this factor at the peak.
 *   weekly_ratio         the same ratio, week by week, so the engine can say how long a pool has been over
 *                        its working ceiling at the peak (its weekly readings give the means).
 *   next_week            the model's forecast for the coming 168 hours: the mean, and the busiest hour at
 *                        p80 (the level the lab plans at) and p95.
 *
 * Like the corpus it is generated, and tied to the lab: `history.mean_last_week` must equal the lab's own
 * latest weekly reading, which is how the engine refuses a profile built for different data.
 */

const crypto = require('node:crypto');
const { WEEK_H } = require('./corpus');

const PROFILE_VERSION = '2026.09.0';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/** The forecast CSV (ml/out/forecast_next_168h.csv) as one summary per pool. */
function parseForecast(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ['pool_id', 'ts_utc', 'horizon_h', 'local_hour', 'p50', 'p80', 'p95']) if (!(need in col)) throw new Error(`forecast_next_168h.csv has no ${need} column`);
  const byPool = {};
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    (byPool[c[col.pool_id]] ||= []).push({ ts: c[col.ts_utc], h: +c[col.horizon_h], local_hour: +c[col.local_hour], p50: +c[col.p50], p80: +c[col.p80], p95: +c[col.p95] });
  }
  const out = {};
  for (const [id, rows] of Object.entries(byPool)) {
    if (rows.length !== 168) throw new Error(`${id}: expected 168 forecast hours, found ${rows.length}`);
    const top80 = rows.reduce((b, r) => (r.p80 > b.p80 ? r : b), rows[0]);
    const top95 = rows.reduce((b, r) => (r.p95 > b.p95 ? r : b), rows[0]);
    out[id] = {
      starts_utc: rows[0].ts, mean_p50: round(mean(rows.map((r) => r.p50)), 1),
      busiest_p80: round(top80.p80, 1), busiest_p80_at_utc: top80.ts, busiest_p80_local_hour: top80.local_hour,
      busiest_p95: round(top95.p95, 1), busiest_p95_at_utc: top95.ts, busiest_p95_local_hour: top95.local_hour,
    };
  }
  return out;
}

/**
 * @param {object} corpus the built corpus (ml/lib/corpus buildCorpus)
 * @param {string} forecastCsv contents of ml/out/forecast_next_168h.csv
 * @param {{corpusFiles:object, backtest:object}} provenance the corpus meta's file checksums, and backtest.json
 */
function buildPeakProfile(corpus, forecastCsv, provenance) {
  const forecast = parseForecast(forecastCsv);
  const known = corpus.knownWeeks;
  const firstKnown = corpus.totalWeeks - known;
  const pools = corpus.pools.map((p) => {
    const id = p.pool.pool_id;
    const f = forecast[id];
    if (!f) throw new Error(`${id} is missing from the forecast`);
    const ratios = []; const p95s = [];
    for (let k = firstKnown; k < corpus.totalWeeks; k++) {
      const wk = Array.from(p.y.subarray(k * WEEK_H, (k + 1) * WEEK_H));
      const m = mean(wk);
      ratios.push(Math.max(...wk) / m);
      p95s.push([...wk].sort((a, b) => a - b)[Math.floor(0.95 * (WEEK_H - 1))] / m);
    }
    const last = Array.from(p.y.subarray(corpus.hours - WEEK_H));
    return {
      pool_id: id,
      weeks: known,
      busiest_hour_ratio: round(mean(ratios)),
      busiest_hour_ratio_sd: round(sd(ratios)),
      p95_hour_ratio: round(mean(p95s)),
      weekly_ratio: ratios.map((r) => round(r)),
      history: { mean_last_week: mean(last), busiest_hour_last_week: Math.max(...last) },
      next_week: f,
    };
  });
  const forecastStart = pools[0].next_week.starts_utc;
  const files = provenance.corpusFiles;
  return {
    source: 'synthetic',
    profile_version: PROFILE_VERSION,
    as_of: corpus.asOf,
    notice: 'Generated from the synthetic hourly corpus and its forecast. It describes how the load sits inside a week; it is not measured data.',
    definition: {
      busiest_hour_ratio: 'The busiest hour of a week divided by that week\'s mean, averaged over the lab\'s weeks. The lab\'s weekly readings are means.',
      weekly_ratio: 'The same ratio for each of the lab\'s weeks, oldest first, aligned with utilization.json.',
      next_week: 'The model forecast for the 168 hours from the dataset\'s as_of: the mean of the p50, and the busiest hour at p80 and at p95.',
    },
    generated_from: {
      corpus_files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.sha256])),
      forecast_sha256: sha256(forecastCsv),
      model: { library: 'lightgbm', version: provenance.backtest.generated_with.lightgbm },
      forecast_starts_utc: forecastStart,
    },
    pools,
  };
}

module.exports = { buildPeakProfile, parseForecast, PROFILE_VERSION };
