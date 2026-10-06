'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { CompanionWindow, boundsFor } = require('../src/core/companion-window.cjs');
const { validWindow } = require('../src/core/game-window.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const recipe = require('../src/data/game-index.json').entries.find(
  (e) => e.kind === '配方' && e.materials.every((m) => !m.alternatives),
);
function setup() {
  const monitor = new EventEmitter();
  monitor.state = null;
  const actions = [];
  monitor.restore = async (hwnd) => {
    actions.push(['restore', hwnd]);
    return true;
  };
  const win = new EventEmitter();
  let visible = false,
    bounds = { x: 0, y: 0, width: 400, height: 600 };
  Object.assign(win, {
    isDestroyed: () => false,
    isVisible: () => visible,
    getBounds: () => bounds,
    setBounds: (b) => {
      bounds = b;
    },
    setFocusable: (b) => actions.push(['focusable', b]),
    setIgnoreMouseEvents: (b) => actions.push(['ignore', b]),
    setOpacity: () => {},
    hide: () => {
      visible = false;
    },
    showInactive: () => {
      actions.push(['inactive']);
      visible = true;
    },
    show: () => {
      visible = true;
    },
    focus: () => actions.push(['focus']),
    webContents: { send: () => {} },
  });
  let quiet = false,
    settings = {};
  const controller = new CompanionWindow({
    monitor,
    create: () => win,
    screen: {
      screenToDipRect: (_, r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    settings: () => settings,
    quiet: () => quiet,
  });
  const set = (s) => {
    monitor.state = s;
    monitor.emit('change');
  };
  return {
    controller,
    win,
    actions,
    set,
    monitor,
    quiet: (b) => {
      quiet = b;
      controller.update();
    },
    settings: (s) => {
      settings = s;
      controller.update();
    },
  };
}
const game = {
  type: 'window',
  hwnd: '123',
  available: true,
  gameForeground: true,
  ownForeground: false,
  x: -1920,
  y: 0,
  width: 1920,
  height: 1080,
};
test('passive hints are nonfocusable, click-through, DPI anchored and hidden outside gameplay', () => {
  const f = setup();
  f.set(game);
  f.win.emit('ready-to-show');
  f.controller.rendererReady();
  assert.equal(f.win.isVisible(), true);
  assert(f.actions.some((a) => a[0] === 'inactive'));
  assert(f.actions.some((a) => a[0] === 'focusable' && a[1] === false));
  assert(f.actions.some((a) => a[0] === 'ignore' && a[1] === true));
  assert(!f.actions.some((a) => a[0] === 'focus'));
  assert.equal(f.win.getBounds().x, -332);
  f.quiet(true);
  assert.equal(f.win.isVisible(), false);
  f.quiet(false);
  assert.equal(f.win.isVisible(), true);
  f.set({ ...game, gameForeground: false });
  assert.equal(f.win.isVisible(), false);
  f.set(null);
  assert.equal(f.win.isVisible(), false);
  f.set(game);
  f.settings({ companionEnabled: false });
  assert.equal(f.win.isVisible(), false);
});
test('only explicit expansion accepts input, collapsing returns verified originating game and external Alt Tab hides', async () => {
  const f = setup();
  f.set(game);
  f.win.emit('ready-to-show');
  f.controller.rendererReady();
  f.controller.expand();
  assert.equal(f.controller.mode, 'expanded');
  assert(f.actions.some((a) => a[0] === 'focus'));
  assert(f.actions.some((a) => a[0] === 'ignore' && a[1] === false));
  f.controller.grace = 0;
  f.set({ ...game, gameForeground: false, ownForeground: true });
  assert.equal(f.win.isVisible(), true);
  f.set({ ...game, gameForeground: false, ownForeground: false });
  assert.equal(f.win.isVisible(), false);
  await f.controller.collapse();
  assert.deepEqual(
    f.actions.filter((a) => a[0] === 'restore'),
    [['restore', '123']],
  );
  f.set({ ...game, gameForeground: false, ownForeground: true });
  f.controller.expand();
  await f.controller.collapse();
  assert.equal(f.actions.filter((a) => a[0] === 'restore').length, 1);
});
test('bounds stay inside negative-coordinate and small client rectangles; helper protocol rejects malformed geometry', () => {
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
    for (const expanded of [true, false]) {
      const rect = { x: -400, y: -200, width: 420, height: 300 },
        b = boundsFor(rect, expanded, corner);
      assert(
        b.x >= rect.x &&
          b.y >= rect.y &&
          b.x + b.width <= rect.x + rect.width &&
          b.y + b.height <= rect.y + rect.height,
      );
    }
  assert(validWindow(game));
  for (const s of [
    { ...game, hwnd: '../x' },
    { ...game, width: -1 },
    { ...game, x: Infinity },
    { ...game, ownForeground: 'true' },
  ])
    assert(!validWindow(s));
});
test('material hints respect unknown stock, reservations, duplicate recipe goals, binding and profile isolation', () => {
  const profile = {
    id: 'a',
    name: 'A',
    goals: [
      {
        id: 'x',
        title: '置顶',
        pinned: true,
        done: false,
        source: { type: 'database', id: recipe.id, quantity: 1 },
      },
      {
        id: 'y',
        title: '另一个制作目标',
        done: false,
        source: { type: 'database', id: recipe.id, quantity: 2 },
      },
    ],
    checks: {},
    stage: 0,
    stageConfirmed: false,
    referenceMode: 'slot',
    saveSlot: '2.sav',
  };
  const state = {
    activeProfileId: 'a',
    settings: {},
    profiles: [profile, { ...profile, id: 'b', name: 'B', goals: [] }],
  };
  const unknown = companionSnapshot(state, catalog, null, '参照缺失');
  assert.equal(unknown.hints.length, 2);
  assert.equal(unknown.hints[0].title, '置顶');
  assert.equal(unknown.materials.recipes[0].quantity, 3);
  assert.equal(unknown.materials.materials[0].missing, null);
  assert(unknown.referenceLabel.includes('固定参照 2.sav'));
  assert.equal(unknown.error, '参照缺失');
  const inventory = recipe.materials.map((m) => ({ id: m.id, count: m.count * 3 }));
  const ref = {
    name: '2.sav',
    modifiedAt: '2026-10-06T00:00:00Z',
    hash: 'abc',
    metadata: { inventory, money: 0, mapName: '测试' },
  };
  profile.reservations = { [inventory[0].id]: 1 };
  const withStock = companionSnapshot(state, catalog, ref);
  assert.equal(withStock.materials.missing, 1);
  assert(withStock.hints[1].title.includes('还缺 1'));
  assert.equal(withStock.reference.hash, 'abc');
  assert.equal(companionSnapshot({ ...state, activeProfileId: 'b' }, catalog, null).materials, null);
  assert.equal(inventory[0].count, recipe.materials[0].count * 3);
});
test('invalid overlay preferences are rejected atomically and valid settings persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-overlay-'));
  const store = new Store(dir, catalog),
    before = store.get();
  for (const value of [
    { companionEnabled: 'false' },
    { companionPosition: 'outside' },
    { compactOpacity: 0 },
    { compactOpacity: 1.1 },
  ]) {
    assert.throws(() => store.mutate({ type: 'settings', value }));
    assert.deepEqual(store.get(), before);
  }
  store.mutate({
    type: 'settings',
    value: { companionPosition: 'bottom-left', compactOpacity: 0.75, companionEnabled: false },
  });
  const persisted = new Store(dir, catalog).get().settings;
  assert.equal(persisted.companionPosition, 'bottom-left');
  assert.equal(persisted.compactOpacity, 0.75);
  assert.equal(persisted.companionEnabled, false);
});
