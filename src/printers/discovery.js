// Yerel ağı tarayıp yazıcı bulur: Anycubic LAN (:18910) ve Klipper/Moonraker (:7125, Mainsail arkasında :80)
// Not: Kobra 3'ün web sunucusu "bağlan-kapat" tarzı çıplak TCP taramasında kilitleniyor;
// bu yüzden her adres doğrudan HTTP isteğiyle yoklanıyor.
const os = require('os');
const anycubic = require('./anycubic');
const moonraker = require('./moonraker');

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
// VirtualBox, VMware, Hyper-V/WSL sanal ağ kartlarını atla
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d)/i;

function localNets() {
  const own = new Set(); const bases = new Set();
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vbox|vmware|hyper-v|vethernet|wsl|docker|utun|bridge/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivate(a.address) || VIRTUAL_MAC.test(a.mac || '')) continue;
      own.add(a.address);
      bases.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return { own, bases: [...bases] };
}

async function pool(items, n, fn, onDone) {
  const out = []; let i = 0; let done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); done++; if (onDone) onDone(done, items.length); }
  }));
  return out;
}

// "192.168.0.50" veya "192.168.0.50:7125" gibi elle girilen bir adresi tanı
async function probeHost(input) {
  const m = /^\s*(?:https?:\/\/)?([\w.-]+)(?::(\d+))?\/?\s*$/.exec(String(input || ''));
  if (!m) throw new Error('Geçersiz adres');
  const host = m[1]; const port = m[2] ? Number(m[2]) : null;
  if (!port || port === 18910) {
    const a = await anycubic.probe(host);
    if (a) return a;
  }
  for (const p of port ? [port] : [7125, 80, 7130]) {
    const r = await moonraker.probe(host, p);
    if (r) return r;
  }
  throw new Error(`${host} adresinde desteklenen bir yazıcı bulunamadı (Anycubic LAN modu ya da Klipper/Moonraker gerekiyor)`);
}

// Bütün /24 ağı yoklar. Bilerek yavaş (aynı anda 32 istek): hızlı taramada ARP yayın seli
// Kobra 3'ün Wi-Fi'sini bir süre tıkayabiliyor. Port 80 sadece elle eklemede denenir;
// Moonraker, Mainsail arkasında olsa bile 7125'i de dinler.
async function discover({ onProgress, known = [] } = {}) {
  const { own, bases } = localNets();
  const targets = [];
  // önce bilinen adresler (IP'si değişmemiş yazıcılar hemen bulunur)
  for (const ip of known) if (!own.has(ip)) targets.push({ ip, port: 18910 }, { ip, port: 7125 });
  for (const b of bases) for (let i = 1; i < 255; i++) {
    const ip = `${b}.${i}`;
    if (own.has(ip) || known.includes(ip)) continue;
    targets.push({ ip, port: 18910 }, { ip, port: 7125 });
  }
  let last = 0;
  const found = (await pool(targets, 32, (t) => (t.port === 18910 ? anycubic.probe(t.ip) : moonraker.probe(t.ip, t.port)), (d, n) => {
    const p = Math.floor((d / n) * 100);
    if (onProgress && p !== last) { last = p; onProgress(p / 100); }
  })).filter(Boolean);
  // aynı yazıcı hem 7125 hem 80'den görünürse tek kayıt bırak
  const seen = new Map();
  for (const f of found) {
    const key = f.uid || `${f.kind}:${f.host}`;
    if (!seen.has(key) || (seen.get(key).port === 80 && f.port === 7125)) seen.set(key, f);
  }
  return [...seen.values()];
}

module.exports = { discover, probeHost };
