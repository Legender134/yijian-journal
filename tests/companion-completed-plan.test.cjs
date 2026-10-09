'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { defaults } = require('../src/core/store.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const catalog = require('../src/data/catalog.cjs');
const recipe = require('../src/data/game-index.json').entries.find((e) => e.id === 'fusion-1002');
const views = import(
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(__dirname, '../src/renderer/companion-view.js')).toString('base64')
);
function fixture() {
  const state = defaults(),
    p = state.profiles[0],
    at = '2026-10-09T00:00:00.000Z';
  p.referenceMode = 'latest';
  p.craftList = [{ id: recipe.id, quantity: 1 }];
  p.craftPlans = [
    {
      id: 'first',
      name: '尚未完成的一份',
      list: structuredClone(p.craftList),
      choices: {},
      reserved: true,
      done: false,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'second',
      name: '已做完的 <img> 第二份',
      list: structuredClone(p.craftList),
      choices: {},
      reserved: true,
      done: true,
      createdAt: at,
      updatedAt: at,
    },
  ];
  p.activeCraftPlanId = 'second';
  return {
    state,
    p,
    reference: {
      name: '1.sav',
      hash: 'a'.repeat(64),
      modifiedAt: at,
      metadata: { inventory: recipe.materials.map((m) => ({ id: m.id, count: m.count })), money: 999999 },
    },
  };
}
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
test('completed selected plan has an identified redo preview, leaves real demand unchanged and never urges passive material work', async () => {
  const { state, p, reference } = fixture();
  const snapshot = companionSnapshot(state, catalog, reference);
  assert.equal(snapshot.materialsLabel, p.craftPlans[1].name);
  assert.equal(snapshot.materialsCompleted, true);
  assert.equal(snapshot.allocations.missingTotal, 0);
  assert.ok(snapshot.materials.missing > 0, 'hypothetical redo competes with the real unfinished plan');
  assert.ok(
    snapshot.hints.every((h) => h.type !== 'material'),
    'completed plan must not become a passive instruction to gather',
  );
  const { createCompanionViews } = await views;
  const ui = createCompanionViews({
    esc,
    icon: () => '',
    act: () => '',
    picture: () => '',
    qualityText: { name: (_id, text) => esc(text) },
  });
  const html = ui.materials(snapshot);
  assert.match(html, /个人已制作完成/);
  assert.match(html, /下方仅供若重新制作时核对/);
  assert.match(html, /若重做：/);
  assert.match(html, /已做完的 &lt;img&gt; 第二份/);
  assert.doesNotMatch(html, /<img>/);
  const restarted = companionSnapshot(JSON.parse(JSON.stringify(state)), catalog, reference);
  assert.equal(restarted.materialsCompleted, true);
  assert.equal(restarted.materialsLabel, snapshot.materialsLabel);
});
test('reopening the same selected plan restores actionable demand and keeps independent recipe goals out of completed redo scope', () => {
  const { state, p, reference } = fixture();
  p.goals.push({
    id: 'independent-recipe',
    title: '独立制作目标',
    detail: '',
    done: false,
    source: { type: 'database', id: recipe.id, quantity: 7 },
  });
  const completed = companionSnapshot(state, catalog, reference);
  assert.equal(completed.materials.recipes[0].quantity, 1);
  assert.ok(completed.hints.some((h) => h.id === 'independent-recipe'));
  p.goals = [];
  p.craftPlans[1].done = false;
  const reopened = companionSnapshot(state, catalog, reference);
  assert.equal(reopened.materialsCompleted, false);
  assert.ok(reopened.allocations.missingTotal > 0);
  assert.ok(reopened.hints.some((h) => h.type === 'material'));
});
