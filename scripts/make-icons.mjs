/**
 * Generates the PWA icons (point 62).
 *
 * Writes real PNGs with a tiny hand-rolled encoder rather than pulling in an
 * image library: the artwork is three rectangles and a chart bar, and a buyer
 * installing this product should not have to build a native toolchain to get
 * a home-screen icon.
 *
 * Run: node scripts/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CANVAS = [0x0a, 0x0b, 0x0d];
const ACCENT = [0x00, 0xd6, 0x8f];
const ACCENT_DIM = [0x00, 0x8f, 0x60];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes an RGB pixel buffer (size × size × 3) as a PNG. */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  // 10..12 stay zero: deflate, default filter, no interlace.

  // Every scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 3, (y + 1) * size * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The mark: three ascending bars on a dark ground — a portfolio that grows.
 *
 * `inset` is the share of the canvas kept clear around the art. Maskable icons
 * need a wide safe zone because the platform crops them to its own shape.
 */
function draw(size, inset) {
  const pixels = Buffer.alloc(size * size * 3);

  for (let i = 0; i < size * size; i += 1) {
    pixels[i * 3] = CANVAS[0];
    pixels[i * 3 + 1] = CANVAS[1];
    pixels[i * 3 + 2] = CANVAS[2];
  }

  const put = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  };

  const pad = Math.round(size * inset);
  const area = size - pad * 2;
  const gap = Math.max(1, Math.round(area * 0.09));
  const barWidth = Math.round((area - gap * 2) / 3);
  const baseline = pad + area;
  const heights = [0.45, 0.72, 1];

  heights.forEach((ratio, index) => {
    const height = Math.round(area * ratio);
    const left = pad + index * (barWidth + gap);
    const top = baseline - height;
    const color = index === 2 ? ACCENT : ACCENT_DIM;
    const radius = Math.max(1, Math.round(barWidth * 0.22));

    for (let y = top; y < baseline; y += 1) {
      for (let x = left; x < left + barWidth; x += 1) {
        // Round only the top corners: the bars sit on a common baseline.
        const dx = x < left + radius ? left + radius - x : x - (left + barWidth - radius - 1);
        const dy = top + radius - y;
        if (dy > 0 && dx > 0 && dx * dx + dy * dy > radius * radius) continue;
        put(x, y, color);
      }
    }
  });

  return pixels;
}

const out = join(process.cwd(), "public", "icons");
mkdirSync(out, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, inset: 0.2 },
  { file: "icon-512.png", size: 512, inset: 0.2 },
  { file: "icon-maskable-512.png", size: 512, inset: 0.29 },
  { file: "apple-touch-icon.png", size: 180, inset: 0.22 },
];

for (const target of targets) {
  const png = encodePng(target.size, draw(target.size, target.inset));
  writeFileSync(join(out, target.file), png);
  console.log(`${target.file} — ${png.length} bytes`);
}
