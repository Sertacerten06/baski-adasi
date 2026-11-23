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

// Yazıcının baskıyı durdurma nedenleri (Anycubic wiki başlıklarından; anycubic_ha_local'in listesi)
const ERROR_TEXT = {
  11504: 'Kafada yazıcının tanımadığı bir filament var. Yazıcı ekranından filamenti geri çek (Unload / Boşalt), sonra tekrar dene; ya da baskıyı "Harici makara" ile başlat.',
  11518: 'Filament sıkıştı.',
  11519: 'Filament dolaştı.',
  11520: 'ACE filament sorunu.',
  11511: 'Ekstrüzyon sorunu (filament itilemiyor).',
  11512: 'Filament geri çekilemedi.',
  11513: 'ACE Pro yanıt vermiyor.',
  11509: 'ACE Pro yanıt vermiyor (zaman aşımı).',
  11503: 'ACE Pro bağlantı sorunu.',
  11524: 'ACE Pro bağlantı sorunu.',
  11521: 'ACE Pro motor sorunu.',
  11531: 'Modelde 8\'den fazla renk var.',
  11532: 'Yazıcıda otomatik seviyeleme yok.',
  11801: 'Spagetti algılandı, baskı duraklatıldı.',
  11900: 'Nozul çapı dosyayla uyuşmuyor.',
  10107: 'Filament koptu.',
  10402: 'Filament koptu ya da bitti; yeni filament yükle.',
  10113: 'Dosyanın MD5 kontrolü başarısız.',
  10115: 'Yazıcı dosyayı okuyamadı.',
  10116: 'Dilimlenmiş dosya hatalı.',
  10133: 'Dosyada gerekli komutlar eksik.',
  10106: 'Yazıcıda yer yok, görev iptal edildi.',
  10118: 'X ekseni sıfırlanamadı.',
  10119: 'Y ekseni sıfırlanamadı.',
  10120: 'Z ekseni sıfırlanamadı.',
  10130: 'Z ekseni sıfırlanamadı, Z sensörünü kontrol et.',
  10121: 'Tabla ısıtmada sorun.',
  10122: 'Nozul ısıtmada sorun.',
  10123: 'Tabla sıcaklık sensörü sorunu.',
  10124: 'Nozul sıcaklık sensörü sorunu.',
  10408: 'Baskı kafası ya da anakart yazılımı çok eski.',
};
const USER_REASONS = new Set([10401, 10601]); // kullanıcı duraklattı / durdurdu
const errorText = (code, msg) => `${ERROR_TEXT[code] || (msg ? `Yazıcı hatası: ${msg}` : 'Yazıcı bir hata bildirdi.')} (kod ${code})`;

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
    this.waiters = [];   // belirli bir raporu bekleyen istekler (ör. baskı başlatma cevabı)
    // startPrint: yazıcıdaki mevcut dosyayı başlatma (ACE eşlemesi bilinmediği için kapalı)
    // sendPrint: uygulamada dilimlenen dosyayı yükleyip başlatma
    this.state.caps = { light: true, speedMode: true, fan: true, upload: true, startPrint: false, sendPrint: true };
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
    this.set({ model: (hs.info.modelName || '').replace(/^Anycubic\s+/i, '') || 'Anycubic', modelFull: hs.info.modelName || null, uid: hs.info.cn || null });

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

  // Komutlar "web" kanalından gider: Home Assistant entegrasyonu (anycubic_ha_local) pause/resume/
  // stop/update komutlarını bu kanalda gerçek cihazda doğruladı.
  _send(type, action, data = null, channel = 'web') {
    if (!this.client || !this.hs || !this.state.connected) throw new Error('Yazıcıya bağlı değil');
    const topic = `${PREFIX}/${channel}/printer/${this.hs.modelId}/${this.hs.deviceId}/${type}`;
    const msgid = crypto.randomUUID();
    this.client.publish(topic, JSON.stringify({ type, action, timestamp: Date.now(), msgid, data }));
    return msgid;
  }

  // Bir komut gönder ve koşula uyan ilk raporu bekle (zaman aşımında null)
  _sendAndWait(type, action, data, match, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (m) => { clearTimeout(w.timer); resolve(m); } };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(null); }, timeout);
      this.waiters.push(w);
      try { this._send(type, action, data); } catch (e) { clearTimeout(w.timer); this.waiters = this.waiters.filter((x) => x !== w); reject(e); }
    });
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
    for (const w of [...this.waiters]) {
      if (w.match({ ...msg, type })) { this.waiters = this.waiters.filter((x) => x !== w); w.resolve({ ...msg, type }); }
    }
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
        // Başarısızlık nedeni: rapor zarfındaki kod (200 dışı, kullanıcı kaynaklı değilse)
        if (msg.code && msg.code !== 200 && !USER_REASONS.has(msg.code) && (msg.state === 'failed' || msg.action === 'start')) {
          this.failure = { code: msg.code, text: errorText(msg.code, msg.msg), at: Date.now() };
        }
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
        // Raporlar artımlı olabilir (baskı sırasında çoğu zaman yalnızca değişen yuva gelir):
        // kutuları id'ye, yuvaları index'e göre öncekilerle birleştir.
        if (d && Array.isArray(d.multi_color_box)) {
          const prev = new Map((r.ace || []).map((b) => [b.id, b]));
          const merged = d.multi_color_box.map((nb) => {
            const ob = prev.get(nb.id) || {};
            const slots = new Map((ob.slots || []).map((s) => [s.index, s]));
            for (const s of nb.slots || []) slots.set(s.index, { ...(slots.get(s.index) || {}), ...s });
            return { ...ob, ...nb, slots: [...slots.values()].sort((a, b) => a.index - b.index) };
          });
          for (const [id, ob] of prev) if (!merged.some((b) => b.id === id)) merged.push(ob);
          r.ace = merged;
        }
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
          rawFile: pr.filename || null, // yazıcının kendi yazımı (ör. ".3mf_temp/x.gcode"); resim isterken gerekir
          progress: Math.max(0, Math.min(100, Number(pr.progress) || 0)),
          layer: pr.curr_layer ?? null, totalLayers: pr.total_layers ?? null,
          elapsedMin: pr.print_time ?? null, remainingMin: pr.remain_time ?? null,
        };
      }
    }
    const box = Array.isArray(r.ace) && r.ace[0];
    const light = (r.lights || []).find((l) => l.type === 1);
    // son başarısızlık 15 dakika boyunca panelde gösterilir; yeni bir iş başlayınca (boştan meşgule geçiş) silinir
    const newJob = ['idle', 'finished'].includes(this.state.status) && ['busy', 'printing'].includes(status);
    if (this.failure && (newJob || status === 'printing' || Date.now() - this.failure.at > 15 * 60 * 1000)) this.failure = null;
    const feat = p.features || {};
    this.set({
      status, statusText, job,
      // baskı öncesi kalibrasyon seçenekleri (yazıcının bildirdiği özellikler)
      features: { autoLeveling: !!feat.auto_leveling_support, vibration: !!feat.vibration_compensation_support, flow: !!feat.flow_calibration_support },
      caps: { ...this.state.caps, aceEdit: !!box, idleBedTemp: !!this.bedIdleCommand, fanIdle: false },
      error: status === 'error' ? (this.failure ? this.failure.text : 'Baskı başarısız oldu') : null,
      lastFailure: this.failure ? { code: this.failure.code, text: this.failure.text, at: this.failure.at } : null,
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
      files: r.files ? r.files.filter((f) => !f.is_dir).map((f) => ({ name: f.filename, size: f.size, date: f.timestamp, plate: f.plate_number || 1 })).sort((a, b) => b.date - a.date) : null,
    });
  }

  _inJob() { return ['printing', 'paused', 'busy'].includes(this.state.status); }

  async command(cmd, value) {
    // Baskı sırasında ayarlar print/update ile gider (görev numarası bilinirse onunla).
    // Yazıcı boştayken print/update yok sayılıyor (gerçek Kobra 3'te denendi).
    const p = this.raw.project || {};
    const taskid = String(p.taskid || p.task_id || '-1');
    const upd = (settings) => this._send('print', 'update', { taskid, settings });
    const needJob = (what) => { if (!this._inJob()) throw new Error(`${what} yalnızca baskı sırasında değiştirilebilir`); };
    // Boştayken nozul: tempature/set. Bu komut yalnızca target_nozzle_temp alanını okuyor
    // (eksikse 0 sayıyor), tabla alanını yok sayıyor; tabla için boşta ayrı yol gerekiyor.
    const nozzle = (t) => (this._inJob() ? upd({ target_nozzle_temp: t }) : this._send('tempature', 'set', { target_nozzle_temp: t }));
    const bed = (t) => {
      if (this._inJob()) return upd({ target_hotbed_temp: t });
      if (this.bedIdleCommand) return this.bedIdleCommand(t);
      throw new Error('Kobra yazıcı boştayken tabla sıcaklığını uzaktan kabul etmiyor; tablayı yazıcının ekranından ısıtabilirsin. Baskı sırasında buradan değiştirilebilir.');
    };
    switch (cmd) {
      case 'pause': return this._send('print', 'pause', { taskid: '-1' });
      case 'resume': return this._send('print', 'resume', { taskid: '-1' });
      case 'stop': return this._send('print', 'stop', { taskid: '-1' });
      case 'setTemp':
        return value.heater === 'bed' ? bed(clamp(value.value, 0, 110)) : nozzle(clamp(value.value, 0, 300));
      case 'preheat': {
        const b = clamp(value.bed, 0, 110);
        nozzle(clamp(value.nozzle, 0, 300));
        if (this._inJob() || this.bedIdleCommand) return bed(b);
        // boştayken tabla uzaktan değişmiyor: kapatmada sessiz geç, ısıtmada kullanıcıya söyle
        return b > 0 ? { note: 'Nozul ısınıyor. Tabla boştayken uzaktan ısıtılamıyor; tablayı yazıcının ekranından ısıt.' } : { note: 'Nozul kapatıldı. Tabla ısınıyorsa yazıcının ekranından kapat.' };
      }
      case 'fan': needJob('Fan hızı'); return upd({ fan_speed_pct: clamp(value, 0, 100) });
      case 'speed': needJob('Hız modu'); return upd({ print_speed_mode: clamp(value, 1, 3) });
      case 'light': return this._send('light', 'control', { type: 1, status: value ? 1 : 0, brightness: value ? 100 : 0 });
      case 'aceSlot': return this._setAceSlot(value);
      case 'aceDry': return this._setAceDry(value);
      case 'refresh': return this._pollAll();
      default: throw new Error('Bu yazıcıda desteklenmiyor');
    }
  }

  // Yazıcıdaki bir dosyanın resimleri (file/fileDetails; gerçek Kobra 3'te doğrulandı):
  // thumbnail ≈ 230x110 dilimleyici önizlemesi, png_image = 512x512 üstten görünüm. Düz G-code'larda boş gelebilir.
  async fileImages(filename, plate = 1) {
    if (!this.state.connected) throw new Error('Yazıcıya bağlı değil');
    const ans = await this._sendAndWait('file', 'fileDetails', { root: 'local', filename, plate_index: plate || 1 },
      (m) => m.type === 'file' && m.action === 'fileDetails', 15000);
    if (!ans || ans.code !== 200) return null;
    const fd = (ans.data && ans.data.file_details) || {};
    const png = (s) => {
      if (typeof s !== 'string' || s.length < 100) return null;
      const b = Buffer.from(s.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      return b.length > 8 && b.length < 3 * 1024 * 1024 && b.toString('latin1', 1, 4) === 'PNG' ? b : null;
    };
    return { thumb: png(fd.thumbnail), top: png(fd.png_image) };
  }

  // ACE yuvasının filament türünü/rengini değiştir (multiColorBox/setInfo; gerçek Kobra 3'te doğrulandı)
  async _setAceSlot({ index, type, color }) {
    const box = Array.isArray(this.raw.ace) && this.raw.ace[0];
    if (!box) throw new Error('ACE bulunamadı');
    const slot = (box.slots || []).find((s) => s.index === Number(index));
    if (!slot) throw new Error('ACE yuvası bulunamadı');
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color || ''));
    const rgb = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : slot.color.slice(0, 3);
    const t = String(type || slot.type || 'PLA').replace(/[^A-Za-z0-9+\- ]/g, '').trim().slice(0, 20) || 'PLA';
    const answer = await this._sendAndWait('multiColorBox', 'setInfo', { multi_color_box: [{ id: box.id || 0, slots: [{ index: slot.index, type: t, color: rgb }] }] },
      (msg) => msg.type === 'multiColorBox' && msg.action === 'setInfo', 6000);
    if (answer && answer.code !== 200) throw new Error(`ACE yuvası güncellenemedi (kod ${answer.code}${answer.msg ? `: ${answer.msg}` : ''})`);
    // cevapta yuvanın yeni hâli geliyor; yine de tam kutuyu tazele
    setTimeout(() => { try { this._send('multiColorBox', 'getInfo', null); } catch { /* */ } }, 400);
    return { index: slot.index, type: t, color: rgb };
  }

  // ACE kurutma (multiColorBox/setDry; biçim anycubic_ha_local'de gerçek cihazda doğrulanmış)
  async _setAceDry({ on, temp = 45, minutes = 240 }) {
    const box = Array.isArray(this.raw.ace) && this.raw.ace[0];
    if (!box) throw new Error('ACE bulunamadı');
    const drying = on ? { status: 1, target_temp: clamp(temp, 35, 55), duration: clamp(minutes, 30, 24 * 60) } : { status: 0 };
    this._send('multiColorBox', 'setDry', { multi_color_box: [{ id: box.id || 0, drying_status: drying }] });
    setTimeout(() => { try { this._send('multiColorBox', 'getInfo', null); } catch { /* */ } }, 800);
    return drying;
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
    // yazıcı dosyayı başka bir adla sakladıysa (ör. 3MF'nin içinden çıkan plaka) o adı kullan
    const kept = body && body.data && body.data.gcode;
    return typeof kept === 'string' && /^[\w ().+-]+\.gcode$/i.test(kept) ? kept : name;
  }

  // Uygulamada dilimlenen G-code'u yükle ve isteğe bağlı olarak baskıyı başlat.
  // slot: ACE yuvası (0-3) ya da null/-1 = harici makara.
  async printFile(filePath, { start = true, slot = null, task = {} } = {}) {
    if (!this.state.connected) throw new Error('Yazıcıya bağlı değil');
    if (start && !['idle', 'finished'].includes(this.state.status)) throw new Error('Yazıcı şu an boşta değil, baskı başlatılamaz');
    const buf = await fs.promises.readFile(filePath);
    const stored = await this.upload(filePath);
    if (!start) return { name: stored, started: false };

    let ams = { use_ams: false, ams_box_mapping: [] };
    const box = Array.isArray(this.raw.ace) && this.raw.ace[0];
    if (slot !== null && slot >= 0) {
      const s = box && (box.slots || []).find((x) => x.index === slot);
      if (!s) throw new Error('Seçilen ACE yuvası bulunamadı');
      const rgba = [...(s.color || [255, 255, 255]).slice(0, 3), 255];
      ams = { use_ams: true, ams_box_mapping: [{ paint_index: 0, ams_index: slot, paint_color: rgba, ams_color: rgba, material_type: s.type || 'PLA' }] };
    }
    // Biçim anycubic_ha_local'in build_print_start'ıyla aynı. Görev numarası her başlatmada yeni.
    // Kalibrasyonlar varsayılan kapalı; kullanıcı seçerse ve yazıcı destekliyorsa açılır.
    const feat = this.state.features || {};
    const on = (want, supported) => (want && supported ? 1 : 0);
    const data = {
      taskid: String(100000000 + crypto.randomInt(900000000)),
      filename: stored,
      filepath: '/',
      filetype: 1,
      filesize: buf.length,
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      ams_settings: ams,
      task_settings: {
        auto_leveling: on(task.leveling, feat.autoLeveling),
        vibration_compensation: on(task.vibration, feat.vibration),
        flow_calibration: on(task.flow, feat.flow),
        timelapse: { status: 0 }, ai_settings: { status: 0 }, dry_mode: 0,
      },
    };
    // Başlatma tek sefer gönderilir: reddedilen bir başlatmayı tekrarlamak yazıcıdaki görev kaydını bozabiliyor.
    const answer = await this._sendAndWait('print', 'start', data, (m) => m.type === 'print' && m.action === 'start', 12000);
    if (answer) {
      if (answer.code === 200 && answer.state !== 'failed') return { name: stored, started: true };
      if (answer.code === 10101) throw new Error('Yazıcı meşgul: önceki görev hâlâ açık görünüyor. Dosya yüklendi ama baskı başlamadı.');
      throw new Error(`Baskı başlatılamadı: ${errorText(answer.code, answer.msg)} Dosya yazıcıya yüklendi.`);
    }
    // Cevap gelmediyse 20 sn boyunca görevin görünmesini bekle
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      try { this._send('info', 'query', null, 'web'); } catch { /* */ }
      if (['printing', 'busy', 'paused'].includes(this.state.status)) return { name: stored, started: true };
    }
    throw new Error('Yazıcı başlatma komutuna yanıt vermedi. Dosya yüklendi; baskıyı yazıcının ekranından başlatabilirsin.');
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
