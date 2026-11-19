// Generates simple placeholder PWA icons (green tile with a cream leaf) as PNG files, with no image libraries.
// Replace public/icons/*.png with designed brand artwork before Play Store submission.
// Run: node scripts/make-pwa-icons.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const GREEN = [27, 107, 60, 255], CREAM = [251, 247, 238, 255], CLEAR = [0, 0, 0, 0];
// Leaf = intersection of two circles, rotated 45 degrees; `scale` keeps it inside the maskable safe zone.
function leaf(u, v, scale) {
  const cx = (u - 0.5) / scale, cy = (v - 0.5) / scale;
  const x = (cx + cy) / Math.SQRT2, y = (cy - cx) / Math.SQRT2;
  return (x - 0.18) ** 2 + y ** 2 < 0.3 ** 2 && (x + 0.18) ** 2 + y ** 2 < 0.3 ** 2;
}
const rounded = (u, v, r) => { const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0); return dx * dx + dy * dy <= r * r; };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
fs.mkdirSync(out, { recursive: true });
const any = (u, v) => (!rounded(u, v, 0.18) ? CLEAR : leaf(u, v, 1) ? CREAM : GREEN);
const maskable = (u, v) => (leaf(u, v, 0.72) ? CREAM : GREEN);
for (const [name, size, fn] of [["icon-192.png", 192, any], ["icon-512.png", 512, any], ["maskable-512.png", 512, maskable], ["apple-touch-icon.png", 180, maskable]]) {
  fs.writeFileSync(path.join(out, name), png(size, fn));
  console.log("wrote", name);
}
