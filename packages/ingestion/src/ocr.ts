import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EnveMemory, MemoryError } from '@enve-memory/core';
import { imageSize } from 'image-size';
import type { Worker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
let busy = false;

// Worker threads and WASM need real paths outside Electron's archive.
const assetPath = (path: string) => path.replace(/\.asar([/\\])/, '.asar.unpacked$1');

export async function extractImageText(memory: EnveMemory, attachmentId: string): Promise<{ text: string; engine: string }> {
  const { attachment, data } = memory.files.readAttachment(attachmentId, { maxBytes: MAX_BYTES });
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp'].includes(attachment.mimeType)) {
    throw new MemoryError('invalid', 'Choose a PNG, JPEG, WebP, TIFF or BMP image. Convert HEIC images on your phone before host extraction.');
  }
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(data); }
  catch { throw new MemoryError('invalid', 'That image could not be read. Try exporting it as PNG or JPEG.'); }
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_PIXELS) {
    throw new MemoryError('invalid', 'Choose an image with at most 25 million pixels.');
  }
  if (busy) throw new MemoryError('conflict', 'Another image is being read. Try again when it finishes.');
  busy = true;
  let worker: Worker | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recognize = async () => {
    const { createWorker } = await import('tesseract.js');
    const bundledWorker = fileURLToPath(new URL('./ocr-worker.cjs', import.meta.url));
    worker = await createWorker('eng', 1, {
      workerPath: assetPath(existsSync(bundledWorker) ? bundledWorker : require.resolve('tesseract.js/src/worker-script/node/index.js')),
      corePath: assetPath(dirname(require.resolve('tesseract.js-core/package.json'))),
      langPath: assetPath(join(dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int')),
      cacheMethod: 'none', gzip: true, errorHandler: () => {},
    });
    if (expired) { await worker.terminate(); return ''; }
    const result = await worker.recognize(data, { rotateAuto: true });
    return result.data.text.trim();
  };
  const recognition = recognize();
  try {
    const text = await Promise.race([
      recognition,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new MemoryError('invalid', 'Text extraction took too long. Try a smaller or clearer image.'));
        }, 45_000);
      }),
    ]);
    if (!text) throw new MemoryError('invalid', 'No readable text was found. Try a sharper image with larger text.');
    if (text.length > 100_000) throw new MemoryError('invalid', 'That image contains too much text for one note. Extract a smaller section.');
    return { text, engine: 'Tesseract · English · library host' };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('invalid', 'The image could not be recognized. Try a clear PNG or JPEG image.');
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
    if (worker) {
      await worker.terminate();
      busy = false;
    } else {
      void recognition.then(() => { busy = false; }, () => { busy = false; });
    }
  }
}
