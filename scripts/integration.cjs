'use strict';
// Exercise the actual Electron IPC and dialog decisions against synthetic files.
// Dialog stubs live only inside this test process; production code is unchanged.
const { _electron: electron } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'playwright',
);
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { Saves, sha } = require('../src/core/saves.cjs');
const { Timeline, writeBytes } = require('../src/core/timeline.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const { gameStopped } = require('../src/core/environment.cjs');
const { PROTOCOL } = require('../src/core/native-io.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(base, '.test-data', 'ipc-'));
const source = path.join(data, 'synthetic-SaveGames');
fs.mkdirSync(source);
const original = syntheticSave({ full: true, inventory: [{ id: 10226, count: 4 }] });
fs.writeFileSync(path.join(source, '1.sav'), original);
const store = new Store(data, catalog);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.setPath('savePath', source);
store.mutate({ type: 'note', value: '导出前的手札\n  保留空白。\n' });
store.mutate({ type: 'craft-set', id: 'fusion-1002', quantity: 7 });
store.mutate({ type: 'goal-add', title: '任务引用', source: { type: 'quest', id: 'quest-5200' } });
store.mutate({ type: 'goal-add', title: '备料引用', source: { type: 'planner', id: 'current' } });
const exported = path.join(data, 'export.json');
const incomingFile = path.join(data, 'incoming.json');
const report = { data, checks: [], errors: [], startedAt: new Date().toISOString() };
let app, win;
async function invoke(method, ...args) {
  return win.evaluate(({ method, args }) => window.journal[method](...args), { method, args });
}
async function ok(method, ...args) {
  const result = await invoke(method, ...args);
  assert.equal(result.ok, true, `${method}: ${result.error}`);
  return result.data;
}
async function decisions(value) {
  await app.evaluate((_electron, settings) => {
    globalThis.testDialogSettings = settings;
    globalThis.testDialogCalls = [];
  }, value);
}
async function nativeIdleBackupFlow() {
  for (const autoBackup of [true, false]) {
    const idleData = fs.mkdtempSync(path.join(base, '.test-data', 'native-idle-backup-'));
    const idleSource = path.join(idleData, '76561190000000000', 'SaveGames');
    fs.mkdirSync(idleSource, { recursive: true });
    fs.writeFileSync(path.join(idleSource, '1.sav'), original);
    const idleStore = new Store(idleData, catalog);
    idleStore.setPath('savePath', idleSource);
    idleStore.mutate({ type: 'settings', value: { autoBackup } });
    const idleTimeline = new Timeline(path.join(idleData, 'game-timeline'));
    idleTimeline.configure(idleSource, true, 10);
    fs.writeFileSync(path.join(idleSource, '29.sav'), original);
    idleTimeline.record(original, 'auto', Date.now());
    const timelineBefore = fs.readFileSync(idleTimeline.file);
    let idleApp, pulse;
    try {
      const env = { ...process.env, YIJIAN_TEST_DATA: idleData, YIJIAN_TEST_HIDDEN: '1', YIJIAN_TEST_AUTO_FAST: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      idleApp = await electron.launch({
        executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
        args: process.env.YIJIAN_EXECUTABLE ? [] : [base], env,
      });
      const idleWin = await idleApp.firstWindow();
      idleWin.on('pageerror', (error) => report.errors.push(error.message));
      await idleWin.waitForSelector('.layout');
      const waitSnapshot = async (method, predicate) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const reply = await idleWin.evaluate(method => window.journal[method](), method);
          assert.equal(reply.ok, true, reply.error);
          if (predicate(reply.data)) return reply.data;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error('Synthetic native-backup state did not become ready: ' + method);
      };
      const idleBackups = new Saves(path.join(idleData, 'save-backups'));
      if (autoBackup) {
        await waitSnapshot('refresh', snapshot => snapshot.backups.length === 1);
        assert.deepEqual(idleBackups.verify(idleBackups.list()[0].id).buffers.get('29.sav'), original);
        const health = (await idleWin.evaluate(() => window.journal.health())).data;
        assert.equal(health.timeline.enabled, true);
        assert.equal(health.backupStatus, 'watching');
        assert.equal(health.protection.label, '完整备份守护中');
        const ipcRoot = path.join(idleData, 'game-bridge'), stateFile = path.join(ipcRoot, 'state.json');
        const state = {
          protocol: PROTOCOL, revision: sha(fs.readFileSync(path.join(base, 'src/game-bridge/main.lua'))),
          session: '1791400000-123456', source: idleSource, ready: false,
          token: fs.readFileSync(path.join(ipcRoot, 'token.txt'), 'utf8'),
        };
        const heartbeat = () => writeBytes(stateFile, Buffer.from(JSON.stringify({ ...state, at: Math.floor(Date.now() / 1000) })));
        heartbeat();
        pulse = setInterval(heartbeat, 200);
        await waitSnapshot('health', health => health.backupStatus === 'paused');
        const changed = syntheticSave({ full: true, seconds: 5678 });
        fs.writeFileSync(path.join(idleSource, '1.sav'), changed);
        await idleWin.waitForTimeout(800);
        assert.equal(idleBackups.list().length, 1, 'A connected native timeline must not duplicate full-file copies');
        clearInterval(pulse);
        pulse = null;
        writeBytes(stateFile, Buffer.from(JSON.stringify({ ...state, at: Math.floor(Date.now() / 1000) - 10 })));
        await waitSnapshot('refresh', snapshot => snapshot.backups.length === 2);
        assert.deepEqual(idleBackups.verify(idleBackups.list()[0].id).buffers.get('1.sav'), changed);
        assert.deepEqual(fs.readFileSync(path.join(idleSource, '1.sav')), changed);
        assert.equal((await idleWin.evaluate(() => window.journal.health())).data.timeline.enabled, true);
        for (const [index, stale] of [
          { revision: 'obsolete-synthetic-revision' },
          { source: path.join(idleData, '76561190000000001', 'SaveGames') },
        ].entries()) {
          writeBytes(stateFile, Buffer.from(JSON.stringify({ ...state, ...stale, at: Math.floor(Date.now() / 1000) })));
          const waiting = await waitSnapshot('health', health => !health.timeline.connected && health.backupStatus === 'watching');
          assert.equal(waiting.timeline.enabled, true);
          const incoming = syntheticSave({ full: true, seconds: 6789 + index });
          fs.writeFileSync(path.join(idleSource, '1.sav'), incoming);
          await waitSnapshot('refresh', snapshot => snapshot.backups.length === 3 + index);
          assert.deepEqual(idleBackups.verify(idleBackups.list()[0].id).buffers.get('1.sav'), incoming);
          assert.deepEqual(fs.readFileSync(path.join(idleSource, '1.sav')), incoming);
        }
      } else {
        await idleWin.waitForTimeout(600);
        assert.deepEqual(idleBackups.list(), []);
        assert.equal((await idleWin.evaluate(() => window.journal.health())).data.backupStatus, 'disabled');
        assert.deepEqual(fs.readFileSync(path.join(idleSource, '1.sav')), original);
      }
      assert.deepEqual(fs.readFileSync(idleTimeline.file), timelineBefore);
      assert.deepEqual(fs.readFileSync(path.join(idleSource, '29.sav')), original);
      assert.equal(fs.existsSync(path.join(idleData, 'game-bridge', 'command.txt')), false);
    } finally {
      clearInterval(pulse);
      if (idleApp) await idleApp.close();
    }
  }
  report.checks.push('native waiting keeps verified file backups, current connection pauses duplication, stale revision/other source do not pause, disconnect resumes and backup opt-out is retained');
}
async function firstBackupFlow() {
  const firstData = fs.mkdtempSync(path.join(base, '.test-data', 'first-backup-'));
  const firstSaveBase = path.join(firstData, 'Wandering_Sword', 'Saved');
  const firstSource = path.join(firstSaveBase, '76561190000000000', 'SaveGames');
  fs.mkdirSync(firstSource, { recursive: true });
  fs.writeFileSync(path.join(firstSource, '1.sav'), original);
  let firstApp;
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: firstData, YIJIAN_TEST_HIDDEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    firstApp = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    const firstWin = await firstApp.firstWindow();
    firstWin.on('pageerror', (error) => report.errors.push(error.message));
    await firstWin.waitForSelector('.layout');
    await firstApp.evaluate(({ app, dialog }, expectedData) => {
      if (app.getPath('userData') !== expectedData) throw Error('First-backup isolation failed');
      globalThis.firstFolderCalls = [];
      globalThis.firstFolderDeferred = false;
      dialog.showOpenDialog = async (_owner, options) => {
        globalThis.firstFolderCalls.push({ title: options.title, defaultPath: options.defaultPath });
        if (globalThis.firstFolderDeferred)
          return new Promise((resolve) => { globalThis.finishFirstFolder = resolve; });
        return { canceled: true };
      };
    }, firstData);
    await firstWin.locator('.nav-btn[data-id="saves"]').click();
    const beforeCancel = fs.readFileSync(path.join(firstData, 'journal.json'));
    await firstWin.locator('.page-header [data-action="backup"]').click();
    await firstWin.waitForFunction(() => !document.querySelector('.page-header [data-action="backup"]').disabled);
    assert.deepEqual(await firstApp.evaluate(() => globalThis.firstFolderCalls), [{
      title: '选择逸剑风云决 SaveGames 文件夹', defaultPath: firstSaveBase,
    }]);
    assert.equal(await firstWin.locator('.page-header h1').innerText(), '存档匣');
    assert.equal(await firstWin.locator('#backup-label').count(), 0);
    assert.equal(await firstWin.locator('.toast.error').count(), 0);
    assert.deepEqual(fs.readFileSync(path.join(firstData, 'journal.json')), beforeCancel);
    await firstApp.evaluate(() => { globalThis.firstFolderDeferred = true; });
    await firstWin.locator('.page-header [data-action="backup"]').click();
    assert.equal(await firstWin.locator('.page-header [data-action="backup"]').isDisabled(), true);
    await firstApp.evaluate((_electron, folder) => {
      if (!globalThis.finishFirstFolder) throw Error('Directory choice was not requested');
      globalThis.finishFirstFolder({ canceled: false, filePaths: [folder] });
    }, firstSource);
    await firstWin.locator('#backup-label').waitFor();
    const connected = (await firstWin.evaluate(() => window.journal.bootstrap())).data;
    assert.equal(connected.state.settings.savePath, firstSource);
    assert.equal(connected.state.profiles[0].stageConfirmed, false);
    assert.ok((await firstWin.locator('#backup-label').inputValue()).startsWith(connected.environment.recent.mapName + ' · '));
    assert.equal(await firstWin.locator('.page-header h1').innerText(), '存档匣');
    await firstWin.locator('#backup-label').fill('直接选择目录后的第一份备份');
    await firstWin.locator('[data-action="backup-confirm"]').click();
    await firstWin.locator('.backup-row').filter({ hasText: '直接选择目录后的第一份备份' }).waitFor();
    assert.equal(sha(fs.readFileSync(path.join(firstSource, '1.sav'))), sha(original));
    const firstCopies = (await firstWin.evaluate(() => window.journal.refresh())).data.backups;
    const manual = firstCopies.find((copy) => copy.label === '直接选择目录后的第一份备份');
    assert.ok(manual);
    assert.equal(new Saves(path.join(firstData, 'save-backups')).verify(manual.id).buffers.get('1.sav').equals(original), true);
    report.firstBackupData = firstData;
    report.checks.push('first backup chooses a directory directly, cancellation is quiet, busy button is locked and unconfirmed stage uses the saved location');
  } finally {
    if (firstApp) await firstApp.close();
  }
}
(async () => {
  try {
    await firstBackupFlow();
    await nativeIdleBackupFlow();
    const env = { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    await win.waitForSelector('.layout');
    await app.evaluate(({ app, dialog }, expectedData) => {
      if (app.getPath('userData') !== expectedData) throw Error('Isolation check failed');
      globalThis.testDialogSettings = {};
      globalThis.testDialogCalls = [];
      dialog.showSaveDialog = async (_owner, options) => {
        globalThis.testDialogCalls.push({ kind: 'save', title: options.title });
        return globalThis.testDialogSettings.save || { canceled: true };
      };
      dialog.showOpenDialog = async (_owner, options) => {
        globalThis.testDialogCalls.push({ kind: 'open', title: options.title });
        if (globalThis.testDialogSettings.deferOpen)
          return new Promise((resolve) => { globalThis.finishTestFolder = resolve; });
        return globalThis.testDialogSettings.open || { canceled: true };
      };
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.testDialogCalls.push({ kind: 'confirm', ...options });
        return { response: globalThis.testDialogSettings.response ?? 0 };
      };
    }, data);

    // Capture this isolated bridge through its normal summary call, then restore the method.
    await app.evaluate(({ app }) => {
      const modulePath = app.getAppPath() + '/src/core/game-bridge.cjs';
      const { GameBridge } = process.getBuiltinModule('node:module').createRequire(modulePath)(modulePath);
      globalThis.testOriginalSummary = GameBridge.prototype.summary;
      GameBridge.prototype.summary = function (...args) {
        globalThis.testFixtureBridge = this;
        return globalThis.testOriginalSummary.apply(this, args);
      };
    });
    await ok('health');
    await app.evaluate(({ app }) => {
      const modulePath = app.getAppPath() + '/src/core/game-bridge.cjs';
      const { GameBridge } = process.getBuiltinModule('node:module').createRequire(modulePath)(modulePath);
      GameBridge.prototype.summary = globalThis.testOriginalSummary;
    });
    const otherSource = path.join(data, 'other-SaveGames');
    fs.mkdirSync(otherSource);
    fs.writeFileSync(path.join(otherSource, '1.sav'), original);
    const beforeFolderChange = fs.readFileSync(path.join(data, 'journal.json'));
    const beforeTimelineChange = fs.readFileSync(path.join(data, 'game-timeline', 'timeline.json'));
    await decisions({ deferOpen: true });
    const folderChange = invoke('chooseSaves');
    await win.waitForTimeout(50);
    await app.evaluate((_electron, folder) => {
      if (!globalThis.finishTestFolder) throw Error('Directory choice did not start');
      globalThis.testFixtureBridge.loadQueued = true;
      globalThis.finishTestFolder({ canceled: false, filePaths: [folder] });
    }, otherSource);
    const blockedFolder = await folderChange;
    await app.evaluate(() => { globalThis.testFixtureBridge.loadQueued = false; });
    assert.equal(blockedFolder.ok, false);
    assert.match(blockedFolder.error, /时间线操作/);
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), beforeFolderChange);
    assert.deepEqual(fs.readFileSync(path.join(data, 'game-timeline', 'timeline.json')), beforeTimelineChange);
    assert.equal(sha(fs.readFileSync(path.join(otherSource, '1.sav'))), sha(original));
    await decisions({ open: { canceled: false, filePaths: [otherSource] } });
    await app.evaluate(() => { globalThis.testFixtureBridge.quiescing = true; });
    const quittingFolder = await invoke('chooseSaves');
    await app.evaluate(() => { globalThis.testFixtureBridge.quiescing = false; });
    assert.equal(quittingFolder.ok, false);
    assert.match(quittingFolder.error, /正在退出/);
    assert.deepEqual(await app.evaluate(() => globalThis.testDialogCalls), []);
    const interruptedRestore = path.join(data, 'save-backups', '.restore-operation.json');
    assert.equal(fs.existsSync(interruptedRestore), false);
    fs.writeFileSync(interruptedRestore, '{"syntheticInterruptedRecord":true}');
    await decisions({ open: { canceled: false, filePaths: [otherSource] } });
    const recoveryFolder = await invoke('chooseSaves');
    fs.renameSync(interruptedRestore, interruptedRestore + '.synthetic-retained');
    assert.equal(recoveryFolder.ok, false);
    assert.match(recoveryFolder.error, /完整存档恢复/);
    assert.deepEqual(await app.evaluate(() => globalThis.testDialogCalls), []);
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), beforeFolderChange);
    report.checks.push('directory selection rechecks queued native operations after the dialog and refuses changes during exit or interrupted full restore');

    assert.equal((await ok('exportJournal')).cancelled, true);
    assert.equal(fs.existsSync(exported), false);
    await decisions({ save: { canceled: false, filePath: exported } });
    await ok('exportJournal');
    const portable = JSON.parse(fs.readFileSync(exported, 'utf8'));
    assert.equal(portable.settings.savePath, '');
    assert.equal(portable.settings.autoBackup, false);
    assert.equal(portable.profiles[0].notes, '导出前的手札\n  保留空白。\n');
    assert.deepEqual(portable.profiles[0].craftList, [{ id: 'fusion-1002', quantity: 7 }]);
    assert.deepEqual(
      portable.profiles[0].goals.map((g) => g.source.type),
      ['planner', 'quest'],
    );
    assert.equal((await ok('bootstrap')).state.settings.savePath, source);
    report.checks.push('export cancellation and path-free portable journal');

    const incoming = structuredClone(portable);
    incoming.profiles[0].name = '导入的新周目';
    incoming.profiles[0].notes = '外部导入内容';
    incoming.settings.savePath = 'C:\\not-the-users-saves';
    incoming.settings.autoBackup = true;
    fs.writeFileSync(incomingFile, '\uFEFF' + JSON.stringify(incoming), 'utf8');
    await decisions({ open: { canceled: false, filePaths: [incomingFile] }, response: 0 });
    assert.equal((await ok('importJournal')).cancelled, true);
    assert.equal((await ok('bootstrap')).state.profiles[0].notes, portable.profiles[0].notes);
    await decisions({ open: { canceled: false, filePaths: [incomingFile] }, response: 1 });
    const imported = await ok('importJournal');
    assert.equal(imported.state.profiles[0].notes, '外部导入内容');
    assert.deepEqual(imported.state.profiles[0].craftList, portable.profiles[0].craftList);
    assert.deepEqual(
      imported.state.profiles[0].goals.map((g) => g.source),
      portable.profiles[0].goals.map((g) => g.source),
    );
    assert.equal(imported.state.settings.savePath, source);
    assert.equal(imported.state.settings.autoBackup, false);
    const retained = fs.readdirSync(data).find((n) => n.startsWith('journal-before-import-'));
    assert.ok(retained);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(data, retained))).profiles[0].notes,
      portable.profiles[0].notes,
    );
    assert.equal(sha(fs.readFileSync(path.join(source, '1.sav'))), sha(original));
    report.checks.push('BOM import, cancellation, retained journal and local settings');

    const beforeInvalid = fs.readFileSync(path.join(data, 'journal.json'));
    fs.writeFileSync(incomingFile, JSON.stringify({ schema: 999, profiles: [] }));
    await decisions({ open: { canceled: false, filePaths: [incomingFile] }, response: 1 });
    assert.equal((await invoke('importJournal')).ok, false);
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), beforeInvalid);
    assert.equal(
      await app.evaluate(() => globalThis.testDialogCalls.some((c) => c.kind === 'confirm')),
      false,
    );
    report.checks.push('invalid import fails before confirmation or mutation');

    assert.equal((await invoke('saveDetails', '../1.sav')).ok, false);
    assert.equal((await invoke('mutate', { type: 'save-slot', value: '999.sav' })).ok, false);
    assert.equal((await invoke('recipePlan', 'fusion-1002', 0)).ok, false);
    assert.equal((await invoke('openSource', 'https://example.invalid')).ok, false);
    assert.equal((await invoke('openFolder', 'C:\\')).ok, false);
    assert.equal((await invoke('launchGame')).ok, false);
    assert.equal((await invoke('useDetectedSaves', source)).ok, false);
    assert.equal(await win.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await win.evaluate(() => typeof window.process), 'undefined');
    report.checks.push('narrow IPC rejects arbitrary paths, sources and test game launch');

    const backup = await ok('backup', 'IPC 恢复测试');
    const newer = syntheticSave({ full: true, seconds: 20000, inventory: [{ id: 10226, count: 10 }] });
    fs.writeFileSync(path.join(source, '1.sav'), newer);
    fs.writeFileSync(path.join(source, '2.sav'), 'unrelated new slot');
    if (gameStopped()) {
      await decisions({ response: 0 });
      assert.equal((await ok('restore', backup.id)).cancelled, true);
      assert.equal(sha(fs.readFileSync(path.join(source, '1.sav'))), sha(newer));
      await decisions({ response: 1 });
      const restored = await ok('restore', backup.id);
      assert.equal(restored.restored, 1);
      assert.equal(sha(fs.readFileSync(path.join(source, '1.sav'))), sha(original));
      assert.equal(fs.readFileSync(path.join(source, '2.sav'), 'utf8'), 'unrelated new slot');
      const service = new Saves(path.join(data, 'save-backups'));
      assert.equal(sha(service.verify(restored.safetyId).buffers.get('1.sav')), sha(newer));
      assert.equal(service.pendingRestore(), null);
      const prompt = await app.evaluate(() => globalThis.testDialogCalls.find((c) => c.kind === 'confirm'));
      assert.equal(prompt.defaultId, 0);
      assert.equal(prompt.cancelId, 0);
      assert.ok(prompt.detail.includes('安全副本'));
      report.checks.push('restore cancellation, safety snapshot, exact replacement and retained extra slot');
    } else {
      assert.equal((await invoke('restore', backup.id)).ok, false);
      report.checks.push(
        'restore refused because the game is running; synthetic restore covered in core tests',
      );
    }

    // A supported journal with multiple full goal lists must survive export/import.
    const large = structuredClone(portable);
    large.profiles = Array.from({ length: 3 }, (_, i) => ({
      ...structuredClone(portable.profiles[0]),
      id: `capacity-${i}`,
      goals: Array.from({ length: 300 }, (_, j) => ({
        id: `goal-${j}`,
        title: `备料 ${j}`,
        detail: '材'.repeat(2000),
        done: false,
        source: { type: 'database', id: 'fusion-1002', quantity: 3 },
      })),
    }));
    large.activeProfileId = large.profiles[0].id;
    fs.writeFileSync(incomingFile, JSON.stringify(large, null, 2));
    assert.ok(fs.statSync(incomingFile).size > 5 * 1024 * 1024);
    await decisions({ open: { canceled: false, filePaths: [incomingFile] }, response: 1 });
    assert.equal((await ok('importJournal')).state.profiles.length, 3);
    await decisions({ save: { canceled: false, filePath: exported } });
    await ok('exportJournal');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(exported)).profiles,
      large.profiles.map((p) => ({ ...p, saveSlot: '' })),
    );
    await decisions({ open: { canceled: false, filePaths: [exported] }, response: 1 });
    assert.equal((await ok('importJournal')).state.profiles[0].goals.length, 300);
    report.checks.push('5 MB+ multi-profile journal round-trips through real export/import IPC');

    await win.locator('.nav-btn[data-id="goals"]').click();
    assert.equal(await win.locator('.goal-row').count(), 300);
    await win.locator('.goal-row').last().locator('[data-action="goal-source"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await win.locator('[data-action="close-overlay"]').click();
    assert.equal(await win.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    report.checks.push('full 300-goal page stays usable and opens the last recipe reference');

    assert.deepEqual(report.errors, []);
    report.passed = true;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(base, 'test-results', 'integration-report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('Electron IPC integration PASS:', report.checks.length, 'flows, isolated at', data);
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
