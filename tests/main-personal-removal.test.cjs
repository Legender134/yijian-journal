'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const start = main.indexOf("    handle('mutate', (_event, command) => {"),
  end = main.indexOf("    handle('refresh',", start);
assert(start >= 0 && end > start);
function setup() {
  const parent = path.join(__dirname, '..', '.test-data', 'main-personal-removal');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'synthetic-')),
    store = new Store(directory, catalog),
    events = [];
  let handler;
  vm.runInNewContext(main.slice(start, end), {
    handle: (name, callback) => {
      assert.equal(name, 'mutate');
      handler = callback;
    },
    store: {
      get: () => store.get(),
      // IPC transfers plain JSON into the application's realm.
      mutate: (command, context) => store.mutate(JSON.parse(JSON.stringify(command)), context),
    },
    broadcast: (...args) => events.push(args),
    companion: null,
    autoBackup: null,
  });
  return { store, events, handler };
}
for (const type of ['goal-remove', 'craft-plan-remove']) {
  test(`${type}: a confirmation queued before another window switches profile is rejected before persistence`, () => {
    const { store, handler, events } = setup();
    if (type === 'goal-remove')
      store.mutate({ type: 'goal-add', title: '原周目目标', detail: '原说明\n完整末行' });
    else
      store.mutate({
        type: 'craft-plan-save',
        name: '原周目计划',
        list: [{ id: 'fusion-1000', quantity: 3 }],
        choices: {},
        reserved: false,
      });
    const old = store.get().profiles[0],
      record = structuredClone((type === 'goal-remove' ? old.goals : old.craftPlans)[0]),
      command = { type, profileId: old.id, id: record.id, expectedRecord: record };
    store.mutate({ type: 'profile-add', name: '另一窗口切换的周目' });
    const before = store.get(),
      bytes = fs.readFileSync(store.file),
      previous = fs.readFileSync(store.file + '.previous');
    assert.notEqual(before.activeProfileId, old.id);
    assert.throws(() => handler({}, command), /周目已变化/);
    assert.deepEqual(store.get(), before);
    assert.deepEqual(fs.readFileSync(store.file), bytes);
    assert.deepEqual(fs.readFileSync(store.file + '.previous'), previous);
    assert.deepEqual(events, []);
    store.mutate({ type: 'profile-switch', id: old.id });
    handler({}, command);
    const restoredOwner = store.get().profiles.find((p) => p.id === old.id);
    assert.equal((type === 'goal-remove' ? restoredOwner.goals : restoredOwner.craftPlans).length, 0);
    assert.deepEqual(restoredOwner.journeyTrash[0].record, record);
    assert.equal(events.length, 1);
  });
}
test('the removal guard preserves explicit old-profile note persistence and legacy active-profile removal', () => {
  const { store, handler } = setup();
  store.mutate({ type: 'goal-add', title: '旧周目目标', detail: '' });
  const old = store.get().profiles[0],
    record = old.goals[0];
  store.mutate({ type: 'profile-add', name: '新周目' });
  handler({}, { type: 'note', profileId: old.id, value: '切换前未写完的旧周目笔记' });
  assert.equal(store.get().profiles.find((p) => p.id === old.id).notes, '切换前未写完的旧周目笔记');
  store.mutate({ type: 'profile-switch', id: old.id });
  handler({}, { type: 'goal-remove', id: record.id });
  assert.deepEqual(store.get().profiles[0].journeyTrash[0].record, record);
});
