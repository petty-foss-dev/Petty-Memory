import { fileURLToPath } from 'node:url';
import { buildEditor } from '@enve-memory/editor/build';

// The shared formatted editor, as static files the page loads from its own origin.
await buildEditor(fileURLToPath(new URL('./public/vendor/', import.meta.url)));
