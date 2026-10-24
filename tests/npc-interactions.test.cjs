'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../scripts/build-npc-interactions.cjs');
const contracts = require('../src/data/npc-interactions.json');

// Synthetic source rows use only the public contract, without private game files.
const input = () => ({
  schema: 1,
  source: structuredClone(contracts.source),
  people: Object.fromEntries(
    Object.entries(contracts.people).map(([id, row]) => [
      id,
      {
        compareRequirements: row.compareRequirements,
        bCantFighting: row.cannotFight,
        guildId: row.guildId,
      },
    ]),
  ),
  skills: Object.fromEntries(
    Object.entries(contracts.skills).map(([id, row]) => [
      id,
      {
        friendliness: row.friendliness,
        requirements: row.requirements,
        openForPlayer: row.openForPlayer,
        excludedFromNativeConsult: row.excluded,
        ConsultSExpCost: row.skillPointCost,
        grade: row.grade,
      },
    ]),
  ),
  friendlyLimits: structuredClone({
    compareGlobalFriendliness: contracts.friendlyLimits.Compare,
    compare: contracts.compare,
    gift: contracts.gift,
    martialCost: contracts.martialCost,
    vigor: contracts.vigorCost,
  }),
});

test('public NPC interaction data retains typed guild, grade and native free-cost sequence through the builder', () => {
  assert.deepEqual(project(input()), contracts);
  assert.deepEqual(
    [5007, 5011, 5013, 10016].map((id) => contracts.people[id].guildId),
    [1, 1, 1, 0],
  );
  assert.equal(contracts.skills[700].grade, 2);
  assert.deepEqual(contracts.martialCost.guildFree, {
    targetGuildId: 1,
    completedQuestStep: 4,
    initialMaxQuality: 0,
    sequence: [5218, 5317, 5323, 5748, 5858].map((questId, index) => ({ questId, maxQuality: index + 2 })),
  });
  assert.doesNotMatch(
    JSON.stringify(contracts.source),
    /[A-Za-z]:\\|\/mnt\//,
    'provenance excludes local paths',
  );
});

test('NPC interaction builder rejects missing or untyped guild and skill quality data', () => {
  for (const guildId of [undefined, null, '1', -1, 1.5]) {
    const raw = input();
    raw.people[5007].guildId = guildId;
    assert.throws(() => project(raw), /guild identity/);
  }
  for (const grade of [undefined, null, '2', 0, 7, 2.5]) {
    const raw = input();
    raw.skills[700].grade = grade;
    assert.throws(() => project(raw), /skill interaction grade/);
  }
});

test('NPC interaction builder rejects ambiguous completion and quality-prefix rules', () => {
  for (const change of [
    (rule) => {
      rule.targetGuildId = '1';
    },
    (rule) => {
      rule.completedQuestStep = 3;
    },
    (rule) => {
      rule.initialMaxQuality = 1;
    },
    (rule) => {
      rule.sequence = [];
    },
    (rule) => {
      rule.sequence[0].questId = '5218';
    },
    (rule) => {
      rule.sequence[1].questId = rule.sequence[0].questId;
    },
    (rule) => {
      rule.sequence[1].maxQuality = rule.sequence[0].maxQuality;
    },
    (rule) => {
      rule.sequence[0].maxQuality = 7;
    },
  ]) {
    const raw = input();
    change(raw.friendlyLimits.martialCost.guildFree);
    assert.throws(() => project(raw), /guild-free consultation/);
  }
});
