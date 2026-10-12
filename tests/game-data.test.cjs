'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { syntheticSave } = require('./fixtures.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich, encyclopedia, recipePlan } = require('../src/core/game-data.cjs');
const { Saves, sha } = require('../src/core/saves.cjs');
test('full save details preserve immutable bytes and map IDs to local game names', () => {
  const b = syntheticSave({ full: true }),
    before = sha(b),
    m = enrich(readMetadata(b, { details: true }));
  assert.equal(m.mapName, '世界地图');
  assert.deepEqual(
    m.team.map((n) => n.name),
    ['宇文逸', '卫霍'],
  );
  assert.equal(m.money, 22522);
  assert.equal(m.mainQuest.name, '【主线】武当求助');
  assert.equal(m.quest.name, '【支线】养生秘术');
  assert.deepEqual(m.fusionRecipes, [1002]);
  assert.match(m.thumbnail, /^data:image\/png;base64,/);
  assert.equal(sha(b), before);
});
test('unknown map, NPC and quest IDs remain visible without invented game names', () => {
  const m = enrich({ map: 'MOD_CUSTOM', teamIds: [-12], trackingQuest: 987654321 });
  assert.equal(m.mapName, 'MOD_CUSTOM');
  assert.equal(m.team[0].name, '角色 #-12');
  assert.equal(m.quest.name, '任务 #987654321');
});
test('quest states match the game enum and visible steps retain parent grouping', () => {
  const b = syntheticSave({
      full: true,
      quests: [
        { id: 5200, step: 1 },
        { id: 5201, step: 1 },
        { id: 5176, step: 4, finished: 1781822869 },
      ],
    }),
    m = enrich(readMetadata(b, { details: true }));
  assert.equal(m.quests.find((q) => q.id === 5200).status, '进行中');
  assert.equal(m.quests.find((q) => q.id === 5201).parentId, 5200);
  assert.equal(m.quests.find((q) => q.id === 5176).status, '已完成');
  assert.equal(m.quests.find((q) => q.id === 5176).finishedAt, undefined);
});
test('unknown or duplicate quest states and truncated sections fail closed', () => {
  const { questSection } = require('./fixtures.cjs'),
    { readQuestSpecs } = require('../src/core/save-reader.cjs');
  for (const list of [
    [{ id: 5200, step: 5 }],
    [
      { id: 5200, step: 1 },
      { id: 5200, step: 4 },
    ],
  ]) {
    const b = questSection(list);
    assert.equal(readQuestSpecs(b, 0, b.length), null);
  }
  const good = questSection([{ id: 5200, step: 1 }]);
  assert.equal(readQuestSpecs(good, 0, good.length - 1), null);
  const b = syntheticSave({ full: true, quests: [{ id: 5200, step: 8 }] });
  const m = readMetadata(b, { details: true });
  assert.equal(m.map, 'LV_World');
  assert.equal(m.quests, null);
});
test('native inventory aggregates item stacks and recipe plan calculates exact shortfall', () => {
  const b = syntheticSave({
    full: true,
    inventory: [
      { id: 10226, count: 2 },
      { id: 10226, count: 1 },
      { id: 10220, count: 5 },
    ],
  });
  const m = readMetadata(b, { details: true });
  assert.deepEqual(m.inventory, [
    { id: 10226, count: 3 },
    { id: 10220, count: 5 },
  ]);
  const plan = recipePlan('fusion-1002', 3, m.inventory),
    steel = plan.materials.find((m) => m.id === 10226),
    silver = plan.materials.find((m) => m.id === 10220);
  assert.deepEqual(
    { need: steel.count, have: steel.owned, missing: steel.missing },
    { need: 9, have: 3, missing: 6 },
  );
  assert.equal(silver.missing, 0);
  assert.throws(() => recipePlan('fusion-1002', 1, [{ id: 10226, count: -1 }]), /库存/);
});

test('native item bool does not consume an action record or hide the entire inventory', () => {
  const { readInventory } = require('../src/core/save-reader.cjs');
  // Layout independently checked against Build21798996's native item
  // serializer: GUID, ID, quantity, uint32 bool, two action arrays, int32, two bools.
  // Each action is uint8 type + int32 ID + float32 value.
  const bytes = Buffer.from(
    '00000000' + // leading native segment marker
      '01000000' + // one item
      '00000000000000000000000000000000' + // GUID
      'f227000003000000' + // item10226, quantity3
      '01000000' + // bool true, NOT an action-array length
      '0100000015090000000000c03f' + // first action array: type21, ID9, 1.5
      '01000000150a00000000002040' + // second: type21, ID10, 2.5
      '0000000000000000' + // native int32 + version9 bool false
      '01000000' + // trailing bool true
      '00000000', // separate NPC collection count
    'hex',
  );
  const before = Buffer.from(bytes);
  assert.deepEqual(readInventory(bytes, 0), [{ id: 10226, count: 3 }]);
  assert.deepEqual(bytes, before);
  const unflagged = Buffer.from(bytes);
  unflagged.writeInt32LE(0, 32);
  assert.deepEqual(readInventory(unflagged, 0), [{ id: 10226, count: 3 }]);
  for (const flag of [-1, 2, 1001]) {
    const invalid = Buffer.from(bytes);
    invalid.writeInt32LE(flag, 32);
    assert.equal(readInventory(invalid, 0), null);
  }
  assert.equal(readInventory(bytes.subarray(0, bytes.length - 1), 0), null);
});
test('truncated or unsupported native inventory is omitted without losing basic metadata', () => {
  const { readInventory } = require('../src/core/save-reader.cjs');
  assert.equal(readInventory(Buffer.alloc(4), 0), null);
  const bad = Buffer.alloc(8);
  bad.writeInt32LE(10001, 4);
  assert.equal(readInventory(bad, 0), null);
  const zlib = require('node:zlib'),
    b = syntheticSave({ full: true, inventory: [{ id: 10226, count: 3 }] }),
    raw = zlib.inflateSync(b.subarray(12));
  const short = raw.subarray(0, raw.length - 10),
    z = zlib.deflateSync(short),
    head = Buffer.alloc(12);
  head.writeUInt32LE(14);
  head.writeUInt32LE(short.length, 4);
  head.writeUInt32LE(z.length, 8);
  const m = readMetadata(Buffer.concat([head, z]), { details: true });
  assert.equal(m.map, 'LV_World');
  assert.equal(m.inventory, null);
});
test('recipe quantity multiplies all material counts and money, refuses invalid counts', () => {
  const one = recipePlan('fusion-1002', 1),
    three = recipePlan('fusion-1002', 3);
  assert.ok(one.materials.length > 0);
  assert.equal(three.money, one.money * 3);
  assert.deepEqual(
    three.materials.map((m) => m.count),
    one.materials.map((m) => m.count * 3),
  );
  assert.equal(three.materials[0].name, '精钢锭');
  for (const q of [0, -1, 1.5, 1000, '2', Infinity, NaN]) assert.throws(() => recipePlan('fusion-1002', q));
  assert.throws(() => recipePlan('item-10201', 1));
});
test('cooking substitutes sum only accepted fish and never double-count a group', () => {
  const p = recipePlan('cooking-102', 3, [
    { id: 10525, count: 2 },
    { id: 10529, count: 3 },
    { id: 10530, count: 99 },
  ]);
  const fish = p.materials.find((m) => m.groupId === 10);
  assert.equal(fish.name, '鱼肉');
  assert.equal(fish.count, 6);
  assert.equal(fish.owned, 5);
  assert.equal(fish.missing, 1);
});
test('local encyclopedia has unique IDs, valid recipe links and no live HTML', () => {
  const data = encyclopedia(),
    ids = new Set(data.entries.map((e) => e.id));
  assert.equal(ids.size, data.entries.length);
  assert.ok(data.entries.length > 2000);
  for (const e of data.entries) {
    assert.ok(e.name);
    assert.equal(/<[^>]+>/.test(e.description), false);
    if (e.kind === '配方')
      for (const m of e.materials) {
        for (const id of m.alternatives || [m.id]) assert.ok(ids.has(`item-${id}`), `${e.id} ${id}`);
        assert.ok(Number.isFinite(m.count) && m.count > 0);
      }
  }
});
test('learning recipes and seller references form valid two-way links from game data', () => {
  const data = encyclopedia(),
    byId = new Map(data.entries.map((e) => [e.id, e]));
  assert.deepEqual(byId.get('item-100304').teachesRecipes, ['alchemy-104']);
  assert.deepEqual(byId.get('alchemy-104').learningItems, [100304]);
  assert.ok(data.merchants.find((m) => m.id === 5056 && m.name === '元济').items.includes(100304));
  for (const e of data.entries) {
    for (const id of e.teachesRecipes || []) {
      const recipe = byId.get(id);
      assert.equal(recipe?.kind, '配方');
      assert.ok(recipe.learningItems.includes(e.gameId));
    }
    for (const id of e.learningItems || []) {
      const item = byId.get(`item-${id}`);
      assert.equal(item?.kind, '物品');
      assert.ok(item.teachesRecipes.includes(e.id));
    }
  }
  assert.ok(data.merchants.length > 100);
  assert.equal(new Set(data.merchants.map((m) => m.id)).size, data.merchants.length);
  for (const m of data.merchants) {
    assert.ok(m.name && m.items.length);
    assert.equal(/<[^>]+>/.test(m.description), false);
    for (const id of m.items) assert.equal(byId.get(`item-${id}`)?.kind, '物品');
  }
});
test('night chest rewards link dated acquisition guidance without replacing native item facts', async () => {
  const raw = require('../src/data/game-index.json');
  const before = structuredClone(raw);
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia();
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
  const views = createGameViews({
    esc,
    icon: () => '',
    act: (action, label, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    empty: esc,
    notice: esc,
    bytes: esc,
    when: esc,
    hours: esc,
    iconButton: () => '',
    picture: (id) => `<img data-picture="${id}">`,
    qualityText: { name: (_, name) => esc(name), label: () => '' },
  });
  for (const id of ['item-13701', 'item-140']) {
    const item = index.entries.find((entry) => entry.id === id);
    const { stats, acquisitionRoutes, ...original } = item;
    assert.deepEqual(
      original,
      raw.entries.find((entry) => entry.id === id),
    );
    assert(stats);
    assert.equal(acquisitionRoutes.length, 1);
    const route = acquisitionRoutes[0];
    assert.equal(route.questId, 5830);
    assert.match(route.detail, /程钰.*喝粥前.*祖师殿右侧.*清风步秘籍.*二转洗髓丹.*拿过/);
    assert.match(route.uncertainty, /不是.*未开启.*精确失效.*未实测.*唯一来源/);
    assert.equal(route.sources.length, 2);
    assert(
      route.sources.every(
        (source) =>
          source.id.startsWith('flow:') && source.date && source.version && source.url.startsWith('https://'),
      ),
    );
    const html = views.detail(index, id);
    assert.match(html, /阶段获取线索.*祖师殿右侧宝箱/s);
    assert.match(html, /data-action="flow-quest" data-id="quest-5830"/);
    assert.match(html, /data-action="source" data-id="flow:flow061WudangNight"/);
    assert.match(html, /2025-07-14.*2026-08-13/s);
    assert.match(html, /使用效果与数值/);
    assert.match(html, new RegExp(`data-picture="${id}"`));
    if (id === 'item-13701') assert.match(html, /初始私物中的人物线索/);
  }
  assert.equal(index.entries.find((entry) => entry.id === 'item-10217').acquisitionRoutes, undefined);
  assert.deepEqual(raw, before);
});

test('wooden sword codex connects house pickup and later return while preserving native QuestItem facts', async () => {
  const raw = require('../src/data/game-index.json');
  const before = structuredClone(raw);
  const index = encyclopedia();
  const item = index.entries.find((row) => row.id === 'item-10393');
  const { stats, acquisitionRoutes, ...native } = item;
  assert.deepEqual(
    native,
    raw.entries.find((row) => row.id === 'item-10393'),
  );
  assert.equal(item.giftable, false);
  assert.equal(item.typeKey, 'QuestItem');
  assert.equal(item.buyPrice, 500);
  assert.equal(item.sellPrice, 250);
  assert.equal(acquisitionRoutes.length, 1);
  const route = acquisitionRoutes[0];
  assert.equal(route.questId, 5351);
  assert.match(route.detail, /江吟风故居.*已归还.*六派共议.*补拿.*天佛窟归来.*墓前.*自动归还/);
  assert.match(route.uncertainty, /精确拾取窗口.*未可靠识别.*背包没有.*不能证明.*不据旧版/);
  assert.equal(route.sources.length, 4);
  assert(route.sources.every((row) => row.id.startsWith('flow:') && row.date && row.version));
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
  const views = createGameViews({
    esc,
    icon: () => '',
    act: (action, label, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    empty: esc,
    notice: esc,
    bytes: esc,
    when: esc,
    hours: esc,
    iconButton: () => '',
    picture: (id) => `<img data-picture="${id}">`,
    qualityText: { name: (_, name) => esc(name), label: () => '' },
  });
  const html = views.detail(index, item.id);
  assert.match(html, /阶段获取线索.*江吟风故居/s);
  assert.match(html, /data-action="flow-quest" data-id="quest-5351"/);
  assert.match(html, /data-action="source" data-id="flow:flow062XiaotongXu"/);
  assert.match(html, /2024-08-28.*2025-07-16.*2024-12-07.*2025-07-16/s);
  assert.match(html, /data-picture="item-10393"/);
  assert.deepEqual(raw, before);
});

test('Chenghuang Yufeng item route distinguishes formation from conditional combat rewards', () => {
  const raw = require('../src/data/game-index.json');
  const before = structuredClone(raw);
  const item = encyclopedia().entries.find((row) => row.id === 'item-13721');
  const { stats, acquisitionRoutes, ...native } = item;
  assert.deepEqual(
    native,
    raw.entries.find((row) => row.id === 'item-13721'),
  );
  assert.equal(item.name, '乘黄御风');
  assert.equal(acquisitionRoutes.length, 1);
  assert.equal(acquisitionRoutes[0].questId, 8499);
  assert.match(
    acquisitionRoutes[0].detail,
    /另存.*燕未还.*荀杳杳.*三人赴战.*多人赴战.*自由组队.*第二战.*并非/,
  );
  assert.match(acquisitionRoutes[0].uncertainty, /两位2025.*24回合.*当前.*未实测.*不保证/);
  assert.equal(acquisitionRoutes[0].sources.length, 2);
  assert(
    acquisitionRoutes[0].sources.every((row) => row.date && row.version && row.url.startsWith('https://')),
  );
  assert.deepEqual(raw, before);
});

test('save detail filename validation and scan cache invalidation', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-detail-'));
  t.after(() => {
    if (
      path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) ||
      !path.basename(base).startsWith('yijian-detail-')
    )
      throw Error('Unsafe test cleanup path');
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dir = path.join(base, 'SaveGames');
  fs.mkdirSync(dir);
  const file = path.join(dir, '2.sav');
  fs.writeFileSync(file, syntheticSave({ full: true }));
  const saves = new Saves(path.join(base, 'backups'));
  assert.equal(saves.scan(dir).files[0].metadata.mapName, '世界地图');
  assert.equal(saves.scan(dir).files[0].metadata.mapName, '世界地图');
  fs.writeFileSync(file, syntheticSave({ full: true, map: 'LV_20_P', seconds: 4000 }));
  assert.equal(saves.scan(dir).files[0].metadata.mapName, '洛村');
  assert.equal(saves.details(dir, '2.sav').metadata.playSeconds, 4000);
  for (const name of ['../2.sav', 'JHSaveConfig.sav', '2.sav:stream', '2.SAV\\x'])
    assert.throws(() => saves.details(dir, name));
});

test('encyclopedia projects single-execution output facts without altering recipe results or other entry fields', () => {
  const raw = require('../src/data/game-index.json'),
    before = structuredClone(raw),
    projected = encyclopedia(),
    entry = (id) => projected.entries.find((e) => e.id === id);
  for (const id of ['fusion-9501', 'fusion-1002', 'fusion-1100']) {
    const { outputReference, ...originalFields } = entry(id);
    assert.deepEqual(
      originalFields,
      raw.entries.find((e) => e.id === id),
    );
    assert.ok(outputReference.length > 0);
    assert.notEqual(
      entry(id),
      raw.entries.find((e) => e.id === id),
    );
  }
  assert.deepEqual(entry('fusion-9501').outputReference, [
    {
      id: 10217,
      name: '铜锭',
      quality: '绿',
      minimumCount: 1,
      maximumCount: 3,
      weights: [5, 3, 2],
      guaranteedItem: true,
    },
  ]);
  assert.deepEqual(entry('fusion-1002').outputReference, [
    {
      id: 1008,
      name: '长虹剑',
      quality: '金',
      minimumCount: 1,
      maximumCount: 1,
      weights: [1],
      guaranteedItem: true,
    },
  ]);
  assert.deepEqual(
    entry('fusion-1100').outputReference.map((o) => [o.id, o.quality, o.guaranteedItem]),
    [
      [1000, '白', false],
      [1001, '绿', false],
      [1002, '蓝', false],
    ],
  );
  assert.deepEqual(
    recipePlan('fusion-9501', 4).results,
    before.entries.find((e) => e.id === 'fusion-9501').results,
  );
  assert.equal(entry('item-10217').outputReference, undefined);
  assert.deepEqual(raw, before);
});

test('recipe detail shows chosen total ranges and separate quality candidates before a craft-list action, with unknown inventory intact', async () => {
  const { pathToFileURL } = require('node:url'),
    { createGameViews } = await import(
      pathToFileURL(path.join(__dirname, '../src/renderer/game-views.js')).href
    ),
    index = encyclopedia();
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
  const views = createGameViews({
    esc,
    icon: () => '',
    act: (action, label, cls, id) =>
      '<button data-action="' + esc(action) + '" data-id="' + esc(id) + '">' + label + '</button>',
    pill: esc,
    empty: esc,
    notice: esc,
    bytes: esc,
    when: esc,
    hours: esc,
    iconButton: () => '',
    picture: () => '',
    qualityText: { name: (_, name) => esc(name), label: () => '' },
  });
  const entry = (id) => index.entries.find((e) => e.id === id);
  for (const [id, quantity, outputs] of [
    ['fusion-9501', 4, [[10217, '铜锭', '绿', '4–12']]],
    ['fusion-1002', 3, [[1008, '长虹剑', '金', '3']]],
    [
      'fusion-1100',
      2,
      [
        [1000, '纯钢剑', '白', '0–2'],
        [1001, '纯钢剑', '绿', '0–2'],
        [1002, '纯钢剑', '蓝', '0–2'],
      ],
    ],
  ]) {
    const recipe = entry(id),
      before = structuredClone(recipe),
      html = views.detail(index, id, quantity),
      totals = html.slice(
        html.indexOf('data-recipe-total-outputs'),
        html.indexOf('<div class="material-row"'),
      );
    assert.ok(totals.includes('制作 ' + quantity + ' 次的预计总产物'));
    for (const [itemId, name, quality, count] of outputs) {
      assert.ok(totals.includes('data-recipe-output-id="' + itemId + '"'));
      assert.ok(
        totals.includes('data-id="item-' + itemId + '">' + name + '</button> · ' + quality + '色 × ' + count),
      );
    }
    assert.match(totals, /尚未计入背包/);
    assert.doesNotMatch(totals, /NaN|Infinity|概率|%|已有|缺 0/);
    assert.equal((totals.match(/data-recipe-output-id=/g) || []).length, outputs.length);
    assert.ok(html.indexOf('data-recipe-total-outputs') < html.indexOf('data-action="craft-add"'));
    assert.match(html, /每次产出参考/);
    assert.doesNotMatch(html, /material-owned|缺 0/);
    assert.equal(totals.includes('不会同时得到全部最大数量'), id === 'fusion-1100');
    assert.deepEqual(recipe, before);
  }
  const copper = entry('fusion-9501');
  for (const outputReference of [
    [],
    [{ ...copper.outputReference[0], minimumCount: null, maximumCount: null, guaranteedItem: false }],
    [{ ...copper.outputReference[0], minimumCount: null, maximumCount: 3, guaranteedItem: false }],
    [
      {
        ...copper.outputReference[0],
        minimumCount: Number.MAX_SAFE_INTEGER,
        maximumCount: Number.MAX_SAFE_INTEGER,
      },
    ],
  ]) {
    const recipe = { ...copper, outputReference },
      html = views.recipeMaterials(recipe, 4, index),
      totals = html.slice(0, html.indexOf('<div class="material-row"'));
    assert.match(totals, /游戏内确认/);
    assert.doesNotMatch(totals, / × |NaN|Infinity|0–/);
  }
  const unreadable = views.recipeMaterials(copper, 4, index, { metadata: {} });
  assert.match(unreadable, /绿色 × 4–12/);
  assert.doesNotMatch(unreadable, /material-owned|缺 0/);
});
