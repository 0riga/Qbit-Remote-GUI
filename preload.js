const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getStoredUrl: () => ipcRenderer.sendSync('connection-get-url'),
  getStoredCredentials: () => ipcRenderer.sendSync('connection-get-credentials'),
  openConnection: (url, username, password) => ipcRenderer.send('connection-open', url, username, password),
});
