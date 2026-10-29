'use strict';
// Stable project identity. A project is identified by its root directory (the Git
// top-level when available, otherwise the directory itself). The id is a hash of the
// normalized root path so it is stable across sessions and machines-with-same-path.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stableId } = require('./ids');

// Resolve symlinks (macOS /tmp -> /private/tmp, Git's realpath'd top level) so the same
// directory always maps to the same project. Paths that do not exist yet resolve through
// their nearest existing ancestor.
function canonicalPath(p) {
  const abs = path.resolve(String(p || '.'));
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch (e) {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function normalizeForCompare(p) {
  let r = canonicalPath(p);
  r = r.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase().replace(/\\/g, '/');
  return r;
}

function isInside(root, dir) {
  const a = normalizeForCompare(root);
  const b = normalizeForCompare(dir);
  return b === a || b.startsWith(a + '/');
}

// Git top-level detection with a hard timeout; never throws.
function detectRoot(dir) {
  const abs = canonicalPath(dir);
  try {
    const out = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (out) return { root: path.resolve(out), git: true };
  } catch (e) {
    /* not a git repo, or git missing */
  }
  return { root: abs, git: false };
}

function projectIdForRoot(root) {
  return stableId('proj', normalizeForCompare(root));
}

// Longest registered root that contains `dir`.
function findProject(state, dir) {
  let best = null;
  for (const project of Object.values(state.projects || {})) {
    if (!project || !project.root) continue;
    if (isInside(project.root, dir)) {
      if (!best || normalizeForCompare(project.root).length > normalizeForCompare(best.root).length) best = project;
    }
  }
  return best;
}

function findProjectByRef(state, ref) {
  if (!ref) return null;
  if (state.projects[ref]) return state.projects[ref];
  return findProject(state, ref);
}

function createProjectRecord(root, { git = false, now } = {}) {
  const at = now || new Date().toISOString();
  return {
    id: projectIdForRoot(root),
    root: canonicalPath(root),
    name: path.basename(canonicalPath(root)) || canonicalPath(root),
    git: !!git,
    createdAt: at,
    activeMissionId: null,
    monitoring: { paused: false, pausedAt: null },
    quiet: null,
    quietHistory: [],
    lastActivityAt: null,
    lastSessionId: null,
    counters: { toolEvents: 0, afterHoursEvents: 0, prompts: 0 },
    advice: { lastAt: null, dismissedUntil: null },
  };
}

// Find or register the project for a directory. Detection spawns git once, only when
// no registered project contains the directory.
function ensureProject(state, dir, { now, detect = true } = {}) {
  const existing = findProject(state, dir);
  if (existing) return existing;
  const det = detect ? detectRoot(dir) : { root: canonicalPath(dir), git: false };
  const id = projectIdForRoot(det.root);
  if (state.projects[id]) return state.projects[id];
  const record = createProjectRecord(det.root, { git: det.git, now });
  state.projects[id] = record;
  return record;
}

function relativePath(project, filePath) {
  if (!filePath) return null;
  try {
    const abs = canonicalPath(filePath);
    if (project && project.root && isInside(project.root, abs)) {
      return path.relative(canonicalPath(project.root), abs).split(path.sep).join('/') || '.';
    }
    return path.basename(abs);
  } catch (e) {
    return null;
  }
}

module.exports = {
  canonicalPath,
  normalizeForCompare,
  isInside,
  detectRoot,
  projectIdForRoot,
  findProject,
  findProjectByRef,
  createProjectRecord,
  ensureProject,
  relativePath,
};
