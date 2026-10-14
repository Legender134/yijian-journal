'use strict';
// Select only proved native button identities. Strategy labels and conditional
// outcomes stay in flow-guide; they are never used as native option strings.
const fs = require('node:fs');
const path = require('node:path');
const guide = require('../src/data/flow-guide.cjs');
function project(source, proof = null) {
  if (source.build !== '21798996' || source.schema !== 1) throw Error('Choice contract build mismatch');
  const rules = new Map(guide.rules.map((row) => [row.id, row]));
  const seen = new Set();
  const contracts = source.contracts.map((row) => {
    const rule = rules.get(row.ruleId);
    if (!rule || rule.questId !== row.rootQuestId || seen.has(row.questId))
      throw Error('Choice identity mismatch');
    seen.add(row.questId);
    const indexes = new Set(row.options.map((option) => option.choiceIndex));
    if (
      indexes.size !== rule.choices.length ||
      row.options.length !== rule.choices.length ||
      row.options.some(
        (option) =>
          !Number.isInteger(option.choiceIndex) ||
          !rule.choices[option.choiceIndex] ||
          option.requirements.length,
      )
    )
      throw Error('Choice mapping is incomplete or conditional');
    if (row.npcPolicy !== 'contextual') throw Error('Unproved NPC constraint');
    return {
      ruleId: row.ruleId,
      questId: row.questId,
      rootQuestId: row.rootQuestId,
      npcPolicy: 'contextual',
      options: row.options.map(({ text, choiceIndex }) => ({ text, choiceIndex })),
    };
  });
  return {
    schema: 1,
    build: source.build,
    source: {
      kind: 'Game data and read-only static native/Blueprint analysis',
      pins: source.pins,
      ...(proof ? { proof } : {}),
      npcPolicy:
        'The event NPC is context, not the dialogue speaker. Matching uses the proved quest row and complete native option set.',
    },
    contracts,
  };
}
if (require.main === module) {
  const result = project(
    JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    JSON.parse(fs.readFileSync(process.argv[3], 'utf8')),
  );
  fs.writeFileSync(
    path.join(__dirname, '../src/data/live-choice-contracts.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
}
module.exports = { project };
