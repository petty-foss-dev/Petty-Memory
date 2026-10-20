import { type KnowledgeRoute, type KnowledgeSection, useApp } from '../context.ts';
import { Icon, type IconName } from '../ui.tsx';
import { Collections } from './Collections.tsx';
import { Freshness } from './KnowledgeFreshness.tsx';
import { Meetings } from './Meetings.tsx';
import { Preferences } from './Preferences.tsx';
import { Recipes } from './Recipes.tsx';
import { Research } from './Research.tsx';
import { Sources } from './Sources.tsx';

const SECTIONS: { section: KnowledgeSection; label: string; icon: IconName; summary: string }[] = [
  { section: 'recipes', label: 'Workflows', icon: 'sparkle', summary: 'Saved AI instructions you run on chosen notes, reviewing every suggested change.' },
  { section: 'collections', label: 'Collections', icon: 'filter', summary: 'Your own fields on items, as a table, cards or a Kanban board.' },
  { section: 'research', label: 'Research', icon: 'file', summary: 'Quote PDFs page by page, and transcribe and search meetings and lectures.' },
  { section: 'meetings', label: 'Meetings', icon: 'mic', summary: 'Bring in Biscotti meeting notes and transcripts, then ask about them or plan follow-ups.' },
  { section: 'sources', label: 'Watched sources', icon: 'refresh', summary: 'Pages, feeds and folders checked for new material you review before import.' },
  { section: 'freshness', label: 'Information review', icon: 'history', summary: 'Find what’s gone unchecked and passages that may disagree.' },
  { section: 'preferences', label: 'Organization preferences', icon: 'pin', summary: 'Filing rules you choose to include in workflow and organization requests.' },
];

/** The knowledge hub: workflows, collections, research, meetings, watched sources, information review and organization preferences. */
export function Knowledge({ route }: { route: KnowledgeRoute }) {
  const { go } = useApp();
  return (
    <div className="page knowledge">
      <header className="page-header">
        <h1>Knowledge</h1>
        <p className="subtitle">Tools for working with what you’ve saved. Everything they create is an ordinary note with its history, and AI suggestions always wait for your review.</p>
      </header>
      <nav className="chips workflow-tabs" aria-label="Knowledge sections">
        {SECTIONS.map(({ section, label }) => (
          <button
            key={section}
            className={`chip ${route.section === section ? 'active' : ''}`}
            aria-current={route.section === section ? 'page' : undefined}
            onClick={() => go({ view: 'knowledge', section })}
          >
            {label}
          </button>
        ))}
      </nav>
      {!route.section && (
        <div className="workflow-examples">
          {SECTIONS.map(({ section, label, icon, summary }) => (
            <button key={section} className="hint-card" onClick={() => go({ view: 'knowledge', section })}>
              <Icon name={icon} />
              <span><strong>{label}</strong> {summary}</span>
            </button>
          ))}
        </div>
      )}
      {route.section === 'recipes' && <Recipes />}
      {route.section === 'collections' && <Collections />}
      {route.section === 'research' && <Research route={route} />}
      {route.section === 'meetings' && <Meetings />}
      {route.section === 'sources' && <Sources />}
      {route.section === 'freshness' && <Freshness />}
      {route.section === 'preferences' && <Preferences />}
    </div>
  );
}
