'use strict';
// Persistence + concurrency: atomic writes, backup recovery, cross-process locking,
// duplicate suppression, tolerant event reading, restart visibility.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./helpers');

const { StopCode } = H.core;

test('corrupt state.json is recovered from the .bak copy and recorded in health', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  sc.startMission({ project: proj, objective: 'Ship the recovery test', criteria: ['Tests pass'], detect: false });
  sc.setNextAction({ project: proj, text: 'Second write so a backup exists' });

  const statePath = path.join(s.dataDir, 'state.json');
  assert.ok(fs.existsSync(`${statePath}.bak`), 'a .bak copy exists after the second write');
  const garbage = '{"version":1,"projects":{"proj_x":{"root":"C:/nope"';
  fs.writeFileSync(statePath, garbage); // simulated interrupted write: truncated JSON

  const sc2 = new StopCode({ dataDir: s.dataDir });
  const state = sc2.readState();
  assert.equal(Object.keys(state.projects).length, 1, 'the project survived through the backup');
  const mission = Object.values(state.missions)[0];
  assert.equal(mission.objective, 'Ship the recovery test');
  // The backup is the previous good copy, so the very last write is the one that is lost.
  assert.equal(mission.nextAction, null);

  const health = sc2.store.readHealth();
  assert.equal(health.storage.lastRecovery.from, 'backup');
  assert.ok(health.storage.lastRecovery.at);
  const preserved = health.storage.lastRecovery.preservedCopy;
  assert.ok(fs.existsSync(preserved), 'the corrupt copy is preserved for inspection');
  assert.equal(fs.readFileSync(preserved, 'utf8'), garbage);
  assert.match(path.basename(preserved), /^state\.json\.corrupt-/);

  // The recovered state was written back and is valid JSON again; views keep working.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(statePath, 'utf8')));
  const view = sc2.projectView(proj);
  assert.equal(view.mission.objective, 'Ship the recovery test');
  assert.equal(view.integration.storage.lastRecovery.from, 'backup');
  const d = H.core.doctor(sc2, { projectRef: proj, checkClaude: false });
  assert.equal(d.storage.lastRecovery.from, 'backup');
  assert.equal(d.storage.stateReadable, true);
});

test('corrupt state.json with no backup falls back to a fresh state and says so', (t) => {
  const s = H.mkScratch(t);
  fs.mkdirSync(s.dataDir, { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'state.json'), 'not json at all');
  const sc = new StopCode({ dataDir: s.dataDir });
  const state = sc.readState();
  assert.deepEqual(state.projects, {});
  assert.equal(sc.store.readHealth().storage.lastRecovery.from, 'fresh');
});

test('6 concurrent tool-event writers and 2 break togglers lose nothing', { timeout: 60000 }, async (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  const started = sc.startMission({ project: proj, objective: 'Concurrency', criteria: ['No lost events'], detect: false });
  const projectId = started.project.id;
  const TOOL_WORKERS = 6;
  const PER_WORKER = 30;
  const BREAK_WORKERS = 2;
  const BREAK_PAIRS = 10;
  for (let i = 0; i < TOOL_WORKERS; i++) sc.sessionStart({ project: proj, sessionId: `sess-${i}`, cwd: proj });

  const runWorker = (mode, id, count) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [H.WORKER, s.dataDir, proj, mode, String(id), String(count)], { env: H.childEnv(s.dataDir), windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => {
        let parsed = null;
        try {
          parsed = JSON.parse(out);
        } catch (e) {
          parsed = { ok: false, error: `unparseable worker output: ${out} ${err}` };
        }
        resolve({ code, ...parsed, stderr: err });
      });
    });

  const jobs = [];
  for (let i = 0; i < TOOL_WORKERS; i++) jobs.push(runWorker('tools', i, PER_WORKER));
  for (let i = 0; i < BREAK_WORKERS; i++) jobs.push(runWorker('breaks', 100 + i, BREAK_PAIRS));
  const t0 = Date.now();
  const results = await Promise.all(jobs);
  t.diagnostic(`8 workers finished in ${Date.now() - t0} ms; lock timeouts: ${results.map((r) => r.lockTimeouts).join(',')}`);
  for (const r of results) assert.equal(r.ok, true, `worker ${r.workerId} failed: ${r.error} ${r.stderr}`);
  for (const r of results) assert.equal(r.code, 0);

  // Every tool event is present exactly once (distinct tool_use_id) and nothing was skipped.
  const { events, skipped } = H.readEvents(s.dataDir, projectId);
  assert.equal(skipped, 0, 'no malformed lines were produced under contention');
  const toolIds = new Set(events.filter((e) => e.type === 'tool').map((e) => e.id));
  assert.equal(toolIds.size, TOOL_WORKERS * PER_WORKER);
  for (let w = 0; w < TOOL_WORKERS; w++) for (let i = 0; i < PER_WORKER; i++) assert.ok(toolIds.has(`tool:w${w}-${i}`), `missing tool:w${w}-${i}`);
  assert.ok(events.some((e) => e.type === 'break_start') && events.some((e) => e.type === 'break_end'));

  // state.json is valid and no read-modify-write update was lost.
  const state = H.readState(s.dataDir);
  assert.equal(state.projects[projectId].counters.toolEvents, TOOL_WORKERS * PER_WORKER);
  for (let w = 0; w < TOOL_WORKERS; w++) {
    assert.equal(state.sessions[`sess-${w}`].counters.tools, PER_WORKER, `session sess-${w} counter`);
    assert.equal(state.sessions[`sess-${w}`].counters.edits, PER_WORKER / 3);
  }
  assert.ok(state.breaks.length >= 1 && state.breaks.length <= BREAK_WORKERS * BREAK_PAIRS);
  assert.ok(state.breaks.every((b) => b.endedAt), 'every break was closed');
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'lock')), 'the lock directory is released');

  // A fresh instance (restart) sees the same state.
  const again = new StopCode({ dataDir: s.dataDir }).projectView(proj);
  assert.equal(again.project.counters.toolEvents, TOOL_WORKERS * PER_WORKER);
  assert.equal(again.activity.skippedMalformed, 0);
  assert.equal(again.breaks.recorded, state.breaks.length);
});

test('duplicate tool events with the same tool_use_id are recorded once', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  const { project } = sc.startMission({ project: proj, objective: 'Dedupe', detect: false });
  sc.sessionStart({ project: proj, sessionId: 's1', cwd: proj });
  const args = { sessionId: 's1', toolUseId: 'toolu_01', toolName: 'Edit', toolInput: { file_path: path.join(proj, 'a.js') }, ok: true, cwd: proj };
  const first = sc.recordToolEvent(args);
  const second = sc.recordToolEvent(args);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const state = H.readState(s.dataDir);
  assert.equal(state.projects[project.id].counters.toolEvents, 1);
  assert.equal(state.sessions.s1.counters.tools, 1);
  const { events } = H.readEvents(s.dataDir, project.id);
  assert.equal(events.filter((e) => e.type === 'tool').length, 1);
});

test('malformed event lines are skipped, reported, and do not break projectView', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  const { project } = sc.startMission({ project: proj, objective: 'Tolerant reader', detect: false });
  sc.recordToolEvent({ toolUseId: 'ok-1', toolName: 'Bash', toolInput: { command: 'ls' }, ok: true, cwd: proj });
  const file = H.eventsFile(s.dataDir, project.id);
  fs.appendFileSync(file, 'not json\n{"type":"tool"}\n{"at":"2026-01-01T00:00:00.000Z"}\n{"type":"tool","at":"x"\n');
  sc.recordToolEvent({ toolUseId: 'ok-2', toolName: 'Bash', toolInput: { command: 'pwd' }, ok: true, cwd: proj });

  const { events, skipped } = H.readEvents(s.dataDir, project.id);
  assert.equal(skipped, 4);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.id), ['tool:ok-1', 'tool:ok-2']);
  const view = sc.projectView(proj);
  assert.equal(view.activity.skippedMalformed, 4);
  assert.equal(view.activity.toolEventsToday, 2);
  assert.ok(Array.isArray(view.timeline));
});

test('a truncated trailing line (interrupted append) does not swallow the next event', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const sc = new StopCode({ dataDir: s.dataDir });
  const { project } = sc.startMission({ project: proj, objective: 'Tail safety', detect: false });
  const file = H.eventsFile(s.dataDir, project.id);
  fs.appendFileSync(file, '{"id":"ev_partial","type":"tool","at":"2026-01-01T00:0'); // cut off, no newline
  sc.recordToolEvent({ toolUseId: 'after-cut', toolName: 'Bash', toolInput: { command: 'ls' }, ok: true, cwd: proj });
  const { events, skipped } = H.readEvents(s.dataDir, project.id);
  assert.equal(skipped, 1, 'only the truncated line is lost');
  assert.ok(events.some((e) => e.id === 'tool:after-cut'), 'the event appended after the cut is intact');
});

test('a restarted instance sees mission, idea, quiet hours and handoff', (t) => {
  const s = H.mkScratch(t);
  const proj = s.project('my project');
  const clock = H.makeClock('2026-03-04T10:00:00Z');
  const sc = new StopCode({ dataDir: s.dataDir, now: clock.now });
  sc.startMission({ project: proj, objective: 'Persist me', criteria: ['A', 'B'], detect: false });
  sc.parkIdea({ project: proj, text: 'Later: cache layer' });
  sc.startQuiet({ project: proj, minutes: 90, protect: true });
  const saved = sc.saveHandoff({ project: proj, note: 'restart check' });

  const sc2 = new StopCode({ dataDir: s.dataDir, now: clock.now });
  const view = sc2.projectView(proj);
  assert.equal(view.mission.objective, 'Persist me');
  assert.equal(view.mission.criteria.length, 2);
  assert.equal(view.ideas[0].text, 'Later: cache layer');
  assert.equal(view.quiet.active, true);
  assert.equal(view.quiet.enforced, true);
  assert.equal(view.handoff.id, saved.handoff.id);
  assert.equal(sc2.readHandoff(saved.handoff.id).markdown, saved.markdown);
});
