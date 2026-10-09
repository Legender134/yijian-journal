'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { journeyPlan } = require('../src/core/journey-plan.cjs');
const { resourceBudget } = require('../src/core/resource-budget.cjs');
const migration = require('../src/core/migration.cjs');
const complete = require('../src/core/complete-migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs');
test('selected itinerary, explicit priority and completed craft plans survive original-byte protection transfer and the unbound historical view', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-planning-intent-'));
  t.after(() => {
    assert(path.basename(root).startsWith('yijian-planning-intent-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'),
    store = new Store(source, catalog);
  store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 1 });
  store.mutate({
    type: 'craft-plan-save',
    name: '已制作的合成铁锭计划',
    list: [{ id: 'fusion-9500', quantity: 2 }],
    reserved: true,
    addGoal: true,
  });
  const completed = store.get().profiles[0].craftPlans[0];
  store.mutate({ type: 'craft-plan-complete', id: completed.id, value: true, expectedPlan: completed });
  store.mutate({
    type: 'journey-todo-put',
    id: 'synthetic-todo',
    title: '本次先核对余料 × 2，再记录图纸差异',
    detail: '合成测试事项',
    done: false,
  });
  let profile = store.get().profiles[0];
  const actions = journeyPlan(profile, null, resourceBudget(profile, null)).actions;
  const action = actions.find((a) => a.kind === 'todo');
  store.mutate({ type: 'journey-itinerary-add', id: action.id }, { journeyActions: actions });
  store.mutate({ type: 'journey-itinerary-skip', id: action.id, skipped: true });
  store.mutate({ type: 'journey-itinerary-name', name: '出发前核对' });
  const current = store.get();
  current.profiles[0].resourcePriority = ['@draft'];
  store.commit(current);
  profile = store.get().profiles[0];
  assert.equal(profile.journey.itinerary.steps[0].title, '本次先核对余料 × 2，再记录图纸差异');
  const raw = fs.readFileSync(path.join(source, 'journal.json'));
  const single = path.join(root, 'intents.yijian-protection'),
    target = path.join(root, 'historical');
  await migration.exportProtection({ dataRoot: source, file: single });
  const preview = await migration.previewProtection({ file: single, targetDirectory: target });
  await migration.importProtection({
    file: single,
    targetDirectory: target,
    expectedPackageHash: preview.packageHash,
  });
  const view = await migration.readHistory({ directory: target });
  assert.deepEqual(view.journal.profiles[0].journey.itinerary, profile.journey.itinerary);
  assert.deepEqual(view.journal.profiles[0].resourcePriority, ['@draft']);
  assert.deepEqual(view.journal.profiles[0].craftPlans, profile.craftPlans);
  assert.deepEqual(view.journal.profiles[0].journalEntries, profile.journalEntries);
  assert.equal(view.journal.profiles[0].goals[0].done, false);
  assert(!resourceBudget(view.journal.profiles[0], null).crafts.some((p) => p.id === completed.id));
  assert.equal(view.journal.profiles[0].referenceMode, 'none');
  assert.equal(view.journal.settings.savePath, '');
  assert.deepEqual(fs.readFileSync(path.join(target, 'payload', 'originals', 'journal.json')), raw);
  const receiver = path.join(root, 'receiver'),
    receivingStore = new Store(receiver, catalog);
  const archives = new ProtectionArchives(receiver, () => '');
  await archives.import(single);
  const collection = path.join(root, 'complete.yijian-protection');
  await complete.exportComplete({ dataRoot: receiver, store: receivingStore, archives, file: collection });
  const finalReceiver = path.join(root, 'final-receiver');
  const finalStore = new Store(finalReceiver, catalog),
    finalArchives = new ProtectionArchives(finalReceiver, () => '');
  const imported = await complete.importComplete({ archives: finalArchives, file: collection });
  const nested = await finalArchives.history(imported.archiveIds[0], finalStore);
  assert(nested.readOnly);
  const all = finalArchives.list();
  assert(all.length >= 2);
  let matched = false;
  for (const item of all) {
    const history = await finalArchives.history(item.id, finalStore);
    if (history.journal.profiles[0].journey?.itinerary?.name === '出发前核对') {
      matched = true;
      assert.deepEqual(history.journal.profiles[0].journey.itinerary, profile.journey.itinerary);
      assert.deepEqual(history.journal.profiles[0].resourcePriority, ['@draft']);
      assert.deepEqual(history.journal.profiles[0].craftPlans, profile.craftPlans);
      assert.deepEqual(history.journal.profiles[0].journalEntries, profile.journalEntries);
      assert.equal(history.journal.profiles[0].goals[0].done, false);
    }
  }
  assert(matched, 'complete migration must retain the original selected itinerary and priority');
  assert.deepEqual(fs.readFileSync(path.join(source, 'journal.json')), raw);
});
