'use strict';
const crypto = require('node:crypto');

// An explicit renderer acknowledgement precedes Electron's beforeunload.
// Cached health broadcasts never authorize throwing away unsaved edits.
class QuitHandoff {
  constructor({ timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.windows = [];
  }
  async prepare(windows) {
    this.cancel();
    this.windows = windows;
    return (await Promise.all(windows.map((win) => this.request(win)))).every(Boolean);
  }
  request(win) {
    const contents = win.webContents;
    if (win.isDestroyed() || contents.isDestroyed()) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID();
      const finish = (ready, error) => {
        clearTimeout(timer);
        contents.removeListener('destroyed', destroyed);
        this.pending.delete(contents.id);
        if (error) reject(error);
        else resolve(ready);
      };
      const destroyed = () => finish(false);
      const timer = setTimeout(
        () => finish(false, Error('界面尚未确认草稿已保存，手札保持运行。请检查未保存的编辑后重试退出。')),
        this.timeoutMs,
      );
      this.pending.set(contents.id, { token, finish });
      contents.once('destroyed', destroyed);
      try {
        contents.send('journal:prepare-quit', { token });
      } catch (error) {
        finish(false, error);
      }
    });
  }
  acknowledge(senderId, value) {
    const request = this.pending.get(senderId);
    if (!request || !value || value.token !== request.token || typeof value.ready !== 'boolean')
      throw Error('退出确认已过期或来源无效');
    request.finish(value.ready);
    return true;
  }
  cancel() {
    for (const request of [...this.pending.values()]) request.finish(false);
    for (const win of this.windows) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        win.webContents.send('journal:prepare-quit', { cancelled: true });
      } catch {
        // A gone renderer cannot receive cancellation; no exit is authorized.
      }
    }
    this.windows = [];
  }
}
module.exports = { QuitHandoff };
