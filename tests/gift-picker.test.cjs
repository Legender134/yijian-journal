'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const game = require('../src/data/game-index.json');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const views = import(
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(__dirname, '../src/renderer/gift-picker.js')).toString('base64')
);
test('three identically named swords are independently searchable by visible quality before selection', async () => {
  const { giftChoiceLabel, giftChoices } = await views;
  const result = giftChoices(game, 'item', { query: '纯钢剑' });
  const swords = result.rows.filter((entry) => [1000, 1001, 1002].includes(entry.gameId));
  assert.equal(swords.length, 3);
  assert.equal(new Set(swords.map((entry) => giftChoiceLabel(entry, game.entries))).size, 3);
  for (const [q, id] of [
    ['白', 'item-1000'],
    ['绿', 'item-1001'],
    ['蓝', 'item-1002'],
  ]) {
    const byQuality = giftChoices(game, 'item', { query: '纯钢剑', quality: q });
    assert.equal(byQuality.rows.find((entry) => entry.id === id).quality, q);
    assert.ok(byQuality.rows.every((entry) => entry.quality === q));
    assert.equal(giftChoices(game, 'item', { query: '纯钢剑 ' + q }).rows[0].id, id);
  }
});
test('every giftable item and person remains reachable through bounded pages without silent selection', async () => {
  const { giftChoices } = await views;
  for (const kind of ['item', 'person']) {
    const first = giftChoices(game, kind),
      found = [];
    for (let page = 1; page <= first.pages; page++) {
      const result = giftChoices(game, kind, { page });
      assert.ok(result.rows.length <= 12);
      assert.equal(result.selected, undefined);
      found.push(...result.rows.map((entry) => entry.id));
    }
    const expected = game.entries
      .filter((entry) =>
        kind === 'person' ? entry.kind === '人物' : entry.kind === '物品' && entry.giftable,
      )
      .map((entry) => entry.id);
    assert.deepEqual(new Set(found), new Set(expected));
    assert.equal(found.length, expected.length);
  }
});
test('changing search and quality never drops an existing selected exact ID', async () => {
  const { giftChoiceLabel, giftChoices } = await views;
  const result = giftChoices(game, 'item', {
    selectedId: 'item-1002',
    query: '完全没有这个物品',
    quality: '白',
  });
  assert.equal(result.total, 0);
  assert.equal(result.selected.id, 'item-1002');
  assert.equal(result.pinned.id, 'item-1002');
  const people = ['npc-5011', 'npc-5030'].map((id) => game.entries.find((entry) => entry.id === id));
  assert.notEqual(giftChoiceLabel(people[0], game.entries), giftChoiceLabel(people[1], game.entries));
  assert.equal(giftChoices(game, 'item', { selectedId: 'npc-5011' }).selected, undefined);
});
test('stock shortcuts use the same finite budget and reclaim only the gift currently being edited', async () => {
  const { giftStock, giftChoices } = await views;
  const profile = {
    id: 'synthetic-profile',
    referenceMode: 'latest',
    goals: [],
    reservations: { 1000: 1 },
    journey: {
      places: [],
      todos: [],
      gifts: [{ id: 'gift-a', npcId: 'npc-5011', itemId: 'item-1002', quantity: 1, note: '', done: false }],
    },
  };
  const ref = {
    name: '0.sav',
    hash: 'a'.repeat(64),
    modifiedAt: '2026-10-09T00:00:00.000Z',
    metadata: {
      inventory: [
        { id: 1000, count: 1 },
        { id: 1002, count: 1 },
      ],
      quests: [],
    },
  };
  ref.planning = resourceBudget(profile, ref);
  const fresh = giftStock(ref, profile.id),
    editing = giftStock(ref, profile.id, 'gift-a');
  assert.equal(fresh.available[1000], 0);
  assert.equal(fresh.available[1002], 0);
  assert.equal(editing.available[1002], 1);
  assert.equal(editing.available[1000], 0);
  assert.equal(giftChoices(game, 'item', { stockOnly: true, stock: fresh }).total, 0);
  assert.deepEqual(
    giftChoices(game, 'item', { stockOnly: true, stock: editing }).rows.map((row) => row.id),
    ['item-1002'],
  );
  assert.equal(giftStock(ref, 'other-profile'), null);
  assert.equal(giftStock({ ...ref, hash: 'b'.repeat(64) }, profile.id), null);
  assert.equal(
    giftStock({ ...ref, planning: { ...ref.planning, inventoryAvailable: false } }, profile.id),
    null,
  );
  assert.equal(giftChoices(game, 'item', { stockOnly: true, stock: null }).total, 0);
});
test('person preferences are an explicit filter and never silently remove the selected gift', async () => {
  const { giftChoices } = await views;
  const person = game.entries.find((row) => row.kind === '人物' && row.hobbyKeys.length);
  const preferred = giftChoices(game, 'item', { personId: person.id, preferredOnly: true });
  assert.ok(preferred.total > 0);
  assert.ok(preferred.rows.every((row) => person.hobbyKeys.includes(row.typeKey)));
  const other = game.entries.find(
    (row) => row.kind === '物品' && row.giftable && !person.hobbyKeys.includes(row.typeKey),
  );
  assert.equal(
    giftChoices(game, 'item', { personId: person.id, preferredOnly: true, selectedId: other.id }).pinned.id,
    other.id,
  );
  assert.equal(giftChoices(game, 'item', { personId: 'unknown', preferredOnly: true }).total, 0);
});
