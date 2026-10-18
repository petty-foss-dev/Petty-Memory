import { can, enc, get } from './api.js';
import { referenceLink } from './detail.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, when } from './dom.js';
import { kdel, kget, kpatch, kpost, plural, projectOptions, setStatus } from './knowledge.js';
import { pickItem } from './picker.js';

const NAME_MAX = 120;
const URL_MAX = 2048;
const APPLY_BATCH = 20;
const KINDS = [['url', 'Web page'], ['rss', 'RSS or Atom feed'], ['folder', 'Folder on the library’s computer']];
const SCHEDULE = 'While the library host is running, enabled sources are checked about every 6 hours; the host looks for due checks every 15 minutes. A check only queues previews: nothing is imported or overwritten until you select changes and apply them.';

const kindLabel = (kind) => KINDS.find(([key]) => key === kind)?.[1] ?? kind;

function folderState(folder) {
  if (!folder.approved) return ['Not approved on the library’s computer', 'Approve a folder for this source in the desktop app on the computer that holds the library. The browser never sends folder paths.'];
  if (!folder.available) return ['Approved but unavailable', 'The approved folder can’t be read now. Reconnect the drive, or approve the folder again in the desktop app.'];
  return ['Approved and available', 'Checks read the top level of the approved folder: Markdown, text and PDF files.'];
}

function checkSummary(check) {
  if (!check) return 'Not checked yet.';
  const counts = check.status === 'ok'
    ? [plural(check.found, 'entry', 'entries') + ' found', plural(check.queued, 'change') + ' queued', `${check.unchanged.toLocaleString()} unchanged`,
      check.skipped ? `${check.skipped.toLocaleString()} skipped (archived, too large or unreadable)` : null,
      check.truncated ? 'more existed than one check takes' : null].filter(Boolean).join(' · ')
    : null;
  return `Last checked ${when(check.at)}${check.status === 'ok' ? `: ${counts}.` : check.status === 'stale' ? ': the source changed during the check.' : ': failed.'}`;
}

function safeLink(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, raw);
  } catch {}
  return raw;
}

export function createSourcesSection(ctx) {
  const writable = can('write');
  const list = h('div');
  const formBox = h('div');
  const focusBox = h('div');
  let watches = [];
  let projects = [];
  let form = null;
  let focus = null;
  let seq = 0;

  async function refresh() {
    const mine = ++seq;
    if (!list.childElementCount) list.append(loading());
    try {
      const [next, nextProjects] = await Promise.all([kget('/sources'), get('/projects')]);
      if (mine !== seq) return;
      watches = next;
      projects = nextProjects;
    } catch (error) {
      if (mine === seq) clear(list, errorBox(error, refresh));
      return;
    }
    clear(list, watches.length
      ? h('ul', { class: 'cards' }, watches.map(watchCard))
      : empty(writable ? 'No watched sources yet. Add a web page, a feed, or a folder approved on the library’s computer.' : 'No watched sources yet.'));
    if (focus && !watches.some((watch) => watch.id === focus.id)) {
      focus = null;
      clear(focusBox, h('p', { class: 'hint' }, 'That source was removed elsewhere. Anything already imported from it stays in your library.'));
    }
  }

  function watchCard(watch) {
    const folder = watch.folder ? folderState(watch.folder) : null;
    const checkReason = !writable ? 'Checking needs a read,write token.'
      : watch.kind === 'folder' && !watch.folder?.approved ? 'Approve the folder in the desktop app first.'
        : watch.kind === 'folder' && !watch.folder?.available ? 'The approved folder can’t be read now.' : '';
    return h('li', { class: `card${watch.enabled ? '' : ' inactive'}` },
      h('div', { class: 'view-head' },
        h('h3', null, watch.name),
        h('span', { class: 'badge' }, kindLabel(watch.kind))),
      watch.url ? h('p', { class: 'url' }, safeLink(watch.url)) : null,
      h('p', { class: 'hint' }, [watch.project ? `Files into ${watch.project.name}` : 'Files into the Inbox', watch.enabled ? 'Checked automatically while the host runs' : 'Automatic checks off'].join(' · ')),
      folder ? h('p', { class: 'hint' }, h('strong', null, folder[0]), `. ${folder[1]}`) : null,
      h('p', { class: 'hint' }, checkSummary(watch.lastCheck)),
      watch.lastCheck?.error ? h('p', { class: 'error' }, watch.lastCheck.error) : null,
      h('div', { class: 'actions' },
        writable ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: watch.enabled, onChange: (event) => toggle(watch, event.target) }), 'Check automatically') : null,
        h('button', { type: 'button', class: 'btn small', disabled: Boolean(checkReason), title: checkReason || undefined, onClick: (event) => check(watch, event.target) }, 'Check now'),
        h('button', { type: 'button', class: `btn small${watch.pending ? ' primary' : ''}`, onClick: () => openQueue(watch) }, watch.pending ? `Review ${plural(watch.pending, 'change')}` : 'Review queue'),
        writable ? h('button', { type: 'button', class: 'btn small', onClick: () => openForm(watch) }, 'Edit') : null,
        writable && watch.folder?.approved ? h('button', { type: 'button', class: 'btn small', onClick: () => revoke(watch) }, 'Forget folder approval') : null,
        writable ? h('button', { type: 'button', class: 'btn small danger', 'aria-label': `Remove ${watch.name}`, onClick: () => remove(watch) }, 'Remove') : null),
      checkReason && writable ? h('p', { class: 'hint' }, checkReason) : null);
  }

  async function toggle(watch, box) {
    box.disabled = true;
    const saved = await ctx.run(() => kpatch(`/sources/${enc(watch.id)}`, { enabled: box.checked }), {
      success: box.checked ? `“${watch.name}” will be checked automatically` : `Automatic checks off for “${watch.name}”`, refreshOutline: false,
    });
    if (!saved) {
      box.checked = !box.checked;
      box.disabled = false;
    }
  }

  async function check(watch, button) {
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const queue = await kpost(`/sources/${enc(watch.id)}/check`);
      ctx.notify(queue.check?.status === 'ok' ? `Checked “${watch.name}”: ${plural(queue.candidates.length, 'change')} to review` : `Check of “${watch.name}” didn’t finish: ${queue.check?.error ?? 'try again'}`, queue.check?.status === 'ok' ? 'ok' : 'error');
      await refresh();
      if (queue.candidates.length) openQueue({ ...watch, pending: queue.candidates.length }, queue);
    } catch (error) {
      ctx.notify(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Check now';
    }
  }

  async function revoke(watch) {
    const ok = await confirmDialog({
      title: 'Forget the folder approval?',
      body: `“${watch.name}” stops reading its folder and its queued previews are cleared. Imported items stay. Approving a folder again is done in the desktop app on the library’s computer.`,
      confirmLabel: 'Forget approval',
    });
    if (ok) await ctx.run(() => kpost(`/sources/${enc(watch.id)}/revoke-folder`), { success: 'Folder approval forgotten', refreshOutline: false });
  }

  async function remove(watch) {
    const ok = await confirmDialog({
      title: 'Remove this watched source?',
      body: `“${watch.name}” stops being checked and its queued previews are dropped. Everything already imported from it stays in your library.`,
      confirmLabel: 'Remove source', danger: true,
    });
    if (!ok) return;
    if (await ctx.run(() => kdel(`/sources/${enc(watch.id)}`), { success: 'Source removed', refreshOutline: false })) {
      if (form?.id === watch.id) closeForm();
    }
  }

  function closeForm() {
    form = null;
    clear(formBox);
  }

  function openForm(watch) {
    const name = h('input', { type: 'text', required: true, maxlength: NAME_MAX, value: watch?.name ?? '', placeholder: 'Library opening hours' });
    const kind = h('select', { disabled: Boolean(watch) }, KINDS.map(([value, text]) => h('option', { value, selected: value === (watch?.kind ?? 'url') }, text)));
    const url = h('input', { type: 'url', maxlength: URL_MAX, value: watch?.url ?? '', placeholder: 'https://example.org/news' });
    const project = h('select', null, projectOptions(projects, watch?.project?.id ?? '', 'Inbox'));
    const enabled = h('input', { type: 'checkbox', checked: watch?.enabled ?? false });
    const urlField = field('Address', url, 'Only http and https addresses without a user name or password.');
    const folderHint = h('p', { class: 'hint' }, 'After saving, approve the folder in the desktop app on the computer that holds the library. The browser never sends folder paths; remote clients can only check and apply folders already approved there.');
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, watch ? 'Save source' : 'Add source');
    const render = () => {
      urlField.hidden = kind.value === 'folder';
      folderHint.hidden = kind.value !== 'folder';
    };
    kind.addEventListener('change', render);
    const values = () => JSON.stringify([name.value, kind.value, url.value, project.value, enabled.checked]);
    const original = values();
    form = { id: watch?.id ?? null, dirty: () => values() !== original };
    const cancel = async () => {
      if (form?.dirty() && !(await confirmDialog({
        title: 'Discard this source?', body: 'Your changes haven’t been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
      }))) return;
      closeForm();
    };
    clear(formBox, h('form', { class: 'panel stack', 'aria-label': watch ? 'Edit watched source' : 'New watched source', onSubmit: async (event) => {
      event.preventDefault();
      const folder = kind.value === 'folder';
      if (!folder && !url.value.trim()) return setStatus(status, 'Enter the address to watch.', 'error');
      submit.disabled = true;
      setStatus(status, 'Saving…');
      try {
        const body = { name: name.value.trim(), project: project.value || null, enabled: enabled.checked, ...(folder ? {} : { url: url.value.trim() }) };
        if (watch) await kpatch(`/sources/${enc(watch.id)}`, body);
        else await kpost('/sources', { ...body, kind: kind.value });
        closeForm();
        ctx.notify(watch ? 'Source saved' : 'Source added', 'ok');
        await refresh();
      } catch (error) {
        submit.disabled = false;
        setStatus(status, `Not saved: ${error.message}`, 'error');
      }
    } },
    h('h2', null, watch ? `Edit “${watch.name}”` : 'New watched source'),
    h('div', { class: 'grid2' }, field('Name', name), field('Kind', kind, watch ? 'A source’s kind can’t change.' : null)),
    urlField, folderHint,
    field('File new items into', project),
    h('label', { class: 'check' }, enabled, 'Check automatically while the library host runs'),
    h('p', { class: 'hint' }, 'Changing the address, project or folder clears previews queued for the old settings.'),
    h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel')),
    status));
    render();
    name.focus();
  }

  /** Previews stay as reviewed: the selection survives refreshes, and a stale preview is refused by the server, not overwritten. */
  async function openQueue(watch, preloaded) {
    const token = {};
    focus = { id: watch.id, token };
    const chosen = new Set();
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const box = h('div', { 'aria-live': 'polite' }, loading('Loading the review queue…'));
    const apply = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Apply selected');
    const label = () => {
      apply.textContent = chosen.size ? `Apply ${plural(chosen.size, 'change')}` : 'Apply selected';
      apply.disabled = !writable || chosen.size === 0;
      box.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = !writable || (!input.checked && chosen.size >= APPLY_BATCH); });
    };
    clear(focusBox, h('section', { class: 'panel stack', 'aria-label': `Review queue for ${watch.name}` },
      h('div', { class: 'view-head' }, h('h3', null, `Review “${watch.name}”`),
        h('button', { type: 'button', class: 'btn small', onClick: () => { focus = null; clear(focusBox); } }, 'Close')),
      h('p', { class: 'hint' }, `Tick up to ${APPLY_BATCH} previews to import or update. They apply together or not at all. Changed pages keep your own notes and history; changed files become a new snapshot that supersedes the earlier one.`),
      box,
      h('div', { class: 'actions' }, apply),
      status));

    const load = async () => {
      try {
        const queue = preloaded ?? await kget(`/sources/${enc(watch.id)}/queue`);
        preloaded = null;
        if (focus?.token !== token) return;
        for (const id of chosen) if (!queue.candidates.some((candidate) => candidate.id === id)) chosen.delete(id);
        clear(box,
          queue.check ? h('p', { class: 'hint' }, checkSummary(queue.check)) : null,
          queue.candidates.length
            ? h('ul', { class: 'plain queue-list' }, queue.candidates.map((candidate) => h('li', { class: 'queue-item' },
              h('label', { class: 'check' },
                h('input', { type: 'checkbox', checked: chosen.has(candidate.id), onChange: (event) => {
                  if (event.target.checked) chosen.add(candidate.id); else chosen.delete(candidate.id);
                  label();
                } }),
                h('span', { class: 'badge' }, candidate.change === 'new' ? 'New' : 'Changed'),
                h('strong', null, candidate.title)),
              h('p', { class: 'hint' }, [
                candidate.url ? null : candidate.key,
                candidate.publishedAt ? `published ${when(candidate.publishedAt)}` : null,
                candidate.file ? `${candidate.file.mimeType} · ${(candidate.file.size / 1024).toFixed(0)} KB · modified ${when(candidate.file.modifiedAt)}` : null,
                `checked ${when(candidate.checkedAt)}`,
              ].filter(Boolean).join(' · ')),
              candidate.url ? h('p', { class: 'url' }, safeLink(candidate.url)) : null,
              h('p', { class: 'hint' }, candidate.targetId
                ? ['Updates ', referenceLink(candidate.targetId, 'an item in your library', (id) => ctx.select(id)), candidate.file ? ' with a new snapshot; the earlier one is kept.' : '; its source text is replaced and your own note stays.']
                : candidate.file ? 'Imports a new file.' : 'Imports a new item.'),
              candidate.text ? h('details', null,
                h('summary', null, candidate.file ? 'Preview of the file’s text' : 'Text that will be stored'),
                h('div', { class: 'pre queue-text', tabIndex: 0 }, candidate.text),
                candidate.truncated ? h('p', { class: 'hint' }, 'Shortened to the stored limit.') : null)
                : h('p', { class: 'hint' }, candidate.file ? 'No text preview for this file type.' : 'No text.'))))
            : empty('Nothing waiting for review.'));
        label();
      } catch (error) {
        if (focus?.token === token) clear(box, errorBox(error, load));
      }
    };
    focus.reload = load;

    apply.addEventListener('click', async () => {
      if (!chosen.size) return;
      apply.disabled = true;
      setStatus(status, 'Applying…');
      try {
        const result = await kpost(`/sources/${enc(watch.id)}/apply`, { candidateIds: [...chosen] });
        if (focus?.token !== token) return;
        chosen.clear();
        setStatus(status, '');
        status.replaceChildren();
        status.className = 'ok';
        status.hidden = false;
        status.append(`Applied ${plural(result.applied.length, 'change')}. `,
          ...result.applied.flatMap((entry, index) => [index ? ', ' : '', referenceLink(entry.itemId, entry.change === 'new' ? 'New item' : 'Updated item', (id) => ctx.select(id))]));
        await ctx.changed({ detail: false });
        await load();
      } catch (error) {
        if (focus?.token !== token) return;
        setStatus(status, error.message, 'error');
        label();
      }
    });
    await load();
  }

  const el = h('section', { class: 'knowledge-section', 'aria-labelledby': 'sources-heading' },
    h('div', { class: 'view-head' },
      h('h2', { id: 'sources-heading' }, 'Watched sources'),
      writable ? h('button', { type: 'button', class: 'btn small primary', onClick: () => {
        if (form) return formBox.querySelector('input')?.focus();
        openForm(null);
      } }, 'New source') : null),
    h('p', { class: 'hint' }, SCHEDULE),
    formBox, list, focusBox);

  return {
    el,
    // Polling redraws the source cards; the open form and the review queue with its ticks are left alone.
    async refresh({ poll } = {}) {
      await refresh();
      if (!poll && focus?.reload) focus.reload();
    },
  };
}

function datesLine(dates) {
  return [
    dates.publishedAt ? `published ${when(dates.publishedAt)}` : null,
    `saved ${when(dates.capturedAt)}`,
    `edited ${when(dates.editedAt)}`,
    dates.checkedAt ? `checked ${when(dates.checkedAt)}` : null,
  ].filter(Boolean).join(' · ');
}

export function createReviewSection(ctx) {
  const writable = can('write');
  const staleBox = h('div', { 'aria-live': 'polite' });
  const conflictBox = h('div', { 'aria-live': 'polite' });
  const aiNote = h('p', { class: 'hint' });
  let projects = [];
  let configured = false;
  let staleBranch = null;
  let conflictBranch = null;
  let staleSeq = 0;
  let analysis = 0;

  const days = h('input', { type: 'number', min: 1, max: 36500, step: 1, value: 90, 'aria-label': 'Days without an edit or check' });
  const staleProject = h('select', { 'aria-label': 'Project' });
  const staleBranchButton = h('button', { type: 'button', class: 'btn small' }, 'Limit to a branch…');
  const staleBranchLabel = h('span', { class: 'hint' });
  const scope = h('select', { 'aria-label': 'Review scope' },
    h('option', { value: 'topic' }, 'A topic'), h('option', { value: 'project' }, 'A whole project'), h('option', { value: 'branch' }, 'A branch'));
  const topic = h('input', { type: 'search', maxlength: 500, placeholder: 'opening hours', 'aria-label': 'Topic keywords' });
  const conflictProject = h('select', { 'aria-label': 'Project' });
  const conflictBranchButton = h('button', { type: 'button', class: 'btn small' }, 'Choose a branch…');
  const conflictBranchLabel = h('span', { class: 'hint' });
  const analyze = h('button', { type: 'submit', class: 'btn primary', disabled: true }, 'Look for conflicts');

  function renderScope() {
    topic.hidden = scope.value !== 'topic';
    conflictProject.hidden = scope.value === 'branch';
    conflictBranchButton.hidden = conflictBranchLabel.hidden = scope.value !== 'branch';
    clear(conflictProject, projectOptions(projects, conflictProject.value, scope.value === 'project' ? 'Choose a project' : 'Any project'));
    conflictBranchLabel.textContent = conflictBranch ? `“${conflictBranch.title}”` : 'No branch chosen.';
    staleBranchLabel.textContent = staleBranch ? `Only “${staleBranch.title}” and what’s inside it.` : '';
    staleProject.disabled = Boolean(staleBranch);
    staleBranchButton.textContent = staleBranch ? 'Clear branch' : 'Limit to a branch…';
    analyze.disabled = !writable || !configured;
  }

  staleBranchButton.addEventListener('click', async () => {
    if (staleBranch) staleBranch = null;
    else staleBranch = await pickItem({ title: 'Check items in this branch', filter: { secret: 'false' } }) ?? null;
    renderScope();
  });
  conflictBranchButton.addEventListener('click', async () => {
    const picked = await pickItem({ title: 'Review this branch for conflicts', filter: { secret: 'false' } });
    if (picked) conflictBranch = picked;
    renderScope();
  });
  scope.addEventListener('change', renderScope);

  async function loadStale() {
    const mine = ++staleSeq;
    const olderThan = Number(days.value);
    if (!Number.isInteger(olderThan) || olderThan < 1 || olderThan > 36500) return clear(staleBox, h('p', { class: 'error' }, 'Choose a whole number of days from 1 to 36,500.'));
    clear(staleBox, loading('Finding items that haven’t been edited or checked…'));
    try {
      const params = new URLSearchParams({ days: String(olderThan) });
      if (staleBranch) params.set('rootId', staleBranch.id);
      else if (staleProject.value) params.set('project', staleProject.value);
      const result = await kget(`/freshness/stale?${params}`);
      if (mine !== staleSeq) return;
      clear(staleBox,
        h('p', { class: 'hint' }, result.total > result.items.length
          ? `The ${result.items.length} oldest of ${plural(result.total, 'item')} not edited or checked since ${when(result.cutoff)}.`
          : `${plural(result.total, 'item')} not edited or checked since ${when(result.cutoff)}.`),
        result.items.length ? h('ul', { class: 'plain freshness-list' }, result.items.map((item) => staleRow(item))) : empty('Everything in this scope was edited or checked recently.'));
    } catch (error) {
      if (mine === staleSeq) clear(staleBox, errorBox(error, loadStale));
    }
  }

  function staleRow(item) {
    const actions = h('div', { class: 'actions' });
    const row = h('li', null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(item.id) }, item.title || item.url || `Untitled ${item.type}`),
        h('span', { class: 'badge' }, `${item.ageDays.toLocaleString()} days since last ${item.basis === 'checked' ? 'check' : 'edit'}`)),
      h('p', { class: 'hint' }, `${item.type} · ${datesLine(item.dates)}`),
      item.excerpt ? h('details', null, h('summary', null, 'Text'), h('div', { class: 'pre queue-text', tabIndex: 0 }, item.excerpt), item.truncated ? h('p', { class: 'hint' }, 'Shortened.') : null) : null,
      actions);
    if (writable) actions.append(h('button', { type: 'button', class: 'btn small', onClick: async (event) => {
      event.target.disabled = true;
      try {
        await kpost('/freshness/check', { id: item.id, stateHash: item.stateHash });
        clear(actions, h('span', { class: 'ok', role: 'status' }, 'Marked checked. The text is unchanged.'));
        ctx.changed({ detail: false });
      } catch (error) {
        event.target.disabled = false;
        actions.append(errorBox(error));
      }
    } }, 'Mark checked'));
    return row;
  }

  async function runAnalysis() {
    const body = scope.value === 'branch' ? (conflictBranch ? { rootId: conflictBranch.id } : null)
      : scope.value === 'project' ? (conflictProject.value ? { project: conflictProject.value } : null)
        : (topic.value.trim() ? { query: topic.value.trim(), ...(conflictProject.value ? { project: conflictProject.value } : {}) } : null);
    if (!body) return clear(conflictBox, h('p', { class: 'error' }, scope.value === 'branch' ? 'Choose a branch first.' : scope.value === 'project' ? 'Choose a project first.' : 'Name the topic first.'));
    const mine = ++analysis;
    analyze.disabled = true;
    clear(conflictBox, loading('Comparing up to 100 items with the AI provider…'));
    try {
      const proposal = await kpost('/freshness/analyze', body);
      if (mine !== analysis) return;
      clear(conflictBox,
        h('p', { class: 'hint' }, `${plural(proposal.scanned, 'item')} compared. ${proposal.message}`),
        proposal.rejected ? h('p', { class: 'hint' }, `${plural(proposal.rejected, 'suggestion')} left out because the quotes or items couldn’t be verified.`) : null,
        proposal.dismissed ? h('p', { class: 'hint' }, `${plural(proposal.dismissed, 'suggestion')} hidden because you dismissed those pairs before.`) : null,
        proposal.suggestions.length ? h('ol', { class: 'plain freshness-list' }, proposal.suggestions.map(suggestionRow)) : null);
    } catch (error) {
      if (mine === analysis) clear(conflictBox, errorBox(error, runAnalysis));
    } finally {
      if (mine === analysis) analyze.disabled = !writable || !configured;
    }
  }

  /** Model output is a lead to check: quotes are verified text, the reason is not, and both notes always keep their text. */
  function suggestionRow(suggestion) {
    const [a, b] = suggestion.items;
    const outcome = h('div', { 'aria-live': 'polite' });
    const buttons = [];
    const done = (text) => {
      buttons.forEach((button) => { button.disabled = true; });
      clear(outcome, h('p', { class: 'ok', role: 'status' }, text));
      ctx.changed({ detail: false });
    };
    const act = async (button, request, message) => {
      buttons.forEach((entry) => { entry.disabled = true; });
      try {
        await request();
        done(message);
      } catch (error) {
        buttons.forEach((entry) => { entry.disabled = false; });
        clear(outcome, errorBox(error));
      }
    };
    const ref = (evidence) => ({ id: evidence.id, stateHash: evidence.stateHash });
    const name = (evidence) => `“${evidence.title || 'Untitled'}”`;
    const evidence = (item) => h('div', { class: 'evidence' },
      h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(item.id) }, item.title || 'Untitled'),
      h('blockquote', null, item.quote),
      h('p', { class: 'hint' }, datesLine(item.dates)),
      suggestion.newer?.id === item.id ? h('span', { class: 'badge' }, `Newer by ${suggestion.newer.basis === 'published' ? 'publication' : 'last edit'} date`) : null);
    const supersede = (newer, older) => {
      const button = h('button', { type: 'button', class: 'btn small', onClick: async () => {
        const ok = await confirmDialog({
          title: 'Mark the older note as superseded?',
          body: `${name(older)} will be marked superseded by ${name(newer)} with a permanent connection, and leaves freshness review. Both notes keep their text, and nothing is decided about which statement is true. Decisions are never changed this way.`,
          confirmLabel: 'Mark superseded',
        });
        if (ok) act(button, () => kpost('/freshness/supersede', { newer: ref(newer), older: ref(older) }), `${name(older)} is marked superseded by ${name(newer)}. Both texts are kept.`);
      } }, `${name(newer)} replaces ${name(older)}`);
      buttons.push(button);
      return button;
    };
    if (writable) {
      const dismiss = h('button', { type: 'button', class: 'btn small', onClick: () => act(dismiss, () => kpost('/freshness/dismiss', { refs: [ref(a), ref(b)] }), 'Dismissed. This pair won’t be suggested again; both items are unchanged.') }, 'Dismiss');
      const checked = h('button', { type: 'button', class: 'btn small', onClick: () => act(checked, async () => {
        await kpost('/freshness/check', ref(a));
        await kpost('/freshness/check', ref(b));
      }, 'Both marked checked. Their text is unchanged.') }, 'Both are still correct');
      buttons.push(dismiss, checked);
    }
    const ordered = suggestion.newer?.id === b.id ? [b, a] : [a, b];
    return h('li', { class: 'suggestion' },
      h('div', { class: 'actions' },
        h('span', { class: 'badge' }, suggestion.kind === 'conflict' ? 'Possible conflict' : 'Possibly outdated'),
        h('span', { class: 'hint' }, 'AI’s reason (not verified): ', suggestion.reason)),
      h('div', { class: 'evidence-pair' }, evidence(a), evidence(b)),
      suggestion.newer ? null : h('p', { class: 'hint' }, 'The dates don’t show which is newer.'),
      writable ? h('div', { class: 'actions' }, buttons.slice(0, 2), supersede(ordered[0], ordered[1]), supersede(ordered[1], ordered[0])) : null,
      writable ? h('p', { class: 'hint' }, 'Superseding works on ordinary notes only; for links and files, mark them checked instead.') : null,
      outcome);
  }

  const el = h('section', { class: 'knowledge-section', 'aria-labelledby': 'review-heading' },
    h('div', { class: 'view-head' }, h('h2', { id: 'review-heading' }, 'Information review')),
    h('p', { class: 'hint' }, 'Find notes, links and files that may be outdated or that disagree. Nothing is rewritten: you mark items checked, dismiss a suggestion, or say which note supersedes another, and both texts stay. Decisions are never changed here.'),
    h('section', { class: 'panel stack' },
      h('h3', null, 'Not edited or checked recently'),
      h('p', { class: 'hint' }, 'Found from dates alone; no AI is involved.'),
      h('form', { class: 'filters', onSubmit: (event) => { event.preventDefault(); loadStale(); } },
        h('label', { class: 'check' }, 'Older than', days, 'days'), staleProject, staleBranchButton, staleBranchLabel,
        h('button', { type: 'submit', class: 'btn small primary' }, 'Show items')),
      staleBox),
    h('section', { class: 'panel stack' },
      h('h3', null, 'Possible conflicts'),
      aiNote,
      h('form', { class: 'filters', onSubmit: (event) => { event.preventDefault(); runAnalysis(); } },
        scope, topic, conflictProject, conflictBranchButton, conflictBranchLabel, analyze),
      conflictBox));

  return {
    el,
    // Results and their review buttons stay as they are; only the project lists and provider status refresh.
    async refresh() {
      try {
        const [nextProjects, status] = await Promise.all([get('/projects'), get('/ai/status').catch(() => ({ configured: false }))]);
        projects = nextProjects;
        configured = Boolean(status.configured);
      } catch (error) {
        aiNote.textContent = `Couldn’t refresh projects and AI status: ${error.message}`;
        return;
      }
      const chosen = staleProject.value;
      clear(staleProject, projectOptions(projects, chosen, 'Any project'));
      aiNote.textContent = !writable ? 'Reviewing suggestions needs a read,write token.'
        : configured ? 'The AI compares up to 100 items in the scope and must copy exact quotes from two of them; anything it can’t back with quotes is left out. Its reason is a suggestion, never a fact.'
          : 'Looking for conflicts needs an AI provider on the library host. Choose one in the desktop app’s Settings → AI, or run petty-memory ai use.';
      renderScope();
    },
  };
}
