'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  zlib = require('node:zlib');
const { readCombat, readInventory } = require('../src/core/native-save-details.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { syntheticSave, nativeNpc, nativeItem } = require('./fixtures.cjs');
const n = (value) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
};
const rich = {
  id: 0,
  guildId: 777,
  skillPoints: 350,
  meridianPoints: 18,
  attributes: { 1: 40, 2: 100, 3: 25, 4: 50, 5: 12, 9: 20.5, 11: 8 },
  skills: [
    { id: 850, level: 5, checked: 1, applied: 1 },
    { id: 851, level: 2 },
  ],
  meridians: [[23, [1, 2, 1, 0]]],
  friendliness: [[10023, 99]],
  guildFriendliness: [[3, -10]],
  guildHonors: [[3, 12]],
  inventory: [{ id: 10220, count: 7 }],
  equipment: [{ id: 1002, nativeValue: -2147483648, flag9: 1 }],
  avatar: { wide: '宇文逸_外观' },
  map: { wide: '梧桐村' },
  itemUsedCount: [[100, 2]],
  buffs: [{ id: 205, mode: 2, remaining: 31 }],
  sidebar: 3,
  meridianExts: [5, 9],
  avatars: ['Player', { wide: '雪地宇文逸' }],
  innerLimit: 1,
};
const section = (npcs = [rich, { id: 10023, attributes: { 5: 35 }, friendliness: [[0, 12]] }]) =>
  Buffer.concat([
    n(0),
    n(1),
    nativeItem({ id: 10226, count: 3, nativeValue: -1, flag9: 1, flag10: 1 }),
    n(npcs.length),
    ...npcs.map(nativeNpc),
  ]);

test('literal format14 contract is independent of the synthetic NPC writer', () => {
  // Hand-specified little-endian serialization, including nonempty skills,
  // signed friendship and two UTF16 FNames. No fixture writer is used here.
  const bytes = Buffer.from(
    `
    00000000 00000000 01000000
    00000000 07000000 7b000000
    05000000 01 00004842 02 0000c842 03 0000c841 04 00004842 05 00004041
    01000000 52030000 05000000 00000000 01000000 01000000
    00000000
    01000000 27270000 ec
    00000000 00000000 09000000
    00000000 00000000
    feffffff 38900000
    00000000 00000000 00000000 00000000 01000000 00000000 00000000 01
    00000000 00000000 ffffffff 00000000
    01000000 feffffff 6b960000
    00000000
  `.replace(/\s/g, ''),
    'hex',
  );
  const result = readCombat(bytes, 0, 14);
  assert(result);
  assert.equal(result.player.level, 12);
  assert.equal(result.player.healthRatio, 0.5);
  assert.equal(result.player.manaRatio, 0.5);
  assert.equal(result.player.skillPoints, 123);
  assert.equal(result.player.meridianPoints, 9);
  assert.deepEqual(result.player.skills, [{ id: 850, level: 5 }]);
  assert.deepEqual(result.player.equipment, []);
  assert.deepEqual(result.opponents, []);
  const invalidName = Buffer.from(bytes);
  const nameAt = invalidName.indexOf(Buffer.from('feffffff38900000', 'hex'));
  invalidName[nameAt + 6] = 1;
  assert.equal(readCombat(invalidName, 0, 14), null, 'unterminated UTF16 name must not shift later fields');
});

test('format14 reads player health ratios, learned skills and equipped items separately from bag and NPC guild', () => {
  const bytes = section(),
    before = Buffer.from(bytes),
    result = readCombat(bytes, 0, 14);
  assert(result);
  assert.equal(result.player.level, 12); // GuildId777 is not level
  assert.equal(result.player.healthRatio, 0.4);
  assert.equal(result.player.manaRatio, 0.5);
  assert.equal(result.player.baseAttack, 20.5);
  assert.equal(result.player.skillPoints, 350);
  assert.equal(result.player.meridianPoints, 18);
  assert.deepEqual(result.player.skills, [
    { id: 850, level: 5 },
    { id: 851, level: 2 },
  ]);
  assert.deepEqual(result.player.equipment, [{ id: 1002, count: 1 }]);
  assert.deepEqual(result.opponents, [{ id: 10023, level: 35, rawFriendliness: 12 }]);
  assert.deepEqual(readInventory(bytes, 0), [{ id: 10226, count: 3 }]);
  assert.deepEqual(bytes, before);
});

test('valid item int32 and two flags do not become a fictitious int64 timestamp', () => {
  for (const nativeValue of [-2147483648, -1, 2147483647])
    for (const flag9 of [0, 1])
      for (const flag10 of [0, 1]) {
        const bytes = Buffer.concat([n(0), n(1), nativeItem({ id: 1002, nativeValue, flag9, flag10 }), n(0)]);
        assert.deepEqual(readInventory(bytes, 0), [{ id: 1002, count: 1 }]);
      }
  for (const flag of [2, -1]) {
    const bytes = Buffer.concat([n(0), n(1), nativeItem({ id: 1002, flag9: flag }), n(0)]);
    assert.equal(readInventory(bytes, 0), null);
  }
});

test('saved NPC progress retains remaining private items, learned skills and life attributes without substituting equipment', () => {
  const bytes = section([
    rich,
    {
      id: 10047,
      attributes: { 5: 15, 27: 2, 48: 3, 61: 4, 63: 5, 65: 6, 67: 7 },
      skills: [
        { id: 850, level: 8 },
        { id: 851, level: 4 },
      ],
      friendliness: [[0, 35]],
      inventory: [{ id: 100034, count: 1 }],
      equipment: [{ id: 1002, count: 1 }],
      map: 'LV_25_P',
      visible: false,
      dynamic: true,
      inHouse: true,
    },
    { id: 10038, inventory: [], skills: [], map: { wide: '梧桐村' } },
  ]);
  const before = Buffer.from(bytes);
  const result = readCombat(bytes, 0, 14);
  assert.equal(result.npcStates.length, 2);
  const npc = result.npcStates.find((row) => row.id === 10047);
  assert.deepEqual(npc.inventory, [{ id: 100034, count: 1 }]);
  assert.deepEqual(npc.equipment, [{ id: 1002, count: 1 }]);
  assert.deepEqual(npc.skills, [
    { id: 850, level: 8 },
    { id: 851, level: 4 },
  ]);
  assert.equal(npc.rawFriendliness, 35);
  assert.equal(npc.attributes[48], 3);
  assert.equal(npc.mapKey, 'LV_25_P');
  assert.equal(npc.visible, false);
  assert.equal(npc.dynamic, true);
  assert.equal(npc.inHouse, true);
  assert.deepEqual(
    result.npcStates.find((row) => row.id === 10038).inventory,
    [],
    'known empty inventory differs from an absent NPC record',
  );
  assert.equal(result.npcStates.find((row) => row.id === 10038).mapKey, '梧桐村');
  assert.equal(
    result.npcStates.some((row) => row.id === 5003),
    false,
  );
  assert.deepEqual(bytes, before);
  assert.equal(
    readCombat(Buffer.concat([bytes, Buffer.from([0])]), 0, 14),
    null,
    'unknown layout never produces partial progress',
  );
});

test('friendship is target NPC key0, signed and independent of reciprocal player entries', () => {
  const result = readCombat(
    section([
      rich,
      {
        id: 10023,
        friendliness: [
          [0, -20],
          [10047, 80],
        ],
      },
      { id: 10047 },
    ]),
    0,
    14,
  );
  assert.deepEqual(
    result.opponents.map((p) => [p.id, p.rawFriendliness]),
    [
      [10023, -20],
      [10047, 0],
    ],
  );
});

test('all truncations, duplicate NPCs, nonfinite values and unknown suffixes omit combat without guessing', () => {
  const bytes = section();
  for (let length = 0; length < bytes.length; length++)
    assert.equal(readCombat(bytes.subarray(0, length), 0, 14), null);
  for (const npcs of [
    [rich, rich],
    [{ ...rich, attributes: { 1: NaN } }],
    [
      {
        ...rich,
        skills: [
          { id: 850, level: 1 },
          { id: 850, level: 2 },
        ],
      },
    ],
    [{ ...rich, friendliness: [[2, 101]] }],
  ])
    assert.equal(readCombat(section(npcs), 0, 14), null);
  assert.equal(readCombat(Buffer.concat([bytes, n(0)]), 0, 14), null);
  for (const format of [null, 13, 15]) assert.equal(readCombat(bytes, 0, format), null);
  assert.equal(readCombat(bytes, -1, 14), null);
  const excessive = Buffer.concat([n(0), n(0), n(20001)]);
  assert.equal(readCombat(excessive, 0, 14), null);
});

test('basic metadata and inventory survive malformed NPCs; bare GVAS does not assert native format14', () => {
  const bytes = syntheticSave({ full: true, npcs: [rich], inventory: [{ id: 10226, count: 3 }] }),
    before = Buffer.from(bytes);
  const metadata = readMetadata(bytes, { details: true });
  assert.equal(metadata.combat.player.level, 12);
  const raw = zlib.inflateSync(bytes.subarray(12));
  assert.equal(readMetadata(raw, { details: true }).combat, null);
  const damaged = raw.subarray(0, raw.length - 1),
    zipped = zlib.deflateSync(damaged);
  const after = readMetadata(Buffer.concat([n(14), n(damaged.length), n(zipped.length), zipped]), {
    details: true,
  });
  assert.equal(after.combat, null);
  assert.equal(after.map, 'LV_World');
  assert.deepEqual(after.inventory, [{ id: 10226, count: 3 }]);
  assert.deepEqual(bytes, before);
});
