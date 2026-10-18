import { useState } from 'react';
import type { ReviewCard } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { displayTitle, formatDate, relativeTime } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, MarkdownView, ProjectSelect, TypeIcon, useFeedback } from '../ui.tsx';

const QUEUE = 50;
const MAX_DAYS = 3650;
const PRESETS: [number, string][] = [[1, 'Tomorrow'], [7, 'Next week'], [30, 'Next month']];

const validDays = (text: string) => {
  const days = Number(text);
  return Number.isInteger(days) && days >= 1 && days <= MAX_DAYS ? days : null;
};

function CardFacts({ card }: { card: ReviewCard }) {
  return (
    <p className="muted small review-facts">
      {card.reason}
      {card.dueAt && <> · due {formatDate(card.dueAt)}</>}
      {' · '}
      {card.lastReviewedAt ? `last reviewed ${relativeTime(card.lastReviewedAt)}` : 'not reviewed yet'}
      {card.reviewCount > 0 && <> · reviewed {card.reviewCount} time{card.reviewCount === 1 ? '' : 's'}</>}
    </p>
  );
}

/** One due card at a time; choosing when to see it again moves on to the next. */
export function Review() {
  const { projects, openItem } = useApp();
  const { toast } = useFeedback();
  const [project, setProject] = useState<string | null>(null);
  const queue = useLive(() => call('review.queue', { limit: QUEUE, ...(project ? { project } : {}) }), [project]);
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [days, setDays] = useState('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = (queue.data ?? []).filter((card) => !handled.has(card.item.id));
  const card = remaining[0];
  const done = handled.size;
  const total = done + remaining.length;
  const custom = validDays(days);

  const schedule = async (count: number) => {
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call('review.schedule', card.item.id, count);
      setHandled((current) => new Set(current).add(card.item.id));
      toast(`“${displayTitle(card.item)}” comes back ${count === 1 ? 'tomorrow' : `on ${formatDate(new Date(Date.now() + count * 86_400_000).toISOString())}`}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page review">
      <header className="page-header">
        <h1>Review</h1>
        <p className="subtitle">Revisit what’s due, then choose when to see each one again.</p>
      </header>

      <div className="review-toolbar">
        <ProjectSelect
          value={project}
          onChange={(next) => {
            setProject(next);
            setHandled(new Set());
          }}
          projects={projects}
          emptyLabel="Whole library"
          label="Review from"
        />
        {total > 0 && (
          <div className="review-progress">
            <progress max={total} value={done} aria-label="Reviewed this session" />
            <span className="muted small">{done} of {total}{queue.data?.length === QUEUE ? '+' : ''} reviewed</span>
          </div>
        )}
      </div>

      {queue.error && (
        <div className="error-box" role="alert">
          <p>{queue.error.message}</p>
          <button className="button small" onClick={queue.reload}>Try again</button>
        </div>
      )}
      {!queue.data && !queue.error && <p className="muted" role="status">Loading what’s due…</p>}

      {queue.data && !card && (
        done > 0 ? (
          <Empty title="All caught up">You reviewed {done} item{done === 1 ? '' : 's'}. Each one comes back on the day you chose.</Empty>
        ) : (
          <Empty title="Nothing is due for review">When something is due it shows up here, and each item you schedule comes back on the day you choose.</Empty>
        )
      )}

      {card && (
        <article className="review-card panel" aria-labelledby="review-title">
          <div className="review-card-head">
            <h2 id="review-title"><TypeIcon type={card.item.type} size={18} /> {displayTitle(card.item)}</h2>
            <button className="button small" onClick={() => openItem(card.item.id)}><Icon name="external" size={14} /> Open</button>
          </div>
          <CardFacts card={card} />
          <div className="review-body">
            {card.item.body ? <MarkdownView source={card.item.body} /> : <p className="muted">{card.item.url ?? 'No text. Open it to see the file or link.'}</p>}
          </div>
          <div className="review-schedule" role="group" aria-label="See it again">
            <span className="muted small">See it again</span>
            {PRESETS.map(([count, label]) => (
              <button key={count} className="button" disabled={busy} onClick={() => void schedule(count)}>{label}</button>
            ))}
            <form
              className="review-custom"
              onSubmit={(event) => {
                event.preventDefault();
                if (custom) void schedule(custom);
              }}
            >
              <label className="field inline">
                <span>In</span>
                <input type="number" min={1} max={MAX_DAYS} step={1} value={days} aria-invalid={custom === null} onChange={(event) => setDays(event.target.value)} />
                <span>days</span>
              </label>
              <button type="submit" className="button" disabled={busy || custom === null}>Schedule</button>
            </form>
          </div>
          {custom === null && <p className="error-text small">Choose a whole number of days from 1 to {MAX_DAYS.toLocaleString()}.</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </article>
      )}
    </div>
  );
}
