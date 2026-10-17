import createDOMPurify, { type WindowLike } from 'dompurify';
import { Marked, type Tokens } from 'marked';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const SAFE_LINK = /^(?:https?:|mailto:)/i;
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;

export interface RenderOptions {
  /** Resolves relative links in archived pages against the page they came from. */
  baseUrl?: string | null;
  /** Current titles of referenced items, shown in place of the label saved with the reference. */
  titles?: ReadonlyMap<string, string>;
}

const ITEM_REFERENCE = /^\[\[item:([0-9a-fA-F-]{36})(?:\|([^\]\n]*))?\]\]/;

/**
 * Markdown → HTML for text we don't control (archived pages, notes written by agents). Raw HTML is shown as text,
 * only http(s)/mailto links survive, and remote images become links so opening a page never contacts its server.
 */
export function createMarkdown(window: WindowLike) {
  const purify = createDOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    if (node.nodeName === 'IMG' && data.attrName === 'src' && !INLINE_IMAGE.test(data.attrValue)) data.keepAttr = false;
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const href = node.getAttribute('href');
    if (!href || !SAFE_LINK.test(href)) {
      node.removeAttribute('href');
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  });

  const sanitize = (html: string) =>
    purify.sanitize(html, {
      USE_PROFILES: { html: true },
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'source', 'picture', 'object', 'embed'],
      FORBID_ATTR: ['style', 'srcset', 'ping', 'background', 'poster', 'id', 'name'],
      RETURN_TRUSTED_TYPE: false,
    }) as string;

  const render = (markdown: string, options: RenderOptions = {}): string => {
    const base = options.baseUrl ?? undefined;
    const marked = new Marked({
      gfm: true,
      async: false,
      // `[[item:UUID|label]]` becomes an in-app link with no href, so nothing but the app's own navigation can follow it.
      extensions: [{
        name: 'itemReference',
        level: 'inline',
        start: (src: string) => {
          const at = src.indexOf('[[item:');
          return at < 0 ? undefined : at;
        },
        tokenizer: (src: string) => {
          const match = ITEM_REFERENCE.exec(src);
          return match ? { type: 'itemReference', raw: match[0], id: match[1]!.toLowerCase(), label: match[2] ?? '' } : undefined;
        },
        renderer: (token) => {
          const label = options.titles?.get(token.id as string) || (token.label as string) || 'Linked item';
          return `<a class="item-ref" data-item="${escapeHtml(token.id as string)}">${escapeHtml(label)}</a>`;
        },
      }],
      walkTokens: (token) => {
        if ((token.type === 'link' || token.type === 'image') && base) {
          try {
            (token as Tokens.Link).href = new URL((token as Tokens.Link).href, base).href;
          } catch {}
        }
      },
      renderer: {
        html: ({ text }) => escapeHtml(text),
        image: ({ href, text }) => {
          if (INLINE_IMAGE.test(href)) return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`;
          const label = `Image${text ? `: ${escapeHtml(text)}` : ''}`;
          return SAFE_LINK.test(href) ? `<a class="md-remote-image" href="${escapeHtml(href)}">${label}</a>` : `<span class="md-remote-image">${label}</span>`;
        },
      },
    });
    return sanitize(marked.parse(markdown) as string);
  };

  return { render, sanitize };
}
