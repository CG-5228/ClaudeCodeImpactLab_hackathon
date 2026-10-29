// Accessible dialogs: role="dialog" + aria-modal, focus trapped inside, Escape closes,
// focus returns to the opener, and the rest of the app is made inert while open.
import { h, icon, btn, linkBtn, copyText, uid, clear } from './dom.js';
import { toast } from './toast.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const stack = [];

function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function trapTab(event, dialog) {
  const items = focusables(dialog);
  if (!items.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openDialog({ title, description, body, actions = [], size = 'md', onClose, initialFocus, dismissible = true }) {
  const opener = document.activeElement;
  const titleId = uid('dlg-title');
  const descId = description ? uid('dlg-desc') : null;
  const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close dialog', onClick: () => close('dismiss') }, icon('x'));
  const dialog = h(
    'div',
    { class: `dialog dialog-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': descId, tabindex: '-1' },
    h('div', { class: 'dialog-head' }, h('h2', { id: titleId, class: 'dialog-title' }, title), dismissible ? closeBtn : null),
    description ? h('p', { id: descId, class: 'dialog-desc' }, description) : null,
    h('div', { class: 'dialog-body' }, body),
    actions.length ? h('div', { class: 'dialog-actions' }, ...actions) : null
  );
  const backdrop = h('div', { class: 'backdrop' }, dialog);
  const root = document.getElementById('dialogs');
  const app = document.getElementById('app');
  root.appendChild(backdrop);
  app.inert = true;
  for (const entry of stack) entry.backdrop.inert = true;

  let closed = false;
  const entry = { backdrop, dialog, close };
  stack.push(entry);

  function close(reason) {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    backdrop.remove();
    if (!stack.length) app.inert = false;
    else stack[stack.length - 1].backdrop.inert = false;
    if (onClose) onClose(reason);
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  }

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      close('escape');
    } else if (event.key === 'Tab') {
      trapTab(event, dialog);
    }
  });
  if (dismissible) {
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close('dismiss');
    });
  }
  requestAnimationFrame(() => {
    const target = (initialFocus && initialFocus.isConnected ? initialFocus : null) || focusables(dialog)[0] || dialog;
    target.focus();
  });
  return { close, dialog, setActions: (nodes) => replaceActions(dialog, nodes) };
}

function replaceActions(dialog, nodes) {
  let bar = dialog.querySelector('.dialog-actions');
  if (!bar) {
    bar = h('div', { class: 'dialog-actions' });
    dialog.appendChild(bar);
  }
  clear(bar);
  bar.append(...nodes);
}

// Promise<boolean>. `typed` requires the user to type the given text before confirming.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, typed = null, detail = null }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (close) close();
    };
    const okBtn = btn(confirmLabel, { variant: danger ? 'danger' : 'primary', disabled: !!typed });
    const cancelBtn = btn(cancelLabel);
    const body = [h('p', null, message)];
    if (detail) body.push(detail);
    let input = null;
    if (typed) {
      const inputId = uid('confirm-typed');
      input = h('input', { id: inputId, class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${inputId}-hint` });
      input.addEventListener('input', () => {
        okBtn.disabled = input.value.trim() !== typed;
      });
      body.push(h('div', { class: 'field' }, h('label', { for: inputId }, `Type ${typed} to confirm`), input, h('p', { id: `${inputId}-hint`, class: 'hint' }, 'This cannot be undone.')));
    }
    const dlg = openDialog({
      title,
      body: h('div', { class: 'dialog-body' }, ...body),
      actions: [cancelBtn, okBtn],
      onClose: () => finish(false),
      initialFocus: input || cancelBtn,
    });
    cancelBtn.addEventListener('click', () => finish(false, dlg.close));
    okBtn.addEventListener('click', () => finish(true, dlg.close));
  });
}

// Shows a Markdown document (handoff) as text with Copy and Download controls.
export function showMarkdown({ title, markdown, downloadHref, filename, note }) {
  const pre = h('pre', { class: 'markdown', tabindex: '0', 'aria-label': `${title} contents` }, markdown || '(empty)');
  const copyBtn = btn('Copy Markdown', { iconName: 'copy', onClick: async () => toast((await copyText(markdown || '')) ? 'Markdown copied.' : 'Copy failed. Select the text and copy manually.', 'ok') });
  const actions = [copyBtn];
  if (downloadHref) actions.push(linkBtn('Download .md', downloadHref, { iconName: 'download', download: filename || '' }));
  const closeBtn = btn('Close');
  actions.push(closeBtn);
  const dlg = openDialog({ title, size: 'lg', body: h('div', { class: 'dialog-body' }, note || null, pre), actions, initialFocus: closeBtn });
  closeBtn.addEventListener('click', () => dlg.close('close'));
  return dlg;
}
