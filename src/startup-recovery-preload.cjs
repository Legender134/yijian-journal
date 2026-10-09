'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (name, ...args) => ipcRenderer.invoke('journal-recovery:' + name, ...args);
contextBridge.exposeInMainWorld('journalRecovery', {
  status: () => call('status'),
  choose: (mode) => call('choose', mode),
  prepareNew: () => call('prepare-new'),
  confirm: (token) => call('confirm', token),
  cancel: () => call('cancel'),
});
