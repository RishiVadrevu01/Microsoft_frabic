'use strict';
/*
 * Guards on the results of `npm run ml`. The training itself is Python and slow, so it is not run here;
 * these tests read what it wrote and hold it to account. They skip until it has been run, and they fail
 * if the corpus has changed since (the results would describe data that is no longer there).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadRaw, indexData } = require('../server/lib/data');
const { DATA_DIR, P } = require('./helpers');

const ML = path.join(__dirname, '..', 'ml');
const OUT = path.join(ML, 'out');
const ran = fs.existsSync(path.join(OUT, 'backtest.json')) && fs.existsSync(path.join(ML, 'corpus', 'meta.json'));
const opts = { skip: ran ? false : 'run npm run ml first' };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const data = indexData(loadRaw(DATA_DIR));

const bt = () => JSON.parse(read(OUT, 'backtest.json'));

test('the results were produced on the corpus that is on disk, with no peeking and no leaked features', opts, () => {
  const b = bt();
  for (const [name, f] of Object.entries(b.corpus.files)) assert.equal(sha(read(ML, 'corpus', name)), f.sha256, `${name} changed since the model was trained: run npm run ml`);
  assert.equal(b.setup.leakage_check_passed, true);
  const hours = b.setup.hours_per_pool;
  assert.equal(b.setup.first_test_hour, hours - b.setup.test_weeks * 168, 'the test window is the last weeks, and nothing from it was trained on');
  assert.ok(b.setup.validation_weeks >= 2);
  assert.equal(b.setup.forecast_horizon_hours, 168);
  assert.equal(b.generated_with.fast, false, 'the reported results come from the full run, not the quick check');
});

test('the model earns its place: it beats repeating last week, overall, at every distance and on every pool', opts, () => {
  const t = bt().test;
  const finite = (x) => Number.isFinite(x) && x > 0 && x < 0.5;
  for (const v of [t.overall, ...Object.values(t.by_horizon), ...Object.values(t.by_pool)]) {
    assert.ok(finite(v.lightgbm) && finite(v.seasonal_naive) && finite(v.profile_4wk));
    assert.ok(v.lightgbm < v.seasonal_naive, `LightGBM ${v.lightgbm} should beat repeating last week ${v.seasonal_naive}`);
  }
  assert.equal(Object.keys(t.by_horizon).length, 4);
  assert.equal(Object.keys(t.by_pool).length, 6);
  assert.ok(t.overall.n > 100000, 'a large rolling-origin test');
});

test('the ranges are honest: p80 covers about 80% and p95 about 95% on weeks the stretch was not learned on', opts, () => {
  const c = bt().test.calibration;
  // Coverage is very sensitive when the noise is small (half a percent of level moves it several points), so the
  // guard is four points either side: it catches a broken or badly miscalibrated model, not ordinary variation.
  assert.ok(Math.abs(c.p80.lightgbm - 0.8) < 0.04, `p80 covers ${c.p80.lightgbm}`);
  assert.ok(Math.abs(c.p95.lightgbm - 0.95) < 0.04, `p95 covers ${c.p95.lightgbm}`);
  for (const k of ['p80', 'p95']) assert.ok(c[k].scale > 0.9 && c[k].scale < 1.6, `${k} stretch ${c[k].scale} is a small correction, not a rescue`);
  for (const v of Object.values(c.by_horizon_p80)) assert.ok(Math.abs(v - 0.8) < 0.07, 'p80 holds at every distance');
});

test('the next-week forecast covers every pool and hour, with ranges in order and starting where the corpus ends', opts, () => {
  const rows = read(OUT, 'forecast_next_168h.csv').trim().split('\n');
  assert.equal(rows[0], 'pool_id,ts_utc,horizon_h,local_hour,p50,p80,p95');
  assert.equal(rows.length, 1 + 6 * 168);
  const byPool = {};
  for (const r of rows.slice(1)) { const [pool, ts, h, lh, p50, p80, p95] = r.split(','); (byPool[pool] ||= []).push({ ts, h: +h, lh: +lh, p50: +p50, p80: +p80, p95: +p95 }); }
  assert.deepEqual(Object.keys(byPool).sort(), data.pools.map((p) => p.pool_id).sort());
  for (const [pool, list] of Object.entries(byPool)) {
    const cap = data.poolById[pool].capacity_units;
    assert.equal(list.length, 168);
    assert.equal(list[0].ts, `${data.as_of}T00:00:00Z`, 'the first forecast hour is the hour after the corpus ends');
    list.forEach((r, j) => {
      assert.equal(r.h, j + 1);
      assert.ok(r.p50 > 0 && r.p50 <= r.p80 && r.p80 <= r.p95, `${pool} hour ${r.h}: ${r.p50} <= ${r.p80} <= ${r.p95}`);
      assert.ok(r.p95 < 1.25 * cap, `${pool} hour ${r.h}: p95 ${r.p95} against capacity ${cap}`);
      if (j) assert.equal(Date.parse(r.ts) - Date.parse(list[j - 1].ts), 3600000);
    });
    const mean = list.reduce((s, r) => s + r.p50, 0) / 168;
    const last = data.utilByPool[pool].at(-1).utilized_units;
    assert.ok(Math.abs(mean / last - 1) < 0.06, `${pool}: next week's mean ${mean.toFixed(0)} against this week's ${last}`);
  }
});

test('the report ties to the lab: this week\'s mean is the lab\'s own latest reading', opts, () => {
  const nw = bt().next_week;
  assert.equal(nw.length, 6);
  for (const n of nw) {
    assert.equal(n.last_week_mean, data.utilByPool[n.pool_id].at(-1).utilized_units, n.pool_id);
    assert.ok(n.busiest_hour_p95 > n.next_week_mean_p50, 'the busiest hour is above the mean');
    assert.ok(n.busiest_hour_p95_share_of_capacity > 0 && n.busiest_hour_p95_share_of_capacity < 1.25);
  }
  const eus = nw.find((n) => n.pool_id === P.eus);
  assert.ok(eus.busiest_hour_p95_share_of_capacity > eus.last_week_mean / eus.capacity_units + 0.08, 'the peak sits well above the mean utilization the lab plans on');
  const report = read(OUT, 'report.md');
  assert.match(report, /generated, not measured/);
  assert.match(report, /## What this does not tell you/);
});

test('three quantile models were saved, and the funnel-signal test was decided before the test weeks', opts, () => {
  for (const q of ['p50', 'p80', 'p95']) assert.match(read(OUT, 'models', `lightgbm_${q}.txt`).slice(0, 40), /^tree/);
  const fs_ = bt().extras.funnel_signals;
  assert.equal(typeof fs_.used_signals, 'boolean');
  assert.equal(fs_.used_signals, fs_.validation_pinball_p50_with_signals < 0.99 * fs_.validation_pinball_p50_calendar_and_lags, 'the choice follows the validation numbers, with a 1% margin for training noise');
});
