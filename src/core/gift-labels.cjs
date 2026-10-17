'use strict';
const game = require('../data/game-index.json'),
  world = require('../data/world-index.json');
const facts = require('../data/npc-facts.json').people;
const canonical = new Map(
  [...game.entries, ...world.people].filter((row) => row.kind === '人物').map((row) => [row.id, row]),
);
const quests = new Map(world.quests.map((row) => [row.gameId, row]));
const roots = (quest) => {
  const seen = new Set();
  while (quest.parentId && !seen.has(quest.gameId)) {
    seen.add(quest.gameId);
    const parent = quests.get(quest.parentId);
    if (!parent) break;
    quest = parent;
  }
  return quest.name.replace(/^【[^】]+】/, '');
};
const knownFacts = (person) => {
  const source = canonical.get(person.id);
  if (!source || source.name !== person.name || source.gameId !== person.gameId) return [];
  const level = facts[person.gameId]?.level;
  return [
    Number.isSafeInteger(level) && level > 0 ? '初始等级 ' + level : '',
    ...new Set(
      world.quests
        .filter(
          (quest) =>
            (quest.requestNPCs || []).includes(person.gameId) ||
            (quest.finishNPCs || []).includes(person.gameId) ||
            (quest.placements || []).some((row) => row.npcId === person.gameId),
        )
        .map((quest) => '关联' + roots(quest)),
    ),
  ].filter(Boolean);
};
// Initial static facts distinguish exact identities; they are not live level/location.
function giftPersonHint(person, entries) {
  if (!person) return '';
  const variants = entries.filter((row) => row.kind === '人物' && row.name === person.name);
  if (variants.length < 2) return '';
  const all = variants.map(knownFacts),
    at = variants.findIndex((row) => row.id === person.id);
  if (at < 0) return '';
  return all[at].find((fact) => !all.some((other, index) => index !== at && other.includes(fact))) || '';
}
function giftItemLabel(item) {
  return item ? (item.quality ? item.name + '（' + item.quality + '色品质）' : item.name) : '';
}
function giftPersonLabel(person, entries) {
  if (!person) return '';
  const sameName = entries.filter((row) => row.kind === '人物' && row.name === person.name);
  if (sameName.length < 2) return person.name;
  const hint =
    giftPersonHint(person, entries) ||
    '同名 ' + (sameName.findIndex((row) => row.id === person.id) + 1) + '/' + sameName.length;
  return person.name + '（' + hint + '）';
}
module.exports = { giftItemLabel, giftPersonLabel, giftPersonHint };
