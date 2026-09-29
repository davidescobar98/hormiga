// Generates resources/icon.png (512×512): rounded teal square with a white "H" (Hormiga). No dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const S = 512;
const px = Buffer.alloc(S * S * 4);
const teal = [15, 107, 92];
const inside = (x, y) => {
  const r = 110; // corner radius
  const cx = Math.min(Math.max(x, r), S - r);
  const cy = Math.min(Math.max(y, r), S - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // 4× supersampling for smooth edges
    let bg = 0;
    let ring = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const fx = x + (sx + 0.5) / 4;
        const fy = y + (sy + 0.5) / 4;
        if (!inside(fx, fy)) continue;
        bg++;
        const leftBar = fx > 150 && fx < 212 && fy > 120 && fy < 392;
        const rightBar = fx > 300 && fx < 362 && fy > 120 && fy < 392;
        const middle = fx > 150 && fx < 362 && fy > 228 && fy < 284;
        if (leftBar || rightBar || middle) ring++;
      }
    }
    const i = (y * S + x) * 4;
    const a = bg / 16;
    const w = ring / 16;
    px[i] = Math.round(teal[0] * (1 - w) + 255 * w);
    px[i + 1] = Math.round(teal[1] * (1 - w) + 255 * w);
    px[i + 2] = Math.round(teal[2] * (1 - w) + 255 * w);
    px[i + 3] = Math.round(255 * a);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = fileURLToPath(new URL('../resources/icon.png', import.meta.url));
mkdirSync(fileURLToPath(new URL('../resources/', import.meta.url)), { recursive: true });
writeFileSync(out, png);
console.log(`icon written: ${out} (${png.length} bytes)`);
