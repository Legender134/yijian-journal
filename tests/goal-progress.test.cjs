'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { goalProgress } = require('../src/core/goal-progress.cjs');
const { Store } = require('../src/core/store.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const catalog = require('../src/data/catalog.cjs');
const profile = () => ({ id: 'one', name: '测试周目', referenceMode: 'latest',
  stageConfirmed: false, checks: {}, goals: [{ id: 'task', title: '采矿', detail: '', done: false,
    source: { type: 'quest', id: 'quest-5201' } }] });
const reference = (step) => ({ name: '1.sav', hash: 'test-hash', modifiedAt: '2026-10-07T10:00:00Z',
  metadata: { mapName: '测试场景', quests: [{ id: 5201, step }], activeQuestFamilies: [] } });

test('completed task follows selected save, reopens for older save, and never changes journal or save', () => {
  const p = profile(), r = reference(4), before = JSON.stringify({ p, r });
  const result = goalProgress(p, r).task;
  assert.equal(result.done, true);
  assert.equal(result.automaticDone, true);
  assert.equal(result.source.hash, r.hash);
  assert.equal(goalProgress(p, reference(1)).task.done, false);
  assert.equal(goalProgress(p, reference(1)).task.status, 'active');
  assert.equal(JSON.stringify({ p, r }), before);
});
test('unknown, incomplete, failed, disabled and wrong-slot records cannot complete a task', () => {
  const p = profile();
  for (const r of [null, { ...reference(4), metadata: {} },
    { ...reference(4), metadata: { quests: [] } }, reference(2), reference(3), reference(0), reference(99)]) {
    assert.equal(goalProgress(p, r).task.done, false);
  }
  assert.equal(goalProgress(p, reference(2)).task.status, 'failed');
  assert.equal(goalProgress(p, reference(4), '存档正在更新').task.status, 'unknown');
  assert.equal(goalProgress({ ...p, referenceMode: 'none' }, reference(4)).task.status, 'unknown');
  assert.equal(goalProgress({ ...p, referenceMode: 'slot', saveSlot: '2.sav' }, reference(4)).task.status, 'unknown');
  assert.equal(goalProgress({ ...p, referenceMode: 'slot', saveSlot: '1.sav' }, reference(4)).task.done, true);
});
test('manual completion and opting out retain user intention across save changes', () => {
  const p = profile();
  p.goals[0].done = true;
  assert.equal(goalProgress(p, null).task.done, true);
  assert.equal(goalProgress(p, reference(4)).task.automaticDone, false);
  p.goals[0].done = false;
  p.goals[0].progressMode = 'manual';
  assert.equal(goalProgress(p, reference(4)).task.done, false);
  assert.equal(goalProgress(p, reference(4)).task.status, 'manual');
});
test('passive companion stops recommending a completed task and resumes on historical progress', () => {
  const p = profile(), s = { activeProfileId: p.id, profiles: [p] };
  assert(!companionSnapshot(s, catalog, reference(4)).hints.some((h) => h.type === 'goal'));
  assert(companionSnapshot(s, catalog, reference(1)).hints.some((h) => h.id === 'task'));
  assert(companionSnapshot(s, catalog, null).hints.some((h) => h.id === 'task'));
});
test('tracking preference survives atomic state reload and rejects invalid commands/imports', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-goal-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog);
  store.mutate({ type: 'goal-add', title: '采矿', source: { type: 'quest', id: 'quest-5201' } });
  const id = store.get().profiles[0].goals[0].id;
  store.mutate({ type: 'goal-toggle', id });
  store.mutate({ type: 'goal-tracking', id, mode: 'manual', reopen: true });
  const reloaded = new Store(dir, catalog).get().profiles[0].goals[0];
  assert.equal(reloaded.progressMode, 'manual');
  assert.equal(reloaded.done, false);
  assert.throws(() => store.mutate({ type: 'goal-tracking', id, mode: 'bad' }));
  const bad = store.get(); bad.profiles[0].goals[0].progressMode = 'bad';
  assert.throws(() => store.importData(bad));
});
