'use strict';
/*
 * Generates the hourly corpus into ml/corpus/:
 *   hourly_pool_metrics.csv   one row per pool per hour, two years, with the funnel signals
 *   pools.csv                 what each pool is (region, SKU, workload type, capacity, time zone)
 *   calendar_future.csv       local hour, day and holiday for the eight days after the last hour
 *   meta.json                 what every column means, how it ties to the lab, and each file's checksum
 *
 * `npm run corpus` runs it. The seed data is read, never written.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadRaw, indexData } = require('../server/lib/data');
const { buildCorpus, toFiles } = require('./lib/corpus');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'corpus');

const started = Date.now();
const corpus = buildCorpus(indexData(loadRaw(path.join(ROOT, 'data'))));
const files = toFiles(corpus);
fs.mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), body);
  console.log(`corpus: wrote ml/corpus/${name} (${(Buffer.byteLength(body) / 1e6).toFixed(2)} MB)`);
}
const meta = JSON.parse(files['meta.json']);
console.log(`corpus: ${meta.rows.toLocaleString('en-US')} rows, ${meta.pools.length} pools x ${meta.hours_per_pool.toLocaleString('en-US')} hours, ${meta.starts_utc} to ${meta.ends_before_utc} (exclusive), in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const p of meta.per_pool) {
  console.log(`  ${p.pool_id.padEnd(34)} last week mean ${String(p.last_week_mean).padStart(7)}  peak/mean ${p.peak_to_mean_max} (p95 ${p.peak_to_mean_p95})  busiest hour ${(p.max_share_of_capacity * 100).toFixed(1)}% of capacity, quietest ${(p.min_share_of_capacity * 100).toFixed(1)}%`);
}
