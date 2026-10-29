// Small DOM helpers. Everything is built with createElement so user-provided text is
// always inserted as text nodes (no innerHTML with data), which also keeps the strict
// CSP happy: no inline handlers, no inline styles.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Lucide-style 24x24 outline paths (1.5px stroke).
const ICONS = {
  dot: ['M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z'],
  clock: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'M12 6v6l4 2'],
  coffee: ['M10 2v2', 'M14 2v2', 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1', 'M6 2v2'],
  bookmark: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'M12 16v-4', 'M12 8h.01'],
  calendar: ['M8 2v4', 'M16 2v4', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 10h18'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  edit: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
  move: ['m5 9-3 3 3 3', 'm9 5 3-3 3 3', 'm15 19-3 3-3-3', 'm19 9 3 3-3 3', 'M2 12h20', 'M12 2v20'],
  message: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
  play: ['m6 3 14 9-14 9V3z'],
  pause: ['M14 4h4v16h-4z', 'M6 4h4v16H6z'],
  plus: ['M5 12h14', 'M12 5v14'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  activity: ['M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2'],
  loader: ['M21 12a9 9 0 1 1-6.219-8.56'],
  send: ['M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z', 'm21.854 2.147-10.94 10.939'],
  target: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z', 'M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0z', 'M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'],
  bulb: ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4'],
  key: ['M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z', 'M16.5 7.5h.01'],
  database: ['M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z', 'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5', 'M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  layers: ['m12.83 2.18 8.59 3.9a1 1 0 0 1 0 1.83l-8.58 3.91a2 2 0 0 1-1.66 0L2.6 7.9a1 1 0 0 1 0-1.83l8.58-3.9a2 2 0 0 1 1.65 0', 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12', 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17'],
  sun: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
};

export function icon(name, { label, size = 16, className } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon${className ? ' ' + className : ''}`);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const d of ICONS[name] || ICONS.dot) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const BOOLEAN_PROPS = new Set(['disabled', 'checked', 'selected', 'hidden', 'multiple', 'required', 'readOnly', 'open', 'inert', 'autofocus']);
const PROP_ALIASES = { readonly: 'readOnly' };

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

// h('button', { class: 'btn', onClick: fn, 'aria-label': 'x' }, 'Label', icon('x'))
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let deferredValue;
  if (attrs) {
    for (const [rawKey, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      const key = PROP_ALIASES[rawKey] || rawKey;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'value') deferredValue = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (BOOLEAN_PROPS.has(key)) el[key] = !!value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(el, children);
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

// Null-safe append: skips null/false/undefined and flattens arrays (Element.append would
// stringify null into the text "null").
export function append(el, ...children) {
  appendChildren(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function chip(label, tone = 'muted') {
  return h('span', { class: `chip chip-${tone}` }, label);
}

const STATUS_CHIPS = {
  not_started: ['not started', 'muted'],
  in_progress: ['in progress', 'progress'],
  reported_complete: ['reported complete', 'reported'],
  verified: ['verified', 'verified'],
  blocked: ['blocked', 'blocked'],
};

export function statusChip(status) {
  const [label, tone] = STATUS_CHIPS[status] || [String(status || 'unknown').replace(/_/g, ' '), 'muted'];
  return chip(label, tone);
}

export function btn(label, { variant = '', size = '', iconName, onClick, disabled = false, type = 'button', title, attrs = {} } = {}) {
  const classes = ['btn', variant ? `btn-${variant}` : '', size ? `btn-${size}` : ''].filter(Boolean).join(' ');
  return h('button', { type, class: classes, onClick, disabled, title, ...attrs }, iconName ? icon(iconName) : null, h('span', null, label));
}

export function linkBtn(label, href, { iconName, download, size = '', variant = '' } = {}) {
  const classes = ['btn', variant ? `btn-${variant}` : '', size ? `btn-${size}` : ''].filter(Boolean).join(' ');
  return h('a', { class: classes, href, download: download === undefined ? null : download }, iconName ? icon(iconName) : null, h('span', null, label));
}

export function emptyState(title, detail) {
  return h('div', { class: 'empty' }, h('strong', null, title), detail ? h('span', null, detail) : null);
}

export function notice(tone, title, ...body) {
  const names = { warn: 'alert', danger: 'alert', info: 'info', ok: 'check', rest: 'moon' };
  return h('div', { class: `notice notice-${tone}` }, icon(names[tone] || 'info'), h('div', { class: 'notice-body' }, title ? h('strong', null, title) : null, ...body));
}

// Inline field error connected to its input via aria-describedby.
export function fieldError(id, message) {
  return h('p', { id, class: 'field-error', role: 'alert' }, icon('alert', { size: 14 }), h('span', null, message));
}

export function skeletonCard(lines = 3) {
  const card = h('div', { class: 'card', 'aria-hidden': 'true' }, h('div', { class: 'skeleton skeleton-title' }));
  for (let i = 0; i < lines; i++) card.appendChild(h('div', { class: `skeleton skeleton-line${i === lines - 1 ? ' short' : ''}` }));
  return card;
}

// Disable a button and show spinner text while `fn` runs. Restores the original content
// afterwards when the button is still in the document (views usually re-render).
export async function withBusy(button, label, fn) {
  const previous = { disabled: button.disabled, nodes: Array.from(button.childNodes) };
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  clear(button);
  button.append(icon('loader', { className: 'spin' }), h('span', null, label));
  try {
    return await fn();
  } finally {
    if (button.isConnected) {
      button.disabled = previous.disabled;
      button.removeAttribute('aria-busy');
      clear(button);
      button.append(...previous.nodes);
    }
  }
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* fall through to the legacy path */
  }
  const ta = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true', value: text });
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'visually-hidden' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

// Re-render a container while keeping keyboard focus and caret position on the element
// with the same id (polling re-renders must never steal focus or lose typed text).
export function preserveFocus(container, renderFn) {
  const active = document.activeElement;
  const id = active && active.id && container.contains(active) ? active.id : null;
  let selection = null;
  if (id && typeof active.selectionStart === 'number') {
    try {
      selection = [active.selectionStart, active.selectionEnd];
    } catch (e) {
      selection = null;
    }
  }
  renderFn();
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (selection && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(selection[0], selection[1]);
    } catch (e) {
      /* some input types do not support selection ranges */
    }
  }
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : pluralForm || singular + 's'}`;
}
