import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { type AttachmentRow, blobPath, toAttachment, writeBlob } from './blobs.ts';
import { type Context, newId, required } from './context.ts';
import { invalid, notFound } from './errors.ts';
import type { ItemService } from './items.ts';
import { isPlainText, mimeFor } from './mime.ts';
import type { Attachment, ItemDetail, ItemMetadata } from './types.ts';

export interface SaveFileInput {
  data: Uint8Array;
  filename: string;
  mimeType?: string;
  title?: string;
  note?: string;
  project?: string;
  tags?: string[];
  /** For importers restoring an export. */
  id?: string;
  createdAt?: string;
}

// Extracted text beyond this is left to the file itself; the index stays small.
const MAX_INLINE_TEXT = 2 * 1024 * 1024;

/** Types an extractor in @enve-memory/ingestion turns into searchable text. */
export const EXTRACTABLE_TYPES = new Set(['application/pdf', 'text/html']);

export class FileService {
  private readonly ctx: Context;
  private readonly items: ItemService;

  constructor(ctx: Context, items: ItemService) {
    this.ctx = ctx;
    this.items = items;
  }

  /** Saving bytes already in the library returns the existing item, with any new note and tags merged in. */
  save(input: SaveFileInput): { item: ItemDetail; created: boolean } {
    const filename = basename(required(input.filename, 'Filename').replaceAll('\\', '/'));
    if (!filename || filename === '.' || filename === '..' || filename.includes('\0')) throw invalid('Choose a real filename.');
    if (input.data.byteLength === 0) throw invalid(`"${filename}" is empty.`);
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const mimeType = input.mimeType?.split(';')[0]?.trim().toLowerCase() || mimeFor(filename);

    const existing = this.ctx.get<{ item_id: string }>(
      `SELECT a.item_id FROM attachments a JOIN items i ON i.id = a.item_id WHERE a.sha256 = ? AND i.archived_at IS NULL
       AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0 ORDER BY i.seq LIMIT 1`,
      sha256,
    );
    if (existing) {
      this.ctx.tx(() => {
        const note = input.note?.trim();
        const row = this.items.row(existing.item_id);
        if (note && !row.body.includes(note)) {
          this.items.write(row, { body: row.body ? `${row.body}\n\n${note}` : note }, 'update');
        }
        if (input.tags?.length) this.items.tag(row.id, { add: input.tags });
      });
      return { item: this.items.get(existing.item_id), created: false };
    }

    writeBlob(this.ctx, sha256, input.data);
    const text = isPlainText(mimeType) ? Buffer.from(input.data).toString('utf8').slice(0, MAX_INLINE_TEXT) : '';
    const metadata: ItemMetadata = EXTRACTABLE_TYPES.has(mimeType) ? { ingest: { status: 'pending' } } : {};
    const id = this.ctx.tx(() => {
      const id = this.items.insert({
        type: mimeType.startsWith('image/') ? 'image' : 'file',
        title: input.title?.trim() || filename,
        body: input.note,
        content: text,
        metadata,
        project: input.project,
        tags: input.tags,
        id: input.id,
        createdAt: input.createdAt,
      });
      const attachment = { id: newId(), sha256, filename, mimeType, size: input.data.byteLength, createdAt: this.ctx.now() };
      this.ctx.run(
        `INSERT INTO attachments (id, item_id, sha256, filename, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        attachment.id, id, sha256, filename, mimeType, attachment.size, attachment.createdAt,
      );
      this.ctx.record('item', id, 'attach', this.items.row(id).project_id, attachment);
      return id;
    });
    return { item: this.items.get(id), created: true };
  }

  saveFromPath(path: string, input: Omit<SaveFileInput, 'data' | 'filename'> & { filename?: string } = {}) {
    return this.save({ ...input, data: readFileSync(path), filename: input.filename ?? basename(path) });
  }

  /** The item's primary file and where its bytes live on disk. */
  primary(itemId: string): { attachment: Attachment; path: string } {
    const row = this.ctx.get<AttachmentRow>(`SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at LIMIT 1`, this.items.row(itemId).id);
    if (!row) throw notFound(`Item "${itemId}" has no file.`);
    return { attachment: toAttachment(row), path: blobPath(this.ctx, row.sha256) };
  }

  read(itemId: string): { attachment: Attachment; data: Buffer } {
    const { attachment, path } = this.primary(itemId);
    if (!existsSync(path)) throw notFound(`The contents of ${attachment.filename} haven't arrived on this device yet.`);
    return { attachment, data: readFileSync(path) };
  }

  readAttachment(id: string, { maxBytes }: { maxBytes?: number } = {}): { itemId: string; attachment: Attachment; data: Buffer } {
    if (typeof id !== 'string' || !id) throw invalid('Choose an image attachment.');
    const attachment = this.ctx.get<AttachmentRow>(`SELECT * FROM attachments WHERE id = ?`, id);
    if (!attachment) throw notFound('That attachment is not in this library.');
    const item = this.items.row(attachment.item_id);
    if (item.archived_at !== null || (JSON.parse(item.metadata) as ItemMetadata).secret) throw invalid('Choose an attachment on an active ordinary item.');
    const path = blobPath(this.ctx, attachment.sha256);
    if (!existsSync(path)) throw notFound('That attachment has not arrived on this device yet.');
    if (maxBytes !== undefined && statSync(path).size > maxBytes) throw invalid(`Choose an attachment smaller than ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
    return { itemId: item.id, attachment: toAttachment(attachment), data: readFileSync(path) };
  }
}
