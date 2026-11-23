// Baskı Adası — ana süreç: tepsi simgesi, dinamik ada penceresi, panel penceresi, yazıcı yöneticisi
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, nativeTheme, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PrinterManager } = require('./printers/manager');
const { discover, probeHost } = require('./printers/discovery');
const { SlicerService } = require('./slicer');

const IS_MAC = process.platform === 'darwin';
const ASSETS = path.join(__dirname, 'assets');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('tr.arpama.baskiadasi');

// ---------- ayarlar ----------
const DEFAULTS = { printers: [], ignored: [], island: true, islandPos: 'center', notifications: true, autoScan: true, openAtLogin: false };
const ISLAND_POS = { left: 'Sol üst', center: 'Orta', right: 'Sağ üst' };
let config = { ...DEFAULTS };
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { config = { ...DEFAULTS }; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}
const publicConfig = () => ({ island: config.island, islandPos: config.islandPos, notifications: config.notifications, autoScan: config.autoScan, openAtLogin: config.openAtLogin, printers: config.printers });

// ---------- yazıcılar ----------
const manager = new PrinterManager();
let scanning = false;
let lastScan = null;
let lastScanStarted = 0;

function addPrinterFromProbe(f) {
  const exists = config.printers.find((p) => (f.uid && p.uid === f.uid) || (p.host === f.host && p.kind === f.kind));
  if (exists) {
    // DHCP ile IP değişmişse güncelle
    if (exists.host !== f.host || exists.port !== f.port) { exists.host = f.host; exists.port = f.port; return { printer: exists, changed: true }; }
    return { printer: exists, changed: false };
  }
  const p = { id: 'p_' + crypto.randomBytes(4).toString('hex'), kind: f.kind, host: f.host, port: f.port, name: f.name, uid: f.uid || null };
  config.printers.push(p);
  return { printer: p, changed: true, added: true };
}

async function runScan({ auto = false } = {}) {
  if (scanning) return { ok: false, error: 'Tarama zaten sürüyor' };
  scanning = true; broadcast('scan', { scanning: true, progress: 0 });
  lastScanStarted = Date.now();
  try {
    const found = await discover({
      known: config.printers.map((p) => p.host),
      onProgress: (progress) => broadcast('scan', { scanning: true, progress }),
    });
    let changed = false; const results = [];
    for (const f of found) {
      const ignored = config.ignored.includes(f.uid || `${f.kind}:${f.host}`);
      if (ignored && auto) { results.push({ ...f, ignored: true }); continue; }
      if (ignored) config.ignored = config.ignored.filter((x) => x !== (f.uid || `${f.kind}:${f.host}`));
      const r = addPrinterFromProbe(f);
      if (r.changed) changed = true;
      results.push({ ...f, added: !!r.added, id: r.printer.id });
    }
    if (changed) { saveConfig(); manager.sync(config.printers); }
    lastScan = { at: Date.now(), results };
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    scanning = false; broadcast('scan', { scanning: false, lastScan }); broadcast('config', publicConfig());
  }
}

// ---------- pencereler ----------
let island = null;
let panel = null;
let tray = null;
const ISLAND_W = 620; const ISLAND_H = 520;

function islandBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const x = config.islandPos === 'left' ? wa.x + 4
    : config.islandPos === 'right' ? wa.x + wa.width - ISLAND_W - 4
      : Math.round(wa.x + (wa.width - ISLAND_W) / 2);
  return { x, y: wa.y + (IS_MAC ? 4 : 8), width: ISLAND_W, height: ISLAND_H };
}

function setIslandPos(pos) {
  if (!ISLAND_POS[pos]) return;
  config.islandPos = pos; saveConfig();
  repositionIsland();
  if (island) island.webContents.send('island:pos', pos);
  updateTrayMenu(); broadcast('config', publicConfig());
}

function createIsland() {
  island = new BrowserWindow({
    ...islandBounds(),
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true,
    backgroundColor: '#00000000', focusable: true, roundedCorners: false,
    ...(IS_MAC ? { type: 'panel' } : {}), // macOS: uygulamayı öne almayan, tam ekranın üstünde de duran pencere
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  island.setIgnoreMouseEvents(true, { forward: true });
  island.loadFile(path.join(__dirname, 'renderer', 'island.html'), { query: { pos: config.islandPos } });
  island.once('ready-to-show', () => { if (config.island) island.showInactive(); });
  island.on('closed', () => { island = null; });
}

function repositionIsland() { if (island) island.setBounds(islandBounds()); }

function setIslandVisible(v) {
  config.island = v; saveConfig();
  if (!island) createIsland();
  else if (v) island.showInactive(); else island.hide();
  updateTrayMenu(); broadcast('config', publicConfig());
}

function titleBarColors() {
  return nativeTheme.shouldUseDarkColors ? { color: '#0c0e13', symbolColor: '#e8eaef', height: 40 } : { color: '#f3f4f7', symbolColor: '#1b1e25', height: 40 };
}

function openPanel(nav) {
  if (IS_MAC && app.dock) app.dock.show(); // panel açıkken Dock'ta ve Cmd+Tab'de görünsün
  if (panel) {
    if (panel.isMinimized()) panel.restore();
    panel.show(); panel.focus();
    if (nav) panel.webContents.send('navigate', nav);
    return;
  }
  panel = new BrowserWindow({
    width: 1220, height: 820, minWidth: 940, minHeight: 640, show: false,
    title: 'Baskı Adası',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e13' : '#f3f4f7',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panel.removeMenu();
  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { query: { platform: process.platform } });
  panel.once('ready-to-show', () => { panel.show(); if (nav) panel.webContents.send('navigate', nav); });
  panel.on('closed', () => { panel = null; if (IS_MAC && app.dock) app.dock.hide(); });
}

nativeTheme.on('updated', () => { if (panel && !IS_MAC) panel.setTitleBarOverlay(titleBarColors()); });

function broadcast(channel, payload) {
  for (const w of [island, panel]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

let stateTimer = null;
manager.on('change', () => {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcast('state', manager.snapshot()); updateTrayTooltip(); }, 150);
});

const EVENT_TEXT = {
  finished: (e) => ({ title: `${e.name}: baskı bitti`, body: e.file || 'Baskı tamamlandı' }),
  error: (e) => ({ title: `${e.name}: hata`, body: e.message || 'Baskı durdu' }),
  paused: (e) => ({ title: `${e.name}: duraklatıldı`, body: e.file || '' }),
  started: (e) => ({ title: `${e.name}: baskı başladı`, body: e.file || '' }),
};
manager.on('event', (e) => {
  broadcast('event', e);
  if (config.notifications && e.type !== 'started' && Notification.isSupported()) {
    const n = new Notification({ ...EVENT_TEXT[e.type](e), icon: path.join(ASSETS, 'icon.png'), silent: false });
    n.on('click', () => openPanel({ view: 'printer', id: e.id }));
    n.show();
  }
});

// ---------- tepsi ----------
function trayImage() {
  if (IS_MAC) { const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png')); img.setTemplateImage(true); return img; }
  return nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
}

function loginItemPath() { return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; }

function setOpenAtLogin(v) {
  config.openAtLogin = v; saveConfig();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: v, path: loginItemPath(), args: ['--gizli'] });
  updateTrayMenu(); broadcast('config', publicConfig());
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Paneli aç', click: () => openPanel() },
    { label: 'Adayı göster', type: 'checkbox', checked: config.island, click: (i) => setIslandVisible(i.checked) },
    { label: 'Ada konumu', submenu: Object.entries(ISLAND_POS).map(([k, label]) => ({ label, type: 'radio', checked: config.islandPos === k, click: () => setIslandPos(k) })) },
    { label: 'Ağda yazıcı ara', click: () => runScan() },
    { type: 'separator' },
    { label: 'Bildirimler', type: 'checkbox', checked: config.notifications, click: (i) => { config.notifications = i.checked; saveConfig(); broadcast('config', publicConfig()); } },
    { label: 'Bilgisayar açılınca başlat', type: 'checkbox', checked: config.openAtLogin, click: (i) => setOpenAtLogin(i.checked) },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function updateTrayTooltip() {
  if (!tray) return;
  const s = manager.snapshot();
  const lines = s.map((p) => (p.job && p.status === 'printing' ? `${p.name}: %${p.job.progress}` : `${p.name}: ${p.status === 'offline' ? 'çevrimdışı' : p.status === 'idle' ? 'hazır' : p.status}`));
  tray.setToolTip(['Baskı Adası', ...lines].join('\n'));
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Baskı Adası');
  tray.on('click', () => { if (!IS_MAC) openPanel(); });
  updateTrayMenu();
}

// ---------- IPC ----------
const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
};

ipcMain.handle('state:get', wrap(() => manager.snapshot()));
ipcMain.handle('config:get', wrap(() => ({ ...publicConfig(), scanning, lastScan, platform: process.platform, version: app.getVersion() })));
ipcMain.handle('config:set', wrap((patch) => {
  if ('island' in patch) setIslandVisible(!!patch.island);
  if ('islandPos' in patch) setIslandPos(patch.islandPos);
  if ('notifications' in patch) config.notifications = !!patch.notifications;
  if ('autoScan' in patch) config.autoScan = !!patch.autoScan;
  if ('openAtLogin' in patch) setOpenAtLogin(!!patch.openAtLogin);
  saveConfig(); updateTrayMenu(); broadcast('config', publicConfig());
  return publicConfig();
}));
ipcMain.handle('printer:add', wrap(async (input) => {
  const f = await probeHost(input);
  config.ignored = config.ignored.filter((x) => x !== (f.uid || `${f.kind}:${f.host}`));
  const r = addPrinterFromProbe(f);
  saveConfig(); manager.sync(config.printers); broadcast('config', publicConfig());
  return { ...r.printer, existed: !r.added };
}));
ipcMain.handle('printer:remove', wrap((id) => {
  const p = config.printers.find((x) => x.id === id);
  if (!p) throw new Error('Yazıcı bulunamadı');
  config.printers = config.printers.filter((x) => x.id !== id);
  config.ignored = [...new Set([...config.ignored, p.uid || `${p.kind}:${p.host}`])]; // otomatik taramada geri eklenmesin
  saveConfig(); manager.sync(config.printers); broadcast('config', publicConfig());
}));
ipcMain.handle('printer:rename', wrap((id, name) => {
  const p = config.printers.find((x) => x.id === id);
  if (!p) throw new Error('Yazıcı bulunamadı');
  p.name = String(name || '').trim().slice(0, 40) || p.name;
  saveConfig(); manager.sync(config.printers); broadcast('config', publicConfig());
}));
ipcMain.handle('printer:move', wrap((id, dir) => {
  const i = config.printers.findIndex((x) => x.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= config.printers.length) return;
  [config.printers[i], config.printers[j]] = [config.printers[j], config.printers[i]];
  saveConfig(); manager.sync(config.printers); broadcast('config', publicConfig());
}));
ipcMain.handle('scan', wrap(async () => {
  const r = await runScan();
  if (!r.ok) throw new Error(r.error);
  return r.results;
}));
ipcMain.handle('cmd', wrap((id, cmd, value) => manager.get(id).command(cmd, value)));
ipcMain.handle('upload', wrap(async (id, filePath) => {
  const d = manager.get(id);
  let p = filePath;
  if (!p) {
    const r = await dialog.showOpenDialog(panel || undefined, {
      title: `${d.state.name} yazıcısına dosya yükle`,
      filters: d.state.kind === 'anycubic' ? [{ name: 'G-code / 3MF', extensions: ['gcode', '3mf'] }] : [{ name: 'G-code', extensions: ['gcode', 'gco', 'g'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    p = r.filePaths[0];
  }
  return d.upload(p);
}));
ipcMain.on('panel:open', (_e, nav) => openPanel(nav));

// ---------- dilimleme ve baskı gönderme ----------
let slicerSvc = null;
const slicer = () => slicerSvc || (slicerSvc = new SlicerService({
  workRoot: path.join(app.getPath('temp'), 'baski-adasi-dilim'),
  getCustomExe: () => config.slicerExe || null,
}));
const printerCfg = (id) => config.printers.find((p) => p.id === id);

ipcMain.handle('slicer:info', wrap(() => slicer().info()));
ipcMain.handle('slicer:refresh', wrap(() => slicer().refresh()));
ipcMain.handle('slicer:catalog', wrap(() => slicer().catalog()));
ipcMain.handle('slicer:options', wrap((printerId) => {
  const svc = slicer();
  const machine = svc.machineFor(manager.get(printerId).state, printerCfg(printerId));
  return machine ? svc.options(machine) : { machine: null };
}));
ipcMain.handle('slicer:setMachine', wrap((printerId, machine) => {
  const p = printerCfg(printerId);
  if (!p) throw new Error('Yazıcı bulunamadı');
  if (machine) p.slicerMachine = String(machine); else delete p.slicerMachine;
  saveConfig(); broadcast('config', publicConfig());
  return true;
}));
ipcMain.handle('model:open', wrap(async (filePath) => {
  let p = filePath;
  if (!p) {
    const r = await dialog.showOpenDialog(panel || undefined, {
      title: 'Yazdırılacak model',
      filters: [{ name: '3B model', extensions: ['stl', '3mf', 'obj', 'step', 'stp', 'amf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    p = r.filePaths[0];
  }
  return slicer().loadModel(p);
}));
ipcMain.handle('slice:run', wrap(async (req) => {
  const job = await slicer().slice(req);
  // son seçimleri yazıcı başına hatırla
  const p = req.printerId && printerCfg(req.printerId);
  if (p && req.prefs) { p.slicePrefs = req.prefs; saveConfig(); }
  return job;
}));
ipcMain.handle('print:send', wrap(async ({ jobId, printerId, start, slot, preview }) => {
  const job = slicer().job(jobId);
  const task = (printerCfg(printerId) || {}).calibration || {};
  const d = manager.get(printerId);
  const res = await d.printFile(job.path, { start: !!start, slot: slot === undefined ? null : slot, task });
  // Yazıcı düz G-code'larda resim vermiyor: dilimleme önizlemesini bu dosya adıyla sakla
  const m = /^data:image\/png;base64,(.+)$/.exec(preview || '');
  if (m && res && res.name) { try { saveThumb(d.state, res.name, Buffer.from(m[1], 'base64')); } catch { /* önbellek yazılamazsa sorun değil */ } }
  return res;
}));

// ---------- dosya resimleri (eski baskılar) ----------
// Yazıcıdan bir kez alınır, kullanıcı klasöründe saklanır. Yazıcıya aynı anda tek istek gider.
const thumbDir = () => path.join(app.getPath('userData'), 'resimler');
const thumbBase = (st, name) => path.join(thumbDir(), crypto.createHash('sha1').update(`${st.uid || st.host}|${name}`).digest('hex'));
function saveThumb(st, name, buf) {
  fs.mkdirSync(thumbDir(), { recursive: true });
  fs.writeFileSync(`${thumbBase(st, name)}.png`, buf);
  fs.rmSync(`${thumbBase(st, name)}.yok`, { force: true });
}
const thumbQueue = new Map(); // yazıcı -> sıradaki istek zinciri
ipcMain.handle('files:thumb', wrap(async (printerId, name) => {
  const d = manager.get(printerId);
  const st = d.state;
  const base = thumbBase(st, name);
  if (fs.existsSync(`${base}.png`)) return `data:image/png;base64,${fs.readFileSync(`${base}.png`).toString('base64')}`;
  if (fs.existsSync(`${base}.yok`) && Date.now() - fs.statSync(`${base}.yok`).mtimeMs < 86400000) return null;
  if (!st.connected) return null;
  const file = (st.files || []).find((f) => f.name === name) || {};
  const prev = thumbQueue.get(printerId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const imgs = await d.fileImages(name, file.plate);
    await new Promise((r) => setTimeout(r, 300)); // yazıcıya nefes aldır
    return imgs;
  });
  thumbQueue.set(printerId, next);
  let imgs = null;
  try { imgs = await next; } catch { return null; }
  const best = imgs && (imgs.top || imgs.thumb);
  fs.mkdirSync(thumbDir(), { recursive: true });
  if (!best) { fs.writeFileSync(`${base}.yok`, ''); return null; }
  fs.writeFileSync(`${base}.png`, best);
  return `data:image/png;base64,${best.toString('base64')}`;
}));
// Baskı öncesi kalibrasyon tercihleri (yazıcı başına): tabla seviyeleme, rezonans telafisi, akış kalibrasyonu
ipcMain.handle('printer:setCalibration', wrap((printerId, cal) => {
  const p = printerCfg(printerId);
  if (!p) throw new Error('Yazıcı bulunamadı');
  p.calibration = { leveling: !!(cal && cal.leveling), vibration: !!(cal && cal.vibration), flow: !!(cal && cal.flow) };
  saveConfig(); broadcast('config', publicConfig());
  return p.calibration;
}));
ipcMain.on('open:orca', () => shell.openExternal('https://github.com/SoftFever/OrcaSlicer/releases/latest'));
ipcMain.on('island:mouse', (_e, inside) => {
  if (!island) return;
  island.setIgnoreMouseEvents(!inside, { forward: true });
  islandInside = !!inside;
});

// Fare pencereden hızla çıkarsa renderer haberdar olmayabilir: içerideyken imleci izle
let islandInside = false;
setInterval(() => {
  if (!island || !islandInside || !island.isVisible()) return;
  const c = screen.getCursorScreenPoint(); const b = island.getBounds();
  if (c.x < b.x || c.x > b.x + b.width || c.y < b.y || c.y > b.y + b.height) {
    islandInside = false; island.setIgnoreMouseEvents(true, { forward: true });
    island.webContents.send('island:leave');
  }
}, 250);

// ---------- yaşam döngüsü ----------
app.on('second-instance', () => openPanel());
app.on('window-all-closed', () => { /* tepside çalışmaya devam */ });
app.on('before-quit', () => { app.isQuitting = true; manager.stopAll(); });
app.on('activate', () => openPanel()); // macOS: Dock/Launchpad'den yeniden açılınca

app.whenReady().then(() => {
  loadConfig();
  if (IS_MAC && app.dock) app.dock.hide();
  // macOS'ta kopyala/yapıştır kısayolları uygulama menüsü olmadan çalışmaz
  if (IS_MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  else Menu.setApplicationMenu(null);
  createTray();
  createIsland();
  manager.sync(config.printers);
  screen.on('display-metrics-changed', repositionIsland);
  screen.on('display-added', repositionIsland);
  screen.on('display-removed', repositionIsland);

  const hidden = process.argv.includes('--gizli') || (app.getLoginItemSettings().wasOpenedAtLogin);
  if (process.env.BADASI_SNAP) {
    require('./main-manager-ref').manager = manager;
    require('./debug-snap')({ dir: process.env.BADASI_SNAP, getIsland: () => island, getPanel: () => panel, openPanel, app });
  } else if (!hidden) openPanel();

  // Ağ taraması seyrek tutulur (ARP seli bazı yazıcıların Wi-Fi'sini kısa süre tıkayabiliyor):
  //  - hiç yazıcı yoksa açılışta,
  //  - kayıtlı bir yazıcıya 25 sn içinde ulaşılamazsa (IP değişmiş olabilir),
  //  - sonra 30 dakikada bir (ulaşılamayan yazıcı varsa 15 dakikada bir).
  const offlineCount = () => manager.snapshot().filter((p) => p.status === 'offline').length;
  lastScanStarted = Date.now(); // ilk periyodik tarama açılıştan 15/30 dk sonra
  if (config.printers.length === 0) setTimeout(() => runScan({ auto: true }), 1000);
  else setTimeout(() => { if (config.autoScan && offlineCount()) runScan({ auto: true }); }, 25000);
  setInterval(() => {
    if (!config.autoScan || scanning) return;
    const every = (offlineCount() ? 15 : 30) * 60 * 1000;
    if (Date.now() - lastScanStarted >= every) runScan({ auto: true });
  }, 60 * 1000);
});
