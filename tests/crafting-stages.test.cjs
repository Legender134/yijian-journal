'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { craftingStages } = require('../src/core/crafting-stages.cjs');
const data = require('../src/data/game-index.json').entries;
test('gold ingot shortage expands to mining, smelting, then the final craft at conservative minimum yield', () => {
  const plan = craftingStages([{ id: 'fusion-1002', quantity: 3 }], { inventory: [], fusionRecipes: [9505] });
  const gold = plan.stages.find((s) => s.id === 'fusion-9505');
  assert.equal(gold.quantity, 6);
  assert.equal(gold.minimumYield, 1);
  assert.equal(gold.learned, true);
  assert.equal(plan.rawMaterials.find((m) => m.id === 10207).count, 6);
  assert(plan.stages.indexOf(gold) < plan.stages.findIndex((s) => s.final));
  assert.match(plan.notice, /还不是背包库存/);
});
test('existing intermediates and shared raw stock are consumed once across several final recipes', () => {
  const metadata = { inventory: [{ id: 10216, count: 4 }, { id: 10246, count: 3 }, { id: 10205, count: 3 }] };
  const before = JSON.stringify(metadata);
  const plan = craftingStages([{ id: 'fusion-1000', quantity: 1 }, { id: 'fusion-1001', quantity: 1 }], metadata);
  assert.equal(plan.stages.filter((s) => s.id === 'fusion-9500').reduce((sum, s) => sum + s.quantity, 0), 2);
  assert.equal(plan.rawMaterials.find((m) => m.id === 10201).count, 2);
  assert.equal(plan.rawMaterials.find((m) => m.id === 10205).count, 2);
  assert.equal(JSON.stringify(metadata), before);
});
test('alternative producers require a choice, cycles stop, and random non-guaranteed outputs are not invented', () => {
  const base = structuredClone(data.find((r) => r.id === 'fusion-1000'));
  const smelt = structuredClone(data.find((r) => r.id === 'fusion-9500'));
  const duplicate = { ...structuredClone(smelt), id: 'fusion-9505', gameId: 9505 };
  const pending = craftingStages([{ id: base.id, quantity: 1 }], { inventory: [] }, {}, {}, [base, smelt, duplicate]);
  assert(pending.decisions.some((d) => d.itemId === 10216 && d.recipes.length === 2));
  const chosen = craftingStages([{ id: base.id, quantity: 1 }], { inventory: [] }, {}, { '10216': smelt.id }, [base, smelt, duplicate]);
  assert(chosen.stages.some((s) => s.id === smelt.id));
  smelt.materials = [{ id: 10216, name: '循环铁锭', count: 1 }];
  const cycle = craftingStages([{ id: base.id, quantity: 1 }], { inventory: [] }, {}, {}, [base, smelt]);
  assert(cycle.warnings.some((w) => w.itemId === 10216));
  smelt.results.push({ id: 10217, name: '随机铜锭', count: 1 });
  const random = craftingStages([{ id: base.id, quantity: 1 }], { inventory: [] }, {}, {}, [base, smelt]);
  assert.equal(random.stages.some((s) => s.id === smelt.id), false);
});
test('unknown inventory and recipe knowledge remain unknown while full planning demand is still usable', () => {
  const plan = craftingStages([{ id: 'fusion-1000', quantity: 1 }]);
  assert.equal(plan.inventoryAvailable, false);
  assert(plan.rawMaterials.length > 0);
  assert(plan.stages.every((s) => s.learned === null));
});
test('a flexible ingredient cannot consume the only stock required by a fixed ingredient', () => {
  const flexible = structuredClone(data.find((r) => r.id === 'cooking-102'));
  flexible.materials = [{ name: '鱼肉', alternatives: [10525, 10526], count: 1 }];
  const fixed = structuredClone(data.find((r) => r.id === 'fusion-1000'));
  fixed.materials = [{ id: 10525, name: '草鱼', count: 1 }];
  const plan = craftingStages([{ id: flexible.id, quantity: 1 }, { id: fixed.id, quantity: 1 }],
    { inventory: [{ id: 10525, count: 1 }, { id: 10526, count: 1 }] }, {}, {}, [flexible, fixed]);
  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.rawMaterials.length, 0);
});
