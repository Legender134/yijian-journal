'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const { goalProgress } = require('../src/core/goal-progress.cjs');
const catalog = require('../src/data/catalog.cjs');
function setup(t, reserved = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-craft-completion-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('yijian-craft-completion-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir, catalog);
  store.mutate({
    type: 'craft-plan-save',
    name: '计划 A',
    list: [{ id: 'fusion-9500', quantity: 3 }],
    reserved: true,
  });
  const a = store.get().profiles[0].craftPlans[0].id;
  store.mutate({
    type: 'craft-plan-save',
    name: '计划 B',
    list: [{ id: 'fusion-9500', quantity: 2 }],
    reserved,
    addGoal: true,
  });
  const b = store.get().profiles[0].craftPlans[0].id;
  const profile = () => store.get().profiles[0];
  const complete = (value = true, expectedPlan = profile().craftPlans.find((p) => p.id === b)) =>
    store.mutate({ type: 'craft-plan-complete', id: b, value, expectedPlan });
  const reference = {
    name: 'Synthetic.sav',
    hash: 'a'.repeat(64),
    modifiedAt: '2026-10-08T00:00:00.000Z',
    metadata: {
      quests: [],
      inventory: [
        { id: 10201, count: 12 },
        { id: 10205, count: 20 },
      ],
      fusionRecipes: [9500],
      money: 999999,
    },
  };
  return { dir, store, profile, complete, reference, a, b };
}
test('explicit completion releases only its own whole-plan demand without inventing stock or rewriting user goals', (t) => {
  const { store, profile, complete, reference, a, b } = setup(t);
  store.mutate({ type: 'craft-plan-open', id: b });
  store.mutate({ type: 'reserve-set', id: '10201', count: 4 });
  const before = profile(),
    budget = resourceBudget(before, reference);
  assert(budget.crafts.some((p) => p.id === a));
  assert(budget.crafts.some((p) => p.id === b));
  complete();
  const after = profile(),
    changed = resourceBudget(after, reference);
  assert.deepEqual(after.craftList, before.craftList);
  assert.deepEqual(
    after.craftPlans.find((p) => p.id === b).list,
    before.craftPlans.find((p) => p.id === b).list,
  );
  assert.equal(after.craftPlans.find((p) => p.id === b).reserved, true);
  assert.equal(after.reserveCraftDraft, before.reserveCraftDraft);
  assert.deepEqual(after.goals, before.goals);
  assert(changed.crafts.some((p) => p.id === a));
  assert(!changed.crafts.some((p) => p.id === b));
  assert.equal(changed.totals[10201], budget.totals[10201] - 2);
  assert.equal(changed.totals[10205], budget.totals[10205] - 2);
  assert.equal(changed.totals[10216] || 0, 0, 'no manufactured iron ingots');
  const progress = goalProgress(after, reference)[after.goals[0].id];
  assert.equal(progress.done, true);
  assert.equal(progress.planDone, true);
  assert.equal(progress.manualDone, false);
  assert.equal(progress.automaticDone, false);
  const event = after.journalEntries.at(-1);
  assert.equal(event.kind, 'craft-plan-completed');
  assert.deepEqual(
    event.links.map(({ type, id }) => ({ type, id })),
    [{ type: 'craft-plan', id: b }],
  );
});
test('selected crafting and procurement steps become personal completion; cold-restart reopening restores the same intent and budget', (t) => {
  const { dir, store, profile, complete, reference, b } = setup(t);
  let p = profile(),
    budget = resourceBudget(p, reference),
    plan = journeyPlan(p, reference, budget);
  const action = plan.actions.find((a) => a.kind === 'craft' && a.ownerId === b);
  assert.equal(action.craftPlanId, b);
  store.mutate({ type: 'journey-itinerary-add', id: action.id }, { journeyActions: plan.actions });
  store.mutate({ type: 'journey-itinerary-status', status: 'active' });
  const selection = profile().journey.itinerary;
  complete();
  p = profile();
  const closed = journeyPlan(p, reference, resourceBudget(p, reference));
  assert.equal(closed.itinerary.steps[0].status, 'user-done');
  assert.equal(closed.itinerary.steps[0].craftPlanId, b);
  assert.equal(closed.itinerary.next, null);
  assert(!closed.actions.some((a) => a.ownerId === b));
  const reloaded = new Store(dir, catalog),
    current = reloaded.get().profiles[0];
  reloaded.mutate({
    type: 'craft-plan-complete',
    id: b,
    value: false,
    expectedPlan: current.craftPlans.find((p) => p.id === b),
  });
  const reopened = reloaded.get().profiles[0];
  assert.deepEqual(reopened.journey.itinerary, selection);
  assert.deepEqual(resourceBudget(reopened, reference).totals, budget.totals);
  assert.equal(
    journeyPlan(reopened, reference, resourceBudget(reopened, reference)).itinerary.next.actionId,
    action.id,
  );
  assert.equal(reopened.journalEntries.at(-1).kind, 'craft-plan-reopened');
});
test('stale completion preview and unsaved editor changes are rejected atomically', (t) => {
  const { store, profile, complete, b } = setup(t);
  const old = profile().craftPlans.find((p) => p.id === b);
  store.mutate({
    type: 'craft-plan-save',
    id: b,
    name: '计划 B 已修改',
    list: [{ id: 'fusion-9500', quantity: 4 }],
    reserved: true,
  });
  let before = store.get();
  assert.throws(() => complete(true, old), /已变化/);
  assert.deepEqual(store.get(), before);
  store.mutate({ type: 'craft-plan-open', id: b });
  store.mutate({ type: 'craft-set', id: 'fusion-9500', quantity: 5 });
  before = store.get();
  assert.throws(() => complete(), /未保存/);
  assert.deepEqual(store.get(), before);
  assert.throws(() => complete('yes'), /设置无效/);
  assert.deepEqual(store.get(), before);
});
test('completion and reopening preserve released reservation preferences and independently completed goals', (t) => {
  const { store, profile, complete, reference, b } = setup(t, false);
  store.mutate({ type: 'goal-toggle', id: profile().goals[0].id });
  const before = profile();
  complete();
  complete(false);
  const after = profile();
  assert.equal(after.craftPlans.find((p) => p.id === b).reserved, false);
  assert.deepEqual(after.goals, before.goals);
  assert(!resourceBudget(after, reference).crafts.some((p) => p.id === b));
});
test('completed plans reject new recipe quantities until explicitly reopened; viewing and renaming preserve completion', (t) => {
  const { store, profile, complete, b } = setup(t);
  complete();
  const plan = profile().craftPlans.find((p) => p.id === b);
  store.mutate({ type: 'craft-plan-open', id: b });
  assert.equal(profile().craftPlans.find((p) => p.id === b).done, true);
  store.mutate({
    type: 'craft-plan-save',
    id: b,
    name: '已完成的计划 B',
    list: plan.list,
    choices: plan.choices,
  });
  assert.equal(profile().craftPlans.find((p) => p.id === b).done, true);
  const before = store.get();
  assert.throws(
    () =>
      store.mutate({
        type: 'craft-plan-save',
        id: b,
        name: '再做一份',
        list: [{ id: 'fusion-9500', quantity: 3 }],
      }),
    /先重新打开/,
  );
  assert.deepEqual(store.get(), before);
  complete(false);
  store.mutate({
    type: 'craft-plan-save',
    id: b,
    name: '再做一份',
    list: [{ id: 'fusion-9500', quantity: 3 }],
  });
  assert.equal(profile().craftPlans.find((p) => p.id === b).list[0].quantity, 3);
});
test('legacy generic handled flags never silently become plan completion', (t) => {
  const { store, profile, reference, b } = setup(t);
  const plan = journeyPlan(profile(), reference, resourceBudget(profile(), reference));
  const action = plan.actions.find((a) => a.kind === 'craft' && a.ownerId === b);
  store.mutate(
    { type: 'journey-action-handle', id: action.id, handled: true },
    { journeyActions: plan.actions },
  );
  assert.notEqual(profile().craftPlans.find((p) => p.id === b).done, true);
  assert(resourceBudget(profile(), reference).crafts.some((p) => p.id === b));
});

test('under scarce stock, completing one plan makes real remaining stock available to the other plan and gift without manufacturing items', (t) => {
  const { store, profile, reference, complete, a, b } = setup(t);
  reference.metadata.inventory[0].count = 8;
  store.mutate({ type: 'reserve-set', id: '10201', count: 4 });
  store.mutate({
    type: 'journey-gift-put',
    id: 'gift-scarce',
    npcId: 'npc-5014',
    itemId: 'item-10201',
    quantity: 3,
    note: '',
    done: false,
  });
  const before = resourceBudget(profile(), reference);
  assert.equal(before.gifts[0].allocated, 0);
  assert.equal(before.crafts.find((p) => p.id === a).materials.find((m) => m.ids.includes(10201)).missing, 1);
  complete();
  const after = resourceBudget(profile(), reference);
  assert(!after.crafts.some((p) => p.id === b));
  assert.equal(after.crafts.find((p) => p.id === a).materials.find((m) => m.ids.includes(10201)).missing, 0);
  assert.equal(after.gifts[0].allocated, 1);
  assert.equal(after.gifts[0].missing, 2);
  assert.equal(after.totals[10201], 8);
  assert.equal(after.totals[10205], 3);
  assert.equal(after.totals[10216] || 0, 0);
});
