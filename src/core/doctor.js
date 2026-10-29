'use strict';
// Integration self-check. Reports facts, not hopes: configuration is never shown as a
// successful connection, and the last real hook event is shown with its age.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const T = require('./time');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function apiConfiguration(env = process.env) {
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim()) return { configured: true, source: 'ANTHROPIC_API_KEY environment variable' };
  if (env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN.trim()) return { configured: true, source: 'ANTHROPIC_AUTH_TOKEN environment variable' };
  const envFile = path.join(REPO_ROOT, '.env');
  try {
    const text = fs.readFileSync(envFile, 'utf8');
    if (/^\s*ANTHROPIC_API_KEY\s*=\s*\S+/m.test(text)) return { configured: true, source: '.env file in the StopCode directory (loaded by the dashboard server only)' };
  } catch (e) {
    /* no .env */
  }
  return { configured: false, source: null };
}

function claudeVersion() {
  // Fixed command string, no user input: safe to run through the shell so that the
  // Windows `claude.cmd` shim resolves.
  try {
    return execSync('claude --version', { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch (e) {
    return null;
  }
}

function doctor(sc, { projectRef, checkClaude = true } = {}) {
  const now = sc.now();
  const health = sc.store.readHealth();
  const writable = sc.store.probeWritable();
  let stateOk = true;
  let stateError = null;
  try {
    sc.readState();
  } catch (e) {
    stateOk = false;
    stateError = String(e.message || e);
  }
  const pluginFiles = {
    manifest: fs.existsSync(path.join(REPO_ROOT, '.claude-plugin', 'plugin.json')),
    hooksJson: fs.existsSync(path.join(REPO_ROOT, 'hooks', 'hooks.json')),
    hookScript: fs.existsSync(path.join(REPO_ROOT, 'hooks', 'stopcode-hook.js')),
    skills: ['start', 'status', 'pause', 'finish', 'resume'].filter((s) => fs.existsSync(path.join(REPO_ROOT, 'skills', s, 'SKILL.md'))),
  };
  const api = apiConfiguration();
  const apiTest = (health.api && health.api.lastTest) || null;
  const lastHook = health.lastHookEvent || null;
  const lastErr = health.lastHookError || null;
  const project = sc.resolveProject(projectRef);
  const quiet = project ? sc.quietStatus({ project: project.id }) : null;
  return {
    now,
    dataDir: sc.dataDir,
    storage: {
      writable: writable.ok,
      error: writable.error || null,
      stateReadable: stateOk,
      stateError,
      lastWriteAt: health.storage && health.storage.lastWriteAt ? health.storage.lastWriteAt : null,
      lastRecovery: health.storage && health.storage.lastRecovery ? health.storage.lastRecovery : null,
    },
    hooks: {
      lastEvent: lastHook,
      lastEventAge: lastHook ? T.humanAge(lastHook.at, now) : null,
      observed: !!lastHook,
      lastError: lastErr,
      degraded: !!(lastErr && (!lastHook || T.toMs(lastErr.at) >= T.toMs(lastHook.at) - 60000) && T.toMs(now) - T.toMs(lastErr.at) < 6 * 3600000),
    },
    plugin: {
      root: REPO_ROOT,
      files: pluginFiles,
      loadCommand: `claude --plugin-dir "${REPO_ROOT}"`,
      claudeVersion: checkClaude ? claudeVersion() : null,
    },
    api: {
      configured: api.configured,
      source: api.source,
      model: process.env.STOPCODE_CHAT_MODEL || 'claude-opus-5-5',
      tested: !!(apiTest && apiTest.ok),
      lastTest: apiTest,
      note: api.configured ? (apiTest && apiTest.ok ? `Last successful test ${T.humanAge(apiTest.at, now)}.` : 'Configured but not yet tested successfully. Use "Test connection" in Settings.') : 'Not configured. Set ANTHROPIC_API_KEY for the dashboard server (a Claude Code subscription does not provide API credentials).',
    },
    quietHours: quiet ? { project: project.name, root: project.root, projectId: project.id, ...quiet } : { project: null, note: 'No StopCode project matches this directory; quiet hours apply per project.' },
    platform: { node: process.version, os: `${os.platform()} ${os.release()}` },
  };
}

module.exports = { doctor, apiConfiguration, REPO_ROOT };
