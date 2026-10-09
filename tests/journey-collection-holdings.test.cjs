'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { journeyPlan, createJourneyPlanner } = require('../src/core/journey-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { emptyJourneyState } = require('../src/core/journey-state.cjs');
const game = require('../src/data/game-index.json'),
  world = require('../src/data/world-index.json');
const rendering = import(pathToFileURL(path.join(__dirname, '../src/renderer/journey-views.js')).href);
const goal = (id) => ({
  id: `collect-${id}`,
  title: '收藏这件物品',
  detail: '',
  done: false,
  source: { type: 'database', id: `item-${id}`, quantity: 1 },
});
const profile = (extra = {}) => ({
  id: 'synthetic-collection-profile',
  referenceMode: 'slot',
  saveSlot: 'synthetic-collection.sav',
  goals: [goal(1000)],
  ...extra,
});
const reference = (inventory = []) => ({
  name: 'synthetic-collection.sav',
  hash: 'synthetic-collection-hash',
  modifiedAt: '2026-10-10T01:02:03.000Z',
  metadata: { quests: [], inventory },
});
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
async function html(plan, data = game, view = {}) {
  const { createJourneyViews } = await rendering;
  return createJourneyViews({
    esc,
    act: (action, label, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    icon: () => '',
    notice: esc,
    empty: esc,
    when: (value) => String(value ?? ''),
  }).page(plan, view, { ...data, world });
}
function card(view, action) {
  const marker = view.indexOf(`data-journey-id="${esc(action.id)}"`);
  assert.notEqual(marker, -1, 'the action is present without enabling completed actions');
  return view.slice(view.lastIndexOf('<article', marker), view.indexOf('</article>', marker) + 10);
}
const collection = (plan, itemId = 1000) =>
  plan.actions.find((a) => a.kind === 'collection' && a.material.ids.includes(itemId));

test('ten requested items use the saved four-item reference without reserving, auto-completing or rewriting that inventory', async () => {
  const g = goal(1000);
  g.source.quantity = 10;
  const p = profile({ goals: [g] }),
    r = reference([{ id: 1000, count: 4 }]),
    before = structuredClone({ p, r }),
    budget = resourceBudget(p, r),
    plan = journeyPlan(p, r, budget),
    action = collection(plan),
    view = card(await html(plan), action);
  assert.equal(action.material.count, 10);
  assert.equal(action.material.onHand, 4);
  assert.equal(action.material.missing, null);
  assert.equal(action.prepared, false);
  assert.equal(action.userDone, false);
  assert.match(view, /需 10 · 已保存持有 4/);
  assert.match(view, /仅收藏目标，未预留库存/);
  assert.deepEqual({ p, r }, before);
});

test('a collection card shows saved holdings and its reference without reserving stock or completing the personal goal', async () => {
  const p = profile(),
    r = reference([{ id: 1000, count: 5 }]),
    before = structuredClone({ p, r }),
    budget = resourceBudget(p, r),
    budgetBefore = structuredClone(budget),
    plan = journeyPlan(p, r, budget),
    action = collection(plan),
    view = card(await html(plan), action);
  assert.equal(action.material.onHand, 5);
  assert.equal(action.material.missing, null);
  assert.equal(action.material.allocationKnown, undefined);
  assert.match(view, /需 1 · 已保存持有 5/);
  assert.match(view, /仅收藏目标，未预留库存；可用数量另核对/);
  assert.match(view, /存档参照：synthetic-collection\.sav · 2026-10-10T01:02:03\.000Z/);
  assert.match(view, /用户收集目标/);
  assert.match(view, /data-action="journey-handle"/);
  assert.doesNotMatch(view, /journey-handled|已分配|还缺 0|可卖/);
  assert.equal(action.gameComplete, false);
  assert.equal(action.userDone, false);
  assert.equal(action.prepared, false);
  assert.equal(plan.summary.pending, 1);
  assert.deepEqual({ p, r }, before);
  assert.deepEqual(budget, budgetBefore);
});

test('known zero remains visible and same-name qualities keep their exact item holdings and navigation', async () => {
  const p = profile({ goals: [goal(1000), goal(1001), goal(1002)] }),
    plan = journeyPlan(
      p,
      reference([
        { id: 1001, count: 5 },
        { id: 1002, count: 9 },
      ]),
    ),
    view = await html(plan);
  assert.equal(
    game.entries.find((e) => e.id === 'item-1000').name,
    game.entries.find((e) => e.id === 'item-1001').name,
  );
  assert.equal(plan.actions.filter((a) => a.kind === 'collection').length, 3);
  for (const [id, count] of [
    [1000, 0],
    [1001, 5],
    [1002, 9],
  ]) {
    const action = collection(plan, id),
      ownCard = card(view, action);
    assert.equal(action.material.onHand, count);
    assert.match(ownCard, new RegExp(`需 1 · 已保存持有 ${count}(?:<| ·)`));
    assert.match(ownCard, new RegExp(`data-id="item-${id}"`));
    assert.doesNotMatch(ownCard, /已保存持有 14|持有量待核对|journey-handled/);
  }
});

test('unknown inventory is not presented as zero, including absent, unreadable, mismatched and invalid references', async () => {
  const valid = reference(),
    cases = [
      null,
      { ...valid, error: 'synthetic read failure' },
      { ...valid, name: 'foreign-synthetic.sav' },
      { ...valid, metadata: { quests: [] } },
      reference([{ id: 1000, count: -1 }]),
    ];
  for (const r of cases) {
    const plan = journeyPlan(profile(), r),
      action = collection(plan),
      view = card(await html(plan), action);
    assert.equal(action.material.onHand, null);
    assert.match(view, /已保存持有量待核对/);
    assert.match(view, /仅收藏目标，未预留库存；可用数量另核对/);
    assert.doesNotMatch(view, /已保存持有 0|已分配|还缺 0|foreign-synthetic\.sav/);
    if (plan.reference) assert.match(view, /存档参照：synthetic-collection\.sav/);
    else assert.doesNotMatch(view, /存档参照：/);
  }
});

test('an action save source takes precedence over the page reference for that collection card', async () => {
  const plan = journeyPlan(profile(), reference([{ id: 1000, count: 5 }])),
    action = collection(plan);
  action.sources.push({ type: 'save', ...plan.reference });
  plan.reference = {
    name: 'other-page-reference.sav',
    modifiedAt: '2026-10-09T00:00:00.000Z',
    hash: 'other-synthetic-hash',
  };
  const view = card(await html(plan), action);
  assert.match(view, /存档参照：synthetic-collection\.sav · 2026-10-10T01:02:03\.000Z/);
  assert.doesNotMatch(view, /other-page-reference/);
});

test('collection names, details and reference labels are escaped in the action card', async () => {
  const data = structuredClone(game),
    p = profile(),
    r = reference([{ id: 1000, count: 5 }]);
  data.entries.find((e) => e.id === 'item-1000').name = '<img src=x onerror="synthetic">';
  p.goals[0].detail = '<script>synthetic</script>';
  p.saveSlot = r.name = 'synthetic<&"collection.sav';
  r.modifiedAt = '<svg onload="synthetic">';
  const plan = createJourneyPlanner({ world, game: data }).journeyPlan(p, r),
    view = card(await html(plan, data), collection(plan));
  assert.match(view, /&lt;img src=x onerror=&quot;synthetic&quot;&gt;/);
  assert.match(view, /&lt;script&gt;synthetic&lt;\/script&gt;/);
  assert.match(
    view,
    /存档参照：synthetic&lt;&amp;&quot;collection\.sav · &lt;svg onload=&quot;synthetic&quot;&gt;/,
  );
  assert.doesNotMatch(view, /<img|<script|<svg/);
});

test('craft material allocations and manual handled state keep their existing meanings', async () => {
  const p = profile({ goals: [], craftList: [{ id: 'cooking-102', quantity: 1 }] }),
    r = reference([{ id: 10525, count: 1 }]),
    budget = resourceBudget(p, r),
    plan = journeyPlan(p, r, budget),
    action = plan.actions.find((a) => a.kind === 'material' && a.material.ids.includes(10525));
  assert.equal(action.material.allocationKnown, true);
  assert.equal(action.material.count, 1);
  assert.equal(action.material.missing, 1);
  assert.deepEqual(action.material.allocation, []);
  const view = card(await html(plan), action);
  assert.match(view, /需 1 · 已分配 0 · 还缺 1 · 可替代材料共用总量/);
  assert.doesNotMatch(view, /已保存持有|仅收藏目标|存档参照：/);
  p.journey = { ...emptyJourneyState(), handledActionIds: [action.id] };
  const handledPlan = journeyPlan(p, r, resourceBudget(p, r)),
    handled = handledPlan.actions.find((a) => a.id === action.id);
  assert.equal(handled.handled, true);
  assert.equal(handled.userDone, false);
  assert.equal(handled.material.missing, 1);
  assert.deepEqual(handled.material.allocation, []);
  const stockedReference = reference([{ id: 10525, count: 3 }]),
    stockedPlan = journeyPlan(p, stockedReference, resourceBudget(p, stockedReference)),
    stocked = stockedPlan.actions.find((a) => a.kind === 'material' && a.material.ids.includes(10525)),
    stockedView = card(await html(stockedPlan, game, { completed: true }), stocked);
  assert.equal(stocked.prepared, true);
  assert.equal(stocked.material.allocation[0].count, 2);
  assert.match(stockedView, /需 2 · 已分配 2 · 还缺 0 · 可替代材料共用总量/);
  assert.doesNotMatch(stockedView, /已保存持有|仅收藏目标|存档参照：/);
});

test('gift allocations keep the exact quality and existing allocated quantity text', async () => {
  const journey = emptyJourneyState();
  journey.gifts.push({
    id: 'synthetic-gift',
    npcId: 'npc-5011',
    itemId: 'item-1002',
    quantity: 2,
    note: '',
    done: false,
  });
  const p = profile({ goals: [], journey }),
    r = reference([
      { id: 1000, count: 5 },
      { id: 1002, count: 1 },
    ]),
    plan = journeyPlan(p, r, resourceBudget(p, r)),
    action = plan.actions.find((a) => a.kind === 'gift'),
    view = card(await html(plan), action);
  assert.equal(action.gift.allocationKnown, true);
  assert.equal(action.gift.itemId, 'item-1002');
  assert.match(view, /蓝色品质/);
  assert.match(view, /为这份赠礼已分配 1 · 还缺 1/);
  assert.doesNotMatch(view, /已保存持有|仅收藏目标|存档参照：/);
});
