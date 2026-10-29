'use strict';
// Project isolation: sibling projects never share data, the longest registered root wins,
// and directories outside every project stay untracked (core and hooks alike).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const { StopCode, NotFoundError } = H.core;

test('two sibling projects (git and non-git) keep events, missions, quiet hours and handoffs apart', (t) => {
  const s = H.mkScratch(t);
  const alphaDir = s.gitProject('alpha repo');
  const betaDir = s.project('beta plain');
  const sc = new StopCode({ dataDir: s.dataDir });
  const alpha = sc.startMission({ project: alphaDir, objective: 'Alpha goal', criteria: ['Alpha passes'] }).project;
  const beta = sc.startMission({ project: betaDir, objective: 'Beta goal', criteria: ['Beta passes'] }).project;
  assert.notEqual(alpha.id, beta.id);
  assert.equal(alpha.git, true, 'git detection sees the scratch repository');
  assert.equal(beta.git, false, 'the plain directory is not inside a repository');
  assert.equal(path.resolve(alpha.root), path.resolve(alphaDir));
  assert.equal(path.resolve(beta.root), path.resolve(betaDir));

  sc.sessionStart({ project: alphaDir, sessionId: 'alpha-s', cwd: alphaDir });
  sc.sessionStart({ project: betaDir, sessionId: 'beta-s', cwd: betaDir });
  sc.recordToolEvent({ sessionId: 'alpha-s', toolUseId: 'a1', toolName: 'Edit', toolInput: { file_path: path.join(alphaDir, 'a.js') }, ok: true, cwd: alphaDir });
  sc.recordToolEvent({ sessionId: 'beta-s', toolUseId: 'b1', toolName: 'Bash', toolInput: { command: 'npm test' }, toolResponse: { stdout: '# pass 3\n# fail 0', stderr: '' }, ok: true, cwd: betaDir });
  sc.recordPrompt({ sessionId: 'alpha-s', promptId: 'p1', prompt: 'alpha prompt', cwd: alphaDir });
  sc.parkIdea({ project: alphaDir, text: 'Alpha idea' });
  sc.parkIdea({ project: betaDir, text: 'Beta idea' });
  sc.acceptAddition({ project: betaDir, text: 'Beta addition' });
  sc.startQuiet({ project: alphaDir, minutes: 60, protect: true });
  const handoff = sc.saveHandoff({ project: betaDir, note: 'beta only' });

  const a = sc.projectView(alphaDir);
  const b = sc.projectView(betaDir);
  assert.equal(a.mission.objective, 'Alpha goal');
  assert.equal(b.mission.objective, 'Beta goal');
  assert.deepEqual(a.ideas.map((i) => i.text), ['Alpha idea']);
  assert.deepEqual(b.ideas.map((i) => i.text), ['Beta idea']);
  assert.deepEqual(a.additions, []);
  assert.deepEqual(b.additions.map((x) => x.text), ['Beta addition']);
  assert.equal(a.quiet.active, true);
  assert.equal(b.quiet.active, false);
  assert.equal(a.handoffCount, 0);
  assert.equal(b.handoffCount, 1);
  assert.equal(b.handoff.id, handoff.handoff.id);
  assert.equal(a.mission.evidence.length, 0);
  assert.equal(b.mission.evidence.length, 1, 'the npm test run belongs to beta only');
  assert.equal(a.session.id, 'alpha-s');
  assert.equal(b.session.id, 'beta-s');
  assert.deepEqual(a.session.files, ['a.js']);
  assert.deepEqual(b.session.files, []);
  assert.equal(a.activity.promptsToday, 1);
  assert.equal(b.activity.promptsToday, 0);

  const ea = H.readEvents(s.dataDir, alpha.id).events;
  const eb = H.readEvents(s.dataDir, beta.id).events;
  assert.ok(ea.some((e) => e.id === 'tool:a1') && !ea.some((e) => e.id === 'tool:b1'));
  assert.ok(eb.some((e) => e.id === 'tool:b1') && !eb.some((e) => e.id === 'tool:a1'));
  assert.ok(ea.some((e) => e.type === 'quiet_start') && !eb.some((e) => e.type === 'quiet_start'));
  assert.ok(eb.some((e) => e.type === 'handoff_saved') && !ea.some((e) => e.type === 'handoff_saved'));
  assert.ok(handoff.handoff.path.startsWith(path.join(s.dataDir, 'handoffs', beta.id)), 'handoff files live under the owning project');
  assert.equal(sc.listHandoffs({ project: alphaDir }).length, 0);
  assert.equal(sc.listHandoffs({ project: betaDir }).length, 1);

  // Deleting one project leaves the other untouched.
  sc.deleteProject(alpha.id);
  assert.equal(sc.projectView(alphaDir), null);
  assert.equal(sc.projectView(betaDir).mission.objective, 'Beta goal');
  assert.ok(!fs.existsSync(H.eventsFile(s.dataDir, alpha.id)));
  assert.ok(fs.existsSync(H.eventsFile(s.dataDir, beta.id)));
  assert.ok(fs.existsSync(handoff.handoff.path));
});

test('findProject picks the longest matching registered root', (t) => {
  const s = H.mkScratch(t);
  const outer = s.project('outer');
  const inner = path.join(outer, 'packages', 'inner app');
  const deeper = path.join(inner, 'src', 'lib');
  fs.mkdirSync(deeper, { recursive: true });
  const sc = new StopCode({ dataDir: s.dataDir });
  // Register the nested project first; registering the outer one afterwards must not absorb it.
  const innerP = sc.startMission({ project: inner, objective: 'Inner', detect: false }).project;
  const outerP = sc.startMission({ project: outer, objective: 'Outer', detect: false }).project;
  assert.notEqual(innerP.id, outerP.id);
  assert.equal(sc.resolveProject(deeper).id, innerP.id);
  assert.equal(sc.resolveProject(inner).id, innerP.id);
  assert.equal(sc.resolveProject(path.join(outer, 'packages')).id, outerP.id);
  assert.equal(sc.resolveProject(outer).id, outerP.id);
  // by id, with a trailing separator, and case-insensitively on Windows
  assert.equal(sc.resolveProject(innerP.id).id, innerP.id);
  assert.equal(sc.resolveProject(inner + path.sep).id, innerP.id);
  if (process.platform === 'win32') assert.equal(sc.resolveProject(inner.toUpperCase()).id, innerP.id);
  // a sibling that merely shares a name prefix is not "inside"
  const sibling = s.project('outer2');
  assert.equal(sc.resolveProject(sibling), null);
  // events from the deeper cwd land in the inner project only
  sc.recordToolEvent({ toolUseId: 'deep', toolName: 'Bash', toolInput: { command: 'ls' }, ok: true, cwd: deeper });
  assert.ok(H.readEvents(s.dataDir, innerP.id).events.some((e) => e.id === 'tool:deep'));
  assert.ok(!H.readEvents(s.dataDir, outerP.id).events.some((e) => e.id === 'tool:deep'));
  assert.equal(H.core.projects.findProject(sc.readState(), deeper).id, innerP.id);
  assert.equal(sc.projectView(deeper).mission.objective, 'Inner');
});

test('a directory outside every project stays untracked: core returns tracked:false and hooks print nothing', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const outside = s.project('elsewhere');
  const sc = new StopCode({ dataDir: s.dataDir });
  sc.startMission({ project: proj, objective: 'Tracked', detect: false });
  assert.equal(sc.resolveProject(outside), null);
  assert.equal(sc.projectView(outside), null);
  assert.deepEqual(sc.sessionStart({ sessionId: 'x', cwd: outside }), { tracked: false, reason: 'no StopCode project for this directory' });
  assert.deepEqual(sc.recordToolEvent({ toolUseId: 't', toolName: 'Bash', toolInput: { command: 'ls' }, cwd: outside }), { tracked: false });
  assert.deepEqual(sc.recordPrompt({ prompt: 'hi', cwd: outside }), { tracked: false });
  assert.equal(sc.quietStatus({ project: outside }).tracked, false);
  assert.throws(() => sc.startQuiet({ project: outside, minutes: 10 }), NotFoundError);
  assert.throws(() => sc.saveHandoff({ project: outside }), NotFoundError);
  assert.throws(() => sc.clockOut({ project: outside }), NotFoundError);

  for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']) {
    const input = H.hookInput(ev, outside, 'sess-outside', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' }, prompt: 'hello' });
    const res = H.runHook(ev, input, { dataDir: s.dataDir, cwd: outside });
    H.expectHookContract(res, ev);
    assert.equal(res.stdout, '', `${ev} printed output for an untracked directory`);
  }
  const state = H.readState(s.dataDir);
  assert.equal(Object.keys(state.projects).length, 1, 'hooks never register projects on their own');
  assert.deepEqual(state.sessions, {});
});
