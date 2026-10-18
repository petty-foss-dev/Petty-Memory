import { useState } from 'react';
import { type Route, useApp } from '../context.ts';
import { Icon } from '../ui.tsx';

const HIDDEN_KEY = 'petty-memory.setup-checklist-hidden';
/** Libraries with more than this many items are past first run, so the checklist never appears there. */
const FIRST_RUN_ITEMS = 20;

interface Step {
  label: string;
  detail: string;
  /** Absent for optional steps that have no single finished state. */
  done?: boolean;
  action?: { label: string; route: Route };
}

/** A short first-run list on Home, built from what the library already has. */
export function SetupChecklist() {
  const { info, projects, go } = useApp();
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === '1');
  if (!info || hidden) return null;
  const { stats } = info;
  const items = stats.note + stats.bookmark + stats.file + stats.image + stats.task + stats.decision;
  if (items > FIRST_RUN_ITEMS) return null;

  const steps: Step[] = [
    { label: 'Save a note or a link', detail: 'Type or dictate in the box above. Links are archived so they stay searchable.', done: items > 0 },
    { label: 'Start a project', detail: 'Use + next to Projects in the sidebar for a memory document, decisions and tasks.', done: projects.length > 0 },
    {
      label: 'Connect an AI tool', detail: 'Claude Code, Codex or Cursor can then read and add to this library.', done: info.aiClientsSeen,
      action: { label: 'Connect', route: { view: 'settings', section: 'mcp' } },
    },
    {
      label: 'Choose an AI provider (optional)',
      detail: 'For AI chat. A local model server keeps your notes on this computer; a cloud provider receives the notes you chat about. Everything else works without one.',
      done: info.aiEnabled,
      action: { label: 'AI settings', route: { view: 'settings', section: 'ai' } },
    },
    {
      label: 'Bring in what you have', detail: 'Browser bookmarks, Markdown folders, CSV or Enve book highlights.',
      action: { label: 'Import', route: { view: 'settings', section: 'import' } },
    },
    {
      label: 'Review a little each day', detail: 'Due notes come back on Review, and you choose when to see each again.',
      action: { label: 'Open Review', route: { view: 'review' } },
    },
  ];
  const tracked = steps.filter((step) => step.done !== undefined);
  const finished = tracked.filter((step) => step.done).length;

  return (
    <section className="panel setup-checklist" aria-labelledby="setup-heading">
      <div className="panel-header">
        <h2 id="setup-heading">Getting started</h2>
        <button className="link-button" onClick={() => {
          localStorage.setItem(HIDDEN_KEY, '1');
          setHidden(true);
        }}>Hide</button>
      </div>
      <p className="muted small">{finished} of {tracked.length} done</p>
      <ul className="setup-steps">
        {steps.map((step) => (
          <li key={step.label} className={step.done ? 'done' : ''}>
            <span className="setup-mark" aria-hidden="true">{step.done ? <Icon name="check" size={14} /> : null}</span>
            <span className="setup-text">
              <strong>{step.label}</strong>
              <span className="sr-only">{step.done ? ' (done)' : step.done === false ? ' (not done yet)' : ''}</span>
              <span className="muted small">{step.detail}</span>
            </span>
            {step.action && !step.done && <button className="button small" onClick={() => go(step.action!.route)}>{step.action.label}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
