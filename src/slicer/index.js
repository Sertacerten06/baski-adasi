// Dilimleme servisi: dilimleyicileri bulur, profilleri sunar, modeli okur, dilimler ve işleri tutar.
// İki motor desteklenir: OrcaSlicer (her marka) ve Anycubic Slicer Next (Orca türevi, Anycubic profilleri).
// Anycubic yazıcılarda Anycubic Slicer Next tercih edilir: çıktısı Kobra yazılımının beklediği
// paint_info / ilk katman sınırları / EXCLUDE_OBJECT gibi satırları taşır.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { locateAll } = require('./locate');
const { Profiles, first } = require('./profiles');
const { loadPreview } = require('./mesh');
const { runProcess, explain, parseStats, injectThumbnails } = require('./slice');
const { asciiName } = require('../printers/net');

const MODEL_EXT = /\.(stl|obj|3mf|step|stp|amf)$/i;
const isModel = (p) => MODEL_EXT.test(p) && !/\.gcode\.3mf$/i.test(p);

// Klipper yazıcılarda model bilgisi yok: adından/hostname'inden tahmin et
function guessKlipper(profiles, text) {
  const t = String(text || '').toLowerCase().replace(/[-_]+/g, ' ');
  const rules = [
    [/x4\s*plus/, 'Artillery Sidewinder X4 Plus 0.4 nozzle'],
    [/x4\s*pro/, 'Artillery Sidewinder X4 Pro 0.4 nozzle'],
    [/x3\s*plus/, 'Artillery Sidewinder X3 Plus 0.4 nozzle'],
    [/x3\s*pro/, 'Artillery Sidewinder X3 Pro 0.4 nozzle'],
    [/genius\s*pro/, 'Artillery Genius Pro 0.4 nozzle'],
    [/hornet/, 'Artillery Hornet 0.4 nozzle'],
  ];
  for (const [re, name] of rules) if (re.test(t) && profiles.has('machine', name)) return name;
  return null;
}

class SlicerService {
  constructor({ workRoot, getCustomExe }) {
    this.workRoot = workRoot;
    this.getCustomExe = getCustomExe;
    this.engines = undefined;   // { orca: { slicer, profiles }, anycubic: { slicer, profiles } }
    this.jobs = new Map();
    this._cleanup();
  }

  // iki günden eski geçici dilimleme klasörlerini temizle (yalnızca uygulamanın kendi dosyaları)
  _cleanup() {
    try {
      for (const d of fs.readdirSync(this.workRoot)) {
        const p = path.join(this.workRoot, d);
        if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86400000) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* klasör yok */ }
  }

  _ensure() {
    const stale = this.engines && Object.values(this.engines).some((e) => !fs.existsSync(e.slicer.exe));
    if (this.engines === undefined || stale) {
      this.engines = {};
      for (const [kind, s] of Object.entries(locateAll(this.getCustomExe && this.getCustomExe()))) {
        this.engines[kind] = { slicer: s, profiles: new Profiles(s.resources) };
      }
    }
    return this.engines;
  }

  _require() {
    if (!Object.keys(this._ensure()).length) throw new Error('Dilimleyici bulunamadı. Bilgisayarına OrcaSlicer ya da Anycubic Slicer Next kur, sonra tekrar dene.');
  }

  info() {
    const list = Object.values(this._ensure()).map((e) => ({ name: e.slicer.name, kind: e.slicer.kind, exe: e.slicer.exe }));
    return list.length ? { available: true, name: list.map((l) => l.name).join(' + '), engines: list } : { available: false };
  }

  refresh() { this.engines = undefined; return this.info(); }

  // Makine için motor: Anycubic makinelerinde Anycubic Slicer Next, yoksa/diğerlerinde OrcaSlicer
  _engineFor(machine) {
    const e = this._ensure();
    const asn = e.anycubic && e.anycubic.profiles.has('machine', machine) && e.anycubic.profiles.vendorOf('machine', machine) === 'Anycubic';
    if (asn) return e.anycubic;
    if (e.orca && e.orca.profiles.has('machine', machine)) return e.orca;
    if (e.anycubic && e.anycubic.profiles.has('machine', machine)) return e.anycubic;
    throw new Error(`Makine profili bulunamadı: ${machine}`);
  }

  catalog() {
    this._require();
    const e = this._ensure();
    return (e.orca || e.anycubic).profiles.catalog();
  }

  machineFor(printer, cfg) {
    this._require();
    const e = this._ensure();
    const all = [e.anycubic, e.orca].filter(Boolean);
    if (cfg && cfg.slicerMachine && all.some((x) => x.profiles.has('machine', cfg.slicerMachine))) return cfg.slicerMachine;
    if (printer.kind === 'anycubic' && printer.modelFull) {
      for (const x of all) { const m = x.profiles.machineForModel(printer.modelFull); if (m) return m; }
      return null;
    }
    if (printer.kind === 'moonraker') {
      for (const x of [e.orca, e.anycubic].filter(Boolean)) { const m = guessKlipper(x.profiles, `${printer.name} ${printer.uid || ''}`); if (m) return m; }
    }
    return null;
  }

  options(machine) {
    this._require();
    const eng = this._engineFor(machine);
    return { ...eng.profiles.compatible(machine), engine: eng.slicer.name, engineKind: eng.slicer.kind };
  }

  loadModel(filePath) {
    if (!isModel(filePath)) throw new Error('Desteklenen model dosyaları: STL, 3MF, OBJ, STEP');
    const st = fs.statSync(filePath);
    if (st.size > 300 * 1024 * 1024) throw new Error('Model dosyası çok büyük (300 MB üstü)');
    let preview;
    try { preview = loadPreview(filePath); } catch (e) { preview = { positions: null, plates: 1, previewError: e.message }; }
    return { path: filePath, name: path.basename(filePath), bytes: st.size, ...preview };
  }

  async slice(req) {
    this._require();
    const { modelPath, machine, process: proc, filament, overrides = {}, scale = 1, orient = false, thumbnails = [] } = req;
    if (!modelPath || !fs.existsSync(modelPath)) throw new Error('Model dosyası bulunamadı');
    const eng = this._engineFor(machine);
    const profiles = eng.profiles;
    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(this.workRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const vendor = profiles.vendorOf('machine', machine);
    let machineFile = profiles.locateFile('machine', machine, vendor).file;
    // Bazı üretici dosyalarında "type" alanı yok (ebeveynden gelir); komut satırı onu dosyada istiyor.
    // Kopyada adı/mirası aynı bırakılır ki dilimleyici onu hâlâ sistem profili olarak tanısın.
    const mraw = profiles._read(machineFile);
    if (mraw.type !== 'machine') {
      machineFile = path.join(dir, 'machine.json');
      fs.writeFileSync(machineFile, JSON.stringify({ ...mraw, type: 'machine' }));
    }

    // Kalite profili: zinciri birleştir, kullanıcı ayarlarını uygula. Dilimleyici, uyumluluk
    // listesinde makinenin adını görmezse "process not compatible" diyerek reddediyor.
    const p = profiles.resolve('process', proc, vendor);
    Object.assign(p, overrides, { name: 'Baski Adasi', from: 'User', inherits: '', compatible_printers: [machine], compatible_printers_condition: '' });
    const processFile = path.join(dir, 'process.json');
    fs.writeFileSync(processFile, JSON.stringify(p));

    // Filament: her zaman düzleştirilmiş kopya (bazı dosyalarda "type" eksik), makineyle uyumlu
    // işaretli. Renk verildiyse (ör. ACE yuvası) yazılır; Anycubic çıktısında paint_info'ya geçer.
    if (!profiles.locateFile('filament', filament, vendor)) throw new Error(`Filament profili bulunamadı: ${filament}`);
    const f = profiles.resolve('filament', filament, vendor);
    Object.assign(f, { type: 'filament', name: f.name || filament, from: 'User', inherits: '', compatible_printers: [machine], compatible_printers_condition: '' });
    if (/^#[0-9a-f]{6}$/i.test(req.filamentColor || '')) f.filament_colour = [req.filamentColor.toUpperCase()];
    const filamentFile = path.join(dir, 'filament.json');
    fs.writeFileSync(filamentFile, JSON.stringify(f));

    const args = ['--slice', '0', '--arrange', '1', '--ensure-on-bed', '--debug', '1',
      '--load-settings', `${machineFile};${processFile}`, '--load-filaments', filamentFile, '--outputdir', dir];
    if (/\.3mf$/i.test(modelPath)) args.push('--allow-newer-file', '1');
    if (scale && Math.abs(scale - 1) > 0.001) args.push('--scale', String(scale));
    if (orient) args.push('--orient', '1');
    args.push(modelPath);

    const t0 = Date.now();
    const r = await runProcess(eng.slicer.exe, args);
    const produced = fs.readdirSync(dir).filter((n) => n.endsWith('.gcode')).sort();
    const gname = produced.includes('plate_1.gcode') ? 'plate_1.gcode' : produced[0];
    if (r.code !== 0 || !gname) throw new Error(explain(r.out, r.code));
    const gfile = path.join(dir, gname);
    let text = fs.readFileSync(gfile, 'utf8');
    const stats = parseStats(text);
    text = injectThumbnails(text, thumbnails);

    const base = asciiName(path.basename(modelPath).replace(MODEL_EXT, '')).replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'model';
    const fil = String(first(f.filament_type) || '').replace(/[^A-Za-z0-9+]/g, '');
    const layer = first(p.layer_height);
    const name = `${base}${fil ? `_${fil}` : ''}${layer ? `_${layer}mm` : ''}.gcode`;
    const out = path.join(dir, name);
    fs.writeFileSync(out, text);
    if (out !== gfile) fs.rmSync(gfile, { force: true });

    const job = { id, path: out, name, bytes: Buffer.byteLength(text), stats, plates: produced.length, machine, process: proc, filament, engine: eng.slicer.name, ms: Date.now() - t0 };
    this.jobs.set(id, job);
    return job;
  }

  job(id) {
    const j = this.jobs.get(id);
    if (!j || !fs.existsSync(j.path)) throw new Error('Dilimlenmiş dosya bulunamadı, tekrar dilimle');
    return j;
  }
}

module.exports = { SlicerService, isModel };
