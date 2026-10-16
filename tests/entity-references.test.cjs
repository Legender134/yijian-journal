'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { encyclopedia } = require('../src/core/game-data.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const url = (name) => {
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
  source = source.replace(
    /from '(\.\.?\/[^']+)'/g,
    (_, dependency) => 'from ' + JSON.stringify(url(path.posix.join(path.posix.dirname(name), dependency))),
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

test('NPC previews use their exact saved or live cohort across catalogue, flow and detail contexts', async () => {
  const [, { createEntityReferences }] = await loaded;
  const { enrich } = require('../src/core/game-data.cjs');
  const { readMetadata } = require('../src/core/save-reader.cjs');
  const { syntheticSave } = require('./fixtures.cjs');
  const index = encyclopedia(),
    references = factory(createEntityReferences, index);
  const makeReference = (name, hash, inventory) => ({
    name,
    hash,
    metadata: enrich(
      readMetadata(
        syntheticSave({
          full: true,
          quests: [],
          map: 'LV_25_P',
          npcs: [
            { id: 0, attributes: { 44: 100 } },
            { id: 10038, attributes: { 5: 15 }, inventory, friendliness: [[0, 70]], map: 'LV_25_P' },
          ],
        }),
        { details: true },
      ),
    ),
  });
  const empty = makeReference('1.sav', 'a'.repeat(64), []);
  const remaining = makeReference('2.sav', 'b'.repeat(64), [{ id: 100034, count: 2 }]);
  const before = JSON.stringify({ empty, remaining });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const at = source.indexOf('  context: async (target) => {', source.indexOf('const entityPreviews'));
  const end = source.indexOf('\n  },\n});', at);
  const state = {
    currentDrawer: null,
    referenceSave: empty,
    referenceSaveName: empty.name,
    referenceFollow: false,
    worldView: { reference: empty },
    route: 'database',
    defaultFollow: () => false,
    defaultReference: () => empty.name,
    currentFlow: () => ({ reference: empty, active: [] }),
    entityPreviewReference: null,
    environment: { saves: { files: [empty, remaining] } },
    call: async (_method, name) => (name === empty.name ? empty : remaining),
  };
  const context = require('node:vm').runInNewContext(
    source.slice(
      source.indexOf('function followsLiveWorld()'),
      source.indexOf('async function showWorldDetail('),
    ) +
      '\n(' +
      source.slice(at + '  context: '.length, end + 4) +
      ')',
    state,
  );
  const target = { dataset: { action: 'database-detail', id: 'npc-10038' }, closest: () => null };
  const preview = async () => references.preview('npc-10038', await context(target));
  for (const drawer of [
    null,
    { type: 'save', data: empty },
    { type: 'entity-choice', reference: empty },
    { type: 'database' },
    { type: 'world-quest' },
  ]) {
    state.currentDrawer = drawer;
    assert.match(await preview(), /私物已清空/);
    assert.doesNotMatch(await preview(), /固定私物/);
  }
  state.currentDrawer = null;
  target.closest = () => true;
  assert.match(await preview(), /私物已清空/, 'flow previews use the exact verified saved hash');
  target.closest = () => null;
  state.defaultFollow = () => true;
  state.referenceFollow = true;
  state.defaultReference = () => remaining.name;
  state.currentFlow = () => ({ reference: remaining, liveReference: null });
  assert.match(await preview(), /私物还剩 1 种/, 'after live withdrawal the latest saved bag is used');
  state.currentFlow = () => ({
    liveReference: { origin: 'live', metadata: {} },
    duels: { progress: empty.metadata.npcProgress },
  });
  assert.match(await preview(), /私物已清空/, 'an explicit live cohort takes priority over saved state');
  state.defaultFollow = () => false;
  state.referenceFollow = false;
  state.defaultReference = () => '';
  assert.doesNotMatch(await preview(), /私物已清空|私物还剩/, 'lookup-only mode cannot borrow either cohort');
  assert.match(await preview(), /固定私物/);
  assert.equal(JSON.stringify({ empty, remaining }), before);
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
  assert.match(item, /保存持有 5/);
  assert.doesNotMatch(item, /3\.sav|模板基础|SHA|当前库存以游戏内为准/);
  assert.match(refs.preview('quest-101', { reference }), /进行中/);
  assert.doesNotMatch(refs.preview('quest-101', { reference }), /3\.sav|不保证执行顺序/);
  assert.match(refs.preview('quest-100', { reference }), /未出现在记录/);
  assert.match(refs.preview('quest-100'), /未核对存档/);
  assert.match(refs.preview('name:莫弃'), /2 条同名资料/);
  assert.equal(refs.preview('npc-999'), '');
});

test('item previews expose exact-item acquisition clues without leaking them into ambiguous names', async () => {
  const [, { createEntityReferences }] = await loaded;
  const index = fixture();
  index.entries.push(
    { id: 'item-12', gameId: 12, name: '金疮药', kind: '物品', quality: '绿' },
    { id: 'fusion-1', gameId: 1, name: '合成矿石配方', kind: '配方', results: [{ id: 9, count: 1 }] },
  );
  index.merchants = [
    { id: 1, name: '合成药铺<甲>', items: [11] },
    { id: 2, name: '合成药铺<甲>', items: [11] },
    { id: 3, name: '合成货郎', items: [11] },
    { id: 4, name: '不同品质商人', items: [12] },
  ];
  const refs = factory(createEntityReferences, index);
  const html = refs.preview('item-11', { reference: { metadata: { inventory: [{ id: 11, count: 5 }] } } });
  assert.match(html, /恢复气血 \+400 点/);
  assert.match(html, /保存持有 5/);
  assert.match(html, /售卖线索：合成药铺&lt;甲&gt;、合成货郎/);
  assert.doesNotMatch(html, /不同品质商人|<甲>/);
  assert.match(refs.preview('item-12'), /售卖线索：不同品质商人/);
  assert.doesNotMatch(refs.preview('name:金疮药'), /售卖线索：/);
  assert.match(refs.preview('item-9'), /制作：合成矿石配方/);
  assert.doesNotMatch(refs.preview('item-10'), /制作：|售卖线索：/);
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
  assert.match(html, /白色品质/);
  assert.match(html, /绿色品质/);
  assert.match(html, /蓝色品质/);
  assert.doesNotMatch(html, /#21|#22|#23/);
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
  assert.doesNotMatch(html, /需 6 件/);
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
  assert.doesNotMatch(person, /亲属关系|好友关系/);
});

test('community pickup clues follow exact NPC identity and root or child tasks without implying live location', async () => {
  const [{ entityCatalog }, { createEntityReferences }, { createEntityDetailViews }] = await loaded;
  const index = fixture(),
    data = entityCatalog(index);
  const view = createEntityDetailViews({
    esc,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    richText: factory(createEntityReferences, index).text,
    guide: () => [
      {
        questId: 100,
        pickup: { personId: 'npc-2', place: '<城门>西侧', action: '找莫弃问询后核对金疮药。' },
        uncertainty: '不同版本位置待核对。',
        sources: [{ id: 'flow:place', title: '<作者>', date: '2025-01-21', version: '具体构建未标' }],
      },
    ],
  });
  for (const id of ['quest-100', 'quest-101']) {
    const html = view.task(index, data.entries.get(id), null);
    assert.match(html, /data-community-pickup/);
    assert.match(html, /&lt;城门&gt;西侧/);
    assert.match(html, /data-id="npc-2"/);
    assert.match(html, /data-entity-id="item-11"/);
    assert.match(html, /data-action="entity-choice" data-id="name:莫弃"/);
    assert.match(html, /不同版本位置待核对/);
    assert.match(html, /data-action="source" data-id="flow:place">&lt;作者&gt;/);
    assert.match(html, /2025-01-21 · 具体构建未标/);
    assert(!html.includes('<城门>'));
  }
  assert.match(view.person(index, data.entries.get('npc-2'), null), /data-community-pickup/);
  assert.doesNotMatch(view.person(index, data.entries.get('npc-3'), null), /data-community-pickup/);
  assert.doesNotMatch(view.task(index, data.entries.get('quest-200'), null), /data-community-pickup/);
});

test('shipped merchant location connects NPC, root and exchange-step codex with material references and dated sources', async () => {
  const [{ entityCatalog }, { createEntityReferences }, { createEntityDetailViews }] = await loaded;
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const index = encyclopedia(),
    data = entityCatalog(index);
  const view = createEntityDetailViews({
    esc,
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    richText: factory(createEntityReferences, index).text,
    guide: () => flowSnapshot({ id: 'lookup', referenceMode: 'none' }, null).guide,
  });
  for (const [type, id] of [
    ['person', 'npc-16030'],
    ['task', 'quest-18500'],
    ['task', 'quest-18501'],
  ]) {
    const html = view[type](index, data.entries.get(id), null);
    assert.match(html, /data-community-pickup/);
    assert.match(html, /天水城.*客栈院内.*门口/);
    assert.match(html, /data-id="quest-18500"/);
    assert.match(html, /data-entity-id="item-10306"/);
    assert.match(html, /10 个/);
    assert.match(html, /2025-01-21.*2025-07-16/s);
    assert.match(html, /flow:flow064MerchantStar/);
    assert.match(html, /flow:flow064MerchantXu/);
    assert.match(html, /具体构建未标/);
  }
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

test('saved Tianshan travel connects companion advice and task details with distinct action labels', async () => {
  const [{ entityCatalog }, { createEntityReferences }, { createEntityDetailViews }, { createFlowViews }] =
    await loaded;
  const index = encyclopedia(),
    data = entityCatalog(index),
    references = factory(createEntityReferences, index);
  const view = createFlowViews({
    esc,
    act: references.button,
    icon: esc,
    pill: esc,
    when: esc,
    richText: references.text,
  });
  const flow = flowSnapshot(
    { id: 'travel', referenceMode: 'latest' },
    {
      name: '0.sav',
      modifiedAt: '2026-10-13T00:00:00Z',
      metadata: {
        trackingMainQuest: 24020,
        trackingQuest: 24089,
        quests: [
          { id: 24020, step: 1 },
          { id: 24089, step: 1 },
        ],
        inventory: [],
      },
    },
  );
  assert.equal(flow.advice[0].id, 'tianshan-secret-pass-route');
  const compact = view.panel(flow, { compact: true });
  const route = compact.match(
    /<article class="flow-suggestion" data-flow-suggestion="tianshan-secret-pass-route">[\s\S]*?<details/,
  )[0];
  assert.match(route, /白龟洞/);
  assert.match(route, /暗道.*关外.*天山/);
  const main = view.panel(flow);
  const preparation = main.match(
    /<article[^>]*data-flow-rule="tianshan-final-preparation"[\s\S]*?<\/article>/,
  )[0];
  const preparationText = preparation
    .replace(/<span class="image-fallback">[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]*>/g, '');
  assert.match(preparationText, /白龟洞暗道 → 关外 → 天山/);
  assert.match(preparationText, /从白龟洞暗道去关外，再按任务栏前往天山/);
  assert.doesNotMatch(preparation, /接取地点|怎么接/);
  assert.match(preparationText, /蜃楼岛挑战/);
  assert.match(preparation, /2025-07-16/);
  assert.match(preparation, /2025-12-11/);
  assert.match(preparation, /data-entity-id="quest-24089"/);
  assert.match(preparation, /data-picture="quest-24089"/);
  const details = createEntityDetailViews({
    esc,
    act: references.button,
    pill: esc,
    richText: references.text,
    guide: () => flow.guide,
  });
  for (const id of ['quest-24020', 'quest-24089']) {
    const html = details.task(index, data.entries.get(id), null);
    assert.match(html, /白龟洞.*暗道.*关外.*天山/s);
    assert.match(html, /蜃楼岛/);
    assert.match(html, /data-action="source" data-id="flow:flow065TianshanXu"/);
    assert.match(html, /data-action="source" data-id="flow:flow065TianshanMiao"/);
  }
  const pickup = view.panel({
    guide: [{ id: 'pickup', name: '未接任务', pickup: { place: '村口', action: '找人询问' } }],
  });
  assert.match(pickup, /class="flow-pickup"/);
  assert.match(pickup, /村口/);
  assert.match(pickup, /找人询问/);
});

test('folded pre-closure reminders retain every poison hand-in, giver, alternative and affected task', async () => {
  const [{ entityCatalog }, { createEntityReferences }, , { createFlowViews }] = await loaded;
  const index = encyclopedia(),
    data = entityCatalog(index),
    references = factory(createEntityReferences, index);
  const view = createFlowViews({
    esc,
    act: references.button,
    icon: esc,
    pill: esc,
    when: esc,
    richText: references.text,
  });
  const flow = flowSnapshot(
    { id: 'closure', referenceMode: 'latest' },
    {
      name: '0.sav',
      modifiedAt: '2026-10-13T00:00:00Z',
      metadata: {
        trackingMainQuest: 8499,
        quests: [
          { id: 8499, step: 1 },
          { id: 8536, step: 1 },
        ],
        inventory: [],
      },
    },
  );
  const compact = view.panel(flow, { compact: true });
  const risks = compact.match(/<section class="flow-risks">([\s\S]*?)<\/details><\/section>/)?.[1];
  assert(risks, 'advance reminders remain inside an expandable risk section');
  const folded = risks.match(/^<details\b([^>]*)><summary>([\s\S]*?)<\/summary>/);
  assert.match(folded[1], /class="flow-compact-risks"/);
  assert.match(folded[1], /\bopen(?:\s|=|$)/);
  assert.match(folded[2], /推进前确认/);
  assert.doesNotMatch(folded[2], /data-flow-impact|资料需 1 件|数量还缺 1 件/);
  const windows = [
    ...risks.matchAll(/<details\b([^>]*class="flow-risk-window"[^>]*)><summary>([\s\S]*?)<\/summary>/g),
  ];
  assert(windows.length > 0);
  assert(windows.every(([, attributes]) => !/\bopen(?:\s|=|$)/.test(attributes)));
  assert.match(risks, /人面蛛.*人面蛛毒元.*异种金蝎.*金蝎毒元.*通幽蜈/);
  const decisionIds = new Set(flow.decisions.map((row) => row.id));
  for (const warning of flow.warnings.filter((row) => !decisionIds.has(row.id))) {
    assert(risks.includes(`data-flow-impact="${esc(warning.id)}"`), warning.id);
    for (const task of warning.affectedTasks || []) {
      assert(risks.includes(esc(task.name)), task.name);
      assert(risks.includes(references.text(task.effect)), task.effect);
    }
  }
  assert(risks.includes('data-entity-id="npc-8510"'));
  for (const [name, itemId] of [
    ['人面蛛', 10488],
    ['人面蛛毒元', 10471],
    ['异种金蝎', 10498],
    ['金蝎毒元', 10472],
    ['通幽蜈', 10473],
  ]) {
    assert(risks.includes(`data-entity-id="name:${name}"`), name);
    assert(data.resolve('name:' + name).some((entity) => entity.id === `item-${itemId}`));
  }
  assert.match(risks, /五神殿/);
  assert.match(risks, /2024-12-11/);
  assert.match(risks, /2025-07-16/);
  for (const id of [10488, 10471, 10498, 10472, 10473]) assert(risks.includes(`data-entity-id="item-${id}"`));
  assert.match(risks, /需 1 件.*持有 0 件.*数量还缺 1 件/);
  const main = view.panel(flow);
  assert.match(main, /人面蛛.*人面蛛毒元.*异种金蝎.*金蝎毒元.*通幽蜈/);
  assert(main.includes('data-entity-id="npc-8510"'));
  assert.doesNotMatch(main, /class="flow-compact-risks"|class="flow-risk-window"/);
});
test('long task instructions keep their named people and locations individually queryable', async () => {
  const [, { createEntityReferences }] = await loaded;
  const index = require('../src/core/game-data.cjs').encyclopedia();
  const refs = factory(createEntityReferences, index);
  const html = refs.text('前往洛村西南方向的武当山，求见清虚道长');
  assert.doesNotMatch(html, /data-id="quest-5201"/);
  assert.match(html, /data-id="npc-5003"/);
  assert.match(html, /data-action="world-place"|data-action="entity-choice"/);
  assert.match(html, /武当山/);
});
test('task-title matches cannot hide a named participant in task relationships', async () => {
  const [{ entityCatalog }] = await loaded;
  const index = require('../src/core/game-data.cjs').encyclopedia();
  const catalog = entityCatalog(index);
  const task = catalog.entries.get('quest-14301');
  assert(catalog.taskRelations(task).people.some((row) => row.entity.name === '卫霍'));
  const person = [...catalog.entries.values()].find(
    (entry) => entry.kind === '人物' && entry.name === '卫霍',
  );
  assert(catalog.personRelations(person).quests.some((row) => row.via.some((quest) => quest.id === task.id)));
});

test('current journal associations use shared entity artwork and previews without changing guarded navigation', async () => {
  const [, { createEntityReferences }] = await loaded;
  const refs = factory(createEntityReferences, fixture());
  for (const [type, id, name] of [
    ['database', 'item-9', '铁矿石'],
    ['quest', 'quest-100', '送矿石'],
  ]) {
    const html = refs.button('journal-link', name, 'text-btn', type + ':' + id, 'arrow');
    assert(html.includes('data-action="journal-link"'));
    assert(html.includes('data-id="' + type + ':' + id + '"'));
    assert(html.includes('data-entity-id="' + id + '"'));
    assert(html.includes('data-picture="' + id + '"'));
    assert(html.includes('entity-link-label'));
    assert(refs.preview(id).includes(name));
  }
  for (const id of ['goal:personal', 'database:item-999999', 'quest:quest-999999'])
    assert(!refs.button('journal-link', '保留的标题', 'text-btn', id).includes('data-entity-id'));
});

test('static archive buttons retain canonical artwork, identity and item quality without changing the archive action', async () => {
  const { pathToFileURL } = require('node:url');
  const { createEntityReferences } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/entity-references.js')).href
  );
  const refs = createEntityReferences({
    index: () => ({
      entries: [{ id: 'item-100', name: '一转血气丹', kind: '物品', quality: '绿' }],
      world: { maps: [], quests: [] },
    }),
    esc: String,
    icon: () => '',
    picture: (id) => `<i data-picture="${id}"></i>`,
    qualityText: { html: (id, text) => `<span data-quality-id="${id}">${text}</span>` },
  });
  const html = refs.button('archive-entity', '一转血气丹', 'text-btn', 'item-100');
  assert.match(html, /data-action="archive-entity"/);
  assert.match(html, /data-entity-id="item-100"/);
  assert.match(html, /data-picture="item-100"/);
  assert.match(html, /data-quality-id="item-100"/);
  assert.match(html, /entity-link-label/);
});

function previewEvents(context = async () => ({})) {
  const vm = require('node:vm');
  const listeners = new Map(),
    timers = new Map(),
    nodes = [];
  let now = 0,
    nextTimer = 0,
    observe,
    afterReplace,
    nextScope;
  const folds = { scope: 'synthetic' };
  const element = (parent = null) => {
    const node = {
      parent,
      get parentElement() {
        return this.parent;
      },
      dataset: {},
      style: {},
      attributes: new Map(),
      isConnected: true,
      hovered: false,
      inert: false,
      hidden: true,
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
      focus() {
        document.activeElement = this;
      },
      contains(node) {
        for (; node; node = node.parent) if (node === this) return true;
        return false;
      },
      closest(selector) {
        for (let node = this; node; node = node.parent) {
          if (
            selector === '[data-entity-choice-list]'
              ? node.getAttribute('data-entity-choice-list') !== null
              : selector === '[inert]'
                ? node.inert
                : node.dataset.entityId
          )
            return node;
        }
        return null;
      },
      matches() {
        return this.hovered;
      },
      getBoundingClientRect() {
        return { left: 20, top: 20, bottom: 40, width: 100, height: 80 };
      },
    };
    nodes.push(node);
    return node;
  };
  const body = element(),
    root = element(body),
    overlay = element(body),
    panel = element(body);
  body.append = () => {};
  root.querySelector = () => null;
  root.querySelectorAll = (selector) =>
    selector.includes('data-entity-id')
      ? nodes.filter(
          (node) => node.isConnected && node !== root && root.contains(node) && node.dataset.entityId,
        )
      : [];
  Object.defineProperty(root, 'innerHTML', {
    set() {
      for (const node of nodes) if (node !== root && root.contains(node)) node.isConnected = false;
      if (root.contains(document.activeElement)) document.activeElement = body;
      afterReplace?.();
    },
  });
  const eventTarget = (surface) => ({
    addEventListener(type, listener) {
      const key = surface + ':' + type;
      listeners.set(key, [...(listeners.get(key) || []), listener]);
    },
  });
  const document = {
    ...eventTarget('document'),
    body,
    activeElement: body,
    documentElement: { clientWidth: 500 },
    createElement: () => panel,
  };
  const window = { ...eventTarget('window'), innerHeight: 500 };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/entity-references.js'), 'utf8');
  const install = vm.runInNewContext(
    '(' + source.slice(source.indexOf('export function installEntityPreviews')).replace('export ', '') + ')',
    {
      setTimeout(callback, delay) {
        const id = ++nextTimer;
        timers.set(id, { callback, at: now + delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      MutationObserver: class {
        constructor(callback) {
          observe = callback;
        }
        observe() {}
      },
    },
  );
  const previews = install({
    document,
    window,
    references: { preview: (id, details) => id + (details?.label ? ' ' + details.label : '') },
    context,
  });
  const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const renderStart = appSource.indexOf('function render(');
  const render = vm.runInNewContext(
    '(' + appSource.slice(renderStart, appSource.indexOf('\nfunction intentDraftBanner', renderStart)) + ')',
    {
      catalog: {},
      state: {},
      composing: false,
      compact: true,
      handbookSuspended: false,
      companionMode: 'expanded',
      document,
      root,
      entityPreviews: previews,
      currentFlow: () => ({ decisions: [] }),
      dockLiveChoice: () => {},
      captureIntentDrafts() {},
      profile: () => ({ id: 'synthetic' }),
      captureDetailFolds: () => {
        if (nextScope) folds.scope = nextScope;
        return new Map();
      },
      detailFolds: folds,
      companionMaterialFolds: { profileId: null, values: new Map() },
      compactPage: () => '',
      availableIntentDrafts: () => [],
      route: 'home',
      syncItineraryIntentEditors() {},
    },
  );
  return {
    document,
    window,
    root,
    overlay,
    panel,
    previews,
    redraw(replace = null, scope = null) {
      afterReplace = replace;
      nextScope = scope;
      render(true);
      afterReplace = nextScope = null;
      observe();
    },
    entry(parent = overlay) {
      const node = element(parent);
      node.dataset.entityId = 'npc-1';
      return node;
    },
    container(parent, attributes) {
      const node = element(parent);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      return node;
    },
    emit(type, target, extra = {}, surface = 'document') {
      const event = {
        target,
        relatedTarget: null,
        preventDefault() {},
        stopImmediatePropagation() {},
        ...extra,
      };
      for (const listener of listeners.get(surface + ':' + type) || []) listener(event);
    },
    async tick(duration) {
      const end = now + duration;
      while (true) {
        const ready = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!ready) break;
        const [id, timer] = ready;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    },
    changed: () => observe(),
  };
}

for (const intent of ['focus', 'hover']) {
  test(`expanded namesake choices stay unobstructed during ${intent}, while ordinary previews remain available`, async () => {
    let reads = 0;
    const ui = previewEvents(async () => {
      reads++;
      return {};
    });
    const list = ui.container(ui.overlay, { 'data-entity-choice-list': '' });
    const choice = ui.entry(list);
    if (intent === 'focus') ui.document.activeElement = choice;
    else choice.hovered = true;
    ui.emit(intent === 'focus' ? 'focusin' : 'pointerover', choice);
    await ui.tick(500);
    assert.equal(reads, 0, 'reading choices must not fetch a covering popup');
    assert.equal(ui.panel.hidden, true);
    assert.equal(choice.getAttribute('aria-describedby'), null);
    let intercepted = false;
    ui.emit('keydown', choice, { key: 'Escape', preventDefault: () => (intercepted = true) });
    assert.equal(intercepted, false, 'the chooser keeps its normal Escape handler');
    const ordinary = ui.entry(ui.root);
    if (intent === 'focus') ui.document.activeElement = ordinary;
    else ordinary.hovered = true;
    ui.emit(intent === 'focus' ? 'focusin' : 'pointerover', ordinary);
    await ui.tick(250);
    assert.equal(reads, 1);
    assert.equal(ui.panel.hidden, false);
    assert.equal(ordinary.getAttribute('aria-describedby'), 'entity-preview');
  });

  test(`background redraw preserves a ${intent} preview outside the replaced surface`, async () => {
    const ui = previewEvents(),
      entry = ui.entry();
    if (intent === 'focus') ui.document.activeElement = entry;
    else entry.hovered = true;
    ui.emit(intent === 'focus' ? 'focusin' : 'pointerover', entry);
    await ui.tick(240);
    assert.equal(ui.panel.hidden, false);
    assert.equal(entry.getAttribute('aria-describedby'), 'entity-preview');
    ui.redraw();
    assert.equal(ui.panel.hidden, false);
    assert.equal(entry.getAttribute('aria-describedby'), 'entity-preview');
    assert.equal(entry.isConnected, true);
  });

  test(`background redraw dismisses a ${intent} preview whose entry is no longer present`, async () => {
    const ui = previewEvents(),
      entry = ui.entry(ui.root);
    if (intent === 'focus') ui.document.activeElement = entry;
    else entry.hovered = true;
    ui.emit(intent === 'focus' ? 'focusin' : 'pointerover', entry);
    await ui.tick(240);
    assert.equal(ui.panel.hidden, false);
    ui.redraw();
    assert.equal(entry.isConnected, false);
    assert.equal(ui.panel.hidden, true);
    assert.equal(entry.getAttribute('aria-describedby'), null);
  });

  test(`background redraw rebinds a ${intent} body preview and resolves fresh context`, async () => {
    let label = 'old',
      calls = 0;
    const ui = previewEvents(async () => {
        calls++;
        return { label };
      }),
      entry = ui.entry(ui.root);
    if (intent === 'focus') ui.document.activeElement = entry;
    else entry.hovered = true;
    ui.emit(intent === 'focus' ? 'focusin' : 'pointerover', entry);
    await ui.tick(240);
    assert.equal(ui.panel.innerHTML, 'npc-1 old');
    label = 'fresh';
    let replacement;
    ui.redraw(() => {
      replacement = ui.entry(ui.root);
      replacement.hovered = intent === 'hover';
    });
    await ui.tick(0);
    assert.equal(entry.isConnected, false);
    assert.equal(ui.panel.hidden, false);
    assert.equal(ui.panel.innerHTML, 'npc-1 fresh');
    assert.equal(replacement.getAttribute('aria-describedby'), 'entity-preview');
    assert.equal(entry.getAttribute('aria-describedby'), null);
    assert.equal(calls, 2);
    if (intent === 'focus') assert.equal(ui.document.activeElement, replacement);
  });
}

for (const invalidation of ['pointer moved', 'different entity', 'different quality', 'different context']) {
  test(`body preview stays closed after ${invalidation}`, async () => {
    const ui = previewEvents(),
      entry = ui.entry(ui.root);
    entry.hovered = true;
    ui.emit('pointerover', entry);
    await ui.tick(240);
    ui.redraw(
      () => {
        const replacement = ui.entry(ui.root);
        replacement.hovered = invalidation !== 'pointer moved';
        if (invalidation === 'different entity') replacement.dataset.entityId = 'npc-2';
        if (invalidation === 'different quality') replacement.dataset.qualityId = 'item-2';
      },
      invalidation === 'different context' ? 'another-profile' : null,
    );
    await ui.tick(0);
    assert.equal(ui.panel.hidden, true);
  });
}

test('a pending body preview discards its old context after rebinding', async () => {
  const replies = [];
  const ui = previewEvents(() => new Promise((resolve) => replies.push(resolve)));
  const entry = ui.entry(ui.root);
  entry.hovered = true;
  ui.emit('pointerover', entry);
  await ui.tick(240);
  ui.redraw(() => {
    ui.entry(ui.root).hovered = true;
  });
  await ui.tick(0);
  assert.equal(replies.length, 2);
  replies[0]({ label: 'stale' });
  await ui.tick(0);
  assert.equal(ui.panel.hidden, true);
  replies[1]({ label: 'current' });
  await ui.tick(0);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.panel.innerHTML, 'npc-1 current');
});

test('a new dock copy cannot take the focus or preview of an offline guide reference', async () => {
  const ui = previewEvents();
  const entry = ui.entry(ui.container(ui.root, { 'data-flow-rule': 'woodcutter' }));
  ui.document.activeElement = entry;
  ui.emit('focusin', entry);
  await ui.tick(0);
  let dock, body;
  ui.redraw(() => {
    dock = ui.entry(ui.container(ui.root, { 'data-flow-decision': 'woodcutter' }));
    body = ui.entry(ui.container(ui.root, { 'data-flow-rule': 'woodcutter' }));
  });
  await ui.tick(0);
  assert.equal(ui.document.activeElement, body);
  assert.equal(body.getAttribute('aria-describedby'), 'entity-preview');
  assert.equal(dock.getAttribute('aria-describedby'), null);
});

for (const fixed of [false, true]) {
  test(`${fixed ? 'fixed' : 'following'} connected overlay preview rechecks its effective reference in place`, async () => {
    let latest = '5',
      calls = 0;
    const ui = previewEvents(async () => {
      calls++;
      return { label: fixed ? 'snapshot-5' : latest };
    });
    const entry = ui.entry();
    ui.document.activeElement = entry;
    ui.emit('focusin', entry);
    await ui.tick(0);
    latest = '9';
    ui.redraw();
    ui.previews.refreshOutside(ui.root);
    assert.equal(ui.panel.hidden, false, 'refresh does not hide the connected popup while reading');
    await ui.tick(0);
    assert.equal(ui.panel.innerHTML, fixed ? 'npc-1 snapshot-5' : 'npc-1 9');
    assert.equal(ui.document.activeElement, entry);
    assert.equal(entry.isConnected, true);
    assert.equal(calls, 2);
  });
}

test('late old overlay context cannot overwrite a more recent refresh', async () => {
  const replies = [];
  const ui = previewEvents(() => new Promise((resolve) => replies.push(resolve)));
  const entry = ui.entry();
  entry.hovered = true;
  ui.emit('pointerover', entry);
  await ui.tick(240);
  ui.previews.refreshOutside(ui.root);
  await ui.tick(0);
  replies[1]({ label: 'new' });
  await ui.tick(0);
  replies[0]({ label: 'old' });
  await ui.tick(0);
  assert.equal(ui.panel.innerHTML, 'npc-1 new');
});

test('pointer exit keeps an asynchronous preview owned by keyboard focus', async () => {
  let complete;
  const ui = previewEvents(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
    entry = ui.entry();
  ui.document.activeElement = entry;
  ui.emit('focusin', entry);
  await ui.tick(0);
  ui.emit('pointerout', entry);
  await ui.tick(500);
  complete({});
  await ui.tick(0);
  assert.equal(ui.panel.hidden, false);
  assert.equal(entry.getAttribute('aria-describedby'), 'entity-preview');
  ui.document.activeElement = ui.document.body;
  ui.emit('focusout', entry);
  await ui.tick(160);
  assert.equal(ui.panel.hidden, true);
});

test('pointer exit cancels an asynchronous hover preview without keyboard focus', async () => {
  let complete;
  const ui = previewEvents(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
    entry = ui.entry();
  ui.emit('pointerover', entry);
  await ui.tick(240);
  ui.emit('pointerout', entry);
  complete({});
  await ui.tick(500);
  assert.equal(ui.panel.hidden, true);
  assert.equal(entry.getAttribute('aria-describedby'), null);
});

test('replacing a surface cancels its pending preview before context resolves', async () => {
  let complete;
  const ui = previewEvents(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
    entry = ui.entry(ui.root);
  ui.document.activeElement = entry;
  ui.emit('focusin', entry);
  await ui.tick(0);
  ui.redraw();
  complete({});
  await ui.tick(0);
  assert.equal(ui.panel.hidden, true);
  assert.equal(entry.getAttribute('aria-describedby'), null);
});

for (const dismissal of ['removed', 'inert', 'Escape', 'blur']) {
  test(`${dismissal} dismisses an active focused preview`, async () => {
    const ui = previewEvents(),
      entry = ui.entry();
    ui.document.activeElement = entry;
    ui.emit('focusin', entry);
    await ui.tick(0);
    assert.equal(ui.panel.hidden, false);
    if (dismissal === 'removed') {
      entry.isConnected = false;
      ui.changed();
    } else if (dismissal === 'inert') {
      ui.overlay.inert = true;
      ui.changed();
    } else if (dismissal === 'Escape') ui.emit('keydown', entry, { key: 'Escape' });
    else ui.emit('blur', ui.window, {}, 'window');
    await ui.tick(500);
    assert.equal(ui.panel.hidden, true);
    assert.equal(entry.getAttribute('aria-describedby'), null);
  });
}
