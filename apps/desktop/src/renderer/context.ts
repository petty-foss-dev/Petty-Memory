import type { ItemType } from '@enve-memory/core';
import { createContext, useContext } from 'react';
import type { AppInfo, ProjectSummary, Shelf } from '../shared/ipc.ts';

export type LibraryType = Exclude<ItemType, 'task' | 'decision'>;

export type SettingsSection =
  | 'library' | 'mcp' | 'devices' | 'search' | 'ai' | 'automations' | 'sync' | 'vault' | 'sharing' | 'import' | 'backups' | 'export'
  | 'appearance' | 'about';

export type Route =
  | { view: 'home' }
  | { view: 'inbox' }
  | { view: 'library'; type?: LibraryType }
  | { view: 'outline'; reveal?: string }
  | { view: 'highlights' }
  | { view: 'project'; id: string; supersede?: string }
  | { view: 'tasks' }
  | { view: 'ask' }
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
