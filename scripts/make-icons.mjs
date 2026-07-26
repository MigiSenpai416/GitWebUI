// Draws the Windows application icon from the brand mark in web/src/brand.ts.
//
// The mark is the app's own commit-graph column, and it is already defined once
// as geometry so the React icon, the auth screen and the favicon can't drift
// apart. The desktop icon is the fourth drawing of it, so it comes from the same
// numbers rather than a hand-exported image that would go stale the first time
// the mark changed.
//
// The rasteriser, the PNG writer and the ICO container are all written by hand,
// because the alternative is a native image toolchain for three shapes.

import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "desktop", "build");

// ---------------------------------------------------------------------------
// The mark (mirrors web/src/brand.ts — see markSvg for the heavier weights,
// which are tuned for small renderings and so suit a taskbar icon too)
// ---------------------------------------------------------------------------

const VIEW = 24;
const TILE = "#0e151d";
const INK = "#22b2a6";
const TILE_RADIUS = 5;
const NODE_R = 2.6;
const STROKE = 2.3;
const NODES = [
  { cx: 8, cy: 4.5 },
  { cx: 8, cy: 19.5 },
  { cx: 16.5, cy: 12 },
];
// The lane and the branch leaving it, as segments (the SVG paths are straight).
const LANES = [
  { x1: 8, y1: 6.7, x2: 8, y2: 17.3 },
  { x1: 8, y1: 12, x2: 13.8, y2: 12 },
];

// ---------------------------------------------------------------------------
// Signed distance fields, in viewBox units
// ---------------------------------------------------------------------------

function sdRoundedRect(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function sdSegment(px, py, seg) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2));
  return Math.hypot(px - (seg.x1 + t * dx), py - (seg.y1 + t * dy));
}

/** Distance to the nearest bit of ink: the lanes (as capsules) and the nodes. */
function sdMark(px, py) {
  let d = Infinity;
  for (const seg of LANES) d = Math.min(d, sdSegment(px, py, seg) - STROKE / 2);
  for (const n of NODES) d = Math.min(d, Math.hypot(px - n.cx, py - n.cy) - NODE_R);
  return d;
}

const hex = (c) => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];

/**
 * Coverage of a shape at a pixel, antialiased over one pixel's width. A signed
 * distance makes this exact for the straight and circular edges here, and far
 * cheaper than supersampling at 1024².
 */
function coverage(distance, pixel) {
  return Math.max(0, Math.min(1, 0.5 - distance / pixel));
}

/** RGBA pixels for the mark at `size`×`size`. */
function render(size) {
  const scale = size / VIEW;
  const pixel = 1 / scale; // one output pixel, in viewBox units
  const [tr, tg, tb] = hex(TILE);
  const [ir, ig, ib] = hex(INK);
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample at pixel centres.
      const px = (x + 0.5) * pixel;
      const py = (y + 0.5) * pixel;

      const tile = coverage(sdRoundedRect(px - VIEW / 2, py - VIEW / 2, VIEW / 2, TILE_RADIUS), pixel);
      const ink = coverage(sdMark(px, py), pixel);

      // Ink over tile, the whole thing masked by the tile so the mark can't
      // spill past the rounded corners.
      const inkAlpha = ink * tile;
      const alpha = tile;
      let r = tr;
      let g = tg;
      let b = tb;
      if (inkAlpha > 0) {
        // Composited against the tile, then stored straight (not premultiplied).
        r = Math.round(tr + (ir - tr) * (inkAlpha / Math.max(alpha, 1e-6)));
        g = Math.round(tg + (ig - tg) * (inkAlpha / Math.max(alpha, 1e-6)));
        b = Math.round(tb + (ib - tb) * (inkAlpha / Math.max(alpha, 1e-6)));
      }

      const i = (y * size + x) * 4;
      out[i] = Math.max(0, Math.min(255, r));
      out[i + 1] = Math.max(0, Math.min(255, g));
      out[i + 2] = Math.max(0, Math.min(255, b));
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlacing

  // One filter byte per scanline; filter 0 (None) keeps this simple and the
  // images are tiny either way.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO — a directory of PNGs. 256 is encoded as 0 in the size bytes.
// ---------------------------------------------------------------------------

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const at = i * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

// ---------------------------------------------------------------------------

// 16 for the taskbar and title bar, 256 for the large icon in Explorer, and the
// steps in between so Windows never has to scale one of them itself.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const images = ICO_SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
  await fs.writeFile(path.join(outDir, "icon.ico"), encodeIco(images));

  console.log(
    `[make-icons] wrote icon.ico (${ICO_SIZES.join(", ")}px) to ` +
      `${path.relative(root, path.join(outDir, "icon.ico"))}`,
  );
}

main().catch((e) => {
  console.error("[make-icons]", e);
  process.exit(1);
});
