'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/data/game-index.json');
const world = require('../src/data/world-index.json');
const { applyEntryCommand, appendSystemEvent, validateEntries } = require('../src/core/event-journal.cjs');
const { giftItemLabel, giftPersonLabel } = require('../src/core/gift-labels.cjs');
const views = import(
  require('node:url').pathToFileURL(path.join(__dirname, '../src/renderer/event-journal-views.js')).href
);
const time = '2026-10-09T08:00:00.000Z';
const index = require('../src/core/game-data.cjs').encyclopedia();
const profile = () => ({ id: 'synthetic-profile', goals: [], journey: { gifts: [], todos: [] } });
const context = (p = profile(), data = game) => ({ profile: p, game: data, world });
const command = (links, extra = {}) => ({
  type: 'journal-entry-put',
  title: '资料核对',
  body: '',
  occurredAt: time,
  tags: [],
  links,
  ...extra,
});
const save = (links, ctx = context()) =>
  applyEntryCommand([], command(links), ctx, { now: time, id: 'synthetic-entry' });
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const helpers = {
  esc,
  act: (action, label, cls, id) =>
    `<button data-action="${action}" data-id="${esc(id || '')}">${label}</button>`,
  icon: () => '',
  pill: (label) => `<span>${esc(label)}</span>`,
  notice: esc,
  empty: esc,
  when: esc,
};
const expectedSwords = [
  ['item-1006', '物品 · 长虹剑（绿色品质）'],
  ['item-1007', '物品 · 长虹剑（蓝色品质）'],
  ['item-1008', '物品 · 长虹剑（金色品质）'],
];

test('event reference pages reach every same-name personal intent and identify it by its full memo', async () => {
  const { journalReferenceChoices, createEventJournalViews } = await views;
  const p = profile();
  p.goals = Array.from({ length: 22 }, (_, i) => ({
    id: 'personal-' + String(i + 1).padStart(2, '0'),
    title: '出发前备药',
    detail: `第 ${i + 1} 次出发；独有备忘 ${i + 1 === 22 ? '<末次 & 核对>' : '准备'}`,
    done: i === 0,
  }));
  const factory = createEventJournalViews(helpers);
  const ids = (html) =>
    [...html.matchAll(/data-action="journal-reference-add" data-id="([^"]+)"/g)].map((m) => m[1]);
  const first = factory.referenceResults(p, {}, '出发前备药');
  const second = factory.referenceResults(p, {}, '出发前备药', 2);
  assert.match(first, /找到 22 项 · 第 1 \/ 2 页/);
  assert.match(second, /找到 22 项 · 第 2 \/ 2 页/);
  assert.equal(ids(first).length, 20);
  assert.equal(ids(second).length, 2);
  assert.deepEqual(
    [...new Set([...ids(first), ...ids(second)])].sort(),
    p.goals.map((g) => 'goal:' + g.id).sort(),
  );
  assert.deepEqual(ids(factory.referenceResults(p, {}, '出发前备药', 999)), ids(second));
  assert.deepEqual(ids(factory.referenceResults(p, {}, '出发前备药', -2)), ids(first));
  assert.equal(journalReferenceChoices(p, {}, '出发前备药').length, 20);
  const narrowed = factory.referenceResults(p, {}, '末次 核对');
  assert.deepEqual(ids(narrowed), ['goal:personal-22']);
  assert.match(narrowed, /&lt;末次 &amp; 核对&gt;/);
  assert(!narrowed.includes('<末次'));
  assert.match(factory.referenceResults(profile(), {}, '末次 核对'), /没有匹配/);
  assert.equal(ids(factory.referenceResults(profile(), {}, '末次 核对')).length, 0);
});

test('same-title goals expose only their explicitly saved place and scene in choices and selected links', async () => {
  const { journalReferenceChoices, createEventJournalViews, queryJournalEntries } = await views;
  const p = profile();
  p.goals = [
    { id: 'herbs-mountain', title: '明早采药', detail: '带上空行囊', placeId: 'place-14' },
    { id: 'herbs-woods', title: '明早采药', detail: '带上空行囊', placeId: 'place-22' },
    { id: 'herbs-unplaced', title: '明早采药', detail: '去野猪林，尚未选择地点' },
  ];
  const expected = [
    ['herbs-mountain', '明早采药 · 碗子山'],
    ['herbs-woods', '明早采药 · 野猪林'],
    ['herbs-unplaced', '明早采药'],
  ];
  const before = structuredClone(p);
  const choices = journalReferenceChoices(p, index, '明早采药');
  for (const [id, label] of expected) assert.equal(choices.find((row) => row.id === id).label, label);
  assert.deepEqual(
    journalReferenceChoices(p, index, '明早采药 野猪林 带上空行囊').map((row) => row.id),
    ['herbs-woods'],
  );
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  const results = factory.referenceResults(p, index, '明早采药');
  for (const [id, label] of expected.slice(0, 2)) {
    assert.ok(results.includes(label));
    assert.ok(results.includes(`aria-label="关联 目标 · ${label} · 带上空行囊"`));
    assert.ok(results.includes(`data-id="goal:${id}"`));
  }
  const links = expected.map(([id]) => ({ type: 'goal', id }));
  const entries = save(links, context(p));
  assert.deepEqual(
    entries[0].links,
    links.map((link) => ({ ...link, label: '明早采药' })),
  );
  const stored = { ...p, journalEntries: entries };
  for (const html of [
    factory.selectedReferences(
      p,
      index,
      links.map((link) => 'goal:' + link.id),
    ),
    factory.selectedReferences(
      stored,
      index,
      links.map((link) => 'goal:' + link.id),
      entries[0],
    ),
    factory.page(stored, { readOnly: true }, index),
    factory.detail(stored, entries[0].id, { readOnly: true }),
  ]) {
    assert.ok(html.includes('碗子山'));
    assert.ok(html.includes('野猪林'));
  }
  assert.match(
    factory.selectedReferences(p, index, ['goal:herbs-woods']),
    /aria-label="移除 目标 · 明早采药 · 野猪林 · 当前备忘：带上空行囊"/,
  );
  assert.deepEqual(queryJournalEntries(stored, { query: '碗子山' }, index).matchedIds, [entries[0].id]);
  const unplaced = factory.selectedReferences(p, index, ['goal:herbs-unplaced']);
  assert.ok(!unplaced.includes('场景 #'));
  assert.match(unplaced, /当前备忘：去野猪林，尚未选择地点/);
  assert.deepEqual(p, before);
});

test('selected personal references retain escaped current memos without rewriting history or borrowing detached records', async () => {
  const { createEventJournalViews } = await views;
  const p = profile();
  p.goals = [
    { id: 'medicine-first', title: '出发备药', detail: '第一次 <核对> & 备忘' },
    { id: 'medicine-next', title: '出发备药', detail: '下一次独立备忘' },
  ];
  p.journey.todos = [{ id: 'todo', title: '去药铺', note: '先询问掌柜' }];
  p.craftPlans = [{ id: 'craft', name: '备药计划', note: '留给下一程' }];
  p.journey.gifts = [{ id: 'gift', npcId: 'person-1', itemId: 'item-100', quantity: 1, note: '见面时再送' }];
  const links = [
    { type: 'goal', id: 'medicine-first', label: '原来的目标标题' },
    { type: 'goal', id: 'medicine-next', label: '出发备药' },
  ];
  const entry = { links },
    before = structuredClone({ p, entry });
  const factory = createEventJournalViews(helpers);
  const html = factory.selectedReferences(
    p,
    {},
    ['goal:medicine-first', 'goal:medicine-next', 'todo:todo', 'craft-plan:craft', 'gift:gift'],
    entry,
  );
  assert.match(html, /当前备忘：第一次 &lt;核对&gt; &amp; 备忘/);
  assert.match(html, /aria-label="移除 目标 · 出发备药 · 当前备忘：下一次独立备忘"/);
  for (const memo of ['先询问掌柜', '留给下一程', '见面时再送']) assert(html.includes('当前备忘：' + memo));
  assert(!html.includes('<核对>'));
  assert.deepEqual({ p, entry }, before);
  const detached = factory.selectedReferences(p, {}, ['goal:medicine-first'], {
    links: [{ ...links[0], detached: true }],
  });
  assert.match(detached, /原来的目标标题/);
  assert.match(detached, /原关联已移除/);
  assert(!detached.includes('当前备忘') && !detached.includes('第一次'));
  const missing = factory.selectedReferences(profile(), {}, ['goal:medicine-first'], entry);
  assert(missing.includes('原来的目标标题') && !missing.includes('当前备忘'));
});

test('real duplicate quest titles expose stable variants in choices and accessible selected links', async () => {
  const { journalReferenceChoices, createEventJournalViews } = await views;
  const p = profile();
  const expected = [5230, 9010, 9011].map((id, i) => [
    `quest-${id}`,
    `莫问授剑 · 【主线】拜师武当 · 资料 ${i + 1}/3`,
  ]);
  const choices = journalReferenceChoices(p, index, '莫问授剑');
  assert.equal(choices.length, 3);
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  const results = factory.referenceResults(p, index, '莫问授剑');
  for (const [id, label] of expected) {
    assert.equal(choices.find((row) => row.id === id).label, label);
    assert.ok(results.includes(`aria-label="关联 任务 · ${label}"`));
    assert.deepEqual(
      journalReferenceChoices(p, index, label).map((row) => row.id),
      [id],
    );
    const selected = factory.selectedReferences(p, index, ['quest:' + id]);
    assert.ok(selected.includes(label));
    assert.ok(selected.includes(`aria-label="移除 任务 · ${label}"`));
    assert.ok(selected.includes(`data-id="quest:${id}"`));
  }
  const entries = save(expected.map(([id]) => ({ type: 'quest', id })));
  assert.deepEqual(
    entries[0].links.map((link) => link.id),
    expected.map(([id]) => id),
  );
  assert.deepEqual(
    entries[0].links.map((link) => [link.id, link.label]),
    expected,
  );
  const before = structuredClone(entries);
  const html = factory.selectedReferences(
    { ...p, journalEntries: entries },
    index,
    expected.map(([id]) => 'quest:' + id),
    entries[0],
  );
  for (const [, label] of expected) assert.ok(html.includes(label));
  assert.deepEqual(entries, before);
});

test('long goal and place display context leaves the core persisted label within its original 160-character limit', async () => {
  const { journalReferenceChoices, createEventJournalViews } = await views;
  const p = profile();
  const title = '字'.repeat(148) + '<标题 & "尾部">';
  assert.ok(title.length <= 160);
  const placeName = '山'.repeat(180) + '<地点 & "尾部">';
  p.goals = [{ id: 'long-goal', title, detail: '', placeId: 'place-14' }];
  const displayIndex = { world: { maps: [{ id: 'place-14', gameId: 14, name: placeName }] } };
  const choice = journalReferenceChoices(p, displayIndex, 'long-goal')[0];
  assert.ok(choice.label.endsWith(placeName));
  const entries = save([{ type: 'goal', id: 'long-goal' }], context(p));
  assert.equal(entries[0].links[0].label, title);
  assert.ok(entries[0].links[0].label.length <= 160);
  validateEntries(entries, context(p));
  const factory = createEventJournalViews(helpers);
  for (const html of [
    factory.referenceResults(p, displayIndex, 'long-goal'),
    factory.selectedReferences(p, displayIndex, ['goal:long-goal'], entries[0]),
  ]) {
    assert.ok(html.includes(esc(placeName)));
    assert.ok(html.includes(esc(title)));
    assert.ok(!html.includes('<标题'));
    assert.ok(!html.includes('<地点'));
  }
});

test('goal context and action names escape markup, tolerate unknown scenes and do not infer detached context', async () => {
  const { createEventJournalViews } = await views;
  const p = profile();
  p.goals = [
    {
      id: 'unsafe-goal',
      title: '<script>采药</script>',
      detail: '<img src=x> & "备忘"',
      placeId: 'place-14',
    },
    { id: 'unknown-goal', title: '旧目标', placeId: 'place-999999999' },
  ];
  const unsafeIndex = { world: { maps: [{ id: 'place-14', gameId: 14, name: '<b>山</b> & "地点"' }] } };
  const factory = createEventJournalViews(helpers);
  for (const html of [
    factory.referenceResults(p, unsafeIndex, '采药'),
    factory.selectedReferences(p, unsafeIndex, ['goal:unsafe-goal']),
  ]) {
    assert.ok(html.includes('&lt;script&gt;采药&lt;/script&gt;'));
    assert.ok(html.includes('&lt;b&gt;山&lt;/b&gt; &amp; &quot;地点&quot;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
  }
  assert.ok(
    factory.referenceResults(p, unsafeIndex, '采药').includes('&lt;img src=x&gt; &amp; &quot;备忘&quot;'),
  );
  assert.ok(factory.selectedReferences(p, unsafeIndex, ['goal:unknown-goal']).includes('地点待核对'));
  const entry = { links: [{ type: 'goal', id: 'unsafe-goal', label: '原来的目标', detached: true }] };
  const detached = factory.selectedReferences(p, unsafeIndex, ['goal:unsafe-goal'], entry);
  assert.ok(detached.includes('原来的目标 · 原关联已移除'));
  assert.ok(!detached.includes('场景 #14'));
});

test('real same-name swords expose actual quality in choices, selected references, saved links and history', async () => {
  const { journalReferenceChoices, createEventJournalViews, queryJournalEntries } = await views;
  const p = profile();
  const choices = journalReferenceChoices(p, index, '长虹剑');
  for (const [id, label] of expectedSwords) {
    assert.equal(choices.find((row) => row.id === id).label, label);
    assert.deepEqual(
      journalReferenceChoices(p, index, label).map((row) => row.id),
      [id],
    );
  }
  const links = expectedSwords.map(([id]) => ({ type: 'database', id }));
  const entries = save(links);
  assert.deepEqual(
    entries[0].links,
    expectedSwords.map(([id, label]) => ({ type: 'database', id, label })),
  );
  validateEntries(JSON.parse(JSON.stringify(entries)), context());
  const stored = { ...p, journalEntries: entries };
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  for (const html of [
    factory.referenceResults(p, index, '长虹剑'),
    factory.selectedReferences(
      p,
      index,
      links.map((link) => `database:${link.id}`),
    ),
    factory.selectedReferences(
      stored,
      index,
      links.map((link) => `database:${link.id}`),
      entries[0],
    ),
    factory.page(stored, { readOnly: true }, index),
    factory.detail(stored, entries[0].id, { readOnly: true }),
  ]) {
    for (const [, label] of expectedSwords) assert.ok(html.includes(label), label);
    assert.ok(!html.includes('当前资料：'));
  }
  assert.deepEqual(queryJournalEntries(stored, { query: '长虹剑 蓝色品质' }, index).matchedIds, [
    'synthetic-entry',
  ]);
  assert.throws(() => save([{ type: 'database', id: 'item-1006', label: '长虹剑（红色品质）' }]), /未知字段/);
});

test('a real recipe and its same-name learning item remain separate identities without invented recipe quality', async () => {
  const { journalReferenceChoices, createEventJournalViews } = await views;
  const expected = [
    ['fusion-1002', '配方 · 长虹剑精良图纸'],
    ['item-100002', '物品 · 长虹剑精良图纸（金色品质） · 学习图纸'],
  ];
  const choices = journalReferenceChoices(profile(), index, '长虹剑精良图纸');
  assert.equal(choices.length, 2);
  for (const [id, label] of expected) assert.equal(choices.find((row) => row.id === id).label, label);
  const entries = save(expected.map(([id]) => ({ type: 'database', id })));
  assert.deepEqual(
    entries[0].links.map(({ id, label }) => [id, label]),
    expected,
  );
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  const html = factory.detail({ ...profile(), journalEntries: entries }, entries[0].id);
  for (const [, label] of expected) assert.ok(html.includes(label));
  assert.equal(entries[0].links[0].label.includes('品质'), false);
});

test('all six real item qualities, world-only people and martial arts retain their actual types', async () => {
  const { journalReferenceChoices } = await views;
  for (const quality of ['白', '绿', '蓝', '金', '暗金', '红']) {
    const item = game.entries.find((row) => row.kind === '物品' && row.quality === quality);
    assert.ok(item, quality);
    const label = save([{ type: 'database', id: item.id }])[0].links[0].label;
    assert.ok(label.startsWith('物品 · '));
    assert.ok(label.includes(`（${quality}色品质）`));
    assert.equal(
      journalReferenceChoices(profile(), index, `${item.id} ${label}`).find((row) => row.id === item.id)
        .label,
      label,
    );
  }
  const person = world.people.find((row) => row.id === 'npc-0');
  assert.ok(person && !game.entries.some((row) => row.id === person.id));
  const skill = game.entries.find((row) => row.id === 'skill-100');
  const entries = save([person, skill].map(({ id }) => ({ type: 'database', id })));
  assert.equal(entries[0].links[0].label, '人物 · 宇文逸');
  assert.equal(entries[0].links[1].label, '武学 · 武当剑法（绿色品质）');
  const unknownQuality = { id: 'item-synthetic', kind: '物品', name: '未标注物品' };
  const ctx = context(profile(), { entries: [unknownQuality] });
  assert.equal(
    save([{ type: 'database', id: unknownQuality.id }], ctx)[0].links[0].label,
    '物品 · 未标注物品',
  );
  const longItem = { ...game.entries.find((row) => row.id === 'item-100002'), name: '字'.repeat(200) };
  const bounded = save(
    [{ type: 'database', id: longItem.id }],
    context(profile(), { entries: [longItem] }),
  )[0].links[0];
  assert.equal(bounded.label.length, 160);
  assert.ok(bounded.label.endsWith('（金色品质） · 学习图纸'));
  assert.equal(
    journalReferenceChoices(profile(), { entries: [longItem] }, longItem.id)[0].label,
    bounded.label,
  );
});

test('old names survive editing and rendering while known IDs supply current identity exactly once', async () => {
  const { createEventJournalViews, queryJournalEntries } = await views;
  const entries = save([{ type: 'database', id: 'item-1006' }]);
  entries[0].links[0].label = '当年的长剑';
  const p = { ...profile(), journalEntries: entries };
  let currentIndex = index;
  const factory = createEventJournalViews({ ...helpers, getIndex: () => currentIndex });
  const original = '当年的长剑 · 当前资料：物品 · 长虹剑（绿色品质）';
  assert.ok(factory.detail(p, entries[0].id, { readOnly: true }).includes(original));
  assert.ok(factory.page(p, { readOnly: true }, index).includes(original));
  assert.ok(factory.selectedReferences(p, index, ['database:item-1006'], entries[0]).includes(original));
  assert.equal(entries[0].links[0].label, '当年的长剑');
  const updated = applyEntryCommand(
    entries,
    command([{ type: 'database', id: 'item-1006' }], {
      type: 'journal-entry-update',
      id: entries[0].id,
      expectedEntry: entries[0],
      body: '继续写正文',
    }),
    context(p),
    { now: time },
  );
  assert.equal(updated[0].links[0].label, '当年的长剑');
  const renamed = { ...game.entries.find((row) => row.id === 'item-1006'), name: '新的索引名称' };
  currentIndex = { entries: [renamed], world };
  assert.ok(
    factory.detail(p, entries[0].id).includes('当年的长剑 · 当前资料：物品 · 新的索引名称（绿色品质）'),
  );
  assert.ok(factory.page(p, {}, index).includes(original));
  assert.deepEqual(queryJournalEntries(p, { query: '当年的长剑 绿色品质' }, index).matchedIds, [
    entries[0].id,
  ]);
  const augmented = structuredClone(entries);
  augmented[0].links[0].label = original;
  const html = factory.detail({ ...p, journalEntries: augmented }, entries[0].id, {}, index);
  const display = html.split('<details><summary>原始记录信息</summary>')[0];
  assert.equal(display.split('当前资料：').length - 1, 1);
  assert.ok(html.includes('<summary>原始记录信息</summary>'));
  assert.equal(augmented[0].links[0].label, original);
});

test('missing and detached legacy references keep historical labels and do not acquire current qualities', async () => {
  const { createEventJournalViews } = await views;
  const entries = save([{ type: 'database', id: 'item-1006' }]);
  entries[0].links = [
    { type: 'database', id: 'item-1006', label: '移除前的旧剑名', detached: true },
    { type: 'database', id: 'item-missing', label: '旧版未知物品', detached: true },
  ];
  validateEntries(entries, context());
  const p = { ...profile(), journalEntries: entries };
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  for (const html of [
    factory.detail(p, entries[0].id, { readOnly: true }),
    factory.selectedReferences(
      p,
      index,
      entries[0].links.map((link) => `database:${link.id}`),
      entries[0],
    ),
  ]) {
    assert.ok(html.includes('移除前的旧剑名 · 原关联已移除'));
    assert.ok(html.includes('旧版未知物品 · 原关联已移除'));
    assert.ok(!html.includes('当前资料：'));
    assert.ok(!html.includes('色品质'));
  }
  const missing = structuredClone(entries);
  missing[0].links = [{ type: 'database', id: 'item-missing', label: '缺失旧资料' }];
  const html = factory.detail({ ...p, journalEntries: missing }, entries[0].id);
  assert.ok(html.includes('缺失旧资料'));
  assert.ok(!html.includes('当前资料：'));
});

test('gift selection, stored user events and legacy display reuse exact gift quality and person numbering', async () => {
  const { journalReferenceChoices, createEventJournalViews } = await views;
  const p = profile();
  p.journey.gifts = [
    { id: 'synthetic-gift', npcId: 'npc-5011', itemId: 'item-1006', quantity: 2, done: true },
  ];
  const person = game.entries.find((row) => row.id === 'npc-5011');
  const item = game.entries.find((row) => row.id === 'item-1006');
  const expected = `${giftPersonLabel(person, game.entries)} · ${giftItemLabel(item)} × 2`;
  assert.match(expected, /道通（初始等级 70）/);
  const choice = journalReferenceChoices(p, index, '长虹剑').find((row) => row.type === 'gift');
  assert.equal(choice.label, expected);
  const entries = appendSystemEvent(
    [],
    { type: 'gift', id: 'synthetic-gift', beforeDone: false, afterDone: true },
    context(p),
    { now: time, id: 'gift-event' },
  );
  assert.equal(entries[0].links.find((link) => link.type === 'gift').label, expected);
  assert.equal(entries[0].links.find((link) => link.id === item.id).label, expectedSwords[0][1]);
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  assert.ok(factory.selectedReferences(p, index, ['gift:synthetic-gift']).includes(expected));
  assert.ok(factory.detail({ ...p, journalEntries: entries }, 'gift-event').includes(expected));
  const legacy = save([{ type: 'gift', id: 'synthetic-gift' }], context(p));
  legacy[0].links[0].label = '原赠礼名称';
  assert.ok(
    factory
      .detail({ ...p, journalEntries: legacy }, legacy[0].id)
      .includes(`原赠礼名称 · 当前资料：${expected}`),
  );
  const updated = applyEntryCommand(
    legacy,
    command([{ type: 'gift', id: 'synthetic-gift' }], {
      type: 'journal-entry-update',
      id: legacy[0].id,
      expectedEntry: legacy[0],
    }),
    context(p),
    { now: time },
  );
  assert.equal(updated[0].links[0].label, '原赠礼名称');
});

test('real same-name places retain exact scene suffix rules alongside database identity', async () => {
  const { journalReferenceChoices, createEventJournalViews } = await views;
  const scenes = world.maps.filter((row) => row.name === '梧桐村');
  assert.deepEqual(scenes.map((row) => row.id).sort(), ['place-10', 'place-63', 'place-64', 'place-9']);
  const choices = journalReferenceChoices(profile(), index, '梧桐村').filter((row) => row.type === 'place');
  assert.equal(new Set(choices.map((row) => row.label)).size, 4);
  const entries = save([
    { type: 'place', id: 'place-63' },
    { type: 'database', id: 'item-1006' },
  ]);
  assert.equal(entries[0].links[0].label, '梧桐村 · 场景 3');
  entries[0].links[0] = { type: 'place', id: 'place-63', label: '旧名 · 场景 #9', detached: true };
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  const p = { ...profile(), journalEntries: entries };
  const html = factory.detail(p, entries[0].id, { readOnly: true });
  assert.ok(html.includes('旧名 · 场景 #9 · 原关联已移除'));
  assert.ok(!html.includes('场景 3'));
  entries[0].links[0].label = '旧名 · 场景 #63';
  const exact = factory.detail(p, entries[0].id, { readOnly: true });
  assert.ok(exact.includes('旧名 · 场景 #63 · 原关联已移除'));
  assert.ok(!exact.includes('场景 #63 · 场景 #63'));
});

test('both current identities and preserved legacy names are escaped on all reference surfaces', async () => {
  const { createEventJournalViews } = await views;
  const item = {
    ...game.entries.find((row) => row.id === 'item-1006'),
    name: '<img src=x onerror="attack">&',
  };
  const unsafeIndex = { entries: [item], world };
  const entries = save([{ type: 'database', id: item.id }]);
  entries[0].links[0].label = '<script>legacy</script>';
  const p = { ...profile(), journalEntries: entries };
  const factory = createEventJournalViews({ ...helpers, getIndex: () => unsafeIndex });
  for (const html of [
    factory.referenceResults(p, unsafeIndex, item.id),
    factory.selectedReferences(p, unsafeIndex, [`database:${item.id}`], entries[0]),
    factory.page(p, {}, unsafeIndex),
    factory.detail(p, entries[0].id, { readOnly: true }),
  ]) {
    assert.ok(html.includes('&lt;img src=x onerror=&quot;attack&quot;&gt;&amp;'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script>'));
  }
  assert.ok(factory.detail(p, entries[0].id).includes('&lt;script&gt;legacy&lt;/script&gt;'));
});

test('legacy system identity suffixes render human variants while edits preserve exact saved labels and IDs', async () => {
  const { createEventJournalViews, queryJournalEntries } = await views;
  const entries = save([
    { type: 'place', id: 'place-63' },
    { type: 'quest', id: 'quest-9010' },
    { type: 'database', id: 'npc-5011' },
  ]);
  const person = game.entries.find((row) => row.id === 'npc-5011');
  entries[0].links[0].label = '梧桐村 · 场景 #63';
  entries[0].links[1].label = '莫问授剑 · 任务 #9010';
  entries[0].links[2].label = `人物 · ${person.name}（资料编号 ${person.gameId}）`;
  const p = { ...profile(), journalEntries: entries };
  const before = structuredClone(entries);
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  for (const html of [
    factory.page(p, {}, index),
    factory.selectedReferences(
      p,
      index,
      entries[0].links.map((link) => `${link.type}:${link.id}`),
      entries[0],
    ),
    factory.detail(p, entries[0].id).split('<details><summary>原始记录信息</summary>')[0],
    factory
      .revisionContent({ id: 'old-version', entry: entries[0], replacedAt: time })
      .split('<details><summary>原始记录信息</summary>')[0],
  ]) {
    assert.ok(html.includes('梧桐村 · 场景 3'));
    assert.ok(html.includes('莫问授剑 · 【主线】拜师武当 · 资料 2/3'));
    assert.match(html, /人物 · 道通（初始等级 70）/);
    assert.doesNotMatch(html, /场景 #|任务 #|资料编号/);
  }
  const updated = applyEntryCommand(
    entries,
    command(
      entries[0].links.map(({ type, id }) => ({ type, id })),
      {
        type: 'journal-entry-update',
        id: entries[0].id,
        expectedEntry: entries[0],
        body: '继续写原来的记录',
      },
    ),
    context(p),
    { now: time },
  );
  assert.deepEqual(updated[0].links, before[0].links);
  assert.deepEqual(entries, before);
  assert.deepEqual(queryJournalEntries(p, { query: '场景 #63 任务 #9010' }, index).matchedIds, [
    entries[0].id,
  ]);
  assert.deepEqual(queryJournalEntries(p, { query: '梧桐村 场景 3 资料 2/3' }, index).matchedIds, [
    entries[0].id,
  ]);
  const raw = factory.detail(p, entries[0].id).split('<details><summary>原始记录信息</summary>')[1];
  for (const link of before[0].links) {
    assert.ok(raw.includes(esc(link.label)));
    assert.ok(raw.includes(link.id));
  }
});

test('same-name people use exact stable variants in fresh saved links and accessible choices', async () => {
  const { createEventJournalViews, journalReferenceChoices } = await views;
  const person = game.entries.find((row) => row.id === 'npc-5011');
  const people = [...new Map([...world.people, ...game.entries].map((row) => [row.id, row])).values()].filter(
    (row) => row.kind === '人物' && row.name === person.name,
  );
  assert.ok(people.length > 1);
  const expected = [
    ['npc-5011', '人物 · 道通（初始等级 70）'],
    ['npc-5030', '人物 · 道通（同名 2/2）'],
  ];
  const choices = journalReferenceChoices(profile(), index, person.name).filter((row) =>
    expected.some(([id]) => row.id === id),
  );
  assert.equal(new Set(choices.map((row) => row.label)).size, expected.length);
  const factory = createEventJournalViews(helpers);
  const html = factory.referenceResults(profile(), index, person.name);
  for (const [id, label] of expected) {
    assert.equal(choices.find((row) => row.id === id).label, label);
    assert.equal(save([{ type: 'database', id }])[0].links[0].label, label);
    assert.ok(html.includes(`aria-label="关联 图鉴 · ${label}"`));
    assert.deepEqual(
      journalReferenceChoices(profile(), index, label).map((row) => row.id),
      [id],
    );
  }
});

test('ambiguous legacy place IDs and detached references never borrow a current scene identity', async () => {
  const { createEventJournalViews, journalReferenceChoices, queryJournalEntries } = await views;
  for (const name of ['山野客栈', '仙人渡', '客房', '仙人渡密室'])
    assert.equal(
      journalReferenceChoices(profile(), index, name).filter(
        (row) => row.type === 'place' && ['place-96', 'place-97'].includes(row.id),
      ).length,
      0,
    );
  const entries = save([{ type: 'place', id: 'place-63' }]);
  entries[0].links = [
    { type: 'place', id: 'place-96', label: '当年投宿的客栈 · 场景 #96' },
    { type: 'place', id: 'place-63', label: '旧名 · 场景 #9', detached: true },
    { type: 'quest', id: 'quest-9010', label: '原来的任务 · 任务 #9010', detached: true },
    { type: 'database', id: 'npc-5011', label: '原来的朋友（资料编号 5011）', detached: true },
  ];
  const p = { ...profile(), journalEntries: entries };
  const before = structuredClone(p);
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  for (const html of [
    factory.page(p, { readOnly: true }, index),
    factory.selectedReferences(
      p,
      index,
      entries[0].links.map((link) => `${link.type}:${link.id}`),
      entries[0],
    ),
  ]) {
    for (const link of entries[0].links) assert.ok(html.includes(link.label));
    assert.doesNotMatch(html, /当前资料：|场景 3|资料 2\/3/);
  }
  for (const name of ['山野客栈', '仙人渡'])
    assert.equal(queryJournalEntries(p, { query: name }, index).total, 0);
  assert.deepEqual(queryJournalEntries(p, { query: '当年投宿的客栈' }, index).matchedIds, [entries[0].id]);
  assert.ok(factory.selectedReferences(p, index, ['place:place-96']).includes('原关联资料'));
  assert.deepEqual(p, before);
});

test('legacy duplicate places stay unresolved in drafts, trash, history and newly recorded actions', async () => {
  const load = (file) =>
    import(require('node:url').pathToFileURL(path.join(__dirname, '../src/renderer', file)).href);
  const [
    { createIntentDraftViews },
    { createJourneyTrashViews },
    { createProtectionViews },
    { placeChoiceLabel },
  ] = await Promise.all(
    ['intent-draft-views.js', 'journey-trash-views.js', 'protection-views.js', 'place-picker.js'].map(load),
  );
  const draftViews = createIntentDraftViews({ ...helpers, placeLabel: placeChoiceLabel });
  const trashViews = createJourneyTrashViews({ ...helpers, placeLabel: placeChoiceLabel });
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const body = app
    .slice(app.indexOf('const protectionViews ='))
    .match(/  name: \(id\) => \{([\s\S]*?)\n  \},\n\}\);/)[1];
  const name = require('node:vm').runInNewContext('(id) => {' + body + '}', {
    gameIndex: index,
    catalog: { entries: [] },
  });
  const archiveViews = createProtectionViews({
    ...helpers,
    name,
    backupViews: { page: () => '' },
    journalPage: () => '',
    historyBackupView: {},
  });
  for (const id of ['place-96', 'place-97']) {
    const expected = '原地点（场景待核对）';
    const matches = world.maps.filter((row) => row.id === id);
    assert.equal(matches.length, 2);
    assert.equal(draftViews.title({ kind: 'journey-place', targetId: id, values: {} }, index), expected);
    assert.equal(trashViews.title({ kind: 'place', record: { placeId: id } }, index), expected);
    assert.equal(name(id), expected);
    const p = { ...profile(), name: '合成历史', notes: '', craftPlans: [] };
    p.journey.places = [{ placeId: id, note: '保留原笔记' }];
    p.journey.todos = [{ id: 'old-todo', title: '原待办', placeId: id, done: true }];
    p.journey.gifts = [];
    p.journey.handledActionIds = [];
    const before = structuredClone(p);
    const html = archiveViews.page({
      archives: [],
      loaded: true,
      history: {
        id: 'synthetic-history',
        createdAt: time,
        compatible: true,
        journal: { profiles: [p] },
        backups: [],
        timeline: { records: [] },
      },
    });
    assert(html.includes(expected));
    assert(html.includes('保留原笔记'));
    for (const place of matches) assert(!html.includes(place.name), 'history does not choose a scene');
    const entries = appendSystemEvent(
      [],
      { type: 'todo', id: 'old-todo', beforeDone: false, afterDone: true },
      context(p),
      { now: time, id: 'synthetic-place-event' },
    );
    const link = entries[0].links.find((row) => row.type === 'place');
    assert.equal(link.id, id);
    assert.equal(link.label, expected);
    assert.deepEqual(p, before);
  }
  assert.equal(name('place-9'), '梧桐村');
});
