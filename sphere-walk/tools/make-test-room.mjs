// Saves the synthetic test room as files the depth tool can read:
//   test-room.png             the 360° picture
//   test-room.true-depth.png  its exact depth (millimeters: red × 256 + green, as in js/depth-file.js)
//
// Run from the photo-sphere-app folder:  node sphere-walk/tools/make-test-room.mjs [output folder] [width]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { renderRoom } from "../js/room.js";

const outDir = process.argv[2] ?? "sphere-walk/tools/output";
const width = Number(process.argv[3] ?? 2048);
mkdirSync(outDir, { recursive: true });

const room = renderRoom({ width, samples: 2 });
const depthPixels = new Uint8ClampedArray(room.width * room.height * 4);
for (let i = 0; i < room.depth.length; i++) {
  const mm = Math.max(0, Math.min(65535, Math.round(room.depth[i] * 1000)));
  depthPixels[i * 4] = mm >> 8;
  depthPixels[i * 4 + 1] = mm & 255;
  depthPixels[i * 4 + 3] = 255;
}
writeFileSync(join(outDir, "test-room.png"), png(room.color, room.width, room.height));
writeFileSync(join(outDir, "test-room.true-depth.png"), png(depthPixels, room.width, room.height));
console.log(`Saved test-room.png and test-room.true-depth.png (${room.width} × ${room.height}) in ${outDir}`);

// Minimal PNG writer: 8-bit RGB, no filtering.
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      raw[row + 1 + x * 3] = rgba[s];
      raw[row + 2 + x * 3] = rgba[s + 1];
      raw[row + 3 + x * 3] = rgba[s + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
