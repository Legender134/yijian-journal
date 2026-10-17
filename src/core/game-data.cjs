'use strict';
const data = require('../data/game-index.json');
const world = require('../data/world-index.json');
const mapAtlas = require('../data/world-map.json');
const images = require('../data/game-images.json');
const itemStats = require('../data/item-stats.json');
const npcFacts = require('../data/npc-facts.json');
const codex = require('../data/codex-details.json');
const skillConsultation = require('../data/npc-interactions.json').skills;
const materialGuide = require('../data/material-guide.cjs');
const taskTargets = require('./task-targets.cjs').createTaskTargetProjector(world, materialGuide.items);
const taskObjectives = Object.fromEntries(world.quests.map((q) => [q.id, taskTargets.template(q)]));
if (String(codex.build) !== String(data.build)) throw Error('图鉴详情版本不一致');
const flowGuide = require('../data/flow-guide.cjs');
const { giftPersonHint } = require('./gift-labels.cjs');
const identityEntries = [...new Map([...data.entries, ...world.people].map((row) => [row.id, row])).values()];
const gatheringRoutes = Object.fromEntries(
  Object.entries(materialGuide.items)
    .map(([id, item]) => [
      id,
      item.routes
        .filter((route) => ['gather', 'drop'].includes(route.kind))
        .map((route) => ({
          ...route,
          sources: route.sourceIds.map((id) => ({ ...materialGuide.sources[id], id: 'material:' + id })),
        })),
    ])
    .filter(([, routes]) => routes.length),
);
const { createNpcProgressProjector } = require('./npc-progress.cjs');
const projectNpcProgress = createNpcProgressProjector({
  world,
  game: data,
  contracts: require('../data/npc-interactions.json'),
  guide: require('../data/duel-guide.cjs'),
});
if (String(itemStats.build) !== String(data.build)) throw Error('物品数值与图鉴版本不一致');
if (String(npcFacts.build) !== String(data.build)) throw Error('人物私物与图鉴版本不一致');
if (String(mapAtlas.build) !== String(data.build)) throw Error('地图与图鉴版本不一致');
const { recipeOutputs } = require('./recipe-outputs.cjs');
const entries = new Map(data.entries.map((e) => [e.id, e]));
const difficulty = {
  Easy: '简单',
  Common: '普通',
  Normal: '普通',
  Difficult: '困难',
  Difficulty: '困难',
  Hell: '极难',
};
function enrich(metadata) {
  if (!metadata) return null;
  const result = { ...metadata, mapName: data.maps[metadata.map] || metadata.map || '未知场景' };
  if (metadata.teamIds)
    result.team = metadata.teamIds.map((id) => ({ id, name: data.npcNames[id] || `角色 #${id}` }));
  if (metadata.fightTeamIds)
    result.fightTeam = metadata.fightTeamIds.map((id) => ({ id, name: data.npcNames[id] || `角色 #${id}` }));
  if (metadata.trackingQuest)
    result.quest = data.quests[metadata.trackingQuest] || {
      name: `任务 #${metadata.trackingQuest}`,
      description: '',
    };
  if (metadata.trackingMainQuest)
    result.mainQuest = data.quests[metadata.trackingMainQuest] || {
      name: `主线 #${metadata.trackingMainQuest}`,
      description: '',
    };
  if (metadata.difficulty)
    result.difficultyName = difficulty[metadata.difficulty.split('::').pop()] || '未识别';
  if (metadata.inventory)
    result.inventory = metadata.inventory.map((item) => ({
      ...item,
      name: entries.get(`item-${item.id}`)?.name || `物品 #${item.id}`,
      type: entries.get(`item-${item.id}`)?.type || '其他',
    }));
  // Keep validated native states, including hidden story gates. The named
  // quest list remains filtered for presentation; absence there is not absence
  // in the save and must not leave a known deadline window open.
  if (metadata.quests) result.questStates = metadata.quests.map(({ id, step }) => ({ id, step }));
  if (metadata.quests)
    result.quests = metadata.quests
      .filter((q) => data.quests[q.id])
      .map((q) => ({
        ...q,
        ...data.quests[q.id],
        status: ['未开始', '进行中', '已失败', '未接取', '已完成'][q.step],
      }));
  if (result.quests) {
    const byId = new Map(result.quests.map((q) => [q.id, q]));
    const families = new Map();
    for (const q of result.quests.filter((q) => q.step === 1)) {
      let root = q;
      const seen = new Set([q.id]);
      while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
        root = byId.get(root.parentId);
        seen.add(root.id);
      }
      const family = families.get(root.id) || {
        id: root.id,
        name: root.name,
        status: root.status,
        step: root.step,
        activeSteps: [],
      };
      if (q.id !== root.id) family.activeSteps.push({ id: q.id, name: q.name, status: q.status });
      families.set(root.id, family);
    }
    result.activeQuestFamilies = [...families.values()].sort(
      (a, b) => Number(b.id === metadata.trackingMainQuest) - Number(a.id === metadata.trackingMainQuest),
    );
  }
  result.dataBuild = data.build;
  if (metadata.combat?.npcStates) result.npcProgress = projectNpcProgress(result);
  return result;
}
function encyclopedia() {
  return {
    build: data.build,
    source: data.source,
    notice: data.notice,
    entries: [
      ...new Map(
        [...data.entries, ...world.people].map((e) => [
          e.id,
          e.kind === '配方'
            ? { ...e, outputReference: recipeOutputs(e, 1) }
            : e.kind === '物品'
              ? {
                  ...e,
                  stats: itemStats.items[e.gameId] || null,
                  ...(gatheringRoutes[e.gameId] ? { gatheringRoutes: gatheringRoutes[e.gameId] } : {}),
                  ...(flowGuide.itemRoutes[e.gameId]
                    ? {
                        acquisitionRoutes: flowGuide.itemRoutes[e.gameId].map((route) => ({
                          ...route,
                          sources: route.sourceIds.map((id) => ({
                            ...flowGuide.sources[id],
                            id: 'flow:' + id,
                          })),
                        })),
                      }
                    : {}),
                }
              : e.kind === '人物'
                ? {
                    ...e,
                    npcFacts: npcFacts.people[e.gameId] || null,
                    identityHint: giftPersonHint(e, identityEntries),
                  }
                : e,
        ]),
      ).values(),
    ],
    codex,
    skillConsultation,
    images: images.entries,
    merchants: data.merchants || [],
    itemStats: {
      build: itemStats.build,
      notice: itemStats.notice,
      attributes: itemStats.attributes,
      pools: itemStats.pools,
      buffs: itemStats.buffs,
    },
    npcFacts: {
      build: npcFacts.build,
      source: npcFacts.source,
      notice: npcFacts.notice,
      pools: npcFacts.pools,
    },
    world: {
      ...world,
      mapAtlas,
      placeAliases: require('../data/world-place-aliases.json'),
      objectives: taskObjectives,
    },
  };
}
function recipePlan(id, quantity, inventory = null) {
  const e = entries.get(id);
  if (!e || e.kind !== '配方') throw Error('配方不存在');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) throw Error('制作次数须为 1 至 999');
  const owned = new Map();
  if (inventory) {
    if (!Array.isArray(inventory) || inventory.length > 10000) throw Error('库存记录无效');
    for (const i of inventory) {
      if (
        !Number.isSafeInteger(i.id) ||
        !Number.isSafeInteger(i.count) ||
        i.count < 0 ||
        i.count > 1000000000000
      )
        throw Error('库存数量无效');
      owned.set(i.id, (owned.get(i.id) || 0) + i.count);
    }
  }
  return {
    id,
    name: e.name,
    targetName: e.results[0]?.name || e.name,
    quantity,
    money: e.money * quantity,
    materials: e.materials.map((m) => {
      const have = (m.alternatives || [m.id]).reduce((sum, id) => sum + (owned.get(id) || 0), 0);
      return {
        ...m,
        count: m.count * quantity,
        ...(inventory ? { owned: have, missing: Math.max(0, m.count * quantity - have) } : {}),
      };
    }),
    results: e.results,
  };
}
module.exports = { enrich, encyclopedia, recipePlan };
