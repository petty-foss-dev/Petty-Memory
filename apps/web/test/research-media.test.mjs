import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAudioRecorder } from '../public/research-media.js';

const originals = new Map(['navigator', 'document', 'window', 'MediaRecorder'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function environment(acquire) {
  const events = { completed: [], errors: [], states: [], stopped: 0, acquired: 0 };
  const stream = { getTracks: () => [{ stop() { events.stopped++; } }] };
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const win = new EventTarget();
  class Recorder extends EventTarget {
    static latest;
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/webm';
    constructor() { super(); Recorder.latest = this; }
    start() { this.state = 'recording'; }
    chunk(bytes) { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([bytes]) })); }
    stop() {
      if (this.state !== 'recording') return;
      this.state = 'inactive';
      this.dispatchEvent(new Event('stop'));
    }
  }
  for (const [key, value] of Object.entries({
    navigator: { mediaDevices: { getUserMedia: async () => { events.acquired++; return acquire ? acquire(stream) : stream; } } },
    document: doc, window: win, MediaRecorder: Recorder,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  const recording = createAudioRecorder({ onComplete: (blob) => events.completed.push(blob), onError: (error) => events.errors.push(error), onState: (state) => events.states.push(state) });
  return { recording, events, doc, Recorder };
}

test('recording asks for the microphone only on Start, then stops when hidden without saving', async () => {
  const { recording, events, doc, Recorder } = environment();
  assert.equal(events.acquired, 0);
  await recording.start();
  Recorder.latest.chunk('fictional recording');
  assert.equal(events.completed.length, 0);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(events.states, [true, false]);
  assert.equal(events.completed.length, 1);
  assert.equal(await events.completed[0].text(), 'fictional recording');
  assert.equal(events.stopped, 1);
  recording.dispose();
});

test('leaving while permission is pending releases the late stream and never starts recording', async () => {
  let grant;
  const { recording, events, Recorder } = environment((stream) => new Promise((resolve) => { grant = () => resolve(stream); }));
  const pending = recording.start();
  recording.dispose();
  grant();
  await pending;
  assert.equal(events.stopped, 1);
  assert.equal(Recorder.latest, undefined);
  assert.deepEqual(events.completed, []);
  assert.deepEqual(events.states, []);
});

test('leaving an active recording discards its unsaved draft and releases the microphone', async () => {
  const { recording, events, Recorder } = environment();
  await recording.start();
  Recorder.latest.chunk('unsaved private draft');
  recording.dispose();
  Recorder.latest.chunk('late audio');
  assert.equal(events.stopped, 1);
  assert.deepEqual(events.completed, []);
});

test('oversized audio is refused and never delivered as a truncated recording', async () => {
  const { recording, events, Recorder } = environment();
  await recording.start();
  Recorder.latest.chunk(new Uint8Array(25 * 1024 * 1024 + 1));
  assert.equal(events.errors.length, 1);
  assert.match(events.errors[0], /25 MB/);
  assert.deepEqual(events.completed, []);
  assert.equal(events.stopped, 1);
  recording.dispose();
});
