'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const migration = require('../src/core/migration.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-journal-store-'));
const manual = {
  type: 'journal-entry-put',
  title: '见到卫霍',
  body: '第一天的原记录',
  occurredAt: '2026-10-08T08:00:00.000Z',
  tags: ['人物'],
  links: [{ type: 'database', id: 'npc-10047' }],
  snapshotMode: 'none',
};
test('persistent records survive restart, link deletion and complete migration without altering legacy notes', async () => {
  const dir = path.join(root, 'first'),
    store = new Store(dir, catalog);
  store.mutate({ type: 'note', value: '旧版整段笔记完整保留' });
  store.mutate({ type: 'goal-add', title: '给卫霍准备物品' });
  const firstGoal = store.get().profiles[0].goals[0].id;
  store.mutate(manual);
  store.mutate({ type: 'goal-toggle', id: firstGoal });
  store.mutate({ type: 'goal-toggle', id: firstGoal });
  let p = store.get().profiles[0];
  assert.deepEqual(
    p.journalEntries.map((e) => e.kind),
    ['manual', 'goal-completed', 'goal-reopened'],
  );
  assert.equal(p.goals[0].done, false);
  store.mutate({ type: 'goal-remove', id: firstGoal });
  p = new Store(dir, catalog).get().profiles[0];
  assert.equal(p.journalEntries[1].links.find((link) => link.type === 'goal').detached, true);
  assert.equal(p.journalEntries[1].links.find((link) => link.type === 'goal').label, '给卫霍准备物品');
  assert.equal(p.notes, '旧版整段笔记完整保留');
  const file = path.join(root, 'with-records.yijian-protection');
  await migration.exportProtection({ dataRoot: dir, file });
  const imported = await migration.importProtection({ file, targetDirectory: path.join(root, 'history') });
  const history = await migration.readHistory({ directory: path.join(root, 'history') });
  assert.equal(imported.profiles.length, 1);
  assert.equal(history.journal.profiles[0].journalEntries.length, 3);
  assert.equal(history.journal.profiles[0].journalEntries[0].body, '第一天的原记录');
  assert.equal(history.journal.profiles[0].notes, p.notes);
  assert(
    history.journal.profiles[0].journalEntries[1].links.some(
      (link) => link.detached && link.label === '给卫霍准备物品',
    ),
  );
});
test('bulk removal affects only selected record identities and never completes, reopens or removes a goal', () => {
  const store = new Store(path.join(root, 'remove'), catalog);
  store.mutate({ type: 'goal-add', title: '还要准备的物品' });
  const goal = store.get().profiles[0].goals[0].id;
  store.mutate({ type: 'goal-toggle', id: goal });
  store.mutate(manual);
  const p = store.get().profiles[0],
    before = store.get();
  assert.throws(
    () => store.mutate({ type: 'journal-entries-remove', ids: [p.journalEntries[0].id, 'foreign-record'] }),
    /当前周目/,
  );
  assert.deepEqual(store.get(), before);
  store.mutate({
    type: 'journal-entries-remove',
    ids: p.journalEntries.map((e) => e.id),
    expectedEntries: p.journalEntries,
  });
  assert.equal(store.get().profiles[0].journalEntries.length, 0);
  assert.equal(store.get().profiles[0].goals[0].done, true);
});

test('a stale main-window deletion cannot remove a record updated through another window or write state', () => {
  const dir = path.join(root, 'stale-confirmation');
  const store = new Store(dir, catalog);
  store.mutate(manual);
  const original = store.get().profiles[0].journalEntries[0];
  store.mutate({
    ...manual,
    type: 'journal-entry-update',
    id: original.id,
    title: '小窗刚保存的标题',
    body: '新增的重要正文',
  });
  const before = store.get();
  const current = fs.readFileSync(path.join(dir, 'journal.json'));
  const previous = fs.readFileSync(path.join(dir, 'journal.json.previous'));
  for (const command of [
    { type: 'journal-entry-remove', id: original.id, expectedEntry: original },
    { type: 'journal-entries-remove', ids: [original.id], expectedEntries: [original] },
  ]) {
    assert.throws(() => store.mutate(command), /已变化/);
    assert.deepEqual(store.get(), before);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'journal.json')), current);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'journal.json.previous')), previous);
  }
  const updated = before.profiles[0].journalEntries[0];
  store.mutate({ type: 'journal-entry-remove', id: updated.id, expectedEntry: updated });
  assert.equal(new Store(dir, catalog).get().profiles[0].journalEntries.length, 0);
});
