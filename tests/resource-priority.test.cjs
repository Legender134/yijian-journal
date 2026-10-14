'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { allocate } = require('../src/core/material-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const {
  resourcePriorityPreview,
  priorityFingerprint,
  validateResourcePriority,
} = require('../src/core/resource-priority.cjs');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const stamp = '2026-10-09T00:00:00.000Z';
const plan = (id) => ({
  id,
  name: id,
  list: [{ id: 'fusion-1000', quantity: 1 }],
  reserved: true,
  createdAt: stamp,
  updatedAt: stamp,
});
const profile = () => ({
  id: 'synthetic-profile',
  referenceMode: 'latest',
  goals: [],
  craftPlans: [plan('a'), plan('b')],
  craftList: plan('a').list,
  activeCraftPlanId: 'a',
});
const reference = () => ({
  name: 'Synthetic.sav',
  hash: 'a'.repeat(64),
  modifiedAt: stamp,
  metadata: {
    inventory: [
      { id: 10216, count: 3 },
      { id: 10246, count: 1 },
      { id: 10205, count: 1 },
    ],
    fusionRecipes: [1000],
    money: 100000,
  },
});
const total = (budget, id) =>
  budget.crafts
    .find((c) => c.id === id)
    .materials.reduce((n, m) => n + m.allocation.reduce((s, a) => s + a.count, 0), 0);
test('explicit priority remains stable when another plan becomes the editor and preview names every transferred physical item', () => {
  const p = { ...profile(), resourcePriority: ['a', 'b'] },
    ref = reference(),
    original = structuredClone(p);
  assert.equal(total(resourceBudget(p, ref), 'a'), 5);
  const openedB = { ...p, activeCraftPlanId: 'b', craftList: plan('b').list };
  assert.equal(total(resourceBudget(openedB, ref), 'a'), 5);
  assert.equal(total(resourceBudget(openedB, ref), 'b'), 0);
  const preview = resourcePriorityPreview(openedB, ref, ['b', 'a']);
  assert.equal(
    preview.changes.find((o) => o.id === 'a').items.reduce((n, a) => n + a.beforeDirect - a.afterDirect, 0),
    5,
  );
  assert.equal(
    preview.changes.find((o) => o.id === 'b').items.reduce((n, a) => n + a.afterDirect - a.beforeDirect, 0),
    5,
  );
  assert.deepEqual(preview.beforePhysicalUsed, preview.afterPhysicalUsed);
  assert.deepEqual(p, original);
  assert.notEqual(
    priorityFingerprint(openedB, ref),
    priorityFingerprint(openedB, { ...ref, hash: 'b'.repeat(64) }),
  );
});
test('priority preserves residual substitution and grants an earlier owner without greedy starvation of a fixed later demand', () => {
  const groups = [
    { ids: [10525, 10526], count: 1 },
    { ids: [10525], count: 1 },
  ];
  const result = allocate(
    groups,
    new Map([
      [10525, 1],
      [10526, 1],
    ]),
    { priorities: [0, 1] },
  );
  assert.deepEqual(
    result.map((g) => g.reduce((n, a) => n + a.count, 0)),
    [1, 1],
  );
  assert.equal(result[0][0].id, 10526);
  assert.equal(result[1][0].id, 10525);
  assert.deepEqual(
    allocate(
      [
        { ids: [10525], count: 3 },
        { ids: [10525], count: 3 },
      ],
      new Map([[10525, 4]]),
      { priorities: [1, 0] },
    ).map((g) => g.reduce((n, a) => n + a.count, 0)),
    [1, 3],
  );
});
test('manual and task reservations remain protected and unknown inventory is not a zero grant', () => {
  const p = {
      ...profile(),
      reservations: { 10246: 1 },
      resourcePriority: ['b', 'a'],
      allocations: [{ questId: 'quest-11010', items: { 10216: 2 } }],
    },
    ref = reference();
  const preview = resourcePriorityPreview(p, ref, ['a', 'b']);
  for (const row of preview.changes) assert.equal(row.items.find((i) => i.id === 10246)?.afterDirect || 0, 0);
  assert.equal(preview.afterPhysicalUsed[10246], 1);
  assert.equal(resourceBudget(p, ref).owners[0].itemAllocations.find((i) => i.id === 10216).allocated, 2);
  assert.equal(
    preview.changes.reduce((n, row) => n + (row.items.find((i) => i.id === 10216)?.afterDirect || 0), 0),
    1,
  );
  assert.equal(preview.afterPhysicalUsed[10216], 3);
  const unknown = resourcePriorityPreview(p, { ...ref, metadata: { fusionRecipes: [1000] } }, ['a', 'b']);
  assert.equal(unknown.inventoryAvailable, false);
  assert.equal(unknown.afterMissingTotal, null);
  assert(unknown.changes.every((row) => row.afterMissing.every((m) => m.count === null)));
});
test('processing impact is included while projected products do not become another owner physical stock', () => {
  const p = { ...profile(), resourcePriority: ['a', 'b'] },
    ref = reference();
  ref.metadata.inventory = [
    { id: 10201, count: 3 },
    { id: 10246, count: 1 },
    { id: 10205, count: 4 },
  ];
  const preview = resourcePriorityPreview(p, ref, ['b', 'a']);
  assert(preview.changes.some((row) => row.items.some((i) => i.beforeProcessing !== i.afterProcessing)));
  for (const physical of [preview.beforePhysicalUsed, preview.afterPhysicalUsed])
    for (const [id, count] of Object.entries(physical))
      assert(count <= ref.metadata.inventory.find((i) => i.id === Number(id)).count);
  assert.equal(preview.afterPhysicalUsed[10216], undefined);
});
test('priority commands require the fresh main-process preview, persist across restart, and stay within their profile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-priority-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog),
    data = store.get();
  Object.assign(data.profiles[0], profile(), { id: data.activeProfileId });
  store.commit(data);
  const p = store.get().profiles[0],
    fingerprint = priorityFingerprint(p, reference());
  const command = { type: 'resource-priority-set', profileId: p.id, order: ['b', 'a'], fingerprint };
  assert.throws(() => store.mutate(command), /预览/);
  store.mutate(command, { resourcePriorityFingerprint: fingerprint });
  assert.deepEqual(new Store(dir, catalog).get().profiles[0].resourcePriority, ['b', 'a']);
  store.mutate({ type: 'profile-add', name: 'another synthetic playthrough' });
  assert.equal(
    store.get().profiles.find((x) => x.id === store.get().activeProfileId).resourcePriority,
    undefined,
  );
});
test('invalid or foreign owners and duplicates are rejected before computing a proposed budget', () => {
  for (const bad of [['a', 'a'], ['../bad'], Array(143).fill('@draft'), ['@gift:']])
    assert.throws(() => validateResourcePriority(bad));
  assert.throws(() => resourcePriorityPreview(profile(), reference(), ['foreign', 'a']), /用途已变化/);
  assert.deepEqual(resourcePriorityPreview(profile(), reference(), []).order, []);
});

test('same-person same-item gift priorities keep each intent distinguishable before and after reordering', async () => {
  const p = {
      ...profile(),
      craftList: [],
      craftPlans: [],
      journey: {
        gifts: [
          {
            id: 'gift-a',
            npcId: 'npc-1',
            itemId: 'item-10216',
            quantity: 1,
            note: '今天告别时赠送 · 甲意图 <原样>',
            done: false,
          },
          {
            id: 'gift-b',
            npcId: 'npc-1',
            itemId: 'item-10216',
            quantity: 1,
            note: '下次探望时赠送 · 乙意图',
            done: false,
          },
        ],
      },
    },
    ref = reference();
  ref.metadata.inventory = [{ id: 10216, count: 1 }];
  const before = structuredClone(p),
    order = ['@gift:gift-b', '@gift:gift-a'];
  const preview = resourcePriorityPreview(p, ref, order);
  const a = preview.changes.find((row) => row.id === '@gift:gift-a'),
    b = preview.changes.find((row) => row.id === '@gift:gift-b');
  assert.match(a.description, /第1份赠礼 · 1件 · 今天告别时赠送 · 甲意图 <原样>/);
  assert.match(b.description, /第2份赠礼 · 1件 · 下次探望时赠送 · 乙意图/);
  assert.equal(a.items[0].beforeDirect, 1);
  assert.equal(a.items[0].afterDirect, 0);
  assert.equal(b.items[0].afterDirect, 1);
  for (const row of [a, b]) {
    assert.equal(row.gift.npcId, 'npc-1');
    assert.equal(row.gift.itemId, 'item-10216');
    assert.equal(row.name, '赠予' + row.gift.npcName + ' · ' + row.gift.itemName);
    assert.deepEqual(
      row.gift,
      resourceBudget(p, ref).priorityOwners.find((owner) => owner.id === row.id).gift,
    );
  }
  assert.deepEqual(
    resourceBudget({ ...p, resourcePriority: order }, ref).priorityOwners.map((row) => row.description),
    [b.description, a.description],
  );
  const { createResourcePriorityViews } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, '../src/renderer/resource-priority-views.js'), 'utf8'),
      ).toString('base64')
  );
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const views = createResourcePriorityViews({ esc, act: () => '', notice: String, when: String });
  const html = views.editor({ order, preview }, { entries: [] });
  for (const row of [a, b]) {
    assert(html.includes('aria-label="上移 ' + esc(row.name + ' · ' + row.description) + '"'));
    assert(html.includes('aria-label="下移 ' + esc(row.name + ' · ' + row.description) + '"'));
    assert(
      views.entry(resourceBudget({ ...p, resourcePriority: order }, ref)).includes(esc(row.description)),
    );
  }
  assert(html.includes('&lt;原样&gt;'));
  assert.equal(html.includes('<原样>'), false);
  assert.deepEqual(p, before);
});

test('priority preview links known allocated items and each alternative without multiplying the group shortage', async () => {
  const { createResourcePriorityViews } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, '../src/renderer/resource-priority-views.js'), 'utf8'),
      ).toString('base64')
  );
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const links = [];
  const views = createResourcePriorityViews({
    esc,
    act: (action, label, cls, id) => {
      if (action === 'database-detail') links.push({ label, cls, id });
      return `<button data-action="${action}" data-id="${esc(id || '')}">${label}</button>`;
    },
    notice: String,
    when: String,
  });
  const group = { name: '可替代原料', ids: [9, 10, 999], count: 4 };
  const preview = {
    inventoryAvailable: true,
    afterOrder: ['a'],
    changes: [
      {
        id: 'a',
        name: '合成计划',
        kind: 'craft',
        beforeMissing: [group],
        afterMissing: [group],
        items: [
          { id: 9, beforeDirect: 2, afterDirect: 1, beforeProcessing: 0, afterProcessing: 1 },
          { id: 999, beforeDirect: 0, afterDirect: 0, beforeProcessing: 1, afterProcessing: 0 },
        ],
      },
    ],
  };
  const before = structuredClone(preview);
  const html = views.editor(
    { order: ['a'], preview },
    {
      entries: [
        { id: 'item-9', name: '铁矿石 <原样>' },
        { id: 'item-10', name: '精铁矿石' },
      ],
    },
  );
  assert.deepEqual(
    links.map((link) => link.id),
    ['item-9', 'item-9', 'item-10'],
  );
  assert(links.every((link) => link.cls === 'text-btn'));
  assert.equal(links[0].label, '铁矿石 &lt;原样&gt;');
  assert.match(html, /直接材料缺口 4 → 4/);
  assert.match(html, /直接分配 2 → 1 · 加工另占 0 → 1/);
  assert.match(html, /物品 #999还缺 4 · 可替代材料组总缺量/);
  assert.equal((html.match(/还缺 4/g) || []).length, 1);
  assert.equal(html.includes('data-id="item-999"'), false);
  assert.deepEqual(preview, before);
});

test('gift purpose and preview titles link their exact identities while personal plan names stay literal', async () => {
  const { createResourcePriorityViews } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, '../src/renderer/resource-priority-views.js'), 'utf8'),
      ).toString('base64')
  );
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const index = {
      entries: [
        { id: 'npc-1', kind: '人物', name: '同名人物' },
        { id: 'npc-2', kind: '人物', name: '同名人物' },
        { id: 'item-9', kind: '物品', name: '同名物品' },
        { id: 'item-10', kind: '物品', name: '同名物品' },
      ],
    },
    gift = {
      npcId: 'npc-2',
      npcName: '同名人物（资料 2/2）',
      itemId: 'item-10',
      itemName: '同名物品（蓝色品质）',
    },
    name = '赠予' + gift.npcName + ' · ' + gift.itemName,
    changes = [
      { id: '@gift:one', kind: 'gift', name, gift, description: '第1份赠礼 · 2件 · <原样>' },
      { id: 'private-plan', kind: 'craft', name: name + ' <私人标题>' },
    ].map((row) => ({ ...row, items: [], beforeMissing: [], afterMissing: [] })),
    summary = { explicitPriority: true, priorityOwners: changes },
    draft = {
      order: changes.map((row) => row.id),
      preview: { changes, afterOrder: changes.map((row) => row.id) },
    },
    before = structuredClone({ summary, draft }),
    links = [],
    views = createResourcePriorityViews({
      esc,
      act: (action, label, cls, id) => {
        if (action === 'database-detail') links.push({ action, label, cls, id });
        return `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`;
      },
      notice: esc,
      when: esc,
      getIndex: () => index,
    });
  const entry = views.entry(summary);
  assert.deepEqual(
    links.map((link) => link.id),
    ['npc-2', 'item-10'],
  );
  assert.match(entry, /资料 2\/2/);
  assert.match(entry, /蓝色品质/);
  assert(entry.includes(esc(changes[1].name)));
  links.length = 0;
  const html = views.editor(draft, index);
  assert.deepEqual(
    links.map((link) => link.id),
    ['npc-2', 'item-10', 'npc-2', 'item-10'],
  );
  assert(links.every((link) => link.cls === 'text-btn'));
  assert.match(
    html,
    /aria-label="上移 赠予同名人物（资料 2\/2） · 同名物品（蓝色品质） · 第1份赠礼 · 2件 · &lt;原样&gt;"/,
  );
  assert.equal(
    (html.match(/赠予同名人物（资料 2\/2） · 同名物品（蓝色品质） &lt;私人标题&gt;/g) || []).length,
    4,
  );
  assert.doesNotMatch(html, /data-id="(?:npc-1|item-9|name:[^"]+)"/);
  links.length = 0;
  const unknown = views.editor(draft, { entries: [] });
  assert.equal(links.length, 0);
  assert(unknown.includes(esc(name)));
  links.length = 0;
  const waiting = views.editor(
    {
      ...draft,
      preview: null,
      owners: Object.fromEntries(changes.map((row) => [row.id, row])),
      loading: true,
    },
    index,
  );
  assert.deepEqual(
    links.map((link) => link.id),
    ['npc-2', 'item-10'],
  );
  assert.match(waiting, /aria-label="上移 [^"]+" disabled/);
  assert.doesNotMatch(waiting, /确认前的材料分配变化|直接材料缺口/);
  assert.deepEqual({ summary, draft }, before);
});
