'use strict';
// Versioned state document: schema defaults and migration. Keep records small; bulky
// activity lives in the per-project event log.
const { systemTimezone } = require('./time');

const SCHEMA_VERSION = 1;

function defaultWorkingHours() {
  const block = [{ start: '09:00', end: '17:30' }];
  return { mon: block, tue: block, wed: block, thu: block, fri: block, sat: [], sun: [] };
}

function defaultSettings() {
  return {
    timezone: systemTimezone(),
    workingHours: defaultWorkingHours(),
    // Planner events activate coding quiet hours only when the user enables this explicitly
    // and only for the listed projects.
    calendarQuietHours: { enabled: false, projectIds: [] },
    // Wellness chat only receives a StopCode summary when the user opts in.
    chat: { shareSummary: false },
    advice: { enabled: true, minIntervalMinutes: 20 },
    clockOut: { lastQuietMinutes: 30, lastProtect: false },
  };
}

function defaultState(now) {
  const at = now || new Date().toISOString();
  return {
    version: SCHEMA_VERSION,
    createdAt: at,
    updatedAt: at,
    settings: defaultSettings(),
    projects: {},
    missions: {},
    sessions: {},
    handoffs: [],
    breaks: [],
    planner: { events: [] },
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function migrate(input) {
  const base = defaultState();
  if (!isObject(input)) return base;
  const state = { ...base, ...input };
  state.version = SCHEMA_VERSION;
  state.settings = { ...base.settings, ...(isObject(input.settings) ? input.settings : {}) };
  if (!isObject(state.settings.workingHours)) state.settings.workingHours = defaultWorkingHours();
  if (!isObject(state.settings.calendarQuietHours)) state.settings.calendarQuietHours = base.settings.calendarQuietHours;
  if (!Array.isArray(state.settings.calendarQuietHours.projectIds)) state.settings.calendarQuietHours.projectIds = [];
  if (!isObject(state.settings.chat)) state.settings.chat = base.settings.chat;
  if (!isObject(state.settings.advice)) state.settings.advice = base.settings.advice;
  if (!isObject(state.settings.clockOut)) state.settings.clockOut = base.settings.clockOut;
  if (!state.settings.timezone || typeof state.settings.timezone !== 'string') state.settings.timezone = systemTimezone();
  if (!isObject(state.projects)) state.projects = {};
  if (!isObject(state.missions)) state.missions = {};
  if (!isObject(state.sessions)) state.sessions = {};
  if (!Array.isArray(state.handoffs)) state.handoffs = [];
  if (!Array.isArray(state.breaks)) state.breaks = [];
  if (!isObject(state.planner)) state.planner = { events: [] };
  if (!Array.isArray(state.planner.events)) state.planner.events = [];
  for (const project of Object.values(state.projects)) {
    if (!isObject(project.monitoring)) project.monitoring = { paused: false, pausedAt: null };
    if (!Array.isArray(project.quietHistory)) project.quietHistory = [];
    if (!isObject(project.counters)) project.counters = { toolEvents: 0, afterHoursEvents: 0, prompts: 0 };
    if (!isObject(project.advice)) project.advice = { lastAt: null, dismissedUntil: null };
  }
  for (const mission of Object.values(state.missions)) {
    if (!Array.isArray(mission.criteria)) mission.criteria = [];
    if (!Array.isArray(mission.evidence)) mission.evidence = [];
    if (!Array.isArray(mission.acceptedAdditions)) mission.acceptedAdditions = [];
    if (!Array.isArray(mission.deferredIdeas)) mission.deferredIdeas = [];
    if (!Array.isArray(mission.scopeNotes)) mission.scopeNotes = [];
    if (!Array.isArray(mission.sessionIds)) mission.sessionIds = [];
    if (!Array.isArray(mission.handoffIds)) mission.handoffIds = [];
    for (const c of mission.criteria) {
      if (!Array.isArray(c.evidenceIds)) c.evidenceIds = [];
      if (!c.status) c.status = 'not_started';
    }
  }
  return state;
}

module.exports = { SCHEMA_VERSION, defaultState, defaultSettings, defaultWorkingHours, migrate };
