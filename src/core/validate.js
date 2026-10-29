'use strict';
// Small input validators used by every mutation (CLI, hooks, dashboard API).
class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.status = 400;
  }
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function str(value, field, { min = 1, max = 2000, optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, field);
  const v = value.trim();
  if (v.length < min) throw new ValidationError(`${field} is too short`, field);
  if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  return v;
}

function int(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new ValidationError(`${field} must be an integer`, field);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`, field);
  return n;
}

function bool(value, field, { optional = false, fallback = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return fallback;
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new ValidationError(`${field} must be a boolean`, field);
}

function oneOf(value, field, allowed, { optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  if (!allowed.includes(value)) throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`, field);
  return value;
}

function isoDate(value, field, { optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} must be an ISO 8601 date-time`, field);
  return d.toISOString();
}

function timeHHMM(value, field, { optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
  if (!m) throw new ValidationError(`${field} must be HH:MM (24h)`, field);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function timezone(value, field, { optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
  } catch (e) {
    throw new ValidationError(`${field} is not a valid IANA time zone`, field);
  }
  return value;
}

function stringList(value, field, { max = 20, itemMax = 400 } = {}) {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  if (arr.length > max) throw new ValidationError(`${field} has too many items (max ${max})`, field);
  return arr.map((v, i) => str(v, `${field}[${i}]`, { max: itemMax }));
}

module.exports = { ValidationError, str, int, bool, oneOf, isoDate, timeHHMM, timezone, stringList };
