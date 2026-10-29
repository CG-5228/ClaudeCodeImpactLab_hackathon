'use strict';
// Scope decisions and completion semantics: accepted additions, parked ideas, the
// completion state machine (incomplete -> reported -> verified -> stale -> complete) and
// evidence derived from tool output.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const H = require('./helpers');

const { StopCode, NotFoundError, parseTestOutput, classifyCommand, completionOf, overlaps } = H.core;
const { ValidationError } = H.core.validate;

test('acceptAddition persists, keeps the objective unchanged and suppresses the hint for overlapping prompts', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  sc.startMission({ project: proj, objective: 'Build the login form', criteria: ['Form submits'], detect: false });
  sc.sessionStart({ project: proj, sessionId: 's1', cwd: proj });

  const before = sc.recordPrompt({ sessionId: 's1', promptId: 'p0', prompt: 'Also add the dark mode toggle on the settings page while you are at it', cwd: proj });
  assert.equal(before.scopeHint, 'possible_expansion');

  const added = sc.acceptAddition({ project: proj, text: 'dark mode toggle on the settings page' });
  assert.equal(added.ok, true);
  assert.equal(added.addition.source, 'user');
  const dup = sc.acceptAddition({ project: proj, text: 'Dark Mode Toggle on the Settings Page' });
  assert.equal(dup.duplicate, true, 'case-insensitive duplicates are reported, not stored twice');
  assert.equal(dup.addition.id, added.addition.id);

  const view = new StopCode({ dataDir: s.dataDir }).projectView(proj);
  assert.deepEqual(view.additions.map((a) => a.text), ['dark mode toggle on the settings page']);
  assert.equal(view.mission.objective, 'Build the login form', 'the original objective is immutable');
  assert.equal(view.scopeNotes.at(-1).classification, 'scope_expansion');
  assert.equal(view.scopeNotes.at(-1).decision, 'accepted');

  const overlapping = sc.recordPrompt({ sessionId: 's1', promptId: 'p1', prompt: 'also wire the dark mode toggle into the settings page header', cwd: proj });
  assert.equal(overlapping.scopeHint, null, 'prompts that overlap an accepted addition raise no hint');
  const unrelated = sc.recordPrompt({ sessionId: 's1', promptId: 'p2', prompt: 'also refactor the database connection pooling', cwd: proj });
  assert.equal(unrelated.scopeHint, 'possible_expansion');
  const plain = sc.recordPrompt({ sessionId: 's1', promptId: 'p3', prompt: 'fix the failing form test', cwd: proj });
  assert.equal(plain.scopeHint, null);
  assert.equal(overlaps('dark mode toggle on the settings page', 'also wire the dark mode toggle into the settings page header'), true);
  assert.equal(overlaps('dark mode toggle on the settings page', 'also refactor the database connection pooling'), false);

  const all = H.readEvents(s.dataDir, view.project.id).events;
  assert.deepEqual(all.filter((e) => e.type === 'prompt').map((e) => e.scopeHint), ['possible_expansion', null, 'possible_expansion', null]);
  assert.equal(all.filter((e) => e.type === 'scope_accepted').length, 1);
});

test('parkIdea works without a mission (project level) and with one (mission level) and never starts a mission', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  const first = sc.parkIdea({ project: proj, text: 'Try the new bundler' });
  assert.equal(first.ok, true);
  assert.equal(first.idea.missionId, null);
  assert.equal(first.idea.status, 'parked');
  let view = sc.projectView(proj);
  assert.equal(view.mission, null, 'parking an idea never starts a mission');
  assert.deepEqual(view.ideas.map((i) => i.text), ['Try the new bundler']);

  const { mission } = sc.startMission({ project: proj, objective: 'Fix the flaky test', detect: false });
  const second = sc.parkIdea({ project: proj, text: 'Parallelise the suite' });
  assert.equal(second.idea.missionId, mission.id);
  view = sc.projectView(proj);
  assert.deepEqual(view.ideas.map((i) => i.text).sort(), ['Parallelise the suite', 'Try the new bundler']);
  assert.deepEqual(view.mission.deferredIdeas.map((i) => i.text), ['Parallelise the suite']);

  const updated = sc.updateIdea({ project: proj, ideaId: first.idea.id, status: 'dropped' });
  assert.equal(updated.idea.status, 'dropped');
  assert.throws(() => sc.updateIdea({ project: proj, ideaId: first.idea.id, status: 'done' }), (e) => e instanceof ValidationError && e.field === 'status');
  assert.throws(() => sc.updateIdea({ project: proj, ideaId: 'idea_missing', status: 'parked' }), NotFoundError);
  assert.throws(() => sc.parkIdea({ project: proj, text: '' }), (e) => e instanceof ValidationError && e.field === 'text');

  const again = new StopCode({ dataDir: s.dataDir }).projectView(proj);
  assert.equal(again.ideas.find((i) => i.id === first.idea.id).status, 'dropped');
  assert.equal(again.ideas.find((i) => i.id === second.idea.id).status, 'parked');
  assert.equal(H.readEvents(s.dataDir, again.project.id).events.filter((e) => e.type === 'idea_parked').length, 2);
});

test('completion moves incomplete -> reported -> verified -> stale -> complete, and only evidence verifies', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const clock = H.makeClock('2026-03-04T10:00:00Z');
  const sc = new StopCode({ dataDir: s.dataDir, now: clock.now });
  sc.startMission({ project: proj, objective: 'Make the suite green', criteria: ['Tests pass', 'Docs updated'], detect: false });
  const mission = () => sc.projectView(proj).mission;
  const completion = () => mission().completion;

  let c = completion();
  assert.equal(c.state, 'incomplete');
  assert.equal(c.headline, 'In progress (0 of 2 verified)');
  assert.equal(mission().nextStep, 'Start: Tests pass');

  // User confirmation is labelled separately and never counts as verification.
  const confirmed = sc.confirmCriterion({ project: proj, criterion: '1', note: 'looked fine locally' });
  assert.equal(confirmed.criterion.status, 'reported_complete');
  assert.deepEqual(confirmed.criterion.userConfirmation, { at: clock.iso, note: 'looked fine locally' });
  assert.equal(completion().state, 'incomplete', 'one reported + one not started is still incomplete');
  sc.confirmCriterion({ project: proj, criterion: 'Docs updated' });
  c = completion();
  assert.equal(c.state, 'reported');
  assert.equal(c.headline, 'Verification pending');
  assert.equal(c.reportedCount, 2);
  assert.equal(c.verifiedCount, 0);
  assert.equal(mission().nextStep, 'Verify: Tests pass');

  assert.throws(() => sc.setCriterionStatus({ project: proj, criterion: '1', status: 'verified' }), (e) => e instanceof ValidationError && e.field === 'status');
  assert.equal(mission().criteria[0].status, 'reported_complete', 'the rejected transition changed nothing');

  clock.tick(5);
  const ev1 = sc.addEvidence({ project: proj, kind: 'test_run', outcome: 'pass', summary: 'node --test: 12 passed', criterion: '1' });
  assert.equal(ev1.criterion.status, 'verified');
  assert.deepEqual(ev1.evidence.criterionIds, [ev1.criterion.id]);
  c = completion();
  assert.equal(c.state, 'reported');
  assert.equal(c.verifiedCount, 1);
  const ev2 = sc.addEvidence({ project: proj, kind: 'manual_check', outcome: 'pass', summary: 'README reviewed', criterion: '2' });
  assert.equal(ev2.criterion.status, 'verified');
  c = completion();
  assert.equal(c.state, 'complete');
  assert.equal(c.headline, 'Your original goal is complete');
  assert.equal(sc.projectView(proj).recommendation.title, 'Your original goal is complete');

  // An edit after the passing checks makes the evidence stale: no longer complete.
  clock.tick(5);
  sc.recordToolEvent({ toolUseId: 'edit-1', toolName: 'Edit', toolInput: { file_path: path.join(proj, 'src', 'index.js') }, ok: true, cwd: proj });
  c = completion();
  assert.equal(c.state, 'reported');
  assert.equal(c.headline, 'Verification pending (stale evidence)');
  assert.ok(mission().criteria.every((x) => x.status === 'verified' && x.stale === true));
  assert.equal(mission().nextStep, 'Verify: Tests pass');
  assert.notEqual(sc.projectView(proj).recommendation.title, 'Your original goal is complete');

  // Failing evidence demotes a verified criterion; fresh passing evidence restores completion.
  clock.tick(5);
  const failing = sc.addEvidence({ project: proj, kind: 'test_run', outcome: 'fail', summary: 'node --test: 1 failed', criterion: '1' });
  assert.equal(failing.criterion.status, 'in_progress');
  assert.equal(completion().state, 'incomplete');
  clock.tick(5);
  sc.addEvidence({ project: proj, kind: 'test_run', outcome: 'pass', summary: 'node --test: 13 passed', criterion: '1' });
  sc.addEvidence({ project: proj, kind: 'manual_check', outcome: 'pass', summary: 'README re-checked', criterion: '2' });
  c = completion();
  assert.equal(c.state, 'complete');
  assert.ok(mission().criteria.every((x) => x.stale === false));

  // Blocked criteria surface as blocked.
  sc.addCriterion({ project: proj, text: 'Deploy preview works' });
  sc.setCriterionStatus({ project: proj, criterion: '3', status: 'blocked', note: 'waiting on credentials' });
  c = completion();
  assert.equal(c.state, 'blocked');
  assert.equal(c.headline, 'Blocked on 1 criterion (2 of 3 verified)');
  assert.equal(mission().nextStep, 'Unblock: Deploy preview works');
  assert.equal(completionOf(null).state, 'no_criteria');
  assert.equal(completionOf({ criteria: [] }).headline, 'No completion criteria recorded');
});

test('parseTestOutput recognises node:test, jest, pytest, go and cargo summaries', () => {
  const cases = [
    ['node --test pass', '# tests 7\n# suites 0\n# pass 7\n# fail 0\n# cancelled 0', 'pass', 7, 0],
    ['node --test fail', '# tests 7\n# pass 5\n# fail 2', 'fail', 5, 2],
    ['jest pass', 'Tests:       7 passed, 7 total\nSnapshots:   0 total\nTime:        1.2 s', 'pass', 7, null],
    ['jest fail', 'Tests:       2 failed, 5 passed, 7 total', 'fail', 5, 2],
    ['pytest pass', '=========== 5 passed in 0.12s ===========', 'pass', 5, null],
    ['pytest fail', '====== 1 failed, 4 passed in 0.30s ======', 'fail', 4, 1],
    ['go pass', 'ok  \tgithub.com/acme/pkg\t0.015s', 'pass', 1, null],
    ['go fail', '--- FAIL: TestThing (0.00s)\n    thing_test.go:12: boom\nFAIL\nFAIL\tgithub.com/acme/pkg\t0.020s', 'fail', null, 1],
    ['cargo pass', 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out', 'pass', 3, 0],
    ['cargo fail', 'test result: FAILED. 1 passed; 2 failed; 0 ignored', 'fail', 1, 2],
    ['unparsed build output', 'Compiled successfully in 1.2s', 'unknown', null, null],
    ['empty output', '', 'unknown', null, null],
  ];
  for (const [name, text, outcome, passed, failed] of cases) {
    const r = parseTestOutput(text);
    assert.equal(r.outcome, outcome, `${name}: outcome`);
    assert.equal(r.passed, passed, `${name}: passed`);
    assert.equal(r.failed, failed, `${name}: failed`);
    if (outcome === 'unknown') assert.equal(r.summary, 'result not parsed from output');
    else assert.match(r.summary, /parsed from output/);
  }
  assert.equal(classifyCommand('npm test'), 'test_run');
  assert.equal(classifyCommand('npx jest --ci'), 'test_run');
  assert.equal(classifyCommand('go test ./...'), 'test_run');
  assert.equal(classifyCommand('cargo build --release'), 'build');
  assert.equal(classifyCommand('git status'), null);
});

test('tool failures yield fail evidence; unparsed successful test commands yield unknown, never pass', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  sc.startMission({ project: proj, objective: 'Evidence from hooks', criteria: ['Suite green'], detect: false });

  const failed = sc.recordToolEvent({ toolUseId: 'f1', toolName: 'Bash', toolInput: { command: 'npm test' }, ok: false, error: 'Command failed with exit code 1', cwd: proj });
  assert.equal(failed.evidence.outcome, 'fail');
  assert.equal(failed.evidence.kind, 'test_run');
  assert.equal(failed.evidence.source, 'hook:PostToolUseFailure');
  assert.match(failed.evidence.summary, /command failed/);

  const vague = sc.recordToolEvent({ toolUseId: 'u1', toolName: 'Bash', toolInput: { command: 'npm test' }, toolResponse: { stdout: 'done\n', stderr: '' }, ok: true, cwd: proj });
  assert.equal(vague.evidence.outcome, 'unknown');
  assert.match(vague.evidence.summary, /result not parsed/);

  const passing = sc.recordToolEvent({ toolUseId: 'p1', toolName: 'Bash', toolInput: { command: 'npx jest --ci' }, toolResponse: { stdout: 'Tests:       4 passed, 4 total', stderr: '' }, ok: true, cwd: proj });
  assert.equal(passing.evidence.outcome, 'pass');
  assert.equal(passing.evidence.source, 'hook:PostToolUse');

  const build = sc.recordToolEvent({ toolUseId: 'b1', toolName: 'Bash', toolInput: { command: 'npm run build' }, toolResponse: { stdout: 'built', stderr: '' }, ok: true, cwd: proj });
  assert.equal(build.evidence.kind, 'build');
  assert.equal(build.evidence.outcome, 'unknown');

  const plain = sc.recordToolEvent({ toolUseId: 'n1', toolName: 'Bash', toolInput: { command: 'git status' }, toolResponse: { stdout: 'clean' }, ok: true, cwd: proj });
  assert.equal(plain.evidence, null, 'commands that are neither tests nor builds produce no evidence');

  let view = sc.projectView(proj);
  assert.equal(view.mission.evidence.length, 4);
  assert.ok(view.mission.evidence.every((e) => e.criterionIds.length === 0), 'hook evidence is never attached to a criterion on its own');
  assert.equal(view.mission.completion.state, 'incomplete');
  assert.equal(view.mission.unattachedEvidence.length, 4);

  const attached = sc.attachEvidence({ project: proj, criterion: '1', evidenceId: passing.evidence.id });
  assert.equal(attached.criterion.status, 'verified');
  assert.equal(sc.projectView(proj).mission.completion.state, 'complete');

  const dup = sc.recordToolEvent({ toolUseId: 'p1', toolName: 'Bash', toolInput: { command: 'npx jest --ci' }, toolResponse: { stdout: 'Tests: 4 passed, 4 total' }, ok: true, cwd: proj });
  assert.equal(dup.duplicate, true);
  view = sc.projectView(proj);
  assert.equal(view.mission.evidence.length, 4, 'a replayed tool_use_id adds no evidence');
});

test('starting a new mission preserves the previous one as archived history', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  const first = sc.startMission({ project: proj, objective: 'First goal', criteria: ['A'], detect: false });
  const second = sc.startMission({ project: proj, objective: 'Second goal', detect: false });
  assert.deepEqual(second.previousMission, { id: first.mission.id, objective: 'First goal', status: 'archived' });
  const view = sc.projectView(proj);
  assert.equal(view.mission.objective, 'Second goal');
  assert.equal(view.previousMissions.length, 1);
  assert.equal(view.previousMissions[0].status, 'archived');
  assert.equal(view.previousMissions[0].objective, 'First goal');
  assert.throws(() => sc.startMission({ project: proj, objective: 'x'.repeat(601), detect: false }), (e) => e instanceof ValidationError && e.field === 'objective');
  assert.throws(() => sc.startMission({ project: proj, objective: 'ok', criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], detect: false }), (e) => e instanceof ValidationError && e.field === 'criteria');
});
