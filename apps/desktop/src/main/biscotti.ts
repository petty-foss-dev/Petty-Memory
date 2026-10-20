import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { BiscottiMeeting } from '@enve-memory/importers';
import type { BiscottiQuery, BiscottiQueryResult } from '../shared/biscotti.ts';
import { DesktopError } from './dispatch.ts';

export const BISCOTTI_ENDPOINT = 'http://127.0.0.1:8516/mcp';
const MAX_RESPONSE = 2 * 1024 * 1024;
const TIMEOUT = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string) => new DesktopError('invalid', message);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function biscottiLink(id: string, seconds?: number): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid('Open the original from a meeting with a Biscotti UUID.');
  if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400)) {
    throw invalid('Choose a recording time between zero and 24 hours.');
  }
  return `biscotti://meeting/${id.toLowerCase()}${seconds === undefined ? '' : `?time=${seconds}`}`;
}

export class BiscottiClient {
  private readonly endpoint: URL;
  private readonly request: typeof fetch;

  constructor(options: { endpoint?: string; fetch?: typeof fetch } = {}) {
    this.endpoint = new URL(options.endpoint ?? BISCOTTI_ENDPOINT);
    if (this.endpoint.protocol !== 'http:' || this.endpoint.hostname !== '127.0.0.1' || this.endpoint.pathname !== '/mcp'
      || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
      throw invalid('Biscotti must use its local Mac connection.');
    }
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async query(input: BiscottiQuery = {}): Promise<BiscottiQueryResult> {
    if (!object(input)) throw invalid('Meeting search options must be an object.');
    const args: Record<string, string | number> = {};
    if (input.query !== undefined) args.query = text(input.query, 'Search', 500);
    if (input.after !== undefined) args.after = date(input.after, false);
    if (input.before !== undefined) args.before = date(input.before, true);
    if (args.after && args.before && String(args.after) > String(args.before)) throw invalid('The start date must come before the end date.');
    const limit = input.limit ?? 50;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 250) throw invalid('Load between one and 250 meetings at a time.');
    args.limit = limit;
    return this.connected(async (client) => {
      const payload = await this.tool(client, 'biscotti_query_meetings', args);
      if (!Array.isArray(payload.results) || payload.results.length > limit || typeof payload.results_truncated !== 'boolean') {
        throw invalid('Biscotti returned an invalid meeting list. Update Biscotti and try again.');
      }
      return {
        results: payload.results.map((entry: unknown) => {
          if (!object(entry)) throw invalid('Biscotti returned an invalid meeting.');
          const id = text(entry.id, 'Meeting id', 200);
          biscottiLink(id);
          return { id: id.toLowerCase(), title: text(entry.title, 'Meeting title', 500), date: date(entry.date, false),
            ...(entry.query_snippet === undefined ? {} : { querySnippet: text(entry.query_snippet, 'Search excerpt', 5000) }) };
        }),
        truncated: payload.results_truncated,
      };
    });
  }

  async meeting(id: string): Promise<BiscottiMeeting> {
    biscottiLink(id);
    return this.connected(async (client) => {
      const detail = await this.tool(client, 'biscotti_get_meeting', { id });
      const sourceID = text(detail.id, 'Meeting id', 200).toLowerCase();
      if (sourceID !== id.toLowerCase()) throw invalid('Biscotti returned a different meeting. Choose it again.');
      if (!object(detail.transcript) || typeof detail.transcript.available !== 'boolean') throw invalid('Biscotti returned invalid transcript details.');
      let transcript = '';
      if (detail.transcript.available) {
        const result = await this.tool(client, 'biscotti_get_transcript', { id });
        if (typeof result.id !== 'string' || result.id.toLowerCase() !== sourceID) throw invalid('Biscotti returned a transcript from another meeting.');
        if (typeof detail.transcript.id === 'string' && result.transcript_id !== detail.transcript.id) {
          throw new DesktopError('conflict', 'The transcript changed while loading. Preview the meeting again.');
        }
        transcript = text(result.text, 'Transcript', 500_000);
      }
      return {
        id: sourceID, title: text(detail.title, 'Meeting title', 500), date: date(detail.date, false),
        summary: text(detail.summary ?? '', 'Summary', 100_000), notes: text(detail.notes ?? '', 'Notes', 100_000), transcript,
        participants: people(detail.participants), tags: strings(detail.tags, 'Meeting tags', 50, 100),
      };
    });
  }

  private async connected<T>(read: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'petty-memory-biscotti', version: '0.1.0' }, { versionNegotiation: { mode: 'legacy' } });
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: { redirect: 'error' }, fetch: (input, init) => this.fetchBounded(input, init),
    });
    try {
      await client.connect(transport, { timeout: TIMEOUT });
      return await read(client);
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError('unavailable', 'Biscotti could not be reached. Open it on this Mac and enable Settings → General → MCP, then try again.');
    } finally {
      await client.close();
    }
  }

  private async tool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result: CallToolResult = await client.callTool({ name, arguments: args }, { timeout: TIMEOUT });
    if (result.isError) throw new DesktopError('unavailable', 'Biscotti could not read that meeting. Refresh the list and try again.');
    let payload = result.structuredContent;
    if (payload === undefined) {
      const body = result.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      try { payload = JSON.parse(body ?? ''); }
      catch { throw invalid('Biscotti returned an unreadable response. Update Biscotti and try again.'); }
    }
    if (!object(payload)) throw invalid('Biscotti returned an invalid response.');
    return payload;
  }

  private async fetchBounded(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== this.endpoint.href) throw invalid('The Biscotti connection tried to leave this Mac.');
    const response = await this.request(input, { ...init, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(TIMEOUT)]) });
    if (response.status >= 300 && response.status < 400) throw invalid('Biscotti redirected the connection. Check its local MCP setting.');
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
      await response.body?.cancel();
      throw invalid('That Biscotti response is too large. Export the meeting as CSV instead.');
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) throw invalid('That Biscotti response is too large. Export the meeting as CSV instead.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw invalid(`${label} is missing or too long.`);
  return value;
}

function date(value: unknown, end: boolean): string {
  const raw = text(value, 'Meeting date', 64);
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2})))?$/.exec(raw);
  if (!parts || Number(parts[4] ?? 0) > 23 || Number(parts[5] ?? 0) > 59 || Number(parts[6] ?? 0) > 59
    || Number(parts[7] ?? 0) > 23 || Number(parts[8] ?? 0) > 59) throw invalid('Use a valid meeting date.');
  const calendar = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== raw.slice(0, 10)) throw invalid('Use a valid meeting date.');
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) throw invalid('Use a valid meeting date.');
  return new Date(stamp + (end && raw.length === 10 ? 86_399_999 : 0)).toISOString();
}

function strings(value: unknown, label: string, count: number, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > count) throw invalid(`${label} has too many entries.`);
  return [...new Set(value.map((entry) => text(entry, label, max).trim()).filter(Boolean))];
}

function people(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid('That meeting has too many participants.');
  return strings(value.map((person: unknown) => {
    if (!object(person)) throw invalid('Biscotti returned invalid participants.');
    return person.name;
  }), 'Participant names', 100, 200);
}
