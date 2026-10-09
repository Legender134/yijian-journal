'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { pathToFileURL } = require('node:url'),
  { enrich } = require('../src/core/game-data.cjs');
const game = require('../src/data/game-index.json');
const rendering = import(pathToFileURL(path.join(__dirname, '../src/renderer/game-views.js')).href);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
async function views() {
  const { createGameViews } = await rendering;
  return createGameViews({
    esc,
    icon: () => '',
    act: (action, label, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    empty: esc,
    notice: esc,
    bytes: esc,
    when: esc,
    hours: esc,
    iconButton: () => '',
    picture: () => '',
    qualityText: { name: (_, name) => esc(name) },
  });
}
function metadata(quests) {
  return enrich({ map: 'Synthetic', playSeconds: 1, quests, inventory: [] });
}
function detail(view, m) {
  return view.saveDetail(
    {
      name: 'synthetic.sav',
      hash: 'synthetic-hash',
      modifiedAt: '2026-10-10T00:00:00.000Z',
      bytes: 1,
      metadata: m,
    },
    game,
  );
}
test('the saved task drawer retains the same active child that the home family exposes when its parent record is absent', async () => {
  const view = await views(),
    m = metadata([{ id: 14082, step: 1 }]),
    before = structuredClone(m);
  assert.equal(game.quests[14082].parentId, 14073);
  assert.equal(m.activeQuestFamilies[0].id, 14082);
  const list = view.questList(m.quests, 'active', m.inventory, game),
    html = detail(view, m);
  assert.match(list, /data-quest-id="14082"/);
  assert(list.includes(esc(game.quests[14082].description)));
  assert.match(list, /进行中 1/);
  assert.match(list, /未记录上级任务/);
  assert.doesNotMatch(list, /data-quest-id="14073"/);
  assert.match(html, /这份存档的任务记录 · 1 项/);
  assert.deepEqual(m, before);
});
test('a recorded parent still groups its active child once and keeps their independent recorded states', async () => {
  const view = await views(),
    m = metadata([
      { id: 14073, step: 3 },
      { id: 14082, step: 1 },
    ]);
  assert.equal(m.activeQuestFamilies[0].id, 14073);
  const list = view.questList(m.quests, 'active', m.inventory, game);
  assert.match(list, /data-quest-id="14073"/);
  assert.doesNotMatch(list, /data-quest-id="14082"|未记录上级任务/);
  assert.match(list, /进行中 1/);
  assert(list.includes(esc(game.quests[14082].name)));
  assert.match(list, /未接取/);
  assert.match(detail(view, m), /任务记录 · 1 项/);
});
test('orphan completed and other recorded steps remain in their respective filters without becoming active', async () => {
  const view = await views();
  for (const [step, filter, label] of [
    [4, 'done', '已完成'],
    [2, 'other', '其他'],
    [3, 'other', '其他'],
  ]) {
    const m = metadata([{ id: 14082, step }]),
      list = view.questList(m.quests, filter, m.inventory, game);
    assert.match(list, /data-quest-id="14082"/);
    assert(list.includes(label + ' 1'));
    assert.match(list, /进行中 0/);
    assert.doesNotMatch(view.questList(m.quests, 'active'), /data-quest-id="14082"/);
    assert.match(detail(view, m), /任务记录 · 1 项/);
  }
});
test('separate recorded families and orphan steps each contribute one truthful drawer group', async () => {
  const view = await views(),
    m = metadata([
      { id: 14082, step: 1 },
      { id: 11077, step: 1 },
      { id: 11078, step: 1 },
    ]);
  const ids = m.activeQuestFamilies.map((q) => q.id),
    list = view.questList(m.quests, 'active', m.inventory, game);
  assert.deepEqual(new Set(ids), new Set([14082, 11077]));
  assert.match(list, /进行中 2/);
  assert.equal((list.match(/class="saved-quest"/g) || []).length, 2);
  assert.match(detail(view, m), /任务记录 · 2 项/);
});
