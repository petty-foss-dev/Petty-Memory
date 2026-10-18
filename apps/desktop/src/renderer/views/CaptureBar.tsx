import type { ItemDetail } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { detectCapture } from '../lib/capture.ts';
import { displayTitle } from '../lib/format.ts';
import {
  type Dictation, type DictationState, NOTE_DICTATION_NOTE, appendDictation, createDictation, speechRecognizer, systemDictationHelp,
} from '../lib/voice.ts';
import { Icon, ProjectSelect, useFeedback } from '../ui.tsx';
import { useApp } from '../context.ts';

/** Saves free text as a link (first word is a URL) or a note. */
export async function saveCapture(text: string, project: string | null): Promise<{ item: ItemDetail; existed: boolean } | null> {
  const detected = detectCapture(text);
  if (!detected) return null;
  if (detected.kind === 'link') {
    const { item, created } = await call('items.saveLink', { url: detected.url, note: detected.note || undefined, project: project ?? undefined });
    return { item, existed: !created };
  }
  return { item: await call('items.saveNote', { body: detected.body, project: project ?? undefined }), existed: false };
}

function SavedChip({ id, existed }: { id: string; existed: boolean }) {
  const { openItem } = useApp();
  const item = useLive(() => call('items.get', id), [id]);
  if (!item.data) return null;
  const status = item.data.metadata.ingest?.status;
  const label = status === 'pending'
    ? `Archiving ${item.data.url}…`
    : status === 'failed'
      ? `Saved, but archiving failed: ${item.data.metadata.ingest?.error ?? 'unknown error'}`
      : `${existed ? 'Already saved' : 'Saved'}: ${displayTitle(item.data)}`;
  return (
    <button className={`saved-chip ${status ?? 'done'}`} onClick={() => openItem(id)} data-testid="saved-chip">
      <Icon name={status === 'pending' ? 'refresh' : 'check'} size={14} className={status === 'pending' ? 'spin' : ''} />
      <span>{label}</span>
    </button>
  );
}

export function CaptureBar({ focus, placeholder }: { focus: { n: number; mode: 'note' | 'link' }; placeholder?: string }) {
  const { projects } = useApp();
  const { toast } = useFeedback();
  const [text, setText] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; existed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState<DictationState>({ status: 'idle' });
  const [dictating, setDictating] = useState(false);
  const [systemHelp, setSystemHelp] = useState(false);
  const dictation = useRef<Dictation | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const detected = detectCapture(text);
  const recording = voice.status === 'starting' || voice.status === 'listening';
  const failed = voice.status === 'failed' ? voice : null;

  useEffect(() => {
    if (focus.n > 0) input.current?.focus();
  }, [focus.n]);

  // Hiding the window or leaving Home releases the microphone; the words already heard stay in the box.
  useEffect(() => {
    const onHidden = () => {
      if (!document.hidden) return;
      dictation.current?.cancel();
      setVoice((current) => (current.status === 'failed' ? current : { status: 'idle' }));
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      dictation.current?.cancel();
    };
  }, []);

  const dictate = () => {
    setDictating(true);
    setSystemHelp(false);
    input.current?.focus();
    const Recognition = speechRecognizer(window);
    if (!Recognition) {
      setSystemHelp(true);
      return;
    }
    dictation.current ??= createDictation(Recognition, {
      lang: navigator.language,
      onText: (heard) => setText((current) => appendDictation(current, heard)),
      onState: setVoice,
    });
    dictation.current.start();
  };

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = async () => {
    if (!detected || busy || recording) return;
    setBusy(true);
    try {
      const result = await saveCapture(text, project);
      if (result) {
        setSaved({ id: result.item.id, existed: result.existed });
        setText('');
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="capture" aria-label="Quick capture">
      <div className="capture-box">
        <Icon name={detected?.kind === 'link' ? 'bookmark' : 'note'} className="capture-icon" />
        <textarea
          ref={input}
          disabled={busy}
          rows={1}
          value={text}
          aria-label="Capture a note or link"
          placeholder={placeholder ?? (focus.mode === 'link' ? 'Paste a link to save and archive it…' : 'Jot a note or paste a link…')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <ProjectSelect className="capture-project" value={project} onChange={setProject} projects={projects} emptyLabel="Inbox" label="Save to" />
        {recording ? (
          <button className="button recording" onClick={() => dictation.current?.stop()}><Icon name="stop" size={15} /> Stop</button>
        ) : (
          <button className="button" disabled={busy} aria-label="Dictate a note" title="Dictate a note" onClick={dictate}><Icon name="mic" size={15} /></button>
        )}
        <button className="button primary" disabled={!detected || busy || recording} onClick={() => void submit()}>Save</button>
      </div>
      <div className="capture-hint">
        {recording ? (
          <span className="recording-status" role="status">
            <span className="recording-dot" aria-hidden="true" />
            {voice.status === 'starting' ? 'Starting dictation…' : voice.interim ? `${voice.interim}…` : 'Listening. Press Stop, then Save when it reads right.'}
          </span>
        ) : detected?.kind === 'link'
          ? 'Link · the page text is archived in the background so it outlives the site'
          : detected
            ? 'Note · Shift+Enter for a new line, Markdown welcome'
            : 'Enter saves · paste a URL to save a link'}
      </div>
      {failed && <p className="error-text small" role="alert">{failed.message}</p>}
      {(systemHelp || failed?.useSystem) && <p className="small">{systemDictationHelp(window.enve.platform, 'note')}</p>}
      {dictating && <p className="muted small">{NOTE_DICTATION_NOTE}</p>}
      {saved && <SavedChip key={saved.id} id={saved.id} existed={saved.existed} />}
    </section>
  );
}
