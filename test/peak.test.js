'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRaw, indexData } = require('../server/lib/data');
const { loadPeakProfile } = require('../server/lib/peak');
const { buildContext } = require('../server/lib/context');
const { assessPool } = require('../server/lib/verdict');
const { decide } = require('../server/lib/decisions');
const { createApp } = require('../server/app');
const { DATA_DIR, P, PEAK_PROFILE, freshStore, fixtureProfile, writeProfile, peakStore } = require('./helpers');

const raw = loadRaw(DATA_DIR);
const data = indexData(raw);
const RANK = { OK: 1, WATCH: 2, PLAN: 3, 'ORDER NOW': 4, OVERDUE: 5 };
const checkOf = (store, id) => store.peak().pools.get(id);
const load = (profile) => loadPeakProfile(writeProfile(profile), raw);

// ---------------------------------------------------------------- the override that makes it possible
test('demand_scale reads the history as something other than the weekly mean, and touches nothing else', () => {
  const base = buildContext(data, P.eus);
  const up = buildContext(data, P.eus, { demand_scale: 1.2 });
  assert.equal(up.latest, base.latest * 1.2);
  assert.ok(Math.abs(up.p50At(26) / base.p50At(26) - 1.2) < 1e-9, 'the forecast scales with it');
  assert.equal(up.pipelineAt(52), base.pipelineAt(52), 'pipeline requests are already capacity asks, and are not scaled');
  assert.equal(up.knownAddsAt(52), base.knownAddsAt(52), 'contracts and events are dated commitments, and are not scaled');
  assert.equal(up.usableAt(26), base.usableAt(26), 'capacity is what it is');
  for (const bad of [0, -1, NaN, 'x', null, undefined]) assert.equal(buildContext(data, P.eus, { demand_scale: bad }).latest, base.latest, `${bad} is ignored`);
  assert.deepEqual(assessPool(data, P.eus, { demand_scale: 1 }).verdict, assessPool(data, P.eus).verdict, 'a scale of 1 is no change');
});

// ---------------------------------------------------------------- refusing a profile that does not fit
test('a profile is refused, with the reason, unless it describes this dataset', () => {
  const ok = load(fixtureProfile());
  assert.equal(ok.available, true);
  assert.equal(loadPeakProfile(null, raw).available, false);
  assert.match(loadPeakProfile('C:/nowhere/peak_profile.json', raw).reason, /npm run ml/);
  const bad = (edit, re) => { const p = fixtureProfile(); edit(p); const r = load(p); assert.equal(r.available, false); assert.match(r.reason, re); assert.match(r.reason, /npm run ml/); };
  bad((p) => { p.as_of = '2025-01-01'; }, /built for 2025-01-01 but the dataset is as of 2026-09-21/);
  bad((p) => { p.source = 'measured'; }, /not labelled synthetic/);
  bad((p) => { p.pools.pop(); }, /is missing/);
  bad((p) => { p.pools[0].busiest_hour_ratio = 0.9; }, /busiest_hour_ratio must be between/);
  bad((p) => { p.pools[0].busiest_hour_ratio = 5; }, /busiest_hour_ratio must be between/);
  bad((p) => { p.pools[1].weekly_ratio = p.pools[1].weekly_ratio.slice(1); }, /one ratio for each of the 52 weekly readings/);
  bad((p) => { p.pools[2].history.mean_last_week += 500; }, /weekly reading/);
  bad((p) => { p.pools[3].next_week.busiest_p80 = 1; }, /next-week forecast is not usable/);
  const fs_ = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lab-peak-junk-'));
  const junk = path.join(fs_, 'p.json'); fs.writeFileSync(junk, '{ not json');
  assert.match(loadPeakProfile(junk, raw).reason, /could not be read/);
  const many = fixtureProfile(); many.as_of = 'x'; many.source = 'y'; many.pools.length = 2;
  assert.match(load(many).reason, /and \d+ more/, 'a long list of problems is cut short');
});

test('without a profile the check is off, says why, and the rest of the lab is exactly the same', () => {
  const plain = freshStore();
  const p = plain.peak();
  assert.equal(p.available, false);
  assert.match(p.reason, /npm run ml/);
  const withProfile = peakStore();
  assert.deepEqual(withProfile.verdicts(), plain.verdicts(), 'the peak check never changes a verdict');
  assert.deepEqual(withProfile.all().map((a) => a.results), plain.all().map((a) => a.results), 'or a funnel result');
});

// ---------------------------------------------------------------- the check itself
test('a busiest-hour ratio of 1 changes nothing, whatever the pool', () => {
  const store = peakStore({ ratio: 1 });
  for (const c of store.peak().pools.values()) {
    assert.equal(c.plan.impact, 'same', c.pool_id);
    assert.deepEqual(c.plan.peak_basis, c.plan.mean_basis);
    assert.equal(c.plan.extra_cu, 0);
    assert.equal(c.plan.extra_usd, 0);
    assert.ok(Math.abs(c.now.busiest_share - c.now.mean_share) < 1e-12);
  }
  assert.equal(store.peak().summary.extra_cu, 0);
});

test('planning on a higher busiest hour never orders less, never orders later, and never lowers the state', () => {
  const store = peakStore({ ratio: 1.18 });
  let anyBigger = false;
  for (const c of store.peak().pools.values()) {
    assert.ok(c.plan.extra_cu >= 0, `${c.pool_id}: ${c.plan.extra_cu}`);
    assert.ok(c.plan.extra_usd >= 0);
    assert.ok(c.plan.weeks_earlier === null || c.plan.weeks_earlier >= 0, `${c.pool_id}: ${c.plan.weeks_earlier}`);
    assert.ok(RANK[c.plan.peak_basis.state] >= RANK[c.plan.mean_basis.state], `${c.pool_id}: ${c.plan.mean_basis.state} to ${c.plan.peak_basis.state}`);
    assert.equal(c.plan.changes_state, c.plan.peak_basis.state !== c.plan.mean_basis.state);
    anyBigger ||= c.plan.impact !== 'same';
  }
  assert.ok(anyBigger, 'with 18% more at the peak, something must change');
});

test('the busiest hour is measured against the working ceiling, and how long it has been over is counted from the weekly readings', () => {
  const store = peakStore({ ratio: 1.15 });
  const c = checkOf(store, P.eus);
  const series = data.utilByPool[P.eus];
  const ceiling = c.now.ceiling_pct * 9600;
  assert.equal(c.now.mean_units, 7388);
  assert.ok(Math.abs(c.now.busiest_units - 7388 * 1.15) < 1e-9);
  assert.ok(Math.abs(c.now.busiest_share - (7388 * 1.15) / 9600) < 1e-12);
  assert.equal(c.now.over_ceiling, 7388 * 1.15 > ceiling);
  assert.equal(c.now.mean_over_ceiling, false, 'the weekly mean is under the ceiling: that is the whole point');
  let n = 0; for (let k = series.length - 1; k >= 0 && series[k].utilized_units * 1.15 > ceiling; k--) n++;
  assert.ok(n > 0 && n < 52);
  assert.equal(c.now.weeks_over, n);
  assert.equal(c.now.over_since, series[series.length - n].week_start);
  assert.equal(c.now.over_by_units, Math.max(0, 7388 * 1.15 - ceiling));
  // a pool comfortably under its ceiling at the peak reports zero weeks
  const calm = checkOf(store, P.weuAmd);
  assert.equal(calm.now.over_ceiling, false);
  assert.equal(calm.now.weeks_over, 0);
  assert.equal(calm.now.over_since, null);
});

test('a pool is over its ceiling at the peak only when the ratio pushes it over: 1.05 does not, 1.2 does', () => {
  assert.equal(checkOf(peakStore({ ratio: 1.05 }), P.eus).now.over_ceiling, false);
  assert.equal(checkOf(peakStore({ ratio: 1.2 }), P.eus).now.over_ceiling, true);
  assert.equal(checkOf(peakStore({ ratio: 1.2, ratios: { [P.eus]: 1.05 } }), P.eus).now.over_ceiling, false, 'each pool has its own ratio');
});

test('next week comes from the model\'s forecast: the busiest hour at p80 against the ceiling', () => {
  const store = peakStore({ ratio: 1.1, next: { [P.eus]: { busiest_p80: 9000, busiest_p95: 9400 }, [P.weuAmd]: { busiest_p80: 6000, busiest_p95: 6200 } } });
  const eus = checkOf(store, P.eus).next_week;
  assert.equal(eus.busiest_p80, 9000);
  assert.ok(Math.abs(eus.share_p80 - 9000 / 9600) < 1e-12);
  assert.equal(eus.over_ceiling, true);
  assert.equal(eus.over_ceiling_p95, true);
  assert.equal(eus.busiest_local_hour, 13);
  assert.equal(checkOf(store, P.weuAmd).next_week.over_ceiling, false);
});

test('the two plans are the same engine on two readings of the history, side by side, and only the peak one is scaled', () => {
  const store = peakStore({ ratio: 1.15 });
  const c = checkOf(store, P.eus);
  const v = store.verdicts().find((x) => x.pool_id === P.eus);
  assert.equal(c.plan.mean_basis.state, v.state);
  assert.equal(c.plan.mean_basis.order_cu, v.order.quantity_cu);
  assert.equal(c.plan.mean_basis.cost_usd, v.order.cost_usd);
  assert.equal(c.plan.mean_basis.needed_by, v.dates.needed_by);
  const direct = assessPool(store.data(), P.eus, { demand_scale: 1.15 }).verdict;
  assert.equal(c.plan.peak_basis.order_cu, direct.order.quantity_cu);
  assert.equal(c.plan.peak_basis.needed_by, direct.dates.needed_by);
  assert.equal(c.plan.extra_cu, direct.order.quantity_cu - v.order.quantity_cu);
  assert.ok(c.plan.extra_cu > 0 && c.plan.extra_usd > 0);
  assert.equal(c.plan.factor, 1.15);
  assert.equal(c.plan.impact, 'bigger');
});

test('a pool that needs nothing on the mean can need an order on the peak, and says so', () => {
  const store = peakStore({ ratios: { [P.weuAmd]: 1.9 } });                  // an absurd peak, to force it
  const c = checkOf(store, P.weuAmd);
  assert.equal(c.plan.mean_basis.order_needed, false);
  assert.equal(c.plan.peak_basis.order_needed, true);
  assert.equal(c.plan.newly_needed, true);
  assert.equal(c.plan.impact, 'newly-needed');
  assert.match(c.headline, /that the weekly view does not ask for/);
  assert.equal(store.peak().summary.newly_needed, 1);
});

test('the sentence names the pool, the busiest hour and the mean, and says when the plan would not change', () => {
  const store = peakStore({ ratio: 1.15 });
  const eus = checkOf(store, P.eus).headline;
  assert.match(eus, /^On its busiest hour East US runs at 8\d% of capacity, above the 85% working ceiling \(\d+ weeks running\), while its weekly mean is 77%\./);
  assert.match(eus, /Planned on the busiest hour the order is [\d,]+ CU instead of 4,032/);
  const calm = peakStore({ ratio: 1 });
  assert.match(checkOf(calm, P.weuAmd).headline, /within the 85% working ceiling \(its weekly mean is 48%\)\. Planning on the busiest hour would not change this pool's plan\./);
});

test('the summary adds up the pools, and the overview narrows it to the pools in scope', () => {
  const store = peakStore({ ratio: 1.15 });
  const s = store.peak().summary;
  const list = [...store.peak().pools.values()];
  assert.equal(s.pools, 6);
  assert.equal(s.extra_cu, list.reduce((t, c) => t + c.plan.extra_cu, 0));
  assert.equal(s.peak_basis_order_cu - s.mean_basis_order_cu, s.extra_cu);
  assert.equal(s.over_ceiling_now, list.filter((c) => c.now.over_ceiling).length);
  const { buildOverview } = require('../server/lib/overview');
  const all = buildOverview(store, {}).peak;
  assert.equal(all.available, true);
  assert.equal(all.rows.length, 6);
  assert.deepEqual(all.summary, s);
  const eu = buildOverview(store, { region: 'europe' }).peak;
  assert.equal(eu.rows.length, 2);
  assert.equal(eu.summary.pools, 2);
  assert.equal(eu.summary.extra_cu, eu.rows.reduce((t, r) => t + r.extra_cu, 0));
  const rank = { 'newly-needed': 0, bigger: 1, same: 2 };
  assert.ok(all.rows.every((r, i) => i === 0 || rank[r.impact] >= rank[all.rows[i - 1].impact]), 'the pools that matter come first');
  assert.equal(buildOverview(freshStore(), {}).peak.available, false);
});

// ---------------------------------------------------------------- it follows the lab
test('the check is recomputed when the lab changes: a scenario and an approval both move it', () => {
  const store = peakStore({ ratio: 1.15 });
  const before = checkOf(store, P.eus).plan;
  store.applyScenario('quota-surge-eastus');
  const surged = checkOf(store, P.eus).plan;
  assert.ok(surged.mean_basis.order_cu > before.mean_basis.order_cu);
  assert.ok(surged.peak_basis.order_cu > before.peak_basis.order_cu);
  assert.equal(store.peak().available, true, 'scenarios never touch utilization, so the profile still fits');
  const stormy = peakStore({ ratio: 1.15 });
  const calmBefore = checkOf(stormy, P.weuAmd).plan.mean_basis.state;
  stormy.applyScenario('incident-storm-weu');
  assert.notEqual(checkOf(stormy, P.weuAmd).plan.mean_basis.state, calmBefore, 'the mean plan follows the scenario');

  const approved = peakStore({ ratio: 1.15 });
  decide(approved, P.eus, { decision: 'approve', decided_by: 'Asha Rao' });
  const after = checkOf(approved, P.eus).plan;
  assert.equal(after.mean_basis.order_cu, 0, 'the approved order covers the mean plan');
  assert.ok(after.peak_basis.order_cu > 0, 'but not the busiest hour: that is the finding');
});

test('the check is deterministic', () => {
  const a = peakStore({ ratio: 1.15 }), b = peakStore({ ratio: 1.15 });
  assert.deepEqual([...a.peak().pools.values()], [...b.peak().pools.values()]);
});

// ---------------------------------------------------------------- the API
async function withServer(store, fn) {
  const server = createApp({ store, webRoot: path.join(__dirname, '..', 'web') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (url) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`); return { status: res.status, json: await res.json() }; };
  try { await fn({ call }); } finally { await new Promise((r) => server.close(r)); }
}

test('API: /api/peak, the pool page and the overview carry the check; /api/health says whether it is on', () => withServer(peakStore({ ratio: 1.15 }), async ({ call }) => {
  const peak = await call('/api/peak');
  assert.equal(peak.status, 200);
  assert.equal(peak.json.available, true);
  assert.equal(peak.json.pools.length, 6);
  assert.equal(peak.json.rows.length, 6);
  assert.equal(peak.json.summary.pools, 6);
  assert.equal(peak.json.source, 'synthetic');
  assert.match(peak.json.definition, /Nothing here changes a plan/);
  const pool = await call(`/api/pools/${P.eus}`);
  assert.equal(pool.json.peak_check.available, true);
  assert.equal(pool.json.peak_check.pool_id, P.eus);
  assert.ok(pool.json.peak_check.plan.extra_cu > 0);
  const ov = await call('/api/overview');
  assert.equal(ov.json.peak.available, true);
  assert.equal(ov.json.peak.rows.length, 6);
  assert.equal((await call('/api/health')).json.peak_profile, true);
}));

test('API: with no profile every route still works and the check says why it is off', () => withServer(freshStore(), async ({ call }) => {
  const peak = await call('/api/peak');
  assert.equal(peak.status, 200);
  assert.equal(peak.json.available, false);
  assert.match(peak.json.reason, /npm run ml/);
  assert.equal((await call(`/api/pools/${P.eus}`)).json.peak_check.available, false);
  assert.equal((await call('/api/overview')).json.peak.available, false);
  assert.equal((await call('/api/health')).json.peak_profile, false);
  assert.equal((await call('/api/summary')).status, 200);
}));

// ---------------------------------------------------------------- the profile that ships
const shipped = { skip: fs.existsSync(PEAK_PROFILE) ? false : 'run npm run ml first' };

test('the shipped profile fits this dataset and is built from the corpus and forecast on disk', shipped, () => {
  const r = loadPeakProfile(PEAK_PROFILE, raw);
  assert.equal(r.available, true, r.reason);
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ml', 'corpus', 'meta.json'), 'utf8'));
  for (const [name, f] of Object.entries(meta.files)) assert.equal(r.profile.generated_from.corpus_files[name], f.sha256, `${name}: the profile was built from an older corpus. Run npm run ml.`);
  assert.equal(r.profile.pools.length, 6);
  assert.equal(r.profile.source, 'synthetic');
});

test('the shipped ratios are what the hourly corpus says, and only the flat AI-training pool is low', shipped, () => {
  const { buildCorpus } = require('../ml/lib/corpus');
  const corpus = buildCorpus(data);
  const { profile } = loadPeakProfile(PEAK_PROFILE, raw);
  for (const p of corpus.pools) {
    const weeks = [];
    for (let k = corpus.totalWeeks - 52; k < corpus.totalWeeks; k++) { const wk = Array.from(p.y.subarray(k * 168, (k + 1) * 168)); weeks.push(Math.max(...wk) / (wk.reduce((s, v) => s + v, 0) / 168)); }
    const pp = profile.pools.find((x) => x.pool_id === p.pool.pool_id);
    assert.ok(Math.abs(pp.busiest_hour_ratio - weeks.reduce((s, v) => s + v, 0) / 52) < 1e-4, p.pool.pool_id);
    assert.equal(pp.weekly_ratio.length, 52);
    assert.ok(Math.abs(pp.weekly_ratio.at(-1) - weeks.at(-1)) < 1e-4);
  }
  const ratio = (id) => profile.pools.find((x) => x.pool_id === id).busiest_hour_ratio;
  assert.ok(ratio(P.weuGpu) < 1.1);
  for (const id of [P.eus, P.weuAmd, P.sea, P.jpe, P.brs]) assert.ok(ratio(id) > 1.12 && ratio(id) < 1.25, id);
});

test('on the shipped profile East US is over its ceiling at the peak while its weekly mean is not, and planning on the peak costs more', shipped, () => {
  const store = freshStore({ peakProfilePath: PEAK_PROFILE });
  const c = checkOf(store, P.eus);
  assert.equal(store.peak().available, true);
  assert.equal(c.now.mean_over_ceiling, false);
  assert.equal(c.now.over_ceiling, true);
  assert.ok(c.now.weeks_over >= 3, `${c.now.weeks_over} weeks`);
  assert.equal(c.plan.mean_basis.order_cu, 4032);
  assert.ok(c.plan.peak_basis.order_cu > 4032 * 1.2, `${c.plan.peak_basis.order_cu}`);
  assert.ok(c.plan.weeks_earlier > 4);
  assert.equal(c.next_week.over_ceiling, true);
  const s = store.peak().summary;
  assert.ok(s.over_ceiling_now >= 1 && s.mean_over_ceiling_now === 0);
  assert.ok(s.extra_cu > 0 && s.extra_usd > 0);
  assert.equal(checkOf(store, P.weuAmd).plan.impact, 'same', 'a pool with plenty of room is unaffected');
});
