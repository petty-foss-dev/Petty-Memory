import type { Context } from './context.ts';
import { invalid } from './errors.ts';

/** Per-library preferences. Device-local: not in the change log, never synced. */
export interface Settings {
  /** Fetch saved links to archive their readable text. Off means no network requests at all on save. */
  fetchLinks: boolean;
  /** Index items with the local embedding model so search matches meaning, not just words. */
  semanticSearch: boolean;
  /** 'none' or a provider id from @enve-memory/ai. */
  aiProvider: string;
  aiModel: string;
  /** Empty means the provider's standard address. */
  aiBaseUrl: string;
  /** Summarize and suggest tags/projects for new items. Only items saved after `aiEnrichSince` are sent, so turning it on never bills a backlog. */
  aiEnrich: boolean;
  aiEnrichSince: string;
  /** Apply suggested tags and project straight away instead of waiting for the user to accept them. */
  aiAutoApply: boolean;
  transcriptionBaseUrl: string;
  transcriptionModel: string;
  /** Shared folder (iCloud Drive, Dropbox, Syncthing…) to sync this library through; empty means off. */
  syncFolder: string;
}

const DEFAULTS: Settings = {
  fetchLinks: true,
  semanticSearch: true,
  aiProvider: 'none',
  aiModel: '',
  aiBaseUrl: '',
  aiEnrich: false,
  aiEnrichSince: '',
  aiAutoApply: false,
  transcriptionBaseUrl: '',
  transcriptionModel: '',
  syncFolder: '',
};

export class SettingsService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.ctx.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, `pref.${key}`);
    return row ? (JSON.parse(row.value) as Settings[K]) : DEFAULTS[key];
  }

  all(): Settings {
    return Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, this.get(key as keyof Settings)])) as unknown as Settings;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (!(key in DEFAULTS)) throw invalid(`Unknown setting "${key}".`);
    if (typeof value !== typeof DEFAULTS[key]) throw invalid(`Setting "${key}" must be a ${typeof DEFAULTS[key]}.`);
    this.ctx.run(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      `pref.${key}`, JSON.stringify(value),
    );
  }
}
