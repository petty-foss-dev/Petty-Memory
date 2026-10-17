import type { Change } from '@enve-memory/core';
import { useState } from 'react';
import { call, useLive } from '../lib/api.ts';
import { actorInfo, formatDateTime, relativeTime } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Empty } from '../ui.tsx';

const KINDS = [
  { value: '', label: 'Everyone' },
  { value: 'ai', label: 'AI tools' },
  { value: 'device', label: 'Extension & devices' },
  { value: 'you', label: 'You' },
  { value: 'background', label: 'Background' },
];

const OPS: Record<string, string> = {
  create: 'created', update: 'edited', archive: 'archived', unarchive: 'unarchived', delete: 'deleted', tag: 'retagged',
  set_memory: 'updated the memory of', ingest: 'archived the source of', attach: 'attached a file to', enrich: 'suggested tags for',
  accept: 'accepted suggestions for', pin: 'pinned', unpin: 'unpinned', open: 'opened', remind: 'set a reminder on',
  reminded: 'sent the reminder for', intent: 'changed the intent of', detach: 'removed a file from',
  undo: 'undid an edit to', redo: 'redid an edit to',
};

const describe = (change: Change) =>
  ['title', 'name', 'body', 'filename'].map((k) => change.data?.[k]).find((v) => typeof v === 'string' && v) as string | undefined;

function subject(change: Change, projectNames: Map<string, string>, titles: Map<string, string>): string {
  const data = change.data ?? {};
  const text = describe(change) ?? titles.get(change.entityId);
  if (text) return text.split('\n')[0]!.slice(0, 90);
  if (change.entity === 'project') return projectNames.get(change.entityId) ?? 'a project';
  if (change.entity === 'relation') return `${String(data.kind ?? 'a relation').replace('_', ' ')} link`;
  return `${String(data.type ?? 'an item')}`;
}

export function Activity() {
  const { projects, openItem, go } = useApp();
  const [kind, setKind] = useState('');
  const changes = useLive(() => call('activity.recent', {}, 200), []);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const shown = (changes.data ?? []).filter((c) => !kind || actorInfo(c.actor).kind === kind);
  // Pins, reminders and suggestions carry no title; borrow one from another change to the same item.
  const titles = new Map<string, string>();
  for (const change of changes.data ?? []) {
    const text = describe(change);
    if (text && !titles.has(change.entityId)) titles.set(change.entityId, text);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Activity</h1>
        <p className="subtitle">Every change to your library and which app or AI made it.</p>
      </header>
      <div className="segmented" role="tablist" aria-label="Who">
        {KINDS.map((k) => (
          <button key={k.value} role="tab" aria-selected={kind === k.value} className={kind === k.value ? 'active' : ''} onClick={() => setKind(k.value)}>{k.label}</button>
        ))}
      </div>
      {changes.data && shown.length === 0 && <Empty title="No activity yet">Changes from this app, the CLI, the browser extension and AI tools appear here.</Empty>}
      <ul className="activity">
        {shown.map((change) => {
          const actor = actorInfo(change.actor);
          const project = change.projectId ? projectNames.get(change.projectId) : undefined;
          const clickable = change.op !== 'delete' && (change.entity === 'item' || change.entity === 'project');
          return (
            <li key={change.id}>
              <span className={`actor ${actor.kind}`} title={change.actor}>{actor.label}</span>
              <span className="activity-text">
                {OPS[change.op] ?? change.op}{' '}
                {clickable ? (
                  <button className="link-button" onClick={() => (change.entity === 'item' ? openItem(change.entityId) : go({ view: 'project', id: change.entityId }))}>
                    {subject(change, projectNames, titles)}
                  </button>
                ) : <span>{subject(change, projectNames, titles)}</span>}
                {project && change.entity !== 'project' && <span className="muted"> in {project}</span>}
              </span>
              <time className="muted" dateTime={change.at} title={formatDateTime(change.at)}>{relativeTime(change.at)}</time>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
