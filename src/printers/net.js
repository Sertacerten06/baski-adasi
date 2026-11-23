// Yazıcılarla HTTP konuşmak için küçük yardımcılar.
// Electron ana sürecinde global fetch (undici) ilk isteklerde saniyelerce gecikebiliyor;
// Node'un http modülü hem hızlı hem öngörülebilir. Bağlantı yeniden kullanılmaz (agent: false):
// Wi-Fi'si kopup gelen yazıcılarda bayat soket kalmasın.
const http = require('http');
const crypto = require('crypto');

function request(url, { method = 'GET', headers = {}, body = null, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (body) h['Content-Length'] = body.length;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: h, agent: false }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('Yanıt çok büyük')); return; }
        chunks.push(c);
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => {
      const e = new Error('Zaman aşımı'); e.code = 'zaman aşımı'; e.network = true;
      req.destroy(e);
    }, timeout);
    req.on('error', (e) => {
      clearTimeout(timer);
      if (e.network === undefined) e.network = /^(E[A-Z]+|zaman aşımı)$/.test(e.code || '');
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(url, timeout = 10000) {
  const r = await request(url, { timeout });
  return JSON.parse(r.text);
}

// multipart/form-data gövdesi: [{ name, value }] ya da [{ name, filename, data: Buffer }]
function multipart(parts) {
  const boundary = `----BaskiAdasi${crypto.randomBytes(12).toString('hex')}`;
  const bufs = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${String(p.filename).replace(/["\r\n]/g, '_')}"\r\nContent-Type: ${p.contentType || 'application/octet-stream'}`;
    bufs.push(Buffer.from(`${head}\r\n\r\n`, 'utf8'));
    bufs.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.value ?? ''), 'utf8'));
    bufs.push(Buffer.from('\r\n'));
  }
  bufs.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(bufs), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Ağ hatasını kullanıcıya gösterilecek kısa metne çevir
function netError(e) {
  if (!e || !e.network) return null;
  return `Yazıcıya ulaşılamıyor (${e.code || 'ağ hatası'})`;
}

// Bazı yazıcı yazılımları dosya adında yalnızca düz ASCII kabul ediyor
function asciiName(name) {
  const map = { ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' };
  return String(name).replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => map[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._()+-]/g, '_');
}

module.exports = { request, getJson, multipart, netError, asciiName };
