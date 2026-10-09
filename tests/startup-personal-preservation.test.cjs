'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { StartupRecovery, isolation } = require('../src/core/startup-recovery.cjs');
const migration = require('../src/core/migration.cjs');
const catalog = require('../src/data/catalog.cjs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function seed(store) {
  store.mutate({ type: 'note', value: '恢复后仍保留的个人正文' });
  store.mutate({
    type: 'goal-add',
    title: '可找回的行囊目标',
    detail: '目标原文\n第二行',
    source: { type: 'database', id: 'item-1000' },
  });
  const goal = store.get().profiles[0].goals[0];
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: goal });
  store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 2 });
  store.mutate({
    type: 'craft-plan-save',
    name: '可找回的完整制作计划',
    list: [{ id: 'fusion-1000', quantity: 1 }],
    reserved: false,
  });
  const plan = store.get().profiles[0].craftPlans[0];
  store.mutate({ type: 'craft-plan-remove', id: plan.id, expectedRecord: plan });
  store.mutate({
    type: 'journey-todo-put',
    id: 'removed-todo',
    title: '可找回的旧安排',
    detail: '原安排的全文\n第二行',
    done: true,
  });
  store.mutate({
    type: 'journey-todo-remove',
    id: 'removed-todo',
    expectedRecord: store.get().profiles[0].journey.todos[0],
  });
  store.mutate({
    type: 'journey-todo-put',
    id: 'current-todo',
    title: '后来保存的新安排',
    detail: '不被恢复旧安排覆盖',
    done: false,
  });
  store.mutate({
    type: 'journal-entry-put',
    title: '可找回的事件',
    body: '事件全文\n第二行',
    occurredAt: '2026-10-09T06:00:00.000Z',
    tags: ['原记录'],
    links: [],
    snapshotMode: 'none',
  });
  const entry = store.get().profiles[0].journalEntries[0];
  store.mutate({ type: 'journal-entry-remove', id: entry.id, expectedEntry: entry });
  store.mutate({
    type: 'journal-draft-put',
    id: 'event-draft',
    revision: 0,
    title: '',
    body: '尚未填写标题的事件原稿',
    localTime: '',
    tags: '尚未写完，',
    links: [],
    snapshotMode: 'none',
  });
  store.mutate({
    type: 'intent-draft-put',
    id: 'intent-draft',
    kind: 'journey-todo',
    targetId: '',
    context: {},
    values: { title: '', detail: '尚未填写标题的安排原稿', placeId: '', done: false, placeQuery: '村' },
    expectedRevision: 0,
    expectedTarget: null,
  });
  const state = store.get();
  state.profiles[0].resourcePriority = ['@draft'];
  state.profiles[0].saveSlot = '29.sav';
  state.profiles[0].referenceMode = 'slot';
  state.settings.savePath = 'synthetic-old-machine/SaveGames';
  state.settings.steamPath = 'synthetic-old-machine/Steam';
  store.commit(state);
  return store.get();
}
for (const mode of ['json', 'protection', 'volumes'])
  test(`${mode} startup recovery preserves complete personal state and exposes counts while discarding machine bindings`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-startup-personal-'));
    t.after(() => {
      assert(path.basename(root).startsWith('yijian-startup-personal-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const source = path.join(root, 'source'),
      store = new Store(source, catalog),
      original = seed(store);
    const raw = fs.readFileSync(path.join(source, 'journal.json'));
    let selected = path.join(root, 'export.json');
    fs.writeFileSync(selected, raw);
    if (mode !== 'json') {
      selected = path.join(root, 'export.yijian-protection');
      await migration.exportProtection({ dataRoot: source, file: selected });
      if (mode === 'volumes') {
        const directory = path.join(root, 'complete-volumes');
        fs.mkdirSync(directory);
        const name = 'part-0001.yijian-protection',
          bytes = fs.readFileSync(selected);
        fs.writeFileSync(path.join(directory, name), bytes);
        fs.writeFileSync(
          path.join(directory, 'transfer.json'),
          JSON.stringify({
            schema: 1,
            kind: 'yijian-protection-volumes',
            createdAt: new Date().toISOString(),
            parts: [{ name, bytes: bytes.length, sha256: sha(bytes) }],
          }),
        );
        selected = directory;
      }
    }
    const broken = path.join(root, 'broken');
    fs.mkdirSync(broken);
    const bad = [
      ['journal.json', Buffer.from('synthetic damaged current')],
      ['journal.json.previous', Buffer.from('synthetic damaged previous')],
    ];
    for (const [name, bytes] of bad) fs.writeFileSync(path.join(broken, name), bytes);
    const recovery = new StartupRecovery(broken, catalog),
      preview = await recovery.preview(mode, selected);
    assert.equal(preview.profiles[0].drafts, 1);
    assert.equal(preview.profiles[0].arrangementDrafts, 1);
    assert.equal(preview.profiles[0].deletedEntries, 1);
    assert.equal(preview.profiles[0].removedArrangements, 3);
    for (const [name, bytes] of bad) assert.deepEqual(fs.readFileSync(path.join(broken, name)), bytes);
    const confirmed = await recovery.confirm(preview.token),
      restored = new Store(broken, catalog).get();
    assert.deepEqual(restored.profiles[0], { ...original.profiles[0], saveSlot: '', referenceMode: 'none' });
    assert.equal(restored.settings.savePath, '');
    assert.equal(restored.settings.steamPath, '');
    assert.equal(restored.settings.autoBackup, false);
    assert.equal(isolation(broken).disableAutoDiscovery, true);
    for (const [name, bytes] of bad)
      assert.deepEqual(fs.readFileSync(path.join(confirmed.retainedDirectory, name)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(source, 'journal.json')), raw);
    const cold = new Store(broken, catalog);
    const p = cold.get().profiles[0];
    for (const row of p.journeyTrash)
      cold.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row });
    assert(cold.get().profiles[0].goals.some((g) => g.title === '可找回的行囊目标'));
    assert(
      cold
        .get()
        .profiles[0].craftPlans.some(
          (plan) => plan.name === '可找回的完整制作计划' && plan.reserved === false,
        ),
    );
    assert(cold.get().profiles[0].journey.todos.some((row) => row.id === 'current-todo'));
    assert(cold.get().profiles[0].journey.todos.some((row) => row.id === 'removed-todo'));
    const trash = cold.get().profiles[0].journalTrash;
    cold.mutate({
      type: 'journal-trash-restore',
      ids: trash.map((row) => row.entry.id),
      expectedEntries: trash,
    });
    assert.equal(cold.get().profiles[0].journalEntries[0].body, '事件全文\n第二行');
    assert.deepEqual(cold.get().profiles[0].intentDrafts, original.profiles[0].intentDrafts);
    assert.deepEqual(cold.get().profiles[0].resourcePriority, ['@draft']);
  });
