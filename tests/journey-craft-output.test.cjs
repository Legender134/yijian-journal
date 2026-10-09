'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { journeyPlan, createJourneyPlanner } = require('../src/core/journey-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const game = require('../src/data/game-index.json'),
  world = require('../src/data/world-index.json');
const rendering = import(
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(__dirname, '../src/renderer/journey-views.js')).toString('base64')
);
const profile = {
  id: 'synthetic-profile',
  referenceMode: 'none',
  goals: [],
  craftPlans: [
    {
      id: 'sword-plan',
      name: '要制作的剑',
      list: [{ id: 'fusion-1001', quantity: 2 }],
      reserved: true,
      done: false,
    },
  ],
};
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
async function html(plan, data = game) {
  const { createJourneyViews } = await rendering;
  return createJourneyViews({
    esc,
    act: (action, label, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    icon: () => '',
    notice: esc,
    empty: esc,
    when: esc,
  }).page(plan, {}, { ...data, world });
}
test('a craft action names the actual blue sword rather than its learning blueprint, while retaining the original recipe and unchanged resource budget', async () => {
  const p = structuredClone(profile),
    before = structuredClone(p),
    budget = resourceBudget(p, null),
    budgetBefore = structuredClone(budget);
  const plan = journeyPlan(p, null, budget),
    craft = plan.actions.find((a) => a.kind === 'craft' && a.recipeId === 'fusion-1001');
  assert.match(craft.title, /白光剑（蓝色品质）.*× 2 次配方/);
  assert(!craft.title.includes('图纸'));
  assert.equal(craft.recipe.name, '白光剑精良图纸');
  assert.equal(craft.recipe.quantity, 2);
  const view = await html(plan);
  assert.match(view, /执行配方：白光剑精良图纸 · 2 次/);
  assert.match(view, /data-journey-craft-output="1005"[\s\S]*data-id="item-1005"[\s\S]*蓝色品质 × 2/);
  assert.match(view, /计划产物尚未进入背包/);
  assert.deepEqual(p, before);
  assert.deepEqual(budget, budgetBefore);
});
test('alternative quality outputs remain separate possible items, never summed into a guaranteed result', async () => {
  const data = structuredClone(game),
    recipe = data.entries.find((e) => e.id === 'fusion-1001');
  recipe.results = [
    { id: 1005, name: '白光剑', count: 1, weight: 5 },
    { id: 1004, name: '白光剑', count: 2, weight: 3 },
  ];
  const plan = createJourneyPlanner({ world, game: data }).journeyPlan(profile, null),
    craft = plan.actions.find((a) => a.kind === 'craft' && a.recipeId === recipe.id);
  assert.match(craft.title, /核对并执行配方：白光剑精良图纸 × 2 次/);
  const view = await html(plan, data);
  assert.match(view, /data-journey-craft-output="1005"[\s\S]*可能产物[\s\S]*蓝色品质 × 2/);
  assert.match(view, /data-journey-craft-output="1004"[\s\S]*可能产物[\s\S]*绿色品质 × 4/);
  assert.match(view, /不表示同时得到全部物品或品质/);
  assert(!view.includes('蓝色品质 × 6'));
});
test('varying counts retain the conservative range and no result data stays explicitly unknown', async () => {
  for (const results of [
    [
      { id: 1005, count: 1 },
      { id: 1005, count: 3 },
    ],
    [],
  ]) {
    const data = structuredClone(game),
      recipe = data.entries.find((e) => e.id === 'fusion-1001');
    recipe.results = results;
    const plan = createJourneyPlanner({ world, game: data }).journeyPlan(profile, null),
      view = await html(plan, data);
    if (results.length) {
      assert.match(view, /蓝色品质 × 2–6/);
      assert(!view.includes('不表示同时得到全部物品或品质'));
    } else {
      assert.match(view, /产物资料待核对/);
      assert.match(plan.actions.find((a) => a.recipeId === recipe.id).title, /核对并执行配方/);
    }
  }
});
