import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { Extracted } from './html.ts';

const MAX_CONTENT = 2 * 1024 * 1024;

/** What `metadata.pdfPages` keeps: pages from page 1 until a limit is reached, so a kept page is never renumbered. */
export const PDF_PAGE_LIMITS = { pages: 2000, pageChars: 100_000, totalBytes: 2 * 1024 * 1024 } as const;

export async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const { info } = await getMeta(pdf);
    const pages = text.map((page) => page.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    const content = pages.filter(Boolean).join('\n\n').slice(0, MAX_CONTENT);
    const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
    const author = typeof info?.Author === 'string' ? info.Author.trim() : '';
    return {
      title,
      content,
      metadata: {
        pageCount: totalPages,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        ...(author ? { byline: author } : {}),
        pdfPages: pageIndex(pages, totalPages),
      },
    };
  } finally {
    await pdf.cleanup();
  }
}

function pageIndex(texts: string[], pageCount: number) {
  const pages: string[] = [];
  const clipped: number[] = [];
  let bytes = 0;
  for (const raw of texts) {
    if (pages.length === PDF_PAGE_LIMITS.pages) break;
    let text = raw.slice(0, PDF_PAGE_LIMITS.pageChars);
    // Never leave half of a surrogate pair at the cut.
    if (text.length < raw.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const size = Buffer.byteLength(text);
    if (bytes + size > PDF_PAGE_LIMITS.totalBytes) break;
    if (text.length < raw.length) clipped.push(pages.length + 1);
    pages.push(text);
    bytes += size;
  }
  return { version: 1, pageCount, pages, clipped, truncated: pages.length < pageCount || clipped.length > 0 };
}
