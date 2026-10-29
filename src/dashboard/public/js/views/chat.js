// Wellness chat: an independent conversation through the StopCode server and the Claude
// API. Nothing here depends on quiet-hours state. Errors are shown as they are (typed),
// never replaced by a canned reply, and suggestion buttons only say "Done" after the
// actions endpoint returned 2xx.
import { h, icon, btn, emptyState, notice, withBusy, preserveFocus, clear, append } from '../dom.js';
import { fmtDateTime, fmtTime } from '../time.js';
import { api, errorText } from '../api.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { store } from '../store.js';

export const id = 'chat';
export const title = 'Wellness chat';

const STARTERS = ['Help me stop for today.', 'What can wait until tomorrow?', 'I feel overloaded.'];
const ERROR_TITLES = {
  missing_credentials: 'API key required',
  auth: 'Authentication failed',
  rate_limit: 'Rate limited',
  timeout: 'Timed out',
  network: 'Server unreachable',
  refusal: 'The assistant declined',
  bad_request: 'Request rejected',
  api_error: 'API error',
};

let container = null;
let root = null;
let live = null;
let data = null; // { conversation, configured, model, shareSummary }
let loadError = null;
let sending = null; // { text } while a message is in flight
let sendError = null; // { error, text } after a failed send
let draft = '';
const done = {}; // `${messageId}:${index}` -> summary (only after a 2xx)
const errors = {}; // `${messageId}:${index}` -> ApiError

export function enter(c) {
  container = c;
  live = h('div', { id: 'chat-live', class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  root = h('div');
  append(container, live, root);
  render();
  load();
}

export function leave() {
  container = null;
  root = null;
  live = null;
}

let lastProjectKey = null;
export function update(state) {
  // Only the "project context" line depends on polling; re-render when the project changes.
  const key = state.view ? `${state.view.project.id}:${state.view.project.name}` : state.projectId || '';
  if (key !== lastProjectKey) {
    lastProjectKey = key;
    if (data) render();
  }
}

function tz() {
  const s = store.get();
  return (s.view && s.view.timezone) || (s.overview && s.overview.settings && s.overview.settings.timezone) || undefined;
}

async function load() {
  loadError = null;
  try {
    data = await api.chat();
  } catch (e) {
    loadError = e;
  }
  render();
}

function announce(text) {
  if (!live) return;
  live.textContent = '';
  setTimeout(() => {
    if (live) live.textContent = text ? `Assistant: ${text}` : '';
  }, 60);
}

// ---------- render ----------

function render() {
  if (!root) return;
  preserveFocus(root, () => {
    clear(root);
    const main = h('div', { class: 'chat-main' });
    const side = h('aside', { class: 'chat-side', 'aria-label': 'Chat settings' });
    append(root, h('div', { class: 'chat' }, main, side));
    append(main, 
      h('h2', { class: 'card-title' }, icon('message'), 'Wellness chat'),
      h('p', { class: 'muted' }, 'A separate conversation with its own history, sent through the local StopCode server to the Claude API. It is not your Claude Code conversation, and it keeps working while quiet hours are active.')
    );
    if (loadError) {
      append(main, notice('danger', 'Could not load the chat', h('span', null, errorText(loadError)), h('div', { class: 'actions' }, btn('Retry', { iconName: 'refresh', onClick: load }))));
      return;
    }
    if (!data) {
      append(main, h('div', { class: 'card', role: 'status', 'aria-label': 'Loading chat' }, h('div', { class: 'skeleton skeleton-line' }), h('div', { class: 'skeleton skeleton-line short' })));
      return;
    }
    if (!data.configured) append(main, configNotice());
    append(main, messagesList(), composer());
    append(side, settingsCard());
  });
}

function configNotice() {
  const ov = store.get().overview;
  const note = ov && ov.doctor && ov.doctor.api && ov.doctor.api.note;
  return notice(
    'warn',
    'API key required',
    h('span', null, note || 'Not configured. Set ANTHROPIC_API_KEY for the dashboard server (a Claude Code subscription does not provide API credentials).'),
    h('span', { class: 'meta' }, 'Set the key in the environment that starts the StopCode server (or in a .env file in the StopCode directory) and restart it. Your history below is kept and the composer stays disabled until then.')
  );
}

function messagesList() {
  const msgs = (data.conversation && data.conversation.messages) || [];
  const list = h('div', { class: 'messages', role: 'log', 'aria-label': 'Conversation' });
  if (!msgs.length && !sending) append(list, emptyState('No messages yet.', 'Say what is on your mind, or pick a starter below.'));
  let lastUserIdx = -1;
  msgs.forEach((m, i) => {
    if (m.role === 'user') lastUserIdx = i;
  });
  msgs.forEach((m, i) => {
    append(list, messageItem(m));
    if (sendError && !sending && i === lastUserIdx) append(list, sendErrorBlock());
  });
  if (sendError && !sending && lastUserIdx < 0) append(list, sendErrorBlock());
  if (sending) append(list, h('article', { class: 'msg msg-user msg-pending' }, h('span', { class: 'msg-role' }, 'You'), h('div', { class: 'bubble' }, sending.text), h('span', { class: 'meta' }, 'Sending...')));
  return list;
}

function messageItem(m) {
  const isUser = m.role === 'user';
  const article = h(
    'article',
    { class: `msg ${isUser ? 'msg-user' : 'msg-assistant'}` },
    h('span', { class: 'msg-role' }, isUser ? 'You' : 'Assistant'),
    h('div', { class: 'bubble' }, m.text || ''),
    m.at ? h('span', { class: 'meta' }, fmtDateTime(m.at, tz())) : null
  );
  if (!isUser && Array.isArray(m.suggestions) && m.suggestions.length) append(article, suggestionsBlock(m));
  return article;
}

const SUGGESTION_ICON = { save_idea: 'bookmark', add_recovery_block: 'calendar', clock_out: 'logout' };

function suggestionsBlock(m) {
  const wrap = h('div', { class: 'suggestions', 'aria-label': 'Suggested actions' });
  m.suggestions.forEach((s, idx) => {
    const key = `${m.id}:${idx}`;
    const col = h('div', { class: 'suggestion' });
    if (done[key]) {
      append(col, btn(`Done - ${done[key]}`, { variant: 'done', size: 'sm', iconName: 'check', disabled: true }));
    } else {
      const b = btn(s.label || s.type, { size: 'sm', iconName: SUGGESTION_ICON[s.type] || 'play', onClick: () => runSuggestion(b, m.id, idx, s, false) });
      append(col, b);
      const err = errors[key];
      if (err) {
        const block = h('div', { class: 'suggestion-error', role: 'alert' }, h('span', null, errorText(err)));
        if (err.status === 409 && err.overlaps && err.overlaps.length) {
          append(block, h('span', null, `Overlaps: ${err.overlaps.map((o) => `${o.title} (${fmtTime(o.start, tz())}-${fmtTime(o.end, tz())})`).join(', ')}`));
          const keep = btn('Keep both', { size: 'sm', onClick: () => runSuggestion(keep, m.id, idx, s, true) });
          append(block, h('div', { class: 'actions' }, keep));
        }
        append(col, block);
      }
    }
    append(wrap, col);
  });
  return wrap;
}

// Convert a model suggestion into the actions-endpoint payload. Recovery blocks are
// turned into absolute ISO start/end on the client.
function toAction(s, allowOverlap) {
  if (s.type === 'save_idea') return { type: 'save_idea', text: s.text || s.label };
  if (s.type === 'add_recovery_block') {
    const start = new Date(Date.now() + (Number(s.minutesFromNow) || 0) * 60000);
    const end = new Date(start.getTime() + (Number(s.durationMinutes) || 20) * 60000);
    return { type: 'add_recovery_block', title: s.title || s.label || 'Recovery block', start: start.toISOString(), end: end.toISOString(), allowOverlap: allowOverlap || undefined };
  }
  if (s.type === 'clock_out') return { type: 'clock_out', quietMinutes: s.quietMinutes, protect: !!s.protect, note: s.note };
  return { ...s };
}

async function runSuggestion(button, messageId, idx, s, allowOverlap) {
  const key = `${messageId}:${idx}`;
  const projectId = store.get().projectId || undefined;
  try {
    const res = await withBusy(button, 'Working', () => api.chatAction({ projectId, action: toAction(s, allowOverlap) }));
    done[key] = (res && res.summary) || 'done';
    delete errors[key];
    toast(`Done - ${done[key]}`, 'ok');
    store.refresh();
  } catch (e) {
    errors[key] = e;
  }
  render();
}

function sendErrorBlock() {
  const e = sendError.error;
  const retry = btn('Retry', { size: 'sm', iconName: 'refresh', onClick: () => send(sendError.text, { retry: true }) });
  return h('div', { class: 'send-error' }, notice('danger', ERROR_TITLES[e.type] || 'Message failed', h('span', null, errorText(e)), h('span', { class: 'meta' }, 'Your message was kept; no reply was generated.'), h('div', { class: 'actions' }, retry)));
}

async function send(text, { retry = false } = {}) {
  const t = String(text || '').trim();
  if (!t || sending || !data || !data.configured) return;
  sending = { text: t };
  sendError = null;
  if (!retry) draft = '';
  render();
  const projectId = store.get().projectId || undefined;
  try {
    const res = await api.chatSend({ text: t, projectId });
    if (res && res.conversation) data.conversation = res.conversation;
    if (res && res.message) {
      const msgs = (data.conversation && data.conversation.messages) || [];
      if (!msgs.some((m) => m.id === res.message.id)) msgs.push(res.message);
      announce(res.message.text);
    }
  } catch (e) {
    sendError = { error: e, text: t };
    try {
      const fresh = await api.chat();
      if (fresh) data = fresh;
    } catch (ignored) {
      /* keep the data we have */
    }
  } finally {
    sending = null;
    render();
    const input = document.getElementById('chat-input');
    if (input && document.activeElement === document.body) input.focus({ preventScroll: true });
  }
}

function composer() {
  const configured = !!data.configured;
  const textarea = h('textarea', {
    id: 'chat-input',
    class: 'input',
    rows: '3',
    maxlength: '4000',
    placeholder: configured ? 'Write a message. Enter sends, Shift+Enter adds a line.' : 'Sending is disabled until an API key is configured.',
    disabled: !configured,
    value: draft,
    'aria-label': 'Message',
    'aria-describedby': 'composer-hint',
    onInput: (e) => {
      draft = e.target.value;
    },
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  });
  const sendBtn = btn(sending ? 'Sending' : 'Send', { variant: 'primary', iconName: 'send', disabled: !configured || !!sending, onClick: () => send(draft) });
  const starters = h('div', { class: 'starters' }, ...STARTERS.map((s) => btn(s, { size: 'sm', disabled: !configured || !!sending, onClick: () => send(s) })));
  return h(
    'div',
    { class: 'composer' },
    h('span', { class: 'label' }, 'Starters'),
    starters,
    h('div', { class: 'composer-row' }, textarea, sendBtn),
    h('p', { id: 'composer-hint', class: 'hint' }, configured ? `Messages go to the Claude API through the local StopCode server${data.model ? ` (configured model: ${data.model})` : ''}. Nothing is sent until you press Send.` : 'Sending is disabled: the dashboard server has no Claude API key. History stays available.')
  );
}

function settingsCard() {
  const s = store.get();
  const projectName = s.view ? s.view.project.name : null;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-chat-settings' }, h('h2', { id: 'h-chat-settings', class: 'card-title' }, icon('shield'), 'What the assistant sees'));
  const toggle = h('input', { id: 'share-summary', type: 'checkbox', checked: !!data.shareSummary, onChange: onShareChange });
  append(card, 
    h('label', { class: 'check', for: 'share-summary' }, toggle, h('span', null, 'Share a short StopCode summary with the assistant')),
    h('p', { class: 'check-desc' }, 'When on, each message carries a brief summary of the selected project (original goal, completion state, elapsed wall-clock time, parked ideas, boundary state); your code and your Claude Code conversation are never part of it.'),
    h('p', { class: 'meta' }, `Project context: ${projectName || 'none selected'}.`)
  );
  const clearBtn = btn('Clear chat', { variant: 'danger', iconName: 'trash', onClick: clearChat });
  append(card, h('div', { class: 'actions' }, clearBtn), h('p', { class: 'meta' }, 'Clearing deletes this conversation from the StopCode data directory. API credentials stay on the server and never appear here.'));
  return card;
}

async function onShareChange(e) {
  const box = e.target;
  const wanted = box.checked;
  box.disabled = true;
  try {
    const res = await api.patchSettings({ chat: { shareSummary: wanted } });
    data.shareSummary = !!(res && res.settings && res.settings.chat && res.settings.chat.shareSummary);
    toast(data.shareSummary ? 'Summary sharing is on.' : 'Summary sharing is off.', 'ok');
  } catch (err) {
    toast(errorText(err), 'danger');
  }
  render();
}

async function clearChat() {
  const ok = await confirmDialog({ title: 'Clear chat history?', message: 'This deletes the whole wellness conversation. Nothing else in StopCode is affected.', confirmLabel: 'Clear chat', danger: true });
  if (!ok) return;
  try {
    const res = await api.chatClear();
    if (res && res.conversation) data.conversation = res.conversation;
    else await load();
    for (const k of Object.keys(done)) delete done[k];
    for (const k of Object.keys(errors)) delete errors[k];
    sendError = null;
    toast('Chat cleared.', 'ok');
  } catch (e) {
    toast(errorText(e), 'danger');
  }
  render();
}
