'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { resourceBudget, subtractBudget, recipeBudget } = require('../src/core/resource-budget.cjs');
const { materialPlan } = require('../src/core/material-plan.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const catalog = require('../src/data/catalog.cjs');
const recipes = require('../src/data/game-index.json').entries;
const profile = () => ({
  id: 'one',
  goals: [],
  craftList: [
    { id: 'fusion-1000', quantity: 1 },
    { id: 'fusion-1001', quantity: 1 },
  ],
});
const reference = () => ({
  name: '1.sav',
  hash: 'test',
  modifiedAt: '2026-10-07T00:00:00Z',
  metadata: {
    inventory: [
      { id: 10216, count: 10 },
      { id: 10246, count: 4 },
      { id: 10205, count: 5 },
    ],
    quests: [],
  },
});

test('a recipe preview excludes its own goal while retaining other plans and task reservations', () => {
  const p = {
    id: 'one',
    referenceMode: 'latest',
    reservations: { 10226: 5 },
    craftPlans: [{ id: 'other', name: '另一份计划', list: [{ id: 'fusion-1002', quantity: 2 }] }],
    goals: [{ id: 'mine', source: { type: 'database', id: 'fusion-1002', quantity: 3 } }],
  };
  const ref = { name: '1.sav', metadata: { inventory: [{ id: 10226, count: 99 }], quests: [] } };
  const total = resourceBudget(p, ref);
  const preview = recipeBudget(p, ref, 'fusion-1002');
  assert.equal(total.totals[10226], 20);
  assert.equal(preview.totals[10226], 11);
  assert.equal(subtractBudget(ref.metadata.inventory, preview.totals)[0].count, 88);
  assert.equal(p.goals.length, 1);
  assert.throws(() => recipeBudget(p, ref, 'item-10226'), /配方编号/);
});
test('giftable stock excludes current crafting demands and each shared item is consumed only once', () => {
  const p = profile(),
    ref = reference();
  const budget = resourceBudget(p, ref);
  const available = subtractBudget(ref.metadata.inventory, budget.totals);
  assert.equal(budget.totals['10216'], 6);
  assert.equal(budget.totals['10205'], 3);
  assert.equal(available.find((i) => i.id === 10216).count, 4);
  assert.equal(available.find((i) => i.id === 10205).count, 2);
  const own = resourceBudget(p, ref, { excludeDraft: true });
  const plan = materialPlan(p.craftList, ref.metadata, own.totals);
  assert.equal(plan.materials.find((m) => m.ids.includes(10216)).allocated, 6);
  assert.equal(plan.missing, 0);
});
test('manual and task allocations combine with crafting, flexible ingredients share one global allocation', () => {
  const flexible = recipes.find((r) => r.kind === '配方' && r.materials.some((m) => m.alternatives));
  assert(flexible);
  const p = {
    ...profile(),
    reservations: { 10216: 1 },
    craftPlans: [
      { id: 'flex', name: '可替代用料', reserved: true, list: [{ id: flexible.id, quantity: 2 }] },
    ],
  };
  const ref = reference();
  for (const m of flexible.materials)
    for (const id of m.alternatives || [m.id])
      if (!ref.metadata.inventory.some((i) => i.id === id)) ref.metadata.inventory.push({ id, count: 100 });
  const budget = resourceBudget(p, ref);
  for (const [id, count] of Object.entries(budget.totals)) {
    const actual = ref.metadata.inventory
      .filter((i) => i.id === Number(id))
      .reduce((sum, i) => sum + i.count, 0);
    assert(count <= actual, 'crafting cannot allocate one physical item more than once');
  }
  assert.equal(budget.crafts.length, 2);
  assert.equal(
    subtractBudget(ref.metadata.inventory, budget.totals).some((i) => i.count < 0),
    false,
  );
});
test('opening a saved plan avoids duplicate draft consumption, completing or releasing it frees gifts', () => {
  const p = profile(),
    ref = reference();
  p.craftPlans = [{ id: 'trip', name: '出行', reserved: true, list: structuredClone(p.craftList) }];
  p.activeCraftPlanId = 'trip';
  p.goals = [{ id: 'goal', done: false, source: { type: 'planner', id: 'trip' } }];
  assert.equal(resourceBudget(p, ref).totals['10216'], 6);
  assert.equal(resourceBudget(p, ref).crafts.length, 1);
  assert.deepEqual(resourceBudget(p, ref, { excludeDraft: true, excludePlanId: 'trip' }).totals, {});
  p.goals[0].done = true;
  assert.deepEqual(resourceBudget(p, ref).totals, {});
  p.goals[0].done = false;
  p.craftPlans[0].reserved = false;
  assert.deepEqual(resourceBudget(p, ref).totals, {});
});
test('unknown inventory never turns crafting demand into invented stock and input saves remain read only', () => {
  const p = profile(),
    ref = reference(),
    before = JSON.stringify({ p, ref });
  resourceBudget(p, ref);
  assert.equal(JSON.stringify({ p, ref }), before);
  const unknown = resourceBudget(p, { ...ref, metadata: {} });
  assert.equal(unknown.inventoryAvailable, false);
  assert.equal(unknown.crafts[0].materials[0].missing, null);
  assert.deepEqual(unknown.totals, {});
  assert.equal(subtractBudget(undefined, unknown.totals), undefined);
});
test('unbound, wrong-slot and updating references cannot manufacture current stock', () => {
  const p = profile(),
    ref = reference();
  for (const [referenceMode, saveSlot, error] of [
    ['none', '', ''],
    ['slot', '2.sav', ''],
    ['latest', '', 'updating'],
  ]) {
    Object.assign(p, { referenceMode, saveSlot });
    const budget = resourceBudget(p, ref, { error });
    assert.equal(budget.inventoryAvailable, false);
    assert.equal(budget.missingTotal, null);
    assert.equal(budget.crafts[0].materials[0].missing, null);
    assert.equal(budget.referenceIdentity, null);
  }
});
test('recipe goals and a different editing recipe are tracked together, never hidden by draft precedence', () => {
  const p = {
    ...profile(),
    name: '测试',
    referenceMode: 'latest',
    stageConfirmed: false,
    checks: {},
    craftList: [{ id: 'fusion-1000', quantity: 1 }],
    goals: [
      {
        id: 'white',
        title: '制作白光剑',
        done: false,
        source: { type: 'database', id: 'fusion-1001', quantity: 1 },
      },
    ],
  };
  const ref = reference();
  ref.metadata.inventory[0].count = 4;
  const result = companionSnapshot({ activeProfileId: p.id, profiles: [p] }, catalog, ref);
  const iron = result.materials.materials.find((m) => m.ids.includes(10216));
  assert.equal(iron.count, 6);
  assert.equal(iron.allocated, 4);
  assert.equal(iron.missing, 2);
  assert.equal(resourceBudget(p, ref).totals['10216'], 4);
  p.goals[0].done = true;
  assert.equal(resourceBudget(p, ref).totals['10216'], 3);
});
test('many valid recipe goals remain readable beyond the editor per-recipe quantity ceiling', () => {
  const p = {
    ...profile(),
    craftList: [],
    goals: Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      done: false,
      source: { type: 'database', id: 'fusion-1000', quantity: 999 },
    })),
  };
  const budget = resourceBudget(p, reference());
  assert.equal(budget.crafts[0].list[0].quantity, 2997);
  assert.equal(budget.crafts[0].materials.find((m) => m.ids.includes(10216)).count, 8991);
});
test('several gift intents and crafting share physical stock, and a handled gift releases its allocation', () => {
  const p = profile(),
    ref = reference();
  p.craftList = [];
  p.journey = {
    gifts: [
      { id: 'a', npcId: 'npc-1', itemId: 'item-10216', quantity: 8, done: false },
      { id: 'b', npcId: 'npc-2', itemId: 'item-10216', quantity: 8, done: false },
    ],
    handledActionIds: [],
  };
  const budget = resourceBudget(p, ref);
  assert.equal(
    budget.gifts.reduce((sum, g) => sum + g.allocated, 0),
    10,
  );
  assert.equal(
    budget.gifts.reduce((sum, g) => sum + g.missing, 0),
    6,
  );
  assert.equal(budget.missingTotal, 6);
  assert.equal(budget.totals['10216'], 10);
  assert.equal(resourceBudget(p, { ...ref, metadata: {} }).gifts[0].missing, null);
  const hash = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify(['a']))
    .digest('hex')
    .slice(0, 32);
  p.journey.handledActionIds.push('journey:gift:' + hash);
  assert.equal(resourceBudget(p, ref).gifts.length, 1);
  assert.equal(resourceBudget(p, ref).totals['10216'], 8);
});
