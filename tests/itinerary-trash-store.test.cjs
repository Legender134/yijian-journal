'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const { StartupRecovery } = require('../src/core/startup-recovery.cjs');
const migration = require('../src/core/migration.cjs'),
  complete = require('../src/core/complete-migration.cjs');
const catalog = require('../src/data/catalog.cjs');
const A = 'journey:todo:' + 'a'.repeat(32),
  B = 'journey:quest:' + 'b'.repeat(32);
const clone = (v) => structuredClone(v);
const trip = () => ({
  name: '原两项行程\n精确场景',
  status: 'active',
  steps: [
    {
      actionId: B,
      title: '原先去的事项',
      placeId: 'place-22',
      sources: [{ type: 'quest', id: 'quest-14082', field: 'placements' }],
      skipped: true,
      progressMode: 'save',
    },
    {
      actionId: A,
      title: '后来再去的事项',
      placeId: 'place-9',
      sources: [{ type: 'user', id: 'original', field: 'journey' }],
      skipped: false,
      progressMode: 'manual',
    },
  ],
});
const active = (s) => {
  const state = s.get();
  return state.profiles.find((p) => p.id === state.activeProfileId);
};
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-itinerary-trash-'));
  t.after(() => {
    assert(path.basename(directory).startsWith('yijian-itinerary-trash-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = new Store(path.join(directory, 'source'), catalog),
    state = store.get();
  state.profiles[0].journey = {
    schema: 1,
    places: [],
    todos: [],
    gifts: [],
    handledActionIds: [A],
    itinerary: trip(),
  };
  store.importData(state);
  return { directory, store };
}
const clear = (store) =>
  store.mutate({
    type: 'journey-itinerary-clear',
    profileId: active(store).id,
    expectedItinerary: clone(active(store).journey.itinerary),
  });
const restore = (store, row = active(store).journeyTrash[0]) => ({
  type: 'journey-trash-restore',
  profileId: active(store).id,
  id: row.id,
  expectedTrash: clone(row),
  expectedItinerary: clone(active(store).journey.itinerary ?? null),
});
const bytes = (store) =>
  ['journal.json', 'journal.json.previous'].map((name) => fs.readFileSync(path.join(store.dir, name)));

test('atomic Store remove, clear and cold restart recover only one itinerary with current independent work and history intact', (t) => {
  const { directory, store } = setup(t),
    original = trip();
  store.mutate({
    type: 'journey-itinerary-remove',
    id: B,
    profileId: active(store).id,
    expectedItinerary: original,
  });
  assert.deepEqual(active(store).journeyTrash[0].record, original);
  assert.equal(active(store).journey.itinerary.steps.length, 1);
  clear(store);
  assert.equal(active(store).journeyTrash.length, 2);
  store.mutate({ type: 'note', value: '移出清空后新增的笔记\n末行' });
  store.mutate({
    type: 'journey-todo-put',
    id: 'later',
    title: '后来新待办',
    detail: '完整详情',
    done: true,
  });
  store.mutate({
    type: 'journey-gift-put',
    id: 'later-gift',
    npcId: 'npc-5011',
    itemId: 'item-1002',
    quantity: 7,
    note: '蓝品质',
    done: true,
  });
  store.mutate({ type: 'goal-add', title: '后来新目标', detail: '目标说明' });
  store.mutate({
    type: 'journal-entry-put',
    title: '后来新手记',
    body: '完整正文',
    occurredAt: '2026-10-09T02:00:00.000Z',
    tags: [],
    links: [],
    snapshotMode: 'none',
  });
  store.mutate({ type: 'journey-itinerary-name', name: '清空后改过的新名称' });
  const cold = new Store(path.join(directory, 'source'), catalog),
    before = active(cold);
  cold.mutate(restore(cold, before.journeyTrash[0]));
  const recovered = active(cold);
  assert.deepEqual(recovered.journey, { ...before.journey, itinerary: original });
  for (const key of [
    'notes',
    'goals',
    'journalEntries',
    'journalDrafts',
    'journalTrash',
    'journalRevisions',
    'intentDrafts',
    'craftList',
    'craftPlans',
  ])
    assert.deepEqual(recovered[key], before[key], key);
  assert.deepEqual(recovered.journeyTrash[0], before.journeyTrash[1]);
  assert.deepEqual(recovered.journeyTrash.at(-1).record, before.journey.itinerary);
  assert.deepEqual(new Store(path.join(directory, 'source'), catalog).get(), cold.get());
});

test('stale current/archive/profile and invalid extra-field confirmations preserve exact current and previous bytes', (t) => {
  const { store } = setup(t);
  clear(store);
  const old = restore(store),
    owner = active(store).id;
  store.mutate({ type: 'journey-itinerary-name', name: '另一窗更新' });
  let before = store.get(),
    raw = bytes(store);
  assert.throws(() => store.mutate(old), /已变化/);
  const good = restore(store);
  for (const command of [
    { ...good, expectedTrash: { ...good.expectedTrash, record: { ...trip(), name: '过期副本' } } },
    { ...good, force: true },
    { ...good, actionIds: [] },
    { ...good, profileId: undefined },
    { type: 'journey-itinerary-clear', profileId: owner },
  ])
    assert.throws(() => store.mutate(command));
  assert.deepEqual(store.get(), before);
  assert.deepEqual(bytes(store), raw);
  store.mutate({ type: 'profile-add', name: '另一个合成周目' });
  before = store.get();
  raw = bytes(store);
  assert.throws(() => store.mutate(good), /周目已变化/);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(bytes(store), raw);
});

test('itinerary trash survives JSON import, original-byte protection, nested complete transfer and explicit startup recovery', async (t) => {
  const { directory, store } = setup(t);
  clear(store);
  const original = clone(active(store).journeyTrash),
    sourceBytes = fs.readFileSync(store.file);
  const jsonReceiver = new Store(path.join(directory, 'json-receiver'), catalog);
  jsonReceiver.importData(JSON.parse(sourceBytes));
  assert.deepEqual(active(jsonReceiver).journeyTrash, original);
  const protection = path.join(directory, 'itinerary.yijian-protection');
  await migration.exportProtection({ dataRoot: store.dir, file: protection });
  const receiving = new Store(path.join(directory, 'receiver'), catalog),
    archives = new ProtectionArchives(receiving.dir, () => '');
  const imported = await archives.import(protection),
    historical = await archives.history(imported.id, receiving);
  assert(historical.readOnly);
  assert.deepEqual(historical.journal.profiles[0].journeyTrash, original);
  const bundle = path.join(directory, 'complete.yijian-protection');
  await complete.exportComplete({ dataRoot: receiving.dir, store: receiving, archives, file: bundle });
  const final = new Store(path.join(directory, 'final'), catalog),
    finalArchives = new ProtectionArchives(final.dir, () => '');
  await complete.importComplete({ archives: finalArchives, file: bundle });
  let found = false;
  for (const entry of finalArchives.list()) {
    const history = await finalArchives.history(entry.id, final);
    if (history.journal.profiles[0].journeyTrash?.length) {
      assert.deepEqual(history.journal.profiles[0].journeyTrash, original);
      found = true;
    }
  }
  assert(found);
  const broken = path.join(directory, 'broken'),
    json = path.join(directory, 'export.json');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'journal.json'), 'synthetic damaged current');
  fs.writeFileSync(path.join(broken, 'journal.json.previous'), 'synthetic damaged previous');
  fs.writeFileSync(json, sourceBytes);
  const recovery = new StartupRecovery(broken, catalog),
    preview = await recovery.preview('json', json);
  await recovery.confirm(preview.token);
  assert.deepEqual(active(new Store(broken, catalog)).journeyTrash, original);
  assert.deepEqual(fs.readFileSync(store.file), sourceBytes);
});
