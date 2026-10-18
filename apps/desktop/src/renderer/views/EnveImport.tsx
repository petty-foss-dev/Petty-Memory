import type { ImportResult } from '@enve-memory/importers';
import { useRef, useState } from 'react';
import { type HighlightPreview, MAX_HIGHLIGHT_FILE_BYTES } from '../../shared/ipc.ts';
import { call, errorMessage } from '../lib/api.ts';
import { formatBytes, providedSourceLink } from '../lib/format.ts';
import { useApp } from '../context.ts';

const SHOWN = 100;
const EXTENSIONS = /\.(json|md|markdown)$/i;

/** Book highlights from an Enve export file: read here as text, previewed, then imported on request. */
export function EnveHighlightsImport({ project, disabled }: { project: string | null; disabled: boolean }) {
  const { projects } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<{ name: string; data: string; preview: HighlightPreview } | null>(null);
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; result: ImportResult } | null>(null);
  const destination = project ? projects.find((p) => p.id === project)?.name ?? 'the chosen project' : 'the Inbox';

  const read = async (file: File) => {
    setError(null);
    setResult(null);
    setLoaded(null);
    if (!EXTENSIONS.test(file.name)) {
      setError('Choose the .json or .md file that Enve exported.');
      return;
    }
    if (file.size > MAX_HIGHLIGHT_FILE_BYTES) {
      setError(`That file is ${formatBytes(file.size)}; exports can be at most ${formatBytes(MAX_HIGHLIGHT_FILE_BYTES)}. Export fewer books at a time.`);
      return;
    }
    setBusy('reading');
    try {
      const data = await file.text();
      setLoaded({ name: file.name, data, preview: await call('highlights.preview', data) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!loaded) return;
    setBusy('importing');
    setError(null);
    try {
      const imported = await call('highlights.import', loaded.data, project ? { project } : {});
      setResult({ name: loaded.name, result: imported });
      setLoaded(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const entries = loaded?.preview.entries ?? [];
  const books = new Set(entries.map((entry) => `${entry.bookTitle}\u0000${entry.author}`)).size;

  return (
    <div className="enve-import">
      <div className="setting-row">
        <div>
          <div className="setting-label">Enve book highlights</div>
          <div className="setting-detail">
            The highlights and notes file that Enve exports (.json or .md). Each passage keeps its book, location and a link back when Enve
            provides one. Passages already imported are skipped.
          </div>
        </div>
        <div className="setting-control">
          <input
            ref={input}
            type="file"
            accept=".json,.md,.markdown,application/json,text/markdown"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void read(file);
            }}
          />
          <button className="button small" disabled={disabled || busy !== null} onClick={() => input.current?.click()}>
            {busy === 'reading' ? 'Reading…' : 'Choose file…'}
          </button>
        </div>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {loaded && (
        <div className="highlight-preview" aria-label="Highlights to import">
          <p>
            <strong>{loaded.name}</strong> ({loaded.preview.format}): {entries.length} highlight{entries.length === 1 ? '' : 's'} from {books} book
            {books === 1 ? '' : 's'}{loaded.preview.skipped ? `, ${loaded.preview.skipped} entr${loaded.preview.skipped === 1 ? 'y' : 'ies'} that can’t be imported` : ''}.
            They go into {destination}.
          </p>
          {entries.length > 0 && (
            <ul className="highlight-list">
              {entries.slice(0, SHOWN).map((entry) => {
                const link = providedSourceLink(entry.sourceUrl);
                return (
                  <li key={entry.id}>
                    <blockquote>{entry.text}</blockquote>
                    {entry.note && <p className="small">{entry.note}</p>}
                    <p className="muted small">
                      {entry.bookTitle}{entry.author ? ` · ${entry.author}` : ''}{entry.location ? ` · ${entry.location}` : ''}
                      {link && <> · <button className="link-button" onClick={() => void call('app.openExternal', link).catch((err) => setError(errorMessage(err)))}>Open source</button></>}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {entries.length > SHOWN && <p className="muted small">And {entries.length - SHOWN} more.</p>}
          <div className="inline-actions">
            <button className="button primary small" disabled={busy !== null || entries.length === 0} onClick={() => void run()}>
              {busy === 'importing' ? 'Importing…' : `Import ${entries.length} highlight${entries.length === 1 ? '' : 's'}`}
            </button>
            <button className="button ghost small" disabled={busy !== null} onClick={() => setLoaded(null)}>Cancel</button>
          </div>
        </div>
      )}
      {result && (
        <div className="token-once" role="status">
          <p>
            <strong>{result.name}:</strong> imported {result.result.created}, skipped {result.result.skipped} already saved
            {result.result.failed.length ? `, ${result.result.failed.length} failed` : ''}.
          </p>
          {result.result.failed.length > 0 && (
            <ul className="history">
              {result.result.failed.slice(0, 20).map((f) => <li key={f.source}><code>{f.source}</code> <span className="error-text">{f.error}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
