// Generates media/icon.png (128×128): an original, simple "stacked aligned
// reads" mark. No IGV branding is used (spec §1.1). Pure Node, no deps.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const px = new Uint8Array(SIZE * SIZE * 4);

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function fill(x0, y0, w, h, color, radius = 0) {
  const [r, g, b] = hex(color);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      if (radius > 0) {
        const cx = x < x0 + radius ? x0 + radius : x >= x0 + w - radius ? x0 + w - radius - 1 : x;
        const cy = y < y0 + radius ? y0 + radius : y >= y0 + h - radius ? y0 + h - radius - 1 : y;
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
      }
      const i = (y * SIZE + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
}

// Background tile
fill(0, 0, SIZE, SIZE, '#1e3a5f', 22);
// Reference line
fill(16, 26, 96, 6, '#e2e8f0', 3);
// Reads: [x, width, row, color]
const rows = [40, 56, 72, 88, 104];
const reads = [
  [16, 44, 0, '#60a5fa'], [66, 46, 0, '#60a5fa'],
  [26, 50, 1, '#93c5fd'], [84, 28, 1, '#93c5fd'],
  [16, 30, 2, '#60a5fa'], [52, 60, 2, '#60a5fa'],
  [36, 40, 3, '#93c5fd'], [82, 30, 3, '#93c5fd'],
  [20, 54, 4, '#60a5fa'], [80, 32, 4, '#60a5fa'],
];
for (const [x, w, row, color] of reads) fill(x, rows[row], w, 10, color, 4);
// Variant column
fill(60, 26, 6, 6, '#f87171', 2);
fill(60, 40, 6, 10, '#f87171', 2);
fill(60, 72, 6, 10, '#f87171', 2);
fill(60, 104, 6, 10, '#f87171', 2);

// PNG encode
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'media'), { recursive: true });
writeFileSync(join(root, 'media/icon.png'), png);
console.log(`wrote media/icon.png (${png.length} bytes)`);
