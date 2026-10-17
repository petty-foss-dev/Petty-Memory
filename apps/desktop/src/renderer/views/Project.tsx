import type { Decision, Project, ProjectStatus } from '@enve-memory/core';
import { useEffect, useState } from 'react';
import type { MemoryVersion } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { actorInfo, formatDate, formatDateTime, relativeTime } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, MarkdownEditor, MarkdownView, useDraft, useFeedback } from '../ui.tsx';
import { ItemRow } from './ItemRow.tsx';
import { AddTask, TaskRow } from './TaskRow.tsx';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

export function ProjectView({ id, supersede }: { id: string; supersede?: string }) {
  const { openItem } = useApp();
  const briefing = useLive(() => call('projects.briefing', id), [id]);
  if (briefing.error) return <div className="page"><Empty title="Project not found">{briefing.error.message}</Empty></div>;
  if (!briefing.data) return <div className="page" />;
  const { project, decisions, openTasks, recentItems } = briefing.data;

  return (
    <div className="page project">
      <ProjectHeader project={project} />
      <div className="project-grid">
        <div className="project-main">
          <MemoryDocument project={project} />
          <DecisionLog project={project} decisions={decisions} supersede={supersede} />
        </div>
        <div className="project-side">
          <About project={project} />
          <section className="panel" aria-labelledby="tasks-heading">
            <div className="panel-header"><h2 id="tasks-heading">Open tasks</h2></div>
            <div className="task-list">
              {openTasks.map((task) => <TaskRow key={task.id} task={task} />)}
            </div>
            {openTasks.length === 0 && <p className="muted">Nothing open.</p>}
            <AddTask project={project.id} />
          </section>
          <section className="panel" aria-labelledby="recent-project-heading">
            <div className="panel-header"><h2 id="recent-project-heading">Recent in {project.name}</h2></div>
            {recentItems.length === 0 ? <p className="muted">Drop files or links here, or file items from the Inbox.</p> : (
              <div className="rows compact">{recentItems.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} showProject={false} />)}</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  const { toast } = useFeedback();
  const name = useDraft(project.name);
  const fail = (error: unknown) => toast(errorMessage(error), 'error');
  return (
    <header className="page-header project-header">
      <input
        className="title-input"
        aria-label="Project name"
        value={name.draft}
        onChange={(event) => name.setDraft(event.target.value)}
        onBlur={() => name.dirty && call('projects.update', project.id, { name: name.draft }).catch((error: unknown) => {
          name.reset();
          fail(error);
        })}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
      />
      <select aria-label="Project status" value={project.status} onChange={(event) => call('projects.update', project.id, { status: event.target.value }).catch(fail)}>
        {STATUSES.map((status) => <option key={status} value={status}>{status[0]!.toUpperCase() + status.slice(1)}</option>)}
      </select>
    </header>
  );
}

function About({ project }: { project: Project }) {
  const { toast } = useFeedback();
  const description = useDraft(project.description);
  const instructions = useDraft(project.instructions);
  const dirty = description.dirty || instructions.dirty;
  const save = () =>
    call('projects.update', project.id, { description: description.draft, instructions: instructions.draft }).then(
      () => toast('Saved'),
      (error: unknown) => toast(errorMessage(error), 'error'),
    );
  return (
    <section className="panel" aria-labelledby="about-heading">
      <div className="panel-header"><h2 id="about-heading">About</h2></div>
      <label className="field">
        <span>Description</span>
        <textarea rows={3} value={description.draft} onChange={(event) => description.setDraft(event.target.value)} placeholder="What this project is, in a sentence or two." />
      </label>
      <label className="field">
        <span>Standing instructions</span>
        <textarea rows={3} value={instructions.draft} onChange={(event) => instructions.setDraft(event.target.value)} placeholder="Rules every AI should follow here, e.g. “must work offline”." />
      </label>
      {dirty && (
        <div className="inline-actions">
          <button className="button primary small" onClick={() => void save()}>Save</button>
          <button className="button ghost small" onClick={() => { description.reset(); instructions.reset(); }}>Discard</button>
        </div>
      )}
    </section>
  );
}

function MemoryDocument({ project }: { project: Project }) {
  const { toast } = useFeedback();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const memory = useDraft(project.memory);
  const save = () =>
    call('projects.setMemory', project.id, memory.draft).then(
      () => {
        setEditing(false);
        toast('Memory saved. Earlier versions stay in History.');
      },
      (error: unknown) => toast(errorMessage(error), 'error'),
    );
  return (
    <section className="panel memory" aria-labelledby="memory-heading">
      <div className="panel-header">
        <h2 id="memory-heading">Memory</h2>
        <div className="inline-actions">
          <button className="link-button" onClick={() => setHistory(!history)}><Icon name="history" size={14} /> History</button>
          {!editing && <button className="button small" onClick={() => setEditing(true)}>Edit</button>}
        </div>
      </div>
      <p className="muted small">
        The living summary your AI tools read first: goals, constraints, current state, open questions. Earlier versions are kept.
      </p>
      {editing ? (
        <>
          <MarkdownEditor label="Memory document" value={memory.draft} onChange={memory.setDraft} onSubmit={() => void save()} rows={16}
            placeholder={'## Goal\n\n## Constraints\n\n## Current state\n\n## Open questions'} />
          <div className="inline-actions">
            <button className="button primary small" onClick={() => void save()} disabled={!memory.dirty}>Save memory</button>
            <button className="button ghost small" onClick={() => { memory.reset(); setEditing(false); }}>Cancel</button>
            <span className="muted small">⌘↵ to save</span>
          </div>
        </>
      ) : project.memory ? (
        <MarkdownView className="reading" source={project.memory} />
      ) : (
        <Empty title="No memory yet" action={<button className="button small" onClick={() => setEditing(true)}>Write the first version</button>}>
          Agents can write it with <code>set_project_memory</code>, or start it yourself.
        </Empty>
      )}
      {history && <MemoryHistory project={project} onRestore={() => setHistory(false)} />}
    </section>
  );
}

const HISTORY_PAGE = 20;

function MemoryHistory({ project, onRestore }: { project: Project; onRestore: () => void }) {
  const { toast, confirm } = useFeedback();
  const [want, setWant] = useState(HISTORY_PAGE);
  // Every loaded page is re-read on a change, so an edit from another device shows up at the top without losing older pages.
  const versions = useLive(async () => {
    const items: MemoryVersion[] = [];
    let total = 0;
    do {
      const page = await call('projects.memoryHistory', project.id, { offset: items.length, limit: Math.min(HISTORY_PAGE, want - items.length) });
      total = page.total;
      items.push(...page.items);
      if (!page.items.length) break;
    } while (items.length < Math.min(want, total));
    return { items, total };
  }, [project.id, want]);
  const [open, setOpen] = useState<MemoryVersion | null>(null);
  const list = versions.data?.items ?? [];
  const restore = async (version: MemoryVersion) => {
    const ok = await confirm({
      title: 'Restore this version?',
      body: <p>The memory document goes back to the version from {formatDateTime(version.at)}. The current text stays in history.</p>,
      confirmLabel: 'Restore version',
    });
    if (!ok) return;
    call('projects.setMemory', project.id, version.memory).then(() => {
      toast('Earlier version restored');
      onRestore();
    }, (error: unknown) => toast(errorMessage(error), 'error'));
  };
  if (versions.error) return <p className="error-text">{versions.error.message}</p>;
  return (
    <div className="memory-history">
      {versions.data && list.length === 0 && <p className="muted small">No saved versions yet.</p>}
      <ul className="history">
        {list.map((version, index) => (
          <li key={version.id}>
            <button className={`link-button ${open?.id === version.id ? 'active' : ''}`} aria-pressed={open?.id === version.id} onClick={() => setOpen(open?.id === version.id ? null : version)}>
              {formatDateTime(version.at)}
            </button>
            <span className={`actor ${actorInfo(version.actor).kind}`}>{actorInfo(version.actor).label}</span>
            {index === 0 && version.memory === project.memory && <span className="badge">Current</span>}
          </li>
        ))}
      </ul>
      {versions.data && list.length < versions.data.total && (
        <button className="button small" onClick={() => setWant(list.length + HISTORY_PAGE)}>
          Show older ({(versions.data.total - list.length).toLocaleString()} more)
        </button>
      )}
      {open && (
        <div className="version-preview">
          {open.memory ? <MarkdownView source={open.memory} /> : <p className="muted">(empty)</p>}
          {open.memory !== project.memory && <button className="button small" onClick={() => void restore(open)}>Restore this version</button>}
        </div>
      )}
    </div>
  );
}

function DecisionLog({ project, decisions, supersede }: { project: Project; decisions: Decision[]; supersede?: string }) {
  const { openItem } = useApp();
  const [recording, setRecording] = useState<string[] | null>(supersede ? [supersede] : null);
  useEffect(() => {
    if (supersede) setRecording([supersede]);
  }, [supersede]);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return (
    <section className="panel" aria-labelledby="decisions-heading">
      <div className="panel-header">
        <h2 id="decisions-heading">Decisions</h2>
        {!recording && <button className="button small" onClick={() => setRecording([])}>Record decision</button>}
      </div>
      <p className="muted small">Append-only. To change a decision, record a new one that supersedes it.</p>
      {recording && <RecordDecision project={project} decisions={decisions} initial={recording} onDone={() => setRecording(null)} />}
      {decisions.length === 0 && !recording && <p className="muted">No decisions yet.</p>}
      <ol className="timeline">
        {[...decisions].reverse().map((decision) => (
          <li key={decision.id} className={decision.supersededBy ? 'superseded' : ''}>
            <div className="timeline-dot" />
            <div className="timeline-body">
              <button className="decision-text" onClick={() => openItem(decision.id)}>{decision.decision}</button>
              {decision.reason && <p className="decision-reason">{decision.reason}</p>}
              <div className="decision-meta">
                <span>{formatDate(decision.createdAt)}</span>
                <span className={`actor ${actorInfo(decision.source).kind}`}>{actorInfo(decision.source).label}</span>
                {decision.supersedes.map((old) => (
                  <span key={old}>supersedes “{truncate(byId.get(old)?.decision ?? 'an earlier decision')}”</span>
                ))}
                {decision.supersededBy && <span>superseded {byId.get(decision.supersededBy) ? relativeTime(byId.get(decision.supersededBy)!.createdAt) : ''}</span>}
                {!decision.supersededBy && !recording && (
                  <button className="link-button" onClick={() => setRecording([decision.id])}>Supersede…</button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const truncate = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function RecordDecision({ project, decisions, initial, onDone }: { project: Project; decisions: Decision[]; initial: string[]; onDone: () => void }) {
  const { toast } = useFeedback();
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [supersedes, setSupersedes] = useState<string[]>(initial);
  const active = decisions.filter((d) => !d.supersededBy);
  return (
    <form
      className="record-decision"
      onSubmit={(event) => {
        event.preventDefault();
        call('decisions.record', { project: project.id, decision, reason, supersedes }).then(
          () => {
            toast('Decision recorded');
            onDone();
          },
          (error: unknown) => toast(errorMessage(error), 'error'),
        );
      }}
    >
      <label className="field">
        <span>Decision</span>
        <textarea autoFocus rows={2} value={decision} onChange={(event) => setDecision(event.target.value)} placeholder="Use the ESP32-C3 for the controller." />
      </label>
      <label className="field">
        <span>Why <span className="muted">(optional)</span></span>
        <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Cheaper, and it has the radio we need." />
      </label>
      {active.length > 0 && (
        <fieldset className="field">
          <legend>Supersedes <span className="muted">(optional)</span></legend>
          {active.map((d) => (
            <label key={d.id} className="check">
              <input
                type="checkbox"
                checked={supersedes.includes(d.id)}
                onChange={(event) => setSupersedes(event.target.checked ? [...supersedes, d.id] : supersedes.filter((x) => x !== d.id))}
              />
              {truncate(d.decision, 90)}
            </label>
          ))}
        </fieldset>
      )}
      <div className="inline-actions">
        <button type="submit" className="button primary small" disabled={!decision.trim()}>Record decision</button>
        <button type="button" className="button ghost small" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
