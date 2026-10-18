import { extname } from 'node:path';

const BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.vtt': 'text/vtt',
  '.srt': 'text/plain',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/yaml']);

export function mimeFor(filename: string): string {
  return BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Types whose bytes are already readable text, so they need no extractor. */
export function isPlainText(mimeType: string): boolean {
  return (mimeType.startsWith('text/') && mimeType !== 'text/html') || TEXT_TYPES.has(mimeType);
}
