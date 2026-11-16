#!/usr/bin/env node
'use strict';
// Genererer Control Tower-ikoner (.ico til Windows og .png-sæt til macOS) uden eksterne afhængigheder.
// Grafikken matcher public/favicon.svg (#14181b baggrund, #E32D22 rød bjælke, #6EC943 grøn bjælke).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0x14, 0x18, 0x1b];
const RED = [0xe3, 0x2d, 0x22];
const GREEN = [0x6e, 0xc9, 0x43];

// Afstandsfunktion til et afrundet rektangel i 32x32-koordinatsystem.
function roundedRectDist(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const dx = Math.max(Math.abs(px - cx) - hw, 0);
  const dy = Math.max(Math.abs(py - cy) - hh, 0);
  return Math.hypot(dx, dy) - r;
}

function renderRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const sub = 4;
  const inv = 1 / (sub * sub);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < sub; sy++) {
        const y = ((py + (sy + 0.5) / sub) / size) * 32;
        for (let sx = 0; sx < sub; sx++) {
          const x = ((px + (sx + 0.5) / sub) / size) * 32;
          if (roundedRectDist(x, y, 0.5, 0.5, 31, 31, 7) <= 0) {
            let c = BG;
            if (roundedRectDist(x, y, 7, 8, 18, 6, 2) <= 0) c = RED;
            else if (roundedRectDist(x, y, 7, 18, 18, 6, 2) <= 0) c = GREEN;
            sr += c[0];
            sg += c[1];
            sb += c[2];
            sa += 255;
          }
        }
      }
      const idx = (py * size + px) * 4;
      const alpha = Math.round(sa * inv);
      if (alpha > 0) {
        // Premultiplieret sum divideret med dækket areal bevarer rene farver i halvgennemsigtige kanter.
        const cov = sa || 1;
        buf[idx] = Math.round((sr * 255) / cov);
        buf[idx + 1] = Math.round((sg * 255) / cov);
        buf[idx + 2] = Math.round((sb * 255) / cov);
      }
      buf[idx + 3] = alpha;
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeDibEntry(size, rgba) {
  const xorBytes = size * size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andBytes = andRowBytes * size;
  const buf = Buffer.alloc(40 + xorBytes + andBytes);

  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);

  let pos = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      buf[pos++] = rgba[s + 2]; // B
      buf[pos++] = rgba[s + 1]; // G
      buf[pos++] = rgba[s];     // R
      buf[pos++] = rgba[s + 3]; // A
    }
  }

  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const alpha = rgba[(y * size + x) * 4 + 3];
      if (alpha < 128) {
        const byteIdx = pos + Math.floor(x / 8);
        buf[byteIdx] |= 1 << (7 - (x % 8));
      }
    }
    pos += andRowBytes;
  }
  return buf;
}

function encodeIco(sizes = [16, 32, 48, 64]) {
  const entries = sizes.map((size) => {
    const rgba = renderRgba(size);
    return { size, data: encodeDibEntry(size, rgba) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirs = entries.map((e) => {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    return d;
  });
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);
}

function writeIco(outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, encodeIco());
}

function writeIconset(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const specs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];
  const cache = new Map();
  for (const [name, size] of specs) {
    if (!cache.has(size)) cache.set(size, encodePng(size, renderRgba(size)));
    fs.writeFileSync(path.join(dir, name), cache.get(size));
  }
}

function encodeIcns() {
  const specs = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];
  const cache = new Map();
  const chunks = [];
  for (const [type, size] of specs) {
    if (!cache.has(size)) cache.set(size, encodePng(size, renderRgba(size)));
    const png = cache.get(size);
    const entry = Buffer.alloc(8 + png.length);
    entry.write(type, 0, 4, 'ascii');
    entry.writeUInt32BE(entry.length, 4);
    png.copy(entry, 8);
    chunks.push(entry);
  }
  const total = 8 + chunks.reduce((sum, c) => sum + c.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

function writeIcns(outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, encodeIcns());
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const idxSet = args.indexOf('--iconset');
  const idxIcns = args.indexOf('--icns');
  if (idxSet !== -1 && args[idxSet + 1]) {
    writeIconset(args[idxSet + 1]);
  } else if (idxIcns !== -1 && args[idxIcns + 1]) {
    writeIcns(args[idxIcns + 1]);
  } else {
    const outFile = args[0] || path.join(__dirname, '..', 'assets', 'control-tower.ico');
    writeIco(outFile);
    console.log(`Oprettede ikon: ${outFile}`);
  }
}

module.exports = { renderRgba, encodePng, encodeIco, encodeIcns, writeIco, writeIcns, writeIconset };
