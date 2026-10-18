import type { ItemDetail } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { createAudioRecorder } from '../../../../web/public/research-media.js';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { displayTitle, formatBytes, relativeTime } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { type KnowledgeRoute, useApp } from '../context.ts';
import { Empty, Icon, TypeIcon, useFeedback } from '../ui.tsx';
import { knowledgePath } from './KnowledgeCommon.tsx';
import { AudioWorkspace } from './ResearchAudio.tsx';
import { PdfReader } from './ResearchPdf.tsx';

type Recorder = ReturnType<typeof createAudioRecorder>;

const AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
};

const kindOf = (item: ItemDetail): 'pdf' | 'audio' | null => {
  const type = item.attachments[0]?.mimeType ?? '';
  return type === 'application/pdf' ? 'pdf' : type.startsWith('audio/') ? 'audio' : null;
};

/** Browsers report some audio (macOS M4A as audio/x-m4a, or nothing at all) differently from what the library accepts. */
const audioType = (file: File) => AUDIO_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? file.type;

/** PDFs and recordings to read closely: page-accurate quotes and OCR, timed transcripts and passages. */
export function Research({ route }: { route: KnowledgeRoute }) {
  const { go } = useApp();
  const { toast } = useFeedback();
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState<'pdf' | 'audio' | null>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const sources = useLive(async () => {
    const items: ItemDetail[] = [];
    let before: string | null = null;
    for (let page = 0; page < pages; page++) {
      const result: { items: ItemDetail[]; next: string | null } = await knowledgeRequest(knowledgePath('/research/sources', { before }));
      items.push(...result.items);
      if (!result.next) return { items, more: false };
      before = result.next;
    }
    return { items, more: true };
  }, [pages]);
  const selected = useLive(() => (route.sourceId ? call('items.get', route.sourceId) : Promise.resolve(null)), [route.sourceId]);
  const open = (id: string) => go({ view: 'knowledge', section: 'research', sourceId: id });

  const importPdf = async (files: File[]) => {
    const paths = files.filter((file) => /\.pdf$/i.test(file.name)).map((file) => window.enve.pathForFile(file)).filter(Boolean);
    if (!paths.length) {
      if (files.length) toast('Choose PDF files. Other documents can be saved from Home or by dropping them on the window.', 'error');
      return;
    }
    setBusy('pdf');
    try {
      const saved = await call('files.save', paths);
      toast(saved.length === 1 ? 'PDF saved. Its page text is read in the background.' : `Saved ${saved.length} PDFs`);
      if (saved[0]) open(saved[0].id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const importAudio = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > AUDIO_BYTES) {
      toast('Choose a recording up to 25 MB. Split longer recordings, or export them at a lower bitrate.', 'error');
      return;
    }
    setBusy('audio');
    try {
      const saved = await call('research.saveAudio', new Uint8Array(await file.arrayBuffer()), file.name, audioType(file));
      toast('Recording saved');
      open(saved.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const item = selected.data;
  const kind = item ? kindOf(item) : null;

  return (
    <section className="knowledge-section" aria-labelledby="research-heading">
      <div className="panel-header">
        <h2 id="research-heading">Research</h2>
        <div className="inline-actions">
          <input ref={pdfInput} type="file" hidden multiple accept="application/pdf,.pdf" onChange={(event) => {
            void importPdf([...(event.target.files ?? [])]);
            event.target.value = '';
          }} />
          <input ref={audioInput} type="file" hidden accept="audio/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.webm" onChange={(event) => {
            void importAudio(event.target.files?.[0]);
            event.target.value = '';
          }} />
          <button className="button small" disabled={busy !== null} onClick={() => pdfInput.current?.click()}><Icon name="file" size={14} /> {busy === 'pdf' ? 'Saving…' : 'Import PDF…'}</button>
          <button className="button small" disabled={busy !== null} onClick={() => audioInput.current?.click()}><Icon name="mic" size={14} /> {busy === 'audio' ? 'Saving…' : 'Import audio…'}</button>
        </div>
      </div>
      <p className="note">
        Read PDFs page by page and save exact quotes with your notes. Bring in meeting or lecture recordings, add their timed transcript, and
        jump to any moment. Originals are never changed; quotes, passages and reviewed OCR are ordinary notes linked to their source.
      </p>
      <RecordPanel onSaved={open} />

      <div className="research-layout">
        <nav className="research-sources" aria-label="Research sources">
          {sources.error && <p className="error-text small" role="alert">{sources.error.message}</p>}
          {!sources.data && !sources.error && <p className="muted small" role="status">Loading sources…</p>}
          {sources.data?.items.length === 0 && <p className="muted small">No PDFs or recordings yet. Import one to start.</p>}
          <ul className="mini-list">
            {(sources.data?.items ?? []).map((source) => (
              <li key={source.id}>
                <button aria-current={source.id === route.sourceId ? 'true' : undefined} className={source.id === route.sourceId ? 'active' : ''} onClick={() => open(source.id)}>
                  <span><Icon name={kindOf(source) === 'audio' ? 'mic' : 'file'} size={14} /> {displayTitle(source)}</span>
                  <span className="muted small">{relativeTime(source.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {sources.data?.more && <button className="button small ghost" onClick={() => setPages(pages + 1)}>Show older</button>}
        </nav>

        <div className="research-workspace">
          {!route.sourceId && <Empty title="Choose a PDF or recording">Pick one from the list, or import a new one.</Empty>}
          {selected.error && <p className="error-text" role="alert">{selected.error.message}</p>}
          {item && (
            <>
              <div className="panel-header">
                <h3 className="research-title"><TypeIcon type={item.type} size={16} /> {displayTitle(item)}</h3>
                <span className="muted small">{item.attachments[0]?.filename}{item.attachments[0] ? ` · ${formatBytes(item.attachments[0].size)}` : ''}</span>
              </div>
              {item.archivedAt && <p className="warning small">This item is archived. Unarchive it to quote or transcribe it.</p>}
              {kind === 'pdf' && <PdfReader key={item.id} item={item} initialPage={route.page} quote={route.quote} />}
              {kind === 'audio' && <AudioWorkspace key={item.id} item={item} transcriptId={route.transcriptId} start={route.start} />}
              {!kind && <p className="muted">This item isn’t a PDF or an audio recording.</p>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Records from the microphone into a draft that is saved only when the person asks; leaving the page stops and discards it. */
function RecordPanel({ onSaved }: { onSaved: (id: string) => void }) {
  const { toast, confirm } = useFeedback();
  const recorder = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<{ blob: Blob; url: string } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    recorder.current = createAudioRecorder({
      onComplete: (blob) => {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
        setName(`Recording ${stamp}`);
        setDraft({ blob, url: URL.createObjectURL(blob) });
      },
      onError: setError,
      onState: setRecording,
    });
    return () => recorder.current?.dispose();
  }, []);

  useEffect(() => () => {
    if (draft) URL.revokeObjectURL(draft.url);
  }, [draft]);

  const start = async () => {
    if (draft && !(await confirm({
      title: 'Replace the unsaved recording?',
      body: <p>The recording you haven’t saved will be discarded.</p>,
      confirmLabel: 'Record again',
    }))) return;
    setDraft(null);
    setError(null);
    await recorder.current?.start();
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const type = draft.blob.type.split(';')[0] || 'audio/webm';
      const extension = type === 'audio/mp4' ? 'm4a' : type.split('/')[1] ?? 'webm';
      const saved = await call('research.saveAudio', new Uint8Array(await draft.blob.arrayBuffer()), `${name.trim() || 'Recording'}.${extension}`, type);
      setDraft(null);
      toast('Recording saved');
      onSaved(saved.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="research-record">
      <div className="inline-actions">
        {recording ? (
          <button className="button recording" onClick={() => recorder.current?.stop()}><Icon name="stop" size={15} /> Stop recording</button>
        ) : (
          <button className="button" disabled={saving} onClick={() => void start()}><Icon name="mic" size={15} /> Record</button>
        )}
        {recording && (
          <span className="recording-status" role="status">
            <span className="recording-dot" aria-hidden="true" /> Recording. Press Stop when you’re done; nothing is saved until you choose Save.
          </span>
        )}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {draft && (
        <form className="ocr-draft" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <audio controls src={draft.url} aria-label="Play the unsaved recording" />
          <span className="muted small">Unsaved recording · {formatBytes(draft.blob.size)}</span>
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="inline-actions">
            <button type="submit" className="button small primary" disabled={saving}>{saving ? 'Saving…' : 'Save recording'}</button>
            <button type="button" className="button small ghost" disabled={saving} onClick={() => setDraft(null)}>Discard</button>
          </div>
        </form>
      )}
    </div>
  );
}
