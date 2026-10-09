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
  startAssistance: () => call('start-assistance'),
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
  saveDetails: (name, recipeId) => call('save-details', name, recipeId),
  compareSaves: (leftName, rightName) => call('compare-saves', leftName, rightName),
  recipePlan: (id, quantity, saveName) => call('recipe-plan', id, quantity, saveName),
  materialPlan: (list, saveName) => call('material-plan', list, saveName),
  resourcePriorityPreview: (profileId, order, referenceName) =>
    call('resource-priority-preview', profileId, order, referenceName),
  recipeDiscovery: (options) => call('recipe-discovery', options),
  backup: (label) => call('backup', label),
  verifyBackup: (id) => call('verify-backup', id),
  lockBackup: (id, locked) => call('backup-lock', id, locked),
  cleanupBackups: (ids) => call('backup-cleanup', ids),
  recoverBackupCleanup: (id, mode) => call('backup-cleanup-recover', id, mode),
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
  journeyPlan: () => call('journey-plan'),
  protectionList: () => call('protection-list'),
  protectionHistory: (id) => call('protection-history', id),
  protectionInspect: (id, type, recordId, name) => call('protection-inspect', id, type, recordId, name),
  exportProtection: () => call('protection-export'),
  exportSelectedBackups: (ids) => call('protection-selected-export', ids),
  exportHistoricalProtection: (id) => call('protection-history-export', id),
  importProtection: (mode = 'files') => call('protection-import', mode),
  useHistoricalJournal: (id) => call('protection-use-journal', id),
  restoreHistoricalBackup: (id, backupId) => call('protection-restore', id, backupId),
  openSource: (id) => call('source', id),
  launchGame: () => call('launch-game'),
  compact: () => call('compact'),
  companionSnapshot: () => call('companion-snapshot'),
  companionCollapse: () => call('companion-collapse'),
  onCompanion: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('journal:companion', listener);
    return () => ipcRenderer.removeListener('journal:companion', listener);
  },
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
  onQuitRequested: (callback) => {
    const listener = async (_event, request) => {
      if (request.cancelled) {
        callback({ cancelled: true });
        return;
      }
      let ready = false;
      try {
        ready = (await callback({ cancelled: false })) === true;
      } catch {
        ready = false;
      } finally {
        await call('quit-ready', { token: request.token, ready }).catch(() => {});
      }
    };
    ipcRenderer.on('journal:prepare-quit', listener);
    return () => ipcRenderer.removeListener('journal:prepare-quit', listener);
  },
});
