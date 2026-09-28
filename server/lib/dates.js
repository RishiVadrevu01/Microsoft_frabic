'use strict';
// Calendar arithmetic on ISO dates (YYYY-MM-DD), always in UTC so results never
// depend on the machine's time zone. The engine never reads the wall clock:
// "today" is the dataset's as_of date, which is what makes every result replayable.

const DAY = 86400000;

const parse = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * DAY));
const addWeeks = (s, n) => addDays(s, Math.round(n * 7));
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
const weeksBetween = (a, b) => daysBetween(a, b) / 7;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s).getTime());

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (s) => {
  if (!s) return '—';
  const d = parse(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

module.exports = { parse, iso, addDays, addWeeks, daysBetween, weeksBetween, isDate, fmt };
