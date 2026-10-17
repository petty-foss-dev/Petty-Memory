import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ThemeMode } from '../shared/ipc.ts';

export interface StoredPrefs {
  theme: ThemeMode;
  lan: boolean;
  shortcut: string;
  /** Remote sync server; its token lives in the secret store. */
  remoteUrl: string | null;
}

const DEFAULTS: StoredPrefs = { theme: 'system', lan: false, shortcut: 'CommandOrControl+Shift+Space', remoteUrl: null };

/** Desktop-only preferences (window chrome, network exposure). Library preferences live in core settings instead. */
export class PrefsFile {
  private readonly file: string;
  private values: StoredPrefs;

  constructor(file: string) {
    this.file = file;
    this.values = { ...DEFAULTS, ...(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredPrefs>) : {}) };
  }

  get<K extends keyof StoredPrefs>(key: K): StoredPrefs[K] {
    return this.values[key];
  }

  set<K extends keyof StoredPrefs>(key: K, value: StoredPrefs[K]): void {
    this.values = { ...this.values, [key]: value };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.values, null, 2));
    renameSync(tmp, this.file);
  }
}
