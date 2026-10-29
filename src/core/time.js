'use strict';
// Time helpers. StopCode stores UTC ISO timestamps and renders them in the user's
// configured IANA timezone. All schedule math (working hours, quiet intervals,
// "until tomorrow 09:00") is done with the Intl API so DST is handled by the platform.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function nowIso(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

function toMs(value) {
  if (value === undefined || value === null) return NaN;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (e) {
    return 'UTC';
  }
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (e) {
    return false;
  }
}

// "30m", "90", "1h", "1h30m", "2 hours", "45 min" -> minutes (integer) or null
function parseDuration(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input);
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/g;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2][0];
    if (unit === 'd') total += n * 1440;
    else if (unit === 'h') total += n * 60;
    else total += n;
  }
  if (!matched) return null;
  return Math.round(total);
}

function localParts(value, tz) {
  const d = new Date(toMs(value));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
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
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') parts[p.type] = p.value;
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

// Wall-clock parts in tz -> UTC ISO string.
function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = tzOffsetMinutes(guess, tz);
  let result = guess - offset * 60000;
  const offset2 = tzOffsetMinutes(result, tz);
  if (offset2 !== offset) result = guess - offset2 * 60000;
  return new Date(result).toISOString();
}

function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function startOfLocalDay(value, tz) {
  const p = localParts(value, tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day }, tz);
}

function addLocalDays(value, tz, days) {
  const p = localParts(value, tz);
  const base = Date.UTC(p.year, p.month - 1, p.day + days, 12, 0, 0);
  const q = localParts(base, 'UTC');
  return { year: q.year, month: q.month, day: q.day };
}

// Next occurrence of HH:MM in tz strictly after `from` (today if still ahead, else tomorrow).
function nextLocalTime(hhmm, tz, from) {
  const mins = minutesOfDay(hhmm);
  if (mins === null) return null;
  const fromMs = toMs(from);
  const p = localParts(fromMs, tz);
  const today = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(mins / 60), minute: mins % 60 }, tz);
  if (toMs(today) > fromMs) return today;
  const t = addLocalDays(fromMs, tz, 1);
  return zonedToUtc({ year: t.year, month: t.month, day: t.day, hour: Math.floor(mins / 60), minute: mins % 60 }, tz);
}

function formatTime(value, tz) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function formatDateTime(value, tz) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function formatDate(value, tz) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'short', day: '2-digit' }).format(new Date(ms));
}

function humanDuration(ms) {
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

function humanAge(value, now) {
  const ms = toMs(value);
  const nowMs = toMs(now || new Date());
  if (!Number.isFinite(ms)) return 'never';
  const diff = nowMs - ms;
  if (diff < 45000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

// Working hours: { mon: [{start:'09:00', end:'17:30'}], ... }. Days with no blocks are
// outside working hours. Returns { known, within, dayKey }.
function workingHoursStatus(value, settings) {
  const tz = (settings && settings.timezone) || systemTimezone();
  const wh = settings && settings.workingHours;
  if (!wh || typeof wh !== 'object') return { known: false, within: null, dayKey: null };
  const p = localParts(value, tz);
  const dayKey = DAY_KEYS.includes(p.weekday) ? p.weekday : null;
  const blocks = (dayKey && Array.isArray(wh[dayKey])) ? wh[dayKey] : [];
  const nowMin = p.hour * 60 + p.minute;
  const within = blocks.some((b) => {
    const s = minutesOfDay(b.start);
    const e = minutesOfDay(b.end);
    return s !== null && e !== null && nowMin >= s && nowMin < e;
  });
  return { known: true, within, dayKey };
}

// Next start of a working block after `from` (used for "planned restart time").
function nextWorkingStart(from, settings) {
  const tz = (settings && settings.timezone) || systemTimezone();
  const wh = settings && settings.workingHours;
  if (!wh) return null;
  const fromMs = toMs(from);
  for (let i = 0; i < 8; i++) {
    const dayParts = addLocalDays(fromMs, tz, i);
    const probe = zonedToUtc({ year: dayParts.year, month: dayParts.month, day: dayParts.day, hour: 12 }, tz);
    const key = localParts(probe, tz).weekday;
    const blocks = Array.isArray(wh[key]) ? wh[key] : [];
    const starts = blocks
      .map((b) => minutesOfDay(b.start))
      .filter((m) => m !== null)
      .sort((a, b) => a - b);
    for (const mins of starts) {
      const iso = zonedToUtc({ year: dayParts.year, month: dayParts.month, day: dayParts.day, hour: Math.floor(mins / 60), minute: mins % 60 }, tz);
      if (toMs(iso) > fromMs) return iso;
    }
  }
  return null;
}

module.exports = {
  DAY_KEYS,
  nowIso,
  toMs,
  systemTimezone,
  isValidTimezone,
  parseDuration,
  localParts,
  tzOffsetMinutes,
  zonedToUtc,
  minutesOfDay,
  startOfLocalDay,
  addLocalDays,
  nextLocalTime,
  formatTime,
  formatDateTime,
  formatDate,
  humanDuration,
  humanAge,
  workingHoursStatus,
  nextWorkingStart,
};
