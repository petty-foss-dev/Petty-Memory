import type { ItemType, Project } from '@enve-memory/core';
import {
  type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppContext, type AppState } from './context.ts';
import { call } from './lib/api.ts';
import type { ControlledValue, MarkdownEditor as SharedEditor } from '@enve-memory/editor';
import '@enve-memory/editor/editor.css';
import { createMarkdown } from './lib/markdown.ts';

const PATHS = {
  note: 'M7 3h7l5 5v13H7zM14 3v5h5M10 12h6M10 16h6',
  bookmark: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  task: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0zM8.5 12.5l2.5 2.5 4.5-5',
  decision: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 3v18M4 7.5l8 4.5 8-4.5',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  inbox: 'M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2h4l1-2h5',
  project: 'M3 7h7l2 2h9v10H3z',
  library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.8 1 -3.6 14-3.8-1',
  tasks: 'M5 4h14v16H5zM8.5 12l2.5 2.5 4.5-5',
  ask: 'M12 3l1.8 4.9L19 9.5l-5.2 1.7L12 16l-1.8-4.8L5 9.5l5.2-1.6zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  check: 'M5 12.5l4.5 4.5L19 7',
  sparkle: 'M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  refresh: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  pin: 'M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  read: 'M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1zM12 6v14',
  watch: 'M4 5h16v14H4zM10 9l5 3-5 3z',
  buy: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  revisit: 'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
  unopened: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  graph: 'M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 7.8l4 8.4M16.8 9.6l-3.8 6.8M8 6.3l8 1.4',
  outline: 'M4 5h12M8 10h12M8 15h12M12 20h8',
  chevron: 'M9 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  indent: 'M4 5h16M10 12h10M4 19h16M4 9l3 3-3 3',
  outdent: 'M4 5h16M10 12h10M4 19h16M7 9l-3 3 3 3',
  more: 'M5.5 12h1M11.5 12h1M17.5 12h1',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  share: 'M4 13v7h16v-7M12 3v12M8 7l4-4 4 4',
  flag: 'M5 21V4h12l-2.5 4L17 12H5',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export const TypeIcon = ({ type, size }: { type: ItemType; size?: number }) => <Icon name={type} size={size} className={`type-${type}`} />;

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

const markdown = createMarkdown(window as unknown as Parameters<typeof createMarkdown>[0]);

/** Rendered untrusted Markdown. Web links open in the system browser through main; item references open in the app. */
export function MarkdownView({ source, baseUrl, className, titles }: {
  source: string;
  baseUrl?: string | null;
  className?: string;
  titles?: ReadonlyMap<string, string>;
}) {
  const app = useContext(AppContext) as AppState | null;
  const html = useMemo(() => markdown.render(source, { baseUrl, titles }), [source, baseUrl, titles]);
  return (
    <div
      className={`markdown ${className ?? ''}`}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor) return;
        event.preventDefault();
        const item = anchor.getAttribute('data-item');
        if (item) {
          app?.openItem(item);
          return;
        }
        const href = anchor.getAttribute('href');
        if (href) void call('app.openExternal', href);
      }}
      // Sanitized by DOMPurify in createMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export type EditorHandle = Pick<SharedEditor, 'insertReference' | 'focus' | 'getMarkdown'>;

// Loaded on first use, so the editor's ProseMirror and Markdown code stays out of the app's first chunk.
const loadEditor = () => import('@enve-memory/editor');

/**
 * The shared formatted editor. The draft stays Markdown. `value` echoes of the editor's own changes can arrive after later
 * keystrokes, so only values it didn't emit (discard, a clean server update) replace the content.
 */
export function MarkdownEditor({ value, onChange, placeholder, rows = 10, label, onSubmit, editorRef, titles }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  label: string;
  onSubmit?: () => void;
  editorRef?: React.RefObject<EditorHandle | null>;
  titles?: ReadonlyMap<string, string>;
}) {
  const app = useContext(AppContext) as AppState | null;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<SharedEditor | null>(null);
  const sync = useRef<ControlledValue | null>(null);
  const [linkRequest, setLinkRequest] = useState<{ current: string | null; resolve: (href: string | null) => void } | null>(null);
  const latest = useRef({ value, onChange, onSubmit, titles, app });
  latest.current = { value, onChange, onSubmit, titles, app };

  useEffect(() => {
    let instance: SharedEditor | null = null;
    let gone = false;
    void loadEditor().then(({ controlledValue, createMarkdownEditor }) => {
      if (gone || !host.current) return;
      instance = createMarkdownEditor(host.current, {
        markdown: latest.current.value,
        label,
        placeholder,
        referenceTitle: (id) => latest.current.titles?.get(id),
        requestLink: (current) => new Promise((resolve) => setLinkRequest({ current, resolve })),
        onChange: (markdown) => {
          sync.current?.emitted(markdown);
          latest.current.onChange(markdown);
        },
        onSubmit: () => latest.current.onSubmit?.(),
        onOpenReference: (id) => latest.current.app?.openItem(id),
        onOpenLink: (href) => void call('app.openExternal', href),
      });
      sync.current = controlledValue(instance);
      editor.current = instance;
      if (editorRef) editorRef.current = instance;
    });
    return () => {
      gone = true;
      instance?.destroy();
      editor.current = null;
      sync.current = null;
      if (editorRef) editorRef.current = null;
    };
  }, []);
  useEffect(() => {
    sync.current?.receive(value);
  }, [value]);
  useEffect(() => editor.current?.refreshReferences(), [titles]);

  return (
    <>
      <div ref={host} className="md-editor" style={{ '--pm-min-height': `${rows * 1.55}em` } as React.CSSProperties} />
      {linkRequest && (
        <LinkDialog
          current={linkRequest.current}
          onClose={(href) => {
            linkRequest.resolve(href);
            setLinkRequest(null);
          }}
        />
      )}
    </>
  );
}

/** Asks for a link target; an empty answer removes the link, null cancels. */
function LinkDialog({ current, onClose }: { current: string | null; onClose: (href: string | null) => void }) {
  const [text, setText] = useState(current ?? '');
  const [normalize, setNormalize] = useState<((input: string) => string | null) | null>(null);
  useEffect(() => void loadEditor().then(({ normalizeLink }) => setNormalize(() => normalizeLink)), []);
  const target = text.trim() && normalize ? normalize(text) : null;
  const submit = () => {
    if (target) onClose(target);
  };
  return (
    <Modal label={current ? 'Edit link' : 'Add link'} onClose={() => onClose(null)}>
      <h2>{current ? 'Edit link' : 'Add link'}</h2>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="field">
          <span>Web or email address</span>
          <input autoFocus type="text" inputMode="url" value={text} placeholder="https://…" onChange={(event) => setText(event.target.value)} aria-invalid={Boolean(text.trim()) && !target} />
        </label>
        {text.trim() && !target && <p className="error-text small">Use a web address (https://…) or an email address.</p>}
        <div className="dialog-actions">
          {current && <button type="button" className="button ghost" onClick={() => onClose('')}>Remove link</button>}
          <button type="button" className="button ghost" onClick={() => onClose(null)}>Cancel</button>
          <button type="submit" className="button primary" disabled={!target}>{current ? 'Update link' : 'Add link'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectSelect({ value, onChange, projects, emptyLabel = 'No project (Inbox)', label = 'Project', className }: {
  value: string | null;
  onChange: (projectId: string | null) => void;
  projects: Project[];
  emptyLabel?: string;
  label?: string;
  className?: string;
}) {
  return (
    <select aria-label={label} className={className} value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{emptyLabel}</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>{project.name}</option>
      ))}
    </select>
  );
}

export function TagEditor({ tags, onAdd, onRemove }: { tags: string[]; onAdd: (tag: string) => void; onRemove: (tag: string) => void }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    for (const tag of draft.split(',').map((t) => t.trim()).filter(Boolean)) onAdd(tag);
    setDraft('');
  };
  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          #{tag}
          <button aria-label={`Remove tag ${tag}`} onClick={() => onRemove(tag)}><Icon name="close" size={12} /></button>
        </span>
      ))}
      <input
        aria-label="Add tag"
        value={draft}
        placeholder={tags.length ? 'Add tag' : 'Add tags (Enter or comma)'}
        onChange={(event) => {
          const parts = event.target.value.split(',');
          const rest = parts.pop()!;
          for (const tag of parts.map((t) => t.trim()).filter(Boolean)) onAdd(tag);
          setDraft(rest);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Backspace' && !draft && tags.length) onRemove(tags[tags.length - 1]!);
        }}
        onBlur={() => draft.trim() && commit()}
      />
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="button ghost small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : label}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** The user must type this word to enable the confirm button. */
  typeToConfirm?: string;
}

interface Feedback {
  toast: (message: string, tone?: Toast['tone']) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<Feedback>({ toast: () => {}, confirm: async () => false });
export const useFeedback = () => useContext(FeedbackContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const next = useRef(1);

  const toast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = next.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...options, resolve })), []);
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.message}</div>)}
      </div>
      {dialog && (
        <ConfirmDialog
          options={dialog}
          onClose={(ok) => {
            dialog.resolve(ok);
            setDialog(null);
          }}
        />
      )}
    </FeedbackContext.Provider>
  );
}

function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const ready = !options.typeToConfirm || typed.trim().toLowerCase() === options.typeToConfirm.toLowerCase();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{options.title}</h2>
        <div className="dialog-body">{options.body}</div>
        {options.typeToConfirm && (
          <label className="field">
            <span>Type <strong>{options.typeToConfirm}</strong> to confirm</span>
            <input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} aria-label="Confirmation word" />
          </label>
        )}
        <div className="dialog-actions">
          <button className="button ghost" onClick={() => onClose(false)} autoFocus={!options.typeToConfirm}>Cancel</button>
          <button className={`button ${options.danger ? 'danger' : 'primary'}`} disabled={!ready} onClick={() => onClose(true)}>
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** A modal dialog: Escape and the scrim close it (unless `busy`), Tab stays inside, focus returns to the opener. */
export function Modal({ label, onClose, busy = false, className, children }: {
  label: string;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const close = () => {
    if (!busy) onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  useEffect(() => () => {
    if (opener?.isConnected) opener.focus();
  }, [opener]);
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={box}
        className={`dialog ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || !box.current) return;
          const focusable = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
          if (event.shiftKey && document.activeElement === focusable[0]) {
            event.preventDefault();
            focusable.at(-1)?.focus();
          } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
            event.preventDefault();
            focusable[0]?.focus();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Keeps a local draft of a server value; outside changes replace it only while the user isn't editing. */
export function useDraft(value: string | undefined): { draft: string; setDraft: (next: string) => void; dirty: boolean; reset: () => void } {
  const [draft, setDraftState] = useState(value ?? '');
  const [editing, setEditing] = useState(false);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    if (value === undefined) return;
    if (!editing || latest.current === value) {
      setDraftState(value);
      setEditing(false);
    }
  }, [value]);
  return {
    draft,
    setDraft: (next) => {
      setDraftState(next);
      setEditing(true);
    },
    dirty: value !== undefined && draft !== value,
    reset: () => {
      setDraftState(value ?? '');
      setEditing(false);
    },
  };
}
