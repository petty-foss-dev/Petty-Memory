import { useEffect, useState } from 'react';
import type { SavedConversation } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { Empty, Modal, useFeedback } from '../ui.tsx';

export const MODE_LABELS: Record<SavedConversation['mode'], string> = {
  ask: 'Ask', edit: 'Change notes', organize: 'Organize library', actions: 'Suggest actions',
};

/** Core lists at most this many, newest first. */
const MAX_LISTED = 100;

/** Saved chats, newest first, searchable across every saved chat, to reopen or archive. */
export function SavedChatsDialog({ currentId, onOpen, onArchived, onClose }: {
  currentId: string | null;
  onOpen: (id: string) => void;
  onArchived: (id: string) => void;
  onClose: () => void;
}) {
  const { toast } = useFeedback();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  // useLive drops replies to searches superseded while in flight; tagging each reply tells whether it answers the box as typed.
  const list = useLive(() => call('chats.list', search ? { query: search } : {}).then((chats) => ({ search, chats })), [search]);
  const [archiving, setArchiving] = useState<string | null>(null);
  const chats = list.data?.chats;
  const fresh = list.data?.search === search && query.trim() === search;

  useEffect(() => {
    const text = query.trim();
    const timer = setTimeout(() => setSearch(text), text ? 200 : 0);
    return () => clearTimeout(timer);
  }, [query]);

  const archive = (conversation: SavedConversation) => {
    setArchiving(conversation.id);
    call('chats.archive', conversation.id).then(() => {
      toast(`Archived “${conversation.title}”`);
      onArchived(conversation.id);
    }, (err: unknown) => toast(errorMessage(err), 'error')).finally(() => setArchiving(null));
  };

  return (
    <Modal label="Saved chats" onClose={onClose} className="move-dialog saved-chats">
      <h2>Saved chats</h2>
      <input
        type="search"
        autoFocus
        aria-label="Search saved chats"
        placeholder="Search all saved chats…"
        value={query}
        maxLength={500}
        onChange={(event) => setQuery(event.target.value)}
      />
      {list.error && (
        <div className="error-box" role="alert">
          <p>{list.error.message}</p>
          <button className="button small" onClick={list.reload}>Try again</button>
        </div>
      )}
      {!list.error && !fresh && <p className="muted small" role="status">{query.trim() ? 'Searching…' : 'Loading…'}</p>}
      {!list.error && fresh && chats?.length === 0 && (search
        ? <Empty title="No matching chats">No saved chat mentions “{search}”. Try other words.</Empty>
        : <Empty title="No saved chats">Use Save chat in a conversation to keep it here.</Empty>)}
      {!list.error && fresh && chats?.length === MAX_LISTED && (
        <p className="muted small">
          {search ? `Showing the ${MAX_LISTED} most recently updated matches. Add words to narrow the search.` : `Showing the ${MAX_LISTED} most recent. Search to find older chats.`}
        </p>
      )}
      {!list.error && chats && chats.length > 0 && (
        <ul className="move-list" aria-label={list.data?.search ? 'Matching saved chats' : 'Saved chats'}>
          {chats.map((conversation) => (
            <li key={conversation.id} className="saved-chat">
              <button disabled={!fresh || archiving !== null} onClick={() => onOpen(conversation.id)} aria-current={conversation.id === currentId ? 'true' : undefined}>
                <span className="move-name">{conversation.title}</span>
                <span className="muted small">
                  {MODE_LABELS[conversation.mode]} · {conversation.messages.length} messages · {relativeTime(conversation.updatedAt)}
                  {conversation.id === currentId ? ' · open now' : ''}
                </span>
              </button>
              <button className="button ghost small" disabled={!fresh || archiving !== null} onClick={() => archive(conversation)} aria-label={`Archive ${conversation.title}`}>
                {archiving === conversation.id ? 'Archiving…' : 'Archive'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button className="button ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** Names a chat before its first save. */
export function SaveChatDialog({ initialTitle, kept, total, onSave, onClose }: {
  initialTitle: string;
  kept: number;
  total: number;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal label="Save this chat" onClose={onClose} busy={busy}>
      <h2>Save this chat</h2>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        setError(null);
        onSave(title.trim()).catch((err: unknown) => {
          setError(errorMessage(err));
          setBusy(false);
        });
      }}>
        <label className="field">
          <span>Title</span>
          <input autoFocus value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <p className="muted small">
          Saved in your library as text: your messages and the AI’s replies.{kept < total ? ` Only the latest ${kept} of ${total} messages fit.` : ''} Proposed
          changes are kept as their summary and can’t be applied from a saved chat.
        </p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save chat'}</button>
        </div>
      </form>
    </Modal>
  );
}
