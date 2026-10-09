'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { journeyPlan, createJourneyPlanner, stableId } = require('../src/core/journey-plan.cjs');
const {
  emptyJourneyState,
  applyJourneyCommand,
  validateItinerary,
} = require('../src/core/journey-state.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const ref = (quests, hash = 'synthetic-current') => ({
  name: 'Synthetic.sav',
  hash,
  modifiedAt: '2026-10-09T00:00:00.000Z',
  metadata: { quests, inventory: [] },
});
const profile = (questId = 'quest-11077', extra = {}) => ({
  id: 'synthetic-profile',
  referenceMode: 'slot',
  saveSlot: 'Synthetic.sav',
  craftList: [],
  goals: [
    {
      id: 'goal-source',
      title: '照自己的顺序办完',
      done: false,
      source: { type: 'quest', id: questId },
      ...extra,
    },
  ],
  journey: emptyJourneyState(),
});
function select(p, questId, r, placeId, planner = { journeyPlan }) {
  const plan = planner.journeyPlan(p, r);
  const action = plan.actions.find((a) => a.questId === questId);
  assert.ok(action);
  return {
    ...p,
    journey: applyJourneyCommand(
      p.journey,
      { type: 'journey-itinerary-add', id: action.id, ...(placeId ? { placeId } : {}) },
      { actions: plan.actions },
    ),
  };
}
function fixture() {
  const w = structuredClone(world);
  const base = w.quests.find((q) => q.id === 'quest-11078');
  w.quests.push({
    ...structuredClone(base),
    id: 'quest-9900001',
    gameId: 9900001,
    name: '合成后续药材',
    requirements: [{ type: 'PreQuest', id: 11078, value: 2, name: base.name }],
  });
  const planner = createJourneyPlanner({ world: w, game });
  return { w, planner };
}
const root = { id: 11077, step: 1 },
  child = { id: 11078, step: 1 };

test('the real 洛村 root continues to its active child with the same anchor, place, order and untouched intent', () => {
  let p = profile();
  p.journey.todos.push({ id: 'after', title: '下一件个人打算', detail: '', done: false });
  p = select(p, 'quest-11077', ref([root]), 'place-13');
  const original = JSON.stringify(p),
    anchor = p.journey.itinerary.steps[0].actionId;
  const changed = journeyPlan(p, ref([root, child], 'advanced'));
  const step = changed.itinerary.next;
  assert.equal(step.actionId, anchor);
  assert.equal(step.action.questId, 'quest-11078');
  assert.equal(step.selectedPlace.id, 'place-13');
  assert.equal(step.position, 0);
  assert.equal(step.status, 'pending');
  assert.equal(step.continuation.kind, 'automatic');
  assert.equal(step.completionSource, null);
  assert.equal(changed.goalProgress[0].status, 'active');
  assert.equal(JSON.stringify(p), original);
  assert.equal(journeyPlan(p, ref([root], 'old')).itinerary.next.action.questId, 'quest-11077');
  assert.equal(
    journeyPlan(p, ref([{ id: 11077, step: 4 }, child])).itinerary.steps[0].status,
    'game-complete',
  );
});

test('a completed child continues to an explicit PreQuest successor without inheriting old personal handling', () => {
  const { planner } = fixture();
  let p = select(profile(), 'quest-11078', ref([root, child]), 'place-13', planner);
  const anchor = p.journey.itinerary.steps[0].actionId;
  p.journey.handledActionIds.push(anchor);
  const advanced = ref([root, { id: 11078, step: 4 }, { id: 9900001, step: 1 }]);
  const step = planner.journeyPlan(p, advanced).itinerary.next;
  assert.equal(step.action.questId, 'quest-9900001');
  assert.equal(step.status, 'pending');
  assert.equal(step.handled, false);
  assert.equal(step.handledActionId, stableId('quest', ['quest-9900001']));
  assert.equal(step.actionId, anchor);
  assert.equal(planner.journeyPlan(p, ref([root, child], 'older')).itinerary.steps[0].status, 'handled');
});

test('an unconfirmed scene never silently adopts a successor but permits an explicit step choice', () => {
  let p = select(profile(), 'quest-11077', ref([root]));
  const original = structuredClone(p.journey.itinerary.steps[0]);
  const r = ref([root, child]);
  const plan = journeyPlan(p, r);
  assert.equal(plan.itinerary.next.continuation.kind, 'choice-required');
  assert.equal(plan.itinerary.next.action, null);
  const targetId = stableId('quest', ['quest-11078']);
  p.journey = applyJourneyCommand(
    p.journey,
    { type: 'journey-itinerary-continue', id: original.actionId, targetId },
    { actions: plan.actions, itinerarySteps: plan.itinerary.steps },
  );
  const step = journeyPlan(p, r).itinerary.next;
  assert.equal(step.action.questId, 'quest-11078');
  assert.equal(step.continuation.kind, 'selected');
  assert.equal(step.placePending, true);
  assert.equal(step.selectedPlace, null);
  assert.equal(step.status, 'pending');
  assert.deepEqual(p.journey.itinerary.steps[0], { ...original, continuationId: targetId });
  validateItinerary(JSON.parse(JSON.stringify(p.journey.itinerary)));
});

test('multiple active steps require an explicit trusted choice, retaining the original pointer and queue', () => {
  const { planner } = fixture();
  let p = select(profile(), 'quest-11077', ref([root]), 'place-13', planner);
  p.journey.handledActionIds.push(p.journey.itinerary.steps[0].actionId);
  const r = ref([root, child, { id: 9900001, step: 1 }]);
  const plan = planner.journeyPlan(p, r),
    step = plan.itinerary.next;
  assert.equal(step.status, 'unavailable');
  assert.equal(step.action, null);
  assert.equal(step.handled, false);
  assert.equal(step.continuation.candidates.length, 2);
  const original = structuredClone(p.journey.itinerary.steps[0]);
  const command = {
    type: 'journey-itinerary-continue',
    id: original.actionId,
    targetId: stableId('quest', ['quest-11078']),
    placeId: 'place-13',
  };
  assert.throws(() => applyJourneyCommand(p.journey, command, { actions: plan.actions }), /接续步骤/);
  assert.throws(
    () =>
      applyJourneyCommand(
        p.journey,
        { ...command, targetId: stableId('quest', ['quest-11079']) },
        { actions: plan.actions, itinerarySteps: plan.itinerary.steps },
      ),
    /接续步骤/,
  );
  assert.throws(
    () =>
      applyJourneyCommand(
        p.journey,
        { ...command, gameComplete: true },
        { actions: plan.actions, itinerarySteps: plan.itinerary.steps },
      ),
    /格式无效/,
  );
  p.journey = applyJourneyCommand(p.journey, command, {
    actions: plan.actions,
    itinerarySteps: plan.itinerary.steps,
  });
  assert.deepEqual(p.journey.itinerary.steps[0], { ...original, continuationId: command.targetId });
  validateItinerary(JSON.parse(JSON.stringify(p.journey.itinerary)));
  const projected = planner.journeyPlan(p, r).itinerary.next;
  assert.equal(projected.action.questId, 'quest-11078');
  assert.equal(projected.continuation.kind, 'selected');
  const saved = JSON.stringify(p.journey);
  p.journey = applyJourneyCommand(
    p.journey,
    { type: 'journey-action-handle', id: projected.handledActionId, handled: true },
    { actions: plan.actions },
  );
  assert.equal(planner.journeyPlan(p, r).itinerary.steps[0].status, 'handled');
  p.journey = applyJourneyCommand(p.journey, {
    type: 'journey-action-handle',
    id: projected.handledActionId,
    handled: false,
  });
  assert.equal(JSON.stringify(p.journey), saved);
});

test('a changed scene requires confirmation and a disappeared chosen branch cannot silently switch to another', () => {
  const { w } = fixture();
  w.quests.find((q) => q.id === 'quest-11078').description = '需要前往梧桐村';
  w.quests.find((q) => q.id === 'quest-11078').name = '合成外地步骤';
  const planner = createJourneyPlanner({ world: w, game });
  let p = select(profile(), 'quest-11077', ref([root]), 'place-13', planner);
  const r = ref([root, child]);
  const plan = planner.journeyPlan(p, r);
  assert.equal(plan.itinerary.next.status, 'unavailable');
  assert.equal(plan.itinerary.next.selectedPlace.id, 'place-13');
  const cmd = {
    type: 'journey-itinerary-continue',
    id: plan.itinerary.next.actionId,
    targetId: stableId('quest', ['quest-11078']),
    placeId: 'place-9',
  };
  assert.throws(
    () =>
      applyJourneyCommand(
        p.journey,
        { ...cmd, placeId: 'place-13' },
        { actions: plan.actions, itinerarySteps: plan.itinerary.steps },
      ),
    /所选场景/,
  );
  p.journey = applyJourneyCommand(p.journey, cmd, {
    actions: plan.actions,
    itinerarySteps: plan.itinerary.steps,
  });
  assert.equal(planner.journeyPlan(p, r).itinerary.next.selectedPlace.id, 'place-9');
  // Remove the prerequisite edge: this is a different branch, not a successor.
  w.quests.find((q) => q.id === 'quest-9900001').requirements = [];
  w.quests.find((q) => q.id === 'quest-9900001').description = '梧桐村的另一件事';
  const later = createJourneyPlanner({ world: w, game }).journeyPlan(
    p,
    ref([root, { id: 9900001, step: 1 }]),
  );
  assert.equal(later.itinerary.next.status, 'unavailable');
  assert.equal(later.itinerary.next.action, null);
  assert.equal(later.itinerary.next.continuation.kind, 'choice-required');
});

test('manual, unavailable reference and truly removed sources remain unresolved instead of adopting a nearby task', () => {
  let p = select(profile(), 'quest-11077', ref([root]), 'place-13');
  p.goals = [];
  assert.equal(journeyPlan(p, ref([root, child])).itinerary.next.status, 'unavailable');
  assert.equal(journeyPlan(p, null).itinerary.next.continuation, null);
  const w = structuredClone(world);
  w.quests = w.quests.filter((q) => q.id !== 'quest-11077');
  assert.equal(
    createJourneyPlanner({ world: w, game }).journeyPlan(p, ref([child])).itinerary.next.action,
    null,
  );
  p = select(profile('quest-11077', { progressMode: 'manual' }), 'quest-11077', ref([root]), 'place-13');
  const manual = journeyPlan(p, ref([root, child, { id: 11079, step: 1 }])).itinerary.next;
  assert.equal(manual.action.questId, 'quest-11077');
  assert.equal(manual.continuation, null);
  assert.equal(manual.status, 'pending');
});

for (const [recordStep, label, status] of [
  [2, '已失败', 'failed'],
  [3, '尚未接取', 'not-accepted'],
]) {
  test(`a real selected root recorded ${status} cannot continue to its active child`, () => {
    const p = select(profile(), 'quest-11077', ref([root]), 'place-13');
    const intent = JSON.stringify(p);
    const changed = journeyPlan(p, ref([{ id: 11077, step: recordStep }, child]));
    const step = changed.itinerary.next;
    assert.equal(changed.goalProgress[0].status, status);
    assert.equal(step.status, 'unavailable');
    assert.equal(step.action, null);
    assert.equal(step.continuation, null);
    assert.equal(step.completionSource, null);
    assert.match(step.reason, new RegExp(label));
    assert(changed.warnings.some((w) => w.code === 'conflicting-quest-records' && w.message.includes(label)));
    assert.equal(JSON.stringify(p), intent);
    assert.equal(journeyPlan(p, ref([root, child], 'older')).itinerary.next.action.questId, 'quest-11078');
    assert.equal(
      journeyPlan(p, ref([{ id: 11077, step: 4 }, child])).itinerary.steps[0].status,
      'game-complete',
    );
  });
}

test('an active descendant below a failed or unaccepted intermediate record is not offered as a trusted continuation', () => {
  // The three-level hierarchy is synthetic; the selected root and child are real catalog entries.
  const { w } = fixture();
  w.quests.find((q) => q.id === 'quest-9900001').parentId = 11078;
  const planner = createJourneyPlanner({ world: w, game });
  for (const recordStep of [2, 3]) {
    const p = select(profile(), 'quest-11077', ref([root]), 'place-13', planner);
    const before = JSON.stringify(p);
    const plan = planner.journeyPlan(
      p,
      ref([root, { id: 11078, step: recordStep }, { id: 9900001, step: 1 }]),
    );
    assert.equal(plan.itinerary.next.status, 'unavailable');
    assert.equal(plan.itinerary.next.action, null);
    assert.equal(plan.itinerary.next.continuation, null);
    assert.equal(plan.itinerary.next.completionSource, null);
    assert(plan.warnings.some((w) => w.code === 'conflicting-quest-records'));
    assert.equal(JSON.stringify(p), before);
  }
});

test('conflicting save records preserve personal handling, manual mode and explicit completion of the selected quest', () => {
  let p = select(profile(), 'quest-11077', ref([root]), 'place-13');
  const conflicting = ref([{ id: 11077, step: 2 }, child]);
  p.goals[0].done = true;
  assert.equal(journeyPlan(p, conflicting).itinerary.steps[0].status, 'user-done');
  p.goals[0].done = false;
  p.journey.handledActionIds.push(p.journey.itinerary.steps[0].actionId);
  assert.equal(journeyPlan(p, conflicting).itinerary.steps[0].status, 'handled');
  p = select(profile('quest-11077', { progressMode: 'manual' }), 'quest-11077', ref([root]), 'place-13');
  const manual = journeyPlan(p, conflicting).itinerary.next;
  assert.equal(manual.status, 'pending');
  assert.equal(manual.action.questId, 'quest-11077');
  assert.equal(manual.continuation, null);
  p = select(profile(), 'quest-11078', ref([root, child]), 'place-13');
  const completed = journeyPlan(
    p,
    ref([
      { id: 11077, step: 2 },
      { id: 11078, step: 4 },
    ]),
  );
  assert.equal(completed.itinerary.steps[0].status, 'game-complete');
  assert.notEqual(completed.itinerary.steps[0].completionSource, null);
});
