import type { Answer, ChatRequest } from '@enve-memory/ai';
import type { EditProposal, ItemType, OrganizationProposal, OrganizationResult } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { type Turn, chatMessages, draftProblem } from '../lib/chat.ts';
import { DICTATION_NOTE, type Dictation, type DictationState, appendDictation, createDictation, speechRecognizer, systemDictationHelp } from '../lib/voice.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, TypeIcon } from '../ui.tsx';
import { AiEditDialog } from './AiEdit.tsx';
import { ItemPicker, type Picked } from './ItemPicker.tsx';
import { OrganizationTurn, OrganizeDialog } from './Organize.tsx';

type Mode = ChatRequest['mode'];

const MODES: [Mode, string][] = [['ask', 'Ask'], ['edit', 'Change notes'], ['organize', 'Organize library']];
const ORGANIZE_EXAMPLE = 'Organize all notes about gardening into a PARA system';

const STARTERS: { mode: Mode; label: string; text: string }[] = [
  { mode: 'edit', label: 'Organize notes', text: 'Organize these notes: group related ones under clear headings and order them sensibly. Keep every note.' },
  { mode: 'edit', label: 'Correct wording', text: 'Correct spelling, grammar and wording without changing the meaning.' },
  { mode: 'edit', label: 'Turn into checklist', text: 'Turn this into a checklist with one clear step per note.' },
  { mode: 'ask', label: 'What have I decided?', text: 'What have I decided, and why?' },
  { mode: 'ask', label: 'What’s still open?', text: 'What’s still open or unresolved?' },
  { mode: 'ask', label: 'Summarize a topic', text: 'Summarize what I’ve saved about ' },
  { mode: 'organize', label: 'Organize a topic', text: ORGANIZE_EXAMPLE },
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

function AnswerTurn({ answer, onOpen }: { answer: Answer; onOpen: (id: string) => void }) {
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

/** A conversation kept only on this screen: cited answers, or reviewable changes. */
export function Ask() {
  const { projects, openItem, go } = useApp();
  const status = useLive(() => call('ai.status'), []);
  const [mode, setMode] = useState<Mode>('ask');
  const [project, setProject] = useState('');
  const [target, setTarget] = useState<Picked | null>(null);
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
  const [voice, setVoice] = useState<DictationState>({ status: 'idle' });
  const [systemHelp, setSystemHelp] = useState(false);
  const generation = useRef(0);
  const sending = useRef(false);
  const dictation = useRef<Dictation | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const provider = status.data?.providers.find((p) => p.id === status.data?.provider);
  const recording = voice.status === 'starting' || voice.status === 'listening';
  const busy = pending !== null;

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

  // A new scope starts over, so earlier context or audio can't steer a request it wasn't meant for.
  const restart = () => {
    stopDictation();
    generation.current++;
    sending.current = false;
    if (turns.length) setNotice(NEW_CHAT);
    setTurns([]);
    setDropped(0);
    setPending(null);
    setError(null);
    setReviewing(null);
    setPlanning(null);
    setOrganized({});
  };

  const chooseMode = (next: Mode) => {
    if (next === mode) return;
    restart();
    setMode(next);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending.current || recording) return;
    const problem = draftProblem(text) ?? (mode === 'edit' && !target ? 'Choose the notes to change first.' : null);
    if (problem) {
      setError(problem);
      return;
    }
    const run = generation.current;
    const { messages, dropped: left } = chatMessages(turns, text);
    const request: ChatRequest = mode === 'edit' ? { mode, messages, rootId: target!.id }
      : mode === 'organize' ? { mode, messages } : { mode, messages, ...(project ? { project } : {}) };
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

  if (status.data?.provider === 'none') {
    return (
      <div className="page ask">
        {header}
        <Empty
          title="Set up an AI provider to chat"
          action={<button className="button primary" onClick={() => go({ view: 'settings', section: 'ai' })}>Open AI settings</button>}
        >
          Choose a local model server or a cloud provider in Settings → AI. Everything else in Petty Memory works without one.
        </Empty>
      </div>
    );
  }

  const failed = voice.status === 'failed' ? voice : null;

  return (
    <div className="page ask chat">
      {header}
      {status.data?.error && <p className="error-text" role="alert">{status.data.error}</p>}

      <div className="chat-scope">
        <div className="segmented" role="radiogroup" aria-label="What should the AI do?">
          {MODES.map(([value, label]) => (
            <button key={value} role="radio" aria-checked={mode === value} className={mode === value ? 'active' : ''} disabled={busy} onClick={() => chooseMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'ask' && (
          <select aria-label="Limit to project" value={project} disabled={busy} onChange={(event) => {
            restart();
            setProject(event.target.value);
          }}>
            <option value="">Whole library</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {mode === 'edit' && (
          <button className="button small" disabled={busy} onClick={() => setPicking(true)}>
            <Icon name="note" size={14} /> {target ? `Notes: ${target.title}` : 'Choose notes to change…'}
          </button>
        )}
        {turns.length > 0 && (
          <button className="button small ghost" disabled={busy} onClick={() => restart()}>New chat</button>
        )}
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
      {turns.length > 0 && <p className="muted small">Changing the mode, project or notes starts a new chat. This chat isn’t saved.</p>}
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
            const { reply } = turn;
            return (
              <li key={index} className="chat-turn assistant">
                {reply.kind === 'answer' && <AnswerTurn answer={reply.answer} onOpen={openItem} />}
                {reply.kind === 'proposal' && <ProposalTurn proposal={reply.proposal} onReview={() => setReviewing(reply.proposal)} />}
                {reply.kind === 'organization' && (
                  <OrganizationTurn
                    proposal={reply.proposal}
                    result={organized[reply.proposal.id]}
                    onReview={() => setPlanning(reply.proposal)}
                    onOpen={openItem}
                  />
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
          placeholder={mode === 'ask' ? 'What do we know about the garage door protocol?'
            : mode === 'organize' ? ORGANIZE_EXAMPLE : 'What should change? For example, “group these by room”'}
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
          <button type="submit" className="button primary" disabled={busy || recording || !draft.trim() || (mode === 'edit' && !target)}>
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
          title="Choose notes to change"
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
    </div>
  );
}
