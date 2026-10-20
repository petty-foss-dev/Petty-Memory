import { del, get, patch, post } from './api.js';
import { clear, h } from './dom.js';
import { createCollectionsSection } from './knowledge-collections.js';
import { createMeetingsSection } from './knowledge-meetings.js';
import { createPreferencesSection } from './knowledge-preferences.js';
import { createRecipesSection } from './knowledge-recipes.js';
import { createResearchSection } from './knowledge-research.js';
import { createReviewSection, createSourcesSection } from './knowledge-sources.js';

// Declared as functions so the section modules, which import them back, can use them regardless of load order.
export function kget(path, options) { return get(`/knowledge${path}`, options); }
export function kpost(path, body) { return post(`/knowledge${path}`, body); }
export function kpatch(path, body) { return patch(`/knowledge${path}`, body); }
export function kdel(path) { return del(`/knowledge${path}`); }

export function plural(n, word, many = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

export function projectOptions(projects, chosen, anyLabel) {
  return [
    h('option', { value: '' }, anyLabel),
    chosen && !projects.some((p) => p.id === chosen) ? h('option', { value: chosen, selected: true }, 'Archived project') : null,
    projects.map((p) => h('option', { value: p.id, selected: p.id === chosen }, p.name)),
  ];
}

export function setStatus(node, text, kind = 'hint') {
  node.className = kind;
  node.textContent = text ?? '';
  node.hidden = !text;
}

const SECTIONS = [
  ['recipes', 'Workflows', createRecipesSection],
  ['collections', 'Collections', createCollectionsSection],
  ['research', 'Research', createResearchSection],
  ['meetings', 'Meetings', createMeetingsSection],
  ['sources', 'Sources', createSourcesSection],
  ['review', 'Information review', createReviewSection],
  ['preferences', 'Organization preferences', createPreferencesSection],
];

/** Sections are built on first use and kept, so drafts, selections and proposals survive switching between them. */
export function createKnowledgeView(ctx) {
  const made = new Map();
  let active = SECTIONS[0][0];
  const body = h('div', { class: 'knowledge-body' });
  const tabs = SECTIONS.map(([key, label]) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': key === active ? 'true' : 'false', onClick: () => open(key),
  }, label));

  const section = (key) => {
    if (!made.has(key)) made.set(key, SECTIONS.find(([name]) => name === key)[2](ctx));
    return made.get(key);
  };

  function show(key) {
    if (key !== active) made.get(active)?.leave?.();
    active = key;
    tabs.forEach((tab, index) => tab.setAttribute('aria-pressed', SECTIONS[index][0] === key ? 'true' : 'false'));
    clear(body, section(key).el);
  }

  function open(key) {
    show(key);
    return section(key).refresh();
  }

  const el = h('section', { class: 'view knowledge', 'aria-labelledby': 'knowledge-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'knowledge-heading' }, 'Knowledge')),
    h('p', { class: 'hint' }, 'Reusable AI workflows, typed collections, PDF and recording research, Biscotti meetings, watched sources, information review and organization preferences. Nothing here changes your library until you review and apply it.'),
    h('nav', { 'aria-label': 'Knowledge sections' }, h('ul', { class: 'chips knowledge-tabs' }, tabs.map((tab) => h('li', null, tab)))),
    body);

  return {
    el,
    refresh({ poll } = {}) {
      if (!body.childElementCount) show(active);
      return section(active).refresh({ poll });
    },
    leave() {
      made.get(active)?.leave?.();
    },
    destroy() {
      for (const entry of made.values()) entry.destroy?.();
      made.clear();
      body.replaceChildren();
    },
    /** Opens a section, and for Research a source at a page or time; the shell's refresh follows. */
    reveal(target = {}) {
      const key = SECTIONS.some(([name]) => name === target.section) ? target.section : active;
      show(key);
      section(key).reveal?.(target);
    },
  };
}
