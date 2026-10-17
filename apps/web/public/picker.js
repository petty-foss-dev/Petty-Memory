import { get, query } from './api.js';
import { errorBox, h, loading } from './dom.js';
import { displayTitle } from './text.js';

const PAGE = 30;
/** The server's largest page; search ranks at most this many. */
const MAX_PAGE = 200;

export function pickItem({ title, exclude = new Set(), extras = [] }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const results = h('ul', { class: 'picker-results', role: 'listbox', 'aria-label': 'Matching items' });
    const input = h('input', { type: 'search', placeholder: 'Search your library', autocomplete: 'off', 'aria-label': 'Search items' });
    const dialog = h('dialog', { class: 'picker', 'aria-label': title },
      h('form', { method: 'dialog', class: 'picker-head', onSubmit: (e) => e.preventDefault() },
        h('h2', null, title),
        input),
      results,
      h('div', { class: 'picker-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => finish(null) }, 'Cancel')));

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      resolve(value);
    };
    dialog.addEventListener('cancel', () => finish(null));

    let seq = 0;
    let want = PAGE;
    let recent = [];
    let cursor;
    // Recent items follow the page cursor; a search widens its ranked list up to the server's limit.
    const search = async (more = false) => {
      const mine = ++seq;
      const shown = results.querySelectorAll('.picker-option').length;
      if (!more) results.replaceChildren(h('li', null, loading('Searching…')));
      const q = input.value.trim();
      try {
        let hits;
        let next = false;
        if (q) {
          if (!more) want = PAGE;
          hits = await get(`/search${query({ q, limit: want })}`);
          next = hits.length === want && want < MAX_PAGE;
        } else {
          if (!more) {
            recent = [];
            cursor = undefined;
          }
          const page = (await get(`/items${query({ limit: PAGE, before: cursor })}`)).map((item) => ({ ...item, preview: item.body }));
          recent = recent.concat(page);
          const last = page.at(-1);
          cursor = last ? `${last.updatedAt},${last.id}` : cursor;
          hits = recent;
          next = page.length === PAGE;
        }
        if (mine !== seq) return;
        const rows = [
          ...extras.map((extra) => option(extra.label, extra.hint ?? '', () => finish(extra.value))),
          ...hits.filter((hit) => !exclude.has(hit.id)).map((hit) => {
            const label = hit.title?.trim() ? hit.title : displayTitle({ title: '', body: hit.preview ?? '' });
            return option(label, `${hit.type}${hit.project ? ` · ${hit.project.name}` : ''}`, () => finish({ id: hit.id, title: label, type: hit.type }));
          }),
        ];
        results.replaceChildren(...(rows.length ? rows : [h('li', { class: 'empty' }, q ? 'Nothing matches.' : 'Your library is empty.')]));
        // Showing more keeps keyboard users where they were: on the first newly listed item.
        if (more) (results.querySelectorAll('.picker-option')[shown] ?? input).focus();
        if (next) {
          results.append(h('li', null, h('button', { type: 'button', class: 'btn small', onClick: (event) => {
            event.target.disabled = true;
            if (q) want = Math.min(MAX_PAGE, want + PAGE);
            search(true);
          } }, q ? 'Show more matches' : 'Show older items')));
        }
      } catch (error) {
        if (mine === seq) results.replaceChildren(h('li', null, errorBox(error, () => search())));
      }
    };
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(), 200);
    });

    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    search();
  });
}

function option(label, hint, choose) {
  return h('li', null, h('button', { type: 'button', class: 'picker-option', role: 'option', onClick: choose },
    h('span', { class: 'picker-title' }, label),
    hint ? h('span', { class: 'hint' }, hint) : null));
}
