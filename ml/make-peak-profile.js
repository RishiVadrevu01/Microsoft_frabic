'use strict';
/*
 * Writes ml/out/peak_profile.json: the small file the lab's engine reads to check its plan against each pool's
 * busiest hour. It needs the corpus (npm run corpus) and the trained forecast (npm run ml:train).
 *
 * It refuses to build if the forecast was trained on a different corpus from the one on disk, so the profile can
 * never quietly mix two datasets.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadRaw, indexData } = require('../server/lib/data');
const { buildCorpus } = require('./lib/corpus');
const { buildPeakProfile } = require('./lib/peak-profile');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const need = (file, hint) => { if (!fs.existsSync(file)) { console.error(`peak profile: ${path.relative(ROOT, file)} is missing. ${hint}`); process.exit(1); } return fs.readFileSync(file, 'utf8'); };

const corpusMeta = JSON.parse(need(path.join(__dirname, 'corpus', 'meta.json'), 'Run: npm run corpus'));
const forecast = need(path.join(OUT, 'forecast_next_168h.csv'), 'Run: npm run ml:train');
const backtest = JSON.parse(need(path.join(OUT, 'backtest.json'), 'Run: npm run ml:train'));

for (const [name, f] of Object.entries(backtest.corpus.files)) {
  if (!corpusMeta.files[name] || corpusMeta.files[name].sha256 !== f.sha256) {
    console.error(`peak profile: the forecast was trained on a different ${name} from the one on disk. Run: npm run ml`);
    process.exit(1);
  }
}

const corpus = buildCorpus(indexData(loadRaw(path.join(ROOT, 'data'))));
const profile = buildPeakProfile(corpus, forecast, { corpusFiles: corpusMeta.files, backtest });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'peak_profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
console.log(`peak profile: wrote ml/out/peak_profile.json for ${profile.pools.length} pools, as of ${profile.as_of}`);
for (const p of profile.pools) {
  console.log(`  ${p.pool_id.padEnd(34)} busiest hour is ${p.busiest_hour_ratio}x the weekly mean (sd ${p.busiest_hour_ratio_sd}); next week's busiest hour p80 ${Math.round(p.next_week.busiest_p80).toLocaleString('en-US')} CU`);
}
