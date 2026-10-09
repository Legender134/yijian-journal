'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_ENTRIES,
  validateEntries,
  applyEntryCommand,
  appendSystemEvent,
  detachLinks,
} = require('../src/core/event-journal.cjs');
const T0 = '2026-10-08T08:00:00.000Z';
const T1 = '2026-10-09T08:00:00.000Z';
const context = (extra = {}) => ({
  profile: {
    id: 'synthetic-profile',
    notes: '旧札记保留',
    goals: [
      {
        id: 'goal-1',
        title: '去梧桐村见上官虹',
        detail: '',
        done: true,
        source: { type: 'quest', id: 'quest-1' },
      },
    ],
    craftPlans: [{ id: 'plan-1', name: '一份备料计划' }],
    journey: {
      todos: [{ id: 'todo-1', title: '回村探望', done: true, placeId: 'place-1' }],
      gifts: [
        { id: 'gift-1', npcId: 'npc-1', itemId: 'item-1', quantity: 2, done: true, placeId: 'place-1' },
      ],
    },
  },
  game: {
    entries: [
      { id: 'npc-1', name: '上官虹', kind: '人物' },
      { id: 'item-1', name: '黄酒', kind: '物品' },
    ],
  },
  world: {
    maps: [{ id: 'place-1', name: '梧桐村' }],
    quests: [{ id: 'quest-1', name: '拜访故人' }],
    people: [],
  },
  catalog: { entries: [{ id: 'guide-1', title: '出发前的提醒' }] },
  selectedReference: {
    name: '1.sav',
    hash: 'a'.repeat(64),
    modifiedAt: T0,
    path: 'C:\\synthetic-only\\1.sav',
    nativeLoadToken: 'never-persist',
    metadata: { mapName: '梧桐村', playSeconds: 7201, inventory: ['never-persist'] },
  },
  ...extra,
});
const entry = (extra = {}) => ({
  id: 'entry-1',
  kind: 'manual',
  title: '第一件事',
  body: '记下当时的决定',
  occurredAt: T0,
  createdAt: T0,
  updatedAt: T0,
  tags: ['朋友'],
  links: [],
  ...extra,
});
const put = (extra = {}) => ({
  type: 'journal-entry-put',
  title: '一段经历',
  body: '当时正文',
  occurredAt: T0,
  tags: ['朋友'],
  links: [],
  ...extra,
});
const update = (extra = {}) => ({
  ...put(),
  type: 'journal-entry-update',
  id: 'entry-1',
  expectedEntry: entry(),
  ...extra,
});
const options = (extra = {}) => ({ now: T1, id: 'new-entry', ...extra });
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const views = import(
  'data:text/javascript;base64,' +
    fs.readFileSync(path.join(__dirname, '../src/renderer/event-journal-views.js')).toString('base64')
);

test('valid ISO dates include leap days and offsets; impossible dates and ambiguous times are rejected', () => {
  for (const value of ['2024-02-29T23:59:59Z', '2026-10-09T16:00:00+08:00', T0])
    assert.doesNotThrow(() => validateEntries([entry({ occurredAt: value })], context()));
  for (const value of [
    '2025-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-09T24:00:00Z',
    '2026-10-09T08:60:00Z',
    '2026-10-09T08:00:60Z',
    '2026-10-09',
    '2026-10-09T08:00:00',
    'bad',
    '2026-10-09T08:00:00+24:00',
  ])
    assert.throws(() => validateEntries([entry({ occurredAt: value })], context()), /时间|日期/);
  assert.throws(() => validateEntries([entry({ updatedAt: '2026-10-07T00:00:00Z' })], context()), /早于/);
});

test('entry shape, IDs, text, tags, duplicate identity and bounds are strict', () => {
  const ctx = context();
  assert.doesNotThrow(() =>
    validateEntries(
      [
        entry({
          id: 'A'.repeat(80),
          title: '字'.repeat(160),
          body: '字'.repeat(4000),
          tags: Array.from({ length: 10 }, (_, i) => String(i).padEnd(30, '字')),
        }),
      ],
      ctx,
    ),
  );
  for (const extra of [
    { id: 'A'.repeat(81) },
    { id: '../file' },
    { kind: 'game-completed' },
    { title: '' },
    { title: '字'.repeat(161) },
    { body: '字'.repeat(4001) },
    { body: '\u0000' },
    { tags: [''] },
    { tags: [' x'] },
    { tags: ['PVP', 'pvp'] },
    { tags: ['字'.repeat(31)] },
    { tags: Array(11).fill('x') },
    { extra: true },
    { nativeLoad: true },
  ])
    assert.throws(() => validateEntries([entry(extra)], ctx));
  assert.throws(() => validateEntries([entry(), entry()], ctx), /重复/);
  assert.throws(() => validateEntries([entry()], { profile: { id: '' } }), /周目/);
  assert.throws(() => validateEntries({}, ctx), /5000/);
});

test('all link types require actual local indexes or current-profile ownership', () => {
  const ctx = context();
  ctx.world.people.push({ id: 'npc-world-only', name: '仅在人口资料的人物' });
  assert.doesNotThrow(() =>
    applyEntryCommand([], put({ links: [{ type: 'database', id: 'npc-world-only' }] }), ctx, options()),
  );
  const specs = [
    { type: 'database', id: 'npc-1' },
    { type: 'quest', id: 'quest-1' },
    { type: 'place', id: 'place-1' },
    { type: 'guide', id: 'guide-1' },
    { type: 'goal', id: 'goal-1' },
    { type: 'craft-plan', id: 'plan-1' },
    { type: 'todo', id: 'todo-1' },
    { type: 'gift', id: 'gift-1' },
  ];
  const result = applyEntryCommand([], put({ links: specs }), ctx, options());
  assert.equal(result[0].links.length, 8);
  assert.equal(result[0].links[0].label, '人物 · 上官虹');
  assert.equal(result[0].links[7].label, '上官虹 · 黄酒 × 2');
  for (const spec of specs)
    assert.throws(
      () => applyEntryCommand([], put({ links: [{ ...spec, id: 'foreign-or-unknown' }] }), ctx, options()),
      /关联不存在/,
    );
  assert.throws(() => applyEntryCommand([], put({ links: [...specs, specs[0]] }), ctx, options()), /8 项/);
  assert.throws(() => applyEntryCommand([], put({ links: [specs[0], specs[0]] }), ctx, options()), /重复/);
  for (const extra of [
    { profileId: 'other-profile' },
    { detached: true },
    { label: '伪造名称' },
    { path: '/tmp/a' },
  ])
    assert.throws(
      () => applyEntryCommand([], put({ links: [{ ...specs[4], ...extra }] }), ctx, options()),
      /未知字段/,
    );
  assert.throws(
    () => applyEntryCommand([], put({ links: [{ type: 'native', id: '1' }] }), ctx, options()),
    /关联类型/,
  );
  const other = context({
    profile: { id: 'other-profile', goals: [], craftPlans: [], journey: { todos: [], gifts: [] } },
  });
  assert.throws(() => validateEntries(result, other), /当前周目/);
});

test('manual put, update and remove are immutable and use trusted clocks and generated identity', () => {
  const input = freeze([entry()]);
  const command = freeze(put({ title: '  新经历  ', occurredAt: '2026-10-09T16:00:00+08:00' }));
  const ctx = freeze(context());
  const result = applyEntryCommand(input, command, ctx, { now: () => T1, id: () => 'new-entry' });
  assert.equal(input.length, 1);
  assert.equal(result.length, 2);
  assert.equal(result[1].id, 'new-entry');
  assert.equal(result[1].title, '新经历');
  assert.equal(result[1].occurredAt, T1);
  assert.equal(result[1].createdAt, T1);
  assert.equal(ctx.profile.notes, '旧札记保留');
  const edited = applyEntryCommand(
    result,
    update({ title: '编辑标题', occurredAt: '2026-10-07T12:00:00Z' }),
    ctx,
    options(),
  );
  assert.equal(edited[0].createdAt, T0);
  assert.equal(edited[0].updatedAt, T1);
  assert.equal(edited[0].occurredAt, '2026-10-07T12:00:00.000Z');
  assert.equal(result[0].title, '第一件事');
  const removed = applyEntryCommand(
    edited,
    { type: 'journal-entry-remove', id: 'entry-1', expectedEntry: edited[0] },
    ctx,
  );
  assert.equal(removed.length, 1);
  assert.equal(edited.length, 2);
  const afterClockRollback = applyEntryCommand(
    input,
    update(),
    ctx,
    options({ now: '2026-10-01T00:00:00Z' }),
  );
  assert.equal(afterClockRollback[0].createdAt, T0);
  assert.ok(Date.parse(afterClockRollback[0].updatedAt) > Date.parse(input[0].updatedAt));
  assert.equal(input[0].updatedAt, T0);
});

test('commands cannot submit system kinds, generated timestamps, identity or snapshot payloads', () => {
  for (const extra of [
    { kind: 'goal-completed' },
    { kind: 'manual' },
    { createdAt: T0 },
    { updatedAt: T0 },
    { id: 'chosen-by-renderer' },
    { snapshot: {} },
    { profileId: 'other' },
    { source: 'system' },
  ])
    assert.throws(() => applyEntryCommand([], put(extra), context(), options()), /未知字段/);
  assert.throws(() => applyEntryCommand([], { type: 'unknown' }, context()), /未知记录命令/);
  assert.throws(() => applyEntryCommand([], update(), context()), /不存在/);
  assert.throws(() => applyEntryCommand([entry()], put(), context(), options({ id: 'entry-1' })), /ID 重复/);
});

test('record removal binds confirmation to the complete record, including edits and detached links', () => {
  const ctx = context();
  const original = entry({ links: [{ type: 'goal', id: 'goal-1', label: '去梧桐村见上官虹' }] });
  const changed = applyEntryCommand(
    [original],
    update({ body: '另一窗口的新正文', expectedEntry: original }),
    ctx,
    options(),
  );
  for (const command of [
    { type: 'journal-entry-remove', id: original.id, expectedEntry: original },
    { type: 'journal-entries-remove', ids: [original.id], expectedEntries: [original] },
  ]) {
    assert.throws(() => applyEntryCommand(changed, command, ctx), /已变化/);
    assert.equal(changed[0].body, '另一窗口的新正文');
  }
  assert.throws(
    () => applyEntryCommand(changed, { type: 'journal-entry-remove', id: original.id }, ctx),
    /核对/,
  );
  assert.throws(
    () => applyEntryCommand(changed, { type: 'journal-entries-remove', ids: [original.id] }, ctx),
    /核对/,
  );
  const detached = detachLinks([original], 'goal', 'goal-1');
  assert.equal(detached[0].updatedAt, original.updatedAt);
  assert.throws(
    () =>
      applyEntryCommand(
        detached,
        { type: 'journal-entry-remove', id: original.id, expectedEntry: original },
        ctx,
      ),
    /已变化/,
  );
  assert.deepEqual(
    applyEntryCommand(
      detached,
      { type: 'journal-entry-remove', id: original.id, expectedEntry: detached[0] },
      ctx,
    ),
    [],
  );
  assert.throws(
    () =>
      applyEntryCommand(
        changed,
        { type: 'journal-entries-remove', ids: [original.id], expectedEntries: [changed[0], changed[0]] },
        ctx,
      ),
    /核对/,
  );
});

test('snapshot comes only from selected reference, with a strict path-free readonly projection', () => {
  const result = applyEntryCommand([], put({ snapshotMode: 'selected' }), context(), options());
  assert.deepEqual(result[0].snapshot, {
    name: '1.sav',
    hash: 'a'.repeat(64),
    modifiedAt: T0,
    mapName: '梧桐村',
    playSeconds: 7201,
  });
  assert.ok(!JSON.stringify(result).includes('synthetic-only'));
  assert.ok(!JSON.stringify(result).includes('never-persist'));
  const edited = applyEntryCommand(
    result,
    update({ id: 'new-entry', expectedEntry: result[0] }),
    context({ selectedReference: null }),
    options(),
  );
  assert.deepEqual(edited[0].snapshot, result[0].snapshot);
  const detached = applyEntryCommand(
    edited,
    update({ id: 'new-entry', expectedEntry: edited[0], snapshotMode: 'none' }),
    context(),
    options(),
  );
  assert.equal(detached[0].snapshot, undefined);
  assert.throws(
    () =>
      applyEntryCommand(
        [],
        put({ snapshotMode: 'selected' }),
        context({ selectedReference: null }),
        options(),
      ),
    /没有/,
  );
  assert.throws(() => applyEntryCommand([], put({ snapshotMode: 'keep' }), context(), options()), /选择/);
  const valid = result[0].snapshot;
  for (const extra of [
    { path: 'C:\\secret' },
    { nativeLoadToken: 'token' },
    { name: '../1.sav' },
    { name: 'C:\\1.sav' },
    { name: 'a.txt' },
    { hash: 'wrong' },
    { modifiedAt: 'bad' },
    { playSeconds: -1 },
    { playSeconds: Infinity },
    { mapName: 'C:\\secret' },
  ])
    assert.throws(() => validateEntries([entry({ snapshot: { ...valid, ...extra } })], context()));
});

test('only verified user transitions append system events; unchanged booleans do not append', () => {
  for (const type of ['goal', 'todo', 'gift']) {
    const result = appendSystemEvent(
      [],
      { type, id: `${type}-1`, beforeDone: false, afterDone: true },
      context(),
      options({ id: `${type}-event` }),
    );
    assert.equal(result[0].kind, `${type}-completed`);
    assert.equal(result[0].createdAt, T1);
    assert.match(result[0].title, /你标为完成/);
    assert.match(result[0].body, /游戏中的实际状态仍需/);
    assert.equal(result[0].links[0].type, type);
    assert.equal(result[0].snapshot, undefined);
    const ctx = context();
    const row =
      type === 'goal' ? ctx.profile.goals[0] : ctx.profile.journey[type === 'todo' ? 'todos' : 'gifts'][0];
    row.done = false;
    const reopened = appendSystemEvent(
      result,
      { type, id: `${type}-1`, beforeDone: true, afterDone: false },
      ctx,
      options({ id: `${type}-reopened-event` }),
    );
    assert.equal(reopened[1].kind, `${type}-reopened`);
    assert.equal(reopened[0].kind, `${type}-completed`);
  }
  const unchanged = freeze([entry()]);
  assert.equal(
    appendSystemEvent(
      unchanged,
      { type: 'goal', id: 'goal-1', beforeDone: true, afterDone: true },
      context(),
    ),
    unchanged,
  );
  assert.throws(
    () =>
      appendSystemEvent([], { type: 'goal', id: 'goal-1', beforeDone: true, afterDone: false }, context()),
    /不一致/,
  );
  assert.throws(
    () =>
      appendSystemEvent([], { type: 'goal', id: 'foreign', beforeDone: false, afterDone: true }, context()),
    /不一致/,
  );
  assert.throws(
    () => appendSystemEvent([], { type: 'goal', id: 'goal-1', beforeDone: 0, afterDone: true }, context()),
    /变化/,
  );
  for (const extra of [{ title: '伪造' }, { createdAt: T0 }, { kind: 'game-completed' }])
    assert.throws(
      () =>
        appendSystemEvent(
          [],
          { type: 'goal', id: 'goal-1', beforeDone: false, afterDone: true, ...extra },
          context(),
        ),
      /未知字段/,
    );
});

test('system events can attach trusted references but cannot be edited as manual entries', () => {
  const result = appendSystemEvent(
    [],
    { type: 'goal', id: 'goal-1', beforeDone: false, afterDone: true },
    context(),
    options({ snapshot: true }),
  );
  assert.equal(result[0].snapshot.name, '1.sav');
  assert.throws(() => applyEntryCommand(result, update({ id: 'new-entry' }), context(), options()), /不能/);
  assert.deepEqual(
    applyEntryCommand(
      result,
      { type: 'journal-entry-remove', id: 'new-entry', expectedEntry: result[0] },
      context(),
    ),
    [],
  );
  assert.equal(result.length, 1);
  assert.throws(() => validateEntries([entry({ kind: 'goal-completed' })], context()), /原对象关联/);
});

test('detach preserves historical link identity and label, and manual commands cannot invent it', () => {
  const ctx = context();
  const original = freeze(
    applyEntryCommand([], put({ links: [{ type: 'goal', id: 'goal-1' }] }), ctx, options()),
  );
  const detached = detachLinks(original, 'goal', 'goal-1');
  assert.equal(detached[0].links[0].detached, true);
  assert.equal(original[0].links[0].detached, undefined);
  assert.equal(detached[0].links[0].label, '去梧桐村见上官虹');
  assert.equal(detached[0].occurredAt, T0);
  ctx.profile.goals = [];
  assert.doesNotThrow(() => validateEntries(detached, ctx));
  assert.throws(() => validateEntries(original, ctx), /不存在/);
  const revised = applyEntryCommand(
    detached,
    update({ id: 'new-entry', expectedEntry: detached[0], links: [{ type: 'goal', id: 'goal-1' }] }),
    ctx,
    options(),
  );
  assert.deepEqual(revised[0].links, detached[0].links);
  const cleared = applyEntryCommand(
    revised,
    update({ id: 'new-entry', expectedEntry: revised[0], links: [] }),
    ctx,
    options(),
  );
  assert.deepEqual(cleared[0].links, []);
  for (const link of [
    { type: 'goal', id: 'goal-1', label: '', detached: true },
    { type: 'native', id: 'goal-1', label: 'old', detached: true },
    { type: 'goal', id: 'goal-1', label: 'old', detached: false },
    { type: 'goal', id: 'goal-1', label: 'old', detached: true, path: 'private' },
  ])
    assert.throws(() => validateEntries([entry({ links: [link] })], ctx));
});

test('5000 entries are valid; an update remains possible and entry 5001 is rejected without eviction', () => {
  const list = Array.from({ length: MAX_ENTRIES }, (_, i) => entry({ id: `entry-${i}` }));
  const ctx = context();
  assert.equal(validateEntries(list, ctx), list);
  const changed = applyEntryCommand(
    list,
    update({ id: 'entry-4999', expectedEntry: list[4999], title: '编辑末条' }),
    ctx,
    options(),
  );
  assert.equal(changed.length, MAX_ENTRIES);
  assert.equal(changed[4999].title, '编辑末条');
  assert.throws(() => applyEntryCommand(list, put(), ctx, options()), /5000/);
  assert.throws(
    () =>
      appendSystemEvent(
        list,
        { type: 'goal', id: 'goal-1', beforeDone: false, afterDone: true },
        ctx,
        options(),
      ),
    /5000/,
  );
  assert.equal(list.length, MAX_ENTRIES);
});

test('bulk history removal accepts mixed kinds and preserves all source state and input objects', () => {
  const ctx = context();
  let rows = [entry({ id: 'manual-history' }), entry({ id: 'keep-history' })];
  for (const type of ['goal', 'todo', 'gift'])
    rows = appendSystemEvent(
      rows,
      { type, id: `${type}-1`, beforeDone: false, afterDone: true },
      ctx,
      options({ id: `${type}-history` }),
    );
  freeze(rows);
  freeze(ctx);
  const before = structuredClone(ctx.profile);
  const next = applyEntryCommand(
    rows,
    {
      type: 'journal-entries-remove',
      ids: ['manual-history', 'goal-history', 'gift-history'],
      expectedEntries: rows.filter((row) =>
        ['manual-history', 'goal-history', 'gift-history'].includes(row.id),
      ),
    },
    ctx,
  );
  assert.deepEqual(
    next.map((row) => row.id),
    ['keep-history', 'todo-history'],
  );
  assert.equal(rows.length, 5);
  assert.notEqual(next[0], rows[1]);
  assert.deepEqual(ctx.profile, before);
  const single = applyEntryCommand(
    rows,
    {
      type: 'journal-entry-remove',
      id: 'todo-history',
      expectedEntry: rows.find((row) => row.id === 'todo-history'),
    },
    ctx,
  );
  assert.equal(
    single.some((row) => row.id === 'todo-history'),
    false,
  );
  assert.deepEqual(ctx.profile, before);
});

test('bulk removal rejects empty, duplicate, unknown or foreign IDs and unknown command fields atomically', () => {
  const rows = freeze([entry()]);
  const ctx = freeze(context());
  for (const ids of [
    [],
    ['entry-1', 'entry-1'],
    ['entry-1', 'other-profile-entry'],
    ['foreign-history'],
    ['entry-1', 'bad/id'],
    Array(MAX_ENTRIES + 1).fill('entry-1'),
    'entry-1',
    [undefined],
  ]) {
    assert.throws(() => applyEntryCommand(rows, { type: 'journal-entries-remove', ids }, ctx));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'entry-1');
  }
  assert.throws(
    () =>
      applyEntryCommand(
        rows,
        { type: 'journal-entries-remove', ids: ['entry-1'], profileId: 'other-profile' },
        ctx,
      ),
    /未知字段/,
  );
  const otherContext = context({
    profile: { id: 'other-profile', goals: [], craftPlans: [], journey: { todos: [], gifts: [] } },
  });
  assert.throws(
    () => applyEntryCommand([], { type: 'journal-entries-remove', ids: ['entry-1'] }, otherContext),
    /当前周目/,
  );
});

test('explicit history removal releases 5000-entry capacity and appending remains available', () => {
  const ctx = context();
  const rows = Array.from({ length: MAX_ENTRIES }, (_, i) =>
    entry({
      id: `history-${i}`,
      kind: 'goal-completed',
      links: [{ type: 'goal', id: 'goal-1', label: ctx.profile.goals[0].title }],
    }),
  );
  freeze(rows);
  const reduced = applyEntryCommand(
    rows,
    {
      type: 'journal-entries-remove',
      ids: ['history-0', 'history-4999'],
      expectedEntries: [rows[0], rows[4999]],
    },
    ctx,
  );
  const appended = appendSystemEvent(
    reduced,
    { type: 'gift', id: 'gift-1', beforeDone: false, afterDone: true },
    ctx,
    options({ id: 'after-removal-event' }),
  );
  assert.equal(reduced.length, 4998);
  assert.equal(appended.length, 4999);
  assert.equal(appended.at(-1).kind, 'gift-completed');
  assert.equal(rows.length, MAX_ENTRIES);
  const emptied = applyEntryCommand(
    rows,
    { type: 'journal-entries-remove', ids: rows.map((row) => row.id), expectedEntries: rows },
    ctx,
  );
  assert.deepEqual(emptied, []);
  assert.equal(ctx.profile.goals[0].done, true);
});

test('renderer finds original records by body, tags, linked person/place and detached labels', async () => {
  const { queryJournalEntries } = await views;
  const ctx = context();
  const rows = applyEntryCommand(
    [],
    put({
      links: [
        { type: 'database', id: 'npc-1' },
        { type: 'place', id: 'place-1' },
      ],
      body: '记下谈话，等有空再回来',
    }),
    ctx,
    options(),
  );
  const p = { ...ctx.profile, journalEntries: rows };
  const index = { entries: ctx.game.entries, world: ctx.world, guides: ctx.catalog.entries };
  for (const query of ['上官虹', '梧桐村', '朋友', '谈话', '上官虹 梧桐村'])
    assert.equal(queryJournalEntries(p, { query }, index).total, 1);
  assert.equal(queryJournalEntries(p, { query: '没有这个人' }, index).total, 0);
  assert.equal(queryJournalEntries(p, { tag: '朋友', kind: 'manual' }, index).total, 1);
  assert.equal(queryJournalEntries(p, { tag: '装备' }, index).total, 0);
  assert.equal(queryJournalEntries(p, { ids: [] }, index).total, 0);
  assert.equal(queryJournalEntries(p, { ids: ['new-entry'], query: '谈话' }, index).total, 1);
  assert.equal(queryJournalEntries(p, { ids: ['other-entry'] }, index).total, 0);
  const historical = { ...p, journalEntries: detachLinks(rows, 'place', 'place-1') };
  assert.equal(queryJournalEntries(historical, { query: '梧桐村' }, {}).total, 1);
});

test('renderer pagination uses 20 rows and stable event-time then ID order without mutation', async () => {
  const { queryJournalEntries, JOURNAL_PAGE_SIZE } = await views;
  const rows = freeze(
    Array.from({ length: 41 }, (_, i) => entry({ id: `record-${String(40 - i).padStart(2, '0')}` })),
  );
  const p = { journalEntries: rows };
  const first = queryJournalEntries(p);
  assert.equal(JOURNAL_PAGE_SIZE, 20);
  assert.equal(first.entries.length, 20);
  assert.equal(first.entries[0].id, 'record-00');
  assert.equal(first.pages, 3);
  assert.equal(first.matchedIds.length, 41);
  assert.equal(first.matchedIds[0], 'record-00');
  assert.equal(first.matchedIds.at(-1), 'record-40');
  const second = queryJournalEntries(p, { page: 2 });
  assert.equal(second.entries[0].id, 'record-20');
  assert.deepEqual(second.matchedIds, first.matchedIds);
  assert.equal(queryJournalEntries(p, { page: 999 }).entries[0].id, 'record-40');
  assert.equal(queryJournalEntries(p, { page: -1 }).page, 1);
  assert.equal(rows[0].id, 'record-40');
  const different = { journalEntries: [entry({ id: 'old' }), entry({ id: 'new', occurredAt: T1 })] };
  assert.equal(queryJournalEntries(different).entries[0].id, 'new');
});

test('renderer date ranges include the full local day and reject impossible or reversed dates', async () => {
  const { queryJournalEntries, journalTimeFromLocal, journalLocalTime } = await views;
  const first = journalTimeFromLocal('2026-10-08T00:00:00.000');
  const last = journalTimeFromLocal('2026-10-08T23:59:59.999');
  const after = journalTimeFromLocal('2026-10-09T00:00:00.000');
  const p = {
    journalEntries: [
      entry({ id: 'first', occurredAt: first }),
      entry({ id: 'last', occurredAt: last }),
      entry({ id: 'after', occurredAt: after }),
    ],
  };
  assert.equal(queryJournalEntries(p, { from: '2026-10-08', to: '2026-10-08' }).total, 2);
  assert.match(queryJournalEntries(p, { from: '2026-02-30' }).error, /无效/);
  assert.deepEqual(queryJournalEntries(p, { from: '2026-02-30' }).matchedIds, []);
  assert.match(queryJournalEntries(p, { from: '2026-10-09', to: '2026-10-08' }).error, /晚于/);
  assert.equal(journalLocalTime(first), '2026-10-08T00:00:00.000');
  assert.throws(() => journalTimeFromLocal('2026-02-30T12:00'), /不存在/);
  assert.throws(() => journalTimeFromLocal('2026-10-08T12:00Z'), /有效/);
});

test('reference picker searches local names and IDs, returns at most 20, and excludes other profiles', async () => {
  const { journalReferenceChoices } = await views;
  const ctx = context();
  const index = {
    entries: [
      ...ctx.game.entries,
      ...Array.from({ length: 25 }, (_, i) => ({ id: `item-${100 + i}`, name: `材料 ${i}` })),
    ],
    world: ctx.world,
    guides: ctx.catalog.entries,
  };
  assert.equal(journalReferenceChoices(ctx.profile, index, '').length, 0);
  assert.equal(journalReferenceChoices(ctx.profile, index, '材料').length, 20);
  assert.equal(journalReferenceChoices(ctx.profile, index, 'npc-1')[0].type, 'database');
  assert.equal(
    journalReferenceChoices(ctx.profile, index, '梧桐村').some((choice) => choice.type === 'place'),
    true,
  );
  assert.equal(journalReferenceChoices(ctx.profile, index, '回村探望')[0].type, 'todo');
  assert.equal(journalReferenceChoices({ id: 'other' }, index, '回村探望').length, 0);
});

test('views escape record text and preserve legacy notes, disclose user state, and locate entry IDs', async () => {
  const { createEventJournalViews } = await views;
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
    notice: (label) => `<p>${esc(label)}</p>`,
    empty: (title, body) => `<p>${esc(title)} ${esc(body)}</p>`,
    when: esc,
  };
  const factory = createEventJournalViews(helpers);
  const p = {
    id: 'p',
    notes: '<script>old</script>',
    journalEntries: [entry({ title: '<img onerror=attack>', body: '<script>attack</script>' })],
  };
  const html = factory.page(p, {});
  assert.ok(html.includes('journal-export'));
  assert.ok(html.includes('journal-remove-filtered'));
  assert.ok(!factory.page(p, { query: 'absent' }).includes('journal-remove-filtered'));
  assert.ok(html.includes('&lt;script&gt;old&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img onerror=attack&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-journal-id="entry-1"'));
  assert.ok(html.includes('journal-entry-open'));
  assert.ok(html.includes('游戏状态需另行核对'));
  assert.ok(factory.detail(p, 'entry-1').includes('journal-entry-edit'));
  assert.ok(factory.editDialog(p, p.journalEntries[0]).includes('datetime-local'));
  const system = {
    ...p,
    journalEntries: [
      entry({ kind: 'goal-completed', links: [{ type: 'goal', id: 'g', label: '目标', detached: true }] }),
    ],
  };
  assert.ok(!factory.detail(system, 'entry-1').includes('journal-entry-edit'));
  assert.ok(factory.detail(system, 'entry-1').includes('journal-entry-remove'));
  assert.ok(factory.detail(system, 'entry-1').includes('移入已删除记录后可逐条恢复'));
  assert.ok(factory.detail(system, 'entry-1').includes('原关联已移除'));
  const historical = factory.page(p, { readOnly: true });
  assert.ok(historical.includes('historical-journal-entry-open'));
  assert.ok(!historical.includes('data-action="journal-entry-new"'));
  assert.ok(!historical.includes('data-action="journal-remove-filtered"'));
  const original = factory.detail(p, 'entry-1', { readOnly: true });
  assert.ok(!original.includes('data-action="journal-entry-edit"'));
  assert.ok(!original.includes('data-action="journal-entry-remove"'));
  assert.ok(original.includes('只读记录'));
});

test('same-name real scenes retain distinct choices, persisted IDs and readable legacy history', async () => {
  const { journalReferenceChoices, createEventJournalViews, queryJournalEntries } = await views;
  const world = require('../src/data/world-index.json');
  const scenes = world.maps.filter((row) => row.name === '梧桐村');
  assert.deepEqual(scenes.map((row) => row.id).sort(), ['place-10', 'place-63', 'place-64', 'place-9']);
  const ctx = context({ world: { ...world, maps: scenes } });
  const choices = journalReferenceChoices(ctx.profile, { world: ctx.world }, '梧桐村').filter(
    (row) => row.type === 'place',
  );
  assert.equal(choices.length, 4);
  assert.equal(new Set(choices.map((row) => row.label)).size, 4);
  assert.deepEqual(
    journalReferenceChoices(ctx.profile, { world: ctx.world }, '梧桐村 #63').map((row) => row.id),
    ['place-63'],
  );
  const rows = applyEntryCommand([], put({ links: [{ type: 'place', id: 'place-63' }] }), ctx, options());
  assert.deepEqual(rows[0].links, [{ type: 'place', id: 'place-63', label: '梧桐村 · 场景 #63' }]);
  validateEntries(JSON.parse(JSON.stringify(rows)), ctx);
  const profile = { ...ctx.profile, journalEntries: rows };
  assert.deepEqual(queryJournalEntries(profile, { query: '梧桐村 #63' }, { world: ctx.world }).matchedIds, [
    'new-entry',
  ]);
  assert.equal(queryJournalEntries(profile, { query: '梧桐村 #9' }, { world: ctx.world }).total, 0);
  const helper = {
    esc: (value) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    act: (action, label, cls, id) =>
      `<button data-action="${action}" data-id="${id || ''}">${label}</button>`,
    icon: () => '',
    pill: String,
    notice: String,
    empty: String,
    when: String,
  };
  const factory = createEventJournalViews(helper);
  assert.match(
    factory.selectedReferences(profile, { world: ctx.world }, ['place:place-63'], rows[0]),
    /梧桐村 · 场景 #63/,
  );
  const legacy = entry({ links: [{ type: 'place', id: 'place-63', label: '梧桐村', detached: true }] });
  const historical = { ...profile, journalEntries: [legacy] };
  const html = factory.detail(historical, legacy.id, { readOnly: true });
  assert.match(html, /梧桐村 · 场景 #63/);
  assert.match(html, /原关联已移除/);
  assert.ok(!html.includes('data-action="journal-entry-edit"'));
  const misleadingLegacy = { ...legacy, links: [{ ...legacy.links[0], label: '旧名 · 场景 #9' }] };
  assert.match(
    factory.detail({ ...profile, journalEntries: [misleadingLegacy] }, legacy.id, { readOnly: true }),
    /旧名 · 场景 #9 · 场景 #63/,
  );
});

test('form parsing emits only the manual command contract and local occurrence time', async (t) => {
  const { readJournalForm } = await views;
  const original = globalThis.FormData;
  globalThis.FormData = class extends Map {
    constructor(form) {
      super(Object.entries(form.fields));
    }
  };
  t.after(() => {
    globalThis.FormData = original;
  });
  const fields = {
    'journal-title': '一段经历',
    'journal-body': '正文',
    'journal-time': '2026-10-08T12:30',
    'journal-tags': '朋友，回访',
    'journal-links': 'database:npc-1\nplace:place-1',
    'journal-snapshot': 'none',
  };
  const command = readJournalForm({ fields, dataset: {} });
  assert.equal(command.type, 'journal-entry-put');
  assert.deepEqual(command.tags, ['朋友', '回访']);
  assert.deepEqual(command.links, [
    { type: 'database', id: 'npc-1' },
    { type: 'place', id: 'place-1' },
  ]);
  assert.equal(command.kind, undefined);
  assert.equal(command.createdAt, undefined);
  assert.equal(command.snapshot, undefined);
  const updated = readJournalForm({ fields, dataset: { entryId: 'entry-1' } });
  assert.equal(updated.type, 'journal-entry-update');
  assert.equal(updated.id, 'entry-1');
  assert.throws(
    () => readJournalForm({ fields: { ...fields, 'journal-links': 'bad-reference' }, dataset: {} }),
    /关联资料/,
  );
});
