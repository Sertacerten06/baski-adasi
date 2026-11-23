// Dilimleyicinin sistem profilleri: makine, kalite (process) ve filament.
// Her üretici için resources/profiles/<Üretici>.json bir dizin dosyasıdır; profiller "inherits" ile
// zincirlenir. Aynı ad (ör. fdm_machine_common) birçok üreticide geçtiği için miras önce aynı
// üreticide aranır.
const fs = require('fs');
const path = require('path');

const SUBS = ['machine', 'process', 'filament'];
const first = (v) => (Array.isArray(v) ? v[0] : v);

class Profiles {
  constructor(resourcesDir) {
    this.dir = path.join(resourcesDir, 'profiles');
    this.vendors = null;          // üretici -> { index, map: Map(`${sub}:${name}` -> dosya) }
    this.raw = new Map();         // dosya -> json
    this.flat = new Map();        // `${vendor}|${sub}:${name}` -> düzleştirilmiş json
  }

  _load() {
    if (this.vendors) return;
    this.vendors = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      let index;
      try { index = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { continue; }
      if (!index.machine_list && !index.process_list && !index.filament_list) continue;
      const vendor = f.slice(0, -5);
      const map = new Map();
      for (const sub of SUBS) {
        for (const e of index[`${sub}_list`] || []) if (e.name && e.sub_path) map.set(`${sub}:${e.name}`, path.join(this.dir, vendor, e.sub_path));
      }
      this.vendors.set(vendor, { index, map });
    }
  }

  _read(file) {
    if (!this.raw.has(file)) this.raw.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
    return this.raw.get(file);
  }

  // Bir profili bul: önce verilen üreticide, sonra Orca'nın genel filament kitaplığında, sonra hepsinde
  locateFile(sub, name, vendorHint) {
    this._load();
    const key = `${sub}:${name}`;
    const order = [vendorHint, 'OrcaFilamentLibrary', ...this.vendors.keys()].filter(Boolean);
    for (const v of order) {
      const e = this.vendors.get(v);
      if (e && e.map.has(key)) return { vendor: v, file: e.map.get(key) };
    }
    return null;
  }

  has(sub, name) { return !!this.locateFile(sub, name); }

  // Miras zincirini birleştir (çocuk ebeveynin üzerine yazar)
  resolve(sub, name, vendorHint, depth = 0) {
    const loc = this.locateFile(sub, name, vendorHint);
    if (!loc) throw new Error(`Profil bulunamadı: ${name}`);
    const key = `${loc.vendor}|${sub}:${name}`;
    if (this.flat.has(key)) return { ...this.flat.get(key) };
    if (depth > 20) throw new Error('Profil mirası çok derin');
    const j = this._read(loc.file);
    const base = j.inherits ? this.resolve(sub, j.inherits, loc.vendor, depth + 1) : {};
    const merged = { ...base, ...j };
    this.flat.set(key, merged);
    return { ...merged };
  }

  vendorOf(sub, name) { const l = this.locateFile(sub, name); return l ? l.vendor : null; }

  // Bir üreticinin seçilebilir (instantiation=true) profilleri
  _leaves(vendor, sub) {
    const e = this.vendors.get(vendor);
    if (!e) return [];
    const out = [];
    for (const [key, file] of e.map) {
      if (!key.startsWith(`${sub}:`)) continue;
      let j;
      try { j = this._read(file); } catch { continue; }
      if (String(j.instantiation) !== 'true') continue;
      out.push(key.slice(sub.length + 1));
    }
    return out;
  }

  // Makine seçici için: üretici -> model -> nozul seçenekleri
  catalog() {
    this._load();
    const vendors = [];
    for (const vendor of [...this.vendors.keys()].sort((a, b) => a.localeCompare(b))) {
      if (/^(OrcaFilamentLibrary|Custom)$/i.test(vendor)) continue;
      const models = new Map();
      for (const name of this._leaves(vendor, 'machine')) {
        let m;
        try { m = this.resolve('machine', name, vendor); } catch { continue; }
        const model = m.printer_model || name;
        if (!models.has(model)) models.set(model, []);
        models.get(model).push({ name, nozzle: first(m.nozzle_diameter) });
      }
      if (models.size) vendors.push({ vendor, models: [...models].map(([model, presets]) => ({ model, presets: presets.sort((a, b) => Number(a.nozzle) - Number(b.nozzle)) })).sort((a, b) => a.model.localeCompare(b.model)) });
    }
    return vendors;
  }

  // Bir makineyle uyumlu kalite ve filament profilleri
  compatible(machineName) {
    const vendor = this.vendorOf('machine', machineName);
    if (!vendor) throw new Error(`Makine profili bulunamadı: ${machineName}`);
    const machine = this.resolve('machine', machineName, vendor);
    const fits = (j) => Array.isArray(j.compatible_printers) && j.compatible_printers.includes(machineName);
    const processes = [];
    for (const name of this._leaves(vendor, 'process')) {
      let j; try { j = this.resolve('process', name, vendor); } catch { continue; }
      if (fits(j)) processes.push({ name, layer: Number(first(j.layer_height)) || null });
    }
    processes.sort((a, b) => (a.layer || 0) - (b.layer || 0) || a.name.localeCompare(b.name));
    const filaments = [];
    for (const name of this._leaves(vendor, 'filament')) {
      let j; try { j = this.resolve('filament', name, vendor); } catch { continue; }
      if (fits(j)) filaments.push({ name, type: first(j.filament_type) || '' });
    }
    // Üreticiye özel filament yoksa Orca'nın genel kitaplığı (her yazıcıyla uyumlu)
    if (!filaments.length && this.vendors.has('OrcaFilamentLibrary')) {
      for (const name of this._leaves('OrcaFilamentLibrary', 'filament')) {
        if (!/^Generic /.test(name)) continue;
        let j; try { j = this.resolve('filament', name, 'OrcaFilamentLibrary'); } catch { continue; }
        filaments.push({ name, type: first(j.filament_type) || '', generic: true });
      }
    }
    filaments.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    const area = (machine.printable_area || []).map((p) => String(p).split('x').map(Number));
    const xs = area.map((p) => p[0]); const ys = area.map((p) => p[1]);
    return {
      vendor,
      machine: machineName,
      model: machine.printer_model || machineName,
      bed: area.length ? { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), z: Number(machine.printable_height) || 250 } : { x0: 0, y0: 0, w: 220, h: 220, z: 250 },
      thumbnails: String(machine.thumbnails_format || 'PNG').toUpperCase() === 'PNG'
        ? (Array.isArray(machine.thumbnails) ? machine.thumbnails : String(machine.thumbnails || '').split(','))
          .map((s) => String(s).trim().split('x').map(Number)).filter(([w, h]) => w > 0 && h > 0 && w <= 600 && h <= 600)
        : [],
      defaultProcess: first(machine.default_print_profile) || null,
      defaultFilament: first(machine.default_filament_profile) || null,
      processes,
      filaments,
    };
  }

  // Bir yazıcı modeline (ör. "Anycubic Kobra 3") uyan 0.4 nozullu makine profili
  machineForModel(modelName) {
    this._load();
    const want = String(modelName || '').toLowerCase();
    if (!want) return null;
    let best = null;
    // önce adı modelin başında geçen üretici (ör. "anycubic kobra 3" -> Anycubic); yoksa hepsi
    const named = [...this.vendors.keys()].filter((v) => want.startsWith(v.toLowerCase()));
    for (const vendor of named.length ? named : this.vendors.keys()) {
      for (const name of this._leaves(vendor, 'machine')) {
        let m; try { m = this.resolve('machine', name, vendor); } catch { continue; }
        const model = String(m.printer_model || '').toLowerCase();
        if (!model || !want.startsWith(model)) continue;
        const score = model.length * 10 + (String(first(m.nozzle_diameter)) === '0.4' ? 5 : 0);
        if (!best || score > best.score) best = { name, score };
      }
    }
    return best && best.name;
  }
}

module.exports = { Profiles, first };
