'use strict';
const fs = require('node:fs');
const path = require('node:path');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
function project(raw) {
  if (raw.schema !== 1 || raw.source.build !== game.build) throw Error('NPC interaction build mismatch');
  const guildFree = raw.friendlyLimits?.martialCost?.guildFree;
  const quality = (value) => Number.isInteger(value) && value >= 1 && value <= 6;
  if (
    !guildFree ||
    !Number.isSafeInteger(guildFree.targetGuildId) ||
    guildFree.targetGuildId < 0 ||
    guildFree.completedQuestStep !== 4 ||
    guildFree.initialMaxQuality !== 0 ||
    !Array.isArray(guildFree.sequence) ||
    !guildFree.sequence.length
  )
    throw Error('Invalid guild-free consultation rule');
  const questIds = new Set();
  let previousQuality = guildFree.initialMaxQuality;
  for (const unlock of guildFree.sequence) {
    if (
      !Number.isSafeInteger(unlock.questId) ||
      unlock.questId <= 0 ||
      questIds.has(unlock.questId) ||
      !quality(unlock.maxQuality) ||
      unlock.maxQuality <= previousQuality
    )
      throw Error('Invalid guild-free consultation sequence');
    questIds.add(unlock.questId);
    previousQuality = unlock.maxQuality;
  }
  const people = Object.fromEntries(
    world.people.map((person) => {
      const row = raw.people[person.gameId];
      if (!row) throw Error('NPC interaction row missing');
      if (!Number.isSafeInteger(row.guildId) || row.guildId < 0)
        throw Error('Invalid NPC interaction guild identity');
      return [
        person.gameId,
        {
          compareRequirements: row.compareRequirements,
          cannotFight: row.bCantFighting,
          guildId: row.guildId,
        },
      ];
    }),
  );
  const skills = Object.fromEntries(
    game.entries
      .filter((row) => row.kind === '武学')
      .map((entry) => {
        const row = raw.skills[entry.gameId];
        if (!row || !Number.isInteger(row.friendliness)) throw Error('Skill interaction row missing');
        if (!quality(row.grade)) throw Error('Invalid skill interaction grade');
        return [
          entry.gameId,
          {
            friendliness: row.friendliness,
            requirements: row.requirements,
            openForPlayer: row.openForPlayer,
            excluded: row.excludedFromNativeConsult,
            skillPointCost: row.ConsultSExpCost,
            grade: row.grade,
          },
        ];
      }),
  );
  return {
    schema: 1,
    build: game.build,
    source: raw.source,
    friendlyLimits: { Compare: raw.friendlyLimits.compareGlobalFriendliness },
    compare: raw.friendlyLimits.compare,
    gift: raw.friendlyLimits.gift,
    martialCost: raw.friendlyLimits.martialCost,
    vigorCost: raw.friendlyLimits.vigor,
    people,
    skills,
  };
}
if (require.main === module) {
  fs.writeFileSync(
    path.join(__dirname, '../src/data/npc-interactions.json'),
    JSON.stringify(project(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2) + '\n',
  );
}
module.exports = { project };
