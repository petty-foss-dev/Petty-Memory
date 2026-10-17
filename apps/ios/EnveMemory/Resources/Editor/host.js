// Bridges the shared editor to the app. Every message goes to the "pettyEditor" handler; requests resolve with its reply.
import { controlledValue, createMarkdownEditor } from './editor.js';

const native = window.webkit.messageHandlers.pettyEditor;
let editor = null;
let sync = null;

window.pettyEditorHost = {
  mount({ markdown, label, placeholder }) {
    editor?.destroy();
    editor = createMarkdownEditor(document.getElementById('editor'), {
      markdown,
      label,
      placeholder,
      requestLink: async (current) => (await native.postMessage({ type: 'requestLink', current })) ?? null,
      requestReference: async () => (await native.postMessage({ type: 'requestReference' })) ?? null,
      onChange: (value) => {
        sync.emitted(value);
        native.postMessage({ type: 'change', markdown: value });
      },
    });
    sync = controlledValue(editor);
  },
  setMarkdown(markdown) { sync.receive(markdown); },
  setTheme(variables) {
    for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value);
  },
};

native.postMessage({ type: 'loaded' });
