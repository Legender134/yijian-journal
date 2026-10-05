'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (name, ...args) => ipcRenderer.invoke(`journal:${name}`, ...args);
contextBridge.exposeInMainWorld('journal', {
  bootstrap: () => call('bootstrap'),
  mutate: (command) => call('mutate', command),
  refresh: () => call('refresh'),
  health: () => call('health'),
  ready: () => call('ready'),
  configureShortcuts: (value) => call('shortcuts-configure', value),
  bridgeInstall: () => call('bridge-install'),
  bridgeDisable: () => call('bridge-disable'),
  timelineConfigure: (value) => call('timeline-configure', value),
  timelineSave: () => call('timeline-save'),
  timelineInspect: (id) => call('timeline-inspect', id),
  timelineUpdate: (id, value) => call('timeline-update', id, value),
  timelineRelease: () => call('timeline-release'),
  nodeDraft: (id, value) => call('node-draft', id, value),
  timelineLoad: (id) => call('timeline-load', id),
  timelineRecover: () => call('timeline-recover'),
  help: () => call('help'),
  saveDetails: (name) => call('save-details', name),
  compareSaves: (leftName, rightName) => call('compare-saves', leftName, rightName),
  recipePlan: (id, quantity, saveName) => call('recipe-plan', id, quantity, saveName),
  materialPlan: (list, saveName) => call('material-plan', list, saveName),
  backup: (label) => call('backup', label),
  verifyBackup: (id) => call('verify-backup', id),
  inspectBackup: (id) => call('inspect-backup', id),
  renameBackup: (id, label) => call('rename-backup', id, label),
  openBackup: (id) => call('open-backup', id),
  restore: (id) => call('restore', id),
  recoverRestore: () => call('recover-restore'),
  chooseSaves: () => call('choose-saves'),
  useDetectedSaves: (value) => call('use-detected-saves', value),
  openFolder: (type) => call('open-folder', type),
  exportJournal: () => call('export'),
  importJournal: () => call('import'),
  openSource: (id) => call('source', id),
  launchGame: () => call('launch-game'),
  compact: () => call('compact'),
  window: (action) => call('window', action),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('journal:state', listener);
    return () => ipcRenderer.removeListener('journal:state', listener);
  },
  onEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on('journal:event', listener);
    return () => ipcRenderer.removeListener('journal:event', listener);
  },
  onAction: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on('journal:action', listener);
    return () => ipcRenderer.removeListener('journal:action', listener);
  },
});
