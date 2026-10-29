// Shared fetch helper for the local StopCode API (docs/API.md). Every non-GET request
// carries X-StopCode-Request: 1 and a JSON body. Error bodies ({error: {type, message,
// field, details}} plus optional overlaps) become ApiError instances.

export class ApiError extends Error {
  constructor(message, { type = 'unknown', status = 0, field = null, details = null, overlaps = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
    this.field = field;
    this.details = details;
    this.overlaps = Array.isArray(overlaps) ? overlaps : [];
  }
}

function typeForStatus(status) {
  if (status === 400) return 'validation';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 503) return 'locked';
  return 'api_error';
}

function extractOverlaps(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.overlaps)) return data.overlaps;
  const err = data.error;
  if (err && Array.isArray(err.overlaps)) return err.overlaps;
  if (err && err.details) {
    if (Array.isArray(err.details)) return err.details;
    if (Array.isArray(err.details.overlaps)) return err.details.overlaps;
  }
  return [];
}

export async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, cache: 'no-store', credentials: 'same-origin' };
  if (method !== 'GET') {
    headers['X-StopCode-Request'] = '1';
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body === undefined ? {} : body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError('Dashboard server unreachable', { type: 'network', status: 0 });
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(err.message || `Request failed (${res.status}${res.statusText ? ' ' + res.statusText : ''})`, {
      type: err.type || typeForStatus(res.status),
      status: res.status,
      field: err.field || null,
      details: err.details || null,
      overlaps: extractOverlaps(data),
    });
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  overview: () => request('GET', '/api/overview'),
  projects: () => request('GET', '/api/projects'),
  project: (id) => request('GET', `/api/projects/${enc(id)}`),
  clockOut: (id, body) => request('POST', `/api/projects/${enc(id)}/clock-out`, body),
  resume: (id, body) => request('POST', `/api/projects/${enc(id)}/resume`, body),
  saveHandoff: (id, body) => request('POST', `/api/projects/${enc(id)}/handoff`, body),
  handoff: (handoffId) => request('GET', `/api/handoffs/${enc(handoffId)}`),
  handoffDownloadUrl: (handoffId) => `/api/handoffs/${enc(handoffId)}/download`,
  exportUrl: (id) => `/api/projects/${enc(id)}/export`,
  deleteProject: (id) => request('DELETE', `/api/projects/${enc(id)}`),
  deleteHistory: (id) => request('DELETE', `/api/projects/${enc(id)}/history`),
  parkIdea: (id, text) => request('POST', `/api/projects/${enc(id)}/ideas`, { text }),
  updateIdea: (id, ideaId, status) => request('PATCH', `/api/projects/${enc(id)}/ideas/${enc(ideaId)}`, { status }),
  addAddition: (id, text) => request('POST', `/api/projects/${enc(id)}/additions`, { text }),
  confirmCriterion: (id, critId, note) => request('POST', `/api/projects/${enc(id)}/criteria/${enc(critId)}/confirm`, note ? { note } : {}),
  setCriterionStatus: (id, critId, status, note) => request('POST', `/api/projects/${enc(id)}/criteria/${enc(critId)}/status`, { status, note }),
  setNext: (id, text) => request('POST', `/api/projects/${enc(id)}/next`, { text }),
  startQuiet: (id, body) => request('POST', `/api/projects/${enc(id)}/quiet`, body),
  overrideQuiet: (id) => request('POST', `/api/projects/${enc(id)}/quiet/override`),
  endQuiet: (id) => request('POST', `/api/projects/${enc(id)}/quiet/end`),
  monitoring: (id, paused) => request('POST', `/api/projects/${enc(id)}/monitoring`, { paused }),
  dismissAdvice: (id, minutes) => request('POST', `/api/projects/${enc(id)}/advice/dismiss`, minutes ? { minutes } : {}),
  startBreak: (note) => request('POST', '/api/breaks/start', note ? { note } : {}),
  endBreak: () => request('POST', '/api/breaks/end'),
  settings: () => request('GET', '/api/settings'),
  patchSettings: (patch) => request('PATCH', '/api/settings', patch),
  planner: (from, to) => request('GET', `/api/planner?from=${enc(from)}&to=${enc(to)}`),
  createEvent: (body) => request('POST', '/api/planner', body),
  updateEvent: (eventId, body) => request('PATCH', `/api/planner/${enc(eventId)}`, body),
  deleteEvent: (eventId) => request('DELETE', `/api/planner/${enc(eventId)}`),
  plannerIcsUrl: () => '/api/planner.ics',
  eventIcsUrl: (eventId) => `/api/planner/${enc(eventId)}.ics`,
  doctor: () => request('GET', '/api/doctor'),
  testApi: () => request('POST', '/api/doctor/test-api'),
  chat: () => request('GET', '/api/chat'),
  chatSend: (body) => request('POST', '/api/chat/messages', body),
  chatClear: () => request('POST', '/api/chat/clear'),
  chatAction: (body) => request('POST', '/api/chat/actions', body),
};

// Human text for an error, with type-specific wording for the chat/API failure classes.
const TYPE_TEXT = {
  network: 'Dashboard server unreachable.',
  missing_credentials: 'API key required: the dashboard server has no Claude API credentials.',
  auth: 'The Claude API rejected the credentials (authentication failed).',
  rate_limit: 'The Claude API is rate limiting requests right now.',
  timeout: 'The request to the Claude API timed out.',
  refusal: 'The assistant declined to answer this request.',
  bad_request: 'The Claude API rejected the request as malformed.',
  api_error: 'The Claude API returned an error.',
  locked: 'StopCode data is locked by another process; try again in a moment.',
  not_found: 'Not found.',
  conflict: 'This change conflicts with existing data.',
  validation: 'The server rejected the input.',
};

export function errorText(e) {
  if (!e) return 'Unknown error';
  if (e instanceof ApiError) {
    const base = TYPE_TEXT[e.type];
    if (base && e.message && e.message !== base && e.type !== 'network') return `${base} ${e.message}`;
    return base || e.message || 'Request failed';
  }
  return e.message || String(e);
}
