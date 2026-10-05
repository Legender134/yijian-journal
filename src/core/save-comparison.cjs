'use strict';
const data = require('../data/game-index.json');
const entries = new Map(data.entries.map((e) => [e.id, e]));
const states = ['未开始', '进行中', '已失败', '未接取', '已完成'];
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN') || String(a.id).localeCompare(String(b.id));
function membership(left, right, key = 'id') {
  if (!Array.isArray(left) || !Array.isArray(right)) return { available: false, leftOnly: [], rightOnly: [] };
  const a = new Map(left.map((x) => [x[key], x])),
    b = new Map(right.map((x) => [x[key], x]));
  return {
    available: true,
    leftOnly: [...a.values()].filter((x) => !b.has(x[key])).sort(byName),
    rightOnly: [...b.values()].filter((x) => !a.has(x[key])).sort(byName),
  };
}
function inventoryMap(items) {
  const result = new Map();
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.count) || item.count < 0)
      throw Error('库存记录无效');
    const count = (result.get(item.id)?.count || 0) + item.count;
    if (!Number.isSafeInteger(count)) throw Error('库存数量超出可比较范围');
    result.set(item.id, { ...item, count });
  }
  return result;
}
function compareRecords(left, right) {
  const a = left.metadata,
    b = right.metadata;
  if (!a || !b) throw Error('两份存档都须能读取后才能比较');
  const inventory = { available: Array.isArray(a.inventory) && Array.isArray(b.inventory), changes: [] };
  if (inventory.available) {
    const before = inventoryMap(a.inventory),
      after = inventoryMap(b.inventory);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const l = before.get(id),
        r = after.get(id),
        leftCount = l?.count || 0,
        rightCount = r?.count || 0;
      if (leftCount !== rightCount)
        inventory.changes.push({
          id,
          name: r?.name || l?.name || `物品 #${id}`,
          type: r?.type || l?.type || '其他',
          quality: entries.get(`item-${id}`)?.quality || '',
          left: leftCount,
          right: rightCount,
          delta: rightCount - leftCount,
        });
    }
    inventory.changes.sort(byName);
  }
  const quests = { available: Array.isArray(a.quests) && Array.isArray(b.quests), changes: [] };
  if (quests.available) {
    const before = new Map(a.quests.map((q) => [q.id, q])),
      after = new Map(b.quests.map((q) => [q.id, q]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const l = before.get(id),
        r = after.get(id);
      if (l?.step !== r?.step)
        quests.changes.push({
          id,
          name: r?.name || l?.name || `任务 #${id}`,
          parentId: r?.parentId || l?.parentId || null,
          left: l ? states[l.step] : '未出现在记录',
          right: r ? states[r.step] : '未出现在记录',
          leftStep: l?.step ?? null,
          rightStep: r?.step ?? null,
        });
    }
    quests.changes.sort(byName);
  }
  const families = [
    ['fusionRecipes', 'fusion', '锻造/制衣'],
    ['alchemyRecipes', 'alchemy', '炼丹'],
    ['cookingRecipes', 'cooking', '烹饪'],
  ];
  const recipes = families.map(([field, prefix, name]) => {
    const map = (list) =>
      Array.isArray(list)
        ? list.map((value) => {
            const id = `${prefix}-${value}`;
            return { id, name: entries.get(id)?.name || `${name}配方 #${value}`, known: entries.has(id) };
          })
        : null;
    return { name, ...membership(map(a[field]), map(b[field])) };
  });
  const recap = (file) => {
    const m = file.metadata;
    return {
      name: file.name,
      modifiedAt: file.modifiedAt,
      mapName: m.mapName,
      playSeconds: m.playSeconds,
      money: m.money ?? null,
      difficultyName: m.difficultyName || '',
      mainQuest: m.mainQuest?.name || '',
      sideQuest: m.quest?.name || '',
    };
  };
  return {
    comparedAt: new Date().toISOString(),
    left: recap(left),
    right: recap(right),
    moneyDelta: Number.isSafeInteger(a.money) && Number.isSafeInteger(b.money) ? b.money - a.money : null,
    playSecondsDelta:
      Number.isSafeInteger(a.playSeconds) && Number.isSafeInteger(b.playSeconds)
        ? b.playSeconds - a.playSeconds
        : null,
    inventory,
    quests,
    team: membership(a.team, b.team),
    fightTeam: membership(a.fightTeam, b.fightTeam),
    recipes,
  };
}
module.exports = { compareRecords };
