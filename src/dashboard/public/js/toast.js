// Toasts live in an aria-live="polite" container (see index.html), auto-dismiss after 4 s
// and never take focus.
import { h, icon } from './dom.js';

const ICON_FOR = { ok: 'check', danger: 'alert', info: 'info' };

export function toast(message, tone = 'info') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div', { class: `toast toast-${tone}` }, icon(ICON_FOR[tone] || 'info'), h('span', null, message));
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 260);
  }, 4000);
}
