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
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(__dirname, '../src/renderer/event-journal-views.js')).toString('base64')
);
const time = '2026-10-09T08:00:00.000Z';
const index = { entries: game.entries, world };
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
  assert.equal(html.split('当前资料：').length - 1, 1);
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
  assert.ok(expected.includes('资料编号'));
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
  assert.equal(entries[0].links[0].label, '梧桐村 · 场景 #63');
  entries[0].links[0] = { type: 'place', id: 'place-63', label: '旧名 · 场景 #9', detached: true };
  const factory = createEventJournalViews({ ...helpers, getIndex: () => index });
  const p = { ...profile(), journalEntries: entries };
  const html = factory.detail(p, entries[0].id, { readOnly: true });
  assert.ok(html.includes('旧名 · 场景 #9 · 场景 #63 · 原关联已移除'));
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
