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
  assert.match(html, /随机词条.*\+172 点.*\+4\.5%/s);
  assert.match(html, /每件装备随机获得其中部分词条/);
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
  assert.match(html(6000), /装备基础数值.*真气上限.*\+41\.14 点/s);
  assert.equal(html(10220), '', 'inert materials need no empty numeric panel');
  assert.doesNotMatch(html(10220), /数值资料尚未收录/);
  assert.match(html(8094), /随机池在当前原始资料中缺失/);
});

test('gift packs name the awarded equipment rather than hiding it as an unknown effect', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  for (const [source, target, name] of [
    [248, 8082, '逸剑风云决'],
    [332, 2063, '万法唯识'],
  ]) {
    const entry = index.entries.find((row) => row.id === 'item-' + source);
    assert.deepEqual(
      entry.stats.effects.filter((row) => row.type === 'ARandItem'),
      [{ type: 'ARandItem', id: target, value: 1 }],
    );
    const html = view.detail(index, entry);
    assert.match(
      html,
      new RegExp(`获得物品：<button[^>]+data-id="item-${target}">${name}</button>（随机词条）`),
    );
    assert.match(html, /× 1/);
    assert.doesNotMatch(html, /掉落池|学习或剧情物品/);
  }
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
  assert.match(html, /仅限：<button[^>]+data-id="npc-10016">江吟风<\/button>/);
  assert.match(html, /效果数值待核定/);
  assert.doesNotMatch(html, /效果等级 \d|持续\d秒/);
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

test('known character restrictions use shared links while unknown owners stay unlinked', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    entry = structuredClone(index.entries.find((row) => row.id === 'item-1029'));
  entry.stats.requirements = [
    { type: 'OnlyDesignatedNPC', id: 10016, value: 1 },
    { type: 'ExcludeNPC', id: 999999, value: 1 },
  ];
  const { createEntityReferences } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/entity-references.js')).href
  );
  const references = createEntityReferences({
    index: () => index,
    esc,
    picture: (id) => `<span data-picture="${esc(id)}"></span>`,
    icon: esc,
    qualityText: { html: (_id, label) => label },
  });
  const view = createItemStatViews({ esc, act: references.button, richText: references.text });
  const html = view.detail(index, entry);
  assert.match(html, /仅限：<button[^>]+data-entity-id="npc-10016"[^>]*>.*江吟风<\/span><\/button>/);
  assert.match(html, /不适用人物 · 1 位<\/summary><p>未收录人物/);
  assert.doesNotMatch(html, /data-id="npc-999999"|#999999|&lt;button/);
  let checked = 0;
  for (const item of index.entries.filter((row) => row.kind === '物品' && row.stats)) {
    const restrictions = item.stats.requirements.filter((r) =>
      ['OnlyDesignatedNPC', 'ExcludeNPC'].includes(r.type),
    );
    if (!restrictions.length) continue;
    const rendered = view.detail(index, item);
    for (const r of restrictions) {
      const id = 'npc-' + r.id;
      if (index.entries.some((row) => row.id === id)) {
        assert.ok(rendered.includes(`data-entity-id="${id}"`), `${item.id} must retain ${id}`);
        checked++;
      } else assert.ok(!rendered.includes(`data-entity-id="${id}"`));
    }
  }
  assert.ok(checked > 10);
  const namesake = view.detail(
    index,
    index.entries.find((row) => row.id === 'item-307'),
  );
  assert.match(namesake, /data-entity-id="npc-5029"/);
  assert.doesNotMatch(namesake, /data-entity-id="name:莫弃"/);
  assert.match(namesake, /<details class="item-excluded-people"><summary>不适用人物/);
  assert.match(namesake, /\d+ 位人物资料未收录/);
  assert.doesNotMatch(namesake, /未收录人物、未收录人物|另有学习或剧情效果/);
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
    assert.match(html, /学习武学/);
    assert.doesNotMatch(html, /必须装备|需要装备|装备剑|装备拳套|学习后.{0,8}1级/);
    if (id === 314) assert.match(html, /data-id="skill-109">天外飞仙剑<\/button>/);
    if (id === 330) assert.match(html, /data-id="skill-483">琢玉手<\/button>/);
    if (id === 324) {
      assert.match(html, /学习武学：未收录武学/);
      assert.doesNotMatch(html, /data-id="skill-130"/);
    }
  }
});

test('skill level and inner cultivation checks retain named objects and unresolved conditions without invented comparisons', async () => {
  const { createItemStatViews } = await load,
    index = encyclopedia(),
    view = createItemStatViews({ esc, act });
  const html = view.detail(
    index,
    index.entries.find((e) => e.id === 'item-13866'),
  );
  assert.match(html, /学习武学：<button[^>]+data-id="skill-866">五恒天经<\/button>/);
  assert.match(html, /武学等级条件：<button[^>]+data-id="skill-885">五恒天经<\/button> · 判定条件待确认/);
  assert.doesNotMatch(html, /至少|等于|达到|1 级|1级|未学习|武学编号|学习动作参数|资料参数/);
  const inner = view.detail(
    index,
    index.entries.find((e) => e.id === 'item-307'),
  );
  assert.match(inner, /内功条件待确认/);
  assert.doesNotMatch(inner, /至少|等于|内功.{0,8}5级|内功.{0,8}5 级|对象编号|资料参数/);
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
  assert.match(prior, /查看青云扇法<\/button> · 进行中/);
  assert.match(prior, /查看青云扇法<\/button><\/span><strong>触发结算/);
  assert.doesNotMatch(prior, /所需状态待确认|另有学习或剧情效果/);
  assert.doesNotMatch(prior, /任务编号|资料参数/);
  for (const [id, quest] of [
    [10424, 30129],
    [10451, 24103],
  ]) {
    const html = view.detail(
      index,
      index.entries.find((e) => e.id === 'item-' + id),
    );
    assert.ok(html.includes('任务排除条件：未收录任务'));
    assert.match(html, /尚未触发/);
    assert.doesNotMatch(html, new RegExp('data-id="quest-' + quest + '"'));
  }
});

test('item quest events use native dispatch meanings rather than saved quest states', async () => {
  const { createItemStatViews } = await load;
  const index = encyclopedia();
  const view = createItemStatViews({ esc, act });
  const item = index.entries.find((row) => row.id === 'item-10438');
  for (const [value, label] of [
    [0, '发起接取'],
    [1, '确认接取'],
    [2, '拒绝接取'],
    [3, '触发推进'],
    [4, '触发结算'],
  ]) {
    const html = view.detail(index, {
      ...item,
      stats: { ...item.stats, effects: [{ type: 'JumpStep', id: 28003, value }], requirements: [] },
    });
    assert.match(html, new RegExp(`查看青云扇法</button></span><strong>${label}</strong>`));
    assert.doesNotMatch(html, /→|已完成|未开始|未接取|进行中|失败/);
  }
  const unknown = view.detail(index, {
    ...item,
    stats: { ...item.stats, effects: [{ type: 'JumpStep', id: 28003, value: 99 }], requirements: [] },
  });
  assert.doesNotMatch(unknown, /发起接取|确认接取|拒绝接取|触发推进|触发结算|已完成/);
});

test('unknown conditions and absent entries remain safe without exposing implementation parameters', async () => {
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
  assert.match(html, /未收录物品 × 2/);
  assert.match(html, /学习武学：未收录武学/);
  assert.match(html, /其他使用条件待确认/);
  assert.match(html, /兵器类型条件：未识别类型/);
  assert.doesNotMatch(
    html,
    /<img|data-id="(?:item-999998|skill-999999)"|学习动作参数|对象编号|资料参数|#\d+/,
  );
  const hostile = structuredClone(index);
  hostile.entries.find((e) => e.id === 'skill-109').name = '<svg onload=evil()>武学';
  const learned = createItemStatViews({ esc, act }).detail(
    hostile,
    index.entries.find((e) => e.id === 'item-314'),
  );
  assert.match(learned, /data-id="skill-109">&lt;svg onload=evil\(\)&gt;武学<\/button>/);
  assert.doesNotMatch(learned, /<svg/);
});

test('the trade fold respects prohibited items and preserves ordinary or unknown sale price facts', async () => {
  const { createGameViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/game-views.js')).href
  );
  const view = createGameViews({
    esc,
    act,
    icon: () => '',
    iconButton: () => '',
    picture: () => '',
    pill: esc,
    notice: esc,
    empty: esc,
    qualityText: { html: (_id, name) => esc(name), label: () => '', name: (_entry, name) => esc(name) },
  });
  const index = encyclopedia();
  const trade = (data, id) =>
    view
      .detail(data, 'item-' + id)
      .match(/<details class="detail-block item-trade-details"[\s\S]*?<\/details>/)[0];
  for (const id of [8065, 247, 10041, 10070, 10347, 10501]) {
    const entry = index.entries.find((row) => row.id === 'item-' + id);
    assert.equal(entry.stats.cantSell, true);
    assert.ok(entry.sellPrice > 0);
    const html = trade(index, id);
    assert.match(html, /<small>卖出<\/small><strong>不可出售<\/strong>/);
    assert.doesNotMatch(html, /卖出基础价/);
    assert.doesNotMatch(html, /<details[^>]*\sopen|可以出售/);
    assert.ok(html.includes(entry.buyPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 文'));
    assert.ok(html.includes(entry.giftable ? '可以赠送' : '不可赠送'));
  }
  for (const id of [100, 1029]) {
    const entry = index.entries.find((row) => row.id === 'item-' + id);
    const html = trade(index, id);
    assert.ok(
      html.includes(
        '<small>卖出基础价</small><strong>' +
          entry.sellPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) +
          ' 文</strong>',
      ),
    );
    assert.doesNotMatch(html, /不可出售|可以出售/);
  }
  const unknown = structuredClone(index);
  const entry = unknown.entries.find((row) => row.id === 'item-247');
  entry.stats = null;
  const missing = trade(unknown, 247);
  assert.match(missing, /卖出基础价/);
  assert.doesNotMatch(missing, /不可出售|可以出售/);
  entry.stats = { ...index.entries.find((row) => row.id === entry.id).stats, cantSell: 'true' };
  assert.equal(
    trade(unknown, 247),
    missing,
    'truthy unverified flags must not imply a restriction or permission',
  );
});
