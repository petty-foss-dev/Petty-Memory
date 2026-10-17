import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, errorMessage, onCommand, onOpenItem, useLive } from './lib/api.ts';
import { SHELVES } from '../shared/ipc.ts';
import { detectCapture } from './lib/capture.ts';
import { isEditable, useUndoRedo } from './lib/edits.ts';
import { AppContext, type AppState, type LibraryType, type Route } from './context.ts';
import { Icon, type IconName, useFeedback } from './ui.tsx';
import { Activity } from './views/Activity.tsx';
import { RemindersView } from './views/Reminders.tsx';
import { SHELF_COPY, ShelfView } from './views/Shelf.tsx';
import { GraphView } from './views/Graph.tsx';
import { Ask } from './views/Ask.tsx';
import { Highlights } from './views/Highlights.tsx';
import { Home } from './views/Home.tsx';
import { Inbox } from './views/Inbox.tsx';
import { ItemDrawer } from './views/ItemDetail.tsx';
import { Library } from './views/Library.tsx';
import { NewProject } from './views/NewProject.tsx';
import { OutlineView } from './views/Outline.tsx';
import { ProjectView } from './views/Project.tsx';
import { SearchPalette } from './views/Search.tsx';
import { Settings } from './views/Settings.tsx';
import { Tasks } from './views/Tasks.tsx';

const isMac = window.enve.platform === 'darwin';
const mod = (event: KeyboardEvent) => (isMac ? event.metaKey : event.ctrlKey);

const LIBRARY_TABS: { type: LibraryType | undefined; label: string }[] = [
  { type: undefined, label: 'All' },
  { type: 'bookmark', label: 'Links' },
  { type: 'note', label: 'Notes' },
  { type: 'file', label: 'Files' },
  { type: 'image', label: 'Images' },
];

export interface CaptureRequest {
  n: number;
  mode: 'note' | 'link';
}

export function App() {
  const { toast } = useFeedback();
  const [route, setRoute] = useState<Route>({ view: 'home' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [capture, setCapture] = useState<CaptureRequest>({ n: 0, mode: 'note' });
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const structure = useUndoRedo();

  const info = useLive(() => call('app.info'), []);
  const shelves = useLive(() => call('shelves.counts'), []);
  const projects = useLive(() => call('projects.list'), []);

  const go = useCallback((next: Route) => {
    setRoute(next);
    setOpenId(null);
  }, []);

  const requestCapture = useCallback((mode: CaptureRequest['mode']) => {
    setRoute({ view: 'home' });
    setOpenId(null);
    setSearching(false);
    setCapture((current) => ({ n: current.n + 1, mode }));
  }, []);

  const runCommand = useCallback((command: string) => {
    if (command === 'search') setSearching(true);
    else if (command === 'new-note') requestCapture('note');
    else if (command === 'save-link') requestCapture('link');
    else if (command === 'settings') go({ view: 'settings' });
    else if (command === 'import') go({ view: 'settings', section: 'import' });
  }, [go, requestCapture]);

  useEffect(() => onCommand(runCommand), [runCommand]);
  useEffect(() => onOpenItem((id) => {
    setSearching(false);
    setOpenId(id);
  }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (mod(event) && !event.altKey && (key === 'z' || (key === 'y' && !isMac)) && !isEditable(event.target) && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) structure.redo();
        else structure.undo();
        return;
      }
      if (mod(event) && !event.shiftKey && !event.altKey) {
        const command = key === 'k' ? 'search' : key === 'n' ? 'new-note' : key === 'l' ? 'save-link' : key === ',' ? 'settings' : null;
        if (command) {
          event.preventDefault();
          runCommand(command);
          return;
        }
      }
      if (event.key === 'Escape' && !searching && openId) {
        event.preventDefault();
        setOpenId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runCommand, searching, openId, structure.undo, structure.redo]);

  const currentProject = route.view === 'project' ? route.id : undefined;

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...event.dataTransfer.files];
    try {
      if (files.length) {
        const paths = files.map((file) => window.enve.pathForFile(file)).filter(Boolean);
        const saved = await call('files.save', paths, currentProject);
        toast(`Saved ${saved.length} file${saved.length === 1 ? '' : 's'}${currentProject ? '' : ' to the Inbox'}`);
        return;
      }
      const text = event.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || event.dataTransfer.getData('text/plain');
      const detected = detectCapture(text);
      if (detected?.kind === 'link') {
        const { created } = await call('items.saveLink', { url: detected.url, project: currentProject });
        toast(created ? 'Link saved' : 'You already saved that link');
      } else if (detected) {
        await call('items.saveNote', { body: detected.body, project: currentProject });
        toast('Note saved');
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const state: AppState = useMemo(() => ({
    info: info.data,
    projects: projects.data ?? [],
    go,
    openItem: setOpenId,
    openSearch: () => setSearching(true),
  }), [info.data, projects.data, go]);

  const nav = (target: Route, icon: IconName, label: string, count?: number) => {
    const active = target.view === route.view
      && (target.view !== 'library' || (route.view === 'library' && route.type === target.type))
      && (target.view !== 'shelf' || (route.view === 'shelf' && route.shelf === target.shelf))
      && (target.view !== 'project' || (route.view === 'project' && route.id === target.id));
    return (
      <button key={`${target.view}-${label}`} className={`nav-item ${active ? 'active' : ''}`} onClick={() => go(target)} aria-current={active ? 'page' : undefined}>
        <Icon name={icon} size={17} />
        <span className="nav-label">{label}</span>
        {count !== undefined && count > 0 && <span className="count">{count}</span>}
      </button>
    );
  };

  return (
    <AppContext.Provider value={state}>
      <div
        className={`app ${isMac ? 'mac' : ''}`}
        onDragEnter={(event) => {
          if (![...event.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list')) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => void onDrop(event)}
      >
        <aside className="sidebar">
          <div className="sidebar-top" />
          <button className="search-trigger" onClick={() => setSearching(true)}>
            <Icon name="search" size={16} />
            <span>Search</span>
            <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <nav aria-label="Main">
            {nav({ view: 'home' }, 'home', 'Home')}
            {nav({ view: 'inbox' }, 'inbox', 'Inbox', info.data?.inboxCount)}
            {nav({ view: 'tasks' }, 'tasks', 'Tasks')}
            {info.data?.aiEnabled && nav({ view: 'ask' }, 'ask', 'Ask')}
            <div className="nav-heading">
              <span>Projects</span>
              <button className="icon-button" aria-label="New project" title="New project" onClick={() => setCreatingProject(true)}>
                <Icon name="plus" size={15} />
              </button>
            </div>
            {(projects.data ?? []).map((project) => nav({ view: 'project', id: project.id }, 'project', project.name, project.openTasks))}
            {projects.data?.length === 0 && <p className="nav-hint">Projects hold a memory document, decisions and tasks.</p>}
            <div className="nav-heading"><span>Library</span></div>
            {nav({ view: 'outline' }, 'outline', 'Outline')}
            {LIBRARY_TABS.map((tab) => nav({ view: 'library', type: tab.type }, tab.type ?? 'library', tab.label))}
            {nav({ view: 'graph' }, 'graph', 'Graph')}
            <div className="nav-heading"><span>Shelves</span></div>
            {nav({ view: 'highlights' }, 'star', 'Highlights')}
            {SHELVES.map((shelf) => nav({ view: 'shelf', shelf }, shelf === 'pinned' ? 'pin' : shelf, SHELF_COPY[shelf].title, shelves.data?.[shelf]))}
            {nav({ view: 'reminders' }, 'bell', 'Reminders', shelves.data?.reminders)}
          </nav>
          <div className="sidebar-bottom">
            {nav({ view: 'activity' }, 'activity', 'Activity')}
            {nav({ view: 'settings' }, 'settings', 'Settings')}
          </div>
        </aside>

        <main className="main" aria-label="Content">
          {route.view === 'home' && <Home capture={capture} />}
          {route.view === 'inbox' && <Inbox />}
          {route.view === 'library' && <Library type={route.type} />}
          {route.view === 'outline' && <OutlineView key={route.reveal ?? ''} reveal={route.reveal} />}
          {route.view === 'highlights' && <Highlights />}
          {route.view === 'project' && <ProjectView key={route.id} id={route.id} supersede={route.supersede} />}
          {route.view === 'tasks' && <Tasks />}
          {route.view === 'ask' && <Ask />}
          {route.view === 'activity' && <Activity />}
          {route.view === 'graph' && <GraphView />}
          {route.view === 'shelf' && <ShelfView shelf={route.shelf} />}
          {route.view === 'reminders' && <RemindersView />}
          {route.view === 'settings' && <Settings section={route.section} />}
        </main>

        {openId && <ItemDrawer key={openId} id={openId} onClose={() => setOpenId(null)} />}
        {searching && (
          <SearchPalette
            onClose={() => setSearching(false)}
            onOpen={(id) => {
              setSearching(false);
              setOpenId(id);
            }}
          />
        )}
        {creatingProject && (
          <NewProject
            onClose={(id) => {
              setCreatingProject(false);
              if (id) go({ view: 'project', id });
            }}
          />
        )}
        {dragging && (
          <div className="drop-overlay">
            <div>Drop to save {currentProject ? 'into this project' : 'to your Inbox'}</div>
          </div>
        )}
      </div>
    </AppContext.Provider>
  );
}
