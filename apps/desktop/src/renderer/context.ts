import type { ItemType } from '@enve-memory/core';
import { createContext, useContext } from 'react';
import type { AppInfo, ProjectSummary, Shelf } from '../shared/ipc.ts';

export type LibraryType = Exclude<ItemType, 'task' | 'decision'>;

export type SettingsSection =
  | 'library' | 'mcp' | 'devices' | 'search' | 'ai' | 'automations' | 'sync' | 'vault' | 'sharing' | 'import' | 'backups' | 'export'
  | 'appearance' | 'about';

export type KnowledgeSection = 'recipes' | 'collections' | 'research' | 'meetings' | 'sources' | 'freshness' | 'preferences';

/** A prefilled chat opened from another view. Each new `key` is applied once; nothing is sent until the person presses Send. */
export interface AskSeed {
  key: string;
  mode: 'ask' | 'actions';
  draft: string;
  project?: string;
  /** The note an actions chat works from. */
  targetId?: string;
}

/** Research locators: a PDF page and quote, or an audio time in seconds, optionally inside one transcript. */
export interface KnowledgeRoute {
  view: 'knowledge';
  section?: KnowledgeSection;
  sourceId?: string;
  transcriptId?: string;
  page?: number;
  start?: number;
  quote?: string;
}

export type Route =
  | KnowledgeRoute
  | { view: 'home' }
  | { view: 'inbox' }
  | { view: 'library'; type?: LibraryType }
  | { view: 'outline'; reveal?: string }
  | { view: 'highlights' }
  | { view: 'project'; id: string; supersede?: string }
  | { view: 'tasks' }
  | { view: 'review' }
  | { view: 'ask'; seed?: AskSeed }
  | { view: 'activity' }
  | { view: 'graph' }
  | { view: 'shelf'; shelf: Shelf }
  | { view: 'reminders' }
  | { view: 'views'; id?: string }
  | { view: 'templates' }
  | { view: 'settings'; section?: SettingsSection };

export interface AppState {
  info: AppInfo | undefined;
  projects: ProjectSummary[];
  go: (route: Route) => void;
  openItem: (id: string | null) => void;
  openSearch: () => void;
}

export const AppContext = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppContext);
