// Anycubic Kobra 3 / S1 serisi, LAN modu.
// Akış: GET :18910/info -> imzalı POST /ctrl -> AES-CBC çöz -> MQTT (mTLS, :9883)
// Protokol kaynağı: github.com/rvanderp3/kobra-connect, github.com/chrisfore/anycubic_ha_local
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { BaseDriver, clamp, toHex } = require('./base');
const { request, getJson, multipart, netError, asciiName } = require('./net');

const PREFIX = 'anycubic/anycubicCloud/v1';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const rand = (n, chars) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');

const getInfo = (host, timeout = 10000) => getJson(`http://${host}:18910/info`, timeout);

async function handshake(host) {
  const info = await getInfo(host, 10000);
  if (info.ctrlType === 'cloud') throw new Error('Yazıcı bulut modunda. Yazıcının ekranından LAN modunu aç.');
  const { token, ctrlInfoUrl, modelId } = info;
  if (!token || !ctrlInfoUrl || !modelId) throw new Error('Bu yazıcı LAN el sıkışmasını desteklemiyor');

  const ts = Date.now();
  const nonce = rand(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  const did = rand(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const sign = md5(md5(token.slice(0, 16)) + String(ts) + nonce);
  // ctrlInfoUrl'nin sadece yolunu al; host her zaman bizim bildiğimiz adres
  const cu = new URL(ctrlInfoUrl);
  const ctrlUrl = `http://${host}:${cu.port || 18910}${cu.pathname}?${new URLSearchParams({ ts, nonce, sign, did })}`;
  const ctrl = JSON.parse((await request(ctrlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 10000 })).text);
  if (ctrl.code !== 200) throw new Error(`/ctrl hatası: ${ctrl.message}`);

  const iv = Buffer.alloc(16);
  Buffer.from(ctrl.data.token).copy(iv, 0, 0, 16);
  const dec = crypto.createDecipheriv('aes-128-cbc', Buffer.from(token.slice(16, 32)), iv);
  const data = JSON.parse(Buffer.concat([dec.update(Buffer.from(ctrl.data.info, 'base64')), dec.final()]).toString('utf8'));
  const m = /mqtts?:\/\/([^:]+):(\d+)/.exec(data.broker);
  if (!m) throw new Error('Broker adresi çözülemedi');
  return {
    info, brokerPort: Number(m[2]),
    username: data.username, password: data.password,
    deviceId: data.deviceId, modelId: String(modelId),
    cert: data.devicecrt || '', key: data.devicepk || '',
  };
}

const UPLOAD_ERRORS = {
  19007: 'Yazıcı dosya adını/türünü kabul etmedi', 19008: 'Dosya yazıcıya kaydedilemedi',
  19009: 'Dosya yazıcıya kaydedilemedi', 19010: 'Yazıcıda yer kalmadı', 19011: 'Yazıcı 3MF dosyasını reddetti',
};

const BUSY_TEXT = {
  preheating: 'Ön ısıtma', auto_leveling: 'Seviyeleme', checking: 'Kontrol ediliyor', downloading: 'Hazırlanıyor',
  stopping: 'Durduruluyor', stoped: 'Durduruldu', resuming: 'Devam ediyor', pausing: 'Duraklatılıyor',
  updating: 'Güncelleniyor', calibrating: 'Kalibrasyon', busy: 'Meşgul',
};

class AnycubicDriver extends BaseDriver {
  constructor(cfg) {
    super(cfg, 'anycubic');
    this.raw = { printer: null, temp: null, project: null, phase: null, ace: null, files: null, lights: null, fan: null };
    this.timers = [];
    this.client = null;
    this.hs = null;
    this.state.caps = { light: true, speedMode: true, fan: true, upload: true, startPrint: false };
  }

  start() { this.stopped = false; this._connect(); }

  stop() {
    super.stop();
    this._teardown();
  }

  _teardown() {
    this.timers.forEach(clearInterval); this.timers = [];
    clearTimeout(this.retryTimer);
    if (this.client) { this.client.removeAllListeners(); this.client.on('error', () => {}); this.client.end(true); this.client = null; }
  }

  _retry(ms) {
    clearTimeout(this.retryTimer);
    if (!this.stopped) this.retryTimer = setTimeout(() => this._connect(), ms);
  }

  async _connect() {
    this._teardown();
    if (this.stopped) return;
    if (this.state.status !== 'offline') this.set({ status: 'connecting', connected: false });
    let hs;
    try {
      hs = await handshake(this.cfg.host);
    } catch (e) {
      this._fail(netError(e) || e.message);
      return;
    }
    if (this.stopped) return;
    this.hs = hs;
    this.set({ model: (hs.info.modelName || '').replace(/^Anycubic\s+/i, '') || 'Anycubic', uid: hs.info.cn || null });

    const client = mqtt.connect({
      protocol: 'mqtts', host: this.cfg.host, port: hs.brokerPort,
      username: hs.username, password: hs.password, cert: hs.cert, key: hs.key,
      rejectUnauthorized: false,
      clientId: `badasi-${crypto.randomBytes(4).toString('hex')}`,
      keepalive: 30, reconnectPeriod: 0, connectTimeout: 10000,
    });
    this.client = client;
    client.on('connect', () => {
      client.subscribe(`${PREFIX}/printer/public/${hs.modelId}/${hs.deviceId}/#`);
      this.failCount = 0;
      this.set({ connected: true, error: null });
      this._pollAll();
      this.timers.push(setInterval(() => this._send('info', 'query', null, 'web'), 4000));
      this.timers.push(setInterval(() => this._send('multiColorBox', 'getInfo', null), 15000));
      this.timers.push(setInterval(() => this._send('light', 'query', null, 'web'), 30000));
      this.timers.push(setInterval(() => this._send('file', 'listLocal', { path: '/' }), 120000));
      // yazıcı sessizleşirse (ör. kapatıldı) bağlantıyı yenile
      this.lastMsg = Date.now();
      this.timers.push(setInterval(() => {
        if (Date.now() - this.lastMsg > 20000) { this._teardown(); this._fail('Yazıcı yanıt vermiyor'); }
      }, 5000));
    });
    client.on('message', (topic, payload) => {
      this.lastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
      this._onReport(topic, msg);
    });
    client.on('error', (e) => this.set({ error: e.message }));
    client.on('close', () => {
      if (this.client !== client || this.stopped) return;
      this._teardown();
      this._fail('Bağlantı koptu');
    });
  }

  // Tek bir başarısızlıkta hemen "çevrimdışı" deme: Wi-Fi'si kısa süre kopan yazıcılar için
  // önce 2 sn sonra yeniden dene, art arda ikinci başarısızlıkta çevrimdışı göster.
  _fail(msg) {
    this.failCount = (this.failCount || 0) + 1;
    if (this.failCount >= 2) this.set({ connected: false, status: 'offline', error: msg, job: null });
    else this.set({ connected: false, status: 'connecting', error: msg });
    this._retry(this.failCount >= 2 ? 8000 : 2000);
  }

  _send(type, action, data = null, channel = 'slicer') {
    if (!this.client || !this.hs || !this.state.connected) throw new Error('Yazıcıya bağlı değil');
    const topic = `${PREFIX}/${channel}/printer/${this.hs.modelId}/${this.hs.deviceId}/${type}`;
    this.client.publish(topic, JSON.stringify({ type, action, timestamp: Date.now(), msgid: crypto.randomUUID(), data }));
  }

  _pollAll() {
    this._send('info', 'query', null, 'web');
    this._send('multiColorBox', 'getInfo', null);
    this._send('file', 'listLocal', { path: '/' });
    this._send('light', 'query', null, 'web');
  }

  _mergeProject(src) {
    if (!src || typeof src !== 'object') return;
    const keys = ['progress', 'curr_layer', 'total_layers', 'remain_time', 'print_time', 'filename', 'display_filename', 'state', 'taskid'];
    if (!keys.some((k) => k in src)) return;
    const p = { ...(this.raw.project || {}) };
    for (const k of keys) if (src[k] !== undefined && src[k] !== null) p[k] = src[k];
    this.raw.project = p;
  }

  _onReport(topic, msg) {
    const type = msg.type || topic.split('/').slice(-2, -1)[0];
    const d = msg.data;
    const r = this.raw;
    switch (type) {
      case 'info': {
        if (!d) return;
        const { urls, temp, project, ...rest } = d;
        if (urls && urls.fileUploadurl) this.uploadUrl = urls.fileUploadurl;
        const wasBusy = r.printer && r.printer.state !== 'free';
        r.printer = rest;
        if (temp) r.temp = { ...(r.temp || {}), ...temp };
        if (rest.state === 'free') {
          if (wasBusy) this.state.cancelled = r.phase === 'stoped' || r.phase === 'stopping';
          r.project = null; r.phase = null;
        } else {
          if (!wasBusy) this.state.cancelled = false;
          if (project) this._mergeProject(project);
        }
        r.fan = d.fan_speed_pct;
        break;
      }
      case 'print':
        if ((msg.state && BUSY_TEXT[msg.state] !== undefined) || ['paused', 'printing', 'finished', 'failed'].includes(msg.state)) { r.phase = msg.state; r.phaseAt = Date.now(); }
        if (d) {
          this._mergeProject(d);
          if (d.settings) {
            const s = d.settings; const t = {};
            for (const k of ['curr_nozzle_temp', 'curr_hotbed_temp', 'target_nozzle_temp', 'target_hotbed_temp']) if (s[k] !== undefined) t[k] = s[k];
            r.temp = { ...(r.temp || {}), ...t };
          }
        }
        break;
      case 'tempature':
        if (d) r.temp = { ...(r.temp || {}), ...d };
        break;
      case 'fan':
        if (d && d.fan_speed_pct !== undefined) r.fan = d.fan_speed_pct;
        break;
      case 'multiColorBox':
        if (d && Array.isArray(d.multi_color_box)) r.ace = d.multi_color_box;
        break;
      case 'file':
        if (d && Array.isArray(d.records) && msg.action === 'listLocal') r.files = d.records;
        break;
      case 'light':
        if (d && Array.isArray(d.lights)) r.lights = d.lights;
        if (msg.action === 'control') setTimeout(() => { try { this._send('light', 'query', null, 'web'); } catch { /* */ } }, 500);
        break;
      default:
        return;
    }
    this._recompute();
  }

  _recompute() {
    const r = this.raw;
    const p = r.printer || {};
    const t = r.temp || {};
    let status = 'idle'; let statusText = null; let job = null;
    if (p.state && p.state !== 'free') {
      // print raporundaki faz anlık ama bayatlayabilir; 10 sn sonra info'daki proje durumuna dön
      const phaseFresh = r.phase && r.phase !== 'printing' && Date.now() - (r.phaseAt || 0) < 10000;
      const ps = phaseFresh ? r.phase : (r.project && r.project.state) || r.phase || 'busy';
      if (ps === 'printing') status = 'printing';
      else if (ps === 'paused' || ps === 'pausing') { status = 'paused'; if (ps === 'pausing') statusText = 'Duraklatılıyor'; }
      else if (ps === 'finished') status = 'finished';
      else if (ps === 'failed') status = 'error';
      else { status = 'busy'; statusText = BUSY_TEXT[ps] || ps; }
      const pr = r.project;
      if (pr) {
        job = {
          file: String(pr.display_filename || pr.filename || '').replace(/^.*\//, ''),
          progress: Math.max(0, Math.min(100, Number(pr.progress) || 0)),
          layer: pr.curr_layer ?? null, totalLayers: pr.total_layers ?? null,
          elapsedMin: pr.print_time ?? null, remainingMin: pr.remain_time ?? null,
        };
      }
    }
    const box = Array.isArray(r.ace) && r.ace[0];
    const light = (r.lights || []).find((l) => l.type === 1);
    this.set({
      status, statusText, job,
      firmware: p.version || this.state.firmware,
      temps: {
        nozzle: t.curr_nozzle_temp !== undefined ? { cur: t.curr_nozzle_temp, target: t.target_nozzle_temp || 0 } : null,
        bed: t.curr_hotbed_temp !== undefined ? { cur: t.curr_hotbed_temp, target: t.target_hotbed_temp || 0 } : null,
        chamber: null,
      },
      fan: r.fan ?? null,
      speedMode: p.print_speed_mode ?? null,
      light: light ? !!light.status : null,
      filaments: box ? (box.slots || []).map((s) => ({ index: s.index, color: toHex(s.color), type: s.type || '—', active: box.loaded_slot === s.index })) : null,
      filamentBox: box ? {
        temp: box.temp ?? null, humidity: box.humidity || null,
        drying: box.drying_status && box.drying_status.status ? { target: box.drying_status.target_temp, remainingMin: box.drying_status.remain_time } : null,
      } : null,
      files: r.files ? r.files.map((f) => ({ name: f.filename, size: f.size, date: f.timestamp })).sort((a, b) => b.date - a.date) : null,
    });
  }

  async command(cmd, value) {
    const upd = (settings) => this._send('print', 'update', { taskid: '-1', settings });
    switch (cmd) {
      case 'pause': return this._send('print', 'pause', { taskid: '-1' });
      case 'resume': return this._send('print', 'resume', { taskid: '-1' });
      case 'stop': return this._send('print', 'stop', { taskid: '-1' });
      case 'setTemp':
        return value.heater === 'bed' ? upd({ target_hotbed_temp: clamp(value.value, 0, 110) }) : upd({ target_nozzle_temp: clamp(value.value, 0, 300) });
      case 'preheat': return upd({ target_nozzle_temp: clamp(value.nozzle, 0, 300), target_hotbed_temp: clamp(value.bed, 0, 110) });
      case 'fan': return upd({ fan_speed_pct: clamp(value, 0, 100) });
      case 'speed': return upd({ print_speed_mode: clamp(value, 1, 3) });
      case 'light': return this._send('light', 'control', { type: 1, status: value ? 1 : 0, brightness: value ? 100 : 0 }, 'web');
      case 'refresh': return this._pollAll();
      default: throw new Error('Bu yazıcıda desteklenmiyor');
    }
  }

  async upload(filePath) {
    const name = asciiName(path.basename(filePath));
    if (!/\.(gcode|3mf)$/i.test(name)) throw new Error('Sadece .gcode veya .gcode.3mf dosyası');
    const buf = await fs.promises.readFile(filePath);
    const fresh = await getInfo(this.cfg.host, 10000);
    // yazıcının verdiği adresin yalnızca port/yol/sorgusunu al, host her zaman bilinen IP
    const u = new URL(fresh.fileUploadurl || this.uploadUrl);
    const target = `http://${this.cfg.host}:${u.port || 18910}${u.pathname}${u.search}`;
    const form = multipart([{ name: 'filename', value: name }, { name: 'gcode', filename: name, data: buf }]);
    let res;
    try {
      res = await request(target, { method: 'POST', body: form.body, headers: { 'Content-Type': form.contentType, 'X-File-Length': String(buf.length) }, timeout: 15 * 60 * 1000 });
    } catch (e) { throw new Error(netError(e) || e.message); }
    let body = {};
    try { body = JSON.parse(res.text); } catch { /* boş yanıt */ }
    if (UPLOAD_ERRORS[body.code]) throw new Error(UPLOAD_ERRORS[body.code]);
    if (res.status !== 200 || (body.code !== undefined && ![0, 200].includes(body.code))) throw new Error(`Yükleme reddedildi (HTTP ${res.status})`);
    setTimeout(() => { try { this._send('file', 'listLocal', { path: '/' }); } catch { /* */ } }, 1500);
    return name;
  }
}

// Ağ taraması için: bu adreste Anycubic LAN yazıcısı var mı?
async function probe(host) {
  try {
    const info = await getInfo(host, 2500);
    if (!info || !info.modelName) return null;
    return {
      kind: 'anycubic', host, port: 18910,
      name: String(info.modelName).replace(/^Anycubic\s+/i, ''), model: info.modelName,
      uid: info.cn || null, lan: info.ctrlType !== 'cloud',
    };
  } catch { return null; }
}

module.exports = { AnycubicDriver, probe };
