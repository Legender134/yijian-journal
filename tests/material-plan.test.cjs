'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { materialPlan, allocate, validateCraftList } = require('../src/core/material-plan.cjs');
const { Store } = require('../src/core/store.cjs');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const catalog = require('../src/data/catalog.cjs');
const recipes = require('../src/data/game-index.json').entries.filter((e) => e.kind === '配方');
test('combined recipe demands share one finite inventory and sum actual crafting fees', () => {
  const a = recipes.find((e) => e.materials.every((m) => !m.alternatives));
  const b = recipes.find(
    (e) => e.id !== a.id && e.materials.some((m) => a.materials.some((n) => n.id === m.id)),
  );
  const stock = a.materials.map((m) => ({ id: m.id, count: m.count }));
  const input = [
    { id: a.id, quantity: 2 },
    { id: b.id, quantity: 3 },
  ];
  const original = JSON.stringify({ input, stock });
  const p = materialPlan(input, { inventory: stock, money: 1, fusionRecipes: [a.gameId] });
  assert.equal(p.money, a.money * 2 + b.money * 3);
  const shared = p.materials.find((m) => m.ids.includes(a.materials[0].id));
  assert(shared.count >= a.materials[0].count * 2);
  assert(shared.allocated <= a.materials[0].count);
  assert(p.missing > 0);
  assert.equal(p.recipes[0].learned, true);
  assert.equal(JSON.stringify({ input, stock }), original);
});
test('residual allocation preserves fixed ingredients while allowing interchangeable stock', () => {
  const groups = [
    { ids: [1, 2], count: 1 },
    { ids: [1], count: 1 },
  ];
  const allocations = allocate(
    groups,
    new Map([
      [1, 1],
      [2, 1],
    ]),
  );
  assert.deepEqual(
    allocations.map((a) => a.map((x) => x.id)),
    [[2], [1]],
  );
});
test('ingredient allocation reaches the exhaustive optimum and never spends a unit twice', () => {
  const brute = (demands, stock) => {
    const units = demands.flatMap((g) => Array.from({ length: g.count }, () => g.ids));
    const visit = (i, left) =>
      i === units.length
        ? 0
        : Math.max(
            visit(i + 1, left),
            ...units[i]
              .filter((id) => left[id] > 0)
              .map((id) => visit(i + 1, { ...left, [id]: left[id] - 1 }) + 1),
          );
    return visit(0, stock);
  };
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++)
      for (let x = 0; x < 3; x++)
        for (let y = 0; y < 3; y++)
          for (let z = 0; z < 3; z++) {
            const groups = [
              { ids: [1, 2], count: x },
              { ids: [1], count: y },
              { ids: [2], count: z },
            ];
            const result = allocate(
              groups,
              new Map([
                [1, a],
                [2, b],
              ]),
            );
            assert.equal(
              result.flat().reduce((s, r) => s + r.count, 0),
              brute(groups, { 1: a, 2: b }),
            );
            for (const [id, count] of [
              [1, a],
              [2, b],
            ])
              assert(
                result
                  .flat()
                  .filter((r) => r.id === id)
                  .reduce((s, r) => s + r.count, 0) <= count,
              );
            result.forEach((rows, i) => assert(rows.reduce((s, r) => s + r.count, 0) <= groups[i].count));
          }
});
test('unread inventory and recipe learning remain unknown while empty arrays mean zero', () => {
  const list = [{ id: recipes[0].id, quantity: 1 }];
  assert.equal(materialPlan(list).missing, null);
  assert.equal(materialPlan(list).recipes[0].learned, null);
  assert(materialPlan(list, { inventory: [] }).missing > 0);
  assert.equal(materialPlan(list, { inventory: [], fusionRecipes: [] }).recipes[0].learned, false);
  assert.equal(materialPlan([], { inventory: [] }).missing, 0);
});
test('craft input is bounded, validates identities and refuses unsafe inventory aggregation', () => {
  for (const list of [
    null,
    [{ id: 'item-100', quantity: 1 }],
    [{ id: recipes[0].id, quantity: 0 }],
    [{ id: recipes[0].id, quantity: 1.5 }],
    [{ id: recipes[0].id, quantity: 1000 }],
    [{ id: recipes[0].id, quantity: 1, arbitrary: true }],
    [
      { id: recipes[0].id, quantity: 1 },
      { id: recipes[0].id, quantity: 2 },
    ],
  ])
    assert.throws(() => validateCraftList(list));
  assert.throws(() => validateCraftList(recipes.slice(0, 41).map((e) => ({ id: e.id, quantity: 1 }))));
  assert.throws(() => materialPlan([], { inventory: [{ id: 1, count: -1 }] }));
});
test('old journals remain compatible and per-profile craft state survives restart/import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-crafts-'));
  const s = new Store(dir, catalog),
    originalProfile = s.get().activeProfileId;
  assert.equal(s.get().profiles[0].craftList, undefined);
  s.mutate({ type: 'craft-set', id: recipes[0].id, quantity: 4 });
  const before = s.get();
  assert.throws(() => s.mutate({ type: 'craft-set', id: recipes[0].id, quantity: 1000 }));
  assert.deepEqual(s.get(), before);
  s.mutate({ type: 'profile-add', name: '第二程' });
  assert.equal(s.get().profiles.find((p) => p.id === s.get().activeProfileId).craftList, undefined);
  s.mutate({ type: 'craft-set', profileId: originalProfile, id: recipes[0].id, quantity: 5 });
  const restarted = new Store(dir, catalog);
  assert.equal(restarted.get().profiles.find((p) => p.id === originalProfile).craftList[0].quantity, 5);
  const imported = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-craft-import-')), catalog);
  imported.importData(restarted.get());
  assert.equal(imported.get().profiles.find((p) => p.id === originalProfile).craftList[0].quantity, 5);
  imported.mutate({ type: 'goal-add', title: '继续武当求助', source: { type: 'quest', id: 'quest-5200' } });
  assert.throws(() =>
    imported.mutate({
      type: 'goal-add',
      title: '未知任务',
      source: { type: 'quest', id: 'quest-999999999' },
    }),
  );
});
