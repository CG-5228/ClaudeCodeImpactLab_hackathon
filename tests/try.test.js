'use strict';
// `npm run try` is the end-to-end walkthrough a newcomer runs first; keep it green.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers');

test('scripts/try.js runs the full loop against the real CLI and hook and reports no failures', () => {
  const r = spawnSync(process.execPath, [path.join(H.REPO, 'scripts', 'try.js')], { env: H.childEnv(''), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Summary: 12 passed, 0 failed\./);
});
