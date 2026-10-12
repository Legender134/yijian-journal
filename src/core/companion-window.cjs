'use strict';
const { fitBounds, applyBounds } = require('./window-layout.cjs');
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
function boundsFor(rect, expanded, position, scale = 1) {
  const width = Math.min((expanded ? 460 : 320) * scale, rect.width - 24);
  const height = Math.min((expanded ? 660 : 112) * scale, rect.height - 24);
  return {
    x: Math.round(position.endsWith('left') ? rect.x + 12 : rect.x + rect.width - width - 12),
    y: Math.round(position.startsWith('bottom') ? rect.y + rect.height - height - 12 : rect.y + 12),
    width: Math.round(width),
    height: Math.round(height),
  };
}
function edgeBounds(rect, anchor, scale = 1) {
  const width = Math.min(Math.round(44 * scale), rect.width);
  const height = Math.min(Math.round(88 * scale), rect.height);
  const side = anchor.x + anchor.width / 2 < rect.x + rect.width / 2 ? 'left' : 'right';
  return {
    side,
    bounds: fitBounds(
      {
        x: side === 'left' ? rect.x : rect.x + rect.width - width,
        y: anchor.y + (anchor.height - height) / 2,
        width,
        height,
      },
      rect,
      { width, height },
    ),
  };
}
class CompanionWindow {
  constructor({ create, monitor, screen, settings, quiet, changed, layout, layoutError, test = false }) {
    Object.assign(this, { create, monitor, screen, settings, quiet, changed, layout, layoutError, test });
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
    for (const event of ['will-move', 'will-resize'])
      win.on(event, (_event, rect) => {
        if (this.mode !== 'expanded') return;
        this.manualChange = true;
        this.layout?.remember('companion', rect);
      });
    for (const event of ['moved', 'resized']) win.on(event, () => this.rememberLayout());
    win.on('close', () => this.rememberLayout());
    return win;
  }
  rememberLayout() {
    if (!this.manualChange || this.mode !== 'expanded' || this.window?.isDestroyed()) return;
    this.manualChange = false;
    this.layout?.remember('companion', this.window.getBounds());
    try {
      this.layout?.save();
    } catch (error) {
      this.layoutError?.(error);
    }
    this.update();
  }
  resetLayout() {
    this.manualChange = false;
    this.layout?.reset('companion');
    this.update();
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
      edge: this.mode === 'tucked' ? this.edgeSide : null,
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
  showEdits() {
    // A failed exit must expose the window that still owns unsaved edits.
    // Unlike the shortcut toggle, repeated requests keep it expanded.
    this.mode = 'expanded';
    this.wantFocus = true;
    this.grace = Date.now() + 750;
    this.ensure();
    this.update();
  }
  async collapse(restore = true) {
    this.rememberLayout();
    const hwnd = this.returnHwnd;
    // Restore before disabling focus; the native helper checks the foreground again.
    if (hwnd && restore) await this.monitor?.restore(hwnd);
    this.returnHwnd = null;
    this.wantFocus = false;
    this.mode = 'hint';
    this.update();
    return false;
  }
  async tuck() {
    if (this.mode !== 'expanded') return false;
    this.rememberLayout();
    this.tuckedFrom = this.window.getBounds();
    const hwnd = this.returnHwnd;
    if (hwnd) await this.monitor?.restore(hwnd);
    this.returnHwnd = null;
    this.wantFocus = false;
    this.mode = 'tucked';
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
        : this.mode === 'tucked'
          ? // Keep this explicit control reachable while menus/dialogue pause automatic hints.
            this.test || !s?.available || s.gameForeground || s.ownForeground
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
    const tucked = this.mode === 'tucked';
    const physical = s?.available && { x: s.x, y: s.y, width: s.width, height: s.height };
    const rect = physical
      ? this.screen.screenToDipRect(null, physical)
      : this.screen.getPrimaryDisplay().workArea;
    const scale = (this.settings().readingScale || 100) / 100;
    const custom = this.layout?.get('companion');
    const customArea =
      custom && (this.screen.getDisplayMatching?.(custom) || this.screen.getPrimaryDisplay()).workArea;
    const edge =
      tucked && edgeBounds(customArea || rect, this.tuckedFrom || custom || win.getBounds(), scale);
    if (edge) this.edgeSide = edge.side;
    const next = edge
      ? edge.bounds
      : custom
        ? fitBounds(
            expanded ? custom : { ...custom, width: 320 * scale, height: 112 * scale },
            customArea,
            expanded ? { width: 360, height: 360 } : { width: 200, height: 90 },
          )
        : boundsFor(rect, expanded, p.position, scale);
    const previous = win.getBounds();
    const minWidth = Math.min(expanded ? 360 : tucked ? 32 : 200, next.width);
    const minHeight = Math.min(expanded ? 360 : tucked ? 64 : 90, next.height);
    const config = `${this.mode}:${p.opacity}:${minWidth}:${minHeight}`;
    if (this.lastConfig !== config) {
      this.lastConfig = config;
      win.setResizable?.(expanded);
      // Electron restores the old constraints when resizing is re-enabled.
      // Apply this mode's minimum afterwards, including on untuck.
      win.setMinimumSize?.(minWidth, minHeight);
      win.setFocusable(expanded);
      win.setIgnoreMouseEvents(!expanded && !tucked);
      win.setOpacity(expanded || tucked ? 1 : p.opacity);
    }
    // Windows fractional scaling can round a native boundary by one DIP.
    // Lower the minimum before shrinking to passive hints.
    if (!this.manualChange && Object.keys(next).some((k) => Math.abs(next[k] - previous[k]) > 1))
      applyBounds(win, next);
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
    this.rememberLayout();
    this.monitor?.dispose();
  }
}
module.exports = { CompanionWindow, preferences, boundsFor, edgeBounds, POSITIONS };
