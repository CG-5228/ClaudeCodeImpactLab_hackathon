// Planner: time zone, working hours, the calendar-quiet-hours opt-in and a 7-day agenda
// of planned blocks. Overlaps are always shown and never resolved silently.
import { h, icon, chip, btn, linkBtn, notice, fieldError, skeletonCard, withBusy, preserveFocus, clear, append } from '../dom.js';
import { fmtTime, fmtDateTime, fmtDayHeading, startOfLocalDay, addLocalDays, zonedToUtc, ymdInTz, hmInTz, combineLocal, toMs } from '../time.js';
import { api, errorText } from '../api.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { store } from '../store.js';

export const id = 'planner';
export const title = 'Planner';

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const TYPES = [['recovery', 'Recovery'], ['work', 'Work'], ['personal', 'Personal']];

let container = null;
let settings = null;
let events = null;
let loadError = null;
let whDraft = null;
let tzDraft = null;
let hoursDirty = false;
let hoursError = null;
let form = null; // { mode: add|edit|move, eventId, originalTitle, values, fieldErrors, error, conflict }

export function enter(c) {
  container = c;
  render();
  load();
}

export function leave() {
  container = null;
}

export function update() {
  // Planner data is loaded on enter and after each action; polling does not affect it.
}

function cloneHours(wh) {
  const out = {};
  for (const [key] of DAYS) out[key] = Array.isArray(wh && wh[key]) ? wh[key].map((b) => ({ start: b.start, end: b.end })) : [];
  return out;
}

async function load() {
  loadError = null;
  try {
    settings = await api.settings();
    const tz = settings.timezone;
    const now = new Date().toISOString();
    const from = startOfLocalDay(now, tz);
    const to = zonedToUtc(addLocalDays(now, tz, 7), tz);
    events = await api.planner(from, to);
    if (!hoursDirty) {
      whDraft = cloneHours(settings.workingHours);
      tzDraft = settings.timezone;
    }
  } catch (e) {
    loadError = e;
  }
  render();
}

function render() {
  if (!container) return;
  preserveFocus(container, () => {
    clear(container);
    if (loadError) {
      append(container, notice('danger', 'Could not load the planner', h('span', null, errorText(loadError)), h('div', { class: 'actions' }, btn('Retry', { iconName: 'refresh', onClick: load }))));
      return;
    }
    if (!settings || !events) {
      append(container, h('div', { class: 'stack', role: 'status', 'aria-label': 'Loading planner' }, skeletonCard(4), skeletonCard(3)));
      return;
    }
    append(container, h('div', { class: 'stack' }, agendaCard(), hoursCard(), calendarQuietCard()));
  });
}

// ---------- time zone + working hours ----------

function addMinutes(hm, mins) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  if (!m) return '17:00';
  const total = Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]) + mins);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function tzInput() {
  let zones = [];
  if (typeof Intl.supportedValuesOf === 'function') {
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch (e) {
      zones = [];
    }
  }
  if (!zones.length) {
    return h('input', {
      id: 'tz-input',
      class: 'input',
      type: 'text',
      value: tzDraft || '',
      placeholder: 'e.g. Europe/Lisbon',
      autocomplete: 'off',
      onInput: (e) => {
        tzDraft = e.target.value.trim();
        hoursDirty = true;
      },
    });
  }
  if (tzDraft && !zones.includes(tzDraft)) zones = [tzDraft, ...zones];
  const select = h('select', { id: 'tz-input', class: 'input', onChange: (e) => { tzDraft = e.target.value; hoursDirty = true; } }, ...zones.map((z) => h('option', { value: z }, z)));
  select.value = tzDraft || '';
  return select;
}

function dayRow(key, label) {
  const blocks = whDraft[key] || [];
  const list = h('div', { class: 'wh-blocks' });
  if (!blocks.length) append(list, h('span', { class: 'wh-none' }, 'No working hours: the whole day counts as after hours.'));
  blocks.forEach((b, i) => {
    const start = h('input', { id: `wh-${key}-${i}-start`, class: 'input', type: 'time', step: '60', value: b.start, 'aria-label': `${label} block ${i + 1} start`, onChange: (e) => { whDraft[key][i].start = e.target.value; hoursDirty = true; } });
    const end = h('input', { id: `wh-${key}-${i}-end`, class: 'input', type: 'time', step: '60', value: b.end, 'aria-label': `${label} block ${i + 1} end`, onChange: (e) => { whDraft[key][i].end = e.target.value; hoursDirty = true; } });
    const remove = btn('Remove', {
      size: 'sm',
      iconName: 'x',
      onClick: () => {
        whDraft[key].splice(i, 1);
        hoursDirty = true;
        render();
      },
    });
    append(list, h('div', { class: 'wh-block' }, start, h('span', { class: 'muted' }, 'to'), end, remove));
  });
  if (blocks.length < 4) {
    append(list, 
      h(
        'div',
        null,
        btn('Add block', {
          size: 'sm',
          iconName: 'plus',
          onClick: () => {
            const last = blocks[blocks.length - 1];
            whDraft[key].push(last ? { start: addMinutes(last.end, 60), end: addMinutes(last.end, 120) } : { start: '09:00', end: '17:30' });
            hoursDirty = true;
            render();
          },
        })
      )
    );
  }
  return h('div', { class: 'wh-day' }, h('span', { class: 'wh-day-name' }, label), list);
}

function hoursCard() {
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-hours' },
    h('h2', { id: 'h-hours', class: 'card-title' }, icon('clock'), 'Time zone and working hours'),
    h('p', { class: 'card-sub' }, 'Working hours define what counts as after hours and the "until next working block" quiet option. They never block anything by themselves.')
  );
  append(card, h('div', { class: 'tz-row' }, h('div', { class: 'field' }, h('label', { for: 'tz-input' }, 'Time zone (IANA)'), tzInput())));
  append(card, h('div', null, ...DAYS.map(([key, label]) => dayRow(key, label))));
  if (hoursError) append(card, h('div', { class: 'form-error', role: 'alert' }, icon('alert'), h('span', null, hoursError)));
  const save = btn('Save time zone and hours', { variant: 'primary', iconName: 'check', onClick: () => saveHours(save) });
  const discard = btn('Discard changes', {
    disabled: !hoursDirty,
    onClick: () => {
      whDraft = cloneHours(settings.workingHours);
      tzDraft = settings.timezone;
      hoursDirty = false;
      hoursError = null;
      render();
    },
  });
  append(card, h('div', { class: 'actions' }, save, discard));
  return card;
}

async function saveHours(button) {
  hoursError = null;
  for (const [key, label] of DAYS) {
    for (const b of whDraft[key] || []) {
      if (!b.start || !b.end) {
        hoursError = `${label}: every block needs a start and an end time.`;
        render();
        return;
      }
      if (b.end <= b.start) {
        hoursError = `${label}: end must be after start.`;
        render();
        return;
      }
    }
  }
  if (!tzDraft) {
    hoursError = 'Choose a time zone.';
    render();
    return;
  }
  try {
    const res = await withBusy(button, 'Saving', () => api.patchSettings({ timezone: tzDraft, workingHours: whDraft }));
    settings = res.settings;
    hoursDirty = false;
    whDraft = cloneHours(settings.workingHours);
    tzDraft = settings.timezone;
    toast('Time zone and working hours saved.', 'ok');
    store.refresh();
    await load();
  } catch (e) {
    hoursError = errorText(e);
    render();
  }
}

// ---------- calendar quiet hours ----------

function calendarQuietCard() {
  const cq = settings.calendarQuietHours || { enabled: false, projectIds: [] };
  const projects = (store.get().overview && store.get().overview.projects) || [];
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-calq' }, h('h2', { id: 'h-calq', class: 'card-title' }, icon('moon'), 'Calendar events activate quiet hours'));
  const toggle = h('input', { id: 'calq-enabled', type: 'checkbox', checked: !!cq.enabled, onChange: (e) => saveCalendarQuiet(e.target, { enabled: e.target.checked, projectIds: cq.projectIds }) });
  append(card, 
    h('label', { class: 'check', for: 'calq-enabled' }, toggle, h('span', null, 'Calendar events activate quiet hours')),
    h('p', { class: 'check-desc' }, 'While a recovery or personal block from this planner is running, the StopCode hook blocks new coding actions in the selected projects. An explicit override lifts it for that block.'),
    notice('info', null, h('span', null, 'Planning a break alone never blocks coding; only this toggle does, and only for the selected projects.'))
  );
  const fs = h('fieldset', null, h('legend', null, 'Projects covered'));
  if (!projects.length) append(fs, h('p', { class: 'muted' }, 'No StopCode projects yet. Projects appear once a mission is started from Claude Code.'));
  for (const p of projects) {
    const cid = `calq-${p.id}`;
    const box = h('input', {
      id: cid,
      type: 'checkbox',
      checked: cq.projectIds.includes(p.id),
      disabled: !cq.enabled,
      onChange: (e) => {
        const ids = new Set(cq.projectIds);
        if (e.target.checked) ids.add(p.id);
        else ids.delete(p.id);
        saveCalendarQuiet(e.target, { enabled: cq.enabled, projectIds: [...ids] });
      },
    });
    append(fs, h('label', { class: 'check', for: cid }, box, h('span', null, p.name, ' ', h('span', { class: 'meta mono' }, p.root))));
  }
  if (!cq.enabled && projects.length) append(fs, h('p', { class: 'hint' }, 'Turn the toggle on to choose projects.'));
  append(card, fs);
  return card;
}

async function saveCalendarQuiet(input, value) {
  input.disabled = true;
  try {
    const res = await api.patchSettings({ calendarQuietHours: value });
    settings = res.settings;
    const cq = settings.calendarQuietHours;
    toast(cq.enabled ? `Calendar quiet hours on for ${cq.projectIds.length} project${cq.projectIds.length === 1 ? '' : 's'}.` : 'Calendar quiet hours off.', 'ok');
    store.refresh();
  } catch (e) {
    toast(errorText(e), 'danger');
  }
  render();
}

// ---------- agenda ----------

function slug(text) {
  return String(text || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
}

function agendaCard() {
  const tz = settings.timezone;
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-agenda' },
    h('h2', { id: 'h-agenda', class: 'card-title' }, icon('calendar'), 'Next 7 days'),
    h('p', { class: 'card-sub' }, `Blocks you plan explicitly (recovery, personal, work), shown in ${tz}.`)
  );
  const addBtn = btn('Add block', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !!(form && form.mode === 'add'),
    onClick: () => {
      form = newForm();
      render();
      focusForm('title');
    },
  });
  append(card, 
    h('div', { class: 'row row-between' }, h('div', { class: 'actions' }, addBtn, linkBtn('Export all (.ics)', api.plannerIcsUrl(), { iconName: 'download', download: 'stopcode-planner.ics' })), h('span', { class: 'meta' }, `${events.length} event${events.length === 1 ? '' : 's'} in the next 7 days`)),
    notice('info', null, h('span', null, 'Downloading an .ics file is not the same as importing it: open it in your calendar app. The export does not block your availability elsewhere and later edits here are not synchronized.'))
  );
  if (form && form.mode === 'add') append(card, eventForm());
  const now = new Date().toISOString();
  const todayKey = ymdInTz(now, tz);
  const agenda = h('div', { class: 'agenda' });
  for (let d = 0; d < 7; d++) {
    const dayStart = zonedToUtc(addLocalDays(now, tz, d), tz);
    const dayKey = ymdInTz(dayStart, tz);
    const dayEvents = events.filter((e) => {
      const key = ymdInTz(e.start, tz);
      return (key < todayKey ? todayKey : key) === dayKey;
    });
    const label = fmtDayHeading(dayStart, tz);
    const block = h('section', { class: 'agenda-day', 'aria-label': label }, h('h3', null, label, d === 0 ? chip('today', 'progress') : null));
    if (!dayEvents.length) append(block, h('p', { class: 'muted' }, 'Nothing planned.'));
    for (const e of dayEvents) append(block, form && form.eventId === e.id ? eventForm() : eventRow(e));
    append(agenda, block);
  }
  append(card, agenda);
  return card;
}

function eventRow(e) {
  const tz = settings.timezone;
  const multiDay = ymdInTz(e.start, tz) !== ymdInTz(e.end, tz);
  const time = h('span', { class: 'time' }, `${fmtTime(e.start, tz)}-${multiDay ? fmtDateTime(e.end, tz) : fmtTime(e.end, tz)}`);
  const body = h(
    'div',
    { class: 'body' },
    h('span', { class: 'title' }, chip(e.type, e.type), e.title),
    e.notes ? h('span', { class: 'meta' }, e.notes) : null,
    e.overlaps && e.overlaps.length ? h('span', { class: 'meta text-warn' }, icon('alert', { size: 12 }), ` overlaps: ${e.overlaps.map((o) => o.title).join(', ')}`) : null
  );
  const edit = btn('Edit', {
    size: 'sm',
    iconName: 'edit',
    onClick: () => {
      form = formFromEvent(e, 'edit');
      render();
      focusForm('title');
    },
  });
  const move = btn('Move', {
    size: 'sm',
    iconName: 'move',
    onClick: () => {
      form = formFromEvent(e, 'move');
      render();
      focusForm('date');
    },
  });
  const del = btn('Delete', { size: 'sm', variant: 'danger', iconName: 'trash', onClick: () => deleteEvent(del, e) });
  const exportBtn = linkBtn('Export (.ics)', api.eventIcsUrl(e.id), { size: 'sm', iconName: 'download', download: `${slug(e.title)}.ics` });
  return h('div', { class: 'event' }, time, body, h('div', { class: 'actions' }, edit, move, del, exportBtn));
}

function newForm() {
  const tz = settings.timezone;
  const nextHour = new Date(Math.ceil(Date.now() / 3600000) * 3600000);
  return {
    mode: 'add',
    eventId: null,
    originalTitle: null,
    values: { title: '', type: 'recovery', date: ymdInTz(nextHour, tz), start: hmInTz(nextHour, tz), end: hmInTz(new Date(nextHour.getTime() + 30 * 60000), tz), notes: '' },
    fieldErrors: {},
    error: null,
    conflict: null,
  };
}

function formFromEvent(e, mode) {
  const tz = settings.timezone;
  return {
    mode,
    eventId: e.id,
    originalTitle: e.title,
    values: { title: e.title, type: e.type, date: ymdInTz(e.start, tz), start: hmInTz(e.start, tz), end: hmInTz(e.end, tz), notes: e.notes || '' },
    fieldErrors: {},
    error: null,
    conflict: null,
  };
}

function formPrefix() {
  return form.mode === 'add' ? 'ev-new' : `ev-${form.eventId}`;
}

function focusForm(name) {
  const el = document.getElementById(`${formPrefix()}-${name}`);
  if (el) el.focus();
}

function eventForm() {
  const f = form;
  const vals = f.values;
  const prefix = formPrefix();
  const errId = (name) => (f.fieldErrors[name] ? `${prefix}-${name}-err` : null);
  const field = (name, label, input) => h('div', { class: 'field' }, h('label', { for: `${prefix}-${name}` }, label), input, f.fieldErrors[name] ? fieldError(errId(name), f.fieldErrors[name]) : null);
  const input = (name, type, extra = {}) =>
    h('input', {
      id: `${prefix}-${name}`,
      class: 'input',
      type,
      value: vals[name],
      'aria-invalid': f.fieldErrors[name] ? 'true' : null,
      'aria-describedby': errId(name),
      onInput: (e) => {
        vals[name] = e.target.value;
      },
      ...extra,
    });
  const typeSelect = h('select', { id: `${prefix}-type`, class: 'input', value: vals.type, onChange: (e) => { vals.type = e.target.value; } }, ...TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const notes = h('textarea', { id: `${prefix}-notes`, class: 'input', rows: '2', maxlength: '500', value: vals.notes, onInput: (e) => { vals.notes = e.target.value; } });
  const save = btn(f.mode === 'add' ? 'Add block' : f.mode === 'move' ? 'Move' : 'Save', { variant: 'primary', iconName: 'check', onClick: () => submitForm(save, false) });
  const cancel = btn('Cancel', {
    onClick: () => {
      form = null;
      render();
    },
  });
  const heading = f.mode === 'add' ? 'New block' : f.mode === 'move' ? `Move "${f.originalTitle}"` : `Edit "${f.originalTitle}"`;
  return h(
    'div',
    { class: 'event-form', role: 'group', 'aria-label': heading },
    h('h3', null, heading),
    h(
      'div',
      { class: 'form-grid form-grid-3' },
      field('title', 'Title', input('title', 'text', { maxlength: '120' })),
      field('type', 'Type', typeSelect),
      field('date', 'Date', input('date', 'date')),
      field('start', 'Start', input('start', 'time', { step: '60' })),
      field('end', 'End', input('end', 'time', { step: '60' })),
      h('div', { class: 'field span-3' }, h('label', { for: `${prefix}-notes` }, 'Notes (optional)'), notes)
    ),
    h('p', { class: 'hint' }, `Times are wall-clock in ${settings.timezone}. An end time earlier than the start means the block ends the next day.`),
    f.error ? h('div', { class: 'form-error', role: 'alert' }, icon('alert'), h('span', null, f.error)) : null,
    f.conflict ? conflictBlock() : null,
    h('div', { class: 'actions' }, save, cancel)
  );
}

function conflictBlock() {
  const tz = settings.timezone;
  const keep = btn('Keep both', { iconName: 'check', onClick: () => submitForm(keep, true) });
  const change = btn('Change time', {
    iconName: 'clock',
    onClick: () => {
      form.conflict = null;
      render();
      focusForm('start');
    },
  });
  return notice(
    'warn',
    'This block overlaps existing events',
    h('ul', { class: 'overlap-list' }, ...form.conflict.overlaps.map((o) => h('li', null, `${o.title} (${o.type}) ${fmtDateTime(o.start, tz)} - ${fmtTime(o.end, tz)}`))),
    h('span', null, 'Nothing was saved. Keep both as they are, or change the time.'),
    h('div', { class: 'actions' }, keep, change)
  );
}

async function submitForm(button, allowOverlap) {
  const f = form;
  const vals = f.values;
  const tz = settings.timezone;
  f.error = null;
  f.fieldErrors = {};
  if (!vals.title.trim()) f.fieldErrors.title = 'Title is required.';
  if (!vals.date) f.fieldErrors.date = 'Choose a date.';
  const startIso = combineLocal(vals.date, vals.start, tz);
  let endIso = combineLocal(vals.date, vals.end, tz);
  if (!startIso) f.fieldErrors.start = 'Choose a start time.';
  if (!endIso) f.fieldErrors.end = 'Choose an end time.';
  if (startIso && endIso && toMs(endIso) <= toMs(startIso)) {
    // Overnight block: the end belongs to the next local day.
    const next = addLocalDays(startIso, tz, 1);
    endIso = combineLocal(`${next.year}-${String(next.month).padStart(2, '0')}-${String(next.day).padStart(2, '0')}`, vals.end, tz);
    if (!endIso || toMs(endIso) <= toMs(startIso)) f.fieldErrors.end = 'End must be after start.';
  }
  if (Object.keys(f.fieldErrors).length) {
    render();
    focusForm(Object.keys(f.fieldErrors)[0]);
    return;
  }
  const payload = { title: vals.title.trim(), type: vals.type, start: startIso, end: endIso, notes: vals.notes.trim() || undefined, allowOverlap: allowOverlap || undefined };
  try {
    const res = await withBusy(button, 'Saving', () => (f.mode === 'add' ? api.createEvent(payload) : api.updateEvent(f.eventId, payload)));
    const kept = res && res.overlaps && res.overlaps.length ? ` Kept alongside ${res.overlaps.length} overlapping event${res.overlaps.length === 1 ? '' : 's'}.` : '';
    toast(`${f.mode === 'add' ? 'Block added.' : f.mode === 'move' ? 'Block moved.' : 'Block saved.'}${kept}`, 'ok');
    form = null;
    store.refresh();
    await load();
  } catch (e) {
    if (e.status === 409) f.conflict = { overlaps: e.overlaps || [] };
    else if (e.field && ['title', 'type', 'start', 'end', 'notes', 'date'].includes(e.field)) f.fieldErrors[e.field] = e.message;
    else f.error = errorText(e);
    render();
  }
}

async function deleteEvent(button, e) {
  const tz = settings.timezone;
  const ok = await confirmDialog({ title: 'Delete this block?', message: `"${e.title}" (${fmtDateTime(e.start, tz)} - ${fmtTime(e.end, tz)}) will be removed from the planner.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await withBusy(button, 'Deleting', () => api.deleteEvent(e.id));
    toast('Block deleted.', 'ok');
    store.refresh();
    await load();
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}
