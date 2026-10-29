'use strict';
// Small HTTP helpers shared by server.js and api.js: security headers, JSON and
// attachment responses, bounded JSON body parsing, and the mapping from core errors to
// HTTP status codes described in docs/API.md.
const { ValidationError } = require('../core/validate');
const { NotFoundError, ConflictError } = require('../core/domain');
const { PlannerConflict } = require('../core/planner');
const { LockTimeoutError } = require('../core/store');

const BODY_LIMIT = 256 * 1024;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'";

// Errors raised by the HTTP layer itself (403, 404 for unknown routes, 413, ...).
class HttpError extends Error {
  constructor(status, type, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.extra = extra || null;
  }
}

// Handlers return plain objects (sent as 200 JSON) or one of these two wrappers.
const ATTACHMENT = Symbol('attachment');
const STATUS = Symbol('status');

function attachment({ body, filename, contentType }) {
  return { [ATTACHMENT]: true, body, filename, contentType };
}

function withStatus(status, body) {
  return { [STATUS]: status, body };
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

// RFC 6266 attachment with an ASCII fallback name plus the UTF-8 encoded original.
function sendAttachment(res, { body, filename, contentType }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const ascii = String(filename || 'download').replace(/[^\w.-]+/g, '_');
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(filename || ascii))}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

// Sends whatever a handler returned.
function sendResult(res, result) {
  if (result && result[ATTACHMENT]) return sendAttachment(res, result);
  if (result && result[STATUS]) return sendJson(res, result[STATUS], result.body);
  return sendJson(res, 200, result === undefined ? { ok: true } : result);
}

// Reads a JSON object body of at most `limit` bytes. Rejects with 413 beyond the limit
// (also when Content-Length announces it), 400 for malformed JSON or non-object bodies.
function readJsonBody(req, { limit = BODY_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(() => reject(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`)));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(() => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      let value;
      try {
        value = JSON.parse(text);
      } catch (e) {
        return reject(new HttpError(400, 'invalid_json', 'Request body is not valid JSON'));
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(new HttpError(400, 'invalid_json', 'Request body must be a JSON object'));
      return resolve(value);
    }));
    req.on('error', (e) => finish(() => reject(e)));
  });
}

function is(err, Cls, name) {
  return !!err && ((Cls && err instanceof Cls) || err.name === name);
}

// Maps an error to {status, body}. Unknown errors become a generic 500; the caller logs
// the stack to stderr (never to the client).
function errorResponse(err) {
  if (err instanceof HttpError) return { status: err.status, body: { error: { type: err.type, message: err.message, ...(err.extra || {}) } } };
  if (is(err, ValidationError, 'ValidationError')) return { status: 400, body: { error: { type: 'validation', message: err.message, ...(err.field ? { field: err.field } : {}) } } };
  if (is(err, NotFoundError, 'NotFoundError')) return { status: 404, body: { error: { type: 'not_found', message: err.message } } };
  if (is(err, PlannerConflict, 'PlannerConflict')) {
    const overlaps = Array.isArray(err.overlaps) ? err.overlaps : [];
    return { status: 409, body: { error: { type: 'conflict', message: err.message, details: { overlaps } }, overlaps } };
  }
  if (is(err, ConflictError, 'ConflictError')) return { status: 409, body: { error: { type: 'conflict', message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } } };
  if (is(err, LockTimeoutError, 'LockTimeoutError')) return { status: 503, body: { error: { type: 'locked', message: err.message } } };
  return { status: 500, body: { error: { type: 'internal', message: 'Internal server error' } } };
}

module.exports = { BODY_LIMIT, CSP, HttpError, attachment, withStatus, setSecurityHeaders, sendJson, sendAttachment, sendResult, readJsonBody, errorResponse };
