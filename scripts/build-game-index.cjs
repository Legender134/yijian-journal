'use strict';
// Offline projection of locally exported game tables.
// Extraction inputs stay in .downloads and are never bundled wholesale.
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(base, '.downloads/game-json', `${name}-simple.json`), 'utf8'));
const clean = (text) =>
  String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
const enumName = (text) =>
  String(text || '')
    .split('::')
    .pop();
const validName = (text) => text && !/测试|test|Test|已废弃|废弃|弃用|模板/.test(text);
const types = {
  Sword: '剑',
  Sabre: '刀',
  Clothing: '衣服',
  Hat: '冠帽',
  Shoes: '鞋靴',
  Ornament: '饰品',
  Drug: '药品',
  QuestItem: '任务物品',
  Drug_Health: '气血药品',
  None: '其他',
  Letter: '书信',
  Recipe: '配方',
  Drug_Stamina: '药品 / 饮食',
  Pill: '丹药',
  NoteBook: '笔记',
  Skip25: '其他',
  Treasure: '珍宝',
  Skip26: '其他',
  Spear: '枪棍',
  Fist: '拳套',
  HiddenWeapon: '暗器',
  Paint: '字画',
  Worm: '虫类',
  Chess: '棋具',
  TeaSet: '茶具',
  Book: '书籍',
  Lyra: '琴',
  Flower: '花卉',
  Mineral: '矿石',
  Wood: '木材',
  Plant: '药材',
  Leather: '皮革',
  Food: '食材',
  SwordBook: '剑法秘籍',
  SabreBook: '刀法秘籍',
  SpearBook: '枪棍秘籍',
  FistBook: '拳掌秘籍',
  HiddenWeaponBook: '暗器秘籍',
  DodgeBook: '轻功秘籍',
  InsideSkillBook: '心法秘籍',
  Default: '其他',
  OtherWeapons: '奇门兵器',
};
const quality = {
  White: '白',
  Green: '绿',
  Blue: '蓝',
  Purple: '紫',
  Orange: '橙',
  Gold: '金',
  DarkGold: '暗金',
  Red: '红',
};
const maps = Object.fromEntries(
  read('Maps')
    .filter((r) => r.MapName !== 'None' && validName(r.ViewName))
    .map((r) => [r.MapName, clean(r.ViewName)]),
);
const npcs = read('NPCs');
const npcNames = Object.fromEntries(npcs.filter((r) => validName(r.Name)).map((r) => [r.Id, clean(r.Name)]));
const quests = Object.fromEntries(
  read('Quests')
    .filter((r) => r.bIsShow && validName(r.Name))
    .map((r) => [
      r.QuestId,
      {
        name: clean(r.Name),
        description: clean(r.Descript),
        parentId: r.OwnerQuestId,
        kind: enumName(r.ClassFlag),
      },
    ]),
);
const rawItems = read('Items');
const items = rawItems
  .filter((r) => r.Id >= 100 && validName(r.Name))
  .map((r) => ({
    id: `item-${r.Id}`,
    gameId: r.Id,
    kind: '物品',
    name: clean(r.Name),
    description: clean(r.Description),
    type: types[enumName(r.ItemType)] || '其他',
    typeKey: enumName(r.ItemType),
    quality: quality[enumName(r.Quality)] || '',
    buyPrice: r.BuyPrice,
    sellPrice: r.SellPrice,
    giftable: !r.bCantGift,
    useLimit: r.UsedCountLimit || 0,
  }));
const itemById = Object.fromEntries(items.map((r) => [r.gameId, r]));
const merchants = npcs
  .filter((r) => validName(r.Name) && !r.bNotShowInUI && r.SellItems.length)
  .map((r) => ({
    id: r.Id,
    name: clean(r.Name),
    description: clean(r.Description),
    items: [...new Set(r.SellItems.filter((id) => itemById[id]))],
  }))
  .filter((r) => r.items.length);
const groups = Object.fromEntries(
  read('Aggregation').map((r) => [
    r.Id,
    { name: clean(r.GroupName), description: clean(r.Desc), alternatives: r.ItemList },
  ]),
);
for (const r of read('Quests'))
  if (quests[r.QuestId]) {
    const materials = r.FinishingRequirements.filter((x) => x.Type === 'ERequirementType::Item').map((x) => ({
      id: x.Id,
      name: itemById[x.Id]?.name || `物品 #${x.Id}`,
      count: Number(x.Num),
    }));
    if (materials.length) quests[r.QuestId].materials = materials;
  }
const skills = read('Skills')
  .filter((r) => r.bOpenForPlayer && validName(r.ViewName))
  .map((r) => ({
    id: `skill-${r.Id}`,
    gameId: r.Id,
    kind: '武学',
    name: clean(r.ViewName),
    description: clean(r.Description),
    special: clean(r.SpecialEffectDesc),
    type: types[enumName(r.WeaponType)] || '心法 / 轻功',
    quality: quality[enumName(r.Quality)] || '',
    consultCost: Number(r.ConsultSExpCost) || 0,
  }));
const people = npcs
  .filter(
    (r) =>
      validName(r.Name) && r.Hobbies.length && r.Functions.some((f) => f.Function === 'ENPCFunction::Gift'),
  )
  .map((r) => ({
    id: `npc-${r.Id}`,
    gameId: r.Id,
    kind: '人物',
    name: clean(r.Name),
    description: clean(r.Description),
    type: '赠礼偏好',
    hobbies: r.Hobbies.map((t) => types[enumName(t)] || enumName(t)),
    hobbyKeys: r.Hobbies.map(enumName),
    recruitable: r.Functions.some((f) => f.Function === 'ENPCFunction::AddToTeam'),
  }));
const recipes = read('Fusions')
  .filter((r) => r.Id >= 1000 && validName(r.Name))
  .map((r) => ({
    id: `fusion-${r.Id}`,
    gameId: r.Id,
    kind: '配方',
    recipeType: 'fusion',
    craft: r.LevelLimits.some((x) => x.Id === 48) ? '制衣' : '锻造',
    name: clean(r.Name),
    description: clean(r.Description),
    type: types[enumName(r.ItemType)] || '锻造',
    level: Number(r.LevelLimits.find((x) => x.Type === 'ERequirementType::AttrLow')?.Num) || 0,
    money: r.Money,
    materials: r.Requirements.filter((x) => x.Type === 'ERequirementType::Item').map((x) => ({
      id: x.Id,
      name: itemById[x.Id]?.name || `物品 #${x.Id}`,
      count: Number(x.Num),
    })),
    results: r.Results.filter((x) => x.Action.Type === 'EActionType::CItem').map((x) => ({
      id: x.Action.Id,
      name: itemById[x.Action.Id]?.name || `物品 #${x.Action.Id}`,
      count: Number(x.Action.Num),
      weight: x.Weight,
    })),
  }));
recipes.push(
  ...read('Alchemy')
    .filter((r) => validName(r.RecipeName))
    .map((r) => ({
      id: `alchemy-${r.Id}`,
      gameId: r.Id,
      kind: '配方',
      recipeType: 'alchemy',
      craft: '炼丹',
      name: clean(r.RecipeName),
      description: clean(r.Desc),
      type: '炼丹',
      level: r.AlchemyLv,
      money: r.MoneyConsumption,
      materials: r.Material.map((id, i) => ({
        id,
        name: itemById[id]?.name || `物品 #${id}`,
        count: r.MaterialConsumption[i],
      })),
      results: [{ id: r.ItemId, name: itemById[r.ItemId]?.name || clean(r.RecipeName), count: 1, weight: 1 }],
    })),
);
recipes.push(
  ...read('Cooking')
    .filter((r) => validName(r.RecipeName))
    .map((r) => ({
      id: `cooking-${r.Id}`,
      gameId: r.Id,
      kind: '配方',
      recipeType: 'cooking',
      craft: '烹饪',
      name: clean(r.RecipeName),
      description: clean(r.Desc),
      type: '烹饪',
      level: r.CookingLv,
      money: r.MoneyConsumption,
      materials: r.Material.map((id, i) =>
        r.MaterialType[i] === 1
          ? { id: null, groupId: id, ...groups[id], count: r.MaterialConsumption[i] }
          : { id, name: itemById[id]?.name || `物品 #${id}`, count: r.MaterialConsumption[i] },
      ),
      results: [{ id: r.ItemId, name: itemById[r.ItemId]?.name || clean(r.RecipeName), count: 1, weight: 1 }],
    })),
);
const recipeById = Object.fromEntries(recipes.map((r) => [r.id, r]));
const recipeActions = { ARecipe: 'fusion', AAlchemyRecipe: 'alchemy', ACookingRecipe: 'cooking' };
for (const raw of rawItems) {
  const item = itemById[raw.Id];
  if (!item || raw.bCantUse) continue;
  for (const action of raw.Actions) {
    const prefix = recipeActions[enumName(action.Type)];
    const recipe = prefix && recipeById[`${prefix}-${action.Id}`];
    if (!recipe) continue;
    item.teachesRecipes ||= [];
    recipe.learningItems ||= [];
    if (!item.teachesRecipes.includes(recipe.id)) item.teachesRecipes.push(recipe.id);
    if (!recipe.learningItems.includes(item.gameId)) recipe.learningItems.push(item.gameId);
  }
}
for (const r of recipes) {
  const used = new Set();
  for (const m of r.materials) {
    if (!m.name || !Number.isFinite(m.count) || m.count <= 0) throw Error(`Invalid material in ${r.id}`);
    for (const id of m.alternatives || [m.id]) {
      if (used.has(id)) throw Error(`Overlapping interchangeable materials in ${r.id}`);
      used.add(id);
      if (!itemById[id]) throw Error(`Unknown material ${id}`);
    }
  }
}
const data = {
  schema: 1,
  build: '21798996',
  generatedAt: new Date().toISOString(),
  source: '本机已安装的《逸剑风云决》游戏资料表',
  notice:
    '本机游戏资料的只读索引，含可能未在当前周目开放的内容。数值与配方以游戏内实际界面为准；不同版本可能有差异。',
  maps,
  npcNames,
  quests,
  merchants,
  entries: [...items, ...skills, ...people, ...recipes],
};
fs.writeFileSync(path.join(base, 'src/data/game-index.json'), JSON.stringify(data));
console.log({
  maps: Object.keys(maps).length,
  npcNames: Object.keys(npcNames).length,
  quests: Object.keys(quests).length,
  items: items.length,
  skills: skills.length,
  people: people.length,
  merchants: merchants.length,
  recipes: recipes.length,
  bytes: fs.statSync(path.join(base, 'src/data/game-index.json')).size,
});
