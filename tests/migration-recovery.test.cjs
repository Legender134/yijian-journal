'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const migration = require('../src/core/migration.cjs');
const { bindHistoricalBackup } = require('../src/core/migration-recovery.cjs');
const { Store, validateState } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const catalog = require('../src/data/catalog.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-migration-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldData = path.join(root, 'old-data'),
    oldGame = path.join(root, 'old-game'),
    newGame = path.join(root, 'new-game');
  fs.mkdirSync(oldGame);
  fs.mkdirSync(newGame);
  fs.writeFileSync(path.join(oldGame, '1.sav'), Buffer.from('old-synthetic-progress'));
  fs.writeFileSync(path.join(oldGame, 'JHSaveConfig.sav'), Buffer.from('old-synthetic-index'));
  fs.writeFileSync(path.join(newGame, '1.sav'), Buffer.from('current-synthetic-progress'));
  fs.writeFileSync(path.join(newGame, 'JHSaveConfig.sav'), Buffer.from('current-synthetic-index'));
  fs.writeFileSync(path.join(newGame, '28.sav'), Buffer.from('unrelated-foreign-slot'));
  const time = new Date(Date.now() - 5000);
  for (const dir of [oldGame, newGame])
    for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), time, time);
  const store = new Store(oldData, catalog);
  store.setPath('savePath', oldGame);
  store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 2 });
  store.mutate({ type: 'craft-choice', itemId: '10216', recipeId: 'fusion-9500' });
  store.mutate({
    type: 'craft-plan-save',
    name: '换机前制作计划',
    list: store.get().profiles[0].craftList,
    addGoal: true,
  });
  store.mutate({ type: 'craft-draft-reserve', value: false });
  store.mutate({ type: 'craft-set', id: 'fusion-1002', quantity: 3 });
  store.mutate({ type: 'craft-plan-open', id: store.get().profiles[0].craftPlans[0].id });
  store.mutate({ type: 'goal-add', title: '武当手动提醒', source: { type: 'quest', id: 'quest-5201' } });
  store.mutate({ type: 'goal-tracking', id: store.get().profiles[0].goals[0].id, mode: 'manual' });
  store.mutate({ type: 'task-reserve', questId: 'quest-11010', itemId: '10201' });
  store.mutate({ type: 'search-save', query: 'kind:物品 气血' });
  store.mutate({
    type: 'journey-todo-put',
    id: 'roundtrip',
    title: '换机后还要去药铺',
    detail: '保留地点和备注',
    placeId: 'place-22',
    done: false,
  });
  const original = new Saves(path.join(oldData, 'save-backups')).capture(oldGame, '旧机器完整副本');
  return { root, oldData, oldGame, newGame, store, original };
}
async function prepare(f) {
  const file = path.join(f.root, 'package.yijian-protection'),
    history = path.join(f.root, 'history');
  await migration.exportProtection({ dataRoot: f.oldData, file });
  await migration.importProtection({ file, targetDirectory: history });
  const staged = await migration.materializeBackup({
    directory: history,
    id: f.original.id,
    targetDirectory: path.join(f.root, 'stage'),
  });
  return { history, staged };
}
test('offline package retains named plans, choices, independent allocations, tracking mode and saved searches', async (t) => {
  const f = setup(t),
    { history } = await prepare(f),
    view = await migration.readHistory({ directory: history });
  const old = f.store.get().profiles[0],
    p = view.journal.profiles[0];
  assert.equal(old.previousCraftContext.reserveCraftDraft, false);
  for (const key of [
    'craftPlans',
    'craftChoices',
    'allocations',
    'savedSearches',
    'activeCraftPlanId',
    'previousCraftContext',
    'journey',
  ])
    assert.deepEqual(p[key], old[key]);
  assert.equal(p.goals.find((g) => g.source.type === 'quest').progressMode, 'manual');
  validateState(view.journal, f.store.ids);
  assert.equal(p.referenceMode, 'none');
  assert.equal(view.journal.settings.savePath, '');
});
test('explicit local binding enables the existing full restore with a verified protection copy and unrelated slots preserved', async (t) => {
  const f = setup(t),
    { staged } = await prepare(f),
    saves = new Saves(path.join(f.root, 'new-data', 'save-backups'));
  const before = fs.readFileSync(path.join(f.newGame, '1.sav'));
  const bound = bindHistoricalBackup({
    saves,
    payloadDirectory: staged.payloadDirectory,
    source: f.newGame,
    stopped: () => true,
  });
  assert.deepEqual(
    fs.readFileSync(path.join(f.newGame, '1.sav')),
    before,
    'registration must not mutate game files',
  );
  const result = saves.restore(bound.id, f.newGame, () => true);
  assert.deepEqual(saves.verify(result.safetyId).buffers.get('1.sav'), before);
  assert.deepEqual(
    fs.readFileSync(path.join(f.newGame, '1.sav')),
    fs.readFileSync(path.join(f.oldGame, '1.sav')),
  );
  assert.equal(fs.readFileSync(path.join(f.newGame, '28.sav'), 'utf8'), 'unrelated-foreign-slot');
  assert(fs.existsSync(path.join(saves.root, bound.id, 'provenance-manifest.json')));
});
test('running game, overlap and damaged imported payload all refuse binding before game changes', async (t) => {
  const f = setup(t),
    { staged } = await prepare(f),
    saves = new Saves(path.join(f.root, 'new-data', 'save-backups'));
  const options = {
    saves,
    payloadDirectory: staged.payloadDirectory,
    source: f.newGame,
    stopped: () => true,
  };
  assert.throws(() => bindHistoricalBackup({ ...options, stopped: () => false }), /退出游戏/);
  assert.throws(() => bindHistoricalBackup({ ...options, source: saves.root }), /不能重叠/);
  fs.writeFileSync(path.join(staged.payloadDirectory, 'files', '1.sav'), Buffer.from('tampered-synthetic'));
  assert.throws(() => bindHistoricalBackup(options), /校验失败/);
  assert.equal(fs.readFileSync(path.join(f.newGame, '1.sav'), 'utf8'), 'current-synthetic-progress');
});
