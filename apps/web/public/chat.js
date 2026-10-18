import { can, del, enc, get, post, query } from './api.js';
import { answerNote, chatMessages, chatTitle, draftProblem, savedMessages, savedTurns } from './conversation.js';
import { referenceLink, showProposal } from './detail.js';
import { clear, confirmDialog, empty, errorBox, h, loading, promptDialog, when } from './dom.js';
import { createPreferenceChooser } from './knowledge-preferences.js';
import { formatTime } from './knowledge-research.js';
import { displayTitle } from './text.js';
import { pickItem } from './picker.js';
import { DICTATION_NOTE, appendDictation, createDictation, platformOf, speechRecognizer, systemDictationHelp } from './voice.js';

const ORGANIZE_EXAMPLE = 'Organize all notes about gardening into a PARA system';
const MODE_LABELS = { ask: 'Ask', edit: 'Change notes', organize: 'Organize library', actions: 'Suggest actions' };
const STARTERS = [
  ['edit', 'Organize notes', 'Organize these notes: group related ones under clear headings and order them sensibly. Keep every note.'],
  ['edit', 'Correct wording', 'Correct spelling, grammar and wording without changing the meaning.'],
  ['edit', 'Turn into checklist', 'Turn this into a checklist with one clear step per note.'],
  ['ask', 'What have I decided?', 'What have I decided, and why?'],
  ['ask', 'What’s still open?', 'What’s still open or unresolved?'],
  ['ask', 'Summarize a topic', 'Summarize what I’ve saved about '],
  ['organize', 'Organize a topic', ORGANIZE_EXAMPLE],
  ['actions', 'Plan next steps', 'Suggest tasks with due dates for what still needs doing, tag what belongs together, and write a short brief.'],
];
const REPLY_KINDS = ['answer', 'proposal', 'organization', 'actions'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const NEW_CHAT = 'Started a new chat. Changes you already applied stay in your notes.';
/** The server lists at most this many saved chats, newest first. */
const MAX_SAVED = 100;

/** Model text only ever becomes text nodes. */
function cited(text, sources, open) {
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  return h('div', { class: 'answer-text' }, text.split(/\n{2,}/).map((paragraph) => h('p', null, paragraph.split(/(\[\d+\])/).map((part) => {
    const n = /^\[(\d+)\]$/.exec(part)?.[1];
    const source = n ? byNumber.get(Number(n)) : undefined;
    return source
      ? h('button', { type: 'button', class: 'ref cite', title: source.title || source.url || '', onClick: () => open(source) }, n)
      : part;
  }))));
}

/** A cited PDF page or recording time, when the source carries a usable locator. */
function researchLocator(source) {
  const { locator } = source;
  if (!locator || typeof locator.sourceId !== 'string') return null;
  if (locator.kind === 'pdf' && Number.isInteger(locator.page)) return locator;
  if (locator.kind === 'audio' && Number.isFinite(locator.start)) return locator;
  return null;
}

/** The proposed hierarchy with a checkbox per moved branch; only Apply changes anything. */
function showOrganization(out, proposal, { changed, open, onDiscard }) {
  const { destination } = proposal;
  const items = new Map(proposal.items.map((item) => [item.id, item]));
  const selected = new Set(items.keys());
  const suggested = proposal.items.filter((item) => item.match === 'semantic').length;
  let working = false;
  const choices = [];
  const status = h('div', { 'aria-live': 'polite' });
  const apply = h('button', { type: 'button', class: 'btn primary' });
  const discard = h('button', { type: 'button', class: 'btn', onClick: onDiscard }, 'Discard');
  const label = () => {
    apply.textContent = working ? 'Moving…' : `Move ${plural(selected.size, 'note')}`;
    apply.disabled = working || selected.size === 0;
    discard.disabled = working;
    choices.forEach((choice) => { choice.disabled = working; });
  };
  const branch = (parentId) => h('ul', { class: 'organize-tree' },
    proposal.groups.filter((group) => group.parentId === parentId).map((group) => h('li', null,
      h('strong', null, group.title), ' ', h('span', { class: 'badge' }, 'New heading'),
      branch(group.id))),
    proposal.assignments.filter((assignment) => assignment.parentId === parentId).map(({ itemId }) => {
      const item = items.get(itemId);
      const title = displayTitle({ title: item.title, body: item.body });
      const choice = h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${title}`, onChange: (event) => {
          if (event.target.checked) selected.add(itemId); else selected.delete(itemId);
          label();
        } });
      choices.push(choice);
      return h('li', null, h('label', { class: 'check' }, choice,
        h('span', null, title,
          item.match === 'semantic' ? [' ', h('span', { class: 'badge suggested', title: 'Found by meaning rather than by your words' }, 'Suggested')] : null,
          item.descendantCount ? h('span', { class: 'hint' }, ` · brings ${item.descendantCount} inside it`) : null,
          h('span', { class: 'hint' }, ' · from '),
          item.parentId ? referenceLink(item.parentId, 'another note', open) : h('span', { class: 'hint' }, 'the top level'))));
    }));
  apply.addEventListener('click', async () => {
    if (working) return;
    working = true;
    label();
    try {
      const result = await post('/ai/organize/apply', { proposal, includeIds: [...selected] });
      changed();
      const undo = h('button', { type: 'button', class: 'btn', onClick: async () => {
        undo.disabled = true;
        try {
          await post('/ai/organize/undo', { receipt: result.undo });
          clear(out, h('p', { class: 'ok' }, 'Organization undone. Nothing from this plan is applied.'));
          changed();
        } catch (error) {
          undo.disabled = false;
          out.append(errorBox(error));
        }
      } }, 'Undo this organization');
      clear(out,
        h('p', { class: 'ok' }, `Moved ${plural(result.moved, 'note')} into “${destination.title}”.`),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => open(result.rootId) }, `Open “${destination.title}”`), undo));
    } catch (error) {
      working = false;
      clear(status, errorBox(error));
      label();
    }
  });
  label();
  clear(out,
    h('h3', null, `Organize into “${destination.title}”`),
    h('p', { class: 'hint' }, `${plural(proposal.matchedCount, 'note')} match “${proposal.query}”; ${plural(proposal.affectedCount, 'item')} in all, counting what’s inside them. Moving a note brings everything inside it. Text, tags, projects and attachments stay as they are. Untick anything that doesn’t belong.`),
    suggested ? h('p', { class: 'hint' }, `${suggested} marked Suggested ${suggested === 1 ? 'was' : 'were'} found by meaning rather than by your words. Only the closest few are offered this way, so check them before moving.`) : null,
    h('div', { class: 'organize-root', role: 'group', 'aria-label': 'Proposed structure' },
      h('strong', null, destination.title), ' ', h('span', { class: 'badge' }, destination.create ? 'New top-level note' : 'Existing note'),
      branch(destination.id)),
    status,
    h('div', { class: 'actions' }, apply, discard));
}

function actionView(operation, open) {
  const item = (id) => referenceLink(id, 'an item', open);
  switch (operation.kind) {
    case 'task':
      return h('div', { class: 'op' }, h('strong', null, `Add task “${operation.title}”${operation.dueAt ? `, due ${when(operation.dueAt)}` : ''}`),
        operation.body ? h('p', { class: 'pre' }, operation.body) : null,
        operation.sourceId ? h('p', { class: 'hint' }, 'From ', item(operation.sourceId)) : null);
    case 'tag':
      return h('div', { class: 'op' }, h('strong', null, 'Tag '), item(operation.itemId), ' ', operation.tags.map((tag) => h('span', { class: 'tag' }, `#${tag} `)));
    case 'reminder':
      return h('div', { class: 'op' }, operation.remindAt
        ? [h('strong', null, 'Remind me about '), item(operation.itemId), ` on ${when(operation.remindAt)}`]
        : [h('strong', null, 'Clear the reminder on '), item(operation.itemId)]);
    case 'note':
      return h('div', { class: 'op' }, h('strong', null, `Add note “${operation.title}”`),
        operation.body ? h('p', { class: 'pre' }, operation.body) : null,
        operation.sourceIds.length ? h('p', { class: 'hint' }, 'From ', operation.sourceIds.flatMap((id, i) => (i ? [', ', item(id)] : [item(id)]))) : null);
    default:
      return h('div', { class: 'op' }, h('strong', null, 'Unrecognised action'));
  }
}

/** Proposed tasks, tags, reminders and notes with a checkbox each; the ticked ones apply together, then a guarded undo is offered. */
export function showActions(out, proposal, { changed, open, onDiscard }) {
  const selected = new Set(proposal.operations.map((operation) => operation.id));
  let working = false;
  const choices = [];
  const status = h('div', { 'aria-live': 'polite' });
  const apply = h('button', { type: 'button', class: 'btn primary' });
  const discard = h('button', { type: 'button', class: 'btn', onClick: onDiscard }, 'Discard');
  const label = () => {
    apply.textContent = working ? 'Applying…' : `Apply ${plural(selected.size, 'action')}`;
    apply.disabled = working || selected.size === 0;
    discard.disabled = working;
    choices.forEach((choice) => { choice.disabled = working; });
  };
  apply.addEventListener('click', async () => {
    if (working) return;
    working = true;
    label();
    try {
      const result = await post('/ai/actions/apply', { proposal, includeIds: [...selected] });
      changed();
      const undo = h('button', { type: 'button', class: 'btn', onClick: async () => {
        undo.disabled = true;
        try {
          const { restored } = await post('/ai/actions/undo', { receipt: result.undo });
          clear(out, h('p', { class: 'ok' }, `Undid ${plural(restored, 'change')}. Nothing from these actions is applied.`));
          changed();
        } catch (error) {
          undo.disabled = false;
          out.append(errorBox(error));
        }
      } }, 'Undo these actions');
      clear(out,
        h('p', { class: 'ok' }, `Added ${plural(result.createdIds.length, 'item')} and updated ${plural(result.updatedIds.length, 'item')}.`),
        result.createdIds.length ? h('ul', { class: 'plain' }, result.createdIds.map((id) => h('li', null, referenceLink(id, 'New item', open)))) : null,
        h('div', { class: 'actions' }, undo));
    } catch (error) {
      working = false;
      clear(status, errorBox(error));
      label();
    }
  });
  label();
  clear(out,
    h('h3', null, 'Suggested actions'),
    h('p', { class: 'hint' }, proposal.rootId ? ['From ', referenceLink(proposal.rootId, 'the chosen note', open), ' and what’s inside it.'] : `About “${proposal.query}”.`),
    h('ol', { class: 'ops' }, proposal.operations.map((operation) => {
      const choice = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Include this action', onChange: (event) => {
        if (event.target.checked) selected.add(operation.id); else selected.delete(operation.id);
        label();
      } });
      choices.push(choice);
      return h('li', null, h('label', { class: 'check' }, choice, actionView(operation, open)));
    })),
    status,
    h('div', { class: 'actions' }, apply, discard));
}

/** A conversation kept in this tab's memory unless saved; leaving the section keeps it, disconnecting forgets it. */
export function createChatView(ctx) {
  let mode = 'ask';
  let target = null;
  let turns = [];
  let generation = 0;
  let sending = false;
  let resuming = false;
  let saving = false;
  let configured = false;
  let saved = null;
  let voice = { status: 'idle' };
  let dictation = null;
  let savedRequest = 0;
  let savedTimer = null;
  const Recognition = speechRecognizer(window);
  const writable = can('write');
  const preferences = writable ? createPreferenceChooser({
    legend: 'Organization preferences for this request',
    hint: 'Only the saved preferences you tick are sent, and only with Organize. Project preferences are offered for workflows in that project.',
  }) : null;

  const disclosure = h('p', { class: 'hint' });
  const unavailable = h('div');
  const radios = Object.keys(MODE_LABELS).map((value) => h('input', { type: 'radio', name: 'chat-mode', value, checked: value === mode }));
  const project = h('select', { 'aria-label': 'Limit to project' }, h('option', { value: '' }, 'Whole library'));
  const actionScope = h('select', { 'aria-label': 'Work from' }, h('option', { value: 'notes' }, 'From chosen notes'), h('option', { value: 'topic' }, 'From a topic'));
  const topic = h('input', { type: 'search', 'aria-label': 'Topic keywords', placeholder: 'Topic, e.g. garage door' });
  const targetButton = h('button', { type: 'button', class: 'btn small' });
  const newChat = h('button', { type: 'button', class: 'btn small', onClick: () => restart() }, 'New chat');
  const savedButton = h('button', { type: 'button', class: 'btn small', 'aria-expanded': 'false', onClick: () => {
    if (!savedPanel.hidden) return hideSaved();
    showSaved();
    savedSearch.focus();
  } }, 'Saved chats');
  const saveButton = h('button', { type: 'button', class: 'btn small', onClick: () => saveChat() });
  const savedLabel = h('span', { class: 'hint', role: 'status' }, 'Saved');
  const savedSearch = h('input', { type: 'search', 'aria-label': 'Search saved chats', placeholder: 'Search all saved chats', maxlength: 500 });
  const savedStatus = h('p', { class: 'hint', role: 'status', hidden: true });
  const savedResults = h('div');
  const savedPanel = h('section', { class: 'panel saved-chats', 'aria-label': 'Saved chats', hidden: true },
    h('div', { class: 'view-head' }, h('h2', null, 'Saved chats'), h('button', { type: 'button', class: 'btn small', onClick: () => hideSaved() }, 'Close')),
    savedSearch, savedStatus, savedResults);
  const editHint = h('p', { class: 'hint' }, 'The AI suggests changes to the chosen note and everything inside it, never secret notes or decisions. You review each change before it’s applied, and can undo it afterwards.');
  const organizeHint = h('p', { class: 'hint' }, `Say what to gather and how, for example “${ORGANIZE_EXAMPLE}”. The AI finds every matching note and proposes headings under one top-level note. Moving a note brings everything inside it, and project filing stays as it is. Nothing moves until you review and apply.`);
  const actionsHint = h('p', { class: 'hint' });
  const restartHint = h('p', { class: 'hint' });
  const notice = h('p', { class: 'chat-notice', role: 'status', hidden: true });
  const trimmed = h('p', { class: 'chat-notice', hidden: true }, 'Earlier messages are still shown, but only the most recent ones are sent to the AI.');
  const starters = h('ul', { class: 'chips', 'aria-label': 'Suggestions' }, STARTERS.filter(([starter]) => writable || starter === 'ask').map(([starter, label, text]) => h('li', null,
    h('button', { type: 'button', class: 'chip', onClick: () => {
      chooseMode(starter);
      message.value = text;
      message.focus();
      render();
    } }, label))));
  const log = h('ol', { class: 'chat-log', role: 'log', 'aria-label': 'Conversation' });
  const message = h('textarea', { rows: 3, 'aria-label': 'Message' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const dictate = h('button', { type: 'button', class: 'btn', onClick: () => startDictation() }, 'Dictate');
  const stop = h('button', { type: 'button', class: 'btn recording', onClick: () => dictation?.stop() }, 'Stop');
  const recording = h('span', { class: 'recording-status', role: 'status', hidden: true });
  const sendButton = h('button', { type: 'submit', class: 'btn primary' }, 'Send');
  const interim = h('p', { class: 'hint chat-interim', 'aria-live': 'polite', hidden: true });
  const voiceError = h('p', { class: 'error', role: 'alert', hidden: true });
  const systemHelp = h('p', { class: 'hint', hidden: true });

  const show = (node, text) => {
    node.textContent = text ?? '';
    node.hidden = !text;
  };
  const fromTopic = () => mode === 'actions' && actionScope.value === 'topic';
  const needsTarget = () => mode === 'edit' || (mode === 'actions' && actionScope.value === 'notes');
  const dirty = () => turns.length > 0 && saved?.count !== turns.length;

  function render() {
    const listening = voice.status === 'starting' || voice.status === 'listening';
    const busy = sending || resuming;
    for (const radio of radios) radio.disabled = busy || (radio.value !== 'ask' && !writable);
    project.hidden = !(mode === 'ask' || fromTopic());
    project.disabled = busy;
    actionScope.hidden = mode !== 'actions';
    actionScope.disabled = busy;
    topic.hidden = !fromTopic();
    topic.disabled = busy || turns.length > 0;
    topic.title = turns.length > 0 ? 'Start a new chat to change the topic' : '';
    targetButton.hidden = !needsTarget();
    targetButton.disabled = busy;
    targetButton.textContent = target ? `Notes: ${target.title}` : mode === 'edit' ? 'Choose notes to change…' : 'Choose notes to work from…';
    editHint.hidden = mode !== 'edit';
    organizeHint.hidden = mode !== 'organize';
    if (preferences) {
      preferences.el.hidden = mode !== 'organize';
      preferences.setDisabled(busy);
    }
    show(actionsHint, mode === 'actions'
      ? `The AI suggests tasks, tags, reminders and a brief from ${fromTopic() ? 'notes about the topic' : 'the chosen note and everything inside it'}. You choose which to apply, and can undo them afterwards. It never deletes or moves anything.`
      : '');
    show(restartHint, turns.length
      ? `Changing the mode, project or notes starts a new chat.${!saved ? ' This chat isn’t saved.' : dirty() ? ` New messages aren’t in “${saved.title}” until you save changes.` : ''}`
      : '');
    newChat.hidden = turns.length === 0;
    newChat.disabled = savedButton.disabled = busy;
    saveButton.hidden = !writable || !dirty();
    saveButton.disabled = busy || saving;
    saveButton.textContent = saving ? 'Saving…' : saved ? 'Save changes' : 'Save chat';
    savedLabel.hidden = turns.length === 0 || dirty();
    starters.hidden = turns.length > 0 || sending;
    log.hidden = turns.length === 0 && !sending;
    message.placeholder = mode === 'ask' ? 'What do we know about the garage door protocol?'
      : mode === 'organize' ? ORGANIZE_EXAMPLE
        : mode === 'actions' ? 'What should come out of this? For example, “tasks for next week and a short brief”'
          : 'What should change? For example, “group these by room”';
    dictate.hidden = listening;
    stop.hidden = !listening;
    show(recording, voice.status === 'starting' ? 'Starting dictation…' : voice.status === 'listening' ? 'Listening. Press Stop when you’re done.' : '');
    show(interim, voice.status === 'listening' && voice.interim ? `${voice.interim}…` : '');
    sendButton.disabled = !configured || busy || listening || !message.value.trim() || (needsTarget() && !target) || (fromTopic() && !topic.value.trim());
    sendButton.textContent = sending ? 'Thinking…' : 'Send';
  }

  function clearConversation() {
    stopDictation();
    generation++;
    sending = false;
    turns = [];
    saved = null;
    log.replaceChildren();
    trimmed.hidden = true;
    show(error, '');
  }

  // A new scope starts over, so earlier context or audio can't steer a request it wasn't meant for, and a saved chat is never overwritten by it.
  function restart() {
    if (turns.length) show(notice, NEW_CHAT);
    clearConversation();
    render();
  }

  function setMode(next) {
    mode = next;
    for (const radio of radios) radio.checked = radio.value === mode;
  }

  function chooseMode(next) {
    if (next === mode) return;
    setMode(next);
    restart();
  }

  function scopeFields() {
    if (needsTarget()) return target ? { rootId: target.id } : {};
    if (mode === 'actions') return { query: topic.value.trim(), ...(project.value ? { project: project.value } : {}) };
    return mode === 'ask' && project.value ? { project: project.value } : {};
  }

  const userTurn = (text) => h('li', { class: 'chat-turn user' }, h('p', { class: 'chat-text' }, text));

  function answerTurn(reply, question) {
    const { answer, sources } = reply.answer;
    const openSource = (source) => {
      const locator = researchLocator(source);
      if (locator) ctx.openResearch(locator);
      else ctx.select(source.id);
    };
    const save = writable ? h('button', { type: 'button', class: 'btn small', onClick: async () => {
      save.disabled = true;
      try {
        const note = await post('/items', {
          type: 'note', title: chatTitle([{ role: 'user', content: question }]), body: answerNote(reply.answer),
          project: mode === 'ask' && project.value ? project.value : undefined,
        });
        save.replaceWith(h('p', { class: 'ok', role: 'status' }, 'Saved as a note. ', h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(note.id) }, 'Open it')));
        ctx.changed({ detail: false });
      } catch (failure) {
        save.disabled = false;
        ctx.notify(failure.message, 'error');
      }
    } }, 'Save as note') : null;
    return h('li', { class: 'chat-turn assistant' }, h('div', { class: 'answer' },
      cited(answer, sources, openSource),
      sources.length ? h('ol', { class: 'sources', 'aria-label': 'Sources' }, sources.map((source) => {
        const locator = researchLocator(source);
        return h('li', null,
          h('button', { type: 'button', class: 'link-btn', onClick: () => openSource(source) },
            h('span', { class: 'ref' }, String(source.n)), ' ', source.title || source.url || `Untitled ${source.type}`,
            locator ? h('span', { class: 'hint' }, locator.kind === 'pdf' ? ` · page ${locator.page}` : ` · at ${formatTime(locator.start)}`) : null),
          locator ? h('button', { type: 'button', class: 'btn small', 'aria-label': `Open the note for source ${source.n}`, onClick: () => ctx.select(source.id) }, 'Note') : null);
      })) : null,
      save ? h('div', { class: 'actions' }, save) : null));
  }

  /** A proposal turn: `hint` stays, `pending` hides while the review is open, and only the review can change anything. */
  function reviewableTurn(summary, { hint, pending, button, present }) {
    const state = pending ? h('p', { class: 'hint' }, pending) : null;
    const out = h('div', { class: 'proposal', 'aria-live': 'polite' });
    const review = h('button', { type: 'button', class: 'btn small', onClick: () => {
      review.hidden = true;
      if (state) state.hidden = true;
      present(out, {
        changed: () => ctx.changed(),
        open: (id) => ctx.select(id),
        onDiscard: () => {
          clear(out);
          review.hidden = false;
          if (state) state.hidden = false;
        },
      });
    } }, button);
    return h('li', { class: 'chat-turn assistant' },
      summary ? h('p', { class: 'chat-text' }, summary) : null,
      h('p', { class: 'hint' }, hint), state, writable && button ? review : null, out);
  }

  function assistantTurn(reply, question) {
    if (reply.kind === 'answer') return answerTurn(reply, question);
    const { proposal } = reply;
    if (reply.kind === 'organization') {
      const { matchedCount, affectedCount, destination } = proposal;
      return reviewableTurn(proposal.summary, {
        hint: `${plural(matchedCount, 'matching note')}, ${plural(affectedCount, 'item')} counting what’s inside them, into ${destination.create ? 'a new' : 'the existing'} top-level note “${destination.title}”.`,
        pending: 'Nothing has moved yet.',
        button: 'Review organization',
        present: (out, handlers) => showOrganization(out, proposal, handlers),
      });
    }
    const count = proposal.operations.length;
    if (reply.kind === 'actions') {
      return reviewableTurn(proposal.summary, {
        hint: count ? `${plural(count, 'suggested action')}. Nothing has changed yet.` : 'The AI didn’t suggest any actions.',
        button: count ? 'Review actions' : null,
        present: (out, handlers) => showActions(out, proposal, handlers),
      });
    }
    return reviewableTurn(proposal.summary, {
      hint: count ? `${plural(count, 'suggested change')}. Nothing has changed yet.` : 'The AI didn’t suggest any changes.',
      button: count ? 'Review changes' : null,
      present: (out, { changed, onDiscard }) => showProposal(out, proposal, { changed, onDiscard }),
    });
  }

  function turnNode(turn, index) {
    if (turn.role === 'user') return userTurn(turn.content);
    if ('saved' in turn) return h('li', { class: 'chat-turn assistant saved' }, h('p', { class: 'chat-text' }, turn.saved), h('p', { class: 'hint' }, 'From the saved chat'));
    return assistantTurn(turn.reply, turns[index - 1]?.content ?? '');
  }

  async function send() {
    if (!configured) return;
    const text = message.value.trim();
    if (!text || sending || resuming || voice.status === 'starting' || voice.status === 'listening') return;
    const problem = draftProblem(text)
      ?? (needsTarget() && !target ? (mode === 'edit' ? 'Choose the notes to change first.' : 'Choose the notes to work from first.') : null)
      ?? (fromTopic() && !topic.value.trim() ? 'Say which topic to work from first.' : null);
    if (problem) return show(error, problem);
    const run = generation;
    const { messages, dropped } = chatMessages(turns, text);
    const chosen = mode === 'organize' ? preferences?.selected() ?? [] : [];
    const request = { mode, messages, ...scopeFields(), ...(chosen.length ? { preferences: chosen } : {}) };
    const pending = [userTurn(text), h('li', { class: 'chat-turn assistant hint', role: 'status' }, 'Thinking…')];
    sending = true;
    message.value = '';
    show(error, '');
    show(notice, '');
    log.append(...pending);
    render();
    try {
      const reply = await post('/ai/chat', request);
      if (run !== generation) return;
      if (!REPLY_KINDS.includes(reply?.kind)) throw new Error('The server sent an unexpected chat reply.');
      turns.push({ role: 'user', content: text }, { role: 'assistant', reply });
      pending[1].replaceWith(assistantTurn(reply, text));
      trimmed.hidden = dropped === 0;
    } catch (failure) {
      if (run !== generation) return;
      pending.forEach((node) => node.remove());
      show(error, failure.message);
      message.value = message.value.trim() ? `${text}\n\n${message.value}` : text;
    } finally {
      if (run === generation) {
        sending = false;
        render();
      }
    }
  }

  async function saveChat() {
    if (saving || sending || !turns.length) return;
    const { messages, dropped } = savedMessages(turns);
    if (!messages.length) return show(error, 'This chat is too long to save. Start a new chat and save it sooner.');
    const title = saved?.title ?? await promptDialog({
      title: 'Save this chat', label: 'Title', value: chatTitle(turns), confirmLabel: 'Save chat',
      validate: (text) => text.trim().slice(0, 200) || null,
    });
    if (title === null) return;
    const run = generation;
    saving = true;
    render();
    try {
      const result = await post('/conversations', { ...(saved ? { id: saved.id } : {}), title, mode, messages, ...scopeFields() });
      if (run !== generation) return;
      saved = { id: result.id, title: result.title, count: turns.length };
      ctx.notify(dropped ? `Saved the latest ${messages.length} messages as “${result.title}”` : `Saved “${result.title}”`, 'ok');
      if (!savedPanel.hidden) showSaved();
    } catch (failure) {
      ctx.notify(`Not saved: ${failure.message}`, 'error');
    } finally {
      saving = false;
      render();
    }
  }

  function hideSaved() {
    clearTimeout(savedTimer);
    savedPanel.hidden = true;
    savedButton.setAttribute('aria-expanded', 'false');
  }

  // The server searches every saved chat; a reply to an older search is dropped once a newer one is under way.
  async function showSaved() {
    clearTimeout(savedTimer);
    savedPanel.hidden = false;
    savedButton.setAttribute('aria-expanded', 'true');
    const search = savedSearch.value.trim();
    const mine = ++savedRequest;
    if (savedResults.childElementCount) show(savedStatus, search ? 'Searching…' : 'Loading…');
    else savedResults.append(loading());
    try {
      const list = await get(`/conversations${query({ query: search })}`);
      if (mine !== savedRequest) return;
      clear(savedResults,
        list.length === MAX_SAVED ? h('p', { class: 'hint' }, search
          ? `Showing the ${MAX_SAVED} most recently updated matches. Add words to narrow the search.`
          : `Showing the ${MAX_SAVED} most recent. Search to find older chats.`) : null,
        list.length
          ? h('ul', { class: 'plain saved-list', 'aria-label': search ? 'Matching saved chats' : 'Saved chats' }, list.map((conversation) => h('li', { class: 'saved-chat' },
            h('button', { type: 'button', class: 'link-btn', 'aria-current': conversation.id === saved?.id ? 'true' : undefined, onClick: () => resume(conversation.id) }, conversation.title),
            h('span', { class: 'hint' }, `${MODE_LABELS[conversation.mode] ?? conversation.mode} · ${plural(conversation.messages.length, 'message')} · ${when(conversation.updatedAt)}`),
            writable ? h('button', { type: 'button', class: 'btn small', 'aria-label': `Archive ${conversation.title}`, onClick: () => archive(conversation) }, 'Archive') : null)))
          : empty(search ? `No saved chat mentions “${search}”. Try other words.`
            : writable ? 'No saved chats yet. Use Save chat in a conversation to keep it.' : 'No saved chats yet.'));
    } catch (failure) {
      if (mine !== savedRequest) return;
      clear(savedResults, errorBox(failure, showSaved));
    } finally {
      if (mine === savedRequest) show(savedStatus, '');
    }
  }

  async function archive(conversation) {
    try {
      await del(`/conversations/${enc(conversation.id)}`);
      if (saved?.id === conversation.id) saved = null;
      ctx.notify(`Archived “${conversation.title}”`, 'ok');
      render();
      showSaved();
    } catch (failure) {
      ctx.notify(failure.message, 'error');
    }
  }

  // Only the text of a saved chat comes back; the draft in the message box is left alone.
  async function resume(id) {
    if (resuming) return;
    if (dirty() && !(await confirmDialog({
      title: 'Open a saved chat?', body: 'This chat has messages you haven’t saved. Opening another one replaces them. Your unsent message stays in the box.', confirmLabel: 'Open saved chat',
    }))) return;
    const run = generation;
    resuming = true;
    render();
    try {
      const conversation = await get(`/conversations/${enc(id)}`);
      const root = conversation.rootId ? await get(`/items/${enc(conversation.rootId)}`).catch(() => null) : null;
      if (run !== generation) return;
      clearConversation();
      setMode(conversation.mode);
      project.value = conversation.project ?? '';
      actionScope.value = conversation.query ? 'topic' : 'notes';
      topic.value = conversation.query ?? '';
      target = root ? { id: root.id, title: displayTitle(root), type: root.type } : null;
      turns = savedTurns(conversation.messages);
      log.replaceChildren(...turns.map(turnNode));
      saved = { id: conversation.id, title: conversation.title, count: conversation.messages.length };
      hideSaved();
      show(notice, `Opened “${conversation.title}”. Earlier proposals show as text; ask again for changes you can apply.`);
      if (conversation.rootId && !root) show(error, 'The notes this chat was about aren’t available any more. Choose notes to continue in a new chat.');
      render();
    } catch (failure) {
      if (run === generation) show(error, failure.message);
    } finally {
      resuming = false;
      render();
    }
  }

  function setVoice(state) {
    voice = state;
    show(voiceError, state.status === 'failed' ? state.message : '');
    if (state.status === 'failed' && state.useSystem) show(systemHelp, systemDictationHelp(platformOf(navigator)));
    render();
  }

  function startDictation() {
    show(voiceError, '');
    show(systemHelp, '');
    message.focus();
    if (!Recognition) return show(systemHelp, systemDictationHelp(platformOf(navigator)));
    dictation ??= createDictation(Recognition, {
      lang: navigator.language,
      onText: (text) => {
        message.value = appendDictation(message.value, text);
        render();
      },
      onState: setVoice,
    });
    dictation.start();
  }

  // Aborting releases the microphone at once; the controls stay usable for whenever the person returns.
  function stopDictation() {
    dictation?.cancel();
    if (voice.status !== 'failed') setVoice({ status: 'idle' });
  }

  const onHidden = () => {
    if (document.hidden) stopDictation();
  };
  document.addEventListener('visibilitychange', onHidden);

  for (const radio of radios) radio.addEventListener('change', () => chooseMode(radio.value));
  project.addEventListener('change', () => restart());
  actionScope.addEventListener('change', () => restart());
  topic.addEventListener('input', render);
  savedSearch.addEventListener('input', () => {
    clearTimeout(savedTimer);
    savedRequest++;
    savedResults.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    savedTimer = setTimeout(showSaved, savedSearch.value.trim() ? 200 : 0);
  });
  targetButton.addEventListener('click', async () => {
    const picked = await pickItem({ title: mode === 'edit' ? 'Choose notes to change' : 'Choose notes to work from', filter: { type: 'note', secret: 'false' } });
    if (!picked || picked.id === target?.id) return;
    restart();
    target = picked;
    render();
  });
  message.addEventListener('input', render);
  message.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  });

  const body = h('div', null,
    h('div', { class: 'chat-scope' },
      h('fieldset', { class: 'chat-mode' },
        h('legend', null, 'What should the AI do?'),
        radios.map((radio) => h('label', { class: 'check' }, radio, MODE_LABELS[radio.value]))),
      actionScope, topic, project, targetButton,
      h('span', { class: 'chat-scope-end' }, savedButton, saveButton, savedLabel, newChat)),
    writable ? null : h('p', { class: 'hint' }, 'Changing notes needs a token with the write scope; this one can only ask.'),
    savedPanel, editHint, organizeHint, preferences?.el, actionsHint, restartHint, notice, starters, trimmed, log,
    h('form', { class: 'chat-form', onSubmit: (event) => { event.preventDefault(); send(); } },
      message, error,
      h('div', { class: 'actions' }, dictate, stop, recording, sendButton),
      interim, voiceError, systemHelp,
      h('p', { class: 'hint' }, DICTATION_NOTE)));

  const el = h('section', { class: 'view chat', 'aria-labelledby': 'chat-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'chat-heading' }, 'AI chat')),
    disclosure, unavailable, body);

  // Status and projects only; the conversation, draft and choices are left exactly as they are.
  async function refresh() {
    let status;
    let projects;
    try {
      [status, projects] = await Promise.all([get('/ai/status'), get('/projects')]);
    } catch (failure) {
      configured = false;
      body.hidden = false;
      render();
      show(disclosure, '');
      clear(unavailable, failure.status === 404
        ? empty('This server’s Petty Memory doesn’t have AI chat yet. Update it to chat here.')
        : errorBox(failure, refresh));
      return;
    }
    const chosen = project.value;
    clear(project, h('option', { value: '' }, 'Whole library'), projects.map((p) => h('option', { value: p.id, selected: p.id === chosen }, p.name)));
    configured = status.configured;
    if (!configured) {
      body.hidden = false;
      show(disclosure, '');
      clear(unavailable,
        empty('No AI provider is set up on the server.'),
        h('p', { class: 'hint' }, 'On the computer running Petty Memory, choose one in the desktop app’s Settings → AI, or run petty-memory ai use.'));
      render();
      return;
    }
    const name = status.label.replace(/ \(.*\)$/, '');
    show(disclosure, status.cloud
      ? `Ask about what you’ve saved, or ask for changes to notes you choose. Your messages and the most relevant notes are sent to ${name}.`
      : `Ask about what you’ve saved, or ask for changes to notes you choose. Uses ${name}${status.model ? ` (${status.model})` : ''}, set up on the server.`);
    unavailable.replaceChildren();
    body.hidden = false;
    preferences?.load(null);
    render();
  }

  render();
  return {
    el,
    refresh,
    leave: stopDictation,
    dispose() {
      dictation?.cancel();
      clearTimeout(savedTimer);
      generation++;
      document.removeEventListener('visibilitychange', onHidden);
    },
  };
}
