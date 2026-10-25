'use strict';
// Offline projection of the same Build's complete quest table and skill table.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { value } = require('./inspect-tables.cjs');
const game = require('../src/data/game-index.json');
const world = require('../src/data/world-index.json');
const blueprintSource = require('./codex-blueprint-outcomes.json');
const sequenceSource = require('./codex-sequence-outcomes.json');
const pins = {
  questsFullTableData: 'f1ddf79d01d5d143512ce55b1007b19cd8dc5c57c48ff00cb3ee396f5ef5fecf',
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
  'CAttr',
  'ARandItem',
  'ANormalRandItem',
  'CMoney',
  'CYHD',
  'ASExp',
  'AJingMaiPoint',
  'CQuestStep',
  'ASkill',
  'ATeam',
  'RTeam',
  'CGuildHonor',
]);
const rewardTypes = new Set([...effectTypes].filter((type) => type !== 'CQuestStep'));
const actionLists = (detail) => [
  ...detail.finish,
  ...detail.choices.map((choice) => choice.actions),
  detail.failed || [],
  ...(detail.events || []).flatMap((event) => [event.success, event.failure]),
];
function outcome(raw) {
  // Preserve the source triples, including unhandled actions. The renderer
  // interprets only verified types; a missing interpretation is not no effect.
  const finish = ['FinishedActions', 'FinishedActionsForDifficulty', 'FinishedActionsForHell'].map((key) =>
    triples(raw[key]),
  );
  const choices = [1, 2, 3, 4, 5].flatMap((n) => {
    const text = clean(raw['OptionText' + n]);
    return text
      ? [
          {
            text,
            requirements: triples(raw['OptionRequirements' + n]),
            actions: triples(raw['OptionActions' + n]),
          },
        ]
      : [];
  });
  const failed = triples(raw.FailedActions);
  const events = [1, 2, 3].flatMap((index) => {
    const success = triples(raw['ProcessedActions' + index]);
    const failure = triples(raw['ProcessFailedActions' + index]);
    return success.length || failure.length ? [{ index, success, failure }] : [];
  });
  return { finish, choices, ...(failed.length ? { failed } : {}), ...(events.length ? { events } : {}) };
}
function project(questRows, skillRows, gameData = game, worldData = world) {
  const quests = {},
    hiddenSteps = {};
  const published = new Map(worldData.quests.map((entry) => [entry.gameId, entry]));
  const byId = new Map();
  for (const raw of questRows) {
    const rows = byId.get(raw.QuestId) || [];
    rows.push(raw);
    byId.set(raw.QuestId, rows);
  }
  // These four static outcomes were verified in this Build's Blueprint bytecode.
  // Match the original unique row, owner and full class path before attaching;
  // synthetic or other-build inputs must not acquire invented production rows.
  const detailFor = (raw) => {
    const detail = outcome(raw);
    const verified = blueprintSource.steps.find((step) => step.questId === raw.QuestId);
    if (
      verified &&
      String(gameData.build) === blueprintSource.build &&
      byId.get(raw.QuestId)?.length === 1 &&
      raw.OwnerQuestId === verified.ownerId &&
      raw.Blueprint?.AssetPath?.AssetName === verified.blueprint
    )
      detail.blueprintOutcomes = [
        {
          condition: verified.condition,
          actions: verified.actions.map((action) => ({ ...action })),
          source: {
            ...blueprintSource.source,
            build: blueprintSource.build,
            blueprint: verified.blueprint,
            ...verified.source,
          },
        },
      ];
    const sequence = sequenceSource.steps.find((step) => step.questId === raw.QuestId);
    if (
      sequence &&
      String(gameData.build) === sequenceSource.build &&
      byId.get(raw.QuestId)?.length === 1 &&
      raw.OwnerQuestId === sequence.ownerId &&
      raw.Name === sequence.name &&
      raw.Blueprint?.AssetPath?.AssetName === sequence.blueprint &&
      raw.FinishSequence?.AssetPath?.AssetName === sequence.finishSequence
    )
      detail.sequenceOutcomes = sequence.outcomes.map((event) => ({
        condition: event.condition,
        actions: event.actions.map((action) => ({ ...action })),
        source: {
          ...sequenceSource.source,
          build: sequenceSource.build,
          finishSequence: sequence.finishSequence,
          ...sequence.source,
          ...event.source,
        },
      }));
    return detail;
  };
  for (const entry of worldData.quests) {
    // One source ID is reused by an unnamed internal row. Match the shipped
    // name and parent as well; never silently select one of two named variants.
    const matches = (byId.get(entry.gameId) || []).filter(
      (r) => r.QuestId === entry.gameId && clean(r.Name) === entry.name && r.OwnerQuestId === entry.parentId,
    );
    if (matches.length !== 1) throw Error(`Quest identity mismatch: ${entry.id}`);
    const detail = detailFor(matches[0]);
    if (
      detail.blueprintOutcomes?.length ||
      detail.sequenceOutcomes?.length ||
      detail.choices.length ||
      actionLists(detail).some((rows) => rows.some((a) => effectTypes.has(a.type)))
    )
      quests[entry.gameId] = detail;
  }
  for (const raw of questRows) {
    if (published.has(raw.QuestId) || byId.get(raw.QuestId).length !== 1) continue;
    const detail = detailFor(raw);
    if (
      !detail.blueprintOutcomes?.length &&
      !detail.sequenceOutcomes?.length &&
      !detail.choices.length &&
      !actionLists(detail).some((rows) => rows.some((a) => rewardTypes.has(a.type)))
    )
      continue;
    const seen = new Set([raw.QuestId]),
      ownerPath = [];
    let ownerId = raw.OwnerQuestId,
      relatedQuestId;
    while (ownerId && !seen.has(ownerId)) {
      seen.add(ownerId);
      const owners = byId.get(ownerId);
      if (owners?.length !== 1) break;
      ownerPath.push(ownerId);
      if (published.has(ownerId)) {
        relatedQuestId = ownerId;
        break;
      }
      ownerId = owners[0].OwnerQuestId;
    }
    if (!relatedQuestId) continue;
    hiddenSteps[raw.QuestId] = {
      ownerId: raw.OwnerQuestId,
      ownerPath,
      relatedQuestId,
      requirements: triples(raw.RequestRequirements),
      finishingRequirements: triples(raw.FinishingRequirements),
      ...detail,
    };
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
    source: {
      kind: 'owned-installed-game-static-tables',
      inputs: pins,
      questTable: {
        uassetSha256: 'ca4fb2762930e4473fa10301678874e9ebbe4d0ee97b4a193b6ae71badcf3e41',
        uexpSha256: '2d84daae1fc93fc6f098fd5897091704960581d305adffd2f42a26315a881a86',
      },
      actionProgramSha256: '946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c',
    },
    quests,
    hiddenSteps,
    skills,
  };
}
function readPinned(file, pin) {
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== pin)
    throw Error('Codex source hash mismatch');
  return JSON.parse(bytes);
}
async function readQuestRows(file) {
  const hash = crypto.createHash('sha256');
  const rows = [];
  let raw = '',
    depth = 0,
    quoted = false,
    escaped = false,
    started = false,
    done = false;
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
    hash.update(chunk);
    let start = depth ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (!depth) {
        if (/\s/.test(c) || c === ',') continue;
        if (!started && c === '[') {
          started = true;
          continue;
        }
        if (started && !done && c === ']') {
          done = true;
          continue;
        }
        if (!started || done || c !== '{') throw Error('Expected complete quest Table.Data array');
        start = i;
        depth = 1;
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (!depth) {
        raw += chunk.slice(start, i + 1);
        rows.push(value(JSON.parse(raw)));
        raw = '';
        start = -1;
      }
    }
    if (depth) raw += chunk.slice(start);
  }
  if (!done || depth || quoted) throw Error('Truncated quest Table.Data array');
  if (hash.digest('hex') !== pins.questsFullTableData) throw Error('Codex source hash mismatch');
  return rows;
}
async function main() {
  const questRows = await readQuestRows(process.argv[2]);
  const skills = readPinned(process.argv[3], pins.skills)
    .Exports.find((e) => e.Table)
    .Table.Data.map(value);
  const result = project(questRows, skills);
  fs.writeFileSync(path.join(__dirname, '../src/data/codex-details.json'), JSON.stringify(result) + '\n');
  console.log({
    questsWithEffects: Object.keys(result.quests).length,
    hiddenSteps: Object.keys(result.hiddenSteps).length,
    skills: Object.keys(result.skills).length,
  });
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { project };
