'use strict';
const { materialPlan, validateCraftList } = require('./core/material-plan.cjs');
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
const { Saves, discoverSaveFolders, realDirectory, listFiles } = require('./core/saves.cjs');
const { detectGame, gameStopped } = require('./core/environment.cjs');
const { encyclopedia, recipePlan, enrich } = require('./core/game-data.cjs');
const { AutoBackup } = require('./core/auto-backup.cjs');
const { Timeline } = require('./core/timeline.cjs');
const { GameBridge } = require('./core/game-bridge.cjs');
const { Shortcuts, DEFAULTS: DEFAULT_SHORTCUTS } = require('./core/shortcuts.cjs');
const { Activity } = require('./core/activity.cjs');
const { availableInventory } = require('./core/reservations.cjs');
const { GameWindow } = require('./core/game-window.cjs');
const { CompanionWindow } = require('./core/companion-window.cjs');
const { companionSnapshot } = require('./core/companion.cjs');
let companion, windowMonitor;
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
  await shell.openExternal('steam://rungameid/1876890');
  resultFeedback(
    'info',
    timeline.data.enabled ? '已启动游戏，连接后继续自动保存' : '已启动游戏；自动保存尚未开启，可在存档匣开启',
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
let tray,
  shortcuts,
  trayTimer,
  quitRequested = false,
  quitGranted = false,
  quitPromise;
const rendererReady = new Set(),
  pendingActions = new Map();
const backgroundAllowed = !isTest || process.env.YIJIAN_TEST_TRAY === '1';
function health() {
  const t = bridge?.summary();
  const fault = activity?.get().fault;
  if (t && !t.enabled && !t.error && fault) t.error = fault.message;
  return {
    timeline: t && {
      enabled: t.enabled,
      busy: t.busy,
      ready: t.ready,
      connected: t.connected,
      error: t.error,
      reason: t.reason,
      pending: !!t.pending,
      latest: t.latest,
      quiescing: quitRequested || t.quiescing,
    },
    background: !!tray,
    operation: activity?.get().events[0] || null,
    quitting: quitRequested,
    backupStatus: !store?.get().settings.autoBackup
      ? 'disabled'
      : bridge?.busy || bridge?.loadQueued || timeline?.data.enabled || quitRequested
        ? 'paused'
        : autoBackup?.error
          ? 'error'
          : 'watching',
  };
}
function timelineStatus(t) {
  return quitRequested
    ? '等待存读档结束后退出'
    : t?.error
      ? '自动保存已停止'
      : t?.busy
        ? '正在存读档'
        : !t?.enabled
          ? '自动保存已关闭'
          : !t.connected
            ? '等待游戏连接'
            : !t.ready
              ? '暂时暂停'
              : '自动保存中';
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
  const t = health().timeline,
    status = timelineStatus(t);
  const colour = t?.error || t?.pending ? '#df514b' : t?.enabled && t?.ready ? '#2aa66e' : '#dda83c';
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
      (t?.latest ? '\n最近保存 ' + new Date(t.latest.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开逸剑手札', click: () => showMain() },
      { label: status, enabled: false },
      { label: t?.reason || '等待连接', enabled: false },
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
      await bridge?.quiesce();
      quitGranted = true;
      app.quit();
    } catch (e) {
      quitRequested = false;
      quitGranted = false;
      if (bridge) bridge.quiescing = false;
      quitPromise = null;
      showMain();
      broadcast('event', { type: 'error', text: e.message });
      updateTray();
    }
  })();
  return quitPromise;
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
    // Respect unfinished renderer edits. A cancelled Electron quit does not reject app.quit().
    // The scheduler has already drained; release its latch so a later explicit quit can retry.
    quitRequested = false;
    quitGranted = false;
    quitPromise = null;
    if (bridge) bridge.quiescing = false;
    showMain();
    broadcast('event', { type: 'health', health: health() });
    updateTray();
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
function overview() {
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
  let recent = null;
  if (latest)
    try {
      const file = saves.details(configured, latest.name),
        m = file.metadata;
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
    } catch {}
  return {
    game,
    saves: scan,
    recent,
    preferredSave: preferred,
    preferredSaveMissing: !!preferred && !latest,
    backups: saves.list(),
    recovery: saves.pendingRestore(),
    detected: detected(),
    userData: app.getPath('userData'),
    backupRoot: saves.root,
    warning: store.warning,
    autoError: autoBackup?.error || '',
    timeline: bridge && { ...bridge.summary(), ...health().timeline },
    shortcutReady,
    shortcuts: shortcuts?.summary(state.settings.shortcuts || DEFAULT_SHORTCUTS),
    health: health(),
    activity: activity?.get(),
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
      return { ok: true, data: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, error: e.message || '操作未完成，请重试' };
    }
  });
}
function owner(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}
app.whenReady().then(() => {
  if (!ownsInstance) return;
  try {
    store = new Store(app.getPath('userData'), catalog);
    activity = new Activity(app.getPath('userData'));
    saves = new Saves(path.join(app.getPath('userData'), 'save-backups'));
    game = isTest ? { installed: false, path: '', build: '' } : detectGame();
    const folders = detected();
    if (!store.get().settings.savePath && folders.length === 1) store.setPath('savePath', folders[0]);
    timeline = new Timeline(path.join(app.getPath('userData'), 'game-timeline'));
    if (!timeline.data.source && store.get().settings.savePath && !timeline.error)
      timeline.configure(store.get().settings.savePath, false, 10);
    const bridgeRoot =
      isTest || !game.installed
        ? path.join(app.getPath('userData'), 'game-bridge')
        : path.join(game.path, 'Wandering_Sword', 'Binaries', 'Win64', 'ue4ss', 'YijianJournal');
    bridge = new GameBridge(bridgeRoot, timeline, {
      getGame: () => (isTest ? game : detectGame()),
      stopped: gameStopped,
      blocked: () => !!saves.pendingRestore(),
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
      if (command?.type === 'save-slot' && command.value)
        saves.details(store.get().settings.savePath, command.value);
      if (command?.type === 'profile-add' && command.saveSlot)
        saves.details(store.get().settings.savePath, command.saveSlot);
      const state = store.mutate(command);
      broadcast('state', state);
      companion?.update();
      return state;
    });
    handle('refresh', () => overview());
    handle('companion-snapshot', () => readCompanion());
    handle('companion-collapse', (event) => {
      if (owner(event) !== companion.window) throw Error('只可收起随行面板');
      releaseTimelinePreview(event.sender.id);
      return companion.collapse();
    });
    handle('health', () => health());
    handle('node-draft', (_event, id, value) => activity.draft(id, value));
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
    handle('save-details', (_event, name) => saves.details(store.get().settings.savePath, name));
    handle('compare-saves', (_event, leftName, rightName) =>
      saves.compare(store.get().settings.savePath, leftName, rightName),
    );
    handle('recipe-plan', (_event, id, quantity, saveName) => {
      const ref = saveName ? saves.details(store.get().settings.savePath, saveName) : null;
      const p = store.get().profiles.find((p) => p.id === store.get().activeProfileId);
      const result = recipePlan(id, quantity, availableInventory(ref?.metadata.inventory, p.reservations));
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
      const p = store.get().profiles.find((p) => p.id === store.get().activeProfileId);
      const result = materialPlan(list, ref?.metadata || null, p.reservations || {});
      if (ref)
        result.reference = {
          name: ref.name,
          hash: ref.hash,
          modifiedAt: ref.modifiedAt,
          mapName: ref.metadata.mapName,
        };
      return result;
    });
    handle('backup', (_event, label) => {
      const result = saves.capture(store.get().settings.savePath, label);
      broadcast('event', { type: 'backup', text: '存档备份完成，校验通过' });
      return { id: result.id, count: result.files.length, environment: overview() };
    });
    handle('verify-backup', (_event, id) => {
      const { manifest } = saves.verify(id);
      return { count: manifest.files.length, label: manifest.label };
    });
    handle('inspect-backup', (_event, id) => saves.inspect(id, store.get().settings.savePath));
    handle('rename-backup', (_event, id, label) => {
      const result = saves.rename(id, label);
      return { ...result, environment: overview() };
    });
    handle('open-backup', async (_event, id) => {
      saves.verify(id);
      const error = await shell.openPath(path.join(saves.root, id));
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
      const { manifest } = saves.verify(id);
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
      if (bridge.busy || bridge.loadQueued || timeline.data.pending) throw Error('请先完成或核对时间线操作');
      const selected = await dialog.showOpenDialog(owner(event), {
        title: '选择逸剑风云决 SaveGames 文件夹',
        properties: ['openDirectory'],
        defaultPath: store.get().settings.savePath || app.getPath('home'),
      });
      if (selected.canceled) return { cancelled: true };
      const root = realDirectory(selected.filePaths[0]);
      listFiles(root);
      timeline.configure(root, false, timeline.data.interval);
      const state = store.setPath('savePath', root);
      if (!isTest) {
        try {
          bridge.connect(root);
          bridge.error = '';
        } catch (e) {
          bridge.error = e.message;
        }
      }
      autoBackup?.reset();
      broadcast('state', state);
      return { state, environment: overview() };
    });
    handle('use-detected-saves', (_event, value) => {
      if (bridge.busy || bridge.loadQueued || timeline.data.pending) throw Error('请先完成或核对时间线操作');
      if (!detected().includes(value)) throw new Error('不是已检测到的存档目录');
      timeline.configure(value, false, timeline.data.interval);
      const state = store.setPath('savePath', value);
      try {
        bridge.connect(value);
        bridge.error = '';
      } catch (e) {
        bridge.error = e.message;
      }
      autoBackup?.reset();
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
      const incoming = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const { validateState } = require('./core/store.cjs');
      validateState(incoming, store.ids);
      const answer = await dialog.showMessageBox(owner(event), {
        type: 'question',
        title: '导入手札',
        message: '用备份中的手札替换当前记录？',
        detail: `备份包含 ${incoming.profiles.length} 个周目。当前手札会另存一份，游戏存档不会改动。`,
        buttons: ['取消', '保留副本并导入'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      const state = store.importData(incoming);
      broadcast('state', state);
      return { state };
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
      quiet: () => {
        const s = bridge.summary();
        return s.busy || s.pending || s.quiescing || (s.connected && !s.ready);
      },
    });
    showMain();
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
      // Native checkpoints change slot 29 frequently; do not multiply them into
      // copies of every unrelated slot while the sparse timeline is enabled.
      isBlocked: () => quitRequested || bridge.busy || bridge.loadQueued || timeline.data.enabled,
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
