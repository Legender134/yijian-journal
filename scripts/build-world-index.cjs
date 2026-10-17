'use strict';
// A selective offline projection. Plot placements are deliberately kept distinct
// from quest interaction targets; a scene rearrangement is not a destination.
const fs = require('node:fs');
const path = require('node:path');
const { projectCompletionRequirements } = require('./quest-completion-data.cjs');
const base = path.resolve(__dirname, '..');
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(base, '.downloads/game-json', `${name}-simple.json`), 'utf8'));
const data = require('../src/data/game-index.json');
const clean = (v) =>
  String(v || '')
    .replace(/<[^>]*>/g, '')
    .trim();
const valid = (v) => v && !/测试|test|Test|已废弃|废弃|弃用|模板/.test(v);
const enumName = (v) =>
  String(v || '')
    .split('::')
    .pop();
const rawQuests = read('Quests');
const allQuests = new Map(rawQuests.map((q) => [q.QuestId, q]));
const originalPeople = new Map(data.entries.filter((e) => e.kind === '人物').map((e) => [e.gameId, e]));
const originalItems = new Map(data.entries.filter((e) => e.kind === '物品').map((e) => [e.gameId, e]));
const itemTypes = new Map(data.entries.filter((e) => e.kind === '物品').map((e) => [e.typeKey, e.type]));
const rawPeople = read('NPCs');
const npcById = new Map(rawPeople.map((n) => [n.Id, n]));
const completionContext = {
  quests: allQuests,
  npcNames: new Map(rawPeople.map((n) => [n.Id, clean(n.Name)])),
  items: originalItems,
  itemGroups: new Map(read('Aggregation').map((row) => [row.Id, row])),
  npcGroups: new Map(read('NPCAggregation').map((row) => [row.Id, row])),
  guilds: new Map(read('Guilds').map((row) => [row.Id, row])),
  published: new Set(Object.keys(data.quests).map(Number)),
};
const maps = read('Maps')
  .filter((m) => data.maps[m.MapName])
  .map((m) => ({
    id: `place-${m.MapId}`,
    gameId: m.MapId,
    key: m.MapName,
    name: data.maps[m.MapName],
    cave: !!m.bInCave,
  }));
const mapByKey = new Map(maps.map((m) => [m.key, m]));
const names = (ids) => [...new Set(ids)].filter((id) => valid(npcById.get(id)?.Name));
// Keep the hidden condition ID for evaluation; its owner is a navigation clue only.
const storyCondition = (id, personName) => {
  // Quest 12681 is a named-NPC conversation after the Tan City incident.
  if (id === 12681) return { name: '谭城之乱后与李元兴交谈' };
  let current = allQuests.get(id);
  const seen = new Set([id]);
  while (current?.OwnerQuestId && !seen.has(current.OwnerQuestId)) {
    const ownerId = current.OwnerQuestId;
    seen.add(ownerId);
    if (data.quests[ownerId])
      return {
        name: clean(data.quests[ownerId].name).replace(/^【[^】]+】\s*/, '') + '相关剧情',
        relatedQuestId: ownerId,
      };
    current = allQuests.get(ownerId);
  }
  return { name: personName + '相关剧情' };
};
const requirement = (r, personName = '') => {
  const type = enumName(r.Type),
    value = Number(r.Num);
  if (type === 'None' || !Number.isFinite(value)) return null;
  const hiddenStory = personName && ['PreQuest', 'NoQuest'].includes(type) && !data.quests[r.Id];
  return {
    type,
    id: r.Id,
    value,
    ...(hiddenStory
      ? storyCondition(r.Id, personName)
      : {
          name:
            type === 'PreQuest' || type === 'NoQuest'
              ? clean(allQuests.get(r.Id)?.Name) || '任务步骤 #' + r.Id
              : type === 'Item'
                ? originalItems.get(r.Id)?.name || '物品 #' + r.Id
                : clean(npcById.get(r.Id)?.Name) || '',
        }),
  };
};
const requirements = (list, personName = '') =>
  (list || []).map((r) => requirement(r, personName)).filter(Boolean);
const quests = Object.entries(data.quests).map(([id, q]) => {
  const raw = allQuests.get(Number(id));
  const placements = [
    ['request', raw.RequestNPCLocation],
    ['finish', raw.FinishNPCLocation],
  ].flatMap(([phase, list]) =>
    list
      .filter((p) => p.IsVisible && mapByKey.has(p.MapName))
      .map((p) => ({
        phase,
        npcId: p.NPCId,
        mapKey: p.MapName,
        inHouse: !!p.IsInHouse,
        interactionTarget: (phase === 'request' ? raw.RequestNPCIds : raw.FinishNPCIds).includes(p.NPCId),
      })),
  );
  return {
    id: `quest-${id}`,
    gameId: Number(id),
    ...q,
    requestNPCs: names(raw.RequestNPCIds),
    finishNPCs: names(raw.FinishNPCIds),
    requirements: requirements(raw.RequestRequirements),
    ...(raw.FinishingRequirements?.some((row) => enumName(row.Type) !== 'None')
      ? { finishingRequirements: projectCompletionRequirements(raw.FinishingRequirements, completionContext) }
      : {}),
    placements,
  };
});
const relatedNpcIds = new Set(quests.flatMap((q) => [...q.requestNPCs, ...q.finishNPCs]));
const people = rawPeople
  .filter(
    (n) =>
      valid(n.Name) &&
      !n.bNotShowInUI &&
      (originalPeople.has(n.Id) ||
        n.SellItems.length ||
        relatedNpcIds.has(n.Id) ||
        n.Functions.some((f) => ['Compare', 'Consult', 'Gift', 'AddToTeam'].includes(enumName(f.Function)))),
  )
  .map((n) => {
    const original = originalPeople.get(n.Id);
    const lifeFields = {
      DaZaoLevel: '锻造',
      ZhiYiLevel: '制衣',
      AlchemyLevel: '炼丹',
      CookingLevel: '烹饪',
      GatheringLevel: '采集',
      FishingLevel: '钓鱼',
    };
    return {
      ...(original || {
        id: `npc-${n.Id}`,
        gameId: n.Id,
        kind: '人物',
        name: clean(n.Name),
        description: clean(n.Description),
        type: '人物资料',
        hobbies: n.Hobbies.map((type) => itemTypes.get(enumName(type)) || enumName(type)),
        hobbyKeys: n.Hobbies.map(enumName),
      }),
      functions: n.Functions.map((f) => enumName(f.Function)),
      recruitable: n.Functions.some((f) => f.Function === 'ENPCFunction::AddToTeam'),
      lifeSkills: Object.entries(lifeFields)
        .filter(([field]) => Number(n[field]) > 0)
        .map(([field, name]) => ({ name, level: Number(n[field]) })),
      skills: n.SkillList.filter((s) => data.entries.some((e) => e.id === `skill-${s.Id}`)).map((s) => ({
        id: `skill-${s.Id}`,
        level: Number(s.Value),
      })),
      friendshipLocks: n.FriendlinessLockSettings.map((l) => ({
        at: Number(l.FriendlinessLock),
        requirements: requirements(l.ReqirementsForUnlock, clean(n.Name)),
      })),
      joinRequirements: requirements(n.JoinTeamRequirements),
      walkMap: mapByKey.has(n.WalkLevelName) ? n.WalkLevelName : '',
    };
  });
const referenced = new Set(
  quests.flatMap((q) => [...q.requestNPCs, ...q.finishNPCs, ...q.placements.map((p) => p.npcId)]),
);
const npcNames = Object.fromEntries(
  [...referenced].filter((id) => valid(npcById.get(id)?.Name)).map((id) => [id, clean(npcById.get(id).Name)]),
);
const result = {
  schema: 1,
  build: data.build,
  generatedAt: new Date().toISOString(),
  source: data.source,
  maps,
  quests,
  people,
  npcNames,
};
const output = path.join(base, 'src/data/world-index.json');
fs.writeFileSync(output, JSON.stringify(result));
console.log({
  maps: maps.length,
  quests: quests.length,
  rootQuests: quests.filter((q) => !q.parentId).length,
  people: people.length,
  bytes: fs.statSync(output).size,
});
