'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_TRASH,
  validateTrash,
  moveEntriesToTrash,
  applyTrashCommand,
  detachTrashLinks,
} = require('../src/core/event-journal-trash.cjs');
const { MAX_ENTRIES } = require('../src/core/event-journal.cjs');
const T0 = '2026-10-08T08:00:00.000Z';
const T1 = '2026-10-09T08:00:00.000Z';
const context = () => ({
  profile: {
    id: 'synthetic-profile',
    goals: [{ id: 'goal-1', title: '拜访故人', done: false }],
    journey: { todos: [], gifts: [] },
  },
  game: { entries: [] },
  world: { people: [], quests: [], maps: [] },
});
const entry = (extra = {}) => ({
  id: 'entry-1',
  kind: 'manual',
  title: '当时的记录',
  body: '原正文与换行\n均保留',
  occurredAt: T0,
  createdAt: T0,
  updatedAt: T0,
  tags: ['故人'],
  links: [],
  ...extra,
});
const row = (extra = {}) => ({ entry: entry(), deletedAt: T1, ...extra });
const remove = (entries) => ({
  type: 'journal-entries-remove',
  ids: entries.map((value) => value.id),
  expectedEntries: structuredClone(entries),
});
const trashCommand = (rows, type = 'journal-trash-restore') => ({
  type,
  ids: rows.map((value) => value.entry.id),
  expectedEntries: structuredClone(rows),
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test('single and bulk removals retain complete mixed records and leave unselected history intact', () => {
  const ctx = context();
  const system = entry({
    id: 'system-1',
    kind: 'goal-completed',
    links: [{ type: 'goal', id: 'goal-1', label: '拜访故人' }],
  });
  const manual = entry({
    snapshot: { name: '1.sav', hash: 'a'.repeat(64), modifiedAt: T0, mapName: '故人村' },
  });
  const retained = entry({ id: 'retained' });
  const priorTrash = row({ entry: entry({ id: 'older-trash' }) });
  const active = freeze([manual, system, retained]);
  const trash = freeze([priorTrash]);
  const single = moveEntriesToTrash(
    active,
    trash,
    {
      type: 'journal-entry-remove',
      id: manual.id,
      expectedEntry: structuredClone(manual),
    },
    ctx,
    { now: T1 },
  );
  assert.deepEqual(single.entries, [system, retained]);
  assert.deepEqual(single.trash, [priorTrash, { entry: manual, deletedAt: T1 }]);
  const bulk = moveEntriesToTrash(active, trash, remove([system, manual]), ctx, { now: T1 });
  assert.deepEqual(bulk.entries, [retained]);
  assert.deepEqual(
    bulk.trash.map((value) => value.entry),
    [priorTrash.entry, manual, system],
  );
  assert.notEqual(bulk.trash[1].entry.snapshot, manual.snapshot);
  assert.deepEqual(ctx.profile.goals, [{ id: 'goal-1', title: '拜访故人', done: false }]);
});

test('move accepts only explicit removals and preserves the existing stale confirmation guards', () => {
  const current = freeze([entry({ updatedAt: T1, body: '另一窗口保存的正文' })]);
  const stale = entry();
  const invalid = [
    { type: 'journal-entry-remove', id: stale.id, expectedEntry: stale },
    remove([stale]),
    { type: 'journal-entry-remove', id: stale.id },
    { ...remove(current), ids: ['foreign-entry'] },
    { ...remove(current), ids: [stale.id, stale.id], expectedEntries: [stale, stale] },
    { type: 'journal-entry-put', title: '不是删除' },
    { type: 'journal-entry-update', id: stale.id },
  ];
  for (const command of invalid) {
    assert.throws(() => moveEntriesToTrash(current, [], command, context(), { now: T1 }));
    assert.equal(current[0].body, '另一窗口保存的正文');
  }
});

test('trash validation rejects malformed timestamps, duplicate or active identity and private metadata', () => {
  const ctx = context();
  assert.doesNotThrow(() => validateTrash([row()], ctx));
  for (const invalid of [
    null,
    {},
    [null],
    [row({ deletedAt: '2026-02-30T08:00:00Z' })],
    [row({ deletedAt: '2026-10-07T08:00:00Z' })],
    [row({ deletedAt: 123 })],
    [row({ deletedAt: undefined })],
    [row(), row()],
    [row({ path: 'C:\\synthetic-only\\1.sav' })],
    [row({ token: 'must-not-persist' })],
    [row({ nativeCapability: true })],
    [row({ entry: entry({ inventory: { 1: 99 } }) })],
    [
      row({
        entry: entry({
          snapshot: { name: '1.sav', hash: 'a'.repeat(64), modifiedAt: T0, token: 'forbidden' },
        }),
      }),
    ],
    [
      row({
        entry: entry({
          snapshot: { name: 'C:\\synthetic-only\\1.sav', hash: 'a'.repeat(64), modifiedAt: T0 },
        }),
      }),
    ],
    [row({ entry: entry({ links: [{ type: 'goal', id: 'foreign-goal', label: '外周目目标' }] }) })],
  ])
    assert.throws(() => validateTrash(invalid, ctx));
  assert.throws(() => validateTrash([row()], ctx, [entry()]), /同时存在/);
  const hiddenField = row();
  Object.defineProperty(hiddenField, 'token', { value: 'hidden' });
  assert.throws(() => validateTrash([hiddenField], ctx), /未知字段/);
  assert.throws(
    () => validateTrash([Object.assign(Object.create({ token: 'prototype' }), row())], ctx),
    /格式无效/,
  );
});

test('restore and purge require exact selected wrappers and never accept an empty or stale preview', () => {
  const rows = freeze([row(), row({ entry: entry({ id: 'unselected' }) })]);
  const chosen = rows[0];
  for (const type of ['journal-trash-restore', 'journal-trash-purge']) {
    for (const command of [
      { type, ids: [], expectedEntries: [] },
      { type, ids: [chosen.entry.id] },
      { ...trashCommand([chosen], type), expectedEntries: [chosen.entry] },
      { ...trashCommand([chosen], type), expectedEntries: [row({ deletedAt: T0 })] },
      { ...trashCommand([chosen], type), expectedEntries: [row({ entry: entry({ body: '旧正文' }) })] },
      { ...trashCommand(rows, type), expectedEntries: [chosen, chosen] },
      { ...trashCommand([chosen], type), ids: ['foreign-entry'] },
      { ...trashCommand([chosen], type), ids: [chosen.entry.id, chosen.entry.id] },
      { ...trashCommand([chosen], type), token: 'renderer-cannot-authorize' },
      { ...trashCommand([chosen], type), expectedEntries: [{ ...chosen, nativeCapability: undefined }] },
      { ...trashCommand([chosen], type), expectedEntries: [{ toJSON: () => chosen }] },
    ])
      assert.throws(() => applyTrashCommand([], rows, command, context(), { now: T1 }));
  }
  const purged = applyTrashCommand([], rows, trashCommand([chosen], 'journal-trash-purge'), context());
  assert.deepEqual(purged.trash, [rows[1]]);
  assert.deepEqual(purged.entries, []);
  assert.deepEqual(rows, [chosen, row({ entry: entry({ id: 'unselected' }) })]);
});

test('restoration merges only selected records with newer history and advances its revision using the trusted clock', () => {
  const rows = freeze([
    row({ entry: entry({ snapshot: { name: '1.sav', hash: 'a'.repeat(64), modifiedAt: T0 } }) }),
    row({ entry: entry({ id: 'unselected' }) }),
  ]);
  const later = freeze([entry({ id: 'later', body: '删除后写下的记录', createdAt: T1, updatedAt: T1 })]);
  let clockCalls = 0;
  const restored = applyTrashCommand(later, rows, trashCommand([rows[0]]), context(), {
    now: () => {
      clockCalls++;
      return T0;
    },
  });
  assert.equal(clockCalls, 1);
  assert.deepEqual(restored.entries[0], later[0]);
  assert.deepEqual(restored.entries[1], { ...rows[0].entry, updatedAt: '2026-10-09T08:00:00.001Z' });
  assert.deepEqual(restored.trash, [rows[1]]);
  assert.notEqual(restored.entries[1].snapshot, rows[0].entry.snapshot);
  for (const command of [
    { ...trashCommand([rows[0]]), now: T1 },
    { ...trashCommand([rows[0]]), restoredAt: T1 },
  ])
    assert.throws(() => applyTrashCommand(later, rows, command, context()), /未知字段/);
  assert.throws(
    () => applyTrashCommand(later, rows, trashCommand([rows[0]]), context(), { now: 'invalid' }),
    /时间/,
  );
});

test('restore then redelete invalidates every purge confirmation from the preceding lifecycle', () => {
  const original = row();
  const stalePurge = trashCommand([original], 'journal-trash-purge');
  const restored = applyTrashCommand([], [original], trashCommand([original]), context(), { now: T0 });
  const deletedAgain = moveEntriesToTrash(
    restored.entries,
    restored.trash,
    remove(restored.entries),
    context(),
    { now: T0 },
  );
  assert.equal(deletedAgain.trash[0].entry.id, original.entry.id);
  assert.equal(deletedAgain.trash[0].entry.createdAt, original.entry.createdAt);
  assert.equal(deletedAgain.trash[0].entry.occurredAt, original.entry.occurredAt);
  assert.ok(Date.parse(deletedAgain.trash[0].deletedAt) > Date.parse(restored.entries[0].updatedAt));
  assert.throws(() => applyTrashCommand([], deletedAgain.trash, stalePurge, context()), /已变化/);
  const purged = applyTrashCommand(
    [],
    deletedAgain.trash,
    trashCommand(deletedAgain.trash, 'journal-trash-purge'),
    context(),
  );
  assert.deepEqual(purged, { entries: [], trash: [] });
});

test('5000-entry limits reject all-or-nothing removal and restoration without eviction', () => {
  const ctx = context();
  const fullTrash = Array.from({ length: MAX_TRASH }, (_, i) => row({ entry: entry({ id: 'trash-' + i }) }));
  const fullEntries = Array.from({ length: MAX_ENTRIES }, (_, i) => entry({ id: 'active-' + i }));
  assert.doesNotThrow(() => validateTrash(fullTrash, ctx, fullEntries));
  assert.throws(
    () => moveEntriesToTrash(fullEntries, fullTrash, remove(fullEntries.slice(0, 1)), ctx, { now: T1 }),
    /已满/,
  );
  assert.throws(
    () => applyTrashCommand(fullEntries, fullTrash, trashCommand(fullTrash.slice(0, 1)), ctx),
    /5000/,
  );
  const partialTrash = fullTrash.slice(0, -2);
  assert.throws(
    () => moveEntriesToTrash(fullEntries, partialTrash, remove(fullEntries.slice(0, 3)), ctx, { now: T1 }),
    /已满/,
  );
  const exactFit = moveEntriesToTrash(fullEntries, partialTrash, remove(fullEntries.slice(0, 2)), ctx, {
    now: T1,
  });
  assert.equal(exactFit.trash.length, MAX_TRASH);
  assert.deepEqual(exactFit.trash.slice(0, -2), partialTrash);
  assert.deepEqual(exactFit.entries, fullEntries.slice(2));
  assert.equal(fullTrash.length, MAX_TRASH);
  assert.equal(fullEntries.length, MAX_ENTRIES);
  assert.throws(
    () => validateTrash([...fullTrash, row({ entry: entry({ id: 'over-limit' }) })], ctx),
    /5000/,
  );
});

test('removed sources detach only matching trash links and retain the recorded label and wrapper time', () => {
  const original = row({
    entry: entry({
      kind: 'goal-completed',
      links: [{ type: 'goal', id: 'goal-1', label: '记录当时的名字' }],
    }),
  });
  const unrelated = row({ entry: entry({ id: 'unrelated' }) });
  const trash = freeze([original, unrelated]);
  const detached = detachTrashLinks(trash, 'goal', 'goal-1');
  const ctx = context();
  ctx.profile.goals = [];
  assert.doesNotThrow(() => validateTrash(detached, ctx));
  assert.deepEqual(detached[0], {
    entry: { ...original.entry, links: [{ ...original.entry.links[0], detached: true }] },
    deletedAt: original.deletedAt,
  });
  assert.deepEqual(detached[1], unrelated);
  assert.equal(original.entry.links[0].detached, undefined);
  assert.throws(
    () => applyTrashCommand([], detached, trashCommand([original], 'journal-trash-purge'), ctx),
    /已变化/,
  );
  const restored = applyTrashCommand([], detached, trashCommand([detached[0]]), ctx, { now: T1 });
  assert.equal(restored.entries[0].links[0].label, '记录当时的名字');
  assert.equal(restored.entries[0].links[0].detached, true);
  assert.deepEqual(ctx.profile.goals, []);
});
