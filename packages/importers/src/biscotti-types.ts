import type { ImportResult } from './result.ts';

export const BISCOTTI_MAX_BYTES = 8 * 1024 * 1024;
export const BISCOTTI_MAX_MEETINGS = 500;

export interface BiscottiMeeting {
  id: string;
  title: string;
  date: string;
  summary: string;
  notes: string;
  transcript: string;
  participants: string[];
  tags: string[];
}

export interface BiscottiTurn {
  start: number;
  speaker: string;
  text: string;
}

export interface BiscottiPreviewEntry extends BiscottiMeeting {
  speakers: string[];
  turns: BiscottiTurn[];
  existingId: string | null;
}

export interface BiscottiPreview {
  entries: BiscottiPreviewEntry[];
  skipped: number;
  warnings: { row: number; message: string }[];
  fingerprint: string;
  source: 'csv' | 'mcp';
}

export interface BiscottiImportRequest {
  data: string | BiscottiMeeting[];
  source: 'csv' | 'mcp';
  fingerprint: string;
  includeIds: string[];
  project?: string;
}

export interface BiscottiImportResult extends ImportResult {
  items: { id: string; sourceId: string; title: string; created: boolean }[];
}

export interface BiscottiSavedMeeting {
  id: string;
  meetingId: string;
  title: string;
  date: string;
  summary: string;
  speakers: string[];
  participants: string[];
  project: { id: string; name: string } | null;
  source: 'csv' | 'mcp';
  moments: { start: number; speaker: string }[];
}

export interface BiscottiMeetingPage {
  items: BiscottiSavedMeeting[];
  next: string | null;
}
