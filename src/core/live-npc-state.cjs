'use strict';
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const attributes = [5, 27, 48, 61, 63, 65, 67, 44, 9, 10, 14, 11, 12, 2, 4];

// Accept one complete, current-world read. Never combine a partial native map
// with a different save or keep it across travel, loading or a stale heartbeat.
function readNpcObservation(value, { world, pawn, now = Date.now() } = {}) {
  try {
    if (
      !value ||
      value.schema !== 1 ||
      typeof world !== 'string' ||
      !world ||
      typeof pawn !== 'string' ||
      !pawn ||
      value.world !== world ||
      value.pawn !== pawn ||
      world.length > 512 ||
      pawn.length > 512 ||
      !integer(value.sampledAt, 1, 9999999999) ||
      now / 1000 - value.sampledAt > 5 ||
      value.sampledAt - now / 1000 > 2 ||
      !Array.isArray(value.quests) ||
      value.quests.length > 20000 ||
      !Array.isArray(value.npcs) ||
      !value.npcs.length ||
      value.npcs.length > 5000
    )
      return null;
    let budget = 100000;
    const quests = [],
      seenQuests = new Set(),
      seenNpcs = new Set();
    for (const row of value.quests) {
      if (!row || !integer(row.id, 1, 10000000) || !integer(row.step, 0, 4) || seenQuests.has(row.id))
        return null;
      seenQuests.add(row.id);
      quests.push({ id: row.id, step: row.step });
    }
    const npcs = [];
    for (const row of value.npcs) {
      if (
        !row ||
        !integer(row.id, 0, 10000000) ||
        seenNpcs.has(row.id) ||
        !integer(row.rawFriendliness, -100, 100) ||
        typeof row.visible !== 'boolean' ||
        typeof row.mapKey !== 'string' ||
        row.mapKey.length > 128 ||
        /[\x00-\x1f\x7f]/.test(row.mapKey) ||
        !row.attributes ||
        typeof row.attributes !== 'object' ||
        Array.isArray(row.attributes) ||
        !Array.isArray(row.skills) ||
        row.skills.length > 1024 ||
        !Array.isArray(row.inventory) ||
        row.inventory.length > 10000 ||
        !integer(row.guildId, 0, 1000000) ||
        !integer(row.skillPoints, 0, 2147483647)
      )
        return null;
      seenNpcs.add(row.id);
      const values = {};
      for (const key of attributes) {
        const n = row.attributes[key];
        if (!Number.isFinite(n) || n < 0 || n > 10000000) return null;
        values[key] = n;
      }
      const skills = [],
        seenSkills = new Set(),
        inventory = [];
      for (const skill of row.skills) {
        if (
          !skill ||
          !integer(skill.id, 1, 10000000) ||
          !integer(skill.level, 0, 1000) ||
          seenSkills.has(skill.id) ||
          --budget < 0
        )
          return null;
        seenSkills.add(skill.id);
        skills.push({ id: skill.id, level: skill.level });
      }
      for (const item of row.inventory) {
        if (!item || !integer(item.id, 1, 10000000) || !integer(item.count, 0, 100000000) || --budget < 0)
          return null;
        inventory.push({ id: item.id, count: item.count });
      }
      npcs.push({
        id: row.id,
        attributes: values,
        skills,
        inventory,
        rawFriendliness: row.rawFriendliness,
        visible: row.visible,
        mapKey: row.mapKey,
        level: Number.isInteger(values[5]) ? values[5] : null,
        guildId: row.guildId,
        skillPoints: row.skillPoints,
      });
    }
    const player = npcs.find((row) => row.id === 0);
    if (!player) return null;
    return {
      schema: 1,
      origin: 'live',
      sampledAt: value.sampledAt,
      world,
      pawn,
      questStates: quests,
      player,
      npcStates: npcs.filter((row) => row.id !== 0),
    };
  } catch {
    return null;
  }
}
// The immutable, MAC-bound blob is rewritten only when its contents change.
// A separately advancing sample sequence attests an actual full re-read, even
// when the contents are identical. Heartbeat time alone never renews a sample.
class NpcObservationReader {
  constructor({ read, token, revision, now = Date.now }) {
    this.read = read;
    this.token = token;
    this.revision = revision;
    this.now = now;
    this.cache = null;
    this.last = null;
  }
  withdraw() {
    this.cache = null;
    // Retain the sequence watermark: a withdrawn old packet cannot revive.
    if (this.last) this.last.withdrawn = true;
  }
  sample(state) {
    try {
      const ref = state?.npcObservation;
      if (
        !ref ||
        !integer(ref.epoch, 1, 2147483647) ||
        !integer(ref.version, 1, 2147483647) ||
        !integer(ref.sequence, 1, 2147483647) ||
        !integer(ref.at, 1, 9999999999) ||
        !/^[a-f0-9]{64}$/.test(ref.mac) ||
        this.now() / 1000 - ref.at > 3 ||
        ref.at - this.now() / 1000 > 2 ||
        ref.at > state.at
      )
        throw Error('sample');
      const crypto = require('node:crypto');
      const frame = [
        'npc-sample-v1',
        state.source,
        state.session,
        this.revision,
        state.world,
        state.pawn,
        ref.epoch,
        ref.version,
        ref.sequence,
        ref.at,
        ref.mac,
      ].join('\n');
      const sampleMac = crypto
        .createHmac('sha256', Buffer.from(this.token, 'hex'))
        .update(frame)
        .digest('hex');
      if (sampleMac !== ref.sampleMac) throw Error('sample_mac');
      const binding = [state.source, state.session, state.world, state.pawn, ref.epoch].join('\n');
      const scope = [state.source, state.session].join('\n');
      if (
        this.last?.scope === scope &&
        (ref.epoch < this.last.epoch ||
          (ref.epoch === this.last.epoch && binding !== this.last.binding) ||
          ref.sequence < this.last.sequence ||
          ref.at < this.last.at ||
          ref.version < this.last.version ||
          (ref.version === this.last.version && ref.mac !== this.last.mac) ||
          (ref.sequence === this.last.sequence &&
            (this.last.withdrawn ||
              ref.at !== this.last.at ||
              ref.mac !== this.last.mac ||
              ref.version !== this.last.version)))
      )
        throw Error('replay');
      if (
        this.cache?.binding !== binding ||
        this.cache.mac !== ref.mac ||
        this.cache.version !== ref.version
      ) {
        const bytes = this.read();
        if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) throw Error('size');
        const mac = crypto.createHmac('sha256', Buffer.from(this.token, 'hex')).update(bytes).digest('hex');
        if (mac !== ref.mac) throw Error('mac');
        const body = JSON.parse(bytes.toString('utf8'));
        if (
          body.schema !== 1 ||
          body.source !== state.source ||
          body.session !== state.session ||
          body.revision !== this.revision ||
          body.world !== state.world ||
          body.pawn !== state.pawn ||
          body.epoch !== ref.epoch ||
          body.version !== ref.version ||
          !Array.isArray(body.identity) ||
          body.identity.length !== 5 ||
          !body.identity.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
        )
          throw Error('binding');
        const value = readNpcObservation(
          { ...body, sampledAt: ref.at },
          { world: state.world, pawn: state.pawn, now: this.now() },
        );
        if (!value) throw Error('body');
        this.cache = { binding, mac, version: ref.version, value };
      }
      this.last = {
        binding,
        scope,
        epoch: ref.epoch,
        sequence: ref.sequence,
        at: ref.at,
        version: ref.version,
        mac: ref.mac,
      };
      return {
        ...this.cache.value,
        epoch: ref.epoch,
        sampledAt: ref.at,
        key: binding + '\n' + ref.version + '\n' + ref.mac,
      };
    } catch {
      this.withdraw();
      return null;
    }
  }
}
module.exports = { readNpcObservation, NpcObservationReader };
