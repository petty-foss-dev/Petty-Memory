import { can, get, post } from './api.js';
import { chatMessages, draftProblem } from './conversation.js';
import { referenceLink, showProposal } from './detail.js';
import { clear, empty, errorBox, h } from './dom.js';
import { displayTitle } from './text.js';
import { pickItem } from './picker.js';
import { DICTATION_NOTE, appendDictation, createDictation, platformOf, speechRecognizer, systemDictationHelp } from './voice.js';

const ORGANIZE_EXAMPLE = 'Organize all notes about gardening into a PARA system';
const STARTERS = [
  ['edit', 'Organize notes', 'Organize these notes: group related ones under clear headings and order them sensibly. Keep every note.'],
  ['edit', 'Correct wording', 'Correct spelling, grammar and wording without changing the meaning.'],
  ['edit', 'Turn into checklist', 'Turn this into a checklist with one clear step per note.'],
  ['ask', 'What have I decided?', 'What have I decided, and why?'],
  ['ask', 'What’s still open?', 'What’s still open or unresolved?'],
  ['ask', 'Summarize a topic', 'Summarize what I’ve saved about '],
  ['organize', 'Organize a topic', ORGANIZE_EXAMPLE],
];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const NEW_CHAT = 'Started a new chat. Changes you already applied stay in your notes.';

/** Model text only ever becomes text nodes. */
function cited(text, sources, open) {
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  return h('div', { class: 'answer-text' }, text.split(/\n{2,}/).map((paragraph) => h('p', null, paragraph.split(/(\[\d+\])/).map((part) => {
    const n = /^\[(\d+)\]$/.exec(part)?.[1];
    const source = n ? byNumber.get(Number(n)) : undefined;
    return source
      ? h('button', { type: 'button', class: 'ref cite', title: source.title || source.url || '', onClick: () => open(source.id) }, n)
      : part;
  }))));
}

/** The proposed hierarchy with a checkbox per moved branch; only Apply changes anything. */
function showOrganization(out, proposal, { changed, open, onDiscard }) {
  const { destination } = proposal;
  const items = new Map(proposal.items.map((item) => [item.id, item]));
  const selected = new Set(items.keys());
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
    h('div', { class: 'organize-root', role: 'group', 'aria-label': 'Proposed structure' },
      h('strong', null, destination.title), ' ', h('span', { class: 'badge' }, destination.create ? 'New top-level note' : 'Existing note'),
      branch(destination.id)),
    status,
    h('div', { class: 'actions' }, apply, discard));
}

/** A conversation kept only in this tab's memory; leaving the section keeps it, disconnecting forgets it. */
export function createChatView(ctx) {
  let mode = 'ask';
  let target = null;
  let turns = [];
  let generation = 0;
  let sending = false;
  let voice = { status: 'idle' };
  let dictation = null;
  const Recognition = speechRecognizer(window);
  const writable = can('write');

  const disclosure = h('p', { class: 'hint' });
  const unavailable = h('div');
  const modeAsk = h('input', { type: 'radio', name: 'chat-mode', value: 'ask', checked: true });
  const modeEdit = h('input', { type: 'radio', name: 'chat-mode', value: 'edit' });
  const modeOrganize = h('input', { type: 'radio', name: 'chat-mode', value: 'organize' });
  const project = h('select', { 'aria-label': 'Limit to project' }, h('option', { value: '' }, 'Whole library'));
  const targetButton = h('button', { type: 'button', class: 'btn small' });
  const newChat = h('button', { type: 'button', class: 'btn small', onClick: () => restart() }, 'New chat');
  const editHint = h('p', { class: 'hint' }, 'The AI suggests changes to the chosen note and everything inside it, never secret notes or decisions. You review each change before it’s applied, and can undo it afterwards.');
  const organizeHint = h('p', { class: 'hint' }, `Say what to gather and how, for example “${ORGANIZE_EXAMPLE}”. The AI finds every matching note and proposes headings under one top-level note. Moving a note brings everything inside it, and project filing stays as it is. Nothing moves until you review and apply.`);
  const restartHint = h('p', { class: 'hint' }, 'Changing the mode, project or notes starts a new chat. This chat isn’t saved.');
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

  function render() {
    const listening = voice.status === 'starting' || voice.status === 'listening';
    modeAsk.disabled = sending;
    modeEdit.disabled = modeOrganize.disabled = sending || !writable;
    project.hidden = mode !== 'ask';
    project.disabled = sending;
    targetButton.hidden = mode !== 'edit';
    targetButton.disabled = sending;
    targetButton.textContent = target ? `Notes: ${target.title}` : 'Choose notes to change…';
    editHint.hidden = mode !== 'edit';
    organizeHint.hidden = mode !== 'organize';
    newChat.hidden = restartHint.hidden = turns.length === 0;
    newChat.disabled = sending;
    starters.hidden = turns.length > 0 || sending;
    log.hidden = turns.length === 0 && !sending;
    message.placeholder = mode === 'ask' ? 'What do we know about the garage door protocol?'
      : mode === 'organize' ? ORGANIZE_EXAMPLE : 'What should change? For example, “group these by room”';
    dictate.hidden = listening;
    stop.hidden = !listening;
    show(recording, voice.status === 'starting' ? 'Starting dictation…' : voice.status === 'listening' ? 'Listening. Press Stop when you’re done.' : '');
    show(interim, voice.status === 'listening' && voice.interim ? `${voice.interim}…` : '');
    sendButton.disabled = sending || listening || !message.value.trim() || (mode === 'edit' && !target);
    sendButton.textContent = sending ? 'Thinking…' : 'Send';
  }

  // A new scope starts over, so earlier context or audio can't steer a request it wasn't meant for.
  function restart() {
    stopDictation();
    generation++;
    sending = false;
    if (turns.length) show(notice, NEW_CHAT);
    turns = [];
    log.replaceChildren();
    trimmed.hidden = true;
    show(error, '');
    render();
  }

  function chooseMode(next) {
    if (next === mode) return;
    mode = next;
    restart();
    for (const radio of [modeAsk, modeEdit, modeOrganize]) radio.checked = radio.value === mode;
  }

  const userTurn = (text) => h('li', { class: 'chat-turn user' }, h('p', { class: 'chat-text' }, text));

  function assistantTurn(reply) {
    if (reply.kind === 'answer') {
      const { answer, sources } = reply.answer;
      return h('li', { class: 'chat-turn assistant' }, h('div', { class: 'answer' },
        cited(answer, sources, (id) => ctx.select(id)),
        sources.length ? h('ol', { class: 'sources', 'aria-label': 'Sources' }, sources.map((source) => h('li', null,
          h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(source.id) },
            h('span', { class: 'ref' }, String(source.n)), ' ', source.title || source.url || `Untitled ${source.type}`)))) : null));
    }
    if (reply.kind === 'organization') return organizationTurn(reply.proposal);
    const { proposal } = reply;
    const count = proposal.operations.length;
    const out = h('div', { class: 'proposal', 'aria-live': 'polite' });
    const review = h('button', { type: 'button', class: 'btn small', onClick: () => {
      review.hidden = true;
      showProposal(out, proposal, {
        changed: () => ctx.changed(),
        onDiscard: () => {
          clear(out);
          review.hidden = false;
        },
      });
    } }, 'Review changes');
    return h('li', { class: 'chat-turn assistant' },
      proposal.summary ? h('p', { class: 'chat-text' }, proposal.summary) : null,
      h('p', { class: 'hint' }, count ? `${count} suggested change${count === 1 ? '' : 's'}. Nothing has changed yet.` : 'The AI didn’t suggest any changes.'),
      count > 0 && writable ? review : null,
      out);
  }

  function organizationTurn(proposal) {
    const { matchedCount, affectedCount, destination } = proposal;
    const state = h('p', { class: 'hint' }, 'Nothing has moved yet.');
    const out = h('div', { class: 'proposal' });
    const review = h('button', { type: 'button', class: 'btn small', onClick: () => {
      review.hidden = state.hidden = true;
      showOrganization(out, proposal, {
        changed: () => ctx.changed(),
        open: (id) => ctx.select(id),
        onDiscard: () => {
          clear(out);
          review.hidden = state.hidden = false;
        },
      });
    } }, 'Review organization');
    return h('li', { class: 'chat-turn assistant' },
      proposal.summary ? h('p', { class: 'chat-text' }, proposal.summary) : null,
      h('p', { class: 'hint' }, `${plural(matchedCount, 'matching note')}, ${plural(affectedCount, 'item')} counting what’s inside them, into ${destination.create ? 'a new' : 'the existing'} top-level note “${destination.title}”.`),
      state, review, out);
  }

  async function send() {
    const text = message.value.trim();
    if (!text || sending || voice.status === 'starting' || voice.status === 'listening') return;
    const problem = draftProblem(text) ?? (mode === 'edit' && !target ? 'Choose the notes to change first.' : null);
    if (problem) return show(error, problem);
    const run = generation;
    const { messages, dropped } = chatMessages(turns, text);
    const request = mode === 'edit' ? { mode, messages, rootId: target.id }
      : mode === 'organize' ? { mode, messages } : { mode, messages, ...(project.value ? { project: project.value } : {}) };
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
      if (!['answer', 'proposal', 'organization'].includes(reply?.kind)) throw new Error('The server sent an unexpected chat reply.');
      turns.push({ role: 'user', content: text }, { role: 'assistant', reply });
      pending[1].replaceWith(assistantTurn(reply));
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

  for (const radio of [modeAsk, modeEdit, modeOrganize]) radio.addEventListener('change', () => chooseMode(radio.value));
  project.addEventListener('change', () => restart());
  targetButton.addEventListener('click', async () => {
    const picked = await pickItem({ title: 'Choose notes to change', filter: { type: 'note', secret: 'false' } });
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
        h('label', { class: 'check' }, modeAsk, 'Ask'),
        h('label', { class: 'check' }, modeEdit, 'Change notes'),
        h('label', { class: 'check' }, modeOrganize, 'Organize library')),
      project, targetButton, newChat),
    writable ? null : h('p', { class: 'hint' }, 'Changing notes needs a token with the write scope; this one can only ask.'),
    editHint, organizeHint, restartHint, notice, starters, trimmed, log,
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
      body.hidden = true;
      show(disclosure, '');
      clear(unavailable, failure.status === 404
        ? empty('This server’s Petty Memory doesn’t have AI chat yet. Update it to chat here.')
        : errorBox(failure, refresh));
      return;
    }
    const chosen = project.value;
    clear(project, h('option', { value: '' }, 'Whole library'), projects.map((p) => h('option', { value: p.id, selected: p.id === chosen }, p.name)));
    if (!status.configured) {
      body.hidden = true;
      show(disclosure, '');
      clear(unavailable,
        empty('No AI provider is set up on the server.'),
        h('p', { class: 'hint' }, 'On the computer running Petty Memory, choose one in the desktop app’s Settings → AI, or run petty-memory ai use.'));
      return;
    }
    const name = status.label.replace(/ \(.*\)$/, '');
    show(disclosure, status.cloud
      ? `Ask about what you’ve saved, or ask for changes to notes you choose. Your messages and the most relevant notes are sent to ${name}.`
      : `Ask about what you’ve saved, or ask for changes to notes you choose. Uses ${name}${status.model ? ` (${status.model})` : ''}, set up on the server.`);
    unavailable.replaceChildren();
    body.hidden = false;
    render();
  }

  render();
  return {
    el,
    refresh,
    leave: stopDictation,
    dispose() {
      dictation?.cancel();
      generation++;
      document.removeEventListener('visibilitychange', onHidden);
    },
  };
}
