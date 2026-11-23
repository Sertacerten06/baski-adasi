// Bağımlılıksız PNG simge üretici: uygulama simgesi, Windows tepsi simgesi, macOS menü çubuğu şablonu.
// Çalıştır: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// SDF yardımcıları (koordinatlar 0..1)
const sdRoundRect = (x, y, cx, cy, w, h, r) => {
  const qx = Math.abs(x - cx) - w / 2 + r; const qy = Math.abs(y - cy) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function render(size, shapes) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 3; // süper örnekleme
  for (let py = 0; py < size; py++) for (let pxi = 0; pxi < size; pxi++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (pxi + (sx + 0.5) / SS) / size; const y = (py + (sy + 0.5) / SS) / size;
      let c = [0, 0, 0, 0]; // premultiplied
      for (const s of shapes) {
        if (s.sd(x, y) > 0) continue;
        const col = typeof s.color === 'function' ? s.color(x, y) : s.color;
        const a = (s.alpha ?? 1);
        c = [col[0] * a + c[0] * (1 - a), col[1] * a + c[1] * (1 - a), col[2] * a + c[2] * (1 - a), a + c[3] * (1 - a)];
      }
      acc = acc.map((v, i) => v + c[i]);
    }
    const n = SS * SS; const a = acc[3] / n;
    const o = (py * size + pxi) * 4;
    px[o] = a ? Math.round(acc[0] / n / a) : 0; px[o + 1] = a ? Math.round(acc[1] / n / a) : 0; px[o + 2] = a ? Math.round(acc[2] / n / a) : 0; px[o + 3] = Math.round(a * 255);
  }
  return png(size, size, px);
}

const top = hex('#1d2433'); const bottom = hex('#0a0c11');
const appShapes = [
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.88, 0.88, 0.2), color: (x, y) => mix(top, bottom, y) },
  // ada kapsülü
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.3, 0.6, 0.16, 0.08), color: hex('#000000') },
  { sd: (x, y) => sdCircle(x, y, 0.29, 0.3, 0.035), color: hex('#30d158') },
  { sd: (x, y) => sdRoundRect(x, y, 0.55, 0.3, 0.32, 0.04, 0.02), color: hex('#3a3a3c') },
  { sd: (x, y) => sdRoundRect(x, y, 0.49, 0.3, 0.2, 0.04, 0.02), color: hex('#0a84ff') },
  // basılan katmanlar
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.56, 0.38, 0.075, 0.035), color: hex('#ffb340') },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.655, 0.48, 0.075, 0.035), color: hex('#ff8a1f') },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.75, 0.58, 0.075, 0.035), color: hex('#ff5f2e') },
];

// tepsi: sade, küçük boyutta okunur
const trayShapes = [
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.96, 0.96, 0.24), color: hex('#111318') },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.33, 0.72, 0.22, 0.11), color: hex('#000000') },
  { sd: (x, y) => sdCircle(x, y, 0.27, 0.33, 0.06), color: hex('#30d158') },
  { sd: (x, y) => sdRoundRect(x, y, 0.56, 0.33, 0.34, 0.07, 0.035), color: hex('#0a84ff') },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.62, 0.5, 0.12, 0.06), color: hex('#ff9f0a') },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.79, 0.7, 0.12, 0.06), color: hex('#ff6a2e') },
];
// macOS şablonu: yalnızca siyah + saydamlık
const tmplShapes = [
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.3, 0.84, 0.26, 0.13), color: [0, 0, 0] },
  { sd: (x, y) => sdCircle(x, y, 0.24, 0.3, 0.07), color: [0, 0, 0], alpha: 0 },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.62, 0.56, 0.13, 0.065), color: [0, 0, 0] },
  { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.82, 0.8, 0.13, 0.065), color: [0, 0, 0] },
];
// şablondaki "delik": alpha 0 katmanı üstündekini siler
function renderTemplate(size) {
  const shapes = tmplShapes.map((s) => (s.alpha === 0 ? { ...s, color: [0, 0, 0], alpha: 1, hole: true } : s));
  const px = Buffer.alloc(size * size * 4); const SS = 4;
  for (let py = 0; py < size; py++) for (let pxi = 0; pxi < size; pxi++) {
    let a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (pxi + (sx + 0.5) / SS) / size; const y = (py + (sy + 0.5) / SS) / size;
      let on = 0;
      for (const s of shapes) if (s.sd(x, y) <= 0) on = s.hole ? 0 : 1;
      a += on;
    }
    px[(py * size + pxi) * 4 + 3] = Math.round((a / (SS * SS)) * 255);
  }
  return png(size, size, px);
}

const root = path.join(__dirname, '..');
const out = (rel, buf) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); console.log('yazıldı', rel, buf.length, 'bayt'); };
out('build/icon.png', render(1024, appShapes));
out('src/assets/icon.png', render(256, appShapes));
out('src/assets/tray.png', render(32, trayShapes));
out('src/assets/trayTemplate.png', renderTemplate(16));
out('src/assets/trayTemplate@2x.png', renderTemplate(32));
