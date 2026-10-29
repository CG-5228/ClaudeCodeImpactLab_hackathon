// Today view: mission, recommendation, workload signals, breaks, ideas, additions, quiet
// hours, handoff, integration self-check and timeline, plus the Clock out dialog and the
// parked screen shown after clocking out. Everything rendered comes from the API payloads.
import { h, icon, chip, statusChip, btn, linkBtn, emptyState, notice, fieldError, skeletonCard, withBusy, copyText, preserveFocus, uid, plural, clear, append } from '../dom.js';
import { fmtTime, fmtDateTime, humanDuration } from '../time.js';
import { api, errorText } from '../api.js';
import { toast } from '../toast.js';
import { openDialog, confirmDialog, showMarkdown } from '../dialog.js';
import { store } from '../store.js';

let container = null;
let ctx = null;
let parked = null; // last clock-out response (shown as the parked screen)
const drafts = {}; // input id -> text typed so far (survives polling re-renders)
const formErrors = {};
let editingNext = false;
let quietFormOpen = false;

export const id = 'today';
export const title = 'Today';

export function enter(c, context) {
  container = c;
  ctx = context;
}

export function leave() {
  container = null;
}

export function update(state) {
  if (!container) return;
  preserveFocus(container, () => render(state));
}

function rerender() {
  if (container) update(store.get());
}

// Runs an action with spinner text on the button; polling pauses meanwhile and data is
// refreshed afterwards. Returns {ok, result|error} instead of throwing.
function run(button, label, fn, { success, onError } = {}) {
  return store.act(async () => {
    try {
      const result = await withBusy(button, label, fn);
      if (success) toast(typeof success === 'function' ? success(result) : success, 'ok');
      return { ok: true, result };
    } catch (e) {
      if (onError) onError(e);
      else toast(errorText(e), 'danger');
      return { ok: false, error: e };
    }
  });
}

// ---------- render root ----------

function render(state) {
  clear(container);
  if (parked && parked.projectId === state.projectId) {
    container.appendChild(renderParked());
    return;
  }
  if (!state.overview) {
    container.appendChild(renderSkeleton());
    return;
  }
  if (!state.projectId) {
    container.appendChild(renderNoProject(state));
    return;
  }
  if (!state.view) {
    container.appendChild(state.viewError ? renderViewError(state) : renderSkeleton());
    return;
  }
  const v = state.view;
  container.appendChild(projectStrip(v));
  container.appendChild(
    h(
      'div',
      { class: 'cards' },
      missionCard(v),
      recommendationCard(v),
      workloadCard(v),
      breakCard(v),
      quietCard(v),
      ideasCard(v),
      additionsCard(v),
      handoffCard(v),
      integrationCard(v, state.overview),
      timelineCard(v)
    )
  );
}

function renderSkeleton() {
  return h('div', { class: 'cards', role: 'status', 'aria-label': 'Loading dashboard data' }, skeletonCard(4), skeletonCard(3), skeletonCard(3), skeletonCard(2));
}

function renderNoProject(state) {
  const doc = state.overview && state.overview.doctor;
  const cmd = doc && doc.plugin && doc.plugin.loadCommand ? doc.plugin.loadCommand : 'claude --plugin-dir <path-to-stopcode>';
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'h-none' },
      h('h2', { id: 'h-none', class: 'card-title' }, icon('target'), 'No StopCode project yet'),
      h('p', null, 'StopCode starts tracking a project when you record a mission from Claude Code. Until then nothing is captured and there is nothing to show.'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', null, '1. Load the plugin: ', h('code', { class: 'mono break-word' }, cmd)),
        h('li', null, '2. Inside your project run ', h('code', null, '/stopcode:start <goal>'), ' to record the original objective and its completion criteria.'),
        h('li', null, '3. Come back here: Today shows the mission, workload signals from real hook events, and the Clock out button.')
      ),
      h('p', { class: 'meta' }, 'The wellness chat and the planner work without a project.')
    )
  );
}

function renderViewError(state) {
  const retry = btn('Retry', { iconName: 'refresh', onClick: () => store.refresh() });
  return notice('danger', 'Could not load this project', h('span', null, errorText(state.viewError)), h('div', { class: 'actions' }, retry));
}

function projectStrip(v) {
  return h(
    'div',
    { class: 'project-strip' },
    h('span', null, 'Project ', h('strong', null, v.project.name)),
    h('span', { class: 'mono' }, v.project.root),
    h('span', { class: 'meta' }, `Times shown in ${v.timezone}`)
  );
}

// ---------- mission ----------

function missionCard(v) {
  const tz = v.timezone;
  const m = v.mission;
  const card = h('section', { class: 'card card-wide', 'aria-labelledby': 'h-mission' }, h('h2', { id: 'h-mission', class: 'card-title' }, icon('target'), 'Mission'));
  if (!m) {
    append(card, emptyState('No mission recorded for this project.', 'Start one from Claude Code with /stopcode:start <goal> (or stopcode start "<goal>"). StopCode keeps the original objective visible here and never rewrites it.'));
    return card;
  }
  const missionState = m.status === 'completed' ? 'completed' : m.parkedAt ? 'parked' : 'active';
  const c = m.completion;
  append(card, 
    h('div', { class: 'stack-sm' }, h('span', { class: 'label' }, 'Original objective (immutable)'), h('p', { class: 'objective' }, m.objective)),
    h(
      'div',
      { class: 'chips' },
      chip(missionState, missionState === 'parked' ? 'parked' : missionState === 'completed' ? 'verified' : 'progress'),
      chip(`${c.verifiedCount} of ${c.total} verified`, 'muted'),
      c.reportedCount ? chip(`${c.reportedCount} reported, unverified`, 'reported') : null,
      c.blockedCount ? chip(`${c.blockedCount} blocked`, 'blocked') : null,
      m.budgetMinutes ? chip(`budget ${m.budgetMinutes} min (advisory)`, 'muted') : null
    ),
    h('p', { class: `headline headline-${c.state}` }, icon(c.state === 'complete' ? 'check' : c.state === 'blocked' ? 'alert' : 'clock'), c.headline),
    m.userConfirmedComplete ? h('p', { class: 'meta' }, `You marked the mission complete on ${fmtDateTime(m.userConfirmedComplete.at, tz)} (user confirmation, separate from verification).`) : null
  );
  if (m.criteria.length) append(card, h('ol', { class: 'criteria' }, ...m.criteria.map((crit) => criterionItem(v, crit))));
  else append(card, emptyState('No completion criteria recorded.', 'Add one from Claude Code: stopcode criterion add "<text>". Without criteria, completion cannot be verified.'));
  append(card, nextStepBlock(v));
  append(card, h('p', { class: 'meta' }, `Started ${fmtDateTime(m.startedAt, tz)} - ${humanDuration(m.elapsedMs)} since the mission started (wall clock, not focused time).`));
  if (m.parkedAt) append(card, parkedNotice(v));
  return card;
}

function criterionItem(v, c) {
  const tz = v.timezone;
  const pid = v.project.id;
  const li = h('li', { class: 'criterion' }, h('div', { class: 'criterion-row' }, h('span', { class: 'criterion-text' }, c.text), statusChip(c.status), c.stale ? chip('stale', 'stale') : null));
  if (c.stale) append(li, h('p', { class: 'meta' }, 'Stale: files changed after the last passing check. Run the check again to re-verify.'));
  if (c.note) append(li, h('p', { class: 'meta' }, `Note: ${c.note}`));
  if (c.evidence && c.evidence.length) {
    append(li, 
      h(
        'ul',
        { class: 'evidence' },
        ...c.evidence.map((e) =>
          h('li', null, chip(`${String(e.kind).replace(/_/g, ' ')} / ${e.outcome}`, e.outcome === 'pass' ? 'verified' : e.outcome === 'fail' ? 'blocked' : 'muted'), h('span', null, e.summary), h('span', { class: 'meta' }, `${fmtDateTime(e.at, tz)} via ${e.source}`))
        )
      )
    );
  } else {
    append(li, h('p', { class: 'meta' }, 'No check recorded for this criterion.'));
  }
  if (c.userConfirmation) {
    append(li, h('p', { class: 'meta' }, icon('check', { size: 14 }), ` User-confirmed ${fmtDateTime(c.userConfirmation.at, tz)}${c.userConfirmation.note ? ' - ' + c.userConfirmation.note : ''} (your confirmation, not independent verification)`));
  }
  if (v.mission.status === 'active' && c.status !== 'verified' && !c.userConfirmation) {
    const confirmBtn = btn('I confirm this is done', {
      size: 'sm',
      iconName: 'check',
      onClick: () => run(confirmBtn, 'Saving', () => api.confirmCriterion(pid, c.id), { success: 'Recorded as your confirmation (labelled separately from verification).' }),
    });
    append(li, h('div', { class: 'actions' }, confirmBtn));
  }
  return li;
}

function nextStepBlock(v) {
  const m = v.mission;
  const pid = v.project.id;
  const wrap = h('div', { class: 'next-step' }, h('span', { class: 'label' }, 'Next step'));
  if (!editingNext) {
    const edit = btn('Set next action', {
      size: 'sm',
      iconName: 'edit',
      onClick: () => {
        editingNext = true;
        drafts['next-input'] = m.nextAction || '';
        rerender();
        const el = document.getElementById('next-input');
        if (el) el.focus();
      },
    });
    append(wrap, h('div', { class: 'row row-between' }, h('span', { class: 'value' }, m.nextStep || 'Not recorded'), m.status === 'active' ? edit : null));
    return wrap;
  }
  const input = h('input', {
    id: 'next-input',
    class: 'input',
    type: 'text',
    maxlength: '400',
    value: drafts['next-input'] || '',
    'aria-label': 'Next action',
    'aria-describedby': formErrors.next ? 'next-error' : null,
    'aria-invalid': formErrors.next ? 'true' : null,
    onInput: (e) => {
      drafts['next-input'] = e.target.value;
    },
  });
  const save = btn('Save', { variant: 'primary', onClick: () => submitNext(save, pid) });
  const cancel = btn('Cancel', {
    onClick: () => {
      editingNext = false;
      delete formErrors.next;
      rerender();
    },
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNext(save, pid);
    } else if (e.key === 'Escape') {
      editingNext = false;
      delete formErrors.next;
      rerender();
    }
  });
  append(wrap, h('div', { class: 'input-inline' }, input, save, cancel), formErrors.next ? fieldError('next-error', formErrors.next) : null);
  return wrap;
}

async function submitNext(button, pid) {
  const text = (drafts['next-input'] || '').trim();
  if (!text) {
    formErrors.next = 'Enter the next action first.';
    rerender();
    return;
  }
  const r = await run(button, 'Saving', () => api.setNext(pid, text), {
    success: 'Next action saved.',
    onError: (e) => {
      formErrors.next = errorText(e);
      rerender();
    },
  });
  if (r.ok) {
    editingNext = false;
    delete formErrors.next;
    delete drafts['next-input'];
  }
}

function parkedNotice(v) {
  const resume = btn('Resume', { iconName: 'play', onClick: () => resumeFlow(resume, { id: v.project.id, name: v.project.name }) });
  return notice('rest', `Parked at ${fmtDateTime(v.mission.parkedAt, v.timezone)}.`, h('span', null, 'Resume restores the latest handoff and clears the parked marker. Nothing starts automatically.'), h('div', { class: 'actions' }, resume));
}

async function resumeFlow(button, project) {
  const r = await run(button, 'Resuming', () => api.resume(project.id, {}));
  if (!r.ok) return;
  const res = r.result;
  if (res.blocked) {
    const ok = await confirmDialog({
      title: 'Quiet hours are active',
      message: res.message || `Quiet hours are active for ${project.name}.`,
      detail: h('p', { class: 'muted' }, 'Overriding lifts the boundary you chose for this project now. It is recorded as an explicit override; nothing is started automatically.'),
      confirmLabel: 'Override and resume',
      danger: true,
    });
    if (!ok) return;
    const r2 = await run(button, 'Resuming', () => api.resume(project.id, { override: true }));
    if (r2.ok) afterResume(r2.result);
    return;
  }
  afterResume(res);
}

function afterResume(res) {
  parked = null;
  toast(res.message || 'Resumed.', 'ok');
  rerender();
}

// ---------- recommendation ----------

function recommendationCard(v) {
  const r = v.recommendation || {};
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-reco' }, h('h2', { id: 'h-reco', class: 'card-title' }, icon(r.tone === 'nudge' ? 'alert' : 'info'), 'Recommendation'));
  append(card, h('p', { class: 'headline' }, r.title || 'No recommendation'), h('p', null, r.detail || ''));
  const actions = (r.actions || []).map((a) => recommendationAction(a, v)).filter(Boolean);
  if (actions.length) append(card, h('div', { class: 'actions' }, ...actions));
  append(card, h('p', { class: 'meta' }, 'Derived from recorded events only. Advice never blocks anything by itself.'));
  return card;
}

function recommendationAction(a, v) {
  if (a === 'clock_out') return btn('Clock out', { variant: 'primary', iconName: 'logout', onClick: () => openClockOut(store.get()) });
  if (a === 'start_break') {
    const b = btn('Start break', { iconName: 'coffee', onClick: () => run(b, 'Starting', () => api.startBreak(), { success: 'Break started.' }) });
    return b;
  }
  if (a === 'unpause') {
    const b = btn('Resume monitoring', { iconName: 'play', onClick: () => run(b, 'Resuming', () => api.monitoring(v.project.id, false), { success: 'Monitoring resumed.' }) });
    return b;
  }
  return null;
}

// ---------- workload ----------

function signal(label, value, meta, { tone = '', small = false } = {}) {
  return h('div', { class: `signal${tone ? ' signal-' + tone : ''}` }, h('dt', null, label), h('dd', { class: small ? 'small' : null }, value), meta ? h('span', { class: 'meta' }, meta) : null);
}

function workloadCard(v) {
  const s = v.session;
  const a = v.activity;
  const integ = v.integration;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-work' }, h('h2', { id: 'h-work', class: 'card-title' }, icon('activity'), 'Workload signals'));
  append(card, 
    h(
      'dl',
      { class: 'signals' },
      signal('Session elapsed', s ? humanDuration(s.elapsedMs) : 'none', s ? 'elapsed, wall clock - not focused time' : 'no active coding session', { tone: s && s.likelyStale ? 'warn' : '' }),
      signal('Tool actions today', String(a.toolEventsToday), 'from Claude Code hook events'),
      signal('Edits today', String(a.editsToday), 'Edit, Write, MultiEdit, NotebookEdit'),
      signal('After-hours events today', String(a.afterHoursToday), 'outside your working hours', { tone: a.afterHoursToday > 0 ? 'warn' : '' }),
      signal('Time since last break', v.breaks.sinceLastBreakLabel, v.breaks.recorded ? `${plural(v.breaks.recorded, 'break')} recorded` : 'StopCode only knows about breaks you record', { small: true }),
      signal('Latest integration event', integ.lastHookEvent ? integ.lastHookEvent.event : 'No activity observed yet', integ.lastHookEvent ? integ.lastHookAge : 'Start Claude Code with the plugin loaded.', { tone: integ.lastHookEvent ? 'info' : '', small: true })
    )
  );
  if (s && s.likelyStale) append(card, h('p', { class: 'meta' }, `No activity for a while (last seen ${s.lastSeenAge}); Claude Code may have exited without a SessionEnd event.`));
  const paused = !!(v.project.monitoring && v.project.monitoring.paused);
  const toggle = btn(paused ? 'Resume monitoring' : 'Pause monitoring', {
    size: 'sm',
    iconName: paused ? 'play' : 'pause',
    onClick: () => run(toggle, paused ? 'Resuming' : 'Pausing', () => api.monitoring(v.project.id, !paused), { success: paused ? 'Monitoring resumed.' : 'Monitoring paused. Coding is not blocked.' }),
  });
  append(card, 
    h(
      'div',
      { class: 'row row-between' },
      h('span', { class: 'meta' }, paused ? `Monitoring paused since ${fmtDateTime(v.project.monitoring.pausedAt, v.timezone)} - no capture or advice; coding is not blocked.` : 'Monitoring active: activity capture and advice are on.'),
      toggle
    )
  );
  return card;
}

// ---------- breaks ----------

function breakCard(v) {
  const b = v.breaks;
  const tz = v.timezone;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-break' }, h('h2', { id: 'h-break', class: 'card-title' }, icon('coffee'), 'Break control'));
  if (b.onBreak) {
    append(card, h('p', { class: 'headline' }, `On a break since ${fmtTime(b.currentBreak.startedAt, tz)}`), h('p', { class: 'muted' }, 'Breaks are about you, not a project. Ending it records the duration.'));
    const end = btn('End break', { variant: 'primary', iconName: 'play', onClick: () => run(end, 'Ending', () => api.endBreak(), { success: 'Break ended.' }) });
    append(card, h('div', { class: 'actions' }, end));
  } else {
    append(card, h('p', null, b.sinceLastBreakMs === null ? 'No break recorded yet, so the time since your last break is unknown.' : `Last recorded break ended ${humanDuration(b.sinceLastBreakMs)} ago (${fmtDateTime(b.lastBreakEndedAt, tz)}).`));
    const start = btn('Start break', { variant: 'primary', iconName: 'coffee', onClick: () => run(start, 'Starting', () => api.startBreak(), { success: 'Break started.' }) });
    append(card, h('div', { class: 'actions' }, start));
  }
  return card;
}

// ---------- quiet hours ----------

function quietCard(v) {
  const q = v.quiet;
  const tz = v.timezone;
  const pid = v.project.id;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-quiet' }, h('h2', { id: 'h-quiet', class: 'card-title' }, icon('moon'), 'Quiet hours'));
  if (q.active) {
    const sourceLabel = q.source === 'calendar' ? `calendar${q.calendarEventTitle ? ' - ' + q.calendarEventTitle : ''}` : q.source === 'clock_out' ? 'clock out' : q.source || 'unknown';
    append(card, 
      h('p', { class: 'headline' }, chip(q.protect ? 'blocking' : 'advisory', q.protect ? 'rest' : 'muted'), `Active until ${q.endsAtLocal || fmtDateTime(q.endsAt, tz)}`),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Interval'),
        h('dd', null, `${fmtDateTime(q.startsAt, tz)} - ${fmtDateTime(q.endsAt, tz)} (${humanDuration(q.remainingMs)} remaining)`),
        h('dt', null, 'Source'),
        h('dd', null, sourceLabel),
        h('dt', null, 'Enforcement'),
        h('dd', null, q.protect ? 'Blocking: the StopCode PreToolUse hook denies new coding actions in this project until the interval ends or you override it.' : 'Advisory only: nothing is blocked.'),
        h('dt', null, 'Override'),
        h('dd', null, q.overriddenAt ? `Overridden at ${fmtDateTime(q.overriddenAt, tz)}` : 'Not overridden'),
        h('dt', null, 'Planned restart'),
        h('dd', null, q.plannedRestartAt ? fmtDateTime(q.plannedRestartAt, tz) : 'not set'),
        h('dt', null, 'Covers'),
        h('dd', null, h('strong', null, q.projectName), ' ', h('span', { class: 'mono meta break-word' }, q.projectRoot))
      )
    );
    const override = btn('Override', {
      variant: 'danger',
      iconName: 'shield',
      onClick: async () => {
        const ok = await confirmDialog({ title: 'Override quiet hours?', message: `This lifts the boundary for ${q.projectName} now. It is recorded as an explicit override.`, confirmLabel: 'Override', danger: true });
        if (ok) run(override, 'Overriding', () => api.overrideQuiet(pid), { success: 'Quiet hours overridden.' });
      },
    });
    const end = btn('End', { iconName: 'x', onClick: () => run(end, 'Ending', () => api.endQuiet(pid), { success: 'Quiet hours ended.' }) });
    append(card, h('div', { class: 'actions' }, override, end));
    return card;
  }
  append(card, h('p', { class: 'headline' }, 'Not active'));
  if (q.expired) append(card, h('p', { class: 'muted' }, `The last interval ended at ${q.endsAtLocal}. Nothing restarted automatically.`));
  else if (q.overriddenAt) append(card, h('p', { class: 'muted' }, `The last interval was overridden at ${fmtDateTime(q.overriddenAt, tz)}.`));
  else if (q.endedAt) append(card, h('p', { class: 'muted' }, `The last interval was ended at ${fmtDateTime(q.endedAt, tz)}.`));
  append(card, h('p', { class: 'meta' }, 'Would cover: ', h('strong', null, q.projectName), ' ', h('span', { class: 'mono break-word' }, q.projectRoot)));
  append(card, manualQuietForm(v));
  return card;
}

function manualQuietForm(v) {
  const pid = v.project.id;
  if (!quietFormOpen) {
    return h(
      'div',
      { class: 'actions' },
      btn('Start quiet hours', {
        iconName: 'moon',
        onClick: () => {
          quietFormOpen = true;
          rerender();
          const el = document.getElementById('quiet-minutes');
          if (el) el.focus();
        },
      })
    );
  }
  const select = h(
    'select',
    { id: 'quiet-minutes', class: 'input', 'aria-label': 'Quiet interval', value: drafts['quiet-minutes'] || '30', onChange: (e) => { drafts['quiet-minutes'] = e.target.value; } },
    ...[['15', '15 min'], ['30', '30 min'], ['60', '1 h'], ['120', '2 h'], ['next', 'Until next working block']].map(([val, label]) => h('option', { value: val }, label))
  );
  const protect = h('input', { id: 'quiet-protect', type: 'checkbox', checked: drafts['quiet-protect'] === true, onChange: (e) => { drafts['quiet-protect'] = e.target.checked; } });
  const start = btn('Start', { variant: 'primary', onClick: () => submitQuiet(start, pid) });
  const cancel = btn('Cancel', {
    onClick: () => {
      quietFormOpen = false;
      delete formErrors.quiet;
      rerender();
    },
  });
  return h(
    'div',
    { class: 'stack-sm' },
    h('div', { class: 'input-inline' }, select, start, cancel),
    h('label', { class: 'check', for: 'quiet-protect' }, protect, h('span', null, `Block new coding actions in ${v.project.name} during this interval (StopCode hook)`)),
    h('p', { class: 'check-desc' }, 'Enforcement opt-in. Unchecked, the interval is advisory and nothing is blocked.'),
    formErrors.quiet ? fieldError('quiet-error', formErrors.quiet) : null
  );
}

async function submitQuiet(button, pid) {
  const val = drafts['quiet-minutes'] || '30';
  const protect = drafts['quiet-protect'] === true;
  const body = val === 'next' ? { until: 'tomorrow', protect } : { minutes: Number(val), protect };
  const r = await run(button, 'Starting', () => api.startQuiet(pid, body), {
    success: (res) => `Quiet hours active until ${res.quiet.endsAtLocal} (${res.quiet.protect ? 'blocking' : 'advisory'}).`,
    onError: (e) => {
      formErrors.quiet = errorText(e);
      rerender();
    },
  });
  if (r.ok) {
    quietFormOpen = false;
    delete formErrors.quiet;
  }
}

// ---------- ideas ----------

function ideasCard(v) {
  const pid = v.project.id;
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-ideas' },
    h('h2', { id: 'h-ideas', class: 'card-title' }, icon('bulb'), 'Park this idea'),
    h('p', { class: 'card-sub' }, 'Saves the thought for later without starting a mission or expanding the current one.')
  );
  const input = h('input', {
    id: 'idea-input',
    class: 'input',
    type: 'text',
    maxlength: '400',
    placeholder: 'e.g. Add a dark-mode toggle',
    'aria-label': 'Idea to park',
    value: drafts['idea-input'] || '',
    'aria-describedby': formErrors.idea ? 'idea-error' : null,
    'aria-invalid': formErrors.idea ? 'true' : null,
    onInput: (e) => {
      drafts['idea-input'] = e.target.value;
    },
  });
  const park = btn('Park', { variant: 'primary', iconName: 'bookmark', onClick: () => submitIdea(park, pid) });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitIdea(park, pid);
    }
  });
  append(card, h('div', { class: 'input-inline' }, input, park));
  if (formErrors.idea) append(card, fieldError('idea-error', formErrors.idea));
  const ideas = v.ideas || [];
  if (!ideas.length) {
    append(card, emptyState('No parked ideas.', 'Ideas parked here are listed in the handoff so they are not lost.'));
    return card;
  }
  const ordered = [...ideas.filter((i) => i.status === 'parked'), ...ideas.filter((i) => i.status !== 'parked')];
  append(card, h('ul', { class: 'plain-list' }, ...ordered.map((i) => ideaItem(v, i))));
  return card;
}

function ideaItem(v, i) {
  const pid = v.project.id;
  const text = h('span', { class: 'item-text' }, i.text, h('span', { class: 'meta' }, `${i.status} - ${fmtDateTime(i.at, v.timezone)}`));
  const actions = h('div', { class: 'actions' });
  if (i.status === 'parked') {
    const resume = btn('Resume', { size: 'sm', iconName: 'play', onClick: () => run(resume, 'Updating', () => api.updateIdea(pid, i.id, 'resumed'), { success: 'Idea marked resumed. If it joins the mission, record it as an accepted addition.' }) });
    const drop = btn('Drop', { size: 'sm', iconName: 'x', onClick: () => run(drop, 'Updating', () => api.updateIdea(pid, i.id, 'dropped'), { success: 'Idea dropped.' }) });
    append(actions, resume, drop);
  } else {
    const again = btn('Park again', { size: 'sm', iconName: 'bookmark', onClick: () => run(again, 'Updating', () => api.updateIdea(pid, i.id, 'parked'), { success: 'Idea parked again.' }) });
    append(actions, again);
  }
  return h('li', null, chip(i.status, i.status === 'parked' ? 'parked' : i.status === 'resumed' ? 'progress' : 'muted'), text, actions);
}

async function submitIdea(button, pid) {
  const text = (drafts['idea-input'] || '').trim();
  if (!text) {
    formErrors.idea = 'Write the idea first.';
    rerender();
    return;
  }
  const r = await run(button, 'Parking', () => api.parkIdea(pid, text), {
    success: 'Parked. No mission was started.',
    onError: (e) => {
      formErrors.idea = errorText(e);
      rerender();
    },
  });
  if (r.ok) {
    delete drafts['idea-input'];
    delete formErrors.idea;
  }
}

// ---------- accepted additions ----------

function additionsCard(v) {
  const pid = v.project.id;
  const m = v.mission;
  const canAdd = !!(m && m.status === 'active');
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-add' },
    h('h2', { id: 'h-add', class: 'card-title' }, icon('layers'), 'Accepted additions'),
    h('p', { class: 'card-sub' }, 'Work you knowingly accepted beyond the original objective. The objective itself never changes.')
  );
  const input = h('input', {
    id: 'addition-input',
    class: 'input',
    type: 'text',
    maxlength: '400',
    placeholder: 'e.g. Also migrate the config loader',
    'aria-label': 'Accepted addition',
    disabled: !canAdd,
    value: drafts['addition-input'] || '',
    'aria-describedby': formErrors.addition ? 'addition-error' : canAdd ? null : 'addition-reason',
    'aria-invalid': formErrors.addition ? 'true' : null,
    onInput: (e) => {
      drafts['addition-input'] = e.target.value;
    },
  });
  const add = btn('Record', { iconName: 'plus', disabled: !canAdd, onClick: () => submitAddition(add, pid) });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAddition(add, pid);
    }
  });
  append(card, h('div', { class: 'input-inline' }, input, add));
  if (!canAdd) append(card, h('p', { id: 'addition-reason', class: 'hint' }, m ? 'The mission is not active, so additions cannot be recorded right now.' : 'Recording an addition needs an active mission.'));
  if (formErrors.addition) append(card, fieldError('addition-error', formErrors.addition));
  const list = v.additions || [];
  if (!list.length) append(card, emptyState('None recorded.', 'The original objective is unchanged.'));
  else append(card, h('ul', { class: 'plain-list' }, ...list.map((a) => h('li', null, h('span', { class: 'item-text' }, a.text, h('span', { class: 'meta' }, `accepted ${fmtDateTime(a.at, v.timezone)} (${a.source})`))))));
  return card;
}

async function submitAddition(button, pid) {
  const text = (drafts['addition-input'] || '').trim();
  if (!text) {
    formErrors.addition = 'Describe the addition first.';
    rerender();
    return;
  }
  const r = await run(button, 'Recording', () => api.addAddition(pid, text), {
    success: (res) => (res.duplicate ? 'Already recorded.' : 'Addition recorded. The original objective is unchanged.'),
    onError: (e) => {
      formErrors.addition = errorText(e);
      rerender();
    },
  });
  if (r.ok) {
    delete drafts['addition-input'];
    delete formErrors.addition;
  }
}

// ---------- handoff ----------

function handoffCard(v) {
  const pid = v.project.id;
  const hnd = v.handoff;
  const tz = v.timezone;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-handoff' }, h('h2', { id: 'h-handoff', class: 'card-title' }, icon('file'), 'Handoff'));
  if (hnd) {
    append(card, 
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Saved'),
        h('dd', null, `${fmtDateTime(hnd.savedAt, tz)} (${hnd.trigger})`),
        h('dt', null, 'Next action'),
        h('dd', null, hnd.nextAction || 'not recorded'),
        h('dt', null, 'Status then'),
        h('dd', null, hnd.completion ? hnd.completion.headline : 'unknown'),
        h('dt', null, 'File'),
        h('dd', { class: 'mono meta break-word' }, hnd.path)
      )
    );
    const copy = btn('Copy resume context', { iconName: 'copy', onClick: async () => toast((await copyText(hnd.resumeContext || '')) ? 'Resume context copied.' : 'Copy failed.', 'ok') });
    const open = btn('Open', { iconName: 'external', onClick: () => openHandoff(hnd.id, v.project.name) });
    append(card, h('div', { class: 'actions' }, copy, open, linkBtn('Download .md', api.handoffDownloadUrl(hnd.id), { iconName: 'download', download: '' })));
    append(card, h('p', { class: 'meta' }, `${plural(v.handoffCount, 'handoff')} saved for this project. A handoff documents recorded evidence; it is not a backup of unsaved editor buffers.`));
  } else {
    append(card, emptyState('No handoff saved yet.', 'Clock out saves one automatically, or save one now to capture where the work stands.'));
  }
  const save = btn('Save handoff now', { iconName: 'bookmark', onClick: () => run(save, 'Saving', () => api.saveHandoff(pid, {}), { success: (r) => `Handoff saved: ${r.handoff.path}` }) });
  append(card, h('div', { class: 'actions' }, save));
  return card;
}

export async function openHandoff(handoffId, projectName) {
  try {
    const res = await api.handoff(handoffId);
    showMarkdown({
      title: `Handoff - ${projectName || 'StopCode'}`,
      markdown: res.markdown || '',
      downloadHref: api.handoffDownloadUrl(handoffId),
      filename: '',
      note: res.missing ? notice('warn', 'Handoff file missing', h('span', null, `The record exists but its file was not found at ${res.handoff && res.handoff.path}.`)) : null,
    });
  } catch (e) {
    toast(errorText(e), 'danger');
  }
}

// ---------- integration ----------

function kv(k, value, tone) {
  return [h('dt', null, k), h('dd', { class: tone ? `text-${tone}` : null }, value)];
}

function integrationCard(v, overview) {
  const integ = v.integration;
  const doc = overview && overview.doctor;
  const q = v.quiet;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-integ' }, h('h2', { id: 'h-integ', class: 'card-title' }, icon('plug'), 'Integration self-check'));
  const storage = doc && doc.storage ? doc.storage : null;
  const apiInfo = doc && doc.api ? doc.api : null;
  append(card, 
    h(
      'dl',
      { class: 'kv' },
      ...kv('Storage', storage ? (storage.writable ? 'writable' : `NOT writable${storage.error ? ' - ' + storage.error : ''}`) : 'unknown', storage && !storage.writable ? 'danger' : ''),
      ...kv('Last real hook event', integ.lastHookEvent ? `${integ.lastHookEvent.event} - ${integ.lastHookAge}` : 'No activity observed yet'),
      ...kv('Claude API', apiInfo ? `${apiInfo.configured ? 'configured' : 'not configured'}; ${apiInfo.tested ? 'connection tested successfully' : 'not tested successfully'}` : 'unknown'),
      ...kv('Quiet hours cover this project', q.active ? `yes - ${q.projectName} (${q.projectRoot}) until ${q.endsAtLocal}` : `no - ${q.projectName} is not under quiet hours`)
    )
  );
  if (integ.degraded && integ.lastHookError) {
    append(card, notice('warn', 'Degraded enforcement', h('span', null, `A hook failed at ${fmtDateTime(integ.lastHookError.at, v.timezone)} (${integ.lastHookError.event}): ${integ.lastHookError.message}. Hooks fail open, so blocking may not have applied.`)));
  }
  append(card, h('p', { class: 'meta' }, 'Configuration is never shown as a successful connection. Details and the connection test are in Settings.'));
  return card;
}

// ---------- timeline ----------

function describeEvent(e, tz) {
  switch (e.type) {
    case 'mission_start':
      return { text: `Mission started: "${e.objective || ''}"${e.criteria ? ` (${plural(e.criteria, 'criterion', 'criteria')})` : ''}`, tone: 'info' };
    case 'session_start':
      return { text: `Coding session started${e.source ? ` (${e.source})` : ''}`, tone: 'info' };
    case 'session_end':
      return { text: `Coding session ended${e.endedBy ? ` (${e.endedBy})` : ''}`, tone: '' };
    case 'evidence':
      return { text: `Evidence: ${String(e.kind || '').replace(/_/g, ' ')} / ${e.outcome}${e.summary ? ' - ' + e.summary : ''}`, tone: e.outcome === 'fail' ? 'danger' : '' };
    case 'evidence_attached':
      return { text: 'Evidence attached to a criterion', tone: '' };
    case 'idea_parked':
      return { text: `Idea parked: ${e.text || ''}`, tone: 'rest' };
    case 'idea_updated':
      return { text: `Idea marked ${e.status}`, tone: '' };
    case 'scope_accepted':
      return { text: `Addition accepted: ${e.text || ''}`, tone: 'warn' };
    case 'scope_note':
      return { text: `Scope note: ${String(e.classification || '').replace(/_/g, ' ')} / ${e.decision}${e.text ? ' - ' + e.text : ''}`, tone: '' };
    case 'handoff_saved':
      return { text: `Handoff saved (${e.trigger || 'manual'})`, tone: 'info' };
    case 'clock_out':
      return { text: 'Clocked out', tone: 'rest' };
    case 'quiet_start':
      return { text: `Quiet hours started until ${fmtTime(e.endsAt, tz)} (${e.protect ? 'blocking' : 'advisory'}, ${String(e.reason || 'manual').replace(/_/g, ' ')})`, tone: 'rest' };
    case 'quiet_end':
      return { text: `Quiet hours ended (${e.by || 'user'})`, tone: 'rest' };
    case 'quiet_override':
      return { text: `Quiet hours overridden (${e.reason || 'user'})`, tone: 'warn' };
    case 'resume':
      return { text: `Resumed${e.override ? ' with explicit override' : ''}`, tone: 'info' };
    case 'break_start':
      return { text: 'Break started', tone: 'rest' };
    case 'break_end':
      return { text: `Break ended${Number.isFinite(e.minutes) ? ` (${e.minutes} min)` : ''}`, tone: 'rest' };
    case 'tool_blocked':
      return { text: `Tool action blocked by quiet hours${e.tool ? ` (${e.tool})` : ''}`, tone: 'warn' };
    case 'prompt_blocked':
      return { text: 'Prompt blocked by quiet hours', tone: 'warn' };
    case 'monitoring_paused':
      return { text: 'Monitoring paused (coding not blocked)', tone: '' };
    case 'monitoring_resumed':
      return { text: 'Monitoring resumed', tone: '' };
    case 'criterion_status':
      return { text: `Criterion status set to ${String(e.status || '').replace(/_/g, ' ')}`, tone: '' };
    case 'criterion_confirmed':
      return { text: 'Criterion confirmed by you (user confirmation)', tone: '' };
    case 'mission_complete':
      return { text: 'Mission marked complete by you', tone: '' };
    default:
      return { text: String(e.type || 'event').replace(/_/g, ' '), tone: '' };
  }
}

function timelineItem(e, tz) {
  if (e.type === 'activity') {
    const parts = [plural(e.count, 'tool action'), plural(e.edits, 'edit'), plural(e.failures, 'failure'), `${e.afterHours} after hours`];
    if (e.prompts) parts.push(plural(e.prompts, 'prompt'));
    const files = e.files && e.files.length ? h('span', { class: 'meta tl-files' }, e.files.slice(0, 6).join(', ') + (e.files.length > 6 ? ` +${e.files.length - 6} more` : '')) : null;
    return h('li', null, h('span', { class: 't' }, `${e.fromLocal}-${e.toLocal}`), h('span', { class: 'activity' }, parts.join(', '), files));
  }
  const { text, tone } = describeEvent(e, tz);
  return h('li', null, h('span', { class: 't' }, e.atLocal || fmtTime(e.at, tz)), h('span', { class: tone || null }, text));
}

function timelineCard(v) {
  const tz = v.timezone;
  const card = h(
    'section',
    { class: 'card card-wide', 'aria-labelledby': 'h-timeline' },
    h('h2', { id: 'h-timeline', class: 'card-title' }, icon('list'), 'Timeline'),
    h('p', { class: 'card-sub' }, 'Most recent first. Consecutive tool activity is grouped into one row.')
  );
  const items = (v.timeline || []).slice().reverse();
  if (!items.length) {
    append(card, emptyState('No events yet.', 'Activity appears here once Claude Code runs with the StopCode plugin loaded, or when you park ideas, record breaks or clock out.'));
    return card;
  }
  append(card, h('ol', { class: 'timeline' }, ...items.map((e) => timelineItem(e, tz))));
  if (v.activity.skippedMalformed) append(card, h('p', { class: 'meta' }, `${plural(v.activity.skippedMalformed, 'malformed event line')} skipped while reading the log.`));
  return card;
}

// ---------- clock out dialog ----------

const INTERVALS = [
  ['none', 'None'],
  ['15', '15 min'],
  ['30', '30 min'],
  ['60', '1 h'],
  ['120', '2 h'],
  ['next', 'Until next working block'],
  ['custom', 'Custom time (HH:MM)'],
];
const PROTECT_HINT = 'Enforcement opt-in: the StopCode PreToolUse hook denies new tool actions in this project until the interval ends. You can lift it any time with an explicit override.';

export function openClockOut(state) {
  const v = state && state.view;
  if (!v) return;
  const pid = v.project.id;
  const co = (v.settings && v.settings.clockOut) || {};
  const ids = { note: uid('co-note'), interval: uid('co-interval'), custom: uid('co-custom'), protect: uid('co-protect'), complete: uid('co-complete'), err: uid('co-err'), hint: uid('co-hint') };

  const note = h('textarea', { id: ids.note, class: 'input', rows: '2', maxlength: '1000', placeholder: 'Optional: anything your future self should know' });
  const interval = h('select', { id: ids.interval, class: 'input' }, ...INTERVALS.map(([val, label]) => h('option', { value: val }, label)));
  interval.value = [15, 30, 60, 120].includes(Number(co.lastQuietMinutes)) ? String(co.lastQuietMinutes) : 'none';
  const custom = h('input', { id: ids.custom, class: 'input', type: 'time', step: '60' });
  const customField = h('div', { class: 'field', hidden: true }, h('label', { for: ids.custom }, 'Quiet until (24-hour time; today if still ahead, otherwise tomorrow)'), custom);
  const protect = h('input', { id: ids.protect, type: 'checkbox', checked: !!co.lastProtect, 'aria-describedby': ids.hint });
  const hint = h('p', { id: ids.hint, class: 'check-desc' }, PROTECT_HINT);
  const complete = h('input', { id: ids.complete, type: 'checkbox' });
  const errorBox = h('div', { id: ids.err, class: 'form-error', role: 'alert', hidden: true });

  function syncInterval() {
    const none = interval.value === 'none';
    customField.hidden = interval.value !== 'custom';
    protect.disabled = none;
    if (none) protect.checked = false;
    hint.textContent = none ? 'Choose an interval to enable blocking; without one there is nothing to enforce.' : PROTECT_HINT;
  }
  interval.addEventListener('change', syncInterval);
  syncInterval();

  const cancel = btn('Cancel');
  const submit = btn('Clock out', { variant: 'primary', iconName: 'logout' });
  const missionActive = v.mission && v.mission.status === 'active';
  const body = h(
    'div',
    { class: 'dialog-body' },
    h('p', { class: 'muted' }, `Saves a handoff for ${v.project.name}, logically ends the tracked session and parks the mission. The Claude Code process is not closed.`),
    h('div', { class: 'field' }, h('label', { for: ids.note }, 'Note (optional)'), note),
    h('div', { class: 'field' }, h('label', { for: ids.interval }, 'Quiet interval'), interval),
    customField,
    h('div', null, h('label', { class: 'check', for: ids.protect }, protect, h('span', null, `Block new coding actions in ${v.project.name} during this interval (StopCode hook)`)), hint),
    missionActive
      ? h(
          'div',
          null,
          h('label', { class: 'check', for: ids.complete }, complete, h('span', null, 'Mark the mission complete (your confirmation, separate from verification)')),
          h('p', { class: 'check-desc' }, v.mission.completion.state === 'complete' ? 'Every criterion already has passing evidence.' : `Verification status right now: ${v.mission.completion.headline}.`)
        )
      : null,
    errorBox
  );
  const dlg = openDialog({ title: 'Clock out', body, actions: [cancel, submit], initialFocus: note });
  cancel.addEventListener('click', () => dlg.close('cancel'));

  function showError(message) {
    clear(errorBox);
    errorBox.hidden = false;
    append(errorBox, icon('alert'), h('span', null, message));
  }

  submit.addEventListener('click', async () => {
    errorBox.hidden = true;
    clear(errorBox);
    let quiet;
    const val = interval.value;
    if (val === 'none') quiet = undefined;
    else if (val === 'next') quiet = { until: 'tomorrow', protect: protect.checked };
    else if (val === 'custom') {
      if (!/^\d{2}:\d{2}$/.test(custom.value)) {
        showError('Enter a time as HH:MM for the custom interval.');
        custom.focus();
        return;
      }
      quiet = { until: custom.value, protect: protect.checked };
    } else quiet = { minutes: Number(val), protect: protect.checked };
    const payload = { note: note.value.trim() || undefined, quiet, markComplete: missionActive && complete.checked ? true : undefined };
    cancel.disabled = true;
    const r = await store.act(async () => {
      try {
        return { ok: true, result: await withBusy(submit, 'Clocking out', () => api.clockOut(pid, payload)) };
      } catch (e) {
        return { ok: false, error: e };
      }
    });
    cancel.disabled = false;
    if (!r.ok) {
      showError(errorText(r.error));
      return;
    }
    parked = { ...r.result, projectId: pid, projectName: v.project.name, timezone: v.timezone };
    dlg.close('submitted');
    rerender();
    const heading = container && container.querySelector('#parked-heading');
    if (heading) heading.focus();
  });
}

// ---------- parked screen ----------

function step(tone, titleText, detail) {
  const name = tone === 'ok' ? 'check' : tone === 'fail' ? 'alert' : tone === 'rest' ? 'moon' : 'info';
  return h('li', { class: `step step-${tone}` }, icon(name, { size: 18 }), h('div', null, h('p', { class: 'step-title' }, titleText), detail ? h('p', { class: 'step-detail muted' }, detail) : null));
}

function renderParked() {
  const r = parked;
  const tz = r.timezone;
  const wrap = h('div', { class: 'parked' });
  append(wrap, h('h2', { id: 'parked-heading', class: 'parked-title', tabindex: '-1' }, icon('moon', { size: 28 }), 'Your work is parked.'));
  if (!r.ok && r.message) append(wrap, notice('warn', 'Some steps had problems', h('span', null, r.message)));

  const steps = h('ol', { class: 'steps' });
  if (r.handoff) append(steps, step(r.handoff.ok ? 'ok' : 'fail', r.handoff.ok ? 'Handoff saved' : 'Handoff failed', r.handoff.ok ? r.handoff.path : r.handoff.error || 'unknown error'));
  if (r.session) append(steps, step('neutral', r.session.endedSessionIds && r.session.endedSessionIds.length ? `Tracked session ended (${r.session.endedSessionIds.length})` : 'No active tracked session to end', r.session.note));
  if (r.mission) append(steps, step(r.mission.status === 'completed' ? 'ok' : 'rest', r.mission.status === 'completed' ? 'Mission marked complete (your confirmation)' : 'Mission parked', r.mission.completion ? r.mission.completion.headline : null));
  if (r.quiet) {
    if (r.quiet.requested === false) append(steps, step('neutral', 'Quiet hours not requested', 'Advisory stop only; nothing is blocked.'));
    else if (r.quiet.ok) {
      const name = r.quiet.projectName || r.projectName;
      append(steps, 
        step(
          'rest',
          `Quiet hours active until ${r.quiet.endsAtLocal || fmtDateTime(r.quiet.endsAt, tz)} (${r.quiet.protect ? 'blocking' : 'advisory'})`,
          `${r.quiet.protect ? `New coding actions in ${name} are blocked by the StopCode hook until then.` : 'Nothing is blocked.'} Covers ${name}${r.quiet.projectRoot ? ' at ' + r.quiet.projectRoot : ''}.`
        )
      );
    } else append(steps, step('fail', 'Quiet hours failed', r.quiet.error || 'unknown error'));
  }
  append(wrap, steps);

  const completion = r.mission && r.mission.completion;
  const open = completion ? Math.max(0, completion.total - completion.verifiedCount) : null;
  append(wrap, 
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Remaining work'),
      h('dd', null, completion ? (completion.total ? `${plural(open, 'open criterion', 'open criteria')} of ${completion.total}` : 'No criteria were recorded') : 'No mission recorded'),
      h('dt', null, 'Next action'),
      h('dd', null, (r.handoff && r.handoff.nextAction) || 'not recorded'),
      h('dt', null, 'Chosen restart time'),
      h('dd', null, r.quiet && r.quiet.ok && r.quiet.requested !== false && r.quiet.plannedRestartAt ? fmtDateTime(r.quiet.plannedRestartAt, tz) : 'none chosen')
    )
  );

  const handoffOk = !!(r.handoff && r.handoff.ok);
  const view = btn('View handoff', { iconName: 'file', disabled: !handoffOk, onClick: () => openHandoff(r.handoff.id, r.projectName) });
  const copy = btn('Copy resume context', { iconName: 'copy', disabled: !(handoffOk && r.handoff.resumeContext), onClick: async () => toast((await copyText(r.handoff.resumeContext)) ? 'Resume context copied.' : 'Copy failed.', 'ok') });
  const resume = btn('Resume', { iconName: 'play', onClick: () => resumeFlow(resume, { id: r.projectId, name: r.projectName }) });
  const chat = btn('Open wellness chat', { iconName: 'message', onClick: () => ctx.navigate('chat') });
  append(wrap, h('div', { class: 'actions' }, view, copy, resume, chat));
  if (!handoffOk) append(wrap, h('p', { class: 'hint' }, 'View handoff and Copy resume context are disabled because no handoff was saved.'));
  append(wrap, h('p', { class: 'meta' }, 'Resume is explicit: it restores the handoff and, if quiet hours are active, asks before overriding them. Nothing starts automatically.'));
  const back = btn('Show Today cards (does not resume)', {
    variant: 'ghost',
    onClick: () => {
      parked = null;
      rerender();
    },
  });
  append(wrap, h('div', null, back));
  return wrap;
}
