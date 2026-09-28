'use strict';
// Makes ONE real call to the configured Azure OpenAI deployment for one pool and prints
// what came back, so you can see the AI explainer work outside the browser.
//   node scripts/try-ai.js [pool-id]
// Sends only that pool's synthetic plan facts. The key is never printed.

const path = require('node:path');
const { loadRaw, indexData } = require('../server/lib/data');
const { assessPool } = require('../server/lib/verdict');
const { createExplainer } = require('../server/lib/explain');
const { loadEnv, aiConfig } = require('../server/lib/env');

async function main() {
  const poolId = process.argv[2] || 'pool-eastus-01-intel-icx';
  const data = indexData(loadRaw(path.join(__dirname, '..', 'data')));
  const explainer = createExplainer({ config: aiConfig(loadEnv(path.join(__dirname, '..', '.env'))) });
  const status = explainer.status();
  console.log('status:', JSON.stringify(status));
  if (!status.configured) { console.log('AI is not configured, so this would use rules-based text.'); }
  const started = Date.now();
  const r = await explainer.explain(assessPool(data, poolId).verdict);
  console.log(`\nsource: ${r.source}   ai: ${r.ai.status}   (${Date.now() - started} ms)`);
  console.log(`note: ${r.ai.message}`);
  if (r.ai.problems) console.log('problems:', r.ai.problems.join('; '));
  console.log('\nsummary:\n ', r.text.summary);
  console.log('\nwhy now:'); r.text.why_now.forEach((x) => console.log('  -', x));
  console.log('\nrisks:'); (r.text.risks.length ? r.text.risks : ['(none)']).forEach((x) => console.log('  -', x));
  console.log(`\nrequest draft: ${r.text.request_title}\n ${r.text.request_body}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
