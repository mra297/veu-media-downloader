// Preload: expose native folder picker + notification to web UI
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  notify: (opts) => ipcRenderer.invoke('show-notification', opts),
  ytLogin: () => ipcRenderer.invoke('yt-login'),
  cookiesStatus: () => ipcRenderer.invoke('cookies-status'),
});
