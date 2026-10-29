// Settings: integration self-check (facts, not hopes), Claude API configuration vs. a
// real connection test, boundary preferences, data location and an honest About.
import { h, icon, chip, btn, notice, fieldError, skeletonCard, withBusy, copyText, preserveFocus, clear, append } from '../dom.js';
import { fmtDateTime } from '../time.js';
import { api, errorText } from '../api.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { store } from '../store.js';

export const id = 'settings';
export const title = 'Settings';

let container = null;
let doctor = null;
let doctorError = null;
let settings = null;
let adviceDraft = null;
let adviceError = null;
let testResult = null; // { at, ok, model, latencyMs, error }

export function enter(c) {
  container = c;
  render();
  load();
}

export function leave() {
  container = null;
}

export function update() {
  // Settings data is loaded on enter and after actions.
}

async function load() {
  doctorError = null;
  try {
    [doctor, settings] = await Promise.all([api.doctor(), api.settings()]);
    adviceDraft = { enabled: settings.advice ? settings.advice.enabled !== false : true, minIntervalMinutes: (settings.advice && settings.advice.minIntervalMinutes) || 20 };
  } catch (e) {
    doctorError = e;
  }
  render();
}

function tz() {
  return (settings && settings.timezone) || undefined;
}

function render() {
  if (!container) return;
  preserveFocus(container, () => {
    clear(container);
    if (doctorError) {
      append(container, notice('danger', 'Could not load the self-check', h('span', null, errorText(doctorError)), h('div', { class: 'actions' }, btn('Retry', { iconName: 'refresh', onClick: load }))));
      return;
    }
    if (!doctor || !settings) {
      append(container, h('div', { class: 'stack', role: 'status', 'aria-label': 'Loading settings' }, skeletonCard(3), skeletonCard(3), skeletonCard(2)));
      return;
    }
    append(container, h('div', { class: 'stack' }, integrationCard(), apiCard(), boundaryCard(), dataCard(), aboutCard()));
  });
}

function integrationCard() {
  const hooks = doctor.hooks || {};
  const plugin = doctor.plugin || {};
  const files = plugin.files || {};
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-integration' }, h('h2', { id: 'h-integration', class: 'card-title' }, icon('plug'), 'Integration'));
  const cmd = plugin.loadCommand || '';
  const copy = btn('Copy command', { size: 'sm', iconName: 'copy', onClick: async () => toast((await copyText(cmd)) ? 'Command copied.' : 'Copy failed.', 'ok') });
  append(card, 
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Load the plugin in Claude Code'), h('div', { class: 'row' }, h('code', { class: 'mono break-word' }, cmd || 'unknown'), copy)),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Hook status'),
      h('dd', null, hooks.observed && hooks.lastEvent ? `Last real hook event: ${hooks.lastEvent.event} ${hooks.lastEventAge || ''}${hooks.lastEvent.at ? ` (${fmtDateTime(hooks.lastEvent.at, tz())})` : ''}` : 'No hook events observed yet. Start Claude Code with the plugin loaded in a tracked project.'),
      h('dt', null, 'Plugin files'),
      h('dd', null, files.manifest && files.hooksJson && files.hookScript ? `present (skills: ${(files.skills || []).join(', ') || 'none'})` : 'MISSING - check the plugin directory'),
      h('dt', null, 'Claude Code version'),
      h('dd', null, plugin.claudeVersion || 'not checked from the dashboard (run "stopcode doctor" in a terminal)')
    )
  );
  if (hooks.degraded && hooks.lastError) {
    append(card, notice('warn', 'Degraded enforcement', h('span', null, `A hook failed at ${fmtDateTime(hooks.lastError.at, tz())} (${hooks.lastError.event}): ${hooks.lastError.message}. Hooks fail open, so blocking may not have applied.`)));
  } else if (hooks.lastError) {
    append(card, h('p', { class: 'meta' }, `Last hook error (older, no longer degraded): ${fmtDateTime(hooks.lastError.at, tz())} - ${hooks.lastError.message}`));
  }
  return card;
}

function apiCard() {
  const a = doctor.api || {};
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-api' }, h('h2', { id: 'h-api', class: 'card-title' }, icon('key'), 'Claude API (wellness chat)'));
  const last = a.lastTest;
  append(card, 
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Configured'),
      h('dd', null, a.configured ? h('span', null, chip('configured', 'progress'), ` via ${a.source || 'unknown source'}`) : h('span', null, chip('not configured', 'muted'), ' no credentials found')),
      h('dt', null, 'Tested'),
      h('dd', null, a.tested ? h('span', null, chip('tested successfully', 'verified'), last ? ` ${fmtDateTime(last.at, tz())}${Number.isFinite(last.latencyMs) ? `, ${last.latencyMs} ms` : ''}${last.model ? `, ${last.model}` : ''}` : '') : h('span', null, chip('not tested successfully', 'reported'), last && !last.ok ? ` - last attempt ${fmtDateTime(last.at, tz())}: ${last.error && last.error.message ? `${last.error.type || 'error'}: ${last.error.message}` : 'failed'}` : ' - no successful test yet')),
      h('dt', null, 'Model'),
      h('dd', null, a.model || 'unknown'),
      h('dt', null, 'Note'),
      h('dd', null, a.note || '')
    )
  );
  const test = btn('Test connection', { variant: 'primary', iconName: 'refresh', onClick: () => runTest(test) });
  append(card, h('div', { class: 'actions' }, test));
  if (testResult) {
    if (testResult.ok) append(card, notice('ok', 'Connection test succeeded', h('span', null, `Model ${testResult.model || 'unknown'} answered in ${Number.isFinite(testResult.latencyMs) ? testResult.latencyMs : '?'} ms (${fmtDateTime(testResult.at, tz())}).`)));
    else append(card, notice('danger', 'Connection test failed', h('span', null, `${testResult.error && testResult.error.type ? testResult.error.type + ': ' : ''}${(testResult.error && testResult.error.message) || 'unknown error'} (${fmtDateTime(testResult.at, tz())})`)));
  }
  append(card, h('p', { class: 'meta' }, 'Configured means credentials were found; it is never shown as a working connection. Only the test above talks to the API, and the key never leaves the server.'));
  return card;
}

async function runTest(button) {
  try {
    const res = await withBusy(button, 'Testing', () => api.testApi());
    testResult = { at: new Date().toISOString(), ok: !!(res && res.ok), model: res && res.model, latencyMs: res && res.latencyMs, error: res && res.error };
  } catch (e) {
    testResult = { at: new Date().toISOString(), ok: false, error: { type: e.type, message: e.message } };
  }
  try {
    doctor = await api.doctor();
  } catch (e) {
    /* keep the previous doctor data */
  }
  store.refresh();
  render();
}

function boundaryCard() {
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-boundary' },
    h('h2', { id: 'h-boundary', class: 'card-title' }, icon('shield'), 'Boundary preferences'),
    h('p', { class: 'card-sub' }, 'Advice is the optional context StopCode adds to Claude Code prompts (scope drift, long sessions, after hours). It is advisory only and never blocks anything.')
  );
  const enabled = h('input', { id: 'advice-enabled', type: 'checkbox', checked: !!adviceDraft.enabled, onChange: (e) => { adviceDraft.enabled = e.target.checked; } });
  const interval = h('input', {
    id: 'advice-interval',
    class: 'input',
    type: 'number',
    min: '5',
    max: '240',
    step: '1',
    inputmode: 'numeric',
    value: String(adviceDraft.minIntervalMinutes),
    'aria-describedby': adviceError ? 'advice-error' : 'advice-interval-hint',
    'aria-invalid': adviceError ? 'true' : null,
    onInput: (e) => {
      adviceDraft.minIntervalMinutes = e.target.value;
    },
  });
  const save = btn('Save preferences', { variant: 'primary', iconName: 'check', onClick: () => saveAdvice(save) });
  append(card, 
    h('label', { class: 'check', for: 'advice-enabled' }, enabled, h('span', null, 'Add advisory StopCode context to Claude Code prompts')),
    h('div', { class: 'field' }, h('label', { for: 'advice-interval' }, 'Minimum minutes between advice notes'), interval, h('p', { id: 'advice-interval-hint', class: 'hint' }, 'Between 5 and 240 minutes.'), adviceError ? fieldError('advice-error', adviceError) : null),
    h('div', { class: 'actions' }, save)
  );
  return card;
}

async function saveAdvice(button) {
  adviceError = null;
  const n = Number(adviceDraft.minIntervalMinutes);
  if (!Number.isInteger(n) || n < 5 || n > 240) {
    adviceError = 'Enter a whole number of minutes between 5 and 240.';
    render();
    return;
  }
  try {
    const res = await withBusy(button, 'Saving', () => api.patchSettings({ advice: { enabled: !!adviceDraft.enabled, minIntervalMinutes: n } }));
    settings = res.settings;
    adviceDraft = { enabled: settings.advice.enabled !== false, minIntervalMinutes: settings.advice.minIntervalMinutes };
    toast('Boundary preferences saved.', 'ok');
    store.refresh();
  } catch (e) {
    adviceError = errorText(e);
  }
  render();
}

function dataCard() {
  const storage = doctor.storage || {};
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-data' }, h('h2', { id: 'h-data', class: 'card-title' }, icon('database'), 'Data'));
  append(card, 
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Data directory'),
      h('dd', { class: 'mono break-word' }, doctor.dataDir || 'unknown'),
      h('dt', null, 'Storage'),
      h('dd', null, storage.writable ? `writable${storage.lastWriteAt ? `, last write ${fmtDateTime(storage.lastWriteAt, tz())}` : ''}` : `NOT writable${storage.error ? ` - ${storage.error}` : ''}`),
      h('dt', null, 'State file'),
      h('dd', null, storage.stateReadable ? 'readable' : `unreadable${storage.stateError ? ` - ${storage.stateError}` : ''}`),
      storage.lastRecovery ? h('dt', null, 'Last recovery') : null,
      storage.lastRecovery ? h('dd', null, `${fmtDateTime(storage.lastRecovery.at, tz())} from ${storage.lastRecovery.from} (${storage.lastRecovery.error || 'unknown error'})`) : null
    )
  );
  const clearChat = btn('Clear chat history', {
    variant: 'danger',
    iconName: 'trash',
    onClick: async () => {
      const ok = await confirmDialog({ title: 'Clear chat history?', message: 'Deletes the wellness conversation stored in the data directory. Nothing else is affected.', confirmLabel: 'Clear chat', danger: true });
      if (!ok) return;
      try {
        await withBusy(clearChat, 'Clearing', () => api.chatClear());
        toast('Chat history cleared.', 'ok');
      } catch (e) {
        toast(errorText(e), 'danger');
      }
    },
  });
  append(card, h('div', { class: 'actions' }, clearChat), h('p', { class: 'meta' }, 'Per-project export and deletion are on the History tab. Removing the whole data directory: stopcode uninstall --purge-data --yes.'));
  return card;
}

function aboutCard() {
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'h-about' },
    h('h2', { id: 'h-about', class: 'card-title' }, icon('info'), 'About StopCode'),
    h('p', null, 'StopCode preserves your original goal, makes workload visible from real Claude Code hook events, parks unfinished work in an honest Markdown handoff, and protects recovery time you choose with opt-in quiet hours.'),
    h('h3', null, 'What it records'),
    h('ul', { class: 'about-list' }, h('li', null, 'Mission objective, criteria, evidence summaries and scope decisions you enter.'), h('li', null, 'Bounded tool activity from hooks: tool name, relative file path, a short redacted command excerpt, success or failure, timestamps.'), h('li', null, 'Short redacted prompt excerpts, session start and end, breaks you record, planner events, settings.'), h('li', null, 'The wellness chat conversation, stored separately in the data directory.')),
    h('h3', null, 'What it does not record'),
    h('ul', { class: 'about-list' }, h('li', null, 'Your source code, full tool outputs or the Claude Code conversation.'), h('li', null, 'Focus, productivity or burnout scores. Elapsed times are wall-clock durations between recorded events.'), h('li', null, 'Anything outside the local data directory. There is no telemetry and no network traffic other than the optional Claude API call for the wellness chat, made from the server with credentials that never reach this page.'))
  );
}
