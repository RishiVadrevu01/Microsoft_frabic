'use strict';
/*
 * Weekly utilisation forecast: the one funnel in the lab that is statistical
 * learning rather than a rule.
 *
 * Two candidates are fitted to the history:
 *   linear : least-squares line over the most recent window (default 26 weeks)
 *   holt   : Holt's double exponential smoothing (level + trend), grid-searched
 * A rolling-origin backtest scores each candidate on how well it predicted
 * `backtest_horizon_weeks` ahead at several past origins. Simplest first: Holt
 * only replaces the line when it is at least `holt_margin` (10%) better.
 *
 * Planning uses the p80 path (p50 + z * sigma), not the middle: a pool should
 * be ordered against the demand we are 80% sure to have reached.
 */

const crypto = require('node:crypto');

const HORIZON_WEEKS = 104;
// The shape of what forecastSeries returns. Bump it when a field is added, removed or changes meaning (docs/CONTRACTS.md).
const FORECAST_CONTRACT = 'forecast/1';

// Standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1e-7): what quantile the p_upper_z multiplier corresponds to.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = 0.3989423 * Math.exp((-z * z) / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - tail : tail;
}

// A short fingerprint of exactly what was fitted: the history, the settings and any hand-set slope. Two forecasts with the
// same fingerprint are the same forecast, so a plan can say which one it was built on.
function fingerprint(values, cfg, slope) {
  const body = JSON.stringify({ values: values.map((v) => +v.toFixed(6)), cfg, slope: Number.isFinite(slope) ? slope : null });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function linearFit(y) {
  const n = y.length;
  const xbar = (n - 1) / 2;
  const ybar = y.reduce((a, v) => a + v, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (i - xbar) ** 2; sxy += (i - xbar) * (y[i] - ybar); }
  const b = sxy / sxx;
  const a = ybar - b * xbar;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i] - (a + b * i)) ** 2;
  const s = Math.sqrt(sse / Math.max(1, n - 2));
  return {
    slope: b,
    fitted_last: a + b * (n - 1),
    predict: (h) => a + b * (n - 1 + h),
    sigma: (h) => s * Math.sqrt(1 + 1 / n + ((n - 1 + h - xbar) ** 2) / sxx),
    resid_sd: s,
  };
}

function holtRun(y, alpha, beta) {
  const lead = Math.min(4, y.length - 1);
  let level = y[0];
  let trend = (y[lead] - y[0]) / lead;
  let sse = 0;
  for (let i = 1; i < y.length; i++) {
    const err = y[i] - (level + trend);
    sse += err * err;
    const prev = level;
    level = alpha * y[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return { level, trend, sse, s: Math.sqrt(sse / Math.max(1, y.length - 1)) };
}

function holtFit(y) {
  let best = null;
  for (const alpha of [0.3, 0.5, 0.7]) {
    for (const beta of [0.05, 0.15]) {
      const r = holtRun(y, alpha, beta);
      if (!best || r.sse < best.sse) best = { ...r, alpha, beta };
    }
  }
  return {
    slope: best.trend,
    fitted_last: best.level,
    predict: (h) => best.level + h * best.trend,
    sigma: (h) => best.s * Math.sqrt(h),
    resid_sd: best.s,
    alpha: best.alpha,
    beta: best.beta,
  };
}

function backtest(values, opts) {
  const { window, horizon } = opts;
  const n = values.length;
  const lin = []; const holt = [];
  for (let o = Math.max(window, n - horizon - 12); o <= n - horizon; o += 3) {
    const train = values.slice(0, o);
    const actual = values[o + horizon - 1];
    lin.push(Math.abs(linearFit(train.slice(-window)).predict(horizon) - actual));
    holt.push(Math.abs(holtFit(train).predict(horizon) - actual));
  }
  const mean = (a) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : NaN);
  return { origins: lin.length, linear_mae: mean(lin), holt_mae: mean(holt) };
}

/**
 * @param {number[]} values weekly utilised units, oldest first
 * @param {{window_weeks:number, backtest_horizon_weeks:number, holt_margin:number, p_upper_z:number}} cfg
 * @param {{slope?:number}} [overrides] slope in units/week replaces the fitted trend (what-if)
 */
function forecastSeries(values, cfg, overrides = {}) {
  const window = Math.min(cfg.window_weeks, values.length);
  const bt = values.length >= window + cfg.backtest_horizon_weeks
    ? backtest(values, { window, horizon: cfg.backtest_horizon_weeks })
    : { origins: 0, linear_mae: NaN, holt_mae: NaN };

  const useHolt = bt.origins > 0 && bt.holt_mae < (1 - cfg.holt_margin) * bt.linear_mae;
  const model = useHolt ? 'holt' : 'linear';
  const fit = useHolt ? holtFit(values) : linearFit(values.slice(-window));
  const latest = values[values.length - 1];

  const overridden = Number.isFinite(overrides.slope);
  const slope = overridden ? overrides.slope : fit.slope;
  const anchor = overridden ? latest : fit.fitted_last;

  const p50 = []; const upper = []; const lower = [];
  for (let h = 1; h <= HORIZON_WEEKS; h++) {
    const mid = Math.max(0, overridden ? anchor + slope * h : fit.predict(h));
    const sd = fit.sigma(h);
    p50.push(mid);
    upper.push(mid + cfg.p_upper_z * sd);
    lower.push(Math.max(0, mid - cfg.p_upper_z * sd));
  }

  const why = bt.origins === 0
    ? 'Not enough history to backtest; using the straight-line trend.'
    : useHolt
      ? `Holt smoothing beat the straight line by more than ${Math.round(cfg.holt_margin * 100)}% in the backtest (MAE ${bt.holt_mae.toFixed(0)} vs ${bt.linear_mae.toFixed(0)} CU at ${cfg.backtest_horizon_weeks} weeks).`
      : `The straight line was as good as Holt smoothing within ${Math.round(cfg.holt_margin * 100)}% in the backtest (MAE ${bt.linear_mae.toFixed(0)} vs ${bt.holt_mae.toFixed(0)} CU at ${cfg.backtest_horizon_weeks} weeks), so the simpler model was kept.`;

  return {
    contract: FORECAST_CONTRACT,
    horizon_weeks: HORIZON_WEEKS,
    // `upper` is the planning path. It is a band around the middle path, not a probability that a plan is right.
    interval: { upper_quantile: +normalCdf(cfg.p_upper_z).toFixed(2), z: cfg.p_upper_z },
    input: { weeks: values.length, latest, window_weeks: window, backtest_origins: bt.origins },
    input_hash: fingerprint(values, cfg, overrides.slope),
    model: overridden ? `${model} (slope overridden)` : model,
    why: overridden ? 'Growth rate set by hand for a what-if; the fitted uncertainty is kept.' : why,
    slope_per_week: slope,
    latest,
    p50, upper, lower,
    resid_sd: fit.resid_sd,
    backtest: { horizon_weeks: cfg.backtest_horizon_weeks, origins: bt.origins, linear_mae: bt.linear_mae, holt_mae: bt.holt_mae, chosen: model },
    overridden,
  };
}

// Linear-interpolated quantile (used for the vendor's observed lead-time p80).
function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

module.exports = { forecastSeries, quantile, linearFit, holtFit, HORIZON_WEEKS, FORECAST_CONTRACT };
