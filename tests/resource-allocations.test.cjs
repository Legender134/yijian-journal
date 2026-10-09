'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { allocationSummary } = require('../src/core/resource-allocations.cjs');
const { availableInventory } = require('../src/core/reservations.cjs');
const world = require('../src/data/world-index.json');
const catalog = require('../src/data/catalog.cjs');
const candidates = world.quests.filter((q) => q.materials?.some((m) => m.id === 10201));
const first = candidates.find((q) => q.materials.find((m) => m.id === 10201).count === 4);
const second = candidates.find((q) => q.materials.find((m) => m.id === 10201).count === 5);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-allocations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(dir, catalog) };
}
test('independent tasks add their demands, repeat clicks are idempotent and manual stock remains separate', (t) => {
  const { store } = setup(t);
  for (const q of [first, second, first]) store.mutate({ type: 'task-reserve', questId: q.id, itemId: '10201' });
  store.mutate({ type: 'reserve-set', id: '10201', count: 2 });
  const p = store.get().profiles[0];
  assert.equal(p.allocations.length, 2);
  const summary = allocationSummary(p, null);
  assert.equal(summary.totals['10201'], 11);
  assert.equal(summary.manual['10201'], 2);
  assert.deepEqual(availableInventory([{ id: 10201, count: 10 }, { id: 10201, count: 5 }], summary.totals)
    .map((i) => i.count), [0, 4]);
});
test('completed tasks stop consuming shared stock, historical and unknown progress retain claims without deleting them', (t) => {
  const { store } = setup(t);
  for (const q of [first, second]) store.mutate({ type: 'task-reserve', questId: q.id, itemId: '10201' });
  const p = store.get().profiles[0], before = JSON.stringify(p);
  const ref = { name: '1.sav', hash: 'test', modifiedAt: '2026-10-07T00:00:00Z',
    metadata: { quests: [{ id: first.gameId, step: 4 }, { id: second.gameId, step: 1 }] } };
  assert.equal(allocationSummary(p, ref).totals['10201'], 5);
  assert.equal(allocationSummary(p, ref).owners[0].complete, true);
  assert.equal(allocationSummary(p, ref, '读取失败').totals['10201'], 9);
  assert.equal(allocationSummary(p, { ...ref, metadata: { quests: [{ id: first.gameId, step: 1 }] } }).totals['10201'], 9);
  assert.equal(allocationSummary(p, { ...ref, metadata: {} }).totals['10201'], 9);
  assert.equal(allocationSummary({ ...p, referenceMode: 'none' }, ref).totals['10201'], 9);
  assert.equal(allocationSummary({ ...p, referenceMode: 'slot', saveSlot: '2.sav' }, ref).totals['10201'], 9);
  assert.equal(JSON.stringify(p), before);
});
test('owned claims can be edited/released, survive reload and imports, and never cross profiles', (t) => {
  const { dir, store } = setup(t);
  store.mutate({ type: 'task-reserve', questId: first.id, itemId: '10201' });
  store.mutate({ type: 'task-reserve-edit', questId: first.id, itemId: '10201', count: 3 });
  assert.equal(new Store(dir, catalog).get().profiles[0].allocations[0].items['10201'], 3);
  store.importData(store.get());
  const firstProfile = store.get().activeProfileId;
  store.mutate({ type: 'profile-add', name: '新周目' });
  assert.throws(() => store.mutate({ type: 'task-reserve-edit', questId: first.id, itemId: '10201', count: 2 }));
  store.mutate({ type: 'profile-switch', id: firstProfile });
  store.mutate({ type: 'task-reserve-remove', questId: first.id });
  assert.equal(store.get().profiles[0].allocations.length, 0);
});
test('invalid owners, unknown materials and impossible aggregate budgets fail atomically', (t) => {
  const { store } = setup(t);
  const before = store.get();
  assert.throws(() => store.mutate({ type: 'task-reserve', questId: first.id, itemId: '999999999' }));
  assert.throws(() => store.mutate({ type: 'task-reserve', questId: '../bad', itemId: '10201' }));
  assert.deepEqual(store.get(), before);
  store.mutate({ type: 'reserve-set', id: '10201', count: 999999 });
  assert.throws(() => store.mutate({ type: 'task-reserve', questId: first.id, itemId: '10201' }));
  assert.equal(store.get().profiles[0].allocations, undefined);
});
