'use strict';
// Developer tool: print the engine's verdict for every pool, one line each, plus
// (with --pool <id>) the full why-now trace. Reads data/ directly, no server.
//   node scripts/inspect.js
//   node scripts/inspect.js --pool pool-eastus-01-intel-icx

const path = require('node:path');
const { loadRaw, indexData } = require('../server/lib/data');
const { assessPool } = require('../server/lib/verdict');
const { fmt } = require('../server/lib/dates');
const { num, usd } = require('../server/lib/format');

const data = indexData(loadRaw(path.join(__dirname, '..', 'data')));
const only = process.argv.includes('--pool') ? process.argv[process.argv.indexOf('--pool') + 1] : null;

console.log(`as_of ${data.as_of}\n`);
for (const p of data.pools) {
  if (only && p.pool_id !== only) continue;
  const { verdict: v } = assessPool(data, p.pool_id);
  const d = v.dates;
  console.log(`${p.pool_id.padEnd(34)} ${v.state.padEnd(9)} ${v.priority.padEnd(8)} util ${(v.capacity.utilization_of_usable * 100).toFixed(0)}%  ` +
    `need-by ${fmt(d.needed_by).padEnd(12)} lead ${String(v.lead.weeks).padStart(2)}w  raise-by ${fmt(d.raise_by).padEnd(12)} ` +
    `order ${num(v.order.quantity_cu).padStart(6)} CU ${usd(v.order.cost_usd).padStart(8)}  covered-until ${fmt(d.covered_until)}  driver ${v.driver ? v.driver.id : '-'}`);
  console.log(`    horizons: ${v.horizons.map((h) => `${h.label}=${h.status}`).join('  ')}   flagged: ${v.trace.filter((t) => t.status === 'flagged').map((t) => `${t.number}${t.context_only ? 'c' : ''}`).join(',')}`);
  if (only) {
    console.log(`\n  ${v.headline}`);
    v.reasons.forEach((r) => console.log(`   - ${r}`));
    console.log('\n  why-now trace:');
    for (const t of v.trace) {
      if (t.status === 'flagged') console.log(`   #${String(t.number).padStart(2)} ${t.name} [${t.severity}${t.context_only ? ', context' : ''}]: ${t.headline}\n        -> ${t.effects.join(' | ')}`);
    }
    console.log('\n  order arithmetic:');
    v.order.components.forEach((c) => console.log(`   ${c.total ? '=' : ' '} ${c.label.padEnd(88)} ${num(c.value).padStart(8)} ${c.unit}`));
    console.log('\n  forecast:', v.forecast.model, '|', v.forecast.why);
  }
}
