'use strict';
// iCalendar (RFC 5545) export for planner events. Times are written as UTC instants
// (the Z form), which every calendar client converts to the viewer's local zone, so no
// VTIMEZONE block is needed and DST is handled by the client. UIDs are stable per event
// and SEQUENCE increases on edits, so re-importing an export updates rather than
// duplicates in clients that honour UID.
const T = require('./time');

const CRLF = '\r\n';

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function fmtUtc(iso) {
  const d = new Date(T.toMs(iso));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// Fold content lines longer than 75 octets (RFC 5545 section 3.1), byte-aware so
// multi-byte characters are never split.
function foldLine(line) {
  const out = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + b > limit) {
      out.push(current);
      current = ' ';
      currentBytes = 1;
      limit = 75;
    }
    current += ch;
    currentBytes += b;
  }
  out.push(current);
  return out.join(CRLF);
}

function buildIcs(events, { timezone, now, calendarName = 'StopCode planner' } = {}) {
  const stamp = fmtUtc(now || new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StopCode//Planner 0.1//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  if (timezone) lines.push(`X-WR-TIMEZONE:${escapeText(timezone)}`);
  for (const e of events) {
    const typeLabel = { work: 'Working hours', recovery: 'Recovery block', personal: 'Personal time' }[e.type] || e.type;
    const description = [`${typeLabel} planned in StopCode.`, e.notes ? String(e.notes) : null, 'Exported from StopCode; later edits in StopCode are not synchronized.'].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}@stopcode.local`);
    lines.push(`DTSTAMP:${e.updatedAt ? fmtUtc(e.updatedAt) : stamp}`);
    lines.push(`DTSTART:${fmtUtc(e.start)}`);
    lines.push(`DTEND:${fmtUtc(e.end)}`);
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    lines.push(`DESCRIPTION:${escapeText(description)}`);
    lines.push(`CATEGORIES:${escapeText(typeLabel)}`);
    lines.push(`SEQUENCE:${Number(e.sequence || 0)}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('TRANSP:OPAQUE');
    lines.push(`X-STOPCODE-TYPE:${escapeText(e.type)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// Lightweight structural check used by tests and the self-check. Returns a list of
// problems (empty when the document looks valid).
function lintIcs(text) {
  const problems = [];
  if (!text.endsWith(CRLF)) problems.push('document must end with CRLF');
  const rawLines = text.split(CRLF);
  for (const l of rawLines) if (Buffer.byteLength(l, 'utf8') > 75) problems.push(`line exceeds 75 octets: ${l.slice(0, 30)}...`);
  if (/(^|[^\r])\n/.test(text)) problems.push('bare LF found; lines must use CRLF');
  // unfold
  const unfolded = text.replace(/\r\n[ \t]/g, '').split(CRLF).filter(Boolean);
  if (unfolded[0] !== 'BEGIN:VCALENDAR') problems.push('missing BEGIN:VCALENDAR');
  if (unfolded[unfolded.length - 1] !== 'END:VCALENDAR') problems.push('missing END:VCALENDAR');
  if (!unfolded.includes('VERSION:2.0')) problems.push('missing VERSION:2.0');
  if (!unfolded.some((l) => l.startsWith('PRODID:'))) problems.push('missing PRODID');
  let depth = 0;
  let inEvent = false;
  let ev = null;
  const uids = new Set();
  for (const l of unfolded) {
    if (l === 'BEGIN:VEVENT') {
      if (inEvent) problems.push('nested VEVENT');
      inEvent = true;
      ev = {};
      depth++;
    } else if (l === 'END:VEVENT') {
      if (!inEvent) problems.push('END:VEVENT without BEGIN');
      for (const req of ['UID', 'DTSTAMP', 'DTSTART']) if (!ev[req]) problems.push(`VEVENT missing ${req}`);
      if (ev.UID && uids.has(ev.UID)) problems.push(`duplicate UID ${ev.UID}`);
      if (ev.UID) uids.add(ev.UID);
      for (const k of ['DTSTAMP', 'DTSTART', 'DTEND']) if (ev[k] && !/^\d{8}T\d{6}Z$/.test(ev[k])) problems.push(`${k} is not a UTC date-time: ${ev[k]}`);
      inEvent = false;
      depth--;
    } else if (inEvent) {
      const i = l.indexOf(':');
      if (i > 0) ev[l.slice(0, i).split(';')[0]] = l.slice(i + 1);
    }
  }
  if (depth !== 0) problems.push('unbalanced BEGIN/END VEVENT');
  return problems;
}

module.exports = { buildIcs, lintIcs, escapeText, fmtUtc, foldLine };
