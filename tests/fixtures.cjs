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
const signed = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};
const float = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b;
};
const fname = (value) =>
  typeof value === 'object'
    ? Buffer.concat([signed(-value.wide.length - 1), Buffer.from(value.wide + '\0', 'utf16le')])
    : s(value);
function nativeItem(i) {
  const actions = (rows = []) =>
    Buffer.concat([
      n(rows.length),
      ...rows.map((a) => Buffer.concat([Buffer.from([a.type]), signed(a.id), float(a.value)])),
    ]);
  return Buffer.concat([
    Buffer.alloc(16),
    n(i.id),
    n(i.count ?? 1),
    n(i.flag ?? 0),
    actions(i.actions),
    actions(i.extraActions),
    signed(i.nativeValue ?? 0),
    signed(i.flag9 ?? 0),
    signed(i.flag10 ?? 0),
  ]);
}
function nativeNpc(i) {
  const map = (rows = [], value) =>
    Buffer.concat([n(rows.length), ...rows.map(([key, v]) => Buffer.concat([signed(key), value(v)]))]);
  const attributes = Object.entries(i.attributes || { 1: 100, 2: 100, 3: 50, 4: 50, 5: 5, 9: 10, 11: 8 });
  const items = (rows = []) => Buffer.concat([n(rows.length), ...rows.map(nativeItem)]);
  return Buffer.concat([
    n(i.id),
    signed(i.guildId ?? 0),
    signed(i.skillPoints ?? 0),
    n(attributes.length),
    ...attributes.map(([key, value]) => Buffer.concat([Buffer.from([Number(key)]), float(value)])),
    n((i.skills || []).length),
    ...(i.skills || []).map((k) =>
      Buffer.concat([n(k.id), signed(k.level), signed(k.order ?? 0), n(k.checked ?? 0), n(k.applied ?? 0)]),
    ),
    map(i.meridians, (v) => Buffer.concat([signed(v[0]), signed(v[1]), n(v[2]), n(v[3])])),
    map(i.friendliness, (v) => Buffer.from([v & 255])),
    map(i.guildFriendliness, (v) => Buffer.from([v & 255])),
    map(i.guildHonors, signed),
    signed(i.meridianPoints ?? 0),
    items(i.inventory),
    items(i.equipment),
    fname(i.avatar ?? 'Player'),
    float(1),
    float(2),
    float(3),
    fname(i.map ?? 'LV_World'),
    n(1),
    n(0),
    n(0),
    Buffer.from([1]),
    map(i.itemUsedCount, signed),
    n((i.buffs || []).length),
    ...(i.buffs || []).map((b) => Buffer.concat([signed(b.id), Buffer.from([b.mode]), signed(b.remaining)])),
    signed(i.sidebar ?? 0),
    ints(i.meridianExts || []),
    n((i.avatars || []).length),
    ...(i.avatars || []).map(fname),
    signed(i.innerLimit ?? 0),
  ]);
}
function syntheticSave({
  full = false,
  map = 'LV_World',
  seconds = 3661,
  team = [0, 10047],
  inventory = [],
  npcs = [],
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
    ...inventory.map(nativeItem),
    n(npcs.length),
    ...npcs.map(nativeNpc),
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
module.exports = { syntheticSave, questSection, nativeNpc, nativeItem };
