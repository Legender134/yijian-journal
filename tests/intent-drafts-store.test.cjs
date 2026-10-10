'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { intentTarget } = require('../src/core/intent-drafts.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const migration = require('../src/core/migration.cjs');
const complete = require('../src/core/complete-migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs'),
  game = require('../src/data/game-index.json'),
  world = require('../src/data/world-index.json');

function rendererDraftBoundary(action) {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const markers = {
    export: ['export', 'protection-open'],
    'protection-export': ['protection-export', 'protection-import-volumes'],
    import: ['import', 'launch'],
    'protection-use-journal': ['protection-use-journal', 'protection-restore'],
  };
  const [start, end] = markers[action];
  const body = source.slice(
    source.indexOf("    case '" + start + "':"),
    source.indexOf("    case '" + end + "':"),
  );
  assert(body.includes("case '" + start + "':"));
  let resolveWrite,
    rejectWrite,
    captured = false,
    persisted = false;
  const write = new Promise((resolve, reject) => {
    resolveWrite = resolve;
    rejectWrite = reject;
  });
  // Rejection is consumed by the real boundary when it waits for the draft.
  // Keep a handler in the old-code red test too, so it cannot become unhandled.
  write.catch(() => {});
  let resolveNotes;
  const noteWrite = new Promise((resolve) => {
    resolveNotes = resolve;
  });
  const savedNotes = [];
  const snapshots = [];
  const context = {
    action,
    id: 'synthetic-history',
    protectionExportRequest: 0,
    protectionView: { exportResultOverride: null },
    captureJournalDraft: () => {},
    flushJournalDrafts: async () => {},
    captureIntentDrafts: () => {
      captured = true;
    },
    flushIntentDrafts: async () => {
      await write;
      persisted = captured;
    },
    drafts: new Map([
      ['profile-one', 'pending clear'],
      ['profile-two', 'pending note'],
    ]),
    saveNote: async (id) => {
      await noteWrite;
      savedNotes.push(id);
    },
    render: () => {},
    toast: () => {},
    refresh: async () => {},
    call: async (method) => {
      snapshots.push({ method, persisted });
      return { cancelled: true };
    },
  };
  vm.createContext(context);
  const run = () => vm.runInContext('(async () => { switch (action) { ' + body + ' } })()', context);
  return { run, snapshots, resolveWrite, rejectWrite, resolveNotes, savedNotes };
}

for (const [action, method] of [
  ['export', 'exportJournal'],
  ['protection-export', 'exportProtection'],
  ['import', 'importJournal'],
  ['protection-use-journal', 'useHistoricalJournal'],
]) {
  test(
    action + ' waits for pending personal drafts before taking an export or protection snapshot',
    async () => {
      const s = rendererDraftBoundary(action),
        task = s.run();
      await new Promise(setImmediate);
      assert.deepEqual(s.snapshots, []);
      s.resolveWrite();
      await new Promise(setImmediate);
      assert.deepEqual(s.snapshots, [], 'All profile note writes must complete before the operation');
      s.resolveNotes();
      await task;
      assert.deepEqual(s.savedNotes, ['profile-one', 'profile-two']);
      assert.deepEqual(s.snapshots, [{ method, persisted: true }]);
    },
  );
  test(
    action + ' refuses the boundary when draft persistence fails, without starting the native operation',
    async () => {
      const s = rendererDraftBoundary(action),
        task = s.run();
      const rejected = assert.rejects(task, /synthetic draft disk fault/);
      s.rejectWrite(Error('synthetic draft disk fault'));
      await rejected;
      assert.deepEqual(s.snapshots, []);
    },
  );
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-intent-draft-store-'));
  t.after(() => {
    assert(path.basename(directory).startsWith('yijian-intent-draft-store-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store: new Store(path.join(directory, 'source'), catalog) };
}
const current = (store) => store.get().profiles.find((p) => p.id === store.get().activeProfileId);
function put(store, spec) {
  const p = current(store);
  store.mutate({
    type: 'intent-draft-put',
    expectedRevision: 0,
    expectedTarget: intentTarget(p, spec.kind, spec.targetId, spec.context),
    ...spec,
  });
  return current(store).intentDrafts.find((row) => row.id === spec.id);
}
function commit(store, row, context = {}) {
  return store.mutate({ type: 'intent-draft-commit', id: row.id, expectedDraft: row }, context);
}
const todo = (id, title = '') => ({
  id,
  kind: 'journey-todo',
  targetId: '',
  context: {},
  values: { title, detail: '可续写的说明\n第二行', placeId: '', done: false, placeQuery: '村' },
});

test('collection quantity drafts retain incomplete input, survive restart, and commit only to the unchanged original item goal', (t) => {
  const { directory, store } = setup(t);
  store.mutate({
    type: 'goal-add',
    title: '原收集目标',
    detail: '原说明',
    source: { type: 'database', id: 'item-1000', quantity: 2 },
  });
  const goal = current(store).goals[0];
  let row = put(store, {
    id: 'item-count',
    kind: 'goal',
    targetId: goal.id,
    context: {},
    values: { title: goal.title, detail: goal.detail, quantity: '' },
  });
  let cold = new Store(path.join(directory, 'source'), catalog);
  assert.deepEqual(current(cold).intentDrafts[0], row);
  const unchanged = cold.get(),
    bytes = fs.readFileSync(cold.file);
  assert.throws(() => commit(cold, row), /收集数量/);
  assert.deepEqual(cold.get(), unchanged);
  assert.deepEqual(fs.readFileSync(cold.file), bytes);
  for (const quantity of ['0', '1.5', '1000', '1e2', 'Infinity']) {
    cold.mutate({
      type: 'intent-draft-put',
      id: row.id,
      kind: row.kind,
      targetId: row.targetId,
      context: {},
      values: { ...row.values, quantity },
      expectedRevision: row.revision,
    });
    row = current(cold).intentDrafts[0];
    assert.throws(() => commit(cold, row), /收集数量/);
    assert.equal(current(cold).goals[0].source.quantity, 2);
  }
  cold.mutate({
    type: 'intent-draft-put',
    id: row.id,
    kind: row.kind,
    targetId: row.targetId,
    context: {},
    values: { ...row.values, quantity: '10' },
    expectedRevision: row.revision,
  });
  row = current(cold).intentDrafts[0];
  cold.mutate({ type: 'goal-edit', id: goal.id, title: goal.title, detail: goal.detail, quantity: 3 });
  assert.throws(() => commit(cold, row), /原安排/);
  assert.deepEqual(current(cold).intentDrafts[0], row);
  cold.mutate({
    type: 'intent-draft-rebase',
    id: row.id,
    expectedDraft: row,
    expectedTarget: intentTarget(current(cold), 'goal', goal.id),
  });
  row = current(cold).intentDrafts[0];
  commit(cold, row);
  assert.deepEqual(current(cold).goals[0], { ...goal, source: { ...goal.source, quantity: 10 } });
  const legacy = put(cold, {
    id: 'old-text',
    kind: 'goal',
    targetId: goal.id,
    context: {},
    values: { title: goal.title, detail: '旧版文字草稿' },
  });
  commit(cold, legacy);
  assert.equal(current(cold).goals[0].source.quantity, 10);
  const invalidNew = put(cold, {
    id: 'no-source',
    kind: 'goal',
    targetId: '',
    context: {},
    values: { title: '普通新目标', detail: '', quantity: '10' },
  });
  assert.throws(() => commit(cold, invalidNew), /原物品目标/);
  assert.equal(current(cold).goals.length, 1);
  row = put(cold, {
    id: 'removed-target',
    kind: 'goal',
    targetId: goal.id,
    context: {},
    values: { title: goal.title, detail: '', quantity: '20' },
  });
  const saved = current(cold).goals[0];
  cold.mutate({ type: 'goal-remove', id: goal.id, expectedRecord: saved });
  assert.throws(() => commit(cold, row), /原安排/);
  assert(current(cold).intentDrafts.some((r) => r.id === row.id));
  const removed = current(cold).journeyTrash[0];
  cold.mutate({ type: 'journey-trash-restore', id: removed.id, expectedTrash: removed });
  assert.deepEqual(current(cold).goals[0], saved);
});

test('cold restart retains incomplete drafts without scheduling or allocating them; each explicit commit is atomic', (t) => {
  const { directory, store } = setup(t);
  const npc = game.entries.find((row) => row.kind === '人物').id,
    item = game.entries.find((row) => row.kind === '物品' && row.giftable).id;
  const originalBudget = resourceBudget(current(store), null),
    beforeJourney = current(store).journey;
  const first = put(store, todo('partial-todo'));
  const second = put(store, {
    id: 'partial-gift',
    kind: 'journey-gift',
    targetId: '',
    context: {},
    values: {
      npcId: npc,
      itemId: item,
      quantity: '',
      placeId: '',
      note: '还在查数量',
      done: false,
      personQuery: '',
      itemQuery: '',
      itemQuality: 'all',
      preferredOnly: false,
      stockOnly: false,
      placeQuery: '',
    },
  });
  assert.deepEqual(current(store).journey, beforeJourney);
  assert.deepEqual(resourceBudget(current(store), null), originalBudget);
  assert.deepEqual(new Store(path.join(directory, 'source'), catalog).get().profiles[0].intentDrafts, [
    first,
    second,
  ]);
  const bytes = fs.readFileSync(store.file),
    memory = store.get();
  assert.throws(() => commit(store, first), /待办标题/);
  assert.throws(() => commit(store, second), /数量/);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(store.get(), memory);
  store.mutate({
    type: 'intent-draft-put',
    ...todo('partial-todo', '准备再出发'),
    expectedRevision: first.revision,
  });
  const ready = current(store).intentDrafts.find((row) => row.id === first.id);
  commit(store, ready);
  assert.equal(current(store).journey.todos[0].id, 'draft-partial-todo');
  assert.equal(current(store).journey.todos[0].title, '准备再出发');
  assert.deepEqual(current(store).intentDrafts, [second]);
  const settled = store.get();
  assert.throws(() => commit(store, ready));
  assert.deepEqual(store.get(), settled);
});

test('editing a changed target never overwrites it or consumes text until an explicitly guarded recheck', (t) => {
  const { store } = setup(t);
  store.mutate({ type: 'goal-add', title: '最初目标', detail: '最初说明' });
  const goal = current(store).goals[0];
  let row = put(store, {
    id: 'edit-target',
    kind: 'goal',
    targetId: goal.id,
    context: {},
    values: { title: '未完成的新标题', detail: '重要的新文字' },
  });
  store.mutate({ type: 'goal-edit', id: goal.id, title: '另一窗口的正式标题', detail: '另一窗口的说明' });
  const unchanged = store.get(),
    raw = fs.readFileSync(store.file);
  assert.throws(() => commit(store, row), /原安排/);
  assert.deepEqual(store.get(), unchanged);
  assert.deepEqual(fs.readFileSync(store.file), raw);
  assert.throws(
    () => store.mutate({ type: 'intent-draft-rebase', id: row.id, expectedDraft: row, expectedTarget: goal }),
    /原安排/,
  );
  store.mutate({
    type: 'intent-draft-rebase',
    id: row.id,
    expectedDraft: row,
    expectedTarget: current(store).goals[0],
  });
  assert.equal(current(store).goals[0].title, '另一窗口的正式标题');
  row = current(store).intentDrafts[0];
  commit(store, row);
  assert.equal(current(store).goals[0].title, '未完成的新标题');
  assert.equal(current(store).goals[0].detail, '重要的新文字');
  assert.equal(current(store).intentDrafts.length, 0);
});

test('itinerary commit still requires current trusted action and exact scene, not a saved label or caller action ID', (t) => {
  const { store } = setup(t);
  store.mutate({
    type: 'journey-todo-put',
    id: 'walk',
    title: '去核对地点',
    detail: '',
    placeId: world.maps[0].id,
    done: false,
  });
  let p = current(store);
  const plan = journeyPlan(p, null, resourceBudget(p, null)),
    action = plan.actions.find((a) => a.kind === 'todo');
  const row = put(store, {
    id: 'choice-draft',
    kind: 'itinerary-choice',
    targetId: action.id,
    context: { mode: 'add', actionId: action.id, label: '可读名称不是授权' },
    values: { placeId: world.maps[0].id },
  });
  const bytes = fs.readFileSync(store.file);
  assert.throws(() => commit(store, row), /当前清单/);
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert(current(store).intentDrafts.some((r) => r.id === row.id));
  commit(store, row, { journeyActions: plan.actions, journeyItinerarySteps: plan.itinerary?.steps || [] });
  p = current(store);
  assert.equal(p.journey.itinerary.steps[0].title, action.title);
  assert.equal(p.journey.itinerary.steps[0].placeId, world.maps[0].id);
  assert.equal(p.intentDrafts.length, 0);
});

test('all seven drafts remain portable through a protection package and nested complete migration with exact original bytes', async (t) => {
  const { directory, store } = setup(t);
  store.mutate({
    type: 'goal-add',
    title: '迁移的物品目标',
    detail: '原说明',
    source: { type: 'database', id: 'item-1000', quantity: 10 },
  });
  const itemGoal = current(store).goals[0];
  const actionId = 'journey:quest:' + 'a'.repeat(32),
    recipe = game.entries.find((r) => r.kind === '配方').id;
  const specs = [
    todo('portable-todo'),
    {
      id: 'portable-place',
      kind: 'journey-place',
      targetId: world.maps[0].id,
      context: {},
      values: { note: '未提交地点说明', favorite: true, done: false },
    },
    {
      id: 'portable-goal',
      kind: 'goal',
      targetId: itemGoal.id,
      context: {},
      values: { title: '', detail: '未提交目标说明', quantity: '12' },
    },
    {
      id: 'portable-craft',
      kind: 'craft-plan',
      targetId: '',
      context: { list: [{ id: recipe, quantity: 2 }], choices: {} },
      values: { name: '未提交制作计划', addGoal: true, reserved: false },
    },
    {
      id: 'portable-name',
      kind: 'itinerary-name',
      targetId: '',
      context: {},
      values: { name: '还在想行程名称' },
    },
    {
      id: 'portable-choice',
      kind: 'itinerary-choice',
      targetId: actionId,
      context: { mode: 'add', actionId, label: '这项行动的旧名称' },
      values: { placeId: '' },
    },
    {
      id: 'portable-gift',
      kind: 'journey-gift',
      targetId: '',
      context: {},
      values: {
        npcId: '',
        itemId: '',
        quantity: '0.5',
        placeId: '',
        note: '仍在查人物与精确品质',
        done: false,
        personQuery: '人物',
        itemQuery: '剑',
        itemQuality: '金',
        preferredOnly: true,
        stockOnly: true,
        placeQuery: '村',
      },
    },
  ];
  specs.forEach((spec) => put(store, spec));
  const original = current(store).intentDrafts,
    raw = fs.readFileSync(store.file),
    source = path.dirname(store.file),
    single = path.join(directory, 'partial.yijian-protection'),
    receiver = path.join(directory, 'receiver');
  await migration.exportProtection({ dataRoot: source, file: single });
  const receivedStore = new Store(receiver, catalog),
    archives = new ProtectionArchives(receiver, () => '');
  const received = await archives.import(single);
  const history = await archives.history(received.id, receivedStore);
  assert.deepEqual(history.journal.profiles[0].intentDrafts, original);
  assert.deepEqual(history.journal.profiles[0].goals, [itemGoal]);
  assert.equal(history.journal.profiles[0].referenceMode, 'none');
  const bundle = path.join(directory, 'nested.yijian-protection');
  await complete.exportComplete({ dataRoot: receiver, store: receivedStore, archives, file: bundle });
  const final = path.join(directory, 'final'),
    finalStore = new Store(final, catalog),
    finalArchives = new ProtectionArchives(final, () => '');
  await complete.importComplete({ archives: finalArchives, file: bundle });
  let matched = false;
  for (const archive of finalArchives.list()) {
    const entry = await finalArchives.history(archive.id, finalStore);
    if (entry.journal.profiles[0].intentDrafts?.length === 7) {
      assert.deepEqual(entry.journal.profiles[0].intentDrafts, original);
      assert.deepEqual(entry.journal.profiles[0].goals, [itemGoal]);
      matched = true;
    }
  }
  assert(matched);
  assert.deepEqual(fs.readFileSync(store.file), raw);
});
