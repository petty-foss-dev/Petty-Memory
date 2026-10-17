import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type DictationState, type Recognizer, type SpeechResultList, appendDictation, createDictation, speechRecognizer, systemDictationHelp,
} from '../src/renderer/lib/voice.ts';

/** Stands in for the browser's recognizer; nothing here touches a microphone. */
class FakeRecognizer implements Recognizer {
  static made: FakeRecognizer[] = [];
  static failStart = false;
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: Recognizer['onstart'] = null;
  onresult: Recognizer['onresult'] = null;
  onerror: Recognizer['onerror'] = null;
  onend: Recognizer['onend'] = null;
  calls: string[] = [];

  constructor() {
    FakeRecognizer.made.push(this);
  }

  start() {
    this.calls.push('start');
    if (FakeRecognizer.failStart) throw new Error('not allowed to start');
  }

  stop() {
    this.calls.push('stop');
  }

  abort() {
    this.calls.push('abort');
  }

  results(resultIndex: number, ...entries: [string, boolean][]) {
    const results = entries.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) as unknown as SpeechResultList;
    this.onresult?.({ resultIndex, results });
  }
}

function setup() {
  FakeRecognizer.made = [];
  FakeRecognizer.failStart = false;
  const texts: string[] = [];
  const states: DictationState[] = [];
  const dictation = createDictation(FakeRecognizer, { lang: 'en-GB', onText: (text) => texts.push(text), onState: (state) => states.push(state) });
  return { dictation, texts, states, last: () => states.at(-1), recognizer: () => FakeRecognizer.made.at(-1)! };
}

test('finds the standard or prefixed recognizer and reports none when absent', () => {
  assert.equal(speechRecognizer({}), null);
  assert.equal(speechRecognizer({ webkitSpeechRecognition: FakeRecognizer }), FakeRecognizer);
  class Standard extends FakeRecognizer {}
  assert.equal(speechRecognizer({ SpeechRecognition: Standard, webkitSpeechRecognition: FakeRecognizer }), Standard);
});

test('starting configures continuous interim recognition and reports listening only once the service starts', () => {
  const { dictation, last, recognizer } = setup();
  dictation.start();
  const r = recognizer();
  assert.deepEqual([r.lang, r.continuous, r.interimResults, r.calls], ['en-GB', true, true, ['start']]);
  assert.deepEqual(last(), { status: 'starting' });
  r.onstart?.();
  assert.deepEqual(last(), { status: 'listening', interim: '' });
  dictation.start();
  assert.equal(FakeRecognizer.made.length, 1, 'a second start while active is ignored');
});

test('interim words are shown, and each final result is delivered exactly once', () => {
  const { dictation, texts, last, recognizer } = setup();
  dictation.start();
  const r = recognizer();
  r.onstart?.();
  r.results(0, ['buy', false]);
  assert.deepEqual(last(), { status: 'listening', interim: 'buy' });
  r.results(0, ['buy milk', true]);
  assert.deepEqual(texts, ['buy milk']);
  r.results(0, ['buy milk', true], ['and eggs', false]);
  r.results(1, ['and eggs', true]);
  r.results(0, ['buy milk', true], ['and eggs', true]);
  assert.deepEqual(texts, ['buy milk', 'and eggs']);
  assert.deepEqual(last(), { status: 'listening', interim: '' });
});

test('stop lets the last words arrive, then ends; a second stop gives up waiting', () => {
  const { dictation, texts, last, recognizer } = setup();
  dictation.start();
  const r = recognizer();
  r.onstart?.();
  r.results(0, ['pack the', false]);
  dictation.stop();
  assert.deepEqual(r.calls, ['start', 'stop']);
  r.results(0, ['pack the tent', true]);
  assert.deepEqual(texts, ['pack the tent']);
  r.onend?.();
  assert.deepEqual(last(), { status: 'idle' });

  dictation.start();
  const next = recognizer();
  dictation.stop();
  dictation.stop();
  assert.deepEqual(next.calls, ['start', 'stop', 'abort']);
  assert.deepEqual(last(), { status: 'idle' });
  assert.equal(next.onresult, null, 'handlers are released');
});

test('blocked or unreachable speech reports why and points to system dictation, releasing the recognizer', () => {
  for (const [error, useSystem] of [['not-allowed', true], ['service-not-allowed', true], ['network', true], ['audio-capture', true], ['no-speech', false]] as const) {
    const { dictation, last, recognizer } = setup();
    dictation.start();
    const r = recognizer();
    r.onerror?.({ error });
    const state = last();
    assert.equal(state?.status, 'failed', error);
    assert.equal(state?.status === 'failed' && state.useSystem, useSystem, error);
    assert.ok(r.calls.includes('abort'), error);
    assert.equal(r.onend, null, error);
  }
});

test('an aborted session is not an error, and a start that throws fails honestly', () => {
  const { dictation, states, last, recognizer } = setup();
  dictation.start();
  recognizer().onerror?.({ error: 'aborted' });
  assert.notEqual(last()?.status, 'failed');
  recognizer().onend?.();
  assert.deepEqual(last(), { status: 'idle' });

  FakeRecognizer.failStart = true;
  dictation.start();
  assert.deepEqual(last(), { status: 'failed', message: 'Speech recognition couldn’t start here.', useSystem: true });
  FakeRecognizer.failStart = false;
  dictation.start();
  assert.equal(states.filter((s) => s.status === 'starting').length, 3, 'a failed start leaves dictation ready to try again');
});

test('cancel aborts silently, for unmounting', () => {
  const { dictation, states, recognizer } = setup();
  dictation.start();
  const r = recognizer();
  const before = states.length;
  dictation.cancel();
  assert.deepEqual(r.calls, ['start', 'abort']);
  assert.equal(states.length, before);
  assert.equal(r.onresult, null);
  dictation.cancel();
  assert.deepEqual(r.calls, ['start', 'abort']);
});

test('dictated text is added after what was typed', () => {
  assert.equal(appendDictation('', 'hello'), 'hello');
  assert.equal(appendDictation('  ', 'hello'), 'hello');
  assert.equal(appendDictation('Organize', 'by room'), 'Organize by room');
  assert.equal(appendDictation('Organize\n', 'by room'), 'Organize\nby room');
});

test('system dictation help names each platform’s own shortcut', () => {
  assert.match(systemDictationHelp('darwin'), /Dictation shortcut/);
  assert.match(systemDictationHelp('win32'), /Windows key \+ H/);
  assert.match(systemDictationHelp('linux'), /desktop/);
  assert.match(systemDictationHelp('ios'), /device/);
});
