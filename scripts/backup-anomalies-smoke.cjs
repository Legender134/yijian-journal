'use strict';
// Windows source Electron, real product IPC/core and only invented save bytes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const complete = require('../src/core/complete-migration.cjs');
const migration = require('../src/core/migration.cjs');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..');
const evidenceRoot =
  process.env.YIJIAN_ANOMALY_EVIDENCE || path.resolve(base, '..', 'implementation-bad-backup');
const run = path.join(evidenceRoot, 'ui-' + Date.now() + '-' + crypto.randomUUID());
const dataRoot = path.join(run, 'userdata'),
  source = path.join(run, 'synthetic-SaveGames');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(path.join(run, 'temp'), { recursive: true });
fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, seconds: 47 }));
const store = new Store(dataRoot, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false, companionEnabled: false } });
const saves = new Saves(path.join(dataRoot, 'save-backups'));
const broken = saves.capture(source, '坏清单中不可信的名称');
const healthy = saves.capture(source, '完好副本仍可选择');
const brokenDirectory = path.join(saves.root, broken.id),
  manifestFile = path.join(brokenDirectory, 'manifest.json');
const goodPackage = path.join(run, 'good-original.yijian-protection');
const failedPackage = path.join(run, 'must-not-publish.yijian-protection');
const ioEvidence = {};
const errors = [],
  checks = [],
  expectedFailures = [];
let app, page, executablePath;
const executionMode = process.env.YIJIAN_EXECUTABLE ? 'packaged-exe' : 'source-electron';
function nativeElectron() {
  if (process.env.YIJIAN_EXECUTABLE) {
    const executable = path.resolve(process.env.YIJIAN_EXECUTABLE);
    assert.ok(fs.existsSync(executable), 'requested packaged executable must exist');
    return executable;
  }
  for (let directory = base; ; directory = path.dirname(directory)) {
    const executable = path.join(directory, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (fs.existsSync(executable)) return executable;
    if (path.dirname(directory) === directory) throw Error('Windows Electron runtime unavailable');
  }
}
async function launch({ activeDataRoot = dataRoot, output = failedPackage } = {}) {
  const env = {
    ...process.env,
    YIJIAN_TEST_DATA: activeDataRoot,
    YIJIAN_TEST_HIDDEN: '1',
    TEMP: path.join(run, 'temp'),
    TMP: path.join(run, 'temp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  executablePath = nativeElectron();
  app = await _electron.launch({
    executablePath,
    args: executionMode === 'packaged-exe' ? [] : [base],
    cwd: base,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.layout');
  await app.evaluate(
    ({ dialog, shell }, options) => {
      globalThis.__backupAnomalyOpened = [];
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: options.failedPackage });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [options.goodPackage] });
      dialog.showMessageBox = async () => ({ response: 1 });
      shell.openPath = async (directory) => {
        globalThis.__backupAnomalyOpened.push(directory);
        return '';
      };
    },
    { failedPackage: output, goodPackage },
  );
  await page.locator('.nav-btn[data-id="saves"]').click();
}
async function environment() {
  const response = await page.evaluate(() => window.journal.bootstrap());
  assert.equal(response.ok, true, response.error);
  return response.data.environment;
}
function assertOriginals() {
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), '{');
  assert.deepEqual(
    fs.readFileSync(path.join(brokenDirectory, 'files', '1.sav')),
    fs.readFileSync(path.join(source, '1.sav')),
  );
}
(async () => {
  let failure;
  try {
    await complete.exportComplete({
      dataRoot,
      archives: new ProtectionArchives(dataRoot, () => source),
      file: goodPackage,
      recordResult: true,
    });
    fs.writeFileSync(manifestFile, '{');
    await launch();
    const abnormal = page.locator('[data-abnormal-backup="' + broken.id + '"]');
    await abnormal.waitFor();
    assert.ok((await abnormal.innerText()).includes(broken.id));
    assert.ok((await abnormal.innerText()).includes(brokenDirectory));
    assert.equal(await abnormal.locator('input[type="checkbox"]').count(), 0);
    assert.deepEqual(
      await abnormal
        .locator('[data-action]')
        .evaluateAll((items) => items.map((item) => item.dataset.action)),
      ['backup-folder'],
    );
    const env = await environment();
    assert.equal(env.backups.length, 1);
    assert.equal(env.backups[0].id, healthy.id);
    assert.equal(env.backupAnomalies.length, 1);
    checks.push('坏清单目录可见但没有恢复、清理、单份导出或选择入口');
    await abnormal.locator('[data-action="backup-folder"]').click();
    assert.deepEqual(await app.evaluate(() => globalThis.__backupAnomalyOpened), [brokenDirectory]);
    checks.push('打开目录只传严格合法ID解析出的确切目录');
    for (const method of ['restore', 'exportSelectedBackups', 'cleanupBackups']) {
      const response = await page.evaluate(
        async ({ method, id }) => window.journal[method](method === 'restore' ? id : [id]),
        { method, id: broken.id },
      );
      assert.equal(response.ok, false, method + ' must fail');
      expectedFailures.push({ method, error: response.error, code: response.code });
    }
    assertOriginals();
    await page.locator('[data-action="protection-export"]').click();
    await page.locator('[aria-label="最近一次完整导出"]').waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('完整备份目录'));
    await page.locator('.nav-btn[data-id="saves"]').click();
    const afterFailure = await environment();
    assert.equal(afterFailure.protectionExportResult.status, 'failed');
    assert.equal(afterFailure.protectionExportResult.backupId, broken.id);
    assert.equal(fs.existsSync(failedPackage), false);
    assert.equal(fs.existsSync(failedPackage + '.parts'), false);
    assertOriginals();
    await page.screenshot({ path: path.join(run, '01-bad-backup-export-failure.png'), fullPage: true });
    checks.push('全量导出安全中止，持久结果包含确切ID和中文原因');
    await app.close();
    app = undefined;
    await launch();
    await page.locator('[data-abnormal-backup="' + broken.id + '"]').waitFor();
    const restarted = await environment();
    assert.equal(restarted.protectionExportResult.status, 'failed');
    assert.equal(restarted.protectionExportResult.backupId, broken.id);
    assert.ok((await page.locator('body').innerText()).includes('完整备份目录'));
    await page.screenshot({ path: path.join(run, '02-restarted-persistent-failure.png'), fullPage: true });
    await page
      .locator('.backup-anomalies')
      .screenshot({ path: path.join(run, '03-abnormal-directory-row.png') });
    checks.push('重启仍可见异常目录与本次导出失败，旧成功未成为最近结果');
    const imported = await page.evaluate(() => window.journal.importProtection());
    assert.equal(imported.ok, true, imported.error);
    assertOriginals();
    checks.push('真实IPC重新导入完好原保护包，坏原目录字节保持不变');
    await app.close();
    app = undefined;
    const truncatedPackage = path.join(run, 'truncated-original.yijian-protection');
    fs.writeFileSync(truncatedPackage, fs.readFileSync(goodPackage).subarray(0, -17));
    await launch();
    const journalBeforeBadImport = fs.readFileSync(path.join(dataRoot, 'journal.json'));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, truncatedPackage);
    await page.locator('[data-action="protection-import"]').click();
    await page.getByRole('heading', { name: '导入未完成' }).waitFor();
    await page.getByRole('heading', { name: '已保存的离线档案 · 1 份', exact: true }).waitFor();
    await page.locator('[data-action="protection-history"]').waitFor();
    assert.ok((await page.locator('.content').innerText()).includes('保护包没有复制完整或已损坏'));
    assert.equal((await page.locator('.content').innerText()).includes('正在读取档案列表'), false);
    assert.deepEqual(fs.readFileSync(path.join(dataRoot, 'journal.json')), journalBeforeBadImport);
    assertOriginals();
    await page.screenshot({
      path: path.join(run, '06-cold-bad-import-keeps-archive-list.png'),
      fullPage: true,
    });
    checks.push('冷启动拒绝坏保护包后自动加载已有档案，错误说明保留且手札和存档字节不变');
    await app.close();
    app = undefined;
    // A second, healthy synthetic machine isolates IO recovery from the bad
    // original directory. Only this Electron process's real fs module is stubbed.
    const ioRoot = path.join(run, 'result-io-fixture'),
      ioData = path.join(ioRoot, 'userdata'),
      ioSource = path.join(ioRoot, 'synthetic-SaveGames');
    fs.mkdirSync(ioSource, { recursive: true });
    fs.writeFileSync(path.join(ioSource, '1.sav'), syntheticSave({ full: true, seconds: 53 }));
    const ioStore = new Store(ioData, catalog);
    ioStore.setPath('savePath', ioSource);
    ioStore.mutate({ type: 'settings', value: { autoBackup: false, companionEnabled: false } });
    const ioSaves = new Saves(path.join(ioData, 'save-backups'));
    const ioBackup = ioSaves.capture(ioSource, '结果写入故障的合成完好副本');
    const previousOutput = path.join(ioRoot, 'old-success.yijian-protection'),
      blockedOutput = path.join(ioRoot, 'must-not-publish-on-record-io.yijian-protection'),
      recoveredOutput = path.join(ioRoot, 'after-record-io-recovery.yijian-protection'),
      ioRecord = path.join(ioData, 'protection-export-result.json');
    await complete.exportComplete({
      dataRoot: ioData,
      archives: new ProtectionArchives(ioData, () => ioSource),
      file: previousOutput,
      recordResult: true,
    });
    await launch({ activeDataRoot: ioData, output: blockedOutput });
    assert.equal((await environment()).protectionExportResult.status, 'success');
    await app.evaluate((_electron, record) => {
      const nativeFs = process.getBuiltinModule('fs');
      globalThis.__anomalyOriginalRename = nativeFs.renameSync;
      nativeFs.renameSync = (from, to) => {
        if (to === record && String(from).startsWith(to + '.'))
          throw Object.assign(Error('synthetic protection-export result EIO'), { code: 'EIO' });
        return globalThis.__anomalyOriginalRename(from, to);
      };
    }, ioRecord);
    await page.locator('[data-action="protection-export"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('本次结果未能写入磁盘'));
    const failedIO = await environment();
    // The disk/bootstrap still has its old success. The active renderer must
    // prioritize its real IPC failure over that result without claiming persistence.
    assert.equal(failedIO.protectionExportResult.status, 'success');
    assert.equal(
      await page.locator('[aria-label="最近一次完整导出"] h2').innerText(),
      '最近一次完整导出未确认完成',
    );
    assert.ok(
      (await page.locator('[aria-label="最近一次完整导出"]').innerText()).includes(
        '之前成功导出的记录不代表这次操作完成',
      ),
    );
    assert.equal(JSON.parse(fs.readFileSync(ioRecord, 'utf8')).status, 'success');
    assert.equal(fs.existsSync(blockedOutput), false);
    assert.equal(fs.existsSync(blockedOutput + '.parts'), false);
    await page.screenshot({
      path: path.join(run, '04-result-io-failure-masks-old-success.png'),
      fullPage: true,
    });
    checks.push('真实结果记录EIO中止导出，页面遮住旧成功并明确本次未记录');
    ioEvidence.failure = {
      published: false,
      recordNotSaved: true,
      renderedMessage: await page.locator('[aria-label="最近一次完整导出"]').innerText(),
      previousDiskResult: failedIO.protectionExportResult,
    };
    await app.evaluate(({ dialog }, output) => {
      process.getBuiltinModule('fs').renameSync = globalThis.__anomalyOriginalRename;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    }, recoveredOutput);
    await page.locator('[data-action="protection-export"]').click();
    await page.waitForFunction((output) => {
      const section = document.querySelector('[aria-label="最近一次完整导出"]');
      return (
        section?.querySelector('h2')?.textContent === '最近一次完整导出已完成' &&
        section.textContent.includes(output)
      );
    }, recoveredOutput);
    const recoveredIO = await environment();
    assert.equal(recoveredIO.protectionExportResult.status, 'success');
    assert.equal(recoveredIO.protectionExportResult.file, recoveredOutput);
    const verifiedOutput = await migration.previewProtection({ file: recoveredOutput });
    assert.equal(verifiedOutput.backups[0].id, ioBackup.id);
    assert.deepEqual(
      ioSaves.verify(ioBackup.id).buffers.get('1.sav'),
      fs.readFileSync(path.join(ioSource, '1.sav')),
    );
    await page.screenshot({
      path: path.join(run, '05-record-io-recovered-export-success.png'),
      fullPage: true,
    });
    ioEvidence.success = recoveredIO.protectionExportResult;
    ioEvidence.output = {
      file: recoveredOutput,
      packageHash: verifiedOutput.packageHash,
      backupId: ioBackup.id,
    };
    checks.push('解除结果写入EIO后真实UI导出成功，独立完整校验产物通过');
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = { message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(
      path.join(run, 'result.json'),
      JSON.stringify(
        {
          ok: !failure,
          executionMode,
          executablePath,
          checks,
          errors,
          expectedFailures,
          failure,
          dataRoot,
          brokenId: broken.id,
          brokenDirectory,
          goodPackage,
          failedPackage,
          exportResult: complete.readProtectionExportResult(dataRoot),
          ioEvidence,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: !failure, checks, failure, result: path.join(run, 'result.json') }));
  }
})();
