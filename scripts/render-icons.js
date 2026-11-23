// SVG simgeleri PNG'ye çevir (Electron'un ekran dışı çizimiyle, ekran ölçeğinden bağımsız).
// Çalıştır: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const jobs = [
  ['build/icon.svg', 'build/icon.png', 1024],
  ['build/icon.svg', 'src/assets/icon.png', 256],
  ['build/tray.svg', 'src/assets/tray.png', 32],
  ['build/trayTemplate.svg', 'src/assets/trayTemplate.png', 16],
  ['build/trayTemplate.svg', 'src/assets/trayTemplate@2x.png', 32],
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  // tek ekran dışı pencere; her boyut için yeniden boyutlandırılır (pencereyi kapatıp yenisini açmak yüklemeyi bozuyor)
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  try {
    for (const [src, out, size] of jobs) {
      const svg = fs.readFileSync(path.join(root, src), 'utf8');
      // her zaman 1024'te çiz, sonra küçült: küçük boyutlarda kenarlar daha temiz
      const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace(/<svg /, '<svg style="display:block;width:1024px;height:1024px" ')}</body></html>`;
      const tmp = path.join(os.tmpdir(), `badasi-icon-${path.basename(src, '.svg')}.html`);
      fs.writeFileSync(tmp, html);
      await win.loadFile(tmp);
      await new Promise((r) => setTimeout(r, 300));
      let img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
      img = img.resize({ width: size, height: size, quality: 'best' });
      fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
      fs.writeFileSync(path.join(root, out), img.toPNG());
      console.log('yazıldı', out, JSON.stringify(img.getSize()));
    }
  } catch (e) {
    console.error('HATA', e.message);
  }
  win.destroy();
  app.quit();
});
