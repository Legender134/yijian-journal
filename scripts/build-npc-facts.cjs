'use strict';
// Offline projection of the same-build NPC private-item tables. No game or save access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const tableHashes = {
  'NPCs.uexp': '0c3dcfdb36901efc70d65446064c5a97d44c1629d1e2cf418eb586ff3c131ec3',
  'DropPools.uexp': 'e43eb18bba381dfb574c96fdde6afefd868951935838c7f2bb3216297602e76a',
};
function projectNpcFacts(npcs, pools, world, itemIds) {
  assert.equal(String(world.build), '21798996');
  const expected = new Set(world.people.filter((e) => e.functions.includes('Compare')).map((e) => e.gameId));
  const people = {},
    usedPools = {};
  const poolById = new Map(pools.map((pool) => [pool.Id, pool]));
  assert.equal(poolById.size, pools.length, 'Duplicate random-pool identity');
  const positiveInteger = (n) => Number.isSafeInteger(n) && n > 0;
  for (const npc of npcs) {
    assert(expected.has(npc.Id) && !people[npc.Id], 'Unknown or duplicate NPC identity');
    assert(Number.isFinite(npc.Level) && npc.Level > 0, 'Invalid template level');
    const fixedItems = npc.ItemList.map((item) => {
      assert(itemIds.has(item.Id) && positiveInteger(item.Value), 'Invalid initial private item');
      return { id: item.Id, count: item.Value };
    });
    // Preserve repeated source rows; presentation can label their recorded total.
    const randomItems = npc.ItemListPools.map((entry) => {
      const pool = poolById.get(entry.DropPoolId);
      assert(pool && positiveInteger(entry.Count), 'Unresolved initial random pool');
      const candidates = pool.DropWeights.map((item) => {
        assert(
          itemIds.has(item.ItemDefId) && Number.isFinite(item.Weight) && item.Weight > 0,
          'Invalid initial random candidate',
        );
        return item.ItemDefId;
      });
      assert(
        candidates.length && new Set(candidates).size === candidates.length,
        'Empty or duplicate random candidates',
      );
      usedPools[entry.DropPoolId] = candidates;
      return { poolId: entry.DropPoolId, count: entry.Count };
    });
    people[npc.Id] = { level: npc.Level, fixedItems, randomItems };
  }
  assert.equal(Object.keys(people).length, expected.size, 'Incomplete known Compare NPC coverage');
  return {
    schema: 1,
    build: String(world.build),
    source: '同版本NPC初始私物与随机池资料表',
    notice:
      '仅为人物初始模板线索；剧情、难度与当前状态可能改变等级、私物和交互。随机池列候选，不表示同时持有或比武奖励概率。请先在游戏中观察当前人物。',
    provenance: {
      rawTableHashes: tableHashes,
      scope: 'NPC Level, ItemList and ItemListPools; private items only, equipped gear excluded',
    },
    people,
    pools: usedPools,
  };
}
module.exports = { projectNpcFacts };
if (require.main === module) {
  const [npcFile, poolFile, rawDirectory] = process.argv.slice(2);
  assert(
    npcFile && poolFile && rawDirectory,
    'Usage: node scripts/build-npc-facts.cjs npc-export.json pools-export.json raw-table-directory',
  );
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  for (const [name, expected] of Object.entries(tableHashes))
    assert.equal(sha(fs.readFileSync(path.join(rawDirectory, name))), expected, 'Same-build source ' + name);
  const root = path.resolve(__dirname, '..');
  const bytes = [npcFile, poolFile].map((file) => fs.readFileSync(file));
  const [npcs, pools] = bytes.map((value) => JSON.parse(value.toString('utf8').replace(/^\uFEFF/, '')));
  const world = require('../src/data/world-index.json');
  const itemIds = new Set(
    require('../src/data/game-index.json')
      .entries.filter((e) => e.kind === '物品')
      .map((e) => e.gameId),
  );
  const data = projectNpcFacts(npcs, pools, world, itemIds);
  data.provenance.exportHashes = { npcs: sha(bytes[0]), pools: sha(bytes[1]) };
  fs.writeFileSync(path.join(root, 'src/data/npc-facts.json'), JSON.stringify(data) + '\n');
  console.log(
    JSON.stringify({ people: Object.keys(data.people).length, randomPools: Object.keys(data.pools).length }),
  );
}
