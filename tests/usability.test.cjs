'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Activity } = require('../src/core/activity.cjs');
const { Store } = require('../src/core/store.cjs');
const { availableInventory, validateReservations } = require('../src/core/reservations.cjs');
const { materialPlan } = require('../src/core/material-plan.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const catalog = require('../src/data/catalog.cjs');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-usability-'));
test('operational results and node drafts survive restart without changing the journal', () => {
  const dir = root();
  new Store(dir, catalog);
  const bytes = fs.readFileSync(path.join(dir, 'journal.json'));
  const a = new Activity(dir);
  a.record('error', '时间线已停止：游戏组件连接异常');
  a.draft('node-1', { label: '<尝试前>', note: '尚未提交的选择备忘' });
  const b = new Activity(dir);
  assert.equal(b.get().events[0].level, 'error');
  assert.equal(b.get().drafts['node-1'].note, '尚未提交的选择备忘');
  b.record('info', '手札已重新打开');
  assert.equal(new Activity(dir).get().fault.message, '时间线已停止：游戏组件连接异常');
  b.clearFault();
  assert.equal(new Activity(dir).get().fault, undefined);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'journal.json')), bytes);
  b.draft('node-1', null);
  assert.deepEqual(new Activity(dir).get().drafts, {});
  for (let i = 0; i < 40; i++) b.record('info', String(i));
  assert.equal(new Activity(dir).get().events.length, 30);
  assert.throws(() => b.draft('../x', { label: '', note: '' }));
  assert.throws(() => b.draft('x', { label: '', note: 'x'.repeat(501) }));
});
test('activity recovers the previous draft and preserves the damaged primary', () => {
  const dir = root(),
    activity = new Activity(dir);
  activity.draft('checkpoint-1', { label: '重要选择', note: '原始草稿' });
  activity.record('info', '已打开预览');
  fs.writeFileSync(activity.file, 'corrupt');
  const recovered = new Activity(dir);
  assert.equal(recovered.get().drafts['checkpoint-1'].note, '原始草稿');
  assert.match(recovered.warning, /上一份/);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('activity.json.damaged-')));
});
test('failed draft writes do not claim persistence or replace the previous in-memory draft', () => {
  const activity = new Activity(root());
  activity.draft('checkpoint-1', { label: '', note: '已保存' });
  const before = fs.readFileSync(activity.file),
    rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === activity.file) throw Error('synthetic write failure');
    return rename(from, to);
  };
  try {
    assert.throws(
      () => activity.draft('checkpoint-1', { label: '', note: '新草稿' }),
      /synthetic write failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readFileSync(activity.file), before);
  assert.equal(activity.get().drafts['checkpoint-1'].note, '已保存');
  activity.draft('checkpoint-1', { label: '', note: '重新保存' });
  assert.equal(new Activity(path.dirname(activity.file)).get().drafts['checkpoint-1'].note, '重新保存');
});
test('damaged activity still reads previous when preservation fails and never overwrites the original', () => {
  const activity = new Activity(root());
  activity.draft('old', { label: '之前', note: '保留' });
  activity.record('info', 'previous retained');
  fs.writeFileSync(activity.file, 'corrupt');
  const copy = fs.copyFileSync;
  fs.copyFileSync = (from, to, ...args) => {
    if (from === activity.file && to.includes('.damaged-')) throw Error('synthetic preservation failure');
    return copy(from, to, ...args);
  };
  let restored;
  try {
    restored = new Activity(path.dirname(activity.file));
    assert.equal(restored.get().drafts.old.note, '保留');
    assert.match(restored.warning, /暂不覆盖/);
    assert.throws(() => restored.record('info', 'new'), /preservation failure/);
    assert.equal(fs.readFileSync(activity.file, 'utf8'), 'corrupt');
  } finally {
    fs.copyFileSync = copy;
  }
  restored.record('info', 'recovered');
  assert.equal(new Activity(path.dirname(activity.file)).get().drafts.old.note, '保留');
  assert.ok(fs.readdirSync(path.dirname(activity.file)).some((n) => n.startsWith('activity.json.damaged-')));
});
test('draft capacity allows replacement, removal, and retry without changing other drafts', () => {
  const activity = new Activity(root());
  for (let i = 0; i < 100; i++) activity.draft('node-' + i, { label: String(i), note: '保留 ' + i });
  const before = fs.readFileSync(activity.file);
  assert.throws(() => activity.draft('new', { label: 'new', note: 'pending' }), /100 份/);
  assert.deepEqual(fs.readFileSync(activity.file), before);
  activity.draft('node-0', null);
  activity.draft('new', { label: 'new', note: 'retry' });
  const reopened = new Activity(path.dirname(activity.file)).get();
  assert.equal(Object.keys(reopened.drafts).length, 100);
  assert.equal(reopened.drafts.new.note, 'retry');
  assert.equal(reopened.drafts['node-99'].note, '保留 99');
});
test('reservation subtraction handles duplicate inventory without hiding invalid stock', () => {
  const inventory = [
    { id: 10300, count: 3 },
    { id: 10300, count: 7 },
  ];
  assert.deepEqual(
    availableInventory(inventory, { 10300: 8 }).map((i) => i.count),
    [0, 2],
  );
  assert.deepEqual(
    inventory.map((i) => i.count),
    [3, 7],
  );
  assert.equal(materialPlan([{ id: 'fusion-7000', quantity: 1 }], { inventory }, { 10300: 8 }).missing, 3);
  assert.equal(materialPlan([{ id: 'fusion-7000', quantity: 1 }], { inventory }, { 10300: 20 }).missing, 5);
  assert.throws(() =>
    materialPlan(
      [{ id: 'fusion-7000', quantity: 1 }],
      { inventory: [{ id: 10300, count: -1 }] },
      { 10300: 8 },
    ),
  );
  for (const value of [{ 10300: -1 }, { 10300: 1.5 }, { 999999999: 1 }, [], { 10300: 0 }])
    assert.throws(() => validateReservations(value));
});
test('active family summary preserves parent state and identifies active child steps', () => {
  const m = enrich({
    quests: [
      { id: 5200, step: 4 },
      { id: 5201, step: 1 },
      { id: 5202, step: 4 },
    ],
    trackingMainQuest: 5200,
  });
  assert.equal(m.activeQuestFamilies.length, 1);
  assert.equal(m.activeQuestFamilies[0].status, '已完成');
  assert.equal(m.activeQuestFamilies[0].activeSteps[0].id, 5201);
  assert.equal(m.quests.find((q) => q.id === 5200).step, 4);
});
test('profile binding, stage confirmation, pinned goals and reservations stay per profile', () => {
  const store = new Store(root(), catalog),
    original = store.get().activeProfileId;
  store.mutate({ type: 'goal-add', title: '重要起点' });
  const id = store.get().profiles[0].goals[0].id;
  store.mutate({ type: 'goal-pin', id });
  store.mutate({ type: 'reserve-set', id: '10300', count: 8 });
  store.mutate({ type: 'stage', value: 0 });
  store.mutate({ type: 'profile-add', name: '二周目' });
  const p = store.get().profiles[1];
  assert.equal(p.referenceMode, 'none');
  assert.equal(p.stageConfirmed, false);
  assert.equal(p.saveSlot, '');
  assert.throws(() => store.mutate({ type: 'save-slot', value: '', mode: 'slot' }));
  store.mutate({ type: 'save-slot', value: '2.sav', mode: 'slot' });
  store.mutate({ type: 'profile-switch', id: original });
  const old = store.get().profiles[0];
  assert.equal(old.goals[0].pinned, true);
  assert.equal(old.reservations[10300], 8);
  assert.equal(old.stageConfirmed, true);
  assert.equal(old.saveSlot, '');
  store.importData(store.get());
  assert.equal(store.get().profiles[1].referenceMode, 'latest');
  store.mutate({ type: 'settings', value: { saveFeedback: true } });
  assert.equal(new Store(store.dir, catalog).get().settings.saveFeedback, true);
  assert.throws(() => store.mutate({ type: 'settings', value: { saveFeedback: 'yes' } }));
});
