import { type Live, useLive } from '../lib/api.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

/** `m:ss`, or `h:mm:ss` from an hour, as core writes timestamps into notes. */
export function timestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** A knowledge route path with its query; empty values are left out. */
export function knowledgePath(path: string, query: Record<string, string | number | null | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** Reads a knowledge route and reloads it whenever the library changes; a null path loads nothing. */
export function useKnowledge<T>(path: string | null): Live<T | null> {
  return useLive(() => (path ? knowledgeRequest<T>(path) : Promise.resolve(null)), [path]);
}

export function LiveStatus({ live, label = 'Loading…' }: { live: Live<unknown>; label?: string }) {
  if (live.error) return <p className="error-text" role="alert">{live.error.message}</p>;
  if (live.data === undefined) return <p className="muted" role="status">{label}</p>;
  return null;
}
