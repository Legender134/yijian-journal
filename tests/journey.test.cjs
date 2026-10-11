'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { journeyPlan, createJourneyPlanner } = require('../src/core/journey-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const {
  validateJourneyState,
  applyJourneyCommand,
  emptyJourneyState,
} = require('../src/core/journey-state.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const clone = (x) => structuredClone(x);
const profile = (extra = {}) => ({
  id: 'synthetic-profile',
  goals: [],
  referenceMode: 'slot',
  saveSlot: 'synthetic.sav',
  ...extra,
});
const reference = (metadata = {}) => ({
  name: 'synthetic.sav',
  hash: 'synthetic-hash',
  modifiedAt: '2026-10-08T00:00:00.000Z',
  metadata: { quests: [], inventory: [], ...metadata },
});
const goal = (id, extra = {}) => ({
  id: `goal-${id}`,
  title: `资料目标 ${id}`,
  detail: '',
  done: false,
  source: { type: 'quest', id: `quest-${id}` },
  ...extra,
});
const matchingBudget = (p, r, extra = {}) => ({
  profileId: p.id,
  referenceIdentity: { name: r.name, hash: r.hash, modifiedAt: r.modifiedAt },
  inventoryAvailable: true,
  totals: {},
  crafts: [],
  ...extra,
});
const actionForQuest = (plan, id) => plan.actions.find((a) => a.questId === `quest-${id}`);
test('gift action identifies the planned quality in text and allocates only that exact physical item', () => {
  const r = reference({ inventory: [{ id: 1002, count: 1 }] });
  for (const [q, id, missing] of [
    ['白', 'item-1000', 1],
    ['绿', 'item-1001', 1],
    ['蓝', 'item-1002', 0],
  ]) {
    const p = profile({
      journey: {
        ...emptyJourneyState(),
        gifts: [{ id: 'gift-identity', npcId: 'npc-5011', itemId: id, quantity: 1, note: '', done: false }],
      },
    });
    const action = journeyPlan(p, r, resourceBudget(p, r)).actions.find((row) => row.kind === 'gift');
    assert.match(action.title, new RegExp(q + '色品质'));
    assert.match(action.title, /5011/);
    assert.equal(action.gift.itemId, id);
    assert.equal(action.gift.missing, missing);
    assert.equal(action.gift.allocated, 1 - missing);
  }
});

test('an explicit task reservation contributes an uncertain task intent and the exact per-owner physical allocation', () => {
  const p = profile({
    allocations: [
      { questId: 'quest-11010', items: { 10201: 4 } },
      { questId: 'quest-13405', items: { 10201: 5 } },
    ],
  });
  const r = reference({ inventory: [{ id: 10201, count: 5 }] });
  const plan = journeyPlan(p, r, resourceBudget(p, r));
  const first = actionForQuest(plan, 11010),
    second = actionForQuest(plan, 13405);
  assert.equal(first.progress.status, 'unknown');
  assert.equal(first.materials.find((m) => m.id === 10201).allocated, 4);
  assert.equal(second.materials.find((m) => m.id === 10201).allocated, 1);
  assert.equal(second.materials.find((m) => m.id === 10201).missing, 4);
  assert.equal(first.gameComplete, false);
  const later = {
    ...r,
    hash: 'later-synthetic-sha',
    metadata: { ...r.metadata, quests: [{ id: 11010, step: 4 }] },
  };
  const updated = journeyPlan(p, later, resourceBudget(p, later));
  assert.equal(actionForQuest(updated, 11010), undefined);
  assert.equal(actionForQuest(updated, 13405).materials.find((m) => m.id === 10201).allocated, 5);
  assert.equal(p.allocations[0].items[10201], 4);
});

test('the itinerary exposes real shared ore shortage and ordered processing without treating outputs as physical stock', () => {
  const p = profile({
    craftList: [{ id: 'fusion-1002', quantity: 1 }],
    craftPlans: [
      { id: 'second', name: '另一份金装', list: [{ id: 'fusion-1002', quantity: 1 }], reserved: true },
    ],
  });
  const r = reference({
    inventory: [
      { id: 10226, count: 6 },
      { id: 10220, count: 2 },
      { id: 10205, count: 10 },
      { id: 10207, count: 3 },
    ],
    money: 100000,
  });
  const before = JSON.stringify({ p, r });
  const budget = resourceBudget(p, r),
    plan = journeyPlan(p, r, budget);
  assert.equal(budget.baseMaterialMissingTotal, 1);
  const raw = plan.actions.filter((a) => a.material?.scope === 'processing-raw');
  assert.equal(raw.length, 1);
  assert.deepEqual(raw[0].material.ids, [10207]);
  assert.equal(raw[0].material.missing, 1);
  assert.equal(raw[0].ownerId, 'second');
  const steps = plan.actions.filter((a) => a.processingStep);
  assert.equal(steps.length, 2);
  assert.equal(
    steps.reduce((sum, a) => sum + a.processingStep.quantity, 0),
    4,
  );
  assert(steps.some((a) => a.processingStep.materialsAvailableNow === true));
  assert(steps.some((a) => a.processingStep.materialsAvailableNow === false));
  assert(steps.every((a) => a.gameComplete === false));
  assert.equal(budget.physicalUsed[10207], 3);
  assert.equal(budget.physicalUsed[10221], undefined);
  assert.equal(plan.summary.prepared, 6);
  assert.equal(
    plan.summary.pending,
    plan.actions.filter((a) => !a.prepared && !a.handled && !a.gameComplete && !a.userDone).length,
  );
  assert(plan.actions.filter((a) => a.prepared).every((a) => !a.gameComplete && !a.userDone));
  assert.equal(JSON.stringify({ p, r }), before);
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('a recipe with no intermediate processing creates one procurement action per material group', () => {
  const recipe = game.entries.find(
    (entry) =>
      entry.kind === '配方' &&
      entry.materials.length === 4 &&
      entry.materials.every(
        (m) =>
          !m.alternatives?.length &&
          !game.entries.some((e) => e.kind === '配方' && e.results.some((result) => result.id === m.id)),
      ),
  );
  assert(recipe, 'the real database contains a four-material recipe without a producer');
  const p = profile({ craftList: [{ id: recipe.id, quantity: 1 }] });
  const r = reference();
  const budget = resourceBudget(p, r);
  const plan = journeyPlan(p, r, budget);
  const procurement = plan.actions.filter((a) => a.kind === 'material' && !a.prepared);
  assert.equal(procurement.length, 4);
  assert.equal(new Set(procurement.map((a) => a.material.ids.join(','))).size, 4);
  assert.equal(
    procurement.reduce((sum, a) => sum + a.material.missing, 0),
    budget.baseMaterialMissingTotal,
  );
  assert.equal(plan.actions.filter((a) => a.processingStep).length, 0);
  assert.equal(plan.actions.find((a) => a.kind === 'craft').materialActionIds.length, 4);
});

test('an expanded recipe procures raw endpoints without also buying planned intermediate products', () => {
  const p = profile({ craftList: [{ id: 'fusion-1002', quantity: 1 }] });
  const r = reference();
  const budget = resourceBudget(p, r);
  const plan = journeyPlan(p, r, budget);
  const procurement = plan.actions.filter((a) => a.kind === 'material' && !a.prepared);
  assert(plan.actions.some((a) => a.processingStep));
  assert(procurement.every((a) => a.material.scope === 'processing-raw'));
  assert.equal(
    procurement.reduce((sum, a) => sum + a.material.missing, 0),
    budget.baseMaterialMissingTotal,
  );
  const produced = budget.crafts[0].processing.plannedOutputs
    .filter((output) => !output.final)
    .map((o) => o.itemId);
  assert(procurement.every((a) => !a.material.ids.some((id) => produced.includes(id))));
});

test('alternative procurement keeps one shared group and releases physical inventory only once', () => {
  const p = profile({ craftList: [{ id: 'cooking-102', quantity: 2 }] });
  const r = reference({ inventory: [{ id: 10525, count: 1 }] });
  const budget = resourceBudget(p, r);
  const plan = journeyPlan(p, r, budget);
  const alternatives = plan.actions.filter((a) => a.kind === 'material' && a.material.alternatives);
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].material.missing, 3);
  assert.equal(alternatives[0].material.scope, 'processing-raw');
  assert.equal(budget.physicalUsed[10525], 1);
  assert.equal(
    plan.actions
      .filter((a) => a.kind === 'material' && !a.prepared)
      .reduce((n, a) => n + a.material.missing, 0),
    budget.baseMaterialMissingTotal,
  );
});

test('three real quest families retain completed, active and missing states without invented next steps', () => {
  const p = profile({ goals: [goal(5053), goal(13802), goal(14052), goal(14073)] });
  const r = reference({
    quests: [
      { id: 5053, step: 4 },
      { id: 13802, step: 1 },
      { id: 13803, step: 1 },
      { id: 14052, step: 1 },
      { id: 14056, step: 1 },
    ],
  });
  const plan = journeyPlan(p, r);
  assert.equal(actionForQuest(plan, 5053).gameComplete, true);
  assert.equal(actionForQuest(plan, 13803).progress.status, 'active');
  assert.equal(actionForQuest(plan, 14056).progress.status, 'active');
  assert.equal(actionForQuest(plan, 14073).progress.status, 'unknown');
  assert.equal(
    actionForQuest(plan, 14073).relatedSteps.find((s) => s.id === 'quest-14082').status,
    'unknown',
  );
  assert.equal(actionForQuest(plan, 14082), undefined);
  assert.ok(actionForQuest(plan, 13803).detail.includes('碗子山、野猪林'));
  assert.equal(plan.summary.gameComplete, 1);
  assert.equal(plan.goalProgress.find((g) => g.questId === 'quest-14073').status, 'unknown');
});

test('cross-task locality merges sourced wild-boar-forest material hints and a personal place goal', () => {
  const p = profile({
    goals: [goal(13803), goal(14056)],
    journey: {
      ...emptyJourneyState(),
      places: [{ placeId: 'place-22', note: '顺路核对', favorite: true, done: false }],
    },
  });
  const plan = journeyPlan(
    p,
    reference({
      quests: [
        { id: 13803, step: 1 },
        { id: 14056, step: 1 },
      ],
    }),
  );
  const route = plan.routes.find((r) => r.name === '野猪林');
  assert.equal(route.favorite, true);
  assert.ok(route.actionIds.includes(actionForQuest(plan, 13803).id));
  assert.ok(route.actionIds.includes(actionForQuest(plan, 14056).id));
  assert.ok(route.sources.some((s) => s.id === 'item-10262' && s.excerpt.includes('野猪林')));
  assert.equal(route.availability, 'unknown');
  assert.equal(route.ordering, 'unordered');
});

test('requirements.value is copied raw and never mapped to save step or inferred unlock', () => {
  const plan = journeyPlan(
    profile({ goals: [goal(13803), goal(13801)] }),
    reference({
      quests: [
        { id: 5230, step: 4 },
        { id: 13803, step: 1 },
        { id: 13801, step: 3 },
        { id: 5748, step: 4 },
        { id: 5858, step: 0 },
      ],
    }),
  );
  const rule = actionForQuest(plan, 13803).prerequisites[0];
  assert.deepEqual(rule.raw, world.quests.find((q) => q.id === 'quest-13803').requirements[0]);
  assert.equal(rule.raw.value, 4);
  assert.equal(rule.observedProgress, 'complete');
  assert.equal(rule.satisfied, null);
  assert.equal(rule.semantics, 'uninterpreted');
  assert.deepEqual(rule.navigation, { action: 'world-quest', id: 'quest-5230' });
  const excluded = actionForQuest(plan, 13801).prerequisites.find((r) => r.raw.type === 'NoQuest');
  assert.equal(excluded.raw.value, 0);
  assert.equal(excluded.satisfied, null);
});

test('unread, mismatched and errored references leave progress and holdings unknown', () => {
  const p = profile({ goals: [goal(13803)] });
  for (const r of [
    null,
    { ...reference({ quests: [{ id: 13803, step: 4 }] }), name: 'other.sav' },
    { ...reference({ quests: [{ id: 13803, step: 4 }] }), error: '读取失败' },
  ]) {
    const plan = journeyPlan(p, r);
    assert.equal(actionForQuest(plan, 13803).gameComplete, false);
    assert.equal(actionForQuest(plan, 13803).progress.status, 'unknown');
    assert.equal(actionForQuest(plan, 13803).materials[0].onHand, null);
    assert.equal(plan.reference, null);
  }
  assert.equal(journeyPlan({ ...p, referenceMode: 'none' }, reference()).recordsKnown, false);
});

test('missing and invalid save step are unknown, while all documented save states remain distinct', () => {
  for (const [step, status] of [
    [0, 'not-started'],
    [1, 'active'],
    [2, 'failed'],
    [3, 'not-accepted'],
    [4, 'complete'],
    [5, 'unknown'],
    ['4', 'unknown'],
    [null, 'unknown'],
  ]) {
    const plan = journeyPlan(profile({ goals: [goal(13803)] }), reference({ quests: [{ id: 13803, step }] }));
    assert.equal(actionForQuest(plan, 13803).progress.status, status);
  }
});

test('manual quest tracking and manual goal completion remain independent from save completion', () => {
  const p = profile({ goals: [goal(13803, { progressMode: 'manual' })] });
  const plan = journeyPlan(p, reference({ quests: [{ id: 13803, step: 4 }] }));
  assert.equal(actionForQuest(plan, 13803).progress.status, 'manual');
  assert.equal(actionForQuest(plan, 13803).gameComplete, false);
  const done = journeyPlan(
    profile({ goals: [goal(13803, { done: true })] }),
    reference({ quests: [{ id: 13803, step: 1 }] }),
  );
  assert.equal(done.summary.gameComplete, 0);
  assert.equal(done.summary.userDone, 1);
});

test('an open manual quest owner survives another automatic completed owner and a completed parent', () => {
  const p = profile({ goals: [goal(13803), goal(13803, { id: 'manual-owner', progressMode: 'manual' })] });
  const plan = journeyPlan(
    p,
    reference({
      quests: [
        { id: 13802, step: 4 },
        { id: 13803, step: 4 },
      ],
    }),
  );
  assert.equal(actionForQuest(plan, 13803).progress.status, 'manual');
  assert.equal(actionForQuest(plan, 13803).gameComplete, false);
  assert.ok(actionForQuest(plan, 13803).goalIds.includes('manual-owner'));
  assert.equal(plan.goalProgress.find((g) => g.goalId === 'goal-13803').gameComplete, true);
});

test('completed parent prevents stale active child from becoming an executable action', () => {
  const plan = journeyPlan(
    profile({ goals: [goal(5053)] }),
    reference({
      quests: [
        { id: 5053, step: 4 },
        { id: 5057, step: 1 },
      ],
    }),
  );
  assert.equal(actionForQuest(plan, 5057), undefined);
  assert.ok(plan.warnings.some((w) => w.code === 'conflicting-quest-records'));
});

test('scene placements keep event role, phase and current location uncertainty', () => {
  const plan = journeyPlan(
    profile({ goals: [goal(5059), goal(5072)] }),
    reference({
      quests: [
        { id: 5059, step: 1 },
        { id: 5072, step: 1 },
      ],
    }),
  );
  const a = actionForQuest(plan, 5059),
    b = actionForQuest(plan, 5072);
  assert.equal(a.places.find((p) => p.evidence === 'scene-placement').interactionTarget, false);
  assert.equal(b.places.find((p) => p.npcId === 10016).interactionTarget, true);
  assert.ok(a.unknowns.some((u) => u.code === 'npc-location-unknown'));
  assert.equal(plan.routes.find((r) => r.name === '梧桐村').ambiguous, false);
});

test('same-name text destinations remain multiple phase candidates', () => {
  const p = profile({ goals: [goal(14082)] });
  const plan = journeyPlan(p, reference());
  const route = plan.routes.find((r) => r.name === '桃花林');
  assert.deepEqual(
    new Set(route.mapIds),
    new Set(world.maps.filter((p) => p.name === '桃花林').map((p) => p.id)),
  );
  assert.equal(route.ambiguous, true);
});

test('the active Wudang root task retains its explicit destination alias and phase ambiguity', () => {
  const plan = journeyPlan(profile(), reference({ quests: [{ id: 5200, step: 1 }] }));
  const quest = actionForQuest(plan, 5200);
  const place = quest.places.find((p) => p.name === '武当派');
  assert.equal(place.mention, '武当');
  assert.equal(place.evidence, 'text-alias');
  assert(place.mapIds.length > 1);
  assert(plan.routes.some((r) => r.name === '武当派' && r.actionIds.includes(quest.id)));
});

test('a mining task cannot suggest a foreign cave merely nested in the named back mountain cave', () => {
  const plan = journeyPlan(profile(), reference({ quests: [{ id: 11010, step: 1 }] }));
  const places = actionForQuest(plan, 11010).places;
  assert.deepEqual(places.find((p) => p.name === '后山山洞').mapIds, ['place-11', 'place-12']);
  assert.equal(
    places.some((p) => p.name === '山洞' || p.mapIds.includes('place-95')),
    false,
  );
  assert(places.some((p) => p.source.type === 'database' && p.name === '梧桐村'));
});

test('itinerary place hints keep independent short names and aliases beside longer names', () => {
  for (const [description, expected, alias] of [
    ['后山山洞，再到后山山洞。', ['后山山洞'], false],
    ['后山山洞，然后到山洞。', ['后山山洞', '山洞'], false],
    ['山洞，然后到后山山洞。', ['后山山洞', '山洞'], false],
    ['山洞。', ['山洞'], false],
    ['到武当山，再去后山山洞。', ['后山山洞', '武当派'], true],
  ]) {
    const custom = clone(world),
      quest = custom.quests.find((q) => q.id === 'quest-11010');
    Object.assign(quest, { name: '地点关联测试', description, placements: [] });
    const plan = createJourneyPlanner({ world: custom, game }).journeyPlan(
      profile(),
      reference({ quests: [{ id: 11010, step: 1 }] }),
    );
    const places = actionForQuest(plan, 11010).places.filter((p) => p.source.type === 'quest');
    assert.deepEqual(places.map((p) => p.name).sort(), expected.sort(), description);
    if (alias) assert.equal(places.find((p) => p.name === '武当派').mention, '武当山');
  }
});

test('actual cooking recipe keeps fish alternatives as one group, accepts exact budget and links sourced fishing hints', () => {
  const p = profile({ craftList: [{ id: 'cooking-102', quantity: 1 }] });
  const r = reference({ inventory: [{ id: 10525, count: 1 }], cookingRecipes: [102] });
  const recipe = game.entries.find((e) => e.id === 'cooking-102');
  const materials = recipe.materials.map((m) => ({
    name: m.name,
    ids: m.alternatives || [m.id],
    count: m.count,
    allocation: m.alternatives ? [{ id: 10525, count: 1 }] : [],
    missing: m.alternatives ? 1 : m.count,
  }));
  const plan = journeyPlan(
    p,
    r,
    matchingBudget(p, r, {
      crafts: [{ id: '@draft', name: '水煮鱼计划', list: p.craftList, materials }],
      totals: { 10525: 1 },
    }),
  );
  const fish = plan.actions.filter((a) => a.kind === 'material' && a.material.alternatives);
  assert.equal(fish.length, 1);
  assert.deepEqual(fish[0].material.ids, [10525, 10526, 10527, 10528, 10529]);
  assert.equal(fish[0].material.count, 2);
  assert.equal(fish[0].material.missing, 1);
  assert.equal(
    fish[0].material.hints[0].description,
    game.entries.find((e) => e.id === 'item-10525').description,
  );
  assert.ok(fish[0].places.some((p) => p.name === '梧桐村'));
  assert.equal(plan.actions.find((a) => a.kind === 'craft').recipe.learned, true);
  assert.ok(
    plan.actions.find((a) => a.kind === 'craft').unknowns.some((u) => u.code === 'craft-execution-unknown'),
  );
});

test('real alchemy requirements merge with task locality and retain unlearned recipe state', () => {
  const p = profile({ goals: [goal(13803)], craftList: [{ id: 'alchemy-100', quantity: 2 }] });
  const plan = journeyPlan(p, reference({ quests: [{ id: 13803, step: 1 }], alchemyRecipes: [] }));
  const whitePeony = plan.actions.find((a) => a.kind === 'material' && a.material.ids.includes(10261));
  assert.equal(whitePeony.material.count, 2);
  assert.equal(whitePeony.material.missing, null);
  const route = plan.routes.find((r) => r.name === '野猪林');
  assert.ok(route.actionIds.includes(whitePeony.id));
  assert.ok(route.actionIds.includes(actionForQuest(plan, 13803).id));
  assert.equal(plan.actions.find((a) => a.kind === 'craft').recipe.learned, false);
});

test('budget must match profile ID and all three save identity values', () => {
  const p = profile({ craftList: [{ id: 'cooking-102', quantity: 1 }] }),
    r = reference();
  const good = matchingBudget(p, r);
  for (const wrong of [
    { ...good, profileId: 'other' },
    { ...good, referenceIdentity: { ...good.referenceIdentity, name: 'other.sav' } },
    { ...good, referenceIdentity: { ...good.referenceIdentity, hash: 'other-hash' } },
    { ...good, referenceIdentity: { ...good.referenceIdentity, modifiedAt: 'old' } },
    { ...good, referenceIdentity: undefined },
  ]) {
    const plan = journeyPlan(p, r, wrong);
    assert.equal(plan.budgetBound, false);
    assert.ok(plan.actions.filter((a) => a.kind === 'material').every((a) => a.material.missing === null));
  }
});

test('a corrupt alternative allocation cannot declare ready materials', () => {
  const p = profile({ craftList: [{ id: 'cooking-102', quantity: 1 }] }),
    r = reference();
  const b = matchingBudget(p, r, {
    crafts: [
      {
        id: '@draft',
        list: p.craftList,
        materials: [
          {
            ids: [10525, 10526, 10527, 10528, 10529],
            count: 2,
            missing: 0,
            allocation: [{ id: 100, count: 2 }],
          },
        ],
      },
    ],
  });
  assert.equal(
    journeyPlan(p, r, b).actions.find((a) => a.kind === 'material' && a.material.alternatives).material
      .missing,
    null,
  );
});

test('merchant catalog facts are navigable, with present stock and location explicitly unknown', () => {
  const p = profile({
    goals: [
      {
        id: 'collect-dan',
        title: '收集丹药',
        detail: '',
        done: false,
        source: { type: 'database', id: 'item-156', quantity: 1 },
      },
    ],
  });
  const a = journeyPlan(p, reference()).actions.find((a) => a.kind === 'collection');
  assert.ok(a.material.hints[0].merchants.some((m) => m.npcId === 'npc-5014'));
  assert.ok(
    a.material.hints[0].merchants.every((m) => m.currentStock === null && m.currentLocation === null),
  );
  assert.deepEqual(a.navigation, [{ action: 'database-detail', id: 'item-156' }]);
});

test('gift intents use exact unified-budget allocations without subtracting its totals twice', () => {
  const s = emptyJourneyState();
  s.gifts = ['b', 'a'].map((id) => ({
    id,
    npcId: 'npc-5014',
    itemId: 'item-100',
    quantity: 1,
    note: '',
    done: false,
  }));
  const p = profile({ journey: s }),
    r = reference({ inventory: [{ id: 100, count: 2 }] });
  const giftsBudget = [
    {
      id: 'a',
      npcId: 'npc-5014',
      itemId: 'item-100',
      quantity: 1,
      allocated: 1,
      missing: 0,
      inventoryAvailable: true,
    },
    {
      id: 'b',
      npcId: 'npc-5014',
      itemId: 'item-100',
      quantity: 1,
      allocated: 0,
      missing: 1,
      inventoryAvailable: true,
    },
  ];
  const plan = journeyPlan(p, r, matchingBudget(p, r, { totals: { 100: 2 }, gifts: giftsBudget }));
  const gifts = plan.actions.filter((a) => a.kind === 'gift');
  assert.equal(gifts[0].gift.allocated, 1);
  assert.equal(gifts[1].gift.allocated, 0);
  assert.equal(gifts[1].gift.missing, 1);
  assert.ok(gifts.every((a) => a.places.length === 0));
  assert.ok(gifts.every((a) => a.unknowns.some((u) => u.code === 'gift-execution-unknown')));
  assert.equal(journeyPlan(p, null).actions.find((a) => a.kind === 'gift').gift.available, null);
  assert.equal(
    journeyPlan(p, r, matchingBudget(p, r)).actions.find((a) => a.kind === 'gift').gift.allocated,
    null,
  );
  const invalid = giftsBudget.map((g) => ({ ...g, itemId: 'item-101' }));
  assert.ok(
    journeyPlan(p, r, matchingBudget(p, r, { gifts: invalid }))
      .actions.filter((a) => a.kind === 'gift')
      .every((a) => a.gift.allocated === null),
  );
  const duplicate = [...giftsBudget, { ...giftsBudget[0] }];
  assert.equal(
    journeyPlan(p, r, matchingBudget(p, r, { gifts: duplicate })).actions.find((a) => a.kind === 'gift').gift
      .allocated,
    null,
  );
});

test('stable action IDs survive reordered goals and quantity updates; no inputs are mutated', () => {
  const p = freeze(
    profile({ goals: [goal(13803), goal(14056)], craftList: [{ id: 'cooking-102', quantity: 1 }] }),
  );
  const r = freeze(
    reference({
      quests: [
        { id: 13803, step: 1 },
        { id: 14056, step: 1 },
      ],
    }),
  );
  const before = JSON.stringify({ p, r });
  const a = journeyPlan(p, r),
    b = journeyPlan(
      { ...p, goals: [...p.goals].reverse(), craftList: [{ id: 'cooking-102', quantity: 2 }] },
      r,
    );
  assert.deepEqual(new Set(a.actions.map((a) => a.id)), new Set(b.actions.map((a) => a.id)));
  assert.equal(before, JSON.stringify({ p, r }));
  a.actions[0].prerequisites[0].raw.value = 'tampered output';
  assert.equal(journeyPlan(p, r).actions[0].prerequisites[0].raw.value, 4);
});

test('duplicate quest goals create one action with all goal owners', () => {
  const p = profile({ goals: [goal(13803), goal(13803, { id: 'second-goal' })] });
  const plan = journeyPlan(p, reference({ quests: [{ id: 13803, step: 4 }] }));
  assert.equal(plan.actions.filter((a) => a.questId === 'quest-13803').length, 1);
  assert.deepEqual(actionForQuest(plan, 13803).goalIds, ['goal-13803', 'second-goal']);
});

test('reference change can regress game progress without changing user journey state', () => {
  const p = profile({ goals: [goal(13803)], journey: emptyJourneyState() });
  const completed = journeyPlan(p, reference({ quests: [{ id: 13803, step: 4 }] }));
  const older = journeyPlan(p, { ...reference({ quests: [{ id: 13803, step: 1 }] }), hash: 'older-hash' });
  assert.equal(completed.summary.gameComplete, 1);
  assert.equal(older.summary.gameComplete, 0);
  assert.equal(p.goals[0].done, false);
  assert.deepEqual(p.journey, emptyJourneyState());
});

test('reversible handled action state never turns into game completion', () => {
  const p = profile({ goals: [goal(13803)], journey: emptyJourneyState() }),
    r = reference({ quests: [{ id: 13803, step: 1 }] });
  const a = journeyPlan(p, r).actions[0];
  const state = applyJourneyCommand(
    p.journey,
    { type: 'journey-action-handle', id: a.id, handled: true },
    { actionIds: [a.id] },
  );
  const plan = journeyPlan({ ...p, journey: state }, r);
  assert.equal(plan.actions[0].handled, true);
  assert.equal(plan.actions[0].gameComplete, false);
  assert.equal(plan.actions[0].progress.status, 'active');
  assert.deepEqual(p.journey, emptyJourneyState());
  assert.deepEqual(
    applyJourneyCommand(state, { type: 'journey-action-handle', id: a.id, handled: false }),
    emptyJourneyState(),
  );
  assert.throws(
    () => applyJourneyCommand(p.journey, { type: 'journey-action-handle', id: a.id, handled: true }),
    /当前行程/,
  );
});

test('strict user state validation rejects unknown keys, invalid references, duplicate IDs and unsafe counts', () => {
  const valid = emptyJourneyState();
  const invalid = [
    null,
    { ...valid, schema: 2 },
    { ...valid, automaticDone: true },
    { ...valid, places: [{ placeId: 'unknown', note: '', favorite: false, done: false }] },
    { ...valid, todos: [{ id: 'todo', title: ' ', detail: '', done: false }] },
    { ...valid, todos: [{ id: 'todo', title: 'a', detail: '', done: 'false' }] },
    { ...valid, todos: [{ id: 'todo', title: 'a', detail: '', done: false, system: true }] },
    {
      ...valid,
      todos: Array.from({ length: 301 }, (_, i) => ({ id: String(i), title: 'a', detail: '', done: false })),
    },
    {
      ...valid,
      handledActionIds: [
        'journey:quest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'journey:quest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ],
    },
  ];
  for (const s of invalid) assert.throws(() => validateJourneyState(s));
  assert.throws(() => journeyPlan(profile({ journey: null }), null), /行程状态/);
  for (const quantity of [0, -1, 1000, 1.5, '1', NaN, Infinity])
    assert.throws(() =>
      validateJourneyState({
        ...valid,
        gifts: [{ id: 'gift', npcId: 'npc-5014', itemId: 'item-100', quantity, note: '', done: false }],
      }),
    );
  assert.throws(() =>
    validateJourneyState({
      ...valid,
      gifts: [{ id: 'gift', npcId: 'npc-999999', itemId: 'item-100', quantity: 1, note: '', done: false }],
    }),
  );
  assert.throws(() =>
    validateJourneyState({
      ...valid,
      gifts: [{ id: 'gift', npcId: 'npc-5014', itemId: 'skill-100', quantity: 1, note: '', done: false }],
    }),
  );
});

test('place/todo/gift put and remove are immutable JSON round-trip commands; raw labels remain renderer responsibility', () => {
  const initial = emptyJourneyState();
  let s = applyJourneyCommand(initial, {
    type: 'journey-place-put',
    placeId: 'place-22',
    note: '<img onerror=alert(1)>',
    favorite: true,
    done: false,
  });
  s = applyJourneyCommand(s, {
    type: 'journey-todo-put',
    id: 'todo-1',
    title: '<script>提醒</script>',
    detail: '核对药材',
    placeId: 'place-22',
    done: false,
  });
  s = applyJourneyCommand(s, {
    type: 'journey-gift-put',
    id: 'gift-1',
    npcId: 'npc-5014',
    itemId: 'item-100',
    quantity: 1,
    note: '自主选择',
    done: false,
  });
  validateJourneyState(JSON.parse(JSON.stringify(s)));
  const plan = journeyPlan(profile({ journey: s }), reference());
  assert.equal(plan.actions.find((a) => a.kind === 'todo').title, '<script>提醒</script>');
  assert.ok(plan.routes.find((r) => r.name === '野猪林').favorite);
  assert.deepEqual(initial, emptyJourneyState());
  for (const command of [
    { type: 'journey-place-remove', placeId: 'place-22' },
    { type: 'journey-todo-remove', id: 'todo-1' },
    { type: 'journey-gift-remove', id: 'gift-1' },
  ])
    s = applyJourneyCommand(s, command);
  assert.deepEqual(s, initial);
  assert.throws(
    () =>
      applyJourneyCommand(initial, {
        type: 'journey-todo-put',
        id: 't',
        title: 'a',
        detail: '',
        done: false,
        filename: 'private.sav',
      }),
    /格式/,
  );
});

test('injected indexes allow contract tests without reading or writing any game save', () => {
  const ownWorld = clone(world),
    ownGame = clone(game);
  const { journeyPlan: injected } = createJourneyPlanner({ world: ownWorld, game: ownGame });
  assert.deepEqual(injected(profile(), null), journeyPlan(profile(), null));
});
