'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createNpcProgressProjector } = require('../src/core/npc-progress.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const contracts = require('../src/data/npc-interactions.json');
const index = require('../src/core/game-data.cjs').encyclopedia();
const renderer = (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer', file)).href);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const dependencies = {
  esc,
  act: (action, label, cls, id) =>
    `<button class="${cls}" data-action="${action}" data-id="${id}">${label}</button>`,
  picture: (id) => `<img data-picture="${id}">`,
  qualityText: { name: (_, label) => esc(label) },
};
const project = createNpcProgressProjector({ world, game, contracts });
const powers = { 2: 1000, 4: 0, 9: 0, 10: 0, 11: 0, 12: 0, 14: 0, 44: 100 };
const metadata = (id, origin = 'live', quests = []) => ({
  map: 'LV_25_P',
  quests,
  inventory: [],
  combat: {
    format: 14,
    origin,
    player: { id: 0, attributes: powers, skills: [], skillPoints: 100 },
    npcStates: [
      {
        id,
        level: 15,
        rawFriendliness: 90,
        visible: true,
        attributes: powers,
        inventory: [{ id: 100034, count: 1 }],
        equipment: [],
        skills: [],
        mapKey: 'LV_25_P',
      },
    ],
  },
});

test('an exact gift selection stays visible and unchanged when filters exclude it', async () => {
  const { createGiftPicker } = await renderer('gift-picker.js');
  const view = {
    selectedId: 'item-1002',
    query: '不匹配的名字',
    quality: '白',
    stockOnly: true,
    stock: {
      known: true,
      counts: { 1002: 3 },
      used: { 1002: 2 },
      own: { 1002: 1 },
      available: { 1002: 2 },
      modifiedAt: '2026-10-18T00:00:00Z',
    },
  };
  const before = structuredClone(view);
  const html = createGiftPicker(dependencies).field(index, 'item', view);
  assert.match(html, /data-action="database-detail" data-id="item-1002"/);
  assert.match(html, /纯钢剑/);
  assert.match(html, /保存时持有 3 · 其他安排 1 · 这份可用 2/);
  assert.match(html, /没有匹配结果/);
  assert.doesNotMatch(html, /data-action="journey-gift-select"/);
  assert.match(html, /value="item-1002" selected/);
  assert.deepEqual(view, before);
});

test('gift preparation uses actual saved and live gates without promoting unread state to availability', async () => {
  const { createGiftPicker } = await renderer('gift-picker.js');
  const picker = createGiftPicker(dependencies);
  const live = project(metadata(10016)).people[0];
  assert.equal(live.gift.status, 'met');
  assert.match(
    picker.selection(index, 'person', { selectedId: live.id, progress: live, progressOrigin: 'live' }),
    />可赠礼</,
  );
  const saved = project(metadata(10016, 'saved')).people[0];
  assert.equal(saved.gift.status, 'unknown');
  const html = picker.selection(index, 'person', {
    selectedId: saved.id,
    progress: saved,
    progressOrigin: 'saved',
  });
  assert.match(html, /赠礼条件待核对/);
  assert.doesNotMatch(html, /保存时可赠礼|>可赠礼</);
  assert.match(picker.selection(index, 'item', { selectedId: 'item-134', stock: null }), /库存暂未读取/);
  assert.doesNotMatch(
    picker.selection(index, 'item', { selectedId: 'item-134', stock: null }),
    /持有 0|这份可用 0/,
  );
});

test('a story cap leads with the blocking reason and keeps the exact visible quest link', async () => {
  const { createGiftPicker } = await renderer('gift-picker.js');
  const row = project(metadata(10047, 'saved', [{ id: 5066, step: 4 }])).people[0];
  assert.equal(row.friendship.cap, 20);
  const html = createGiftPicker(dependencies).selection(index, 'person', {
    selectedId: row.id,
    progress: row,
    progressOrigin: 'saved',
  });
  assert.match(html, /保存时暂不能赠礼：好感暂时上限 20/);
  assert.match(html, /data-action="world-quest" data-id="quest-5062"/);
  assert.doesNotMatch(html, /data-id="quest-5091"|保存时可赠礼/);
  assert.match(html, /赠礼境界待确认/);
});

test('duel cards open gift preparation for their exact person, while missing gift entries stay unavailable', async () => {
  const { createNpcProgressViews } = await renderer('npc-progress-views.js');
  const views = createNpcProgressViews({ ...dependencies, richText: esc });
  const result = project(metadata(10016));
  let html = views.page(result, { tab: 'remaining' });
  assert.match(html, /data-action="journey-gift-dialog" data-id="npc-10016">准备赠礼/);
  const changed = structuredClone(result);
  for (const row of changed.people)
    row.gift = { status: 'unmet', checks: [{ status: 'unmet', text: '暂无常规赠礼入口' }] };
  // Projected lists contain the same person, but keep this check valid after serialization too.
  for (const key of ['remaining', 'learning', 'locked', 'cleared'])
    for (const row of changed[key])
      row.gift = { status: 'unmet', checks: [{ status: 'unmet', text: '暂无常规赠礼入口' }] };
  html = views.page(changed, { tab: 'remaining' });
  assert.doesNotMatch(html, /data-action="journey-gift-dialog"/);
  assert.match(html, /赠礼：暂无入口/);
});

test('companion gift summaries retain exact links and quantities with one follow-through entry', async () => {
  const { companionSnapshot } = require('../src/core/companion.cjs');
  const { defaults } = require('../src/core/store.cjs');
  const { createCompanionViews } = await renderer('companion-view.js');
  const state = defaults();
  state.profiles[0].journey = require('../src/core/journey-state.cjs').emptyJourneyState();
  state.profiles[0].journey.gifts = [
    { id: 'present', npcId: 'npc-5011', itemId: 'item-1002', quantity: 2, note: '', done: false },
  ];
  const ui = createCompanionViews({ ...dependencies, index: () => index });
  for (const count of [1, 2]) {
    const snapshot = companionSnapshot(state, require('../src/data/catalog.cjs'), {
      name: '1.sav',
      hash: 'a'.repeat(64),
      modifiedAt: '2026-10-18T00:00:00Z',
      metadata: { inventory: [{ id: 1002, count }] },
    });
    const html = ui.actions(snapshot);
    assert.match(html, /赠送：/);
    for (const id of ['npc-5011', 'item-1002']) assert.match(html, new RegExp('data-id="' + id + '"'));
    assert.match(html, count === 1 ? /已备 1 · 还缺 1/ : /已备齐 2 件/);
    assert.equal((html.match(/>调整与完成<\/button>/g) || []).length, 1);
    assert.doesNotMatch(html, /含待核对条件|来自当前周目的记录|赠礼意图：|还缺 0/);
  }
});
