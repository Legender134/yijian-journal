'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { encyclopedia } = require('../src/core/game-data.cjs');
const url = (name) => {
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
  source = source.replace(
    /from '(\.\/[^']+)'/g,
    (_, dependency) => 'from ' + JSON.stringify(url(dependency.slice(2))),
  );
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
};
const loaded = Promise.all([
  import(url('entity-catalog.js')),
  import(url('entity-references.js')),
  import(url('entity-detail-views.js')),
  import(url('flow-views.js')),
]);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const factory = (createEntityReferences, index) =>
  createEntityReferences({
    index: () => index,
    esc,
    picture: (id) => `<span data-picture="${esc(id)}"></span>`,
    icon: esc,
    qualityText: { html: (_, text) => text },
  });
const fixture = () => ({
  entries: [
    { id: 'npc-1', gameId: 1, name: '郎中-孙老', kind: '人物', hobbies: ['茶具'] },
    { id: 'npc-2', gameId: 2, name: '莫弃', kind: '人物' },
    { id: 'npc-3', gameId: 3, name: '莫弃', kind: '人物' },
    { id: 'item-9', gameId: 9, name: '铁矿石', kind: '物品' },
    { id: 'item-10', gameId: 10, name: '铁矿石箱', kind: '物品' },
    {
      id: 'item-11',
      gameId: 11,
      name: '金疮药',
      kind: '物品',
      stats: { effects: [{ type: 'CAttr', id: 1, value: 400 }] },
      buyPrice: 100,
      giftable: true,
    },
  ],
  itemStats: { attributes: { 1: { name: '气血', scale: 1, unit: '点' } } },
  images: {},
  world: {
    maps: [],
    quests: [
      { id: 'quest-100', gameId: 100, name: '【支线】送矿石', parentId: 0, description: '找孙老和莫弃。' },
      {
        id: 'quest-101',
        gameId: 101,
        name: '送去矿石',
        parentId: 100,
        finishNPCs: [1],
        materials: [{ id: 9, count: 4 }],
      },
      {
        id: 'quest-102',
        gameId: 102,
        name: '另一分支',
        parentId: 100,
        description: '莫弃提到孙老。',
        materials: [{ id: 9, count: 2 }],
        requirements: [{ type: 'NoQuest', id: 200, value: 1 }],
      },
      { id: 'quest-200', gameId: 200, name: '其他任务', parentId: 0 },
    ],
  },
});

test('inline entity prose escapes untrusted strings, prefers full names and makes same-name choice explicit', async () => {
  const [, { createEntityReferences }] = await loaded,
    index = fixture(),
    refs = factory(createEntityReferences, index);
  const html = refs.text('<img onerror="bad">孙老找铁矿石箱，再找莫弃和送矿石。');
  assert(!html.includes('<img '));
  assert(html.includes('&lt;img onerror=&quot;bad&quot;&gt;'));
  assert(html.includes('data-id="npc-1"'));
  assert(html.includes('data-id="item-10"'));
  assert(!html.includes('data-id="item-9"'));
  assert(html.includes('data-action="entity-choice" data-id="name:莫弃"'));
  assert(!html.includes('data-id="npc-2"'));
  assert(!html.includes('data-id="npc-3"'));
  assert(html.includes('data-id="quest-100"'));
  assert(html.includes('entity-link-label'));
  assert.equal(refs.choices('name:莫弃').length, 2);
});

test('task and person relationships aggregate actual steps without summing alternative material requirements', async () => {
  const [{ entityCatalog }] = await loaded,
    data = entityCatalog(fixture());
  const task = data.taskRelations(data.entries.get('quest-100'));
  assert.equal(task.group.length, 3);
  assert(task.people.find((p) => p.entity.id === 'npc-1').roles.includes('完成人物'));
  assert(task.people.find((p) => p.entity.id === 'npc-2').roles.includes('说明提名（同名身份待核对）'));
  assert.deepEqual(
    task.items[0].via.map((row) => [row.quest.id, row.count]),
    [
      ['quest-101', 4],
      ['quest-102', 2],
    ],
  );
  assert.equal(task.items[0].count, undefined);
  assert.equal(task.requirements[0].type, 'NoQuest');
  assert.equal(task.requirements[0].entity.id, 'quest-200');
  const person = data.personRelations(data.entries.get('npc-1'));
  assert.equal(person.quests.length, 1);
  assert.equal(person.quests[0].entity.id, 'quest-100');
  assert(person.people.some((p) => p.entity.id === 'npc-2'));
  assert(!person.people.some((p) => p.entity.id === 'npc-1'));
});

test('previews use saved-state and template numeric facts and disclose ambiguity and missing records', async () => {
  const [, { createEntityReferences }] = await loaded,
    refs = factory(createEntityReferences, fixture());
  const reference = {
    name: '3.sav',
    metadata: {
      quests: [{ id: 101, step: 1 }],
      inventory: [
        { id: 11, count: 2 },
        { id: 11, count: 3 },
        { id: 11, count: -8 },
      ],
    },
  };
  const item = refs.preview('item-11', { reference });
  assert.match(item, /恢复气血 \+400 点/);
  assert.match(item, /3.sav · 库存 5/);
  assert.match(item, /模板基础/);
  assert.match(refs.preview('quest-101', { reference }), /3.sav · 进行中/);
  assert.match(refs.preview('quest-100', { reference }), /未出现在记录/);
  assert.match(refs.preview('quest-100'), /未核对存档/);
  assert.match(refs.preview('name:莫弃'), /2 条同名资料/);
  assert.equal(refs.preview('npc-999'), '');
});

test('unresolved equipment names retain per-variant qualities without assigning the first quality to the group', async () => {
  const [, { createEntityReferences }] = await loaded;
  const index = fixture();
  index.entries.push(
    { id: 'item-21', gameId: 21, name: '亮银甲', kind: '物品', quality: '白' },
    { id: 'item-22', gameId: 22, name: '亮银甲', kind: '物品', quality: '绿' },
    { id: 'item-23', gameId: 23, name: '亮银甲', kind: '物品', quality: '蓝' },
  );
  const refs = factory(createEntityReferences, index);
  const html = refs.preview('name:亮银甲');
  assert.match(html, /<small>同名资料<\/small>/);
  assert.match(html, /物品 · 白色 · #21/);
  assert.match(html, /物品 · 绿色 · #22/);
  assert.match(html, /物品 · 蓝色 · #23/);
  assert.match(refs.preview('item-22'), /<small>物品 · 绿色<\/small>/);
});

test('detailed relations remain traversable, typed and escaped with per-step state and version-qualified advice', async () => {
  const [{ entityCatalog }, { createEntityReferences }, { createEntityDetailViews }] = await loaded,
    index = fixture(),
    data = entityCatalog(index);
  const view = createEntityDetailViews({
    esc,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    richText: factory(createEntityReferences, index).text,
    guide: () => [
      {
        questId: 100,
        name: '选择提醒',
        recommendation: { action: '先找孙老，备金疮药', reason: '保留选择' },
        affectedTasks: [{ questId: 200, name: '<旧任务>', effect: '莫弃的同名身份待核对' }],
        uncertainty: '旧版社区资料',
      },
    ],
  });
  const reference = { name: '1.sav', metadata: { quests: [{ id: 101, step: 4 }] } };
  const html = view.task(index, data.entries.get('quest-100'), reference);
  assert.match(html, /data-task-relations/);
  assert.match(html, /data-id="npc-1"/);
  assert.match(html, /需 4 件 已完成/);
  assert.match(html, /需 2 件 未出现在记录/);
  assert.match(html, /data-id="quest-200"/);
  assert.match(html, /不合并互斥分支/);
  assert.match(html, /&lt;旧任务&gt;/);
  assert.match(html, /旧版社区资料/);
  const advice = html.match(/<details class="entity-related-advice">[\s\S]*?<\/details>/)[0];
  assert.match(advice, /data-entity-id="npc-1"/);
  assert.match(advice, /data-entity-id="item-11"/);
  assert.match(advice, /data-action="entity-choice" data-id="name:莫弃"/);
  assert.match(advice, /data-action="world-quest" data-id="quest-200">&lt;旧任务&gt;/);
  const person = view.person(index, data.entries.get('npc-1'), reference);
  assert.match(person, /data-person-relations/);
  assert.match(person, /data-id="quest-100"/);
  assert.match(person, /不推断亲属/);
});

test('shipped character and root quest relationships include actual descendants and preserve exact IDs', async () => {
  const [{ entityCatalog }] = await loaded,
    index = encyclopedia(),
    data = entityCatalog(index);
  const cold = data.personRelations(data.entries.get('npc-8001'));
  assert(cold.quests.some((row) => row.entity.gameId === 13000));
  const axe = data.taskRelations(data.entries.get('quest-11002'));
  assert(axe.group.some((q) => q.gameId === 11010));
  assert(axe.people.some((row) => row.entity.id === 'npc-10005'));
  assert(
    axe.items.some(
      (row) =>
        row.entity.id === 'item-10201' &&
        row.via.some(({ quest, count }) => quest.gameId === 11010 && count === 4),
    ),
  );
});

test('expanded community steps and choice effects retain escaped entity previews and ambiguous-name choices', async () => {
  const [, { createEntityReferences }, , { createFlowViews }] = await loaded;
  const index = fixture(),
    references = factory(createEntityReferences, index);
  const view = createFlowViews({
    esc,
    act: references.button,
    icon: esc,
    pill: esc,
    when: esc,
    richText: references.text,
  });
  const html = view.panel({
    guide: [
      {
        id: 'guide',
        name: '攻略',
        steps: ['先找孙老，再问莫弃。<img onerror="bad">'],
        choices: [{ label: '把金疮药送给孙老', effect: '莫弃的分支需核对' }],
      },
    ],
  });
  const steps = html.match(/<ol class="flow-guide-steps">[\s\S]*?<\/ol>/)[0];
  assert.match(steps, /data-entity-id="npc-1"/);
  assert.match(steps, /data-action="entity-choice" data-id="name:莫弃"/);
  assert.match(steps, /&lt;img onerror=&quot;bad&quot;&gt;/);
  const choices = html.match(/<dl>[\s\S]*?<\/dl>/)[0];
  assert.match(choices, /data-entity-id="item-11"/);
  assert.match(choices, /data-id="name:莫弃"/);
  assert.doesNotMatch(html, /<img onerror/);
});
