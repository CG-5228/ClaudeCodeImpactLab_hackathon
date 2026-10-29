// Application state: overview + the selected project's view, refreshed by polling every
// 4 s while the tab is visible and after every action. Fetch failures keep the last good
// data and flip `status` to 'error' so the banner can offer a retry.
import { api } from './api.js';

const LS_PROJECT = 'stopcode.project';
const POLL_MS = 4000;
const OVERVIEW_EVERY = 5; // ticks (20 s) unless there is no project yet

const state = {
  status: 'loading', // loading | ok | error
  error: null,
  overview: null,
  view: null,
  projectId: null,
  requestedProjectId: null,
  viewError: null,
  inflight: 0,
  lastUpdated: null,
};

const subscribers = new Set();
let timer = null;
let tick = 0;
let refreshing = null;
let again = null;

function emit() {
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch (e) {
      console.error(e); // eslint-disable-line no-console
    }
  }
}

function readStoredProject() {
  try {
    return localStorage.getItem(LS_PROJECT);
  } catch (e) {
    return null;
  }
}

function storeProject(id) {
  try {
    if (id) localStorage.setItem(LS_PROJECT, id);
    else localStorage.removeItem(LS_PROJECT);
  } catch (e) {
    /* storage may be unavailable */
  }
}

function chooseProject() {
  const projects = (state.overview && state.overview.projects) || [];
  const has = (id) => id && projects.some((p) => p.id === id);
  if (has(state.requestedProjectId)) return state.requestedProjectId;
  if (has(state.projectId)) return state.projectId;
  const stored = readStoredProject();
  if (has(stored)) return stored;
  return projects.length ? projects[0].id : null;
}

async function doRefresh({ withOverview }) {
  try {
    if (withOverview || !state.overview) state.overview = await api.overview();
    const chosen = chooseProject();
    if (chosen !== state.projectId) state.view = null;
    state.projectId = chosen;
    state.requestedProjectId = null;
    if (chosen) {
      storeProject(chosen);
      try {
        state.view = await api.project(chosen);
        state.viewError = null;
      } catch (e) {
        if (e.status === 404) {
          // The project disappeared (deleted elsewhere): drop it and pick another.
          storeProject(null);
          state.projectId = null;
          state.view = null;
          state.overview = await api.overview();
          const next = chooseProject();
          if (next) {
            state.projectId = next;
            storeProject(next);
            state.view = await api.project(next);
          }
          state.viewError = null;
        } else {
          state.viewError = e;
          throw e;
        }
      }
    } else {
      state.view = null;
      state.viewError = null;
    }
    state.status = 'ok';
    state.error = null;
    state.lastUpdated = Date.now();
  } catch (e) {
    state.status = 'error';
    state.error = e;
  } finally {
    emit();
  }
}

export const store = {
  get: () => state,

  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  // Coalesces concurrent refreshes; the returned promise resolves when data is fresh.
  refresh({ withOverview = true } = {}) {
    if (refreshing) {
      // A refresh requested while one is running (typically right after an action) must
      // still observe the action's result, so run one more pass when this one ends.
      again = again || { withOverview };
      if (withOverview) again.withOverview = true;
      return refreshing;
    }
    refreshing = doRefresh({ withOverview }).finally(() => {
      refreshing = null;
      if (again) {
        const next = again;
        again = null;
        store.refresh(next);
      }
    });
    return refreshing;
  },

  selectProject(id) {
    if (!id) return Promise.resolve();
    state.requestedProjectId = id;
    storeProject(id);
    return store.refresh({ withOverview: true });
  },

  // Wrap an action so polling pauses while it is in flight and data refreshes afterwards.
  async act(fn) {
    state.inflight += 1;
    try {
      return await fn();
    } finally {
      state.inflight -= 1;
      store.refresh({ withOverview: true });
    }
  },

  startPolling() {
    if (timer) return;
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (state.inflight > 0) return;
      tick += 1;
      store.refresh({ withOverview: tick % OVERVIEW_EVERY === 0 || !state.projectId || state.status === 'error' });
    }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') store.refresh({ withOverview: true });
    });
  },
};
