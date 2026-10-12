'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectNpcFacts } = require('../scripts/build-npc-facts.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const source = require('../src/data/npc-facts.json');
const world = require('../src/data/world-index.json');
function fixture() {
  return {
    npcs: [
      {
        Id: 1,
        Level: 5,
        ItemList: [
          { Id: 9, Value: 2 },
          { Id: 9, Value: 1 },
        ],
        ItemListPools: [{ DropPoolId: 7, Count: 2 }],
      },
    ],
    pools: [
      {
        Id: 7,
        DropWeights: [
          { ItemDefId: 10, Weight: 3 },
          { ItemDefId: 11, Weight: 1 },
        ],
      },
    ],
    world: {
      build: '21798996',
      people: [
        { gameId: 1, functions: ['Compare'] },
        { gameId: 2, functions: ['Talk'] },
      ],
    },
    items: new Set([9, 10, 11]),
  };
}
const project = (f) => projectNpcFacts(f.npcs, f.pools, f.world, f.items);
test('private-item projection preserves source rows and separates fixed quantities from random candidates', () => {
  const f = fixture(),
    before = structuredClone(f);
  const data = project(f);
  assert.deepEqual(data.people[1].fixedItems, [
    { id: 9, count: 2 },
    { id: 9, count: 1 },
  ]);
  assert.deepEqual(data.people[1].randomItems, [{ poolId: 7, count: 2 }]);
  assert.deepEqual(data.pools[7], [10, 11]);
  assert.equal(data.people[2], undefined);
  assert.deepEqual(f, before);
  assert.match(data.notice, /不表示同时持有或比武奖励概率/);
});
test('projection refuses inconsistent versions, incomplete identity coverage, unknown items and invalid random pools', () => {
  for (const change of [
    (f) => (f.world.build = 'foreign'),
    (f) => f.npcs.push(structuredClone(f.npcs[0])),
    (f) => f.world.people.push({ gameId: 3, functions: ['Compare'] }),
    (f) => (f.npcs[0].ItemList[0].Id = 99),
    (f) => (f.npcs[0].ItemList[0].Value = -2),
    (f) => (f.npcs[0].Level = NaN),
    (f) => (f.npcs[0].ItemListPools[0].DropPoolId = 99),
    (f) => (f.pools[0].DropWeights[0].ItemDefId = 99),
    (f) => (f.pools[0].DropWeights[0].Weight = 0),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => project(f));
  }
});
test('shipped static facts cover every known Compare template and retain verified important items without mutating base data', () => {
  const before = structuredClone(world),
    index = encyclopedia();
  assert.equal(source.build, index.build);
  assert.equal(Object.keys(source.people).length, 252);
  assert.equal(
    Object.values(source.people).reduce((sum, row) => sum + row.fixedItems.length, 0),
    1301,
  );
  assert.deepEqual(
    new Set(Object.keys(source.people).map(Number)),
    new Set(world.people.filter((e) => e.functions.includes('Compare')).map((e) => e.gameId)),
  );
  const ids = new Set(index.entries.filter((e) => e.kind === '物品').map((e) => e.gameId));
  for (const facts of Object.values(source.people)) {
    for (const item of facts.fixedItems)
      assert(ids.has(item.id) && Number.isSafeInteger(item.count) && item.count > 0);
    for (const pool of facts.randomItems) assert(source.pools[pool.poolId]?.every((id) => ids.has(id)));
  }
  const qin = index.entries.find((e) => e.id === 'npc-10023');
  assert.equal(qin.npcFacts.level, 35);
  assert.deepEqual(
    qin.npcFacts.fixedItems.find((item) => item.id === 100312),
    { id: 100312, count: 1 },
  );
  const jiang = index.entries.find((e) => e.id === 'npc-10016');
  assert.equal(jiang.npcFacts.level, 75);
  assert.deepEqual(
    jiang.npcFacts.fixedItems.find((item) => item.id === 1008),
    { id: 1008, count: 1 },
  );
  assert.deepEqual(world, before);
});
