import { type AnnotationInput, type EnveMemory, type OcrPageInput, type SaveTranscriptInput, pageCursor } from '@enve-memory/core';
import { type CaptionFormat, extractImageBytes, ingestItem, parseTranscript, transcribeAudio } from '@enve-memory/ingestion';
import { knowledgeInvalid, knowledgePath, knowledgeText, type KnowledgeRoute } from './knowledge-common.ts';

const optionalNumber = (query: URLSearchParams, name: string) => query.has(name) ? Number(query.get(name)) : undefined;

export const researchRoutes: KnowledgeRoute[] = [
  { method: 'GET', pattern: knowledgePath('/research/sources'), scope: 'read', handle: ({ memory, query }) => {
    const files = memory.items.list({ type: 'file', before: query.get('before') ?? undefined, secret: false, excludeDefinitions: true }, 100);
    const items = files.map((file) => ({ ...memory.items.get(file.id), metadata: file.metadata, content: '' })).filter((item) => !item.archivedAt && item.metadata.knowledgeDefinition !== true
      && item.attachments.some((file) => file.mimeType === 'application/pdf' || file.mimeType.startsWith('audio/')));
    return { items, next: files.length === 100 ? pageCursor(files.at(-1)!) : null };
  } },
  { method: 'GET', pattern: knowledgePath('/research/pdf/:id'), scope: 'read', handle: ({ memory, params }) => memory.research.pdfSource(params[0]!) },
  { method: 'GET', pattern: knowledgePath('/research/pdf/:id/pages'), scope: 'read', handle: ({ memory, params, query }) => memory.research.pages(params[0]!, {
    from: optionalNumber(query, 'from'), limit: optionalNumber(query, 'limit'),
  }) },
  { method: 'GET', pattern: knowledgePath('/research/pdf/:id/find'), scope: 'read', handle: ({ memory, params, query }) => memory.research.findInPdf(params[0]!, query.get('q') ?? '', { limit: optionalNumber(query, 'limit') }) },
  { method: 'GET', pattern: knowledgePath('/research/pdf/:id/annotations'), scope: 'read', handle: ({ memory, params, query }) => memory.research.annotations(params[0]!, { limit: optionalNumber(query, 'limit') }) },
  { method: 'POST', pattern: knowledgePath('/research/pdf/:id/index'), scope: 'write', handle: async ({ memory, params }) => {
    memory.research.requestPageText(params[0]!);
    await ingestItem(memory, params[0]!);
    return memory.research.pdfSource(params[0]!);
  } },
  { method: 'POST', pattern: knowledgePath('/research/annotations'), scope: 'write', handle: ({ memory, body }) => memory.research.annotate(body as unknown as AnnotationInput) },
  { method: 'GET', pattern: knowledgePath('/research/annotations/:id'), scope: 'read', handle: ({ memory, params }) => memory.research.locateAnnotation(params[0]!) },
  { method: 'POST', pattern: knowledgePath('/research/ocr-pages'), scope: 'write', handle: ({ memory, body }) => memory.research.saveOcrPage(body as unknown as OcrPageInput) },
  { method: 'POST', pattern: knowledgePath('/research/ocr'), scope: 'write', transient: true, handle: async ({ memory, body }) => {
    const sourceId = knowledgeText(body, 'sourceId');
    const sha256 = knowledgeText(body, 'sha256');
    const page = Number(body?.page);
    const source = memory.research.pages(sourceId, { from: page, limit: 1 });
    if (source.sha256 !== sha256) throw knowledgeInvalid('The PDF changed. Open it again before recognizing text.');
    const encoded = knowledgeText(body, 'png');
    if (encoded.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw knowledgeInvalid('Send one rendered PDF page as PNG, up to 20 MB.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw knowledgeInvalid('The rendered page must be a PNG image.');
    const result = await extractImageBytes(bytes, 'image/png');
    if (memory.research.pdfSource(sourceId).sha256 !== sha256) throw knowledgeInvalid('The PDF changed during recognition. Open it again and retry.');
    return { ...result, sourceId, page, sha256 };
  } },
  { method: 'GET', pattern: knowledgePath('/research/audio/:id'), scope: 'read', handle: ({ memory, params }) => ({
    transcripts: memory.research.transcripts(params[0]!),
  }) },
  { method: 'POST', pattern: knowledgePath('/research/transcripts/preview'), scope: 'read', transient: true, handle: ({ memory, body }) => {
    const parsed = parseTranscript(knowledgeText(body, 'data'), body?.format as CaptionFormat | undefined);
    return { ...memory.research.previewTranscript({ audioId: knowledgeText(body, 'audioId'), segments: parsed.segments, format: parsed.format, engine: parsed.engine }), skipped: parsed.skipped };
  } },
  { method: 'POST', pattern: knowledgePath('/research/transcripts'), scope: 'write', handle: ({ memory, body }) => memory.research.saveTranscript(body as unknown as SaveTranscriptInput) },
  { method: 'POST', pattern: knowledgePath('/research/transcribe'), scope: 'write', transient: true, handle: async ({ memory, body, transcription }) => {
    if (body?.confirmed !== true) throw knowledgeInvalid('Confirm sending this recording to the configured transcription server.');
    const audioId = knowledgeText(body, 'audioId');
    const audio = memory.items.get(audioId);
    if (audio.metadata.secret === true || audio.archivedAt || audio.metadata.knowledgeDefinition === true) throw knowledgeInvalid('Choose an active ordinary recording.');
    const config = transcription();
    if (!config) throw knowledgeInvalid('Configure a transcription server on the library host, or import a VTT, SRT or timed JSON transcript.');
    const hash = memory.files.primary(audioId).attachment.sha256;
    const parsed = await transcribeAudio(memory, audioId, config);
    if (memory.files.primary(audioId).attachment.sha256 !== hash) throw knowledgeInvalid('The recording changed during transcription. Select it again and retry.');
    return { ...memory.research.previewTranscript({ audioId, segments: parsed.segments, format: parsed.format, engine: parsed.engine }), skipped: parsed.skipped };
  } },
  { method: 'GET', pattern: knowledgePath('/research/transcripts/:id'), scope: 'read', handle: ({ memory, params }) => memory.research.transcript(params[0]!) },
  { method: 'GET', pattern: knowledgePath('/research/transcripts/:id/passages'), scope: 'read', handle: ({ memory, params, query }) => memory.research.passages(params[0]!, { limit: optionalNumber(query, 'limit') }) },
  { method: 'GET', pattern: knowledgePath('/research/audio-locator/:id'), scope: 'read', handle: ({ memory, params, query }) => memory.research.audioLocator(params[0]!, optionalNumber(query, 'segment')) },
  { method: 'POST', pattern: knowledgePath('/research/passages'), scope: 'write', handle: ({ memory, body }) => memory.research.savePassage(body as unknown as Parameters<EnveMemory['research']['savePassage']>[0]) },
  { method: 'GET', pattern: knowledgePath('/research/transcription'), scope: 'read', handle: ({ transcription }) => {
    const config = transcription();
    return { configured: Boolean(config), baseUrl: config?.baseUrl ?? '', model: config?.model ?? '' };
  } },
];
