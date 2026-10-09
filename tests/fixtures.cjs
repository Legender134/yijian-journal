'use strict';
const zlib = require('node:zlib');
const n = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const s = (v) => Buffer.concat([n(Buffer.byteLength(v) + 1), Buffer.from(v + '\0')]);
const prop = (name, type, value, extra = Buffer.alloc(0)) =>
  Buffer.concat([s(name), s(type), n(value.length), n(0), extra, Buffer.from([0]), value]);
const ints = (a) => Buffer.concat([n(a.length), ...a.map(n)]);
function syntheticSave({
  full = false,
  map = 'LV_World',
  seconds = 3661,
  team = [0, 10047],
  inventory = [],
  quests = [],
  money = 22522,
  fusionRecipes = [1002],
  cookingRecipes = [100],
  alchemyRecipes = [100],
  trackingQuest = 11077,
  trackingMainQuest = 5200,
} = {}) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4n8AAAAASUVORK5CYII=',
    'base64',
  );
  const extra = full
    ? [
        prop('Quests', 'ArrayProperty', questSection(quests), s('StructProperty')),
        prop('FightTeamInfos', 'ArrayProperty', ints(team), s('IntProperty')),
        prop('FusionRecipes', 'ArrayProperty', ints(fusionRecipes), s('IntProperty')),
        prop('CookingRecipes', 'ArrayProperty', ints(cookingRecipes), s('IntProperty')),
        prop('AlchemyRecipes', 'ArrayProperty', ints(alchemyRecipes), s('IntProperty')),
        prop('Money', 'IntProperty', n(money)),
        prop('CurrentTrackingQuestId', 'IntProperty', n(trackingQuest)),
        prop('CurrentTrackingPrimeQuestId', 'IntProperty', n(trackingMainQuest)),
        prop('DifficultyMode', 'EnumProperty', s('EDifficultyMode::Hell'), s('EDifficultyMode')),
      ]
    : [];
  const nativeInventory = Buffer.concat([
    n(0),
    n(inventory.length),
    ...inventory.map((i) =>
      Buffer.concat([Buffer.alloc(16), n(i.id), n(i.count), n(0), n(0), n(0), Buffer.alloc(8), n(0)]),
    ),
    n(0),
  ]);
  const data = Buffer.concat([
    Buffer.from('GVAS'),
    n(2),
    n(522),
    Buffer.from([4, 0, 26, 0, 2, 0]),
    n(0),
    s('++UE4+Release-4.26'),
    n(3),
    n(0),
    s('/Script/JH.JHSaveGame'),
    n(0),
    prop('MapName', 'StrProperty', s(map)),
    ...(full
      ? [prop('ThumbnailRaw', 'ArrayProperty', Buffer.concat([n(png.length), png]), s('ByteProperty'))]
      : []),
    prop('SaveGameTime', 'IntProperty', n(seconds)),
    prop('TeamInfos', 'ArrayProperty', ints(team), s('IntProperty')),
    ...extra,
    s('None'),
    ...(full ? [nativeInventory] : []),
  ]);
  const zipped = zlib.deflateSync(data);
  return Buffer.concat([n(14), n(data.length), n(zipped.length), zipped]);
}
function questSection(quests) {
  const records = Buffer.concat(
    quests.map((q, i) => Buffer.concat([n(q.id), Buffer.from([q.step]), n(0), n(i + 1), n(q.finished || 0)])),
  );
  return Buffer.concat([
    n(quests.length),
    s('Quests'),
    s('StructProperty'),
    n(records.length),
    n(0),
    s('QuestSpec'),
    Buffer.alloc(16),
    Buffer.from([0]),
    records,
  ]);
}
module.exports = { syntheticSave, questSection };
