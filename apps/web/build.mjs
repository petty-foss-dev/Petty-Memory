import { fileURLToPath } from 'node:url';
import { buildResearchAssets } from './research-assets.mjs';
import { buildEditor } from '@enve-memory/editor/build';

// The shared formatted editor, as static files the page loads from its own origin.
await buildEditor(fileURLToPath(new URL('./public/vendor/', import.meta.url)));
buildResearchAssets(new URL('./public/vendor/', import.meta.url));
