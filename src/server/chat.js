'use strict';
// Wellness chatbot backend. A separate conversation with its own system prompt and its own
// history (chat/conversations.json), never the Claude Code conversation. Credentials stay
// in this process: they are never written to state, to responses or to logs.
//
// Conversation document shape (sc.store.readChat / writeChat):
//   { version: 1,
//     conversations: { current: { id, createdAt, messages: [
//       { id, role: 'user'|'assistant', text, at,
//         suggestions?: [...],              // assistant turns, validated server-side
//         truncated?: true,                 // assistant turn cut off by max_tokens
//         usage?: {...}, model?: string,    // assistant turns
//         error?: { type, message } }       // user turns that received no reply
//     ] } } }
//
// Honesty rules: the user message is persisted before the API is called; a failed call
// never fabricates an assistant turn; the StopCode summary is only attached when the user
// opted in (settings.chat.shareSummary === true) and is never stored in the history.
const V = require('../core/validate');
const T = require('../core/time');
const { NotFoundError } = require('../core/domain');
const { Planner } = require('../core/planner');
const { redact } = require('../core/redact');
const { randomId } = require('../core/ids');

const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_TOKENS = 2048;
const MAX_MESSAGES = 60; // kept per conversation (oldest trimmed)
const HISTORY_LIMIT = 24; // sent to the model
const MAX_INPUT_CHARS = 4000;
const SUGGESTION_TYPES = ['save_idea', 'add_recovery_block', 'clock_out'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM_PROMPT = [
  "You are the StopCode wellness companion: a brief, supportive work-boundary coach inside a developer's local StopCode dashboard. StopCode helps people who use AI coding tools notice when a task has expanded into more tasks and a longer day, and stop without losing their place.",
  '',
  'Your job in each reply:',
  '- Help the person separate necessary work from optional additions.',
  '- Help them choose a stopping point even when the work is incomplete. Stopping never requires finishing.',
  '- Suggest dropping or deferring tasks, and taking a break they choose.',
  '- When a StopCode summary is provided, use it cautiously: it shows elapsed wall-clock time and recorded events, not focus, effort, or rest. Say so if you lean on it. Absence of activity is not proof of rest.',
  '',
  'Style:',
  '- Default to 2 to 5 short sentences. No essays, no bullet lists unless the person asks for a plan, no repeated questioning. At most one question per reply.',
  '- Warm, plain, specific. Never shame, never praise productivity, never push to "finish one more thing".',
  '- You are not a therapist and do not diagnose burnout, anxiety, or any condition. If someone describes being in danger or in crisis, say you are not able to help with that and suggest they contact local emergency services or a crisis line.',
  '- Do not turn a wind-down conversation into a new backlog. One parked idea or one small next step is enough.',
  '- You have no tools, cannot run code, cannot see files, and cannot change anything by yourself. You may propose structured suggestions (save an idea, add a recovery block, clock out); the person decides by clicking. Never claim an action happened.',
  '',
  'Respond with JSON matching the schema: {"reply": string, "suggestions": [...]} where suggestions has 0 to 3 items and is empty unless clearly useful. Fill unused suggestion fields with "" / 0 / false.',
].join('\n');

// Every property is required so strict schema validation is satisfied; the model fills
// unused fields with "" / 0 / false and normalizeSuggestions() drops what is not needed.
const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: SUGGESTION_TYPES },
          label: { type: 'string' },
          text: { type: 'string' },
          title: { type: 'string' },
          minutesFromNow: { type: 'integer' },
          durationMinutes: { type: 'integer' },
          quietMinutes: { type: 'integer' },
          protect: { type: 'boolean' },
        },
        required: ['type', 'label', 'text', 'title', 'minutesFromNow', 'durationMinutes', 'quietMinutes', 'protect'],
        additionalProperties: false,
      },
    },
  },
  required: ['reply', 'suggestions'],
  additionalProperties: false,
};

const SUMMARY_HEADER = "[StopCode summary shared with the user's consent - elapsed time is wall clock, not focus or rest]";

class ChatError extends Error {
  constructor(type, message, status) {
    super(message);
    this.name = 'ChatError';
    this.type = type;
    this.apiStatus = status;
  }

  toJSON() {
    return { type: this.type, message: this.message, ...(this.apiStatus ? { status: this.apiStatus } : {}) };
  }
}

// ---------- pure helpers ----------

function clip(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Keeps only well-formed suggestions of the three supported types (max 3).
function normalizeSuggestions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= 3) break;
    if (!raw || typeof raw !== 'object' || !SUGGESTION_TYPES.includes(raw.type)) continue;
    const label = clip(raw.label, 80);
    if (!label) continue;
    if (raw.type === 'save_idea') {
      const text = clip(raw.text, 400);
      if (!text) continue;
      out.push({ type: 'save_idea', label, text });
    } else if (raw.type === 'add_recovery_block') {
      out.push({
        type: 'add_recovery_block',
        label,
        title: clip(raw.title, 120) || label.slice(0, 120),
        minutesFromNow: clampInt(raw.minutesFromNow, 0, 1440, 0),
        durationMinutes: clampInt(raw.durationMinutes, 5, 480, 20),
      });
    } else {
      out.push({ type: 'clock_out', label, quietMinutes: clampInt(raw.quietMinutes, 0, 1440, 0), protect: raw.protect === true });
    }
  }
  return out;
}

// Extracts the reply from a Messages response. Structured output arrives as one text
// block containing JSON; if it does not parse, the whole text is the reply.
function interpretResponse(response) {
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();
  const truncated = response.stop_reason === 'max_tokens';
  let reply = text;
  let suggestions = [];
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string') {
        reply = parsed.reply.trim();
        suggestions = normalizeSuggestions(parsed.suggestions);
      }
    } catch (e) {
      /* plain text reply */
    }
  }
  if (!reply) reply = truncated ? '(The reply was cut off before any text arrived. Try a shorter question.)' : '(No reply text was returned.)';
  const usage = response.usage && typeof response.usage === 'object'
    ? {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: response.usage.cache_read_input_tokens } : {}),
      ...(response.usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: response.usage.cache_creation_input_tokens } : {}),
    }
    : undefined;
  const fallbackUsed = content.some((b) => b && b.type === 'fallback');
  return { reply, suggestions, truncated, usage, model: response.model || null, fallbackUsed };
}

function freshConversation(now) {
  return { id: randomId('conv', 4), createdAt: now, messages: [] };
}

function hasCurrent(doc) {
  return !!(doc && doc.conversations && doc.conversations.current && Array.isArray(doc.conversations.current.messages));
}

function normalizeDoc(doc, now) {
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  if (!d.conversations || typeof d.conversations !== 'object') d.conversations = {};
  if (!hasCurrent(d)) d.conversations.current = freshConversation(now);
  d.version = 1;
  return d;
}

function trimConversation(conv) {
  if (conv.messages.length > MAX_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES);
}

function publicConversation(conv) {
  return { id: conv.id, createdAt: conv.createdAt, messages: conv.messages };
}

// History -> Messages API turns. The first turn must be from the user.
function toApiMessages(history) {
  const msgs = [];
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = String(m.text || '').trim();
    if (!text) continue;
    msgs.push({ role: m.role, content: text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function apiMessage(err) {
  const nested = err && err.error && err.error.error && err.error.error.message;
  return String(nested || (err && err.message) || '');
}

// Error text shown to the user: redacted, single line, bounded. Never contains the key.
function cleanText(text) {
  return redact(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`);
}

// ---------- the chat service ----------

function createChat({ sc, env = process.env, log = defaultLog } = {}) {
  let sdk = null; // { Anthropic, client }, created lazily and only with credentials

  const model = () => String(env.STOPCODE_CHAT_MODEL || '').trim() || DEFAULT_MODEL;
  const effort = () => {
    const e = String(env.STOPCODE_CHAT_EFFORT || '').trim().toLowerCase();
    return EFFORTS.includes(e) ? e : 'low';
  };
  const timeoutMs = () => {
    const n = Number(env.STOPCODE_CHAT_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 500 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
  };
  const fallbacksEnabled = () => String(env.STOPCODE_CHAT_FALLBACKS || '').trim().toLowerCase() !== 'off';
  const credentialsPresent = () => !!((env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim()) || (env.ANTHROPIC_AUTH_TOKEN && String(env.ANTHROPIC_AUTH_TOKEN).trim()));

  function missingCredentialsError() {
    return {
      type: 'missing_credentials',
      message: 'No Claude API credentials are configured for the dashboard server. A Claude Code subscription does not provide API credentials. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment or in a .env file in the StopCode directory, then restart `stopcode serve`.',
    };
  }

  // Lazily requires the SDK so hooks and the CLI never load it. Returns null without
  // credentials; never creates a client that could fall back to other credential sources.
  function getSdk() {
    if (sdk) return sdk;
    if (!credentialsPresent()) return null;
    let mod;
    try {
      mod = require('@anthropic-ai/sdk');
    } catch (e) {
      throw new ChatError('api_error', 'The @anthropic-ai/sdk package is not installed. Run `npm install` in the StopCode directory and restart the server.');
    }
    const Anthropic = typeof mod === 'function' ? mod : mod.default;
    const client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY ? String(env.ANTHROPIC_API_KEY).trim() : undefined,
      authToken: !env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN ? String(env.ANTHROPIC_AUTH_TOKEN).trim() : undefined,
      baseURL: env.ANTHROPIC_BASE_URL ? String(env.ANTHROPIC_BASE_URL).trim() : undefined,
      timeout: timeoutMs(),
      maxRetries: 1,
    });
    sdk = { Anthropic, client };
    return sdk;
  }

  // SDK error classes -> the error types in docs/API.md.
  function mapApiError(err, Anthropic) {
    if (err instanceof ChatError) return err.toJSON();
    if (Anthropic) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return { type: 'auth', message: `The Claude API rejected the configured credentials (HTTP ${err.status}). Check ANTHROPIC_API_KEY and restart the dashboard server.`, status: err.status };
      }
      if (err instanceof Anthropic.RateLimitError) return { type: 'rate_limit', message: 'The Claude API is rate limiting requests right now. Wait a moment and try again.', status: err.status || 429 };
      if (err instanceof Anthropic.APIConnectionTimeoutError) return { type: 'timeout', message: `The Claude API did not answer within ${Math.round(timeoutMs() / 1000)} seconds. Try again in a moment.` };
      if (err instanceof Anthropic.APIConnectionError) return { type: 'network', message: `Could not reach the Claude API: ${cleanText(err.message) || 'connection error'}` };
      if (err instanceof Anthropic.BadRequestError) return { type: 'bad_request', message: `The Claude API rejected the request: ${cleanText(apiMessage(err))}`, status: 400 };
      if (err instanceof Anthropic.APIError) return { type: 'api_error', message: `Claude API error${err.status ? ` (HTTP ${err.status})` : ''}: ${cleanText(apiMessage(err)) || 'no details'}`, ...(err.status ? { status: err.status } : {}) };
    }
    return { type: 'api_error', message: `Unexpected error while calling the Claude API: ${cleanText(err && err.message) || 'unknown error'}` };
  }

  function recordCall(ok, extra) {
    sc.store.updateHealth({ api: { lastCall: { ok, at: sc.now(), ...(extra || {}) } } });
  }

  // One model call with bounded retries:
  //   1. beta endpoint with server-side refusal fallbacks (unless STOPCODE_CHAT_FALLBACKS=off)
  //   2. on BadRequestError: once more on the stable endpoint without betas/fallbacks
  //   3. on a BadRequestError about output_config/format: once more without the schema
  async function callModel({ Anthropic, client }, messages) {
    const base = {
      model: model(),
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort: effort(), format: { type: 'json_schema', schema: SCHEMA } },
    };
    const attempts = [];
    let response = null;
    let structured = true;
    if (fallbacksEnabled()) {
      try {
        response = await client.beta.messages.create({ ...base, betas: [FALLBACK_BETA], fallbacks: 'default' });
        attempts.push('beta_fallbacks');
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        attempts.push('beta_fallbacks_rejected');
        log('stopcode chat: the server-side fallback request was rejected (HTTP 400); retrying once with the stable Messages API');
      }
    }
    if (!response) {
      try {
        response = await client.messages.create(base);
        attempts.push('stable');
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError) || !/output_config|format/i.test(apiMessage(e))) throw e;
        attempts.push('stable_format_rejected');
        log('stopcode chat: the structured output format was rejected (HTTP 400); retrying once without a response schema');
        response = await client.messages.create({ ...base, output_config: { effort: effort() } });
        structured = false;
        attempts.push('stable_no_format');
      }
    }
    return { response, structured, attempts };
  }

  // ----- summary (consent-gated) -----

  function pickProjectId(projectId) {
    if (projectId) {
      const p = sc.resolveProject(projectId);
      if (p) return p.id;
    }
    const list = sc.listProjects();
    return list.length ? list[0].id : null;
  }

  // Facts only, no file paths, prompts or code. Never stored in the conversation.
  function buildSummary(projectId) {
    const lines = [SUMMARY_HEADER];
    const id = pickProjectId(projectId);
    const view = id ? sc.projectView(id) : null;
    if (!view) {
      lines.push('No StopCode project has been recorded yet.');
      return lines.join('\n');
    }
    lines.push(`Project: ${view.project.name}`);
    if (view.mission) {
      lines.push(`Original goal: ${view.mission.objective}`);
      lines.push(`Completion: ${view.mission.completion.headline}${view.mission.parkedAt ? ' (mission parked)' : ''}`);
      const open = view.mission.criteria.filter((c) => c.status !== 'verified').slice(0, 4).map((c) => `${c.text} [${String(c.status).replace(/_/g, ' ')}]`);
      if (open.length) lines.push(`Open criteria: ${open.join('; ')}`);
    } else {
      lines.push('No active mission recorded.');
    }
    lines.push(`Coding session: ${view.session ? view.session.elapsedLabel : 'no active coding session recorded'}`);
    lines.push(`Time since last recorded break: ${view.breaks.sinceLastBreakLabel}`);
    lines.push(`Quiet hours: ${view.quiet.active ? `active until ${view.quiet.endsAtLocal}` : 'not active'}`);
    lines.push(`Parked ideas: ${view.ideas.filter((i) => i.status === 'parked').length}`);
    lines.push(`After-hours events recorded today: ${view.activity.afterHoursToday}`);
    lines.push(`Last Claude Code hook event: ${view.integration.lastHookAge || 'none observed yet'}`);
    return lines.join('\n');
  }

  function shareSummaryEnabled() {
    const settings = sc.settings();
    return !!(settings && settings.chat && settings.chat.shareSummary === true);
  }

  // ----- public operations -----

  function get() {
    const now = sc.now();
    const raw = sc.store.readChat();
    const existed = hasCurrent(raw);
    const doc = normalizeDoc(raw, now);
    // Persist a freshly created conversation so its id is stable across reloads.
    if (!existed) sc.store.withLock(() => sc.store.writeChat(doc));
    return {
      conversation: publicConversation(doc.conversations.current),
      configured: credentialsPresent(),
      model: model(),
      effort: effort(),
      shareSummary: shareSummaryEnabled(),
      serverSideFallbacks: fallbacksEnabled(),
    };
  }

  // Marks the user message as unanswered and returns the failure. Nothing else is stored.
  function fail(userMessageId, error, { health = true } = {}) {
    if (health) recordCall(false, { error: { type: error.type, message: error.message } });
    const conversation = sc.store.withLock(() => {
      const doc = normalizeDoc(sc.store.readChat(), sc.now());
      const conv = doc.conversations.current;
      const m = conv.messages.find((x) => x.id === userMessageId);
      if (m) m.error = { type: error.type, message: error.message };
      sc.store.writeChat(doc);
      return publicConversation(conv);
    });
    return { ok: false, error, conversation };
  }

  async function send({ text, projectId } = {}) {
    const t = V.str(text, 'text', { max: MAX_INPUT_CHARS });
    const pid = V.str(projectId, 'projectId', { optional: true, max: 600 }) || null;
    const now = sc.now();
    const userMsg = { id: randomId('msg', 4), role: 'user', text: t, at: now };
    // 1. persist the user message before anything can fail
    const history = sc.store.withLock(() => {
      const doc = normalizeDoc(sc.store.readChat(), now);
      const conv = doc.conversations.current;
      conv.messages.push(userMsg);
      trimConversation(conv);
      sc.store.writeChat(doc);
      return conv.messages.slice(-HISTORY_LIMIT);
    });
    // 2. credentials and SDK
    let api;
    try {
      api = getSdk();
    } catch (e) {
      return fail(userMsg.id, mapApiError(e, null));
    }
    if (!api) return fail(userMsg.id, missingCredentialsError(), { health: false });
    // 3. turns; the summary is appended to the latest user turn only with consent
    const messages = toApiMessages(history);
    if (shareSummaryEnabled() && messages.length) {
      try {
        const last = messages[messages.length - 1];
        last.content = `${last.content}\n\n${buildSummary(pid)}`;
      } catch (e) {
        // A summary problem must never block the conversation; continue without it.
        log(`stopcode chat: could not build the StopCode summary (${e && e.message ? e.message : e}); sending the message without it`);
      }
    }
    // 4. the call
    let outcome;
    try {
      outcome = await callModel(api, messages);
    } catch (e) {
      return fail(userMsg.id, mapApiError(e, api.Anthropic));
    }
    const { response, structured, attempts } = outcome;
    if (response.stop_reason === 'refusal') {
      recordCall(true, { stopReason: 'refusal' });
      const explanation = response.stop_details && response.stop_details.explanation ? ` ${cleanText(response.stop_details.explanation)}` : '';
      return fail(userMsg.id, { type: 'refusal', message: `The assistant declined this request.${explanation}` }, { health: false });
    }
    const parsed = interpretResponse(response);
    recordCall(true, { model: parsed.model || model() });
    const assistant = {
      id: randomId('msg', 4),
      role: 'assistant',
      text: parsed.reply,
      at: sc.now(),
      suggestions: parsed.suggestions,
      ...(parsed.truncated ? { truncated: true } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.fallbackUsed ? { fallbackUsed: true } : {}),
      ...(structured ? {} : { unstructured: true }),
    };
    const conversation = sc.store.withLock(() => {
      const doc = normalizeDoc(sc.store.readChat(), now);
      const conv = doc.conversations.current;
      conv.messages.push(assistant);
      trimConversation(conv);
      sc.store.writeChat(doc);
      return publicConversation(conv);
    });
    return { ok: true, message: assistant, conversation, attempts };
  }

  // Replaces the current conversation with an empty one. The document is written twice
  // on purpose: the store keeps a .bak of the previous file, and the second write makes
  // that backup the empty conversation too, so the cleared text does not linger.
  function clear() {
    const now = sc.now();
    const conversation = sc.store.withLock(() => {
      const doc = { version: 1, conversations: { current: freshConversation(now) } };
      sc.store.writeChat(doc);
      sc.store.writeChat(doc);
      return publicConversation(doc.conversations.current);
    });
    return { ok: true, conversation };
  }

  // Real minimal API call for Settings > "Test connection". Never throws.
  async function testConnection() {
    const at = sc.now();
    const finish = (record, result) => {
      sc.store.updateHealth({ api: record });
      return result;
    };
    if (!credentialsPresent()) {
      const error = missingCredentialsError();
      return finish({ lastTest: { ok: false, at, model: model(), error } }, { ok: false, error });
    }
    let api;
    try {
      api = getSdk();
    } catch (e) {
      const error = mapApiError(e, null);
      return finish({ lastTest: { ok: false, at, model: model(), error } }, { ok: false, error });
    }
    const started = Date.now();
    try {
      const response = await api.client.messages.create({
        model: model(),
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      });
      const latencyMs = Date.now() - started;
      const result = { ok: true, model: response.model || model(), latencyMs };
      return finish({ lastTest: { ...result, at }, lastCall: { ok: true, at } }, result);
    } catch (e) {
      const error = mapApiError(e, api.Anthropic);
      const latencyMs = Date.now() - started;
      return finish({ lastTest: { ok: false, at, model: model(), latencyMs, error }, lastCall: { ok: false, at, error } }, { ok: false, error });
    }
  }

  function resolveActionProject(projectId) {
    if (projectId) {
      const p = sc.resolveProject(String(projectId));
      if (!p) throw new NotFoundError(`Project not found: ${projectId}`);
      return p;
    }
    const list = sc.listProjects();
    return list.length ? sc.resolveProject(list[0].id) : null;
  }

  // Executes one user-approved suggestion through the core. Only three actions exist;
  // the chat has no shell, no coding agent and no repository access.
  function runAction({ projectId, action } = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new V.ValidationError('action is required', 'action');
    if (!SUGGESTION_TYPES.includes(action.type)) {
      throw new V.ValidationError('The wellness chat can only save an idea, add a recovery block, or clock out. Nothing else runs from here.', 'action.type');
    }
    const project = resolveActionProject(projectId);
    const tz = sc.settings().timezone;
    if (action.type === 'save_idea') {
      if (!project) throw new V.ValidationError('No StopCode project to attach this idea to yet. Start a mission from Claude Code first.', 'projectId');
      const result = sc.parkIdea({ project: project.id, text: action.text, source: 'chat' });
      return { ok: true, result, summary: `Parked "${result.idea.text}" for ${project.name}. No new mission was started.` };
    }
    if (action.type === 'add_recovery_block') {
      const planner = new Planner(sc);
      const result = planner.create(
        { title: action.title, type: 'recovery', start: action.start, end: action.end, notes: 'Suggested in StopCode wellness chat' },
        { allowOverlap: V.bool(action.allowOverlap, 'allowOverlap', { optional: true }) }
      );
      const kept = result.overlaps.length ? ` (kept alongside ${result.overlaps.length} overlapping event${result.overlaps.length === 1 ? '' : 's'})` : '';
      return { ok: true, result, summary: `Added recovery block "${result.event.title}" from ${T.formatDateTime(result.event.start, tz)} to ${T.formatTime(result.event.end, tz)}${kept}.` };
    }
    if (!project) throw new V.ValidationError('No StopCode project to clock out of yet.', 'projectId');
    const quietMinutes = clampInt(action.quietMinutes, 0, 1440, 0);
    const protect = V.bool(action.protect, 'protect', { optional: true });
    const result = sc.clockOut({ project: project.id, note: action.note, quiet: quietMinutes > 0 ? { minutes: quietMinutes, protect } : null, trigger: 'chat' });
    const parts = [];
    if (result.handoff) parts.push(result.handoff.ok ? 'handoff saved' : `handoff failed (${result.handoff.error})`);
    if (result.session) parts.push(result.session.endedSessionIds.length ? 'tracked session ended' : 'no active tracked session to end');
    if (result.quiet) {
      if (result.quiet.requested === false) parts.push('no quiet hours requested');
      else if (result.quiet.ok) parts.push(`quiet hours until ${result.quiet.endsAtLocal} (${result.quiet.protect ? `blocking new coding actions in ${project.name}` : 'advisory only'})`);
      else parts.push(`quiet hours failed (${result.quiet.error})`);
    }
    return { ok: result.ok, result, summary: `Clocked out of ${project.name}: ${parts.join('; ')}. ${result.message}` };
  }

  return { get, send, clear, testConnection, runAction, isConfigured: credentialsPresent, buildSummary, model, effort };
}

module.exports = { createChat, ChatError, normalizeSuggestions, interpretResponse, toApiMessages, SYSTEM_PROMPT, SCHEMA, SUGGESTION_TYPES, MAX_MESSAGES, HISTORY_LIMIT, DEFAULT_MODEL, FALLBACK_BETA };
