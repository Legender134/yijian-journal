'use strict';
// Read-only projection of the same Build's named quest and skill tables.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { value } = require('./inspect-tables.cjs');
const game = require('../src/data/game-index.json');
const world = require('../src/data/world-index.json');
const pins = {
  quests: '45303fedd1778387ecfc26ff842251ba83e2057f9dbe90c3803a074a44c131d1',
  skills: '1ef5e9f6debaaab410d11b331ea3869ba09f6f90926ee079200df34523e29313',
};
const clean = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .trim();
const triples = (rows = []) =>
  rows
    .map((r) => ({ type: String(r.Type).split('::').pop(), id: Number(r.Id), value: Number(r.Num) }))
    .filter((r) => Number.isInteger(r.id) && Number.isFinite(r.value));
const effectTypes = new Set([
  'CItem',
  'CMoney',
  'CYHD',
  'ASExp',
  'AJingMaiPoint',
  'CQuestStep',
  'ASkill',
  'ATeam',
  'RTeam',
]);
function project(questRows, skillRows, gameData = game, worldData = world) {
  const quests = {};
  for (const entry of worldData.quests) {
    // One source ID is reused by an unnamed internal row. Match the shipped
    // name and parent as well; never silently select one of two named variants.
    const matches = questRows.filter(
      (r) => r.QuestId === entry.gameId && clean(r.Name) === entry.name && r.OwnerQuestId === entry.parentId,
    );
    if (matches.length !== 1) throw Error(`Quest identity mismatch: ${entry.id}`);
    const raw = matches[0];
    const effects = (rows) => triples(rows).filter((r) => effectTypes.has(r.type));
    const finish = ['FinishedActions', 'FinishedActionsForDifficulty', 'FinishedActionsForHell'].map((key) =>
      effects(raw[key]),
    );
    const choices = [1, 2, 3, 4, 5].flatMap((n) => {
      const text = clean(raw['OptionText' + n]);
      const actions = effects(raw['OptionActions' + n]);
      return text && actions.length
        ? [{ text, requirements: triples(raw['OptionRequirements' + n]), actions }]
        : [];
    });
    if (finish.some((rows) => rows.length) || choices.length) quests[entry.gameId] = { finish, choices };
  }
  const skills = {};
  for (const entry of gameData.entries.filter((e) => e.kind === '武学')) {
    const matches = skillRows.filter((r) => r.Id === entry.gameId && clean(r.ViewName) === entry.name);
    if (matches.length !== 1) throw Error(`Skill identity mismatch: ${entry.id}`);
    const raw = matches[0];
    const levelUnlockRequirements = (raw.LevelUnLockReqs || []).map((row) => ({
      level: Number(row.Level),
      requirements: triples(row.Reqs),
    }));
    skills[entry.gameId] = {
      growth: Array.from({ length: 10 }, (_, n) =>
        triples(raw['LvUpAction' + (n + 1)]).filter((r) => r.type === 'CAttr'),
      ),
      ...(levelUnlockRequirements.length ? { levelUnlockRequirements } : {}),
    };
  }
  return {
    schema: 1,
    build: gameData.build,
    source: { kind: 'owned-installed-game-static-tables', inputs: pins },
    quests,
    skills,
  };
}
function readPinned(file, pin) {
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== pin)
    throw Error('Codex source hash mismatch');
  return JSON.parse(bytes);
}
if (require.main === module) {
  const questRows = readPinned(process.argv[2], pins.quests).map(value);
  const skills = readPinned(process.argv[3], pins.skills)
    .Exports.find((e) => e.Table)
    .Table.Data.map(value);
  const result = project(questRows, skills);
  fs.writeFileSync(path.join(__dirname, '../src/data/codex-details.json'), JSON.stringify(result) + '\n');
  console.log({
    questsWithEffects: Object.keys(result.quests).length,
    skills: Object.keys(result.skills).length,
  });
}
module.exports = { project };
