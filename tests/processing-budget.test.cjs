'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { resourceBudget, subtractBudget, materialReport } = require('../src/core/resource-budget.cjs');
const { craftingStages, validateCraftChoices } = require('../src/core/crafting-stages.cjs');
const { validateCraftList } = require('../src/core/material-plan.cjs');
const entries = require('../src/data/game-index.json').entries;
const world = require('../src/data/world-index.json');
const gold = () => [{ id: 'fusion-1002', quantity: 1 }];
const recipe = (id) => structuredClone(entries.find((e) => e.id === id));
const profile = (extra = {}) => ({ id: 'synthetic', goals: [], craftList: gold(), ...extra });
const reference = (inventory, extra = {}) => ({
  name: 'synthetic.sav',
  hash: 'synthetic-sha256',
  modifiedAt: '2026-10-08T00:00:00Z',
  metadata: { inventory, quests: [], ...extra },
});
const supportsGold = (quantity = 1) => [
  { id: 10226, count: 3 * quantity },
  { id: 10220, count: quantity },
  { id: 10205, count: 5 * quantity },
];
const amount = (lines, id) => lines.filter((a) => a.id === id).reduce((n, a) => n + a.count, 0);
function assertPhysicalConservation(budget, inventory) {
  const physical = new Map();
  for (const item of inventory) physical.set(item.id, (physical.get(item.id) || 0) + item.count);
  for (const [id, count] of Object.entries(budget.physicalUsed))
    assert(count <= (physical.get(Number(id)) || 0));
  for (const [id, count] of Object.entries(budget.totals)) assert(count <= (physical.get(Number(id)) || 0));
  const processing = {};
  for (const craft of budget.crafts)
    for (const item of craft.processingAllocation)
      processing[item.id] = (processing[item.id] || 0) + item.count;
  for (const [id, count] of Object.entries(processing))
    assert.equal(count, (budget.totals[id] || 0) - (budget.directTotals[id] || 0));
}

test('the editor consumes the same direct and processing allocation as the shared ledger', () => {
  const stock = [...supportsGold(2), { id: 10207, count: 3 }];
  const p = profile({ craftPlans: [{ id: 'second', name: '第二计划', list: gold(), reserved: true }] });
  const r = reference(stock),
    before = JSON.stringify({ p, r });
  const report = materialReport(p, r);
  const allocated = report.sharedBudget.crafts.find((c) => c.id === '@draft');
  assert.deepEqual(report.stages, allocated.processing);
  for (const m of report.materials) {
    const own = allocated.materials.find((a) => a.ids.join(',') === m.ids.join(','));
    assert.deepEqual(m.allocation, own.allocation);
    assert.equal(m.missing, own.missing);
  }
  assert.equal(report.stages.processingPhysicalUsed[10207], 2);
  assert.equal(report.sharedBudget.baseMaterialMissingTotal, 1);
  assert.equal(JSON.stringify({ p, r }), before);
  assert.equal(materialReport({ ...p, referenceMode: 'none' }, r).inventoryAvailable, false);
});

test('independent task owners expose actual allocated stock and per-owner deficits without changing claims', () => {
  const p = profile({
    craftList: [],
    allocations: [
      { questId: 'quest-11010', items: { 10201: 4 } },
      { questId: 'quest-13405', items: { 10201: 5 } },
    ],
  });
  const r = reference([{ id: 10201, count: 5 }]);
  const budget = resourceBudget(p, r);
  assert.deepEqual(
    budget.owners.map((o) => o.itemAllocations[0].allocated),
    [4, 1],
  );
  assert.deepEqual(
    budget.owners.map((o) => o.itemAllocations[0].missing),
    [0, 4],
  );
  assert.equal(budget.totals[10201], 9);
  assert.equal(budget.physicalUsed[10201], 5);
  assert.equal(budget.baseMaterialMissingTotal, 4);
  const completed = resourceBudget(p, {
    ...r,
    metadata: { ...r.metadata, quests: [{ id: 11010, step: 4 }] },
  });
  assert.equal(completed.owners[1].itemAllocations[0].allocated, 5);
  assert.equal(completed.owners[0].itemAllocations[0].allocated, 0);
  assert.equal(p.allocations[0].items[10201], 4);
});

test('two plans share gold ore once, keep direct deficits separate from expanded procurement', () => {
  const inventory = [...supportsGold(2), { id: 10207, count: 1 }, { id: 10207, count: 2 }];
  const p = profile({ craftPlans: [{ id: 'second', name: '第二计划', list: gold(), reserved: true }] });
  const budget = resourceBudget(p, reference(inventory));
  assert.deepEqual(budget.processingOrder, ['@draft', 'second']);
  assert.equal(budget.directTotals['10207'], undefined);
  assert.equal(budget.crafts[0].processing.processingPhysicalUsed['10207'], 2);
  assert.equal(budget.crafts[1].processing.processingPhysicalUsed['10207'], 1);
  assert.equal(budget.crafts[1].processing.rawMaterials.find((m) => m.id === 10207).missing, 1);
  assert.equal(budget.totals['10207'], 3);
  assert.equal(budget.totals['10221'], undefined);
  assert.equal(budget.directMissingTotal, 4);
  assert.equal(budget.baseMaterialMissingTotal, 1);
  assert.equal(budget.crafts[0].processing.workRemaining.processing, 2);
  assertPhysicalConservation(budget, inventory);
  assert.equal(amount(subtractBudget(inventory, budget.totals), 10207), 0);
});

test('direct gift ore is protected before processing, and a manually handled gift releases only its claim', () => {
  const inventory = [...supportsGold(), { id: 10207, count: 4 }];
  const p = profile({
    journey: {
      gifts: [{ id: 'ore-gift', itemId: 'item-10207', quantity: 3, done: false }],
      handledActionIds: [],
    },
  });
  const before = JSON.stringify({ p, inventory });
  const budget = resourceBudget(p, reference(inventory));
  assert.equal(budget.gifts[0].allocated, 3);
  assert.equal(budget.directTotals['10207'], 3);
  assert.equal(budget.crafts[0].processing.processingPhysicalUsed['10207'], 1);
  assert.equal(budget.baseMaterialMissingTotal, 1);
  assert.equal(budget.totals['10207'], 4);
  assert.equal(JSON.stringify({ p, inventory }), before);
  const hash = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify(['ore-gift']))
    .digest('hex')
    .slice(0, 32);
  p.journey.handledActionIds.push('journey:gift:' + hash);
  const released = resourceBudget(p, reference(inventory));
  assert.deepEqual(released.gifts, []);
  assert.equal(released.totals['10207'], 2);
  assert.equal(released.baseMaterialMissingTotal, 0);
  assert.equal(amount(subtractBudget(inventory, released.totals), 10207), 2);
  assert.equal(
    resourceBudget({ ...p, journey: { ...p.journey, handledActionIds: [] } }, reference(inventory), {
      excludeGiftId: 'ore-gift',
    }).totals['10207'],
    2,
  );
  assertPhysicalConservation(budget, inventory);
});

test('independent task claims and manual leave-stock survive processing and selected completion only frees its owner', () => {
  const inventory = [
    { id: 10201, count: 15 },
    { id: 10205, count: 4 },
    { id: 10246, count: 1 },
  ];
  const p = profile({
    craftList: [{ id: 'fusion-1000', quantity: 1 }],
    reservations: { 10201: 2 },
    allocations: [
      { questId: 'quest-11010', items: { 10201: 4 } },
      { questId: 'quest-13405', items: { 10201: 5 } },
    ],
  });
  const budget = resourceBudget(p, reference(inventory));
  assert.equal(budget.manual['10201'], 2);
  assert.equal(budget.directTotals['10201'], 11);
  assert.equal(budget.totals['10201'], 14);
  assert.equal(budget.crafts[0].processing.processingPhysicalUsed['10201'], 3);
  assert.equal(amount(subtractBudget(inventory, budget.totals), 10201), 1);
  const first = world.quests.find((q) => q.id === 'quest-11010');
  const completed = resourceBudget(p, reference(inventory, { quests: [{ id: first.gameId, step: 4 }] }));
  assert.equal(completed.directTotals['10201'], 7);
  assert.equal(completed.totals['10201'], 10);
  assert.deepEqual(
    p.allocations.map((a) => a.items['10201']),
    [4, 5],
  );
  assertPhysicalConservation(budget, inventory);
});

test('existing ingot plus ore uses the ingot directly and charges only the remaining processing once', () => {
  const inventory = [...supportsGold(), { id: 10221, count: 1 }, { id: 10207, count: 1 }];
  const budget = resourceBudget(profile(), reference(inventory, { money: 1200, fusionRecipes: [9505] }));
  const plan = budget.crafts[0].processing;
  assert.equal(budget.directTotals['10221'], 1);
  assert.equal(budget.totals['10221'], 1);
  assert.equal(plan.directPhysicalUsed['10221'], 1);
  assert.equal(plan.processingPhysicalUsed['10221'], undefined);
  assert.equal(plan.processingPhysicalUsed['10207'], 1);
  assert.equal(plan.plannedUsed['10221'], 1);
  assert.equal(plan.stages.find((s) => s.id === 'fusion-9505').quantity, 1);
  assert.equal(plan.stages.find((s) => s.id === 'fusion-9505').learned, true);
  assert.equal(plan.stages.find((s) => s.final).learned, false);
  assert.equal(plan.stages.find((s) => s.final).materialsAvailableNow, false);
  assert.equal(plan.hasAllBaseIngredients, true);
  assert.deepEqual(plan.workRemaining, { final: 1, processing: 1 });
  assert(plan.stages.every((s) => s.levelConfirmed === false));
  assert.equal(budget.money, 1232);
  assert.equal(budget.processingMoney, 100);
  assert.equal(budget.copperMissing, 32);
  assertPhysicalConservation(budget, inventory);
});

test('a conservative multi-yield surplus has planned provenance and never inflates physical inventory', () => {
  const base = recipe('fusion-1000'),
    second = recipe('fusion-1001'),
    smelt = recipe('fusion-9500');
  base.materials = second.materials = [{ id: 10216, name: '铁锭', count: 1 }];
  smelt.results = [{ id: 10216, name: '铁锭', count: 3 }];
  const inventory = [
    { id: 10201, count: 1 },
    { id: 10205, count: 1 },
  ];
  const plan = craftingStages(
    [
      { id: base.id, quantity: 1 },
      { id: second.id, quantity: 1 },
    ],
    { inventory },
    {},
    {},
    [base, second, smelt],
  );
  assert.deepEqual(plan.physicalUsed, { 10201: 1, 10205: 1 });
  assert.deepEqual(plan.directPhysicalUsed, {});
  assert.deepEqual(plan.plannedUsed, { 10216: 2 });
  assert.equal(plan.plannedSurplus[0].count, 1);
  assert.equal(plan.plannedSurplus[0].recipeId, smelt.id);
  assert.equal(plan.plannedSurplus[0].conditional, true);
  assert.equal(
    plan.physicalRemaining.some((m) => m.id === 10216 && m.count),
    false,
  );
  assert.equal(plan.stages.filter((s) => !s.final).length, 1);
  assert(
    plan.stages
      .filter((s) => s.final)
      .every((s) =>
        s.materials[0].sources.some((a) => a.source === 'planned-output' && a.recipeId === smelt.id),
      ),
  );
  assert.equal(plan.rawMissingTotal, 0);
});

test('conditional surplus stays inside its plan; shared ore usage respects physical stock', () => {
  const recipes = structuredClone(entries);
  recipes.find((r) => r.id === 'fusion-9505').results = [{ id: 10221, name: '金锭', count: 4 }];
  const inventory = [...supportsGold(2), { id: 10207, count: 1 }];
  const p = profile({ craftPlans: [{ id: 'second', name: '第二计划', list: gold(), reserved: true }] });
  const budget = resourceBudget(p, reference(inventory), { processingRecipeData: recipes });
  assert.equal(budget.totals['10207'], 1);
  assert.equal(budget.totals['10221'], undefined);
  assert.equal(budget.crafts[0].processing.plannedSurplus.find((m) => m.id === 10221).count, 2);
  assert.equal(budget.crafts[1].processing.rawMaterials.find((m) => m.id === 10207).missing, 1);
  assert.equal(budget.crafts[1].processing.processingPhysicalUsed['10207'], undefined);
  assertPhysicalConservation(budget, inventory);
});

test('each plan owns its processing choice; recipe goals do not inherit draft choices', () => {
  const recipes = structuredClone(entries).filter((r) => r.id !== 'fusion-9506');
  const alternate = recipe('fusion-9505');
  alternate.id = 'fusion-9506';
  alternate.gameId = 9506;
  alternate.name = '合成验收替代加工';
  alternate.materials = [
    { id: 10201, name: '铁矿石', count: 1 },
    { id: 10205, name: '煤炭', count: 1 },
  ];
  recipes.push(alternate);
  const p = profile({
    craftChoices: { 10221: 'fusion-9505' },
    craftPlans: [{ id: 'alternate', name: '另一选择', list: gold(), choices: { 10221: alternate.id } }],
    goals: [{ id: 'gold-goal', done: false, source: { type: 'database', id: 'fusion-1002', quantity: 2 } }],
  });
  const inventory = [...supportsGold(3), { id: 10207, count: 2 }, { id: 10201, count: 2 }];
  const budget = resourceBudget(p, reference(inventory), { processingRecipeData: recipes });
  assert.equal(budget.crafts[0].processing.processingPhysicalUsed['10207'], 2);
  assert.equal(budget.crafts[0].processing.processingPhysicalUsed['10201'], undefined);
  assert.equal(budget.crafts[1].processing.processingPhysicalUsed['10201'], 2);
  assert.equal(budget.crafts[1].processing.processingPhysicalUsed['10207'], undefined);
  const goal = budget.crafts.find((c) => c.id === '@recipe-goals');
  assert.equal(goal.list[0].quantity, 1);
  assert(goal.processing.decisions.some((d) => d.itemId === 10221 && d.recipes.length === 2));
  assert.deepEqual(goal.processing.processingPhysicalUsed, {});
  assert.equal(goal.processing.moneyComplete, false);
  const opened = resourceBudget(
    profile({
      activeCraftPlanId: 'saved',
      craftChoices: { 10221: alternate.id },
      craftPlans: [
        {
          id: 'saved',
          name: '已打开',
          list: [{ id: 'fusion-1002', quantity: 2 }],
          choices: { 10221: 'fusion-9505' },
        },
      ],
    }),
    reference(inventory),
    { processingRecipeData: recipes },
  );
  assert.equal(opened.crafts.length, 1);
  assert.equal(opened.crafts[0].id, 'saved');
  assert.equal(opened.crafts[0].list[0].quantity, 1);
  assert.equal(opened.crafts[0].processing.processingPhysicalUsed['10201'], 2);
  assert.equal(opened.crafts[0].processing.processingPhysicalUsed['10207'], undefined);
  assertPhysicalConservation(budget, inventory);
});

test('random alternative outputs cannot pay an intermediate debt, cycles retain shortages and choices validate', () => {
  const randomRecipes = structuredClone(entries);
  const smelt = randomRecipes.find((r) => r.id === 'fusion-9505');
  smelt.results.push({ id: 10220, name: '随机银锭', count: 1 });
  const inventory = [...supportsGold(), { id: 10207, count: 2 }];
  const random = resourceBudget(profile(), reference(inventory), { processingRecipeData: randomRecipes });
  assert.equal(random.totals['10207'], undefined);
  assert.equal(
    random.crafts[0].processing.stages.some((s) => s.id === smelt.id),
    false,
  );
  assert.equal(random.crafts[0].processing.rawMaterials.find((m) => m.id === 10221).missing, 2);
  assert.throws(() => validateCraftChoices({ 10221: smelt.id }, randomRecipes), /不能稳定/);
  const cycles = structuredClone(entries);
  cycles.find((r) => r.id === smelt.id).materials = [{ id: 10221, name: '循环金锭', count: 1 }];
  const cycle = resourceBudget(profile(), reference(inventory), { processingRecipeData: cycles });
  const plan = cycle.crafts[0].processing;
  assert.equal(cycle.totals['10207'], undefined);
  assert(plan.warnings.some((w) => w.itemId === 10221));
  assert.equal(plan.hasAllBaseIngredients, false);
  assert.equal(plan.rawMaterials.find((m) => m.id === 10221).sources[0].reason, 'cycle');
  assert.equal(plan.moneyComplete, false);
});

test('unknown, unbound, mismatched or updating references expose planning estimates without inventing counts', () => {
  const ref = reference([...supportsGold(), { id: 10207, count: 2 }], {
    money: 10000,
    fusionRecipes: [9505],
  });
  for (const [extra, candidate, options] of [
    [{}, { ...ref, metadata: {} }, {}],
    [{ referenceMode: 'none' }, ref, {}],
    [{ referenceMode: 'slot', saveSlot: 'other.sav' }, ref, {}],
    [{ referenceMode: 'latest' }, ref, { error: 'updating' }],
  ]) {
    const budget = resourceBudget(profile(extra), candidate, options),
      plan = budget.crafts[0].processing;
    assert.equal(budget.inventoryAvailable, false);
    assert.deepEqual(budget.physicalUsed, {});
    assert.deepEqual(plan.physicalUsed, {});
    assert.equal(budget.directMissingTotal, null);
    assert.equal(budget.baseMaterialMissingTotal, null);
    assert.equal(plan.rawMissingTotal, null);
    assert.equal(plan.hasAllBaseIngredients, null);
    assert.equal(budget.copper, null);
    assert.equal(budget.copperMissing, null);
    assert(plan.rawMaterials.length > 0);
    assert(plan.rawMaterials.every((m) => m.count > 0 && m.missing === null));
    assert(plan.stages.every((s) => s.learned === null && s.materialsAvailableNow === null));
    assert(
      plan.stages
        .flatMap((s) => s.materials)
        .every((m) => m.missing === null && Number.isSafeInteger(m.planningMissing)),
    );
  }
});

test('unknown copper stays unknown even when all processing fees are included', () => {
  const budget = resourceBudget(profile(), reference([...supportsGold(), { id: 10207, count: 2 }]));
  assert.equal(budget.money, 1332);
  assert.equal(budget.processingMoney, 200);
  assert.equal(budget.copper, null);
  assert.equal(budget.copperMissing, null);
  assert.equal(budget.moneyComplete, true);
});

test('an uncovered leave-stock claim remains a claim while physical usage is clamped to actual stock', () => {
  const inventory = [
    { id: 10201, count: 1 },
    { id: 10246, count: 1 },
    { id: 10205, count: 4 },
  ];
  const budget = resourceBudget(
    profile({ craftList: [{ id: 'fusion-1000', quantity: 1 }], reservations: { 10201: 2 } }),
    reference(inventory),
  );
  assert.equal(budget.directTotals['10201'], 2);
  assert.equal(budget.totals['10201'], 2);
  assert.equal(budget.physicalUsed['10201'], 1);
  assert.equal(budget.crafts[0].processing.processingPhysicalUsed['10201'], undefined);
  assert.equal(budget.crafts[0].processing.rawMaterials.find((m) => m.id === 10201).missing, 3);
  assert.equal(budget.baseMaterialMissingTotal, 4);
  assert.equal(amount(subtractBudget(inventory, budget.totals), 10201), 0);
});

test('fixed top-level allocation preserves the global owner assignment before processing', () => {
  const base = recipe('fusion-1000'),
    smelt = recipe('fusion-9500');
  base.materials = [
    { name: '可替代锭', alternatives: [10216, 10221], count: 1 },
    { id: 10226, name: '精钢锭', count: 1 },
  ];
  smelt.results = [{ id: 10226, name: '精钢锭', count: 1 }];
  smelt.materials = [{ id: 10221, name: '金锭', count: 1 }];
  const directMaterials = [
    { ids: [10216, 10221], count: 1, allocation: [{ id: 10221, count: 1 }] },
    { ids: [10226], count: 1, allocation: [] },
  ];
  const plan = craftingStages(
    [{ id: base.id, quantity: 1 }],
    {
      inventory: [
        { id: 10216, count: 1 },
        { id: 10221, count: 1 },
      ],
    },
    {},
    {},
    [base, smelt],
    { directMaterials },
  );
  assert.deepEqual(plan.directPhysicalUsed, { 10221: 1 });
  assert.deepEqual(plan.processingPhysicalUsed, {});
  assert.equal(amount(plan.physicalRemaining, 10216), 1);
  assert.equal(plan.rawMaterials.find((m) => m.id === 10221).missing, 1);
  assert.equal(directMaterials[0].allocation[0].count, 1);
  assert.throws(
    () =>
      craftingStages([{ id: base.id, quantity: 1 }], { inventory: [] }, {}, {}, [base, smelt], {
        directMaterials,
      }),
    /超过可用/,
  );
});

test('large legal aggregated goals expand through processing while editor validation remains unchanged', () => {
  const p = profile({
    craftList: [],
    goals: Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      done: false,
      source: { type: 'database', id: 'fusion-1000', quantity: 999 },
    })),
  });
  const budget = resourceBudget(p, reference([]));
  const plan = budget.crafts[0].processing;
  assert.equal(budget.crafts[0].list[0].quantity, 2997);
  assert.equal(plan.stages.find((s) => s.id === 'fusion-9500').quantity, 8991);
  assert.equal(plan.rawMaterials.find((m) => m.id === 10201).missing, 8991);
  assert.throws(() => validateCraftList([{ id: 'fusion-1000', quantity: 2997 }]), /1 至 999/);
});

test('a full legal goal profile stays readable with many distinct recipes and maximum quantities', () => {
  const goals = entries
    .filter((e) => e.kind === '配方')
    .slice(0, 300)
    .map((e, i) => ({
      id: String(i),
      done: false,
      source: { type: 'database', id: e.id, quantity: 999 },
    }));
  const budget = resourceBudget(profile({ craftList: [], goals }), reference([]));
  assert.equal(budget.crafts[0].list.length, goals.length);
  assert.equal(budget.crafts[0].processing.stages.filter((s) => s.final).length, goals.length);
  assert(budget.baseMaterialMissingTotal > 0);
});

test('all exclusion paths release processing and a completed named plan remains released', () => {
  const inventory = [...supportsGold(), { id: 10207, count: 2 }];
  const p = profile({
    activeCraftPlanId: 'saved',
    craftPlans: [{ id: 'saved', name: '已打开', list: gold(), reserved: true }],
    goals: [{ id: 'linked', done: false, source: { type: 'planner', id: 'saved' } }],
  });
  assert.equal(resourceBudget(p, reference(inventory)).totals['10207'], 2);
  assert.deepEqual(resourceBudget(p, reference(inventory), { excludePlanId: 'saved' }).totals, {});
  assert.deepEqual(resourceBudget(p, reference(inventory), { excludeDraft: true }).totals, {});
  p.goals[0].done = true;
  assert.deepEqual(resourceBudget(p, reference(inventory)).totals, {});
  const goalOnly = profile({
    craftList: [],
    goals: [{ id: 'gold', done: false, source: { type: 'database', id: 'fusion-1002', quantity: 1 } }],
  });
  assert.deepEqual(
    resourceBudget(goalOnly, reference(inventory), { excludeRecipeId: 'fusion-1002' }).totals,
    {},
  );
  assert.deepEqual(resourceBudget(goalOnly, reference(inventory), { excludeRecipeGoals: true }).totals, {});
});
