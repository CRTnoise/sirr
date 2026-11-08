/**
 * Sirr — lock screen bridge. The lock window gets these two calls and
 * nothing else; the full bridge (preload.js) exists only after unlock.
 */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sirrLock', {
  unlock: (pass) => ipcRenderer.invoke('lock:unlock', String(pass || '')),
  quit:   ()     => ipcRenderer.invoke('lock:quit'),
});
