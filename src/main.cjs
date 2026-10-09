'use strict';
const { validateCraftList } = require('./core/material-plan.cjs');
const { goalProgress } = require('./core/goal-progress.cjs');
const { allocationSummary } = require('./core/resource-allocations.cjs');
const {
  resourceBudget,
  subtractBudget,
  recipeBudget,
  materialReport,
} = require('./core/resource-budget.cjs');
const {
  exportComplete,
  readProtectionExportResult,
  volumeFiles,
  previewCompleteSet,
  importCompleteSet,
} = require('./core/complete-migration.cjs');
const { exportProtection, readProtectionIndex } = require('./core/migration.cjs');
const { protectionExportReceipt } = require('./core/backup-anomalies.cjs');
const {
  setBackupLock,
  cleanupExportedBackups,
  listPending: pendingBackupCare,
  finishPending: finishBackupCare,
  rollbackPending: rollbackBackupCare,
} = require('./core/backup-care.cjs');
const { ProtectionArchives } = require('./core/protection-archives.cjs');
const { journeyPlan } = require('./core/journey-plan.cjs');
const { applyIntentDraftCommand } = require('./core/intent-drafts.cjs');
const { priorityFingerprint, resourcePriorityPreview } = require('./core/resource-priority.cjs');
const { recipeDiscovery, assertDiscoveryScope } = require('./core/recipe-discovery.cjs');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  globalShortcut,
  session,
  Tray,
  Menu,
  nativeImage,
  Notification,
  screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const catalog = require('./data/catalog.cjs');
const { Store, MAX_JOURNAL_BYTES } = require('./core/store.cjs');
const { isolation: journalRecoveryIsolation } = require('./core/startup-recovery.cjs');
const { showStartupRecovery } = require('./startup-recovery-window.cjs');
const { Saves, discoverSaveFolders, realDirectory, listFiles } = require('./core/saves.cjs');
const { detectGame, gameStopped } = require('./core/environment.cjs');
const { encyclopedia, recipePlan, enrich } = require('./core/game-data.cjs');
const { AutoBackup } = require('./core/auto-backup.cjs');
const { Timeline } = require('./core/timeline.cjs');
const { GameBridge, activeSteamId, bridgeStateRoot } = require('./core/game-bridge.cjs');
const { QuickStart, selectSaveFolder } = require('./core/quick-start.cjs');
const { protectionStatus } = require('./core/protection-status.cjs');
const { Shortcuts, DEFAULTS: DEFAULT_SHORTCUTS } = require('./core/shortcuts.cjs');
const { Activity } = require('./core/activity.cjs');
const { availableInventory } = require('./core/reservations.cjs');
const { GameWindow } = require('./core/game-window.cjs');
const { CompanionWindow } = require('./core/companion-window.cjs');
const { QuitHandoff } = require('./core/quit-handoff.cjs');
const quitHandoff = new QuitHandoff();
const { companionSnapshot } = require('./core/companion.cjs');
let companion, windowMonitor;
let protectionArchives,
  protectionJobPromise = null;
async function protectionJob(label, work) {
  if (protectionJobPromise) throw Error('正在处理保护资料，请等待当前操作完成');
  if (bridge?.busy || bridge?.loadQueued || bridge?.quiescing)
    throw Error('游戏存读档操作正在进行，请稍后再处理保护资料');
  if (quitRequested) throw Error('手札正在退出');
  broadcast('event', { type: 'protection', busy: true, label });
  const task = Promise.resolve().then(work);
  protectionJobPromise = task;
  try {
    return await task;
  } finally {
    protectionJobPromise = null;
    broadcast('event', { type: 'protection', busy: false, label });
  }
}
let gameCheckedAt = -Infinity;
let activity;
const trayImages = new Map();
let lastNotificationAt = 0;
function clearOperationFault() {
  try {
    activity.clearFault();
  } catch {
    activity.warning = '保存已完成，但操作记录无法更新。请检查本机数据目录可写及剩余空间。';
  }
}
function resultFeedback(level, message, notify = false) {
  let result;
  try {
    result = activity.record(level, message);
  } catch {
    activity.warning = '操作结果未能写入本机，请检查数据目录及剩余空间。';
    result = { level, message: message + '；操作结果记录未能写入', at: Date.now() };
  }
  broadcast('event', { type: 'operation', result });
  if (
    notify &&
    !isTest &&
    store.get().settings.saveFeedback &&
    Date.now() - lastNotificationAt > 1000 &&
    Notification.isSupported()
  ) {
    new Notification({ title: '逸剑手札', body: message, silent: true }).show();
    lastNotificationAt = Date.now();
  }
  updateTray();
  return result;
}
function bridgeEvent(event) {
  if (event.type === 'error') resultFeedback('error', event.text, true);
  if (event.type === 'timeline') clearOperationFault();
  broadcast('event', event);
  updateTray();
}
async function launchGame() {
  if (isTest) throw Error('测试环境不启动游戏');
  if (quitRequested) throw Error('手札正在退出');
  if (protectionJobPromise) throw Error('正在处理保护资料，请完成后再开始游戏');
  if (bridge.busy || bridge.loadQueued || bridge.quiescing || saves.busy)
    throw Error('请等待当前存读档完成，再开始游戏');
  if (timeline.data.pending || saves.pendingRestore())
    throw Error('请先在存档匣核对上次中断的操作，再开始游戏');
  bridge.assertLaunchSafe();
  await shell.openExternal('steam://rungameid/1876890');
  resultFeedback(
    'info',
    timeline.data.enabled ? '已启动游戏，连接后继续自动保存' : '已启动游戏，查询与存档备份可直接使用',
  );
  return true;
}

app.setName('YijianJournal');
if (process.env.YIJIAN_TEST_DATA) app.setPath('userData', path.resolve(process.env.YIJIAN_TEST_DATA));
const isTest = !!process.env.YIJIAN_TEST_DATA;
const timelinePreviews = new Map();
function releaseTimelinePreview(senderId) {
  timelinePreviews.get(senderId)?.();
  return timelinePreviews.delete(senderId);
}
let mainWindow,
  store,
  saves,
  game,
  autoBackup,
  timeline,
  bridge,
  shortcutReady = false;
let recoveryWindow = null,
  startupRecoveryActive = false,
  recoveredIsolation = null;
let tray,
  shortcuts,
  trayTimer,
  quitRequested = false,
  quitGranted = false,
  quitPromise;
const rendererReady = new Set(),
  pendingActions = new Map();
const backgroundAllowed = !isTest || process.env.YIJIAN_TEST_TRAY === '1';
function autoBackupBlocked(
  care = saves ? pendingBackupCare({ saves }).filter((p) => p.blocking !== false) : [],
) {
  return (
    quitRequested ||
    !!protectionJobPromise ||
    care.length > 0 ||
    bridge?.busy ||
    bridge?.loadQueued ||
    bridge?.quiescing ||
    (timeline?.data.enabled && bridge?.connected())
  );
}
function health(t = bridge?.summary()) {
  const fault = activity?.get().fault;
  const backupCareRecords = saves ? pendingBackupCare({ saves }) : [];
  const backupCare = backupCareRecords.filter((p) => p.blocking !== false);
  if (t && !t.enabled && !t.error && fault) t.error = fault.message;
  const snapshot = {
    timeline: t && {
      enabled: t.enabled,
      busy: t.busy,
      ready: t.ready,
      connected: t.connected,
      error: t.error,
      indexError: t.indexError,
      reason: t.reason,
      pending: !!t.pending,
      latest: t.latest,
      quiescing: quitRequested || t.quiescing,
    },
    background: !!tray,
    operation: activity?.get().events[0] || null,
    quitting: quitRequested,
    recovery: !!saves?.pendingRestore(),
    backupCare,
    backupCareRecords,
    saveConnected: !!store?.get().settings.savePath,
    backupError: autoBackup?.error || '',
    lastBackup: backupCare.some((p) => p.ids?.includes(autoBackup?.lastBackup?.id))
      ? null
      : autoBackup?.lastBackup || null,
    backupStatus: !store?.get().settings.autoBackup
      ? 'disabled'
      : autoBackupBlocked(backupCare)
        ? 'paused'
        : autoBackup?.error
          ? 'error'
          : 'watching',
  };
  snapshot.protection = protectionStatus(snapshot);
  return snapshot;
}
function sendAction(action) {
  if (quitRequested) return;
  let w;
  if (
    windowMonitor?.state?.gameForeground ||
    (companion?.mode === 'expanded' && windowMonitor?.state?.available && windowMonitor.state.ownForeground)
  ) {
    if (companion.mode !== 'expanded') companion.expand();
    w = companion.window;
  } else w = showMain();
  if (rendererReady.has(w.webContents.id)) w.webContents.send('journal:action', { action });
  else pendingActions.set(w.webContents.id, action);
}
async function quickSave() {
  if (isTest || quitRequested) return;
  if (protectionJobPromise) {
    resultFeedback('info', '正在处理保护资料，完成后可手动保存', true);
    return;
  }
  try {
    const record = await bridge.save();
    clearOperationFault();
    resultFeedback('success', '进度已保存并收藏 · ' + enrich({ map: record.map }).mapName, true);
    broadcast('event', { type: 'timeline', text: '' });
  } catch (e) {
    resultFeedback('error', '手动保存未完成：' + e.message, true);
    broadcast('event', { type: 'error', text: e.message });
  }
  updateTray();
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  refreshGameEnvironment();
  const snapshot = health(),
    t = snapshot.timeline,
    protection = snapshot.protection,
    status = protection.label;
  const colour = protection.warning ? '#df514b' : protection.ready ? '#2aa66e' : '#dda83c';
  if (!trayImages.has(colour)) {
    const image = nativeImage
      .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
      .resize({ width: 16, height: 16 });
    const pixels = image.toBitmap();
    const rgb = colour
      .slice(1)
      .match(/../g)
      .map((v) => parseInt(v, 16));
    for (let y = 8; y < 16; y++)
      for (let x = 8; x < 16; x++)
        if ((x - 12) ** 2 + (y - 12) ** 2 <= 12) {
          const i = (y * 16 + x) * 4;
          pixels[i] = rgb[2];
          pixels[i + 1] = rgb[1];
          pixels[i + 2] = rgb[0];
          pixels[i + 3] = 255;
        }
    trayImages.set(colour, nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
  }
  tray.setImage(trayImages.get(colour));
  tray.setToolTip(
    '逸剑手札 · ' +
      status +
      (protection.at
        ? '\n' +
          protection.detail +
          ' ' +
          new Date(protection.at).toLocaleTimeString('zh-CN', { hour12: false })
        : ''),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开逸剑手札', click: () => showMain() },
      { label: status, enabled: false },
      { label: protection.reason, enabled: false },
      { label: activity?.get().events[0]?.message || '尚无手动操作结果', enabled: false },
      { type: 'separator' },
      {
        label: '立即保存进度',
        enabled: !quitRequested && !!t?.ready && !t.busy && !t.pending,
        click: quickSave,
      },
      { label: '查看历史存档', enabled: !quitRequested, click: () => sendAction('history') },
      {
        label: '查看读档前进度',
        enabled: !quitRequested && !!timeline?.summary().returnRecord,
        click: () => sendAction('return'),
      },
      { type: 'separator' },
      { label: '退出手札（停止自动保存）', click: () => requestQuit() },
    ]),
  );
}
function createTray() {
  if (!backgroundAllowed) return;
  try {
    tray = new Tray(
      nativeImage
        .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
        .resize({ width: 16, height: 16 }),
    );
    tray.on('double-click', () => showMain());
    updateTray();
    trayTimer = setInterval(updateTray, 5000);
  } catch {
    tray = null;
    broadcast('event', { type: 'error', text: '托盘创建失败，关闭主窗口将退出；请保持窗口运行以自动保存' });
  }
}
function requestQuit() {
  if (quitPromise) return quitPromise;
  quitRequested = true;
  broadcast('event', { type: 'health', health: health() });
  updateTray();
  quitPromise = (async () => {
    try {
      await protectionJobPromise?.catch(() => {});
      const prepared = await quitHandoff.prepare(
        BrowserWindow.getAllWindows().filter(
          (win) => !win.isDestroyed() && rendererReady.has(win.webContents.id),
        ),
      );
      if (!prepared) {
        cancelQuit();
        return;
      }
      await bridge?.quiesce();
      quitGranted = true;
      app.quit();
    } catch (e) {
      cancelQuit();
      broadcast('event', { type: 'error', text: e.message });
    }
  })();
  return quitPromise;
}
function cancelQuit() {
  quitHandoff.cancel();
  quitRequested = false;
  quitGranted = false;
  quitPromise = null;
  if (bridge) bridge.quiescing = false;
  showMain();
  broadcast('event', { type: 'health', health: health() });
  updateTray();
}
const htmlPath = path.join(__dirname, 'renderer', 'index.html');
const validUrl = (url) => {
  try {
    return (
      new URL(url).pathname === new URL(pathToFileURL(htmlPath)).pathname && new URL(url).protocol === 'file:'
    );
  } catch {
    return false;
  }
};
const ownsInstance = isTest || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show();
    if (recoveryWindow.isMinimized()) recoveryWindow.restore();
    recoveryWindow.focus();
    return;
  }
  if (app.isReady() && store) {
    showMain();
    if (argv.includes('--guard-game')) launchGame().catch((e) => resultFeedback('error', e.message, true));
  }
});
function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const contents = w.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send(`journal:${channel}`, data);
    } catch (error) {
      if (!contents.isDestroyed()) throw error;
    }
  }
}
function makeWindow(compact = false) {
  const win = new BrowserWindow({
    width: compact ? 460 : 1340,
    height: compact ? 660 : 880,
    minWidth: compact ? 200 : 980,
    minHeight: compact ? 90 : 660,
    frame: false,
    show: false,
    title: compact ? '逸剑手札 · 随行' : '逸剑手札',
    backgroundColor: '#f5f3ec',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    skipTaskbar: compact,
    resizable: !compact,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.setMenu(null);
  if (!compact)
    win.on('close', (event) => {
      if (tray && !quitGranted) {
        event.preventDefault();
        win.hide();
        releaseTimelinePreview(senderId);
        win.webContents.send('journal:action', { action: 'hide' });
      }
    });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const senderId = win.webContents.id;
  win.webContents.on('will-prevent-unload', () => {
    if (!quitRequested) return;
    // Edits made after the acknowledgement still cancel exit without relying on health delivery.
    cancelQuit();
  });
  win.webContents.once('destroyed', () => {
    releaseTimelinePreview(senderId);
    rendererReady.delete(senderId);
    pendingActions.delete(senderId);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (compact) {
      win.destroy();
      return;
    }
    if (!isTest)
      dialog.showErrorBox('逸剑手札', `界面意外退出（${details.reason}）。记录已保存在本机，请重新打开。`);
  });
  win.loadFile(htmlPath, { query: compact ? { compact: '1' } : {} });
  if (compact) {
    win.setAlwaysOnTop(true, 'floating');
    win.setFocusable(false);
    win.setIgnoreMouseEvents(true);
  }
  win.once('ready-to-show', () => {
    if (!compact && (!isTest || !process.env.YIJIAN_TEST_HIDDEN)) win.show();
  });
  return win;
}
function toggleCompact() {
  return companion.expand();
}
function readCompanion() {
  const state = store.get(),
    profile = state.profiles.find((p) => p.id === state.activeProfileId);
  let reference = null,
    error = '';
  if (profile.referenceMode !== 'none' && state.settings.savePath) {
    const scan = saves.scan(state.settings.savePath);
    const selected = profile.saveSlot
      ? scan.files.find((f) => f.name === profile.saveSlot && f.metadata)
      : scan.files.find((f) => f.metadata);
    error =
      scan.error || (selected ? '' : profile.saveSlot ? '固定参照不存在或暂时无法解析' : '尚无有效游戏存档');
    if (selected) {
      if (Date.now() - Date.parse(selected.modifiedAt) < 1000 || bridge.busy)
        error = '存档正在更新，稍后核对';
      else
        try {
          reference = saves.details(state.settings.savePath, selected.name);
        } catch (e) {
          error = e.message;
        }
    }
  }
  return { ...companionSnapshot(state, catalog, reference, error), ...companion.status() };
}
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = makeWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return mainWindow;
}
function detected() {
  return isTest
    ? []
    : discoverSaveFolders(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'));
}
function assertSaveSelectionReady() {
  if (protectionJobPromise) throw Error('请等待保护资料迁移完成');
  if (quitRequested || bridge.quiescing) throw Error('手札正在退出，请等待存读档完成');
  if (bridge.busy || bridge.loadQueued || timeline.data.pending) throw Error('请先完成或核对时间线操作');
  if (saves.busy || saves.pendingRestore()) throw Error('请先完成或核对完整存档恢复');
}
function connectDetectedSaves() {
  if (
    recoveredIsolation?.disableAutoDiscovery ||
    quitRequested ||
    saves.busy ||
    bridge?.quiescing ||
    store.get().settings.savePath ||
    timeline?.error ||
    timeline?.data.pending ||
    saves.pendingRestore() ||
    bridge?.busy ||
    bridge?.loadQueued
  )
    return;
  const source = selectSaveFolder(detected(), activeSteamId);
  if (!source) return;
  timeline.configure(source, false, 10);
  const state = store.setPath('savePath', source);
  if (bridge && !isTest) {
    try {
      bridge.connect(source);
      bridge.error = '';
    } catch (e) {
      bridge.error = timeline.data.enabled ? e.message : '';
    }
  }
  autoBackup?.reset();
  autoBackup?.check();
  broadcast('state', state);
}
function refreshGameEnvironment() {
  if (isTest || quitRequested || bridge?.quiescing) return;
  const now = performance.now();
  if (now - gameCheckedAt < 5000) return;
  gameCheckedAt = now;
  game = detectGame();
  windowMonitor?.setTarget(
    game.path ? path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64', 'JH-Win64-Shipping.exe') : '',
  );
  if (bridge?.reconcileEnvironment()) autoBackup?.check();
}
function prepareConfiguredTimeline() {
  const source = store.get().settings.savePath;
  if (
    !timeline.data.source &&
    !timeline.data.pending &&
    source &&
    !timeline.error &&
    !saves.scan(source).error
  )
    timeline.configure(source, false, 10);
}
function overview() {
  refreshGameEnvironment();
  const state = store.get(),
    configured = state.settings.savePath,
    profile = state.profiles.find((p) => p.id === state.activeProfileId),
    preferred = profile.saveSlot || '';
  const scan = saves.scan(configured),
    latest =
      profile.referenceMode === 'none'
        ? null
        : preferred
          ? scan.files.find((f) => f.name === preferred && f.metadata)
          : scan.files.find((f) => f.metadata);
  let recent = null,
    goalReference = null,
    goalError = scan.error || '';
  if (latest)
    try {
      const file = saves.details(configured, latest.name),
        m = file.metadata;
      if (Date.now() - Date.parse(file.modifiedAt) < 1000 || bridge?.busy)
        goalError = '存档正在更新，稍后核对';
      else goalReference = file;
      recent = {
        name: file.name,
        modifiedAt: file.modifiedAt,
        mapName: m.mapName,
        playSeconds: m.playSeconds,
        team: m.team,
        mainQuest: m.mainQuest?.name,
        quest: m.quest?.name,
        pendingTasks: m.activeQuestFamilies?.length,
        activeQuests: m.activeQuestFamilies?.slice(0, 4),
        thumbnail: m.thumbnail,
      };
    } catch (e) {
      goalError = e.message || '存档进度暂无法读取';
    }
  const timelineStatus = bridge?.summary(),
    snapshot = health(timelineStatus);
  const allocations = resourceBudget(profile, goalReference, { error: goalError });
  const journey = journeyPlan(profile, goalError ? null : goalReference, {
    ...allocations,
    referenceIdentity:
      goalReference && !goalError
        ? { name: goalReference.name, hash: goalReference.hash, modifiedAt: goalReference.modifiedAt }
        : null,
  });
  return {
    game,
    saves: scan,
    recent,
    goalProfileId: profile.id,
    goalProgress: goalProgress(profile, goalReference, goalError),
    allocations,
    journey,
    preferredSave: preferred,
    preferredSaveMissing: !!preferred && !latest,
    backups: saves.list(),
    backupAnomalies: saves.anomalies(),
    protectionExportResult: readProtectionExportResult(app.getPath('userData')),
    journalRecovery: {
      isolated: !!recoveredIsolation,
      needsSaveConfirmation: !!recoveredIsolation && !state.settings.savePath,
      retainedDirectory: recoveredIsolation?.retainedDirectory || '',
    },
    recovery: saves.pendingRestore(),
    backupCare: snapshot.backupCareRecords,
    detected: detected(),
    userData: app.getPath('userData'),
    backupRoot: saves.root,
    warning: store.warning,
    autoError: autoBackup?.error || '',
    timeline: bridge && { ...timelineStatus, ...snapshot.timeline },
    shortcutReady,
    shortcuts: shortcuts?.summary(state.settings.shortcuts || DEFAULT_SHORTCUTS),
    health: snapshot,
    activity: activity?.get(),
  };
}
function currentPlanningReference(profile) {
  const scan = saves.scan(store.get().settings.savePath);
  const mode = profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest');
  const file =
    mode === 'none'
      ? null
      : mode === 'slot'
        ? scan.files.find((f) => f.name === profile.saveSlot)
        : scan.files.find((f) => f.metadata);
  let reference = null,
    error = scan.error || '';
  if (file)
    try {
      const read = saves.details(store.get().settings.savePath, file.name);
      if (bridge.busy || Date.now() - Date.parse(read.modifiedAt) < 1000) error = '存档正在更新，稍后核对';
      else reference = read;
    } catch (e) {
      error = e.message;
    }
  return { reference: error ? null : reference, error };
}
function currentJourney(profile) {
  const { reference, error } = currentPlanningReference(profile);
  const budget = resourceBudget(profile, reference, { error });
  return {
    ...journeyPlan(profile, error ? null : reference, {
      ...budget,
      referenceIdentity:
        reference && !error
          ? { name: reference.name, hash: reference.hash, modifiedAt: reference.modifiedAt }
          : null,
    }),
    error,
  };
}
function handle(name, fn) {
  ipcMain.handle(`journal:${name}`, async (event, ...args) => {
    try {
      if (
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        !validUrl(event.senderFrame.url)
      )
        throw new Error('界面来源无效');
      if (
        protectionJobPromise &&
        [
          'choose-saves',
          'use-detected-saves',
          'timeline-save',
          'timeline-load',
          'timeline-configure',
          'start-assistance',
          'launch-game',
          'bridge-install',
          'bridge-disable',
          'restore',
          'recover-restore',
          'timeline-recover',
          'backup',
          'rename-backup',
          'verify-backup',
          'import',
          'export',
        ].includes(name)
      )
        throw Error('正在处理保护资料，请等待完成再操作存档');
      return { ok: true, data: await fn(event, ...args) };
    } catch (e) {
      const failure = { ok: false, error: e.message || '操作未完成，请重试' };
      for (const key of ['code', 'reasonCode', 'backupId', 'directory', 'diagnostic'])
        if (typeof e[key] === 'string') failure[key] = e[key].slice(0, key === 'diagnostic' ? 4000 : 2000);
      if (typeof e.published === 'boolean') failure.published = e.published;
      if (name === 'protection-export') {
        const receipt = protectionExportReceipt(e.exportResult);
        if (receipt) failure.exportResult = receipt;
      }
      return failure;
    }
  });
}
function checkedBackup(id, read) {
  let result;
  try {
    result = read();
  } catch (e) {
    autoBackup?.invalidate(id, e);
    try {
      saves.recordCheck(id, e.message);
    } catch {
      activity.warning = '副本校验失败，校验记录暂未保存；请检查手札数据目录及剩余空间。';
    }
    resultFeedback('error', `完整副本校验失败：${e.message}`);
    broadcast('event', { type: 'health', health: health() });
    throw e;
  }
  try {
    saves.recordCheck(id);
  } catch {
    activity.warning = '副本校验通过，但校验记录暂未保存；请检查手札数据目录及剩余空间。';
  }
  return result;
}
function owner(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}
app.whenReady().then(async () => {
  if (!ownsInstance) return;
  try {
    try {
      store = new Store(app.getPath('userData'), catalog);
    } catch (error) {
      if (error.code !== 'JOURNAL_RECOVERY_REQUIRED') throw error;
      startupRecoveryActive = true;
      const restored = await showStartupRecovery({
        app,
        BrowserWindow,
        ipcMain,
        dialog,
        session,
        catalog,
        hidden: isTest && !!process.env.YIJIAN_TEST_HIDDEN,
        onWindow: (window) => {
          recoveryWindow = window;
        },
      });
      recoveryWindow = null;
      if (!restored) {
        app.quit();
        return;
      }
      store = new Store(app.getPath('userData'), catalog);
      store.warning =
        '本机手札已重新建立，损坏原件另存保留。请在设置中重新确认本机存档目录；原生时间线需另外明确开启。';
    }
    recoveredIsolation = journalRecoveryIsolation(app.getPath('userData'));
    activity = new Activity(app.getPath('userData'));
    saves = new Saves(path.join(app.getPath('userData'), 'save-backups'));
    protectionArchives = new ProtectionArchives(app.getPath('userData'), () => store.get().settings.savePath);
    game = isTest ? { installed: false, path: '', build: '' } : detectGame();
    gameCheckedAt = performance.now();
    timeline = new Timeline(
      path.join(app.getPath('userData'), recoveredIsolation?.timelineDirectory || 'game-timeline'),
    );
    connectDetectedSaves();
    prepareConfiguredTimeline();
    const bridgeRoot = recoveredIsolation
      ? path.join(app.getPath('userData'), recoveredIsolation.bridgeDirectory)
      : bridgeStateRoot(game, app.getPath('userData'), isTest);
    bridge = new GameBridge(bridgeRoot, timeline, {
      getGame: () => (isTest ? game : detectGame()),
      stopped: gameStopped,
      blocked: () =>
        !!protectionJobPromise ||
        !!saves.pendingRestore() ||
        pendingBackupCare({ saves }).some((p) => p.blocking !== false),
      notify: bridgeEvent,
      test: isTest,
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    handle('bootstrap', () => ({
      catalog,
      gameIndex: encyclopedia(),
      state: store.get(),
      environment: overview(),
      version: app.getVersion(),
    }));
    handle('mutate', (_event, command) => {
      const trustedContext = {};
      let intentDraftCommit;
      if (['goal-remove', 'craft-plan-remove'].includes(command?.type)) {
        const current = store.get();
        if (command.profileId && command.profileId !== current.activeProfileId)
          throw Error('周目已变化，请重新核对要移除的个人安排');
        command = { ...command, profileId: current.activeProfileId };
      }
      if (command?.type?.startsWith('intent-draft-')) {
        const current = store.get();
        const ownerId =
          command.type === 'intent-draft-put' && command.profileId
            ? command.profileId
            : current.activeProfileId;
        const owner = current.profiles.find((profile) => profile.id === ownerId);
        if (!owner || (command.profileId && command.profileId !== owner.id))
          throw Error('周目已变化，请重新打开安排草稿');
        command = { ...command, profileId: owner.id };
        if (command.type === 'intent-draft-commit') {
          const { profileId, ...draftCommand } = command;
          const result = applyIntentDraftCommand(owner, draftCommand);
          intentDraftCommit = command;
          command = { ...result.intent, profileId: owner.id };
        }
      }
      if (command?.discovery !== undefined) {
        const data = store.get(),
          profile = data.profiles.find((p) => p.id === data.activeProfileId);
        if (command.profileId !== profile.id || !['craft-set', 'craft-plan-save'].includes(command.type))
          throw Error('周目或加入目标已变化，请重新核对反查结果');
        const { reference, error } = currentPlanningReference(profile);
        const budget = resourceBudget(profile, reference, { error });
        const candidate = assertDiscoveryScope(profile, reference, budget, command.discovery);
        const quantity = command.discovery.quantity;
        if (command.type === 'craft-set') {
          const expected =
            (profile.craftList?.find((line) => line.id === candidate.recipeId)?.quantity || 0) + quantity;
          if (command.id !== candidate.recipeId || command.quantity !== expected)
            throw Error('加入数量与当前清单已变化，请重新核对');
        } else {
          const plan = profile.craftPlans?.find((p) => p.id === command.id);
          if (!plan) throw Error('所选制作计划已不存在，请重新选择');
          const editing = plan.id === profile.activeCraftPlanId;
          const list = structuredClone(editing ? profile.craftList || [] : plan.list);
          const old = list.find((line) => line.id === candidate.recipeId);
          if (old) old.quantity += quantity;
          else list.push({ id: candidate.recipeId, quantity });
          const choices = editing ? profile.craftChoices || {} : plan.choices || {};
          if (
            JSON.stringify(command.list) !== JSON.stringify(list) ||
            command.name !== plan.name ||
            JSON.stringify(command.choices || {}) !== JSON.stringify(choices) ||
            command.reserved !== (plan.reserved !== false) ||
            command.addGoal !== undefined
          )
            throw Error('所选计划的内容已变化，请重新核对后加入');
          validateCraftList(list);
          trustedContext.discoveryPlanId = plan.id;
          if (editing) trustedContext.discoveryEditingPlanId = plan.id;
        }
        command = { ...command };
        delete command.discovery;
      }
      if (command?.type === 'resource-priority-set') {
        const current = store.get(),
          profile = current.profiles.find((p) => p.id === current.activeProfileId);
        if (command.profileId !== profile.id) throw Error('周目已变化，请重新核对物资顺序');
        const { reference } = currentPlanningReference(profile);
        const preview = resourcePriorityPreview(profile, reference, command.order);
        if (command.fingerprint !== preview.fingerprint) throw Error('存档或计划已变化，请重新核对物资顺序');
        trustedContext.resourcePriorityFingerprint = priorityFingerprint(profile, reference);
      }
      if (
        command?.type?.startsWith('journal-entr') ||
        command?.type?.startsWith('journal-draft') ||
        command?.type?.startsWith('journal-trash-') ||
        command?.type?.startsWith('journal-revision-')
      ) {
        const current = store.get(),
          profile = current.profiles.find(
            (p) =>
              p.id ===
              (command.type === 'journal-draft-put' && command.profileId
                ? command.profileId
                : current.activeProfileId),
          );
        if (!profile) throw Error('草稿所属周目已不存在，当前编辑仍保留');
        if (command.type.startsWith('journal-revision-') && command.profileId !== profile.id)
          throw Error('周目已变化，请重新核对记录版本');
        if (command.profileId && command.profileId !== profile.id) throw Error('周目已变化，请重新打开记录');
        command = { ...command, profileId: profile.id };
        const committingDraft =
          command.type === 'journal-draft-commit'
            ? profile.journalDrafts?.find((draft) => draft.id === command.id)
            : null;
        if (
          (command.snapshotMode === 'selected' && !command.type.startsWith('journal-draft')) ||
          committingDraft?.snapshotMode === 'selected'
        ) {
          if (bridge?.busy || bridge?.loadQueued) throw Error('游戏存档操作正在进行，请稍后再附加参照');
          const scan = saves.scan(current.settings.savePath),
            mode = profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest');
          const file =
            mode === 'none'
              ? null
              : mode === 'slot'
                ? scan.files.find((f) => f.name === profile.saveSlot)
                : scan.files.find((f) => f.metadata);
          if (!file || !file.metadata || Date.now() - Date.parse(file.modifiedAt) < 1200)
            throw Error('当前存档参照不可读或正在更新，请保存后重新核对');
          const details = saves.details(current.settings.savePath, file.name);
          if (!details.metadata || Date.now() - Date.parse(details.modifiedAt) < 1200 || bridge?.busy)
            throw Error('当前存档参照正在更新或不可读，请保存后重新核对');
          trustedContext.selectedReference = { ...details, metadata: enrich(details.metadata) };
        }
      }
      if (command?.type?.startsWith('journey-')) {
        const current = store.get(),
          profile = current.profiles.find((p) => p.id === current.activeProfileId);
        if (
          ['journey-itinerary-remove', 'journey-itinerary-clear'].includes(command.type) ||
          (command.type === 'journey-trash-restore' && command.expectedTrash?.kind === 'itinerary')
        ) {
          if (command.profileId !== profile.id) throw Error('周目已变化，请重新核对本次行程');
        }
        if (
          (command.type.startsWith('journey-trash-') ||
            ['journey-itinerary-remove', 'journey-itinerary-clear'].includes(command.type)) &&
          Object.hasOwn(command, 'actionIds')
        )
          throw Error('行程命令包含未知字段');
        if (command.profileId && command.profileId !== profile.id) throw Error('周目已变化，请重新打开行程');
        command = { ...command, profileId: profile.id };
        delete command.actionIds;
        if (['journey-todo-put', 'journey-gift-put'].includes(command.type) && !command.id)
          command.id = crypto.randomUUID();
        if (command.type === 'journey-action-handle')
          command.actionIds = currentJourney(profile).actions.map((a) => a.id);
        if (
          ['journey-itinerary-add', 'journey-itinerary-place', 'journey-itinerary-continue'].includes(
            command.type,
          )
        ) {
          const plan = currentJourney(profile);
          trustedContext.journeyActions = plan.actions;
          trustedContext.journeyItinerarySteps = plan.itinerary?.steps || [];
        }
      }
      if (command?.type === 'save-slot' && command.value)
        saves.details(store.get().settings.savePath, command.value);
      if (command?.type === 'profile-add' && command.saveSlot)
        saves.details(store.get().settings.savePath, command.saveSlot);
      const previousAutoBackup = store.get().settings.autoBackup;
      const state = store.mutate(intentDraftCommit || command, trustedContext);
      if (state.settings.autoBackup !== previousAutoBackup) {
        autoBackup?.reset();
        if (state.settings.autoBackup) autoBackup?.check();
      }
      broadcast('state', state);
      companion?.update();
      return state;
    });
    handle('refresh', () => {
      connectDetectedSaves();
      return overview();
    });
    handle('journey-plan', () => {
      const data = store.get();
      return currentJourney(data.profiles.find((p) => p.id === data.activeProfileId));
    });
    handle('resource-priority-preview', (_event, profileId, order) => {
      const data = store.get(),
        profile = data.profiles.find((p) => p.id === data.activeProfileId);
      if (profileId !== profile.id) throw Error('周目已变化，请重新打开物资顺序');
      const { reference } = currentPlanningReference(profile);
      return resourcePriorityPreview(profile, reference, order);
    });
    handle('recipe-discovery', (_event, options) => {
      const data = store.get(),
        profile = data.profiles.find((p) => p.id === data.activeProfileId);
      const { reference, error } = currentPlanningReference(profile);
      const budget = resourceBudget(profile, reference, { error });
      return recipeDiscovery(profile, reference, budget, options);
    });
    handle('companion-snapshot', () => readCompanion());
    handle('companion-collapse', (event) => {
      if (owner(event) !== companion.window) throw Error('只可收起随行面板');
      releaseTimelinePreview(event.sender.id);
      return companion.collapse();
    });
    handle('health', () => health());
    handle('node-draft', (_event, id, value) => activity.draft(id, value));
    handle('quit-ready', (event, value) => {
      const accepted = quitHandoff.acknowledge(event.sender.id, value);
      if (!value.ready && owner(event) === companion.window) companion.showEdits();
      return accepted;
    });
    handle('ready', (event) => {
      rendererReady.add(event.sender.id);
      if (owner(event) === companion.window) companion.rendererReady();
      const action = pendingActions.get(event.sender.id);
      pendingActions.delete(event.sender.id);
      if (action) event.sender.send('journal:action', { action });
      return true;
    });
    handle('shortcuts-configure', (_event, value) => {
      if (quitRequested) throw Error('手札正在退出');
      shortcuts.configure(value, (next) => store.setShortcuts(next));
      broadcast('state', store.get());
      return { state: store.get(), environment: overview() };
    });
    const quickStart = new QuickStart({
      store,
      saves,
      timeline,
      bridge,
      quitting: () => quitRequested,
      confirm: async () => false,
    });
    handle('start-assistance', async (event) => {
      if (isTest) throw Error('测试环境不接入或启动实际游戏');
      if (recoveredIsolation && !store.get().settings.savePath)
        throw Error('手札刚从备份恢复，请先明确选择本机存档目录，再确认自动存档权限');
      if (quickStart.running) throw Error('正在准备游戏助手，请等待完成');
      quickStart.confirm = async () => {
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'question',
          title: '开始游戏，自动留住进度',
          message: '开始游戏时，自动留住进度？',
          detail:
            '将自动准备游戏组件，每 10 秒在游戏允许保存时留存进度；战斗、对话和菜单中暂停。以后打开手札即可沿用，无需再配置。\n\n自动保存使用 29 号手动槽。会先校验完整保护副本，并把该槽的原有进度独立收藏，再将它用于自动存档。请勿在游戏中手动覆盖 29 号槽。\n\n也可以先直接开始游戏，软件会记住你的选择；以后可在首页展开选项开启自动存档。',
          buttons: ['取消', '直接开始游戏', '开启自动存档并开始游戏'],
          defaultId: 2,
          cancelId: 0,
          noLink: true,
        });
        return answer.response === 1 ? 'launch-only' : answer.response === 2;
      };
      const result = await quickStart.start();
      if (result.cancelled) return result;
      if (!result.launchOnly) clearOperationFault();
      broadcast('state', store.get());
      await launchGame();
      return { ...result, state: store.get(), environment: overview() };
    });
    handle('bridge-install', async (event) => {
      if (isTest) throw Error('测试环境不安装游戏组件');
      const answer = await dialog.showMessageBox(owner(event), {
        type: 'question',
        title: '接入游戏存读档',
        message: '安装或更新已校验的游戏接入组件？',
        detail:
          '使用 UE4SS 官方组件接入游戏原生保存接口。会新增游戏目录下的组件文件，原游戏程序和资源包保留。请先退出游戏。\n\n安装前会建立完整存档保护副本。时间线使用 29 号手动槽，请保持这个槽专供时间线使用。',
        buttons: ['取消', '保护存档并接入'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      if (!bridge.canStop()) throw Error('请先退出游戏');
      const backup = saves.capture(store.get().settings.savePath, '游戏接入前保护副本', 'safety');
      saves.verify(backup.id);
      const installed = bridge.install();
      bridge.connect(store.get().settings.savePath);
      return { installed, backupId: backup.id, environment: overview() };
    });
    handle('bridge-disable', async (event) => {
      if (isTest) throw Error('测试环境不修改游戏组件');
      const answer = await dialog.showMessageBox(owner(event), {
        type: 'question',
        title: '停用游戏接入',
        message: '停用原生存读档组件？',
        detail: '请先退出游戏。会停用本工具新增的加载文件，时间线历史和保护副本保留。',
        buttons: ['取消', '停用组件'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      bridge.disable();
      return { environment: overview() };
    });
    handle('timeline-configure', async (event, value) => {
      if (quitRequested) throw Error('手札正在退出');
      if (
        !value ||
        typeof value.enabled !== 'boolean' ||
        ![10, 20, 30, 60, 120, 300].includes(value.interval)
      )
        throw Error('时间线设置无效');
      if (bridge.busy || bridge.loadQueued) throw Error('请等待当前存读档完成');
      if (isTest && value.enabled) throw Error('测试环境不启用游戏自动保存');
      const source = store.get().settings.savePath;
      if (value.enabled && !timeline.data.enabled) {
        const installed = bridge.installation();
        if (!installed.installed) throw Error(installed.reason);
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'question',
          title: '开启时间线自动保存',
          message: `每 ${value.interval} 秒尝试保存当前游戏进度？`,
          detail:
            '游戏运行且处于可保存状态时，使用原生接口静默保存到 29 号手动槽。提供 11 个目标时间点，最多轮换 47 份自动候选；卡片标明实际时间和偏差，偏差超限时不可用。收藏和最近一次读档前保护另存。菜单、战斗、对话和过场会跳过。\n\n开启前会建立完整保护副本。请不要在游戏中手动覆盖 29 号槽。关闭主窗口后在托盘继续自动保存，选择“退出手札”后停止。',
          buttons: ['取消', '保护存档并开启'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) return { cancelled: true };
        saves.capture(source, '开启时间线前保护副本', 'safety');
      }
      timeline.configure(source, value.enabled, value.interval);
      if (!isTest) bridge.connect(source);
      bridge.error = '';
      bridge.nextSaveAt = 0;
      if (value.enabled) clearOperationFault();
      resultFeedback('info', value.enabled ? '已开启自动保存，连接后在可保存状态下运行' : '已关闭自动保存');
      return { environment: overview() };
    });
    handle('timeline-save', async () => {
      if (isTest) throw Error('测试环境不执行游戏保存');
      if (!timeline.data.source) throw Error('请先连接存档目录');
      try {
        const record = await bridge.save();
        clearOperationFault();
        resultFeedback('success', '进度已保存并收藏 · ' + enrich({ map: record.map }).mapName, true);
        return { record, environment: overview() };
      } catch (e) {
        resultFeedback('error', '手动保存未完成：' + e.message, true);
        throw e;
      }
    });
    handle('timeline-inspect', (event, id) => {
      const result = timeline.inspect(id);
      const release = timeline.pin(id);
      releaseTimelinePreview(event.sender.id);
      timelinePreviews.set(event.sender.id, release);
      let compared;
      try {
        compared = timeline.comparison(id);
      } catch (e) {
        compared = { comparisonError: e.message };
      }
      return {
        record: result.record,
        metadata: result.metadata,
        ...compared,
        draft: activity.get().drafts[id],
        readiness: health().timeline,
      };
    });
    handle('timeline-update', (_event, id, value) => {
      const record = timeline.updateNode(id, value);
      try {
        activity.draft(id, null);
      } catch (e) {
        activity.warning = '节点已正式保存，但旧草稿暂未清除：' + e.message;
      }
      broadcast('event', { type: 'timeline', text: '' });
      return { record, environment: overview() };
    });
    handle('timeline-release', (event) => ({ released: releaseTimelinePreview(event.sender.id) }));
    handle('timeline-recover', () => {
      if (isTest) throw Error('测试环境不核对实际游戏接入');
      bridge.recover();
      clearOperationFault();
      return { environment: overview() };
    });
    handle('timeline-load', async (event, id) => {
      if (isTest) throw Error('测试环境不执行游戏读档');
      const release = timeline.pin(id);
      try {
        const checkpoint = timeline.inspect(id);
        bridge.assertReady();
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'warning',
          title: '读回历史进度',
          message: `读回 ${new Date(checkpoint.record.at).toLocaleString('zh-CN')} 的进度？`,
          detail: `场景：${checkpoint.metadata.mapName}。\n\n会先通过游戏接口保存当前进度，并建立经过校验的完整保护副本，再读入这个历史节点。你可以从“返回读档前进度”中读回刚才的进度。`,
          buttons: ['取消', '保护当前进度并读档'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) return { cancelled: true };
        const result = await bridge.loadConfirmed(id, () => {
          const backup = saves.capture(store.get().settings.savePath, '时间线读档前完整保护', 'safety');
          saves.verify(backup.id);
          return backup;
        });
        resultFeedback('success', '已读回历史进度 · ' + enrich({ map: result.record.map }).mapName);
        return { ...result, environment: overview() };
      } finally {
        release();
      }
    });
    handle('help', () =>
      fs.readFileSync(path.join(__dirname, '..', '使用说明.txt'), 'utf8').replace(/^\uFEFF/, ''),
    );
    handle('save-details', (_event, name, recipeId) => {
      const state = store.get(),
        p = state.profiles.find((p) => p.id === state.activeProfileId);
      const file = saves.details(state.settings.savePath, name);
      const bound = { ...p, referenceMode: 'slot', saveSlot: file.name };
      return {
        ...file,
        planning: recipeId ? recipeBudget(bound, file, recipeId) : resourceBudget(bound, file),
      };
    });
    handle('compare-saves', (_event, leftName, rightName) =>
      saves.compare(store.get().settings.savePath, leftName, rightName),
    );
    handle('recipe-plan', (_event, id, quantity, saveName) => {
      const ref = saveName ? saves.details(store.get().settings.savePath, saveName) : null;
      const current = store.get().profiles.find((p) => p.id === store.get().activeProfileId);
      // A picker is an explicit read-only reference for this report. It does
      // not change the profile's default reference or game permissions.
      const p = { ...current, referenceMode: ref ? 'slot' : 'none', saveSlot: ref?.name || '' };
      const budget = recipeBudget(p, ref, id);
      const result = recipePlan(id, quantity, subtractBudget(ref?.metadata.inventory, budget.totals));
      if (ref)
        result.reference = {
          name: ref.name,
          modifiedAt: ref.modifiedAt,
          mapName: ref.metadata.mapName,
          money: ref.metadata.money,
          inventoryAvailable: Array.isArray(ref.metadata.inventory),
          hash: ref.hash,
        };
      return result;
    });
    handle('material-plan', (_event, list, saveName) => {
      validateCraftList(list);
      const ref = saveName ? saves.details(store.get().settings.savePath, saveName) : null;
      const current = store.get().profiles.find((p) => p.id === store.get().activeProfileId);
      const p = { ...current, referenceMode: ref ? 'slot' : 'none', saveSlot: ref?.name || '' };
      return materialReport(p, ref, list);
    });
    handle('backup', (_event, label) => {
      const result = saves.capture(store.get().settings.savePath, label);
      autoBackup?.accept(result);
      broadcast('event', { type: 'backup', text: '存档备份完成，校验通过' });
      return { id: result.id, count: result.files.length, environment: overview() };
    });
    handle('verify-backup', (_event, id) => {
      const { manifest } = checkedBackup(id, () => saves.verify(id));
      return { count: manifest.files.length, label: manifest.label };
    });
    handle('inspect-backup', (_event, id) =>
      checkedBackup(id, () => saves.inspect(id, store.get().settings.savePath)),
    );
    handle('rename-backup', (_event, id, label) => {
      const result = saves.rename(id, label);
      return { ...result, environment: overview() };
    });
    handle('open-backup', async (_event, id) => {
      const directory = saves.directory(id);
      const error = await shell.openPath(directory);
      if (error) throw Error(error);
      return true;
    });
    handle('recover-restore', async (event) => {
      const recovery = saves.pendingRestore();
      if (!recovery) throw Error('没有需要处理的中断恢复');
      if (recovery.error) throw Error(recovery.error);
      if (!bridge.canStop()) throw Error('请先退出逸剑风云决再处理');
      const answer = await dialog.showMessageBox(owner(event), {
        type: 'warning',
        title: '处理上次中断的恢复',
        message: '回退到上次恢复开始前的存档？',
        detail: `上次恢复在 ${recovery.createdAt} 中断。将使用已校验的安全副本回退可能写入的 ${recovery.count} 个文件。\n\n目标目录：${recovery.source}\n\n若发现中断后又产生的新修改，会停止回退以保留新进度。`,
        buttons: ['取消', '核对文件并回退'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      const result = saves.recoverRestore(() => bridge.canStop());
      broadcast('event', { type: 'backup', text: '已回退中断的恢复，安全副本仍然保留' });
      return { ...result, environment: overview() };
    });
    handle('restore', async (event, id) => {
      const { manifest } = checkedBackup(id, () => saves.verify(id));
      if (!bridge.canStop()) throw new Error('请先退出逸剑风云决，再恢复存档');
      const answer = await dialog.showMessageBox(owner(event), {
        type: 'warning',
        title: '恢复这份游戏存档？',
        message: `恢复「${manifest.label}」`,
        detail: `将覆盖当前存档目录中的 ${manifest.files.length} 个同名文件。恢复前会自动建立并校验安全副本，其他文件会保留。\n\n请确认游戏已退出、Steam 云同步已完成。恢复后若 Steam 提示冲突，请核对时间再选择本地存档。`,
        buttons: ['取消', '备份当前存档并恢复'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      const result = saves.restore(id, store.get().settings.savePath, () => bridge.canStop());
      broadcast('event', { type: 'backup', text: '存档恢复完成，恢复前副本已保留' });
      return { ...result, environment: overview() };
    });
    handle('choose-saves', async (event) => {
      assertSaveSelectionReady();
      const localRoot = isTest
        ? app.getPath('userData')
        : process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
      const defaultPath = [
        store.get().settings.savePath,
        path.join(localRoot, 'Wandering_Sword', 'Saved'),
        isTest ? app.getPath('userData') : app.getPath('home'),
      ].find((folder) => folder && fs.existsSync(folder));
      const selected = await dialog.showOpenDialog(owner(event), {
        title: '选择逸剑风云决 SaveGames 文件夹',
        properties: ['openDirectory'],
        defaultPath,
      });
      if (selected.canceled) return { cancelled: true };
      assertSaveSelectionReady();
      const root = timeline.validateSource(selected.filePaths[0]);
      listFiles(root);
      if (!timeline.error) timeline.configure(root, false, timeline.data.interval);
      const state = store.setPath('savePath', root);
      if (!isTest && !timeline.error) {
        try {
          bridge.connect(root);
          bridge.error = '';
        } catch (e) {
          bridge.error = timeline.data.enabled ? e.message : '';
        }
      }
      autoBackup?.reset();
      autoBackup?.check();
      broadcast('state', state);
      return { state, environment: overview() };
    });
    handle('use-detected-saves', (_event, value) => {
      assertSaveSelectionReady();
      if (!detected().includes(value)) throw new Error('不是已检测到的存档目录');
      const root = timeline.validateSource(value);
      listFiles(root);
      if (!timeline.error) timeline.configure(root, false, timeline.data.interval);
      const state = store.setPath('savePath', value);
      if (!timeline.error) {
        try {
          bridge.connect(root);
          bridge.error = '';
        } catch (e) {
          bridge.error = timeline.data.enabled ? e.message : '';
        }
      }
      autoBackup?.reset();
      autoBackup?.check();
      broadcast('state', state);
      return { state, environment: overview() };
    });
    handle('open-folder', async (_event, type) => {
      const folders = {
        data: app.getPath('userData'),
        backups: saves.root,
        saves: store.get().settings.savePath,
        game: game.path,
        timeline: timeline.root,
      };
      if (!Object.hasOwn(folders, type) || !folders[type]) throw new Error('目录尚未找到');
      const error = await shell.openPath(folders[type]);
      if (error) throw new Error(error);
      return true;
    });
    handle('protection-list', () => protectionArchives.list());
    handle('protection-history', (_event, id) =>
      protectionJob('正在校验离线档案', () => protectionArchives.history(id, store)),
    );
    handle('protection-inspect', (_event, id, type, recordId, name) =>
      protectionJob('正在读取历史存档', () => protectionArchives.inspect(id, type, recordId, name)),
    );
    handle('protection-export', (event) =>
      protectionJob('正在导出本机保护资料', async () => {
        if (pendingBackupCare({ saves }).some((p) => p.blocking !== false))
          throw Error('请先在存档匣处理未完成的副本清理，再导出全部保护资料');
        const selected = await dialog.showSaveDialog(owner(event), {
          title: '导出手札、完整备份、时间线与全部历史档案',
          defaultPath: path.join(
            isTest ? app.getPath('userData') : app.getPath('documents'),
            `逸剑保护资料-${new Date().toISOString().replace(/[:.]/g, '-')}.yijian-protection`,
          ),
          filters: [{ name: '逸剑离线保护包', extensions: ['yijian-protection'] }],
        });
        if (selected.canceled) return { cancelled: true };
        protectionArchives.assertSeparated(selected.filePath);
        let result;
        try {
          const options = {
            archives: protectionArchives,
            dataRoot: app.getPath('userData'),
            file: selected.filePath,
            recordResult: true,
          };
          try {
            result = await exportComplete(options);
          } catch (error) {
            if (error.code !== 'HISTORY_EXPORT_CONFIRMATION_REQUIRED') throw error;
            const failed = error.failedArchives;
            const answer = await dialog.showMessageBox(owner(event), {
              type: 'warning',
              title: '部分历史档案无法校验',
              message: `本次仅带走已校验资料，保留 ${failed.length} 份异常历史档案在本机？`,
              detail:
                failed
                  .map((archive) => `「${archive.label}」\n${archive.id}\n${archive.reason}`)
                  .join('\n\n') +
                '\n\n这些档案的完整性尚未确认，本次导出不会包含它们。当前手札、完整备份、时间线与其余已校验历史会重新校验后导出。异常原件不会改写或删除；换机前请另外保留本机原始数据目录，并用完好的原保护包恢复。取消不会发布任何保护包。',
              buttons: ['取消，保留全部原件', '导出已校验资料，异常原件留在本机'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            if (answer.response !== 1)
              return { cancelled: true, exportResult: protectionExportReceipt(error.exportResult) };
            result = await exportComplete({
              ...options,
              excludedArchiveIds: failed.map((archive) => archive.id),
              confirmationToken: error.confirmationToken,
            });
          }
        } catch (e) {
          if (['EPERM', 'ENOTSUP', 'ENOSYS'].includes(e.code))
            throw Object.assign(e, {
              message: '此磁盘不支持安全发布保护包，请导出到本机 NTFS 磁盘后再复制。已有文件未覆盖。',
            });
          throw e;
        }
        resultFeedback(
          'info',
          `离线保护资料已校验：本机 ${result.backups.length} 份完整备份、${result.nodes} 个时间线节点${result.historicalArchives ? `，及 ${result.historicalArchives} 份历史档案` : ''}${result.volumes > 1 ? `。共 ${result.volumes} 卷，请一并带走目录 ${result.file}` : ''}${result.omittedArchives?.length ? `。本次未包含 ${result.omittedArchives.length} 份异常历史档案，原件仍在本机；换机前请另行保留原始数据目录。` : ''}`,
        );
        return result;
      }),
    );
    handle('backup-lock', (event, id, locked) =>
      protectionJob('正在调整副本锁定', async () => {
        if (typeof locked !== 'boolean') throw Error('副本锁定状态无效');
        const backup = saves.list().find((b) => b.id === id);
        if (!backup) throw Error('完整备份已不存在');
        if (!locked && backup.locked) {
          const answer = await dialog.showMessageBox(owner(event), {
            type: 'warning',
            title: '解锁完整备份',
            message: '解锁「' + backup.label + '」？',
            detail:
              '解锁后可以选择导出并清理这份本机副本。当前副本和游戏进度继续保留，解锁本身不会删除文件。',
            buttons: ['取消', '解锁这份副本'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (answer.response !== 1) return { cancelled: true };
        }
        const result = setBackupLock({ saves, id, locked });
        return { ...result, environment: overview() };
      }),
    );
    handle('backup-cleanup', (event, ids) =>
      protectionJob('正在导出并核对所选副本', async () => {
        if (
          saves.busy ||
          saves.pendingRestore() ||
          pendingBackupCare({ saves }).some((p) => p.blocking !== false)
        )
          throw Error('请先完成当前存档恢复或副本清理');
        const available = new Map(saves.list().map((b) => [b.id, b]));
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 1000 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== 'string' || !available.has(id))
        )
          throw Error('请选择 1 至 1000 份仍在本机的完整备份');
        const backups = ids.map((id) => available.get(id));
        if (backups.some((b) => b.locked))
          throw Error('所选副本含已锁定的保护记录，请先取消选择或逐份明确解锁');
        const selected = await dialog.showSaveDialog(owner(event), {
          title: '先导出所选副本，再确认清理',
          defaultPath: path.join(
            isTest ? app.getPath('userData') : app.getPath('documents'),
            '逸剑清理留底-' + Date.now() + '.yijian-protection',
          ),
          filters: [{ name: '逸剑离线保护包', extensions: ['yijian-protection'] }],
        });
        if (selected.canceled) return { cancelled: true };
        protectionArchives.assertSeparated(selected.filePath);
        const exported = await exportProtection({
          dataRoot: app.getPath('userData'),
          file: selected.filePath,
          backupIds: ids,
          includeTimeline: false,
        });
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'warning',
          title: '保护包已校验，确认清理所选副本',
          message: '清理这 ' + backups.length + ' 份本机完整备份？',
          detail:
            '已导出并校验：' +
            exported.file +
            '\n\n仅删除以下所选副本，游戏存档、其他备份、时间线、离线档案和导出保护包继续保留。删除后需要导入上述保护包才能恢复这些副本。\n\n' +
            backups.map((b) => b.label + ' · ' + b.createdAt + ' · ' + b.count + ' 个文件').join('\n'),
          buttons: ['保留本机副本', '清理所列副本'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1)
          return { cancelled: true, exported: true, file: exported.file, environment: overview() };
        for (const id of ids) autoBackup?.forget(id);
        const result = await cleanupExportedBackups({
          saves,
          ids,
          packageFile: exported.file,
          expectedPackageHash: exported.packageHash,
        });
        autoBackup?.check();
        resultFeedback('info', '所选 ' + result.count + ' 份完整备份已导出留底并清理');
        return { ...result, file: exported.file, environment: overview() };
      }),
    );
    handle('backup-cleanup-recover', (event, id, mode) =>
      protectionJob('正在核对未完成的副本清理', async () => {
        const pending = pendingBackupCare({ saves }).find((p) => p.id === id);
        if (
          !pending ||
          pending.error ||
          pending.blocking === false ||
          (mode === 'finish' && pending.canFinish === false) ||
          !['rollback', 'finish'].includes(mode)
        )
          throw Error('副本清理状态无法操作，请保留管理目录并重新核对');
        let result;
        if (mode === 'rollback') {
          if (!pending.canRollback) throw Error('副本已开始删除，请选择原保护包继续完成');
          result = rollbackBackupCare({ saves, id });
        } else {
          const selected = await dialog.showOpenDialog(owner(event), {
            title: '选择这次清理留底的原保护包',
            properties: ['openFile'],
            filters: [{ name: '逸剑离线保护包', extensions: ['yijian-protection'] }],
          });
          if (selected.canceled) return { cancelled: true };
          const file = selected.filePaths[0];
          protectionArchives.assertSeparated(file);
          const verified = await readProtectionIndex({ file });
          if (verified.packageHash !== pending.packageHash)
            throw Error('这不是原先确认的保护包，请重新选择，暂存副本继续保留');
          const answer = await dialog.showMessageBox(owner(event), {
            type: 'warning',
            title: '继续未完成的副本清理',
            message: '原保护包已校验，继续清理这 ' + pending.ids.length + ' 份副本？',
            detail:
              pending.backups.map((b) => b.label + ' · ' + b.createdAt).join('\n') +
              '\n\n导出保护包和游戏存档继续保留。',
            buttons: ['取消', '继续所列清理'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (answer.response !== 1) return { cancelled: true };
          result = await finishBackupCare({
            saves,
            id,
            packageFile: file,
            expectedPackageHash: pending.packageHash,
          });
        }
        if (result.phase === 'complete') for (const backupId of result.ids) autoBackup?.forget(backupId);
        autoBackup?.check();
        return { ...result, environment: overview() };
      }),
    );
    handle('protection-selected-export', (event, ids) =>
      protectionJob('正在导出所选完整备份', async () => {
        const available = new Set(saves.list().map((b) => b.id));
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 1000 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== 'string' || !available.has(id))
        )
          throw Error('请选择 1 至 1000 份仍在本机的完整备份');
        if (pendingBackupCare({ saves }).some((p) => p.blocking !== false))
          throw Error('请先在存档匣处理未完成的副本清理，再导出保护资料');
        const selected = await dialog.showSaveDialog(owner(event), {
          title: `导出全部手札与所选 ${ids.length} 份完整备份`,
          defaultPath: path.join(
            isTest ? app.getPath('userData') : app.getPath('documents'),
            `逸剑备份选集-${Date.now()}.yijian-protection`,
          ),
          filters: [{ name: '逸剑离线保护包', extensions: ['yijian-protection'] }],
        });
        if (selected.canceled) return { cancelled: true };
        protectionArchives.assertSeparated(selected.filePath);
        const result = await exportProtection({
          dataRoot: app.getPath('userData'),
          file: selected.filePath,
          backupIds: ids,
          includeTimeline: false,
        });
        resultFeedback('info', `所选 ${result.backups.length} 份完整备份和手札已校验并导出，原副本保留`);
        return result;
      }),
    );
    handle('protection-history-export', (event, id) =>
      protectionJob('正在导出历史保护资料', async () => {
        await protectionArchives.history(id, store);
        const selected = await dialog.showSaveDialog(owner(event), {
          title: '导出这份离线档案',
          defaultPath: path.join(
            isTest ? app.getPath('userData') : app.getPath('documents'),
            `逸剑历史保护-${id}-${Date.now()}.yijian-protection`,
          ),
          filters: [{ name: '逸剑离线保护包', extensions: ['yijian-protection'] }],
        });
        if (selected.canceled) return { cancelled: true };
        try {
          return await protectionArchives.export(id, selected.filePath);
        } catch (e) {
          if (['EPERM', 'ENOTSUP', 'ENOSYS'].includes(e.code))
            throw Error('请导出到本机 NTFS 磁盘后再复制。已有文件未覆盖。');
          throw e;
        }
      }),
    );
    handle('protection-import', (event, mode = 'files') =>
      protectionJob('正在校验并导入保护资料', async () => {
        if (!['files', 'directory'].includes(mode)) throw Error('保护资料导入方式无效');
        const selected = await dialog.showOpenDialog(owner(event), {
          title: mode === 'directory' ? '选择完整的换机分卷目录' : '导入保护包，可同时选择多份',
          properties: mode === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
          filters: [{ name: '逸剑离线保护包', extensions: ['yijian-protection'] }],
        });
        if (selected.canceled) return { cancelled: true };
        const files =
            mode === 'directory'
              ? await volumeFiles({ archives: protectionArchives, directory: selected.filePaths[0] })
              : selected.filePaths,
          preview = await previewCompleteSet({ archives: protectionArchives, files });
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'question',
          title: '导入离线保护资料',
          message: `从 ${preview.volumes} 份保护包保存 ${preview.profiles.length} 个周目、${preview.backups.length} 份完整备份和 ${preview.nodes} 个历史节点${preview.historicalArchives ? `，以及 ${preview.historicalArchives} 份补充历史档案` : ''}？`,
          detail: `会另建只读离线档案，不替换当前手札和游戏存档。保留 ${preview.bookmarks} 个书签及节点说明。${preview.historicalArchives ? `另有历史完整备份 ${preview.historicalBackups} 份、时间线节点 ${preview.historicalNodes} 个、书签 ${preview.historicalBookmarks} 个，一并导入。` : ''}重复档案经完整校验后沿用；未通过校验的旧档案会原样保留，从本次完好保护包另存可用副本。旧机器的存档目录、账户和自动存读档权限不会启用。\n\n导入后可以浏览记录，再分别确认使用手札或恢复完整备份。保护包含私人游戏进度，请妥善保管。`,
          buttons: ['取消', '保存离线档案'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) return { cancelled: true };
        const result = await importCompleteSet({ archives: protectionArchives, files, preview });
        const retainedUnverifiedArchives = result.retainedUnverifiedArchives || [];
        resultFeedback(
          'info',
          '离线保护资料已校验并保存，当前游戏进度未改动' +
            (retainedUnverifiedArchives.length
              ? `；${retainedUnverifiedArchives.length} 份未通过校验的旧档案原样保留，已从完好保护包另存可用档案`
              : ''),
        );
        return {
          id: result.id,
          archives: protectionArchives.list(),
          historicalArchives: result.historicalArchives || 0,
          reusedArchives: result.reusedArchives || 0,
          retainedUnverifiedArchives,
        };
      }),
    );
    handle('protection-use-journal', (event, id) =>
      protectionJob('正在核对历史手札', async () => {
        const history = await protectionArchives.history(id, store);
        if (!history.compatible) throw Error('历史手札与当前资料不兼容：' + history.compatibilityError);
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'question',
          title: '使用这份历史手札',
          message: `用离线档案的 ${history.journal.profiles.length} 个周目替换当前手札？`,
          detail:
            '当前手札会另存保护副本。本机路径、显示设置与备份开关继续使用当前设置；历史周目暂不绑定本机存档，可在周目管理中选择参照。游戏文件和时间线权限不会改变。',
          buttons: ['取消', '保留当前副本并使用'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) return { cancelled: true };
        const checked = await protectionArchives.history(id, store);
        if (!checked.compatible) throw Error('历史手札已变化，请重新核对');
        const state = store.importData(checked.journal);
        broadcast('state', state);
        return { state };
      }),
    );
    handle('protection-restore', (event, id, backupId) =>
      protectionJob('正在准备迁移备份恢复', async () => {
        if (
          bridge.busy ||
          bridge.loadQueued ||
          bridge.quiescing ||
          timeline.data.pending ||
          saves.busy ||
          saves.pendingRestore()
        )
          throw Error('请先完成或核对当前存读档操作');
        if (!bridge.canStop()) throw Error('请先退出逸剑风云决，再恢复迁移备份');
        const source = realDirectory(store.get().settings.savePath);
        const history = await protectionArchives.history(id, store),
          backup = history.backups.find((b) => b.id === backupId);
        if (!backup) throw Error('历史完整备份不存在');
        const answer = await dialog.showMessageBox(owner(event), {
          type: 'warning',
          title: '将历史备份恢复到本机',
          message: `恢复「${backup.label}」到当前连接的存档目录？`,
          detail: `将覆盖 ${backup.files.length} 个同名文件：${backup.files.map((f) => f.name).join('、')}。其他文件保留。\n\n目标目录：${source}\n\n会先建立并校验当前完整存档的安全副本，再恢复历史字节。请确认游戏已退出、Steam 云同步已完成，且这是要恢复的游戏账户。历史槽位权限不会用于原生读档；恢复后仍需在游戏内选择存档。`,
          buttons: ['取消', '保护当前进度并恢复'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) return { cancelled: true };
        const bound = await protectionArchives.prepareRecovery(id, backupId, saves, source, () =>
          bridge.canStop(),
        );
        const result = saves.restore(bound.id, source, () => bridge.canStop());
        broadcast('event', { type: 'backup', text: '历史备份恢复完成，当前进度安全副本已保留' });
        return { ...result, environment: overview() };
      }),
    );
    handle('export', async (event) => {
      const result = await dialog.showSaveDialog(owner(event), {
        title: '导出全部手札与周目',
        defaultPath: `逸剑手札-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: '手札备份', extensions: ['json'] }],
      });
      if (result.canceled) return { cancelled: true };
      const data = store.get();
      data.settings.savePath = '';
      data.settings.steamPath = '';
      data.settings.autoBackup = false;
      fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { path: result.filePath };
    });
    handle('import', async (event) => {
      const result = await dialog.showOpenDialog(owner(event), {
        title: '导入手札备份',
        properties: ['openFile'],
        filters: [{ name: '手札备份', extensions: ['json'] }],
      });
      if (result.canceled) return { cancelled: true };
      const file = result.filePaths[0];
      if (fs.statSync(file).size > MAX_JOURNAL_BYTES) throw new Error('手札文件超过 32 MB，请确认选择正确');
      let incoming;
      try {
        incoming = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        throw Error(
          '这份手札文件无法读取，当前记录未改动。请重新选择由手札导出的 JSON 文件，或使用之前导出的副本。',
        );
      }
      const { validateState } = require('./core/store.cjs');
      validateState(incoming, store.ids);
      const resetReferences = incoming.profiles.filter((p) => p.referenceMode === 'slot').length;
      const answer = await dialog.showMessageBox(owner(event), {
        type: 'question',
        title: '导入手札',
        message: '用备份中的手札替换当前记录？',
        detail: `备份包含 ${incoming.profiles.length} 个周目。当前手札会另存一份，游戏存档不会改动。${resetReferences ? `\n\n其中 ${resetReferences} 个周目的固定存档参照会改为跟随本机最新保存，避免套用其他账户的槽位；导入后可在周目管理中重新选择固定参照。` : ''}`,
        buttons: ['取消', '保留副本并导入'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      const state = store.importData(incoming);
      broadcast('state', state);
      return { state, resetReferences };
    });
    handle('source', async (_event, id) => {
      const source = catalog.sources.find((x) => x.id === id);
      if (!source || new URL(source.url).protocol !== 'https:') throw new Error('资料来源不存在');
      await shell.openExternal(source.url);
      return true;
    });
    handle('launch-game', launchGame);
    handle('compact', () => toggleCompact());
    handle('window', (event, action) => {
      const w = owner(event);
      if (action === 'minimize') w.minimize();
      else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
      else if (action === 'close') w.close();
      else if (action === 'main') {
        if (w === companion.window) companion.collapse(false);
        showMain();
      } else if (action === 'quit') requestQuit();
      else throw new Error('窗口操作无效');
      return true;
    });
    windowMonitor = new GameWindow(
      app.isPackaged
        ? path.join(process.resourcesPath, 'YijianWindow.exe')
        : path.join(__dirname, '..', '.build', 'YijianWindow.exe'),
      !isTest && game.path
        ? path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64', 'JH-Win64-Shipping.exe')
        : null,
    );
    companion = new CompanionWindow({
      create: () => makeWindow(true),
      monitor: windowMonitor,
      screen,
      settings: () => store.get().settings,
      test: isTest,
      quiet: () => bridge.hintQuiet(),
    });
    showMain();
    startupRecoveryActive = false;
    if (!isTest) windowMonitor.start();
    if (!isTest) shortcutReady = globalShortcut.register('CommandOrControl+Alt+J', toggleCompact);
    shortcuts = new Shortcuts(
      globalShortcut,
      { save: quickSave, history: () => sendAction('history') },
      !isTest,
    );
    shortcuts.start(store.get().settings.shortcuts || DEFAULT_SHORTCUTS);
    createTray();
    autoBackup = new AutoBackup(store, saves, (event) => broadcast('event', event), {
      ...(isTest && process.env.YIJIAN_TEST_AUTO_FAST ? { intervalMs: 150, settleMs: 100 } : {}),
      // Connected native checkpoints change slot 29 frequently. While waiting
      // for the game, keep protecting saved files and incoming cloud progress.
      isBlocked: autoBackupBlocked,
    });
    autoBackup.start();
    bridge.start();
    if (!isTest && process.argv.includes('--guard-game'))
      launchGame().catch((e) => resultFeedback('error', e.message, true));
  } catch (e) {
    dialog.showErrorBox('逸剑手札无法启动', e.message);
    app.quit();
  }
});
app.on('window-all-closed', () => {
  if (startupRecoveryActive) return;
  if (!tray || quitGranted) app.quit();
});
app.on('before-quit', (event) => {
  if (!quitGranted && bridge) {
    event.preventDefault();
    requestQuit();
  }
});
app.on('will-quit', () => {
  clearInterval(trayTimer);
  tray?.destroy();
  autoBackup?.dispose();
  bridge?.dispose();
  companion?.dispose();
  globalShortcut.unregisterAll();
});
