'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { applyJourneyTrashCommand, validateJourneyTrash } = require('../src/core/journey-trash.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { intentTarget } = require('../src/core/intent-drafts.cjs');
const { StartupRecovery } = require('../src/core/startup-recovery.cjs');
const migration = require('../src/core/migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs');
const clone = (value) => structuredClone(value);
const current = (store) => store.get().profiles[0];
const rawPlan = () => ({
  id: 'original-plan',
  name: '  完整制作计划\n原名  ',
  list: [
    { id: 'fusion-1000', quantity: 3 },
    { id: 'fusion-1001', quantity: 2 },
  ],
  choices: { 10216: 'fusion-9500' },
  reserved: true,
  done: true,
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
});
function setup() {
  const parent =
    process.env.YIJIAN_CRAFT_PLAN_TRASH_TMPDIR ||
    path.join(__dirname, '..', '.test-data', 'craft-plan-trash-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'synthetic-'));
  return { root, store: new Store(path.join(root, 'source'), catalog) };
}
function unchanged(store, operation, pattern) {
  const state = store.get(),
    bytes = fs.readFileSync(store.file);
  assert.throws(operation, pattern);
  assert.deepEqual(store.get(), state);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
}
function withPlan(store, plan = rawPlan()) {
  const state = store.get();
  state.profiles[0].craftPlans = [clone(plan)];
  store.commit(state);
  return plan;
}
function remove(store, plan) {
  store.mutate({ type: 'craft-plan-remove', id: plan.id, expectedRecord: clone(plan) });
  return current(store).journeyTrash.find((row) => row.kind === 'craft-plan');
}
const restore = (row) => ({ type: 'journey-trash-restore', id: row.id, expectedTrash: clone(row) });

test('stale full-plan confirmations reject changes to every field and preserve exact memory and file bytes', () => {
  const { store } = setup(),
    plan = rawPlan();
  const changes = [
    { name: '另一窗口的新名称' },
    { list: [{ id: 'fusion-1001', quantity: 5 }] },
    { choices: {} },
    { reserved: false },
    { done: false },
    { createdAt: '2026-10-07T08:00:00.000Z' },
    { updatedAt: '2026-10-09T09:00:00.000Z' },
  ];
  for (const change of changes) {
    withPlan(store, { ...plan, ...change });
    unchanged(store, () => remove(store, plan), /已变化/);
  }
  withPlan(store, plan);
  const reversed = Object.fromEntries(Object.entries(plan).reverse());
  const row = remove(store, reversed);
  assert.deepEqual(row.record, plan);
  unchanged(store, () => remove(store, reversed), /已变化/);
});

test('single restore preserves all later content, editor ownership, history detachments and raw plan fields after restart', () => {
  const { root, store } = setup(),
    plan = withPlan(store);
  let state = store.get(),
    p = state.profiles[0];
  p.craftList = [{ id: 'fusion-1002', quantity: 4 }];
  p.craftChoices = { 10216: 'fusion-9500' };
  p.reserveCraftDraft = false;
  p.activeCraftPlanId = plan.id;
  p.previousCraftList = [{ id: 'fusion-1001', quantity: 5 }];
  p.previousCraftChoices = {};
  p.previousCraftContext = { activeCraftPlanId: plan.id, reserveCraftDraft: true };
  store.commit(state);
  store.mutate({
    type: 'journal-entry-put',
    title: '计划原关联',
    body: '历史保持',
    occurredAt: '2026-10-09T06:00:00.000Z',
    tags: [],
    links: [{ type: 'craft-plan', id: plan.id }],
    snapshotMode: 'none',
  });
  const row = remove(store, plan);
  p = current(store);
  assert.equal(p.activeCraftPlanId, undefined);
  assert.equal(p.previousCraftContext.activeCraftPlanId, undefined);
  assert.deepEqual(p.craftList, [{ id: 'fusion-1002', quantity: 4 }]);
  assert.equal(p.reserveCraftDraft, false);
  store.mutate({
    type: 'craft-plan-save',
    name: '后来的独立计划',
    list: [{ id: 'fusion-1000', quantity: 1 }],
    choices: {},
    reserved: false,
  });
  const laterPlanId = current(store).craftPlans[0].id;
  store.mutate({ type: 'craft-plan-open', id: laterPlanId });
  store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 6 });
  store.mutate({ type: 'craft-choice', itemId: '10216', recipeId: '' });
  store.mutate({ type: 'goal-add', title: '后来的独立目标', detail: '完整新说明' });
  store.mutate({ type: 'note', value: '后来笔记\n完整末行' });
  store.mutate({
    type: 'journal-draft-put',
    id: 'later-journal-draft',
    revision: 0,
    title: '',
    body: '后来未写完的正文',
    localTime: '',
    tags: '',
    links: [],
    snapshotMode: 'none',
  });
  store.mutate({
    type: 'intent-draft-put',
    id: 'later-intent-draft',
    expectedRevision: 0,
    kind: 'journey-todo',
    targetId: '',
    context: {},
    expectedTarget: intentTarget(current(store), 'journey-todo', '', {}),
    values: { title: '后来未写完的安排', detail: '完整草稿', placeId: '', done: false, placeQuery: '' },
  });
  state = store.get();
  p = state.profiles[0];
  p.resourcePriority = ['@draft', p.craftPlans[0].id, plan.id];
  store.commit(state);
  const before = current(store),
    cold = new Store(path.join(root, 'source'), catalog);
  cold.mutate(restore(row));
  const after = current(cold);
  assert.deepEqual(after.craftPlans, [...before.craftPlans, plan]);
  for (const key of Object.keys(before).filter(
    (key) => !['craftPlans', 'journeyTrash', 'updatedAt'].includes(key),
  ))
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.activeCraftPlanId, laterPlanId);
  assert.equal(after.journeyTrash.length, 0);
  assert(
    after.journalEntries.some((entry) =>
      entry.links.some((link) => link.type === 'craft-plan' && link.detached),
    ),
  );
  assert.deepEqual(new Store(path.join(root, 'source'), catalog).get().profiles[0].craftPlans.at(-1), plan);
});

test('restoring an unfinished reserved plan recomputes shared budget without replacing the current draft or its priority', () => {
  const { store } = setup(),
    plan = withPlan(store, {
      ...rawPlan(),
      done: false,
      choices: {},
      list: [{ id: 'fusion-1000', quantity: 2 }],
    });
  const row = remove(store, plan);
  const state = store.get();
  Object.assign(state.profiles[0], {
    referenceMode: 'latest',
    craftList: [{ id: 'fusion-1001', quantity: 1 }],
    reserveCraftDraft: false,
    resourcePriority: [plan.id, '@draft'],
  });
  store.commit(state);
  const reference = {
    name: '1.sav',
    metadata: {
      inventory: [
        { id: 10216, count: 100 },
        { id: 10205, count: 100 },
      ],
      quests: [],
    },
  };
  const before = current(store),
    priorBudget = resourceBudget(before, reference);
  store.mutate(restore(row));
  const after = current(store),
    budget = resourceBudget(after, reference);
  assert.deepEqual(after.craftList, before.craftList);
  assert.equal(after.reserveCraftDraft, false);
  assert.deepEqual(after.resourcePriority, before.resourcePriority);
  assert.equal(priorBudget.totals['10216'] || 0, 0);
  assert(budget.totals['10216'] > 0);
});

test('plan and target association protection survives removal and selected restoration in either order', () => {
  const { store } = setup();
  store.mutate({
    type: 'craft-plan-save',
    name: '带目标的计划',
    list: [{ id: 'fusion-1000', quantity: 2 }],
    addGoal: true,
  });
  const plan = current(store).craftPlans[0],
    goal = current(store).goals[0];
  unchanged(store, () => remove(store, plan), /行囊目标/);
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: goal });
  const goalRow = current(store).journeyTrash[0],
    planRow = remove(store, plan);
  unchanged(store, () => store.mutate(restore(goalRow)), /完整目标仍保留/);
  store.mutate(restore(planRow));
  assert.equal(current(store).activeCraftPlanId, undefined);
  assert.equal(current(store).goals.length, 0);
  store.mutate(restore(goalRow));
  assert.deepEqual(current(store).goals[0], goal);
  unchanged(store, () => remove(store, plan), /行囊目标/);
});

test('same-ID conflicts, 40-plan capacity, 5000 retained items and stale purge never overwrite or evict', () => {
  const { store } = setup(),
    plan = withPlan(store),
    row = remove(store, plan);
  withPlan(store, { ...plan, name: '同ID的后来内容' });
  unchanged(store, () => store.mutate(restore(row)), /同一安排已存在/);
  let state = store.get();
  state.profiles[0].craftPlans = Array.from({ length: 40 }, (_, index) => ({
    ...plan,
    id: 'occupied-' + index,
  }));
  store.commit(state);
  unchanged(store, () => store.mutate(restore(row)), /数量已满/);
  unchanged(
    store,
    () =>
      store.mutate({
        type: 'journey-trash-purge',
        id: row.id,
        expectedTrash: { ...row, record: { ...plan, name: '旧预览' } },
      }),
    /已变化/,
  );
  state = store.get();
  state.profiles[0].craftPlans.pop();
  store.commit(state);
  store.mutate(restore(row));
  assert.equal(current(store).craftPlans.length, 40);
  assert.deepEqual(current(store).craftPlans.at(-1), plan);
  state = store.get();
  state.profiles[0].journeyTrash = Array.from({ length: 5000 }, (_, index) => ({
    ...row,
    id: 'retained-' + index,
  }));
  store.commit(state);
  unchanged(store, () => remove(store, plan), /已满/);
  store.mutate({
    type: 'journey-trash-purge',
    id: 'retained-0',
    expectedTrash: current(store).journeyTrash[0],
  });
  assert.equal(current(store).journeyTrash.length, 4999);
  assert.deepEqual(current(store).craftPlans.at(-1), plan);
  remove(store, plan);
  assert.equal(current(store).journeyTrash.length, 5000);
  assert.equal(current(store).journeyTrash[0].id, 'retained-1');
});

test('strict JSON and craft-plan validation refuse accessors, foreign fields and invalid nested values without side effects', () => {
  const plan = rawPlan(),
    row = { id: 'trash-plan', kind: 'craft-plan', record: plan, deletedAt: plan.updatedAt };
  assert.equal(validateJourneyTrash([row])[0], row);
  let reads = 0;
  const getter = clone(plan);
  Object.defineProperty(getter, 'name', {
    enumerable: true,
    get: () => {
      reads++;
      return plan.name;
    },
  });
  for (const record of [
    getter,
    { ...plan, extra: true },
    { ...plan, choices: { 10216: 'fusion-1000' } },
    { ...plan, list: [{ id: 'fusion-1000', quantity: -1 }] },
    { ...plan, done: 'true' },
  ])
    assert.throws(() => validateJourneyTrash([{ ...row, record }]));
  const profile = { craftPlans: [plan], goals: [] },
    before = clone(profile);
  assert.throws(() =>
    applyJourneyTrashCommand(profile, { type: 'craft-plan-remove', id: plan.id, expectedRecord: getter }),
  );
  assert.deepEqual(profile, before);
  assert.equal(reads, 0);
  const legacy = applyJourneyTrashCommand(profile, { type: 'craft-plan-remove', id: plan.id });
  assert.deepEqual(legacy.trash[0].record, plan);
  assert.deepEqual(legacy.craftPlans, []);
});

test('full plans travel through JSON, protection history and startup recovery with original files retained', async () => {
  const { root, store } = setup(),
    plan = withPlan(store),
    row = remove(store, plan);
  const raw = fs.readFileSync(store.file),
    receiving = new Store(path.join(root, 'receiver'), catalog);
  receiving.importData(JSON.parse(raw));
  assert.deepEqual(current(receiving).journeyTrash, [row]);
  const file = path.join(root, 'plans.yijian-protection');
  await migration.exportProtection({ dataRoot: path.dirname(store.file), file });
  const archives = new ProtectionArchives(path.dirname(receiving.file), () => ''),
    imported = await archives.import(file),
    history = await archives.history(imported.id, receiving);
  assert(history.readOnly);
  assert.deepEqual(history.journal.profiles[0].journeyTrash, [row]);
  for (const type of ['json', 'protection']) {
    const data = path.join(root, 'recovery-' + type);
    fs.mkdirSync(data);
    const original = ['synthetic damaged current\n', '{ synthetic damaged previous }'];
    ['journal.json', 'journal.json.previous'].forEach((name, index) =>
      fs.writeFileSync(path.join(data, name), original[index]),
    );
    const recovery = new StartupRecovery(data, catalog),
      preview = await recovery.preview(type, type === 'json' ? store.file : file);
    assert.equal(preview.profiles[0].removedArrangements, 1);
    const result = await recovery.confirm(preview.token),
      recovered = new Store(data, catalog);
    assert.deepEqual(current(recovered).journeyTrash, [row]);
    ['journal.json', 'journal.json.previous'].forEach((name, index) =>
      assert.equal(fs.readFileSync(path.join(result.retainedDirectory, name), 'utf8'), original[index]),
    );
    recovered.mutate(restore(row));
    assert.deepEqual(current(recovered).craftPlans, [plan]);
    assert.equal(current(recovered).activeCraftPlanId, undefined);
  }
  assert.deepEqual(fs.readFileSync(store.file), raw);
});
