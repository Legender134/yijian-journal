'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { applyJourneyTrashCommand, validateJourneyTrash } = require('../src/core/journey-trash.cjs');
const migration = require('../src/core/migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs');
const world = require('../src/data/world-index.json');
const current = (store) => store.get().profiles[0];
test('removal and recovery previews preserve item counts and recipe repetitions, including legacy defaults and missing references', async () => {
  const { createJourneyTrashViews } = await import(
    'data:text/javascript;base64,' +
      fs.readFileSync(path.join(__dirname, '../src/renderer/journey-trash-views.js')).toString('base64')
  );
  const view = createJourneyTrashViews({ esc: (v) => String(v ?? ''), act: () => '', when: (v) => v });
  const index = { entries: [], world: { maps: [], quests: [] }, guides: [] };
  for (const [source, label] of [
    [{ type: 'database', id: 'item-10207', quantity: 10 }, '收集数量：10 件'],
    [{ type: 'database', id: 'item-999999999', quantity: 37 }, '收集数量：37 件'],
    [{ type: 'database', id: 'item-10207' }, '收集数量：1 件'],
    [{ type: 'database', id: 'fusion-1000', quantity: 9 }, '制作次数 9 次'],
    [{ type: 'database', id: 'alchemy-100' }, '制作次数 1 次'],
    [{ type: 'database', id: 'cooking-100', quantity: 3 }, '制作次数 3 次'],
    [{ type: 'database', id: 'npc-5011' }, ''],
    [{ type: 'quest', id: 'quest-5053' }, ''],
    [{ type: 'planner', id: 'current' }, ''],
  ]) {
    const row = {
        id: 'removed',
        kind: 'goal',
        deletedAt: '2026-10-09T08:00:00.000Z',
        record: { title: '原目标', detail: '原说明', source, done: false },
      },
      before = structuredClone(row);
    for (const preview of [true, false]) {
      const html = view.detail(row, index, { preview });
      assert(html.includes(label));
      if (source.id.startsWith('item-')) assert(!html.includes('制作次数'));
      if (!label) assert(!/收集数量|制作次数/.test(html));
      assert(html.includes('原说明'));
    }
    assert.deepEqual(row, before);
  }
});
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-goal-trash-'));
  t.after(() => {
    assert(path.basename(root).startsWith('yijian-goal-trash-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store: new Store(path.join(root, 'source'), catalog) };
}
function unchanged(store, operation, pattern) {
  const state = store.get(),
    bytes = fs.readFileSync(store.file);
  assert.throws(operation, pattern);
  assert.deepEqual(store.get(), state);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
}
test('stale goal deletion refuses changed title, detail, completion and pin; fresh deletion is restart-safe and selected restore retains later content and historical detachments', (t) => {
  const { root, store } = setup(t);
  store.mutate({
    type: 'goal-add',
    title: '原目标',
    detail: '原文\n第二行',
    source: { type: 'database', id: 'fusion-1000', quantity: 3 },
  });
  const goal = current(store).goals[0];
  store.mutate({
    type: 'journal-entry-put',
    title: '关联原目标',
    body: '保留事件历史',
    occurredAt: '2026-10-09T06:00:00.000Z',
    tags: [],
    links: [{ type: 'goal', id: goal.id }],
    snapshotMode: 'none',
  });
  for (const command of [
    { type: 'goal-edit', id: goal.id, title: '另一窗口的新目标', detail: '另一窗口的新说明\n末行' },
    { type: 'goal-toggle', id: goal.id },
    { type: 'goal-pin', id: goal.id },
  ]) {
    const before = current(store).goals[0];
    store.mutate(command);
    unchanged(
      store,
      () => store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: before }),
      /已变化/,
    );
  }
  const original = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: original });
  assert.equal(current(store).goals.length, 0);
  const row = current(store).journeyTrash[0];
  assert.equal(row.kind, 'goal');
  assert.deepEqual(row.record, original);
  const detached = current(store).journalEntries;
  assert(detached.some((e) => e.links.some((l) => l.type === 'goal' && l.detached)));
  store.mutate({ type: 'goal-add', title: '后来新写的目标', detail: '后来的完整说明' });
  store.mutate({ type: 'note', value: '后来的笔记' });
  const cold = new Store(path.join(root, 'source'), catalog);
  cold.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row });
  assert.deepEqual(
    current(cold).goals.find((g) => g.id === goal.id),
    original,
  );
  assert(current(cold).goals.some((g) => g.title === '后来新写的目标'));
  assert.equal(current(cold).notes, '后来的笔记');
  assert.deepEqual(current(cold).journalEntries, detached);
  assert.equal(current(cold).journeyTrash.length, 0);
});
test('changed quest tracking blocks old removal; full restored goal retains automatic tracking and pin', (t) => {
  const { store } = setup(t);
  store.mutate({ type: 'goal-add', title: '跟踪任务', source: { type: 'quest', id: world.quests[0].id } });
  const goal = current(store).goals[0];
  store.mutate({ type: 'goal-tracking', id: goal.id, mode: 'auto' });
  unchanged(store, () => store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: goal }), /已变化/);
  store.mutate({ type: 'goal-pin', id: goal.id });
  const original = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: original });
  const row = current(store).journeyTrash[0];
  store.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row });
  assert.deepEqual(current(store).goals[0], original);
});
test('a removed craft-plan source keeps the complete archived goal and refuses restore without losing later goals or file bytes', (t) => {
  const { store } = setup(t);
  store.mutate({
    type: 'craft-plan-save',
    name: '原备料计划',
    list: [{ id: 'fusion-1000', quantity: 2 }],
    addGoal: true,
  });
  const goal = current(store).goals[0],
    plan = current(store).craftPlans[0];
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: goal });
  const row = current(store).journeyTrash[0];
  store.mutate({ type: 'craft-plan-remove', id: plan.id });
  store.mutate({ type: 'goal-add', title: '后来的目标' });
  unchanged(
    store,
    () => store.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row }),
    /完整目标仍保留/,
  );
  assert.deepEqual(current(store).journeyTrash[0].record, goal);
  const beforeCopy = current(store),
    laterGoal = beforeCopy.goals[0];
  store.mutate({ type: 'journey-trash-copy-goal', id: row.id, expectedTrash: row });
  const copy = current(store).goals.find((g) => g.id !== laterGoal.id);
  assert.equal(copy.title, goal.title);
  assert.equal(copy.detail, goal.detail);
  assert.equal(copy.done, goal.done);
  assert.equal(copy.source, undefined);
  assert.equal(copy.progressMode, undefined);
  assert.notEqual(copy.id, goal.id);
  assert.deepEqual(current(store).goals[0], laterGoal);
  assert.deepEqual(current(store).journeyTrash, beforeCopy.journeyTrash);
});
test('goal identity collision, current capacity, stale trash and full trash all refuse without overwriting', (t) => {
  const { store } = setup(t);
  store.mutate({ type: 'goal-add', title: '原目标' });
  const original = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id: original.id, expectedRecord: original });
  const row = current(store).journeyTrash[0];
  let state = store.get();
  state.profiles[0].goals = [{ ...original, title: '同标识的新内容' }];
  store.commit(state);
  unchanged(
    store,
    () => store.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row }),
    /同一安排已存在/,
  );
  state = store.get();
  state.profiles[0].goals = Array.from({ length: 300 }, (_, i) => ({ ...original, id: 'later-' + i }));
  store.commit(state);
  unchanged(
    store,
    () => store.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row }),
    /数量已满/,
  );
  unchanged(
    store,
    () =>
      store.mutate({
        type: 'journey-trash-purge',
        id: row.id,
        expectedTrash: { ...row, record: { ...original, detail: '旧预览' } },
      }),
    /已变化/,
  );
  state = store.get();
  state.profiles[0].journeyTrash = Array.from({ length: 5000 }, (_, i) => ({ ...row, id: 'trash-' + i }));
  store.commit(state);
  unchanged(
    store,
    () => store.mutate({ type: 'goal-remove', id: 'later-0', expectedRecord: current(store).goals[0] }),
    /已满/,
  );
  unchanged(
    store,
    () =>
      store.mutate({
        type: 'journey-trash-copy-goal',
        id: 'trash-0',
        expectedTrash: current(store).journeyTrash[0],
      }),
    /数量已满/,
  );
});
test('copying an archived tracked goal requires its exact snapshot, preserves pin and manual completion, leaves the original archive and history intact', (t) => {
  const { store } = setup(t);
  store.mutate({
    type: 'goal-add',
    title: '原任务目标',
    detail: '原任务说明\n末行',
    source: { type: 'quest', id: world.quests[0].id },
  });
  const goal = current(store).goals[0];
  store.mutate({ type: 'goal-tracking', id: goal.id, mode: 'auto' });
  store.mutate({ type: 'goal-pin', id: goal.id });
  store.mutate({ type: 'goal-toggle', id: goal.id });
  const original = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: original });
  const row = current(store).journeyTrash[0],
    history = current(store).journalEntries;
  unchanged(
    store,
    () =>
      store.mutate({
        type: 'journey-trash-copy-goal',
        id: row.id,
        expectedTrash: { ...row, record: { ...original, detail: '旧说明' } },
      }),
    /已变化/,
  );
  store.mutate({ type: 'journey-trash-copy-goal', id: row.id, expectedTrash: row });
  const copy = current(store).goals[0];
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.title, original.title);
  assert.equal(copy.detail, original.detail);
  assert.equal(copy.done, true);
  assert.equal(copy.pinned, true);
  assert.equal(copy.source, undefined);
  assert.equal(copy.progressMode, undefined);
  assert.deepEqual(current(store).journeyTrash[0], row);
  assert.deepEqual(current(store).journalEntries, history);
  assert.throws(
    () =>
      applyJourneyTrashCommand(
        current(store),
        { type: 'journey-trash-copy-goal', id: row.id, expectedTrash: row },
        { id: () => original.id },
      ),
    /已存在/,
  );
  assert.throws(
    () =>
      applyJourneyTrashCommand(
        current(store),
        { type: 'journey-trash-copy-goal', id: row.id, expectedTrash: row },
        { id: () => copy.id },
      ),
    /已存在/,
  );
});
test('raw text and the complete goal remain immutable in the pure transition; malformed archived goal payloads are refused', () => {
  const goal = {
    id: 'raw-goal',
    title: '  原标题  ',
    detail: '  原全文\n第二行😀  ',
    done: false,
    pinned: true,
    source: { type: 'database', id: 'item-1000', quantity: 999 },
  };
  const profile = { goals: [goal], notes: '后来的笔记' },
    before = structuredClone(profile);
  const removed = applyJourneyTrashCommand(
    profile,
    { type: 'goal-remove', id: goal.id, expectedRecord: goal },
    { now: '2026-10-09T06:00:00.000Z', id: () => 'trash-raw' },
  );
  assert.deepEqual(profile, before);
  assert.deepEqual(removed.trash[0].record, goal);
  assert.equal(removed.goals.length, 0);
  for (const record of [
    { ...goal, done: 'false' },
    { ...goal, progressMode: 'auto' },
    { ...goal, source: { type: 'planner', id: 'plan', quantity: 2 } },
    { ...goal, source: { type: 'database', id: 'item-1000', quantity: 0 } },
    { ...goal, token: 'private' },
  ])
    assert.throws(() => validateJourneyTrash([{ ...removed.trash[0], record }]));
});
test('goals in the recovery collection travel with JSON and protection history without changing the source', async (t) => {
  const { root, store } = setup(t);
  store.mutate({
    type: 'goal-add',
    title: '跨设备找回的目标',
    detail: '完整说明\n末行',
    source: { type: 'guide', id: catalog.entries[0].id },
  });
  const goal = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: goal });
  const rows = current(store).journeyTrash,
    raw = fs.readFileSync(store.file);
  const receiving = new Store(path.join(root, 'receiver'), catalog);
  receiving.importData(JSON.parse(raw));
  assert.deepEqual(current(receiving).journeyTrash, rows);
  const file = path.join(root, 'goals.yijian-protection');
  await migration.exportProtection({ dataRoot: path.dirname(store.file), file });
  const archives = new ProtectionArchives(path.dirname(receiving.file), () => '');
  const imported = await archives.import(file),
    history = await archives.history(imported.id, receiving);
  assert(history.readOnly);
  assert.deepEqual(history.journal.profiles[0].journeyTrash, rows);
  assert.deepEqual(fs.readFileSync(store.file), raw);
});
