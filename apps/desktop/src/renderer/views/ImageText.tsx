import type { Attachment, ItemDetail } from '@enve-memory/core';
import { useState } from 'react';
import { call, errorMessage } from '../lib/api.ts';
import { displayTitle } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Icon, useFeedback } from '../ui.tsx';

const isImage = (attachment: Attachment) => attachment.mimeType.startsWith('image/');

type Extraction =
  | { status: 'reading'; attachmentId: string }
  | { status: 'draft'; attachmentId: string; engine: string; title: string; text: string }
  | { status: 'failed'; attachmentId: string; message: string }
  | { status: 'saved'; attachmentId: string; noteId: string };

/** Reads text out of an image on request, then saves it as a note only after review. The image stays as it is. */
export function ImageTextSection({ item }: { item: ItemDetail }) {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [saving, setSaving] = useState(false);
  const images = item.attachments.filter(isImage);
  const label = displayTitle(item).replace(/[\]\n\r]+/g, ' ');

  const extract = (attachment: Attachment) => {
    setExtraction({ status: 'reading', attachmentId: attachment.id });
    call('ocr.extract', attachment.id).then(
      ({ text, engine }) => setExtraction({ status: 'draft', attachmentId: attachment.id, engine, title: `Text from ${label}`, text: text.trim() }),
      (err: unknown) => setExtraction({ status: 'failed', attachmentId: attachment.id, message: errorMessage(err) }),
    );
  };

  const save = async () => {
    if (saving || extraction?.status !== 'draft' || !extraction.text.trim()) return;
    setSaving(true);
    try {
      const note = await call('items.saveNote', {
        title: extraction.title.trim() || undefined,
        body: `${extraction.text.trim()}\n\nFrom [[item:${item.id}|${label}]]`,
        project: item.project?.id,
      });
      setExtraction({ status: 'saved', attachmentId: extraction.attachmentId, noteId: note.id });
      toast('Saved as a note');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="detail-section image-text" aria-labelledby={`image-text-${item.id}`}>
      <h2 id={`image-text-${item.id}`}>Text in {images.length === 1 ? 'the image' : 'images'}</h2>
      {images.map((attachment) => {
        const mine = extraction?.attachmentId === attachment.id ? extraction : null;
        return (
          <div key={attachment.id} className="image-text-entry">
            <div className="inline-actions">
              <span className="small">{attachment.filename}</span>
              {mine?.status !== 'draft' && (
                <button className="button small" disabled={extraction?.status === 'reading' || saving} onClick={() => extract(attachment)}>
                  <Icon name="text" size={14} /> {mine?.status === 'reading' ? 'Reading…' : mine ? 'Extract again' : 'Extract text'}
                </button>
              )}
            </div>
            {mine?.status === 'reading' && <p className="muted small" role="status">Reading text from {attachment.filename}…</p>}
            {mine?.status === 'failed' && <p className="error-text small" role="alert">{mine.message}</p>}
            {mine?.status === 'saved' && (
              <p className="small" role="status">
                Saved as a note. The image is unchanged. <button className="link-button" onClick={() => openItem(mine.noteId)}>Open the note</button>
              </p>
            )}
            {mine?.status === 'draft' && (
              mine.text ? (
                <form
                  className="ocr-draft"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <p className="muted small">Read with {mine.engine}. Correct anything it misread before saving.</p>
                  <label className="field">
                    <span>Note title</span>
                    <input disabled={saving} value={mine.title} onChange={(event) => setExtraction({ ...mine, title: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Text</span>
                    <textarea aria-label="Text" disabled={saving} rows={8} value={mine.text} onChange={(event) => setExtraction({ ...mine, text: event.target.value })} />
                  </label>
                  <div className="inline-actions">
                    <button type="submit" className="button primary small" disabled={saving || !mine.text.trim()}>{saving ? 'Saving…' : 'Save as note'}</button>
                    <button type="button" className="button ghost small" disabled={saving} onClick={() => setExtraction(null)}>Discard</button>
                  </div>
                </form>
              ) : (
                <div className="inline-actions">
                  <p className="muted small">No text was found in {attachment.filename}.</p>
                  <button className="button ghost small" onClick={() => setExtraction(null)}>Dismiss</button>
                </div>
              )
            )}
          </div>
        );
      })}
    </section>
  );
}
