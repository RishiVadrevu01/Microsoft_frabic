'use strict';
// Reads .env (KEY=VALUE per line) and the process environment, and turns the
// Azure OpenAI settings into one config object. The key is read here and used only
// by explain.js on the server; it is never sent to the browser or written to logs.
// Names match the earlier POCs, so an existing .env works unchanged.

const fs = require('node:fs');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

// The process environment wins over the file, so a key set in the shell is honoured.
function loadEnv(file, processEnv = process.env) {
  let fromFile = {};
  try { if (file && fs.existsSync(file)) fromFile = parseEnv(fs.readFileSync(file, 'utf8')); } catch { /* unreadable .env: treat as absent */ }
  const merged = { ...fromFile };
  for (const [k, v] of Object.entries(processEnv)) if (/^(AZURE_OPENAI_|USE_AZURE_OPENAI)/.test(k) && v) merged[k] = v;
  return merged;
}

const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

function aiConfig(vars = {}) {
  const off = (reason) => ({ enabled: false, reason });
  if (String(vars.USE_AZURE_OPENAI || 'true').toLowerCase() === 'false') return off('USE_AZURE_OPENAI is false');
  if (!vars.AZURE_OPENAI_ENDPOINT) return off('AZURE_OPENAI_ENDPOINT is not set');
  if (!vars.AZURE_OPENAI_API_KEY) return off('AZURE_OPENAI_API_KEY is not set');
  let url;
  try { url = new URL(vars.AZURE_OPENAI_ENDPOINT); } catch { return off('AZURE_OPENAI_ENDPOINT is not a valid URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) return off('AZURE_OPENAI_ENDPOINT must be https');
  return {
    enabled: true,
    endpoint: `${url.protocol}//${url.host}`,
    host: url.host,
    apiKey: vars.AZURE_OPENAI_API_KEY,
    deployment: vars.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4.1-mini',
    apiVersion: vars.AZURE_OPENAI_API_VERSION || '2024-10-21',
  };
}

module.exports = { parseEnv, loadEnv, aiConfig };
