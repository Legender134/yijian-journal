'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
function validWindow(value) {
  return (
    value?.type === 'window' &&
    /^\d{1,20}$/.test(value.hwnd) &&
    ['available', 'gameForeground', 'ownForeground'].every((k) => typeof value[k] === 'boolean') &&
    ['x', 'y', 'width', 'height'].every(
      (k) => Number.isSafeInteger(value[k]) && Math.abs(value[k]) <= 100000,
    ) &&
    (!value.available || (value.hwnd !== '0' && value.width > 300 && value.height > 200))
  );
}
class GameWindow extends EventEmitter {
  constructor(executable, target, ownerPid = process.pid) {
    super();
    this.executable = executable;
    this.target = target || '';
    this.ownerPid = ownerPid;
    this.state = null;
    this.error = '';
    this.at = 0;
    this.active = false;
  }
  setTarget(target) {
    const next = target || '';
    if (next === this.target) {
      if (this.active && !this.child) this.start();
      return false;
    }
    const active = this.active;
    this.dispose();
    this.target = next;
    this.error = '';
    this.at = 0;
    this.emit('change', null);
    if (active) this.start();
    return true;
  }
  start() {
    this.active = true;
    if (this.child) return;
    const child = (this.child = spawn(this.executable, [this.target || '', String(this.ownerPid)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    let buffer = '';
    const clearState = (e) => {
      this.error = e?.message || '游戏窗口组件已停止';
      this.state = null;
      this.focusResult?.(false);
      this.emit('change', null);
    };
    const fail = (e) => {
      if (this.child === child) clearState(e);
    };
    const stopped = (e) => {
      if (this.child !== child) return;
      this.child = null;
      clearInterval(this.timer);
      this.timer = null;
      clearState(e);
    };
    child.on('error', stopped);
    child.stdin.on('error', () => {});
    child.on('exit', () => stopped());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 16384) {
        buffer = '';
        fail(Error('窗口组件数据无效'));
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'focus' && typeof value.ok === 'boolean') this.focusResult?.(value.ok);
          else if (validWindow(value)) {
            this.at = Date.now();
            this.state = value;
            this.error = '';
            this.emit('change', value);
          }
        } catch {}
      }
    });
    this.timer = setInterval(() => {
      if (this.child === child && this.state && Date.now() - this.at > 1500) {
        this.state = null;
        this.emit('change', null);
      }
    }, 500);
    this.timer.unref();
  }
  restore(hwnd) {
    if (!this.child?.stdin.writable || !/^\d{1,20}$/.test(hwnd || '') || this.focusResult)
      return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.focusResult?.(false), 750);
      this.focusResult = (ok) => {
        clearTimeout(timer);
        this.focusResult = null;
        resolve(ok);
      };
      this.child.stdin.write(`focus:${hwnd}\n`);
    });
  }
  dispose() {
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    this.focusResult?.(false);
    const child = this.child;
    this.child = null;
    child?.stdin.end();
    this.state = null;
  }
}
module.exports = { GameWindow, validWindow };
