// Geliştirme aracı: BADASI_SNAP=<klasör> ile çalıştırılınca ada ve panelin ekran görüntülerini kaydedip çıkar.
const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function snap({ dir, getIsland, getPanel, openPanel, app }) {
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'console.log');
  fs.writeFileSync(logFile, '');
  const hook = (win, tag) => win && win.webContents.on('console-message', (e) => {
    const { level, message, lineNumber, sourceId } = e;
    fs.appendFileSync(logFile, `[${tag}] ${level} ${message} (${path.basename(sourceId || '')}:${lineNumber})\n`);
  });
  const save = async (win, name) => {
    if (!win) return;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name), img.toPNG());
    console.log('[snap]', name);
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { fs.appendFileSync(logFile, `[snap] ${name} HATA: ${e.message}\n`); } };

  hook(getIsland(), 'ada');
  // yazıcı durum değişimlerini zaman damgasıyla kaydet
  const t0 = Date.now();
  const mgr = require('./main-manager-ref');
  if (mgr.manager) {
    let lastLine = '';
    mgr.manager.on('change', () => {
      const line = mgr.manager.snapshot().map((p) => `${p.name}:${p.status}${p.error ? '(' + p.error + ')' : ''}`).join(' ');
      if (line !== lastLine) { lastLine = line; fs.appendFileSync(logFile, `[durum +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}\n`); }
    });
  }
  await wait(Number(process.env.BADASI_SNAP_WAIT || 9000));
  openPanel();
  await wait(300);
  hook(getPanel(), 'panel');
  await wait(2500);
  const island = getIsland(); const panel = getPanel();
  await step('ada-kompakt', () => save(island, 'island-compact.png'));
  await step('ada-genis', async () => {
    await island.webContents.executeJavaScript('setExpanded(true)');
    await wait(1600);
    await save(island, 'island-expanded.png');
    await island.webContents.executeJavaScript('setExpanded(false)');
  });
  await step('panel', () => save(panel, 'panel-printer.png'));
  await step('panel-alt', async () => {
    await panel.webContents.executeJavaScript('document.querySelector(".content").scrollTop = 10000');
    await wait(400);
    await save(panel, 'panel-printer-bottom.png');
  });
  await step('ayarlar', async () => {
    await panel.webContents.executeJavaScript('go({ type: "settings" })');
    await wait(800);
    await save(panel, 'panel-settings.png');
  });
  if (process.env.BADASI_SNAP_EXTRA) await step('ekstra', () => require(process.env.BADASI_SNAP_EXTRA)({ island, panel, save, wait }));
  if (process.env.BADASI_SNAP_KEEP !== '1') { app.isQuitting = true; app.quit(); }
};
