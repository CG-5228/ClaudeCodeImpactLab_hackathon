// History: previous missions, recent sessions (elapsed = wall clock), handoffs and the
// project's data controls (export, delete session history, delete all project data).
import { h, icon, chip, statusChip, btn, linkBtn, emptyState, notice, skeletonCard, withBusy, preserveFocus, clear, plural, append } from '../dom.js';
import { fmtDateTime, humanDuration } from '../time.js';
import { api, errorText } from '../api.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { store } from '../store.js';
import { openHandoff } from './today.js';

export const id = 'history';
export const title = 'History';

let container = null;

export function enter(c) {
  container = c;
}

export function leave() {
  container = null;
}

export function update(state) {
  if (!container) return;
  preserveFocus(container, () => render(state));
}

function render(state) {
  clear(container);
  if (!state.overview) {
    append(container, h('div', { class: 'cards', role: 'status', 'aria-label': 'Loading history' }, skeletonCard(3), skeletonCard(3)));
    return;
  }
  if (!state.projectId) {
    append(container, notice('info', 'No project yet', h('span', null, 'History fills in once a mission is started from Claude Code with /stopcode:start.')));
    return;
  }
  if (!state.view) {
    append(container, state.viewError ? notice('danger', 'Could not load this project', h('span', null, errorText(state.viewError))) : skeletonCard(3));
    return;
  }
  const v = state.view;
  const handoffs = (state.overview.handoffs || []).filter((hd) => hd.projectId === v.project.id);
  append(container, h('div', { class: 'project-strip' }, h('span', null, 'Project ', h('strong', null, v.project.name)), h('span', { class: 'mono' }, v.project.root), h('span', { class: 'meta' }, `Times shown in ${v.timezone}`)));
  append(container, h('div', { class: 'cards' }, missionsCard(v), sessionsCard(v), handoffsCard(v, handoffs), dataCard(v)));
}

function missionsCard(v) {
  const tz = v.timezone;
  const card = h('section', { class: 'card card-wide', 'aria-labelledby': 'h-missions' }, h('h2', { id: 'h-missions', class: 'card-title' }, icon('target'), 'Missions'));
  const list = h('ul', { class: 'plain-list' });
  if (v.mission) {
    const m = v.mission;
    append(list, 
      h(
        'li',
        null,
        h('span', { class: 'item-text' }, h('strong', null, m.objective), h('span', { class: 'meta' }, `${m.completion.headline} - started ${fmtDateTime(m.startedAt, tz)}${m.parkedAt ? `, parked ${fmtDateTime(m.parkedAt, tz)}` : ''}`)),
        h('div', { class: 'chips' }, chip('current', 'progress'), chip(m.status, m.status === 'completed' ? 'verified' : 'muted'))
      )
    );
  }
  for (const m of v.previousMissions || []) {
    const when = `started ${fmtDateTime(m.startedAt, tz)}${m.finishedAt ? `, finished ${fmtDateTime(m.finishedAt, tz)}` : ''}${m.archivedAt ? `, archived ${fmtDateTime(m.archivedAt, tz)}` : ''}`;
    append(list, h('li', null, h('span', { class: 'item-text' }, m.objective, h('span', { class: 'meta' }, `${m.completion ? m.completion.headline : ''} - ${when}`)), h('div', { class: 'chips' }, chip(m.status, m.status === 'completed' ? 'verified' : m.status === 'archived' ? 'muted' : 'progress'))));
  }
  if (!list.childNodes.length) append(card, emptyState('No missions recorded yet.', 'Missions appear here once started from Claude Code; replaced missions are preserved, never deleted.'));
  else append(card, list);
  return card;
}

function sessionsCard(v) {
  const tz = v.timezone;
  const card = h(
    'section',
    { class: 'card card-wide', 'aria-labelledby': 'h-sessions' },
    h('h2', { id: 'h-sessions', class: 'card-title' }, icon('history'), 'Recent sessions'),
    h('p', { class: 'card-sub' }, 'Elapsed is wall-clock time between the first and last recorded event of a session, not focused time.')
  );
  const sessions = v.recentSessions || [];
  if (!sessions.length) {
    append(card, emptyState('No coding sessions recorded.', 'Sessions are created by the SessionStart hook when Claude Code runs with the plugin loaded.'));
    return card;
  }
  const rows = sessions.map((s) =>
    h(
      'tr',
      null,
      h('td', null, fmtDateTime(s.startedAt, tz)),
      h('td', null, s.endedAt ? fmtDateTime(s.endedAt, tz) : h('span', null, statusChip('in_progress'), ' open')),
      h('td', { class: 'num' }, `${humanDuration(s.durationMs)} elapsed`),
      h('td', { class: 'num' }, String(s.counters.tools)),
      h('td', { class: 'num' }, String(s.counters.edits)),
      h('td', { class: 'num' }, String(s.counters.commands)),
      h('td', { class: 'num' }, String(s.counters.afterHours)),
      h('td', { class: 'num' }, String(s.counters.failures)),
      h('td', null, s.files && s.files.length ? h('span', null, plural(s.files.length, 'file'), h('span', { class: 'meta break-word' }, s.files.slice(-4).join(', ') + (s.files.length > 4 ? ' ...' : ''))) : h('span', { class: 'muted' }, 'none observed'))
    )
  );
  append(card, 
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Started'), h('th', { scope: 'col' }, 'Ended'), h('th', { scope: 'col', class: 'num' }, 'Elapsed (wall clock)'), h('th', { scope: 'col', class: 'num' }, 'Tools'), h('th', { scope: 'col', class: 'num' }, 'Edits'), h('th', { scope: 'col', class: 'num' }, 'Commands'), h('th', { scope: 'col', class: 'num' }, 'After hours'), h('th', { scope: 'col', class: 'num' }, 'Failures'), h('th', { scope: 'col' }, 'Files'))),
        h('tbody', null, ...rows)
      )
    )
  );
  return card;
}

function handoffsCard(v, handoffs) {
  const tz = v.timezone;
  const card = h('section', { class: 'card card-wide', 'aria-labelledby': 'h-handoffs' }, h('h2', { id: 'h-handoffs', class: 'card-title' }, icon('file'), 'Handoffs'));
  if (!handoffs.length) {
    append(card, emptyState('No handoffs saved yet.', 'Clocking out saves one; so does "Save handoff now" on Today.'));
    return card;
  }
  append(card, 
    h(
      'ul',
      { class: 'plain-list' },
      ...handoffs.map((hd) =>
        h(
          'li',
          null,
          h('span', { class: 'item-text' }, `${fmtDateTime(hd.savedAt, tz)} - ${hd.trigger}`, h('span', { class: 'meta' }, `Next action then: ${hd.nextAction || 'not recorded'}${hd.completion ? ` - ${hd.completion.headline}` : ''}`)),
          h('div', { class: 'actions' }, btn('Open', { size: 'sm', iconName: 'external', onClick: () => openHandoff(hd.id, v.project.name) }), linkBtn('Download .md', api.handoffDownloadUrl(hd.id), { size: 'sm', iconName: 'download', download: '' }))
        )
      )
    )
  );
  if (v.handoffCount > handoffs.length) append(card, h('p', { class: 'meta' }, `Showing the ${handoffs.length} most recent of ${v.handoffCount} handoffs. Older files remain in the data directory.`));
  return card;
}

function dataCard(v) {
  const pid = v.project.id;
  const card = h('section', { class: 'card card-wide', 'aria-labelledby': 'h-data' }, h('h2', { id: 'h-data', class: 'card-title' }, icon('database'), 'Data controls for this project'), h('p', { class: 'card-sub' }, 'Everything StopCode knows about this project lives in the local data directory. Nothing is sent anywhere.'));
  const delHistory = btn('Delete session history', {
    variant: 'danger',
    iconName: 'trash',
    onClick: async () => {
      const ok = await confirmDialog({ title: 'Delete session history?', message: `Removes ended sessions and the activity event log for ${v.project.name}. The mission, criteria, evidence and handoffs are kept.`, confirmLabel: 'Delete history', danger: true });
      if (!ok) return;
      await store.act(async () => {
        try {
          await withBusy(delHistory, 'Deleting', () => api.deleteHistory(pid));
          toast('Session history deleted.', 'ok');
        } catch (e) {
          toast(errorText(e), 'danger');
        }
      });
    },
  });
  const delProject = btn("Delete this project's StopCode data", {
    variant: 'danger',
    iconName: 'trash',
    onClick: async () => {
      const ok = await confirmDialog({ title: 'Delete all StopCode data for this project?', message: `Removes missions, sessions, events and handoff files for ${v.project.name}. Your source code is not touched.`, confirmLabel: 'Delete project data', danger: true, typed: v.project.name });
      if (!ok) return;
      await store.act(async () => {
        try {
          await withBusy(delProject, 'Deleting', () => api.deleteProject(pid));
          toast(`StopCode data for ${v.project.name} deleted.`, 'ok');
        } catch (e) {
          toast(errorText(e), 'danger');
        }
      });
    },
  });
  append(card, h('div', { class: 'actions' }, linkBtn('Export JSON', api.exportUrl(pid), { iconName: 'download', download: `stopcode-${v.project.name}.json` }), delHistory, delProject));
  return card;
}
