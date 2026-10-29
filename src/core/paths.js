'use strict';
// Data directory layout for StopCode. Everything StopCode persists lives under one
// directory so it can be inspected, exported, or deleted by the user.
//
//   <data>/state.json                 versioned document: projects, missions, sessions, settings, planner
//   <data>/state.json.bak             previous good copy (used for recovery)
//   <data>/events/<projectId>.jsonl   bounded, append-only activity events per project
//   <data>/handoffs/<projectId>/*.md  readable handoff receipts
//   <data>/chat/conversations.json    wellness chat (logically separate from coding state)
//   <data>/health.json                integration self-check data (last hook event, last error)
//   <data>/logs/hooks.log             bounded diagnostics (never written to hook stdout)
//   <data>/lock/                      cross-process mutex directory
//
// Override with STOPCODE_DATA_DIR (used for demo isolation and tests).
const path = require('path');
const os = require('os');

function dataDir() {
  const override = process.env.STOPCODE_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.stopcode');
}

function paths(base) {
  const root = base || dataDir();
  return {
    root,
    state: path.join(root, 'state.json'),
    stateBackup: path.join(root, 'state.json.bak'),
    events: path.join(root, 'events'),
    handoffs: path.join(root, 'handoffs'),
    chat: path.join(root, 'chat', 'conversations.json'),
    health: path.join(root, 'health.json'),
    hookLog: path.join(root, 'logs', 'hooks.log'),
    lock: path.join(root, 'lock'),
    eventsFile: (projectId) => path.join(root, 'events', `${projectId}.jsonl`),
    handoffDir: (projectId) => path.join(root, 'handoffs', projectId),
  };
}

module.exports = { dataDir, paths };
