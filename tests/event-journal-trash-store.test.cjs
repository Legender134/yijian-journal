'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Store, MAX_JOURNAL_BYTES } = require('../src/core/store.cjs');
const { MAX_TRASH } = require('../src/core/event-journal-trash.cjs');
const { MAX_ENTRIES } = require('../src/core/event-journal.cjs');
const catalog = require('../src/data/catalog.cjs');
const game = require('../src/data/game-index.json');
const migration = require('../src/core/migration.cjs');
const complete = require('../src/core/complete-migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-journal-trash-store-'));
const T0 = '2026-10-08T08:00:00.000Z';
const T1 = '2026-10-09T08:00:00.000Z';
const manual = {
  type: 'journal-entry-put',
  title: '第一天的手写记录',
  body: '原正文\n原标签与事件时间',
  occurredAt: T0,
  tags: ['故人'],
  links: [],
  snapshotMode: 'none',
};
const profile = (store) => {
  const state = store.get();
  return state.profiles.find((value) => value.id === state.activeProfileId);
};
const fixture = (name) => new Store(path.join(root, name), catalog);
const remove = (entries, extra = {}) => ({
  type: 'journal-entries-remove',
  ids: entries.map((entry) => entry.id),
  expectedEntries: structuredClone(entries),
  ...extra,
});
const trashCommand = (rows, type = 'journal-trash-restore', extra = {}) => ({
  type,
  ids: rows.map((row) => row.entry.id),
  expectedEntries: structuredClone(rows),
  ...extra,
});
const entry = (id) => ({
  id,
  kind: 'manual',
  title: '合成记录',
  body: '',
  occurredAt: T0,
  createdAt: T0,
  updatedAt: T0,
  tags: [],
  links: [],
});
const row = (id) => ({ entry: entry(id), deletedAt: T1 });
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function diskState(store) {
  return Object.fromEntries(
    fs
      .readdirSync(store.dir)
      .sort()
      .map((name) => {
        const file = path.join(store.dir, name);
        assert.ok(fs.statSync(file).isFile(), 'this journal-only fixture contains ordinary files');
        return [name, hash(fs.readFileSync(file))];
      }),
  );
}
function rejectedUnchanged(store, command, pattern = undefined) {
  const before = store.get();
  const disk = diskState(store);
  assert.throws(() => store.mutate(command), pattern);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(diskState(store), disk);
}
function domainState(value) {
  const { journalEntries, journalTrash, updatedAt, ...domain } = value;
  return domain;
}
test.after(() => console.log('Retained synthetic trash-store fixtures: ' + root));

test('one atomic commit moves mixed manual and system history; restore never replays goal, todo or gift state', () => {
  const store = fixture('mixed-events');
  store.mutate({ type: 'goal-add', title: '旧目标' });
  const goalId = profile(store).goals[0].id;
  const todo = { type: 'journey-todo-put', id: 'todo-1', title: '旧待办', detail: '', done: false };
  const item = game.entries.find((value) => value.kind === '物品' && value.giftable === true);
  assert.ok(item);
  const gift = {
    type: 'journey-gift-put',
    id: 'gift-1',
    npcId: 'npc-10047',
    itemId: item.id,
    quantity: 2,
    note: '原赠礼意图',
    done: false,
  };
  store.mutate(todo);
  store.mutate(gift);
  store.mutate(manual, {
    selectedReference: { path: '/synthetic-only/1.sav', nativeLoadToken: 'cannot-enter-history' },
  });
  store.mutate({ type: 'goal-toggle', id: goalId });
  store.mutate({ ...todo, done: true });
  store.mutate({ ...gift, done: true });
  const originals = profile(store).journalEntries;
  assert.deepEqual(
    originals.map((value) => value.kind),
    ['manual', 'goal-completed', 'todo-completed', 'gift-completed'],
  );
  const before = fs.readFileSync(store.file);
  const realCommit = store.commit.bind(store);
  let commits = 0;
  store.commit = (state) => {
    commits++;
    const p = state.profiles.find((value) => value.id === state.activeProfileId);
    assert.deepEqual(p.journalEntries, []);
    assert.deepEqual(
      p.journalTrash.map((value) => value.entry),
      originals,
    );
    return realCommit(state);
  };
  store.mutate(remove(originals));
  assert.equal(commits, 1);
  assert.deepEqual(fs.readFileSync(store.file + '.previous'), before);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(store.file)).profiles[0].journalTrash.map((value) => value.entry),
    originals,
  );
  store.commit = realCommit;
  store.mutate({ type: 'goal-toggle', id: goalId });
  store.mutate({ ...todo, done: false });
  store.mutate({ ...gift, done: false });
  store.mutate({ ...manual, title: '删除以后新写的内容' });
  const current = profile(store);
  const selected = current.journalTrash.filter((value) =>
    ['manual', 'goal-completed', 'gift-completed'].includes(value.entry.kind),
  );
  store.mutate(trashCommand(selected));
  const restored = profile(store);
  assert.deepEqual(domainState(restored), domainState(current));
  assert.deepEqual(restored.journalEntries.slice(0, current.journalEntries.length), current.journalEntries);
  assert.equal(restored.journalTrash.length, 1);
  for (const value of selected) {
    const restoredEntry = restored.journalEntries.find((e) => e.id === value.entry.id);
    assert.deepEqual({ ...restoredEntry, updatedAt: value.entry.updatedAt }, value.entry);
    assert.ok(Date.parse(restoredEntry.updatedAt) > Date.parse(value.deletedAt));
  }
  assert.equal(restored.goals[0].done, false);
  assert.equal(restored.journey.todos[0].done, false);
  assert.equal(restored.journey.gifts[0].done, false);
  assert.equal(restored.journey.gifts[0].quantity, 2);
  assert.doesNotMatch(
    JSON.stringify(restored.journalTrash) + JSON.stringify(restored.journalEntries),
    /nativeLoadToken|nativeCapability|cannot-enter-history|inventory/,
  );
});

test('stale and malformed confirmations keep both current and previous files unchanged', () => {
  const store = fixture('rejections');
  store.mutate(manual);
  const original = profile(store).journalEntries[0];
  store.mutate({
    ...manual,
    type: 'journal-entry-update',
    id: original.id,
    expectedEntry: original,
    body: '另一窗口刚保存的重要正文',
  });
  rejectedUnchanged(
    store,
    { type: 'journal-entry-remove', id: original.id, expectedEntry: original },
    /已变化/,
  );
  rejectedUnchanged(store, remove([original]), /已变化/);
  const updated = profile(store).journalEntries[0];
  store.mutate({ type: 'journal-entry-remove', id: updated.id, expectedEntry: updated });
  const rows = profile(store).journalTrash;
  const cancelled = trashCommand(rows, 'journal-trash-purge');
  for (const type of ['journal-trash-restore', 'journal-trash-purge']) {
    for (const command of [
      { type, ids: [], expectedEntries: [] },
      { type, ids: [updated.id] },
      { ...trashCommand(rows, type), expectedEntries: [updated] },
      { ...trashCommand(rows, type), expectedEntries: [{ ...rows[0], deletedAt: T0 }] },
      {
        ...trashCommand(rows, type),
        expectedEntries: [{ ...rows[0], entry: { ...updated, body: '旧正文' } }],
      },
      { ...trashCommand(rows, type), ids: [updated.id, updated.id] },
      { ...trashCommand(rows, type), ids: ['foreign-record'] },
      { ...trashCommand(rows, type), now: T1 },
      { ...trashCommand(rows, type), nativeCapability: true },
    ])
      rejectedUnchanged(store, command);
  }
  store.mutate(trashCommand(rows));
  rejectedUnchanged(store, cancelled, /周目已变化/);
  store.mutate(remove(profile(store).journalEntries));
  rejectedUnchanged(store, cancelled, /已变化/);
  const current = profile(store).journalTrash;
  assert.notEqual(current[0].deletedAt, cancelled.expectedEntries[0].deletedAt);
  store.mutate(trashCommand(current, 'journal-trash-purge'));
  assert.deepEqual(profile(store).journalTrash, []);
});

test('a cold restart retains trash and merges selected restoration with later records and saved window drafts', () => {
  let store = fixture('restart-drafts');
  store.mutate(manual);
  const original = profile(store).journalEntries[0];
  store.mutate({
    type: 'journal-draft-put',
    id: 'edit-window',
    revision: 0,
    entryId: original.id,
    entryUpdatedAt: original.updatedAt,
    entrySnapshot: original,
    title: '小窗尚未完成的编辑',
    body: '未丢失的草稿',
    localTime: '2026-10-08T16:00',
    tags: '故人',
    links: [],
    snapshotMode: 'keep',
  });
  store.mutate({
    type: 'journal-draft-put',
    id: 'other-window',
    revision: 0,
    title: '另一个窗口的草稿',
    body: '后来新建的草稿',
    localTime: '',
    tags: '',
    links: [],
    snapshotMode: 'none',
  });
  const drafts = profile(store).journalDrafts;
  store.mutate({ type: 'journal-entry-remove', id: original.id, expectedEntry: original });
  const trash = profile(store).journalTrash;
  store = new Store(store.dir, catalog);
  assert.deepEqual(profile(store).journalTrash, trash);
  assert.deepEqual(profile(store).journalDrafts, drafts);
  store.mutate({ ...manual, title: '冷启动后新增记录' });
  const later = profile(store).journalEntries;
  store.mutate(trashCommand(trash));
  assert.deepEqual(profile(store).journalEntries.slice(0, later.length), later);
  assert.deepEqual(profile(store).journalDrafts, drafts);
  rejectedUnchanged(
    store,
    { type: 'journal-draft-commit', id: 'edit-window', revision: 1, occurredAt: T0 },
    /原记录已被修改/,
  );
  store.mutate({ type: 'journal-draft-commit', id: 'other-window', revision: 1, occurredAt: T0 });
  assert.equal(profile(store).journalDrafts.length, 1);
  assert.ok(profile(store).journalEntries.some((value) => value.body === '后来新建的草稿'));
});

test('trash association detachment preserves original identity and name when the goal or todo is removed', () => {
  const store = fixture('deleted-links');
  store.mutate({ type: 'goal-add', title: '记录当时的目标名' });
  const goalId = profile(store).goals[0].id;
  store.mutate({ type: 'goal-toggle', id: goalId });
  store.mutate({
    type: 'journey-todo-put',
    id: 'todo-1',
    title: '记录当时的待办名',
    detail: '',
    done: false,
  });
  store.mutate({ type: 'journey-todo-put', id: 'todo-1', title: '记录当时的待办名', detail: '', done: true });
  const originals = profile(store).journalEntries;
  store.mutate(remove(originals));
  const stale = trashCommand(profile(store).journalTrash, 'journal-trash-purge');
  store.mutate({ type: 'goal-edit', id: goalId, title: '后来改过的目标名', detail: '' });
  store.mutate({ type: 'goal-remove', id: goalId });
  store.mutate({ type: 'journey-todo-remove', id: 'todo-1' });
  const rows = profile(store).journalTrash;
  assert.deepEqual(
    rows.map((value) => value.entry.links[0].label),
    ['记录当时的目标名', '记录当时的待办名'],
  );
  assert.ok(rows.every((value) => value.entry.links[0].detached === true));
  rejectedUnchanged(store, stale, /不存在|已变化/);
  store.mutate(trashCommand(rows));
  assert.deepEqual(profile(store).goals, []);
  assert.deepEqual(profile(store).journey.todos, []);
  assert.ok(profile(store).journalEntries.every((value) => value.links[0].detached));
});

test('explicit and active profile scope cannot restore, purge or remove foreign records', () => {
  const store = fixture('profile-scope');
  store.mutate(manual);
  const firstId = profile(store).id;
  store.mutate(remove(profile(store).journalEntries));
  const firstTrash = profile(store).journalTrash;
  store.mutate({ type: 'profile-add', name: '另一个周目' });
  store.mutate({ ...manual, title: '外周目自己的记录' });
  const secondId = profile(store).id;
  const secondEntries = profile(store).journalEntries;
  rejectedUnchanged(store, trashCommand(firstTrash), /周目已变化/);
  rejectedUnchanged(store, trashCommand(firstTrash, 'journal-trash-purge'), /周目已变化/);
  rejectedUnchanged(store, remove(secondEntries, { profileId: firstId }), /当前周目/);
  rejectedUnchanged(
    store,
    trashCommand(firstTrash, 'journal-trash-restore', { profileId: 'missing-profile' }),
    /周目不存在/,
  );
  store.mutate(trashCommand(firstTrash, 'journal-trash-restore', { profileId: firstId }));
  assert.equal(store.get().activeProfileId, secondId);
  assert.deepEqual(profile(store).journalEntries, secondEntries);
  assert.equal(
    store.get().profiles.find((value) => value.id === firstId).journalEntries[0].id,
    firstTrash[0].entry.id,
  );
});

test('trash and active capacities reject atomically; overfull imports and illegal trash metadata write nothing', () => {
  const store = fixture('capacity');
  const state = store.get();
  state.profiles[0].journalEntries = [entry('selected')];
  state.profiles[0].journalTrash = Array.from({ length: MAX_TRASH }, (_, i) => row('trash-' + i));
  store.commit(state);
  rejectedUnchanged(store, remove(profile(store).journalEntries), /已满/);
  const valid = store.get();
  valid.profiles[0].journalEntries = Array.from({ length: MAX_ENTRIES }, (_, i) => entry('active-' + i));
  store.commit(valid);
  rejectedUnchanged(store, trashCommand(profile(store).journalTrash.slice(0, 1)), /5000/);
  const disk = diskState(store);
  const before = store.get();
  for (const change of [
    (p) => p.journalTrash.push(row('over-limit')),
    (p) => (p.journalTrash[0].token = 'forbidden'),
    (p) =>
      (p.journalTrash[0].entry.snapshot = {
        name: '1.sav',
        hash: 'a'.repeat(64),
        modifiedAt: T0,
        nativeCapability: true,
      }),
    (p) => (p.journalTrash[0].entry = p.journalEntries[0]),
  ]) {
    const invalid = store.get();
    change(invalid.profiles[0]);
    assert.throws(() => store.importData(invalid));
    assert.deepEqual(store.get(), before);
    assert.deepEqual(diskState(store), disk);
  }
});

test('the shared 32 MB ceiling counts trash and refuses a deletion before memory or disk changes', () => {
  const store = fixture('byte-ceiling');
  const state = store.get();
  const p = state.profiles[0];
  p.journalEntries = Array.from({ length: 4000 }, (_, i) => entry('active-' + i));
  p.journalTrash = Array.from({ length: 4000 }, (_, i) => row('trash-' + i));
  const all = [...p.journalEntries, ...p.journalTrash.map((value) => value.entry)];
  const available = MAX_JOURNAL_BYTES - 16 - Buffer.byteLength(JSON.stringify(state, null, 2));
  const length = Math.floor(available / all.length);
  const extra = available % all.length;
  assert.ok(length >= 0 && length + 1 <= 4000);
  all.forEach((value, index) => (value.body = 'x'.repeat(length + (index < extra ? 1 : 0))));
  assert.equal(Buffer.byteLength(JSON.stringify(state, null, 2)), MAX_JOURNAL_BYTES - 16);
  store.commit(state);
  rejectedUnchanged(store, remove(profile(store).journalEntries.slice(0, 1)), /32 MB/);
  const incoming = store.get();
  incoming.profiles[0].journalEntries[0].body += 'x'.repeat(32);
  const disk = diskState(store),
    before = store.get();
  assert.throws(() => store.importData(incoming), /32 MB/);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(diskState(store), disk);
});

test('legacy state without trash stays usable and JSON import preserves trash while keeping receiver paths local', () => {
  const sender = fixture('json-sender');
  assert.equal(profile(sender).journalTrash, undefined);
  sender.mutate(manual);
  sender.mutate(remove(profile(sender).journalEntries));
  const exported = JSON.parse(JSON.stringify(sender.get()));
  const receiver = fixture('json-receiver');
  receiver.setPath('savePath', '/synthetic-only/receiver-save-path');
  const settings = receiver.get().settings;
  receiver.importData(exported);
  assert.deepEqual(receiver.get().settings, settings);
  assert.deepEqual(profile(receiver).journalTrash, profile(sender).journalTrash);
  const cold = new Store(receiver.dir, catalog);
  assert.deepEqual(profile(cold).journalTrash, profile(sender).journalTrash);
  cold.mutate(trashCommand(profile(cold).journalTrash));
  assert.equal(profile(cold).journalEntries[0].body, manual.body);
  assert.equal(cold.get().settings.savePath, settings.savePath);
});

test('protection export rejects malformed trash before writing output and preserves the raw source', async () => {
  const mutations = [
    (p) => (p.journalTrash[0].token = 'must-not-travel'),
    (p) => (p.journalTrash[0].entry.nativeCapability = true),
    (p) => (p.journalTrash[0].deletedAt = '2026-02-30T00:00:00Z'),
    (p) => (p.journalEntries = [structuredClone(p.journalTrash[0].entry)]),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const store = fixture('invalid-protection-' + index);
    store.mutate(manual);
    store.mutate(remove(profile(store).journalEntries));
    const state = store.get();
    mutate(state.profiles[0]);
    const raw = Buffer.from(JSON.stringify(state, null, 2));
    fs.writeFileSync(store.file, raw);
    const file = path.join(root, 'invalid-protection-' + index + '.yijian-protection');
    await assert.rejects(migration.exportProtection({ dataRoot: store.dir, file }));
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readFileSync(store.file), raw);
  }
});

function machine(name, seconds) {
  const dataRoot = path.join(root, name),
    source = path.join(dataRoot, '合成存档');
  fs.mkdirSync(source, { recursive: true });
  const bytes = syntheticSave({ full: true, seconds });
  fs.writeFileSync(path.join(source, '1.sav'), bytes);
  fs.writeFileSync(path.join(source, '28.sav'), 'foreign synthetic slot');
  const store = new Store(dataRoot, catalog);
  store.setPath('savePath', source);
  store.mutate({ type: 'settings', value: { autoBackup: false } });
  store.mutate({ ...manual, title: name + '已删除记录' });
  store.mutate(remove(profile(store).journalEntries));
  store.mutate({ ...manual, title: name + '后来记录' });
  new Saves(path.join(dataRoot, 'save-backups')).capture(source, name + '合成保护');
  const timeline = new Timeline(path.join(dataRoot, 'game-timeline'));
  timeline.configure(source, false, 30);
  const node = timeline.record(bytes, 'manual');
  timeline.updateNode(node.id, { bookmarked: true, label: name + '书签' });
  return { dataRoot, source, bytes, store, archives: new ProtectionArchives(dataRoot, () => source) };
}

test('protection package and successive complete collections preserve trash in read-only nested histories', async () => {
  const a = machine('第一代', 1000),
    b = machine('第二代', 2000),
    c = machine('第三代', 3000);
  const rows = [a, b, c].map((value) => profile(value.store).journalTrash);
  const journals = [a, b, c].map((value) => fs.readFileSync(value.store.file));
  const one = path.join(root, 'trash-one.yijian-protection');
  await migration.exportProtection({ dataRoot: a.dataRoot, file: one });
  const unpack = path.join(root, 'trash-one-history');
  await migration.importProtection({ file: one, targetDirectory: unpack });
  const direct = await migration.readHistory({ directory: unpack });
  assert.deepEqual(direct.journal.profiles[0].journalTrash, rows[0]);
  assert.equal(direct.readOnly, true);
  assert.equal(direct.bound, false);
  await b.archives.import(one);
  const second = path.join(root, 'trash-two.yijian-protection');
  await complete.exportComplete({ ...b, file: second });
  const imported = await complete.importComplete({ archives: c.archives, file: second });
  assert.equal(imported.archiveIds.length, 2);
  const histories = await Promise.all(imported.archiveIds.map((id) => c.archives.history(id, c.store)));
  assert.deepEqual(histories.map((value) => value.journal.profiles[0].journalTrash[0].entry.title).sort(), [
    '第一代已删除记录',
    '第二代已删除记录',
  ]);
  const third = path.join(root, 'trash-three.yijian-protection');
  await complete.exportComplete({ ...c, file: third });
  const d = machine('接收方', 4000),
    local = fs.readFileSync(d.store.file);
  const localSlots = [
    fs.readFileSync(path.join(d.source, '1.sav')),
    fs.readFileSync(path.join(d.source, '28.sav')),
  ];
  const nested = await complete.importComplete({ archives: d.archives, file: third });
  assert.equal(nested.archiveIds.length, 3);
  const nestedHistories = await Promise.all(nested.archiveIds.map((id) => d.archives.history(id, d.store)));
  assert.deepEqual(
    nestedHistories.map((value) => value.journal.profiles[0].journalTrash[0].entry.title).sort(),
    ['第三代已删除记录', '第一代已删除记录', '第二代已删除记录'].sort(),
  );
  for (const history of nestedHistories) {
    assert.ok(history.readOnly && !history.bound);
    const p = history.journal.profiles[0];
    const expected = rows.find((value) => value[0].entry.id === p.journalTrash[0].entry.id);
    assert.deepEqual(p.journalTrash, expected);
    assert.equal(p.journalEntries.length, 1);
    assert.equal(history.journal.settings.savePath, '');
    assert.equal(history.journal.settings.steamPath, '');
    assert.equal(history.journal.settings.autoBackup, false);
    assert.doesNotMatch(
      JSON.stringify(p.journalTrash),
      /nativeCapability|nativeLoadToken|ownerHash|savePath|steamPath/,
    );
  }
  for (const [i, source] of [a, b, c].entries()) {
    assert.deepEqual(fs.readFileSync(source.store.file), journals[i]);
    assert.deepEqual(fs.readFileSync(path.join(source.source, '1.sav')), source.bytes);
    assert.equal(fs.readFileSync(path.join(source.source, '28.sav'), 'utf8'), 'foreign synthetic slot');
  }
  assert.deepEqual(fs.readFileSync(d.store.file), local);
  assert.deepEqual(fs.readFileSync(path.join(d.source, '1.sav')), localSlots[0]);
  assert.deepEqual(fs.readFileSync(path.join(d.source, '28.sav')), localSlots[1]);
});
