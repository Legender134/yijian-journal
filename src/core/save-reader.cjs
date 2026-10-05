'use strict';
const zlib = require('node:zlib');

// The native inventory segment follows the tagged properties. Its layout was
// checked against all 36 local numeric slots. Unknown layouts are omitted;
// metadata and byte-exact backup remain available independently.
function readInventory(data, start) {
  try {
    let offset = start;
    const take = (n) => {
      if (!Number.isSafeInteger(n) || n < 0 || offset + n > data.length) throw Error('Inventory truncated');
      const at = offset;
      offset += n;
      return at;
    };
    const i32 = () => data.readInt32LE(take(4));
    if (i32() !== 0) return null;
    const count = i32();
    if (count < 0 || count > 10000) return null;
    const totals = new Map();
    for (let i = 0; i < count; i++) {
      take(16);
      const id = i32(),
        quantity = i32();
      if (id < 0 || id > 10000000 || quantity < 0 || quantity > 100000000) return null;
      for (let group = 0; group < 3; group++) {
        const actions = i32();
        if (actions < 0 || actions > 1000) return null;
        for (let j = 0; j < actions; j++) {
          take(1);
          i32();
          const value = data.readFloatLE(take(4));
          if (!Number.isFinite(value)) return null;
        }
      }
      const acquired = data.readBigInt64LE(take(8));
      if (acquired < 0n || acquired > 7258118400n) return null;
      const flag = i32();
      if (flag !== 0 && flag !== 1) return null;
      totals.set(id, (totals.get(id) || 0) + quantity);
    }
    // The following native NPC map is a separate collection, not an item.
    const npcCount = i32();
    if (npcCount < 0 || npcCount > 20000) return null;
    return [...totals].map(([id, count]) => ({ id, count }));
  } catch {
    return null;
  }
}
function readQuestSpecs(data, start, size) {
  try {
    let offset = start;
    const end = start + size;
    const take = (n) => {
      if (!Number.isSafeInteger(n) || n < 0 || offset + n > end) throw Error('Quest section truncated');
      const at = offset;
      offset += n;
      return at;
    };
    const u32 = () => data.readUInt32LE(take(4));
    const str = () => {
      const n = u32();
      if (n < 1 || n > 256) throw Error('Quest tag invalid');
      const at = take(n);
      return data.subarray(at, at + n - 1).toString('utf8');
    };
    const count = u32();
    if (count > 20000) return null;
    if (str() !== 'Quests' || str() !== 'StructProperty') return null;
    const payloadSize = u32();
    if (u32() !== 0 || str() !== 'QuestSpec') return null;
    take(16);
    if (data.readUInt8(take(1))) take(16);
    if (payloadSize !== end - offset) return null;
    const quests = [],
      seen = new Set();
    for (let i = 0; i < count; i++) {
      const id = u32(),
        step = data.readUInt8(take(1)),
        progressCount = u32();
      if (step > 4 || progressCount > 1000 || seen.has(id)) return null;
      // These two native integers are not treated as portable wall-clock
      // timestamps: historical saves can encode the machine's local clock.
      seen.add(id);
      take(progressCount * 9);
      u32();
      u32();
      quests.push({ id, step });
    }
    return offset === end ? quests : null;
  } catch {
    return null;
  }
}

// Read-only reader for the compressed GVAS header observed in the local game.
// Unknown formats return no metadata; they are still available for byte-exact backup.
function readMetadata(bytes, { details = false } = {}) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 32 * 1024 * 1024) return null;
    let data = bytes;
    if (bytes.subarray(0, 4).toString() !== 'GVAS') {
      if (bytes.readUInt32LE(0) !== 14 || bytes.readUInt32LE(8) !== bytes.length - 12) return null;
      const expected = bytes.readUInt32LE(4);
      if (expected > 64 * 1024 * 1024) return null;
      data = zlib.inflateSync(bytes.subarray(12), { maxOutputLength: 64 * 1024 * 1024 });
      if (data.length !== expected) return null;
    }
    let offset = 0;
    const take = (n) => {
      if (!Number.isSafeInteger(n) || n < 0 || offset + n > data.length) throw new Error('Truncated save');
      const start = offset;
      offset += n;
      return start;
    };
    const u32 = () => data.readUInt32LE(take(4));
    const i32 = () => data.readInt32LE(take(4));
    const str = () => {
      const length = i32();
      if (Math.abs(length) > 4096) throw new Error('String too long');
      if (!length) return '';
      const n = Math.abs(length) * (length < 0 ? 2 : 1);
      const start = take(n);
      return data.subarray(start, start + n - (length < 0 ? 2 : 1)).toString(length < 0 ? 'utf16le' : 'utf8');
    };
    if (data.subarray(take(4), 4).toString() !== 'GVAS' || u32() !== 2) return null;
    u32();
    take(6);
    u32();
    str();
    u32();
    const versions = u32();
    if (versions > 512) return null;
    take(versions * 20);
    if (str() !== '/Script/JH.JHSaveGame' || u32() !== 0) return null;
    const result = {};
    let propertyEnd = null;
    for (let i = 0; i < (details ? 128 : 12); i++) {
      const name = str();
      if (name === 'None') {
        propertyEnd = offset;
        break;
      }
      const type = str(),
        size = u32();
      u32();
      if (size > 32 * 1024 * 1024) return null;
      let inner;
      if (type === 'StructProperty') {
        inner = str();
        take(16);
      } else if (['ArrayProperty', 'SetProperty', 'ByteProperty', 'EnumProperty'].includes(type))
        inner = str();
      else if (type === 'MapProperty') {
        inner = str();
        str();
      } else if (type === 'BoolProperty') take(1);
      else if (
        !['StrProperty', 'NameProperty', 'IntProperty', 'FloatProperty', 'Int64Property'].includes(type)
      )
        break;
      const guid = data.readUInt8(take(1));
      if (guid) take(16);
      const start = offset;
      if (name === 'MapName' && type === 'StrProperty') result.map = str();
      if (name === 'SaveGameTime' && type === 'IntProperty' && size === 4) {
        const value = i32();
        if (value >= 0 && value < 100000000) result.playSeconds = value;
      }
      if (name === 'TeamInfos' && inner === 'IntProperty') {
        const count = u32();
        if (count > 128 || size !== 4 + count * 4) return null;
        result.teamIds = Array.from({ length: count }, () => i32());
      }
      if (details) {
        if (name === 'Quests' && type === 'ArrayProperty' && inner === 'StructProperty')
          result.quests = readQuestSpecs(data, start, size);
        const integers = {
          Money: 'money',
          CurrentTrackingQuestId: 'trackingQuest',
          CurrentTrackingPrimeQuestId: 'trackingMainQuest',
        };
        const arrays = {
          FightTeamInfos: 'fightTeamIds',
          FusionRecipes: 'fusionRecipes',
          CookingRecipes: 'cookingRecipes',
          AlchemyRecipes: 'alchemyRecipes',
        };
        if (Object.hasOwn(integers, name) && type === 'IntProperty' && size === 4) {
          const v = i32();
          if (v >= 0) result[integers[name]] = v;
        }
        if (Object.hasOwn(arrays, name) && type === 'ArrayProperty' && inner === 'IntProperty') {
          const count = u32();
          if (count > 10000 || size !== 4 + count * 4) return null;
          result[arrays[name]] = Array.from({ length: count }, () => i32());
        }
        if (name === 'DifficultyMode' && type === 'EnumProperty') result.difficulty = str();
        if (
          name === 'ThumbnailRaw' &&
          type === 'ArrayProperty' &&
          inner === 'ByteProperty' &&
          size <= 1024 * 1024
        ) {
          const count = u32();
          if (count === size - 4 && count >= 24) {
            const start = take(count),
              png = data.subarray(start, start + count);
            if (
              png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
              png.readUInt32BE(16) <= 2048 &&
              png.readUInt32BE(20) <= 2048
            )
              result.thumbnail = `data:image/png;base64,${png.toString('base64')}`;
          }
        }
      }
      offset = start;
      take(size);
      if (result.teamIds && !details) break;
    }
    if (details && propertyEnd !== null) result.inventory = readInventory(data, propertyEnd);
    return typeof result.playSeconds === 'number' ? result : null;
  } catch {
    return null;
  }
}
module.exports = { readMetadata, readInventory, readQuestSpecs };
