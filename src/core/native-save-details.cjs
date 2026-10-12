'use strict';

// Read-only format14 contract from Build21798996's UJHSaveGame/NPCInfo
// serializers. Attribute values are saved BASE values, not the runtime panel.
// FNames use FObjectAndNameAsStringProxyArchive's FString representation.
function cursor(data, start) {
  if (!Buffer.isBuffer(data) || !Number.isSafeInteger(start) || start < 0 || start > data.length)
    throw Error('Invalid native section');
  let offset = start,
    budget = 1000000;
  const take = (n) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > data.length - offset)
      throw Error('Native section truncated');
    const at = offset;
    offset += n;
    return at;
  };
  const i32 = () => data.readInt32LE(take(4));
  const u8 = () => data.readUInt8(take(1));
  const i8 = () => data.readInt8(take(1));
  const count = (max, minimum = 1) => {
    const value = i32();
    if (value < 0 || value > max || value > (data.length - offset) / minimum || (budget -= value) < 0)
      throw Error('Native collection invalid');
    return value;
  };
  const bool = () => {
    const value = i32();
    if (value !== 0 && value !== 1) throw Error('Native bool invalid');
    return !!value;
  };
  const float = () => {
    const value = data.readFloatLE(take(4));
    if (!Number.isFinite(value)) throw Error('Native float invalid');
    return value;
  };
  const name = () => {
    const length = i32();
    if (!length) return;
    if (Math.abs(length) > 4096) throw Error('Native name too long');
    const width = length < 0 ? 2 : 1,
      bytes = Math.abs(length) * width;
    const at = take(bytes);
    if (data[at + bytes - 1] !== 0 || (width === 2 && data[at + bytes - 2] !== 0))
      throw Error('Native name unterminated');
  };
  const item = () => {
    take(16); // GUID
    const id = i32(),
      quantity = i32();
    if (id < 0 || id > 10000000 || quantity < 0 || quantity > 100000000) throw Error('Native item invalid');
    bool();
    for (let group = 0; group < 2; group++) {
      const actions = count(1000, 9);
      for (let i = 0; i < actions; i++) {
        u8();
        i32();
        float();
      }
    }
    // Version6 adds ONE int32, version9/10 add separate uint32 bools.
    // This is not an int64 acquisition timestamp.
    i32();
    bool();
    bool();
    return { id, count: quantity };
  };
  const items = () => {
    const length = count(10000, 48),
      result = [];
    for (let i = 0; i < length; i++) result.push(item());
    return result;
  };
  return { take, i32, u8, i8, count, bool, float, name, items, end: () => offset === data.length };
}

function inventoryPrefix(reader) {
  if (reader.i32() !== 0) throw Error('Native prefix invalid');
  const totals = new Map();
  for (const item of reader.items()) totals.set(item.id, (totals.get(item.id) || 0) + item.count);
  const npcCount = reader.count(20000, 4);
  return { inventory: [...totals].map(([id, count]) => ({ id, count })), npcCount };
}

function readInventory(data, start) {
  try {
    return inventoryPrefix(cursor(data, start)).inventory;
  } catch {
    return null;
  }
}

function readCombat(data, start, format) {
  if (format !== 14) return null;
  try {
    const r = cursor(data, start),
      { npcCount } = inventoryPrefix(r);
    const seen = new Set(),
      opponents = [];
    let player = null;
    const fixedMap = (max, width) => r.take(r.count(max, width) * width);
    for (let i = 0; i < npcCount; i++) {
      const id = r.i32();
      if (id < 0 || id > 10000000 || seen.has(id)) throw Error('Native NPC invalid');
      seen.add(id);
      r.i32(); // GuildId, not level
      const skillPoints = r.i32();
      const attributes = {},
        attrCount = r.count(69, 5);
      for (let a = 0; a < attrCount; a++) {
        const key = r.u8(),
          value = r.float();
        if (key < 1 || key > 69 || Object.hasOwn(attributes, key)) throw Error('Native attribute invalid');
        attributes[key] = value;
      }
      const skills = [],
        skillCount = r.count(10000, 20),
        skillIds = new Set();
      for (let s = 0; s < skillCount; s++) {
        const skillId = r.i32(),
          level = r.i32();
        if (skillId < 0 || skillId > 10000000 || skillIds.has(skillId)) throw Error('Native skill invalid');
        skillIds.add(skillId);
        r.i32();
        r.bool();
        r.bool();
        if (id === 0) skills.push({ id: skillId, level });
      }
      const meridians = r.count(10000, 20);
      for (let m = 0; m < meridians; m++) {
        r.i32();
        r.i32();
        r.i32();
        r.bool();
        r.bool();
      }
      let playerFriendliness = 0;
      const friendCount = r.count(20000, 5),
        friendIds = new Set();
      for (let f = 0; f < friendCount; f++) {
        const npcId = r.i32(),
          value = r.i8();
        if (npcId < 0 || npcId > 10000000 || value < -100 || value > 100 || friendIds.has(npcId))
          throw Error('Native friendship invalid');
        friendIds.add(npcId);
        // GetFriendliness(target) looks up target NPCInfo's key0, then applies
        // a separate story cap. Do not read the player's reciprocal map.
        if (npcId === 0) playerFriendliness = value;
      }
      fixedMap(10000, 5); // GuildFriendliness
      fixedMap(10000, 8); // GuildHonors
      const meridianPoints = r.i32();
      r.items(); // NPC inventory is distinct from equipped items
      const equipment = r.items();
      r.name(); // AvatarResourceName
      r.float();
      r.float();
      r.float();
      r.name(); // location vector + map FName
      r.bool();
      r.bool();
      r.bool();
      r.u8();
      fixedMap(10000, 8); // ItemUsedCount (version2)
      const buffs = r.count(10000, 9); // SceneBuffs (version4)
      for (let b = 0; b < buffs; b++) {
        r.i32();
        r.u8();
        r.i32();
      }
      r.i32(); // SideBarOrderIndex (version11)
      r.take(r.count(10000, 4) * 4); // JingMaiExts (version12)
      const avatars = r.count(10000, 4); // unlocked avatar FNames (version13)
      for (let a = 0; a < avatars; a++) r.name();
      r.i32(); // AddNeiGongUpLimit (version14)
      const level = attributes[5];
      if (id !== 0)
        opponents.push({
          id,
          level: Number.isInteger(level) && level > 0 && level <= 1000 ? level : null,
          rawFriendliness: playerFriendliness,
        });
      if (id === 0) {
        const ratio = (current, maximum) =>
          maximum > 0 && current >= 0 && current <= maximum ? current / maximum : null;
        player = {
          id,
          level: Number.isInteger(level) && level > 0 && level <= 1000 ? level : null,
          healthRatio: ratio(attributes[1], attributes[2]),
          manaRatio: ratio(attributes[3], attributes[4]),
          baseAttack: attributes[9] ?? null,
          baseDefense: attributes[11] ?? null,
          skillPoints: skillPoints >= 0 ? skillPoints : null,
          meridianPoints: meridianPoints >= 0 ? meridianPoints : null,
          skills,
          equipment,
        };
      }
    }
    // Any unknown suffix or shifted record invalidates combat information only.
    return r.end() && player ? { format: 14, player, opponents } : null;
  } catch {
    return null;
  }
}

module.exports = { readInventory, readCombat };
