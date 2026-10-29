'use strict';
// Calendar planner: working-hour blocks, recovery blocks and personal time. Events are
// stored as UTC instants with stable ids. Overlaps are reported, never resolved silently.
const { randomId } = require('./ids');
const V = require('./validate');
const T = require('./time');

const EVENT_TYPES = ['work', 'recovery', 'personal'];
const MAX_EVENTS = 2000;
const MAX_DURATION_MS = 7 * 24 * 3600000;

class PlannerConflict extends Error {
  constructor(message, overlaps) {
    super(message);
    this.name = 'PlannerConflict';
    this.status = 409;
    this.overlaps = overlaps;
  }
}

function brief(e) {
  return { id: e.id, title: e.title, type: e.type, start: e.start, end: e.end };
}

function rangesOverlap(a, b) {
  return T.toMs(a.start) < T.toMs(b.end) && T.toMs(b.start) < T.toMs(a.end);
}

function findOverlaps(events, candidate, excludeId) {
  return events.filter((e) => e.id !== excludeId && rangesOverlap(e, candidate)).map(brief);
}

function normalize(input, existing) {
  const base = existing || {};
  const title = input.title !== undefined ? V.str(input.title, 'title', { max: 120 }) : base.title;
  const type = input.type !== undefined ? V.oneOf(input.type, 'type', EVENT_TYPES) : base.type;
  const start = input.start !== undefined ? V.isoDate(input.start, 'start') : base.start;
  const end = input.end !== undefined ? V.isoDate(input.end, 'end') : base.end;
  const notes = input.notes !== undefined ? V.str(input.notes, 'notes', { optional: true, max: 500 }) || null : base.notes || null;
  if (!title) throw new V.ValidationError('title is required', 'title');
  if (!type) throw new V.ValidationError('type is required', 'type');
  if (!start || !end) throw new V.ValidationError('start and end are required', 'start');
  const dur = T.toMs(end) - T.toMs(start);
  if (dur <= 0) throw new V.ValidationError('end must be after start', 'end');
  if (dur > MAX_DURATION_MS) throw new V.ValidationError('an event may last at most 7 days', 'end');
  return { title, type, start, end, notes };
}

class Planner {
  constructor(stopcode) {
    this.sc = stopcode;
  }

  list({ from, to } = {}) {
    const state = this.sc.readState();
    const events = state.planner.events.slice().sort((a, b) => T.toMs(a.start) - T.toMs(b.start));
    const f = from ? T.toMs(V.isoDate(from, 'from')) : -Infinity;
    const t = to ? T.toMs(V.isoDate(to, 'to')) : Infinity;
    const inRange = events.filter((e) => T.toMs(e.end) > f && T.toMs(e.start) < t);
    return inRange.map((e) => ({ ...e, overlaps: findOverlaps(events, e, e.id) }));
  }

  get(id) {
    const state = this.sc.readState();
    const e = state.planner.events.find((x) => x.id === id);
    if (!e) throw new V.ValidationError(`planner event not found: ${id}`, 'id');
    return e;
  }

  create(input, { allowOverlap = false } = {}) {
    const data = normalize(input);
    return this.sc.store.update((state) => {
      if (state.planner.events.length >= MAX_EVENTS) throw new V.ValidationError('planner is full (2000 events)', 'events');
      const overlaps = findOverlaps(state.planner.events, data);
      if (overlaps.length && !allowOverlap) throw new PlannerConflict('This block overlaps existing events. Choose to keep both or change the time.', overlaps);
      const now = this.sc.now();
      const ev = { id: randomId('plan', 5), ...data, createdAt: now, updatedAt: now, sequence: 0 };
      state.planner.events.push(ev);
      return { ok: true, event: ev, overlaps };
    });
  }

  update(id, patch, { allowOverlap = false } = {}) {
    return this.sc.store.update((state) => {
      const ev = state.planner.events.find((x) => x.id === id);
      if (!ev) throw new V.ValidationError(`planner event not found: ${id}`, 'id');
      const data = normalize(patch || {}, ev);
      const overlaps = findOverlaps(state.planner.events, data, id);
      if (overlaps.length && !allowOverlap) throw new PlannerConflict('The new time overlaps existing events. Choose to keep both or pick another time.', overlaps);
      Object.assign(ev, data, { updatedAt: this.sc.now(), sequence: (ev.sequence || 0) + 1 });
      return { ok: true, event: ev, overlaps };
    });
  }

  remove(id) {
    return this.sc.store.update((state) => {
      const idx = state.planner.events.findIndex((x) => x.id === id);
      if (idx < 0) throw new V.ValidationError(`planner event not found: ${id}`, 'id');
      const [removed] = state.planner.events.splice(idx, 1);
      return { ok: true, removed: brief(removed) };
    });
  }
}

module.exports = { Planner, PlannerConflict, EVENT_TYPES, findOverlaps, rangesOverlap };
