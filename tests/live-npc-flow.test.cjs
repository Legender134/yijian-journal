'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { readNpcObservation } = require('../src/core/live-npc-state.cjs');
const profile = { id: 'live-npc', referenceMode: 'latest' };
const saved = {
  name: '1.sav',
  hash: 'synthetic',
  modifiedAt: '2026-10-14T00:00:00Z',
  metadata: {
    quests: [{ id: 5020, step: 1 }],
    inventory: [{ id: 100034, count: 99 }],
    map: 'LV_25_P',
    mapName: '梧桐村',
  },
};
const npc = (id, rawFriendliness = 70) => ({
  id,
  rawFriendliness,
  visible: true,
  mapKey: 'LV_26_P',
  guildId: 0,
  skillPoints: 500,
  attributes: {
    5: 15,
    44: 100,
    27: 1,
    48: 1,
    61: 1,
    63: 1,
    65: 1,
    67: 1,
    9: 100,
    10: 10,
    14: 20,
    11: 100,
    12: 10,
    2: 1000,
    4: 800,
  },
  inventory: [{ id: 100034, count: 1 }],
  skills: [],
});
const observation = (friend = 70, extraQuests = []) =>
  readNpcObservation(
    {
      schema: 1,
      world: 'World /Synthetic.LV_26_P',
      pawn: 'Pawn Synthetic',
      sampledAt: 1800000000,
      quests: [
        { id: 12071, step: 4 },
        { id: 12075, step: 4 },
        { id: 12090, step: 1 },
        { id: 12094, step: 1 },
        { id: 11272, step: 1 },
        ...extraQuests,
      ],
      npcs: [npc(0), npc(10221, friend)],
    },
    { world: 'World /Synthetic.LV_26_P', pawn: 'Pawn Synthetic', now: 1800000000000 },
  );
test('nonlinear future checkpoint uses actual same-cohort affinity and active affected tasks', () => {
  for (const [friend, phrase] of [
    [69, /低于 70/],
    [70, /取胜会让他离场.*线索也会失败/],
    [90, /取胜会让他离场/],
  ]) {
    const flow = flowSnapshot(profile, saved, '', {
      dialogue: null,
      suppressedQuestIds: [],
      npcState: observation(friend),
    });
    assert.equal(flow.stateOrigin, 'live');
    assert.equal(flow.duels.progress.origin, 'live');
    assert.match(flow.guide.find((r) => r.id === 'chenlinxi-recruit-followup').warning, phrase);
    assert(
      !flow.active.some((r) => r.gameId === 5020),
      'old saved route cannot leak into current quest cohort',
    );
    const chen = flow.duels.progress.people.find((r) => r.npcId === 10221);
    assert.equal(chen.friendship.value, friend);
    assert.equal(
      chen.remainingItems[0].owned,
      null,
      'saved player holdings cannot masquerade as live holdings',
    );
  }
  const branched = flowSnapshot(profile, saved, '', { npcState: observation(90, [{ id: 12095, step: 1 }]) });
  assert(
    !branched.advice.some((r) => r.id === 'chenlinxi-recruit-followup'),
    'resolved branch retires its pre-branch advice',
  );
});
test('historical lookup suppresses live NPC and route projection; withdrawal returns to saved state', () => {
  const fixed = flowSnapshot({ ...profile, referenceMode: 'slot', saveSlot: '1.sav' }, saved, '', {
    npcState: observation(),
  });
  assert.equal(fixed.stateOrigin, 'saved');
  assert(!fixed.duels.progress.available);
  const withdrawn = flowSnapshot(profile, saved, '', { dialogue: null });
  assert.equal(withdrawn.stateOrigin, 'saved');
  assert(withdrawn.active.some((r) => r.gameId === 5020));
});
