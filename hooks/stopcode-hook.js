#!/usr/bin/env node
'use strict';
// Single entry point for every StopCode hook (configured in hooks/hooks.json).
// Reads the event JSON from stdin, hands it to the core, prints a JSON decision only when
// there is one, and always exits 0 so a StopCode failure never blocks the user.
// Diagnostics go to <data>/logs/hooks.log, never to stdout.
const path = require('path');

const eventName = process.argv[2];
let raw = '';
let done = false;

function finish(output) {
  if (done) return;
  done = true;
  const text = output ? JSON.stringify(output) : '';
  if (!text) {
    process.exit(0);
    return;
  }
  process.stdout.write(text, () => process.exit(0));
}

function run() {
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    input = {};
  }
  let out = null;
  try {
    const { handleHook } = require(path.join(__dirname, '..', 'src', 'core', 'hooks.js'));
    out = handleHook(eventName || input.hook_event_name, input);
  } catch (e) {
    try {
      const { StopCode } = require(path.join(__dirname, '..', 'src', 'core', 'domain.js'));
      const { recordHookError } = require(path.join(__dirname, '..', 'src', 'core', 'hooks.js'));
      recordHookError(new StopCode(), eventName, e);
    } catch (e2) {
      /* nothing else we can do; fail open */
    }
    out = null;
  }
  finish(out);
}

// Guard against a stdin that never closes.
const timer = setTimeout(() => {
  if (!done) run();
}, 5000);
timer.unref();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', run);
process.stdin.on('error', run);
