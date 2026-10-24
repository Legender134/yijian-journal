'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  BUILD,
  FILES,
  buildItemStats,
  projectAction,
  readInputs,
} = require('../scripts/build-item-stats.cjs');
const stats = require('../src/data/item-stats.json');
const gameIndex = require('../src/data/game-index.json');

function fixture() {
  const entries = [
    { gameId: 100, kind: '物品', name: '合成剑', typeKey: 'Sword' },
    { gameId: 101, kind: '物品', name: '合成药', typeKey: 'Drug_Stamina' },
    { gameId: 102, kind: '物品', name: '合成材料', typeKey: 'Mineral' },
  ];
  const action = (id, value, type = 'CAttr') => ({ Type: `EActionType::${type}`, Id: id, Num: value });
  const items = entries.map((e) => ({
    Id: e.gameId,
    Name: e.name,
    ItemType: `EItemSubType::${e.typeKey}`,
    EquipmentRank: 0,
    bCantUse: e.gameId === 102,
    Actions: [],
    Requirements: [],
    RandActionPools: [],
    RandRange: [],
    NormalRandActionPools: [],
    NormalRandRange: [],
  }));
  items[0].Actions = [action(9, 100), action(10, 15)];
  items[0].RandActionPools = [700];
  items[0].RandRange = [4, 5];
  items[0].Requirements = [{ Type: 'ERequirementType::OnlyDesignatedNPC', Id: 5015, Num: 1 }];
  items[1].Actions = [action(1, 400, 'CAllAttr'), action(0, 50, 'AJingMaiPoint')];
  return {
    gameIndex: { build: BUILD, entries },
    items,
    pools: [
      {
        Id: 700,
        ActionWeights: [
          { Weight: 2, Action: action(9, 20) },
          { Weight: 1, Action: action(100050, 3, 'ABuff') },
        ],
      },
    ],
    buffs: [
      {
        id: '100050',
        ViewName: '合成增益',
        Description: '获得效果{0}',
        ModifierValue: 180,
        ModifierValue1: 190,
        ModifierValue2: 200,
        ModifierValue3: 210,
        ModifierValue4: 0,
        ModifierValue5: 0,
        ModifierValue6: 0,
        ModifierValue7: 0,
        ModifierValue8: 0,
        ModifierValue9: 0,
        Duration1: 0,
        Duration4: 0,
        Duration7: 0,
        Duration10: 0,
        Period: 0,
        Chance: 1,
        StackLimit: 1,
      },
    ],
    formats: [
      {
        ActionType: 'EActionType::CAttr',
        ActionId: 10,
        NumberType: 'EJHNeoUIAffixDisplayNumberType::Percent_Decimal_2',
      },
    ],
    attributes: [
      { Id: 1, Key: 'Health' },
      { Id: 9, Key: 'AttackPower' },
      { Id: 10, Key: 'Crit' },
      { Id: 68, Key: 'GatheringExp' },
    ],
    provenance: {
      schema: 1,
      build: BUILD,
      source: { kind: 'owned-installed-game-static-tables' },
      attributeEnumSource: { sha256: 'a'.repeat(64) },
      tables: Object.fromEntries(Object.values(FILES).map((file) => [file, 'b'.repeat(64)])),
      tools: [],
    },
  };
}

test('same-build item statistics cover exactly the encyclopedia items, with genuine empty materials', () => {
  const ids = gameIndex.entries
    .filter((e) => e.kind === '物品')
    .map((e) => e.gameId)
    .sort((a, b) => a - b);
  assert.equal(stats.build, gameIndex.build);
  assert.deepEqual(Object.keys(stats.items).map(Number), ids);
  assert.equal(ids.length, 1629);
  const equipment = gameIndex.entries.filter((e) =>
    ['Sword', 'Sabre', 'Spear', 'Fist', 'HiddenWeapon', 'Hat', 'Shoes', 'Ornament', 'Clothing'].includes(
      e.typeKey,
    ),
  );
  assert.equal(equipment.length, 399);
  assert.ok(equipment.every((e) => stats.items[e.gameId].effects.length));
  assert.deepEqual(stats.items[10220].effects, []); // 银锭 has no fabricated combat benefit.
  assert.deepEqual(stats.items[10220].random, []);
  assert.equal(stats.items[99], undefined);
});

test('official fixed weapon and armor values remain separate from random candidates', () => {
  assert.equal(stats.items[1029].effects[0].value, 637.892578125);
  assert.deepEqual(stats.items[1029].effects[1], { type: 'CAttr', id: 10, value: 15 });
  assert.equal(stats.items[9000].effects[0].id, 11);
  assert.ok(Math.abs(stats.items[9000].effects[0].value - 28.911999) < 0.000001);
  assert.equal(stats.items[8000].effects[0].id, 14);
  assert.equal(stats.items[8000].effects[0].value, 20);
  assert.equal(stats.attributes[51].key, 'Accuracy');
  assert.equal(stats.attributes[51].name, '命中');
});

test('attribute formats distinguish percent points, fractional percentages and unverified parameters', () => {
  assert.deepEqual([stats.attributes[10].unit, stats.attributes[10].scale], ['%', 1]);
  assert.deepEqual([stats.attributes[60].unit, stats.attributes[60].scale], ['%', 100]);
  assert.deepEqual([stats.attributes[53].unit, stats.attributes[53].scale], ['%', 100]);
  assert.equal(stats.attributes[58].unit, '原始参数');
  assert.equal(stats.attributes[58].scale, 1);
  const input = fixture();
  input.items[0].Actions.push({ Type: 'EActionType::CAttr', Id: 777, Num: 12.5 });
  input.attributes.push({ Id: 777, Key: 'FutureParameter' });
  const future = buildItemStats(input).attributes[777];
  assert.equal(future.unit, '原始参数');
  assert.match(future.name, /777.*FutureParameter/);
});

test('recovery medicines, permanent elixirs and meridian points keep their distinct actions', () => {
  assert.deepEqual(stats.items[100].effects, [{ type: 'CAttr', id: 2, value: 10 }]);
  assert.deepEqual(stats.items[101].effects, [{ type: 'CAttr', id: 4, value: 10 }]);
  assert.deepEqual(stats.items[133].effects, [{ type: 'CAllAttr', id: 1, value: 400 }]);
  assert.deepEqual(stats.items[139].effects, [{ type: 'AJingMaiPoint', id: 0, value: 50 }]);
  assert.equal(stats.items[250].effects.find((e) => e.type === 'CHealthAttrPercent').value, 20);
});

test('random pools preserve weights and raw ranges without claiming drop rates or resolved buff ranks', () => {
  const out = buildItemStats(fixture());
  assert.deepEqual(out.items[100].random, [{ source: 'RandActionPools', poolIds: [700], range: [4, 5] }]);
  assert.deepEqual(out.pools[700].candidates[0], { type: 'CAttr', id: 9, value: 20, weight: 2 });
  assert.equal(out.items[100].effects[0].value, 100);
  assert.equal(out.pools[700].candidates[1].value, 3);
  assert.equal(out.buffs[100050].description, '获得效果{0}');
  assert.deepEqual(out.buffs[100050].modifiers.slice(0, 4), [180, 190, 200, 210]);
  assert.equal(out.pools[700].candidates[0].probability, undefined);
  assert.deepEqual(stats.pools[8094], { candidates: [], unresolved: true });
});

test('all referenced shared data resolves or carries the explicit source-table gap', () => {
  for (const item of Object.values(stats.items)) {
    for (const random of item.random) for (const id of random.poolIds) assert.ok(stats.pools[id]);
  }
  const actions = [
    ...Object.values(stats.items).flatMap((i) => i.effects),
    ...Object.values(stats.pools).flatMap((p) => p.candidates),
  ];
  for (const action of actions) {
    if (['CAttr', 'CAllAttr', 'CHealthAttrPercent', 'CBlueAttrPercent'].includes(action.type))
      assert.ok(stats.attributes[action.id]);
    if (['ABuff', 'ABattleCountBuff', 'ARealTimeBuff'].includes(action.type))
      assert.ok(stats.buffs[action.id]);
    assert.ok(Number.isFinite(action.value));
  }
  assert.equal(Object.values(stats.pools).filter((p) => p.unresolved).length, 1);
});

test('pure projection is deterministic, does not mutate inputs and retains restrictions', () => {
  const input = fixture(),
    before = structuredClone(input);
  const one = buildItemStats(input);
  assert.deepEqual(input, before);
  input.items.reverse();
  input.attributes.reverse();
  input.gameIndex.entries.reverse();
  assert.equal(JSON.stringify(one), JSON.stringify(buildItemStats(input)));
  assert.deepEqual(one.items[100].requirements, [{ type: 'OnlyDesignatedNPC', id: 5015, value: 1 }]);
  assert.deepEqual(one.items[102].effects, []);
  assert.equal(one.items[102].usable, false);
});

test('build mismatches, identity drift and malformed numbers fail before projection', () => {
  let input = fixture();
  input.provenance.build = 'older';
  assert.throws(() => buildItemStats(input), /same-build/);
  input = fixture();
  input.items[0].Name = '另一个物品';
  assert.throws(() => buildItemStats(input), /source mismatch/);
  input = fixture();
  input.pools[0].ActionWeights[0].Weight = -1;
  assert.throws(() => buildItemStats(input), /pool weight/);
  assert.throws(() => projectAction({ Type: 'EActionType::CAttr', Id: 9, Num: NaN }), /action value/);
  assert.throws(() => projectAction({ Type: 'EActionType::CAttr', Id: 9, Num: null }), /action value/);
});

test('on-disk input hashes must match the explicit static provenance manifest', (t) => {
  const input = fixture(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-item-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [key, file] of Object.entries(FILES)) {
    const text = JSON.stringify(input[key]);
    fs.writeFileSync(path.join(dir, file), text);
    input.provenance.tables[file] = crypto.createHash('sha256').update(text).digest('hex');
  }
  fs.writeFileSync(path.join(dir, 'source-manifest.json'), JSON.stringify(input.provenance));
  assert.deepEqual(readInputs(dir, input.gameIndex).items, input.items);
  fs.writeFileSync(path.join(dir, FILES.items), '[]');
  assert.throws(() => readInputs(dir, input.gameIndex), /input hash mismatch/);
});

test('ordinary item sale flags require a strictly true source boolean', () => {
  const input = fixture();
  input.items[0].bCantSell = true;
  input.items[1].bCantSell = false;
  input.items[2].bCantSell = 'true';
  const projected = buildItemStats(input);
  assert.equal(projected.items[100].cantSell, true);
  assert.equal(Object.hasOwn(projected.items[101], 'cantSell'), false);
  assert.equal(Object.hasOwn(projected.items[102], 'cantSell'), false);
  delete input.items[0].bCantSell;
  assert.equal(Object.hasOwn(buildItemStats(input).items[100], 'cantSell'), false);
});

test('published sale restrictions retain actual prohibited items without changing their price facts', () => {
  for (const [id, sellPrice] of [
    [8065, 462.7598876953125],
    [247, 1437.8721923828125],
    [10041, 1],
    [10070, 100],
    [10347, 1000],
    [10501, 60],
  ]) {
    assert.equal(stats.items[id].cantSell, true);
    assert.equal(gameIndex.entries.find((entry) => entry.id === 'item-' + id).sellPrice, sellPrice);
  }
  for (const id of [100, 1029]) assert.equal(Object.hasOwn(stats.items[id], 'cantSell'), false);
  const restricted = Object.values(stats.items).filter((item) => Object.hasOwn(item, 'cantSell'));
  assert.equal(restricted.length, 287);
  assert.ok(restricted.every((item) => item.cantSell === true));
  for (const id of [
    10041, 10070, 10347, 10348, 10354, 10358, 10360, 10361, 10362, 10363, 10364, 10365, 10366, 10372, 10374,
    10375, 10501,
  ])
    assert.equal(stats.items[id].cantSell, true, `native QuestItem restriction ${id}`);
});

test('the native QuestItem category independently prohibits sale even without a true flag', () => {
  for (const flag of [false, undefined, null, 0, 'true']) {
    const input = fixture();
    input.gameIndex.entries[0].typeKey = 'QuestItem';
    input.items[0].ItemType = 'EItemSubType::QuestItem';
    input.items[0].bCantSell = flag;
    assert.equal(buildItemStats(input).items[100].cantSell, true);
    assert.equal(Object.hasOwn(buildItemStats(input).items[101], 'cantSell'), false);
  }
});
