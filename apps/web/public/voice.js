// Mirrors the desktop renderer/lib/voice.ts.

export const DICTATION_NOTE = 'Your browser or system speech service turns speech into text and may send the audio off this device. Dictation only fills in the message; nothing is sent until you press Send.';
export const NOTE_DICTATION_NOTE = 'Your browser or system speech service turns speech into text and may send the audio off this device. Dictation only fills in the note; nothing is saved until you press Save.';

export function speechRecognizer(scope) {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const FAILURES = {
  'not-allowed': { message: 'Microphone or speech access was blocked here.', useSystem: true },
  'service-not-allowed': { message: 'Speech recognition isn’t available here.', useSystem: true },
  network: { message: 'The speech service couldn’t be reached.', useSystem: true },
  'audio-capture': { message: 'No microphone could be used.', useSystem: true },
  'language-not-supported': { message: 'Speech recognition doesn’t support your language here.', useSystem: true },
  'no-speech': { message: 'No speech was heard. Press Dictate to try again.', useSystem: false },
};

/**
 * Reports idle, starting, listening (with interim words) or failed through onState, and each final phrase once through
 * onText. stop() waits for words already heard; cancel() aborts without reporting.
 */
export function createDictation(Recognition, { lang, onText, onState }) {
  let active = null;
  let stopping = false;

  const release = (recognizer) => {
    recognizer.onstart = recognizer.onresult = recognizer.onerror = recognizer.onend = null;
    if (active === recognizer) active = null;
  };
  const cannotStart = () => onState({ status: 'failed', message: 'Speech recognition couldn’t start here.', useSystem: true });

  return {
    start() {
      if (active) return;
      let recognizer;
      try {
        recognizer = new Recognition();
      } catch {
        return cannotStart();
      }
      // Results stay in the list as the service revises them; each final one is handed over once.
      const delivered = new Set();
      recognizer.lang = lang;
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.onstart = () => onState({ status: 'listening', interim: '' });
      recognizer.onresult = ({ resultIndex, results }) => {
        let interim = '';
        for (let i = resultIndex; i < results.length; i++) {
          const result = results[i];
          const text = result?.[0]?.transcript.trim() ?? '';
          if (!result?.isFinal) interim += `${text} `;
          else if (!delivered.has(i)) {
            delivered.add(i);
            if (text) onText(text);
          }
        }
        if (!stopping) onState({ status: 'listening', interim: interim.trim() });
      };
      recognizer.onerror = ({ error }) => {
        if (error === 'aborted') return;
        release(recognizer);
        recognizer.abort();
        onState({ status: 'failed', ...(FAILURES[error] ?? { message: `Dictation stopped (${error}).`, useSystem: false }) });
      };
      recognizer.onend = () => {
        release(recognizer);
        onState({ status: 'idle' });
      };
      active = recognizer;
      stopping = false;
      onState({ status: 'starting' });
      try {
        recognizer.start();
      } catch {
        release(recognizer);
        cannotStart();
      }
    },
    stop() {
      const recognizer = active;
      if (!recognizer) return;
      if (stopping) {
        release(recognizer);
        recognizer.abort();
        onState({ status: 'idle' });
        return;
      }
      stopping = true;
      onState({ status: 'listening', interim: '' });
      recognizer.stop();
    },
    cancel() {
      const recognizer = active;
      if (!recognizer) return;
      release(recognizer);
      recognizer.abort();
    },
  };
}

export function appendDictation(draft, text) {
  if (!draft.trim()) return text;
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`;
}

/** Phones and tablets, iPads included, are `other`. */
export function platformOf(nav) {
  if (/iPhone|iPad|Android/.test(nav.userAgent ?? '') || (/Mac/.test(nav.platform ?? '') && nav.maxTouchPoints > 1)) return 'other';
  const platform = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''}`;
  if (/Mac/i.test(platform)) return 'darwin';
  if (/Win/i.test(platform)) return 'win32';
  if (/Linux/i.test(platform)) return 'linux';
  return 'other';
}

export function systemDictationHelp(platform, field = 'message') {
  if (platform === 'darwin') return `Use macOS Dictation instead: click in the ${field} and press your Dictation shortcut (System Settings → Keyboard → Dictation).`;
  if (platform === 'win32') return `Use Windows voice typing instead: click in the ${field} and press Windows key + H.`;
  if (platform === 'linux') return `Use your desktop’s dictation or voice typing tool instead, with the ${field} box focused.`;
  return `Use your device’s own dictation instead, such as the microphone key on its keyboard, with the ${field} box focused.`;
}
