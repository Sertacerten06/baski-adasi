// Önizleme için model okuyucular: STL (ikili/ASCII), OBJ ve 3MF -> düz üçgen listesi (Float32Array).
// Dilimlemeyi Orca yapar; burası yalnızca ekranda göstermek için.
const fs = require('fs');
const zlib = require('zlib');

const MAX_TRIS = 700000; // önizlemede bundan fazlası seyreltilir

function parseSTL(buf) {
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 === buf.length) {
      const step = Math.max(1, Math.ceil(n / MAX_TRIS));
      const out = new Float32Array(Math.ceil(n / step) * 9);
      let k = 0;
      for (let i = 0; i < n; i += step) {
        const o = 84 + i * 50 + 12;
        for (let j = 0; j < 9; j++) out[k++] = buf.readFloatLE(o + j * 4);
      }
      return out.subarray(0, k);
    }
  }
  const text = buf.toString('latin1');
  const nums = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  return new Float32Array(nums);
}

function parseOBJ(text) {
  const v = []; const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) { const p = line.trim().split(/\s+/); v.push([+p[1], +p[2], +p[3]]); }
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map((t) => { const i = parseInt(t, 10); return i < 0 ? v.length + i : i - 1; });
      for (let i = 1; i + 1 < idx.length; i++) for (const j of [idx[0], idx[i], idx[i + 1]]) { const p = v[j]; if (p) out.push(p[0], p[1], p[2]); }
    }
  }
  return new Float32Array(out);
}

// --- 3MF: zip içinde XML ---
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('3MF dosyası okunamadı (zip değil)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name.replace(/^\/+/, ''), { method, csize, local });
    p += 46 + nlen + elen + clen;
  }
  return (name) => {
    const e = files.get(String(name).replace(/^\/+/, ''));
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.csize);
    return (e.method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
  };
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseT = (s) => { const n = String(s || '').trim().split(/\s+/).map(Number); return n.length === 12 && n.every(Number.isFinite) ? n : IDENT; };
// 3MF dönüşümleri satır vektörü kuralında: p' = p * M  (M: 4x3)
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  a[9] * b[0] + a[10] * b[3] + a[11] * b[6] + b[9], a[9] * b[1] + a[10] * b[4] + a[11] * b[7] + b[10], a[9] * b[2] + a[10] * b[5] + a[11] * b[8] + b[11],
];
const ATTR_RE = new Map();
const attr = (tag, name) => {
  let re = ATTR_RE.get(name);
  if (!re) { re = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`); ATTR_RE.set(name, re); }
  const m = re.exec(tag);
  return m ? m[1] : null;
};

function parse3MF(buf) {
  const read = unzip(buf);
  const docs = new Map();
  const doc = (p) => {
    const key = String(p).replace(/^\/+/, '');
    if (!docs.has(key)) {
      const xml = read(key);
      const objects = new Map();
      if (xml) {
        const re = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
        let m;
        while ((m = re.exec(xml))) objects.set(attr(m[1], 'id'), m[2]);
      }
      docs.set(key, { xml, objects });
    }
    return docs.get(key);
  };
  const root = doc('3D/3dmodel.model');
  if (!root.xml) throw new Error('3MF içinde model bulunamadı');
  const out = [];
  let tris = 0;
  const emit = (docPath, id, T, depth) => {
    if (depth > 8 || tris > MAX_TRIS) return;
    const body = doc(docPath).objects.get(id);
    if (!body) return;
    const mesh = /<mesh\b[\s\S]*?<\/mesh>/.exec(body);
    if (mesh) {
      const verts = [];
      const vr = /<vertex\b([^>]*)\/?>/g; let v;
      while ((v = vr.exec(mesh[0]))) {
        const x = +attr(v[1], 'x'); const y = +attr(v[1], 'y'); const z = +attr(v[1], 'z');
        verts.push(x * T[0] + y * T[3] + z * T[6] + T[9], x * T[1] + y * T[4] + z * T[7] + T[10], x * T[2] + y * T[5] + z * T[8] + T[11]);
      }
      const tr = /<triangle\b([^>]*)\/?>/g; let t;
      while ((t = tr.exec(mesh[0])) && tris <= MAX_TRIS) {
        for (const k of ['v1', 'v2', 'v3']) { const i = +attr(t[1], k) * 3; out.push(verts[i], verts[i + 1], verts[i + 2]); }
        tris++;
      }
    }
    const cr = /<component\b([^>]*)\/?>/g; let c;
    while ((c = cr.exec(body))) {
      const ref = attr(c[1], 'path') || docPath;
      emit(ref, attr(c[1], 'objectid'), mul(parseT(attr(c[1], 'transform')), T), depth + 1);
    }
  };
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(root.xml);
  const items = build ? [...build[1].matchAll(/<item\b([^>]*)\/?>/g)] : [];
  for (const it of items) emit('3D/3dmodel.model', attr(it[1], 'objectid'), parseT(attr(it[1], 'transform')), 0);
  const plates = (read('Metadata/model_settings.config') || '').match(/<plate>/g);
  return { positions: new Float32Array(out), plates: plates ? plates.length : 1 };
}

// Dosyayı oku ve önizleme verisini çıkar
function loadPreview(filePath) {
  const lower = filePath.toLowerCase();
  const buf = fs.readFileSync(filePath);
  let positions = null; let plates = 1;
  if (lower.endsWith('.stl')) positions = parseSTL(buf);
  else if (lower.endsWith('.obj')) positions = parseOBJ(buf.toString('utf8'));
  else if (lower.endsWith('.3mf')) ({ positions, plates } = parse3MF(buf));
  if (!positions || !positions.length) return { positions: null, plates };
  let x0 = Infinity; let y0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]; const y = positions[i + 1]; const z = positions[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { positions, plates, size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 }, tris: positions.length / 9 };
}

module.exports = { loadPreview, parseSTL, parseOBJ, parse3MF };
