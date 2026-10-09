'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { craftingStages } = require('../src/core/crafting-stages.cjs');
const entries = require('../src/data/game-index.json').entries;

test('fusion-1001 keeps the recipe and learning blueprint distinct from the blue sword result without changing its budget', () => {
  const input = {
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 2 },
      { id: 10205, count: 2 },
    ],
    fusionRecipes: [1001],
  };
  const before = JSON.stringify(input);
  const result = craftingStages([{ id: 'fusion-1001', quantity: 1 }], input);
  const step = result.stages.find((s) => s.final);
  assert.equal(step.name, '白光剑精良图纸');
  assert.deepEqual(step.learningItems, [100001]);
  assert.deepEqual(step.outputs, [
    {
      id: 1005,
      name: '白光剑',
      quality: '蓝',
      minimumCount: 1,
      maximumCount: 1,
      weights: [1],
      guaranteedItem: true,
    },
  ]);
  assert.deepEqual(result.physicalUsed, { 10216: 3, 10246: 2, 10205: 2 });
  assert.equal(result.rawMissingTotal, 0);
  assert.equal(result.money, 645);
  assert.equal(result.plannedOutputs[0].itemId, 1005);
  assert.equal(result.plannedOutputs[0].conditional, true);
  assert.equal(JSON.stringify(input), before);
});

test('quality variants remain possible alternative outputs; varying counts retain a conservative range', () => {
  const recipe = structuredClone(entries.find((e) => e.id === 'fusion-1001'));
  recipe.results.push({ id: 1004, name: '白光剑', count: 2, weight: 3 });
  const data = [recipe, ...entries.filter((e) => ['item-1004', 'item-1005'].includes(e.id))];
  const result = craftingStages([{ id: recipe.id, quantity: 2 }], { inventory: [] }, {}, {}, data);
  assert.equal(result.plannedOutputs[0].itemId, null);
  assert.equal(result.plannedOutputs[0].count, null);
  assert.equal(result.stages[0].minimumYield, null);
  assert.deepEqual(
    result.stages[0].outputs.map((o) => [o.id, o.quality, o.minimumCount, o.guaranteedItem]),
    [
      [1005, '蓝', 2, false],
      [1004, '绿', 4, false],
    ],
  );
  recipe.results = [
    { id: 1005, count: 1, weight: 1 },
    { id: 1005, count: 3, weight: 1 },
  ];
  const ranged = craftingStages([{ id: recipe.id, quantity: 2 }], null, {}, {}, data);
  assert.equal(ranged.stages[0].outputs[0].minimumCount, 2);
  assert.equal(ranged.stages[0].outputs[0].maximumCount, 6);
  assert.equal(ranged.plannedOutputs[0].count, 2);
});
