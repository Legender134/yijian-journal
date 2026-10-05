'use strict';
const path = require('node:path');
const sourceKey = (source) => path.resolve(source).toLowerCase();
const manifestFingerprint = (manifest) =>
  manifest.files.map((f) => `${f.name}:${f.bytes}:${f.modifiedAt}:${f.sha256}`).join('|');

class AutoBackup {
  constructor(store, saves, notify, options = {}) {
    this.store = store;
    this.saves = saves;
    this.notify = notify;
    this.error = '';
    this.lastKey = '';
    this.seededSource = '';
    this.pending = null;
    this.disposed = false;
    this.intervalMs = options.intervalMs || 60000;
    this.settleMs = options.settleMs || 2000;
    this.schedule = options.schedule || setTimeout;
    this.cancel = options.cancel || clearTimeout;
    this.isBlocked = options.isBlocked || (() => false);
  }
  start() {
    if (!this.interval) this.interval = setInterval(() => this.check(), this.intervalMs);
  }
  reset() {
    if (this.pending) this.cancel(this.pending.timer);
    this.pending = null;
    this.lastKey = '';
    this.seededSource = '';
    this.error = '';
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.interval);
    this.reset();
  }
  fail(error) {
    const text = error.message || '未知错误';
    if (this.error !== text) {
      this.error = text;
      this.notify({ type: 'error', text: `自动备份未完成：${text}` });
    }
  }
  check() {
    if (this.disposed || this.pending || this.isBlocked()) return;
    const settings = this.store.get().settings;
    if (!settings.autoBackup || !settings.savePath || this.saves.busy || this.saves.pendingRestore()) return;
    try {
      const source = settings.savePath,
        key = sourceKey(source),
        fingerprint = this.saves.fingerprint(source);
      // Reuse a verified matching snapshot after app restart. An unchanged
      // directory does not need another identical automatic copy every launch.
      if (this.seededSource !== key) {
        this.seededSource = key;
        this.lastKey = '';
        const previous = this.saves.list().find((b) => sourceKey(b.source) === key);
        if (previous)
          try {
            this.lastKey = `${key}|${manifestFingerprint(this.saves.verify(previous.id).manifest)}`;
          } catch {}
      }
      if (this.lastKey === `${key}|${fingerprint}`) {
        if (this.error) {
          this.error = '';
          this.notify({ type: 'auto-status', text: '' });
        }
        return;
      }
      const pending = { source, key, fingerprint, timer: null };
      this.pending = pending;
      pending.timer = this.schedule(() => this.finish(pending), this.settleMs);
    } catch (e) {
      this.fail(e);
    }
  }
  finish(pending) {
    if (this.disposed || this.pending !== pending) return;
    this.pending = null;
    const settings = this.store.get().settings;
    if (
      !settings.autoBackup ||
      !settings.savePath ||
      sourceKey(settings.savePath) !== pending.key ||
      this.saves.busy ||
      this.isBlocked() ||
      this.saves.pendingRestore()
    )
      return;
    try {
      if (this.saves.fingerprint(pending.source) !== pending.fingerprint) return;
      const result = this.saves.capture(pending.source, '自动备份', 'auto');
      this.lastKey = `${pending.key}|${manifestFingerprint(result)}`;
      this.error = '';
      this.notify({ type: 'backup', text: `自动备份完成 · ${result.files.length} 个文件` });
    } catch (e) {
      this.fail(e);
    }
  }
}
module.exports = { AutoBackup };
