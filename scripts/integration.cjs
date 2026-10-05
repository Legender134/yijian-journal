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
const { syntheticSave } = require('../tests/fixtures.cjs');
const { gameStopped } = require('../src/core/environment.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(base, '.test-data', 'ipc-'));
const source = path.join(data, 'synthetic-SaveGames');
fs.mkdirSync(source);
const original = syntheticSave({ full: true, inventory: [{ id: 10226, count: 4 }] });
fs.writeFileSync(path.join(source, '1.sav'), original);
const store = new Store(data, catalog);
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
(async () => {
  try {
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
        return globalThis.testDialogSettings.open || { canceled: true };
      };
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.testDialogCalls.push({ kind: 'confirm', ...options });
        return { response: globalThis.testDialogSettings.response ?? 0 };
      };
    }, data);

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
