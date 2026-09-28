'use strict';
/*
 * The optional ML side of the lab. The lab itself is Node built-ins only; this adds an hourly corpus
 * (Node) and a LightGBM forecast trained on it (Python, in its own virtual environment in ml/.venv).
 *
 *   node scripts/ml.js setup        create ml/.venv and install ml/requirements.txt (needs Python 3.10+ and a network)
 *   node scripts/ml.js corpus       generate ml/corpus/ from the lab's data
 *   node scripts/ml.js train [--fast]   train and back-test, write ml/out/, then build the peak profile
 *   node scripts/ml.js peak-profile     rebuild ml/out/peak_profile.json from the corpus and the last forecast
 *   node scripts/ml.js all [--fast]     corpus, then train
 *
 * Nothing here touches the lab's data or its running state.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ML = path.resolve(__dirname, '..', 'ml');
const venvPython = process.platform === 'win32' ? path.join(ML, '.venv', 'Scripts', 'python.exe') : path.join(ML, '.venv', 'bin', 'python');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status;
};

function findPython() {
  const candidates = process.env.PYTHON ? [[process.env.PYTHON, []]] : [['python', []], ['python3', []], ['py', ['-3']]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status === 0) {
      const [maj, min] = r.stdout.trim().split('.').map(Number);
      if (maj === 3 && min >= 10) return [cmd, pre];
    }
  }
  return null;
}

function setup() {
  if (!fs.existsSync(venvPython)) {
    const py = findPython();
    if (!py) { console.error('Python 3.10 or newer was not found. Install it, or set PYTHON to its path.'); return 1; }
    console.log(`ml: creating ml/.venv with ${py[0]}`);
    if (run(py[0], [...py[1], '-m', 'venv', path.join(ML, '.venv')]) !== 0) return 1;
  }
  console.log('ml: installing ml/requirements.txt');
  return run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(ML, 'requirements.txt')]);
}

function corpus() { return run(process.execPath, [path.join(ML, 'make-corpus.js')]); }

// The peak profile is what the lab's engine reads to check its plan against each pool's busiest hour.
function peakProfile() { return run(process.execPath, [path.join(ML, 'make-peak-profile.js')]); }

function train(extra) {
  if (!fs.existsSync(venvPython)) { console.error('ml/.venv is missing. Run: npm run ml:setup'); return 1; }
  if (!fs.existsSync(path.join(ML, 'corpus', 'meta.json'))) { console.error('ml/corpus is missing. Run: npm run corpus'); return 1; }
  const status = run(venvPython, [path.join(ML, 'train_forecast.py'), ...extra]);
  // A --fast run is a rough check of the pipeline; its forecast is not one to plan against, so it does not feed the lab.
  return status || (extra.includes('--fast') ? 0 : peakProfile());
}

const [cmd = '', ...rest] = process.argv.slice(2);
const table = { setup, corpus, train: () => train(rest), 'peak-profile': peakProfile, all: () => corpus() || train(rest) };
if (!table[cmd]) { console.error('usage: node scripts/ml.js setup | corpus | train [--fast] | peak-profile | all [--fast]'); process.exit(2); }
process.exit(table[cmd]());
