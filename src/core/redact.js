'use strict';
// Conservative redaction of obvious secrets in the short text excerpts StopCode keeps
// (command excerpts, prompt excerpts). Best effort only; it is not a guarantee.
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gh[ousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/g,
];
const KEY_VALUE = /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer)\b(\s*[:=]\s*|\s+)["']?([^\s"']{6,})/gi;

function redact(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(KEY_VALUE, (m, key) => `${key}=[redacted]`);
  return out;
}

function excerpt(text, max = 160) {
  const clean = redact(String(text || '')).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

module.exports = { redact, excerpt };
