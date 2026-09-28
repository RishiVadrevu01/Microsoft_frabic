'use strict';
/*
 * The hourly corpus: two years of hourly readings for every pool, built from the lab's own data.
 *
 * Nothing here is measured. It is generated, deterministically, so a model has something realistic
 * to learn from. What makes it usable rather than random:
 *
 *  - It ties to the lab. The last 52 weeks add up to the lab's weekly readings exactly: each weekly
 *    reading is the mean of the 168 hours ending at its week_start, so a week's hours sum to
 *    168 x the reading. The corpus therefore ends at the dataset's "today" and never past it.
 *  - The 52 weeks before that are a backcast, fitted from the observed series (trend plus a yearly
 *    wave), so a model can see two winters, two holiday seasons and two daylight-saving changes.
 *  - Load follows each region's LOCAL clock (business hours, weekends, public holidays and daylight
 *    saving), which is the main thing a model has to learn across regions.
 *  - Other funnel signals are generated hourly and tied to the lab's records: latency and queue
 *    depth (performance funnel), incidents (reliability funnel, from incidents.json) and carbon
 *    (sustainability funnel).
 *
 * Every random draw comes from a seeded stream named after the pool and the purpose, so the corpus
 * is reproducible byte for byte and adding a pool does not change the others.
 */

const crypto = require('node:crypto');
const { mulberry32, normal } = require('../../server/lib/rng');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WEEK_H = 168;
const BACKCAST_WEEKS = 52;
const GENERATOR_VERSION = '2026.09.1';
const FUTURE_HOURS = 8 * 24;             // calendar rows past the last hour, so the next week can be forecast

// ------------------------------------------------------------------ small helpers
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const stream = (poolId, purpose) => mulberry32(hash32(`${poolId}:${purpose}`));
const pad = (n) => String(n).padStart(2, '0');
const isoHour = (ms) => `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); };

// ------------------------------------------------------------------ regions, daylight saving, holidays
// Illustrative calendars. Public holidays are the fixed or easily computed ones; this is not a
// complete national calendar and does not need to be.
const REGIONS = {
  eastus: { tz: 'America/New_York', std: -5, dst: 'US', holidays: 'us' },
  westeurope: { tz: 'Europe/Amsterdam', std: 1, dst: 'EU', holidays: 'nl' },
  southeastasia: { tz: 'Asia/Singapore', std: 8, dst: null, holidays: 'sg' },
  japaneast: { tz: 'Asia/Tokyo', std: 9, dst: null, holidays: 'jp' },
  brazilsouth: { tz: 'America/Sao_Paulo', std: -3, dst: null, holidays: 'br' },
};
const FALLBACK_REGION = { tz: 'UTC', std: 0, dst: null, holidays: null };

// The n-th given weekday (0 = Sunday) of a month, as a day of the month.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}
const dstCache = new Map();
// The instants (UTC) at which daylight saving starts and ends in a year.
function dstWindow(rule, year) {
  const key = `${rule}${year}`;
  if (!dstCache.has(key)) {
    dstCache.set(key, rule === 'US'
      ? [Date.UTC(year, 2, nthWeekday(year, 2, 0, 2), 7), Date.UTC(year, 10, nthWeekday(year, 10, 0, 1), 6)]   // 2nd Sun Mar 02:00 EST .. 1st Sun Nov 02:00 EDT
      : [Date.UTC(year, 2, lastWeekday(year, 2, 0), 1), Date.UTC(year, 9, lastWeekday(year, 9, 0), 1)]);        // last Sun Mar .. last Sun Oct, both 01:00 UTC
  }
  return dstCache.get(key);
}
function offsetHours(region, ms) {
  if (!region.dst) return region.std;
  const [start, end] = dstWindow(region.dst, new Date(ms).getUTCFullYear());
  return region.std + (ms >= start && ms < end ? 1 : 0);
}

const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const HOLIDAYS = {
  us: (y) => [ymd(y, 0, 1), ymd(y, 6, 4), ymd(y, 8, nthWeekday(y, 8, 1, 1)), ymd(y, 10, nthWeekday(y, 10, 4, 4)), ymd(y, 11, 25)],
  nl: (y) => [ymd(y, 0, 1), ymd(y, 3, 27), ymd(y, 11, 25), ymd(y, 11, 26)],
  sg: (y) => [ymd(y, 0, 1), ymd(y, 7, 9), ymd(y, 11, 25)],
  jp: (y) => [ymd(y, 0, 1), ymd(y, 0, 2), ymd(y, 0, 3), ymd(y, 3, 29), ymd(y, 4, 3), ymd(y, 4, 4), ymd(y, 4, 5), ymd(y, 7, 13), ymd(y, 7, 14), ymd(y, 7, 15)],
  br: (y) => [ymd(y, 0, 1), ymd(y, 8, 7), ymd(y, 9, 12), ymd(y, 10, 15), ymd(y, 11, 25)],
};

/** The local clock of a region: a function from a UTC instant to {hour, dow (0 = Monday), holiday}. */
function localClock(region, fromMs, toMs) {
  const set = new Set();
  if (region.holidays) for (let y = new Date(fromMs).getUTCFullYear() - 1; y <= new Date(toMs).getUTCFullYear() + 1; y++) for (const d of HOLIDAYS[region.holidays](y)) set.add(d);
  const dayKey = new Map();
  const keyOf = (days) => { let k = dayKey.get(days); if (!k) { k = new Date(days * DAY).toISOString().slice(0, 10); dayKey.set(days, k); } return k; };
  return (ms) => {
    const local = ms + offsetHours(region, ms) * HOUR;
    const days = Math.floor(local / DAY);
    return { hour: Math.floor((local - days * DAY) / HOUR), dow: (days + 3) % 7, holiday: set.has(keyOf(days)) ? 1 : 0 };
  };
}

// ------------------------------------------------------------------ how each kind of workload uses a day
// The daily shape is a floor plus Gaussian bumps in LOCAL time; the weekly shape multiplies whole days
// (Monday first). Amplitudes are deliberately modest so a pool's busiest hour stays under its capacity.
const WORKLOADS = {
  'general-compute': {
    base: 0.90, bumps: [[13, 3.8, 0.16], [2, 1.3, 0.04]],                 // business hours, plus a small overnight batch window
    week: [1.02, 1.03, 1.03, 1.02, 0.99, 0.90, 0.88], holiday: 0.88,
    ar: { phi: 0.85, sd: 0.022 }, burst: { p: 1 / 120, amp: [0.03, 0.08], len: [2, 6] },
  },
  'ai-inference': {
    base: 0.88, bumps: [[16, 4.5, 0.20]],                                 // user traffic, afternoon into evening
    week: [0.99, 1.0, 1.0, 1.0, 1.01, 1.02, 1.03], holiday: 0.95,
    ar: { phi: 0.88, sd: 0.025 }, burst: { p: 1 / 100, amp: [0.03, 0.08], len: [2, 6] },
  },
  'ai-training': {
    base: 0.985, bumps: [[11, 6, 0.04]],                                  // long jobs: nearly flat, with job-sized steps
    week: [1.01, 1.01, 1.01, 1.0, 1.0, 0.98, 0.97], holiday: 0.96,
    ar: { phi: 0.92, sd: 0.012 }, burst: { p: 1 / 240, amp: [0.02, 0.05], len: [3, 8] }, blocks: { meanLen: 30, amp: 0.035 },
  },
};
const profileOf = (workload) => WORKLOADS[workload] || WORKLOADS['general-compute'];

const circ = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 24 - d); };
const dayShape = (p, hour) => p.bumps.reduce((s, [c, w, amp]) => s + amp * Math.exp(-0.5 * (circ(hour + 0.5, c) / w) ** 2), p.base);
// The average of the daily and weekly shapes over a whole week: dividing by it keeps the scale near 1.
function shapeNorm(p) {
  let s = 0;
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) s += dayShape(p, h) * p.week[d];
  return s / (7 * 24);
}

// ------------------------------------------------------------------ the weekly level, and its backcast
// Solve the small normal equations of a least-squares fit.
function lstsq(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let r = 0; r < X.length; r++) for (let i = 0; i < k; i++) { for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j]; A[i][k] += X[r][i] * y[r]; }
  for (let i = 0; i < k; i++) {
    let piv = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

const MAX_WAVE_SHARE = 0.03;             // a yearly wave larger than this share of the level is not believable

/**
 * Extend the observed weekly series backwards. A continuous two-part trend is fitted first, then a
 * yearly wave to what the trend leaves over (fitting both at once is ill-conditioned on a single year:
 * the wave and the trend trade off and the wave comes out several times too large). The earlier weeks
 * follow the first part of the trend and the same wave, with fresh noise of the size the fit leaves.
 * The observed noise is not copied, so a model cannot learn a pattern that repeats year on year.
 */
function backcast(known, weeks, rand) {
  const n = known.length;
  const knee = Math.floor(n / 2);
  const trendRow = (j) => [1, j, Math.max(0, j - knee)];
  const waveRow = (j) => [Math.sin((2 * Math.PI * j) / 52), Math.cos((2 * Math.PI * j) / 52)];
  const beta = lstsq(known.map((_, j) => trendRow(j)), known);
  const trend = (j) => trendRow(j).reduce((s, v, i) => s + v * beta[i], 0);
  const left = known.map((v, j) => v - trend(j));
  const gamma = lstsq(known.map((_, j) => waveRow(j)), left);
  const cap = MAX_WAVE_SHARE * mean(known), amp = Math.hypot(gamma[0], gamma[1]);
  const shrink = amp > cap ? cap / amp : 1;
  const wave = (j) => shrink * waveRow(j).reduce((s, v, i) => s + v * gamma[i], 0);
  const resid = known.map((v, j) => v - trend(j) - wave(j));
  const sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 5));
  const out = [];
  for (let j = -weeks; j < 0; j++) out.push(Math.max(0.25 * known[0], Math.round(trend(j) + wave(j) + normal(rand) * sd)));
  return out;
}

// ------------------------------------------------------------------ the build
/**
 * @param {object} data an indexed dataset (server/lib/data indexData)
 * @returns the corpus: per-pool hourly series, the calendar for the coming week and a description of both
 */
function buildCorpus(data) {
  const asOf = data.as_of;
  const pools = data.pools;
  if (!pools.length) throw new Error('The dataset has no pools.');
  const window = data.policy.reliability.window_days;

  // The corpus ends where the last weekly reading is stamped: the reading summarises the week before it.
  const lastStamp = data.utilByPool[pools[0].pool_id].at(-1).week_start;
  const knownWeeks = data.utilByPool[pools[0].pool_id].length;
  const endMs = Date.parse(`${lastStamp}T00:00:00Z`);
  const totalWeeks = knownWeeks + BACKCAST_WEEKS;
  const hours = totalWeeks * WEEK_H;
  const startMs = endMs - hours * HOUR;
  const tsMs = (i) => startMs + i * HOUR;

  const out = [];
  for (const pool of pools) {
    const series = data.utilByPool[pool.pool_id];
    if (series.length !== knownWeeks || series.at(-1).week_start !== lastStamp) throw new Error(`${pool.pool_id}: weekly readings do not line up with the other pools.`);
    const region = REGIONS[pool.region] || FALLBACK_REGION;
    const prof = profileOf(pool.workload_type);
    const clock = localClock(region, startMs, endMs + FUTURE_HOURS * HOUR);
    const sku = data.skuById[pool.sku_id];
    const perf = data.perfByPool[pool.pool_id];

    // ---- weekly levels: the backcast, then the lab's own readings
    const known = series.map((r) => r.utilized_units);
    const W = [...backcast(known, BACKCAST_WEEKS, stream(pool.pool_id, 'backcast')), ...known];

    // ---- hourly shape: local clock x weekly level x correlated noise x bursts x job blocks
    const rand = stream(pool.pool_id, 'load');
    const norm = shapeNorm(prof);
    const raw = new Float64Array(hours);
    const localHour = new Uint8Array(hours), localDow = new Uint8Array(hours), holiday = new Uint8Array(hours);
    let ar = 0, burstLeft = 0, burstLen = 1, burstAmp = 0, block = 1, blockLeft = 0;
    const arSd = prof.ar.sd * Math.sqrt(1 - prof.ar.phi ** 2);
    for (let i = 0; i < hours; i++) {
      const k = Math.min(totalWeeks - 1, Math.floor(i / WEEK_H));
      const rel = i + 0.5 - (k * WEEK_H + WEEK_H / 2);
      let level;                                                     // the weekly level, joined smoothly between week midpoints
      if (rel >= 0) level = k + 1 < totalWeeks ? W[k] + (W[k + 1] - W[k]) * (rel / WEEK_H) : W[k];
      else level = k > 0 ? W[k] + (W[k - 1] - W[k]) * (-rel / WEEK_H) : W[k];

      const c = clock(tsMs(i));
      localHour[i] = c.hour; localDow[i] = c.dow; holiday[i] = c.holiday;
      ar = prof.ar.phi * ar + arSd * normal(rand);
      if (burstLeft === 0 && rand() < prof.burst.p) {
        burstAmp = prof.burst.amp[0] + rand() * (prof.burst.amp[1] - prof.burst.amp[0]);
        burstLen = prof.burst.len[0] + Math.floor(rand() * (prof.burst.len[1] - prof.burst.len[0] + 1));
        burstLeft = burstLen;
      }
      const burst = burstLeft > 0 ? 1 + burstAmp * (burstLeft / burstLen) : 1;
      if (burstLeft > 0) burstLeft--;
      if (prof.blocks) {
        if (blockLeft === 0) { block = 1 + (rand() * 2 - 1) * prof.blocks.amp; blockLeft = 1 + Math.floor(-Math.log(Math.max(rand(), 1e-9)) * prof.blocks.meanLen); }
        blockLeft--;
      }
      raw[i] = level * (dayShape(prof, c.hour) * prof.week[c.dow] / norm) * (c.holiday ? prof.holiday : 1) * block * Math.exp(ar) * burst;
    }

    // ---- scale each week so its hours add up to the weekly level, as whole units, exactly
    const y = new Int32Array(hours);
    for (let k = 0; k < totalWeeks; k++) {
      const from = k * WEEK_H, total = W[k] * WEEK_H;
      let sum = 0;
      for (let i = from; i < from + WEEK_H; i++) sum += raw[i];
      const scale = total / sum;
      let floorSum = 0;
      const frac = [];
      for (let i = from; i < from + WEEK_H; i++) {
        const v = raw[i] * scale;
        y[i] = Math.floor(v); floorSum += y[i];
        frac.push([v - y[i], i]);
      }
      frac.sort((a, b) => b[0] - a[0] || a[1] - b[1]);              // the hours that lost most to rounding get the missing units
      for (let r = 0; r < total - floorSum; r++) y[frac[r][1]] += 1;
    }

    // ---- performance funnel: latency and queue depth rise as the pool nears its knee
    const cap = pool.capacity_units;
    const rho = (i) => y[i] / cap;
    const lastFrom = hours - WEEK_H;
    const latRand = stream(pool.pool_id, 'latency'), qRand = stream(pool.pool_id, 'queue');
    const LAT_SD = 0.025, Q_SD = 0.12, P = 6;
    const fLat = (i) => (rho(i) / perf.knee_util_pct) ** P;
    let fMean = 0; for (let i = lastFrom; i < hours; i++) fMean += fLat(i); fMean /= WEEK_H;
    const kappa = Math.max(0, (perf.p95_latency_ms / (perf.p95_baseline_ms * Math.exp(LAT_SD ** 2 / 2)) - 1) / fMean);
    const rhoRef = mean(Array.from(y.subarray(lastFrom)), 0, WEEK_H) / cap;
    const fQ = (i) => (rho(i) / rhoRef) ** P;
    let fqMean = 0; for (let i = lastFrom; i < hours; i++) fqMean += fQ(i); fqMean /= WEEK_H;
    const qScale = perf.queue_depth_p95 / (fqMean * Math.exp(Q_SD ** 2 / 2));
    const latency = new Float64Array(hours), queue = new Int32Array(hours);
    for (let i = 0; i < hours; i++) {
      latency[i] = round(perf.p95_baseline_ms * (1 + kappa * fLat(i)) * Math.exp(LAT_SD * normal(latRand)), 1);
      queue[i] = Math.max(0, Math.round(qScale * fQ(i) * Math.exp(Q_SD * normal(qRand))));
    }

    // ---- reliability funnel: the recorded incidents as they happened, and a quiet background before them
    const opened = new Int32Array(hours), weight = new Float64Array(hours);
    const w = data.policy.reliability.weights;
    const place = (atMs, severity, mttr) => {
      const i = Math.floor((atMs - startMs) / HOUR);
      if (i < 0 || i >= hours) return;
      opened[i] += 1;
      for (let j = i; j < Math.min(hours, i + Math.max(1, Math.ceil(mttr))); j++) weight[j] += w[severity] || 0;
    };
    const cutoffMs = endMs - window * DAY;
    const iRand = stream(pool.pool_id, 'incidents');
    for (let i = 0; i < hours; i++) {
      if (tsMs(i) >= cutoffMs) break;
      if (iRand() < 1.5 / (window * 24)) {
        const r = iRand();
        place(tsMs(i), r < 0.1 ? 2 : r < 0.55 ? 3 : 4, 1.5 + 3.5 * iRand());
      }
    }
    for (const inc of data.incidents.filter((x) => x.pool_id === pool.pool_id)) {
      place(Date.parse(`${inc.opened_on}T00:00:00Z`) + (hash32(inc.incident_id) % 24) * HOUR, inc.severity, inc.mttr_hours);
    }
    for (let i = 0; i < hours; i++) weight[i] = round(weight[i], 1);

    // ---- sustainability funnel: emissions follow the load exactly
    const carbon = new Float64Array(hours);
    for (let i = 0; i < hours; i++) carbon[i] = round((sku.gco2_per_cu_hour * y[i]) / 1000, 1);

    // ---- the coming week's calendar, so a forecast knows local hours and holidays it has not seen yet
    const future = [];
    for (let j = 0; j < FUTURE_HOURS; j++) { const c = clock(endMs + j * HOUR); future.push({ ms: endMs + j * HOUR, hour: c.hour, dow: c.dow, holiday: c.holiday }); }

    out.push({ pool, region, weeklyLevels: W, y, latency, queue, opened, weight, carbon, localHour, localDow, holiday, future });
  }

  return { asOf, startMs, endMs, hours, totalWeeks, knownWeeks, window, pools: out, tsMs };
}

// ------------------------------------------------------------------ files
const HOURLY_HEADER = 'ts_utc,pool_id,utilized_units,p95_latency_ms,queue_depth_p95,incidents_opened,incident_weight_active,carbon_kg,local_hour,local_dow,is_holiday';
const POOLS_HEADER = 'pool_id,region,region_label,geo,sku_id,sku_class,workload_type,capacity_units,time_zone,utc_offset_standard,daylight_saving';
const CALENDAR_HEADER = 'ts_utc,pool_id,local_hour,local_dow,is_holiday';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Summary figures that describe the corpus, and that a test can check against the lab's own data. */
function describe(c) {
  return c.pools.map((p) => {
    const hoursN = c.hours, weeks = c.knownWeeks;
    const ratios = [], p95s = [];
    for (let k = c.totalWeeks - weeks; k < c.totalWeeks; k++) {
      const wk = Array.from(p.y.subarray(k * WEEK_H, (k + 1) * WEEK_H));
      const m = mean(wk);
      ratios.push(Math.max(...wk) / m);
      p95s.push([...wk].sort((a, b) => a - b)[Math.floor(0.95 * (WEEK_H - 1))] / m);
    }
    const lastWeek = Array.from(p.y.subarray(hoursN - WEEK_H));
    return {
      pool_id: p.pool.pool_id,
      capacity_units: p.pool.capacity_units,
      last_week_mean: round(mean(lastWeek), 1),
      peak_to_mean_max: round(mean(ratios), 3),
      peak_to_mean_p95: round(mean(p95s), 3),
      max_share_of_capacity: round(Math.max(...p.y) / p.pool.capacity_units, 3),
      min_share_of_capacity: round(Math.min(...p.y) / p.pool.capacity_units, 3),
    };
  });
}

/** The corpus as file contents, with a description that carries each file's checksum. */
function toFiles(c) {
  const lines = [HOURLY_HEADER];
  for (const p of c.pools) {
    for (let i = 0; i < c.hours; i++) {
      lines.push(`${isoHour(c.tsMs(i))},${p.pool.pool_id},${p.y[i]},${p.latency[i]},${p.queue[i]},${p.opened[i]},${p.weight[i]},${p.carbon[i]},${p.localHour[i]},${p.localDow[i]},${p.holiday[i]}`);
    }
  }
  const hourly = `${lines.join('\n')}\n`;

  const poolLines = [POOLS_HEADER, ...c.pools.map((p) => [p.pool.pool_id, p.pool.region, p.pool.region_label, p.pool.geo, p.pool.sku_id, p.pool.sku_class, p.pool.workload_type, p.pool.capacity_units, p.region.tz, p.region.std, p.region.dst || 'none'].join(','))];
  const pools = `${poolLines.join('\n')}\n`;

  const calLines = [CALENDAR_HEADER];
  for (const p of c.pools) for (const f of p.future) calLines.push(`${isoHour(f.ms)},${p.pool.pool_id},${f.hour},${f.dow},${f.holiday}`);
  const calendar = `${calLines.join('\n')}\n`;

  const meta = {
    source: 'synthetic',
    generator_version: GENERATOR_VERSION,
    notice: 'Every value is generated. It ties to the lab\'s weekly readings and records, and is not measured data from any real estate.',
    as_of: c.asOf,
    frequency: '1 hour',
    starts_utc: isoHour(c.startMs),
    ends_before_utc: isoHour(c.endMs),
    hours_per_pool: c.hours,
    weeks: { total: c.totalWeeks, from_the_lab: c.knownWeeks, backcast: c.totalWeeks - c.knownWeeks },
    rows: c.pools.length * c.hours,
    pools: c.pools.map((p) => p.pool.pool_id),
    definitions: {
      utilized_units: 'Capacity units in use during the hour. The 168 hours ending at a week_start add up to 168 x that week\'s reading in utilization.json, exactly.',
      p95_latency_ms: 'The hour\'s p95 latency. The last week averages to performance.json p95_latency_ms.',
      queue_depth_p95: 'The hour\'s p95 queue depth. The last week averages to performance.json queue_depth_p95.',
      incidents_opened: 'Incidents opened in the hour. The last window_days come from incidents.json, placed at a fixed hour of their day; earlier hours carry a quiet background rate.',
      incident_weight_active: 'Severity weight (policy.reliability.weights) of incidents still open in the hour, each open for its recorded time to mitigate.',
      carbon_kg: 'kg CO2e in the hour: the SKU\'s gCO2 per CU-hour x utilized_units / 1000.',
      local_hour: 'Hour of day, 0-23, on the region\'s local clock, including daylight saving.',
      local_dow: 'Day of week on the local clock, 0 = Monday.',
      is_holiday: '1 on an illustrative local public holiday.',
    },
    assumptions: [
      'Weekly readings are read as the mean of the 168 hours ending at week_start, so the corpus ends at the dataset\'s as_of.',
      'The 52 weeks before the lab\'s history are a backcast: a fitted two-part trend and yearly wave with fresh noise.',
      'Installed capacity is constant through the history; orders in flight land after the last hour.',
      'The calendar is illustrative: standard daylight-saving rules and a short list of public holidays per region.',
      'Latency, queue depth and carbon are generated from utilization, so they carry no information a model could not already get from it.',
    ],
    per_pool: describe(c),
  };
  const files = { 'hourly_pool_metrics.csv': hourly, 'pools.csv': pools, 'calendar_future.csv': calendar };
  meta.files = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, { rows: body.split('\n').length - 2, sha256: sha256(body) }]));
  return { ...files, 'meta.json': `${JSON.stringify(meta, null, 2)}\n` };
}

module.exports = { buildCorpus, toFiles, describe, REGIONS, WORKLOADS, offsetHours, dstWindow, localClock, WEEK_H, BACKCAST_WEEKS, FUTURE_HOURS, GENERATOR_VERSION };
