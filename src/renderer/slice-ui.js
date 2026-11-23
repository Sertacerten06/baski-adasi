// Yeni baskı görünümü: model seç → ayarla → dilimle → yazıcıya gönder.
// panel.js ile aynı global kapsamı paylaşır (go, toast, run, printers, config, view, $view, ICONS...).

const SL = {
  info: null,
  printerId: null,
  opts: null, optsFor: null, optsError: null, loadingOpts: false,
  catalog: null, pickMachine: false,
  model: null, loadingModel: false,
  sel: { process: null, filament: null, slot: null, bedType: 'High Temp Plate', infill: 15, support: false, brim: true, scale: 100 },
  result: null, stale: false, slicing: false, sending: false,
  aceKey: null,
};
const BED_TYPES = [['High Temp Plate', 'Pürüzsüz PEI'], ['Textured PEI Plate', 'Dokulu PEI'], ['Cool Plate', 'Soğuk plaka'], ['Engineering Plate', 'Mühendislik plakası']];
const sliceable = () => printers.filter((p) => p.caps && p.caps.sendPrint);
const slPrinter = () => printers.find((p) => p.id === SL.printerId);
const slCfg = () => (config.printers || []).find((p) => p.id === SL.printerId) || {};
const fmtSec = (s) => (s == null ? '—' : fmtMin(s / 60));

function viewerReady(cb) {
  if (window.Viewer) cb(window.Viewer);
  else window.addEventListener('viewer-ready', () => cb(window.Viewer), { once: true });
}

// --- giriş noktaları ---
function openSlice({ printerId, file } = {}) {
  if (printerId) SL.printerId = printerId;
  go({ type: 'slice' });
  if (file) loadModel(file);
}

function renderSlice() {
  if (!$('#sliceRoot')) buildSlice();
  updateSliceDynamic();
}

function buildSlice() {
  skeletonKey = null;
  $view.onclick = null; $view.onkeydown = null;
  $view.innerHTML = `<div class="wrap" id="sliceRoot">
    <div class="ph"><div><h1>Yeni baskı</h1><div class="ph-sub">Modeli seç, ayarlarını yap, dilimle ve yazıcıya gönder</div></div></div>
    <div id="slSlicer"></div>
    <div class="grid">
      <div class="card s7 viewer-card">
        <div class="card-h">${ICONS.layers}<h2>Model</h2><div class="r"><span class="ps muted-sm" id="slModelMeta"></span><button class="btn sm" id="slPick">${ICONS.file}Model seç</button></div></div>
        <div class="viewer" id="slViewer">
          <canvas id="slCanvas"></canvas>
          <button class="viewer-empty" id="slEmpty">${ICONS.upload}<b>Model dosyasını buraya sürükle ya da tıkla</b><span>STL · 3MF · OBJ · STEP</span></button>
          <div class="viewer-hint">Sürükle: döndür · Tekerlek: yakınlaştır · Çift tık: sıfırla</div>
        </div>
        <div class="sl-warn" id="slWarn"></div>
      </div>
      <div class="card s5">
        <div class="card-h">${ICONS.gear}<h2>Ayarlar</h2></div>
        <div id="slForm"></div>
      </div>
    </div></div>`;
  $('#slPick').onclick = () => loadModel(null);
  $('#slEmpty').onclick = () => loadModel(null);
  $('#slForm').addEventListener('change', onFormChange);
  $('#slForm').addEventListener('input', onFormInput);
  $('#slForm').addEventListener('click', onFormClick);
  viewerReady((V) => {
    const c = $('#slCanvas');
    if (!c) return;
    V.mount(c);
    if (SL.opts) V.setBed(SL.opts.bed);
    V.setScale(SL.sel.scale / 100);
    V.setColor(currentColor());
    if (SL.model && SL.model.positions) V.setModel(SL.model.positions);
  });
  if (!SL.info) api.slicerInfo().then((i) => { SL.info = i; renderSlicerBanner(); }).catch(() => {});
  else renderSlicerBanner();
  if (!SL.printerId || !slPrinter()) {
    const sel = view.from && printers.find((p) => p.id === view.from && p.caps.sendPrint);
    SL.printerId = (sel || sliceable()[0] || {}).id || null;
  }
  renderModelMeta();
  ensureOptions();
  renderForm();
}

function renderSlicerBanner() {
  const el = $('#slSlicer');
  if (!el) return;
  if (SL.info && !SL.info.available) {
    el.innerHTML = `<div class="card banner">${ICONS.alert}<div><b>Dilimleyici bulunamadı</b>
      <span>Dilimleme için bilgisayarında ücretsiz OrcaSlicer (ya da Anycubic Slicer Next) kurulu olmalı. Kurduktan sonra "Yeniden ara"ya bas.</span></div>
      <div class="r"><button class="btn sm" id="slOrca">${ICONS.upload}OrcaSlicer'ı indir</button><button class="btn sm" id="slRescan">${ICONS.refresh}Yeniden ara</button></div></div>`;
    $('#slOrca').onclick = () => api.openOrcaDownload();
    $('#slRescan').onclick = async () => { SL.info = await api.slicerRefresh(); SL.opts = null; SL.optsFor = null; renderSlicerBanner(); ensureOptions(); renderForm(); };
  } else el.innerHTML = '';
}

// --- profil seçenekleri ---
async function ensureOptions(force) {
  const p = slPrinter();
  if (!p) return;
  const key = `${p.id}|${slCfg().slicerMachine || ''}|${p.modelFull || ''}`;
  if (!force && (SL.optsFor === key || SL.loadingOpts)) return;
  SL.loadingOpts = true; SL.optsError = null;
  renderForm();
  try {
    const o = await api.slicerOptions(p.id);
    SL.opts = o && o.machine ? o : null;
    SL.pickMachine = !SL.opts;
    SL.optsFor = key;
    if (SL.opts) applyDefaults();
  } catch (e) { SL.opts = null; SL.optsError = e.message; SL.optsFor = key; }
  SL.loadingOpts = false;
  SL.result = null;
  if (window.Viewer && SL.opts) { window.Viewer.setBed(SL.opts.bed); window.Viewer.setColor(currentColor()); }
  renderModelMeta();
  renderForm();
}

function applyDefaults() {
  const o = SL.opts; const prefs = slCfg().slicePrefs || {};
  const has = (list, n) => n && list.some((x) => x.name === n);
  SL.sel.process = has(o.processes, prefs.process) ? prefs.process
    : has(o.processes, o.defaultProcess) ? o.defaultProcess
      : (o.processes.find((x) => /0\.20mm/.test(x.name)) || o.processes[0] || {}).name;
  SL.sel.bedType = prefs.bedType || 'High Temp Plate';
  SL.sel.infill = prefs.infill ?? 15;
  SL.sel.support = !!prefs.support;
  SL.sel.brim = prefs.brim ?? true;
  const p = slPrinter();
  const ace = p && p.filaments && p.filaments.length ? p.filaments : null;
  if (ace) {
    const active = ace.find((f) => f.active);
    const keep = prefs.slot != null && ace.some((f) => f.index === prefs.slot) ? prefs.slot : null;
    SL.sel.slot = keep ?? (active ? active.index : ace[0].index);
    SL.sel.filament = filamentForSlot();
  } else {
    SL.sel.slot = null;
    SL.sel.filament = has(o.filaments, prefs.filament) ? prefs.filament : has(o.filaments, o.defaultFilament) ? o.defaultFilament : (o.filaments[0] || {}).name;
  }
}

function filamentForSlot() {
  const p = slPrinter(); const o = SL.opts;
  if (!o) return null;
  const slot = p && p.filaments && p.filaments.find((f) => f.index === SL.sel.slot);
  const type = String((slot && slot.type) || 'PLA').toUpperCase();
  const fl = o.filaments;
  return (fl.find((f) => f.type.toUpperCase() === type && /^Anycubic /i.test(f.name) && f.name.includes('@'))
    || fl.find((f) => f.type.toUpperCase() === type)
    || fl.find((f) => f.name === o.defaultFilament) || fl[0] || {}).name || null;
}

function currentColor() {
  const p = slPrinter();
  const slot = p && p.filaments && p.filaments.find((f) => f.index === SL.sel.slot);
  return slot ? slot.color : '#ff8a1f';
}

// --- form ---
function renderForm() {
  const el = $('#slForm');
  if (!el) return;
  const list = sliceable();
  if (!list.length) {
    el.innerHTML = '<div class="empty-list">Baskı gönderilebilecek bir yazıcı yok. Önce Ayarlar\'dan bir yazıcı ekle.</div>';
    return;
  }
  const p = slPrinter();
  const o = SL.opts;
  const printerSel = `<label class="fl"><span>Yazıcı</span><select class="input" id="slPrinter">${list.map((x) => `<option value="${x.id}" ${x.id === SL.printerId ? 'selected' : ''}>${esc(x.name)} · ${esc(statusOf(x).text)}</option>`).join('')}</select></label>`;
  let body = '';
  if (SL.loadingOpts) body = '<div class="msg"><span class="spin"></span> Profiller yükleniyor…</div>';
  else if (SL.optsError) body = `<div class="msg err">${esc(SL.optsError)}</div>`;
  else if (!o || SL.pickMachine) body = machinePicker(!o);
  else {
    const ace = p && p.filaments && p.filaments.length ? p.filaments : null;
    body = `
      <div class="fl-machine"><span>${esc(o.machine)}${o.engine ? ` · ${esc(o.engine)}` : ''}</span><button class="link" data-act="pickMachine">Değiştir</button></div>
      <label class="fl"><span>Kalite</span><select class="input" id="slProcess">${o.processes.map((x) => `<option value="${esc(x.name)}" ${x.name === SL.sel.process ? 'selected' : ''}>${esc(x.name.replace(/\s*@.*$/, ''))}</option>`).join('')}</select></label>
      ${ace ? `<div class="fl"><span>Filament (ACE yuvası)</span><div class="slots-pick">${ace.map((f) => `<button class="slot-chip ${SL.sel.slot === f.index ? 'on' : ''}" data-slot="${f.index}" title="Yuva ${f.index + 1}"><i style="background:${f.color}"></i>${esc(f.type)}<small>${f.index + 1}</small></button>`).join('')}
        <button class="slot-chip ${SL.sel.slot === -1 ? 'on' : ''}" data-slot="-1" title="ACE yerine yazıcının arkasındaki makara"><i class="ext"></i>Harici</button></div></div>` : ''}
      <label class="fl"><span>Filament profili</span><select class="input" id="slFilament">${o.filaments.map((x) => `<option value="${esc(x.name)}" ${x.name === SL.sel.filament ? 'selected' : ''}>${esc(x.name.replace(/\s*@.*$/, ''))}${x.type ? ` (${esc(x.type)})` : ''}</option>`).join('')}</select></label>
      <label class="fl"><span>Tabla</span><select class="input" id="slBed">${BED_TYPES.map(([v, t]) => `<option value="${v}" ${v === SL.sel.bedType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="fl"><span>Dolgu <b id="slInfillV">%${SL.sel.infill}</b></span><input type="range" id="slInfill" min="0" max="100" step="5" value="${SL.sel.infill}"></div>
      <div class="fl-row"><span>Destek</span><button class="switch ${SL.sel.support ? 'on' : ''}" data-toggle-sl="support"></button></div>
      <div class="fl-row"><span>Kenar (brim)</span><button class="switch ${SL.sel.brim ? 'on' : ''}" data-toggle-sl="brim"></button></div>
      <label class="fl-row"><span>Ölçek</span><span class="scale-in"><input class="input" type="number" id="slScale" min="5" max="1000" step="5" value="${SL.sel.scale}"> %</span></label>
      ${calibrationFormHTML(p)}
      <button class="btn primary wide" id="slGo" ${!SL.model || SL.slicing ? 'disabled' : ''}>${SL.slicing ? '<span class="spin light"></span>Dilimleniyor…' : `${ICONS.layers}Dilimle`}</button>
      <div id="slResult"></div>`;
  }
  el.innerHTML = printerSel + body;
  renderResult();
}

// Baskı öncesi kalibrasyon: yazıcı görünümündeki ayarın aynısı (yazıcı başına saklanır)
function calibrationFormHTML(p) {
  const f = (p && p.features) || {};
  const opts = CAL_OPTIONS.filter(([, feat]) => f[feat]);
  if (!opts.length) return '';
  const cal = calOf(SL.printerId);
  return `<div class="fl cal-form"><span>Baskı öncesi kalibrasyon</span>
    ${opts.map(([key, , title, desc]) => `<div class="cal-row"><div><b>${title}</b><span>${desc}</span></div><button class="switch ${cal[key] ? 'on' : ''}" data-cal-sl="${key}"></button></div>`).join('')}
  </div>`;
}

function machinePicker(required) {
  if (!SL.catalog) {
    api.slicerCatalog().then((c) => { SL.catalog = c; renderForm(); }).catch((e) => { SL.optsError = e.message; renderForm(); });
    return `<div class="msg"><span class="spin"></span> Yazıcı modelleri yükleniyor…</div>`;
  }
  const cur = SL.opts && SL.opts.machine;
  return `<div class="fl"><span>${required ? 'Bu yazıcının modeli otomatik bulunamadı, listeden seç' : 'Dilimleyici yazıcı profili'}</span>
    <select class="input" id="slMachine"><option value="">— Yazıcı modeli seç —</option>
    ${SL.catalog.map((v) => `<optgroup label="${esc(v.vendor)}">${v.models.map((m) => m.presets.map((pr) => `<option value="${esc(pr.name)}" ${pr.name === cur ? 'selected' : ''}>${esc(m.model)}${m.presets.length > 1 ? ` · ${pr.nozzle} mm nozul` : ''}</option>`).join('')).join('')}</optgroup>`).join('')}
    </select></div>${!required ? '<button class="link" data-act="cancelMachine">Vazgeç</button>' : ''}`;
}

function markStale() { if (SL.result) { SL.stale = true; renderResult(); } }

function onFormChange(e) {
  const t = e.target;
  if (t.id === 'slPrinter') { SL.printerId = t.value; SL.result = null; ensureOptions(); if (window.Viewer) window.Viewer.setColor(currentColor()); return; }
  if (t.id === 'slMachine' && t.value) {
    run(async () => { await api.slicerSetMachine(SL.printerId, t.value); config = { ...config, ...(await api.getConfig()) }; SL.pickMachine = false; await ensureOptions(true); }, 'Yazıcı profili kaydedildi');
    return;
  }
  if (t.id === 'slProcess') SL.sel.process = t.value;
  if (t.id === 'slFilament') SL.sel.filament = t.value;
  if (t.id === 'slBed') SL.sel.bedType = t.value;
  if (t.id === 'slScale') {
    SL.sel.scale = Math.max(5, Math.min(1000, Number(t.value) || 100));
    t.value = SL.sel.scale;
    if (window.Viewer) window.Viewer.setScale(SL.sel.scale / 100);
    renderModelMeta();
  }
  markStale();
}

function onFormInput(e) {
  if (e.target.id === 'slInfill') { SL.sel.infill = Number(e.target.value); $('#slInfillV').textContent = `%${SL.sel.infill}`; markStale(); }
}

function onFormClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.slot !== undefined) {
    SL.sel.slot = Number(b.dataset.slot);
    if (SL.sel.slot >= 0) SL.sel.filament = filamentForSlot();
    if (window.Viewer) window.Viewer.setColor(currentColor());
    markStale(); renderForm();
    return;
  }
  if (b.dataset.toggleSl) { SL.sel[b.dataset.toggleSl] = !SL.sel[b.dataset.toggleSl]; b.classList.toggle('on'); markStale(); return; }
  if (b.dataset.calSl) {
    const next = { ...calOf(SL.printerId), [b.dataset.calSl]: !b.classList.contains('on') };
    b.classList.toggle('on');
    run(async () => { const saved = await api.setCalibration(SL.printerId, next); const pc = (config.printers || []).find((x) => x.id === SL.printerId); if (pc) pc.calibration = saved; renderResult(); });
    return;
  }
  if (b.dataset.act === 'pickMachine') { SL.pickMachine = true; renderForm(); return; }
  if (b.dataset.act === 'cancelMachine') { SL.pickMachine = false; renderForm(); return; }
  if (b.id === 'slGo') { doSlice(); return; }
  if (b.id === 'slSendStart') { doSend(true); return; }
  if (b.id === 'slSendOnly') { doSend(false); }
}

// --- model ---
async function loadModel(file) {
  if (SL.loadingModel) return;
  SL.loadingModel = true;
  const meta = $('#slModelMeta'); if (meta) meta.innerHTML = '<span class="spin"></span> Model okunuyor…';
  try {
    const m = await api.openModel(file);
    if (m) {
      SL.model = m; SL.result = null; SL.stale = false;
      viewerReady((V) => V.setModel(m.positions || null));
    }
  } catch (e) { toast(e.message, true); }
  SL.loadingModel = false;
  renderModelMeta();
  renderForm();
}

function renderModelMeta() {
  const meta = $('#slModelMeta'); const empty = $('#slEmpty'); const warn = $('#slWarn');
  if (!meta) return;
  const m = SL.model;
  if (empty) empty.style.display = m && m.positions ? 'none' : '';
  if (empty && m && !m.positions) empty.innerHTML = `${ICONS.file}<b>${esc(m.name)}</b><span>${m.previewError ? 'Önizleme gösterilemiyor' : 'Bu dosya türü için önizleme yok'}; yine de dilimlenebilir</span>`;
  if (!m) { meta.textContent = ''; if (warn) warn.innerHTML = ''; return; }
  const s = window.Viewer && window.Viewer.size();
  const dims = s ? `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm` : '';
  meta.innerHTML = `<b>${esc(m.name)}</b>${dims ? ` · ${dims}` : ''}`;
  const notes = [];
  if (m.plates > 1) notes.push(`Bu 3MF'te ${m.plates} tabla var; yalnızca ilk tabla dilimlenir.`);
  if (s && SL.opts && (s.x > SL.opts.bed.w || s.y > SL.opts.bed.h || s.z > SL.opts.bed.z)) notes.push(`Model tablaya sığmıyor (tabla ${SL.opts.bed.w} × ${SL.opts.bed.h} × ${SL.opts.bed.z} mm). Ölçeği küçült.`);
  if (warn) warn.innerHTML = notes.map((n) => `<div>${ICONS.alert}${esc(n)}</div>`).join('');
}

// --- dilimleme ---
async function doSlice() {
  const o = SL.opts;
  if (!SL.model || !o || SL.slicing) return;
  if (!SL.sel.process || !SL.sel.filament) return toast('Kalite ve filament seç', true);
  SL.slicing = true; renderForm();
  try {
    const thumbs = [];
    if (window.Viewer && window.Viewer.hasModel()) for (const [w, h] of o.thumbnails) { const png = window.Viewer.thumbnail(w, h); if (png) thumbs.push({ w, h, png }); }
    const overrides = {
      sparse_infill_density: `${SL.sel.infill}%`,
      enable_support: SL.sel.support ? '1' : '0',
      brim_type: SL.sel.brim ? 'auto_brim' : 'no_brim',
      curr_bed_type: SL.sel.bedType,
    };
    if (SL.sel.support) overrides.support_type = 'tree(auto)';
    const job = await api.slice({
      printerId: SL.printerId, modelPath: SL.model.path, machine: o.machine, process: SL.sel.process, filament: SL.sel.filament,
      overrides, scale: SL.sel.scale / 100, thumbnails: thumbs,
      filamentColor: SL.sel.slot !== null && SL.sel.slot >= 0 ? currentColor() : null,
      prefs: { process: SL.sel.process, filament: SL.sel.filament, slot: SL.sel.slot, bedType: SL.sel.bedType, infill: SL.sel.infill, support: SL.sel.support, brim: SL.sel.brim },
    });
    const big = window.Viewer && window.Viewer.hasModel() ? window.Viewer.thumbnail(360, 240) : null;
    SL.result = { ...job, preview: big, printerId: SL.printerId, slot: SL.sel.slot };
    SL.stale = false;
  } catch (e) { toast(e.message, true); }
  SL.slicing = false;
  renderForm();
}

function renderResult() {
  const el = $('#slResult');
  if (!el) return;
  const r = SL.result;
  if (!r) { el.innerHTML = ''; return; }
  const p = printers.find((x) => x.id === r.printerId);
  const st = r.stats || {};
  const canStart = p && p.connected && ['idle', 'finished'].includes(p.status);
  const slotText = r.slot === null || r.slot === undefined ? '' : r.slot === -1 ? 'Harici makara' : `ACE yuva ${r.slot + 1}`;
  const cal = calOf(r.printerId); const feats = (p && p.features) || {};
  const calText = CAL_OPTIONS.filter(([key, feat]) => cal[key] && feats[feat]).map(([, , title]) => title.toLowerCase()).join(', ');
  el.innerHTML = `<div class="sl-result ${SL.stale ? 'stale' : ''}">
    ${SL.stale ? `<div class="msg">${ICONS.alert} Ayarlar değişti. Göndermeden önce yeniden dilimle.</div>` : ''}
    <div class="sl-res-top">${r.preview ? `<img src="${r.preview}" alt="">` : ''}
      <div class="sl-stats">
        <div class="tile"><div class="k">${ICONS.clock}Süre</div><div class="v">${fmtSec(st.seconds)}</div></div>
        <div class="tile"><div class="k">${ICONS.drop}Filament</div><div class="v">${st.grams != null ? `${st.grams.toFixed(1)} g` : '—'}</div></div>
        <div class="tile"><div class="k">${ICONS.layers}Katman</div><div class="v">${st.layers ?? '—'}</div></div>
        <div class="tile"><div class="k">${ICONS.flag}Biter</div><div class="v">${st.seconds ? fmtEta(st.seconds / 60) : '—'}</div></div>
      </div></div>
    <div class="note">${esc(r.name)} · ${fmtSize(r.bytes)}${st.nozzleTemp ? ` · Nozul ${st.nozzleTemp}°` : ''}${st.bedTemp ? ` · Tabla ${st.bedTemp}°` : ''}${slotText ? ` · ${slotText}` : ''}${r.engine ? ` · ${esc(r.engine)}` : ''}</div>
    ${calText ? `<div class="note">${ICONS.layers} Başlamadan önce: ${esc(calText)}</div>` : ''}
    <div class="actions">
      <button class="btn primary" id="slSendStart" ${!canStart || SL.stale || SL.sending ? 'disabled' : ''}>${SL.sending ? '<span class="spin light"></span>Gönderiliyor…' : `${ICONS.play}Gönder ve başlat`}</button>
      <button class="btn" id="slSendOnly" ${!p || !p.connected || SL.stale || SL.sending ? 'disabled' : ''}>${ICONS.upload}Sadece yükle</button>
    </div>
    ${p && !canStart ? `<div class="note">${p.connected ? `${esc(p.name)} şu an boşta değil (${esc(statusOf(p).text)}); şimdilik sadece yükleyebilirsin.` : `${esc(p.name)} bağlı değil.`}</div>` : ''}
  </div>`;
}

async function doSend(start) {
  const r = SL.result;
  if (!r || SL.sending) return;
  const p = printers.find((x) => x.id === r.printerId);
  if (!p) return;
  if (start) {
    const slotText = r.slot === -1 ? 'harici makaradan' : r.slot != null ? `ACE yuva ${r.slot + 1}'den` : '';
    if (!confirm(`${p.name} yazıcısında baskı başlatılsın mı?\n\n• Tablanın boş ve temiz olduğundan emin ol.\n• Filament ${slotText || 'yazıcıdaki makaradan'} beslenecek.\n• Süre: ${fmtSec(r.stats && r.stats.seconds)}`)) return;
  }
  SL.sending = true; renderResult();
  try {
    const res = await api.sendPrint({ jobId: r.id, printerId: r.printerId, start, slot: r.slot, preview: r.preview || null });
    toast(res && res.started ? `${p.name}: baskı başladı` : `${res ? res.name : r.name} yazıcıya yüklendi`);
    SL.sending = false;
    if (res && res.started) { go({ type: 'printer', id: p.id }); return; }
  } catch (e) { toast(e.message, true); }
  SL.sending = false;
  renderResult();
}

// --- durum güncellemelerinde (her birkaç saniyede) yalnızca değişeni tazele ---
function updateSliceDynamic() {
  const sel = $('#slPrinter');
  if (sel && document.activeElement !== sel) {
    for (const opt of sel.options) { const x = printers.find((p) => p.id === opt.value); if (x) opt.textContent = `${x.name} · ${statusOf(x).text}`; }
  }
  const p = slPrinter();
  const aceKey = JSON.stringify(p && p.filaments);
  if (aceKey !== SL.aceKey) {
    const first = SL.aceKey === null;
    SL.aceKey = aceKey;
    if (!first && SL.opts && !SL.slicing) {
      if (SL.sel.slot === null && p && p.filaments) applyDefaults();
      if (window.Viewer) window.Viewer.setColor(currentColor());
      renderForm();
    }
  }
  if (p) ensureOptions();
  if (SL.result && !SL.sending) renderResult();
}
