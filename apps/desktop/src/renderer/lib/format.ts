import type { Intent, ItemType } from '@enve-memory/core';

export { displayTitle, firstLine } from '../../shared/text.ts';

export function providedSourceLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'enve:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function siteOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(iso, now);
}

export function formatDate(iso: string, now = Date.now()): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function dueInfo(due: string | null, now = new Date()): { label: string; tone: 'overdue' | 'soon' | 'later' } | null {
  if (!due) return null;
  const today = localDay(now);
  const day = due.length === 10 ? due : localDay(new Date(due));
  const tomorrow = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const week = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  if (day < today) return { label: `Overdue · ${formatDate(day)}`, tone: 'overdue' };
  if (day === today) return { label: 'Today', tone: 'soon' };
  if (day === tomorrow) return { label: 'Tomorrow', tone: 'soon' };
  return { label: formatDate(day), tone: day <= week ? 'soon' : 'later' };
}

export function isDueSoon(due: string | null, now = new Date()): boolean {
  const info = dueInfo(due, now);
  return info !== null && info.tone !== 'later';
}

export const TYPE_LABELS: Record<ItemType, string> = {
  note: 'Note', bookmark: 'Link', task: 'Task', decision: 'Decision', file: 'File', image: 'Image',
};

/** `mcp:claude-code` → "claude-code" via MCP. */
export function actorInfo(actor: string): { label: string; kind: 'ai' | 'device' | 'you' | 'background' } {
  const [source, ...rest] = actor.split(':');
  const name = rest.join(':');
  switch (source) {
    case 'mcp':
      return { label: name ? `${name} · MCP` : 'MCP client', kind: 'ai' };
    case 'api':
      return { label: name ? `${name} · API` : 'API client', kind: 'device' };
    case 'desktop':
      return { label: 'You · desktop', kind: 'you' };
    case 'cli':
      return { label: 'You · CLI', kind: 'you' };
    case 'ingest':
      return { label: 'Archiver', kind: 'background' };
    case 'ai':
      return { label: 'AI suggestions', kind: 'background' };
    case 'rule':
      return { label: name ? `Automation · ${name}` : 'Automation', kind: 'background' };
    case 'import':
      return { label: name ? `Import · ${name}` : 'Import', kind: 'you' };
    default:
      return { label: actor, kind: 'background' };
  }
}

/** FTS snippets mark matches as `[term]`; split them so the UI can highlight without HTML. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  const pattern = /\[([^[\]]+)\]/g;
  let last = 0;
  for (let m = pattern.exec(snippet); m; m = pattern.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false });
    parts.push({ text: m[1]!, match: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts;
}

export const INTENT_LABELS: Record<Intent, string> = { read: 'Read', watch: 'Watch', buy: 'Buy', revisit: 'Revisit' };

/** "Tonight 8:00 PM", "Tomorrow 9:00 AM", "Sat 10:00 AM", "Oct 3, 9:00 AM". */
export function formatReminder(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(date) - day(now)) / 86_400_000);
  if (days === 0) return `${date.getHours() >= 17 ? 'Tonight' : 'Today'} ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${formatDate(iso, now.getTime())}, ${time}`;
}

/** How a restore went, naming any files whose bytes aren't on this device rather than claiming a full recovery. */
export function recoveryMessage(done: string, { missingFiles = [] }: { missingFiles?: { filename: string }[] }): { message: string; tone: 'info' | 'error' } {
  if (!missingFiles.length) return { message: done, tone: 'info' };
  const names = missingFiles.map((file) => file.filename).join(', ');
  const count = missingFiles.length === 1 ? '1 file isn’t' : `${missingFiles.length} files aren’t`;
  return { message: `${done}, but ${count} on this device (${names}). Sync with the device that has them, or restore a backup that does.`, tone: 'error' };
}
