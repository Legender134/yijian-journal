'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readNpcObservation, NpcObservationReader } = require('../src/core/live-npc-state.cjs');
const crypto = require('node:crypto');
const now = 1800000000000;
const binding = { now, world: 'World /Synthetic.Village', pawn: 'Pawn Synthetic.Player' };
const npc = (id) => ({
  id,
  rawFriendliness: 70,
  visible: true,
  mapKey: 'LV_25_P',
  guildId: 1,
  skillPoints: 500,
  attributes: {
    5: 15,
    44: 60,
    27: 1,
    48: 1,
    61: 1,
    63: 1,
    65: 3,
    67: 2,
    9: 100,
    10: 10,
    14: 20,
    11: 40,
    12: 10,
    2: 1000,
    4: 600,
  },
  skills: [{ id: 100, level: 3 }],
  inventory: [{ id: 100034, count: 1 }],
});
function channel() {
  let clock = now,
    reads = 0;
  const token = 'b'.repeat(64),
    revision = 'a'.repeat(64);
  const sign = (bytes) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(bytes).digest('hex');
  let body = {
    ...sample(),
    session: '1800000000-123456',
    source: 'C:/Synthetic/SaveGames',
    revision,
    epoch: 1,
    version: 1,
    identity: ['gi1', 'sm1', 'nm1', 'qm1', 'player1'],
  };
  delete body.sampledAt;
  let bytes = Buffer.from(JSON.stringify(body));
  function state(extra = {}, bodyExtra = null) {
    if (bodyExtra) {
      body = { ...body, ...bodyExtra };
      bytes = Buffer.from(JSON.stringify(body));
    }
    const s = {
      source: body.source,
      session: body.session,
      world: body.world,
      pawn: body.pawn,
      at: clock / 1000,
    };
    const ref = {
      epoch: body.epoch,
      version: body.version,
      sequence: 1,
      at: clock / 1000,
      mac: sign(bytes),
      ...extra,
    };
    ref.sampleMac = sign(
      [
        'npc-sample-v1',
        s.source,
        s.session,
        revision,
        s.world,
        s.pawn,
        ref.epoch,
        ref.version,
        ref.sequence,
        ref.at,
        ref.mac,
      ].join('\n'),
    );
    return { ...s, npcObservation: ref };
  }
  const reader = new NpcObservationReader({
    token,
    revision,
    now: () => clock,
    read: () => {
      reads++;
      return bytes;
    },
  });
  return {
    reader,
    state,
    advance: (n = 1000) => (clock += n),
    reads: () => reads,
    corrupt: () => {
      bytes = Buffer.from('{}');
    },
    body: () => body,
  };
}
test('immutable blob cache renews only on a signed actual re-sampling reference', () => {
  const c = channel();
  const first = c.state();
  const a = c.reader.sample(first);
  assert(a);
  assert.equal(c.reads(), 1);
  assert(c.reader.sample(first));
  assert.equal(c.reads(), 1);
  c.advance();
  const fresh = c.state({ sequence: 2 });
  const b = c.reader.sample(fresh);
  assert(b);
  assert.equal(b.key, a.key);
  assert.equal(b.sampledAt, a.sampledAt + 1);
  assert.equal(c.reads(), 1, 'timestamp-only progress does not reparse or rerender all NPCs');
  const forged = structuredClone(fresh);
  forged.npcObservation.at++;
  forged.at++;
  assert.equal(c.reader.sample(forged), null, 'a heartbeat edit cannot extend a sample MAC');
  assert.equal(c.reader.sample(fresh), null, 'withdrawn sample cannot revive at the same sequence');
  c.advance();
  assert(c.reader.sample(c.state({ sequence: 3 })));
  c.advance(4000);
  assert.equal(c.reader.sample(c.state({ sequence: 4, at: first.at })), null);
});
test('blob changes, load epochs and source bindings reject replay, stale and partial state', () => {
  for (const mutate of [
    (c, s) => {
      s.npcObservation.mac = 'd'.repeat(64);
    },
    (c, s) => {
      s.world = 'World /Different';
    },
    (c, s) => {
      s.source = 'C:/Different';
    },
    (c, s) => {
      s.session = '1800000000-222222';
    },
    (c, s) => {
      s.pawn = 'Pawn Different';
    },
    (c, s) => {
      s.npcObservation.sequence = 0;
    },
    (c, s) => {
      c.corrupt();
    },
  ]) {
    const c = channel(),
      s = c.state();
    mutate(c, s);
    assert.equal(c.reader.sample(s), null);
  }
  const c = channel();
  const old = c.state();
  assert(c.reader.sample(old));
  c.advance();
  const changed = c.state(
    { sequence: 2 },
    { epoch: 2, version: 2, npcs: [npc(0), { ...npc(10016), inventory: [] }] },
  );
  assert.deepEqual(c.reader.sample(changed).npcStates[0].inventory, []);
  assert.equal(c.reader.sample(old), null, 'old epoch cannot replace the post-load result');
  const duplicate = c.state({ sequence: 3 }, { version: 3, npcs: [npc(0), npc(10016), npc(10016)] });
  assert.equal(
    c.reader.sample(duplicate),
    null,
    'a complete parse is required before replacing known empty bags',
  );
});
const sample = () => ({
  schema: 1,
  world: binding.world,
  pawn: binding.pawn,
  sampledAt: now / 1000,
  quests: [{ id: 12071, step: 4 }],
  npcs: [npc(0), npc(10016)],
});
test('a complete live NPC observation is bound to its current world, pawn and sampling time', () => {
  const packet = sample(),
    before = structuredClone(packet);
  const result = readNpcObservation(packet, binding);
  assert.equal(result.origin, 'live');
  assert.equal(result.player.id, 0);
  assert.equal(result.npcStates[0].id, 10016);
  assert.equal(result.player.attributes[44], 60);
  assert.deepEqual(result.questStates, packet.quests);
  assert.deepEqual(packet, before);
  assert.equal(readNpcObservation(packet, { ...binding, world: 'World Different' }), null);
  assert.equal(readNpcObservation(packet, { ...binding, pawn: 'Pawn Different' }), null);
  assert.equal(readNpcObservation(packet, { ...binding, now: now + 6000 }), null);
  assert.equal(readNpcObservation(packet, { ...binding, now: now - 3000 }), null);
});
test('invalid, incomplete and oversized observations cannot clear saved private items or bypass story caps', () => {
  for (const mutate of [
    (p) => {
      p.schema = 2;
    },
    (p) => {
      p.npcs.shift();
    },
    (p) => {
      p.npcs.push(npc(10016));
    },
    (p) => {
      p.quests.push({ id: 12071, step: 2 });
    },
    (p) => {
      p.quests[0].step = 5;
    },
    (p) => {
      delete p.npcs[1].attributes[65];
    },
    (p) => {
      p.npcs[1].attributes[44] = Infinity;
    },
    (p) => {
      p.npcs[1].skills.push({ id: 100, level: 4 });
    },
    (p) => {
      p.npcs[1].inventory[0].count = -1;
    },
    (p) => {
      p.npcs[1].rawFriendliness = 101;
    },
    (p) => {
      p.npcs[1].mapKey = 'bad\u0000map';
    },
    (p) => {
      p.npcs[1].visible = 'true';
    },
    (p) => {
      p.npcs = Array.from({ length: 5001 }, (_, id) => npc(id));
    },
  ]) {
    const p = sample();
    mutate(p);
    assert.equal(readNpcObservation(p, binding), null);
  }
  const empty = sample();
  empty.npcs[1].inventory = [];
  empty.quests = [];
  const result = readNpcObservation(empty, binding);
  assert.deepEqual(result.npcStates[0].inventory, [], 'a complete empty bag remains meaningful');
  assert.deepEqual(result.questStates, [], 'a complete empty map differs from a missing collection');
});
