import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { BiscottiClient, biscottiLink } from '../src/main/biscotti.ts';

const id = '19a2cad1-51bf-4c43-a749-1efcbd986f1c';
const calls: { name: string; arguments: Record<string, unknown> }[] = [];
let mismatchedTranscript = false;
let toolError = false;
let textResponse = false;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks).toString());
  if (rpc.id === undefined) { res.writeHead(202).end(); return; }
  let result: unknown;
  if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Biscotti fixture', version: '1.0' } };
  else if (rpc.method === 'tools/list') result = { tools: ['biscotti_query_meetings', 'biscotti_get_meeting', 'biscotti_get_transcript'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
  else if (rpc.method === 'tools/call') {
    calls.push(rpc.params);
    const payload = rpc.params.name === 'biscotti_query_meetings'
      ? { results: [{ id, title: 'Garden launch', date: '2026-10-19T10:00:00Z', query_snippet: 'Order cedar.' }], results_truncated: false }
      : rpc.params.name === 'biscotti_get_meeting'
        ? { id, title: 'Garden launch', date: '2026-10-19T10:00:00Z', summary: 'Order cedar.', notes: 'Keep the receipts.',
          participants: [{ name: 'Alex', email: 'alex@example.invalid' }], tags: ['garden'],
          transcript: { available: true, id: 'transcript-one' }, audio_files: { present: true, microphone: '/private/never-read.wav' } }
        : { id, transcript_id: mismatchedTranscript ? 'transcript-two' : 'transcript-one', text: '[0:23] Alex\nOrder cedar.' };
    result = toolError ? { content: [{ type: 'text', text: 'not available' }], isError: true }
      : textResponse ? { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        : { content: [], structuredContent: payload };
  } else { res.writeHead(400).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
const client = new BiscottiClient({ endpoint });

test('the live connector searches and reads only the selected meeting through read-only MCP tools', async () => {
  const found = await client.query({ query: 'cedar', after: '2026-10-01', before: '2026-10-20', limit: 20 });
  assert.equal(found.results[0]!.id, id);
  assert.equal(found.truncated, false);
  const meeting = await client.meeting(id);
  assert.equal(meeting.transcript, '[0:23] Alex\nOrder cedar.');
  assert.deepEqual(meeting.participants, ['Alex']);
  assert.equal('audio_files' in meeting, false);
  assert.equal(JSON.stringify(meeting).includes('/private/'), false);
  assert.deepEqual(calls.map((call) => call.name), ['biscotti_query_meetings', 'biscotti_get_meeting', 'biscotti_get_transcript']);
  assert.equal(calls[0]!.arguments.before, '2026-10-20T23:59:59.999Z');
});

test('text tool payloads are supported, and tool failures and changed transcripts are refused', async () => {
  textResponse = true;
  assert.equal((await client.query()).results[0]!.title, 'Garden launch');
  textResponse = false;
  toolError = true;
  await assert.rejects(client.query(), /could not read/i);
  toolError = false;
  mismatchedTranscript = true;
  await assert.rejects(client.meeting(id), /transcript changed/i);
  mismatchedTranscript = false;
});

test('connection endpoints, recording links and search boundaries cannot escape their intended surface', async () => {
  for (const bad of ['https://example.com/mcp', 'http://localhost:8516/mcp', 'http://127.0.0.1:8516/other', 'http://user@127.0.0.1/mcp']) {
    assert.throws(() => new BiscottiClient({ endpoint: bad }), /local Mac connection/);
  }
  assert.equal(biscottiLink(id.toUpperCase(), 23.5), `biscotti://meeting/${id}?time=23.5`);
  for (const bad of ['../../../secret', 'https://example.com', `${id}?time=1`]) assert.throws(() => biscottiLink(bad), /UUID/);
  for (const bad of [-1, Infinity, NaN, 86_401]) assert.throws(() => biscottiLink(id, bad), /recording time/);
  await assert.rejects(client.query({ before: '2026-02-30T00:00:00Z' }), /valid meeting date/);
  await assert.rejects(client.query({ after: '2026-10-20', before: '2026-10-19' }), /start date/);
  await assert.rejects(client.query({ limit: 251 }), /250 meetings/);
});

test('redirects and excessive response bodies are rejected without following an external location', async () => {
  let requested = 0;
  const redirect = new BiscottiClient({ endpoint, fetch: async (_url, options) => {
    requested++;
    assert.equal(options?.redirect, 'error');
    return new Response('', { status: 302, headers: { Location: 'https://example.invalid/private' } });
  } });
  await assert.rejects(redirect.query());
  assert.equal(requested, 1);
  const large = new BiscottiClient({ endpoint, fetch: async () => new Response('too big', { headers: { 'Content-Length': String(3 * 1024 * 1024) } }) });
  await assert.rejects(large.query());
  const streaming = new BiscottiClient({ endpoint, fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  await assert.rejects(streaming.query());
});
