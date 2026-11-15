#!/usr/bin/env node
/**
 * Deterministic zero-dependency PNG + multi-resolution Windows ICO icon generator
 * for the Remove.ac standalone Electron desktop application.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, "..");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - r;
}

function blendOver(dst, srcR, srcG, srcB, srcA) {
  const a = clamp01(srcA);
  if (a <= 0) return;
  const outA = a + dst.a * (1 - a);
  if (outA <= 0) return;
  dst.r = (srcR * a + dst.r * dst.a * (1 - a)) / outA;
  dst.g = (srcG * a + dst.g * dst.a * (1 - a)) / outA;
  dst.b = (srcB * a + dst.b * dst.a * (1 - a)) / outA;
  dst.a = outA;
}

/**
 * Renders the original remove.ac dual-frame cutout studio emblem at arbitrary square resolution:
 * - Rounded cobalt-to-royal-blue squircle base
 * - Subtle right-half transparency checkerboard field representing removed background
 * - Crisp offset white foreground card + clean cutout aperture ring
 */
function renderBrandIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = Math.max(0.9 / size, 0.0015);

  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const px = { r: 0, g: 0, b: 0, a: 0 };

      // 1. Outer rounded squircle
      const dOuter = sdRoundedBox(nx, ny, 0.5, 0.5, 0.44, 0.44, 0.21);
      const outerAlpha = 1 - smoothstep(-aa, aa, dOuter);

      if (outerAlpha > 0) {
        const gradT = clamp01(nx * 0.45 + ny * 0.65);
        const bgR = 11 + (8 - 11) * gradT;
        const bgG = 99 + (47 - 99) * gradT;
        const bgB = 206 + (118 - 206) * gradT;
        blendOver(px, bgR, bgG, bgB, outerAlpha);

        // 2. Right-side alpha checkerboard motif inside squircle
        if (nx > 0.48) {
          const cellSize = 0.085;
          const cxIdx = Math.floor(nx / cellSize);
          const cyIdx = Math.floor(ny / cellSize);
          const isLightCell = (cxIdx + cyIdx) % 2 === 0;
          const fadeIn = smoothstep(0.48, 0.54, nx);
          if (isLightCell) {
            blendOver(px, 255, 255, 255, 0.14 * fadeIn * outerAlpha);
          } else {
            blendOver(px, 4, 24, 62, 0.18 * fadeIn * outerAlpha);
          }
        }

        // 3. Back translucent layer frame (offset bottom-right)
        const dBackCard = sdRoundedBox(nx, ny, 0.555, 0.555, 0.215, 0.215, 0.075);
        const backCardAlpha = (1 - smoothstep(-aa, aa, dBackCard)) * outerAlpha;
        if (backCardAlpha > 0) {
          blendOver(px, 125, 194, 255, 0.34 * backCardAlpha);
        }

        // 4. Soft drop shadow beneath foreground cutout card
        const dShadow = sdRoundedBox(nx, ny, 0.455, 0.475, 0.23, 0.23, 0.082);
        const shadowAlpha = (1 - smoothstep(-0.02, 0.045, dShadow)) * outerAlpha;
        if (shadowAlpha > 0) {
          blendOver(px, 3, 18, 48, 0.32 * shadowAlpha);
        }

        // 5. Crisp white foreground cutout card (top-left)
        const dFrontCard = sdRoundedBox(nx, ny, 0.445, 0.445, 0.225, 0.225, 0.08);
        const frontCardAlpha = (1 - smoothstep(-aa, aa, dFrontCard)) * outerAlpha;
        if (frontCardAlpha > 0) {
          blendOver(px, 255, 255, 255, frontCardAlpha);

          // Inner cobalt cutout subject circle + diagonal split spark
          const distCircle = Math.hypot(nx - 0.445, ny - 0.445) - 0.108;
          const circleAlpha = (1 - smoothstep(-aa, aa, distCircle)) * frontCardAlpha;
          if (circleAlpha > 0) {
            const cR = nx > ny ? 15 : 11;
            const cG = nx > ny ? 118 : 99;
            const cB = nx > ny ? 236 : 206;
            blendOver(px, cR, cG, cB, circleAlpha);
          }
        }
      }

      const idx = (y * size + x) * 4;
      buf[idx] = Math.round(clamp01(px.r / 255) * 255);
      buf[idx + 1] = Math.round(clamp01(px.g / 255) * 255);
      buf[idx + 2] = Math.round(clamp01(px.b / 255) * 255);
      buf[idx + 3] = Math.round(clamp01(px.a) * 255);
    }
  }
  return encodeRgbaPng(size, size, buf);
}

function buildWindowsIco(sizes) {
  const pngBuffers = sizes.map((sz) => ({ size: sz, png: renderBrandIcon(sz) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(pngBuffers.length, 4);

  const dirEntries = Buffer.alloc(16 * pngBuffers.length);
  let dataOffset = 6 + dirEntries.length;

  pngBuffers.forEach(({ size, png }, i) => {
    const base = i * 16;
    dirEntries[base] = size >= 256 ? 0 : size;
    dirEntries[base + 1] = size >= 256 ? 0 : size;
    dirEntries[base + 2] = 0; // palette count
    dirEntries[base + 3] = 0; // reserved
    dirEntries.writeUInt16LE(1, base + 4); // color planes
    dirEntries.writeUInt16LE(32, base + 6); // bits per pixel
    dirEntries.writeUInt32LE(png.length, base + 8);
    dirEntries.writeUInt32LE(dataOffset, base + 12);
    dataOffset += png.length;
  });

  return Buffer.concat([header, dirEntries, ...pngBuffers.map((p) => p.png)]);
}

const buildDir = path.join(DESKTOP_ROOT, "build");
fs.mkdirSync(buildDir, { recursive: true });

const icon1024 = renderBrandIcon(1024);
const icon256 = renderBrandIcon(256);
const icoMulti = buildWindowsIco([16, 32, 48, 64, 128, 256]);

fs.writeFileSync(path.join(buildDir, "icon.png"), icon1024);
fs.writeFileSync(path.join(buildDir, "icon-256.png"), icon256);
fs.writeFileSync(path.join(buildDir, "icon.ico"), icoMulti);

console.log(
  `Generated desktop icons: icon.png (${icon1024.length} B), icon-256.png (${icon256.length} B), icon.ico (${icoMulti.length} B)`
);
