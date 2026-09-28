'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forecastSeries, quantile, HORIZON_WEEKS } = require('../server/lib/forecast');
const { mulberry32, normal } = require('../server/lib/rng');
const { addWeeks, addDays, daysBetween, isDate, fmt } = require('../server/lib/dates');

const CFG = { window_weeks: 26, backtest_horizon_weeks: 8, holt_margin: 0.1, p_upper_z: 0.8416 };

function series(n, fn, noise = 0, seed = 7) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, t) => fn(t) + normal(rand) * noise);
}

test('a straight noisy line is recovered: slope close to truth and the simple model is kept', () => {
  const y = series(52, (t) => 1000 + 20 * t, 15);
  const f = forecastSeries(y, CFG);
  assert.equal(f.model, 'linear');
  assert.ok(Math.abs(f.slope_per_week - 20) < 2, `slope ${f.slope_per_week}`);
});

test('the p80 line is above the middle line and the gap widens with the horizon', () => {
  const f = forecastSeries(series(52, (t) => 1000 + 20 * t, 30), CFG);
  for (let h = 0; h < HORIZON_WEEKS; h++) assert.ok(f.upper[h] >= f.p50[h] && f.p50[h] >= f.lower[h]);
  assert.ok(f.upper[100] - f.p50[100] > f.upper[3] - f.p50[3]);
});

test('a growth spurt is followed better by Holt smoothing than by the straight line', () => {
  const y = series(52, (t) => (t < 30 ? 2000 + 10 * t : 2300 + 90 * (t - 30)), 10);
  const f = forecastSeries(y, CFG);
  assert.equal(f.model, 'holt');
  assert.ok(f.backtest.holt_mae < f.backtest.linear_mae * 0.9);
});

test('a slope override replaces the fitted trend and is labelled as a what-if', () => {
  const y = series(52, (t) => 1000 + 20 * t, 15);
  const f = forecastSeries(y, CFG, { slope: 50 });
  assert.ok(f.overridden);
  assert.match(f.model, /slope overridden/);
  assert.ok(Math.abs(f.p50[9] - (y[51] + 50 * 10)) < 1e-6);
});

test('too little history falls back to the line and says so', () => {
  const f = forecastSeries(series(30, (t) => 100 + t), CFG);
  assert.equal(f.model, 'linear');
  assert.match(f.why, /Not enough history/);
});

test('forecast never goes negative', () => {
  const f = forecastSeries(series(52, (t) => 500 - 9 * t, 5), CFG);
  assert.ok(f.p50.every((v) => v >= 0));
  assert.ok(f.lower.every((v) => v >= 0));
});

test('quantile interpolates between order statistics', () => {
  assert.equal(quantile([15, 17, 18, 19, 20, 21], 0.8), 20);
  assert.ok(Math.abs(quantile([17, 17, 18, 20], 0.8) - 18.8) < 1e-9);
  assert.equal(quantile([5], 0.8), 5);
});

test('date arithmetic is calendar-exact and time-zone free', () => {
  assert.equal(addWeeks('2026-09-21', 2), '2026-10-05');
  assert.equal(addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(daysBetween('2026-09-21', '2027-09-20'), 364);
  assert.equal(fmt('2026-09-21'), '21 Sep 2026');
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026-13-01'));
  assert.ok(!isDate('tomorrow'));
});
