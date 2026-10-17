import { DesktopError } from './dispatch.ts';

/** SecretStore name of the remote sync token. */
export const REMOTE_TOKEN = 'remote-sync';

/** A server URL the user typed: http(s) only, no credentials or query, trailing slash dropped. */
export function remoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DesktopError('invalid', 'Enter the server address, like https://memory.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DesktopError('invalid', 'The server address must start with https:// or http://.');
  if (url.username || url.password) throw new DesktopError('invalid', 'Put the token in the token field, not in the address.');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}
