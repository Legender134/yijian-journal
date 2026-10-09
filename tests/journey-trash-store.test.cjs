'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store } = require('../src/core/store.cjs'),
  { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const migration = require('../src/core/migration.cjs'),
  complete = require('../src/core/complete-migration.cjs'),
  { resourceBudget } = require('../src/core/resource-budget.cjs');
const catalog = require('../src/data/catalog.cjs'),
  game = require('../src/data/game-index.json');
const current = (store) => store.get().profiles[0];
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-journey-trash-store-'));
  t.after(() => {
    assert(path.basename(directory).startsWith('yijian-journey-trash-store-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store: new Store(path.join(directory, 'source'), catalog) };
}
test('three kinds survive deletion and restart; selected restore retains later notes, intent, precise gift and detached historical links', (t) => {
  const { directory, store } = setup(t),
    npcId = game.entries.find((e) => e.kind === '人物').id,
    itemId = game.entries.find((e) => e.kind === '物品' && e.giftable).id;
  const todos = {
    type: 'journey-todo-put',
    id: 'original',
    title: '要找回的待办',
    detail: '完整说明\n保留第二行',
    placeId: 'place-9',
    done: true,
  };
  store.mutate(todos);
  store.mutate({
    type: 'journey-place-put',
    placeId: 'place-9',
    note: '精确场景9',
    favorite: true,
    done: true,
  });
  store.mutate({
    type: 'journey-gift-put',
    id: 'gift',
    npcId,
    itemId,
    quantity: 999,
    placeId: 'place-9',
    note: '精确品质与数量',
    done: false,
  });
  store.mutate({
    type: 'journal-entry-put',
    title: '先前的正文',
    body: '历史关联只回顾',
    occurredAt: '2026-10-09T05:00:00.000Z',
    tags: [],
    links: [{ type: 'todo', id: 'original' }],
    snapshotMode: 'none',
  });
  const originals = structuredClone(current(store).journey);
  store.mutate({ type: 'journey-todo-remove', id: 'original', expectedRecord: originals.todos[0] });
  store.mutate({ type: 'journey-place-remove', placeId: 'place-9', expectedRecord: originals.places[0] });
  store.mutate({ type: 'journey-gift-remove', id: 'gift', expectedRecord: originals.gifts[0] });
  store.mutate({ type: 'note', value: '后来写下的新笔记' });
  store.mutate({ type: 'journey-todo-put', id: 'later', title: '后来保存的事项', detail: '', done: false });
  const cold = new Store(path.join(directory, 'source'), catalog),
    entries = structuredClone(current(cold).journalEntries);
  assert(entries[0].links[0].detached);
  assert.equal(current(cold).journeyTrash.length, 3);
  for (const row of current(cold).journeyTrash)
    cold.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row });
  assert.equal(current(cold).notes, '后来写下的新笔记');
  assert(current(cold).journey.todos.some((r) => r.id === 'later'));
  assert.deepEqual(
    current(cold).journey.todos.find((r) => r.id === 'original'),
    originals.todos[0],
  );
  assert.deepEqual(current(cold).journey.places, originals.places);
  assert.deepEqual(current(cold).journey.gifts, originals.gifts);
  assert.deepEqual(current(cold).journalEntries, entries);
  assert.equal(current(cold).journeyTrash.length, 0);
});
test('stale remove and restore confirmations leave exact memory and file bytes unchanged; a foreign recreated identifier is never overwritten', (t) => {
  const { store } = setup(t);
  store.mutate({ type: 'journey-todo-put', id: 'one', title: '旧标题', detail: '旧文字', done: false });
  const old = current(store).journey.todos[0];
  store.mutate({ type: 'journey-todo-put', id: 'one', title: '另一窗口', detail: '新文字', done: false });
  let before = store.get(),
    bytes = fs.readFileSync(store.file);
  assert.throws(() => store.mutate({ type: 'journey-todo-remove', id: 'one', expectedRecord: old }));
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  store.mutate({ type: 'journey-todo-remove', id: 'one', expectedRecord: current(store).journey.todos[0] });
  const deleted = current(store).journeyTrash[0];
  store.mutate({ type: 'journey-todo-put', id: 'one', title: '后来重新创建的安排', detail: '', done: false });
  before = store.get();
  bytes = fs.readFileSync(store.file);
  assert.throws(() =>
    store.mutate({ type: 'journey-trash-restore', id: deleted.id, expectedTrash: deleted }),
  );
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  const stale = { ...deleted, deletedAt: '2026-10-08T00:00:00.000Z' };
  assert.throws(() => store.mutate({ type: 'journey-trash-purge', id: deleted.id, expectedTrash: stale }));
  store.mutate({ type: 'journey-trash-purge', id: deleted.id, expectedTrash: deleted });
  assert.equal(current(store).journey.todos[0].title, '后来重新创建的安排');
  assert.equal(current(store).journeyTrash.length, 0);
});
test('deleted arrangements remain separate from stock claims and travel through original-byte and nested protection transfer', async (t) => {
  const { directory, store } = setup(t),
    source = path.dirname(store.file);
  store.mutate({
    type: 'journey-todo-put',
    id: 'travel',
    title: '跨设备找回',
    detail: '完整已移除意图',
    placeId: 'place-9',
    done: false,
  });
  store.mutate({
    type: 'journey-todo-remove',
    id: 'travel',
    expectedRecord: current(store).journey.todos[0],
  });
  const original = current(store).journeyTrash,
    budget = resourceBudget(current(store), null),
    raw = fs.readFileSync(store.file),
    single = path.join(directory, 'original.yijian-protection');
  assert.equal(current(store).journey.todos.length, 0);
  assert.equal(budget.gifts.length, 0);
  await migration.exportProtection({ dataRoot: source, file: single });
  const receiver = path.join(directory, 'receiver'),
    receiving = new Store(receiver, catalog),
    archives = new ProtectionArchives(receiver, () => '');
  const imported = await archives.import(single),
    history = await archives.history(imported.id, receiving);
  assert(history.readOnly);
  assert.deepEqual(history.journal.profiles[0].journeyTrash, original);
  const bundle = path.join(directory, 'complete.yijian-protection');
  await complete.exportComplete({ dataRoot: receiver, store: receiving, archives, file: bundle });
  const final = path.join(directory, 'final'),
    finalStore = new Store(final, catalog),
    finalArchives = new ProtectionArchives(final, () => '');
  await complete.importComplete({ archives: finalArchives, file: bundle });
  let found = false;
  for (const archive of finalArchives.list()) {
    const row = await finalArchives.history(archive.id, finalStore);
    if (row.journal.profiles[0].journeyTrash?.length) {
      assert.deepEqual(row.journal.profiles[0].journeyTrash, original);
      found = true;
    }
  }
  assert(found);
  assert.deepEqual(fs.readFileSync(store.file), raw);
});
