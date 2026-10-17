export interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: { readonly isFinal: boolean; readonly [alternative: number]: { readonly transcript: string } | undefined };
}

export interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognizerConstructor = new () => Recognizer;

export type DictationState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'listening'; interim: string }
  | { status: 'failed'; message: string; useSystem: boolean };

export interface Dictation {
  start(): void;
  /** Waits for words already heard; a second stop gives up waiting. */
  stop(): void;
  /** Aborts at once without reporting; the caller resets its own state. */
  cancel(): void;
}

export const DICTATION_NOTE = 'Your browser or system speech service turns speech into text and may send the audio off this device. Dictation only fills in the message; nothing is sent until you press Send.';

export function speechRecognizer(scope: object): RecognizerConstructor | null {
  const { SpeechRecognition, webkitSpeechRecognition } = scope as { SpeechRecognition?: RecognizerConstructor; webkitSpeechRecognition?: RecognizerConstructor };
  return SpeechRecognition ?? webkitSpeechRecognition ?? null;
}

const FAILURES: Record<string, { message: string; useSystem: boolean }> = {
  'not-allowed': { message: 'Microphone or speech access was blocked here.', useSystem: true },
  'service-not-allowed': { message: 'Speech recognition isn’t available here.', useSystem: true },
  network: { message: 'The speech service couldn’t be reached.', useSystem: true },
  'audio-capture': { message: 'No microphone could be used.', useSystem: true },
  'language-not-supported': { message: 'Speech recognition doesn’t support your language here.', useSystem: true },
  'no-speech': { message: 'No speech was heard. Press Dictate to try again.', useSystem: false },
};

export function createDictation(Recognition: RecognizerConstructor, { lang, onText, onState }: {
  lang: string;
  onText: (text: string) => void;
  onState: (state: DictationState) => void;
}): Dictation {
  let active: Recognizer | null = null;
  let stopping = false;

  const release = (recognizer: Recognizer) => {
    recognizer.onstart = recognizer.onresult = recognizer.onerror = recognizer.onend = null;
    if (active === recognizer) active = null;
  };

  return {
    start() {
      if (active) return;
      let recognizer: Recognizer;
      try {
        recognizer = new Recognition();
      } catch {
        onState({ status: 'failed', message: 'Speech recognition couldn’t start here.', useSystem: true });
        return;
      }
      // Results stay in the list as the service revises them; each final one is handed over once.
      const delivered = new Set<number>();
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
        onState({ status: 'failed', message: 'Speech recognition couldn’t start here.', useSystem: true });
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

export function appendDictation(draft: string, text: string): string {
  if (!draft.trim()) return text;
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`;
}

export function systemDictationHelp(platform: string): string {
  if (platform === 'darwin') return 'Use macOS Dictation instead: click in the message and press your Dictation shortcut (System Settings → Keyboard → Dictation).';
  if (platform === 'win32') return 'Use Windows voice typing instead: click in the message and press Windows key + H.';
  if (platform === 'linux') return 'Use your desktop’s dictation or voice typing tool instead, with the message box focused.';
  return 'Use your device’s own dictation instead, such as the microphone key on its keyboard, with the message box focused.';
}
