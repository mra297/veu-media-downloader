// Preload cho cửa sổ popup cập nhật
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('updaterAPI', {
  onInfo: (cb) => { window._updInfo = cb; },
  onProgress: (cb) => { window._updProgress = cb; },
  onDownloaded: (cb) => { window._updDownloaded = cb; },
  onError: (cb) => { window._updError = cb; },
  download: () => ipcRenderer.invoke('update-download'),
  install: () => ipcRenderer.invoke('update-install'),
  close: () => ipcRenderer.invoke('update-close'),
});
