'use strict';
// Source or packaged Electron verification. All data and game-like bytes are invented.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = path.join(__dirname, '..');
const repository = path.resolve(base, '..', '..', '..');
process.env.ELECTRON_OVERRIDE_DIST_PATH ||= path.join(repository, 'node_modules', 'electron', 'dist');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const packagedExecutable = process.env.YIJIAN_EXECUTABLE || '',
  executablePath = packagedExecutable || require('electron'),
  launchArgs = packagedExecutable ? [] : [base];
const { Store } = require('../src/core/store.cjs');
const { Timeline } = require('../src/core/timeline.cjs');
const catalog = require('../src/data/catalog.cjs');
const { exportProtection } = require('../src/core/migration.cjs');
const { isolation } = require('../src/core/startup-recovery.cjs');
const out = path.join(
  repository,
  '.test-data',
  'maturity',
  'implementation-startup-recovery',
  'ui-' + Date.now(),
);
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'userdata'),
  source = path.join(out, 'synthetic-export'),
  gameFiles = path.join(out, 'synthetic-game-files');
for (const dir of [data, source, gameFiles]) fs.mkdirSync(dir);
const gameSentinel = path.join(gameFiles, '29.sav');
fs.writeFileSync(gameSentinel, 'invented foreign slot 29 - never launch or attach a game');
const sourceStore = new Store(source, catalog);
sourceStore.mutate({ type: 'note', value: '恢复后与重启后完整保留的笔记' });
sourceStore.mutate({ type: 'profile-rename', name: '恢复验证江湖' });
sourceStore.mutate({ type: 'goal-add', title: '恢复后的目标', detail: '合成资料' });
sourceStore.mutate({
  type: 'journal-entry-put',
  title: '恢复后的江湖记录',
  body: '原始正文完整保留',
  occurredAt: '2026-10-09T08:00:00.000Z',
  tags: ['验证'],
  links: [],
});
sourceStore.setPath('savePath', gameFiles);
sourceStore.mutate({ type: 'save-slot', value: '29.sav', mode: 'slot' });
sourceStore.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 2 });
sourceStore.mutate({
  type: 'goal-add',
  title: '恢复后可找回的目标',
  detail: '移除目标的完整说明',
  source: { type: 'database', id: 'item-1000' },
});
const removedGoal = sourceStore.get().profiles[0].goals[0];
sourceStore.mutate({ type: 'goal-remove', id: removedGoal.id, expectedRecord: removedGoal });
sourceStore.mutate({
  type: 'craft-plan-save',
  name: '恢复后可找回的计划',
  list: [{ id: 'fusion-1000', quantity: 1 }],
  reserved: false,
});
const removedPlan = sourceStore.get().profiles[0].craftPlans[0];
sourceStore.mutate({ type: 'craft-plan-remove', id: removedPlan.id, expectedRecord: removedPlan });
sourceStore.mutate({
  type: 'journey-todo-put',
  id: 'removed-intent',
  title: '恢复后要找回的安排',
  detail: '原安排全文',
  done: false,
});
sourceStore.mutate({
  type: 'journey-todo-remove',
  id: 'removed-intent',
  expectedRecord: sourceStore.get().profiles[0].journey.todos[0],
});
sourceStore.mutate({
  type: 'journal-entry-put',
  title: '恢复后要找回的事件',
  body: '回收中的原记录全文',
  occurredAt: '2026-10-09T08:00:00.000Z',
  tags: [],
  links: [],
  snapshotMode: 'none',
});
const deletedEvent = sourceStore
  .get()
  .profiles[0].journalEntries.find((row) => row.title === '恢复后要找回的事件');
sourceStore.mutate({ type: 'journal-entry-remove', id: deletedEvent.id, expectedEntry: deletedEvent });
sourceStore.mutate({
  type: 'intent-draft-put',
  id: 'unfinished-intent',
  kind: 'journey-todo',
  targetId: '',
  context: {},
  values: { title: '', detail: '恢复后仍可接着填写的想法', placeId: '', done: false, placeQuery: '村' },
  expectedRevision: 0,
  expectedTarget: null,
});
const sourceState = sourceStore.get();
sourceState.profiles[0].resourcePriority = ['@draft'];
sourceStore.commit(sourceState);
const personalFields = ['resourcePriority', 'intentDrafts', 'journeyTrash', 'journalTrash'];
const preservedPersonal = Object.fromEntries(
  personalFields.map((key) => [key, sourceStore.get().profiles[0][key]]),
);
function personalStatePreserved(profile) {
  for (const key of personalFields) assert.deepEqual(profile[key], preservedPersonal[key]);
}
fs.writeFileSync(path.join(data, 'journal.json'), '{synthetic current broken');
fs.writeFileSync(path.join(data, 'journal.json.previous'), '{synthetic previous broken');
const badBefore = ['journal.json', 'journal.json.previous'].map((name) => [
  name,
  fs.readFileSync(path.join(data, name)),
]);
const oldTimeline = new Timeline(path.join(data, 'game-timeline'));
oldTimeline.commit({
  ...oldTimeline.data,
  enabled: true,
  nativeProtocol: 2,
  source: gameFiles,
  ownerHash: 'a'.repeat(64),
});
const oldTimelineBytes = fs.readFileSync(oldTimeline.file),
  gameBefore = fs.readFileSync(gameSentinel);
let app;
const errors = [],
  facts = {
    fixture: out,
    sourceCandidate: base,
    executionMode: packagedExecutable ? 'packaged' : 'source',
    executablePath: path.resolve(executablePath),
    scenarios: [],
  };
async function observeGameWrites() {
  await app.evaluate((_electron, root) => {
    const fs = process.getBuiltinModule('fs'),
      path = process.getBuiltinModule('path');
    global.__recoveryGameWrites = [];
    const inside = (value) =>
      typeof value === 'string' &&
      (path.resolve(value).toLowerCase() === root.toLowerCase() ||
        path
          .resolve(value)
          .toLowerCase()
          .startsWith(root.toLowerCase() + path.sep));
    for (const name of [
      'writeFileSync',
      'appendFileSync',
      'truncateSync',
      'unlinkSync',
      'rmSync',
      'rmdirSync',
      'mkdirSync',
      'renameSync',
      'copyFileSync',
    ]) {
      const original = fs[name];
      fs[name] = function (...args) {
        const targets =
          name === 'copyFileSync' ? [args[1]] : name === 'renameSync' ? args.slice(0, 2) : [args[0]];
        if (targets.some(inside)) global.__recoveryGameWrites.push({ operation: name, targets });
        return original.apply(this, args);
      };
    }
    const open = fs.openSync;
    fs.openSync = function (file, flags, ...args) {
      const writing =
        typeof flags === 'number'
          ? !!(
              flags &
              (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)
            )
          : /[wa+]/.test(flags);
      if (writing && inside(file))
        global.__recoveryGameWrites.push({ operation: 'openSync', targets: [file] });
      return open.call(this, file, flags, ...args);
    };
  }, gameFiles);
}
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, args: launchArgs, cwd: base, env, timeout: 30000 });
  const window = await app.firstWindow();
  await observeGameWrites();
  window.on('pageerror', (error) => errors.push(error.message));
  await window.waitForSelector('#cancel');
  await window.waitForFunction(() => document.getElementById('status').textContent.includes('原件尚未替换'));
  return window;
}
function originalsUnchanged() {
  for (const [name, bytes] of badBefore) assert.deepEqual(fs.readFileSync(path.join(data, name)), bytes);
}
async function picker(file) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () =>
      selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] };
  }, file);
}
async function closeNormally(window) {
  assert.deepEqual(await app.evaluate(() => global.__recoveryGameWrites), []);
  const closed = app.waitForEvent('close');
  await window.evaluate(() => window.journal.window('quit')).catch(() => {});
  await closed;
  app = null;
}
(async () => {
  try {
    const good = path.join(out, 'valid.yijian-protection'),
      bad = path.join(out, 'invalid.yijian-protection');
    await exportProtection({ dataRoot: source, file: good });
    fs.writeFileSync(bad, 'this is invented wrong format');
    let window = await launch();
    assert.equal(await window.evaluate(() => typeof window.journal), 'undefined');
    assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
    const options = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => ({
        url: win.webContents.getURL(),
        preferences: win.webContents.getLastWebPreferences(),
      })),
    );
    assert.equal(options.length, 1);
    assert.equal(options[0].preferences.sandbox, true);
    assert.equal(options[0].preferences.nodeIntegration, false);
    await window.screenshot({ path: path.join(out, '01-double-corrupt-recovery.png') });
    const closed = app.waitForEvent('close');
    await window.locator('#cancel').click();
    await closed;
    app = null;
    originalsUnchanged();
    facts.scenarios.push('double corrupt starts isolated recovery; cancel leaves both originals exact');
    window = await launch();
    await picker(null);
    await window.locator('[data-mode="json"]').click();
    await window.waitForFunction(() => document.getElementById('status').textContent.includes('已取消选择'));
    originalsUnchanged();
    await picker(bad);
    await window.locator('[data-mode="protection"]').click();
    await window.waitForSelector('#error:not([hidden])');
    assert.match(await window.locator('#error').innerText(), /未通过完整校验/);
    assert.equal(await window.locator('#preview').isVisible(), false);
    originalsUnchanged();
    await window.screenshot({ path: path.join(out, '02-invalid-package-refused.png') });
    facts.scenarios.push('invalid package refused in recovery UI; no replacement');
    await picker(good);
    await window.locator('[data-mode="protection"]').click();
    await window.waitForSelector('#preview:not([hidden])');
    assert.match(await window.locator('#profiles').innerText(), /恢复验证江湖/);
    assert.match(await window.locator('#profiles').innerText(), /1 条江湖记录/);
    assert.match(await window.locator('#profiles').innerText(), /1 份安排草稿/);
    assert.match(await window.locator('#profiles').innerText(), /1 条已删除记录/);
    assert.match(await window.locator('#profiles').innerText(), /3 项已移除安排/);
    assert.equal(await window.locator('#confirm').isEnabled(), false);
    originalsUnchanged();
    const packageBytes = fs.readFileSync(good);
    fs.appendFileSync(good, 'source changed');
    await window.locator('#ack').check();
    await window.locator('#confirm').click();
    await window.waitForSelector('#error:not([hidden])');
    originalsUnchanged();
    fs.writeFileSync(good, packageBytes);
    facts.scenarios.push('package changed after preview is refused and retry remains available');
    await window.locator('[data-mode="protection"]').click();
    await window.waitForSelector('#preview:not([hidden])');
    await window.screenshot({ path: path.join(out, '03-valid-package-preview.png') });
    const nextWindow = app.waitForEvent('window');
    await window.locator('#ack').check();
    await window.locator('#confirm').click();
    window = await nextWindow;
    window.on('pageerror', (error) => errors.push(error.message));
    await window.waitForSelector('.layout');
    let bootstrap = await window.evaluate(async () => (await window.journal.bootstrap()).data);
    const profile = bootstrap.state.profiles.find((value) => value.id === bootstrap.state.activeProfileId);
    assert.equal(profile.notes, '恢复后与重启后完整保留的笔记');
    assert.equal(profile.journalEntries[0].title, '恢复后的江湖记录');
    assert.equal(profile.goals[0].title, '恢复后的目标');
    personalStatePreserved(profile);
    assert.equal(bootstrap.state.settings.savePath, '');
    assert.equal(bootstrap.state.settings.autoBackup, false);
    assert.equal(bootstrap.environment.timeline.enabled, false);
    const gate = isolation(data);
    for (const [name, bytes] of badBefore)
      assert.deepEqual(fs.readFileSync(path.join(data, gate.retainedDirectory, name)), bytes);
    assert.deepEqual(fs.readFileSync(oldTimeline.file), oldTimelineBytes);
    assert.deepEqual(fs.readFileSync(gameSentinel), gameBefore);
    await window.screenshot({ path: path.join(out, '04-restored-normal-journal.png') });
    facts.scenarios.push(
      'preview and explicit acknowledgement recover notes, goals and journal; verified original copies retained',
    );
    await closeNormally(window);
    const env = { ...process.env, YIJIAN_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath, args: launchArgs, cwd: base, env, timeout: 30000 });
    window = await app.firstWindow();
    await observeGameWrites();
    window.on('pageerror', (error) => errors.push(error.message));
    await window.waitForSelector('.layout');
    bootstrap = await window.evaluate(async () => (await window.journal.bootstrap()).data);
    assert.equal(bootstrap.state.profiles[0].notes, '恢复后与重启后完整保留的笔记');
    assert.equal(bootstrap.state.profiles[0].journalEntries[0].body, '原始正文完整保留');
    personalStatePreserved(bootstrap.state.profiles[0]);
    assert.equal(bootstrap.state.settings.savePath, '');
    assert.equal(bootstrap.environment.timeline.enabled, false);
    assert.deepEqual(isolation(data), gate);
    assert.deepEqual(fs.readFileSync(oldTimeline.file), oldTimelineBytes);
    assert.deepEqual(fs.readFileSync(gameSentinel), gameBefore);
    await window.screenshot({ path: path.join(out, '05-restart-still-isolated.png') });
    facts.scenarios.push(
      'restart retains restored journal and isolation; prior enabled timeline and game slot bytes remain exact',
    );
    facts.scenarios.push(
      'recovery preview and cold restart preserve arrangement drafts, both trash collections and explicit resource priority',
    );
    facts.gameBytesUnchanged = true;
    facts.gameWriteCount = (await app.evaluate(() => global.__recoveryGameWrites)).length;
    facts.oldTimelineSha256 = crypto.createHash('sha256').update(oldTimelineBytes).digest('hex');
    facts.errors = errors;
    assert.deepEqual(errors, []);
    await closeNormally(window);
    facts.passed = true;
    fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(facts, null, 2));
    console.log(
      JSON.stringify({ passed: true, evidence: out, scenarios: facts.scenarios, pageErrors: errors }),
    );
  } catch (error) {
    facts.error = error.stack;
    fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(facts, null, 2));
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
