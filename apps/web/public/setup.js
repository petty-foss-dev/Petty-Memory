import { can, currentClient, get, query } from './api.js';
import { clear, h } from './dom.js';

/** Libraries with more than this many items are past first run, so the checklist never appears there. */
const FIRST_RUN_ITEMS = 20;

// Storage can be switched off by the browser; the checklist then just can't stay hidden across reloads.
function remembered(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function remember(key) {
  try { localStorage.setItem(key, '1'); } catch { /* hidden for this page only */ }
}

/** A short first-run list above the outline, built from what this server's library already has. Hiding it is remembered for this token in this browser. */
export function createSetupChecklist({ open }) {
  const key = `petty-memory.web.setup-hidden.${currentClient().id}`;
  const el = h('section', { class: 'panel setup-checklist', 'aria-labelledby': 'setup-heading', hidden: true });
  let dismissed = remembered(key);
  let seq = 0;

  async function refresh() {
    if (dismissed || !can('write')) return;
    const mine = ++seq;
    let items;
    let ai;
    try {
      [items, ai] = await Promise.all([
        get(`/items${query({ limit: FIRST_RUN_ITEMS + 1 })}`),
        get('/ai/status').catch((error) => (error.status === 404 ? null : Promise.reject(error))),
      ]);
    } catch {
      // A first-run hint isn't worth an error; the outline below reports connection problems.
      return;
    }
    if (mine !== seq || dismissed) return;
    if (items.length > FIRST_RUN_ITEMS) {
      el.hidden = true;
      return;
    }
    const configured = ai ? Boolean(ai.configured) : undefined;
    const steps = [
      {
        label: 'Capture a note', detail: 'Write or dictate one in Capture & import. It goes to your Inbox or a project you choose.',
        done: items.length > 0, action: ['Capture', 'capture'],
      },
      {
        label: 'Choose an AI provider (optional)',
        detail: 'For AI chat. It’s chosen on the computer running Petty Memory: in the desktop app’s Settings → AI, or with petty-memory ai use. A local model keeps your notes on that computer; a cloud provider receives the notes you chat about. Everything else works without one.',
        done: configured,
      },
      {
        label: 'Bring in Enve book highlights', detail: 'Import the highlights file Enve exports. Each passage keeps its book and location, and ones already imported are skipped.',
        action: ['Import', 'capture'],
      },
      {
        label: 'Review a little each day', detail: 'Due notes come back on Review, and you choose when to see each again.',
        action: ['Open Review', 'review'],
      },
      {
        label: 'Keep useful AI chats',
        detail: configured
          ? 'In AI chat, Save chat keeps a conversation in your library, and Saved chats searches every one you kept.'
          : 'Once an AI provider is chosen, Save chat in AI chat keeps a conversation, and Saved chats searches every one you kept.',
        action: configured ? ['Open AI chat', 'chat'] : null,
      },
    ];
    const tracked = steps.filter((step) => step.done !== undefined);
    clear(el,
      h('div', { class: 'view-head' },
        h('h2', { id: 'setup-heading' }, 'Getting started'),
        h('button', { type: 'button', class: 'btn small', onClick: () => {
          dismissed = true;
          remember(key);
          el.hidden = true;
        } }, 'Hide')),
      h('p', { class: 'hint' }, `${tracked.filter((step) => step.done).length} of ${tracked.length} done`),
      h('ul', { class: 'plain setup-steps' }, steps.map((step) => h('li', { class: step.done ? 'done' : undefined },
        step.done === undefined
          ? h('span', { class: 'setup-mark', 'aria-hidden': 'true' })
          : h('span', { class: 'setup-mark', role: 'img', 'aria-label': step.done ? 'Done' : 'Not done yet' }, step.done ? '✓' : ''),
        h('span', { class: 'setup-text' }, h('strong', null, step.label), h('span', { class: 'hint' }, step.detail)),
        step.action && !step.done ? h('button', { type: 'button', class: 'btn small', onClick: () => open(step.action[1]) }, step.action[0]) : null))));
    el.hidden = false;
  }

  return { el, refresh };
}
