import type { ItemDetail, PassageView, TranscriptPreview, TranscriptSummary, TranscriptView } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import type { ActionProposal } from '../../shared/ipc.ts';
import type { TranscriptionStatus } from '../../shared/knowledge.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { formatBytes, formatDate } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Icon, useFeedback } from '../ui.tsx';
import { ActionsDialog } from './Actions.tsx';
import { LiveStatus, plural, timestamp, useKnowledge } from './KnowledgeCommon.tsx';

type Preview = TranscriptPreview & { skipped: number };
type CaptionFormat = '' | 'vtt' | 'srt' | 'json';

const CAPTION_BYTES = 5 * 1024 * 1024;
const TITLE_MAX = 200;
const NOTE_MAX = 20_000;
const PASSAGE_MAX = 50;
const PREVIEW_SEGMENTS = 50;
const FOLLOW_UP = 'Suggest tasks for the follow-ups mentioned, with due dates only where one is said, and write a short brief of what was discussed.';

const FORMAT_LABELS: Record<TranscriptPreview['format'], string> = { vtt: 'WebVTT', srt: 'SubRip', json: 'Timed JSON', transcription: 'Transcription' };

/** A saved recording with its transcripts: play, seek from any cue, save passages, and propose follow-ups. */
export function AudioWorkspace({ item, transcriptId, start }: { item: ItemDetail; transcriptId?: string; start?: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [selected, setSelected] = useState<string | null>(transcriptId ?? null);
  const pendingSeek = useRef<number | undefined>(start);
  const list = useKnowledge<{ transcripts: TranscriptSummary[] }>(`/research/audio/${encodeURIComponent(item.id)}`);
  const transcripts = list.data?.transcripts ?? [];

  useEffect(() => {
    let objectUrl: string | null = null;
    let gone = false;
    call('research.file', item.id).then((file) => {
      if (gone) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mimeType }));
      setUrl(objectUrl);
    }, (error: unknown) => !gone && setFileError(errorMessage(error)));
    return () => {
      gone = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.id]);

  useEffect(() => {
    pendingSeek.current = start;
    if (start !== undefined && audio.current && audio.current.readyState > 0) {
      audio.current.currentTime = start;
      pendingSeek.current = undefined;
    }
  }, [start]);

  useEffect(() => {
    if (transcriptId) setSelected(transcriptId);
  }, [transcriptId]);

  // A link to a moment in the recording opens its newest transcript, so the passage is visible.
  useEffect(() => {
    if (!selected && start !== undefined && transcripts.length) setSelected(transcripts.at(-1)!.id);
  }, [transcripts.length, start]);

  const seek = (seconds: number) => {
    if (!audio.current) return;
    audio.current.currentTime = seconds;
    void audio.current.play().catch(() => {});
  };

  return (
    <div className="research-audio">
      {fileError && <p className="error-text" role="alert">The recording can’t be played here: {fileError}</p>}
      {url && (
        <audio
          ref={audio}
          controls
          preload="metadata"
          src={url}
          aria-label={`Play ${item.title || item.attachments[0]?.filename || 'recording'}`}
          onLoadedMetadata={(event) => {
            if (pendingSeek.current !== undefined) event.currentTarget.currentTime = pendingSeek.current;
            pendingSeek.current = undefined;
          }}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        />
      )}
      {!url && !fileError && <p className="muted small" role="status">Loading the recording…</p>}

      <section className="detail-section">
        <h2>Transcripts</h2>
        <LiveStatus live={list} />
        {list.data && transcripts.length === 0 && <p className="muted small">No transcript yet. Import captions or transcribe the recording below.</p>}
        {transcripts.length > 0 && (
          <div className="chips" role="group" aria-label="Saved transcripts">
            {transcripts.map((transcript) => (
              <button key={transcript.id} className={`chip ${transcript.id === selected ? 'active' : ''}`} aria-pressed={transcript.id === selected} onClick={() => setSelected(transcript.id)}>
                {transcript.title} <span className="muted small">· {plural(transcript.segmentCount, 'cue')} · {timestamp(transcript.duration)}</span>
              </button>
            ))}
          </div>
        )}
        {selected && <TranscriptPanel key={selected} id={selected} time={time} focus={start} onSeek={seek} />}
      </section>

      <section className="detail-section">
        <h2>Add a transcript</h2>
        <TranscriptImport audio={item} onSaved={setSelected} />
      </section>
    </div>
  );
}

function TranscriptPanel({ id, time, focus, onSeek }: { id: string; time: number; focus?: number; onSeek: (seconds: number) => void }) {
  const { openItem, info, go } = useApp();
  const { toast } = useFeedback();
  const transcript = useKnowledge<TranscriptView>(`/research/transcripts/${encodeURIComponent(id)}`);
  const passages = useKnowledge<PassageView[]>(`/research/transcripts/${encodeURIComponent(id)}/passages`);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState(FOLLOW_UP);
  const [thinking, setThinking] = useState(false);
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const focused = useRef<HTMLLIElement>(null);
  const view = transcript.data;
  const playable = view?.audioStatus === 'ok';
  const segments = view?.segments ?? [];
  const playing = segments.findLastIndex((segment) => segment.start <= time && time < Math.max(segment.end, segment.start + 0.5));
  const focusIndex = focus === undefined ? -1 : segments.findLastIndex((segment) => segment.start <= focus);

  useEffect(() => {
    if (focusIndex >= 0) focused.current?.scrollIntoView({ block: 'center' });
  }, [focusIndex, view?.id]);

  const toggle = (index: number) => {
    if (!range) setRange({ from: index, to: index });
    else if (index < range.from) setRange({ from: index, to: range.to });
    else if (index > range.to) setRange({ from: range.from, to: index });
    else if (range.from === range.to) setRange(null);
    else setRange(index === range.from ? { from: index + 1, to: range.to } : { from: range.from, to: index - 1 });
  };
  const tooLong = range !== null && range.to - range.from + 1 > PASSAGE_MAX;

  const savePassage = async () => {
    if (!view || !range) return;
    setSaving(true);
    try {
      const { item, created } = await knowledgeRequest<{ item: ItemDetail; created: boolean }>('/research/passages', 'POST', {
        transcriptId: view.id, fingerprint: view.fingerprint, from: range.from, to: range.to, ...(note.trim() ? { note: note.trim() } : {}),
      });
      setRange(null);
      setNote('');
      toast(created ? 'Passage saved as a note' : 'That passage and note were already saved');
      if (!created) openItem(item.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const propose = async () => {
    if (!view) return;
    setThinking(true);
    try {
      const reply = await call('ai.chat', { mode: 'actions', rootId: view.id, messages: [{ role: 'user', content: instruction.trim() }] });
      if (reply.kind !== 'actions') throw new Error('The AI didn’t return suggested actions. Try again.');
      setAsking(false);
      setProposal(reply.proposal);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setThinking(false);
    }
  };

  if (!view) return <LiveStatus live={transcript} label="Loading the transcript…" />;
  return (
    <div className="research-transcript">
      <div className="panel-header">
        <span className="muted small">
          {FORMAT_LABELS[view.format]}{view.engine ? ` · ${view.engine}` : ''} · {timestamp(view.duration)} · saved {formatDate(view.createdAt)}
        </span>
        <div className="inline-actions">
          <button className="button small ghost" onClick={() => openItem(view.id)}>Open note</button>
          {info?.aiEnabled ? (
            <button className="button small" onClick={() => setAsking(!asking)} aria-expanded={asking}><Icon name="sparkle" size={14} /> Suggest tasks or a brief…</button>
          ) : (
            <button className="button small ghost" onClick={() => go({ view: 'settings', section: 'ai' })}>Set up AI for follow-ups</button>
          )}
        </div>
      </div>
      {view.audioStatus !== 'ok' && (
        <p className="warning small" role="alert">
          {view.audioStatus === 'missing' ? 'The recording behind this transcript is missing or archived.' : 'The recording was replaced after this transcript was made.'} Cues can’t play, and new passages can’t point into it.
        </p>
      )}
      {asking && (
        <form className="ocr-draft" onSubmit={(event) => { event.preventDefault(); void propose(); }}>
          <label className="field">
            <span>What should come out of this transcript?</span>
            <textarea rows={3} maxLength={4000} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <p className="muted small">The transcript is sent to your AI provider. You review each suggestion before anything is added, and can undo it.</p>
          <div className="inline-actions">
            <button type="submit" className="button small primary" disabled={thinking || !instruction.trim()}>{thinking ? 'Thinking…' : 'Suggest actions'}</button>
            <button type="button" className="button small ghost" disabled={thinking} onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </form>
      )}
      <p className="muted small">Select cues with their checkboxes to save a passage. Click a time to play from there.</p>
      <ol className="transcript-cues" aria-label="Transcript">
        {segments.map((segment, index) => {
          const chosen = range !== null && index >= range.from && index <= range.to;
          return (
            <li key={index} ref={index === focusIndex ? focused : undefined} className={`${index === playing ? 'playing' : ''} ${index === focusIndex ? 'focused' : ''} ${chosen ? 'chosen' : ''}`}>
              <input type="checkbox" aria-label={`Include cue at ${timestamp(segment.start)} in a passage`} checked={chosen} onChange={() => toggle(index)} />
              <button className="link-button cue-time" disabled={!playable} onClick={() => onSeek(segment.start)} aria-label={`Play from ${timestamp(segment.start)}`}>{timestamp(segment.start)}</button>
              <span>{segment.speaker && <strong>{segment.speaker}: </strong>}{segment.text}</span>
            </li>
          );
        })}
      </ol>
      {range && (
        <form className="ocr-draft research-selection-form" onSubmit={(event) => { event.preventDefault(); void savePassage(); }}>
          <p className="small">
            Passage {timestamp(segments[range.from]!.start)}–{timestamp(Math.max(...segments.slice(range.from, range.to + 1).map((s) => s.end)))}, {plural(range.to - range.from + 1, 'cue')}.
            {tooLong && <span className="error-text"> Choose at most {PASSAGE_MAX} cues.</span>}
          </p>
          <label className="field">
            <span>Your note (optional)</span>
            <textarea rows={2} maxLength={NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="inline-actions">
            <button type="submit" className="button small primary" disabled={saving || tooLong || !playable}>{saving ? 'Saving…' : 'Save passage'}</button>
            <button type="button" className="button small ghost" disabled={saving} onClick={() => { setRange(null); setNote(''); }}>Clear selection</button>
          </div>
        </form>
      )}
      <h3>Saved passages</h3>
      <LiveStatus live={passages} />
      {passages.data?.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="insight-list">
        {(passages.data ?? []).map((passage) => (
          <li key={passage.id}>
            <div className="insight-main">
              <blockquote className="research-quote">{passage.quote}</blockquote>
              <span className="muted small">{timestamp(passage.start)}–{timestamp(passage.end)}</span>
            </div>
            <div className="inline-actions">
              <button className="button small" disabled={!playable} onClick={() => onSeek(passage.start)}>Play {timestamp(passage.start)}</button>
              <button className="button small ghost" onClick={() => openItem(passage.id)}>Open note</button>
            </div>
          </li>
        ))}
      </ul>
      {proposal && <ActionsDialog proposal={proposal} onApplied={() => {}} onUndone={() => setProposal(null)} onClose={() => setProposal(null)} />}
    </div>
  );
}

/** Captions imported from a file or pasted, or a transcription the person asked for; either way previewed before anything is saved. */
function TranscriptImport({ audio, onSaved }: { audio: ItemDetail; onSaved: (transcriptId: string) => void }) {
  const { openItem } = useApp();
  const { toast, confirm } = useFeedback();
  const status = useLive(() => call('research.transcriptionStatus'), []);
  const [raw, setRaw] = useState('');
  const [format, setFormat] = useState<CaptionFormat>('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<'preview' | 'transcribe' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const size = audio.attachments[0]?.size;

  const edit = (text: string) => {
    setRaw(text);
    setPreview(null);
  };

  const readFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.size > CAPTION_BYTES) {
      setError('Choose a caption file smaller than 5 MB.');
      return;
    }
    setError(null);
    const extension = chosen.name.split('.').pop()?.toLowerCase();
    if (extension === 'vtt' || extension === 'srt' || extension === 'json') setFormat(extension);
    edit(await chosen.text());
  };

  const run = async (kind: 'preview' | 'transcribe', request: () => Promise<Preview>) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await request();
      setPreview(next);
      setTitle('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const previewCaptions = () => run('preview', () => knowledgeRequest<Preview>('/research/transcripts/preview', 'POST', { audioId: audio.id, data: raw, ...(format ? { format } : {}) }));

  const transcribe = async () => {
    const config = status.data;
    if (!config?.configured) return;
    if (!(await confirm({
      title: 'Send this recording for transcription?',
      body: (
        <p>
          “{audio.title || audio.attachments[0]?.filename}”{size ? ` (${formatBytes(size)})` : ''} will be sent to <strong>{config.baseUrl}</strong> using the model <strong>{config.model}</strong>.
          The result comes back as a preview; nothing is saved until you review it.
        </p>
      ),
      confirmLabel: 'Send recording',
    }))) return;
    await run('transcribe', () => knowledgeRequest<Preview>('/research/transcribe', 'POST', { audioId: audio.id, confirmed: true }));
  };

  const save = async () => {
    if (!preview) return;
    setBusy('save');
    setError(null);
    try {
      const { item, created } = await knowledgeRequest<{ item: ItemDetail; created: boolean }>('/research/transcripts', 'POST', {
        audioId: preview.audio.itemId, segments: preview.segments, format: preview.format, fingerprint: preview.fingerprint,
        ...(preview.engine ? { engine: preview.engine } : {}), ...(title.trim() ? { title: title.trim() } : {}),
      });
      setPreview(null);
      setRaw('');
      setTitle('');
      toast(created ? 'Transcript saved' : 'This transcript was already saved');
      onSaved(item.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="research-import">
      <p className="note">
        Import timed captions (WebVTT, SubRip or timed JSON) from the tool that recorded the meeting or lecture, or paste them below.
      </p>
      <div className="inline-actions">
        <input ref={file} type="file" hidden accept=".vtt,.srt,.json,text/vtt,application/x-subrip,application/json" onChange={(event) => {
          void readFile(event.target.files?.[0]);
          event.target.value = '';
        }} />
        <button className="button small" disabled={busy !== null} onClick={() => file.current?.click()}><Icon name="file" size={14} /> Choose caption file…</button>
        <label className="field inline">
          <span className="sr-only">Caption format</span>
          <select aria-label="Caption format" value={format} disabled={busy !== null} onChange={(event) => { setFormat(event.target.value as CaptionFormat); setPreview(null); }}>
            <option value="">Detect format</option>
            <option value="vtt">WebVTT (.vtt)</option>
            <option value="srt">SubRip (.srt)</option>
            <option value="json">Timed JSON</option>
          </select>
        </label>
      </div>
      <textarea
        className="caption-input"
        aria-label="Caption text"
        rows={6}
        value={raw}
        disabled={busy !== null}
        placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome, everyone.'}
        onChange={(event) => edit(event.target.value)}
      />
      <div className="inline-actions">
        <button className="button small" disabled={!raw.trim() || busy !== null} onClick={() => void previewCaptions()}>{busy === 'preview' ? 'Checking…' : 'Preview transcript'}</button>
      </div>

      <div className="research-transcription">
        <h3>Transcribe the recording</h3>
        <p className="muted small">
          Uses a speech-to-text server you choose: one you run on this computer or your network (any OpenAI-compatible
          <code> /audio/transcriptions</code> endpoint, such as a whisper.cpp server) or a provider’s. No speech model is downloaded, your text AI
          isn’t used for audio, and each recording is sent only after you confirm.
        </p>
        {status.error && <p className="error-text" role="alert">{status.error.message}</p>}
        {status.data?.configured ? (
          <div className="inline-actions">
            <button className="button small" disabled={busy !== null} onClick={() => void transcribe()}><Icon name="mic" size={14} /> {busy === 'transcribe' ? 'Transcribing… this can take a few minutes' : `Transcribe with ${status.data.model}…`}</button>
            <button className="button small ghost" onClick={() => setConfiguring(!configuring)} aria-expanded={configuring}>Server settings</button>
          </div>
        ) : status.data && (
          <button className="button small" onClick={() => setConfiguring(!configuring)} aria-expanded={configuring}>Set up a transcription server…</button>
        )}
        {configuring && status.data && <TranscriptionSettings status={status.data} onSaved={() => { status.reload(); setConfiguring(false); }} />}
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}
      {preview && (
        <div className="highlight-preview" aria-label="Transcript preview">
          <p>
            <strong>{FORMAT_LABELS[preview.format]}</strong>{preview.engine ? ` from ${preview.engine}` : ''}: {plural(preview.segmentCount, 'cue')}, {timestamp(preview.duration)} long,
            {' '}{preview.characters.toLocaleString()} characters.
            {preview.overlaps > 0 && ` ${plural(preview.overlaps, 'cue')} slightly overlap the one before.`}
            {preview.skipped > 0 && ` ${plural(preview.skipped, 'empty cue')} left out.`}
          </p>
          {preview.existingId && (
            <p className="small">This recording already has this exact transcript. <button className="link-button" onClick={() => openItem(preview.existingId!)}>Open it</button></p>
          )}
          <ol className="transcript-cues preview">
            {preview.segments.slice(0, PREVIEW_SEGMENTS).map((segment, index) => (
              <li key={index}><span className="cue-time muted">{timestamp(segment.start)}</span><span>{segment.speaker && <strong>{segment.speaker}: </strong>}{segment.text}</span></li>
            ))}
          </ol>
          {preview.segmentCount > PREVIEW_SEGMENTS && <p className="muted small">And {plural(preview.segmentCount - PREVIEW_SEGMENTS, 'more cue')}.</p>}
          <label className="field">
            <span>Title (optional)</span>
            <input maxLength={TITLE_MAX} value={title} placeholder={`${audio.title || audio.attachments[0]?.filename || 'Recording'} transcript`} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="inline-actions">
            <button className="button small primary" disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save transcript'}</button>
            <button className="button small ghost" disabled={busy !== null} onClick={() => setPreview(null)}>Discard preview</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Local, per-computer settings; the key is kept in the system’s encrypted store, never in the library. */
function TranscriptionSettings({ status, onSaved }: { status: TranscriptionStatus; onSaved: () => void }) {
  const { toast } = useFeedback();
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [model, setModel] = useState(status.model);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const incomplete = Boolean(baseUrl.trim()) !== Boolean(model.trim());

  const save = async (off = false) => {
    setBusy(true);
    setError(null);
    try {
      const input = off ? { baseUrl: '', model: '' } : { baseUrl: baseUrl.trim(), model: model.trim() };
      await call('research.configureTranscription', clearKey ? { ...input, apiKey: '' } : key.trim() ? { ...input, apiKey: key.trim() } : input);
      toast(off ? 'Transcription turned off' : 'Transcription settings saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="ocr-draft" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="field">
        <span>Server address</span>
        <input type="url" value={baseUrl} placeholder="http://127.0.0.1:8080/v1" onChange={(event) => setBaseUrl(event.target.value)} />
      </label>
      <label className="field">
        <span>Model</span>
        <input value={model} maxLength={200} placeholder="whisper-1" onChange={(event) => setModel(event.target.value)} />
      </label>
      <label className="field">
        <span>API key (only if the server needs one)</span>
        <input
          type="password"
          autoComplete="off"
          value={key}
          disabled={!status.encryptionAvailable || clearKey}
          placeholder={status.hasKey ? 'A key is saved; leave empty to keep it' : 'No key'}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      {!status.encryptionAvailable && <p className="warning small">This computer can’t encrypt saved keys, so none can be stored. Use a server that doesn’t need one.</p>}
      {status.hasKey && <label className="check small"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} /> Remove the saved key</label>}
      <p className="muted small">Leave the address and model empty to turn transcription off. These settings stay on this computer.</p>
      {incomplete && <p className="error-text small">Fill in both the address and the model, or leave both empty.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="inline-actions">
        <button type="submit" className="button small primary" disabled={busy || incomplete}>{busy ? 'Saving…' : 'Save settings'}</button>
        {status.configured && <button type="button" className="button small ghost" disabled={busy} onClick={() => void save(true)}>Turn off</button>}
      </div>
    </form>
  );
}
