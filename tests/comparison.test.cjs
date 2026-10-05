'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { compareRecords } = require('../src/core/save-comparison.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const { Saves, sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const record = (name, metadata) => ({
  name,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  metadata: enrich({ map: 'LV_World', playSeconds: 3600, ...metadata }),
});
test('comparison aggregates stacks and gives signed deltas without changing either record', () => {
  const a = record('1.sav', {
      money: 20,
      inventory: [
        { id: 10226, count: 2 },
        { id: 10226, count: 3 },
        { id: 10220, count: 8 },
      ],
    }),
    b = record('2.sav', {
      money: 15,
      playSeconds: 1800,
      inventory: [
        { id: 10226, count: 7 },
        { id: 10525, count: 1 },
      ],
    });
  const before = JSON.stringify([a, b]),
    diff = compareRecords(a, b);
  assert.deepEqual(
    diff.inventory.changes.map((i) => [i.id, i.left, i.right, i.delta]).sort((a, b) => a[0] - b[0]),
    [
      [10220, 8, 0, -8],
      [10226, 5, 7, 2],
      [10525, 0, 1, 1],
    ],
  );
  assert.equal(diff.moneyDelta, -5);
  assert.equal(diff.playSecondsDelta, -1800);
  assert.equal(JSON.stringify([a, b]), before);
  const reverse = compareRecords(b, a);
  for (const item of diff.inventory.changes)
    assert.equal(reverse.inventory.changes.find((i) => i.id === item.id).delta, -item.delta);
});
test('unread sections stay unavailable while empty readable sections can show changes', () => {
  const a = record('1.sav', { inventory: null, quests: null }),
    b = record('2.sav', { inventory: [{ id: 10226, count: 2 }], quests: [] });
  const diff = compareRecords(a, b);
  assert.equal(diff.inventory.available, false);
  assert.deepEqual(diff.inventory.changes, []);
  assert.equal(diff.quests.available, false);
  assert.equal(diff.moneyDelta, null);
  assert.equal(diff.team.available, false);
  assert.ok(diff.recipes.every((f) => !f.available));
  const empty = compareRecords(record('0.sav', { inventory: [] }), b);
  assert.equal(empty.inventory.available, true);
  assert.equal(empty.inventory.changes[0].delta, 2);
});
test('task comparison retains status zero and does not invent completion for missing records', () => {
  const diff = compareRecords(
    record('1.sav', {
      quests: [
        { id: 5200, step: 1 },
        { id: 5201, step: 0 },
        { id: 5176, step: 4 },
      ],
    }),
    record('2.sav', {
      quests: [
        { id: 5200, step: 4 },
        { id: 5201, step: 1 },
      ],
    }),
  );
  assert.equal(diff.quests.changes.find((q) => q.id === 5200).right, '已完成');
  assert.equal(diff.quests.changes.find((q) => q.id === 5201).left, '未开始');
  assert.equal(diff.quests.changes.find((q) => q.id === 5201).parentId, 5200);
  assert.equal(diff.quests.changes.find((q) => q.id === 5176).right, '未出现在记录');
  assert.equal(diff.quests.changes.find((q) => q.id === 5176).rightStep, null);
});
test('team and recipe membership deduplicate IDs and keep unknown names explicit', () => {
  const diff = compareRecords(
    record('1.sav', { teamIds: [0, 10047, 10047], fusionRecipes: [1002, 1002], cookingRecipes: [100] }),
    record('2.sav', { teamIds: [0, 987654321], fusionRecipes: [1002, 123456], cookingRecipes: [] }),
  );
  assert.equal(diff.team.leftOnly.length, 1);
  assert.equal(diff.team.rightOnly[0].name, '角色 #987654321');
  assert.equal(diff.recipes[0].leftOnly.length, 0);
  assert.equal(diff.recipes[0].rightOnly[0].known, false);
  assert.equal(diff.recipes[1].available, false);
  assert.equal(diff.recipes[2].leftOnly.length, 1);
});
test('same-name items keep their distinct IDs and quality labels in the comparison', () => {
  const diff = compareRecords(
    record('1.sav', { inventory: [] }),
    record('2.sav', {
      inventory: [
        { id: 129, count: 2 },
        { id: 171, count: 3 },
      ],
    }),
  );
  assert.equal(diff.inventory.changes.length, 2);
  assert.ok(diff.inventory.changes.every((i) => i.name === '水煮鱼'));
  assert.equal(diff.inventory.changes.find((i) => i.id === 129).quality, '蓝');
  assert.equal(diff.inventory.changes.find((i) => i.id === 171).quality, '金');
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-comparison-'));
  const source = path.join(root, 'SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, '1.sav'),
    syntheticSave({ full: true, inventory: [{ id: 10226, count: 2 }] }),
  );
  fs.writeFileSync(
    path.join(source, '2.sav'),
    syntheticSave({ full: true, inventory: [{ id: 10226, count: 7 }] }),
  );
  return { source, saves: new Saves(path.join(root, 'backups')) };
}
test('save comparison reads fresh bytes, is immutable, and validates selected filenames', () => {
  const { source, saves } = fixture();
  const before = ['1.sav', '2.sav'].map((name) => ({
    name,
    sha: sha(fs.readFileSync(path.join(source, name))),
    mtime: fs.statSync(path.join(source, name), { bigint: true }).mtimeNs,
  }));
  assert.equal(saves.compare(source, '1.sav', '2.sav').inventory.changes[0].delta, 5);
  const same = saves.compare(source, '1.sav', '1.sav');
  assert.deepEqual(same.inventory.changes, []);
  assert.deepEqual(same.quests.changes, []);
  for (const f of before) {
    assert.equal(sha(fs.readFileSync(path.join(source, f.name))), f.sha);
    assert.equal(fs.statSync(path.join(source, f.name), { bigint: true }).mtimeNs, f.mtime);
  }
  for (const name of ['../1.sav', 'JHSaveConfig.sav', '2.sav:stream', null])
    assert.throws(() => saves.compare(source, name, '1.sav'), /槽位/);
  assert.throws(() => saves.compare(source, '99.sav', '1.sav'), /不存在/);
  fs.writeFileSync(path.join(source, '2.sav'), 'unsupported');
  assert.throws(() => saves.compare(source, '1.sav', '2.sav'), /能读取/);
});
test('comparison refuses a file changed while the pair is being read', () => {
  const { source, saves } = fixture(),
    original = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function (file, ...args) {
    const result = original.call(fs, file, ...args);
    if (file === path.join(source, '1.sav') && !injected) {
      injected = true;
      fs.writeFileSync(
        path.join(source, '2.sav'),
        syntheticSave({ full: true, inventory: [{ id: 10226, count: 10 }] }),
      );
    }
    return result;
  };
  try {
    assert.throws(() => saves.compare(source, '1.sav', '2.sav'), /读取期间发生变化/);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(saves.compare(source, '1.sav', '2.sav').inventory.changes[0].delta, 8);
});
