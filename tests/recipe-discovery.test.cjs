'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  recipeDiscovery,
  assertDiscoveryScope,
  validateDiscoveryOptions,
} = require('../src/core/recipe-discovery.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const game = require('../src/data/game-index.json');
const world = require('../src/data/world-index.json');
const profile = () => ({ id: 'synthetic-one', referenceMode: 'latest', goals: [], craftList: [] });
const reference = () => ({
  name: 'ResearchSynthetic.sav',
  hash: 'ab'.repeat(32),
  modifiedAt: '2026-10-09T00:00:00.000Z',
  metadata: {
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ],
    fusionRecipes: [1000],
    alchemyRecipes: [],
    cookingRecipes: [],
    money: 100000000,
    quests: [],
  },
});
const options = { craft: 'fusion', query: '纯钢剑', learned: 'all', view: 'all' };
const discover = (p, ref, filters = options) => recipeDiscovery(p, ref, resourceBudget(p, ref), filters);
const row = (p, ref, filters = options) =>
  discover(p, ref, filters).rows.find((r) => r.recipeId === 'fusion-1000');
test('real fusion-1000 separates learning, direct material support, fees and unknown skill level', () => {
  const p = profile(),
    ref = reference(),
    before = JSON.stringify({ p, ref });
  const result = discover(p, ref),
    actual = result.rows[0];
  assert.equal(actual.recipeId, 'fusion-1000');
  assert.equal(actual.learned, true);
  assert.equal(actual.supportsOne, true);
  assert.equal(actual.materialStatus, 'supported');
  assert.equal(actual.missingTotal, 0);
  assert.equal(actual.money, 572);
  assert.equal(actual.moneyStatus, 'supported');
  assert.equal(actual.currentLevel, null);
  assert.equal(actual.requirementLevel, 0);
  assert.deepEqual(actual.learningItemIds, [100000]);
  assert.deepEqual(
    actual.outputs.map((item) => [
      item.id,
      item.name,
      item.quality,
      item.minimumCount,
      item.maximumCount,
      item.guaranteedItem,
    ]),
    [[1002, '纯钢剑', '蓝', 1, 1, true]],
  );
  assert.deepEqual(result.referenceIdentity, { name: ref.name, hash: ref.hash, modifiedAt: ref.modifiedAt });
  assert.match(result.scopeToken, /^[a-f0-9]{64}$/);
  assert.match(result.notices.join(' '), /不表示.*同时/);
  assert.equal(JSON.stringify({ p, ref }), before, 'all inputs stay read-only');
});
test('all other saved plans and the current draft consume their actual materials before discovery', () => {
  const ref = reference();
  for (const p of [
    { ...profile(), craftList: [{ id: 'fusion-1000', quantity: 1 }] },
    {
      ...profile(),
      craftPlans: [{ id: 'another', name: '另一份剑计划', list: [{ id: 'fusion-1000', quantity: 1 }] }],
    },
    {
      ...profile(),
      goals: [{ id: 'g', done: false, source: { type: 'database', id: 'fusion-1000', quantity: 1 } }],
    },
  ]) {
    const actual = row(p, ref);
    assert.equal(actual.supportsOne, false);
    assert.equal(actual.missingTotal, 5);
    assert.equal(discover(p, ref, { ...options, view: 'supported' }).rows.length, 0);
  }
});
test('manual, task, gift and real processing consumption each reduce the candidate pool', () => {
  const ref = reference(),
    task = world.quests[0];
  for (const patch of [
    { reservations: { 10216: 1 } },
    { allocations: [{ questId: task.id, items: { 10216: 1 } }] },
    {
      journey: {
        gifts: [{ id: 'gift', npcId: 'npc-1', itemId: 'item-10216', quantity: 1, done: false }],
        handledActionIds: [],
      },
    },
  ]) {
    assert.equal(row({ ...profile(), ...patch }, ref).supportsOne, false);
    assert.equal(row({ ...profile(), ...patch }, ref).missingTotal, 1);
  }
  const p = { ...profile(), craftList: [{ id: 'fusion-1002', quantity: 1 }] };
  ref.metadata.inventory.push({ id: 10207, count: 2 });
  const budget = resourceBudget(p, ref);
  assert(budget.crafts[0].processingAllocation.some((item) => item.id === 10216 && item.count === 3));
  const actual = recipeDiscovery(p, ref, budget, options).rows[0];
  assert.equal(actual.supportsOne, false);
  assert(actual.missingItems.some((material) => material.ids.includes(10216) && material.missing === 3));
});
test('duplicate inventory rows share a single physical total even after budget subtraction', () => {
  const p = profile(),
    ref = reference();
  ref.metadata.inventory = [
    { id: 10216, count: 1 },
    { id: 10216, count: 2 },
    { id: 10246, count: 1 },
    { id: 10205, count: 1 },
  ];
  assert.equal(row(p, ref).supportsOne, true);
  p.reservations = { 10216: 2 };
  assert.equal(row(p, ref).missingTotal, 2);
});
test('each recipe is an independent proposal, and adding one invalidates the other shared-stock support', () => {
  const p = profile(),
    ref = reference();
  ref.metadata.inventory = [
    { id: 10201, count: 1 },
    { id: 10202, count: 1 },
    { id: 10205, count: 1 },
  ];
  ref.metadata.fusionRecipes = [9500, 9501];
  const result = discover(p, ref, { craft: 'fusion', learned: 'learned', view: 'supported' });
  assert(result.rows.some((r) => r.recipeId === 'fusion-9500' && r.supportsOne));
  assert(result.rows.some((r) => r.recipeId === 'fusion-9501' && r.supportsOne));
  const request = { scopeToken: result.scopeToken, recipeId: 'fusion-9501', quantity: 1 };
  assert.equal(assertDiscoveryScope(p, ref, resourceBudget(p, ref), request).materialStatus, 'supported');
  p.craftList = [{ id: 'fusion-9500', quantity: 1 }];
  assert.throws(() => assertDiscoveryScope(p, ref, resourceBudget(p, ref), request), /过期/);
  assert.equal(
    discover(p, ref, { craft: 'fusion', query: '铜锭', learned: 'all', view: 'all' }).rows.find(
      (r) => r.recipeId === 'fusion-9501',
    ).supportsOne,
    false,
  );
});
test('unknown inventory, learning and money remain independently unknown', () => {
  const p = profile(),
    ref = reference();
  delete ref.metadata.inventory;
  let actual = row(p, ref);
  assert.equal(actual.learned, true);
  assert.equal(actual.supportsOne, null);
  assert.equal(actual.missingTotal, null);
  assert.equal(actual.materialStatus, 'unknown');
  assert.equal(discover(p, ref).status, 'inventory-unknown');
  assert(discover(p, ref, { ...options, view: 'supported' }).rows.length > 0);
  ref.metadata.inventory = reference().metadata.inventory;
  delete ref.metadata.fusionRecipes;
  delete ref.metadata.money;
  actual = row(p, ref);
  assert.equal(actual.learned, null);
  assert.equal(actual.supportsOne, true);
  assert.equal(actual.moneyStatus, 'unknown');
  assert(actual.blockingUnknowns.some((reason) => reason.includes('学习记录')));
  assert.equal(discover(p, ref, { ...options, learned: 'learned' }).rows[0].learned, null);
  ref.metadata.fusionRecipes = [];
  assert.equal(row(p, ref).learned, false);
  assert.equal(discover(p, ref, { ...options, learned: 'learned' }).rows.length, 0);
});
test('foreign-profile, hash/time/name mismatches and inconsistent budget availability cannot supply trusted stock', () => {
  const p = profile(),
    ref = reference(),
    budget = resourceBudget(p, ref);
  for (const invalid of [
    { ...budget, profileId: 'other' },
    ...['name', 'hash', 'modifiedAt'].map((key) => ({
      ...budget,
      referenceIdentity: { ...budget.referenceIdentity, [key]: 'changed' },
    })),
    { ...budget, inventoryAvailable: false },
  ]) {
    const result = recipeDiscovery(p, ref, invalid, options);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.scopeToken, null);
    assert.equal(result.referenceIdentity, null);
    assert.equal(result.rows[0].supportsOne, null);
    assert.equal(result.rows[0].learned, null);
    assert.equal(result.rows[0].moneyStatus, 'unknown');
  }
  for (const patch of [{ referenceMode: 'none' }, { referenceMode: 'slot', saveSlot: 'Different.sav' }]) {
    const other = { ...p, ...patch },
      result = discover(other, ref);
    assert.equal(result.status, 'no-reference');
    assert.equal(result.scopeToken, null);
    assert.equal(result.rows[0].missingTotal, null);
  }
});
test('scope checks reject changed saves and profile intent but allow pure search and paging changes', () => {
  const p = profile(),
    ref = reference();
  const result = discover(p, ref),
    request = { scopeToken: result.scopeToken, recipeId: 'fusion-1000', quantity: 1 };
  for (const key of ['name', 'hash', 'modifiedAt']) {
    const newer = { ...ref, [key]: key === 'modifiedAt' ? '2026-10-09T00:01:00Z' : 'new-' + ref[key] };
    assert.throws(() => assertDiscoveryScope(p, newer, resourceBudget(p, newer), request), /过期/);
  }
  const changed = {
    ...p,
    craftPlans: [
      { id: 'emptying', name: '新意图', reserved: false, list: [{ id: 'fusion-1000', quantity: 1 }] },
    ],
  };
  assert.deepEqual(resourceBudget(changed, ref).totals, {});
  assert.throws(() => assertDiscoveryScope(changed, ref, resourceBudget(changed, ref), request), /过期/);
  assert.equal(
    discover(p, ref, { view: 'all', learned: 'all', page: 3, pageSize: 12 }).scopeToken,
    result.scopeToken,
  );
  assert.equal(assertDiscoveryScope(p, ref, resourceBudget(p, ref), request).requestedQuantity, 1);
});
test('quantity, enum and pagination inputs are bounded; large pages clamp to the last real page', () => {
  for (const quantity of [0, -1, 1000, 1.5, '1', NaN, Infinity])
    assert.throws(() => validateDiscoveryOptions({ quantities: { 'fusion-1000': quantity } }), /制作次数/);
  for (const invalid of [
    { query: 'x'.repeat(101) },
    { craft: 'unknown' },
    { learned: 'yes' },
    { view: 'craftable' },
    { page: 0 },
    { page: 1.5 },
    { page: 10001 },
    { pageSize: 999 },
    { quantities: [] },
    { quantities: { 'item-10216': 1 } },
    { extra: true },
    null,
  ])
    assert.throws(() => validateDiscoveryOptions(invalid));
  assert.doesNotThrow(() => validateDiscoveryOptions({ quantities: { 'fusion-1000': 999 } }));
  const actual = row(profile(), reference(), { ...options, quantities: { 'fusion-1000': 999 } });
  assert.equal(actual.requestedQuantity, 999);
  assert.equal(actual.outputs[0].minimumCount, 999);
  assert.equal(actual.outputs[0].maximumCount, 999);
  assert.equal(actual.money, 572 * 999);
  assert.equal(actual.missingTotal, 5 * 998);
  assert.equal(actual.supportsOne, true);
  const result = discover(profile(), reference(), { view: 'all', learned: 'all', page: 9999, pageSize: 12 });
  assert.equal(result.pagination.page, result.pagination.pageCount);
  assert.equal(result.rows.length, 3);
  assert.equal(new Set(result.rows.map((r) => r.recipeId)).size, result.rows.length);
});

test('discovery distinguishes the actual product, variable yield and alternative qualities without crediting future stock', () => {
  const p = profile(),
    ref = reference(),
    before = JSON.stringify({ p, ref });
  const iron = discover(p, ref, {
    craft: 'fusion',
    query: '铁锭',
    learned: 'all',
    view: 'all',
    quantities: { 'fusion-9500': 2 },
  }).rows.find((r) => r.recipeId === 'fusion-9500');
  assert.deepEqual(
    iron.outputs.map((o) => [o.id, o.minimumCount, o.maximumCount, o.guaranteedItem]),
    [[10216, 2, 6, true]],
  );
  const variants = discover(p, ref, { ...options, quantities: { 'fusion-1100': 2 } }).rows.find(
    (r) => r.recipeId === 'fusion-1100',
  );
  assert.deepEqual(
    variants.outputs.map((o) => [o.id, o.quality, o.maximumCount, o.guaranteedItem]),
    [
      [1000, '白', 2, false],
      [1001, '绿', 2, false],
      [1002, '蓝', 2, false],
    ],
  );
  assert.deepEqual(variants.learningItemIds, [100091]);
  assert.equal(JSON.stringify({ p, ref }), before);
  assert.deepEqual(resourceBudget(p, ref).totals, {});
});

test('discovery cards show conditional totals and exact product links separately from learning blueprints', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/recipe-discovery-views.js'), 'utf8');
  const { createRecipeDiscoveryViews } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const views = createRecipeDiscoveryViews({
    esc: String,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    pill: String,
    notice: String,
    empty: String,
    when: String,
  });
  const result = discover(profile(), reference(), {
    ...options,
    quantities: { 'fusion-1000': 2, 'fusion-1100': 2 },
  });
  const html = views.page(result, {}, game, profile());
  assert.match(html, /制作 2 次的产物/);
  assert.match(html, /data-id="item-1002">纯钢剑<\/button> · 蓝色 × 2/);
  assert.match(html, /data-id="item-1000">纯钢剑<\/button> · 白色 × 0–2/);
  assert.match(html, /可能未得到其中某项/);
  assert.match(html, /data-id="item-100091"/);
  assert.match(html, /尚未计入背包/);
});
test('near-material ranking is explicitly limited to one or two missing units for one copy', () => {
  const p = profile(),
    ref = reference();
  ref.metadata.inventory[0].count = 2;
  assert.equal(discover(p, ref, { ...options, view: 'near' }).rows[0].oneMissingTotal, 1);
  ref.metadata.inventory[0].count = 1;
  assert.equal(discover(p, ref, { ...options, view: 'near' }).rows[0].oneMissingTotal, 2);
  ref.metadata.inventory[0].count = 0;
  assert.equal(discover(p, ref, { ...options, view: 'near' }).rows.length, 0);
});
test('fees subtract existing complete plan costs, and unresolved costs never imply affordability', () => {
  const p = { ...profile(), craftList: [{ id: 'fusion-1000', quantity: 1 }] },
    ref = reference();
  ref.metadata.inventory.forEach((item) => {
    item.count *= 2;
  });
  ref.metadata.money = 1000;
  const budget = resourceBudget(p, ref),
    actual = recipeDiscovery(p, ref, budget, options).rows[0];
  assert.equal(actual.remainingCopper, 428);
  assert.equal(actual.materialStatus, 'supported');
  assert.equal(actual.moneyStatus, 'missing');
  assert.equal(actual.copperMissing, 144);
  assert.equal(
    recipeDiscovery(p, ref, { ...budget, moneyComplete: false }, options).rows[0].moneyStatus,
    'unknown',
  );
});
// The shipped table currently has no overlapping alternative groups in one
// recipe. Load an isolated synthetic table into the actual modules to verify
// their maximum-flow integration without modifying runtime data or exports.
function syntheticModules(table) {
  const load = (filename, overrides) => {
    const instance = new Module(filename, module);
    instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = instance.require.bind(instance);
    instance.require = (name) => (Object.hasOwn(overrides, name) ? overrides[name] : original(name));
    instance._compile(fs.readFileSync(filename, 'utf8'), filename);
    return instance.exports;
  };
  const material = load(path.join(__dirname, '../src/core/material-plan.cjs'), {
    '../data/game-index.json': table,
  });
  return load(path.join(__dirname, '../src/core/recipe-discovery.cjs'), {
    '../data/game-index.json': table,
    './material-plan.cjs': material,
  });
}
test('candidate allocation uses residual maximum flow across overlapping fixed and flexible groups', () => {
  const table = structuredClone(game),
    recipe = table.entries.find((entry) => entry.id === 'fusion-1000');
  recipe.materials = [
    { name: '鱼肉', alternatives: [10525, 10526], count: 1 },
    { id: 10525, name: '草鱼', count: 1 },
  ];
  const core = syntheticModules(table),
    p = profile(),
    ref = reference();
  ref.metadata.inventory = [
    { id: 10525, count: 1 },
    { id: 10526, count: 1 },
  ];
  let result = core.recipeDiscovery(p, ref, resourceBudget(p, ref), options);
  assert.equal(result.rows[0].missingTotal, 0);
  ref.metadata.inventory = [{ id: 10525, count: 1 }];
  result = core.recipeDiscovery(p, ref, resourceBudget(p, ref), options);
  assert.equal(result.rows[0].missingTotal, 1, 'one fish cannot fill two groups');
  table.build = 'synthetic-new-build';
  const otherCore = syntheticModules(table);
  assert.notEqual(
    otherCore.recipeDiscovery(p, ref, resourceBudget(p, ref), options).scopeToken,
    result.scopeToken,
  );
});
test('malformed budgets and add requests fail closed', () => {
  const p = profile(),
    ref = reference(),
    budget = resourceBudget(p, ref);
  for (const totals of [{ 10216: -1 }, { 10216: 1.5 }, { bad: 1 }, null])
    assert.throws(() => recipeDiscovery(p, ref, { ...budget, totals }, options), /预算记录/);
  const request = { scopeToken: discover(p, ref).scopeToken, recipeId: 'fusion-1000', quantity: 1 };
  for (const bad of [
    { ...request, quantity: 0 },
    { ...request, quantity: 1000 },
    { ...request, recipeId: 'item-10216' },
    { ...request, scopeToken: 'abc' },
    { ...request, extra: true },
  ])
    assert.throws(() => assertDiscoveryScope(p, ref, budget, bad));
});
