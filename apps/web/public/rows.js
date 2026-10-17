import { h, when } from './dom.js';
import { displayTitle, isSecret, presentationOf } from './text.js';

export function itemRow(item, ctx, extra) {
  const p = presentationOf(item);
  return h('li', null, h('button', { type: 'button', class: `row attention-${p.attention}`, onClick: () => ctx.select(item.id) },
    h('span', { class: 'row-title' }, isSecret(item) ? '🔒 Secret note' : displayTitle(item)),
    h('span', { class: 'meta' }, [item.type, item.project?.name, extra ?? `updated ${when(item.updatedAt)}`].filter(Boolean).join(' · ')),
    p.review ? h('span', { class: 'badge review' }, 'Review') : null));
}
