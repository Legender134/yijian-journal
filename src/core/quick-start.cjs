'use strict';
const path = require('node:path');
const { realDirectory, listFiles } = require('./saves.cjs');
const { SLOT } = require('./timeline.cjs');

function selectSaveFolder(folders, account) {
  if (folders.length === 1) return folders[0];
  if (!folders.length) return '';
  try {
    const id = account();
    const matches = folders.filter((p) => path.basename(path.dirname(p)) === id);
    return matches.length === 1 ? matches[0] : '';
  } catch {
    return '';
  }
}

class QuickStart {
  constructor({ store, saves, timeline, bridge, confirm, quitting = () => false }) {
    Object.assign(this, { store, saves, timeline, bridge, confirm, quitting });
    this.running = false;
  }
  check(source, native = true) {
    if (this.quitting()) throw Error('手札正在退出');
    if (this.bridge.busy || this.bridge.loadQueued || this.bridge.quiescing)
      throw Error('请等待当前存读档完成');
    if (this.timeline.error) throw Error(this.timeline.error);
    if (this.timeline.data.pending || this.saves.pendingRestore())
      throw Error('请先在存档匣核对上次中断的操作');
    if (this.store.get().settings.savePath !== source) throw Error('存档目录已改变，请重新开始');
    const directory = realDirectory(source);
    listFiles(directory);
    if (!native) return directory;
    if (
      path.basename(directory) !== 'SaveGames' ||
      path.basename(path.dirname(directory)) !== this.bridge.account()
    )
      throw Error('请先登录对应的 Steam 账户，再开启自动存档');
    this.bridge.location(directory);
    if (!this.bridge.canStop()) throw Error('请先退出游戏，再开启自动存档；准备好后可直接开始游戏');
    return directory;
  }
  async start() {
    if (this.running) throw Error('正在准备游戏助手，请等待完成');
    this.running = true;
    try {
      const source = this.store.get().settings.savePath;
      this.check(source, false);
      const choice = await this.confirm();
      if (choice === 'launch-only') {
        this.check(source, false);
        this.store.mutate({ type: 'settings', value: { offerAutoSaveOnStart: false } });
        return { launchOnly: true };
      }
      if (!choice) return { cancelled: true };
      this.check(source);
      const backup = this.saves.capture(source, '首次开启助手前的完整保护', 'safety');
      const verified = this.saves.verify(backup.id);
      this.check(source);
      const installed = this.bridge.install();
      if (!installed.installed) throw Error(installed.reason || '游戏接入未完成');
      this.check(source);
      const retained = this.timeline.enableProtected(source, verified.buffers.get(SLOT));
      this.bridge.connect(source);
      this.bridge.error = '';
      this.bridge.nextSaveAt = 0;
      return { backupId: backup.id, retainedId: retained?.id };
    } finally {
      this.running = false;
    }
  }
}
module.exports = { QuickStart, selectSaveFolder };
