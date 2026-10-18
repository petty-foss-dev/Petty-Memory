import { can, enc, get } from './api.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading } from './dom.js';
import { kdel, kget, kpost, projectOptions, setStatus } from './knowledge.js';

const NAME_MAX = 120;
const INSTRUCTION_MAX = 1000;
/** The server accepts at most this many chosen preferences per request. */
export const MAX_CHOSEN = 10;

const USAGE = 'A preference is used only when you tick it for one request: Organize in AI chat, or a workflow run. Petty Memory never learns preferences from your chats and never files anything by itself. A project preference can be ticked only for a workflow scoped to that project.';

/**
 * Checkboxes for the saved preferences that apply where a request runs: global ones, plus the given project's own.
 * Ticks survive reloads; a preference that no longer applies is unticked.
 */
export function createPreferenceChooser({ legend, hint }) {
  let all = [];
  let project = null;
  let seq = 0;
  const chosen = new Set();
  const list = h('div', null, loading());
  const el = h('fieldset', { class: 'pref-chooser' }, h('legend', null, legend), hint ? h('p', { class: 'hint' }, hint) : null, list);

  function render() {
    const usable = all.filter((preference) => preference.project === null || preference.project === project);
    for (const id of chosen) if (!usable.some((preference) => preference.id === id)) chosen.delete(id);
    clear(list, usable.length
      ? h('ul', { class: 'plain' }, usable.map((preference) => h('li', null, h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: chosen.has(preference.id), disabled: !chosen.has(preference.id) && chosen.size >= MAX_CHOSEN,
          onChange: (event) => {
            if (event.target.checked) chosen.add(preference.id); else chosen.delete(preference.id);
            render();
          },
        }),
        h('span', null, h('strong', null, preference.name), preference.project ? [' ', h('span', { class: 'badge' }, 'This project only')] : null,
          h('span', { class: 'hint pref-instruction' }, preference.instruction))))))
      : empty('No saved preferences apply here. Add them under Knowledge → Organization preferences.'),
    chosen.size >= MAX_CHOSEN ? h('p', { class: 'hint' }, `You can tick up to ${MAX_CHOSEN} preferences for one request.`) : null);
  }

  async function load(projectId = project) {
    project = projectId;
    const mine = ++seq;
    try {
      const next = await kget('/preferences');
      if (mine !== seq) return;
      all = next;
      render();
    } catch (error) {
      if (mine === seq) clear(list, errorBox(error, () => load(project)));
    }
  }

  return {
    el,
    load,
    selected: () => [...chosen],
    setDisabled(disabled) {
      el.disabled = disabled;
    },
  };
}

export function createPreferencesSection(ctx) {
  const writable = can('write');
  const list = h('div');
  const formBox = h('div');
  let projects = [];
  let form = null;
  let seq = 0;

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? 'an archived project';

  async function refresh({ poll } = {}) {
    const mine = ++seq;
    if (!list.childElementCount) list.append(loading());
    try {
      const [preferences, nextProjects] = await Promise.all([kget('/preferences'), get('/projects')]);
      if (mine !== seq) return;
      projects = nextProjects;
      clear(list, preferences.length
        ? h('ul', { class: 'cards' }, preferences.map((preference) => h('li', { class: 'card' },
          h('div', { class: 'view-head' },
            h('h3', null, preference.name),
            h('span', { class: 'badge' }, preference.project ? `Only in ${projectName(preference.project)}` : 'Everywhere')),
          h('p', { class: 'pre' }, preference.instruction),
          writable ? h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn small', onClick: () => openForm(preference) }, 'Edit'),
            h('button', { type: 'button', class: 'btn small', 'aria-label': `Archive ${preference.name}`, onClick: () => archive(preference) }, 'Archive')) : null)))
        : empty(writable ? 'No organization preferences yet. Add one, such as “File receipts under Finance”.' : 'No organization preferences yet. A read,write token can add them.'));
      if (!poll && form && !form.dirty()) form.syncProjects();
    } catch (error) {
      if (mine === seq) clear(list, errorBox(error, () => refresh()));
    }
  }

  async function archive(preference) {
    const ok = await confirmDialog({
      title: 'Archive this preference?',
      body: `“${preference.name}” stops being offered for AI requests. It stays an archived note you can unarchive.`,
      confirmLabel: 'Archive preference',
    });
    if (!ok) return;
    await ctx.run(() => kdel(`/preferences/${enc(preference.id)}`), { success: 'Preference archived', refreshOutline: false });
    if (form?.id === preference.id) closeForm();
  }

  function closeForm() {
    form = null;
    clear(formBox);
  }

  function openForm(preference) {
    const name = h('input', { type: 'text', value: preference?.name ?? '', maxlength: NAME_MAX, placeholder: 'Derived from the instruction if left empty' });
    const instruction = h('textarea', { rows: 3, maxlength: INSTRUCTION_MAX, required: true, value: preference?.instruction ?? '', placeholder: 'File receipts under Finance, one note per month' });
    const project = h('select', null, projectOptions(projects, preference?.project ?? '', 'Everywhere'));
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, preference ? 'Save preference' : 'Add preference');
    const original = JSON.stringify([name.value, instruction.value, project.value]);
    form = {
      id: preference?.id ?? null,
      dirty: () => JSON.stringify([name.value, instruction.value, project.value]) !== original,
      syncProjects: () => clear(project, projectOptions(projects, project.value, 'Everywhere')),
    };
    const cancel = async () => {
      if (form?.dirty() && !(await confirmDialog({
        title: 'Discard this preference?', body: 'Your changes haven’t been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
      }))) return;
      closeForm();
    };
    clear(formBox, h('form', { class: 'panel stack', 'aria-label': preference ? 'Edit preference' : 'New preference', onSubmit: async (event) => {
      event.preventDefault();
      if (!instruction.value.trim()) return setStatus(status, 'Write the instruction first.', 'error');
      submit.disabled = true;
      setStatus(status, 'Saving…');
      try {
        await kpost('/preferences', {
          ...(preference ? { id: preference.id } : {}),
          name: name.value.trim() || null,
          instruction: instruction.value.trim(),
          project: project.value || null,
        });
        closeForm();
        ctx.notify(preference ? 'Preference saved' : 'Preference added', 'ok');
        await refresh();
      } catch (error) {
        submit.disabled = false;
        setStatus(status, `Not saved: ${error.message}`, 'error');
      }
    } },
    h('h2', null, preference ? 'Edit preference' : 'New preference'),
    field('Instruction', instruction, `Up to ${INSTRUCTION_MAX} characters, saved as written. It guides AI proposals you review; it is never run as a command.`),
    h('div', { class: 'grid2' }, field('Name (optional)', name), field('Applies to', project, 'A project preference is offered only for workflows scoped to that project.')),
    h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel')),
    status));
    instruction.focus();
  }

  const el = h('section', { class: 'knowledge-section', 'aria-labelledby': 'preferences-heading' },
    h('div', { class: 'view-head' },
      h('h2', { id: 'preferences-heading' }, 'Organization preferences'),
      writable ? h('button', { type: 'button', class: 'btn small primary', onClick: () => {
        if (form) return formBox.querySelector('textarea')?.focus();
        openForm(null);
      } }, 'New preference') : null),
    h('p', { class: 'hint' }, USAGE),
    formBox, list);

  return {
    el,
    // Polling redraws the list only; an open form keeps what was typed.
    refresh,
  };
}
