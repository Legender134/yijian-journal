'use strict';
// A small, deterministic projection of same-build static tables, never player saves.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BUILD = '21798996';
const FILES = {
  items: 'Items-simple.json',
  pools: 'RandActionPools-simple.json',
  buffs: 'Buffs-simple.json',
  formats: 'AffixDisplay-simple.json',
  attributes: 'AttributeTypes-simple.json',
};
// IDs come from AttributeTypes-simple.json, derived from the matching static PE
// enum registration pairs. Labels were checked against that binary and item text.
const LABELS = {
  Health: '气血',
  MaxHealth: '气血上限',
  Mana: '真气',
  MaxMana: '真气上限',
  Level: '等级',
  Strength: '力道',
  Constitution: '根骨',
  Agility: '身法',
  AttackPower: '攻击力',
  Crit: '暴击率',
  Defense: '防御力',
  Dodge: '闪避',
  ActionPoint: '行动力',
  TurnRate: '集气速率',
  BoxingLevel: '拳掌精通',
  BoxingExp: '拳掌熟练',
  FencingLevel: '剑法精通',
  FencingExp: '剑法熟练',
  SabreLevel: '刀法精通',
  SabreExp: '刀法熟练',
  HiddenWeaponsLevel: '暗器精通',
  HiddenWeaponsExp: '暗器熟练',
  SpearLevel: '枪棍精通',
  SpearExp: '枪棍熟练',
  OtherWeaponsLevel: '奇门精通',
  OtherWeaponsExp: '奇门熟练',
  DaZaoLevel: '锻造等级',
  DaZaoExp: '锻造经验',
  NeiLi: '内功',
  JingLi: '精力',
  MaxJingLi: '精力上限',
  ZhiYiLevel: '制衣等级',
  ZhiYiExp: '制衣经验',
  CritResistance: '暴击抵抗',
  Accuracy: '命中',
  BeDamageMultiplier: '承伤倍率变化',
  EscapeSuccrate: '逃跑成功率',
  MoneyMultiplier: '钱币掉落倍率参数',
  SExpMultiplier: '武学获得倍率参数',
  WorldMoveSpeed: '世界地图移动速度加成参数',
  SceneMoveSpeed: '场景移动速度加成参数',
  CritDamagePercent: '暴击伤害加成',
  FishingLevel: '钓鱼等级',
  FishingExp: '钓鱼经验',
  CookingLevel: '烹饪等级',
  CookingExp: '烹饪经验',
  AlchemyLevel: '炼丹等级',
  AlchemyExp: '炼丹经验',
  GatheringLevel: '采集等级',
  GatheringExp: '采集经验',
};
const clean = (value) =>
  String(value || '')
    .replace(/<[^>]*>/g, '')
    .trim();
const enumKey = (value) =>
  String(value || '')
    .split('::')
    .pop();
function number(value, label) {
  if (!['number', 'string'].includes(typeof value) || value === '') throw Error(`Invalid ${label}`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw Error(`Invalid ${label}`);
  return n;
}
function integer(value, label) {
  const n = number(value, label);
  if (!Number.isSafeInteger(n) || n < 0) throw Error(`Invalid ${label}`);
  return n;
}
function projectAction(row) {
  const type = enumKey(row?.Type);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(type)) throw Error('Invalid action type');
  return { type, id: integer(row.Id, 'action ID'), value: number(row.Num, 'action value') };
}
function rowMap(rows, key, label) {
  if (!Array.isArray(rows)) throw Error(`Missing ${label} table`);
  const result = new Map();
  for (const row of rows) {
    const id = integer(row[key], `${label} ID`);
    if (result.has(id)) throw Error(`Duplicate ${label} ${id}`);
    result.set(id, row);
  }
  return result;
}
function buildItemStats({ gameIndex, items, pools, buffs, formats, attributes, provenance }) {
  if (
    gameIndex?.build !== BUILD ||
    provenance?.schema !== 1 ||
    provenance.build !== BUILD ||
    provenance.source?.kind !== 'owned-installed-game-static-tables' ||
    !/^[a-f0-9]{64}$/.test(provenance.attributeEnumSource?.sha256 || '') ||
    !Object.values(FILES).every((file) => /^[a-f0-9]{64}$/.test(provenance.tables?.[file] || ''))
  ) {
    throw Error('Item statistics require verified same-build static provenance');
  }
  const itemRows = rowMap(items, 'Id', 'item');
  const poolRows = rowMap(pools, 'Id', 'pool');
  const buffRows = rowMap(buffs, 'id', 'buff');
  const attrRows = rowMap(attributes, 'Id', 'attribute');
  if (!Array.isArray(formats)) throw Error('Missing attribute display table');
  const outputItems = {},
    outputPools = {},
    outputBuffs = {},
    outputAttrs = {};
  const neededAttrs = new Set(),
    neededPools = new Set(),
    neededBuffs = new Set();
  function remember(action) {
    if (
      ['CAttr', 'CAllAttr', 'CHealthAttrPercent', 'CBlueAttrPercent', 'AttrLow', 'AttrHigh'].includes(
        action.type,
      )
    )
      neededAttrs.add(action.id);
    if (['ABuff', 'ABattleCountBuff', 'ARealTimeBuff'].includes(action.type)) neededBuffs.add(action.id);
    return action;
  }
  const selected = gameIndex.entries
    .filter((entry) => entry.kind === '物品')
    .sort((a, b) => a.gameId - b.gameId);
  for (const entry of selected) {
    if (
      !Number.isSafeInteger(entry.gameId) ||
      entry.gameId < 100 ||
      /测试|test|Test|已废弃|废弃|弃用|模板/.test(entry.name)
    )
      throw Error(`Invalid selected item ${entry.gameId}`);
    const raw = itemRows.get(entry.gameId);
    if (!raw || clean(raw.Name) !== entry.name || enumKey(raw.ItemType) !== entry.typeKey)
      throw Error(`Item source mismatch ${entry.gameId}`);
    if (outputItems[entry.gameId]) throw Error(`Duplicate selected item ${entry.gameId}`);
    const random = [];
    for (const [source, rangeKey] of [
      ['RandActionPools', 'RandRange'],
      ['NormalRandActionPools', 'NormalRandRange'],
    ]) {
      if (!Array.isArray(raw[source]) || !Array.isArray(raw[rangeKey]))
        throw Error(`Invalid random data ${entry.gameId}`);
      const poolIds = raw[source].map((id) => integer(id, 'random pool ID'));
      const range = raw[rangeKey].map((n) => integer(n, 'random range'));
      poolIds.forEach((id) => neededPools.add(id));
      if (poolIds.length || range.length) random.push({ source, poolIds, range });
    }
    if (!Array.isArray(raw.Actions) || !Array.isArray(raw.Requirements) || typeof raw.bCantUse !== 'boolean')
      throw Error(`Invalid item data ${entry.gameId}`);
    outputItems[entry.gameId] = {
      equipmentRank: integer(raw.EquipmentRank, 'equipment rank'),
      usable: !raw.bCantUse,
      effects: raw.Actions.map((a) => remember(projectAction(a))),
      requirements: raw.Requirements.map((a) => remember(projectAction(a))),
      random,
    };
  }
  for (const id of [...neededPools].sort((a, b) => a - b)) {
    const pool = poolRows.get(id);
    if (!pool) {
      outputPools[id] = { candidates: [], unresolved: true };
      continue;
    }
    if (!Array.isArray(pool.ActionWeights)) throw Error(`Invalid random pool ${id}`);
    outputPools[id] = {
      candidates: pool.ActionWeights.map((row) => {
        const weight = number(row.Weight, 'pool weight');
        if (weight < 0) throw Error('Invalid pool weight');
        return { ...remember(projectAction(row.Action)), weight };
      }),
    };
  }
  for (const id of [...neededAttrs].sort((a, b) => a - b)) {
    const raw = attrRows.get(id);
    if (!raw || !/^[A-Za-z][A-Za-z0-9_]*$/.test(raw.Key)) throw Error(`Missing attribute ${id}`);
    const modes = new Set(
      formats
        .filter((f) => enumKey(f.ActionType) === 'CAttr' && f.ActionId === id)
        .map((f) => enumKey(f.NumberType)),
    );
    const percent100 = [...modes].some((m) => m.startsWith('Percent100_'));
    const percent = [...modes].some((m) => m.startsWith('Percent_'));
    if (percent100 && percent) throw Error(`Conflicting attribute units ${id}`);
    const uncertain = /Multiplier|MoveSpeed/.test(raw.Key) || !LABELS[raw.Key];
    outputAttrs[id] = {
      key: raw.Key,
      name: LABELS[raw.Key] || `附加属性 #${id} (${raw.Key})`,
      unit: percent100 || percent ? '%' : uncertain ? '原始参数' : '点',
      scale: percent100 ? 100 : 1,
      precision: 2,
    };
  }
  for (const id of [...neededBuffs].sort((a, b) => a - b)) {
    const raw = buffRows.get(id);
    if (!raw) throw Error(`Missing buff ${id}`);
    outputBuffs[id] = {
      name: clean(raw.ViewName),
      description: clean(raw.Description),
      modifiers: Array.from({ length: 10 }, (_, i) =>
        number(raw[`ModifierValue${i || ''}`], 'buff modifier'),
      ),
      durations: [1, 4, 7, 10].map((n) => number(raw[`Duration${n}`], 'buff duration')),
      period: number(raw.Period, 'buff period'),
      chance: number(raw.Chance, 'buff chance'),
      stackLimit: integer(raw.StackLimit, 'buff stack limit'),
    };
  }
  return {
    schema: 1,
    build: BUILD,
    source: '本机同版本游戏静态资料表与属性枚举',
    notice:
      '基础效果是物品模板资料值，展示取两位小数，不代表随机词条结算后的实际面板。随机池列候选与池内权重，权重不是掉率；区间按原字段保留，未核定抽取机制。增益数值与动作参数保留原值，未验证的等级代入与单位不作推算。',
    provenance: {
      source: provenance.source,
      tools: provenance.tools,
      attributeEnumSource: provenance.attributeEnumSource,
      tables: provenance.tables,
    },
    attributes: outputAttrs,
    pools: outputPools,
    buffs: outputBuffs,
    items: outputItems,
  };
}
function readInputs(inputDir, gameIndex) {
  const provenance = JSON.parse(fs.readFileSync(path.join(inputDir, 'source-manifest.json'), 'utf8'));
  const inputs = {};
  for (const [key, file] of Object.entries(FILES)) {
    const bytes = fs.readFileSync(path.join(inputDir, file));
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (provenance.tables?.[file] !== hash) throw Error(`Static input hash mismatch: ${file}`);
    inputs[key] = JSON.parse(bytes);
  }
  return { gameIndex, provenance, ...inputs };
}
if (require.main === module) {
  const base = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  let inputDir = path.join(base, '.downloads/game-json');
  let output = path.join(base, 'src/data/item-stats.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input-dir' && args[i + 1]) inputDir = path.resolve(args[++i]);
    else if (args[i] === '--output' && args[i + 1]) output = path.resolve(args[++i]);
    else throw Error(`Unknown or incomplete option ${args[i]}`);
  }
  const gameIndex = JSON.parse(fs.readFileSync(path.join(base, 'src/data/game-index.json'), 'utf8'));
  const data = buildItemStats(readInputs(inputDir, gameIndex));
  fs.writeFileSync(output, JSON.stringify(data));
  console.log({
    build: data.build,
    items: Object.keys(data.items).length,
    pools: Object.keys(data.pools).length,
    buffs: Object.keys(data.buffs).length,
    bytes: fs.statSync(output).size,
  });
}
module.exports = { BUILD, FILES, buildItemStats, projectAction, readInputs };
