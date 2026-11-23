// Yapılandırılmış yazıcıları sürücülere bağlar, durumları birleştirir, bitiş/hata olaylarını yakalar.
const { EventEmitter } = require('events');
const { AnycubicDriver } = require('./anycubic');
const { MoonrakerDriver } = require('./moonraker');

const DRIVERS = { anycubic: AnycubicDriver, moonraker: MoonrakerDriver };
const HISTORY_MS = 20 * 60 * 1000;

class PrinterManager extends EventEmitter {
  constructor() {
    super();
    this.drivers = new Map();   // id -> driver
    this.history = new Map();   // id -> [[ts, nozzle, bed]]
    this.prev = new Map();      // id -> { status, progress }
    this.order = [];
  }

  sync(configs) {
    this.order = configs.map((c) => c.id);
    for (const cfg of configs) {
      const d = this.drivers.get(cfg.id);
      if (d && (d.cfg.host !== cfg.host || d.cfg.port !== cfg.port || d.cfg.kind !== cfg.kind)) {
        d.stop(); d.removeAllListeners(); this.drivers.delete(cfg.id);
      } else if (d) {
        d.cfg = cfg; d.state.name = cfg.name; continue;
      }
      const Driver = DRIVERS[cfg.kind];
      if (!Driver) continue;
      const nd = new Driver(cfg);
      nd.on('change', () => this._onChange(nd));
      this.drivers.set(cfg.id, nd);
      nd.start();
    }
    for (const [id, d] of this.drivers) {
      if (!configs.find((c) => c.id === id)) { d.stop(); d.removeAllListeners(); this.drivers.delete(id); this.history.delete(id); this.prev.delete(id); }
    }
    this.emit('change');
  }

  get(id) {
    const d = this.drivers.get(id);
    if (!d) throw new Error('Yazıcı bulunamadı');
    return d;
  }

  snapshot() {
    return this.order.filter((id) => this.drivers.has(id)).map((id) => ({ ...this.drivers.get(id).state, history: this.history.get(id) || [] }));
  }

  _onChange(d) {
    const s = d.state;
    // sıcaklık geçmişi
    if (s.temps && (s.temps.nozzle || s.temps.bed)) {
      const h = this.history.get(s.id) || [];
      const now = Date.now();
      const last = h[h.length - 1];
      if (!last || now - last[0] >= 3000) {
        h.push([now, s.temps.nozzle ? s.temps.nozzle.cur : null, s.temps.bed ? s.temps.bed.cur : null]);
        while (h.length && h[0][0] < now - HISTORY_MS) h.shift();
        this.history.set(s.id, h);
      }
    }
    // olaylar
    const p = this.prev.get(s.id);
    if (p && p.status !== s.status) {
      const base = { id: s.id, name: s.name, file: (s.job && s.job.file) || p.file };
      if (s.status === 'finished' || (p.status === 'printing' && s.status === 'idle' && p.progress >= 97 && !s.cancelled)) this.emit('event', { ...base, type: 'finished' });
      else if (s.status === 'error' && ['printing', 'paused', 'busy'].includes(p.status)) this.emit('event', { ...base, type: 'error', message: s.error });
      else if (s.status === 'paused' && p.status === 'printing') this.emit('event', { ...base, type: 'paused' });
      else if (s.status === 'printing' && ['idle', 'busy', 'finished'].includes(p.status)) this.emit('event', { ...base, type: 'started' });
    }
    if (s.status !== 'offline' && s.status !== 'connecting') {
      this.prev.set(s.id, { status: s.status, progress: s.job ? s.job.progress : (p ? p.progress : 0), file: s.job ? s.job.file : (p && p.file) });
    }
    this.emit('change');
  }

  stopAll() { for (const d of this.drivers.values()) d.stop(); }
}

module.exports = { PrinterManager };
