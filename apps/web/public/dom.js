// Every node is built with createElement/textContent; saved text never reaches an HTML parser.
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'type', 'name', 'placeholder', 'required', 'readOnly', 'tabIndex', 'id', 'htmlFor', 'rows', 'min', 'max', 'autocomplete']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    // CSSOM writes are allowed by the CSP, unlike style attributes.
    else if (key === 'style') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : String(child));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function errorBox(error, retry) {
  return h('div', { class: 'error', role: 'alert' },
    h('p', null, error?.message ?? String(error)),
    retry ? h('button', { type: 'button', class: 'btn small', onClick: retry }, 'Try again') : null);
}

export function empty(text) {
  return h('p', { class: 'empty' }, text);
}

export function loading(text = 'Loading…') {
  return h('p', { class: 'loading', role: 'status' }, text);
}

let dialogs = 0;

/**
 * An in-page modal: focus moves into it, the rest of the page is inert, Escape cancels, and focus returns to whatever
 * had it. Used instead of window.confirm/prompt, which block the page and can't be styled or labelled.
 */
function modal({ title, role, content, initial, onCancel }) {
  const opener = document.activeElement;
  const id = `dialog-${++dialogs}`;
  const dialog = h('dialog', { class: 'modal', role, 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-body` },
    h('h2', { id: `${id}-title` }, title),
    content(`${id}-body`));
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    dialog.close();
    dialog.remove();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    onCancel();
  });
  document.body.append(dialog);
  dialog.showModal();
  (initial() ?? dialog).focus();
  return close;
}

export function confirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const finish = (value) => {
      close();
      resolve(value);
    };
    const cancel = h('button', { type: 'button', class: 'btn', onClick: () => finish(false) }, cancelLabel);
    const confirm = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => finish(true) }, confirmLabel);
    const close = modal({
      title,
      role: 'alertdialog',
      content: (bodyId) => [h('p', { id: bodyId }, body), h('div', { class: 'actions' }, cancel, confirm)],
      // A destructive choice never has focus by default, so a stray Enter keeps things as they are.
      initial: () => (danger ? cancel : confirm),
      onCancel: () => finish(false),
    });
  });
}

/** Asks for one line of text. Resolves the accepted text, an `extras` button's value, or null when cancelled. */
export function promptDialog({ title, label, value = '', confirmLabel, hint, validate = (text) => text, extras = [] }) {
  return new Promise((resolve) => {
    const finish = (result) => {
      close();
      resolve(result);
    };
    const input = h('input', { type: 'text', value, autocomplete: 'off', spellcheck: 'false' });
    const error = h('p', { class: 'error', role: 'status', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, confirmLabel);
    const check = () => {
      const accepted = input.value.trim() ? validate(input.value) : null;
      submit.disabled = accepted === null;
      error.textContent = input.value.trim() && accepted === null && hint ? hint : '';
      error.hidden = !error.textContent;
      input.setAttribute('aria-invalid', String(Boolean(input.value.trim()) && accepted === null));
      return accepted;
    };
    input.addEventListener('input', check);
    const close = modal({
      title,
      role: 'dialog',
      content: (bodyId) => h('form', { onSubmit: (event) => {
        event.preventDefault();
        const accepted = check();
        if (accepted !== null) finish(accepted);
      } },
      field(label, input),
      h('div', { id: bodyId }, error),
      h('div', { class: 'actions' },
        extras.map((extra) => h('button', { type: 'button', class: 'btn', onClick: () => finish(extra.value) }, extra.label)),
        h('button', { type: 'button', class: 'btn', onClick: () => finish(null) }, 'Cancel'),
        submit)),
      initial: () => input,
      onCancel: () => finish(null),
    });
    check();
  });
}
