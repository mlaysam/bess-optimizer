const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveCSV:    (content, defaultName) => ipcRenderer.invoke('save-csv',    { content, defaultName }),
  saveReport: (content, defaultName) => ipcRenderer.invoke('save-report', { content, defaultName }),
  isElectron: true,
});
