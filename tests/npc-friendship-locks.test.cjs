'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encyclopedia } = require('../src/core/game-data.cjs');
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const helpers = {
  esc,
  act: (action, label, _cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  icon: () => '',
  iconButton: () => '',
  picture: () => '',
  pill: esc,
  empty: esc,
  notice: esc,
  qualityText: { name: (_entry, name) => esc(name) },
};
async function fixture() {
  const [{ createGameViews }, { createWorldViews }] = await Promise.all([
    import('../src/renderer/game-views.js'),
    import('../src/renderer/world-views.js'),
  ]);
  const index = encyclopedia();
  const world = createWorldViews(helpers);
  index.renderRequirements = world.requirementRows;
  return { index, views: createGameViews(helpers), world };
}
const lockSection = (html) =>
  html.match(/<details class="detail-block"><summary>好感解锁条件<\/summary>([\s\S]*?)<\/details>/)?.[1];

test('冷无情 codex displays the real 50 cap condition without the inert zero row', async () => {
  const { index, views } = await fixture();
  const person = index.entries.find((entry) => entry.id === 'npc-11509');
  assert.equal(person.name, '冷无情');
  assert.deepEqual(
    person.friendshipLocks.map((lock) => [
      lock.at,
      lock.requirements.map((row) => [row.type, row.id, row.value]),
    ]),
    [
      [50, [['PreQuest', 12583, 4]]],
      [0, []],
    ],
  );
  const before = structuredClone(person.friendshipLocks);
  const section = lockSection(views.detail(index, person.id));
  assert(section);
  assert.deepEqual(
    [...section.matchAll(/<h3 class="mt">(\d+) 好感<\/h3>/g)].map((m) => m[1]),
    ['50'],
  );
  assert.match(section, /data-id="quest-12583"[^>]*>诛杀覆海蛟/);
  assert.doesNotMatch(section, /未收录条件/);
  assert.deepEqual(person.friendshipLocks, before);
});

test('codex preserves all four real zero cap unlock conditions', async () => {
  const { index, views } = await fixture();
  for (const [id, name, quest] of [
    [10047, '卫霍', 5066],
    [10131, '白锦', 12001],
    [10221, '陈麟熙', 12071],
    [10269, '孔亮', 12304],
  ]) {
    const person = index.entries.find((entry) => entry.id === `npc-${id}`);
    assert.equal(person.name, name);
    assert.deepEqual(
      person.friendshipLocks[0].requirements.map((row) => [row.type, row.id, row.value]),
      [['PreQuest', quest, 4]],
    );
    assert.equal(person.friendshipLocks[0].at, 0);
    const before = structuredClone(person.friendshipLocks);
    const section = lockSection(views.detail(index, person.id));
    assert.match(section, /<h3 class="mt">0 好感<\/h3><div class="world-rule">/);
    assert.match(section, new RegExp(esc(person.friendshipLocks[0].requirements[0].name)));
    assert.deepEqual(person.friendshipLocks, before);
  }
});

test('no displayed friendship locks leaves no empty codex details', async () => {
  const { index, views, world } = await fixture();
  const person = index.entries.find((entry) => entry.id === 'npc-11509');
  for (const friendshipLocks of [[], [{ at: 0, requirements: [] }]]) {
    const altered = {
      ...index,
      entries: index.entries.map((entry) => (entry.id === person.id ? { ...entry, friendshipLocks } : entry)),
    };
    assert.equal(lockSection(views.detail(altered, person.id)), undefined);
  }
  assert.match(world.requirementRows([], index, { reference: null }), /未收录条件/);
});
