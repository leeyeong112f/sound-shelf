const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundLibrary', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addFiles: () => ipcRenderer.invoke('library:add-files'),
  addFolder: () => ipcRenderer.invoke('library:add-folder'),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  updateSound: (payload) => ipcRenderer.invoke('library:update', payload),
  removeSound: (payload) => ipcRenderer.invoke('library:remove', payload),
  getWaveform: (id) => ipcRenderer.invoke('library:waveform', id),
  prepareClip: (payload) => ipcRenderer.invoke('library:prepare-clip', payload),
  reveal: (filePath) => ipcRenderer.invoke('library:reveal', filePath),
  insertIntoResolve: (sound) => ipcRenderer.invoke('resolve:insert', sound),
  startDrag: (filePath) => ipcRenderer.send('library:start-drag', filePath),
  onDragError: (callback) => ipcRenderer.on('drag-error', (_event, message) => callback(message)),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_event, payload) => callback(payload))
});
