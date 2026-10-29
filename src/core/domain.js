'use strict';
// StopCode shared domain layer. Every surface (hooks, CLI, skills, dashboard API) calls
// these operations; nothing else writes state. Operations are synchronous and run inside
// the store's cross-process lock.
const path = require('path');
const { Store } = require('./store');
const { randomId } = require('./ids');
const V = require('./validate');
const T = require('./time');
const P = require('./projects');
const { excerpt } = require('./redact');
const H = require('./handoff');

const CRITERION_STATUSES = ['not_started', 'in_progress', 'reported_complete', 'verified', 'blocked'];
const EVIDENCE_KINDS = ['test_run', 'build', 'command', 'file_edit', 'manual_check', 'user_confirmation', 'note'];
const EVIDENCE_OUTCOMES = ['pass', 'fail', 'unknown'];
const SCOPE_CLASSES = ['in_scope', 'necessary_dependency', 'optional_improvement', 'scope_expansion', 'unrelated', 'uncertain'];
const IDEA_STATUSES = ['parked', 'resumed', 'dropped'];
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_SESSIONS_PER_PROJECT = 100;
const MAX_FILES_PER_SESSION = 60;
const STALE_SESSION_MS = 2 * 60 * 60 * 1000;

const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+test\b|\bgradlew?\s+test\b|\bjest\b|\bvitest\b|\bmocha\b|\bphpunit\b|\brspec\b|\bdotnet\s+test\b|\bctest\b/;
const BUILD_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b|\bgradlew?\s+build\b|\bmvn\s+(?:package|compile)\b|\bdotnet\s+build\b/;
const SCOPE_HINT = /\b(?:also|additionally|while (?:you're|you are|we're|we are) at it|bonus|on top of that|one more thing|can you also|could you also|another thing|as well as that)\b/i;

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.details = details;
  }
}

// ---------- pure helpers ----------

function parseTestOutput(text) {
  const t = String(text || '');
  let passed = null;
  let failed = null;
  let m;
  // TAP (`# pass 4`) and Node's default spec reporter (`ℹ pass 4`).
  if ((m = /^\s*[#ℹ] pass (\d+)/m.exec(t))) passed = Number(m[1]);
  if ((m = /^\s*[#ℹ] fail (\d+)/m.exec(t))) failed = Number(m[1]);
  if (passed === null && (m = /(\d+) (?:tests? )?passed/.exec(t))) passed = Number(m[1]);
  if (failed === null && (m = /(\d+) (?:tests? )?failed/.exec(t))) failed = Number(m[1]);
  if ((m = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/.exec(t))) {
    passed = Number(m[2]);
    failed = Number(m[3]);
  }
  if (/--- FAIL|^FAIL\s/m.test(t)) failed = Math.max(1, failed || 0);
  if (failed === null && passed === null && /^ok\s/m.test(t)) passed = 1;
  if ((m = /(\d+) errors?\b/.exec(t)) && Number(m[1]) > 0) failed = Math.max(Number(m[1]), failed || 0);
  let outcome = 'unknown';
  if (failed !== null && failed > 0) outcome = 'fail';
  else if (passed !== null && passed > 0) outcome = 'pass';
  const summary = outcome === 'unknown'
    ? 'result not parsed from output'
    : `${passed === null ? '?' : passed} passed, ${failed === null ? 0 : failed} failed (parsed from output)`;
  return { passed, failed, outcome, summary };
}

function classifyCommand(command) {
  const c = String(command || '');
  if (TEST_COMMAND.test(c)) return 'test_run';
  if (BUILD_COMMAND.test(c)) return 'build';
  return null;
}

function significantWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );
}

function overlaps(a, b, minShared = 3) {
  const wa = significantWords(a);
  const wb = significantWords(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared >= minShared;
}

function completionOf(mission, nowMs) {
  const criteria = mission ? mission.criteria : [];
  const total = criteria.length;
  if (!mission || total === 0) {
    return { state: 'no_criteria', headline: mission ? 'No completion criteria recorded' : 'No mission', verifiedCount: 0, total: 0, reportedCount: 0, blockedCount: 0 };
  }
  let verified = 0;
  let reported = 0;
  let blocked = 0;
  let staleVerified = 0;
  for (const c of criteria) {
    if (c.status === 'verified') {
      if (c.stale) staleVerified++;
      else verified++;
    } else if (c.status === 'reported_complete') reported++;
    else if (c.status === 'blocked') blocked++;
  }
  let state = 'incomplete';
  let headline = `In progress (${verified} of ${total} verified)`;
  if (verified === total) {
    state = 'complete';
    headline = 'Your original goal is complete';
  } else if (verified + reported + staleVerified === total) {
    state = 'reported';
    headline = staleVerified ? 'Verification pending (stale evidence)' : 'Verification pending';
  } else if (blocked > 0) {
    state = 'blocked';
    headline = `Blocked on ${blocked} criteri${blocked === 1 ? 'on' : 'a'} (${verified} of ${total} verified)`;
  }
  return { state, headline, verifiedCount: verified, total, reportedCount: reported, blockedCount: blocked, staleVerified };
}

function nextStepOf(mission) {
  if (!mission) return null;
  if (mission.nextAction) return mission.nextAction;
  const inProgress = mission.criteria.find((c) => c.status === 'in_progress');
  if (inProgress) return `Finish: ${inProgress.text}`;
  const reported = mission.criteria.find((c) => c.status === 'reported_complete' || (c.status === 'verified' && c.stale));
  if (reported) return `Verify: ${reported.text}`;
  const notStarted = mission.criteria.find((c) => c.status === 'not_started');
  if (notStarted) return `Start: ${notStarted.text}`;
  const blocked = mission.criteria.find((c) => c.status === 'blocked');
  if (blocked) return `Unblock: ${blocked.text}`;
  if (mission.criteria.length) return 'All criteria verified. Decide whether to clock out.';
  return 'Add a completion criterion so progress can be verified.';
}

// Mark evidence/criteria stale when files changed after the last passing check.
function applyStaleness(mission) {
  if (!mission) return;
  const lastEdit = T.toMs(mission.lastEditAt);
  const byId = new Map(mission.evidence.map((e) => [e.id, e]));
  for (const c of mission.criteria) {
    c.stale = false;
    if (c.status !== 'verified' || !Number.isFinite(lastEdit)) continue;
    const passes = c.evidenceIds.map((id) => byId.get(id)).filter((e) => e && e.outcome === 'pass');
    if (!passes.length) continue;
    const newest = Math.max(...passes.map((e) => T.toMs(e.at)));
    c.stale = lastEdit > newest;
  }
}

// ---------- the core ----------

class StopCode {
  constructor({ dataDir, now } = {}) {
    this.store = new Store(dataDir);
    this._now = now;
  }

  now() {
    if (typeof this._now === 'function') return this._now();
    if (this._now) return new Date(this._now).toISOString();
    return new Date().toISOString();
  }

  get dataDir() {
    return this.store.root;
  }

  readState() {
    return this.store.readState();
  }

  settings() {
    return this.readState().settings;
  }

  // ----- projects -----

  resolveProject(ref, { create = false } = {}) {
    const state = this.readState();
    const dir = ref || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = P.findProjectByRef(state, dir);
    if (found) return found;
    if (!create) return null;
    return this.store.update((s) => P.ensureProject(s, dir, { now: this.now() }));
  }

  requireProject(ref) {
    const project = this.resolveProject(ref);
    if (!project) throw new NotFoundError(`No StopCode project found for ${ref || process.cwd()}. Run \`stopcode start "<mission>"\` first.`);
    return project;
  }

  listProjects() {
    const state = this.readState();
    return Object.values(state.projects)
      .sort((a, b) => T.toMs(b.lastActivityAt || b.createdAt) - T.toMs(a.lastActivityAt || a.createdAt))
      .map((p) => this._projectSummary(state, p));
  }

  _projectSummary(state, p) {
    const mission = p.activeMissionId ? state.missions[p.activeMissionId] : null;
    if (mission) applyStaleness(mission);
    const quiet = this._quietStatus(state, p, this.now());
    return {
      id: p.id,
      name: p.name,
      root: p.root,
      git: p.git,
      lastActivityAt: p.lastActivityAt,
      monitoringPaused: !!p.monitoring.paused,
      quietActive: quiet.active,
      mission: mission ? { id: mission.id, objective: mission.objective, status: mission.status, parkedAt: mission.parkedAt || null, completion: completionOf(mission) } : null,
    };
  }

  _update(fn) {
    return this.store.update((state) => fn(state));
  }

  _event(state, projectId, event) {
    const at = event.at || this.now();
    const ev = { id: event.id || randomId('ev'), at, ...event };
    if (typeof ev.type !== 'string' || !ev.type) throw new V.ValidationError('event.type is required', 'type');
    if (!Number.isFinite(T.toMs(ev.at))) throw new V.ValidationError('event.at must be a timestamp', 'at');
    const res = this.store.appendEventUnlocked(projectId, ev);
    if (!res.duplicate) {
      const project = state.projects[projectId];
      if (project) project.lastActivityAt = at;
    }
    return res;
  }

  // ----- missions -----

  startMission({ project: ref, objective, criteria = [], budgetMinutes, sessionId, source = 'cli', detect = true } = {}) {
    const text = V.str(objective, 'objective', { max: 600 });
    const crit = V.stringList(criteria, 'criteria', { max: 8, itemMax: 300 });
    const budget = V.int(budgetMinutes, 'budgetMinutes', { min: 5, max: 24 * 60, optional: true });
    const now = this.now();
    return this._update((state) => {
      const dir = ref || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const project = P.findProjectByRef(state, dir) || P.ensureProject(state, dir, { now, detect });
      let previous = null;
      if (project.activeMissionId && state.missions[project.activeMissionId]) {
        previous = state.missions[project.activeMissionId];
        if (previous.status === 'active') {
          previous.status = 'archived';
          previous.archivedAt = now;
          previous.archivedReason = 'replaced by a new mission (preserved)';
        }
      }
      const mission = {
        id: randomId('mis'),
        projectId: project.id,
        objective: text,
        criteria: crit.map((c) => ({ id: randomId('crit', 3), text: c, status: 'not_started', evidenceIds: [], note: null, userConfirmation: null, stale: false })),
        acceptedAdditions: [],
        deferredIdeas: [],
        scopeNotes: [],
        evidence: [],
        sessionIds: sessionId ? [sessionId] : [],
        handoffIds: [],
        budgetMinutes: budget || null,
        nextAction: null,
        status: 'active',
        startedAt: now,
        finishedAt: null,
        parkedAt: null,
        lastEditAt: null,
        userConfirmedComplete: null,
        source,
      };
      state.missions[mission.id] = mission;
      project.activeMissionId = mission.id;
      if (sessionId && state.sessions[sessionId]) state.sessions[sessionId].missionId = mission.id;
      this._event(state, project.id, { type: 'mission_start', sessionId: sessionId || null, missionId: mission.id, objective: text, criteria: crit.length, previousMissionId: previous ? previous.id : null });
      return { project: this._projectSummary(state, project), mission, previousMission: previous ? { id: previous.id, objective: previous.objective, status: previous.status } : null };
    });
  }

  _requireMission(state, ref) {
    const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!project) throw new NotFoundError('No StopCode project found for this directory');
    const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
    if (!mission) throw new NotFoundError(`No active mission for ${project.name}. Run \`stopcode start "<mission>"\` first.`);
    return { project, mission };
  }

  setNextAction({ project: ref, text }) {
    const t = V.str(text, 'text', { max: 400 });
    return this._update((state) => {
      const { mission } = this._requireMission(state, ref);
      mission.nextAction = t;
      return { ok: true, nextAction: t };
    });
  }

  completeMission({ project: ref, note } = {}) {
    const n = V.str(note, 'note', { optional: true, max: 400 });
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      mission.userConfirmedComplete = { at: this.now(), note: n || null };
      mission.status = 'completed';
      mission.finishedAt = this.now();
      this._event(state, project.id, { type: 'mission_complete', missionId: mission.id, by: 'user' });
      return { ok: true, mission };
    });
  }

  // ----- criteria + evidence -----

  addCriterion({ project: ref, text }) {
    const t = V.str(text, 'text', { max: 300 });
    return this._update((state) => {
      const { mission } = this._requireMission(state, ref);
      if (mission.criteria.length >= 12) throw new V.ValidationError('A mission can have at most 12 criteria', 'text');
      const c = { id: randomId('crit', 3), text: t, status: 'not_started', evidenceIds: [], note: null, userConfirmation: null, stale: false };
      mission.criteria.push(c);
      return { ok: true, criterion: c };
    });
  }

  _findCriterion(mission, criterionRef) {
    const ref = String(criterionRef || '').trim();
    let c = mission.criteria.find((x) => x.id === ref);
    if (!c && /^\d+$/.test(ref)) c = mission.criteria[Number(ref) - 1];
    if (!c) c = mission.criteria.find((x) => x.text.toLowerCase() === ref.toLowerCase());
    if (!c) throw new NotFoundError(`Criterion not found: ${ref} (use the id, the 1-based number, or the exact text)`);
    return c;
  }

  setCriterionStatus({ project: ref, criterion, status, note }) {
    const st = V.oneOf(status, 'status', CRITERION_STATUSES);
    const n = V.str(note, 'note', { optional: true, max: 400 });
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      const c = this._findCriterion(mission, criterion);
      if (st === 'verified') {
        const hasPass = c.evidenceIds.some((id) => mission.evidence.find((e) => e.id === id && e.outcome === 'pass'));
        if (!hasPass) throw new V.ValidationError('A criterion can only be marked verified with passing evidence attached. Add evidence first (stopcode evidence add ... --criterion <id>) or use reported_complete.', 'status');
      }
      c.status = st;
      if (n !== undefined) c.note = n;
      applyStaleness(mission);
      this._event(state, project.id, { type: 'criterion_status', missionId: mission.id, criterionId: c.id, status: st });
      return { ok: true, criterion: c };
    });
  }

  confirmCriterion({ project: ref, criterion, note }) {
    const n = V.str(note, 'note', { optional: true, max: 400 });
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      const c = this._findCriterion(mission, criterion);
      c.userConfirmation = { at: this.now(), note: n || null };
      if (c.status === 'not_started' || c.status === 'in_progress') c.status = 'reported_complete';
      this._event(state, project.id, { type: 'criterion_confirmed', missionId: mission.id, criterionId: c.id });
      return { ok: true, criterion: c };
    });
  }

  addEvidence({ project: ref, kind, outcome = 'unknown', summary, criterion, source = 'user', sessionId = null, toolUseId = null, at } = {}) {
    const k = V.oneOf(kind, 'kind', EVIDENCE_KINDS);
    const o = V.oneOf(outcome, 'outcome', EVIDENCE_OUTCOMES);
    const s = V.str(summary, 'summary', { max: 500 });
    const when = at ? V.isoDate(at, 'at') : this.now();
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      return this._addEvidenceTo(state, project, mission, { kind: k, outcome: o, summary: s, criterion, source, sessionId, toolUseId, at: when });
    });
  }

  _addEvidenceTo(state, project, mission, { kind, outcome, summary, criterion, source, sessionId, toolUseId, at }) {
    if (toolUseId && mission.evidence.some((e) => e.toolUseId === toolUseId)) {
      return { ok: true, duplicate: true, evidence: mission.evidence.find((e) => e.toolUseId === toolUseId) };
    }
    const ev = { id: randomId('evd', 4), kind, outcome, summary, source, sessionId, toolUseId, at, criterionIds: [] };
    mission.evidence.push(ev);
    if (mission.evidence.length > 300) mission.evidence.splice(0, mission.evidence.length - 300);
    let crit = null;
    if (criterion) {
      crit = this._findCriterion(mission, criterion);
      crit.evidenceIds.push(ev.id);
      ev.criterionIds.push(crit.id);
      if (outcome === 'pass') crit.status = 'verified';
      else if (outcome === 'fail' && crit.status === 'verified') crit.status = 'in_progress';
    }
    applyStaleness(mission);
    this._event(state, project.id, { type: 'evidence', missionId: mission.id, evidenceId: ev.id, kind, outcome, summary: excerpt(summary, 140), criterionId: crit ? crit.id : null, sessionId, source });
    return { ok: true, evidence: ev, criterion: crit };
  }

  attachEvidence({ project: ref, criterion, evidenceId }) {
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      const ev = mission.evidence.find((e) => e.id === evidenceId);
      if (!ev) throw new NotFoundError(`Evidence not found: ${evidenceId}`);
      const c = this._findCriterion(mission, criterion);
      if (!c.evidenceIds.includes(ev.id)) c.evidenceIds.push(ev.id);
      if (!ev.criterionIds.includes(c.id)) ev.criterionIds.push(c.id);
      if (ev.outcome === 'pass') c.status = 'verified';
      applyStaleness(mission);
      this._event(state, project.id, { type: 'evidence_attached', missionId: mission.id, evidenceId: ev.id, criterionId: c.id });
      return { ok: true, criterion: c, evidence: ev };
    });
  }

  // ----- scope: additions, ideas, notes -----

  acceptAddition({ project: ref, text, source = 'user' }) {
    const t = V.str(text, 'text', { max: 400 });
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      const existing = mission.acceptedAdditions.find((a) => a.text.toLowerCase() === t.toLowerCase());
      if (existing) return { ok: true, duplicate: true, addition: existing };
      const a = { id: randomId('add', 3), text: t, at: this.now(), source };
      mission.acceptedAdditions.push(a);
      mission.scopeNotes.push({ id: randomId('scp', 3), text: t, classification: 'scope_expansion', decision: 'accepted', at: a.at, source });
      this._event(state, project.id, { type: 'scope_accepted', missionId: mission.id, text: excerpt(t, 140) });
      return { ok: true, addition: a };
    });
  }

  parkIdea({ project: ref, text, source = 'user' }) {
    const t = V.str(text, 'text', { max: 400 });
    const now = this.now();
    return this._update((state) => {
      const dir = ref || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const project = P.findProjectByRef(state, dir) || P.ensureProject(state, dir, { now });
      const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
      const idea = { id: randomId('idea', 3), text: t, at: now, status: 'parked', source, missionId: mission ? mission.id : null };
      if (mission) {
        mission.deferredIdeas.push(idea);
        mission.scopeNotes.push({ id: randomId('scp', 3), text: t, classification: 'optional_improvement', decision: 'deferred', at: now, source });
      } else {
        if (!Array.isArray(project.ideas)) project.ideas = [];
        project.ideas.push(idea);
      }
      this._event(state, project.id, { type: 'idea_parked', missionId: mission ? mission.id : null, ideaId: idea.id, text: excerpt(t, 140) });
      return { ok: true, idea, projectId: project.id };
    });
  }

  updateIdea({ project: ref, ideaId, status }) {
    const st = V.oneOf(status, 'status', IDEA_STATUSES);
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      let idea = null;
      for (const m of Object.values(state.missions)) {
        if (m.projectId !== project.id) continue;
        idea = m.deferredIdeas.find((i) => i.id === ideaId) || idea;
      }
      if (!idea && Array.isArray(project.ideas)) idea = project.ideas.find((i) => i.id === ideaId);
      if (!idea) throw new NotFoundError(`Idea not found: ${ideaId}`);
      idea.status = st;
      idea.updatedAt = this.now();
      this._event(state, project.id, { type: 'idea_updated', ideaId, status: st });
      return { ok: true, idea };
    });
  }

  noteScope({ project: ref, text, classification, decision = 'noted', source = 'claude' }) {
    const t = V.str(text, 'text', { max: 400 });
    const c = V.oneOf(classification, 'classification', SCOPE_CLASSES);
    const d = V.oneOf(decision, 'decision', ['noted', 'accepted', 'deferred', 'dismissed']);
    return this._update((state) => {
      const { project, mission } = this._requireMission(state, ref);
      const note = { id: randomId('scp', 3), text: t, classification: c, decision: d, at: this.now(), source };
      mission.scopeNotes.push(note);
      if (mission.scopeNotes.length > 100) mission.scopeNotes.splice(0, mission.scopeNotes.length - 100);
      this._event(state, project.id, { type: 'scope_note', missionId: mission.id, classification: c, decision: d, text: excerpt(t, 140) });
      return { ok: true, note };
    });
  }

  dismissAdvice({ project: ref, minutes = 120 }) {
    const m = V.int(minutes, 'minutes', { min: 5, max: 24 * 60 });
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      project.advice.dismissedUntil = new Date(T.toMs(this.now()) + m * 60000).toISOString();
      return { ok: true, dismissedUntil: project.advice.dismissedUntil };
    });
  }

  markAdvice({ project: ref }) {
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.cwd());
      if (!project) return { ok: false };
      project.advice.lastAt = this.now();
      return { ok: true };
    });
  }

  // ----- sessions -----

  sessionStart({ project: ref, sessionId, source = 'startup', cwd, detect = true, register = false } = {}) {
    const sid = V.str(sessionId, 'sessionId', { max: 120 });
    const now = this.now();
    return this._update((state) => {
      const dir = ref || cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      let project = P.findProjectByRef(state, dir);
      if (!project && register) project = P.ensureProject(state, dir, { now, detect });
      if (!project) return { tracked: false, reason: 'no StopCode project for this directory' };
      let session = state.sessions[sid];
      let created = false;
      if (!session) {
        session = {
          id: sid,
          projectId: project.id,
          missionId: project.activeMissionId || null,
          startedAt: now,
          lastSeenAt: now,
          endedAt: null,
          endedBy: null,
          endReason: null,
          source,
          status: 'active',
          counters: { tools: 0, edits: 0, commands: 0, prompts: 0, afterHours: 0, failures: 0 },
          files: [],
          cwd: cwd || null,
        };
        state.sessions[sid] = session;
        created = true;
        this._pruneSessions(state, project.id);
      } else {
        session.lastSeenAt = now;
        if (session.status !== 'active') {
          session.status = 'active';
          session.endedAt = null;
          session.endedBy = null;
          session.reopenedAt = now;
        }
        if (!session.missionId && project.activeMissionId) session.missionId = project.activeMissionId;
      }
      project.lastSessionId = sid;
      const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
      if (mission && !mission.sessionIds.includes(sid)) mission.sessionIds.push(sid);
      if (created || source === 'clear') {
        this._event(state, project.id, { id: `session_start:${sid}:${source}`, type: 'session_start', sessionId: sid, source });
      }
      return { tracked: true, created, project: this._projectSummary(state, project), session, mission, quiet: this._quietStatus(state, project, now) };
    });
  }

  _pruneSessions(state, projectId) {
    const list = Object.values(state.sessions).filter((s) => s.projectId === projectId);
    if (list.length <= MAX_SESSIONS_PER_PROJECT) return;
    list.sort((a, b) => T.toMs(a.startedAt) - T.toMs(b.startedAt));
    const removable = list.filter((s) => s.status !== 'active');
    for (const s of removable.slice(0, list.length - MAX_SESSIONS_PER_PROJECT)) delete state.sessions[s.id];
  }

  sessionEnd({ sessionId, reason = 'other', endedBy = 'session_end' } = {}) {
    const sid = V.str(sessionId, 'sessionId', { max: 120 });
    const now = this.now();
    return this._update((state) => {
      const session = state.sessions[sid];
      if (!session) return { tracked: false };
      if (session.status === 'active') {
        session.status = 'ended';
        session.endedAt = now;
        session.endedBy = endedBy;
        session.endReason = reason;
        this._event(state, session.projectId, { id: `session_end:${sid}:${now}`, type: 'session_end', sessionId: sid, reason, endedBy });
      }
      return { tracked: true, session };
    });
  }

  // Record a prompt (minimal excerpt only). Returns advisory hints for the hook.
  recordPrompt({ sessionId, promptId, prompt, cwd }) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProject(state, cwd || process.cwd());
      if (!project) return { tracked: false };
      const session = sessionId ? state.sessions[sessionId] : null;
      const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
      const text = String(prompt || '');
      const wh = T.workingHoursStatus(now, state.settings);
      const afterHours = wh.known && !wh.within;
      const hint = SCOPE_HINT.test(text) ? 'possible_expansion' : null;
      const suppressed = hint && mission ? mission.acceptedAdditions.some((a) => overlaps(a.text, text)) : false;
      const id = promptId ? `prompt:${promptId}` : undefined;
      const res = this._event(state, project.id, { id, type: 'prompt', sessionId: sessionId || null, excerpt: excerpt(text, 120), length: text.length, afterHours, scopeHint: hint && !suppressed ? hint : null });
      if (!res.duplicate) {
        project.counters.prompts++;
        if (session) {
          session.counters.prompts++;
          session.lastSeenAt = now;
        }
      }
      return { tracked: true, project: this._projectSummary(state, project), mission, session, afterHours, scopeHint: hint && !suppressed ? hint : null, monitoringPaused: !!project.monitoring.paused };
    });
  }

  // Record one tool action (bounded fields only) and derive evidence from test/build runs.
  recordToolEvent({ sessionId, toolUseId, toolName, toolInput, toolResponse, ok = true, error, cwd, durationMs }) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProject(state, cwd || process.cwd());
      if (!project) return { tracked: false };
      const session = sessionId ? state.sessions[sessionId] : null;
      const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
      const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
      const wh = T.workingHoursStatus(now, state.settings);
      const afterHours = wh.known && !wh.within;
      const isEdit = EDIT_TOOLS.has(toolName);
      const file = input.file_path || input.notebook_path || null;
      const rel = file ? P.relativePath(project, file) : null;
      const command = toolName === 'Bash' || toolName === 'PowerShell' ? excerpt(input.command, 100) : null;
      const ev = {
        id: toolUseId ? `tool:${toolUseId}` : undefined,
        type: 'tool',
        sessionId: sessionId || null,
        tool: toolName,
        file: rel,
        command,
        ok: !!ok,
        afterHours,
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      };
      const res = this._event(state, project.id, ev);
      if (res.duplicate) return { tracked: true, duplicate: true };
      project.counters.toolEvents++;
      if (afterHours) project.counters.afterHoursEvents++;
      if (session) {
        session.lastSeenAt = now;
        session.counters.tools++;
        if (isEdit) session.counters.edits++;
        if (command) session.counters.commands++;
        if (afterHours) session.counters.afterHours++;
        if (!ok) session.counters.failures++;
        if (isEdit && rel) {
          session.files = session.files.filter((f) => f !== rel);
          session.files.push(rel);
          if (session.files.length > MAX_FILES_PER_SESSION) session.files.splice(0, session.files.length - MAX_FILES_PER_SESSION);
        }
      }
      let evidence = null;
      if (mission) {
        if (isEdit && ok) {
          mission.lastEditAt = now;
          applyStaleness(mission);
        }
        const kind = command ? classifyCommand(input.command) : null;
        if (kind) {
          let outcome = 'unknown';
          let detail = '';
          if (ok) {
            const stdout = toolResponse && typeof toolResponse === 'object' ? String(toolResponse.stdout || '') + '\n' + String(toolResponse.stderr || '') : String(toolResponse || '');
            const parsed = parseTestOutput(stdout);
            outcome = parsed.outcome;
            detail = parsed.outcome === 'unknown' ? 'command exited successfully; result not parsed from output' : parsed.summary;
          } else {
            const parsed = parseTestOutput(error || '');
            outcome = 'fail';
            detail = parsed.outcome === 'fail' ? parsed.summary : `command failed: ${excerpt(error, 120) || 'no error text'}`;
          }
          const added = this._addEvidenceTo(state, project, mission, {
            kind,
            outcome,
            summary: `${command} — ${detail}`,
            criterion: null,
            source: ok ? 'hook:PostToolUse' : 'hook:PostToolUseFailure',
            sessionId: sessionId || null,
            toolUseId: toolUseId || null,
            at: now,
          });
          evidence = added.evidence;
        }
      }
      return { tracked: true, duplicate: false, afterHours, evidence, monitoringPaused: !!project.monitoring.paused };
    });
  }

  recordTurnEnd({ sessionId, cwd }) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProject(state, cwd || process.cwd());
      if (!project) return { tracked: false };
      const session = sessionId ? state.sessions[sessionId] : null;
      if (session) session.lastSeenAt = now;
      project.lastActivityAt = now;
      return { tracked: true };
    });
  }

  // ----- breaks (about the person, not a project) -----

  startBreak({ note } = {}) {
    const n = V.str(note, 'note', { optional: true, max: 200 });
    const now = this.now();
    return this._update((state) => {
      const open = state.breaks.find((b) => !b.endedAt);
      if (open) return { ok: true, alreadyOnBreak: true, break: open };
      const b = { id: randomId('brk', 3), startedAt: now, endedAt: null, note: n || null };
      state.breaks.push(b);
      if (state.breaks.length > 500) state.breaks.splice(0, state.breaks.length - 500);
      for (const p of Object.values(state.projects)) if (p.activeMissionId) this._event(state, p.id, { type: 'break_start', breakId: b.id });
      return { ok: true, break: b };
    });
  }

  endBreak() {
    const now = this.now();
    return this._update((state) => {
      const open = state.breaks.find((b) => !b.endedAt);
      if (!open) return { ok: true, notOnBreak: true };
      open.endedAt = now;
      for (const p of Object.values(state.projects)) if (p.activeMissionId) this._event(state, p.id, { type: 'break_end', breakId: open.id, minutes: Math.round((T.toMs(now) - T.toMs(open.startedAt)) / 60000) });
      return { ok: true, break: open };
    });
  }

  _breakStatus(state, now) {
    const open = state.breaks.find((b) => !b.endedAt);
    const ended = state.breaks.filter((b) => b.endedAt).sort((a, b) => T.toMs(b.endedAt) - T.toMs(a.endedAt));
    const last = ended[0] || null;
    return {
      onBreak: !!open,
      currentBreak: open,
      lastBreakEndedAt: last ? last.endedAt : null,
      sinceLastBreakMs: open ? 0 : last ? T.toMs(now) - T.toMs(last.endedAt) : null,
      recorded: state.breaks.length,
    };
  }

  // ----- monitoring pause -----

  pauseMonitoring({ project: ref } = {}) {
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      project.monitoring = { paused: true, pausedAt: this.now() };
      this._event(state, project.id, { type: 'monitoring_paused' });
      return { ok: true, project: this._projectSummary(state, project), quiet: this._quietStatus(state, project, this.now()) };
    });
  }

  resumeMonitoring({ project: ref } = {}) {
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      project.monitoring = { paused: false, pausedAt: null };
      this._event(state, project.id, { type: 'monitoring_resumed' });
      return { ok: true, project: this._projectSummary(state, project) };
    });
  }

  // ----- quiet hours (deterministic, local) -----

  _quietStatus(state, project, nowIso) {
    const now = T.toMs(nowIso);
    const tz = state.settings.timezone;
    const result = { active: false, protect: false, source: null, startsAt: null, endsAt: null, overriddenAt: null, endedAt: null, reason: null, expired: false, plannedRestartAt: null };
    const q = project.quiet;
    if (q) {
      const starts = T.toMs(q.startsAt);
      const ends = T.toMs(q.endsAt);
      result.startsAt = q.startsAt;
      result.endsAt = q.endsAt;
      result.protect = !!q.protect;
      result.source = q.reason || 'clock_out';
      result.overriddenAt = q.overriddenAt || null;
      result.endedAt = q.endedAt || null;
      result.plannedRestartAt = q.plannedRestartAt || q.endsAt;
      if (!q.endedAt && !q.overriddenAt && starts <= now && now < ends) result.active = true;
      else if (!q.endedAt && !q.overriddenAt && now >= ends) result.expired = true;
    }
    const cal = state.settings.calendarQuietHours;
    if (!result.active && cal && cal.enabled && Array.isArray(cal.projectIds) && cal.projectIds.includes(project.id)) {
      const overrides = project.calendarOverrides || {};
      const ev = (state.planner.events || []).find((e) => (e.type === 'recovery' || e.type === 'personal') && T.toMs(e.start) <= now && now < T.toMs(e.end) && !overrides[e.id]);
      if (ev) {
        result.active = true;
        result.protect = true;
        result.source = 'calendar';
        result.startsAt = ev.start;
        result.endsAt = ev.end;
        result.calendarEventId = ev.id;
        result.calendarEventTitle = ev.title;
        result.plannedRestartAt = ev.end;
      }
    }
    result.enforced = result.active && result.protect;
    result.endsAtLocal = result.endsAt ? T.formatDateTime(result.endsAt, tz) : null;
    result.endsAtTime = result.endsAt ? T.formatTime(result.endsAt, tz) : null;
    result.remainingMs = result.active ? Math.max(0, T.toMs(result.endsAt) - now) : 0;
    result.projectId = project.id;
    result.projectName = project.name;
    result.projectRoot = project.root;
    return result;
  }

  quietStatus({ project: ref } = {}) {
    const state = this.readState();
    const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!project) return { active: false, protect: false, source: null, tracked: false };
    return { tracked: true, ...this._quietStatus(state, project, this.now()) };
  }

  _computeQuietEnd(state, nowIso, { minutes, until }) {
    const tz = state.settings.timezone;
    if (until) {
      const hhmm = /^\d{1,2}:\d{2}$/.test(String(until).trim()) ? V.timeHHMM(until, 'until') : null;
      if (hhmm) return { endsAt: T.nextLocalTime(hhmm, tz, nowIso), label: `until ${hhmm}` };
      if (String(until).trim().toLowerCase() === 'tomorrow' || String(until).trim().toLowerCase() === 'next-working-start') {
        const next = T.nextWorkingStart(nowIso, state.settings);
        if (!next) throw new V.ValidationError('No working hours configured; give an explicit time instead', 'until');
        return { endsAt: next, label: 'until the next working block' };
      }
      return { endsAt: V.isoDate(until, 'until'), label: 'until a fixed time' };
    }
    const mins = T.parseDuration(minutes);
    if (!mins || mins < 1) throw new V.ValidationError('Quiet duration must be at least 1 minute (e.g. 30m, 2h)', 'minutes');
    if (mins > 7 * 1440) throw new V.ValidationError('Quiet duration must be at most 7 days', 'minutes');
    return { endsAt: new Date(T.toMs(nowIso) + mins * 60000).toISOString(), label: `for ${T.humanDuration(mins * 60000)}` };
  }

  startQuiet({ project: ref, minutes, until, protect = false, reason = 'manual' } = {}) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      return this._startQuietIn(state, project, now, { minutes, until, protect, reason });
    });
  }

  _startQuietIn(state, project, now, { minutes, until, protect, reason }) {
    const { endsAt, label } = this._computeQuietEnd(state, now, { minutes, until });
    if (T.toMs(endsAt) <= T.toMs(now)) throw new V.ValidationError('Quiet interval must end in the future', 'until');
    if (project.quiet && !project.quiet.endedAt) {
      project.quiet.endedAt = now;
      project.quiet.endedBy = 'replaced';
      project.quietHistory.push(project.quiet);
    }
    project.quiet = { id: randomId('qt', 3), startsAt: now, endsAt, protect: !!protect, reason, overriddenAt: null, endedAt: null, plannedRestartAt: endsAt, label };
    if (project.quietHistory.length > 50) project.quietHistory.splice(0, project.quietHistory.length - 50);
    this._event(state, project.id, { type: 'quiet_start', quietId: project.quiet.id, endsAt, protect: !!protect, reason });
    return { ok: true, quiet: this._quietStatus(state, project, now) };
  }

  endQuiet({ project: ref, by = 'user' } = {}) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      if (project.quiet && !project.quiet.endedAt) {
        project.quiet.endedAt = now;
        project.quiet.endedBy = by;
        this._event(state, project.id, { type: 'quiet_end', quietId: project.quiet.id, by });
      }
      return { ok: true, quiet: this._quietStatus(state, project, now) };
    });
  }

  // Used by uninstall: no boundary may outlive the integration.
  endAllQuiet() {
    const now = this.now();
    return this._update((state) => {
      const ended = [];
      for (const project of Object.values(state.projects)) {
        if (project.quiet && !project.quiet.endedAt && T.toMs(project.quiet.endsAt) > T.toMs(now)) {
          project.quiet.endedAt = now;
          project.quiet.endedBy = 'uninstall';
          ended.push(project.name);
          this._event(state, project.id, { type: 'quiet_end', quietId: project.quiet.id, by: 'uninstall' });
        }
      }
      return ended;
    });
  }

  // Explicit override: lifts an active interval (clock-out or calendar) for this project.
  overrideQuiet({ project: ref, reason = 'user override' } = {}) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      const before = this._quietStatus(state, project, now);
      if (!before.active) return { ok: true, wasActive: false, quiet: before };
      if (before.source === 'calendar' && before.calendarEventId) {
        if (!project.calendarOverrides) project.calendarOverrides = {};
        project.calendarOverrides[before.calendarEventId] = now;
      } else if (project.quiet) {
        project.quiet.overriddenAt = now;
        project.quiet.overrideReason = reason;
      }
      this._event(state, project.id, { type: 'quiet_override', source: before.source, reason });
      return { ok: true, wasActive: true, quiet: this._quietStatus(state, project, now) };
    });
  }

  // ----- handoff -----

  _collectHandoffContext(state, project, mission, { note, trigger, now, quietPlan }) {
    const sessions = Object.values(state.sessions).filter((s) => s.projectId === project.id && (!mission || s.missionId === mission.id || mission.sessionIds.includes(s.id)));
    sessions.sort((a, b) => T.toMs(a.startedAt) - T.toMs(b.startedAt));
    const files = [];
    for (const s of sessions) for (const f of s.files || []) {
      const i = files.indexOf(f);
      if (i >= 0) files.splice(i, 1);
      files.push(f);
    }
    if (mission) applyStaleness(mission);
    const completion = completionOf(mission, T.toMs(now));
    const attached = new Set();
    if (mission) for (const c of mission.criteria) for (const id of c.evidenceIds) attached.add(id);
    const evidence = mission ? mission.evidence : [];
    const unattachedEvidence = evidence.filter((e) => !attached.has(e.id));
    const checksNotRun = mission ? mission.criteria.filter((c) => !c.evidenceIds.length && c.status !== 'verified').map((c) => `${c.text}: no check recorded (${H.statusLabel(c.status)})`) : [];
    const current = sessions.filter((s) => s.status === 'active').sort((a, b) => T.toMs(b.startedAt) - T.toMs(a.startedAt))[0] || sessions[sessions.length - 1] || null;
    const sessionMs = current ? T.toMs(current.status === 'active' ? now : current.endedAt || current.lastSeenAt) - T.toMs(current.startedAt) : null;
    const elapsed = {
      sessionLabel: current ? `${T.humanDuration(sessionMs)} elapsed (wall clock) since ${T.formatDateTime(current.startedAt, state.settings.timezone)}${current.status === 'active' ? ', still open' : ''}` : 'no coding session recorded',
      missionLabel: mission ? `${T.humanDuration(T.toMs(now) - T.toMs(mission.startedAt))} since the mission started (wall clock)` : 'n/a',
    };
    const deferredIdeas = [...(mission ? mission.deferredIdeas : []), ...((project.ideas || []).filter((i) => !i.missionId))];
    const ctx = {
      project,
      mission,
      sessions,
      evidence,
      unattachedEvidence,
      checksNotRun,
      files,
      git: H.gitState(project.root),
      deferredIdeas,
      additions: mission ? mission.acceptedAdditions : [],
      nextAction: nextStepOf(mission),
      elapsed,
      now,
      settings: state.settings,
      note: note || null,
      trigger,
      completion,
      quietPlan: quietPlan || null,
    };
    ctx.resumeContext = H.buildResumeContext(ctx);
    return ctx;
  }

  saveHandoff({ project: ref, note, trigger = 'manual', sessionId = null, quietPlan } = {}) {
    const n = V.str(note, 'note', { optional: true, max: 1000 });
    const now = this.now();
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      return this._saveHandoffIn(state, project, now, { note: n, trigger, sessionId, quietPlan });
    });
  }

  _saveHandoffIn(state, project, now, { note, trigger, sessionId, quietPlan }) {
    const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
    const ctx = this._collectHandoffContext(state, project, mission, { note, trigger, now, quietPlan });
    const markdown = H.renderHandoff(ctx);
    const fileName = H.handoffFileName(now, mission ? mission.id : null);
    const file = this.store.writeHandoffFile(project.id, fileName, markdown);
    const record = {
      id: randomId('hnd', 4),
      projectId: project.id,
      missionId: mission ? mission.id : null,
      sessionId,
      savedAt: now,
      trigger,
      path: file,
      nextAction: ctx.nextAction,
      resumeContext: ctx.resumeContext,
      completion: ctx.completion,
      note: note || null,
    };
    state.handoffs.push(record);
    if (state.handoffs.length > 500) state.handoffs.splice(0, state.handoffs.length - 500);
    if (mission) mission.handoffIds.push(record.id);
    this._event(state, project.id, { type: 'handoff_saved', handoffId: record.id, missionId: mission ? mission.id : null, trigger, sessionId });
    return { ok: true, handoff: record, markdown };
  }

  listHandoffs({ project: ref } = {}) {
    const state = this.readState();
    const project = ref ? P.findProjectByRef(state, ref) : null;
    return state.handoffs.filter((h) => !project || h.projectId === project.id).slice().reverse();
  }

  readHandoff(id) {
    const state = this.readState();
    const record = state.handoffs.find((h) => h.id === id);
    if (!record) throw new NotFoundError(`Handoff not found: ${id}`);
    let markdown = null;
    let missing = false;
    try {
      markdown = this.store.readHandoffFile(record.path);
    } catch (e) {
      missing = true;
    }
    return { handoff: record, markdown, missing };
  }

  latestHandoff(projectId) {
    const state = this.readState();
    const list = state.handoffs.filter((h) => h.projectId === projectId);
    return list.length ? list[list.length - 1] : null;
  }

  // ----- clock out / finish / resume -----

  // Shared workflow used by the dashboard's Clock out, /stopcode:finish and the CLI.
  // Each step reports its own result; a failure in one does not hide the others.
  clockOut({ project: ref, sessionId = null, note, quiet = null, trigger = 'clock_out', markComplete = false } = {}) {
    const n = V.str(note, 'note', { optional: true, max: 1000 });
    const now = this.now();
    const result = { ok: false, handoff: null, session: null, quiet: null, mission: null, errors: [] };
    const quietReq = quiet && (quiet.minutes || quiet.until) ? { minutes: quiet.minutes, until: quiet.until, protect: !!quiet.protect } : null;
    this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
      let quietPlan = null;
      if (quietReq) {
        try {
          const { endsAt, label } = this._computeQuietEnd(state, now, quietReq);
          quietPlan = `${label} (${T.formatDateTime(endsAt, state.settings.timezone)})${quietReq.protect ? ', new coding actions in this project blocked' : ', advisory only'}`;
        } catch (e) {
          quietPlan = null;
        }
      }
      // 1. handoff from available evidence
      try {
        const saved = this._saveHandoffIn(state, project, now, { note: n, trigger, sessionId, quietPlan });
        result.handoff = { ok: true, id: saved.handoff.id, path: saved.handoff.path, nextAction: saved.handoff.nextAction, resumeContext: saved.handoff.resumeContext };
      } catch (e) {
        result.handoff = { ok: false, error: String(e.message || e) };
        result.errors.push(`handoff: ${e.message}`);
      }
      // 2. logically end the tracked session(s) and park the mission
      const ended = [];
      for (const s of Object.values(state.sessions)) {
        if (s.projectId !== project.id || s.status !== 'active') continue;
        if (sessionId && s.id !== sessionId) continue;
        s.status = 'ended';
        s.endedAt = now;
        s.endedBy = trigger;
        s.endReason = trigger;
        ended.push(s.id);
        this._event(state, project.id, { id: `session_end:${s.id}:${now}`, type: 'session_end', sessionId: s.id, reason: trigger, endedBy: trigger });
      }
      result.session = { ok: true, endedSessionIds: ended, note: 'The tracked session is logically ended; the Claude Code process is not closed by StopCode.' };
      if (mission) {
        mission.parkedAt = now;
        if (markComplete) {
          mission.userConfirmedComplete = { at: now, note: n || null };
          mission.status = 'completed';
          mission.finishedAt = now;
        }
        result.mission = { id: mission.id, status: mission.status, parkedAt: mission.parkedAt, completion: completionOf(mission, T.toMs(now)) };
      }
      this._event(state, project.id, { type: 'clock_out', sessionId, missionId: mission ? mission.id : null, trigger });
      // 3. chosen quiet interval
      if (quietReq) {
        try {
          const q = this._startQuietIn(state, project, now, { minutes: quietReq.minutes, until: quietReq.until, protect: quietReq.protect, reason: 'clock_out' });
          result.quiet = { ok: true, ...q.quiet };
          state.settings.clockOut = { lastQuietMinutes: T.parseDuration(quietReq.minutes) || state.settings.clockOut.lastQuietMinutes, lastProtect: !!quietReq.protect };
        } catch (e) {
          result.quiet = { ok: false, error: String(e.message || e), ...this._quietStatus(state, project, now) };
          result.errors.push(`quiet hours: ${e.message}`);
        }
      } else {
        result.quiet = { ok: true, requested: false, ...this._quietStatus(state, project, now) };
      }
      result.project = this._projectSummary(state, project);
    });
    result.ok = result.errors.length === 0;
    result.message = result.ok
      ? 'Your work is parked.'
      : `Clock out finished with problems: ${result.errors.join('; ')}`;
    return result;
  }

  // Restores the latest handoff and mission. If quiet hours are active the caller must pass
  // override=true explicitly; nothing is launched automatically either way.
  resume({ project: ref, override = false, sessionId = null } = {}) {
    const now = this.now();
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (!project) throw new NotFoundError('No StopCode project found for this directory');
      const quiet = this._quietStatus(state, project, now);
      if (quiet.active && !override) {
        return { ok: false, blocked: true, quiet, message: `Quiet hours are active for ${project.name} until ${quiet.endsAtLocal}. Resume with an explicit override to lift them.` };
      }
      let overrode = false;
      if (quiet.active && override) {
        if (quiet.source === 'calendar' && quiet.calendarEventId) {
          if (!project.calendarOverrides) project.calendarOverrides = {};
          project.calendarOverrides[quiet.calendarEventId] = now;
        } else if (project.quiet) {
          project.quiet.overriddenAt = now;
          project.quiet.overrideReason = 'resume override';
        }
        overrode = true;
        this._event(state, project.id, { type: 'quiet_override', source: quiet.source, reason: 'resume' });
      }
      const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
      if (mission) {
        mission.parkedAt = null;
        if (sessionId && !mission.sessionIds.includes(sessionId)) mission.sessionIds.push(sessionId);
        applyStaleness(mission);
      }
      const list = state.handoffs.filter((h) => h.projectId === project.id);
      const latest = list.length ? list[list.length - 1] : null;
      let markdown = null;
      if (latest) {
        try {
          markdown = this.store.readHandoffFile(latest.path);
        } catch (e) {
          markdown = null;
        }
      }
      this._event(state, project.id, { type: 'resume', sessionId, missionId: mission ? mission.id : null, override: overrode });
      return {
        ok: true,
        blocked: false,
        overrode,
        quiet: this._quietStatus(state, project, now),
        mission: mission ? { ...mission, completion: completionOf(mission, T.toMs(now)), nextStep: nextStepOf(mission) } : null,
        handoff: latest ? { ...latest, markdown } : null,
        message: mission ? `Resumed mission "${mission.objective}". Next action: ${nextStepOf(mission)}` : 'No active mission; nothing to resume.',
      };
    });
  }

  // ----- views -----

  recommendation({ mission, completion, quiet, elapsedMs, workingHours, breaks, project }) {
    const hours = elapsedMs ? elapsedMs / 3600000 : 0;
    if (quiet && quiet.active) {
      return { tone: 'calm', title: 'Your work is parked', detail: `Quiet hours run until ${quiet.endsAtLocal}. The handoff holds your next step; nothing here needs attention.`, actions: [] };
    }
    if (project && project.monitoring && project.monitoring.paused) {
      return { tone: 'calm', title: 'Monitoring is paused', detail: 'StopCode is not recording activity or giving advice for this project. Coding is not blocked.', actions: ['unpause'] };
    }
    if (!mission) {
      return { tone: 'calm', title: 'No mission yet', detail: 'Start a mission from Claude Code with /stopcode:start <goal> so StopCode can keep the original goal visible.', actions: [] };
    }
    if (completion.state === 'complete') {
      return { tone: 'calm', title: 'Your original goal is complete', detail: 'Every criterion has passing evidence. This is a natural place to clock out; anything new can be parked for tomorrow.', actions: ['clock_out'] };
    }
    if (workingHours.known && !workingHours.within) {
      return { tone: 'nudge', title: 'Outside your working hours', detail: `It is outside the working hours you set. Saving a handoff now keeps your place; the next step (${nextStepOf(mission)}) will be waiting.`, actions: ['clock_out'] };
    }
    if (breaks.sinceLastBreakMs !== null && breaks.sinceLastBreakMs > 2 * 3600000) {
      return { tone: 'nudge', title: `No break recorded in ${T.humanDuration(breaks.sinceLastBreakMs)}`, detail: 'A short recorded break is a cheap reset. StopCode only knows about breaks you record.', actions: ['start_break'] };
    }
    if (breaks.sinceLastBreakMs === null && hours >= 2) {
      return { tone: 'nudge', title: 'No break recorded this session', detail: `This session has ${T.humanDuration(elapsedMs)} of elapsed time and no recorded break. Consider a short one.`, actions: ['start_break'] };
    }
    if (hours >= 4) {
      return { tone: 'nudge', title: `${T.humanDuration(elapsedMs)} elapsed this session`, detail: `Pick a stopping point on purpose: the next verified criterion, or now with a handoff. Next step: ${nextStepOf(mission)}.`, actions: ['clock_out'] };
    }
    if (completion.reportedCount > 0) {
      return { tone: 'calm', title: 'Verification pending', detail: `${completion.reportedCount} criteri${completion.reportedCount === 1 ? 'on is' : 'a are'} reported complete but unverified. Running the check is a clean stopping point.`, actions: [] };
    }
    return { tone: 'calm', title: 'On track', detail: `Next step: ${nextStepOf(mission)}. A natural stop is when it is verified.`, actions: [] };
  }

  _timeline(events, tz) {
    const out = [];
    let group = null;
    const flush = () => {
      if (group) out.push(group);
      group = null;
    };
    for (const ev of events) {
      if (ev.type === 'tool') {
        if (!group) group = { type: 'activity', from: ev.at, to: ev.at, count: 0, edits: 0, commands: 0, failures: 0, afterHours: 0, files: [] };
        group.to = ev.at;
        group.count++;
        if (ev.file && EDIT_TOOLS.has(ev.tool)) {
          group.edits++;
          if (!group.files.includes(ev.file)) group.files.push(ev.file);
        }
        if (ev.command) group.commands++;
        if (ev.ok === false) group.failures++;
        if (ev.afterHours) group.afterHours++;
        continue;
      }
      if (ev.type === 'prompt') {
        if (!group) group = { type: 'activity', from: ev.at, to: ev.at, count: 0, edits: 0, commands: 0, failures: 0, afterHours: 0, files: [], prompts: 0 };
        group.prompts = (group.prompts || 0) + 1;
        group.to = ev.at;
        if (ev.afterHours) group.afterHours++;
        continue;
      }
      flush();
      out.push(ev);
    }
    flush();
    return out.slice(-60).map((e) => ({ ...e, atLocal: T.formatTime(e.at || e.to, tz), fromLocal: e.from ? T.formatTime(e.from, tz) : undefined, toLocal: e.to ? T.formatTime(e.to, tz) : undefined }));
  }

  projectView(ref) {
    const state = this.readState();
    const now = this.now();
    const nowMs = T.toMs(now);
    const tz = state.settings.timezone;
    const project = P.findProjectByRef(state, ref || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!project) return null;
    const mission = project.activeMissionId ? state.missions[project.activeMissionId] : null;
    if (mission) applyStaleness(mission);
    const completion = completionOf(mission, nowMs);
    const sessions = Object.values(state.sessions).filter((s) => s.projectId === project.id).sort((a, b) => T.toMs(b.startedAt) - T.toMs(a.startedAt));
    const current = sessions.find((s) => s.status === 'active') || null;
    const elapsedMs = current ? nowMs - T.toMs(current.startedAt) : 0;
    const { events, skipped } = this.store.readEvents(project.id, { limit: 600 });
    const dayStart = T.toMs(T.startOfLocalDay(now, tz));
    const today = events.filter((e) => T.toMs(e.at) >= dayStart);
    const toolToday = today.filter((e) => e.type === 'tool');
    const lastEvent = events.length ? events[events.length - 1] : null;
    const workingHours = T.workingHoursStatus(now, state.settings);
    const breaks = this._breakStatus(state, now);
    const quiet = this._quietStatus(state, project, now);
    const health = this.store.readHealth();
    const handoffs = state.handoffs.filter((h) => h.projectId === project.id);
    const latestHandoff = handoffs.length ? handoffs[handoffs.length - 1] : null;
    const ideas = [...(mission ? mission.deferredIdeas : []), ...((project.ideas || []))];
    const evidenceById = mission ? new Map(mission.evidence.map((e) => [e.id, e])) : new Map();
    const criteria = mission ? mission.criteria.map((c) => ({ ...c, evidence: c.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean) })) : [];
    const attached = new Set(criteria.flatMap((c) => c.evidenceIds));
    const previousMissions = Object.values(state.missions).filter((m) => m.projectId === project.id && m.id !== (mission && mission.id)).sort((a, b) => T.toMs(b.startedAt) - T.toMs(a.startedAt)).slice(0, 20).map((m) => ({ id: m.id, objective: m.objective, status: m.status, startedAt: m.startedAt, finishedAt: m.finishedAt, archivedAt: m.archivedAt || null, completion: completionOf(m) }));
    const lastHook = health.lastHookEvent || null;
    const degraded = health.lastHookError && (!lastHook || T.toMs(health.lastHookError.at) > T.toMs(lastHook.at) - 60000) && nowMs - T.toMs(health.lastHookError.at) < 6 * 3600000;
    const view = {
      now,
      timezone: tz,
      project: { id: project.id, name: project.name, root: project.root, git: project.git, createdAt: project.createdAt, monitoring: project.monitoring, counters: project.counters, lastActivityAt: project.lastActivityAt },
      mission: mission ? { ...mission, criteria, completion, nextStep: nextStepOf(mission), unattachedEvidence: mission.evidence.filter((e) => !attached.has(e.id)).slice(-15), elapsedMs: nowMs - T.toMs(mission.startedAt) } : null,
      previousMissions,
      session: current ? { ...current, elapsedMs, elapsedLabel: `${T.humanDuration(elapsedMs)} elapsed (wall clock)`, likelyStale: nowMs - T.toMs(current.lastSeenAt) > STALE_SESSION_MS, lastSeenAge: T.humanAge(current.lastSeenAt, now) } : null,
      recentSessions: sessions.slice(0, 10).map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, status: s.status, endedBy: s.endedBy, durationMs: T.toMs(s.endedAt || s.lastSeenAt) - T.toMs(s.startedAt), counters: s.counters, files: s.files })),
      activity: {
        toolEventsToday: toolToday.length,
        editsToday: toolToday.filter((e) => e.file && EDIT_TOOLS.has(e.tool)).length,
        commandsToday: toolToday.filter((e) => e.command).length,
        afterHoursToday: today.filter((e) => e.afterHours).length,
        promptsToday: today.filter((e) => e.type === 'prompt').length,
        lastEventAt: lastEvent ? lastEvent.at : null,
        lastEventAge: lastEvent ? T.humanAge(lastEvent.at, now) : null,
        skippedMalformed: skipped,
      },
      breaks: { ...breaks, sinceLastBreakLabel: breaks.onBreak ? 'on a break now' : breaks.sinceLastBreakMs === null ? 'unknown (no break recorded)' : `${T.humanDuration(breaks.sinceLastBreakMs)} ago` },
      quiet,
      workingHours: { ...workingHours, today: (state.settings.workingHours || {})[workingHours.dayKey] || [] },
      handoff: latestHandoff,
      handoffCount: handoffs.length,
      ideas,
      additions: mission ? mission.acceptedAdditions : [],
      scopeNotes: mission ? mission.scopeNotes.slice(-20) : [],
      timeline: this._timeline(events.slice(-250), tz),
      integration: {
        lastHookEvent: lastHook,
        lastHookAge: lastHook ? T.humanAge(lastHook.at, now) : null,
        lastHookError: health.lastHookError || null,
        degraded: !!degraded,
        storage: health.storage || null,
      },
      settings: { timezone: tz, workingHours: state.settings.workingHours, calendarQuietHours: state.settings.calendarQuietHours, clockOut: state.settings.clockOut },
    };
    view.recommendation = this.recommendation({ mission, completion, quiet, elapsedMs, workingHours, breaks, project });
    return view;
  }

  overview() {
    const state = this.readState();
    const now = this.now();
    const health = this.store.readHealth();
    return {
      now,
      dataDir: this.store.root,
      settings: state.settings,
      projects: Object.values(state.projects).sort((a, b) => T.toMs(b.lastActivityAt || b.createdAt) - T.toMs(a.lastActivityAt || a.createdAt)).map((p) => this._projectSummary(state, p)),
      breaks: this._breakStatus(state, now),
      health,
      handoffs: state.handoffs.slice(-50).reverse(),
      plannerEventCount: state.planner.events.length,
    };
  }

  // ----- settings -----

  updateSettings(patch = {}) {
    return this._update((state) => {
      const s = state.settings;
      if (patch.timezone !== undefined) s.timezone = V.timezone(patch.timezone, 'timezone');
      if (patch.workingHours !== undefined) {
        const wh = {};
        for (const day of T.DAY_KEYS) {
          const blocks = Array.isArray(patch.workingHours[day]) ? patch.workingHours[day] : [];
          if (blocks.length > 4) throw new V.ValidationError(`${day}: at most 4 working blocks`, 'workingHours');
          wh[day] = blocks.map((b) => {
            const start = V.timeHHMM(b.start, `${day}.start`);
            const end = V.timeHHMM(b.end, `${day}.end`);
            if (T.minutesOfDay(end) <= T.minutesOfDay(start)) throw new V.ValidationError(`${day}: end must be after start`, 'workingHours');
            return { start, end };
          });
        }
        s.workingHours = wh;
      }
      if (patch.calendarQuietHours !== undefined) {
        const c = patch.calendarQuietHours || {};
        s.calendarQuietHours = {
          enabled: V.bool(c.enabled, 'calendarQuietHours.enabled', { optional: true, fallback: false }),
          projectIds: (Array.isArray(c.projectIds) ? c.projectIds : []).filter((id) => state.projects[id]),
        };
      }
      if (patch.chat !== undefined) {
        s.chat = { shareSummary: V.bool((patch.chat || {}).shareSummary, 'chat.shareSummary', { optional: true, fallback: false }) };
      }
      if (patch.advice !== undefined) {
        const a = patch.advice || {};
        s.advice = {
          enabled: V.bool(a.enabled, 'advice.enabled', { optional: true, fallback: true }),
          minIntervalMinutes: V.int(a.minIntervalMinutes, 'advice.minIntervalMinutes', { min: 5, max: 240, optional: true }) || s.advice.minIntervalMinutes || 20,
          timeNudges: V.bool(a.timeNudges, 'advice.timeNudges', { optional: true, fallback: !!(s.advice && s.advice.timeNudges) }),
        };
      }
      return { ok: true, settings: s };
    });
  }

  // ----- data controls -----

  exportProject(ref) {
    const state = this.readState();
    const project = P.findProjectByRef(state, ref);
    if (!project) throw new NotFoundError('Project not found');
    const missions = Object.values(state.missions).filter((m) => m.projectId === project.id);
    const sessions = Object.values(state.sessions).filter((s) => s.projectId === project.id);
    const { events } = this.store.readEvents(project.id, { limit: 0 });
    const handoffs = state.handoffs.filter((h) => h.projectId === project.id).map((h) => {
      let markdown = null;
      try {
        markdown = this.store.readHandoffFile(h.path);
      } catch (e) {
        markdown = null;
      }
      return { ...h, markdown };
    });
    return { exportedAt: this.now(), stopcodeVersion: 1, project, missions, sessions, events, handoffs };
  }

  deleteProject(ref) {
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref);
      if (!project) throw new NotFoundError('Project not found');
      for (const [id, m] of Object.entries(state.missions)) if (m.projectId === project.id) delete state.missions[id];
      for (const [id, s] of Object.entries(state.sessions)) if (s.projectId === project.id) delete state.sessions[id];
      const removed = state.handoffs.filter((h) => h.projectId === project.id);
      state.handoffs = state.handoffs.filter((h) => h.projectId !== project.id);
      for (const h of removed) {
        try {
          require('fs').unlinkSync(h.path);
        } catch (e) {
          /* ignore */
        }
      }
      state.settings.calendarQuietHours.projectIds = state.settings.calendarQuietHours.projectIds.filter((id) => id !== project.id);
      delete state.projects[project.id];
      this.store.deleteEvents(project.id);
      return { ok: true, deleted: project.id };
    });
  }

  deleteSessionHistory(ref) {
    return this._update((state) => {
      const project = P.findProjectByRef(state, ref);
      if (!project) throw new NotFoundError('Project not found');
      for (const [id, s] of Object.entries(state.sessions)) if (s.projectId === project.id && s.status !== 'active') delete state.sessions[id];
      this.store.deleteEvents(project.id);
      project.counters = { toolEvents: 0, afterHoursEvents: 0, prompts: 0 };
      return { ok: true };
    });
  }
}

module.exports = {
  StopCode,
  NotFoundError,
  ConflictError,
  completionOf,
  nextStepOf,
  parseTestOutput,
  classifyCommand,
  applyStaleness,
  overlaps,
  CRITERION_STATUSES,
  EVIDENCE_KINDS,
  EVIDENCE_OUTCOMES,
  SCOPE_CLASSES,
  IDEA_STATUSES,
  SCOPE_HINT,
};
