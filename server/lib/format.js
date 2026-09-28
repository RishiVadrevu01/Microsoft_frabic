'use strict';
// Plain-language formatting shared by the engine's headlines and the API.

const cu = (n) => `${Math.round(n).toLocaleString('en-US')} CU`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;
const pts = (x, digits = 2) => `${(x * 100).toFixed(digits)} pts`;
const usd = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
};
const weeks = (n) => `${Math.round(n)} week${Math.round(n) === 1 ? '' : 's'}`;

module.exports = { cu, num, pct, pts, usd, weeks };
