'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { recipeDiscovery } = require('../src/core/recipe-discovery.cjs');
const catalog = require('../src/data/catalog.cjs');
const list = (quantity) => [{ id: 'fusion-1000', quantity }];
const ref = {
  name: 'Synthetic.sav',
  hash: 'a'.repeat(64),
  modifiedAt: '2026-10-09T00:00:00.000Z',
  metadata: {
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ],
    fusionRecipes: [1000],
    money: 100000,
    quests: [],
  },
};
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-discovery-intents-'));
  t.after(() => {
    assert(path.basename(dir).startsWith('yijian-discovery-intents-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir, catalog);
  store.mutate({ type: 'save-slot', value: '', mode: 'latest' });
  store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 2 });
  return { store, dir };
}
for (const editing of ['draft', 'active-plan'])
  test(`adding to a released other plan preserves ${editing} ownership and its physical claims even when lists become identical`, (t) => {
    const { store, dir } = setup(t);
    if (editing === 'active-plan')
      store.mutate({ type: 'craft-plan-save', name: '正在编辑', list: list(2), choices: {}, reserved: true });
    store.mutate({
      type: 'craft-plan-save',
      name: '另一已释放计划',
      list: list(1),
      choices: {},
      reserved: false,
    });
    const data = store.get(),
      original = data.profiles[0],
      target = original.craftPlans.find((p) => p.name === '另一已释放计划');
    original.resourcePriority = [original.activeCraftPlanId || '@draft'];
    store.commit(data);
    const before = store.get().profiles[0],
      claims = resourceBudget(before, ref).totals;
    store.mutate(
      {
        type: 'craft-plan-save',
        id: target.id,
        name: target.name,
        list: list(2),
        choices: {},
        reserved: false,
      },
      { discoveryPlanId: target.id },
    );
    const after = new Store(dir, catalog).get().profiles[0];
    assert.equal(after.activeCraftPlanId, before.activeCraftPlanId);
    assert.equal(after.reserveCraftDraft, before.reserveCraftDraft);
    assert.deepEqual(after.craftList, before.craftList);
    assert.deepEqual(after.craftChoices, before.craftChoices);
    assert.deepEqual(after.resourcePriority, before.resourcePriority);
    assert.equal(after.craftPlans.find((p) => p.id === target.id).reserved, false);
    assert.deepEqual(resourceBudget(after, ref).totals, claims);
    const discovery = recipeDiscovery(after, ref, resourceBudget(after, ref), {
      query: '纯钢剑',
      learned: 'all',
      view: 'all',
      pageSize: 8,
    });
    assert.equal(discovery.rows.find((r) => r.recipeId === 'fusion-1000').oneMissingTotal, 5);
  });
test('adding to the plan currently edited merges unsaved editor intent into that plan without allocating a second copy', (t) => {
  const { store, dir } = setup(t);
  store.mutate({ type: 'craft-plan-save', name: '本次编辑', list: list(2), choices: {}, reserved: true });
  const id = store.get().profiles[0].activeCraftPlanId;
  store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 3 });
  store.mutate({ type: 'craft-choice', itemId: '10216', recipeId: 'fusion-9500' });
  const choices = store.get().profiles[0].craftChoices;
  store.mutate(
    { type: 'craft-plan-save', id, name: '本次编辑', list: list(4), choices, reserved: true },
    { discoveryPlanId: id, discoveryEditingPlanId: id },
  );
  const after = new Store(dir, catalog).get().profiles[0];
  assert.equal(after.activeCraftPlanId, id);
  assert.deepEqual(after.craftList, list(4));
  assert.deepEqual(after.craftPlans.find((p) => p.id === id).list, list(4));
  assert.deepEqual(after.craftChoices, choices);
  assert.deepEqual(after.craftPlans.find((p) => p.id === id).choices, choices);
  assert.equal(resourceBudget(after, ref).crafts.length, 1);
});
