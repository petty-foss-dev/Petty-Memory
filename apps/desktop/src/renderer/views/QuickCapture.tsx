import { useEffect, useRef, useState } from 'react';
import { call, errorMessage, onCommand, useLive } from '../lib/api.ts';
import { detectCapture } from '../lib/capture.ts';
import {
  type Dictation, type DictationState, NOTE_DICTATION_NOTE, appendDictation, createDictation, speechRecognizer, systemDictationHelp,
} from '../lib/voice.ts';
import { Icon, ProjectSelect } from '../ui.tsx';
import { saveCapture } from './CaptureBar.tsx';

/** The small always-on-top window behind the global shortcut: type, paste or dictate, Enter, gone. */
export function QuickCapture() {
  const projects = useLive(() => call('projects.list'), []);
  const [text, setText] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState<DictationState>({ status: 'idle' });
  const [dictating, setDictating] = useState(false);
  const [systemHelp, setSystemHelp] = useState(false);
  const saving = useRef(false);
  const dictation = useRef<Dictation | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const detected = detectCapture(text);
  const recording = voice.status === 'starting' || voice.status === 'listening';
  const failed = voice.status === 'failed' ? voice : null;

  useEffect(() => {
    input.current?.focus();
    return onCommand((command) => {
      if (command === 'capture-focus') {
        setMessage(null);
        setSystemHelp(false);
        setVoice({ status: 'idle' });
        input.current?.focus();
      }
    });
  }, []);

  // Hiding or closing the window releases the microphone; the words already heard stay in the box.
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

  const close = () => {
    dictation.current?.cancel();
    setVoice((current) => (current.status === 'failed' ? current : { status: 'idle' }));
    void call('capture.close');
  };

  const dictate = () => {
    setDictating(true);
    setSystemHelp(false);
    setMessage(null);
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

  const submit = async () => {
    // The ref catches a second Enter that arrives before the disabled state renders.
    if (!detected || recording || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const result = await saveCapture(text, project);
      const where = project ? projects.data?.find((p) => p.id === project)?.name : 'Inbox';
      setMessage({ text: result?.existed ? 'Already saved' : `Saved to ${where}`, error: false });
      setText('');
      setTimeout(close, 700);
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const status = voice.status === 'listening'
    ? (voice.interim ? `${voice.interim}…` : 'Listening. Press Stop, then Save.')
    : voice.status === 'starting' ? 'Starting dictation…'
    : message?.text ?? failed?.message
      ?? (busy ? 'Saving…' : detected?.kind === 'link' ? 'Link · archived in the background' : 'Enter to save · Esc to close');
  const statusIsError = !recording && (message ? message.error : Boolean(failed));
  const note = systemHelp || failed?.useSystem ? systemDictationHelp(window.enve.platform, 'note') : dictating ? NOTE_DICTATION_NOTE : null;

  return (
    <div
      className="quick-capture"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <textarea
        ref={input}
        disabled={busy}
        aria-label="Quick capture"
        value={text}
        placeholder="Jot, dictate or paste a link…"
        onChange={(event) => {
          setText(event.target.value);
          setMessage(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="quick-capture-bar">
        <ProjectSelect value={project} onChange={setProject} projects={projects.data ?? []} emptyLabel="Inbox" label="Save to" />
        <span className={`muted small ${recording ? 'recording-status' : ''} ${statusIsError ? 'error-text' : ''}`} role="status">
          {recording && <span className="recording-dot" aria-hidden="true" />}
          {status}
        </span>
        {recording ? (
          <button className="button small recording" onClick={() => dictation.current?.stop()}><Icon name="stop" size={14} /> Stop</button>
        ) : (
          <button className="button small" disabled={busy} onClick={dictate}><Icon name="mic" size={14} /> Dictate</button>
        )}
        <button className="button primary small" disabled={!detected || busy || recording} onClick={() => void submit()}>Save</button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
