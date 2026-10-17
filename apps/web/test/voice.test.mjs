// Drives the browser's dictation helper (public/voice.js) with a scripted recognizer; no microphone is involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendDictation, createDictation, platformOf, speechRecognizer, systemDictationHelp } from '../public/voice.js';

class FakeRecognizer {
  static made = [];
  static failStart = false;
  calls = [];
  onstart = null;
  onresult = null;
  onerror = null;
  onend = null;

  constructor() {
    FakeRecognizer.made.push(this);
  }

  start() {
    this.calls.push('start');
    if (FakeRecognizer.failStart) throw new Error('blocked');
  }

  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }

  results(resultIndex, ...entries) {
    this.onresult?.({ resultIndex, results: entries.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  }
}

function setup() {
  FakeRecognizer.made = [];
  FakeRecognizer.failStart = false;
  const texts = [];
  const states = [];
  const dictation = createDictation(FakeRecognizer, { lang: 'fr-FR', onText: (text) => texts.push(text), onState: (state) => states.push(state) });
  return { dictation, texts, states, last: () => states.at(-1), recognizer: () => FakeRecognizer.made.at(-1) };
}

test('uses the standard recognizer, else the prefixed one, else none', () => {
  class Standard extends FakeRecognizer {}
  assert.equal(speechRecognizer({}), null);
  assert.equal(speechRecognizer({ webkitSpeechRecognition: FakeRecognizer }), FakeRecognizer);
  assert.equal(speechRecognizer({ SpeechRecognition: Standard, webkitSpeechRecognition: FakeRecognizer }), Standard);
});

test('listens continuously in the page language and says so only once the service starts', () => {
  const { dictation, last, recognizer } = setup();
  dictation.start();
  const r = recognizer();
  assert.deepEqual([r.lang, r.continuous, r.interimResults], ['fr-FR', true, true]);
  assert.deepEqual(last(), { status: 'starting' });
  r.onstart();
  assert.deepEqual(last(), { status: 'listening', interim: '' });
});

test('partial words are shown but not delivered; each final phrase is delivered once', () => {
  const { dictation, texts, last, recognizer } = setup();
  dictation.start();
  const r = recognizer();
  r.results(0, ['sort', false]);
  assert.deepEqual(last(), { status: 'listening', interim: 'sort' });
  assert.deepEqual(texts, []);
  r.results(0, ['sort by room', true], ['then', false]);
  r.results(0, ['sort by room', true], ['then date', true]);
  r.results(1, ['then date', true]);
  assert.deepEqual(texts, ['sort by room', 'then date']);
});

test('stop waits for the last words, a second stop aborts, and errors release the recognizer', () => {
  const { dictation, texts, last, recognizer } = setup();
  dictation.start();
  dictation.stop();
  recognizer().results(0, ['done', true]);
  recognizer().onend();
  assert.deepEqual(texts, ['done']);
  assert.deepEqual(last(), { status: 'idle' });

  dictation.start();
  dictation.stop();
  dictation.stop();
  assert.deepEqual(recognizer().calls, ['start', 'stop', 'abort']);

  dictation.start();
  const r = recognizer();
  r.onerror({ error: 'network' });
  assert.deepEqual(last(), { status: 'failed', message: 'The speech service couldn’t be reached.', useSystem: true });
  assert.deepEqual(r.calls, ['start', 'abort']);
  assert.equal(r.onend, null);

  dictation.start();
  recognizer().onerror({ error: 'no-speech' });
  assert.equal(last().useSystem, false);
});

test('a refused start fails honestly, and cancel aborts without reporting', () => {
  const { dictation, states, last, recognizer } = setup();
  FakeRecognizer.failStart = true;
  dictation.start();
  assert.equal(last().status, 'failed');
  FakeRecognizer.failStart = false;
  dictation.start();
  const count = states.length;
  dictation.cancel();
  assert.deepEqual(recognizer().calls, ['start', 'abort']);
  assert.equal(states.length, count);
});

test('dictation adds to typed text and system help fits the platform', () => {
  assert.equal(appendDictation('Group these', 'by room'), 'Group these by room');
  assert.equal(appendDictation('', 'by room'), 'by room');
  assert.equal(platformOf({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }), 'darwin');
  assert.equal(platformOf({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 }), 'other', 'iPadOS reports a Mac platform');
  assert.equal(platformOf({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), 'win32');
  assert.equal(platformOf({ platform: '', userAgentData: { platform: 'Linux' }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'linux');
  assert.equal(platformOf({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15)' }), 'other');
  assert.match(systemDictationHelp('win32'), /Windows key \+ H/);
  assert.match(systemDictationHelp('darwin'), /Dictation shortcut/);
});
