const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('addTorrentAPI', {
  getTorrentInfo: (filePath) => ipcRenderer.invoke('addtorrent-get-info', filePath),
  openFolderDialog: (currentPath) => ipcRenderer.invoke('addtorrent-open-folder', currentPath),
  addTorrent: (options) => ipcRenderer.invoke('addtorrent-add', options),
  getStoredSavePath: () => ipcRenderer.invoke('addtorrent-get-savepath'),
  getWebUiUrl: () => ipcRenderer.invoke('addtorrent-get-url'),
  getCategories: () => ipcRenderer.invoke('addtorrent-get-categories'),
});
