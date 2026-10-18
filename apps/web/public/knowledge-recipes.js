import { can, enc, get } from './api.js';
import { showActions } from './chat.js';
import { referenceLink } from './detail.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading } from './dom.js';
import { kdel, kget, kpost, projectOptions, setStatus } from './knowledge.js';
import { createPreferenceChooser } from './knowledge-preferences.js';
import { pickItem } from './picker.js';

const NAME_MAX = 120;
const INSTRUCTION_MAX = 4000;
const QUERY_MAX = 500;

export function createRecipesSection(ctx) {
  const writable = can('write');
  const aiStatus = h('div');
  const list = h('div');
  const formBox = h('div');
  const runBox = h('div');
  let recipes = [];
  let projects = [];
  let configured = false;
  let form = null;
  let run = null;
  let seq = 0;

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? 'an archived project';
  const open = (id) => ctx.select(id);

  function scopeText(recipe) {
    const { rootId, query, project } = recipe.scope;
    if (rootId) return h('span', null, 'Branch: ', referenceLink(rootId, 'the chosen note', open), ' and everything inside it');
    return h('span', null, `Topic: “${query}”${project ? ` in ${projectName(project)}` : ' across the library'}`);
  }

  async function refresh() {
    const mine = ++seq;
    if (!list.childElementCount) list.append(loading());
    try {
      const [next, nextProjects, status] = await Promise.all([kget('/recipes'), get('/projects'), get('/ai/status').catch(() => ({ configured: false }))]);
      if (mine !== seq) return;
      recipes = next;
      projects = nextProjects;
      configured = Boolean(status.configured);
      clear(aiStatus, configured ? null : h('p', { class: 'hint' },
        'Running a workflow needs an AI provider on the library host. Choose one in the desktop app’s Settings → AI, or run petty-memory ai use. You can still create and edit workflows.'));
      clear(list, recipes.length
        ? h('ul', { class: 'cards' }, recipes.map(recipeCard))
        : empty(writable ? 'No workflows yet. Save an instruction and a branch or topic, then run it whenever you need fresh suggestions.' : 'No workflows yet. A read,write token can create them.'));
      if (run && !recipes.some((recipe) => recipe.id === run.id)) run.gone();
    } catch (error) {
      if (mine === seq) clear(list, errorBox(error, refresh));
    }
  }

  function recipeCard(recipe) {
    const reason = !writable ? 'Applying suggestions needs a read,write token.' : !configured ? 'Set up an AI provider on the host to run workflows.' : '';
    return h('li', { class: 'card' },
      h('h3', null, recipe.name),
      h('p', { class: 'pre recipe-instruction' }, recipe.instruction),
      h('p', { class: 'hint' }, scopeText(recipe)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small primary', disabled: Boolean(reason), title: reason || undefined, onClick: () => openRun(recipe) }, 'Run…'),
        writable ? h('button', { type: 'button', class: 'btn small', onClick: () => openForm(recipe) }, 'Edit') : null,
        writable ? h('button', { type: 'button', class: 'btn small', 'aria-label': `Archive ${recipe.name}`, onClick: () => archive(recipe) }, 'Archive') : null),
      reason ? h('p', { class: 'hint' }, reason) : null);
  }

  async function archive(recipe) {
    const ok = await confirmDialog({
      title: 'Archive this workflow?',
      body: `“${recipe.name}” leaves the list. Nothing it suggested before is changed, and it stays an archived note you can unarchive.`,
      confirmLabel: 'Archive workflow',
    });
    if (!ok) return;
    await ctx.run(() => kdel(`/recipes/${enc(recipe.id)}`), { success: 'Workflow archived', refreshOutline: false });
    if (form?.id === recipe.id) closeForm();
  }

  function closeForm() {
    form = null;
    clear(formBox);
  }

  function openForm(recipe) {
    const scope = recipe?.scope ?? { rootId: null, query: '', project: null };
    let branch = scope.rootId ? { id: scope.rootId, title: null } : null;
    const name = h('input', { type: 'text', required: true, maxlength: NAME_MAX, value: recipe?.name ?? '', placeholder: 'Weekly garden plan' });
    const instruction = h('textarea', { rows: 4, required: true, maxlength: INSTRUCTION_MAX, value: recipe?.instruction ?? '',
      placeholder: 'Suggest tasks with due dates for anything still open, and tag notes that belong together.' });
    const kind = h('select', { 'aria-label': 'Scope' },
      h('option', { value: 'topic', selected: !scope.rootId }, 'A topic (keywords)'),
      h('option', { value: 'branch', selected: Boolean(scope.rootId) }, 'A branch (one note and everything inside it)'));
    const query = h('input', { type: 'search', maxlength: QUERY_MAX, value: scope.query ?? '', placeholder: 'garden beds' });
    const project = h('select', null, projectOptions(projects, scope.project ?? '', 'Whole library'));
    const branchLabel = h('span', { class: 'hint' });
    const branchButton = h('button', { type: 'button', class: 'btn small' });
    const topicFields = h('div', { class: 'grid2' }, field('Topic keywords', query, 'Matched as plain keywords each time it runs.'), field('Project', project));
    const branchFields = h('div', { class: 'actions' }, branchButton, branchLabel);
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, recipe ? 'Save workflow' : 'Create workflow');

    const values = () => JSON.stringify([name.value, instruction.value, kind.value, query.value, project.value, branch?.id ?? null]);
    const original = values();
    const render = () => {
      topicFields.hidden = kind.value !== 'topic';
      branchFields.hidden = kind.value !== 'branch';
      branchButton.textContent = branch ? 'Choose another branch…' : 'Choose a branch…';
      clear(branchLabel, branch ? (branch.title ? `“${branch.title}”` : referenceLink(branch.id, 'the chosen note', open)) : 'No branch chosen.');
    };
    kind.addEventListener('change', render);
    branchButton.addEventListener('click', async () => {
      const picked = await pickItem({ title: 'Choose the branch this workflow works from', filter: { secret: 'false' } });
      if (picked) {
        branch = picked;
        render();
      }
    });
    form = { id: recipe?.id ?? null, dirty: () => values() !== original };
    const cancel = async () => {
      if (form?.dirty() && !(await confirmDialog({
        title: 'Discard this workflow?', body: 'Your changes haven’t been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
      }))) return;
      closeForm();
    };

    clear(formBox, h('form', { class: 'panel stack', 'aria-label': recipe ? 'Edit workflow' : 'New workflow', onSubmit: async (event) => {
      event.preventDefault();
      const nextScope = kind.value === 'branch'
        ? (branch ? { rootId: branch.id, query: null, project: null } : null)
        : (query.value.trim() ? { rootId: null, query: query.value.trim(), project: project.value || null } : null);
      if (!nextScope) return setStatus(status, kind.value === 'branch' ? 'Choose the branch first.' : 'Name the topic first.', 'error');
      submit.disabled = true;
      setStatus(status, 'Saving…');
      try {
        await kpost('/recipes', { ...(recipe ? { id: recipe.id } : {}), name: name.value.trim(), instruction: instruction.value.trim(), scope: nextScope });
        closeForm();
        ctx.notify(recipe ? 'Workflow saved' : 'Workflow created', 'ok');
        await refresh();
      } catch (error) {
        submit.disabled = false;
        setStatus(status, `Not saved: ${error.message}`, 'error');
      }
    } },
    h('h2', null, recipe ? 'Edit workflow' : 'New workflow'),
    field('Name', name),
    field('Instruction', instruction, 'What the AI should suggest. Saved as written and sent with the current notes each time you run it.'),
    field('Works from', kind),
    topicFields, branchFields,
    h('p', { class: 'hint' }, 'A workflow keeps only its name, instruction and scope. It never stores suggestions; every run rereads the notes as they are then.'),
    h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel')),
    status));
    render();
    name.focus();
  }

  /** The proposal stays in this tab only; applying goes through the reviewed action service with its guarded undo. */
  function openRun(recipe) {
    const token = {};
    run = { id: recipe.id, token, gone: () => setStatus(status, 'This workflow was archived or changed elsewhere. You can still review the suggestions already shown.', 'hint') };
    const chooser = createPreferenceChooser({
      legend: 'Organization preferences for this run',
      hint: 'Only the preferences you tick are sent with this run.',
    });
    const out = h('div', { class: 'proposal', 'aria-live': 'polite' });
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const start = h('button', { type: 'button', class: 'btn primary' }, 'Run now');
    const close = h('button', { type: 'button', class: 'btn', onClick: () => { run = null; clear(runBox); } }, 'Close');

    const scopeProject = async () => {
      if (!recipe.scope.rootId) return recipe.scope.project;
      const root = await get(`/items/${enc(recipe.scope.rootId)}`);
      return root.project?.id ?? null;
    };
    scopeProject().then((projectId) => { if (run?.token === token) chooser.load(projectId); },
      (error) => { if (run?.token === token) setStatus(status, `The branch isn’t available: ${error.message}`, 'error'); });

    start.addEventListener('click', async () => {
      start.disabled = true;
      chooser.setDisabled(true);
      setStatus(status, '');
      clear(out, loading('Reading the current notes and asking the AI provider…'));
      try {
        const preferences = chooser.selected();
        const reply = await kpost(`/recipes/${enc(recipe.id)}/run`, preferences.length ? { preferences } : {});
        if (run?.token !== token) return;
        if (reply?.kind !== 'actions' || !Array.isArray(reply.proposal?.operations)) throw new Error('The server sent an unexpected workflow reply.');
        if (!reply.proposal.operations.length) clear(out, empty(reply.proposal.summary || 'The AI didn’t suggest any actions for the notes as they are now.'));
        else {
          showActions(out, reply.proposal, {
            changed: () => ctx.changed(),
            open,
            onDiscard: () => clear(out, h('p', { class: 'hint' }, 'Suggestions discarded. Nothing was changed.')),
          });
          if (reply.proposal.summary) out.prepend(h('p', null, reply.proposal.summary));
        }
      } catch (error) {
        if (run?.token === token) clear(out, errorBox(error));
      } finally {
        if (run?.token === token) {
          start.disabled = false;
          chooser.setDisabled(false);
        }
      }
    });

    clear(runBox, h('section', { class: 'panel stack', 'aria-label': `Run ${recipe.name}` },
      h('h2', null, `Run “${recipe.name}”`),
      h('p', { class: 'hint' }, scopeText(recipe)),
      h('p', { class: 'hint' }, 'The AI reads the branch or topic as it is now and suggests tasks, tags, reminders or a brief. Tick the ones to keep; nothing changes until you apply them, and you can undo afterwards.'),
      chooser.el,
      h('div', { class: 'actions' }, start, close),
      status, out));
    start.focus();
  }

  const el = h('section', { class: 'knowledge-section', 'aria-labelledby': 'recipes-heading' },
    h('div', { class: 'view-head' },
      h('h2', { id: 'recipes-heading' }, 'Workflows'),
      writable ? h('button', { type: 'button', class: 'btn small primary', onClick: () => {
        if (form) return formBox.querySelector('input')?.focus();
        openForm(null);
      } }, 'New workflow') : null),
    h('p', { class: 'hint' }, 'Saved AI instructions for a branch or topic. Each run proposes actions from the notes as they are then; you review every action before anything changes.'),
    aiStatus, formBox, runBox, list);

  return {
    el,
    // Polling redraws the list; the open form, the run panel and its proposal are left as they are.
    refresh,
  };
}
