'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { journeyPlan, createJourneyPlanner } = require('../src/core/journey-plan.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const {
  emptyJourneyState,
  applyJourneyCommand,
  validateJourneyState,
  validateItinerary,
} = require('../src/core/journey-state.cjs');
const { Store } = require('../src/core/store.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const profile = (extra = {}) => ({
  id: 'synthetic-profile',
  name: '合成周目',
  goals: [],
  checks: {},
  craftList: [],
  referenceMode: 'slot',
  saveSlot: 'Synthetic.sav',
  journey: emptyJourneyState(),
  ...extra,
});
const reference = (metadata = {}, hash = 'synthetic-hash') => ({
  name: 'Synthetic.sav',
  hash,
  modifiedAt: '2026-10-08T00:00:00.000Z',
  metadata: { quests: [], inventory: [], ...metadata },
});
const todo = (id, placeId) => ({
  id,
  title: `合成待办 ${id}`,
  detail: '',
  done: false,
  ...(placeId ? { placeId } : {}),
});
const goal = (id, extra = {}) => ({
  id: `goal-${id}`,
  title: `任务 ${id}`,
  detail: '',
  done: false,
  source: { type: 'quest', id: `quest-${id}` },
  ...extra,
});
function command(p, value, r = null) {
  const plan = journeyPlan(p, r);
  return { ...p, journey: applyJourneyCommand(p.journey, value, { actions: plan.actions }) };
}
function add(p, a, r = null, placeId) {
  return command(p, { type: 'journey-itinerary-add', id: a.id, ...(placeId ? { placeId } : {}) }, r);
}
function twoTodos() {
  const p = profile();
  p.journey.todos = [todo('first'), todo('second')];
  return p;
}

test('old schema with no itinerary remains valid and all-actions behavior remains available', () => {
  const p = twoTodos();
  const original = JSON.stringify(p);
  validateJourneyState(p.journey);
  const plan = journeyPlan(p, null);
  assert.equal(plan.itinerary, null);
  assert.equal(plan.summary.pending, 2);
  assert.equal(
    companionSnapshot({ profiles: [p], activeProfileId: p.id }, { entries: [] }, null).nextActions.length,
    2,
  );
  assert.equal(JSON.stringify(p), original);
});

test('selection is deduplicated, preserves source pointers and copies no save facts or resource quantities', () => {
  let p = twoTodos();
  const a = journeyPlan(p, null).actions[0];
  p = add(p, a);
  const one = JSON.stringify(p.journey);
  p = add(p, a);
  assert.equal(JSON.stringify(p.journey), one);
  const selection = p.journey.itinerary.steps[0];
  assert.deepEqual(selection.sources, [{ type: 'user', id: 'first', field: 'journey' }]);
  assert.deepEqual(
    Object.keys(selection).sort(),
    ['actionId', 'progressMode', 'skipped', 'sources', 'title'].sort(),
  );
  assert.equal(selection.progressMode, 'manual');
  validateJourneyState(JSON.parse(JSON.stringify(p.journey)));
});

test('current action validation rejects invented IDs, mismatched scenes and renderer-injected facts', () => {
  const p = twoTodos(),
    a = journeyPlan(p, null).actions[0];
  for (const c of [
    { type: 'journey-itinerary-add', id: 'journey:todo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { type: 'journey-itinerary-add', id: 'bad' },
    { type: 'journey-itinerary-add', id: a.id, placeId: 'place-22' },
    { type: 'journey-itinerary-add', id: a.id, title: '注入名称' },
    { type: 'journey-itinerary-add', id: a.id, gameComplete: true },
  ])
    assert.throws(() => command(p, c));
  assert.throws(() => applyJourneyCommand(p.journey, { type: 'journey-itinerary-add', id: a.id }));
});

for (const kind of ['todo', 'goal'])
  test(`a personal ${kind} title containing quantity-like text survives selection and removal of its source`, () => {
    const title = '来回核对 × 2，再记录图纸差异';
    let p = profile();
    if (kind === 'todo') p.journey.todos = [{ id: 'synthetic-title', title, detail: '', done: false }];
    else p.goals = [{ id: 'synthetic-title', title, detail: '', done: false }];
    const action = journeyPlan(p, null).actions.find((a) => a.kind === kind);
    p = add(p, action);
    assert.equal(p.journey.itinerary.steps[0].title, title);
    if (kind === 'todo') p.journey.todos = [];
    else p.goals = [];
    const projected = journeyPlan(p, null).itinerary.steps[0];
    assert.equal(projected.status, 'unavailable');
    assert.equal(projected.title, title);
    validateJourneyState(JSON.parse(JSON.stringify(p.journey)));
  });

test('generated crafting quantity labels are still shortened independently of personal titles', () => {
  const p = profile({ craftList: [{ id: 'fusion-1000', quantity: 2 }] });
  const action = journeyPlan(p, null).actions.find((a) => a.kind === 'craft');
  assert(action.title.includes('× 2'));
  const selected = add(p, action);
  assert.equal(selected.journey.itinerary.steps[0].title, action.title.replace(/\s*×\s*\d+.*$/, ''));
  assert.equal(Object.hasOwn(selected.journey.itinerary.steps[0], 'quantity'), false);
});

test('one action with same-name and multiple location clues occupies exactly one chosen position', () => {
  let p = profile({ goals: [goal(14082)] });
  const r = reference(),
    a = journeyPlan(p, r).actions.find((a) => a.questId === 'quest-14082');
  const ids = [...new Set(a.places.flatMap((p) => p.mapIds))];
  assert.ok(ids.length > 1);
  p = add(p, a, r);
  const pending = journeyPlan(p, r).itinerary.next;
  assert.equal(Object.hasOwn(p.journey.itinerary.steps[0], 'placeId'), false);
  assert.equal(pending.selectedPlace, null);
  assert.equal(pending.placePending, true);
  assert.equal(pending.status, 'pending');
  assert.match(pending.placeLabel, /场景待核定/);
  assert.deepEqual(pending.selectionSources, p.journey.itinerary.steps[0].sources);
  validateJourneyState(JSON.parse(JSON.stringify(p.journey)));
  p = command(p, { type: 'journey-itinerary-place', id: a.id, placeId: ids[0] }, r);
  p = add(p, a, r, ids[1]);
  assert.equal(p.journey.itinerary.steps.length, 1);
  assert.equal(p.journey.itinerary.steps[0].placeId, ids[0]);
  p = command(p, { type: 'journey-itinerary-place', id: a.id, placeId: ids[1] }, r);
  assert.equal(journeyPlan(p, r).itinerary.next.selectedPlace.id, ids[1]);
  assert.equal(journeyPlan(p, r).itinerary.summary.total, 1);
  assert.equal(journeyPlan(p, r).itinerary.next.placePending, false);
  p = command(p, { type: 'journey-itinerary-place', id: a.id }, r);
  assert.equal(journeyPlan(p, r).itinerary.next.placePending, true);
  assert.equal(p.journey.itinerary.steps.length, 1);
});

test('unconfirmed scene intent survives cold restart and full protection without guessing a map', async (t) => {
  const migration = require('../src/core/migration.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-unconfirmed-scene-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataRoot = path.join(dir, 'source');
  const store = new Store(dataRoot, { entries: [] });
  store.mutate({
    type: 'goal-add',
    title: '之后核定桃花林场景',
    source: { type: 'quest', id: 'quest-14082' },
  });
  const p = store.get().profiles[0];
  const actions = journeyPlan(p, null).actions;
  const action = actions.find((row) => row.questId === 'quest-14082');
  assert(new Set(action.places.flatMap((row) => row.mapIds)).size > 1);
  store.mutate({ type: 'journey-itinerary-add', id: action.id }, { journeyActions: actions });
  store.mutate({ type: 'journey-itinerary-status', status: 'active' });
  const intent = store.get().profiles[0].journey.itinerary;
  assert.equal(Object.hasOwn(intent.steps[0], 'placeId'), false);
  const reopened = new Store(dataRoot, { entries: [] });
  const saved = reopened.get().profiles[0];
  assert.deepEqual(saved.journey.itinerary, intent);
  const compact = companionSnapshot({ profiles: [saved], activeProfileId: saved.id }, { entries: [] }, null);
  assert.equal(compact.itinerary.next.placePending, true);
  assert.match(compact.hints[0].title, /场景待核定/);
  const file = path.join(dir, 'synthetic-pending-scene.yijian-protection');
  await migration.exportProtection({ dataRoot, file });
  const targetDirectory = path.join(dir, 'historical');
  await migration.importProtection({ file, targetDirectory });
  const history = await migration.readHistory({ directory: targetDirectory });
  assert.deepEqual(history.journal.profiles[0].journey.itinerary, intent);
  assert.deepEqual(history.journal.profiles[0].goals, saved.goals);
});

test('selection limit is 100 and strict portable validation excludes all facts and malformed intent', () => {
  const p = profile();
  p.journey.todos = Array.from({ length: 101 }, (_, i) => todo(`t-${i}`));
  const actions = journeyPlan(p, null).actions;
  let state = p.journey;
  for (const a of actions.slice(0, 100))
    state = applyJourneyCommand(state, { type: 'journey-itinerary-add', id: a.id }, { actions });
  assert.equal(state.itinerary.steps.length, 100);
  assert.throws(
    () => applyJourneyCommand(state, { type: 'journey-itinerary-add', id: actions[100].id }, { actions }),
    /100/,
  );
  const choice = state.itinerary.steps[0];
  for (const itinerary of [
    { ...state.itinerary, name: ' ' },
    { ...state.itinerary, status: 'complete' },
    { ...state.itinerary, currentStepId: choice.actionId },
    { ...state.itinerary, steps: [choice, choice] },
    { ...state.itinerary, steps: [{ ...choice, skipped: 1 }] },
    { ...state.itinerary, steps: [{ ...choice, progressMode: 'done' }] },
    { ...state.itinerary, steps: [{ ...choice, placeId: '../../outside' }] },
    { ...state.itinerary, steps: [{ ...choice, sources: [] }] },
    {
      ...state.itinerary,
      steps: [{ ...choice, sources: [{ type: 'save', id: 'Synthetic.sav', field: 'quests' }] }],
    },
    {
      ...state.itinerary,
      steps: [{ ...choice, sources: [{ type: 'user', id: 'first', field: 'journey', hash: 'fact' }] }],
    },
    {
      ...state.itinerary,
      steps: [{ ...choice, sources: [{ type: 'user', id: 'first', field: 'unknown' }] }],
    },
  ])
    assert.throws(() => validateItinerary(itinerary));
});

test('ordering stays stable across recomputation, boundary moves, renaming, remove and clear', () => {
  let p = twoTodos();
  const [a, b] = journeyPlan(p, null).actions;
  p = add(add(p, a), b);
  p = command(p, { type: 'journey-itinerary-move', id: b.id, direction: 'up' });
  p = command(p, { type: 'journey-itinerary-move', id: b.id, direction: 'up' });
  p = command(p, { type: 'journey-itinerary-name', name: '  先看药材  ' });
  assert.equal(p.journey.itinerary.name, '先看药材');
  assert.deepEqual(
    journeyPlan(p, null).itinerary.steps.map((s) => s.actionId),
    [b.id, a.id],
  );
  const reorderedSources = { ...p, journey: { ...p.journey, todos: [...p.journey.todos].reverse() } };
  assert.deepEqual(
    journeyPlan(reorderedSources, null).itinerary.steps.map((s) => s.actionId),
    [b.id, a.id],
  );
  assert.throws(() => command(p, { type: 'journey-itinerary-move', id: b.id, direction: 'sideways' }));
  p = command(p, { type: 'journey-itinerary-remove', id: b.id });
  assert.equal(journeyPlan(p, null).itinerary.next.actionId, a.id);
  p = command(p, { type: 'journey-itinerary-clear' });
  assert.equal(p.journey.itinerary.status, 'draft');
  assert.equal(p.journey.todos.length, 2);
  assert.throws(() => command(p, { type: 'journey-itinerary-status', status: 'active' }), /至少/);
});

test('removed actions remain named with their original source and require an explicit decision', () => {
  let p = twoTodos();
  const [a, b] = journeyPlan(p, null).actions;
  p = add(add(p, a), b);
  p = command(p, { type: 'journey-todo-remove', id: 'first' });
  const trip = journeyPlan(p, reference()).itinerary;
  assert.equal(trip.steps.length, 2);
  assert.equal(trip.next.actionId, a.id);
  assert.equal(trip.next.title, '合成待办 first');
  assert.equal(trip.next.status, 'unavailable');
  assert.match(trip.next.reason, /未推断为游戏完成/);
  assert.deepEqual(trip.next.selectionSources, [{ type: 'user', id: 'first', field: 'journey' }]);
  assert.equal(trip.summary['game-complete'], 0);
});

test('changed and disappeared scene choices stay intact and visibly require review', () => {
  let p = profile();
  p.journey.todos = [todo('scene', 'place-22')];
  const a = journeyPlan(p, null).actions[0];
  p = add(p, a, null, 'place-22');
  p = command(p, { type: 'journey-todo-put', ...todo('scene', 'place-23') });
  assert.equal(journeyPlan(p, null).itinerary.next.status, 'unavailable');
  assert.equal(p.journey.itinerary.steps[0].placeId, 'place-22');
  // A historical choice can still be decoded if its map is removed from data.
  const ownWorld = structuredClone(world);
  ownWorld.maps = ownWorld.maps.filter((p) => p.id !== 'place-22');
  const planner = createJourneyPlanner({ world: ownWorld, game });
  const trip = planner.journeyPlan(p, null).itinerary;
  assert.equal(trip.next.selectedPlace.name, '原场景 place-22');
  assert.equal(trip.steps.length, 1);
});

test('automatic completion advances and an older reference restores the same selected quest', () => {
  let p = profile({ goals: [goal(13803)] });
  p.journey.todos = [todo('after')];
  const r = reference({ quests: [{ id: 13803, step: 1 }] });
  const actions = journeyPlan(p, r).actions;
  const quest = actions.find((a) => a.questId === 'quest-13803'),
    after = actions.find((a) => a.kind === 'todo');
  const place = quest.places[0]?.mapIds[0];
  p = add(add(p, quest, r, place), after, r);
  const before = JSON.stringify(p.journey);
  const complete = journeyPlan(p, reference({ quests: [{ id: 13803, step: 4 }] }, 'new')).itinerary;
  assert.equal(complete.steps[0].status, 'game-complete');
  assert.equal(complete.next.actionId, after.id);
  assert.equal(complete.steps[0].completionSource.hash, 'new');
  assert.equal(journeyPlan(p, r).itinerary.next.actionId, quest.id);
  assert.equal(JSON.stringify(p.journey), before);
  assert.equal(p.goals[0].done, false);
});

test('a selected child suppressed by completed parent advances on explicit source and regresses on old save', () => {
  let p = profile({ goals: [goal(5053)] });
  const r = reference({
    quests: [
      { id: 5053, step: 1 },
      { id: 5057, step: 1 },
    ],
  });
  const a = journeyPlan(p, r).actions.find((a) => a.questId === 'quest-5057');
  assert.ok(a);
  p = add(p, a, r, a.places[0]?.mapIds[0]);
  const next = journeyPlan(
    p,
    reference({
      quests: [
        { id: 5053, step: 4 },
        { id: 5057, step: 1 },
      ],
    }),
  ).itinerary;
  assert.equal(next.steps[0].status, 'game-complete');
  assert.match(next.steps[0].reason, /上级任务/);
  assert.equal(next.next, null);
  assert.equal(journeyPlan(p, r).itinerary.next.actionId, a.id);
});

test('manual quest intention does not become automatic completion after its owner is removed', () => {
  let p = profile({ goals: [goal(13803, { progressMode: 'manual' })] });
  const r = reference({ quests: [{ id: 13803, step: 4 }] });
  const a = journeyPlan(p, r).actions.find((a) => a.questId === 'quest-13803');
  p = add(p, a, r, a.places[0]?.mapIds[0]);
  p.goals = [];
  const trip = journeyPlan(p, r).itinerary;
  assert.equal(trip.steps[0].status, 'unavailable');
  assert.equal(trip.summary['game-complete'], 0);
});

test('manual handling advances globally, is reversible even after the action disappears, and writes no game state', () => {
  let p = twoTodos();
  const [a, b] = journeyPlan(p, null).actions;
  p = add(add(p, a), b);
  p = command(p, { type: 'journey-action-handle', id: a.id, handled: true });
  assert.equal(journeyPlan(p, null).itinerary.next.actionId, b.id);
  assert.equal(journeyPlan(p, null).itinerary.steps[0].status, 'handled');
  assert.equal(p.journey.todos[0].done, false);
  p = command(p, { type: 'journey-todo-remove', id: 'first' });
  assert.equal(journeyPlan(p, null).itinerary.steps[0].status, 'handled');
  p = command(p, { type: 'journey-action-handle', id: a.id, handled: false });
  assert.equal(journeyPlan(p, null).itinerary.next.status, 'unavailable');
});

test('skipping only this session leaves all-actions pending and can restore the earliest selected item', () => {
  let p = twoTodos();
  const [a, b] = journeyPlan(p, null).actions;
  p = add(add(p, a), b);
  p = command(p, { type: 'journey-itinerary-skip', id: a.id, skipped: true });
  assert.equal(journeyPlan(p, null).itinerary.next.actionId, b.id);
  assert.equal(journeyPlan(p, null).summary.pending, 2);
  assert.deepEqual(p.journey.handledActionIds, []);
  p = command(p, { type: 'journey-itinerary-skip', id: a.id, skipped: false });
  assert.equal(journeyPlan(p, null).itinerary.next.actionId, a.id);
});

test('personal todo completion and reopen keep selected order without manufacturing game completion', () => {
  let p = twoTodos();
  const [a, b] = journeyPlan(p, null).actions;
  p = add(add(p, a), b);
  p = command(p, { type: 'journey-todo-put', ...todo('first'), done: true });
  assert.equal(journeyPlan(p, null).itinerary.next.actionId, b.id);
  assert.equal(journeyPlan(p, null).itinerary.summary['user-done'], 1);
  p = command(p, { type: 'journey-todo-put', ...todo('first') });
  assert.equal(journeyPlan(p, null).itinerary.next.actionId, a.id);
  assert.equal(journeyPlan(p, null).itinerary.summary['game-complete'], 0);
});

test('the small-window projection and passive hint use the same selected next item and reference', () => {
  let p = twoTodos();
  const [a, b] = journeyPlan(p, null).actions;
  p = add(add(p, b), a);
  p = command(p, { type: 'journey-itinerary-status', status: 'active' });
  const data = companionSnapshot({ profiles: [p], activeProfileId: p.id }, { entries: [] }, reference());
  assert.equal(data.itinerary.next.actionId, b.id);
  assert.equal(data.nextActions[0].id, b.id);
  assert.equal(data.hints[0].id, b.id);
  assert.deepEqual(
    data.itinerary.reference,
    data.reference && {
      name: data.reference.name,
      hash: data.reference.hash,
      modifiedAt: data.reference.modifiedAt,
    },
  );
});

test('atomic Store preserves independent sessions across profile switches and a cold restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-session-journey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, { entries: [] });
  const firstId = store.get().activeProfileId;
  store.mutate({ type: 'journey-todo-put', id: 'first', title: '合成第一程', detail: '', done: false });
  const p = store.get().profiles[0],
    a = journeyPlan(p, null).actions[0];
  store.mutate({ type: 'journey-itinerary-add', id: a.id }, { journeyActions: [a] });
  store.mutate({ type: 'journey-itinerary-status', status: 'active' });
  store.mutate({ type: 'journey-itinerary-name', name: '第一程' });
  store.mutate({ type: 'profile-add', name: '第二合成周目' });
  const secondId = store.get().activeProfileId;
  store.mutate({ type: 'journey-todo-put', id: 'second', title: '合成第二程', detail: '', done: false });
  const second = store.get().profiles.find((p) => p.id === secondId),
    b = journeyPlan(second, null).actions[0];
  store.mutate({ type: 'journey-itinerary-add', id: b.id }, { journeyActions: [b] });
  store.mutate({ type: 'journey-itinerary-skip', id: b.id, skipped: true });
  store.mutate({ type: 'journey-itinerary-status', status: 'ended' });
  const reopened = new Store(dir, { entries: [] });
  reopened.mutate({ type: 'profile-switch', id: firstId });
  const saved = reopened.get().profiles;
  assert.equal(saved.find((p) => p.id === firstId).journey.itinerary.name, '第一程');
  assert.equal(saved.find((p) => p.id === firstId).journey.itinerary.status, 'active');
  assert.equal(saved.find((p) => p.id === secondId).journey.itinerary.status, 'ended');
  assert.equal(saved.find((p) => p.id === secondId).journey.itinerary.steps[0].skipped, true);
  assert.equal(
    journeyPlan(
      saved.find((p) => p.id === firstId),
      null,
    ).itinerary.next.actionId,
    a.id,
  );
  assert.ok(fs.existsSync(path.join(dir, 'journal.json.previous')));
});

test('portable protection and read-only history retain selected intent and existing journal event semantics', async (t) => {
  const migration = require('../src/core/migration.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-session-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataRoot = path.join(dir, 'source');
  const store = new Store(dataRoot, { entries: [] });
  store.mutate({
    type: 'journey-todo-put',
    id: 'todo-history',
    title: '合成历史待办',
    detail: '',
    placeId: 'place-22',
    done: false,
  });
  const action = journeyPlan(store.get().profiles[0], null).actions[0];
  store.mutate(
    { type: 'journey-itinerary-add', id: action.id, placeId: 'place-22' },
    { journeyActions: [action] },
  );
  store.mutate({ type: 'journey-itinerary-status', status: 'active' });
  assert.deepEqual(store.get().profiles[0].journalEntries || [], []);
  store.mutate({
    type: 'journey-todo-put',
    id: 'todo-history',
    title: '合成历史待办',
    detail: '',
    placeId: 'place-22',
    done: true,
  });
  store.mutate({
    type: 'journey-todo-put',
    id: 'todo-history',
    title: '合成历史待办',
    detail: '',
    placeId: 'place-22',
    done: false,
  });
  const original = store.get().profiles[0];
  assert.deepEqual(
    original.journalEntries.map((e) => e.kind),
    ['todo-completed', 'todo-reopened'],
  );
  const file = path.join(dir, 'synthetic-session.yijian-protection');
  await migration.exportProtection({ dataRoot, file });
  const targetDirectory = path.join(dir, 'historical');
  await migration.importProtection({ file, targetDirectory });
  const view = await migration.readHistory({ directory: targetDirectory });
  const historical = view.journal.profiles[0];
  assert.deepEqual(historical.journey.itinerary, original.journey.itinerary);
  assert.deepEqual(historical.journalEntries, original.journalEntries);
  assert.equal(view.timeline.enabled, false);
  assert.equal(
    fs.readFileSync(path.join(dataRoot, 'journal.json'), 'utf8'),
    JSON.stringify(store.get(), null, 2),
  );
});
