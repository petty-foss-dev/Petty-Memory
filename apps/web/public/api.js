// The bearer token lives only in this module's memory: reloading the page or disconnecting forgets it.
import { lockVault, uuidv7 } from './crypto.js';
let token = null;
let client = null;
let onUnauthorized = null;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SCOPE_HELP = {
  read: 'Create a token with `petty-memory clients add "Browser" --scope read,write` and reconnect.',
  write: 'This token is read-only. Create one with `petty-memory clients add "Browser" --scope read,write` to make changes.',
  capture: 'Create a token with `petty-memory clients add "Browser" --scope read,write` to add notes.',
  secrets: 'Secret notes need a token that explicitly includes the "secrets" scope, e.g. `--scope read,write,secrets`.',
};

function explain(status, code, message) {
  if (code === 'insufficient_scope') {
    const scope = /"(\w+)" scope/.exec(message)?.[1];
    return `${message} ${SCOPE_HELP[scope] ?? ''}`.trim();
  }
  if (status === 401) {
    return client
      ? 'The server no longer accepts this token. It may have been revoked; connect with a current one.'
      : 'The server doesn’t recognise this token. Check you pasted all of it, or create a new one.';
  }
  return message;
}

export async function request(method, path, body, { signal } = {}) {
  if (!token) throw new ApiError(401, 'unauthorized', 'Not connected.');
  const sentToken = token;
  const headers = { Authorization: `Bearer ${sentToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Lets the server replay the original answer if a retry follows a lost response.
  if (method !== 'GET') headers['Idempotency-Key'] = uuidv7();
  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network', 'Couldn’t reach the Petty Memory server. Check that it is still running.');
  }
  const text = await res.text();
  if (token !== sentToken) throw new DOMException('The connection changed.', 'AbortError');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'bad_response', `The server sent an unexpected response (${res.status}).`);
  }
  if (!res.ok) {
    const code = data?.error?.code ?? 'error';
    const error = new ApiError(res.status, code, explain(res.status, code, data?.error?.message ?? `Request failed (${res.status}).`));
    if (res.status === 401 && client) onUnauthorized?.(error);
    throw error;
  }
  return data;
}

export function onSessionLost(handler) {
  onUnauthorized = handler;
}

export const get = (path, options) => request('GET', path, undefined, options);
export const post = (path, body = {}) => request('POST', path, body);
export const patch = (path, body) => request('PATCH', path, body);
export const put = (path, body) => request('PUT', path, body);
export const del = (path, body) => request('DELETE', path, body);

export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== false) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const enc = encodeURIComponent;

export async function connect(candidate) {
  const trimmed = candidate.trim();
  if (!trimmed) throw new ApiError(400, 'invalid', 'Paste a token to connect.');
  token = trimmed;
  try {
    client = await get('/whoami');
  } catch (error) {
    token = null;
    throw error;
  }
  if (!client.scopes.includes('read')) {
    token = null;
    client = null;
    throw new ApiError(403, 'insufficient_scope', `This token can't read the library. ${SCOPE_HELP.read}`);
  }
  return client;
}

export function disconnect() {
  lockVault();
  token = null;
  client = null;
}

export const can = (scope) => Boolean(client?.scopes.includes(scope) || (scope === 'capture' && client?.scopes.includes('write')));
export const currentClient = () => client;
