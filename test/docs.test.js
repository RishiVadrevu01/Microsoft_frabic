'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../scripts/make-docs');
const { DATA_DIR } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const norm = (s) => s.replace(/\r\n/g, '\n');

test('the generated docs match what the engine produces (run npm run docs to refresh)', () => {
  for (const [file, body] of Object.entries(build())) {
    const onDisk = norm(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert.equal(onDisk, norm(body), `${file} is out of date`);
  }
});

test('the demo script quotes the numbers the API returns', () => {
  const demo = build()['docs/DEMO-SCRIPT.md'];
  assert.match(demo, /No\. 1 of 6 pools is already past/);
  assert.match(demo, /4,032 CU of FAB-AMD-GENOA-96/);
  assert.match(demo, /from OVERDUE to \*\*PLAN\*\*/);
  assert.match(demo, /ORD-LAB-0001/);
});

test('the data dictionary documents every data file', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'DATA.md'), 'utf8');
  for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
    assert.ok(doc.includes(`\`${f}\``), `docs/DATA.md does not mention ${f}`);
  }
});

test('the README lists every npm script it tells people to run', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  for (const name of ['start', 'demo', 'reset', 'test', 'verify:ui', 'docs']) {
    assert.ok(scripts[name], `package.json has no "${name}" script`);
    assert.ok(readme.includes(name), `README does not mention ${name}`);
  }
});
