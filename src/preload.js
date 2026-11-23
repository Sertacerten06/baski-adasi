const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const on = (channel) => (cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getState: () => call('state:get'),
  getConfig: () => call('config:get'),
  setConfig: (patch) => call('config:set', patch),
  addPrinter: (host) => call('printer:add', host),
  removePrinter: (id) => call('printer:remove', id),
  renamePrinter: (id, name) => call('printer:rename', id, name),
  movePrinter: (id, dir) => call('printer:move', id, dir),
  scan: () => call('scan'),
  cmd: (id, cmd, value) => call('cmd', id, cmd, value),
  upload: (id, file) => call('upload', id, file ? webUtils.getPathForFile(file) : null),
  openPanel: (nav) => ipcRenderer.send('panel:open', nav),
  islandMouse: (inside) => ipcRenderer.send('island:mouse', inside),
  onState: on('state'),
  onEvent: on('event'),
  onConfig: on('config'),
  onScan: on('scan'),
  onNavigate: on('navigate'),
  onIslandLeave: on('island:leave'),
  onIslandPos: on('island:pos'),
});
