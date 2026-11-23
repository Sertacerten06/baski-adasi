// Baskı Adası — tam panel
const { esc, fmtMin, fmtEta, fmtT, fmtSize, fmtDate, prettyFile, statusOf, heating, ICONS, ring } = window.U;
// `api` global'i preload'daki contextBridge'den gelir (yeniden tanımlanamaz)
const $ =(s, r = document) => r.querySelector(s);
const $view = $('#view');

document.body.classList.add(api.platform === 'darwin' ? 'mac' : 'win');
$('#addBtn').innerHTML = `${ICONS.plus}<span>Yazıcı ekle</span>`;
$('#setBtn').innerHTML = `${ICONS.gear}<span>Ayarlar</span>`;
$('#dropIcon').innerHTML = ICONS.upload;

let printers = [];
let config = { printers: [] };
let scanning = false;
let scanProgress = 0;
let lastScan = null;
let view = { type: 'printer', id: null };
let skeletonKey = null;
let jobKey = null;
let filKey = null;
let filesKey = null;
let uploading = false;
const RING = 172; // baskı halkasının çapı (px)
let aceEdit = null; // { index, type, color } — ACE yuvası düzenleyicisinin taslağı

const ACE_TYPES = ['PLA', 'PLA+', 'PLA Matte', 'PLA Silk', 'PLA High Speed', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS'];
const ACE_COLORS = ['#FFFFFF', '#161616', '#8E9089', '#C0C0C0', '#E3261F', '#FF6A14', '#FFEC3D', '#A3D82B', '#00AE42', '#009FA1',
  '#00B1F4', '#0B5FFF', '#1F3A93', '#8E44AD', '#F55A9E', '#EC008C', '#7B4A2A', '#E8D5B5', '#C9A54C', '#F5C9A5'];
function aceEditorHTML() {
  const e = aceEdit;
  const types = ACE_TYPES.includes(e.type) ? ACE_TYPES : [e.type, ...ACE_TYPES];
  return `<div class="ace-edit">
    <div class="ace-edit-h"><b>Yuva ${e.index + 1}</b><span class="muted-sm">ACE'deki makaranın bilgisini günceller</span></div>
    <label class="fl"><span>Filament türü</span><select class="input" id="aceType">${types.map((t) => `<option ${t === e.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
    <div class="fl"><span>Renk</span><div class="swatches">${ACE_COLORS.map((c) => `<button class="sw ${c.toLowerCase() === e.color.toLowerCase() ? 'on' : ''}" data-swatch="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <label class="sw custom" title="Özel renk"><input type="color" id="aceColor" value="${e.color}"></label></div></div>
    <div class="actions"><button class="btn primary" data-ace="save">Kaydet</button><button class="btn" data-ace="cancel">Vazgeç</button></div>
  </div>`;
}

// ---------- yardımcılar ----------
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(t._h); t._h = setTimeout(() => { t.className = ''; }, 2800);
}
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); return undefined; }
}
const cur = () => printers.find((p) => p.id === view.id);
const setK = (k, html, root = $view) => { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== String(html)) el.innerHTML = html; };

// ---------- kenar çubuğu ----------
function renderSidebar() {
  $('#plist').innerHTML = printers.map((p) => {
    const st = statusOf(p);
    let sub = st.text;
    if (p.job && ['printing', 'paused'].includes(p.status)) sub = `%${p.job.progress} · ${p.status === 'paused' ? 'Duraklatıldı' : fmtMin(p.job.remainingMin) + ' kaldı'}`;
    else if (p.status === 'idle' && heating(p)) sub = `Isınıyor · ${fmtT(p.temps.nozzle && p.temps.nozzle.cur)}`;
    const pulse = p.status === 'connecting' || (p.status === 'idle' && heating(p)) ? ' pulse' : '';
    const bar = p.job && ['printing', 'paused'].includes(p.status) ? `<div class="pbar"><div style="width:${p.job.progress}%;background:${st.color}"></div></div>` : '';
    return `<button class="pitem ${view.type === 'printer' && view.id === p.id ? 'sel' : ''}" data-id="${p.id}">
      <span class="pdot${pulse}" style="background:${st.color}"></span>
      <span class="pt"><div class="pn">${esc(p.name)}</div><div class="ps">${esc(sub)}</div>${bar}</span></button>`;
  }).join('') || `<div class="ps" style="padding:6px 10px;color:var(--muted);font-size:13px">${scanning ? '<span class="spin"></span> Aranıyor…' : 'Henüz yazıcı yok'}</div>`;
  $('#setBtn').classList.toggle('sel', view.type === 'settings');
  $('#newBtn').classList.toggle('sel', view.type === 'slice');
}
$('#plist').addEventListener('click', (e) => { const b = e.target.closest('.pitem'); if (b) go({ type: 'printer', id: b.dataset.id }); });
$('#addBtn').onclick = () => go({ type: 'settings', focusAdd: true });
$('#setBtn').onclick = () => go({ type: 'settings' });
$('#newBtn').innerHTML = `${ICONS.layers}<span>Yeni baskı</span>`;
$('#newBtn').onclick = () => go({ type: 'slice', from: view.type === 'printer' ? view.id : null });

function go(v) {
  if (view.type === 'slice' && v.type !== 'slice' && window.Viewer) window.Viewer.unmount();
  view = { ...v };
  if (view.type === 'printer' && !printers.find((p) => p.id === view.id)) view = printers[0] ? { type: 'printer', id: printers[0].id } : { type: 'settings' };
  skeletonKey = null; jobKey = null; filKey = null; filesKey = null; aceEdit = null;
  $('.content').scrollTop = 0;
  render();
  if (v.focusAdd) setTimeout(() => { const i = $('#addInput'); if (i) i.focus(); }, 50);
}

// ---------- yazıcı görünümü ----------
// Baskı öncesi kalibrasyon (yalnızca yazıcının desteklediği seçenekler; tercih yazıcı başına saklanır)
const CAL_OPTIONS = [
  ['leveling', 'autoLeveling', 'Tabla seviyeleme', 'Baskıdan önce tablayı otomatik ölçer'],
  ['vibration', 'vibration', 'Rezonans telafisi', 'Titreşim (input shaping) ölçümü yapar'],
  ['flow', 'flow', 'Akış kalibrasyonu', 'Ekstrüzyon akışını (pressure advance) ölçer'],
];
const calOf = (id) => ((config.printers || []).find((x) => x.id === id) || {}).calibration || {};
function calibrationHTML(p) {
  const f = p.features || {};
  const opts = CAL_OPTIONS.filter(([, feat]) => f[feat]);
  if (!p.caps.sendPrint || !opts.length) return '';
  return `<div class="ctl-row col cal">
    <div class="top"><span class="k">${ICONS.layers}Baskı öncesi kalibrasyon</span></div>
    ${opts.map(([key, , title, desc]) => `<div class="cal-row"><div><b>${title}</b><span>${desc}</span></div><button class="switch" data-cal="${key}"></button></div>`).join('')}
    <div class="tg-note">Uygulamadan başlatılan baskılarda uygulanır; baskı süresine birkaç dakika ekler.</div>
  </div>`;
}

function skeleton(p) {
  const hasFil = !!(p.filaments && p.filaments.length);
  return `<div class="wrap">
    <div class="ph">
      <div><h1 data-k="name"></h1><div class="ph-sub" data-k="sub"></div></div>
      <div class="ph-right"><span data-k="chip"></span>
        ${p.caps.sendPrint ? `<button class="btn" data-act="slice">${ICONS.layers}Model yazdır</button>` : ''}
        <button class="btn ghost icon" data-act="refresh" title="Yenile">${ICONS.refresh}</button></div>
    </div>
    <div class="grid">
      <div class="card s8" id="jobCard"></div>
      <div class="card s4">
        <div class="card-h">${ICONS.gear}<h2>Kontroller</h2></div>
        ${p.caps.light ? `<div class="ctl-row"><span class="k">${ICONS.bulb}Işık</span><button class="switch" data-act="light"></button></div>` : ''}
        ${p.caps.speedMode ? `<div class="ctl-row col"><div class="top"><span class="k">${ICONS.clock}Hız modu</span></div>
          <div class="seg full"><button data-speed="1">Sessiz</button><button data-speed="2">Standart</button><button data-speed="3">Spor</button></div></div>` : ''}
        ${p.caps.fan ? `<div class="ctl-row col"><div class="top"><span class="k">${ICONS.fan}Parça fanı</span><span class="v" data-k="fanv">—</span></div>
          <input type="range" min="0" max="100" step="5" id="fanRange"><div class="tg-note" data-k="jobOnlyNote"></div></div>` : ''}
        ${calibrationHTML(p)}
        <div class="ctl-row col" style="gap:2px">
          <div class="kv"><span>Bağlantı</span><b>${p.kind === 'anycubic' ? 'Anycubic LAN (MQTT)' : 'Klipper · Moonraker'}</b></div>
          <div class="kv"><span>Adres</span><b>${esc(p.host)}${p.kind === 'moonraker' && p.port && p.port !== 80 ? ':' + p.port : ''}</b></div>
          <div class="kv"><span>Firmware</span><b data-k="fw">—</b></div>
        </div>
      </div>
      <div class="card ${hasFil ? 's7' : 's12'}">
        <div class="card-h">${ICONS.nozzle}<h2>Sıcaklık</h2></div>
        <div class="temps">
          ${['nozzle', 'bed'].map((h) => `<div class="temp">
            <div class="k" style="color:var(--${h})">${ICONS[h]}<span style="color:var(--text-2)">${h === 'nozzle' ? 'Nozul' : 'Tabla'}</span></div>
            <div class="cur" data-k="${h}Cur">—</div><div class="tg" data-k="${h}Tg">—</div>
            <div class="heat"><div data-k-bar="${h}" style="width:0;background:var(--${h})"></div></div>
            <div class="set"><input class="input" type="number" min="0" max="${h === 'nozzle' ? 300 : 120}" placeholder="°C" id="${h}In"><button class="btn sm" data-settemp="${h}">Ayarla</button></div>
            ${h === 'bed' ? '<div class="tg-note" data-k="bedNote"></div>' : ''}
          </div>`).join('')}
        </div>
        <div class="presets">
          <button class="btn sm" data-pre="210,60">PLA · 210/60</button>
          <button class="btn sm" data-pre="240,80">PETG · 240/80</button>
          <button class="btn sm" data-pre="225,50">TPU · 225/50</button>
          <button class="btn sm danger" data-pre="0,0">Isıtmayı kapat</button>
        </div>
        <div class="chart-wrap">
          <div class="legend"><span><i style="background:var(--nozzle)"></i>Nozul</span><span><i style="background:var(--bed)"></i>Tabla</span><span style="margin-left:auto">son 20 dk</span></div>
          <canvas id="chart"></canvas>
        </div>
      </div>
      ${hasFil ? `<div class="card s5"><div class="card-h">${ICONS.drop}<h2>${p.kind === 'anycubic' ? 'ACE Pro' : 'Filament'}</h2></div><div id="filBody"></div></div>` : ''}
      <div class="card s12">
        <div class="card-h">${ICONS.file}<h2>Yazıcıdaki dosyalar</h2><div class="r"><span class="ps" style="color:var(--muted);font-size:12px" data-k="fcount"></span></div></div>
        ${p.caps.upload ? `<div class="drop" id="dropZone">${ICONS.upload}<span data-k="dropText">Dosyayı buraya sürükle ya da tıklayıp seç</span></div>` : ''}
        <ul class="files" id="fileList"></ul>
        <div class="note">${p.caps.startPrint ? 'Bir dosyanın yanındaki Yazdır düğmesiyle baskıyı buradan başlatabilirsin.' : 'Yükleme baskıyı başlatmaz. Dosya yazıcıya gider, baskıyı yazıcının ekranından başlatırsın.'}</div>
      </div>
    </div></div>`;
}

function jobHTML(p) {
  const st = statusOf(p);
  const j = p.job;
  if (j && ['printing', 'paused', 'busy'].includes(p.status)) {
    const paused = p.status === 'paused';
    return `<div class="job">
      <div class="job-ring"><div data-k="ring">${ring(j.progress, RING, 14, st.color)}</div>
        <div class="c"><div class="pct" data-k="pct">%${j.progress}</div><div class="lbl" data-k="lbl"></div></div></div>
      <div class="job-info">
        <div class="job-head"><div class="job-head-t">
          <div class="eyebrow" style="color:${st.color}" data-k="eyebrow">${esc(st.text)}</div>
          <div class="job-file" data-k="file" title="${esc(j.file)}">${esc(prettyFile(j.file) || 'Baskı')}</div></div>
          <span class="job-img" data-job-img="${esc(j.rawFile || j.file)}"></span></div>
        <div class="tiles">
          <div class="tile"><div class="k">${ICONS.layers}Katman</div><div class="v" data-k="layer">—</div></div>
          <div class="tile"><div class="k">${ICONS.clock}Geçen</div><div class="v" data-k="elapsed">—</div></div>
          <div class="tile"><div class="k">${ICONS.hourglass}Kalan</div><div class="v" data-k="remaining">—</div></div>
          <div class="tile"><div class="k">${ICONS.flag}Bitiş</div><div class="v" data-k="eta">—</div></div>
        </div>
        <div class="actions">
          ${paused ? `<button class="btn primary" data-act="resume">${ICONS.play}Devam et</button>` : `<button class="btn" data-act="pause" ${p.status === 'busy' ? 'disabled' : ''}>${ICONS.pause}Duraklat</button>`}
          <button class="btn danger" data-act="stop">${ICONS.stop}Baskıyı iptal et</button>
        </div>
      </div></div>`;
  }
  let ico = ICONS.check; let title = 'Hazır'; let text = 'Yazıcı boşta ve komut bekliyor.'; let color = 'var(--c-ok)';
  if (p.status === 'offline') {
    ico = ICONS.wifi; title = 'Çevrimdışı'; color = 'var(--c-off)';
    text = `${esc(p.error || 'Yazıcıya ulaşılamıyor')}. Yazıcı açık ve aynı ağda mı? ${p.kind === 'anycubic' ? 'Anycubic yazıcılarda LAN modunun açık olması gerekiyor. ' : ''}Bağlantı her birkaç saniyede bir yeniden deneniyor.`;
  } else if (p.status === 'connecting') {
    ico = ICONS.refresh; title = 'Bağlanıyor'; color = 'var(--c-busy)'; text = 'Yazıcıyla bağlantı kuruluyor…';
  } else if (p.status === 'error') {
    ico = ICONS.alert; title = 'Hata'; color = 'var(--c-err)'; text = esc(p.error || 'Yazıcı bir hata bildirdi.');
  } else if (p.status === 'finished') {
    ico = ICONS.check; title = 'Baskı bitti'; color = 'var(--c-ok)'; text = j ? esc(prettyFile(j.file)) : 'Baskı tamamlandı.';
  } else if (heating(p)) {
    ico = ICONS.nozzle; title = 'Isınıyor'; color = 'var(--nozzle)'; text = 'Isıtıcılar açık. Hedef sıcaklıklar aşağıdaki Sıcaklık kartında.';
  } else if (p.cancelled || p.statusText === 'İptal edildi') {
    text = 'Son baskı iptal edildi. Yazıcı yeni baskı için hazır.';
  } else if (p.caps.startPrint) {
    text = 'Yazıcı boşta. Aşağıdaki dosyalardan birini seçip baskı başlatabilirsin.';
  }
  return `<div class="idle-state"><div class="idle-ico" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)">${ico}</div>
    <div><h3>${title}</h3><p>${text}</p>
    ${p.lastFailure && ['idle', 'error'].includes(p.status) ? `<div class="fail-box">${ICONS.alert}<div><b>Son baskı başlatılamadı</b><span>${esc(p.lastFailure.text)}</span></div></div>` : ''}
    ${p.status !== 'offline' && p.status !== 'connecting' ? `<div class="idle-chips">
      ${p.temps.nozzle ? `<span class="chip"><i style="background:var(--nozzle)"></i>Nozul ${fmtT(p.temps.nozzle.cur)}</span>` : ''}
      ${p.temps.bed ? `<span class="chip"><i style="background:var(--bed)"></i>Tabla ${fmtT(p.temps.bed.cur)}</span>` : ''}
      ${p.temps.chamber ? `<span class="chip"><i style="background:var(--c-busy)"></i>Kabin ${fmtT(p.temps.chamber.cur)}</span>` : ''}
    </div>` : ''}</div></div>`;
}

function renderPrinter() {
  const p = cur();
  if (!p) return;
  const key = `${p.id}|${p.kind}|${JSON.stringify(p.caps)}|${JSON.stringify(p.features)}|${!!(p.filaments && p.filaments.length)}`;
  if (key !== skeletonKey) { $view.innerHTML = skeleton(p); skeletonKey = key; jobKey = null; filKey = null; filesKey = null; bindPrinterView(); }

  const st = statusOf(p);
  setK('name', esc(p.name));
  setK('sub', [p.model, p.host].filter(Boolean).map(esc).join(' · '));
  setK('chip', `<span class="chip"><i style="background:${st.color}"></i>${esc(st.text)}</span>`);
  setK('fw', esc(p.firmware || '—'));

  // baskı kartı
  const jk = `${p.status}|${p.statusText}|${!!p.job}|${p.error}|${heating(p)}|${p.cancelled}|${p.job ? p.job.file : ''}|${p.lastFailure ? p.lastFailure.at : ''}`;
  if (jk !== jobKey) { $('#jobCard').innerHTML = jobHTML(p); jobKey = jk; loadThumbs(p.id); }
  if (p.job && ['printing', 'paused', 'busy'].includes(p.status)) {
    const j = p.job;
    setK('pct', `%${j.progress}`);
    const ringEl = $view.querySelector('[data-k="ring"] circle:last-child');
    if (ringEl) { const C = 2 * Math.PI * ((RING - 14) / 2); ringEl.setAttribute('stroke-dashoffset', C * (1 - j.progress / 100)); }
    setK('lbl', p.status === 'paused' ? 'duraklatıldı' : j.remainingMin != null ? `${fmtMin(j.remainingMin, true)} kaldı` : '');
    setK('layer', j.totalLayers ? `${j.layer ?? '—'} / ${j.totalLayers}` : '—');
    setK('elapsed', fmtMin(j.elapsedMin));
    setK('remaining', fmtMin(j.remainingMin));
    setK('eta', fmtEta(j.remainingMin));
  }

  // sıcaklık
  for (const h of ['nozzle', 'bed']) {
    const t = p.temps[h];
    setK(`${h}Cur`, t ? fmtT(t.cur) : '—');
    setK(`${h}Tg`, t ? (t.target ? `Hedef ${t.target}°` : 'Kapalı') : '—');
    const bar = $view.querySelector(`[data-k-bar="${h}"]`);
    if (bar) bar.style.width = t && t.target ? `${Math.min(100, (t.cur / t.target) * 100)}%` : '0';
  }
  drawChart(p);

  // kontroller (Kobra'da fan ve hız modu yalnızca baskı sırasında değişiyor)
  const inJob = ['printing', 'paused', 'busy'].includes(p.status);
  const jobOnly = p.caps.fanIdle === false && !inJob;
  const sw = $view.querySelector('[data-act="light"]');
  if (sw) { sw.classList.toggle('on', !!p.light); sw.disabled = !p.connected || p.light === null; }
  $view.querySelectorAll('[data-speed]').forEach((b) => { b.classList.toggle('on', Number(b.dataset.speed) === p.speedMode); b.disabled = !p.connected || jobOnly; });
  const fr = $('#fanRange');
  if (fr) { if (document.activeElement !== fr) fr.value = p.fan ?? 0; fr.disabled = !p.connected || jobOnly; }
  setK('fanv', p.fan != null ? `%${p.fan}` : '—');
  setK('jobOnlyNote', jobOnly ? 'Fan ve hız modu baskı sırasında değiştirilebilir.' : '');
  $view.querySelectorAll('[data-settemp],[data-pre]').forEach((b) => { b.disabled = !p.connected; });
  const cal = calOf(p.id);
  $view.querySelectorAll('[data-cal]').forEach((b) => b.classList.toggle('on', !!cal[b.dataset.cal]));
  // Kobra boştayken tabla hedefini uzaktan kabul etmiyor
  const bedLocked = p.kind === 'anycubic' && !p.caps.idleBedTemp && !inJob;
  const bedIn = $('#bedIn'); const bedBtn = $view.querySelector('[data-settemp="bed"]');
  if (bedIn) { bedIn.disabled = bedLocked || !p.connected; bedIn.placeholder = bedLocked ? 'ekrandan' : '°C'; }
  if (bedBtn) bedBtn.disabled = bedLocked || !p.connected;
  setK('bedNote', bedLocked ? 'Yazıcı boştayken tabla ekranından ısıtılır; baskı sırasında buradan değişir.' : '');

  // filament (ACE)
  const fb = $('#filBody');
  if (fb) {
    // düzenleyicideki taslak (renk/tür) anahtara girmez: renk seçici açıkken kart yeniden çizilmesin
    const fk = JSON.stringify([p.filaments, p.filamentBox, aceEdit && aceEdit.index, p.caps.aceEdit, p.connected]);
    if (fk !== filKey) {
      filKey = fk;
      const box = p.filamentBox || {};
      const editable = p.caps.aceEdit && p.connected;
      fb.innerHTML = `<div class="fil-meta">
          ${box.temp != null ? `<span class="chip">İç sıcaklık ${box.temp}°</span>` : ''}
          ${box.humidity ? `<span class="chip">Nem %${box.humidity}</span>` : ''}
          <span class="chip">${box.drying ? `Kurutuyor ${box.drying.target}° · ${fmtMin(box.drying.remainingMin)} kaldı` : 'Kurutma kapalı'}</span>
        </div>
        <div class="spools">${(p.filaments || []).map((f) => `<button class="spool ${f.active ? 'act' : ''} ${aceEdit && aceEdit.index === f.index ? 'editing' : ''}" data-ace-slot="${f.index}" ${editable ? '' : 'disabled'} title="${editable ? 'Türünü ve rengini değiştir' : ''}">
          ${f.active ? '<span class="badge">KAFADA</span>' : ''}
          <div class="disc" style="background:${aceEdit && aceEdit.index === f.index ? aceEdit.color : f.color}"></div><div class="t">${esc(aceEdit && aceEdit.index === f.index ? aceEdit.type : f.type)}</div><div class="n">Yuva ${f.index + 1}</div></button>`).join('')}</div>
        ${aceEdit ? aceEditorHTML() : (editable ? '<div class="note">Bir makaraya tıklayıp filament türünü ve rengini değiştirebilirsin.</div>' : '')}
        ${editable && p.kind === 'anycubic' ? `<div class="dry-row">${box.drying
    ? `<span>${ICONS.drop}Kurutma sürüyor: ${box.drying.target}°, ${fmtMin(box.drying.remainingMin)} kaldı</span><button class="btn sm danger" data-dry="stop">Durdur</button>`
    : `<span>${ICONS.drop}Kurutma</span>
       <select class="input sm" id="dryTemp">${[40, 45, 50, 55].map((t) => `<option value="${t}" ${t === 45 ? 'selected' : ''}>${t}°C</option>`).join('')}</select>
       <select class="input sm" id="dryTime">${[2, 4, 6, 8, 12].map((h) => `<option value="${h * 60}" ${h === 4 ? 'selected' : ''}>${h} saat</option>`).join('')}</select>
       <button class="btn sm" data-dry="start">Başlat</button>`}</div>` : ''}`;
    }
  }

  // dosyalar
  const fl = $('#fileList');
  if (fl) {
    const busy = ['printing', 'paused', 'busy'].includes(p.status);
    const fk = JSON.stringify([(p.files || []).map((f) => f.name + f.date), busy, p.connected, p.caps.startPrint]);
    if (fk !== filesKey) {
      filesKey = fk;
      setK('fcount', p.files ? `${p.files.length} dosya` : '');
      if (!p.files) fl.innerHTML = `<li class="empty-list">${p.connected ? 'Liste bekleniyor…' : 'Yazıcıya bağlı değil'}</li>`;
      else if (!p.files.length) fl.innerHTML = '<li class="empty-list">Yazıcıda dosya yok</li>';
      else {
        fl.innerHTML = p.files.map((f) => {
          const ext = /\.3mf$/i.test(f.name) ? '3MF' : 'GCODE';
          return `<li data-file="${esc(f.name)}" title="Büyük önizleme için tıkla">
            <span class="fthumb" data-thumb="${esc(f.name)}">${ICONS.file}</span>
            <span class="finfo"><span class="nm">${esc(prettyFile(f.name))}</span>
              <span class="meta"><span class="ext">${ext}</span>${fmtSize(f.size)} · ${fmtDate(f.date)}</span></span>
            ${p.caps.startPrint ? `<button class="btn sm" data-print="${esc(f.name)}" ${busy || !p.connected ? 'disabled' : ''}>${ICONS.play}Yazdır</button>` : ''}</li>`;
        }).join('');
        loadThumbs(p.id);
      }
    }
  }
}

function bindPrinterView() {
  const id = () => view.id;
  $view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (b) {
      const act = b.dataset.act;
      // ACE yuvası düzenleme ve kurutma
      if (b.dataset.aceSlot !== undefined) {
        const f = (cur().filaments || []).find((x) => x.index === Number(b.dataset.aceSlot));
        if (f) { aceEdit = aceEdit && aceEdit.index === f.index ? null : { index: f.index, type: f.type || 'PLA', color: f.color }; filKey = null; renderPrinter(); }
        return;
      }
      if (b.dataset.swatch) {
        aceEdit.color = b.dataset.swatch;
        $view.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s === b));
        const disc = $view.querySelector('.spool.editing .disc'); if (disc) disc.style.background = aceEdit.color;
        return;
      }
      if (b.dataset.ace === 'cancel') { aceEdit = null; filKey = null; renderPrinter(); return; }
      if (b.dataset.ace === 'save') {
        const e = aceEdit; b.disabled = true;
        await run(() => api.cmd(id(), 'aceSlot', { index: e.index, type: e.type, color: e.color }), `Yuva ${e.index + 1} güncellendi`);
        aceEdit = null; filKey = null; renderPrinter();
        return;
      }
      if (b.dataset.dry === 'start') return run(() => api.cmd(id(), 'aceDry', { on: true, temp: Number($('#dryTemp').value), minutes: Number($('#dryTime').value) }), 'Kurutma başlatıldı');
      if (b.dataset.dry === 'stop') return run(() => api.cmd(id(), 'aceDry', { on: false }), 'Kurutma durduruldu');
      if (b.dataset.cal) {
        const next = { ...calOf(id()), [b.dataset.cal]: !b.classList.contains('on') };
        b.classList.toggle('on');
        const saved = await run(() => api.setCalibration(id(), next));
        if (saved) { const pc = (config.printers || []).find((x) => x.id === id()); if (pc) pc.calibration = saved; }
        return;
      }
      if (act === 'slice') return openSlice({ printerId: id() });
      if (act === 'refresh') return run(() => api.cmd(id(), 'refresh'), 'Yenilendi');
      if (act === 'pause') return run(() => api.cmd(id(), 'pause'), 'Duraklatma komutu gönderildi');
      if (act === 'resume') return run(() => api.cmd(id(), 'resume'), 'Devam komutu gönderildi');
      if (act === 'stop') { if (confirm('Baskı iptal edilsin mi? Bu geri alınamaz.')) run(() => api.cmd(id(), 'stop'), 'İptal komutu gönderildi'); return; }
      if (act === 'light') return run(() => api.cmd(id(), 'light', !b.classList.contains('on')));
      if (b.dataset.speed) return run(() => api.cmd(id(), 'speed', Number(b.dataset.speed)), `Hız modu: ${b.textContent}`);
      if (b.dataset.settemp) {
        const h = b.dataset.settemp; const inp = $(`#${h}In`);
        if (inp.value === '') return toast('Bir sıcaklık gir', true);
        const v = Number(inp.value); inp.value = '';
        return run(() => api.cmd(id(), 'setTemp', { heater: h, value: v }), `${h === 'nozzle' ? 'Nozul' : 'Tabla'} hedefi ${v}°`);
      }
      if (b.dataset.pre) {
        const [n, bed] = b.dataset.pre.split(',').map(Number);
        // yazıcı bir not döndürürse (ör. Kobra'da tabla boştayken uzaktan ısınmıyor) onu göster
        return run(async () => { const r = await api.cmd(id(), 'preheat', { nozzle: n, bed }); toast(r && r.note ? r.note : n ? `Ön ısıtma ${n}° / ${bed}°` : 'Isıtıcılar kapatıldı'); });
      }
      if (b.dataset.print) {
        const f = b.dataset.print;
        if (confirm(`"${prettyFile(f)}" yazdırılsın mı?\n\nTablanın boş olduğundan emin ol.`)) run(() => api.cmd(id(), 'startPrint', f), 'Baskı başlatılıyor');
        return;
      }
    }
    if (e.target.closest('#dropZone')) doUpload(null);
    const li = e.target.closest('#fileList li[data-file]');
    if (li && !b) openPreview(id(), li.dataset.file);
    const ji = e.target.closest('[data-job-img].has');
    if (ji) openPreview(id(), ji.dataset.jobImg);
  };
  $view.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('.temp .input')) e.target.parentElement.querySelector('button').click(); };
  $view.oninput = (e) => {
    if (!aceEdit) return;
    if (e.target.id === 'aceColor') { aceEdit.color = e.target.value; const disc = $view.querySelector('.spool.editing .disc'); if (disc) disc.style.background = aceEdit.color; }
    if (e.target.id === 'aceType') aceEdit.type = e.target.value;
  };
  const fr = $('#fanRange');
  if (fr) {
    fr.oninput = () => setK('fanv', `%${fr.value}`);
    fr.onchange = () => run(() => api.cmd(id(), 'fan', Number(fr.value)), `Fan %${fr.value}`);
  }
}

async function doUpload(file) {
  const p = cur();
  if (!p || uploading) return;
  if (!p.caps.upload) return toast('Bu yazıcıya dosya yüklenemiyor', true);
  if (!p.connected) return toast('Yazıcıya bağlı değil', true);
  uploading = true;
  const dz = $('#dropZone');
  const prev = dz && dz.innerHTML;
  if (dz) { dz.classList.add('busy'); dz.innerHTML = `<span class="spin"></span><span>${file ? esc(file.name) + ' yükleniyor…' : 'Dosya seçiliyor…'}</span>`; }
  try {
    const name = await api.upload(p.id, file);
    if (name) toast(`${name} yazıcıya yüklendi`);
  } catch (e) { toast(e.message, true); }
  uploading = false;
  if (dz) { dz.classList.remove('busy'); dz.innerHTML = prev; }
}

// ---------- dosya resimleri (eski baskılar) ----------
// Ana süreç resmi yazıcıdan bir kez alıp diske kaydeder; burada da oturum boyunca tutulur.
const thumbCache = new Map(); // `${yazıcı}|${dosya}` -> data URL | null (resim yok)
let thumbBusy = false;
function fillThumb(el, url) {
  if (url) el.innerHTML = `<img src="${url}" alt="">`;
  el.classList.toggle('none', url === null);
  el.classList.toggle('has', !!url);
}
async function loadThumbs(printerId) {
  for (const el of $view.querySelectorAll('[data-thumb],[data-job-img]')) {
    const key = `${printerId}|${el.dataset.thumb || el.dataset.jobImg}`;
    if (thumbCache.has(key)) fillThumb(el, thumbCache.get(key));
  }
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    // önce baskıdaki işin resmi, sonra listedekiler yukarıdan aşağı; yazıcıya sırayla sorulur
    for (;;) {
      if (view.type !== 'printer' || view.id !== printerId) break;
      const el = [...$view.querySelectorAll('[data-job-img]'), ...$view.querySelectorAll('[data-thumb]')]
        .find((x) => !thumbCache.has(`${printerId}|${x.dataset.thumb || x.dataset.jobImg}`));
      if (!el) break;
      const name = el.dataset.thumb || el.dataset.jobImg;
      let url = null;
      try { url = await api.fileThumb(printerId, name); } catch { url = null; }
      thumbCache.set(`${printerId}|${name}`, url);
      $view.querySelectorAll(`[data-thumb="${CSS.escape(name)}"],[data-job-img="${CSS.escape(name)}"]`).forEach((x) => fillThumb(x, url));
    }
  } finally { thumbBusy = false; }
}

function openPreview(printerId, name) {
  const p = printers.find((x) => x.id === printerId) || {};
  const f = (p.files || []).find((x) => x.name === name) || {};
  const url = thumbCache.get(`${printerId}|${name}`);
  const ov = document.createElement('div');
  ov.className = 'lightbox';
  ov.innerHTML = `<div class="lb-card">
    <div class="lb-img">${url ? `<img src="${url}" alt="">` : `<div class="lb-none">${ICONS.file}<span>Bu dosya için resim yok</span></div>`}</div>
    <div class="lb-info"><b>${esc(prettyFile(name))}</b><span>${esc(name)}</span>${f.date ? `<span>${fmtSize(f.size)} · ${fmtDate(f.date)}</span>` : ''}</div>
    <div class="actions"><button class="btn" data-lb-close>Kapat</button></div></div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-lb-close]')) ov.remove(); });
  document.body.appendChild(ov);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.lightbox').forEach((x) => x.remove()); });

// sürükle-bırak (pencerenin her yerine): model dosyası dilimlemeye, G-code yazıcıya
const MODEL_RE = /\.(stl|obj|3mf|step|stp|amf)$/i;
const isModelFile = (name) => MODEL_RE.test(name) && !/\.gcode\.3mf$/i.test(name);
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files') || view.type === 'settings') return;
  dragDepth++; const p = cur();
  $('#dropTarget').textContent = view.type === 'slice' ? 'Model dilimleme ekranına açılacak' : p ? `G-code ${p.name} yazıcısına yüklenir` : '';
  $('#dropOverlay').classList.add('show');
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.remove('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (!f || view.type === 'settings') return;
  if (isModelFile(f.name)) { openSlice({ printerId: view.type === 'printer' ? view.id : null, file: f }); return; }
  if (view.type === 'printer') doUpload(f);
  else toast('Dilimleme ekranına STL, 3MF, OBJ ya da STEP bırakabilirsin', true);
});

// sıcaklık grafiği
function drawChart(p) {
  const cv = $('#chart');
  if (!cv) return;
  const h = p.history || [];
  const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth; const H = cv.clientHeight;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line').trim(); const muted = css.getPropertyValue('--muted').trim();
  const vals = h.flatMap((r) => [r[1], r[2]]).filter((v) => v != null);
  const max = Math.max(60, ...vals) * 1.12;
  const padL = 34; const padT = 6; const padB = 6;
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  g.font = '11px system-ui'; g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1;
  for (const v of [0, Math.round(max / 2 / 10) * 10, Math.round(max / 10) * 10]) {
    if (v > max) continue;
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(W, y(v)); g.stroke(); g.fillText(`${v}°`, 0, y(v) + 4);
  }
  if (h.length < 2) return;
  const span = 20 * 60 * 1000; const t0 = Date.now() - span;
  const x = (t) => padL + Math.max(0, (t - t0) / span) * (W - padL);
  for (const [i, v] of [[2, '--bed'], [1, '--nozzle']]) {
    const col = css.getPropertyValue(v).trim();
    const pts = h.filter((r) => r[i] != null).map((r) => [x(r[0]), y(r[i])]);
    if (pts.length < 2) continue;
    const grad = g.createLinearGradient(0, padT, 0, H);
    grad.addColorStop(0, col + '40'); grad.addColorStop(1, col + '00');
    g.beginPath(); pts.forEach(([a, b], k) => (k ? g.lineTo(a, b) : g.moveTo(a, b)));
    g.lineTo(pts[pts.length - 1][0], H - padB); g.lineTo(pts[0][0], H - padB); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); pts.forEach(([a, b], k) => (k ? g.lineTo(a, b) : g.moveTo(a, b)));
    g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  }
}
window.addEventListener('resize', () => { const p = cur(); if (p && view.type === 'printer') drawChart(p); });

// ---------- ayarlar ----------
const KIND = { anycubic: 'Anycubic LAN', moonraker: 'Klipper' };
function renderSettings(force) {
  if (force || !$('#setRoot')) {
    skeletonKey = null;
    $view.onclick = null; $view.onkeydown = null;
    $view.innerHTML = `<div class="wrap" id="setRoot">
      <div class="set-h"><h1>Ayarlar</h1><p>Yazıcılar, dinamik ada ve bildirimler</p></div>
      <div class="stack">
        <div class="card">
          <div class="card-h">${ICONS.printer}<h2>Yazıcılar</h2>
            <div class="r"><button class="btn sm" id="scanBtn">${ICONS.search}Ağı tara</button></div></div>
          <div id="plistSet"></div>
          <div class="addrow"><input class="input" id="addInput" placeholder="IP adresi, ör. 192.168.0.50 ya da 192.168.0.50:7125">
            <button class="btn primary" id="addGo">${ICONS.plus}Ekle</button></div>
          <div class="msg" id="addMsg"></div>
          <div id="scanBox"></div>
        </div>
        <div class="card">
          <div class="card-h">${ICONS.gear}<h2>Genel</h2></div>
          ${[
            ['island', 'Dinamik ada', 'Ekranın üstünde küçük durum kapsülü. Üzerine gelince genişler.'],
            ['notifications', 'Bildirimler', 'Baskı bitince, durunca ya da hata verince sistem bildirimi göster.'],
            ['autoScan', 'Otomatik ağ taraması', 'Arka planda 30 dakikada bir ağda yeni yazıcı ara (ulaşılamayan yazıcı varsa 15 dakikada bir). IP\'si değişen yazıcıyı da bulur.'],
            ['openAtLogin', 'Bilgisayar açılınca başlat', 'Oturum açınca arka planda, sadece ada ve tepsi simgesiyle başlar.'],
          ].map(([k, t, d]) => `<div class="trow"><div class="tx"><b>${t}</b><span>${d}</span></div><button class="switch" data-toggle="${k}"></button></div>`).join('')}
          <div class="trow"><div class="tx"><b>Ada konumu</b><span>Ortadaki ada tarayıcı sekmelerinin üstüne denk geliyorsa köşeye al.</span></div>
            <div class="seg" id="posSeg"><button data-pos="left">Sol üst</button><button data-pos="center">Orta</button><button data-pos="right">Sağ üst</button></div></div>
        </div>
        <div class="card">
          <div class="card-h">${ICONS.wifi}<h2>Desteklenen yazıcılar</h2></div>
          <div class="help">
            <b>Anycubic Kobra 3 / S1 serisi:</b> Yazıcının ekranından LAN modunu açman yeterli. Uygulama yazıcıyı kendisi bulur.<br>
            <b>Artillery Sidewinder X4 / M1 ve diğer Klipper yazıcılar:</b> Yazıcıyı Wi-Fi'ye bağla. Moonraker üzerinden (port 7125 ya da 80) otomatik bulunur. Bulunmazsa IP adresini yukarıya yaz.<br>
            <b>Eski Marlin yazıcılar</b> (Sidewinder X1/X2/X3, Genius): Bu yazıcılarda Wi-Fi yok. Bağlamak için yanlarına OctoPrint ya da Klipper kurulu bir Raspberry Pi gerekiyor.
          </div>
          <div class="kv" style="margin-top:12px"><span>Sürüm</span><b id="verText">—</b></div>
        </div>
      </div></div>`;
    $('#verText').textContent = config.version || '—';
    $('#scanBtn').onclick = () => doScan();
    $('#addGo').onclick = () => doAdd();
    $('#addInput').onkeydown = (e) => { if (e.key === 'Enter') doAdd(); };
    $view.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => run(async () => { config = { ...config, ...(await api.setConfig({ [b.dataset.toggle]: !b.classList.contains('on') })) }; renderSettingsDynamic(); });
    });
    $view.querySelectorAll('[data-pos]').forEach((b) => {
      b.onclick = () => run(async () => { config = { ...config, ...(await api.setConfig({ islandPos: b.dataset.pos })) }; renderSettingsDynamic(); });
    });
    $('#plistSet').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const p = config.printers.find((x) => x.id === b.dataset.id);
      if (b.dataset.rm && p && confirm(`${p.name} listeden kaldırılsın mı?\nOtomatik taramada tekrar eklenmez; istersen IP ile yeniden ekleyebilirsin.`)) {
        await run(() => api.removePrinter(p.id), 'Yazıcı kaldırıldı');
      }
      if (b.dataset.mv) await run(() => api.movePrinter(b.dataset.id, Number(b.dataset.mv)));
    };
    $('#plistSet').onchange = (e) => {
      if (e.target.matches('[data-rename]')) run(() => api.renamePrinter(e.target.dataset.rename, e.target.value), 'İsim kaydedildi');
    };
  }
  renderSettingsDynamic();
}

function renderSettingsDynamic() {
  if (!$('#setRoot')) return;
  $view.querySelectorAll('[data-toggle]').forEach((b) => b.classList.toggle('on', !!config[b.dataset.toggle]));
  $view.querySelectorAll('[data-pos]').forEach((b) => b.classList.toggle('on', (config.islandPos || 'center') === b.dataset.pos));
  const pl = $('#plistSet');
  if (!pl.contains(document.activeElement)) {
    pl.innerHTML = config.printers.length ? config.printers.map((c, i) => {
      const s = printers.find((p) => p.id === c.id) || { status: 'connecting' };
      const st = statusOf(s);
      return `<div class="prow"><span class="pdot" style="background:${st.color}" title="${esc(st.text)}"></span>
        <input class="input" data-rename="${c.id}" value="${esc(c.name)}">
        <span class="tag">${KIND[c.kind] || c.kind}</span>
        <span class="info">${esc(c.host)}${c.kind === 'moonraker' ? ':' + (c.port || 7125) : ''} · ${esc(st.text)}${s.error && s.status === 'offline' ? ' · ' + esc(s.error) : ''}</span>
        <button class="btn ghost icon sm" data-id="${c.id}" data-mv="-1" ${i === 0 ? 'disabled' : ''} title="Yukarı">${ICONS.up}</button>
        <button class="btn ghost icon sm" data-id="${c.id}" data-mv="1" ${i === config.printers.length - 1 ? 'disabled' : ''} title="Aşağı">${ICONS.down}</button>
        <button class="btn ghost icon sm danger" data-id="${c.id}" data-rm="1" title="Kaldır">${ICONS.trash}</button></div>`;
    }).join('') : '<div class="empty-list">Henüz yazıcı yok. Ağı tarayabilir ya da IP adresini yazabilirsin.</div>';
  }
  const sb = $('#scanBtn');
  sb.disabled = scanning;
  sb.innerHTML = scanning ? `<span class="spin"></span>Taranıyor %${Math.round(scanProgress * 100)}` : `${ICONS.search}Ağı tara`;
  const box = $('#scanBox');
  if (scanning) {
    box.innerHTML = `<div class="msg">Ağdaki adresler yavaşça yoklanıyor (yaklaşık 1 dakika). Yazıcıları yormamak için tarama bilerek yavaş.</div>
      <div class="progress"><div style="width:${Math.round(scanProgress * 100)}%"></div></div>`;
  }
  else if (lastScan) {
    const r = lastScan.results || [];
    box.innerHTML = `<div class="msg">${r.length ? `Son tarama (${new Date(lastScan.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}): ${r.length} yazıcı bulundu` : 'Son taramada yazıcı bulunamadı. Yazıcı açık ve aynı Wi-Fi ağında mı?'}</div>
      ${r.length ? `<div class="found">${r.map((f) => `<div><span class="tag">${KIND[f.kind]}</span><b>${esc(f.name)}</b><span style="color:var(--muted)">${esc(f.host)}</span>
        <span style="margin-left:auto;color:var(--muted)">${f.added ? 'yeni eklendi' : f.ignored ? 'kaldırılmıştı' : 'listede'}</span></div>`).join('')}</div>` : ''}`;
  }
}

async function doScan() {
  await run(async () => {
    const r = await api.scan();
    const added = r.filter((x) => x.added).length;
    toast(added ? `${added} yeni yazıcı eklendi` : r.length ? 'Yeni yazıcı yok, bulunanlar zaten listede' : 'Yazıcı bulunamadı');
  });
}

async function doAdd() {
  const inp = $('#addInput'); const msg = $('#addMsg'); const btn = $('#addGo');
  const v = inp.value.trim();
  if (!v) { msg.className = 'msg err'; msg.textContent = 'Bir IP adresi yaz'; return; }
  btn.disabled = true; msg.className = 'msg'; msg.innerHTML = '<span class="spin"></span> Yazıcı aranıyor…';
  try {
    const p = await api.addPrinter(v);
    msg.className = 'msg ok'; msg.textContent = p.existed ? `${p.name} zaten listede` : `${p.name} eklendi (${KIND[p.kind]})`;
    inp.value = '';
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
  btn.disabled = false;
}

// ---------- genel ----------
function render() {
  renderSidebar();
  if (view.type === 'settings') renderSettings();
  else if (view.type === 'slice') renderSlice();
  else if (!cur()) {
    if (printers.length) { view = { type: 'printer', id: printers[0].id }; renderPrinter(); } else renderSettings();
  } else renderPrinter();
}

api.onState((s) => { if (window.__freeze) return; printers = s; render(); }); // __freeze: test görüntüsü alırken
api.onConfig((c) => { config = { ...config, ...c }; if (view.type === 'settings') renderSettingsDynamic(); });
api.onScan((s) => {
  scanning = s.scanning; scanProgress = s.progress || 0;
  if (s.lastScan !== undefined) lastScan = s.lastScan;
  renderSidebar();
  if (view.type === 'settings') renderSettingsDynamic();
});
api.onNavigate((nav) => {
  if (nav.view === 'slice') return openSlice({ printerId: nav.id || null });
  go(nav.view === 'settings' ? { type: 'settings' } : { type: 'printer', id: nav.id || view.id });
});
api.onEvent((e) => { if (e.type === 'finished') toast(`${e.name}: baskı bitti`); });

(async () => {
  try {
    const [s, c] = await Promise.all([api.getState(), api.getConfig()]);
    printers = s; config = c; scanning = c.scanning; lastScan = c.lastScan;
    view = printers[0] ? { type: 'printer', id: printers[0].id } : { type: 'settings' };
  } catch (e) { console.error(e); }
  render();
})();
// bitiş saati gibi zamana bağlı alanları tazele
setInterval(() => { if (view.type === 'printer') render(); }, 30000);
