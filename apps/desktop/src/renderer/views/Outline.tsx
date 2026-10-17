import type { Item, ItemPresentation, OutlineEntry } from '@enve-memory/core';
import {
  type CSSProperties, Fragment, createContext, useCallback, useContext, useEffect, useReducer, useRef, useState,
} from 'react';
import { call, errorMessage, onChanged, useLive } from '../lib/api.ts';
import { applyEdit, onEditFocus, useUndoRedo } from '../lib/edits.ts';
import { TYPE_LABELS, displayTitle, firstLine, siteOf } from '../lib/format.ts';
import {
  type Plan, type Siblings, displayPath, enterAction, firstAnchor, insertBelow, mergeTarget, organizable, pasteCommands, planIndent, planMoveDown,
  planMoveUp, planOutdent,
} from '../lib/outline.ts';
import {
  ATTENTION_LABELS, KIND_LABELS, type PastedLine, isChecked, isSecret, parsePastedOutline, presentationOf, readableText,
} from '../lib/presentation.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, type IconName, TypeIcon, useFeedback } from '../ui.tsx';
import { AiEditDialog } from './AiEdit.tsx';
import { PagedItems } from './Highlights.tsx';
import { MoveDialog, type Moved, loadChildren } from './OutlineMove.tsx';
import { ShareDialog } from './Share.tsx';
import { SecretNoteDialog } from './Vault.tsx';

const PAGE_SIZE = 100;
const ROOT = '';
const keyOf = (parentId: string | null) => parentId ?? ROOT;
const isMac = window.enve.platform === 'darwin';
const ALT = isMac ? '⌥' : 'Alt+';
const MOD = isMac ? '⌘' : 'Ctrl+';

interface Branch extends Siblings {
  /** Order of the request that filled it, so a reopened parent can tell which cached child lists are older. */
  seq: number;
  want: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

/** Where the inline composer sits: before `beforeId` among `parentId`'s children, or at the end when null. */
interface Insertion {
  n: number;
  parentId: string | null;
  beforeId: string | null;
  project: Item['project'];
  /** Ancestors shown above it; collapsing any of them closes the composer. */
  path: string[];
  /** The row to focus when it closes without saving. */
  anchor: string | null;
  last: string | null;
}

interface RowInfo {
  entry: OutlineEntry;
  list: Branch;
  index: number;
  path: string[];
  parent: OutlineEntry | null;
}

interface Abilities {
  up: boolean;
  down: boolean;
  indent: boolean;
  outdent: boolean;
}

type RowDialog = { kind: 'ai' | 'share' | 'secret'; entry: OutlineEntry };

/** The row being renamed, and where its caret starts (after a merge, at the join). */
interface Editing {
  id: string;
  caret?: number;
}

interface OutlineApi {
  branch: (parentId: string | null) => Branch | undefined;
  isOpen: (id: string) => boolean;
  composer: Insertion | null;
  flash: string | null;
  editing: Editing | null;
  aiEnabled: boolean;
  edit: (id: string | null) => void;
  rename: (row: RowInfo, title: string) => Promise<void>;
  /** Splits a note's title at the caret into a following sibling; `title` is the text being edited. */
  split: (row: RowInfo, title: string, caret: number) => Promise<void>;
  /** Joins a note onto the note right above it; `title` is the text being edited. */
  merge: (row: RowInfo, title: string) => Promise<void>;
  addAbove: (row: RowInfo) => void;
  /** Creates pasted rows at `at`; a line deeper than the first goes inside the row above it, starting from `seed`. */
  paste: (at: Pick<Insertion, 'parentId' | 'beforeId' | 'project'>, lines: PastedLine[], seed?: string[]) => Promise<void>;
  pasteBelow: (row: RowInfo, lines: PastedLine[]) => Promise<void>;
  style: (row: RowInfo, patch: Partial<ItemPresentation>) => void;
  check: (row: RowInfo, checked: boolean) => void;
  reset: (row: RowInfo) => void;
  dialog: (dialog: RowDialog) => void;
  toggle: (id: string, open: boolean) => void;
  open: (id: string) => void;
  moveUp: (row: RowInfo) => void;
  moveDown: (row: RowInfo) => void;
  indent: (row: RowInfo) => void;
  outdent: (row: RowInfo) => void;
  moveTo: (row: RowInfo) => void;
  addInside: (row: RowInfo) => void;
  addBelow: (row: RowInfo) => void;
  loadMore: (parentId: string | null) => void;
  retry: (parentId: string | null) => void;
  create: (at: Insertion, title: string, body: string) => Promise<void>;
  closeComposer: () => void;
  fail: (error: unknown) => void;
  onRowKey: (event: React.KeyboardEvent<HTMLButtonElement>, row: RowInfo, open: boolean) => void;
}

const OutlineContext = createContext<OutlineApi>(null as unknown as OutlineApi);

// Survives switching views, so coming back shows the outline as it was left.
const expanded = new Set<string>();

const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties;

type Focus = 'all' | 'review' | 'high';

export function OutlineView({ reveal }: { reveal?: string }) {
  const { openItem, info } = useApp();
  const { toast } = useFeedback();
  const [archived, setArchived] = useState(false);
  const [focus, setFocus] = useState<Focus>('all');
  const [composer, setComposer] = useState<Insertion | null>(null);
  const [moving, setMoving] = useState<OutlineEntry | null>(null);
  const [rowDialog, setRowDialog] = useState<RowDialog | null>(null);
  const [newSecret, setNewSecret] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const branches = useRef(new Map<string, Branch>());
  const inflight = useRef(new Map<string, Promise<unknown>>());
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const busy = useRef(false);
  const pendingFocus = useRef<{ id: string; until: number } | null>(null);
  const serial = useRef(0);
  const seq = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const fail = useCallback((error: unknown) => toast(errorMessage(error), 'error'), [toast]);

  /** Reloads the first `want` (at least as many as before) children; a newer request for the same list wins. */
  const refresh = useCallback((parentId: string | null, want = 0): Promise<unknown> => {
    const key = keyOf(parentId);
    const current = branches.current.get(key);
    const target = Math.max(want, current?.want ?? PAGE_SIZE);
    const mine = ++seq.current;
    branches.current.set(key, current
      ? { ...current, seq: mine, want: target, loading: true }
      : { parentId, entries: [], total: 0, seq: mine, want: target, loaded: false, loading: true, error: null });
    rerender();
    const run: Promise<unknown> = loadChildren(parentId, target, archivedRef.current).then(
      (page) => {
        if (inflight.current.get(key) !== run) return inflight.current.get(key);
        branches.current.set(key, { parentId, entries: page.items, total: page.total, seq: mine, want: target, loaded: true, loading: false, error: null });
        rerender();
        for (const entry of page.items) {
          const child = branches.current.get(entry.item.id);
          if (expanded.has(entry.item.id) && entry.childCount > 0 && (!child || child.seq < mine)) void refresh(entry.item.id);
        }
      },
      (error: unknown) => {
        if (inflight.current.get(key) !== run) return inflight.current.get(key);
        branches.current.set(key, { ...branches.current.get(key)!, loading: false, error: errorMessage(error) });
        rerender();
      },
    );
    inflight.current.set(key, run);
    return run;
  }, []);

  const refreshVisible = useCallback(() => {
    const parents: (string | null)[] = [null];
    for (const parentId of parents) {
      for (const entry of branches.current.get(keyOf(parentId))?.entries ?? []) {
        if (expanded.has(entry.item.id) && branches.current.has(entry.item.id)) parents.push(entry.item.id);
      }
    }
    return Promise.all(parents.map((parentId) => refresh(parentId)));
  }, [refresh]);

  /** Loads more of a list until `done` holds or the list runs out. */
  const loadUntil = useCallback(async (parentId: string | null, done: (branch: Branch) => boolean): Promise<Branch> => {
    const key = keyOf(parentId);
    await (inflight.current.get(key) ?? refresh(parentId));
    for (;;) {
      const branch = branches.current.get(key)!;
      if (done(branch) || branch.error || branch.entries.length >= branch.total) return branch;
      await refresh(parentId, branch.entries.length + PAGE_SIZE);
      if (branches.current.get(key)!.entries.length <= branch.entries.length) return branches.current.get(key)!;
    }
  }, [refresh]);

  const contains = (id: string) => (branch: Branch) => branch.entries.some((e) => e.item.id === id);

  const focusRow = useCallback((id: string, highlight = false) => {
    pendingFocus.current = { id, until: Date.now() + 2000 };
    if (highlight) setFlash(id);
    rerender();
  }, []);

  /** Expands the rows above an item, loads each list far enough to hold it, then focuses it. */
  const revealItem = useCallback(async (id: string) => {
    const path = displayPath(await call('outline.ancestors', id), archivedRef.current);
    for (const ancestor of path) expanded.add(ancestor);
    let parentId: string | null = null;
    for (const step of [...path, id]) {
      const branch = await loadUntil(parentId, contains(step));
      if (!contains(step)(branch)) {
        toast(archivedRef.current ? 'It isn’t in the outline any more.' : 'It isn’t in the outline. If it’s archived, turn on Show archived.', 'error');
        return;
      }
      parentId = step;
    }
    focusRow(id, true);
  }, [loadUntil, focusRow, toast]);

  useEffect(() => {
    branches.current.clear();
    inflight.current.clear();
    void refresh(null);
  }, [archived, refresh]);

  useEffect(() => onChanged(() => void refreshVisible()), [refreshVisible]);

  useEffect(() => onEditFocus((id) => void revealItem(id).catch(() => {})), [revealItem]);

  useEffect(() => {
    if (reveal) revealItem(reveal).catch(fail);
  }, [reveal]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  // A row being refocused may only appear a render or two later, once its list has reloaded.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (Date.now() > pending.until) pendingFocus.current = null;
    const row = container.current?.querySelector<HTMLElement>(`[data-outline-main="${CSS.escape(pending.id)}"]`);
    if (!row) return;
    pendingFocus.current = null;
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
  });

  /** Plans against `planOn`'s children (loading more when the plan needs it), moves, then refocuses the row. */
  const runMove = (entry: OutlineEntry, source: string | null, planOn: string | null, plan: (branch: Branch) => Plan) => {
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        const settled = (branch: Branch) => {
          const result = plan(branch);
          return result === null || !('needs' in result);
        };
        const result = plan(await loadUntil(planOn, settled));
        if (!result || !('move' in result)) return;
        const { parentId } = result.move;
        await applyEdit([{ op: 'move', id: entry.item.id, parentId, beforeId: result.move.beforeId ?? null }]);
        if (parentId) expanded.add(parentId);
        await Promise.all([refresh(source), refresh(parentId)]);
        await loadUntil(parentId, contains(entry.item.id));
        focusRow(entry.item.id);
      } catch (error) {
        fail(error);
      } finally {
        busy.current = false;
      }
    })();
  };

  // Plans from the row's place in the reloaded list, not the index it had when it was rendered.
  const atFresh = (entry: OutlineEntry, plan: (list: Siblings, index: number) => Plan) => (branch: Branch): Plan => {
    const index = branch.entries.findIndex((e) => e.item.id === entry.item.id);
    return index < 0 ? null : plan(branch, index);
  };

  const openComposer =(at: Omit<Insertion, 'n' | 'last'>) => setComposer({ ...at, n: ++serial.current, last: null });

  const newNote = () => {
    const root = branches.current.get(ROOT);
    openComposer({ parentId: null, beforeId: root ? firstAnchor(root) : null, project: null, path: [], anchor: null });
  };

  // One journalled batch, so a paste is one structural undo step.
  const paste: OutlineApi['paste'] = async (at, lines, seed = []) => {
    const listed = branches.current.get(keyOf(at.parentId));
    const beforeId = at.beforeId && listed?.entries.some((e) => e.item.id === at.beforeId) ? at.beforeId : null;
    const { commands } = pasteCommands({ parentId: at.parentId, beforeId, project: at.project?.id }, lines, seed);
    await applyEdit(commands);
    if (at.parentId) expanded.add(at.parentId);
    for (const id of seed) expanded.add(id);
    await refreshVisible();
    toast(`Added ${lines.length} notes`);
  };

  /** Puts the caret in a row's title once its list has reloaded with it. */
  const editRow = async (parentId: string | null, id: string, caret?: number) => {
    await refresh(parentId);
    await loadUntil(parentId, contains(id));
    setEditing({ id, caret });
  };

  const titleUpdate = (entry: OutlineEntry, title: string) =>
    title === entry.item.title ? [] : [{ op: 'update' as const, id: entry.item.id, title, baseTitle: entry.item.title }];

  const api: OutlineApi = {
    branch: (parentId) => branches.current.get(keyOf(parentId)),
    isOpen: (id) => expanded.has(id),
    composer,
    flash,
    editing,
    aiEnabled: info?.aiEnabled ?? false,
    edit: (id) => {
      setEditing(id ? { id } : null);
      if (!id && editing) focusRow(editing.id);
    },
    rename: async ({ entry }, title) => {
      await applyEdit(titleUpdate(entry, title));
      setEditing(null);
      focusRow(entry.item.id);
    },
    split: async ({ entry, list }, title, caret) => {
      const result = await applyEdit([...titleUpdate(entry, title), { op: 'split', id: entry.item.id, field: 'title', offset: caret, baseText: title }]);
      await editRow(list.parentId, result.focusId, 0);
    },
    merge: async ({ entry, list, index }, title) => {
      const previousId = mergeTarget(list, index);
      const previous = list.entries[index - 1];
      if (!previousId || !previous) return;
      const result = await applyEdit([...titleUpdate(entry, title), { op: 'merge', id: entry.item.id, previousId }]);
      const kept = previous.item.title;
      await editRow(list.parentId, result.focusId, kept.length + (kept && title ? 1 : 0));
    },
    addAbove: ({ entry, list, path, parent }) => {
      openComposer({ parentId: list.parentId, beforeId: entry.item.id, project: parent?.item.project ?? null, path, anchor: entry.item.id });
    },
    paste,
    pasteBelow: async ({ entry, list }, lines) => {
      const id = entry.item.id;
      const below = (b: Branch) => insertBelow(b, b.entries.findIndex((e) => e.item.id === id));
      const next = below(await loadUntil(list.parentId, (b) => !('needs' in below(b))));
      await paste({ parentId: list.parentId, beforeId: 'id' in next ? next.id : null, project: null }, lines, [id]);
    },
    style: ({ entry }, patch) => void applyEdit([{ op: 'presentation', id: entry.item.id, patch }]).catch(fail),
    check: ({ entry }, checked) => void applyEdit([{ op: 'check', id: entry.item.id, checked }]).catch(fail),
    reset: ({ entry }) => {
      call('presentation.reset', entry.item.id).then(({ updated }) => toast(`Unchecked ${updated}`), fail);
    },
    dialog: (next) => setRowDialog(next),
    toggle: (id, open) => {
      if (open) {
        expanded.add(id);
        void refresh(id);
      } else {
        expanded.delete(id);
        if (composer?.path.includes(id)) setComposer(null);
      }
      rerender();
    },
    open: (id) => openItem(id),
    moveUp: ({ entry, list }) => runMove(entry, list.parentId, list.parentId, atFresh(entry, planMoveUp)),
    moveDown: ({ entry, list }) => runMove(entry, list.parentId, list.parentId, atFresh(entry, planMoveDown)),
    indent: ({ entry, list }) => runMove(entry, list.parentId, list.parentId, atFresh(entry, planIndent)),
    outdent: ({ entry, list, path }) => {
      const parentId = path.at(-1);
      if (!parentId) return;
      runMove(entry, list.parentId, path.at(-2) ?? null, (b) => {
        const at = b.entries.findIndex((e) => e.item.id === parentId);
        return at < 0 ? null : planOutdent(b, at);
      });
    },
    moveTo: ({ entry }) => setMoving(entry),
    addInside: ({ entry, path }) => {
      const id = entry.item.id;
      expanded.add(id);
      const opened = { parentId: id, project: entry.item.project, path: [...path, id], anchor: id };
      if (entry.childCount === 0) {
        openComposer({ ...opened, beforeId: null });
        return;
      }
      refresh(id).then(() => {
        const branch = branches.current.get(id);
        openComposer({ ...opened, beforeId: branch ? firstAnchor(branch) : null });
      }, fail);
    },
    addBelow: ({ entry, list, path, parent }) => {
      const id = entry.item.id;
      const below = (b: Branch) => insertBelow(b, b.entries.findIndex((e) => e.item.id === id));
      loadUntil(list.parentId, (b) => !('needs' in below(b))).then((branch) => {
        const next = below(branch);
        openComposer({ parentId: list.parentId, beforeId: 'id' in next ? next.id : null, project: parent?.item.project ?? null, path, anchor: id });
      }, fail);
    },
    loadMore: (parentId) => {
      const branch = branches.current.get(keyOf(parentId));
      if (branch) void refresh(parentId, branch.entries.length + PAGE_SIZE);
    },
    retry: (parentId) => void refresh(parentId),
    create: async (at, title, body) => {
      const listed = branches.current.get(keyOf(at.parentId));
      const beforeId = at.beforeId && listed?.entries.some((e) => e.item.id === at.beforeId) ? at.beforeId : null;
      const result = await applyEdit([{
        op: 'create', parentId: at.parentId, beforeId, title: title || undefined, body: body || undefined, project: at.project?.id,
      }]);
      const id = result.createdIds[0] ?? result.focusId;
      if (at.parentId) expanded.add(at.parentId);
      await refresh(at.parentId);
      await loadUntil(at.parentId, contains(id));
      setComposer((current) => (current?.n === at.n ? { ...current, beforeId, last: id } : current));
      setFlash(id);
    },
    closeComposer: () => {
      const target = composer?.last ?? composer?.anchor;
      setComposer(null);
      if (target) focusRow(target);
      else newButton.current?.focus();
    },
    fail,
    onRowKey: (event, row, open) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      const movable = organizable(row.entry);
      if (event.key === 'F2' && movable && !isSecret(row.entry.item)) {
        event.preventDefault();
        setEditing({ id: row.entry.item.id });
        return;
      }
      const step = (delta: number) => {
        const rows = [...(container.current?.querySelectorAll<HTMLElement>('[data-outline-main]') ?? [])];
        rows[rows.indexOf(event.currentTarget) + delta]?.focus();
      };
      const keys: Record<string, (() => void) | undefined> = event.altKey
        ? {
            ArrowUp: movable ? () => api.moveUp(row) : undefined,
            ArrowDown: movable ? () => api.moveDown(row) : undefined,
            ArrowRight: movable ? () => api.indent(row) : undefined,
            ArrowLeft: movable && row.path.length > 0 ? () => api.outdent(row) : undefined,
          }
        : {
            ArrowDown: () => step(1),
            ArrowUp: () => step(-1),
            ArrowRight: () => (open ? step(1) : row.entry.childCount > 0 && api.toggle(row.entry.item.id, true)),
            ArrowLeft: () => (open ? api.toggle(row.entry.item.id, false) : row.path.length > 0 && focusRow(row.path.at(-1)!)),
          };
      const action = keys[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    },
  };

  const onMoved = (moved: Moved | null) => {
    const entry = moving!;
    setMoving(null);
    if (!moved) {
      focusRow(entry.item.id);
      return;
    }
    toast(moved.parentId ? `Moved into ${moved.title}` : 'Moved to the top level');
    revealItem(entry.item.id).catch(fail);
  };

  const root = branches.current.get(ROOT);
  return (
    <OutlineContext.Provider value={api}>
      <div className="page outline-page">
        <header className="page-header">
          <h1>Outline</h1>
          <p className="subtitle">Everything in your library, in the order you choose. Put notes, links and files inside each other; decisions stay where they were recorded.</p>
        </header>
        <div className="toolbar">
          <button ref={newButton} className="button primary small" onClick={newNote}>
            <Icon name="plus" size={14} /> New note
          </button>
          <button className="button small" onClick={() => setNewSecret(true)}>
            <Icon name="lock" size={14} /> New secret note
          </button>
          <UndoRedo />
          <select aria-label="Show" value={focus} onChange={(event) => setFocus(event.target.value as Focus)}>
            <option value="all">Whole outline</option>
            <option value="review">Marked for review</option>
            <option value="high">High attention</option>
          </select>
          {focus === 'all' && (
            <label className="check">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => {
                  setComposer(null);
                  setArchived(event.target.checked);
                }}
              /> Show archived
            </label>
          )}
          {focus === 'all' && root?.loaded && <span className="muted small">{root.total.toLocaleString()} at the top level</span>}
        </div>
        {focus === 'all' ? (
          <div className="outline" ref={container}>
            {root?.loaded && root.total === 0 && composer?.parentId !== null && (
              <Empty title="Nothing here yet" action={<button className="button" onClick={newNote}>Write the first note</button>}>
                Start with a note, then add notes inside it. Links, files and notes you save anywhere else show up here too.
              </Empty>
            )}
            <Rows parentId={null} depth={0} path={[]} parent={null} />
          </div>
        ) : (
          <FocusList focus={focus} />
        )}
        <p className="outline-keys muted small">
          <kbd>↑</kbd> <kbd>↓</kbd> between rows · <kbd>←</kbd> <kbd>→</kbd> collapse and expand · <kbd>{ALT}↑</kbd> <kbd>{ALT}↓</kbd> reorder ·{' '}
          <kbd>{ALT}→</kbd> indent · <kbd>{ALT}←</kbd> outdent · <kbd>F2</kbd> rename (<kbd>↵</kbd> there splits at the caret, <kbd>⌫</kbd> at the start
          joins the note above) · <kbd>{MOD}Z</kbd> <kbd>{isMac ? '⌘⇧Z' : 'Ctrl+Y'}</kbd> undo and redo outline changes · <kbd>↵</kbd> open · paste
          several lines to add nested notes
        </p>
      </div>
      {moving && <MoveDialog entry={moving} onClose={onMoved} />}
      {rowDialog?.kind === 'ai' && <AiEditDialog rootId={rowDialog.entry.item.id} title={displayTitle(rowDialog.entry.item)} onClose={() => setRowDialog(null)} />}
      {rowDialog?.kind === 'share' && <ShareDialog rootId={rowDialog.entry.item.id} title={displayTitle(rowDialog.entry.item)} onClose={() => setRowDialog(null)} />}
      {rowDialog?.kind === 'secret' && (
        <SecretNoteDialog parentId={rowDialog.entry.item.id} onClose={(created) => {
          setRowDialog(null);
          if (created) revealItem(created.id).catch(fail);
        }} />
      )}
      {newSecret && (
        <SecretNoteDialog onClose={(created) => {
          setNewSecret(false);
          if (created) revealItem(created.id).catch(fail);
        }} />
      )}
    </OutlineContext.Provider>
  );
}

/** A flat list of what's marked for review or needs attention, wherever it sits in the outline. */
function FocusList({ focus }: { focus: Exclude<Focus, 'all'> }) {
  return (
    <PagedItems
      key={focus}
      filter={focus === 'review' ? { review: true } : { attention: 'high' }}
      empty={(
        <Empty title={focus === 'review' ? 'Nothing to review' : 'Nothing needs attention'}>
          {focus === 'review' ? 'Mark notes for review from their actions menu or details.' : 'Set attention to High from a note’s actions menu or details.'}
        </Empty>
      )}
    />
  );
}

/** Structural undo and redo for outline changes; typing undo stays with the field being edited. */
function UndoRedo() {
  const { history, undo, redo } = useUndoRedo();
  return (
    <span className="toolbar-group" role="group" aria-label="Outline history">
      <button className="button small" disabled={!history.undo || history.busy} onClick={undo}
        title={history.undo ? `Undo ${history.undo.label} (${MOD}Z)` : 'Nothing to undo'}>
        Undo{history.undo ? ` ${history.undo.label}` : ''}
      </button>
      <button className="button small" disabled={!history.redo || history.busy} onClick={redo}
        title={history.redo ? `Redo ${history.redo.label} (${isMac ? '⌘⇧Z' : 'Ctrl+Y'})` : 'Nothing to redo'}>
        Redo{history.redo ? ` ${history.redo.label}` : ''}
      </button>
    </span>
  );
}

function Rows({ parentId, depth, path, parent }: { parentId: string | null; depth: number; path: string[]; parent: OutlineEntry | null }) {
  const o = useContext(OutlineContext);
  const branch = o.branch(parentId);
  const entries = branch?.entries ?? [];
  const composer = o.composer?.parentId === parentId ? o.composer : null;
  const composerBefore = composer?.beforeId && entries.some((e) => e.item.id === composer.beforeId) ? composer.beforeId : null;
  if (parent && !composer && (branch?.loaded ? branch.total === 0 : parent.childCount === 0)) return null;
  const status = (content: React.ReactNode) => <li className="outline-status" style={depthStyle(depth)}>{content}</li>;
  const checklist = parent ? presentationOf(parent.item) : null;
  const hiding = Boolean(checklist?.checklist && checklist.hideCompleted);
  const hidden = hiding ? entries.filter((e) => isChecked(e.item)).length : 0;
  return (
    <ul className="outline-list" id={parent ? `outline-children-${parent.item.id}` : undefined} aria-label={parent ? `Inside ${displayTitle(parent.item)}` : 'Outline'}>
      {entries.map((entry, index) => (
        <Fragment key={entry.item.id}>
          {composer && composerBefore === entry.item.id && <Composer key={composer.n} insertion={composer} depth={depth} />}
          {!(hiding && isChecked(entry.item)) && (
            <Row entry={entry} list={branch!} index={index} depth={depth} path={path} parent={parent} />
          )}
        </Fragment>
      ))}
      {hidden > 0 && status(
        <>
          <span className="muted small">{hidden} completed hidden</span>
          <button className="button small" onClick={() => void call('presentation.update', parent!.item.id, { hideCompleted: false }).catch(o.fail)}>Show</button>
        </>,
      )}
      {composer && composerBefore === null && <Composer key={composer.n} insertion={composer} depth={depth} />}
      {!branch?.loaded && !branch?.error && (!parent || parent.childCount > 0) && status(<span className="muted">Loading…</span>)}
      {branch?.error && status(
        <>
          <span className="error-text">{branch.error}</span>
          <button className="button small" onClick={() => o.retry(parentId)}>Try again</button>
        </>,
      )}
      {branch?.loaded && !branch.error && branch.entries.length < branch.total && status(
        <>
          <button className="button small" onClick={() => o.loadMore(parentId)}>Show more</button>
          <span className="muted small">{(branch.total - branch.entries.length).toLocaleString()} not shown yet</span>
        </>,
      )}
    </ul>
  );
}

function Row({ entry, list, index, depth, path, parent }: RowInfo & { depth: number }) {
  const o = useContext(OutlineContext);
  const { item } = entry;
  const id = item.id;
  const open = o.isOpen(id);
  const title = readableText(displayTitle(item));
  const preview = item.title ? readableText(firstLine(item.body, 160)) : '';
  const site = item.type === 'bookmark' ? siteOf(item.url) : '';
  const row: RowInfo = { entry, list, index, path, parent };
  const can: Abilities | null = organizable(entry)
    ? { up: planMoveUp(list, index) !== null, down: planMoveDown(list, index) !== null, indent: planIndent(list, index) !== null, outdent: path.length > 0 }
    : null;
  const style = presentationOf(item);
  const secret = isSecret(item);
  const checkable = !secret && parent !== null && presentationOf(parent.item).checklist && organizable(entry);
  // An open row's own list is fresher than the count its parent's list carried.
  const children = open && o.branch(id)?.loaded ? o.branch(id)!.total : entry.childCount;
  const hasChildren = children > 0 || o.composer?.parentId === id;
  const classes = [
    'outline-row', `kind-${style.kind}`, `attention-${style.attention}`,
    item.archivedAt ? 'archived' : '', checkable && isChecked(item) ? 'checked' : '', o.flash === id ? 'flash' : '',
  ].filter(Boolean).join(' ');
  return (
    <li className="outline-node">
      <div className={classes} style={depthStyle(depth)}>
        {hasChildren ? (
          <button
            className={`outline-toggle ${open ? 'open' : ''}`}
            aria-expanded={open}
            aria-controls={`outline-children-${id}`}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
            title={`${children} inside`}
            onClick={() => o.toggle(id, !open)}
          >
            <Icon name="chevron" size={14} />
          </button>
        ) : (
          <span className="outline-toggle" aria-hidden="true" />
        )}
        {checkable && (
          <input
            type="checkbox"
            className="outline-check"
            aria-label={`Done: ${title}`}
            checked={isChecked(item)}
            onChange={(event) => o.check(row, event.target.checked)}
          />
        )}
        {o.editing?.id === id ? (
          <RowEditor row={row} caret={o.editing?.caret} />
        ) : (
        <button
          className="outline-main"
          data-outline-main={id}
          aria-label={title}
          onClick={() => o.open(id)}
          onDoubleClick={(event) => {
            if (!organizable(entry) || secret) return;
            event.preventDefault();
            o.edit(id);
          }}
          onKeyDown={(event) => o.onRowKey(event, row, open)}
        >
          {secret ? <Icon name="lock" size={16} /> : <TypeIcon type={item.type} size={16} />}
          <span className="outline-text">
            <span className="outline-title">{title}</span>
            {preview && style.kind !== 'section' && <span className="outline-preview">{preview}</span>}
          </span>
          <span className="outline-meta">
            {style.checklist && <ChecklistProgress id={id} />}
            {style.attention === 'high' && <span className="meta-flag"><Icon name="star" size={12} /> High</span>}
            {style.review && <span className="meta-flag"><Icon name="flag" size={12} /> Review</span>}
            {style.autoOrganize && <span className="meta-flag"><Icon name="sparkle" size={12} /> Auto</span>}
            {secret && <span>Secret</span>}
            {!open && entry.childCount > 0 && <span className="outline-count">{entry.childCount}</span>}
            {item.type !== 'note' && <span>{TYPE_LABELS[item.type]}</span>}
            {site && <span>{site}</span>}
            {item.project && <span className="project-chip">{item.project.name}</span>}
            {item.archivedAt && <span>Archived</span>}
          </span>
        </button>
        )}
        {can && (
          <div className="outline-quick">
            <Quick icon="up" label="Move up" shown={can.up} onClick={() => o.moveUp(row)} />
            <Quick icon="down" label="Move down" shown={can.down} onClick={() => o.moveDown(row)} />
            <Quick icon="outdent" label="Outdent" shown={can.outdent} onClick={() => o.outdent(row)} />
            <Quick icon="indent" label="Indent" shown={can.indent} onClick={() => o.indent(row)} />
            <Quick icon="plus" label="Add note inside" shown={!secret} onClick={() => o.addInside(row)} />
          </div>
        )}
        <RowMenu row={row} title={title} can={can} />
      </div>
      {open && <Rows parentId={id} depth={depth + 1} path={[...path, id]} parent={entry} />}
    </li>
  );
}

/** Mouse shortcuts; the actions menu and row shortcuts cover the keyboard, so these stay out of the tab order. */
function Quick({ icon, label, shown, onClick }: { icon: IconName; label: string; shown: boolean; onClick: () => void }) {
  if (!shown) return <span className="outline-quick-gap" />;
  return (
    <button className="icon-button" tabIndex={-1} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  );
}

function RowMenu({ row, title, can }: { row: RowInfo; title: string; can: Abilities | null }) {
  const o = useContext(OutlineContext);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { item } = row.entry;

  const secret = isSecret(item);
  const style = presentationOf(item);
  const actions: { label: string; keys?: string; group?: boolean; run: () => void }[] = [];
  const add = (label: string, run: () => void, keys?: string) => actions.push({ label, run, keys });
  const group = () => {
    if (actions.length) actions[actions.length - 1]!.group = true;
  };
  if (can && !secret) add('Add note inside', () => o.addInside(row));
  if (!item.archivedAt && row.parent?.item.metadata.secret !== true) add('Add note above', () => o.addAbove(row));
  if (!item.archivedAt && row.parent?.item.metadata.secret !== true) add('Add note below', () => o.addBelow(row));
  if (can) add('Add secret note inside', () => o.dialog({ kind: 'secret', entry: row.entry }));
  group();
  if (can && !secret) add('Rename', () => o.edit(item.id), 'F2');
  if (mergeTarget(row.list, row.index)) add('Join with note above', () => void o.merge(row, item.title).catch(o.fail));
  if (can?.up) add('Move up', () => o.moveUp(row), `${ALT}↑`);
  if (can?.down) add('Move down', () => o.moveDown(row), `${ALT}↓`);
  if (can?.indent) add('Indent', () => o.indent(row), `${ALT}→`);
  if (can?.outdent) add('Outdent', () => o.outdent(row), `${ALT}←`);
  if (can) add('Move to…', () => o.moveTo(row));
  group();
  if (can && !secret) {
    for (const kind of Object.keys(KIND_LABELS) as ItemPresentation['kind'][]) {
      if (kind !== style.kind) add(`Show as ${KIND_LABELS[kind].toLowerCase()}`, () => o.style(row, { kind }));
    }
    for (const attention of ['high', 'normal', 'low'] as const) {
      if (attention !== style.attention) add(`${ATTENTION_LABELS[attention]} attention`, () => o.style(row, { attention }));
    }
    add(style.review ? 'Clear review mark' : 'Mark for review', () => o.style(row, { review: !style.review }));
    add(style.checklist ? 'Stop being a checklist' : 'Make a checklist', () => o.style(row, { checklist: !style.checklist }));
    if (style.checklist) {
      add(style.hideCompleted ? 'Show completed' : 'Hide completed', () => o.style(row, { hideCompleted: !style.hideCompleted }));
      add('Reset checklist', () => o.reset(row));
    }
    group();
    if (o.aiEnabled) {
      add('Edit with AI…', () => o.dialog({ kind: 'ai', entry: row.entry }));
      if (row.path.length === 0) {
        add(style.autoOrganize ? 'Stop organizing automatically' : 'Organize automatically with AI', () => o.style(row, { autoOrganize: !style.autoOrganize }));
      }
    }
  }
  if (!secret) add('Share…', () => o.dialog({ kind: 'share', entry: row.entry }));
  add('Open details', () => o.open(item.id), '↵');

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onMenuKey = (event: React.KeyboardEvent) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => items[(index + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      trigger.current?.focus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="menu-root" ref={root}>
      <button
        ref={trigger}
        className="icon-button outline-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${title}`}
        title="Actions"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="menu outline-menu" role="menu" aria-label={`Actions for ${title}`} onKeyDown={onMenuKey}>
          {actions.map((action, index) => (
            <Fragment key={action.label}>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  action.run();
                }}
              >
                <span>{action.label}</span>
                {action.keys && <kbd>{action.keys}</kbd>}
              </button>
              {action.group && index < actions.length - 1 && <div role="separator" className="menu-separator" />}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function ChecklistProgress({ id }: { id: string }) {
  const progress = useLive(() => call('presentation.progress', id), [id]);
  if (!progress.data?.total) return null;
  return <span className="outline-progress" title="Checked off">{progress.data.done}/{progress.data.total}</span>;
}

/**
 * Renames a row in place. Leaving the field saves and Escape cancels. In a note, Enter splits the title at the caret (or,
 * at either end, opens a new note there) and Backspace at the start joins it onto the note above. Pasting several lines
 * adds rows below.
 */
function RowEditor({ row, caret }: { row: RowInfo; caret?: number }) {
  const o = useContext(OutlineContext);
  const { item } = row.entry;
  const [value, setValue] = useState(item.title || displayTitle(item));
  const [saving, setSaving] = useState(false);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const note = item.type === 'note' && !isSecret(item);

  useEffect(() => {
    if (caret !== undefined) input.current?.setSelectionRange(caret, caret);
  }, []);

  /** Runs a structural change instead of the plain rename; a failure leaves the draft in the field. */
  const structural = (change: () => Promise<void>) => {
    if (done.current || saving) return;
    done.current = true;
    setSaving(true);
    change().catch((error: unknown) => {
      done.current = false;
      setSaving(false);
      o.fail(error);
      input.current?.focus();
    });
  };

  const save = () => {
    if (done.current || saving) return;
    const title = value.trim();
    if (title === item.title || !title) {
      done.current = true;
      o.edit(null);
      return;
    }
    setSaving(true);
    o.rename(row, title).then(() => {
      done.current = true;
    }, (error: unknown) => {
      setSaving(false);
      o.fail(error);
    });
  };

  const enter = (at: number) => {
    const action = enterAction(value, at);
    if (action === 'split') {
      structural(() => o.split(row, value, at));
      return;
    }
    const title = value.trim();
    structural(async () => {
      if (title && title !== item.title) await o.rename(row, title);
      else o.edit(null);
      if (action === 'below') o.addBelow(row);
      else o.addAbove(row);
    });
  };

  return (
    <input
      ref={input}
      className="outline-edit"
      autoFocus
      aria-label="Title"
      value={value}
      readOnly={saving}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const { selectionStart, selectionEnd } = event.currentTarget;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (note && !event.shiftKey && selectionStart !== null && selectionStart === selectionEnd) enter(selectionStart);
          else save();
        } else if (event.key === 'Backspace' && note && selectionStart === 0 && selectionEnd === 0 && mergeTarget(row.list, row.index)) {
          event.preventDefault();
          structural(() => o.merge(row, value));
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          done.current = true;
          o.edit(null);
        }
      }}
      onPaste={(event) => {
        const lines = parsePastedOutline(event.clipboardData.getData('text/plain'));
        if (lines.length < 2) return;
        event.preventDefault();
        const field = event.currentTarget;
        const start = field.selectionStart ?? value.length;
        setValue(`${value.slice(0, start)}${lines[0]!.title}${value.slice(field.selectionEnd ?? start)}`);
        o.pasteBelow(row, lines.slice(1).map((line) => ({ ...line, depth: Math.max(0, line.depth - lines[0]!.depth) }))).catch(o.fail);
      }}
    />
  );
}

function Composer({ insertion, depth }: { insertion: Insertion; depth: number }) {
  const o = useContext(OutlineContext);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [details, setDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const empty = !title.trim() && !body.trim();
  // A create in flight finishes in this composer, so it can't be closed underneath it.
  const close = () => {
    if (!saving) o.closeComposer();
  };

  const save = async () => {
    if (saving || empty) return;
    setSaving(true);
    try {
      await o.create(insertion, title.trim(), body.trim() ? body : '');
      setTitle('');
      setBody('');
      setDetails(false);
    } catch (error) {
      o.fail(error);
    } finally {
      setSaving(false);
      titleInput.current?.focus();
    }
  };

  const onKey = (event: React.KeyboardEvent, multiline: boolean) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      if (multiline && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (!multiline && event.shiftKey) setDetails(true);
      else void save();
    }
  };

  return (
    <li className="outline-composer" style={depthStyle(depth)}>
      <span className="outline-toggle" aria-hidden="true" />
      <form
        aria-label={insertion.parentId ? 'New note inside' : 'New note'}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          ref={titleInput}
          autoFocus
          aria-label="Note title"
          placeholder="Name this note"
          value={title}
          readOnly={saving}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => onKey(event, false)}
          onPaste={(event) => {
            const lines = parsePastedOutline(event.clipboardData.getData('text/plain'));
            if (lines.length < 2 || saving) return;
            event.preventDefault();
            setSaving(true);
            o.paste(insertion, lines).catch(o.fail).finally(() => {
              setSaving(false);
              titleInput.current?.focus();
            });
          }}
        />
        {details && (
          <textarea
            autoFocus
            aria-label="Note details"
            rows={3}
            placeholder="Details, if you want them. Plain text is fine; Markdown works too."
            value={body}
            readOnly={saving}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => onKey(event, true)}
          />
        )}
        <div className="outline-composer-bar">
          <button type="submit" className="button primary small" disabled={empty || saving}>Save</button>
          {!details && <button type="button" className="button ghost small" onClick={() => setDetails(true)}>Add details</button>}
          <button type="button" className="button ghost small" disabled={saving} onClick={close}>Cancel</button>
          <span className="muted small">
            {details ? `${isMac ? '⌘↵' : 'Ctrl+↵'} to save` : '↵ to save, ⇧↵ for details'} · esc to cancel{insertion.project ? ` · Files into ${insertion.project.name}` : ''}
          </span>
        </div>
      </form>
    </li>
  );
}
