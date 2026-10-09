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
const { Store, defaults } = require('../src/core/store.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich } = require('../src/core/game-data.cjs');
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

test('reading size enlarges both hint and expanded bounds while keeping every corner within the display', () => {
  const large = { x: -1920, y: -50, width: 1920, height: 1080 };
  for (const scale of [1, 1.1, 1.25, 1.5])
    for (const expanded of [true, false])
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
        const expectedWidth = Math.round((expanded ? 460 : 320) * scale);
        assert.equal(boundsFor(large, expanded, corner, scale).width, expectedWidth);
        for (const rect of [large, { x: -400, y: -200, width: 420, height: 300 }]) {
          const b = boundsFor(rect, expanded, corner, scale);
          assert(b.x >= rect.x && b.y >= rect.y);
          assert(b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height);
        }
      }
  const f = setup();
  f.set(game);
  f.win.emit('ready-to-show');
  f.controller.rendererReady();
  const normal = f.win.getBounds();
  f.settings({ readingScale: 150 });
  assert(f.win.getBounds().width > normal.width);
  assert(f.win.getBounds().height > normal.height);
  f.settings({ readingScale: 100 });
  assert.deepEqual(f.win.getBounds(), normal);
});
test('unsaved companion edits are exposed after cancelled exit without toggling them closed', () => {
  const f = setup();
  f.set(game);
  f.win.emit('ready-to-show');
  f.controller.rendererReady();
  f.controller.showEdits();
  assert.equal(f.controller.mode, 'expanded');
  assert.equal(f.win.isVisible(), true);
  f.controller.showEdits();
  assert.equal(f.controller.mode, 'expanded');
  assert.equal(f.win.isVisible(), true);
  assert(f.actions.some((a) => a[0] === 'focus'));
  assert.equal(f.actions.filter((a) => a[0] === 'restore').length, 0);
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
test('ready current materials do not hide shortages in other gift plans', () => {
  const state = defaults(),
    profile = state.profiles[0];
  assert(!recipe.materials.some((m) => m.id === 100));
  profile.craftList = [{ id: recipe.id, quantity: 1 }];
  profile.journey = {
    schema: 1,
    places: [],
    todos: [],
    handledActionIds: [],
    gifts: [{ id: 'gift', npcId: 'npc-5014', itemId: 'item-100', quantity: 2, note: '', done: false }],
  };
  const reference = {
    name: '1.sav',
    metadata: { money: 999999, inventory: recipe.materials.map((m) => ({ id: m.id, count: m.count })) },
  };
  const snapshot = companionSnapshot(state, catalog, reference);
  assert.equal(snapshot.materials.missing, 0);
  assert.equal(snapshot.allocations.missingTotal, 2);
  assert.match(snapshot.hints[0].title, /当前清单材料已齐.*全部计划原料仍缺 2 件/);
});

test('raw materials that are ready still require processing and prepared ingredient rows do not crowd the next actions', () => {
  const state = defaults(),
    profile = state.profiles[0];
  profile.craftList = [{ id: 'fusion-1002', quantity: 1 }];
  const ref = {
    name: '1.sav',
    hash: 'synthetic-processing',
    modifiedAt: '2026-10-08T00:00:00Z',
    metadata: {
      quests: [],
      money: 100000,
      inventory: [
        { id: 10226, count: 3 },
        { id: 10220, count: 1 },
        { id: 10205, count: 5 },
        { id: 10207, count: 2 },
      ],
    },
  };
  const snapshot = companionSnapshot(state, catalog, ref);
  assert.match(snapshot.hints[0].title, /原料已齐.*先加工 2 次.*核对配方与制作费/);
  assert.equal(snapshot.journeySummary.prepared, 3);
  assert(snapshot.nextActions.every((a) => !a.title.startsWith('备料已齐')));
  assert.equal(snapshot.allocations.physicalUsed[10221], undefined);
});
test('personal itinerary leads hints and vanishes after user handles it without marking a game quest complete', () => {
  const state = defaults(),
    p = state.profiles[0];
  p.journey = {
    schema: 1,
    places: [],
    gifts: [],
    handledActionIds: [],
    todos: [
      {
        id: 'own',
        title: '去药铺',
        detail: '自己的安排',
        placeId: 'place-22',
        done: false,
      },
    ],
  };
  const first = companionSnapshot(state, catalog, null);
  assert.equal(first.hints[0].title, '去药铺');
  assert.equal(first.hints[0].type, 'journey');
  assert.equal(first.nextActions[0].kind, 'todo');
  p.journey.handledActionIds.push(first.nextActions[0].id);
  const handled = companionSnapshot(state, catalog, null);
  assert.equal(handled.nextActions.length, 0);
  assert.equal(handled.journeySummary.gameComplete, 0);
  assert.equal(handled.journeySummary.handled, 1);
});
test('fresh profiles receive existing task hints without goals or a manual stage', () => {
  const profile = {
    id: 'fresh',
    name: '我的江湖',
    goals: [],
    checks: {},
    stage: 0,
    stageConfirmed: false,
    referenceMode: 'latest',
  };
  const state = { activeProfileId: profile.id, profiles: [profile] };
  const reference = {
    name: '1.sav',
    modifiedAt: '2026-10-07T00:00:00Z',
    hash: 'read-only',
    metadata: {
      mapName: '当前地点',
      activeQuestFamilies: [
        { id: 5200, name: '已经接到的任务', activeSteps: [{ name: '存档中的当前步骤' }] },
        { id: 5202, name: '另一项已接任务', activeSteps: [] },
        { id: 5203, name: '第三项已接任务', activeSteps: [] },
      ],
    },
  };
  const original = JSON.stringify(state);
  const snapshot = companionSnapshot(state, catalog, reference);
  assert.deepEqual(
    snapshot.hints.map((h) => h.title),
    ['存档中的当前步骤', '另一项已接任务'],
  );
  assert.equal(snapshot.hints[0].type, 'quest');
  assert.equal(snapshot.quests.length, 3);
  assert.equal(snapshot.reference.name, '1.sav');
  assert.equal(JSON.stringify(state), original);
  assert.equal(companionSnapshot(state, catalog, reference, '存档正在更新').quests.length, 0);
  assert.equal(companionSnapshot(state, catalog, null).hints[0].type, 'help');
  profile.referenceMode = 'none';
  assert.equal(companionSnapshot(state, catalog, reference).quests.length, 0);
});

test('saved tracked tasks and child steps lead automatic hints without changing source records', () => {
  const state = defaults();
  for (const choice of [
    { trackingQuest: 11077, trackingMainQuest: 5200, ids: ['quest-11077', 'quest-5200'] },
    { trackingQuest: 5372, trackingMainQuest: 5200, ids: ['quest-5368', 'quest-5200'], title: '与莫弃交谈' },
    { trackingQuest: 987654321, trackingMainQuest: 5200, ids: ['quest-5200', 'quest-11077'] },
    { trackingQuest: 0, trackingMainQuest: 5372, ids: ['quest-5368', 'quest-11077'], title: '与莫弃交谈' },
    { trackingQuest: 11077, trackingMainQuest: 5200, completed: true, ids: ['quest-5200', 'quest-5368'] },
  ]) {
    const bytes = syntheticSave({
      full: true,
      trackingQuest: choice.trackingQuest,
      trackingMainQuest: choice.trackingMainQuest,
      quests: [
        { id: 11077, step: choice.completed ? 4 : 1 },
        { id: 5200, step: 4 },
        { id: 5201, step: 1 },
        { id: 5368, step: 1 },
        { id: 5371, step: 1 },
        { id: 5372, step: 1 },
      ],
    });
    const originalBytes = Buffer.from(bytes);
    const reference = { name: '1.sav', metadata: enrich(readMetadata(bytes, { details: true })) };
    const originalMetadata = structuredClone(reference.metadata);
    const snapshot = companionSnapshot(state, catalog, reference);
    assert.deepEqual(
      snapshot.hints.map((hint) => hint.id),
      choice.ids,
    );
    if (choice.title) assert.equal(snapshot.hints[0].title, choice.title);
    assert.deepEqual(reference.metadata, originalMetadata);
    assert.deepEqual(bytes, originalBytes);
    assert.equal(reference.metadata.quests.find((quest) => quest.id === 5200).status, '已完成');
  }
  assert.equal(state.profiles[0].stageConfirmed, false);
  assert.deepEqual(state.profiles[0].goals, []);
});

test('custom goals and material tracking keep priority over automatic task hints', () => {
  const profile = {
    id: 'a',
    name: 'A',
    goals: [{ id: 'goal', title: '我的置顶目标', pinned: true, done: false }],
    checks: {},
    stage: 0,
    stageConfirmed: false,
    craftList: [{ id: recipe.id, quantity: 1 }],
  };
  const reference = {
    name: '1.sav',
    metadata: {
      activeQuestFamilies: [{ id: 5200, name: '已接任务', activeSteps: [] }],
      inventory: [],
      money: 0,
    },
  };
  const snapshot = companionSnapshot({ activeProfileId: 'a', profiles: [profile] }, catalog, reference);
  assert.deepEqual(
    snapshot.hints.map((h) => h.type),
    ['goal', 'material'],
  );
  assert.equal(snapshot.quests[0].name, '已接任务');
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
