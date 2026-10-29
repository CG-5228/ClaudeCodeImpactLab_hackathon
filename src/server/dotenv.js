'use strict';
// Minimal .env loader used by the dashboard server only. Hooks, skills and the CLI never
// load it, so API credentials stay with the long-running local server process.
//
// Rules: only an allow-list of keys is read, variables that are already set in the
// environment are never overridden, and values are never logged (callers only get the
// names of the keys that were applied).
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWED_KEY = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|STOPCODE_[A-Z_]+)$/;

// Parses KEY=VALUE lines. Supports `export KEY=...`, single/double quotes and `# comments`.
function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

// Loads <repo>/.env into `env` (default process.env). Returns which keys were applied and
// which were skipped (not allowed, empty, or already set). Never returns values.
function loadDotenv({ file = path.join(REPO_ROOT, '.env'), env = process.env } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { loaded: false, file, applied: [], skipped: [] };
  }
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    if (!ALLOWED_KEY.test(key) || !value || (env[key] !== undefined && String(env[key]).trim() !== '')) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { loaded: true, file, applied, skipped };
}

module.exports = { loadDotenv, parseDotenv, ALLOWED_KEY, REPO_ROOT };
