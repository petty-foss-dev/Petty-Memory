export interface KnowledgeRequest {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  path: string;
  body?: Record<string, unknown>;
}

export interface ResearchFile {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  sha256: string;
}

export interface TranscriptionStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  encryptionAvailable: boolean;
}
export const TRANSCRIPTION_KEY = 'audio-transcription';
