'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { encyclopedia } = require('../src/core/game-data.cjs');
const load = import(pathToFileURL(path.join(__dirname, '../src/renderer/item-stat-views.js')).href);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
const act = (action, label, cls, id) =>
  `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`;

test('encyclopedia exposes same-build numbers and rendered basics exclude random bonuses', async () => {
  const { createItemStatViews, itemNumericSummary } = await load,
    index = encyclopedia();
  const entry = index.entries.find((row) => row.id === 'item-1029');
  assert.equal(index.itemStats.build, index.build);
  assert.equal(entry.stats.effects[0].value, 637.892578125);
  const html = createItemStatViews({ esc, act }).detail(index, entry);
  const base = html.slice(0, html.indexOf('class="item-random-stats"'));
  assert.match(base, /攻击力.*\+637\.89 点/s);
  assert.match(base, /暴击率.*\+15%/s);
  assert.doesNotMatch(base, /\+172 点|\+4\.5%/);
  assert.match(html, /随机词条候选.*\+172 点.*\+4\.5%/s);
  assert.match(html, /不表示物品掉率或最终词条概率/);
  assert.doesNotMatch(html, /RandRange|RandActionPools|EquipmentRank|池内权重/);
  assert.equal(itemNumericSummary(entry, index), '攻击力 +637.89 点 · 暴击率 +15%');
});

test('medicine, permanent stats, armor and materials render different benefits honestly', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  const html = (id) =>
    view.detail(
      index,
      index.entries.find((e) => e.id === 'item-' + id),
    );
  assert.match(html(100), /气血上限.*\+10 点/s);
  assert.match(html(133), /恢复气血.*\+400 点/s);
  assert.doesNotMatch(html(133), /全队|全体|永久/);
  assert.match(html(139), /经脉点.*\+50 点/s);
  assert.match(html(250), /气血恢复比例.*20%.*真气恢复比例.*20%/s);
  assert.match(html(250), /计算基准尚未核定/);
  assert.match(html(6000), /装备基础数值.*真气上限.*\+41\.14 点/s);
  assert.match(html(10220), /没有直接增加战斗属性/);
  assert.doesNotMatch(html(10220), /数值资料尚未收录/);
  assert.match(html(8094), /随机池在当前原始资料中缺失/);
});

test('fractional percentages and unverified parameters do not receive invented units', async () => {
  const { itemEffectText } = await load,
    { itemStats } = encyclopedia();
  assert.deepEqual(itemEffectText({ type: 'CAttr', id: 53, value: -0.07 }, itemStats), {
    name: '承伤倍率变化',
    value: '-7%',
  });
  assert.deepEqual(itemEffectText({ type: 'CAttr', id: 60, value: 0.15 }, itemStats), {
    name: '暴击伤害加成',
    value: '+15%',
  });
  assert.match(itemEffectText({ type: 'CAttr', id: 58, value: 10 }, itemStats).value, /原始参数/);
});

test('unknown buff ranks, exclusive owners and extracted strings remain safe and explicit', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  const real = index.entries.find((e) => e.id === 'item-1029'),
    modified = structuredClone(real);
  const action = index.itemStats.pools[1029].candidates.find((a) => a.type === 'ABuff');
  modified.stats.effects = [action];
  modified.stats.requirements = [{ type: 'OnlyDesignatedNPC', id: 10016, value: 1 }];
  const buffIndex = structuredClone(index);
  buffIndex.itemStats.buffs[action.id].name = '<img src=x onerror=evil()>奸';
  const html = view.detail(buffIndex, modified);
  assert.match(html, /仅限：江吟风/);
  assert.match(html, /效果数值待核定/);
  assert.match(html, /尚未核定效果等级与数值/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|\{0\}|100%触发|持续3秒|装备要求30级/);
});

test('combined item requirements retain both clickable targets and their quantities', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    entry = index.entries.find((e) => e.id === 'item-10460');
  const html = createItemStatViews({ esc, act }).detail(index, entry);
  assert.match(html, /物品条件（需同时满足）/);
  assert.match(html, /data-id="item-10461">【锻骨法下篇】<\/button> × 1/);
  assert.match(html, /data-id="item-10486">《惔神秘鉴·残》<\/button> × 1/);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.doesNotMatch(html, /另有武学、装备或剧情条件|消耗物品/);
});

test('weapon type conditions and learning targets use verified names without inventing equipment checks', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  for (const [id, type] of [
    [314, '剑法'],
    [324, '剑法'],
    [317, '拳掌'],
    [323, '拳掌'],
    [330, '拳掌'],
  ]) {
    const html = view.detail(
      index,
      index.entries.find((e) => e.id === 'item-' + id),
    );
    assert.ok(html.includes('兵器类型条件：' + type));
    assert.match(html, /具体检查范围尚未核定/);
    assert.match(html, /学习武学/);
    assert.doesNotMatch(html, /必须装备|需要装备|装备剑|装备拳套|学习后.{0,8}1级/);
    if (id === 314) assert.match(html, /data-id="skill-109">天外飞仙剑<\/button>/);
    if (id === 330) assert.match(html, /data-id="skill-483">琢玉手<\/button>/);
    if (id === 324) {
      assert.match(html, /武学 #130（当前图鉴未收录详情/);
      assert.doesNotMatch(html, /data-id="skill-130"/);
    }
  }
});

test('skill level and inner cultivation checks retain objects and parameters without invented comparisons', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  const html = view.detail(
    index,
    index.entries.find((e) => e.id === 'item-13866'),
  );
  assert.match(html, /学习武学：<button[^>]+data-id="skill-866">五恒天经<\/button>/);
  assert.match(
    html,
    /武学等级条件：<button[^>]+data-id="skill-885">五恒天经<\/button>（武学编号 885）；资料参数 1（比较方式尚未核定）/,
  );
  assert.match(html, /学习动作参数：1；初始等级与重复使用效果尚未核定/);
  assert.doesNotMatch(html, /至少|等于|达到|1 级|1级|未学习/);
  const inner = view.detail(
    index,
    index.entries.find((e) => e.id === 'item-307'),
  );
  assert.match(inner, /内功检查：对象编号 0；资料参数 5（检查范围与比较方式尚未核定）/);
  assert.doesNotMatch(inner, /至少|等于|内功.{0,8}5级|内功.{0,8}5 级/);
});

test('quest conditions retain available links and missing references remain explicit', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  const prior = view.detail(
    index,
    index.entries.find((e) => e.id === 'item-10438'),
  );
  assert.match(
    prior,
    /前置任务条件：<button[^>]+data-action="world-quest"[^>]+data-id="quest-28003">查看青云扇法<\/button>/,
  );
  assert.match(prior, /任务编号 28003）；资料参数 1（对应状态尚未核定）/);
  for (const [id, quest] of [
    [10424, 30129],
    [10451, 24103],
  ]) {
    const html = view.detail(
      index,
      index.entries.find((e) => e.id === 'item-' + id),
    );
    assert.ok(html.includes('任务排除条件：任务 #' + quest));
    assert.match(html, /资料参数 0（对应状态尚未核定）/);
    assert.doesNotMatch(html, new RegExp('data-id="quest-' + quest + '"'));
  }
});

test('unknown conditions and absent entries preserve safe reference parameters', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    entry = structuredClone(index.entries.find((e) => e.id === 'item-10460'));
  entry.stats.effects = [{ type: 'ASkill', id: 999999, value: 3 }];
  entry.stats.requirements = [
    { type: 'Item', id: 999998, value: 2 },
    { type: '<img src=x onerror=evil()>', id: 999997, value: 7 },
    { type: 'WeaponRequirement', id: 0, value: 99 },
  ];
  const html = createItemStatViews({ esc, act }).detail(index, entry);
  assert.match(html, /物品 #999998 × 2/);
  assert.match(html, /武学 #999999（当前图鉴未收录详情/);
  assert.match(html, /学习动作参数：3/);
  assert.match(html, /其他使用条件（&lt;img[^<]+&gt;）：对象编号 999997；资料参数 7/);
  assert.match(html, /兵器类型条件：未识别类型（资料参数 99/);
  assert.doesNotMatch(html, /<img|data-id="(?:item-999998|skill-999999)"/);
  const hostile = structuredClone(index);
  hostile.entries.find((e) => e.id === 'skill-109').name = '<svg onload=evil()>武学';
  const learned = createItemStatViews({ esc, act }).detail(
    hostile,
    index.entries.find((e) => e.id === 'item-314'),
  );
  assert.match(learned, /data-id="skill-109">&lt;svg onload=evil\(\)&gt;武学<\/button>/);
  assert.doesNotMatch(learned, /<svg/);
});
