import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export function buildResearchAssets(destination) {
  mkdirSync(destination, { recursive: true });
  const pdf = new URL(import.meta.resolve('unpdf/pdfjs'));
  copyFileSync(pdf, new URL('pdfjs.mjs', destination));
  writeFileSync(new URL('pdf-licenses.txt', destination), [
    'PDF research renderer: unpdf (MIT), bundled PDF.js (Apache-2.0).',
    'https://github.com/unjs/unpdf — https://github.com/mozilla/pdf.js',
    readFileSync(new URL('../LICENSE', pdf), 'utf8'),
    readFileSync(new URL('./PDFJS-LICENSE', import.meta.url), 'utf8'),
  ].join('\n\n'));
}
