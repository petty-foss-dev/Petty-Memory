import type { Answer, ChatRequest } from '@enve-memory/ai';
import type { EditProposal, ItemType, OrganizationProposal, OrganizationResult } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import type { ActionProposal, ActionResult, ConversationInput } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { type Turn, answerNote, chatMessages, chatTitle, draftProblem, savedMessages, savedTurns } from '../lib/chat.ts';
import { displayTitle, firstLine } from '../lib/format.ts';
import { DICTATION_NOTE, type Dictation, type DictationState, appendDictation, createDictation, speechRecognizer, systemDictationHelp } from '../lib/voice.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, TypeIcon, useFeedback } from '../ui.tsx';
import { ActionsDialog, ActionsTurn } from './Actions.tsx';
import { AiEditDialog } from './AiEdit.tsx';
import { ItemPicker, type Picked } from './ItemPicker.tsx';
import { OrganizationTurn, OrganizeDialog } from './Organize.tsx';
import { MODE_LABELS, SaveChatDialog, SavedChatsDialog } from './SavedChats.tsx';

type Mode = ChatRequest['mode'];
type ActionScope = 'notes' | 'topic';

const MODES = (['ask', 'edit', 'organize', 'actions'] as const).map((mode) => [mode, MODE_LABELS[mode]] as const);
const ORGANIZE_EXAMPLE = 'Organize all notes about gardening into a PARA system';

const STARTERS: { mode: Mode; label: string; text: string }[] = [
  { mode: 'edit', label: 'Organize notes', text: 'Organize these notes: group related ones under clear headings and order them sensibly. Keep every note.' },
  { mode: 'edit', label: 'Correct wording', text: 'Correct spelling, grammar and wording without changing the meaning.' },
  { mode: 'edit', label: 'Turn into checklist', text: 'Turn this into a checklist with one clear step per note.' },
  { mode: 'ask', label: 'What have I decided?', text: 'What have I decided, and why?' },
  { mode: 'ask', label: 'What’s still open?', text: 'What’s still open or unresolved?' },
  { mode: 'ask', label: 'Summarize a topic', text: 'Summarize what I’ve saved about ' },
  { mode: 'organize', label: 'Organize a topic', text: ORGANIZE_EXAMPLE },
  { mode: 'actions', label: 'Plan next steps', text: 'Suggest tasks with due dates for what still needs doing, tag what belongs together, and write a short brief.' },
];

const NEW_CHAT = 'Started a new chat. Changes you already applied stay in your notes.';

function Cited({ text, sources, onOpen }: { text: string; sources: Answer['sources']; onOpen: (id: string) => void }) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  return (
    <div className="answer-text">
      {text.split(/\n{2,}/).map((paragraph, p) => (
        <p key={p}>
          {paragraph.split(/(\[\d+\])/).map((part, i) => {
            const n = /^\[(\d+)\]$/.exec(part)?.[1];
            const source = n ? byNumber.get(Number(n)) : undefined;
            return source ? (
              <button key={i} className="cite" title={source.title || source.url || ''} onClick={() => onOpen(source.id)}>{n}</button>
            ) : (
              <span key={i}>{part}</span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

function AnswerTurn({ answer, noteId, saving, onSave, onOpen }: {
  answer: Answer;
  noteId: string | undefined;
  saving: boolean;
  onSave: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="answer">
      <Cited text={answer.answer} sources={answer.sources} onOpen={onOpen} />
      {answer.sources.length > 0 && (
        <ol className="sources" aria-label="Sources">
          {answer.sources.map((source) => (
            <li key={source.n}>
              <button className="link-button" onClick={() => onOpen(source.id)}>
                <span className="cite static">{source.n}</span>
                <TypeIcon type={source.type as ItemType} size={14} /> {source.title || source.url || `Untitled ${source.type}`}
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="inline-actions answer-actions">
        {noteId ? (
          <span className="small" role="status">Saved as a note. <button className="link-button" onClick={() => onOpen(noteId)}>Open it</button></span>
        ) : (
          <button className="button small ghost" disabled={saving} onClick={onSave}><Icon name="note" size={14} /> {saving ? 'Saving…' : 'Save as note'}</button>
        )}
      </div>
    </div>
  );
}

function ProposalTurn({ proposal, onReview }: { proposal: EditProposal; onReview: () => void }) {
  const count = proposal.operations.length;
  return (
    <div className="chat-proposal">
      {proposal.summary && <p className="chat-text">{proposal.summary}</p>}
      <p className="muted small">{count ? `${count} suggested change${count === 1 ? '' : 's'}. Nothing has changed yet.` : 'The AI didn’t suggest any changes.'}</p>
      {count > 0 && <button className="button small" onClick={onReview}><Icon name="check" size={14} /> Review changes…</button>}
    </div>
  );
}

/** A conversation on this screen: cited answers or reviewable changes, kept only if the user saves it. */
export function Ask() {
  const { projects, openItem, go } = useApp();
  const { toast, confirm } = useFeedback();
  const status = useLive(() => call('ai.status'), []);
  const [mode, setMode] = useState<Mode>('ask');
  const [project, setProject] = useState('');
  const [target, setTarget] = useState<Picked | null>(null);
  const [actionScope, setActionScope] = useState<ActionScope>('notes');
  const [topic, setTopic] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [dropped, setDropped] = useState(0);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [reviewing, setReviewing] = useState<EditProposal | null>(null);
  const [planning, setPlanning] = useState<OrganizationProposal | null>(null);
  const [organized, setOrganized] = useState<Record<string, OrganizationResult | null>>({});
  const [acting, setActing] = useState<ActionProposal | null>(null);
  const [acted, setActed] = useState<Record<string, ActionResult | null>>({});
  const [answerNotes, setAnswerNotes] = useState<Record<number, string>>({});
  const [savingAnswer, setSavingAnswer] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ id: string; title: string; count: number } | null>(null);
  const [savingChat, setSavingChat] = useState(false);
  const [naming, setNaming] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [voice, setVoice] = useState<DictationState>({ status: 'idle' });
  const [systemHelp, setSystemHelp] = useState(false);
  const generation = useRef(0);
  const sending = useRef(false);
  const dictation = useRef<Dictation | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const provider = status.data?.providers.find((p) => p.id === status.data?.provider);
  const recording = voice.status === 'starting' || voice.status === 'listening';
  const busy = pending !== null || resuming;
  const configured = Boolean(status.data && status.data.provider !== 'none');
  const needsTarget = mode === 'edit' || (mode === 'actions' && actionScope === 'notes');
  const usesProject = mode === 'ask' || (mode === 'actions' && actionScope === 'topic');
  const dirty = turns.length > 0 && saved?.count !== turns.length;

  // Aborting releases the microphone at once; the controls stay usable for whenever the person returns.
  const stopDictation = () => {
    dictation.current?.cancel();
    setVoice((current) => (current.status === 'failed' ? current : { status: 'idle' }));
  };

  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) stopDictation();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      dictation.current?.cancel();
      generation.current++;
    };
  }, []);

  const clearConversation = () => {
    stopDictation();
    generation.current++;
    sending.current = false;
    setTurns([]);
    setDropped(0);
    setPending(null);
    setError(null);
    setReviewing(null);
    setPlanning(null);
    setOrganized({});
    setActing(null);
    setActed({});
    setAnswerNotes({});
    setSaved(null);
  };

  // A new scope starts over, so earlier context or audio can't steer a request it wasn't meant for, and a saved chat is never overwritten by it.
  const restart = () => {
    if (turns.length) setNotice(NEW_CHAT);
    clearConversation();
  };

  const chooseMode = (next: Mode) => {
    if (next === mode) return;
    restart();
    setMode(next);
  };

  const scopeFields = (): Pick<ConversationInput, 'project' | 'rootId' | 'query'> => {
    if (needsTarget) return target ? { rootId: target.id } : {};
    if (mode === 'actions') return { query: topic.trim(), ...(project ? { project } : {}) };
    return mode === 'ask' && project ? { project } : {};
  };

  const send = async () => {
    const text = draft.trim();
    if (!configured || resuming || !text || sending.current || recording) return;
    const problem = draftProblem(text)
      ?? (needsTarget && !target ? (mode === 'edit' ? 'Choose the notes to change first.' : 'Choose the notes to work from first.') : null)
      ?? (mode === 'actions' && actionScope === 'topic' && !topic.trim() ? 'Say which topic to work from first.' : null);
    if (problem) {
      setError(problem);
      return;
    }
    const run = generation.current;
    const { messages, dropped: left } = chatMessages(turns, text);
    const request = { mode, messages, ...scopeFields() } as ChatRequest;
    sending.current = true;
    setPending(text);
    setDraft('');
    setError(null);
    setNotice(null);
    try {
      const reply = await call('ai.chat', request);
      if (run !== generation.current) return;
      setTurns((current) => [...current, { role: 'user', content: text }, { role: 'assistant', reply }]);
      setDropped(left);
    } catch (err) {
      if (run !== generation.current) return;
      setError(errorMessage(err));
      setDraft((current) => (current.trim() ? `${text}\n\n${current}` : text));
    } finally {
      if (run === generation.current) {
        sending.current = false;
        setPending(null);
      }
    }
  };

  const saveChat = async (title: string) => {
    const run = generation.current;
    const { messages, dropped: left } = savedMessages(turns);
    if (!messages.length) throw new Error('This chat is too long to save. Start a new chat and save it sooner.');
    const result = await call('chats.save', { ...(saved ? { id: saved.id } : {}), title, mode, messages, ...scopeFields() });
    if (run !== generation.current) return;
    setSaved({ id: result.id, title: result.title, count: turns.length });
    setNaming(false);
    toast(left ? `Saved the latest ${messages.length} messages as “${result.title}”` : `Saved “${result.title}”`);
  };

  const updateChat = () => {
    if (!saved) return;
    setSavingChat(true);
    saveChat(saved.title).catch((err: unknown) => toast(errorMessage(err), 'error')).finally(() => setSavingChat(false));
  };

  // Only the text of a saved chat comes back; the draft in the message box is left alone.
  const resume = async (id: string) => {
    setBrowsing(false);
    if (dirty && !(await confirm({
      title: 'Open a saved chat?',
      body: <p>This chat has messages you haven’t saved. Opening another one replaces them. Your unsent message stays in the box.</p>,
      confirmLabel: 'Open saved chat',
    }))) return;
    const run = generation.current;
    setResuming(true);
    try {
      const conversation = await call('chats.get', id);
      const root = conversation.rootId ? await call('items.get', conversation.rootId).then((item) => item, () => null) : null;
      if (run !== generation.current) return;
      clearConversation();
      setMode(conversation.mode);
      setProject(conversation.project ?? '');
      setActionScope(conversation.query ? 'topic' : 'notes');
      setTopic(conversation.query ?? '');
      setTarget(root ? { id: root.id, title: displayTitle(root), type: root.type } : null);
      setTurns(savedTurns(conversation.messages));
      setSaved({ id: conversation.id, title: conversation.title, count: conversation.messages.length });
      setNotice(`Opened “${conversation.title}”. Earlier proposals show as text; ask again for changes you can apply.`);
      if (conversation.rootId && !root) setError('The notes this chat was about aren’t available any more. Choose notes to continue in a new chat.');
    } catch (err) {
      if (run === generation.current) setError(errorMessage(err));
    } finally {
      setResuming(false);
    }
  };

  const saveAnswer = async (index: number, answer: Answer) => {
    const question = turns[index - 1];
    const run = generation.current;
    setSavingAnswer(index);
    try {
      const note = await call('items.saveNote', {
        title: question?.role === 'user' ? firstLine(question.content, 120) : 'AI answer',
        body: answerNote(answer),
        project: mode === 'ask' && project ? project : undefined,
      });
      if (run === generation.current) setAnswerNotes((current) => ({ ...current, [index]: note.id }));
      toast('Answer saved as a note');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSavingAnswer(null);
    }
  };

  const Recognition = speechRecognizer(window);
  const dictate = () => {
    setSystemHelp(false);
    input.current?.focus();
    if (!Recognition) {
      setSystemHelp(true);
      return;
    }
    dictation.current ??= createDictation(Recognition, {
      lang: navigator.language,
      onText: (text) => setDraft((current) => appendDictation(current, text)),
      onState: setVoice,
    });
    dictation.current.start();
  };

  const header = (
    <header className="page-header">
      <h1>AI chat</h1>
      <p className="subtitle">
        Ask about what you’ve saved, or ask for changes to notes you choose. {provider?.cloud
          ? <>Your messages and the most relevant notes are sent to {provider.label}.</>
          : provider ? <>Runs on the {provider.label.replace(/ \(.*\)$/, '')} server at {status.data?.baseUrl || provider.baseUrl}. It receives your messages and matching notes.</> : null}{' '}
        <button className="link-button" onClick={() => go({ view: 'settings', section: 'ai' })}>AI settings</button>
      </p>
    </header>
  );

  const failed = voice.status === 'failed' ? voice : null;
  const canSend = configured && !busy && !recording && Boolean(draft.trim()) && (!needsTarget || target !== null) && (mode !== 'actions' || actionScope === 'notes' || Boolean(topic.trim()));
  const placeholder = mode === 'ask' ? 'What do we know about the garage door protocol?'
    : mode === 'organize' ? ORGANIZE_EXAMPLE
      : mode === 'actions' ? 'What should come out of this? For example, “tasks for next week and a short brief”'
        : 'What should change? For example, “group these by room”';

  return (
    <div className="page ask chat">
      {header}
      {status.data?.provider === 'none' && (
        <Empty title="Set up an AI provider to chat"
          action={<button className="button primary" onClick={() => go({ view: 'settings', section: 'ai' })}>Open AI settings</button>}>
          Choose a local model server or a cloud provider in Settings → AI. Saved chats and the rest of your library remain available.
        </Empty>
      )}
      {status.data?.error && <p className="error-text" role="alert">{status.data.error}</p>}

      <div className="chat-scope">
        <div className="segmented" role="radiogroup" aria-label="What should the AI do?">
          {MODES.map(([value, label]) => (
            <button key={value} role="radio" aria-checked={mode === value} className={mode === value ? 'active' : ''} disabled={busy} onClick={() => chooseMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'actions' && (
          <div className="segmented small" role="radiogroup" aria-label="Work from">
            {([['notes', 'Chosen notes'], ['topic', 'A topic']] as const).map(([value, label]) => (
              <button key={value} role="radio" aria-checked={actionScope === value} className={actionScope === value ? 'active' : ''} disabled={busy} onClick={() => {
                if (value === actionScope) return;
                restart();
                setActionScope(value);
              }}>{label}</button>
            ))}
          </div>
        )}
        {mode === 'actions' && actionScope === 'topic' && (
          <input
            type="search"
            className="chat-topic"
            aria-label="Topic keywords"
            placeholder="Topic, e.g. garage door"
            value={topic}
            disabled={busy || turns.length > 0}
            title={turns.length > 0 ? 'Start a new chat to change the topic' : undefined}
            onChange={(event) => setTopic(event.target.value)}
          />
        )}
        {usesProject && (
          <select aria-label="Limit to project" value={project} disabled={busy} onChange={(event) => {
            restart();
            setProject(event.target.value);
          }}>
            <option value="">Whole library</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {needsTarget && (
          <button className="button small" disabled={busy} onClick={() => setPicking(true)}>
            <Icon name="note" size={14} /> {target ? `Notes: ${target.title}` : mode === 'edit' ? 'Choose notes to change…' : 'Choose notes to work from…'}
          </button>
        )}
        <span className="chat-scope-end">
          <button className="button small ghost" disabled={busy} onClick={() => setBrowsing(true)}>Saved chats</button>
          {turns.length > 0 && (dirty ? (
            <button className="button small" disabled={busy || savingChat} onClick={() => (saved ? updateChat() : setNaming(true))}>
              {savingChat ? 'Saving…' : saved ? 'Save changes' : 'Save chat'}
            </button>
          ) : <span className="muted small" role="status">Saved</span>)}
          {turns.length > 0 && <button className="button small ghost" disabled={busy} onClick={() => restart()}>New chat</button>}
        </span>
      </div>
      {mode === 'edit' && (
        <p className="muted small">
          The AI suggests changes to the chosen note and everything inside it, never secret notes or decisions. You review each
          change before it’s applied, and can undo it afterwards.
        </p>
      )}
      {mode === 'organize' && (
        <p className="muted small">
          Say what to gather and how, for example “{ORGANIZE_EXAMPLE}”. The AI finds every matching note and proposes headings under one
          top-level note. Moving a note brings everything inside it, and project filing stays as it is. Nothing moves until you review and
          apply.
        </p>
      )}
      {mode === 'actions' && (
        <p className="muted small">
          The AI suggests tasks, tags, reminders and a brief from {actionScope === 'notes' ? 'the chosen note and everything inside it' : 'notes about the topic'}.
          You choose which to apply, and can undo them afterwards. It never deletes or moves anything.
        </p>
      )}
      {turns.length > 0 && (
        <p className="muted small">
          Changing the mode, project or notes starts a new chat.
          {!saved ? ' This chat isn’t saved.' : dirty ? ` New messages aren’t in “${saved.title}” until you save changes.` : ''}
        </p>
      )}
      {notice && <p className="chat-notice" role="status">{notice}</p>}

      {turns.length === 0 && !busy && (
        <div className="chips" role="group" aria-label="Suggestions">
          {STARTERS.map((starter) => (
            <button key={starter.label} className="chip" onClick={() => {
              chooseMode(starter.mode);
              setDraft(starter.text);
              input.current?.focus();
            }}>{starter.label}</button>
          ))}
        </div>
      )}

      {(turns.length > 0 || busy) && (
        <ol className="chat-log" role="log" aria-label="Conversation">
          {dropped > 0 && <li className="chat-notice">Earlier messages are still shown, but only the most recent ones are sent to the AI.</li>}
          {turns.map((turn, index) => {
            if (turn.role === 'user') return <li key={index} className="chat-turn user"><p className="chat-text">{turn.content}</p></li>;
            if ('saved' in turn) {
              return (
                <li key={index} className="chat-turn assistant saved">
                  <p className="chat-text">{turn.saved}</p>
                  <p className="muted small">From the saved chat</p>
                </li>
              );
            }
            const { reply } = turn;
            return (
              <li key={index} className="chat-turn assistant">
                {reply.kind === 'answer' && (
                  <AnswerTurn
                    answer={reply.answer}
                    noteId={answerNotes[index]}
                    saving={savingAnswer === index}
                    onSave={() => void saveAnswer(index, reply.answer)}
                    onOpen={openItem}
                  />
                )}
                {reply.kind === 'proposal' && <ProposalTurn proposal={reply.proposal} onReview={() => setReviewing(reply.proposal)} />}
                {reply.kind === 'organization' && (
                  <OrganizationTurn
                    proposal={reply.proposal}
                    result={organized[reply.proposal.id]}
                    onReview={() => setPlanning(reply.proposal)}
                    onOpen={openItem}
                  />
                )}
                {reply.kind === 'actions' && (
                  <ActionsTurn proposal={reply.proposal} result={acted[reply.proposal.id]} onReview={() => setActing(reply.proposal)} />
                )}
              </li>
            );
          })}
          {pending !== null && (
            <>
              <li className="chat-turn user"><p className="chat-text">{pending}</p></li>
              <li className="chat-turn assistant muted" role="status">Thinking…</li>
            </>
          )}
        </ol>
      )}

      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          aria-label="Message"
          rows={3}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="inline-actions chat-actions">
          {recording ? (
            <button type="button" className="button recording" onClick={() => dictation.current?.stop()}>
              <Icon name="stop" size={15} /> Stop
            </button>
          ) : (
            <button type="button" className="button" onClick={dictate}>
              <Icon name="mic" size={15} /> Dictate
            </button>
          )}
          {recording && (
            <span className="recording-status" role="status">
              <span className="recording-dot" aria-hidden="true" />
              {voice.status === 'starting' ? 'Starting dictation…' : 'Listening. Press Stop when you’re done.'}
            </span>
          )}
          <button type="submit" className="button primary" disabled={!canSend}>
            <Icon name="sparkle" size={15} /> {busy ? 'Thinking…' : 'Send'}
          </button>
        </div>
        {voice.status === 'listening' && voice.interim && <p className="muted small chat-interim" aria-live="polite">{voice.interim}…</p>}
        {failed && <p className="error-text" role="alert">{failed.message}</p>}
        {(systemHelp || failed?.useSystem) && <p className="small">{systemDictationHelp(window.enve.platform)}</p>}
        <p className="muted small">{DICTATION_NOTE}</p>
      </form>

      {picking && (
        <ItemPicker
          title={mode === 'edit' ? 'Choose notes to change' : 'Choose notes to work from'}
          filter={{ type: 'note', secret: false }}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPicking(false);
            if (picked.id === target?.id) return;
            restart();
            setTarget(picked);
          }}
        />
      )}
      {reviewing && target && (
        <AiEditDialog rootId={target.id} title={target.title} initialProposal={reviewing} onClose={() => setReviewing(null)} />
      )}
      {planning && (
        <OrganizeDialog
          proposal={planning}
          onApplied={(result) => setOrganized((current) => ({ ...current, [planning.id]: result }))}
          onUndone={() => setOrganized((current) => ({ ...current, [planning.id]: null }))}
          onOpen={(id) => {
            setPlanning(null);
            go({ view: 'outline', reveal: id });
          }}
          onClose={() => setPlanning(null)}
        />
      )}
      {acting && (
        <ActionsDialog
          proposal={acting}
          onApplied={(result) => setActed((current) => ({ ...current, [acting.id]: result }))}
          onUndone={() => setActed((current) => ({ ...current, [acting.id]: null }))}
          onClose={() => setActing(null)}
        />
      )}
      {browsing && (
        <SavedChatsDialog
          currentId={saved?.id ?? null}
          onOpen={(id) => void resume(id)}
          onArchived={(id) => {
            if (id === saved?.id) setSaved(null);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
      {naming && (
        <SaveChatDialog
          initialTitle={chatTitle(turns)}
          kept={savedMessages(turns).messages.length}
          total={turns.length}
          onSave={saveChat}
          onClose={() => setNaming(false)}
        />
      )}
    </div>
  );
}
