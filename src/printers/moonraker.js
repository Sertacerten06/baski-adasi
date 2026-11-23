// Klipper + Moonraker yazıcılar (Artillery Sidewinder X4 / M1 serisi ve diğer Klipper yazıcılar).
// Moonraker JSON-RPC websocket: ws://host:port/websocket  (port genelde 7125, Mainsail arkasında 80)
const fs = require('fs');
const path = require('path');
const WS = require('ws'); // Electron ana sürecinde yerleşik WebSocket yerine olgun `ws` paketi
const { BaseDriver, clamp } = require('./base');
const { request, getJson, multipart, netError } = require('./net');

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const LIGHT_RE = /^(output_pin|led|neopixel|dotstar|pca9533|pca9632)\s+(.*)$/i;

class MoonrakerDriver extends BaseDriver {
  constructor(cfg) {
    super(cfg, 'moonraker');
    this.port = cfg.port || 7125;
    this.ws = null;
    this.rpcId = 1;
    this.pending = new Map();
    this.raw = {};
    this.meta = null;       // o anki dosyanın metadata'sı
    this.metaFile = null;
    this.lightObj = null;
    this.state.caps = { light: false, speedMode: false, fan: true, upload: true, startPrint: true, sendPrint: true };
  }

  get base() { return `http://${this.cfg.host}:${this.port}`; }

  start() { this.stopped = false; this._connect(); }

  stop() {
    super.stop();
    clearTimeout(this.retryTimer);
    clearInterval(this.fileTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
  }

  _retry(ms) {
    clearTimeout(this.retryTimer);
    if (!this.stopped) this.retryTimer = setTimeout(() => this._connect(), ms);
  }

  _connect() {
    if (this.stopped) return;
    if (this.ws) { try { this.ws.close(); } catch { /* */ } }
    if (this.state.status !== 'offline') this.set({ status: 'connecting', connected: false });
    let ws;
    try { ws = new WS(`ws://${this.cfg.host}:${this.port}/websocket`); } catch (e) { this._fail(e.message); return; }
    this.ws = ws;
    const openTimer = setTimeout(() => { if (ws.readyState !== 1) { try { ws.close(); } catch { /* */ } this._fail('Yazıcıya ulaşılamıyor'); } }, 8000);
    ws.onopen = () => { clearTimeout(openTimer); this.failCount = 0; this.set({ connected: true, error: null }); this._init().catch((e) => this.set({ error: e.message })); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      this._onMessage(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (this.ws !== ws) return;
      for (const p of this.pending.values()) p.reject(new Error('Bağlantı koptu'));
      this.pending.clear();
      clearInterval(this.fileTimer);
      this._fail(this.state.connected ? 'Bağlantı koptu' : 'Yazıcıya ulaşılamıyor');
    };
  }

  // ilk başarısızlıkta "bağlanıyor" kal ve 2 sn sonra dene; art arda ikincisinde çevrimdışı
  _fail(msg) {
    this.failCount = (this.failCount || 0) + 1;
    if (this.failCount >= 2) this.set({ connected: false, status: 'offline', error: msg, job: null });
    else this.set({ connected: false, status: 'connecting', error: msg });
    this._retry(this.failCount >= 2 ? 10000 : 2000);
  }

  call(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Yazıcıya bağlı değil'));
      const id = this.rpcId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('Yazıcı yanıt vermedi')); }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  async _init() {
    const server = await this.call('server.info');
    let pinfo = null;
    try { pinfo = await this.call('printer.info'); } catch { /* klippy hazır değil */ }
    if (pinfo) this.set({ uid: this.state.uid || `mr:${pinfo.hostname}`, firmware: (pinfo.software_version || '').split('-')[0] || null });
    if (!this.state.model) this.set({ model: 'Klipper' });
    if (server.klippy_state !== 'ready') {
      this.set({ status: 'error', statusText: null, error: (pinfo && pinfo.state_message) || `Klipper durumu: ${server.klippy_state}`, job: null });
      // notify_klippy_ready gelince yeniden başlatılır; gelmezse periyodik dene
      clearTimeout(this.klippyTimer);
      this.klippyTimer = setTimeout(() => { if (this.state.connected && this.state.status === 'error') this._init().catch(() => {}); }, 10000);
      return;
    }
    const { objects } = await this.call('printer.objects.list');
    const sub = { print_stats: null, display_status: null, virtual_sdcard: null, extruder: null, heater_bed: null, webhooks: null, gcode_move: ['speed_factor'] };
    if (objects.includes('fan')) sub.fan = null;
    const chamber = objects.find((o) => /^(temperature_sensor|heater_generic)\s+.*chamber/i.test(o));
    if (chamber) sub[chamber] = null;
    this.chamberObj = chamber || null;
    this.lightObj = objects.find((o) => LIGHT_RE.test(o) && /light|led|lamp|case|chamber/i.test(o)) || null;
    if (this.lightObj) sub[this.lightObj] = null;
    this.state.caps = { ...this.state.caps, light: !!this.lightObj, fan: objects.includes('fan') };
    const res = await this.call('printer.objects.subscribe', { objects: sub });
    this.raw = res.status || {};
    this._recompute();
    this._refreshFiles();
    clearInterval(this.fileTimer);
    this.fileTimer = setInterval(() => this._refreshFiles(), 120000);
  }

  _onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'Moonraker hatası')); else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case 'notify_status_update':
        deepMerge(this.raw, m.params && m.params[0]);
        this._recompute();
        break;
      case 'notify_klippy_ready':
        this._init().catch((e) => this.set({ error: e.message }));
        break;
      case 'notify_klippy_shutdown':
      case 'notify_klippy_disconnected':
        this.set({ status: 'error', error: 'Klipper bağlantısı kesildi', job: null });
        break;
      case 'notify_filelist_changed':
        this._refreshFiles();
        break;
      default:
    }
  }

  async _refreshFiles() {
    try {
      const list = await this.call('server.files.list', { root: 'gcodes' });
      const files = (list || []).map((f) => ({ name: f.path, size: f.size, date: Math.round((f.modified || 0) * 1000) }))
        .sort((a, b) => b.date - a.date).slice(0, 200);
      this.set({ files });
    } catch { /* sessiz geç */ }
  }

  async _loadMeta(filename) {
    this.metaFile = filename; this.meta = null;
    if (!filename) return;
    try { this.meta = await this.call('server.files.metadata', { filename }); this._recompute(); } catch { /* */ }
  }

  _recompute() {
    const r = this.raw;
    const ps = r.print_stats || {};
    if (ps.filename !== undefined && ps.filename !== this.metaFile) this._loadMeta(ps.filename);
    const map = { printing: 'printing', paused: 'paused', complete: 'finished', error: 'error', cancelled: 'idle', standby: 'idle' };
    const status = map[ps.state] || 'idle';
    let job = null;
    if (['printing', 'paused', 'finished'].includes(status) || (status === 'error' && ps.filename)) {
      const prog = (r.display_status && r.display_status.progress) || (r.virtual_sdcard && r.virtual_sdcard.progress) || 0;
      const dur = ps.print_duration || 0;
      let remaining = null;
      if (status === 'finished') remaining = 0;
      else if (prog > 0.05) remaining = (dur / prog - dur) / 60;
      else if (this.meta && this.meta.estimated_time) remaining = Math.max(0, this.meta.estimated_time - dur) / 60;
      const info = ps.info || {};
      job = {
        file: String(ps.filename || '').replace(/^.*\//, ''),
        progress: Math.round((status === 'finished' ? 1 : prog) * 100),
        layer: info.current_layer ?? null,
        totalLayers: info.total_layer ?? (this.meta && this.meta.layer_count) ?? null,
        elapsedMin: dur / 60,
        remainingMin: remaining,
      };
    }
    const heat = (o) => (o && o.temperature !== undefined ? { cur: o.temperature, target: o.target || 0 } : null);
    let light = null;
    if (this.lightObj && r[this.lightObj]) {
      const lo = r[this.lightObj];
      if (lo.value !== undefined) light = lo.value > 0;
      else if (Array.isArray(lo.color_data)) light = lo.color_data.some((c) => c.some((x) => x > 0));
    }
    this.set({
      status,
      statusText: ps.state === 'cancelled' ? 'İptal edildi' : null,
      cancelled: ps.state === 'cancelled',
      error: status === 'error' ? (ps.message || 'Baskı hatası') : null,
      job,
      temps: { nozzle: heat(r.extruder), bed: heat(r.heater_bed), chamber: this.chamberObj ? heat(r[this.chamberObj]) : null },
      fan: r.fan ? Math.round((r.fan.speed || 0) * 100) : null,
      light,
    });
  }

  _gcode(script) { return this.call('printer.gcode.script', { script }, 30000); }

  async command(cmd, value) {
    switch (cmd) {
      case 'pause': return this.call('printer.print.pause');
      case 'resume': return this.call('printer.print.resume');
      case 'stop': return this.call('printer.print.cancel');
      case 'setTemp':
        return value.heater === 'bed' ? this._gcode(`M140 S${clamp(value.value, 0, 130)}`) : this._gcode(`M104 S${clamp(value.value, 0, 320)}`);
      case 'preheat':
        await this._gcode(`M104 S${clamp(value.nozzle, 0, 320)}`);
        return this._gcode(`M140 S${clamp(value.bed, 0, 130)}`);
      case 'fan': return this._gcode(`M106 S${Math.round((clamp(value, 0, 100) * 255) / 100)}`);
      case 'light': {
        if (!this.lightObj) throw new Error('Işık bulunamadı');
        const [, type, name] = LIGHT_RE.exec(this.lightObj);
        if (type.toLowerCase() === 'output_pin') return this._gcode(`SET_PIN PIN=${name} VALUE=${value ? 1 : 0}`);
        const v = value ? 1 : 0;
        return this._gcode(`SET_LED LED=${name} RED=${v} GREEN=${v} BLUE=${v}`);
      }
      case 'startPrint': return this.call('printer.print.start', { filename: String(value) });
      case 'refresh': this._refreshFiles(); return this.call('printer.objects.query', { objects: { print_stats: null } });
      default: throw new Error('Bu yazıcıda desteklenmiyor');
    }
  }

  async upload(filePath) {
    const name = path.basename(filePath);
    if (!/\.(gcode|g|gco|ufp)$/i.test(name)) throw new Error('Sadece .gcode dosyası');
    const buf = await fs.promises.readFile(filePath);
    const form = multipart([{ name: 'root', value: 'gcodes' }, { name: 'file', filename: name, data: buf }]);
    let res;
    try {
      res = await request(`${this.base}/server/files/upload`, { method: 'POST', body: form.body, headers: { 'Content-Type': form.contentType }, timeout: 15 * 60 * 1000 });
    } catch (e) { throw new Error(netError(e) || e.message); }
    if (res.status < 200 || res.status >= 300) throw new Error(`Yükleme reddedildi (HTTP ${res.status})`);
    this._refreshFiles();
    let stored = name;
    try { const j = JSON.parse(res.text); if (j.result && j.result.item && j.result.item.path) stored = j.result.item.path; } catch { /* */ }
    return stored;
  }

  // Uygulamada dilimlenen G-code'u yükle ve isteğe bağlı olarak başlat
  async printFile(filePath, { start = true } = {}) {
    if (!this.state.connected) throw new Error('Yazıcıya bağlı değil');
    if (start && !['idle', 'finished'].includes(this.state.status)) throw new Error('Yazıcı şu an boşta değil, baskı başlatılamaz');
    const name = await this.upload(filePath);
    if (!start) return { name, started: false };
    await this.call('printer.print.start', { filename: name }, 30000);
    return { name, started: true };
  }
}

// Ağ taraması için: bu adreste Moonraker var mı?
async function probe(host, port = 7125) {
  try {
    const sjson = await getJson(`http://${host}:${port}/server/info`, 2500);
    if (!sjson || !sjson.result || sjson.result.klippy_state === undefined) return null;
    let hostname = host;
    try {
      const p = await getJson(`http://${host}:${port}/printer/info`, 2500);
      if (p.result && p.result.hostname) hostname = p.result.hostname;
    } catch { /* */ }
    // "artillery-x4plus" -> "Artillery X4plus"
    const pretty = hostname.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase('tr-TR')).trim() || host;
    return { kind: 'moonraker', host, port, name: pretty, model: 'Klipper', uid: `mr:${hostname}` };
  } catch { return null; }
}

module.exports = { MoonrakerDriver, probe };
