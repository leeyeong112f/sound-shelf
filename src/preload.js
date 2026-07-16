const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('soundLibrary', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addFiles: () => ipcRenderer.invoke('library:add-files'),
  addDroppedFiles: (files) => ipcRenderer.invoke('library:add-paths', files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)),
  addFolder: () => ipcRenderer.invoke('library:add-folder'),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  updateSound: (payload) => ipcRenderer.invoke('library:update', payload),
  removeSound: (payload) => ipcRenderer.invoke('library:remove', payload),
  moveSoundToFolder: (id) => ipcRenderer.invoke('library:move-folder', id),
  moveSoundToCategory: (payload) => ipcRenderer.invoke('library:move-category', payload),
  setShortcuts: (shortcuts) => ipcRenderer.invoke('shortcuts:set', shortcuts),
  setShortcutCapture: (active) => ipcRenderer.send('shortcuts:capture', active),
  getWaveform: (id) => ipcRenderer.invoke('library:waveform', id),
  prepareClip: (payload) => ipcRenderer.invoke('library:prepare-clip', payload),
  reveal: (filePath) => ipcRenderer.invoke('library:reveal', filePath),
  insertIntoResolve: (sound) => ipcRenderer.invoke('resolve:insert', sound),
  startDrag: (filePath) => ipcRenderer.send('library:start-drag', filePath),
  onDragError: (callback) => ipcRenderer.on('drag-error', (_event, message) => callback(message)),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_event, payload) => callback(payload)),
  onShortcut: (callback) => ipcRenderer.on('shortcut-triggered', (_event, shortcut) => callback(shortcut))
});
