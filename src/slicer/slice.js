// Orca komut satırıyla dilimleme, G-code istatistikleri ve küçük resim ekleme
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function runProcess(exe, args, { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '';
    const keep = (d) => { out += d.toString(); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); out += '\n[error] zaman aşımı'; }, timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n[error] ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Orca'nın hata satırlarını anlaşılır Türkçeye çevir
function explain(out, code) {
  const errs = out.split(/\r?\n/).filter((l) => /\[error\]/i.test(l)).map((l) => l.replace(/^.*\[error\]\s*/, '').replace(/^Slic3r::CLI::run \d+:\s*/, '').trim()).filter(Boolean);
  const msg = errs.filter((e) => !/found error, exit/i.test(e)).pop() || errs.pop() || '';
  if (/not compatible/i.test(msg)) return 'Seçilen kalite ya da filament profili bu makineyle uyumlu değil.';
  if (/print volume|fully inside|outside|out of the|exceed|beyond|partly inside/i.test(msg)) return 'Model tablaya sığmıyor ya da tabla sınırlarının dışında. Ölçeği küçültmeyi dene.';
  if (/empty|no object|nothing/i.test(msg)) return 'Dilimlenecek model bulunamadı.';
  if (/zaman aşımı/.test(msg)) return 'Dilimleme çok uzun sürdü ve durduruldu.';
  if (/not found|cannot open|failed to load|load.*fail/i.test(msg)) return `Model dosyası açılamadı${msg ? `: ${msg}` : ''}.`;
  return msg ? `Dilimleyici hatası: ${msg}` : `Dilimleyici beklenmedik şekilde kapandı (kod ${code}).`;
}

function parseDuration(s) {
  let sec = 0;
  for (const [, n, u] of String(s).matchAll(/(\d+)\s*([dhms])/g)) sec += Number(n) * { d: 86400, h: 3600, m: 60, s: 1 }[u];
  return sec || null;
}

function parseStats(text) {
  const tail = text.slice(-60000); const head = text.slice(0, 20000);
  const pick = (re, src) => { const m = re.exec(src); return m ? m[1] : null; };
  const time = pick(/; estimated printing time \(normal mode\) = (.+)/, tail) || pick(/; total estimated time: (.+)/, head);
  const grams = pick(/; total filament used \[g\] = ([\d.]+)/, tail) || pick(/; filament used \[g\] = ([\d.]+)/, tail);
  const mm = pick(/; filament used \[mm\] = ([\d.]+)/, tail);
  const layers = pick(/; total layer number: (\d+)/, head) || pick(/; total layers count = (\d+)/, tail);
  const height = pick(/; max_z_height: ([\d.]+)/, head);
  // Asıl baskı sıcaklıkları dosyanın sonundaki ayar bloğundan; ilk M104 çoğu zaman ön ısıtma (ör. 140°C) olur
  const bed = pick(/^M1[49]0 S([1-9]\d*)/m, text.slice(0, 300000));
  const nozzle = pick(/; nozzle_temperature = (\d+)/, tail) || pick(/^M10[49] S([1-9]\d*)/m, text.slice(0, 300000));
  return {
    seconds: time ? parseDuration(time) : null,
    grams: grams ? Number(grams) : null,
    meters: mm ? Number(mm) / 1000 : null,
    layers: layers ? Number(layers) : null,
    height: height ? Number(height) : null,
    bedTemp: bed ? Number(bed) : null,
    nozzleTemp: nozzle ? Number(nozzle) : null,
  };
}

// Küçük resim(leri) G-code başlığının hemen arkasına, Orca/Prusa biçiminde ekle
function injectThumbnails(text, thumbs) {
  if (!thumbs || !thumbs.length || /; thumbnail begin/.test(text.slice(0, 400000))) return text;
  let block = '\n; THUMBNAIL_BLOCK_START\n';
  for (const t of thumbs) {
    const b64 = String(t.png || '').replace(/^data:image\/png;base64,/, '');
    if (!b64) continue;
    block += `; thumbnail begin ${t.w}x${t.h} ${b64.length}\n`;
    for (let i = 0; i < b64.length; i += 78) block += `; ${b64.slice(i, i + 78)}\n`;
    block += '; thumbnail end\n';
  }
  block += '; THUMBNAIL_BLOCK_END\n';
  const marker = '; HEADER_BLOCK_END';
  const i = text.indexOf(marker);
  if (i < 0) return block + text;
  const j = text.indexOf('\n', i) + 1;
  return text.slice(0, j) + block + text.slice(j);
}

module.exports = { runProcess, explain, parseStats, injectThumbnails };
