// StopCode dashboard entry point: hash routing, the tablist (roving tabindex), header
// controls (project switcher, Clock out), the unreachable-server banner and polling.
import { store } from './js/store.js';
import { h, icon, btn, clear } from './js/dom.js';
import { errorText } from './js/api.js';
import * as today from './js/views/today.js';
import * as chat from './js/views/chat.js';
import * as planner from './js/views/planner.js';
import * as history from './js/views/history.js';
import * as settings from './js/views/settings.js';

const VIEWS = { today, chat, planner, history, settings };
const ROUTES = Object.keys(VIEWS);

const panel = document.getElementById('panel');
const tabs = Array.from(document.querySelectorAll('.tab[role="tab"]'));
const projectSwitch = document.getElementById('project-switch');
const projectSelect = document.getElementById('project-select');
const clockOutWrap = document.getElementById('clock-out-wrap');
const clockOutBtn = document.getElementById('clock-out-btn');
const clockOutReason = document.getElementById('clock-out-reason');
const bannerSlot = document.getElementById('banner');

let currentRoute = null;
let currentView = null;
let bannerShown = false;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const route = ROUTES.includes(path) ? path : 'today';
  const params = new URLSearchParams(query);
  return { route, project: params.get('project') };
}

function hashFor(route, projectId) {
  return `#/${route}${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`;
}

function navigate(route, { project } = {}) {
  location.hash = hashFor(route, project || store.get().projectId);
}

const ctx = { navigate, store, openClockOut: () => today.openClockOut(store.get()) };

function activate(route) {
  if (currentRoute === route) return;
  if (currentView && currentView.leave) currentView.leave();
  currentRoute = route;
  currentView = VIEWS[route];
  for (const tab of tabs) {
    const selected = tab.dataset.route === route;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  }
  panel.setAttribute('aria-labelledby', `tab-${route}`);
  clear(panel);
  currentView.enter(panel, ctx);
  if (currentView.update) currentView.update(store.get());
  document.title = `${currentView.title} - StopCode`;
  updateHeader(store.get());
}

function onHashChange() {
  const { route, project } = parseHash();
  if (project && project !== store.get().projectId) store.selectProject(project);
  activate(route);
}

// ---------- tabs: click + roving tabindex with arrow keys ----------

for (const tab of tabs) {
  tab.addEventListener('click', () => navigate(tab.dataset.route));
}
document.querySelector('.tabs').addEventListener('keydown', (event) => {
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  navigate(tabs[next].dataset.route);
});

// ---------- header ----------

projectSelect.addEventListener('change', () => navigate(currentRoute || 'today', { project: projectSelect.value }));
clockOutBtn.addEventListener('click', () => today.openClockOut(store.get()));

function updateHeader(state) {
  const projects = (state.overview && state.overview.projects) || [];
  if (projects.length > 1) {
    const wanted = projects.map((p) => `${p.id}|${p.name}`).join(',');
    if (projectSelect.dataset.options !== wanted) {
      clear(projectSelect);
      for (const p of projects) projectSelect.appendChild(h('option', { value: p.id }, p.name));
      projectSelect.dataset.options = wanted;
    }
    if (state.projectId && projectSelect.value !== state.projectId) projectSelect.value = state.projectId;
    projectSwitch.hidden = false;
  } else {
    projectSwitch.hidden = true;
  }
  const onToday = currentRoute === 'today';
  clockOutWrap.hidden = !onToday;
  if (onToday) {
    const ready = !!state.view;
    clockOutBtn.disabled = !ready;
    if (ready) {
      clockOutReason.hidden = true;
      clockOutReason.textContent = '';
    } else {
      clockOutReason.hidden = false;
      clockOutReason.textContent = !state.overview ? 'Waiting for the dashboard server.' : !state.projectId ? 'No project yet: start a mission from Claude Code first.' : 'Loading the project.';
    }
  }
  // Keep the project in the URL so a reload or a shared link lands on the same project.
  if (state.projectId && currentRoute) {
    const wanted = hashFor(currentRoute, state.projectId);
    if (location.hash !== wanted) window.history.replaceState(null, '', wanted);
  }
}

// ---------- banner ----------

function updateBanner(state) {
  if (state.status === 'error') {
    if (bannerShown) return;
    bannerShown = true;
    clear(bannerSlot);
    const retry = btn('Retry', { iconName: 'refresh', onClick: () => store.refresh() });
    bannerSlot.appendChild(
      h(
        'div',
        { class: 'banner', role: 'alert' },
        icon('alert'),
        h('span', { class: 'banner-text' }, h('strong', null, 'Dashboard server unreachable - retrying'), h('span', { class: 'meta' }, ` ${errorText(state.error)}. Showing the last data received.`)),
        retry
      )
    );
  } else if (bannerShown) {
    bannerShown = false;
    clear(bannerSlot);
  }
}

// ---------- boot ----------

store.subscribe((state) => {
  updateHeader(state);
  updateBanner(state);
  if (currentView && currentView.update) currentView.update(state);
});

window.addEventListener('hashchange', onHashChange);
onHashChange();
store.refresh();
store.startPolling();
