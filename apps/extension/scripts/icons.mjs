// Renders the toolbar icons (teal rounded square, white "M" stroke) to PNG with Node built-ins only.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const TEAL = [0x0f, 0x7a, 0x8a];
const WHITE = [0xff, 0xff, 0xff];
const GLYPH = [[0.29, 0.7], [0.29, 0.31], [0.5, 0.55], [0.71, 0.31], [0.71, 0.7]];
const SAMPLES = 8;

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function render(size) {
  // Small sizes get a heavier stroke so the glyph survives at 16px.
  const stroke = size <= 16 ? 0.16 : size <= 32 ? 0.13 : 0.11;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;
          if (!insideRoundedSquare(u, v, 0.23)) continue;
          bg++;
          const d = Math.min(...GLYPH.slice(1).map((p, i) => distanceToSegment(u, v, GLYPH[i], p)));
          if (d <= stroke / 2) fg++;
        }
      }
      const total = SAMPLES * SAMPLES;
      const i = (y * size + x) * 4;
      const mix = bg ? fg / bg : 0;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(TEAL[c] * (1 - mix) + WHITE[c] * mix);
      pixels[i + 3] = Math.round((bg / total) * 255);
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  await writeFile(join(out, `icon-${size}.png`), render(size));
  console.log(`icon-${size}.png`);
}
