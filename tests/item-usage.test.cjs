'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/data/game-index.json');
const world = require('../src/data/world-index.json');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const load = (name) =>
  import(
    'data:text/javascript;base64,' +
      fs.readFileSync(path.join(__dirname, '../src/renderer', name)).toString('base64')
  );
const projection = load('item-usage.js');
const rendering = load('item-usage-views.js');
const stamp = '2026-10-09T00:00:00.000Z';
const quest = world.quests[0];
const person = game.entries.find((entry) => entry.kind === '人物');
const plan = (id, extra = {}) => ({
  id,
  name: '合成计划' + id,
  list: [{ id: 'fusion-1000', quantity: 1 }],
  reserved: true,
  ...extra,
});
const profile = (extra = {}) => ({
  id: 'synthetic-profile',
  referenceMode: 'latest',
  goals: [],
  reservations: {},
  allocations: [],
  craftPlans: [],
  craftList: [],
  reserveCraftDraft: false,
  journey: { gifts: [], handledActionIds: [] },
  ...extra,
});
const reference = (inventory = [], extra = {}) => ({
  name: 'Synthetic.sav',
  hash: 'a'.repeat(64),
  modifiedAt: stamp,
  metadata: { inventory, quests: [], fusionRecipes: [], money: 100000 },
  ...extra,
});
const budgetReference = (p, ref, options) => ({ ...ref, planning: resourceBudget(p, ref, options) });
const project = async (id, p, ref, error = '') => {
  const { projectItemUsage } = await projection;
  return projectItemUsage(id, { profile: p, reference: ref, gameIndex: game, error });
};
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
const html = async (result) => {
  const { createItemUsageViews } = await rendering;
  return createItemUsageViews({
    esc,
    act: (action, label, className, id) =>
      `<button class="${className}" data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    when: () => '合成时间',
  }).detail(result);
};

test('exact item reverse lookup presents each existing owner and the authoritative physical total', async () => {
  const p = profile({
    reservations: { 10216: 1 },
    allocations: [{ questId: quest.id, items: { 10216: 2 } }],
    craftPlans: [plan('甲'), plan('乙')],
  });
  const ref = budgetReference(
    p,
    reference([
      { id: 10216, count: 4 },
      { id: 10216, count: 6 },
      { id: 10246, count: 10 },
      { id: 10205, count: 10 },
    ]),
  );
  const before = JSON.stringify({ p, ref });
  const result = await project('item-10216', p, ref);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.stock, { owned: 10, allocated: 9, remaining: 1 });
  assert.deepEqual(
    result.usages.map((row) => [row.kind, row.required, row.allocated, row.missing]),
    [
      ['manual', 1, 1, 0],
      ['quest', 2, 2, 0],
      ['craft', 3, 3, 0],
      ['craft', 3, 3, 0],
    ],
  );
  assert.equal(result.usages.find((row) => row.kind === 'quest').source.action, 'world-quest');
  assert.deepEqual(
    result.usages.filter((row) => row.kind === 'craft').map((row) => row.source.id),
    ['甲', '乙'],
  );
  assert.equal(result.stock.allocated, ref.planning.physicalUsed[10216]);
  assert.equal(JSON.stringify({ p, ref }), before);
  const output = await html(result);
  assert.match(output, /合成计划甲/);
  assert.match(output, /合成计划乙/);
  assert.match(output, /data-action="craft-plan-open"/);
  assert.match(output, /data-action="world-quest"/);
  assert.match(output, /记录预留 2/);
  assert.match(output, /预留尚缺 0/);
  assert.match(output, /data-action="navigate" data-id="materials"/);
});

test('same named quality variants keep stock and existing gifts isolated by exact ID', async () => {
  const p = profile({
    reservations: { 1004: 1 },
    journey: {
      gifts: [
        { id: 'green-gift', npcId: person.id, itemId: 'item-1004', quantity: 2, done: false },
        { id: 'blue-gift', npcId: person.id, itemId: 'item-1005', quantity: 3, done: false },
      ],
      handledActionIds: [],
    },
  });
  const ref = budgetReference(
    p,
    reference([
      { id: 1004, count: 8 },
      { id: 1005, count: 6 },
    ]),
  );
  const green = await project('item-1004', p, ref);
  const blue = await project('item-1005', p, ref);
  assert.equal(green.item.name, blue.item.name);
  assert.equal(green.item.quality, '绿');
  assert.equal(blue.item.quality, '蓝');
  assert.deepEqual(green.stock, { owned: 8, allocated: 3, remaining: 5 });
  assert.deepEqual(blue.stock, { owned: 6, allocated: 3, remaining: 3 });
  assert.deepEqual(
    blue.usages.map((row) => row.key),
    ['gift:blue-gift'],
  );
  assert.equal(blue.usages[0].source.action, 'journey-gift-edit');
  assert.equal(blue.usages[0].source.id, 'blue-gift');
  assert.match(await html(blue), /蓝色品质.*item-1005/);
});

test('processing distinguishes physical input, preceding projected supply and core endpoint shortage', async () => {
  const p = profile({ craftPlans: [plan('加工')] });
  const final = game.entries.find((entry) => entry.id === 'fusion-1000');
  const processingRecipeData = [
    final,
    {
      id: 'fusion-900001',
      gameId: 900001,
      kind: '配方',
      recipeType: 'fusion',
      name: '合成铁锭加工',
      materials: [{ id: 10201, name: '合成中间原料', count: 2 }],
      results: [{ id: 10216, count: 1 }],
      money: 0,
    },
    {
      id: 'fusion-900002',
      gameId: 900002,
      kind: '配方',
      recipeType: 'fusion',
      name: '合成前序加工',
      materials: [{ id: 10206, name: '合成原料端点', count: 3 }],
      results: [{ id: 10201, count: 1 }],
      money: 0,
    },
  ];
  const ref = budgetReference(
    p,
    reference([
      { id: 10201, count: 1 },
      { id: 10206, count: 4 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ]),
    { processingRecipeData },
  );
  const intermediate = await project('item-10201', p, ref);
  assert.deepEqual(intermediate.stock, { owned: 1, allocated: 1, remaining: 0 });
  const row = intermediate.usages.find((row) => row.kind === 'processing');
  assert.equal(row.required, 6);
  assert.equal(row.allocated, 1);
  assert.equal(row.unallocatedPhysical, 5);
  assert.equal(row.plannedAllocated, 5);
  assert.deepEqual(row.plannedSources, [{ id: 10201, count: 5, recipeId: 'fusion-900002' }]);
  assert.equal(row.endpointMissing, 0);
  const raw = await project('item-10206', p, ref);
  assert.deepEqual(raw.stock, { owned: 4, allocated: 4, remaining: 0 });
  assert.equal(raw.usages[0].required, 15);
  assert.equal(raw.usages[0].allocated, 4);
  assert.equal(raw.usages[0].endpointMissing, 11);
  const iron = await project('item-10216', p, ref);
  assert.deepEqual(iron.stock, { owned: 0, allocated: 0, remaining: 0 });
  assert.equal(iron.usages[0].allocated, 0);
  assert.equal(iron.usages[0].missing, 3);
  assert(ref.planning.crafts[0].processing.plannedOutputs.some((output) => output.itemId === 10216));
  const output = await html(intermediate);
  assert.match(output, /尚未分配真实库存 5/);
  assert.match(output, /预计前序加工供给 5/);
  assert.match(output, /原料端点缺口 0/);
  assert.match(output, /不是当前持有/);
});

test('an eligible alternative appears even if another exact item satisfies its entire group', async () => {
  const recipe = game.entries.find(
    (entry) => entry.kind === '配方' && entry.materials.some((m) => m.alternatives),
  );
  const material = recipe.materials.find((m) => m.alternatives);
  const itemId = material.alternatives[0];
  const p = profile({ craftPlans: [plan('替代', { list: [{ id: recipe.id, quantity: 1 }] })] });
  const inventory = [...new Set(recipe.materials.flatMap((m) => m.alternatives || [m.id]))].map((id) => ({
    id,
    count: id === itemId ? 0 : 100,
  }));
  const ref = budgetReference(p, reference(inventory));
  const result = await project('item-' + itemId, p, ref);
  const row = result.usages.find((row) => row.kind === 'craft');
  assert.equal(row.scope, 'alternative-group');
  assert.equal(row.required, material.count);
  assert.equal(row.allocated, 0);
  assert.equal(row.groupAllocated, material.count);
  assert.equal(row.missing, 0);
  assert.deepEqual(row.alternativeIds, material.alternatives);
  const output = await html(result);
  assert.match(output, /材料组共需/);
  assert.match(output, /本物品分配 0/);
  assert.match(output, /该组缺口 0/);
  assert.match(output, /不表示每种品质各需/);
});

test('completed task records remain discoverable without current occupancy; inactive plans and gifts are excluded', async () => {
  const p = profile({
    allocations: [{ questId: quest.id, items: { 10216: 3 } }],
    craftPlans: [plan('已完成', { done: true }), plan('已释放', { reserved: false }), plan('目标已完成')],
    goals: [{ id: 'linked', done: true, source: { type: 'planner', id: '目标已完成' } }],
    journey: {
      gifts: [{ id: 'done-gift', npcId: person.id, itemId: 'item-10216', quantity: 2, done: true }],
      handledActionIds: [],
    },
  });
  const ref = reference([{ id: 10216, count: 10 }]);
  ref.metadata.quests = [{ id: quest.gameId, step: 4 }];
  const result = await project('item-10216', p, budgetReference(p, ref));
  assert.deepEqual(result.stock, { owned: 10, allocated: 0, remaining: 10 });
  assert.equal(result.usages.length, 1);
  assert.equal(result.usages[0].kind, 'quest');
  assert.equal(result.usages[0].active, false);
  assert.equal(result.usages[0].required, 3);
  assert.equal(result.usages[0].allocated, 0);
  assert.equal(result.usages[0].missing, 0);
  assert.match(await html(result), /已完成 · 当前不占用/);
});

test('physical total is clamped by core when manual claims exceed actual stock', async () => {
  const p = profile({ reservations: { 10216: 20 } });
  const result = await project('item-10216', p, budgetReference(p, reference([{ id: 10216, count: 5 }])));
  assert.deepEqual(result.stock, { owned: 5, allocated: 5, remaining: 0 });
  assert.equal(result.usages[0].required, 20);
  assert.equal(result.usages[0].allocated, 5);
  assert.equal(result.usages[0].missing, 15);
});

test('missing inventory preserves known intention demand and unknown physical quantities', async () => {
  const p = profile({
    reservations: { 10216: 2 },
    allocations: [{ questId: quest.id, items: { 10216: 2 } }],
    craftPlans: [plan('未知库存')],
  });
  const ref = reference();
  delete ref.metadata.inventory;
  const result = await project('item-10216', p, budgetReference(p, ref));
  assert.equal(result.status, 'inventory-unknown');
  assert.equal(result.inventoryAvailable, false);
  assert.deepEqual(result.stock, { owned: null, allocated: null, remaining: null });
  assert.equal(result.usages[0].required, 2);
  const task = result.usages.find((row) => row.kind === 'quest');
  assert.equal(task.active, true);
  assert.equal(task.allocated, null);
  assert.equal(task.missing, null);
  assert.match(task.status, /待核对/);
  assert.ok(result.usages.every((row) => row.allocated === null && row.missing === null));
  const output = await html(result);
  assert.match(output, /真实持有<\/small><strong>待核对/);
  assert.match(output, /真实库存分配 待核对/);
  assert.doesNotMatch(output, /真实库存分配 0/);
});

test('profile or reference mismatches never expose another context allocation as current fact', async () => {
  const p = profile({ reservations: { 10216: 1 } });
  const ref = budgetReference(p, reference([{ id: 10216, count: 5 }]));
  const another = await project('item-10216', { ...p, id: 'another-profile' }, ref);
  assert.equal(another.status, 'profile-mismatch');
  for (const changed of [
    { name: 'Other.sav' },
    { hash: 'b'.repeat(64) },
    { modifiedAt: '2026-10-08T00:00:00Z' },
  ]) {
    const result = await project('item-10216', p, { ...ref, ...changed });
    assert.equal(result.status, 'reference-mismatch');
    assert.deepEqual(result.stock, { owned: null, allocated: null, remaining: null });
    assert.deepEqual(result.usages, []);
    assert.match(await html(result), /用途尚未核对/);
  }
  assert.deepEqual(another.usages, []);
});

test('unreadable, absent and incomplete references remain explicit; item names cannot substitute exact IDs', async () => {
  const p = profile();
  assert.equal((await project('item-10216', p, null)).status, 'no-reference');
  const unreadable = await project('item-10216', p, null, '合成参照读取失败');
  assert.equal(unreadable.status, 'unreadable');
  assert.deepEqual(unreadable.stock, { owned: null, allocated: null, remaining: null });
  assert.match(await html(unreadable), /合成参照读取失败/);
  assert.equal((await project('item-10216', p, reference())).status, 'budget-unavailable');
  assert.equal((await project('铁锭', p, reference())).status, 'invalid-item');
  assert.equal((await project('item-010216', p, reference())).status, 'invalid-item');
  const invalidRef = budgetReference(p, reference([{ id: 10216, count: 0 }]));
  invalidRef.planning.physicalUsed[10216] = 1;
  assert.equal((await project('item-10216', p, invalidRef)).status, 'unreadable');
  invalidRef.planning.physicalUsed[10216] = null;
  assert.equal((await project('item-10216', p, invalidRef)).status, 'unreadable');
});

test('no recorded uses and spare stock do not imply permission to sell; views escape all personal text', async () => {
  const p = profile({
    craftPlans: [
      plan('安全', { name: '<img src=x onerror=alert(1)>', list: [{ id: 'fusion-1000', quantity: 1 }] }),
    ],
  });
  const ref = budgetReference(
    p,
    reference([
      { id: 10216, count: 10 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ]),
  );
  const safe = await html(await project('item-10216', p, ref));
  assert.match(safe, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(safe, /<img src=x/);
  const unused = await project('item-1005', p, ref);
  assert.equal(unused.usages.length, 0);
  const output = await html(unused);
  assert.match(output, /尚无这件物品的已记录用途/);
  assert.match(output, /没有已记录用途不代表可以出售/);
  assert.match(output, /余量也不代表可以安全出售/);
});

test('editing draft and recipe goal sources navigate to their existing management pages', async () => {
  const p = profile({
    reserveCraftDraft: true,
    craftList: [{ id: 'fusion-1000', quantity: 1 }],
    goals: [{ id: 'recipe-goal', done: false, source: { type: 'database', id: 'fusion-1001', quantity: 1 } }],
  });
  const result = await project('item-10216', p, budgetReference(p, reference([{ id: 10216, count: 10 }])));
  assert.deepEqual(
    result.usages.filter((row) => row.kind === 'craft').map((row) => row.source),
    [
      { action: 'navigate', id: 'materials', label: '查看编辑清单' },
      { action: 'navigate', id: 'goals', label: '查看制作目标' },
    ],
  );
});
