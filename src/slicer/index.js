// Dilimleme servisi: dilimleyiciyi bulur, profilleri sunar, modeli okur, dilimler ve işleri tutar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { locate } = require('./locate');
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
    this.slicer = undefined;
    this.profiles = null;
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
    if (this.slicer === undefined || (this.slicer && !fs.existsSync(this.slicer.exe))) {
      this.slicer = locate(this.getCustomExe && this.getCustomExe());
      this.profiles = this.slicer ? new Profiles(this.slicer.resources) : null;
    }
    return this.slicer;
  }

  _require() {
    if (!this._ensure()) throw new Error('Dilimleyici bulunamadı. Bilgisayarına OrcaSlicer kur, sonra tekrar dene.');
  }

  info() {
    const s = this._ensure();
    return s ? { available: true, name: s.name, kind: s.kind, exe: s.exe } : { available: false };
  }

  refresh() { this.slicer = undefined; return this.info(); }

  catalog() { this._require(); return this.profiles.catalog(); }

  machineFor(printer, cfg) {
    this._require();
    if (cfg && cfg.slicerMachine && this.profiles.has('machine', cfg.slicerMachine)) return cfg.slicerMachine;
    if (printer.kind === 'anycubic' && printer.modelFull) return this.profiles.machineForModel(printer.modelFull);
    if (printer.kind === 'moonraker') return guessKlipper(this.profiles, `${printer.name} ${printer.uid || ''}`);
    return null;
  }

  options(machine) { this._require(); return this.profiles.compatible(machine); }

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
    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(this.workRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const vendor = this.profiles.vendorOf('machine', machine);
    if (!vendor) throw new Error(`Makine profili bulunamadı: ${machine}`);
    const machineFile = this.profiles.locateFile('machine', machine, vendor).file;

    // Kalite profili: zinciri birleştir, kullanıcı ayarlarını uygula. Orca, uyumluluk
    // listesinde makinenin adını görmezse "process not compatible" diyerek reddediyor.
    const p = this.profiles.resolve('process', proc, vendor);
    Object.assign(p, overrides, { name: 'Baski Adasi', from: 'User', inherits: '', compatible_printers: [machine], compatible_printers_condition: '' });
    const processFile = path.join(dir, 'process.json');
    fs.writeFileSync(processFile, JSON.stringify(p));

    // Filament: makineyle uyumluysa sistem dosyası, değilse düzleştirilip uyumlu işaretlenir
    const floc = this.profiles.locateFile('filament', filament, vendor);
    if (!floc) throw new Error(`Filament profili bulunamadı: ${filament}`);
    let filamentFile = floc.file;
    const f = this.profiles.resolve('filament', filament, vendor);
    if (!(Array.isArray(f.compatible_printers) && f.compatible_printers.includes(machine))) {
      Object.assign(f, { from: 'User', inherits: '', compatible_printers: [machine], compatible_printers_condition: '' });
      filamentFile = path.join(dir, 'filament.json');
      fs.writeFileSync(filamentFile, JSON.stringify(f));
    }

    const args = ['--slice', '0', '--arrange', '1', '--ensure-on-bed', '--debug', '1',
      '--load-settings', `${machineFile};${processFile}`, '--load-filaments', filamentFile, '--outputdir', dir];
    if (/\.3mf$/i.test(modelPath)) args.push('--allow-newer-file', '1');
    if (scale && Math.abs(scale - 1) > 0.001) args.push('--scale', String(scale));
    if (orient) args.push('--orient', '1');
    args.push(modelPath);

    const t0 = Date.now();
    const r = await runProcess(this.slicer.exe, args);
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

    const job = { id, path: out, name, bytes: Buffer.byteLength(text), stats, plates: produced.length, machine, process: proc, filament, ms: Date.now() - t0 };
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
