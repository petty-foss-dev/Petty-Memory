import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

// Archived pages are rendered in this document, so the policy blocks remote loads of every kind (no beacons, no scripts).
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "font-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

// Vite's dev server needs inline scripts (React refresh), inline styles and its HMR socket.
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "font-src 'self' blob:",
  "connect-src 'self' ws://localhost:5199",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const csp = (dev: boolean): Plugin => ({
  name: 'enve-csp',
  transformIndexHtml: (html) => html.replace('%CSP%', dev ? DEV_CSP : PRODUCTION_CSP),
});

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), csp(command === 'serve')],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
  },
  server: { port: 5199, strictPort: true, host: 'localhost' },
}));
