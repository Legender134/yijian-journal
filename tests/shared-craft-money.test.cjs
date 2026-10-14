'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { defaults } = require('../src/core/store.cjs');
const { resourceBudget, materialReport, craftMoneySummary } = require('../src/core/resource-budget.cjs');
const { priorityReferenceProfile, resourcePriorityPreview } = require('../src/core/resource-priority.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const catalog = require('../src/data/catalog.cjs');
const index = require('../src/data/game-index.json');
const recipe = index.entries.find((e) => e.id === 'fusion-1000');
const at = '2026-10-09T00:00:00.000Z';
function fixture() {
  const state = defaults(),
    p = state.profiles[0];
  p.referenceMode = 'latest';
  p.craftList = [{ id: recipe.id, quantity: 1 }];
  p.activeCraftPlanId = 'a';
  p.craftPlans = ['a', 'b'].map((id) => ({
    id,
    name: '合成计划' + id,
    list: structuredClone(p.craftList),
    reserved: true,
    done: false,
    choices: {},
    createdAt: at,
    updatedAt: at,
  }));
  const reference = {
    name: '1.sav',
    hash: 'a'.repeat(64),
    modifiedAt: at,
    metadata: {
      inventory: recipe.materials.map((m) => ({ id: m.id, count: m.count * 2 })),
      money: 1000,
      quests: [],
    },
  };
  return { state, p, reference };
}
const helpers = {
  esc: (v) => String(v).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  act: (_a, v) => v || '',
  icon: () => '',
  iconButton: () => '',
  picture: () => '',
  pill: (v) => v,
  notice: (v) => v,
  empty: (v) => v,
  when: (v) => v,
  qualityText: { name: (_id, v) => v },
};
const views = Promise.all(
  ['material-views.js', 'companion-view.js'].map(
    (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer', file)).href),
  ),
);

test('empty material lists keep the merge action only for unfinished recipe goals', async () => {
  const [materials] = await views;
  const act = (action, label) => `<button data-action="${action}">${label}</button>`;
  const p = defaults().profiles[0];
  for (const [source, done, expected] of [
    [{ type: 'database', id: recipe.id }, false, true],
    [{ type: 'database', id: recipe.id }, true, false],
    [{ type: 'database', id: 'item-10300' }, false, false],
    [{ type: 'guide', id: 'wei-training' }, false, false],
  ]) {
    p.goals = [{ source, done }];
    const html = materials.createMaterialViews({ ...helpers, act }).page(index, p, { query: '' }, []);
    assert.equal(html.includes('data-action="craft-goals-merge"'), expected);
    assert.doesNotMatch(html, /craft-result-card|先选一份配方/);
  }
});

test('an unresolved fish alternative stays missing even when no fixed raw material is missing', async () => {
  const p = defaults().profiles[0];
  p.craftList = [{ id: 'cooking-102', quantity: 1 }];
  for (const fishCount of [0, 2]) {
    const report = materialReport(p, {
      name: 'synthetic.sav',
      hash: 'a'.repeat(64),
      metadata: {
        inventory: [
          { id: 10319, count: 99 },
          { id: 10324, count: 99 },
          { id: 10525, count: fishCount },
        ],
        money: 99999,
      },
    });
    assert.equal(report.stages.rawMaterials.length, 0);
    assert.equal(report.stages.rawMissingTotal, 2 - fishCount);
    const [materials] = await views;
    const html = materials.createMaterialViews(helpers).page(
      index,
      p,
      {
        query: '',
        result: report,
        resultList: p.craftList,
        resultChoices: '{}',
        profileId: p.id,
      },
      [],
    );
    if (fishCount) assert.match(html, /原料已齐/);
    else {
      assert.doesNotMatch(html, /原料已齐/);
      assert.match(html, /请补足下方待选择材料/);
      assert.match(html, /鱼肉 · 还缺 2/);
    }
  }
});
test('all active costs reach the material report, journey warning and companion even when each local cost fits', async () => {
  const { state, p, reference } = fixture(),
    before = JSON.stringify({ state, reference });
  const budget = resourceBudget(p, reference),
    report = materialReport(p, reference);
  assert.equal(budget.money, 1144);
  assert.equal(budget.copperMissing, 144);
  assert.equal(report.copperMissing, 0, 'the local field remains a single-plan estimate');
  assert.equal(report.sharedBudget.moneySummary.status, 'shortfall');
  const journey = journeyPlan(p, reference, budget);
  assert.match(
    journey.warnings.find((w) => w.code === 'craft-money-shortfall').message,
    /1,144.*1,000.*共同还差 144/,
  );
  const companion = companionSnapshot(state, catalog, reference);
  assert.match(companion.hints.find((h) => h.type === 'material').title, /全部制作计划铜钱还差 144/);
  const [materials, compact] = await views;
  const html = materials
    .createMaterialViews(helpers)
    .page(
      index,
      p,
      { query: '', result: report, resultList: p.craftList, resultChoices: '{}', profileId: p.id },
      [],
    );
  assert.match(html, /共同还差 144 文/);
  assert.doesNotMatch(html, /足够支付基础制作费|足够支付这条/);
  assert.match(compact.createCompanionViews(helpers).materials(companion), /共同还差 144 文/);
  assert.equal(JSON.stringify({ state, reference }), before);
  const reordered = resourceBudget({ ...p, resourcePriority: ['b', 'a'] }, reference);
  assert.equal(reordered.copperMissing, 144, 'material order does not grant the same copper to both owners');
});
test('unknown fees, unknown copper and incomplete routes cannot become an all-plan sufficient claim', () => {
  const known = {
    crafts: [{}],
    money: 1144,
    processingMoney: 0,
    moneyComplete: true,
    copper: 1144,
    copperMissing: 0,
    inventoryAvailable: true,
  };
  assert.equal(craftMoneySummary(known).status, 'supported');
  for (const [change, status, text] of [
    [{ money: null, copperMissing: null, moneyComplete: false }, 'unknown-fee', /费用资料未齐/],
    [{ copper: null, copperMissing: null }, 'unknown-copper', /存档铜钱待核对/],
    [{ moneyComplete: false }, 'incomplete', /完整路线费用待核对/],
    [{ moneyComplete: false, copper: 1000, copperMissing: 144 }, 'incomplete', /至少缺 144/],
    [{ inventoryAvailable: false }, 'unknown-inventory', /库存未核对/],
  ]) {
    const result = craftMoneySummary({ ...known, ...change });
    assert.equal(result.status, status);
    assert.match(result.message, text);
    assert.doesNotMatch(result.message, /足够支付/);
  }
  assert.equal(craftMoneySummary({ ...known, crafts: [] }), null);
  const { p, reference } = fixture();
  delete reference.metadata.money;
  const noCopper = resourceBudget(p, reference);
  assert.equal(noCopper.moneySummary.status, 'unknown-copper');
  assert.equal(noCopper.copperMissing, null);
  p.craftList = [{ id: 'fusion-1002', quantity: 1 }];
  p.craftPlans = [];
  delete p.activeCraftPlanId;
  const recipes = structuredClone(index.entries);
  recipes.find((r) => r.id === 'fusion-9505').money = null;
  reference.metadata.money = 1000;
  const noFee = resourceBudget(p, reference, { processingRecipeData: recipes });
  assert.equal(noFee.money, null);
  assert.equal(noFee.copperMissing, null);
  assert.equal(noFee.moneySummary.status, 'unknown-fee');
});
test('completed and released plans leave the shared cost; a selected completed plan keeps only its redo estimate', async () => {
  for (const change of [
    (p) => (p.craftPlans[0].done = true),
    (p) => (p.craftPlans[0].reserved = false),
    (p) => (p.reserveCraftDraft = false),
    (p) => (p.goals = [{ id: 'linked', done: true, source: { type: 'planner', id: 'a' } }]),
  ]) {
    const { p, reference } = fixture();
    change(p);
    assert.equal(resourceBudget(p, reference).money, 572);
  }
  const { state, p, reference } = fixture();
  p.craftPlans[0].done = true;
  const report = materialReport(p, reference),
    snapshot = companionSnapshot(state, catalog, reference);
  assert.equal(report.money, 572);
  assert.equal(report.sharedBudget.money, 572);
  assert.equal(snapshot.materialsCompleted, true);
  assert.equal(
    snapshot.hints.some((h) => h.type === 'material'),
    false,
  );
  const [materials, compact] = await views;
  const html = materials
    .createMaterialViews(helpers)
    .page(
      index,
      p,
      { query: '', result: report, resultList: p.craftList, resultChoices: '{}', profileId: p.id },
      [],
    );
  assert.match(html, /若重新制作的用料核对/);
  assert.match(
    compact.createCompanionViews(helpers).materials(snapshot),
    /若重做含加工费用 572 文，未纳入共同预算/,
  );
  p.goals.push({
    id: 'independent',
    done: false,
    title: '合成独立目标',
    source: { type: 'database', id: recipe.id, quantity: 2 },
  });
  assert.equal(
    resourceBudget(p, reference).money,
    1866,
    'independent goals remain real demand, including 150 for the third set of ingots',
  );
  const withGoal = companionSnapshot(state, catalog, reference);
  assert.equal(
    withGoal.materials.recipes[0].quantity,
    1,
    'the independent target is not merged into completed redo',
  );
});
test('a local source projection preserves defaults and produces a source-specific preview and fingerprint', () => {
  const { p, reference } = fixture(),
    before = JSON.stringify(p);
  const older = {
    ...reference,
    name: '0.sav',
    hash: '0'.repeat(64),
    metadata: {
      ...reference.metadata,
      inventory: recipe.materials.map((m) => ({ id: m.id, count: m.count })),
    },
  };
  const scoped = priorityReferenceProfile(p, older.name);
  const report = materialReport(scoped, older),
    preview = resourcePriorityPreview(scoped, older, ['b', 'a']);
  assert.equal(report.sharedBudget.directMissingTotal, 5);
  assert.equal(report.sharedBudget.baseMaterialMissingTotal, 8);
  assert.equal(preview.referenceIdentity.name, '0.sav');
  assert.notEqual(preview.fingerprint, resourcePriorityPreview(p, reference, ['b', 'a']).fingerprint);
  assert.equal(priorityReferenceProfile(p, '').referenceMode, 'none');
  assert.equal(priorityReferenceProfile(p, '@latest').referenceMode, 'latest');
  assert.equal(priorityReferenceProfile(p, undefined), p);
  for (const invalid of ['../0.sav', 'C:\\private\\0.sav', 'foreign.sav', {}, null])
    assert.throws(() => priorityReferenceProfile(p, invalid));
  assert.equal(JSON.stringify(p), before);
});

test('material processing and shared ledgers keep exact catalogue links without changing quantities', async () => {
  const { p, reference } = fixture();
  p.craftList = [{ id: 'fusion-1002', quantity: 1 }];
  p.craftPlans = [];
  reference.metadata.inventory = [
    { id: 10205, count: 10 },
    { id: 10207, count: 3 },
  ];
  const report = materialReport(p, reference);
  const act = (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`;
  const [materials] = await views;
  const html = materials.createMaterialViews({ ...helpers, act }).page(
    index,
    p,
    {
      query: '',
      result: report,
      resultList: p.craftList,
      resultChoices: '{}',
      profileId: p.id,
    },
    [],
  );
  assert.match(
    html,
    /计划产物 · 先完成 <button data-action="database-detail" data-id="fusion-9500">铁锭<\/button>/,
  );
  const fs = require('node:fs'),
    vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const context = {
    act,
    esc: helpers.esc,
    gameIndex: { ...index, world: { quests: [] } },
    gameViews: { byId: (data, id) => data.entries.find((entry) => entry.id === id) },
    profile: () => ({ allocations: [{ questId: 'quest-synthetic', items: { 10205: 2 } }] }),
    materialBudgetContext: () => ({ summary: null }),
    resourcePriorityViews: { entry: () => '' },
    craftMoneyNotice: () => '',
  };
  vm.createContext(context);
  vm.runInContext(
    source.slice(
      source.indexOf('function allocationLedger()'),
      source.indexOf('function renderResourcePriorityDialog()'),
    ) +
      source.slice(
        source.indexOf('function craftBudgetLedger(summary)'),
        source.indexOf('function invalidateMaterials()'),
      ),
    context,
  );
  assert.match(context.allocationLedger(), /data-id="item-10205">煤炭<\/button>/);
  const summary = {
    crafts: [
      {
        id: '@draft',
        name: '合成计划',
        materials: [
          { name: '材料组', ids: [10205, 10207], count: 3, missing: 2, allocation: [{ count: 1 }] },
        ],
      },
    ],
  };
  const before = JSON.stringify(summary);
  const ledger = context.craftBudgetLedger(summary);
  for (const id of [10205, 10207]) assert(ledger.includes('data-id="item-' + id + '"'));
  assert.match(ledger, /直接需 3 · 已分配 1 · 还缺 2/);
  assert.equal(JSON.stringify(summary), before);
});
