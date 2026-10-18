import type { CaptureRequest } from '../App.tsx';
import { call, useLive } from '../lib/api.ts';
import { dueInfo, displayTitle, formatReminder, isDueSoon } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Icon } from '../ui.tsx';
import { CaptureBar } from './CaptureBar.tsx';
import { ItemRow } from './ItemRow.tsx';
import { SetupChecklist } from './SetupChecklist.tsx';

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home({ capture }: { capture: CaptureRequest }) {
  const { info, projects, go, openItem } = useApp();
  const recent = useLive(() => call('items.list', {}, 40), []);
  const tasks = useLive(() => call('tasks.list', { status: 'active' }, 100), []);
  const reminders = useLive(() => call('reminders.list'), []);
  const soonCutoff = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const nextReminders = [...(reminders.data?.due ?? []), ...(reminders.data?.upcoming ?? []).filter((r) => r.remindAt! <= soonCutoff)].slice(0, 5);

  const items = (recent.data ?? []).filter((item) => item.type !== 'task' && item.type !== 'decision').slice(0, 10);
  const openTasks = tasks.data ?? [];
  const soon = openTasks.filter((task) => isDueSoon(task.task.dueAt));
  const shownTasks = (soon.length ? soon : openTasks).slice(0, 6);
  const stats = info?.stats;
  const isEmpty = stats !== undefined && stats.note + stats.bookmark + stats.file + stats.image + stats.task + stats.decision === 0 && projects.length === 0;

  return (
    <div className="page home">
      <header className="page-header">
        <h1>{greeting()}</h1>
      </header>
      <CaptureBar focus={capture} />

      {isEmpty && (
        <section className="welcome" aria-label="Welcome">
          <h2>Save a link, jot a note, or connect Claude Code.</h2>
          <p>
            Petty Memory is one library on this computer that you and your AI tools share. What you save here, Claude Code,
            Codex and other assistants can search and build on, and what they record shows up here.
          </p>
          <div className="welcome-steps">
            <div>
              <Icon name="bookmark" />
              <h3>Capture</h3>
              <p>Paste a link above and its text is archived, so it stays searchable even if the page disappears.</p>
            </div>
            <div>
              <Icon name="project" />
              <h3>Organize</h3>
              <p>Projects keep a living memory document, a decision log and tasks that every AI client can read.</p>
            </div>
            <div>
              <Icon name="sparkle" />
              <h3>Connect</h3>
              <p>Add Petty Memory to Claude Code, Codex or Cursor once, and they all share the same memory.</p>
              <button className="button small" onClick={() => go({ view: 'settings', section: 'mcp' })}>Connect AI tools</button>
            </div>
          </div>
        </section>
      )}
      {isEmpty && <SetupChecklist />}

      {!isEmpty && (
        <div className="home-grid">
          <section className="panel" aria-labelledby="recent-heading">
            <div className="panel-header">
              <h2 id="recent-heading">Recent</h2>
              <button className="link-button" onClick={() => go({ view: 'library' })}>All items</button>
            </div>
            {items.length === 0 ? <p className="muted">Nothing saved yet.</p> : (
              <div className="rows">{items.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} />)}</div>
            )}
          </section>

          <div className="home-side">
            <SetupChecklist />
            {nextReminders.length > 0 && (
              <section className="panel" aria-labelledby="reminders-heading">
                <div className="panel-header">
                  <h2 id="reminders-heading">Reminders</h2>
                  <button className="link-button" onClick={() => go({ view: 'reminders' })}>All</button>
                </div>
                <ul className="mini-list">
                  {nextReminders.map((item) => (
                    <li key={item.id}>
                      <button onClick={() => openItem(item.id)}>
                        <span>{displayTitle(item)}</span>
                        <span className={`due ${item.remindAt! <= new Date().toISOString() ? 'overdue' : 'soon'}`}>{formatReminder(item.remindAt!)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="panel" aria-labelledby="due-heading">
              <div className="panel-header">
                <h2 id="due-heading">{soon.length ? 'Due soon' : 'Open tasks'}</h2>
                <button className="link-button" onClick={() => go({ view: 'tasks' })}>Tasks</button>
              </div>
              {shownTasks.length === 0 ? <p className="muted">No open tasks.</p> : (
                <ul className="mini-list">
                  {shownTasks.map((task) => {
                    const due = dueInfo(task.task.dueAt);
                    return (
                      <li key={task.id}>
                        <button onClick={() => openItem(task.id)}>
                          <span>{displayTitle(task)}</span>
                          {due && <span className={`due ${due.tone}`}>{due.label}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="panel" aria-labelledby="projects-heading">
              <div className="panel-header"><h2 id="projects-heading">Projects</h2></div>
              {projects.length === 0 ? <p className="muted">Create a project from the sidebar to give your AI tools a briefing.</p> : (
                <ul className="mini-list">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <button onClick={() => go({ view: 'project', id: project.id })}>
                        <span>{project.name}</span>
                        <span className="muted">{project.openTasks ? `${project.openTasks} open` : project.status}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {info && !info.aiClientsSeen && (
              <button className="hint-card" onClick={() => go({ view: 'settings', section: 'mcp' })}>
                <Icon name="sparkle" />
                <span>
                  <strong>No AI clients connected yet.</strong>
                  <span>Connect Claude Code, Codex or Cursor so they can read and add to this library.</span>
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
