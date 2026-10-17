import { type EnveMemory, MemoryError, type SyncPage, type SyncPeerState, type SyncRecord } from '@enve-memory/core';
import { setTimeout as delay } from 'node:timers/promises';

export interface RemoteSyncOptions {
  url: string;
  token: string;
}

export interface RemoteSyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  rejected: number;
}

export interface RemoteWatchOptions {
  signal: AbortSignal;
  onSync?: (result: RemoteSyncResult) => void;
  onError?: (error: Error) => void;
}

export class RemoteSyncPartialError extends MemoryError {
  readonly result: RemoteSyncResult;
  constructor(result: RemoteSyncResult) {
    super('conflict', 'Some changes were refused and remain pending. Other changes and incoming updates have synced.');
    this.result = result;
  }
}

interface Applied {
  imported: number;
  conflicts: number;
  rejected: number;
  rejectedRecords?: Pick<SyncRecord, 'entity' | 'id' | 'hlc'>[];
}

interface Capabilities { wait: boolean; maxBodyBytes: number }

const MAX_BYTES = 200 * 1024 * 1024;
const PAGE = 100;
class PermissionError extends MemoryError {}

/** Syncs a library with a server over its API. Cursors and pending files persist in the library, never the token. */
export class RemoteSyncClient {
  private readonly memory: EnveMemory;
  private readonly base: string;
  private readonly token: string;
  private running: Promise<RemoteSyncResult> | null = null;
  private activeSignal: AbortSignal | undefined;
  private capabilitiesPending: Promise<Capabilities> | null = null;

  constructor(memory: EnveMemory, options: RemoteSyncOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new MemoryError('invalid', 'Enter a valid sync server address.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new MemoryError('invalid', 'Use an HTTP or HTTPS sync address without credentials, a query or a fragment.');
    }
    if (!options.token.trim()) throw new MemoryError('invalid', 'A sync client token is required.');
    this.memory = memory;
    this.base = `${url.href.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1`;
    this.token = options.token;
  }

  run({ signal }: { signal?: AbortSignal } = {}): Promise<RemoteSyncResult> {
    if (this.running) return this.running;
    this.activeSignal = signal;
    this.running = this.exchange().finally(() => { this.running = null; this.activeSignal = undefined; });
    return this.running;
  }

  async watch({ signal, onSync, onError }: RemoteWatchOptions): Promise<void> {
    let failures = 0;
    let live: boolean | undefined;
    while (!signal.aborted) {
      try {
        const result = await this.run({ signal });
        onSync?.(result);
        if (result.rejected) onError?.(new RemoteSyncPartialError(result));
        failures = 0;
        if (live === undefined) live = await this.supportsWait(signal);
        const revision = this.memory.feed.revision;
        const state = this.memory.sync.peerState(this.base)!;
        // Pulls enter the local log too; flush them and any edit made during the exchange before waiting.
        if (revision > state.pushedCursor) continue;
        if (!live || state.uploads.length || state.downloads.length || state.pendingPushes?.length || state.pendingPulls?.length) {
          await delay(2000, undefined, { signal });
          continue;
        }
        const cycle = new AbortController();
        const waiting = AbortSignal.any([signal, cycle.signal]);
        try {
          await Promise.race([
            this.page(state.pulledCursor, 25_000, waiting),
            this.waitForLocalChange(revision, waiting),
          ]);
        } finally {
          cycle.abort();
        }
      } catch (error) {
        if (signal.aborted) return;
        onError?.(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof PermissionError) return;
        failures++;
        try { await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)), undefined, { signal }); }
        catch { return; }
      }
    }
  }

  private async waitForLocalChange(revision: number, signal: AbortSignal): Promise<void> {
    while (this.memory.feed.revision === revision) await delay(250, undefined, { signal });
  }

  private async supportsWait(signal: AbortSignal): Promise<boolean> {
    return (await this.capabilities(signal)).wait;
  }

  private capabilities(signal?: AbortSignal): Promise<Capabilities> {
    this.capabilitiesPending ??= this.fetchCapabilities(signal).catch((error: unknown) => {
      this.capabilitiesPending = null;
      throw error;
    });
    return this.capabilitiesPending;
  }

  private async fetchCapabilities(signal?: AbortSignal): Promise<Capabilities> {
    const response = await this.request('/sync/capabilities', { signal });
    if (response.status === 404) { await response.body?.cancel(); return { wait: false, maxBodyBytes: MAX_BYTES }; }
    await this.check(response);
    const value = JSON.parse((await boundedBody(response)).toString('utf8')) as { protocol?: number; features?: unknown; maxBodyBytes?: number };
    if (value.protocol !== 1 || !Array.isArray(value.features)) throw new MemoryError('invalid', 'Incompatible sync protocol. Update the app and sync server.');
    if (value.maxBodyBytes !== undefined && (!Number.isSafeInteger(value.maxBodyBytes) || value.maxBodyBytes < 1)) throw new MemoryError('invalid', 'The sync server returned an invalid request limit.');
    return { wait: value.features.includes('wait'), maxBodyBytes: Math.min(value.maxBodyBytes ?? MAX_BYTES, MAX_BYTES) };
  }

  /** Forgets this server's cursors and pending files, so the next run starts over. */
  forget(): void {
    this.memory.sync.setPeerState(this.base, null);
  }

  private async exchange(): Promise<RemoteSyncResult> {
    const result: RemoteSyncResult = { pushed: 0, pulled: 0, conflicts: 0, rejected: 0 };
    const state: SyncPeerState = this.memory.sync.peerState(this.base)
      ?? { deviceId: null, pushedCursor: 0, pulledCursor: 0, uploads: [], downloads: [] };
    const save = () => this.memory.sync.setPeerState(this.base, state);
    const uploads = new Set(state.uploads);
    const downloads = new Set(state.downloads);
    const pendingPushes = new Set(state.pendingPushes ?? []);
    const pendingPulls = new Set(state.pendingPulls ?? []);
    const track = () => {
      state.uploads = [...uploads];
      state.downloads = [...downloads];
      if (pendingPushes.size) state.pendingPushes = [...pendingPushes];
      else delete state.pendingPushes;
      if (pendingPulls.size) state.pendingPulls = [...pendingPulls];
      else delete state.pendingPulls;
      save();
    };

    const capabilities = await this.capabilities(this.activeSignal);
    const head = await this.page(state.pulledCursor);
    if (state.deviceId !== null && head.deviceId !== state.deviceId) {
      Object.assign(state, { pushedCursor: 0, pulledCursor: 0 });
      uploads.clear();
      downloads.clear();
      pendingPushes.clear();
      pendingPulls.clear();
    } else if (head.reset) {
      // The server was restored from a backup: it may have lost what we sent, so send everything again.
      Object.assign(state, { pushedCursor: 0, pulledCursor: 0 });
      pendingPushes.clear();
      pendingPulls.clear();
    }
    state.deviceId = head.deviceId;
    track();

    const push = async (records: SyncRecord[], cursor: number) => {
      const sent = await this.pushRecords(records, capabilities.maxBodyBytes);
      result.pushed += sent.applied.imported;
      result.conflicts += sent.applied.conflicts;
      result.rejected += sent.applied.rejected;
      this.memory.sync.markSynced(sent.accepted);
      for (const hash of blobHashes(sent.accepted)) uploads.add(hash);
      if (sent.applied.rejected) pendingPushes.add(cursor);
      else pendingPushes.delete(cursor);
    };

    for (const cursor of [...pendingPushes]) {
      const page = this.memory.sync.exportChanges(cursor, PAGE, { base: 'synced' });
      if (page.reset) pendingPushes.delete(cursor);
      else await push(page.records, cursor);
      track();
    }

    for (;;) {
      const page = this.memory.sync.exportChanges(state.pushedCursor, PAGE, { base: 'synced' });
      // This library was restored from a backup and lost what it had pulled; fetch it all again.
      if (page.reset) { state.pulledCursor = 0; pendingPushes.clear(); pendingPulls.clear(); }
      if (page.records.length) {
        await push(page.records, page.reset ? 0 : state.pushedCursor);
      }
      state.pushedCursor = page.nextCursor;
      track();
      if (!page.hasMore) break;
    }

    for (const hash of [...uploads]) {
      const status = this.memory.sync.blobStatus(hash);
      if (status === 'missing') continue;
      if (status === 'stored') {
        const response = await this.request(`/sync/blobs/${hash}`, {
          method: 'PUT', body: new Uint8Array(this.memory.sync.readBlob(hash)), headers: { 'Content-Type': 'application/octet-stream' },
        });
        // The server doesn't list the attachment yet; keep the file pending while this library still refers to it.
        if (response.status === 404) {
          await response.body?.cancel();
          continue;
        }
        await this.check(response);
        await response.body?.cancel();
      }
      uploads.delete(hash);
      track();
    }

    const pull = (page: SyncPage, cursor: number) => {
      // The next run's first page sees the new library or the restore and starts over.
      if (page.deviceId !== state.deviceId || page.reset) {
        throw new MemoryError('conflict', 'The sync server library changed during sync. Run sync again.');
      }
      const applied = this.memory.sync.applyChanges(page.records, { pulled: true });
      this.memory.sync.markSynced(acceptedRecords(page.records, applied));
      result.pulled += applied.imported;
      result.conflicts += applied.conflicts;
      result.rejected += applied.rejected;
      for (const hash of blobHashes(page.records)) downloads.add(hash);
      if (applied.rejected) pendingPulls.add(cursor);
      else pendingPulls.delete(cursor);
    };

    for (const cursor of [...pendingPulls]) {
      pull(await this.page(cursor), cursor);
      track();
    }
    for (;;) {
      const page = await this.page(state.pulledCursor);
      pull(page, state.pulledCursor);
      state.pulledCursor = page.nextCursor;
      track();
      if (!page.hasMore) break;
    }

    for (const hash of [...downloads]) {
      if (this.memory.sync.blobStatus(hash) === 'missing') {
        const response = await this.request(`/sync/blobs/${hash}`);
        if (response.status === 404) {
          await response.body?.cancel();
          continue;
        }
        await this.check(response);
        const bytes = await boundedBody(response);
        try {
          this.memory.sync.writeBlob(hash, bytes);
        } catch (error) {
          if (!(error instanceof MemoryError)) throw error;
          // A damaged transfer stays pending for the next run; a file nothing here refers to anymore is dropped.
          if (error.code !== 'not_found') continue;
        }
      }
      downloads.delete(hash);
      track();
    }
    return result;
  }

  private async page(cursor: number, wait = 0, signal?: AbortSignal): Promise<SyncPage> {
    const page = await this.json<SyncPage>(`/sync?cursor=${cursor}&limit=${PAGE}${wait ? `&wait=${wait}` : ''}`, { signal });
    const reset = page.reset === true;
    if (!Array.isArray(page.records) || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < (reset ? 0 : cursor)
      || typeof page.deviceId !== 'string' || typeof page.hasMore !== 'boolean'
      || (page.hasMore && page.nextCursor === (reset ? 0 : cursor))) {
      throw new MemoryError('invalid', 'The sync server returned an invalid change page.');
    }
    return { ...page, reset };
  }

  private async pushRecords(records: SyncRecord[], maxBytes: number): Promise<{ applied: Applied; accepted: SyncRecord[] }> {
    const applied: Applied = { imported: 0, conflicts: 0, rejected: 0 };
    const accepted: SyncRecord[] = [];
    let parts: string[] = [];
    let batch: SyncRecord[] = [];
    let bytes = 14;
    const flush = async () => {
      if (!batch.length) return;
      const result = await this.json<Applied>('/sync', { method: 'POST', body: `{"records":[${parts.join(',')}]}` });
      this.validateApplied(result, batch);
      applied.imported += result.imported;
      applied.conflicts += result.conflicts;
      applied.rejected += result.rejected;
      accepted.push(...acceptedRecords(batch, result));
      parts = [];
      batch = [];
      bytes = 14;
    };
    for (const record of records) {
      const part = JSON.stringify(record);
      const length = Buffer.byteLength(part);
      if (length + 14 > maxBytes) { applied.rejected++; continue; }
      if (bytes + length + (parts.length ? 1 : 0) > maxBytes) await flush();
      bytes += length + (parts.length ? 1 : 0);
      parts.push(part);
      batch.push(record);
    }
    await flush();
    return { applied, accepted };
  }

  private validateApplied(value: Applied, records: SyncRecord[]): void {
    if (![value.imported, value.conflicts, value.rejected].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw new MemoryError('invalid', 'The sync server returned an invalid result.');
    }
    if (value.rejectedRecords !== undefined && (!Array.isArray(value.rejectedRecords) || value.rejectedRecords.length !== value.rejected
      || value.rejectedRecords.some((record) => !record || !records.some((sent) => sent.entity === record.entity && sent.id === record.id && sent.hlc === record.hlc)))) {
      throw new MemoryError('invalid', 'The sync server returned invalid refused change identities.');
    }
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? this.activeSignal;
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...init.headers },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    await this.check(response);
    return JSON.parse((await boundedBody(response)).toString('utf8')) as T;
  }

  private async check(response: Response): Promise<void> {
    if (response.ok) return;
    await response.body?.cancel();
    if (response.status === 413) this.capabilitiesPending = null;
    const message = response.status === 401
      ? 'The sync server rejected the token. Create a client on the server with --scope sync and use its token.'
      : response.status === 403
        ? 'This token lacks the sync scope. Create a client on the server with --scope sync and use its token.'
        : `The sync server returned HTTP ${response.status}.`;
    throw new (response.status === 401 || response.status === 403 ? PermissionError : MemoryError)('invalid', message);
  }
}

function acceptedRecords(records: SyncRecord[], result: Applied): SyncRecord[] {
  if (!result.rejected) return records;
  if (!result.rejectedRecords || result.rejectedRecords.length !== result.rejected) return [];
  const refused = new Set(result.rejectedRecords.map((record) => JSON.stringify([record.entity, record.id, record.hlc])));
  return records.filter((record) => !refused.has(JSON.stringify([record.entity, record.id, record.hlc])));
}

function blobHashes(records: SyncRecord[]): Set<string> {
  const hashes = new Set<string>();
  for (const record of records) {
    if (record.entity !== 'item' || !record.state || !('attachments' in record.state)) continue;
    const attachments = record.state.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) {
      if (attachment && typeof attachment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(attachment.sha256)) hashes.add(attachment.sha256);
    }
  }
  return hashes;
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_BYTES) throw new MemoryError('invalid', 'The sync response exceeds 200 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
