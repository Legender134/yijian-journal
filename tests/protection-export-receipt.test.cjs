'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const complete = require('../src/core/complete-migration.cjs');
const migration = require('../src/core/migration.cjs');
const { recordProtectionExportResult, protectionExportReceipt } = require('../src/core/backup-anomalies.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('./fixtures.cjs');
function machine() {
  const parent = process.env.YIJIAN_ANOMALY_TEST_ROOT || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'yijian-export-receipt-'));
  const dataRoot = path.join(root, 'userdata'),
    source = path.join(root, 'synthetic-SaveGames');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, seconds: 43 }));
  const store = new Store(dataRoot, catalog),
    saves = new Saves(path.join(dataRoot, 'save-backups'));
  const backup = saves.capture(source, '长期保护 0001');
  return {
    root,
    dataRoot,
    source,
    store,
    saves,
    backup,
    archives: new ProtectionArchives(dataRoot, () => source),
  };
}
const diskResult = (m) =>
  JSON.parse(fs.readFileSync(path.join(m.dataRoot, 'protection-export-result.json'), 'utf8'));
function failRecording(m, status) {
  const original = fs.renameSync,
    target = path.join(m.dataRoot, 'protection-export-result.json');
  let count = 0;
  fs.renameSync = function (from, to) {
    if (
      to === target &&
      String(from).startsWith(to + '.') &&
      JSON.parse(fs.readFileSync(from, 'utf8')).status === status
    ) {
      count++;
      throw Object.assign(Error('synthetic receipt persistence EIO'), { code: 'EIO' });
    }
    return original.call(this, from, to);
  };
  return () => {
    fs.renameSync = original;
    assert.equal(count, 1);
  };
}
test('failed export returns the exact durable receipt and a later success returns its own receipt', async () => {
  const m = machine(),
    payload = path.join(m.saves.root, m.backup.id, 'files/1.sav');
  const original = fs.readFileSync(payload),
    source = fs.readFileSync(path.join(m.source, '1.sav'));
  fs.appendFileSync(payload, 'synthetic damage');
  const damaged = fs.readFileSync(payload),
    output = path.join(m.root, 'failed.yijian-protection');
  await assert.rejects(complete.exportComplete({ ...m, file: output, recordResult: true }), (error) => {
    assert.equal(error.exportResult.status, 'failed');
    assert.equal(error.exportResult.recordNotSaved, undefined);
    assert.equal(error.exportResult.file, output);
    assert.ok(error.exportResult.message.includes('长期保护 0001'));
    assert.ok(error.exportResult.message.includes('1.sav'));
    assert.ok(error.exportResult.message.includes(m.backup.id));
    assert.deepEqual(JSON.parse(JSON.stringify(error.exportResult)), diskResult(m));
    return true;
  });
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(payload), damaged);
  assert.deepEqual(fs.readFileSync(path.join(m.source, '1.sav')), source);
  fs.writeFileSync(payload, original);
  const success = await complete.exportComplete({
    ...m,
    file: path.join(m.root, 'success.yijian-protection'),
    recordResult: true,
  });
  assert.deepEqual(success.exportResult, diskResult(m));
  assert.equal(success.exportResult.status, 'success');
  assert.equal(success.exportResult.file, success.file);
  assert.equal((await migration.previewProtection({ file: success.file })).backups[0].id, m.backup.id);
});
test('real EIO distinguishes initial recording, failure recording, and recording after publication', async () => {
  for (const status of ['running', 'failed', 'success']) {
    const m = machine(),
      output = path.join(m.root, status + '.yijian-protection');
    recordProtectionExportResult(m.dataRoot, { status: 'success', file: 'old-success', message: '旧成功' });
    if (status === 'failed') fs.writeFileSync(path.join(m.saves.root, m.backup.id, 'manifest.json'), '{');
    const restore = failRecording(m, status);
    try {
      await assert.rejects(complete.exportComplete({ ...m, file: output, recordResult: true }), (error) => {
        const receipt = error.exportResult;
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.recordNotSaved, true);
        assert.equal(receipt.file, output);
        assert.ok(receipt.message.includes(status === 'failed' ? m.backup.id : '记录'));
        assert.equal(receipt.published === true, status === 'success');
        if (status === 'failed') {
          assert.equal(error.recordCode, 'EXPORT_RESULT_WRITE_FAILED');
          assert.ok(receipt.recordError.includes('EIO'));
        }
        return true;
      });
    } finally {
      restore();
    }
    assert.equal(fs.existsSync(output), status === 'success');
    assert.equal(diskResult(m).status, status === 'running' ? 'success' : 'running');
    if (status === 'success')
      assert.equal((await migration.previewProtection({ file: output })).backups[0].id, m.backup.id);
  }
});

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function rendererHarness() {
  const requests = [],
    operations = [];
  const context = {
    api: {
      exportProtection: () => new Promise((resolve) => operations.push(resolve)),
      refresh: () => new Promise((resolve) => requests.push((data) => resolve({ ok: true, data }))),
    },
    protectionView: { omittedArchives: [{ id: 'retained-warning' }] },
    environment: { saves: { files: [] }, protectionExportResult: { status: 'success', message: '旧成功' } },
    refreshRequest: 0,
    recipeDiscoveryRequest: 0,
    recipeDiscoveryTimer: undefined,
    recipeDiscoveryNeedsRefresh: false,
    recipeDiscoveryView: { result: null, busy: false },
    clearTimeout,
    protectionExportRequest: 0,
    route: 'saves',
    captureJournalDraft() {},
    flushJournalDrafts: async () => {},
    captureIntentDrafts() {},
    flushIntentDrafts: async () => {},
    drafts: new Map([['synthetic-note-profile', 'pending note']]),
    saveNote: async () => {},
    render() {},
    toast() {},
    journeyDraft: null,
    worldView: {},
    materialView: {},
    referenceSaveName: undefined,
    referenceFollow: false,
    currentDrawer: null,
    document: { querySelector: () => null },
    Date,
  };
  vm.createContext(context);
  vm.runInContext(
    section(renderer, 'async function call(', '\nfunction toast(') +
      '\n' +
      section(
        renderer,
        'function recipeDiscoverySourceSignature(',
        '\nasync function refreshRecipeDiscovery(',
      ) +
      '\n' +
      section(renderer, 'async function refresh() {', '\nasync function handle(') +
      '\n' +
      'async function runExport() { switch ("protection-export") {' +
      section(renderer, "case 'protection-export': {", "    case 'protection-import-volumes':") +
      '\n} }',
    context,
  );
  return { context, requests, operations };
}
const failureReceipt = () => ({
  schema: 1,
  at: Date.now(),
  status: 'failed',
  file: '本次目标',
  message: '长期保护 0001 · 1.sav 校验失败；原件保留，可靠副本分批导出。',
});
test('superseding refresh cannot turn a durable failure into an unrecorded generic failure', async () => {
  const { context, requests, operations } = rendererHarness(),
    receipt = failureReceipt();
  const operation = context.runExport();
  await tick();
  operations[0]({ ok: false, error: receipt.message, exportResult: receipt });
  await tick();
  assert.equal(requests.length, 1);
  const concurrent = context.refresh();
  requests[0]({ saves: { files: [] }, protectionExportResult: receipt });
  await operation;
  assert.equal(context.environment.protectionExportResult.status, 'success');
  assert.equal(context.protectionView.exportResultOverride.message, receipt.message);
  assert.equal(context.protectionView.exportResultOverride.file, receipt.file);
  assert.equal(context.protectionView.exportResultOverride.recordNotSaved, undefined);
  assert.equal(context.route, 'saves', 'failure preserves the current backup list page');
  requests[1]({ saves: { files: [] }, protectionExportResult: { status: 'running' } });
  await concurrent;
  assert.equal(context.protectionView.exportResultOverride.message, receipt.message);
  assert.equal(context.protectionView.omittedArchives[0].id, 'retained-warning');
});
test('cancel preserves an unrecorded warning, later success owns its receipt, and older responses cannot replace it', async () => {
  const { context, requests, operations } = rendererHarness();
  const warning = { ...failureReceipt(), recordNotSaved: true };
  context.protectionView.exportResultOverride = warning;
  const cancel = context.runExport();
  await tick();
  operations[0]({ ok: true, data: { cancelled: true } });
  await cancel;
  assert.equal(context.protectionView.exportResultOverride, warning);
  assert.equal(context.protectionView.omittedArchives[0].id, 'retained-warning');
  const old = context.runExport();
  await tick();
  const duplicate = context.runExport();
  await duplicate;
  assert.equal(operations.length, 2, 'rendered-again button cannot submit a duplicate while running');
  operations[1]({ ok: false, error: warning.message, exportResult: warning });
  await tick();
  const latest = context.runExport();
  await tick();
  const receipt = { schema: 1, at: Date.now(), status: 'success', file: '最新目标', message: '最新成功' };
  const omittedArchives = [{ id: 'new-warning' }];
  operations[2]({
    ok: true,
    data: { exportResult: receipt, omittedArchives, backups: [], nodes: 0, volumes: 1 },
  });
  await tick();
  requests[1]({ saves: { files: [] }, protectionExportResult: warning });
  await latest;
  requests[0]({ saves: { files: [] }, protectionExportResult: warning });
  await old;
  assert.equal(context.protectionView.exportResultOverride, receipt);
  assert.equal(context.protectionView.omittedArchives[0].id, 'new-warning');
});
test('existing export IPC emits only bounded receipt fields', async () => {
  let handler;
  const receipt = { ...failureReceipt(), ignored: 'must not cross IPC' };
  const context = {
    ipcMain: {
      handle: (_name, fn) => {
        handler = fn;
      },
    },
    protectionJobPromise: null,
    validUrl: () => true,
    protectionExportReceipt,
    error: Object.assign(Error('wrapped publication error'), { code: 'EPERM', exportResult: receipt }),
  };
  vm.createContext(context);
  vm.runInContext(
    section(main, 'function handle(name, fn) {', '\nfunction checkedBackup(') +
      '\nhandle("protection-export", () => { throw error; });',
    context,
  );
  const senderFrame = { url: 'synthetic://renderer' },
    event = { senderFrame, sender: { mainFrame: senderFrame } };
  const response = await handler(event);
  assert.equal(response.exportResult.message, receipt.message);
  assert.equal(response.exportResult.ignored, undefined);
  assert.equal(response.exportResult.recordNotSaved, undefined);
  context.error.exportResult = { ...receipt, message: 'x'.repeat(4001) };
  assert.equal((await handler(event)).exportResult, undefined);
  assert.equal(protectionExportReceipt({ ...receipt, recordNotSaved: 'true' }), null);
  assert.equal(
    protectionExportReceipt({ ...receipt, omittedArchives: [{ id: '../outside', label: '', reason: '' }] }),
    null,
  );
});
test('publication compatibility wrapping preserves the durable failure receipt', async () => {
  let exportHandler;
  const receipt = failureReceipt();
  const context = {
    handle: (name, handler) => {
      assert.equal(name, 'protection-export');
      exportHandler = handler;
    },
    protectionJob: (_label, work) => work(),
    pendingBackupCare: () => [],
    saves: {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: 'synthetic-target' }) },
    owner() {},
    path,
    isTest: true,
    app: { getPath: () => 'synthetic-userdata' },
    Date,
    protectionArchives: { assertSeparated() {} },
    protectionExportReceipt,
    exportComplete: async () => {
      throw Object.assign(Error('synthetic ENOTSUP'), { code: 'ENOTSUP', exportResult: receipt });
    },
  };
  vm.createContext(context);
  vm.runInContext(section(main, "    handle('protection-export',", "    handle('backup-lock',"), context);
  await assert.rejects(exportHandler({}), (error) => {
    assert.ok(error.message.includes('NTFS'));
    assert.equal(error.exportResult, receipt);
    assert.equal(error.exportResult.recordNotSaved, undefined);
    return true;
  });
});
