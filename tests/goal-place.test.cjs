'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { intentTarget } = require('../src/core/intent-drafts.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const migration = require('../src/core/migration.cjs');
const complete = require('../src/core/complete-migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs'),
  world = require('../src/data/world-index.json');
const PLACE = 'place-9',
  OTHER = 'place-10';
const current = (store) => store.get().profiles[0];
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-goal-place-'));
  t.after(() => {
    assert(path.basename(root).startsWith('yijian-goal-place-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store: new Store(path.join(root, 'source'), catalog) };
}
function unchanged(store, operation, pattern) {
  const before = store.get(),
    bytes = fs.readFileSync(store.file);
  assert.throws(operation, pattern);
  assert.deepEqual(store.get(), before);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
}
function draft(store, id, goal, values) {
  store.mutate({
    type: 'intent-draft-put',
    id,
    kind: 'goal',
    targetId: goal.id,
    context: {},
    values,
    expectedRevision: 0,
    expectedTarget: intentTarget(current(store), 'goal', goal.id),
  });
  return current(store).intentDrafts.find((row) => row.id === id);
}
function commit(store, row) {
  store.mutate({ type: 'intent-draft-commit', id: row.id, expectedDraft: row });
}

test('an existing personal goal gains, changes and removes an explicit scene while keeping one identity, completion and itinerary selection', (t) => {
  const { store } = setup(t);
  store.mutate({ type: 'goal-add', title: '去梧桐村办事', detail: '先核对原说明\n保留第二行' });
  const goal = current(store).goals[0];
  store.mutate({ type: 'goal-pin', id: goal.id });
  store.mutate({
    type: 'journey-todo-put',
    id: 'independent',
    title: goal.title,
    detail: '这是另一份打算',
    placeId: PLACE,
    done: false,
  });
  let p = current(store),
    plan = journeyPlan(p, null),
    action = plan.actions.find((a) => a.kind === 'goal');
  const actionId = action.id;
  assert.equal(action.places.length, 0, 'words never select a scene');
  assert(plan.unplacedActionIds.includes(actionId));
  store.mutate({ type: 'goal-edit', id: goal.id, title: goal.title, detail: goal.detail, placeId: PLACE });
  p = current(store);
  plan = journeyPlan(p, null);
  action = plan.actions.find((a) => a.id === actionId);
  assert.deepEqual(
    action.places.flatMap((place) => place.mapIds),
    [PLACE],
  );
  assert.equal(action.places[0].evidence, 'user-target');
  assert(plan.routes.some((route) => route.mapIds.includes(PLACE) && route.actionIds.includes(actionId)));
  assert(!plan.unplacedActionIds.includes(actionId));
  assert.equal(p.goals.length, 1);
  assert.equal(p.journey.todos.length, 1);
  store.mutate(
    { type: 'journey-itinerary-add', id: actionId, placeId: PLACE },
    { journeyActions: plan.actions },
  );
  const selection = current(store).journey.itinerary.steps[0];
  store.mutate({ type: 'goal-edit', id: goal.id, title: goal.title, detail: goal.detail, placeId: OTHER });
  p = current(store);
  plan = journeyPlan(p, null);
  assert.deepEqual(p.journey.itinerary.steps[0], selection);
  assert.equal(plan.actions.find((a) => a.kind === 'goal').id, actionId);
  assert.equal(plan.itinerary.steps[0].status, 'unavailable');
  assert.match(plan.itinerary.steps[0].reason, /保留你的选择/);
  store.mutate({ type: 'goal-toggle', id: goal.id });
  p = current(store);
  plan = journeyPlan(p, null);
  assert.equal(plan.itinerary.steps[0].status, 'user-done');
  assert.equal(plan.actions.find((a) => a.kind === 'todo').userDone, false);
  assert.equal(p.journey.todos[0].done, false, 'same-name independent todo never synchronizes');
  store.mutate({ type: 'goal-edit', id: goal.id, title: goal.title, detail: goal.detail, placeId: '' });
  p = current(store);
  assert.equal(Object.hasOwn(p.goals[0], 'placeId'), false);
  assert.deepEqual(p.goals[0], { ...goal, pinned: true, done: true });
  assert.deepEqual(p.journey.itinerary.steps[0], selection);
  assert(journeyPlan(p, null).unplacedActionIds.includes(actionId));
});

test('unknown, malformed and source-incompatible locations refuse atomically; old goals still cold-load unchanged', (t) => {
  const { root, store } = setup(t);
  store.mutate({ type: 'goal-add', title: '旧格式目标', detail: '说明' });
  const goal = current(store).goals[0];
  assert.deepEqual(new Store(path.join(root, 'source'), catalog).get().profiles[0].goals[0], goal);
  for (const placeId of [undefined, null, true, 9, [], {}, 'npc-9', 'place-999999999', 'place-9\n']) {
    unchanged(
      store,
      () => store.mutate({ type: 'goal-edit', id: goal.id, title: goal.title, detail: goal.detail, placeId }),
      /地点/,
    );
    unchanged(store, () => store.mutate({ type: 'goal-add', title: '坏地点', placeId }), /地点/);
  }
  for (const source of [
    { type: 'quest', id: world.quests[0].id },
    { type: 'database', id: 'item-1000' },
    { type: 'database', id: 'fusion-1000' },
  ])
    unchanged(
      store,
      () => store.mutate({ type: 'goal-add', title: '资料目标', source, placeId: PLACE }),
      /原资料/,
    );
  for (const source of [
    { type: 'guide', id: catalog.entries[0].id },
    { type: 'database', id: 'npc-5011' },
    { type: 'database', id: 'skill-1000' },
    { type: 'database', id: 'item-999999999' },
  ]) {
    store.mutate({ type: 'goal-add', title: '个人资料打算', source, placeId: PLACE });
    const p = current(store),
      g = p.goals[0];
    assert(
      journeyPlan(p, null).actions.some(
        (a) => a.kind === 'goal' && a.goalIds.includes(g.id) && a.places[0].mapIds.includes(PLACE),
      ),
    );
  }
});

test('place drafts survive restart and cancel without domain changes, guard concurrent edits, and retain compatibility with earlier text-only drafts', (t) => {
  const { root, store } = setup(t);
  store.mutate({ type: 'goal-add', title: '原目标', detail: '原说明', placeId: PLACE });
  const goal = current(store).goals[0];
  let row = draft(store, 'cancel-place', goal, {
    title: goal.title,
    detail: goal.detail,
    placeId: '',
    placeQuery: '武当山',
  });
  assert.deepEqual(current(store).goals[0], goal);
  const cold = new Store(path.join(root, 'source'), catalog);
  assert.deepEqual(current(cold).intentDrafts[0], row);
  cold.mutate({ type: 'intent-draft-remove', id: row.id, expectedDraft: row });
  assert.deepEqual(current(cold).goals[0], goal);
  row = draft(cold, 'change-place', goal, {
    title: goal.title,
    detail: goal.detail,
    placeId: OTHER,
    placeQuery: '村',
  });
  cold.mutate({
    type: 'goal-edit',
    id: goal.id,
    title: goal.title,
    detail: goal.detail,
    placeId: 'place-22',
  });
  unchanged(cold, () => commit(cold, row), /原安排/);
  assert.deepEqual(current(cold).intentDrafts[0], row);
  cold.mutate({
    type: 'intent-draft-rebase',
    id: row.id,
    expectedDraft: row,
    expectedTarget: current(cold).goals[0],
  });
  commit(cold, current(cold).intentDrafts[0]);
  assert.equal(current(cold).goals[0].placeId, OTHER);
  const legacy = draft(cold, 'legacy-text', current(cold).goals[0], {
    title: '旧草稿新标题',
    detail: '旧草稿原文',
  });
  commit(cold, legacy);
  assert.equal(current(cold).goals[0].placeId, OTHER, 'missing field is never an implicit removal');
  row = draft(cold, 'remove-place', current(cold).goals[0], {
    title: '旧草稿新标题',
    detail: '旧草稿原文',
    placeId: '',
    placeQuery: '',
  });
  commit(cold, row);
  assert.equal(Object.hasOwn(current(cold).goals[0], 'placeId'), false);
  assert.equal(current(cold).goals[0].id, goal.id);
  row = draft(cold, 'unknown-scene', current(cold).goals[0], {
    title: '未核定',
    detail: '不丢文字',
    placeId: 'place-999999999',
    placeQuery: '',
  });
  unchanged(cold, () => commit(cold, row), /地点/);
  assert.equal(current(cold).intentDrafts[0].values.detail, '不丢文字');
});

test('goal removal, restart and explicit restoration retain the scene and all original personal state', (t) => {
  const { root, store } = setup(t);
  store.mutate({ type: 'goal-add', title: '有地点的打算', detail: '完整说明', placeId: PLACE });
  const id = current(store).goals[0].id;
  store.mutate({ type: 'goal-toggle', id });
  store.mutate({ type: 'goal-pin', id });
  const goal = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id, expectedRecord: goal });
  const row = current(store).journeyTrash[0],
    cold = new Store(path.join(root, 'source'), catalog);
  assert.deepEqual(row.record, goal);
  cold.mutate({ type: 'journey-trash-restore', id: row.id, expectedTrash: row });
  assert.deepEqual(current(cold).goals[0], goal);
});

test('protection and complete migration preserve goal places, pending changes, removed copies and selected itinerary without rewriting source bytes', async (t) => {
  const { root, store } = setup(t);
  store.mutate({ type: 'goal-add', title: '保留目标地点', detail: '保留说明', placeId: PLACE });
  const goal = current(store).goals[0],
    plan = journeyPlan(current(store), null),
    action = plan.actions.find((a) => a.kind === 'goal');
  store.mutate(
    { type: 'journey-itinerary-add', id: action.id, placeId: PLACE },
    { journeyActions: plan.actions },
  );
  draft(store, 'portable-place', goal, {
    title: '未提交改地点',
    detail: '保留草稿文字',
    placeId: OTHER,
    placeQuery: '村',
  });
  store.mutate({ type: 'goal-add', title: '已移除目标', detail: '保留副本', placeId: OTHER });
  const removed = current(store).goals[0];
  store.mutate({ type: 'goal-remove', id: removed.id, expectedRecord: removed });
  const original = current(store),
    bytes = fs.readFileSync(store.file),
    file = path.join(root, 'place.yijian-protection');
  await migration.exportProtection({ dataRoot: path.dirname(store.file), file });
  const receiver = path.join(root, 'receiver'),
    receivingStore = new Store(receiver, catalog),
    archives = new ProtectionArchives(receiver, () => '');
  const imported = await archives.import(file),
    history = await archives.history(imported.id, receivingStore);
  for (const key of ['goals', 'intentDrafts', 'journeyTrash', 'journey'])
    assert.deepEqual(history.journal.profiles[0][key], original[key]);
  const nested = path.join(root, 'complete.yijian-protection');
  await complete.exportComplete({ dataRoot: receiver, store: receivingStore, archives, file: nested });
  const final = path.join(root, 'final'),
    finalStore = new Store(final, catalog),
    finalArchives = new ProtectionArchives(final, () => '');
  await complete.importComplete({ archives: finalArchives, file: nested });
  let matched = false;
  for (const archive of finalArchives.list()) {
    const entry = await finalArchives.history(archive.id, finalStore),
      p = entry.journal.profiles[0];
    if (p.goals[0]?.id !== goal.id) continue;
    for (const key of ['goals', 'intentDrafts', 'journeyTrash', 'journey'])
      assert.deepEqual(p[key], original[key]);
    matched = true;
  }
  assert(matched);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});

test('read-only protection history shows each saved goal scene, preserves unknown IDs and never infers a legacy place', async () => {
  const { createProtectionViews } = await import(
    'data:text/javascript;base64,' +
      fs.readFileSync(path.join(__dirname, '../src/renderer/protection-views.js')).toString('base64')
  );
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const factory = createProtectionViews({
    backupViews: { page: () => '' },
    journalPage: () => '',
    historyBackupView: {},
    esc,
    act: () => '',
    pill: esc,
    notice: esc,
    empty: esc,
    when: esc,
    name: (id) => (id === 'place-14' ? '<b>碗子山</b> & "地点"' : world.maps.find((m) => m.id === id)?.name),
  });
  const p = {
    id: 'historical',
    name: '历史周目',
    notes: '',
    craftPlans: [],
    goals: [
      { id: 'village-a', title: '同名村中采药', detail: '带上空行囊', placeId: PLACE, done: false },
      { id: 'village-b', title: '同名村中采药', detail: '带上空行囊', placeId: OTHER, done: true },
      {
        id: 'mountain',
        title: '<script>明早采药</script>',
        detail: '<img src=x> & 原说明',
        placeId: 'place-14',
      },
      { id: 'woods', title: '明早采药', placeId: 'place-22' },
      { id: 'unknown', title: '旧版未知地点', placeId: 'place-999999999' },
      { id: 'legacy', title: '旧目标无地点', detail: '计划前往梧桐村，尚未选择地点' },
    ],
    journey: {
      todos: [{ id: 'todo', title: '待办', placeId: PLACE }],
      gifts: [{ id: 'gift', npcId: 'npc-0', itemId: 'item-1006', quantity: 1, placeId: OTHER }],
      places: [],
      handledActionIds: [],
    },
  };
  const history = {
    id: 'synthetic-history',
    createdAt: '2026-10-09T08:00:00.000Z',
    compatible: true,
    journal: { profiles: [p] },
    backups: [],
    timeline: { records: [] },
  };
  const before = structuredClone(history);
  const html = factory.page({ history, archives: [], loaded: true });
  const goals = html.match(/<summary>目标记录<\/summary>(.*?)<\/details>/s)[1];
  assert.match(goals, /○ 同名村中采药 · 梧桐村 · 场景 #9<br>带上空行囊/);
  assert.match(goals, /✓ 同名村中采药 · 梧桐村 · 场景 #10<br>带上空行囊/);
  assert.ok(goals.includes('&lt;b&gt;碗子山&lt;/b&gt; &amp; &quot;地点&quot; · 场景 #14'));
  assert.ok(goals.includes('野猪林 · 场景 #22'));
  assert.ok(goals.includes('旧版未知地点 · place-999999999 · 场景 #999999999'));
  assert.match(goals, /旧目标无地点<br>计划前往梧桐村，尚未选择地点<\/p>/);
  assert.ok(!goals.includes('<script>'));
  assert.ok(!goals.includes('<img'));
  assert.ok(goals.includes('&lt;script&gt;明早采药&lt;/script&gt;'));
  assert.ok(goals.includes('&lt;img src=x&gt; &amp; 原说明'));
  assert.ok(html.includes('待办 · 梧桐村 · 场景 #9'));
  assert.ok(html.includes('item-1006 × 1 · 梧桐村 · 场景 #10'));
  assert.deepEqual(history, before);
});
