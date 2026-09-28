'use strict';
// One command for a clean demo: reset the lab to the baseline, start the server,
// and open the browser.   npm run demo

const { execFile, execSync } = require('node:child_process');
const path = require('node:path');

execSync(`"${process.execPath}" "${path.join(__dirname, 'reset.js')}"`, { stdio: 'inherit' });
require('../server/index.js');

const port = Number(process.env.PORT || 4400);
const url = `http://127.0.0.1:${port}/`;
setTimeout(() => {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url], () => {});
}, 600);
