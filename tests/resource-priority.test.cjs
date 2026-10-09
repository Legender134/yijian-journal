'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { allocate } = require('../src/core/material-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const {
  resourcePriorityPreview,
  priorityFingerprint,
  validateResourcePriority,
} = require('../src/core/resource-priority.cjs');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const stamp = '2026-10-09T00:00:00.000Z';
const plan = (id) => ({
  id,
  name: id,
  list: [{ id: 'fusion-1000', quantity: 1 }],
  reserved: true,
  createdAt: stamp,
  updatedAt: stamp,
});
const profile = () => ({
  id: 'synthetic-profile',
  referenceMode: 'latest',
  goals: [],
  craftPlans: [plan('a'), plan('b')],
  craftList: plan('a').list,
  activeCraftPlanId: 'a',
});
const reference = () => ({
  name: 'Synthetic.sav',
  hash: 'a'.repeat(64),
  modifiedAt: stamp,
  metadata: {
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ],
    fusionRecipes: [1000],
    money: 100000,
  },
});
const total = (budget, id) =>
  budget.crafts
    .find((c) => c.id === id)
    .materials.reduce((n, m) => n + m.allocation.reduce((s, a) => s + a.count, 0), 0);
test('explicit priority remains stable when another plan becomes the editor and preview names every transferred physical item', () => {
  const p = { ...profile(), resourcePriority: ['a', 'b'] },
    ref = reference(),
    original = structuredClone(p);
  assert.equal(total(resourceBudget(p, ref), 'a'), 5);
  const openedB = { ...p, activeCraftPlanId: 'b', craftList: plan('b').list };
  assert.equal(total(resourceBudget(openedB, ref), 'a'), 5);
  assert.equal(total(resourceBudget(openedB, ref), 'b'), 0);
  const preview = resourcePriorityPreview(openedB, ref, ['b', 'a']);
  assert.equal(
    preview.changes.find((o) => o.id === 'a').items.reduce((n, a) => n + a.beforeDirect - a.afterDirect, 0),
    5,
  );
  assert.equal(
    preview.changes.find((o) => o.id === 'b').items.reduce((n, a) => n + a.afterDirect - a.beforeDirect, 0),
    5,
  );
  assert.deepEqual(preview.beforePhysicalUsed, preview.afterPhysicalUsed);
  assert.deepEqual(p, original);
  assert.notEqual(
    priorityFingerprint(openedB, ref),
    priorityFingerprint(openedB, { ...ref, hash: 'b'.repeat(64) }),
  );
});
test('priority preserves residual substitution and grants an earlier owner without greedy starvation of a fixed later demand', () => {
  const groups = [
    { ids: [10525, 10526], count: 1 },
    { ids: [10525], count: 1 },
  ];
  const result = allocate(
    groups,
    new Map([
      [10525, 1],
      [10526, 1],
    ]),
    { priorities: [0, 1] },
  );
  assert.deepEqual(
    result.map((g) => g.reduce((n, a) => n + a.count, 0)),
    [1, 1],
  );
  assert.equal(result[0][0].id, 10526);
  assert.equal(result[1][0].id, 10525);
  assert.deepEqual(
    allocate(
      [
        { ids: [10525], count: 3 },
        { ids: [10525], count: 3 },
      ],
      new Map([[10525, 4]]),
      { priorities: [1, 0] },
    ).map((g) => g.reduce((n, a) => n + a.count, 0)),
    [1, 3],
  );
});
test('manual and task reservations remain protected and unknown inventory is not a zero grant', () => {
  const p = {
      ...profile(),
      reservations: { 10246: 1 },
      resourcePriority: ['b', 'a'],
      allocations: [{ questId: 'quest-11010', items: { 10216: 2 } }],
    },
    ref = reference();
  const preview = resourcePriorityPreview(p, ref, ['a', 'b']);
  for (const row of preview.changes) assert.equal(row.items.find((i) => i.id === 10246)?.afterDirect || 0, 0);
  assert.equal(preview.afterPhysicalUsed[10246], 1);
  assert.equal(resourceBudget(p, ref).owners[0].itemAllocations.find((i) => i.id === 10216).allocated, 2);
  assert.equal(
    preview.changes.reduce((n, row) => n + (row.items.find((i) => i.id === 10216)?.afterDirect || 0), 0),
    1,
  );
  assert.equal(preview.afterPhysicalUsed[10216], 3);
  const unknown = resourcePriorityPreview(p, { ...ref, metadata: { fusionRecipes: [1000] } }, ['a', 'b']);
  assert.equal(unknown.inventoryAvailable, false);
  assert.equal(unknown.afterMissingTotal, null);
  assert(unknown.changes.every((row) => row.afterMissing.every((m) => m.count === null)));
});
test('processing impact is included while projected products do not become another owner physical stock', () => {
  const p = { ...profile(), resourcePriority: ['a', 'b'] },
    ref = reference();
  ref.metadata.inventory = [
    { id: 10201, count: 3 },
    { id: 10246, count: 1 },
    { id: 10205, count: 4 },
  ];
  const preview = resourcePriorityPreview(p, ref, ['b', 'a']);
  assert(preview.changes.some((row) => row.items.some((i) => i.beforeProcessing !== i.afterProcessing)));
  for (const physical of [preview.beforePhysicalUsed, preview.afterPhysicalUsed])
    for (const [id, count] of Object.entries(physical))
      assert(count <= ref.metadata.inventory.find((i) => i.id === Number(id)).count);
  assert.equal(preview.afterPhysicalUsed[10216], undefined);
});
test('priority commands require the fresh main-process preview, persist across restart, and stay within their profile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-priority-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog),
    data = store.get();
  Object.assign(data.profiles[0], profile(), { id: data.activeProfileId });
  store.commit(data);
  const p = store.get().profiles[0],
    fingerprint = priorityFingerprint(p, reference());
  const command = { type: 'resource-priority-set', profileId: p.id, order: ['b', 'a'], fingerprint };
  assert.throws(() => store.mutate(command), /预览/);
  store.mutate(command, { resourcePriorityFingerprint: fingerprint });
  assert.deepEqual(new Store(dir, catalog).get().profiles[0].resourcePriority, ['b', 'a']);
  store.mutate({ type: 'profile-add', name: 'another synthetic playthrough' });
  assert.equal(
    store.get().profiles.find((x) => x.id === store.get().activeProfileId).resourcePriority,
    undefined,
  );
});
test('invalid or foreign owners and duplicates are rejected before computing a proposed budget', () => {
  for (const bad of [['a', 'a'], ['../bad'], Array(143).fill('@draft'), ['@gift:']])
    assert.throws(() => validateResourcePriority(bad));
  assert.throws(() => resourcePriorityPreview(profile(), reference(), ['foreign', 'a']), /用途已变化/);
  assert.deepEqual(resourcePriorityPreview(profile(), reference(), []).order, []);
});
