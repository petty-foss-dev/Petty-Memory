const MAX_AUDIO = 25 * 1024 * 1024;

export function createAudioRecorder({ onComplete, onError, onState }) {
  let recorder = null;
  let stream = null;
  let timer = null;
  let generation = 0;
  let disposed = false;
  let starting = false;

  function release() {
    if (timer) clearTimeout(timer);
    timer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function stop() {
    generation++;
    starting = false;
    if (recorder?.state === 'recording') recorder.stop();
    else { release(); if (!disposed) onState(false); }
  }

  async function start() {
    if (disposed || starting || recorder?.state === 'recording') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError('Recording needs microphone access in a secure browser context. Use localhost or HTTPS, or import an audio file.');
      return;
    }
    const mine = ++generation;
    starting = true;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (disposed || mine !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      recorder = active;
      const chunks = [];
      let size = 0;
      let failed = false;
      active.addEventListener('dataavailable', ({ data }) => {
        if (disposed || failed || !data.size) return;
        size += data.size;
        if (size > MAX_AUDIO) {
          failed = true;
          chunks.length = 0;
          onError('The recording exceeded 25 MB. Import a shorter recording.');
          stop();
        } else chunks.push(data);
      });
      active.addEventListener('error', () => {
        failed = true;
        chunks.length = 0;
        if (!disposed) onError('Recording failed. Check microphone access and try again.');
        stop();
      });
      active.addEventListener('stop', () => {
        release();
        if (recorder === active) recorder = null;
        if (!disposed) {
          onState(false);
          if (!failed && chunks.length) onComplete(new Blob(chunks, { type: active.mimeType || 'audio/webm' }));
        }
      }, { once: true });
      active.start(1000);
      onState(true);
      timer = setTimeout(stop, 60 * 60_000);
    } catch (error) {
      release();
      if (!disposed && mine === generation) {
        onState(false);
        onError(error?.name === 'NotAllowedError' ? 'Microphone access was refused. Allow it in your browser or system settings, or import audio.' : 'The microphone could not start. Check that it is connected and available.');
      }
    } finally {
      if (mine === generation) starting = false;
    }
  }

  const hidden = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', stop);
  return {
    start, stop,
    dispose() {
      disposed = true;
      stop();
      release();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', stop);
    },
  };
}

export async function openResearchPdf(bytes) {
  const script = new URL('./vendor/pdfjs.mjs', import.meta.url);
  const { getDocument, PDFWorker } = await import(/* @vite-ignore */ script.href);
  const port = new Worker(script.href, { type: 'module' });
  const worker = new PDFWorker({ port });
  const task = getDocument({ data: new Uint8Array(bytes), worker, isEvalSupported: false, useSystemFonts: true, useWorkerFetch: false });
  let pdf;
  try { pdf = await task.promise; }
  catch (error) { worker.destroy(); port.terminate(); throw error; }
  let rendering = null;
  let closed = false;
  return {
    pageCount: pdf.numPages,
    async render(pageNumber, canvas) {
      if (closed) throw new Error('This document is closed. Open it again.');
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) throw new Error('Choose a page in this document.');
      if (rendering) { rendering.cancel(); await rendering.promise.catch(() => {}); }
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2.5, 1600 / base.width, Math.sqrt(12_000_000 / (base.width * base.height))) });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser could not draw the PDF page.');
      rendering = page.render({ canvasContext: context, canvas, viewport });
      await rendering.promise;
      rendering = null;
      const text = await page.getTextContent();
      return text.items.filter((item) => typeof item.str === 'string').map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
    },
    async close() {
      closed = true;
      rendering?.cancel();
      await task.destroy();
      worker.destroy();
      port.terminate();
    },
  };
}

export function canvasPng(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The page could not be prepared for text recognition.')), 'image/png'));
}
