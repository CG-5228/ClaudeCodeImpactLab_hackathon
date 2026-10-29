// Time formatting for the dashboard. The API returns UTC ISO strings and the configured
// IANA timezone; everything is rendered with Intl in that zone, 24-hour clock.

const LOCALE = 'en-GB';

function safeTz(tz) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: tz }).format(new Date());
    return tz;
  } catch (e) {
    return undefined;
  }
}

export function toMs(value) {
  if (value === null || value === undefined) return NaN;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function fmt(value, tz, options) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Intl.DateTimeFormat(LOCALE, { timeZone: safeTz(tz), hourCycle: 'h23', ...options }).format(new Date(ms));
}

export function fmtTime(value, tz) {
  return fmt(value, tz, { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(value, tz) {
  return fmt(value, tz, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(value, tz) {
  return fmt(value, tz, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDayHeading(value, tz) {
  return fmt(value, tz, { weekday: 'long', day: '2-digit', month: 'short' });
}

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (rem || parts.length === 0) parts.push(`${rem}m`);
  return parts.slice(0, 2).join(' ');
}

export function humanAge(value, now) {
  const ms = toMs(value);
  const nowMs = toMs(now || new Date());
  if (!Number.isFinite(ms)) return 'never';
  const diff = nowMs - ms;
  if (diff < 45000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

// Wall-clock parts of an instant in a zone.
export function localParts(value, tz) {
  const d = new Date(toMs(value));
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: String(parts.weekday || '').toLowerCase().slice(0, 3),
  };
}

function tzOffsetMinutes(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// Wall-clock parts in tz -> UTC ISO string (DST handled by probing the offset twice).
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = tzOffsetMinutes(guess, tz);
  let result = guess - offset * 60000;
  const offset2 = tzOffsetMinutes(result, tz);
  if (offset2 !== offset) result = guess - offset2 * 60000;
  return new Date(result).toISOString();
}

export function startOfLocalDay(value, tz) {
  const p = localParts(value, tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day }, tz);
}

// Calendar date `days` after the local date of `value`, as {year, month, day}.
export function addLocalDays(value, tz, days) {
  const p = localParts(value, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12, 0, 0));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' of an instant in tz (for <input type="date">).
export function ymdInTz(value, tz) {
  const p = localParts(value, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// 'HH:MM' of an instant in tz (for <input type="time">).
export function hmInTz(value, tz) {
  const p = localParts(value, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function ymdToParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function hmToParts(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

// Combine date + time inputs (wall clock in tz) into a UTC ISO string; null when invalid.
export function combineLocal(ymd, hm, tz) {
  const d = ymdToParts(ymd);
  const t = hmToParts(hm);
  if (!d || !t) return null;
  return zonedToUtc({ ...d, ...t }, tz);
}

export function sameLocalDay(a, b, tz) {
  return ymdInTz(a, tz) === ymdInTz(b, tz);
}
