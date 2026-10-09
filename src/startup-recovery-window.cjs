'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { StartupRecovery, recoveryError } = require('./core/startup-recovery.cjs');
function showStartupRecovery({
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  catalog,
  hidden = false,
  onWindow,
}) {
  const recovery = new StartupRecovery(app.getPath('userData'), catalog);
  const html = path.join(__dirname, 'renderer', 'startup-recovery.html');
  const win = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 720,
    minHeight: 580,
    show: false,
    title: '逸剑手札 · 恢复本机手札',
    backgroundColor: '#f5f3ec',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'startup-recovery-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  onWindow?.(win);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  let finish,
    settled = false,
    choosing = false;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const channels = [];
  function handle(name, work) {
    const channel = 'journal-recovery:' + name;
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (
          settled ||
          event.sender !== win.webContents ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url !== pathToFileURL(html).href
        )
          throw Error('恢复界面来源无效');
        return { ok: true, data: await work(...args) };
      } catch (error) {
        return { ok: false, error: recoveryError(error) };
      }
    });
  }
  function close(restored) {
    if (settled) return;
    settled = true;
    for (const channel of channels) ipcMain.removeHandler(channel);
    finish(restored);
    if (!win.isDestroyed()) win.destroy();
  }
  handle('status', () => recovery.status());
  handle('prepare-new', () => {
    if (choosing || recovery.busy) throw Error('正在处理恢复资料，请稍候');
    return recovery.prepareNew();
  });
  handle('choose', async (mode) => {
    if (!['json', 'protection', 'volumes'].includes(mode)) throw Error('恢复资料类型无效');
    if (choosing || recovery.busy) throw Error('正在处理恢复资料，请稍候');
    choosing = true;
    recovery.pending = null;
    try {
      const selected = await dialog.showOpenDialog(win, {
        title: mode === 'volumes' ? '选择同一次导出的完整分卷目录' : '选择已导出的手札恢复资料',
        properties: [mode === 'volumes' ? 'openDirectory' : 'openFile'],
        ...(mode === 'volumes'
          ? {}
          : {
              filters: [
                {
                  name: mode === 'json' ? '手札 JSON 备份' : '逸剑完整保护包',
                  extensions: mode === 'json' ? ['json'] : ['yijian-protection', 'yijianprotect'],
                },
              ],
            }),
      });
      if (selected.canceled || !selected.filePaths.length) return { cancelled: true };
      return recovery.preview(mode, selected.filePaths[0]);
    } finally {
      choosing = false;
    }
  });
  handle('confirm', async (token) => {
    if (choosing) throw Error('请选择完恢复资料后再确认');
    const result = await recovery.confirm(token);
    setImmediate(() => close(true));
    return result;
  });
  handle('cancel', () => {
    if (choosing || recovery.busy) throw Error('正在校验或写入资料，请等待完成后再退出');
    setImmediate(() => close(false));
    return { cancelled: true };
  });
  win.on('close', (event) => {
    if (choosing || recovery.busy) {
      event.preventDefault();
      return;
    }
    close(false);
  });
  win.webContents.on('render-process-gone', () => close(false));
  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });
  win.loadFile(html).catch(() => close(false));
  return completed;
}
module.exports = { showStartupRecovery };
