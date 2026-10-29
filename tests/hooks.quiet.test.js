'use strict';
// The real hook script under protected quiet hours, spawned the way Claude Code spawns it,
// plus the evidence path for Node's default test reporter and symlinked project paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const { parseTestOutput, buildIcs, lintIcs, STOPCODE_CLI_ALLOW } = H.core;

function quietProject(t) {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const opts = { dataDir: s.dataDir, cwd: proj };
  assert.equal(H.runCli(['start', 'Fix login validation', '--criteria', 'auth tests pass'], opts).status, 0);
  const fin = H.runCli(['finish', '--quiet', '30m', '--protect', '--note', 'stopping'], opts);
  assert.equal(fin.status, 0, fin.stderr);
  return { s, proj, opts };
}

test('PreToolUse denies new tool calls during protected quiet hours and allows bare StopCode CLI calls', (t) => {
  const { s, proj } = quietProject(t);
  const run = (tool, toolInput, id) => H.runHook('PreToolUse', H.hookInput('PreToolUse', proj, 'sess-1', { tool_name: tool, tool_input: toolInput, tool_use_id: id }), { dataDir: s.dataDir, cwd: proj });

  const write = run('Write', { file_path: path.join(proj, 'blocked.txt'), content: 'x' }, 't1');
  H.expectHookContract(write, 'Write');
  assert.equal(write.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(write.json.hookSpecificOutput.permissionDecisionReason, /quiet hours/i);

  const status = run('Bash', { command: `node "${H.CLI}" status` }, 't2');
  H.expectHookContract(status, 'status');
  assert.equal(status.stdout.trim(), '', 'allow-listed StopCode command produces no decision');

  const chained = run('Bash', { command: `node "${H.CLI}" status && rm -rf src` }, 't3');
  assert.equal(chained.json.hookSpecificOutput.permissionDecision, 'deny', 'shell chaining is never allow-listed');
});

test('the CLI allowlist rejects chaining, substitution, redirection and newlines', () => {
  for (const ok of ['stopcode status', 'node "/a b/bin/stopcode.js" resume --override', 'stopcode quiet status 2>&1', 'stopcode status; echo "exit=$?"']) {
    assert.ok(STOPCODE_CLI_ALLOW.test(ok), `should allow: ${ok}`);
  }
  for (const bad of ['stopcode status && ls', 'stopcode status; ls', 'stopcode status | cat', 'stopcode status > x', 'stopcode status $(id)', 'stopcode status\nls', 'cd /x && stopcode status', 'FOO=1 stopcode status', 'stopcode start x']) {
    assert.ok(!STOPCODE_CLI_ALLOW.test(bad), `should deny: ${JSON.stringify(bad)}`);
  }
});

test('UserPromptSubmit blocks new prompts during protected quiet hours except /stopcode commands', (t) => {
  const { s, proj } = quietProject(t);
  const run = (prompt) => H.runHook('UserPromptSubmit', H.hookInput('UserPromptSubmit', proj, 'sess-1', { prompt }), { dataDir: s.dataDir, cwd: proj });
  const blocked = run('add a password strength meter');
  H.expectHookContract(blocked, 'prompt');
  assert.equal(blocked.json.decision, 'block');
  const resume = run('/stopcode:resume');
  H.expectHookContract(resume, 'resume');
  assert.notEqual(resume.json && resume.json.decision, 'block');
});

test('resume exits 3 during quiet hours and succeeds with --override', (t) => {
  const { opts } = quietProject(t);
  assert.equal(H.runCli(['resume'], opts).status, 3);
  const over = H.runCli(['resume', '--override'], opts);
  assert.equal(over.status, 0, over.stderr);
  assert.equal(H.runCli(['resume'], opts).status, 0, 'quiet hours lifted by the override');
});

test('hooks fail open: malformed stdin and unrelated directories produce no decision', (t) => {
  const s = H.mkScratch(t);
  const other = s.project('unrelated');
  const bad = H.runHook('PreToolUse', '{not json', { dataDir: s.dataDir, cwd: other });
  H.expectHookContract(bad, 'malformed');
  assert.equal(bad.stdout.trim(), '');
  const stop = H.runHook('Stop', H.hookInput('Stop', other, 'x'), { dataDir: s.dataDir, cwd: other });
  H.expectHookContract(stop, 'Stop');
  assert.equal(stop.stdout.trim(), '');
});

test('parseTestOutput recognises Node spec reporter, TAP, jest and cargo summaries', () => {
  assert.equal(parseTestOutput('ℹ tests 4\nℹ suites 0\nℹ pass 4\nℹ fail 0\n').outcome, 'pass');
  const nodeFail = parseTestOutput('ℹ tests 4\nℹ pass 3\nℹ fail 1\n');
  assert.equal(nodeFail.outcome, 'fail');
  assert.equal(nodeFail.passed, 3);
  assert.equal(parseTestOutput('# tests 2\n# pass 2\n# fail 0\n').outcome, 'pass');
  assert.equal(parseTestOutput('Tests: 1 failed, 3 passed, 4 total').outcome, 'fail');
  assert.equal(parseTestOutput('test result: ok. 5 passed; 0 failed; 0 ignored').outcome, 'pass');
  assert.equal(parseTestOutput('compiled successfully').outcome, 'unknown', 'unrecognised output is never a pass');
});

test('PostToolUse records a passing `node --test` run as pass evidence', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const opts = { dataDir: s.dataDir, cwd: proj };
  H.runCli(['start', 'Fix login validation', '--criteria', 'auth tests pass'], opts);
  H.runHook('SessionStart', H.hookInput('SessionStart', proj, 'sess-2', { source: 'startup' }), opts);
  const res = H.runHook('PostToolUse', H.hookInput('PostToolUse', proj, 'sess-2', {
    tool_name: 'Bash',
    tool_use_id: 'tu-1',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: '✔ rejects empty password\nℹ tests 4\nℹ pass 4\nℹ fail 0\n', stderr: '', interrupted: false },
  }), opts);
  H.expectHookContract(res, 'PostToolUse');
  const view = H.runCli(['status', '--json'], opts).json;
  const evidence = view.mission.evidence;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, 'pass');
});

test('a project registered through a symlinked path is found through either path', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, (t) => {
  const s = H.mkScratch(t);
  const real = s.project('real project');
  const link = path.join(s.dir, 'linked project');
  fs.symlinkSync(real, link, 'dir');
  assert.equal(H.runCli(['start', 'Symlink goal', '--criteria', 'works', '--project', link], { dataDir: s.dataDir, cwd: s.dir }).status, 0);
  for (const ref of [link, real]) {
    const st = H.runCli(['status', '--project', ref], { dataDir: s.dataDir, cwd: s.dir });
    assert.equal(st.status, 0, `status via ${ref}: ${st.stderr}`);
    assert.match(st.stdout, /Symlink goal/);
  }
  assert.equal(Object.keys(H.readState(s.dataDir).projects).length, 1);
});

test('ICS export passes the structural linter with long, escaped text', () => {
  const ics = buildIcs([
    { id: 'evt_1', title: 'Recovery; walk, then dinner\\ with a very long title that must be folded at seventy-five octets', type: 'recovery', start: '2026-10-29T17:30:00.000Z', end: '2026-10-29T18:30:00.000Z', sequence: 2, notes: 'line one\nline two' },
    { id: 'evt_2', title: 'Work', type: 'work', start: '2026-10-30T09:00:00.000Z', end: '2026-10-30T17:30:00.000Z', sequence: 0 },
  ], { timezone: 'Europe/Dublin', now: '2026-10-29T12:00:00.000Z' });
  assert.deepEqual(lintIcs(ics), []);
  assert.match(ics, /SUMMARY:Recovery\\; walk\\, then dinner\\\\/);
});

test('time reminders (3 h / after hours) are opt-in; scope hints stay on by default', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const opts = { dataDir: s.dataDir, cwd: proj };
  const sc = new H.core.StopCode({ dataDir: s.dataDir });
  sc.startMission({ project: proj, objective: 'Fix login validation', criteria: ['auth tests pass'], detect: false });
  sc.updateSettings({ workingHours: H.noWorkingHours(), advice: { minIntervalMinutes: 5 } });
  assert.equal(H.readState(s.dataDir).settings.advice.timeNudges, false, 'off by default');
  const prompt = (id, text) => {
    const r = H.runHook('UserPromptSubmit', H.hookInput('UserPromptSubmit', proj, 'sess-t', { prompt: text, prompt_id: id }), opts);
    H.expectHookContract(r, id);
    return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  };

  assert.equal(prompt('p1', 'fix the failing test'), '', 'outside working hours, but no reminder by default');
  const scope = prompt('p2', 'also add dark mode while you are at it');
  assert.match(scope, /not blocking/, 'scope hint is on by default');
  assert.doesNotMatch(scope, /working hours/);

  sc.updateSettings({ advice: { timeNudges: true, minIntervalMinutes: 5 } });
  const st = H.readState(s.dataDir);
  st.projects[Object.keys(st.projects)[0]].advice.lastAt = null;
  require('fs').writeFileSync(require('path').join(s.dataDir, 'state.json'), JSON.stringify(st));
  assert.match(prompt('p3', 'fix the failing test'), /outside the working hours/, 'reminder appears once enabled');

  sc.updateSettings({ advice: { enabled: true, minIntervalMinutes: 30 } });
  assert.equal(H.readState(s.dataDir).settings.advice.timeNudges, true, 'saving other advice fields keeps the choice');
});

test('time protected counts quiet hours in force over the last 7 days, kept vs overridden', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const clock = H.makeClock('2026-10-20T18:00:00Z');
  const sc = new H.core.StopCode({ dataDir: s.dataDir, now: clock.now });
  sc.startMission({ project: proj, objective: 'Fix login validation', criteria: ['auth tests pass'], detect: false });
  assert.equal(sc.projectView(proj).protectedTime.label, 'none in the last 7 days');

  sc.startQuiet({ project: proj, minutes: 120, protect: true });   // kept: full 2 h
  clock.tick(180);
  sc.startQuiet({ project: proj, minutes: 600, protect: true });   // overridden after 1 h
  clock.tick(60);
  sc.overrideQuiet({ project: proj });
  let pt = sc.projectView(proj).protectedTime;
  assert.deepEqual([pt.ms, pt.kept, pt.overridden], [3 * 3600000, 1, 1]);

  clock.tick(8 * 24 * 60);                                           // both fall out of the window
  pt = sc.projectView(proj).protectedTime;
  assert.deepEqual([pt.ms, pt.kept, pt.overridden], [0, 0, 0]);
});
