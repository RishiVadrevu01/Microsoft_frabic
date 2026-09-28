'use strict';
// Return the lab to the shipped baseline: delete everything the person did
// (scenarios, submitted requests, decisions, lab progress). The seed data in
// data/ is never modified, so there is nothing else to undo.

const fs = require('node:fs');
const path = require('node:path');

const statePath = process.env.LAB_STATE || path.join(__dirname, '..', 'runtime', 'state.json');

if (fs.existsSync(statePath)) {
  fs.rmSync(statePath);
  console.log(`reset: removed ${statePath}`);
} else {
  console.log('reset: nothing to remove, the lab is already at the baseline.');
}
