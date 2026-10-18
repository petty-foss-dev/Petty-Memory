import { can, enc, get, post, query } from './api.js';
import { clear, empty, errorBox, field, h, loading, when } from './dom.js';
import { displayTitle, renderText } from './text.js';
import { referenceLink } from './detail.js';

const QUEUE = 50;
const MAX_DAYS = 3650;
const PRESETS = [[1, 'Tomorrow'], [7, 'Next week'], [30, 'Next month']];

const validDays = (text) => {
  const days = Number(text);
  return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : null;
};

/** One due card at a time; choosing when to see it again moves on to the next. */
export function createReviewView(ctx) {
  const project = h('select', { 'aria-label': 'Review from' }, h('option', { value: '' }, 'Whole library'));
  const progress = h('div', { class: 'progress' });
  const body = h('div');
  const handled = new Set();
  let cards = [];
  let busy = false;
  let seq = 0;
  let days = '3';

  async function refresh() {
    const mine = ++seq;
    if (!body.childElementCount) body.append(loading('Loading what’s due…'));
    try {
      const [queue, projects] = await Promise.all([get(`/review${query({ limit: QUEUE, project: project.value })}`), get('/projects')]);
      if (mine !== seq) return;
      const chosen = project.value;
      clear(project, h('option', { value: '' }, 'Whole library'), projects.map((p) => h('option', { value: p.id, selected: p.id === chosen }, p.name)));
      cards = queue;
      render();
    } catch (error) {
      if (mine === seq) clear(body, errorBox(error, refresh));
    }
  }

  function render() {
    const remaining = cards.filter((card) => !handled.has(card.item.id));
    const total = handled.size + remaining.length;
    clear(progress, total ? [
      h('progress', { max: total, value: handled.size, 'aria-label': 'Reviewed this session' }),
      h('span', { class: 'hint' }, `${handled.size} of ${total}${cards.length === QUEUE ? '+' : ''} reviewed`),
    ] : null);
    const card = remaining[0];
    if (!card) {
      clear(body, empty(handled.size
        ? `All caught up: you reviewed ${handled.size}. Each one comes back on the day you chose.`
        : 'Nothing is due for review. When something is due it shows up here, and each item you schedule comes back on the day you choose.'));
      return;
    }
    const { item } = card;
    const status = h('div', { class: 'review-status', 'aria-live': 'polite' });
    const custom = h('input', { type: 'number', min: 1, max: MAX_DAYS, step: 1, value: days, 'aria-label': 'Days until the next review' });
    const customButton = h('button', { type: 'submit', class: 'btn' }, 'Schedule');
    const buttons = PRESETS.map(([count, label]) => h('button', { type: 'button', class: 'btn', onClick: () => schedule(card, count) }, label));
    const sync = () => {
      days = custom.value;
      const ok = validDays(custom.value) !== null;
      custom.setAttribute('aria-invalid', String(!ok));
      customButton.disabled = busy || !ok || !can('write');
      buttons.forEach((button) => { button.disabled = busy || !can('write'); });
    };
    custom.addEventListener('input', sync);
    clear(body, h('article', { class: 'panel review-card', 'aria-labelledby': 'review-title' },
      h('div', { class: 'view-head' },
        h('h2', { id: 'review-title' }, displayTitle(item)),
        h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(item.id) }, 'Open')),
      h('p', { class: 'hint' }, [
        card.reason,
        card.dueAt ? `due ${when(card.dueAt)}` : null,
        card.lastReviewedAt ? `last reviewed ${when(card.lastReviewedAt)}` : 'not reviewed yet',
        card.reviewCount ? `reviewed ${card.reviewCount} time${card.reviewCount === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ')),
      h('div', { class: 'review-body' }, item.body ? renderText(item.body, (id, label) => referenceLink(id, label, ctx.select)) : empty(item.url ?? 'No text. Open it to see the file or link.')),
      can('write')
        ? h('form', { class: 'actions', 'aria-label': 'See it again', onSubmit: (event) => {
          event.preventDefault();
          const count = validDays(custom.value);
          if (count) schedule(card, count);
        } },
        h('span', { class: 'hint' }, 'See it again'), buttons,
        field('Or in this many days', custom), customButton)
        : h('p', { class: 'hint' }, 'Scheduling needs a token with the write scope.'),
      status));
    sync();
  }

  async function schedule(card, count) {
    if (busy) return;
    busy = true;
    render();
    let failure = null;
    try {
      await post(`/review/${enc(card.item.id)}`, { days: count });
      handled.add(card.item.id);
      ctx.notify(`“${displayTitle(card.item)}” comes back ${count === 1 ? 'tomorrow' : `on ${new Date(Date.now() + count * 86_400_000).toLocaleDateString()}`}`, 'ok');
    } catch (error) {
      failure = error;
    }
    busy = false;
    render();
    if (failure) body.querySelector('.review-status')?.append(errorBox(failure));
  }

  project.addEventListener('change', () => {
    handled.clear();
    body.replaceChildren();
    refresh();
  });

  const el = h('section', { class: 'view', 'aria-labelledby': 'review-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'review-heading' }, 'Review')),
    h('p', { class: 'hint' }, 'Revisit what’s due, then choose when to see each one again.'),
    h('div', { class: 'filters' }, project, progress),
    body);
  // Polling leaves the open card alone while the user is choosing.
  return { el, refresh: ({ poll } = {}) => (poll && body.contains(document.activeElement) ? undefined : refresh()) };
}
