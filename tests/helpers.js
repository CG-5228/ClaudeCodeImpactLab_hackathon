'use strict';
// Shared fixtures for the StopCode test-suite (node:test only, no dependencies).
//
// Every test creates its own scratch directory under the OS temp dir and points the core at
// a data directory inside it, so the suite never touches ~/.stopcode. The temp path is
// resolved to its long form: Windows may hand out an 8.3 short name (GREGDE~1) while git,
// which the core uses for project-root detection, reports long names; mixing the two forms
// would make project roots compare unequal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'stopcode.js');
const HOOK = path.join(REPO, 'hooks', 'stopcode-hook.js');
const WORKER = path.join(__dirname, 'helpers', 'concurrency-worker.js');
const core = require(path.join(REPO, 'src', 'core'));

const TMP_ROOT = fs.realpathSync.native(os.tmpdir());

// A developer's home directory can itself be a git work tree (it is on the machine this
// suite was written on). Without a ceiling, git would report every scratch directory as part
// of that repository and a "non-git" project could never exist. The ceiling applies to the
// core's in-process git calls and, through childEnv() below, to spawned CLI/hook processes.
process.env.GIT_CEILING_DIRECTORIES = TMP_ROOT;
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

function mkScratch(t, prefix = 'stopcode-test-') {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  // The data directory name carries a space on purpose; so does the default project name.
  const dataDir = path.join(dir, 'stopcode data');
  const api = {
    dir,
    dataDir,
    project(name = 'my project') {
      const p = path.join(dir, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    gitProject(name = 'git project') {
      const p = api.project(name);
      gitInit(p);
      return p;
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (e) {
        if (t) t.diagnostic(`scratch cleanup failed for ${dir}: ${e.message}`);
      }
    },
  };
  if (t) t.after(() => api.cleanup());
  return api;
}

function gitInit(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=StopCode Tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial commit']);
}

// Environment for spawned processes: the scratch data dir, no inherited Claude Code project
// hints (they would redirect the CLI away from the scratch project), and the git ceiling.
function childEnv(dataDir, extra = {}) {
  const env = { ...process.env, STOPCODE_DATA_DIR: dataDir, ...extra };
  for (const key of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'STOPCODE_PORT']) if (!(key in extra)) delete env[key];
  return env;
}

// Spawns hooks/stopcode-hook.js exactly the way Claude Code does: event name as argv[2],
// JSON on stdin, cwd = the project directory.
function runHook(event, input, { dataDir, cwd, env } = {}) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [HOOK, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    cwd,
    env: childEnv(dataDir, env),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  const ms = Date.now() - started;
  let json = null;
  if (res.stdout && res.stdout.trim()) {
    try {
      json = JSON.parse(res.stdout);
    } catch (e) {
      json = { unparseable: res.stdout };
    }
  }
  return { status: res.status, signal: res.signal, error: res.error, stdout: res.stdout || '', stderr: res.stderr || '', json, ms };
}

// The hook contract: exit code 0, fast, and stdout is either empty or one JSON object.
function expectHookContract(res, label) {
  assert.equal(res.error, undefined, `${label}: spawn error ${res.error && res.error.message}`);
  assert.equal(res.status, 0, `${label}: exit code ${res.status}; stderr: ${res.stderr}`);
  assert.ok(res.ms < 3000, `${label}: hook took ${res.ms} ms (limit 3000)`);
  assert.ok(!res.json || !res.json.unparseable, `${label}: stdout was not JSON: ${res.stdout}`);
}

function hookInput(event, cwd, sessionId, extra = {}) {
  return { session_id: sessionId, transcript_path: path.join(cwd, '.transcript.jsonl'), cwd, hook_event_name: event, permission_mode: 'default', ...extra };
}

function runCli(args, { dataDir, cwd, env } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: childEnv(dataDir, env),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    input: '',
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch (e) {
    json = null;
  }
  return { status: res.status, error: res.error, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readState(dataDir) {
  return readJson(path.join(dataDir, 'state.json'));
}

function readHealth(dataDir) {
  try {
    return readJson(path.join(dataDir, 'health.json'));
  } catch (e) {
    return {};
  }
}

function eventsFile(dataDir, projectId) {
  return path.join(dataDir, 'events', `${projectId}.jsonl`);
}

function readEvents(dataDir, projectId) {
  return new core.store.Store(dataDir).readEvents(projectId, { limit: 0 });
}

function onlyProject(state) {
  const list = Object.values(state.projects);
  assert.equal(list.length, 1, `expected exactly one project, found ${list.length}`);
  return list[0];
}

// A controllable clock for `new StopCode({ now })`: `now` is a function returning the
// current ISO string, which tests advance explicitly.
function makeClock(startIso) {
  let iso = new Date(startIso).toISOString();
  return {
    now: () => iso,
    get iso() {
      return iso;
    },
    set(value) {
      iso = new Date(value).toISOString();
      return iso;
    },
    tick(minutes) {
      iso = new Date(Date.parse(iso) + minutes * 60000).toISOString();
      return iso;
    },
  };
}

function allDayWorkingHours() {
  const block = [{ start: '00:00', end: '23:59' }];
  return { mon: block, tue: block, wed: block, thu: block, fri: block, sat: block, sun: block };
}

function noWorkingHours() {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

module.exports = {
  REPO,
  CLI,
  HOOK,
  WORKER,
  TMP_ROOT,
  core,
  mkScratch,
  gitInit,
  childEnv,
  runHook,
  expectHookContract,
  hookInput,
  runCli,
  readJson,
  readState,
  readHealth,
  eventsFile,
  readEvents,
  onlyProject,
  makeClock,
  allDayWorkingHours,
  noWorkingHours,
};
