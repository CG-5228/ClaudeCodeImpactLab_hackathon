'use strict';
// JSON API for the dashboard: every endpoint in docs/API.md, implemented by calling the
// shared core (never by touching state files). Handlers return a plain object (200 JSON),
// attachment(...) for downloads, or withStatus(status, body) for non-200 JSON. Thrown
// errors are mapped to HTTP statuses by http-util.errorResponse in server.js.
const path = require('path');
const V = require('../core/validate');
const { NotFoundError } = require('../core/domain');
const { Planner } = require('../core/planner');
const { buildIcs } = require('../core/ics');
const { doctor } = require('../core/doctor');
const U = require('./http-util');

// '/api/projects/:id/ideas/:ideaId' -> regex + param names. A ':name.ext' segment matches
// '<name>.ext' (used for '/api/planner/:eventId.ics').
function compile(pattern) {
  const keys = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = pattern
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return esc(seg);
      let name = seg.slice(1);
      let suffix = '';
      const dot = name.indexOf('.');
      if (dot > 0) {
        suffix = name.slice(dot);
        name = name.slice(0, dot);
      }
      keys.push(name);
      return suffix ? `([^/]+?)${esc(suffix)}` : '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

function safeName(name) {
  return String(name || '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'project';
}

// planner.get/update/remove throw ValidationError for unknown ids; the API answers 404.
function plannerNotFound(err, id) {
  if (err && err.name === 'ValidationError' && err.field === 'id' && /not found/i.test(err.message)) return new NotFoundError(`Planner event not found: ${id}`);
  return err;
}

function createApi({ sc, chat }) {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, ...compile(pattern), fn });
  const planner = () => new Planner(sc);
  const optBool = (value, field) => V.bool(value, field, { optional: true });
  const icsOptions = () => ({ timezone: sc.settings().timezone, now: sc.now() });

  // :id may be a proj_ id or an absolute path; the core never falls back to the server's
  // own working directory because we always pass the resolved project id onwards.
  function requireProject(ref) {
    const project = sc.resolveProject(ref);
    if (!project) throw new NotFoundError(`No StopCode project matches ${ref}`);
    return project;
  }

  // ----- overview, projects, handoffs, data controls -----
  route('GET', '/api/overview', () => ({ ...sc.overview(), doctor: doctor(sc, { checkClaude: false }) }));
  route('GET', '/api/projects', () => sc.listProjects());
  route('GET', '/api/projects/:id', ({ params }) => sc.projectView(requireProject(params.id).id));
  route('POST', '/api/projects/:id/clock-out', ({ params, body }) => {
    const project = requireProject(params.id);
    const q = body.quiet && typeof body.quiet === 'object' ? body.quiet : null;
    const quiet = q ? { minutes: q.minutes, until: q.until, protect: optBool(q.protect, 'quiet.protect') } : null;
    return sc.clockOut({ project: project.id, note: body.note, quiet, markComplete: optBool(body.markComplete, 'markComplete'), trigger: 'clock_out' });
  });
  route('POST', '/api/projects/:id/resume', ({ params, body }) => sc.resume({ project: requireProject(params.id).id, override: optBool(body.override, 'override') }));
  route('POST', '/api/projects/:id/handoff', ({ params, body }) => sc.saveHandoff({ project: requireProject(params.id).id, note: body.note, trigger: 'manual' }));
  route('GET', '/api/handoffs/:handoffId', ({ params }) => sc.readHandoff(params.handoffId));
  route('GET', '/api/handoffs/:handoffId/download', ({ params }) => {
    const { handoff, markdown, missing } = sc.readHandoff(params.handoffId);
    if (missing || markdown === null) throw new NotFoundError(`The handoff file for ${params.handoffId} is missing on disk`);
    return U.attachment({ body: markdown, filename: path.basename(handoff.path), contentType: 'text/markdown; charset=utf-8' });
  });
  route('GET', '/api/projects/:id/export', ({ params }) => {
    const project = requireProject(params.id);
    const bundle = sc.exportProject(project.id);
    const day = String(bundle.exportedAt || '').slice(0, 10) || 'export';
    return U.attachment({ body: JSON.stringify(bundle, null, 2), filename: `stopcode-${safeName(project.name)}-${day}.json`, contentType: 'application/json; charset=utf-8' });
  });
  route('DELETE', '/api/projects/:id', ({ params }) => sc.deleteProject(requireProject(params.id).id));
  route('DELETE', '/api/projects/:id/history', ({ params }) => sc.deleteSessionHistory(requireProject(params.id).id));

  // ----- scope: ideas, additions, criteria, next action -----
  route('POST', '/api/projects/:id/ideas', ({ params, body }) => sc.parkIdea({ project: requireProject(params.id).id, text: body.text, source: 'dashboard' }));
  route('PATCH', '/api/projects/:id/ideas/:ideaId', ({ params, body }) => sc.updateIdea({ project: requireProject(params.id).id, ideaId: params.ideaId, status: body.status }));
  route('POST', '/api/projects/:id/additions', ({ params, body }) => sc.acceptAddition({ project: requireProject(params.id).id, text: body.text, source: 'user' }));
  route('POST', '/api/projects/:id/criteria/:critId/confirm', ({ params, body }) => sc.confirmCriterion({ project: requireProject(params.id).id, criterion: params.critId, note: body.note }));
  route('POST', '/api/projects/:id/criteria/:critId/status', ({ params, body }) => sc.setCriterionStatus({ project: requireProject(params.id).id, criterion: params.critId, status: body.status, note: body.note }));
  route('POST', '/api/projects/:id/next', ({ params, body }) => sc.setNextAction({ project: requireProject(params.id).id, text: body.text }));

  // ----- quiet hours, monitoring, advice -----
  route('POST', '/api/projects/:id/quiet', ({ params, body }) => sc.startQuiet({ project: requireProject(params.id).id, minutes: body.minutes, until: body.until, protect: optBool(body.protect, 'protect'), reason: 'manual' }));
  route('POST', '/api/projects/:id/quiet/override', ({ params }) => sc.overrideQuiet({ project: requireProject(params.id).id, reason: 'dashboard override' }));
  route('POST', '/api/projects/:id/quiet/end', ({ params }) => sc.endQuiet({ project: requireProject(params.id).id, by: 'user' }));
  route('POST', '/api/projects/:id/monitoring', ({ params, body }) => {
    const project = requireProject(params.id);
    return V.bool(body.paused, 'paused') ? sc.pauseMonitoring({ project: project.id }) : sc.resumeMonitoring({ project: project.id });
  });
  route('POST', '/api/projects/:id/advice/dismiss', ({ params, body }) => sc.dismissAdvice({ project: requireProject(params.id).id, minutes: body.minutes === null ? undefined : body.minutes }));

  // ----- breaks (about the person, not a project) -----
  route('POST', '/api/breaks/start', ({ body }) => sc.startBreak({ note: body.note }));
  route('POST', '/api/breaks/end', () => sc.endBreak());

  // ----- settings -----
  route('GET', '/api/settings', () => sc.settings());
  route('PATCH', '/api/settings', ({ body }) => sc.updateSettings(body));

  // ----- planner (the .ics routes are registered before the :eventId routes on purpose) -----
  route('GET', '/api/planner.ics', () => U.attachment({ body: buildIcs(planner().list(), icsOptions()), filename: 'stopcode-planner.ics', contentType: 'text/calendar; charset=utf-8' }));
  route('GET', '/api/planner/:eventId.ics', ({ params }) => {
    let event;
    try {
      event = planner().get(params.eventId);
    } catch (e) {
      throw plannerNotFound(e, params.eventId);
    }
    return U.attachment({ body: buildIcs([event], icsOptions()), filename: `stopcode-${safeName(event.id)}.ics`, contentType: 'text/calendar; charset=utf-8' });
  });
  route('GET', '/api/planner', ({ query }) => planner().list({ from: query.get('from') || undefined, to: query.get('to') || undefined }));
  route('POST', '/api/planner', ({ body }) => {
    const { allowOverlap, ...fields } = body;
    return planner().create(fields, { allowOverlap: optBool(allowOverlap, 'allowOverlap') });
  });
  route('PATCH', '/api/planner/:eventId', ({ params, body }) => {
    const { allowOverlap, ...fields } = body;
    try {
      return planner().update(params.eventId, fields, { allowOverlap: optBool(allowOverlap, 'allowOverlap') });
    } catch (e) {
      throw plannerNotFound(e, params.eventId);
    }
  });
  route('DELETE', '/api/planner/:eventId', ({ params }) => {
    try {
      return planner().remove(params.eventId);
    } catch (e) {
      throw plannerNotFound(e, params.eventId);
    }
  });

  // ----- doctor -----
  route('GET', '/api/doctor', () => doctor(sc, { checkClaude: false }));
  route('POST', '/api/doctor/test-api', () => chat.testConnection());

  // ----- wellness chat -----
  route('GET', '/api/chat', () => chat.get());
  route('POST', '/api/chat/messages', async ({ body }) => {
    const r = await chat.send({ text: body.text, projectId: body.projectId });
    if (r.ok) return { message: r.message, conversation: r.conversation };
    return U.withStatus(502, { error: r.error, conversation: r.conversation });
  });
  route('POST', '/api/chat/clear', () => chat.clear());
  route('POST', '/api/chat/actions', ({ body }) => chat.runAction({ projectId: body.projectId, action: body.action }));

  // Dispatches one /api request. Throws HttpError for unknown routes and methods.
  async function handle(req, res, { method, url }) {
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const verb = method === 'HEAD' ? 'GET' : method;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== verb) continue;
      const params = {};
      r.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch (e) {
          throw new U.HttpError(400, 'bad_request', `Malformed URL component: ${key}`);
        }
      });
      const body = verb === 'GET' ? {} : await U.readJsonBody(req);
      const result = await r.fn({ params, query: url.searchParams, body, req, res });
      return U.sendResult(res, result);
    }
    if (pathMatched) throw new U.HttpError(405, 'method_not_allowed', `${method} is not supported for ${pathname}`);
    throw new U.HttpError(404, 'not_found', `No API route for ${method} ${pathname}`);
  }

  return { handle, routes: routes.map((r) => ({ method: r.method, pattern: r.pattern })) };
}

module.exports = { createApi, compile };
