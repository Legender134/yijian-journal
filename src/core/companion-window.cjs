'use strict';
const POSITIONS = ['top-right', 'bottom-right', 'top-left', 'bottom-left'];
function preferences(settings = {}) {
  return {
    enabled: settings.companionEnabled !== false,
    position: POSITIONS.includes(settings.companionPosition) ? settings.companionPosition : 'top-right',
    opacity: Number.isFinite(settings.compactOpacity)
      ? Math.max(0.65, Math.min(1, settings.compactOpacity))
      : 0.96,
  };
}
function boundsFor(rect, expanded, position) {
  const width = Math.min(expanded ? 460 : 320, rect.width - 24);
  const height = Math.min(expanded ? 660 : 112, rect.height - 24);
  return {
    x: Math.round(position.endsWith('left') ? rect.x + 12 : rect.x + rect.width - width - 12),
    y: Math.round(position.startsWith('bottom') ? rect.y + rect.height - height - 12 : rect.y + 12),
    width: Math.round(width),
    height: Math.round(height),
  };
}
class CompanionWindow {
  constructor({ create, monitor, screen, settings, quiet, changed, test = false }) {
    Object.assign(this, { create, monitor, screen, settings, quiet, changed, test });
    this.mode = 'hint';
    this.window = null;
    this.ready = false;
    this.nativeReady = false;
    this.uiReady = false;
    this.returnHwnd = null;
    monitor?.on('change', () => this.update());
  }
  ensure() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = (this.window = this.create());
    this.ready = false;
    this.nativeReady = false;
    this.uiReady = false;
    this.lastConfig = null;
    this.lastStatus = null;
    win.once('ready-to-show', () => {
      this.nativeReady = true;
      this.ready = this.uiReady;
      this.update();
    });
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.ready = false;
        this.mode = 'hint';
      }
    });
    win.on('blur', () => {
      if (!this.monitor?.state) this.update();
    });
    return win;
  }
  rendererReady() {
    this.uiReady = true;
    this.ready = this.nativeReady;
    this.update();
  }
  status() {
    return {
      mode: this.mode,
      visible: !!this.visible,
      preferences: preferences(this.settings()),
      tracking: !!this.monitor?.state,
      windowError: this.monitor?.error || '',
    };
  }
  publish() {
    if (!this.ready || !this.window || this.window.isDestroyed()) return;
    const status = this.status(),
      key = JSON.stringify(status);
    if (this.lastStatus !== key) {
      this.lastStatus = key;
      this.window.webContents.send('journal:companion', status);
      this.changed?.(status);
    }
  }
  expand() {
    if (this.mode === 'expanded' && this.window?.isVisible()) return this.collapse();
    this.returnHwnd = this.monitor?.state?.gameForeground ? this.monitor.state.hwnd : null;
    this.mode = 'expanded';
    this.wantFocus = true;
    this.grace = Date.now() + 750;
    this.ensure();
    this.update();
    return true;
  }
  async collapse(restore = true) {
    const hwnd = this.returnHwnd;
    // Restore before disabling focus; the native helper checks the foreground again.
    if (hwnd && restore) await this.monitor?.restore(hwnd);
    this.returnHwnd = null;
    this.wantFocus = false;
    this.mode = 'hint';
    this.update();
    return false;
  }
  update() {
    const s = this.monitor?.state,
      p = preferences(this.settings());
    if (this.mode === 'expanded' && !this.wantFocus && Date.now() > this.grace && s?.gameForeground) {
      this.mode = 'hint';
      this.returnHwnd = null;
    }
    const visible =
      this.mode === 'expanded'
        ? this.test ||
          s?.ownForeground ||
          (!s && this.window?.isFocused?.()) ||
          Date.now() <= this.grace ||
          (this.wantFocus && s?.gameForeground)
        : p.enabled && s?.gameForeground && !this.quiet();
    this.visible = !!visible;
    if (!visible) {
      this.wantFocus = false;
      if (this.window?.isVisible()) this.window.hide();
      this.publish();
      return;
    }
    const win = this.ensure();
    if (!this.ready) return;
    const expanded = this.mode === 'expanded';
    const physical = s?.available && { x: s.x, y: s.y, width: s.width, height: s.height };
    const rect = physical
      ? this.screen.screenToDipRect(null, physical)
      : this.screen.getPrimaryDisplay().workArea;
    const next = boundsFor(rect, expanded, p.position);
    const previous = win.getBounds();
    // Windows fractional scaling can round a native boundary by one DIP.
    if (Object.keys(next).some((k) => Math.abs(next[k] - previous[k]) > 1)) win.setBounds(next);
    const config = `${expanded}:${p.opacity}`;
    if (this.lastConfig !== config) {
      this.lastConfig = config;
      win.setFocusable(expanded);
      win.setIgnoreMouseEvents(!expanded);
      win.setOpacity(expanded ? 1 : p.opacity);
    }
    if (!win.isVisible()) win.showInactive();
    if (expanded && this.wantFocus) {
      this.wantFocus = false;
      this.grace = Date.now() + 750;
      win.show();
      win.focus();
    }
    this.publish();
  }
  dispose() {
    this.monitor?.dispose();
  }
}
module.exports = { CompanionWindow, preferences, boundsFor, POSITIONS };
