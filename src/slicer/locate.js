// Bilgisayarda kurulu dilimleyiciyi bul. OrcaSlicer ve onun türevi Anycubic Slicer Next'in
// komut satırı modu (--slice) kullanılıyor; ikisi de yazıcı profillerini resources/profiles altında taşır.
const fs = require('fs');
const path = require('path');
const os = require('os');

function candidates() {
  const list = [];
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    for (const r of roots) {
      list.push({ kind: 'orca', name: 'OrcaSlicer', exe: path.join(r, 'OrcaSlicer', 'orca-slicer.exe'), resources: path.join(r, 'OrcaSlicer', 'resources') });
      list.push({ kind: 'anycubic', name: 'Anycubic Slicer Next', exe: path.join(r, 'AnycubicSlicerNext', 'AnycubicSlicerNext.exe'), resources: path.join(r, 'AnycubicSlicerNext', 'resources') });
    }
  } else if (process.platform === 'darwin') {
    for (const apps of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      list.push({ kind: 'orca', name: 'OrcaSlicer', exe: path.join(apps, 'OrcaSlicer.app/Contents/MacOS/OrcaSlicer'), resources: path.join(apps, 'OrcaSlicer.app/Contents/Resources') });
      list.push({ kind: 'anycubic', name: 'Anycubic Slicer Next', exe: path.join(apps, 'AnycubicSlicerNext.app/Contents/MacOS/AnycubicSlicerNext'), resources: path.join(apps, 'AnycubicSlicerNext.app/Contents/Resources') });
    }
  } else {
    list.push({ kind: 'orca', name: 'OrcaSlicer', exe: '/usr/bin/orca-slicer', resources: '/usr/share/OrcaSlicer/resources' });
  }
  return list;
}

// Kullanıcı ayarlarda özel bir yol verdiyse önce o denenir
function locate(customExe) {
  const list = candidates();
  if (customExe) {
    const dir = path.dirname(customExe);
    const res = [path.join(dir, 'resources'), path.join(dir, '..', 'Resources')].find((p) => fs.existsSync(path.join(p, 'profiles')));
    list.unshift({ kind: /anycubic/i.test(customExe) ? 'anycubic' : 'orca', name: path.basename(customExe), exe: customExe, resources: res || '' });
  }
  for (const c of list) {
    if (fs.existsSync(c.exe) && c.resources && fs.existsSync(path.join(c.resources, 'profiles'))) return c;
  }
  return null;
}

// Kurulu bütün dilimleyiciler (tür başına ilk bulunan): { orca, anycubic }
function locateAll(customExe) {
  const found = {};
  const list = candidates();
  if (customExe) {
    const c = locate(customExe);
    if (c) found[c.kind] = c;
  }
  for (const c of list) {
    if (found[c.kind]) continue;
    if (fs.existsSync(c.exe) && c.resources && fs.existsSync(path.join(c.resources, 'profiles'))) found[c.kind] = c;
  }
  return found;
}

module.exports = { locate, locateAll };
