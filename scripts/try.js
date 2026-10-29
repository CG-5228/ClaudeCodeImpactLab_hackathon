#!/usr/bin/env node
'use strict';
// StopCode end to end in about a second, without Claude Code and without an API key.
//
// It drives the real CLI (bin/stopcode.js) and the real hook script (hooks/stopcode-hook.js),
// feeding the hook the same JSON on stdin that Claude Code sends. Nothing is mocked: every check
// reads the state the core actually wrote. Everything happens in a throwaway project and data
// directory under the OS temp dir, so your real StopCode data (~/.stopcode) is never touched.
//
// Usage: npm run try            (or: node scripts/try.js [--keep] to leave the scratch dir)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'stopcode.js');
const HOOK = path.join(REPO, 'hooks', 'stopcode-hook.js');
const keep = process.argv.includes('--keep');

const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'stopcode-try-'));
const proj = path.join(base, 'login service');
const dataDir = path.join(base, 'data');
fs.mkdirSync(proj);

const env = { ...process.env, STOPCODE_DATA_DIR: dataDir, GIT_CEILING_DIRECTORIES: base };
for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
const SESSION = 'try-session';

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: proj, env, encoding: 'utf8', input: '' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(event, extra) {
  const input = { session_id: SESSION, cwd: proj, hook_event_name: event, ...extra };
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify(input) });
  const text = (r.stdout || '').trim();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
function view() {
  return JSON.parse(cli('status', '--json').out);
}

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
}
function step(title) {
  console.log(`\n--- ${title}`);
}
const oneLine = (s, n = 150) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

try {
  step('1. Record the original goal (what /stopcode:start does)');
  const start = cli('start', 'Fix login validation so empty passwords are rejected', '--criteria', 'auth tests pass', '--criteria', 'empty password returns 400');
  check('mission recorded with 2 completion criteria', start.status === 0 && view().mission.criteria.length === 2);

  step('2. Claude Code starts a session: the SessionStart hook reminds Claude of the goal');
  const ss = hook('SessionStart', { source: 'startup' });
  const ctx = ss.json && ss.json.hookSpecificOutput && ss.json.hookSpecificOutput.additionalContext;
  check('goal injected into Claude\'s context', ss.status === 0 && /empty passwords are rejected/.test(ctx || ''), oneLine(ctx));

  step('3. "While you\'re at it..." - scope creep is noticed, not silently absorbed');
  const creep = hook('UserPromptSubmit', { prompt: 'Also add a dark mode toggle while you are at it' });
  const hint = creep.json && creep.json.hookSpecificOutput && creep.json.hookSpecificOutput.additionalContext;
  check('advisory note for Claude, prompt not blocked', creep.status === 0 && /advisory/.test(hint || '') && !(creep.json && creep.json.decision), oneLine(hint));
  cli('idea', 'add', 'Dark mode toggle');
  check('idea parked for later instead of done tonight', view().ideas.some((i) => /Dark mode/.test(i.text)));

  step('4. Claude runs the tests: results become evidence automatically');
  hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'npm test' }, error: 'ℹ tests 4\nℹ pass 3\nℹ fail 1\n' });
  hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu-2', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ℹ tests 4\nℹ pass 4\nℹ fail 0\n', stderr: '' } });
  const outcomes = view().mission.evidence.map((e) => e.outcome);
  check('failing run recorded as fail, then passing run as pass', outcomes.join(',') === 'fail,pass', `evidence: ${outcomes.join(', ')}`);

  step('5. The shutdown command: handoff, tomorrow\'s list, Claude Code paused until morning');
  const fin = cli('finish', '--until', 'tomorrow', '--protect', '--note', 'Stopping for today');
  check('handoff saved, mission parked, quiet hours started', fin.status === 0 && view().quiet.enforced === true, oneLine(fin.out, 220));
  const handoff = cli('handoff', 'show').out;
  check('handoff has the goal, the evidence, tomorrow\'s next action and the parked idea', /## Original mission/.test(handoff) && /## Completion criteria and evidence/.test(handoff) && /## Next action/.test(handoff) && /Dark mode toggle/.test(handoff));

  step('6. "Just one more thing" at 11 pm: blocked in this project until you choose otherwise');
  const write = hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'tu-3', tool_input: { file_path: path.join(proj, 'late-night.js'), content: '//' } });
  const decision = write.json && write.json.hookSpecificOutput;
  check('new tool call denied by the PreToolUse hook', decision && decision.permissionDecision === 'deny', oneLine(decision && decision.permissionDecisionReason));
  const prompt = hook('UserPromptSubmit', { prompt: 'Quickly refactor the session store' });
  check('new prompt blocked by the UserPromptSubmit hook', prompt.json && prompt.json.decision === 'block');
  const statusCall = hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-4', tool_input: { command: `node "${CLI}" status` } });
  check('StopCode\'s own status command still allowed', statusCall.status === 0 && statusCall.json === null);

  step('7. Next day: resume exactly where you stopped');
  check('resume refuses while quiet hours are active (exit 3)', cli('resume').status === 3);
  const resume = cli('resume', '--override');
  check('explicit override restores the handoff and lifts quiet hours', resume.status === 0 && !view().quiet.enforced, oneLine(resume.out, 220));
} catch (err) {
  failed++;
  console.log(`FAIL  unexpected error: ${err && err.stack ? err.stack : err}`);
} finally {
  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (keep) {
    console.log(`Scratch data kept in ${base}\nSee it in the dashboard: node bin/stopcode.js serve --data-dir "${dataDir}"`);
  } else {
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.exitCode = failed ? 1 : 0;
}
