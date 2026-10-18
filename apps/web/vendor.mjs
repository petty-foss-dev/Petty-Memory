import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const destination = new URL('./public/vendor/', import.meta.url);
mkdirSync(destination, { recursive: true });
const marked = new URL(import.meta.resolve('marked'));
const purify = new URL(import.meta.resolve('dompurify'));
copyFileSync(marked, new URL('marked.js', destination));
copyFileSync(purify, new URL('purify.js', destination));
const license = (file) => readFileSync(fileURLToPath(file), 'utf8');
writeFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), [
  '# Web renderer licenses',
  'The browser renderer uses the same Markdown parser and sanitizer as the desktop app.',
  'The PDF research renderer uses unpdf (MIT) and bundled PDF.js (Apache-2.0). Their license text ships in public/vendor/pdf-licenses.txt; the PDF.js license is preserved in PDFJS-LICENSE.',
  '## marked', license(new URL('../LICENSE', marked)),
  '## DOMPurify', license(new URL('../LICENSE', purify)),
].join('\n\n'));
