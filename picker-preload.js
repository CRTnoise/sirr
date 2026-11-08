/**
 * Sirr — Picker preload
 * Exposes a minimal IPC bridge for the display-media source picker window.
 * The picker is identified by its webContents id, tagged on every IPC call
 * by Electron automatically via `event.sender.id` on the main side.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sirrPicker', {
  getSources: () => ipcRenderer.invoke('sirr:picker:get-sources'),
  pick:   id => ipcRenderer.send('sirr:picker:pick', id),
  cancel: () => ipcRenderer.send('sirr:picker:cancel'),
});
