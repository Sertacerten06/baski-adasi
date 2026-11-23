// Tüm yazıcı sürücülerinin ortak tabanı. Arayüz yalnızca bu normalize edilmiş `state` ile konuşur.
const { EventEmitter } = require('events');

// status: offline | connecting | idle | busy | printing | paused | finished | error
class BaseDriver extends EventEmitter {
  constructor(cfg, kind) {
    super();
    this.cfg = cfg;
    this.stopped = false;
    this.state = {
      id: cfg.id,
      kind,
      name: cfg.name,
      host: cfg.host,
      port: cfg.port || null,
      uid: cfg.uid || null,
      connected: false,
      status: 'connecting',
      statusText: null,     // sürücüye özel ayrıntı (ör. "Seviyeleme")
      error: null,
      model: null,
      firmware: null,
      job: null,            // { file, progress, layer, totalLayers, elapsedMin, remainingMin }
      temps: { nozzle: null, bed: null, chamber: null }, // { cur, target }
      fan: null,            // 0-100
      speedMode: null,      // 1 sessiz, 2 standart, 3 spor
      light: null,          // true/false/null
      filaments: null,      // [{ index, color:'#rrggbb', type, active }]
      filamentBox: null,    // { temp, humidity, drying }
      files: null,          // [{ name, size, date }]
      caps: { light: false, speedMode: false, fan: false, upload: false, startPrint: false, sendPrint: false },
      modelFull: null,      // üreticinin tam model adı (ör. "Anycubic Kobra 3"), dilimleyici profili seçmek için
      cancelled: false,
      lastFailure: null,    // { code, text, at } son başarısız baskının nedeni (yazıcı bildirdiyse)
    };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('change');
  }

  start() {}
  stop() { this.stopped = true; }
  async command() { throw new Error('Desteklenmiyor'); }
  async upload() { throw new Error('Bu yazıcıya dosya yüklenemiyor'); }
  async printFile() { throw new Error('Bu yazıcıya baskı gönderilemiyor'); }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
const toHex = (rgb) => '#' + (rgb || [128, 128, 128]).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');

module.exports = { BaseDriver, clamp, toHex };
