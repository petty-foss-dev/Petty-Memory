import type { ItemDetail, ItemPresentation, TaskPriority, TaskStatus } from '@enve-memory/core';
import { useMemo, useRef, useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { applyEdit } from '../lib/edits.ts';
import { TYPE_LABELS, actorInfo, displayTitle, formatBytes, formatDate, formatDateTime, relativeTime, siteOf } from '../lib/format.ts';
import { ATTENTION_LABELS, KIND_LABELS, isSecret, presentationOf } from '../lib/presentation.ts';
import { useApp } from '../context.ts';
import { type EditorHandle, Icon, MarkdownEditor, MarkdownView, ProjectSelect, TagEditor, Toggle, TypeIcon, useDraft, useFeedback } from '../ui.tsx';
import { AiEditDialog } from './AiEdit.tsx';
import { ConnectionsSection, useReferences } from './Connections.tsx';
import { VersionsPanel } from './History.tsx';
import { IntentChips, PinButton, RemindMenu } from './ItemActions.tsx';
import { ItemPicker } from './ItemPicker.tsx';
import { MoveDialog } from './OutlineMove.tsx';
import { ShareDialog } from './Share.tsx';
import { SecretBody } from './Vault.tsx';

const STATUS_LABELS: Record<TaskStatus, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };

export function ItemDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const live = useLive(() => call('items.get', id), [id]);
  const item = live.data;
  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" aria-label="Close item" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={item ? `${TYPE_LABELS[item.type]} details` : 'Item details'}>
        <div className="drawer-bar">
          {item && <span className="drawer-type"><TypeIcon type={item.type} size={16} /> {TYPE_LABELS[item.type]}</span>}
          <button className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
        </div>
        {live.error && <p className="error-text">{live.error.message}</p>}
        {item && <ItemBody item={item} onClose={onClose} />}
      </aside>
    </div>
  );
}

function ItemBody({ item, onClose }: { item: ItemDetail; onClose: () => void }) {
  const { projects, info, go, openItem } = useApp();
  const { toast, confirm } = useFeedback();
  const title = useDraft(item.title);
  const body = useDraft(item.body);
  const [showHistory, setShowHistory] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [dialog, setDialog] = useState<'ai' | 'share' | 'reference' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const references = useReferences(item.id);
  const titles = useMemo(() => new Map((references.data?.outgoing ?? []).map((r) => [r.id, r.title || 'Untitled'])), [references.data]);
  const decision = item.type === 'decision';
  const secret = isSecret(item);

  const fail = (error: unknown) => toast(errorMessage(error), 'error');
  // Saved through the editor journal against the text this drawer loaded, so a newer edit elsewhere is never overwritten.
  const saveTitle = () => {
    if (!title.dirty) return;
    applyEdit([{ op: 'update', id: item.id, title: title.draft, baseTitle: item.title }]).catch(fail);
  };
  const saveBody = () => {
    const draft = editor.current?.getMarkdown() ?? body.draft;
    applyEdit([{ op: 'update', id: item.id, body: draft, baseBody: item.body }]).then(() => {
      setSaveError(null);
      toast('Saved');
    }, (error: unknown) => setSaveError(errorMessage(error)));
  };
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete permanently?',
      body: <p>“{item.title || item.url || 'This item'}” and its files will be removed from this library for good. Archive it instead if you only want it out of sight; archiving can be undone.</p>,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    call('items.delete', item.id).then(() => {
      toast('Deleted');
      onClose();
    }, fail);
  };

  const ingest = item.metadata.ingest;
  const source = item.url ? siteOf(item.metadata.finalUrl ?? item.url) : item.attachments[0]?.filename;
  const ai = item.metadata.ai;

  return (
    <div className="drawer-content">
      {decision || secret ? (
        <h1 className="item-heading">{secret && <Icon name="lock" size={20} />} {item.title}</h1>
      ) : (
        <input
          className="item-heading"
          aria-label="Title"
          value={title.draft}
          placeholder={item.type === 'note' ? 'Untitled note' : 'Add a title'}
          onChange={(event) => title.setDraft(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        />
      )}

      <div className="item-facts">
        {item.url && (
          <button className="link-button url" onClick={() => call('items.openUrl', item.id).catch(fail)} title={item.url}>
            <Icon name="external" size={14} /> {item.url}
          </button>
        )}
        <span>Saved {relativeTime(item.createdAt)} by {actorInfo(item.source).label}</span>
        {item.openedAt && item.url && <span>Last opened {relativeTime(item.openedAt)}</span>}
        {item.archivedAt && <span className="badge">Archived</span>}
      </div>

      <div className="item-actions">
        <PinButton item={item} />
        {!decision && <RemindMenu item={item} />}
        {!decision && item.type !== 'task' && <IntentChips item={item} />}
        {!decision && !secret && info?.aiEnabled && (
          <button className="button small" onClick={() => setDialog('ai')}><Icon name="sparkle" size={14} /> Edit with AI…</button>
        )}
        {!secret && <button className="button small" onClick={() => setDialog('share')}><Icon name="share" size={14} /> Share…</button>}
      </div>

      {!decision && <PresentationControls item={item} />}

      <div className="field-row">
        <label className="field inline">
          <span>Project</span>
          <ProjectSelect
            value={item.project?.id ?? null}
            projects={projects}
            onChange={(project) => call('items.update', item.id, { project }).catch(fail)}
          />
        </label>
      </div>
      {decision && <p className="muted small">Decisions are append-only and stay in their project. To change one, record a decision that supersedes it.</p>}

      {item.task && <TaskFields item={item} />}

      <OutlinePlacement item={item} />

      <section className="detail-section">
        <h2>Tags</h2>
        <TagEditor
          tags={item.tags}
          onAdd={(tag) => call('items.tag', item.id, { add: [tag] }).catch(fail)}
          onRemove={(tag) => call('items.tag', item.id, { remove: [tag] }).catch(fail)}
        />
      </section>

      {secret && <SecretBody item={item} />}

      {!secret && <section className="detail-section">
        <h2>{decision ? 'Reason' : item.type === 'note' ? 'Note' : item.task ? 'Notes' : 'Your note'}</h2>
        {decision ? (
          item.body ? <MarkdownView source={item.body} titles={titles} /> : <p className="muted">No reason recorded.</p>
        ) : (
          <>
            <MarkdownEditor
              label="Note"
              value={body.draft}
              onChange={body.setDraft}
              onSubmit={saveBody}
              rows={item.type === 'note' ? 12 : 4}
              placeholder={item.type === 'bookmark' ? 'Why is this worth keeping?' : 'Write here. Use the toolbar for formatting, or switch to Markdown.'}
              editorRef={editor}
              titles={titles}
            />
            {saveError && body.dirty && (
              <p className="error-text small" role="alert">Not saved: {saveError} Your text is still here; copy it or Discard to load the saved version.</p>
            )}
            <div className="inline-actions">
              {body.dirty && <button className="button primary small" onClick={saveBody}>Save</button>}
              {body.dirty && <button className="button ghost small" onClick={() => { setSaveError(null); body.reset(); }}>Discard</button>}
              <button className="button ghost small" onClick={() => setDialog('reference')}>Link to an item…</button>
              {body.dirty && <span className="muted small">⌘↵ to save</span>}
            </div>
          </>
        )}
        {decision && item.project && (
          <button className="button small" onClick={() => go({ view: 'project', id: item.project!.id, supersede: item.id })}>Supersede…</button>
        )}
      </section>}

      {(ai || info?.aiEnabled) && !decision && !secret && item.type !== 'task' && (
        <section className="detail-section">
          <h2>AI summary</h2>
          {ai?.status === 'done' && (
            <div className="ai-box">
              {ai.summary && <p>{ai.summary}</p>}
              {(ai.tags?.length || ai.project) && (
                <p className="muted small">
                  Suggested {ai.project ? <>project <strong>{ai.project.name}</strong> </> : null}
                  {ai.tags?.map((t) => <span key={t} className="tag small">#{t}</span>)}
                </p>
              )}
              <div className="inline-actions">
                {!ai.accepted && (ai.tags?.length || (ai.project && !item.project)) ? (
                  <button className="button small" onClick={() => call('items.acceptSuggestions', item.id).then(() => toast('Suggestions applied'), fail)}>Accept suggestions</button>
                ) : null}
                <span className="muted small">{ai.model}</span>
              </div>
            </div>
          )}
          {ai?.status === 'failed' && <p className="error-text">{ai.error}</p>}
          {info?.aiEnabled && ai?.status !== 'done' && (
            <button className="button small" onClick={() => call('items.enrich', item.id).catch(fail)}>
              <Icon name="sparkle" size={14} /> Summarize and suggest tags
            </button>
          )}
        </section>
      )}

      {!secret && item.attachments.length > 0 && (
        <section className="detail-section">
          <h2>File</h2>
          {item.attachments.map((a) => (
            <div key={a.id} className="attachment">
              <Icon name="file" />
              <span>{a.filename}<span className="muted small"> · {a.mimeType} · {formatBytes(a.size)}</span></span>
              <button className="button small" onClick={() => call('items.openFile', item.id).catch(fail)}>Open</button>
            </div>
          ))}
        </section>
      )}

      <ConnectionsSection item={item} backlinks={references.data?.incoming ?? []} />

      {(ingest || item.content) && (
        <section className="reader-section" aria-label="Archived source">
          <div className="reader-header">
            <span className="reader-label">{item.url ? 'Saved from' : 'Text from'} {source || 'source'}{ingest?.at ? ` · ${formatDate(ingest.at)}` : ''}</span>
            <div className="reader-meta">
              {item.metadata.siteName && <span>{item.metadata.siteName}</span>}
              {item.metadata.byline && <span>{item.metadata.byline}</span>}
              {item.metadata.publishedAt && <span>Published {formatDate(item.metadata.publishedAt)}</span>}
              {item.metadata.wordCount ? <span>{item.metadata.wordCount.toLocaleString()} words</span> : null}
              {item.metadata.pageCount ? <span>{item.metadata.pageCount} pages</span> : null}
            </div>
          </div>
          {ingest?.status === 'pending' && <p className="muted">Archiving the page text…</p>}
          {ingest?.status === 'failed' && (
            <div className="error-box">
              <p>{ingest.error}</p>
              <button className="button small" onClick={() => call('items.retryIngest', item.id).catch(fail)}>Try again</button>
            </div>
          )}
          {item.content && (
            <>
              <p className="reader-note">Quoted from the source. It’s saved text, not instructions, and remote images aren’t loaded.</p>
              <MarkdownView className="reader" source={item.content} baseUrl={item.metadata.finalUrl ?? item.url} />
            </>
          )}
        </section>
      )}

      <section className="detail-section">
        <div className="inline-actions">
          <button className="link-button" aria-expanded={showVersions} onClick={() => setShowVersions(!showVersions)}>
            <Icon name="history" size={14} /> {showVersions ? 'Hide versions' : 'Versions and restore'}
          </button>
          <button className="link-button" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide activity' : 'Activity'}
          </button>
        </div>
        {showVersions && <VersionsPanel itemId={item.id} />}
        {showHistory && <ItemHistory id={item.id} />}
      </section>

      {dialog === 'ai' && <AiEditDialog rootId={item.id} title={displayTitle(item)} onClose={() => setDialog(null)} />}
      {dialog === 'share' && <ShareDialog rootId={item.id} title={displayTitle(item)} onClose={() => setDialog(null)} />}
      {dialog === 'reference' && (
        <ItemPicker
          title="Link to an item"
          exclude={[item.id]}
          onClose={() => setDialog(null)}
          onPick={(target) => {
            setDialog(null);
            editor.current?.insertReference(target.id, target.title);
          }}
        />
      )}

      <footer className="drawer-footer">
        {!decision && (item.archivedAt ? (
          <button className="button" onClick={() => call('items.unarchive', item.id).then(() => toast('Restored'), fail)}>Unarchive</button>
        ) : (
          <button className="button" onClick={() => call('items.archive', item.id).then(() => toast('Archived'), fail)}>
            <Icon name="archive" size={15} /> Archive
          </button>
        ))}
        <button className="button danger-ghost" onClick={() => void remove()}>
          <Icon name="trash" size={15} /> Delete…
        </button>
      </footer>
    </div>
  );
}

/** Where the item sits in the outline, shown once it's nested or holds anything. */
function OutlinePlacement({ item }: { item: ItemDetail }) {
  const { go, openItem } = useApp();
  const { toast } = useFeedback();
  const [moving, setMoving] = useState(false);
  const live = useLive(() => Promise.all([call('outline.get', item.id), call('outline.ancestors', item.id)]), [item.id]);
  if (!live.data) return null;
  const [entry, ancestors] = live.data;
  if (ancestors.length === 0 && entry.childCount === 0) return null;
  const movable = item.type !== 'decision' && !item.archivedAt;
  return (
    <section className="detail-section outline-placement">
      <h2>Outline</h2>
      {ancestors.length > 0 && (
        <nav className="crumbs" aria-label="Inside">
          <ol>
            {ancestors.map((ancestor) => (
              <li key={ancestor.id}>
                <button className="link-button" onClick={() => openItem(ancestor.id)}>{displayTitle(ancestor)}</button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="inline-actions">
        {entry.childCount > 0 && <span className="muted small">{entry.childCount} inside</span>}
        <button className="button small" onClick={() => go({ view: 'outline', reveal: item.id })}>Show in outline</button>
        {movable && <button className="button small" onClick={() => setMoving(true)}>Move…</button>}
      </div>
      {moving && (
        <MoveDialog
          entry={entry}
          onClose={(moved) => {
            setMoving(false);
            if (moved) toast(moved.parentId ? `Moved into ${moved.title}` : 'Moved to the top level');
          }}
        />
      )}
    </section>
  );
}

const ATTENTION_ORDER = ['high', 'normal', 'low'] as const;

/** Style, attention, review and checklist settings, so nobody needs Markdown to shape a note. */
function PresentationControls({ item }: { item: ItemDetail }) {
  const { toast } = useFeedback();
  const presentation = presentationOf(item);
  const progress = useLive(
    () => (presentation.checklist ? call('presentation.progress', item.id) : Promise.resolve(null)),
    [item.id, presentation.checklist],
  );
  const fail = (error: unknown) => toast(errorMessage(error), 'error');
  const update = (patch: Partial<ItemPresentation>) => call('presentation.update', item.id, patch).catch(fail);
  return (
    <section className="detail-section presentation-controls" aria-label="Style">
      <div className="field-row">
        <div className="field inline">
          <span>Show as</span>
          <div className="segmented small" role="radiogroup" aria-label="Show as">
            {(Object.keys(KIND_LABELS) as ItemPresentation['kind'][]).map((kind) => (
              <button key={kind} role="radio" aria-checked={presentation.kind === kind} className={presentation.kind === kind ? 'active' : ''} onClick={() => void update({ kind })}>
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
        <div className="field inline">
          <span>Attention</span>
          <div className="segmented small" role="radiogroup" aria-label="Attention">
            {ATTENTION_ORDER.map((attention) => (
              <button key={attention} role="radio" aria-checked={presentation.attention === attention} className={presentation.attention === attention ? 'active' : ''} onClick={() => void update({ attention })}>
                {ATTENTION_LABELS[attention]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="inline-actions">
        <label className="check"><Toggle label="Marked for review" checked={presentation.review} onChange={(review) => void update({ review })} /> Marked for review</label>
        {!item.task && (
          <label className="check">
            <Toggle label="Checked off" checked={presentation.checked} onChange={(checked) => void applyEdit([{ op: 'check', id: item.id, checked }]).catch(fail)} /> Checked off
          </label>
        )}
        <label className="check"><Toggle label="Checklist" checked={presentation.checklist} onChange={(checklist) => void update({ checklist })} /> Checklist</label>
        {presentation.checklist && (
          <>
            <label className="check"><Toggle label="Hide completed" checked={presentation.hideCompleted} onChange={(hideCompleted) => void update({ hideCompleted })} /> Hide completed</label>
            {progress.data && <span className="muted small">{progress.data.done} of {progress.data.total} done</span>}
            <button className="button small" onClick={() => call('presentation.reset', item.id).then(({ updated }) => toast(`Unchecked ${updated}`), fail)}>Reset</button>
          </>
        )}
      </div>
    </section>
  );
}

function TaskFields({ item }: { item: ItemDetail }) {
  const { toast } = useFeedback();
  const task = item.task!;
  const update = (input: { status?: TaskStatus; due?: string | null; priority?: TaskPriority }) =>
    call('tasks.update', item.id, input).catch((error: unknown) => toast(errorMessage(error), 'error'));
  return (
    <div className="field-row">
      <label className="field inline">
        <span>Status</span>
        <select value={task.status} onChange={(event) => update({ status: event.target.value as TaskStatus })}>
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="field inline">
        <span>Due</span>
        <input type="date" value={task.dueAt?.slice(0, 10) ?? ''} onChange={(event) => update({ due: event.target.value || null })} />
      </label>
      <label className="field inline">
        <span>Priority</span>
        <select value={task.priority} onChange={(event) => update({ priority: event.target.value as TaskPriority })}>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </label>
    </div>
  );
}

function ItemHistory({ id }: { id: string }) {
  const history = useLive(() => call('activity.recent', { entityId: id }, 30), [id]);
  return (
    <ul className="history">
      {(history.data ?? []).map((change) => (
        <li key={change.id}>
          <span className={`actor ${actorInfo(change.actor).kind}`}>{actorInfo(change.actor).label}</span>
          <span>{change.op.replace('_', ' ')}</span>
          <span className="muted">{formatDateTime(change.at)}</span>
        </li>
      ))}
    </ul>
  );
}
