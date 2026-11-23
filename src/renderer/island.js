// Dinamik ada: üstte küçük kapsül, üzerine gelince genişleyip yazıcı kartlarını gösterir.
const { esc, fmtMin, fmtEta, fmtT, prettyFile, statusOf, heating, ICONS, ring } = window.U;
const $island = document.getElementById('island');
const $compact = document.getElementById('compact');
const $full = document.getElementById('full');

let printers = [];
let scanning = false;
let scanProgress = 0;
let expanded = false;
let inside = false;
let flash = null;
let flashTimer = null;
let expandTimer = null;
let collapseTimer = null;

const ACTIVE = ['printing', 'paused', 'busy'];

// konum: sol üst / orta / sağ üst (ana süreç pencereyi taşır, burada kapsül hizalanır)
const setPos = (pos) => { document.body.classList.remove('pos-left', 'pos-center', 'pos-right'); document.body.classList.add(`pos-${pos || 'center'}`); };
setPos(new URLSearchParams(location.search).get('pos'));
window.api.onIslandPos(setPos);
const shortName = (n) => (n.length > 16 ? n.slice(0, 15) + '…' : n);

function compactHTML() {
  if (flash) {
    const ico = flash.type === 'finished' ? `<span class="flash-ico" style="color:var(--c-ok)">${ICONS.check}</span>`
      : flash.type === 'error' ? `<span class="flash-ico" style="color:var(--c-err)">${ICONS.alert}</span>`
        : flash.type === 'started' ? `<span class="flash-ico" style="color:var(--c-print)">${ICONS.play}</span>`
          : `<span class="flash-ico" style="color:var(--c-pause)">${ICONS.pause}</span>`;
    const txt = { finished: 'Baskı bitti', error: 'Hata', paused: 'Duraklatıldı', started: 'Baskı başladı' }[flash.type];
    return `${ico}<span class="c-name">${esc(shortName(flash.name))}</span><span class="c-muted">${txt}</span>`;
  }
  if (!printers.length) {
    return scanning ? `<span class="spin"></span><span class="c-muted">Yazıcı aranıyor %${Math.round(scanProgress * 100)}</span>`
      : `<span class="dot" style="background:var(--c-off)"></span><span class="c-muted">Yazıcı yok</span>`;
  }
  const active = printers.filter((p) => ACTIVE.includes(p.status) && p.job);
  if (active.length) {
    return active.slice(0, 3).map((p, i) => {
      const st = statusOf(p);
      const name = active.length === 1 ? `<span class="c-name">${esc(shortName(p.name))}</span>` : '';
      const tail = p.status === 'paused' ? 'Duraklatıldı' : p.status === 'busy' ? esc(st.text) : fmtMin(p.job.remainingMin, true);
      return `${i ? '<span class="sep"></span>' : ''}<span class="seg"><span class="mini">${ring(p.job.progress, 20, 3, st.color)}</span>${name}
        <span class="c-pct">%${p.job.progress}</span><span class="c-muted">${tail}</span></span>`;
    }).join('');
  }
  return printers.slice(0, 3).map((p, i) => {
    const st = statusOf(p);
    let tail = '';
    if (p.status === 'idle' && heating(p)) {
      const n = p.temps.nozzle;
      tail = `<span class="c-muted">${n && n.target ? `${fmtT(n.cur)}→${n.target}°` : 'Isınıyor'}</span>`;
    } else if (printers.length === 1) tail = `<span class="c-muted">${esc(st.text)}</span>`;
    const pulse = p.status === 'connecting' || (p.status === 'idle' && heating(p)) ? ' pulse' : '';
    return `${i ? '<span class="sep"></span>' : ''}<span class="seg"><span class="dot${pulse}" style="background:${st.color}"></span>
      <span class="c-name">${esc(shortName(p.name))}</span>${tail}</span>`;
  }).join('');
}

function cardHTML(p) {
  const st = statusOf(p);
  const job = p.job;
  const active = job && ['printing', 'paused', 'busy', 'finished'].includes(p.status);
  const n = p.temps && p.temps.nozzle; const b = p.temps && p.temps.bed;
  const inner = active ? `%${job.progress}` : p.status === 'offline' ? ICONS.wifi : p.status === 'error' ? ICONS.alert : ICONS.printer;
  const sub = active ? esc(prettyFile(job.file) || 'Baskı')
    : p.status === 'offline' ? esc(p.error || 'Yazıcıya ulaşılamıyor')
      : p.status === 'error' ? esc(p.error || 'Hata')
        : `${p.model ? esc(p.model) + ' · ' : ''}${esc(p.host)}`;

  const btns = [];
  if (p.connected && p.status === 'printing') btns.push(`<button class="ib" data-cmd="pause" data-id="${p.id}" title="Duraklat">${ICONS.pause}</button>`);
  if (p.connected && p.status === 'paused') btns.push(`<button class="ib accent" data-cmd="resume" data-id="${p.id}" title="Devam et">${ICONS.play}</button>`);
  if (p.connected && p.caps.light && p.light !== null) btns.push(`<button class="ib ${p.light ? 'on' : ''}" data-cmd="light" data-val="${p.light ? 0 : 1}" data-id="${p.id}" title="Işık">${ICONS.bulb}</button>`);
  btns.push(`<button class="ib" data-open="${p.id}" title="Panelde aç">${ICONS.expand}</button>`);

  const stats = [];
  if (active && p.status !== 'finished') {
    stats.push(`<span>${ICONS.hourglass}${fmtMin(job.remainingMin, true)} kaldı</span>`);
    stats.push(`<span>${ICONS.flag}${fmtEta(job.remainingMin)}</span>`);
    if (job.totalLayers) stats.push(`<span>${ICONS.layers}${job.layer ?? '—'}/${job.totalLayers}</span>`);
  }
  if (p.status !== 'offline' && (n || b)) {
    // hedefe ulaşmışsa tek değer, ısınıyorsa "180°→210°"
    const t = (x) => (!x ? '—' : x.target && Math.abs(x.cur - x.target) > 2 ? `${fmtT(x.cur)}<span style="opacity:.55">→${x.target}°</span>` : fmtT(x.cur));
    stats.push(`<span>${ICONS.nozzle}${t(n)}</span><span>${ICONS.bed}${t(b)}</span>`);
  }
  if (p.filaments && p.filaments.length && p.status !== 'offline') {
    stats.push(`<span class="fil">${p.filaments.map((f) => `<i class="${f.active ? 'act' : ''}" style="background:${f.color}" title="${esc(f.type)}"></i>`).join('')}</span>`);
  }

  return `<div class="pc">
    <div class="pc-top">
      <div class="ringwrap">${ring(active ? job.progress : p.status === 'idle' ? 0 : 100, 46, 4, st.color)}<div class="in" style="color:${active ? '#fff' : st.color}">${inner}</div></div>
      <div class="pc-main">
        <div class="pc-name">${esc(p.name)}<span class="chip" style="color:${st.color}">${esc(st.text)}</span></div>
        <div class="pc-sub">${sub}</div>
      </div>
      <div class="pc-actions">${btns.join('')}</div>
    </div>
    ${active && p.status !== 'finished' ? `<div class="bar"><div style="width:${job.progress}%;background:${st.color}"></div></div>` : ''}
    ${stats.length ? `<div class="stats">${stats.join('')}</div>` : ''}
  </div>`;
}

function fullHTML() {
  if (!printers.length) {
    return `<div class="empty"><b>${scanning ? 'Ağda yazıcı aranıyor…' : 'Henüz yazıcı yok'}</b>
      Yazıcın Wi-Fi'ye bağlıysa otomatik bulunur, istersen IP'sini de girebilirsin.
      <div class="row"><button class="pill-btn primary" data-nav="settings">${ICONS.plus} IP ile ekle</button></div></div>`;
  }
  return printers.map(cardHTML).join('') +
    `<div class="foot"><span class="brand">BASKI ADASI</span>
      <button class="pill-btn" data-nav="settings">${ICONS.gear} Ayarlar</button>
      <button class="pill-btn primary" data-nav="panel">${ICONS.expand} Paneli aç</button></div>`;
}

function layout() {
  if (expanded) {
    $island.style.width = '540px';
    $island.style.height = `${$full.offsetHeight}px`;
  } else {
    $island.style.width = `${Math.max(120, $compact.offsetWidth)}px`;
    $island.style.height = '38px';
  }
}

function render() {
  $compact.innerHTML = compactHTML();
  $full.innerHTML = fullHTML();
  $island.classList.toggle('expanded', expanded);
  $island.classList.remove('flash-ok', 'flash-err', 'flash-warn');
  if (flash) $island.classList.add(flash.type === 'finished' ? 'flash-ok' : flash.type === 'error' ? 'flash-err' : flash.type === 'started' ? 'flash-ok' : 'flash-warn');
  layout();
}

function setExpanded(v) {
  if (expanded === v) return;
  expanded = v;
  render();
}

// fare: pencere tıklamaları geçirir; imleç adanın üstündeyse tıklamaları yakala
function hit(x, y) {
  const r = $island.getBoundingClientRect();
  return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 2 && y <= r.bottom + 6;
}
function setInside(v) {
  if (inside === v) return;
  inside = v;
  window.api.islandMouse(v);
  clearTimeout(expandTimer); clearTimeout(collapseTimer);
  if (v) expandTimer = setTimeout(() => setExpanded(true), 140);
  else collapseTimer = setTimeout(() => setExpanded(false), 380);
}
document.addEventListener('mousemove', (e) => setInside(hit(e.clientX, e.clientY)));
document.addEventListener('mouseleave', () => setInside(false));
window.api.onIslandLeave(() => { inside = false; clearTimeout(expandTimer); collapseTimer = setTimeout(() => setExpanded(false), 200); });

$island.addEventListener('click', async (e) => {
  const el = e.target.closest('button');
  if (!el) { if (!expanded) setExpanded(true); return; }
  if (el.dataset.nav === 'panel') return window.api.openPanel();
  if (el.dataset.nav === 'settings') return window.api.openPanel({ view: 'settings' });
  if (el.dataset.open) return window.api.openPanel({ view: 'printer', id: el.dataset.open });
  if (el.dataset.cmd) {
    el.disabled = true;
    try {
      const val = el.dataset.val !== undefined ? el.dataset.val === '1' : undefined;
      await window.api.cmd(el.dataset.id, el.dataset.cmd, val);
    } catch (err) { console.warn(err); }
    setTimeout(() => { el.disabled = false; }, 1200);
  }
});

window.api.onState((s) => { if (window.__freeze) return; printers = s; render(); }); // __freeze: test görüntüsü alırken
window.api.onScan((s) => { scanning = s.scanning; scanProgress = s.progress || 0; if (!printers.length) render(); });
window.api.onEvent((ev) => {
  flash = ev; render();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; render(); }, ev.type === 'finished' ? 12000 : 7000);
});

(async () => {
  try { printers = await window.api.getState(); const c = await window.api.getConfig(); scanning = c.scanning; } catch { /* */ }
  render();
})();
