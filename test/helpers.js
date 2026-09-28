'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createStore } = require('../server/lib/store');
const { loadRaw, indexData, clone } = require('../server/lib/data');
const { assessPool } = require('../server/lib/verdict');

const DATA_DIR = path.join(__dirname, '..', 'data');

const P = {
  eus: 'pool-eastus-01-intel-icx',
  weuAmd: 'pool-westeurope-01-amd-genoa',
  weuGpu: 'pool-westeurope-02-gpu-h100',
  sea: 'pool-southeastasia-01-amd-genoa',
  jpe: 'pool-japaneast-01-gpu-l40s',
  brs: 'pool-brazilsouth-01-amd-genoa',
};

// A store with no state file: nothing touches disk, every test starts at the baseline.
// `peakProfilePath` switches the optional peak check on.
const freshStore = (opts = {}) => createStore({ dataDir: DATA_DIR, statePath: null, ...opts });

// The peak profile that `npm run ml` ships, and a valid stand-in built from the dataset so the engine can be
// tested without any ML output: the same ratio for every pool unless told otherwise.
const PEAK_PROFILE = path.join(__dirname, '..', 'ml', 'out', 'peak_profile.json');
function fixtureProfile({ ratio = 1.15, ratios = {}, weekly = {}, next = {} } = {}) {
  const raw = loadRaw(DATA_DIR);
  return {
    source: 'synthetic', profile_version: 'test', as_of: raw.as_of, generated_from: { test: true },
    pools: raw.pools.map((pool) => {
      const series = raw.utilization.find((u) => u.pool_id === pool.pool_id).series;
      const r = ratios[pool.pool_id] ?? ratio;
      const last = series.at(-1).utilized_units;
      const n = next[pool.pool_id] || {};
      return {
        pool_id: pool.pool_id, weeks: series.length, busiest_hour_ratio: r, busiest_hour_ratio_sd: 0.02, p95_hour_ratio: r - 0.03,
        weekly_ratio: weekly[pool.pool_id] || series.map(() => r),
        history: { mean_last_week: last, busiest_hour_last_week: last * r },
        next_week: {
          starts_utc: `${raw.as_of}T00:00:00Z`, mean_p50: last, busiest_p80: last * r, busiest_p80_at_utc: `${raw.as_of}T13:00:00Z`, busiest_p80_local_hour: 13,
          busiest_p95: last * (r + 0.03), busiest_p95_at_utc: `${raw.as_of}T13:00:00Z`, busiest_p95_local_hour: 13, ...n,
        },
      };
    }),
  };
}
function writeProfile(profile) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-peak-')), 'peak_profile.json');
  fs.writeFileSync(file, JSON.stringify(profile));
  return file;
}
const peakStore = (opts) => freshStore({ peakProfilePath: writeProfile(fixtureProfile(opts)) });

// The raw seed as an indexed dataset, optionally edited first.
function dataset(edit) {
  const raw = clone(loadRaw(DATA_DIR));
  if (edit) edit(raw);
  return indexData(raw);
}

const verdictOf = (data, poolId, overrides) => assessPool(data, poolId, overrides).verdict;

// Copy data/ to a temp directory so a test can corrupt a file safely.
function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-data-'));
  for (const f of fs.readdirSync(DATA_DIR)) if (f.endsWith('.json')) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
  return dir;
}

module.exports = { DATA_DIR, P, freshStore, dataset, verdictOf, tempDataDir, PEAK_PROFILE, fixtureProfile, writeProfile, peakStore };
