'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadRaw, indexData } = require('../server/lib/data');
const { buildCorpus, toFiles, offsetHours, dstWindow, localClock, REGIONS, WEEK_H, FUTURE_HOURS } = require('../ml/lib/corpus');
const { DATA_DIR, P } = require('./helpers');

const data = indexData(loadRaw(DATA_DIR));
const corpus = buildCorpus(data);
const files = toFiles(corpus);
const meta = JSON.parse(files['meta.json']);
const pool = (id) => corpus.pools.find((p) => p.pool.pool_id === id);
const sum = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s; };
const KNOWN_FROM = corpus.hours - corpus.knownWeeks * WEEK_H;        // the first hour the lab's own readings cover
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The mean load by local hour of day on weekdays, over the lab's own 52 weeks.
function byLocalHour(p) {
  const total = new Array(24).fill(0), n = new Array(24).fill(0);
  for (let i = KNOWN_FROM; i < corpus.hours; i++) if (p.localDow[i] < 5 && !p.holiday[i]) { total[p.localHour[i]] += p.y[i]; n[p.localHour[i]]++; }
  return total.map((t, h) => t / n[h]);
}
const argmax = (a) => a.indexOf(Math.max(...a));

test('the corpus is hourly, two years, and ends exactly where the dataset\'s "today" is', () => {
  assert.equal(corpus.hours, 104 * WEEK_H);
  assert.equal(corpus.knownWeeks, 52);
  assert.equal(corpus.pools.length, 6);
  assert.equal(new Date(corpus.endMs).toISOString().slice(0, 10), data.as_of, 'the last hour is the one before as_of');
  assert.equal(corpus.tsMs(corpus.hours) - corpus.tsMs(0), corpus.hours * 3600000);
  assert.equal(meta.rows, 6 * 17472);
  assert.equal(meta.starts_utc, '2024-09-23T00:00:00Z');
  assert.equal(meta.ends_before_utc, '2026-09-21T00:00:00Z');
  for (const p of corpus.pools) assert.equal(p.y.length, corpus.hours);
});

test('every weekly reading in the lab is exactly the mean of the 168 hours that end at its week_start', () => {
  let checked = 0;
  for (const p of corpus.pools) {
    const series = data.utilByPool[p.pool.pool_id];
    series.forEach((r, j) => {
      const to = corpus.hours - (series.length - 1 - j) * WEEK_H;
      assert.equal(sum(p.y, to - WEEK_H, to), r.utilized_units * WEEK_H, `${p.pool.pool_id} ${r.week_start}`);
      checked++;
    });
  }
  assert.equal(checked, 6 * 52);
  const last = data.utilByPool[P.eus].at(-1);
  assert.equal(last.week_start, data.as_of, 'the last reading is stamped today, so its week ends where the corpus ends');
});

test('the corpus is deterministic, and the files on disk are the ones this code produces', () => {
  const again = toFiles(buildCorpus(indexData(loadRaw(DATA_DIR))));
  for (const name of ['hourly_pool_metrics.csv', 'pools.csv', 'calendar_future.csv', 'meta.json']) assert.equal(again[name], files[name], `${name} is stable`);
  const dir = path.join(__dirname, '..', 'ml', 'corpus');
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return;             // not generated yet: nothing to compare
  for (const name of ['hourly_pool_metrics.csv', 'pools.csv', 'calendar_future.csv', 'meta.json']) {
    assert.equal(sha(fs.readFileSync(path.join(dir, name), 'utf8')), sha(files[name]), `ml/corpus/${name} is out of date: run npm run corpus`);
  }
});

test('the backcast year is positive, joins the lab\'s history without a jump, and does not copy its noise', () => {
  for (const p of corpus.pools) {
    const W = p.weeklyLevels;
    assert.equal(W.length, 104);
    assert.ok(W.slice(0, 52).every((v) => v > 0), p.pool.pool_id);
    // The join between the two years should look like any other week-to-week step, judged against how much
    // this pool's own weeks move (its standard deviation of weekly change), not against a fixed percentage.
    const steps = W.slice(53).map((v, j) => v - W[52 + j]);
    const sdStep = Math.sqrt(steps.reduce((s, d) => s + d * d, 0) / steps.length);
    assert.ok(Math.abs(W[52] - W[51]) < 3.5 * sdStep, `${p.pool.pool_id}: ${W[51]} then ${W[52]}, a typical step is ${sdStep.toFixed(0)}`);
    const known = W.slice(52), earlier = W.slice(0, 52);
    assert.ok(earlier.some((v, j) => v !== known[j]), 'not a copy');
    assert.ok(Math.min(...earlier) < Math.min(...known) + 1, `${p.pool.pool_id}: growth means the earlier year was smaller`);
  }
});

test('load is always non-negative, whole units, and never reaches installed capacity', () => {
  for (const p of corpus.pools) {
    assert.ok(Math.min(...p.y) > 0, p.pool.pool_id);
    assert.ok(Math.max(...p.y) <= 0.97 * p.pool.capacity_units, `${p.pool.pool_id}: busiest hour ${Math.max(...p.y)} of ${p.pool.capacity_units}`);
    assert.ok(p.y instanceof Int32Array);
  }
});

test('load follows each region\'s own clock: business-hours pools peak in the local afternoon, whatever the UTC hour', () => {
  for (const id of [P.eus, P.weuAmd, P.sea, P.brs]) {
    const h = argmax(byLocalHour(pool(id)));
    assert.ok(h >= 11 && h <= 15, `${id} peaks at local hour ${h}`);
    const prof = byLocalHour(pool(id));
    assert.ok(prof[h] / Math.min(...prof) > 1.1, `${id} has a real daily swing`);
  }
  const jpe = argmax(byLocalHour(pool(P.jpe)));
  assert.ok(jpe >= 14 && jpe <= 18, `inference traffic peaks in the afternoon or evening, local hour ${jpe}`);
});

test('a training pool is nearly flat across the day, unlike the others', () => {
  const prof = byLocalHour(pool(P.weuGpu));
  assert.ok(Math.max(...prof) / Math.min(...prof) < 1.08, `${Math.max(...prof) / Math.min(...prof)}`);
});

test('the same UTC hour is a different local hour in different regions, so a UTC-only model would be misled', () => {
  const utcPeak = (id) => {
    const p = pool(id), total = new Array(24).fill(0);
    for (let i = KNOWN_FROM; i < corpus.hours; i++) if (p.localDow[i] < 5 && !p.holiday[i]) total[new Date(corpus.tsMs(i)).getUTCHours()] += p.y[i];
    return argmax(total);
  };
  const gap = Math.abs(utcPeak(P.eus) - utcPeak(P.sea));
  assert.ok(Math.min(gap, 24 - gap) >= 9, `East US and Southeast Asia peak ${gap} hours apart in UTC`);
});

test('daylight saving follows the real rules: US and EU switch on different Sundays, and Asia and Brazil never do', () => {
  const at = (region, iso) => offsetHours(REGIONS[region], Date.parse(iso));
  assert.equal(at('eastus', '2026-01-15T12:00:00Z'), -5);
  assert.equal(at('eastus', '2026-07-15T12:00:00Z'), -4);
  assert.deepEqual(dstWindow('US', 2026).map((ms) => new Date(ms).toISOString()), ['2026-03-08T07:00:00.000Z', '2026-11-01T06:00:00.000Z']);
  assert.deepEqual(dstWindow('EU', 2026).map((ms) => new Date(ms).toISOString()), ['2026-03-29T01:00:00.000Z', '2026-10-25T01:00:00.000Z']);
  assert.deepEqual(dstWindow('US', 2025).map((ms) => new Date(ms).toISOString()), ['2025-03-09T07:00:00.000Z', '2025-11-02T06:00:00.000Z']);
  assert.equal(at('westeurope', '2026-03-28T12:00:00Z'), 1);
  assert.equal(at('westeurope', '2026-03-30T12:00:00Z'), 2, 'the US switched three weeks before Europe');
  assert.equal(at('eastus', '2026-03-28T12:00:00Z'), -4);
  for (const r of ['southeastasia', 'japaneast', 'brazilsouth']) assert.equal(at(r, '2026-01-15T12:00:00Z'), at(r, '2026-07-15T12:00:00Z'), r);
  // the same UTC instant is a different local hour either side of the change
  const clock = localClock(REGIONS.eastus, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z'));
  assert.equal(clock(Date.parse('2026-03-08T06:00:00Z')).hour, 1);
  assert.equal(clock(Date.parse('2026-03-08T07:00:00Z')).hour, 3, 'the clock skips 02:00');
  assert.equal(clock(Date.parse('2026-11-01T05:00:00Z')).hour, 1);
  assert.equal(clock(Date.parse('2026-11-01T06:00:00Z')).hour, 1, '01:00 happens twice');
});

test('public holidays are flagged on the local date and lower the load that day', () => {
  const dayMean = (p, dateIso) => {
    const idx = []; for (let i = 0; i < corpus.hours; i++) if (p.localHour[i] === 12) { const d = new Date(corpus.tsMs(i) + REGIONS[p.pool.region].std * 3600000).toISOString().slice(0, 10); if (d === dateIso) idx.push(i); }
    return idx.length ? idx : null;
  };
  const eus = pool(P.eus);
  const thanksgiving = dayMean(eus, '2025-11-27');
  assert.ok(thanksgiving && eus.holiday[thanksgiving[0]] === 1, 'Thanksgiving 2025 is flagged');
  assert.equal(eus.holiday[dayMean(eus, '2025-11-26')[0]], 0, 'the day before is not');
  // the load is lower than on the same weekday in the weeks either side
  const at = (i) => eus.y[i];
  const t = thanksgiving[0], week = WEEK_H;
  assert.ok(at(t) < 0.95 * (at(t - week) + at(t + week)) / 2, `${at(t)} vs ${(at(t - week) + at(t + week)) / 2}`);
  const jpe = pool(P.jpe);
  assert.equal(jpe.holiday[dayMean(jpe, '2026-05-04')[0]], 1, 'Golden Week');
  assert.equal(pool(P.brs).holiday[dayMean(pool(P.brs), '2026-09-07')[0]], 1, 'Brazilian Independence Day');
  for (const p of corpus.pools) assert.ok(p.holiday.some((x) => x === 1) && p.holiday.some((x) => x === 0));
});

test('the busiest hour of a week sits a plausible distance above its mean, and a flat pool less than the rest', () => {
  for (const s of meta.per_pool) {
    assert.ok(s.peak_to_mean_max > 1.03 && s.peak_to_mean_max < 1.3, `${s.pool_id}: ${s.peak_to_mean_max}`);
    assert.ok(s.peak_to_mean_p95 < s.peak_to_mean_max);
  }
  const ratio = (id) => meta.per_pool.find((s) => s.pool_id === id).peak_to_mean_max;
  assert.ok(ratio(P.weuGpu) < ratio(P.eus) - 0.05);
});

test('latency and queue depth rise with load, and the last week averages to the lab\'s performance records', () => {
  for (const p of corpus.pools) {
    const rec = data.perfByPool[p.pool.pool_id];
    const from = corpus.hours - WEEK_H;
    assert.ok(Math.abs(sum(p.latency, from, corpus.hours) / WEEK_H / rec.p95_latency_ms - 1) < 0.03, `${p.pool.pool_id} latency`);
    assert.ok(Math.abs(sum(p.queue, from, corpus.hours) / WEEK_H / rec.queue_depth_p95 - 1) < 0.1, `${p.pool.pool_id} queue`);
    // busy hours are slower than quiet hours
    const idx = Array.from({ length: WEEK_H }, (_, k) => from + k).sort((a, b) => p.y[a] - p.y[b]);
    const quiet = idx.slice(0, 42).reduce((s, i) => s + p.latency[i], 0) / 42, busy = idx.slice(-42).reduce((s, i) => s + p.latency[i], 0) / 42;
    assert.ok(busy > quiet, `${p.pool.pool_id}: busy ${busy} vs quiet ${quiet}`);
    assert.ok(p.queue.every((q) => q >= 0));
  }
});

test('incidents in the last 90 days are exactly the lab\'s incident records; earlier hours carry a quiet background', () => {
  const cutoff = corpus.hours - data.policy.reliability.window_days * 24;
  for (const p of corpus.pools) {
    const recs = data.incidents.filter((x) => x.pool_id === p.pool.pool_id);
    assert.equal(sum(p.opened, cutoff, corpus.hours), recs.length, `${p.pool.pool_id} opened in the window`);
    assert.ok(sum(p.opened, 0, cutoff) > 0, `${p.pool.pool_id} has a background before the window`);
    assert.ok(p.weight.every((w) => w >= 0));
  }
  const sea = pool(P.sea);
  assert.equal(sum(sea.opened, cutoff, corpus.hours), 11);
  assert.ok(sum(sea.weight, cutoff, corpus.hours) > 4 * sum(pool(P.brs).weight, cutoff, corpus.hours), 'the failing pool carries far more open incident weight');
  // an incident stays open for its recorded time to mitigate
  const inc = data.incidents.find((x) => x.pool_id === P.sea && x.severity === 1) || data.incidents.find((x) => x.pool_id === P.sea);
  const open = Date.parse(`${inc.opened_on}T00:00:00Z`);
  const i0 = Math.floor((open - corpus.startMs) / 3600000);
  assert.ok(sea.opened.subarray(i0, i0 + 24).some((n) => n > 0), 'the incident lands on its own day');
});

test('carbon is the SKU\'s intensity times the load, every hour', () => {
  for (const p of corpus.pools) {
    const g = data.skuById[p.pool.sku_id].gco2_per_cu_hour;
    for (let i = 0; i < corpus.hours; i += 97) assert.equal(p.carbon[i], Math.round((g * p.y[i]) / 100) / 10, `${p.pool.pool_id} hour ${i}`);
  }
});

test('the CSV files are well formed: header, one row per pool-hour, sorted, and nothing missing', () => {
  const lines = files['hourly_pool_metrics.csv'].split('\n');
  assert.equal(lines[0], 'ts_utc,pool_id,utilized_units,p95_latency_ms,queue_depth_p95,incidents_opened,incident_weight_active,carbon_kg,local_hour,local_dow,is_holiday');
  assert.equal(lines.length, 1 + 6 * corpus.hours + 1, 'header, rows, trailing newline');
  assert.equal(lines.at(-1), '');
  assert.ok(!/NaN|undefined|Infinity|null/.test(files['hourly_pool_metrics.csv']));
  assert.ok(lines.slice(1, -1).every((l) => l.split(',').length === 11));
  assert.equal(lines[1].split(',')[0], '2024-09-23T00:00:00Z');
  assert.equal(lines.at(-2).split(',')[0], '2026-09-20T23:00:00Z');
  // one block per pool, in the lab's own pool order, each running forward one hour at a time
  const rows = lines.slice(1, -1).map((l) => l.split(',').slice(0, 2));
  data.pools.forEach((pl, k) => {
    const block = rows.slice(k * corpus.hours, (k + 1) * corpus.hours);
    assert.ok(block.every((r) => r[1] === pl.pool_id), `${pl.pool_id} is one block`);
    for (let i = 1; i < block.length; i++) if (Date.parse(block[i][0]) - Date.parse(block[i - 1][0]) !== 3600000) assert.fail(`${pl.pool_id}: hour ${i} does not follow the one before`);
  });
  const pools = files['pools.csv'].trim().split('\n');
  assert.equal(pools.length, 7);
  assert.match(pools[1], /^pool-eastus-01-intel-icx,eastus,East US,north-america,FAB-INTEL-ICX-64,.*general-compute,9600,America\/New_York,-5,US$/);
  for (const [name, f] of Object.entries(meta.files)) assert.equal(f.sha256, sha(files[name]), name);
});

test('the calendar for the coming week starts at the last hour and agrees with the local clock', () => {
  const rows = files['calendar_future.csv'].trim().split('\n');
  assert.equal(rows.length, 1 + 6 * FUTURE_HOURS);
  assert.equal(rows[1].split(',')[0], '2026-09-21T00:00:00Z');
  const eus = rows.filter((r) => r.includes(P.eus));
  assert.equal(eus.length, FUTURE_HOURS);
  const clock = localClock(REGIONS.eastus, corpus.startMs, corpus.endMs + FUTURE_HOURS * 3600000);
  eus.forEach((r, j) => { const c = clock(corpus.endMs + j * 3600000); assert.deepEqual(r.split(',').slice(2).map(Number), [c.hour, c.dow, c.holiday]); });
  assert.equal(eus[0].split(',')[2], '20', '00:00 UTC on 21 Sep is 20:00 the evening before in New York');
  assert.equal(eus[0].split(',')[3], '6', 'and that is still a Sunday there');
});

test('building the corpus reads the lab\'s data and changes none of it', () => {
  const before = JSON.stringify([data.utilByPool, data.incidents, data.perfByPool, data.policy]);
  buildCorpus(data);
  assert.equal(JSON.stringify([data.utilByPool, data.incidents, data.perfByPool, data.policy]), before);
});
