'use strict';
// Entry point. `npm start` serves the lab on http://127.0.0.1:4400.
// HOST and PORT can be overridden; HOST=0.0.0.0 exposes it to the local network.
// An optional .env (see .env.example) switches on the AI plain-words explainer.

const path = require('node:path');
const { createStore } = require('./lib/store');
const { createExplainer } = require('./lib/explain');
const { loadEnv, aiConfig } = require('./lib/env');
const { createApp } = require('./app');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4400);
const HOST = process.env.HOST || '127.0.0.1';

const store = createStore({
  dataDir: path.join(ROOT, 'data'),
  statePath: process.env.LAB_STATE || path.join(ROOT, 'runtime', 'state.json'),
  peakProfilePath: process.env.PEAK_PROFILE || path.join(ROOT, 'ml', 'out', 'peak_profile.json'),    // optional: from `npm run ml`
});
const explainer = createExplainer({ config: aiConfig(loadEnv(path.join(ROOT, '.env'))) });
const server = createApp({ store, webRoot: path.join(ROOT, 'web'), explainer });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other server, or start with PORT=<free port>.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const meta = store.data();
  console.log(`Fabric capacity planning lab  ->  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  synthetic dataset ${meta.meta.dataset_version}, as of ${meta.as_of}, ${meta.pools.length} pools, 14 funnels`);
  const ai = explainer.status();
  console.log(ai.configured
    ? `  AI explainer: on (${ai.model} at ${ai.host}). It only re-tells the plan and its figures are checked.`
    : `  AI explainer: off (${ai.reason}). Rules-based text is used; everything else works.`);
  const peak = store.peak();
  console.log(peak.available ? '  peak check: on (each plan is also checked against its busiest hour)' : `  peak check: off (${peak.reason})`);
  const applied = store.state().scenarios.length;
  if (applied) console.log(`  note: ${applied} lab scenario(s) from a previous session are still applied. Use "npm run reset" or the Lab page to clear them.`);
});

module.exports = { server, store };
