'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, text } = require('./store.cjs');
// Operational feedback and unfinished node edits live apart from the user's journal.
class Activity {
  constructor(root) {
    this.file = path.join(root, 'activity.json');
    this.data = { events: [], drafts: {} };
    this.warning = '';
    if (fs.existsSync(this.file)) {
      try {
        this.data = this.read(this.file);
      } catch {
        this.warning = '操作记录或节点草稿无法读取，原文件已保留。';
        try {
          fs.copyFileSync(this.file, this.file + '.damaged-' + Date.now());
        } catch {
          this.unpreserved = true;
        }
        try {
          this.data = this.read(this.file + '.previous');
          this.needsRepair = true;
          this.warning = this.unpreserved
            ? '操作记录或草稿异常，已读取上一份；异常原件无法另存，暂不覆盖，请检查磁盘空间和权限。'
            : '操作记录或草稿异常，已找回上一份；异常原文件保留。';
          if (!this.unpreserved) {
            atomicWrite(this.file, this.data, true);
            this.needsRepair = false;
          }
        } catch {}
      }
    }
  }
  read(file) {
    if (fs.statSync(file).size > 256 * 1024) throw Error('too large');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !Array.isArray(d.events) ||
      d.events.length > 30 ||
      !d.drafts ||
      typeof d.drafts !== 'object' ||
      Array.isArray(d.drafts) ||
      Object.keys(d.drafts).length > 100
    )
      throw Error('invalid activity');
    for (const e of d.events) {
      if (!['success', 'error', 'info'].includes(e.level) || !Number.isSafeInteger(e.at))
        throw Error('invalid event');
      text(e.message, 600);
    }
    if (d.fault) {
      text(d.fault.message, 600);
      if (!Number.isSafeInteger(d.fault.at)) throw Error('invalid fault');
    }
    for (const [id, v] of Object.entries(d.drafts)) this.validateDraft(id, v);
    return d;
  }
  commit(next) {
    if (this.unpreserved) {
      fs.copyFileSync(this.file, this.file + '.damaged-' + Date.now());
      atomicWrite(this.file, next, true);
      this.unpreserved = false;
    } else atomicWrite(this.file, next, !!this.needsRepair);
    this.needsRepair = false;
    this.data = next;
  }
  get() {
    return JSON.parse(JSON.stringify({ ...this.data, warning: this.warning }));
  }
  record(level, message) {
    if (!['success', 'error', 'info'].includes(level)) throw Error('操作结果无效');
    const event = { level, message: text(message, 600), at: Date.now() };
    const next = JSON.parse(JSON.stringify(this.data));
    next.events.unshift(event);
    if (level === 'error' && event.message.startsWith('时间线已停止：')) next.fault = event;
    next.events.length = Math.min(30, next.events.length);
    this.commit(next);
    return event;
  }
  clearFault() {
    if (!this.data.fault) return;
    const next = JSON.parse(JSON.stringify(this.data));
    delete next.fault;
    this.commit(next);
  }
  validateDraft(id, value) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error('节点草稿编号无效');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !['label', 'note', 'at'].includes(k))
    )
      throw Error('节点草稿无效');
    text(value.label, 80);
    text(value.note, 500);
    if (value.at !== undefined && !Number.isSafeInteger(value.at)) throw Error('草稿时间无效');
  }
  draft(id, value) {
    if (value !== null) this.validateDraft(id, value);
    else if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error('节点草稿编号无效');
    const next = JSON.parse(JSON.stringify(this.data));
    if (value === null) delete next.drafts[id];
    else {
      if (!this.data.drafts[id] && Object.keys(this.data.drafts).length >= 100)
        throw Error('节点草稿已达 100 份，请先保存或放弃旧草稿');
      next.drafts[id] = { label: value.label, note: value.note, at: Date.now() };
    }
    this.commit(next);
    return this.get();
  }
}
module.exports = { Activity };
