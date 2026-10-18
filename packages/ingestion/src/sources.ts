import {
  type CheckReport, type EnveMemory, MemoryError, SOURCE_LIMITS, type SourceObservation, type SourceQueue, WATCH_KINDS, type WatchedSource,
  isPlainText,
} from '@enve-memory/core';
import { DOMParser, parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { type FetchedSource, IngestError, fetchSource } from './fetch.ts';
import { extractHtml } from './html.ts';
import { extractPdf } from './pdf.ts';

export interface SourceCheckOptions {
  timeoutMs?: number;
}

export interface SourceWatcherOptions extends SourceCheckOptions {
  onChecked?: (count: number) => void;
  /** How long after a watch's last check it is due again. */
  intervalMs?: number;
  /** How often the watcher looks for due watches. */
  pollMs?: number;
  /** Watches checked per pass, one at a time. */
  limit?: number;
}

export interface ParsedFeed {
  observations: SourceObservation[];
  truncated: boolean;
}

interface XmlElement {
  tagName: string;
  children: ArrayLike<XmlElement>;
  textContent: string | null;
  getAttribute(name: string): string | null;
}

const FEED_ROOTS = new Set(['rss', 'feed', 'rdf:rdf']);
const MAX_NODES = 200_000;

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'object', 'embed']);

// Per process: a slow source checked by hand and by the watcher at once would race to replace one queue.
const checking = new WeakMap<EnveMemory, Set<string>>();

/**
 * Checks one watched source on the library's computer and queues new or changed material for review. Fetching uses the
 * same guards as saving a link; network failures are recorded on the watch's last check rather than thrown. Nothing is
 * imported or updated until the person applies a preview.
 */
export async function checkWatchedSource(memory: EnveMemory, id: string, { timeoutMs = 15_000 }: SourceCheckOptions = {}): Promise<SourceQueue> {
  const watch = memory.sources.get(id);
  if (watch.kind === 'folder') return memory.sources.checkFolder(watch.id);
  if (!memory.settings.get('fetchLinks')) {
    throw new MemoryError('invalid', 'Link fetching is turned off in Settings, so URL and feed watches can’t be checked. Turn it on to check this source.');
  }
  const active = checking.get(memory) ?? new Set<string>();
  checking.set(memory, active);
  if (active.has(watch.id)) throw new MemoryError('conflict', 'This source is already being checked. Wait for that check to finish.');
  active.add(watch.id);
  try {
    const report = await read(watch, timeoutMs);
    try {
      return memory.sources.recordCheck(watch.id, report);
    } catch (error) {
      if (error instanceof MemoryError && error.code !== 'invalid') throw error;
      const reason = error instanceof MemoryError ? `The source sent something that couldn’t be read: ${error.message}` : 'What the source sent couldn’t be saved.';
      return memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, error: `${reason} Check it again later.`.slice(0, 500) });
    }
  } finally {
    active.delete(watch.id);
  }
}

/** Checks enabled watches that are due, one at a time and at most `limit` per pass. Returns how many were checked. */
export async function checkDueSources(
  memory: EnveMemory, { intervalMs = 6 * 3_600_000, limit = 5, ...options }: Omit<SourceWatcherOptions, 'pollMs'> = {},
): Promise<number> {
  // URL and feed watches are left out before the cap while fetching is off, so they can't crowd folders out of every pass.
  const kinds = memory.settings.get('fetchLinks') ? WATCH_KINDS : (['folder'] as const);
  let checked = 0;
  for (const id of memory.sources.due(intervalMs, limit, kinds)) {
    try {
      await checkWatchedSource(memory, id, options);
      checked++;
    } catch (error) {
      // A watch removed or already being checked meanwhile is simply skipped this pass; one broken source never stops the rest.
      if (!(error instanceof MemoryError)) console.error('sources:', error);
    }
  }
  return checked;
}

/** Periodically checks due watches. Passes never overlap, and stop() waits for the current one. Lifecycle belongs to the host. */
export class SourceWatcher {
  private readonly memory: EnveMemory;
  private readonly options: SourceWatcherOptions;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private stopped = false;

  constructor(memory: EnveMemory, options: SourceWatcherOptions = {}) {
    this.memory = memory;
    this.options = options;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 15 * 60_000);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.running) return this.running;
    const { intervalMs, limit, timeoutMs } = this.options;
    const run = checkDueSources(this.memory, { intervalMs, limit, timeoutMs }).then((count) => {
      if (count) this.options.onChecked?.(count);
      return count;
    }).catch((error: unknown) => {
      console.error('sources:', error);
      return 0;
    });
    this.running = run;
    void run.finally(() => {
      if (this.running === run) this.running = null;
    });
    return run;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

/**
 * RSS 2.0, RSS 1.0 and Atom. Entity declarations are refused and the DOCTYPE dropped, so nothing outside the document
 * is ever resolved; feed HTML becomes Markdown with scripts removed and only http(s) links kept.
 */
export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  if (/<!ENTITY/i.test(xml)) throw new IngestError('The feed declares its own XML entities, which are never read. Ask the publisher for a plain feed.');
  const document = new DOMParser().parseFromString(xml.replace(/<!DOCTYPE[^>[]*(?:\[[^\]]*\])?[^>]*>/gi, ''), 'text/xml');
  const root = document.documentElement as unknown as XmlElement | null;
  if (!root || !FEED_ROOTS.has(name(root))) throw new IngestError('That address isn’t an RSS or Atom feed.');
  const entries: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  let truncated = false;
  for (let visited = 0; stack.length; visited++) {
    if (visited > MAX_NODES) {
      truncated = true;
      break;
    }
    const node = stack.pop()!;
    const tag = name(node);
    if (tag === 'item' || tag === 'entry') {
      if (entries.length === SOURCE_LIMITS.entries) {
        truncated = true;
        break;
      }
      entries.push(node);
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
  }
  const observations: SourceObservation[] = [];
  for (const entry of entries) {
    const link = entryLink(entry, feedUrl);
    const title = plain(text(child(entry, 'title')));
    const key = text(child(entry, 'guid', 'id')).trim() || link || '';
    const publishedAt = date(text(child(entry, 'pubdate', 'published', 'dc:date', 'updated')));
    if (!key && !title) continue;
    const raw = text(child(entry, 'content:encoded', 'content')) || text(child(entry, 'description', 'summary'));
    const body = /<[a-z][\s\S]*>/i.test(raw) ? markdown(raw, link ?? feedUrl) : raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    observations.push({
      key: (key || `${title}|${publishedAt ?? ''}`).slice(0, 2048), title: title.slice(0, 500), url: link, text: body, publishedAt,
      truncated: body.length > SOURCE_LIMITS.candidateText,
    });
  }
  return { observations, truncated };
}

async function read(watch: WatchedSource, timeoutMs: number): Promise<CheckReport> {
  try {
    const fetched = await fetchSource(watch.url!, { timeoutMs, maxBytes: SOURCE_LIMITS.fetchBytes });
    if (watch.kind === 'rss') return { sourceHash: watch.hash, ...parseFeed(Buffer.from(fetched.bytes).toString('utf8'), fetched.finalUrl) };
    return { sourceHash: watch.hash, observations: [await page(watch.url!, fetched)] };
  } catch (error) {
    const message = error instanceof IngestError ? error.message : `The check failed: ${(error as Error).message}`;
    return { sourceHash: watch.hash, error: message.slice(0, 500) };
  }
}

async function page(url: string, source: FetchedSource): Promise<SourceObservation> {
  const { contentType, bytes, finalUrl } = source;
  const decoded = Buffer.from(bytes).toString('utf8');
  let title = '';
  let body: string;
  let publishedAt: string | null = null;
  if (contentType === 'application/pdf') {
    const extracted = await extractPdf(bytes);
    title = extracted.title;
    body = extracted.content;
  } else if (contentType === 'text/html' || contentType === 'application/xhtml+xml' || (!contentType && /<html[\s>]/i.test(decoded))) {
    const extracted = extractHtml(decoded, finalUrl);
    title = extracted.title;
    body = extracted.content;
    publishedAt = extracted.metadata.publishedAt ?? null;
  } else if (isPlainText(contentType)) {
    body = decoded.trim();
  } else {
    throw new IngestError(`Can’t read ${contentType || 'this kind of page'} as a watched page.`);
  }
  return { key: url, title, url, text: body, publishedAt, truncated: body.length > SOURCE_LIMITS.candidateText };
}

function entryLink(entry: XmlElement, base: string): string | null {
  for (const node of Array.from(entry.children)) {
    if (name(node) !== 'link') continue;
    const href = node.getAttribute('href');
    const rel = node.getAttribute('rel');
    const value = href === null ? text(node) : rel === null || rel === 'alternate' ? href : null;
    const url = value && absolute(value.trim(), base);
    if (url) return url;
  }
  const guid = child(entry, 'guid');
  return guid && guid.getAttribute('isPermaLink') !== 'false' ? absolute(text(guid).trim(), base) : null;
}

function markdown(html: string, base: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const element of document.querySelectorAll('script, style, noscript, iframe, object, embed, form, button')) element.remove();
  for (const [selector, attribute] of [['a[href]', 'href'], ['img[src]', 'src']] as const) {
    for (const element of document.querySelectorAll(selector)) {
      const url = absolute(element.getAttribute(attribute) ?? '', base);
      if (url) element.setAttribute(attribute, url);
      else element.removeAttribute(attribute);
    }
  }
  for (const img of document.querySelectorAll('img[srcset]')) img.removeAttribute('srcset');
  return turndown.turndown(document.body?.innerHTML ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

function plain(value: string): string {
  const stripped = /<[a-z][\s\S]*>/i.test(value) ? parseHTML(`<!doctype html><html><body>${value}</body></html>`).document.body?.textContent ?? '' : value;
  return stripped.replace(/\s+/g, ' ').trim();
}

function absolute(value: string, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function date(value: string): string | null {
  const parsed = Date.parse(value.trim());
  return value.trim() && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function child(node: XmlElement, ...names: string[]): XmlElement | null {
  for (const wanted of names) {
    for (const element of Array.from(node.children)) if (name(element) === wanted) return element;
  }
  return null;
}

const name = (node: XmlElement) => node.tagName.toLowerCase();
const text = (node: XmlElement | null) => node?.textContent ?? '';
