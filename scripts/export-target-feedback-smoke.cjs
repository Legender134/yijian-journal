'use strict';
// Exercise real product IPC and UI with synthetic saves and exact owned dialog paths.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs'),
  { Saves } = require('../src/core/saves.cjs'),
  { ProtectionArchives } = require('../src/core/protection-archives.cjs');
const complete = require('../src/core/complete-migration.cjs'),
  migration = require('../src/core/migration.cjs'),
  catalog = require('../src/data/catalog.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..'),
  evidence = path.resolve(
    process.env.YIJIAN_EXPORT_FEEDBACK_EVIDENCE || path.join(base, '.test-data/export-target-feedback'),
  );
fs.mkdirSync(evidence, { recursive: true });
const run = fs.mkdtempSync(path.join(evidence, 'ui-')),
  temp = path.join(run, 'temp'),
  executablePath = path.resolve(process.env.YIJIAN_EXECUTABLE || require('electron')),
  mode = process.env.YIJIAN_EXECUTABLE ? 'packaged' : 'source';
fs.mkdirSync(temp);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checks = [],
  scenarios = [],
  errors = [];
let app, page, failure;
function machine(label) {
  const directory = path.join(run, label),
    dataRoot = path.join(directory, 'userdata'),
    source = path.join(directory, 'synthetic-SaveGames');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, seconds: 53 }));
  const store = new Store(dataRoot, catalog),
    saves = new Saves(path.join(dataRoot, 'save-backups'));
  store.setPath('savePath', source);
  store.mutate({ type: 'note', value: label + '合成手札' });
  store.mutate({ type: 'settings', value: { autoBackup: false, companionEnabled: false } });
  saves.capture(source, label + '合成保护');
  return { directory, dataRoot, source, archives: new ProtectionArchives(dataRoot, () => source) };
}
async function quit() {
  if (!app) return;
  if (page && !page.isClosed())
    await Promise.all([page.waitForEvent('close'), page.evaluate(() => window.journal.window('quit'))]);
  await app.close();
  app = null;
  page = null;
}
async function clickExport(file) {
  const previous = await app.evaluate((_electron, output) => {
    if (!globalThis.__exportTargetAllowed.includes(output)) throw Error('Unowned export target');
    globalThis.__exportTargetOutput = output;
    return globalThis.__exportTargetResponses.length;
  }, file);
  await page.locator('[data-action="protection-export"]').click();
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await app.evaluate(
      (_electron, count) => globalThis.__exportTargetResponses[count],
      previous,
    );
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Real export IPC did not settle');
}
async function expectReceipt(receipt) {
  await page.waitForFunction(({ message, file }) => {
    const card = document.querySelector('[aria-label="最近一次完整导出"]');
    return card?.innerText.includes(message) && card.innerText.includes(file);
  }, receipt);
  return page.locator('[aria-label="最近一次完整导出"]');
}
(async () => {
  try {
    for (const history of [false, true]) {
      const label = history ? 'collection' : 'single',
        m = machine(label),
        file = path.join(m.directory, 'existing.yijian-protection'),
        renamed = path.join(m.directory, 'new-name.yijian-protection');
      if (history) {
        const old = machine('imported-history'),
          historyFile = path.join(old.directory, 'history.yijian-protection');
        await migration.exportProtection({ ...old, file: historyFile });
        await m.archives.import(historyFile);
      }
      await complete.exportComplete({ ...m, file, recordResult: true });
      const originalHash = hash(file),
        sourceHash = hash(path.join(m.source, '1.sav')),
        resultFile = path.join(m.dataRoot, 'protection-export-result.json'),
        env = {
          ...process.env,
          YIJIAN_TEST_DATA: m.dataRoot,
          YIJIAN_TEST_HIDDEN: '1',
          TEMP: temp,
          TMP: temp,
        };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({
        executablePath,
        args: mode === 'source' ? [base] : [],
        cwd: base,
        env,
        timeout: 30000,
      });
      for (const [stream, suffix] of [
        [app.process().stdout, 'stdout'],
        [app.process().stderr, 'stderr'],
      ])
        stream?.on('data', (bytes) =>
          fs.appendFileSync(path.join(run, label + '-electron-' + suffix + '.log'), bytes),
        );
      page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(label + ': ' + error.message));
      await page.locator('.layout').waitFor();
      await page.locator('.nav-btn[data-id="saves"]').click();
      await app.evaluate(
        ({ dialog, ipcMain }, options) => {
          if (process.env.YIJIAN_TEST_DATA !== options.dataRoot || process.env.TEMP !== options.temp)
            throw Error('Expected isolated test data and TEMP');
          globalThis.__exportTargetAllowed = Object.freeze(options.allowed);
          globalThis.__exportTargetResponses = [];
          dialog.showSaveDialog = async () => {
            const filePath = globalThis.__exportTargetOutput;
            if (!globalThis.__exportTargetAllowed.includes(filePath))
              throw Error('Unowned save-dialog target');
            return { canceled: false, filePath };
          };
          const original = ipcMain._invokeHandlers.get('journal:protection-export');
          if (typeof original !== 'function') throw Error('Product export IPC unavailable');
          ipcMain.removeHandler('journal:protection-export');
          ipcMain.handle('journal:protection-export', async (...args) => {
            const response = await original(...args);
            globalThis.__exportTargetResponses.push(response);
            return response;
          });
        },
        { dataRoot: m.dataRoot, temp, allowed: [file, renamed] },
      );
      const failed = await clickExport(file);
      assert.equal(failed.ok, false);
      assert.equal(failed.code, 'PROTECTION_EXPORT_TARGET_EXISTS');
      assert.match(failed.error, /目标已存在.*另选新文件名.*原文件已保留/);
      assert.deepEqual(failed.exportResult, JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      let card = await expectReceipt(failed.exportResult);
      const visible = await card.innerText();
      assert.match(visible, /另选新文件名.*原文件已保留/);
      assert.ok(visible.includes('目标已有文件已保留，未被覆盖'));
      assert.doesNotMatch(visible, /异常副本或磁盘状态|完好的来源恢复|Protection file already exists|EEXIST/);
      assert.equal(await card.locator('details').evaluate((node) => node.open), false);
      assert.equal(hash(file), originalHash);
      assert.equal(hash(path.join(m.source, '1.sav')), sourceHash);
      const screenshots = {};
      screenshots.failure = path.join(run, label + '-01-existing-target.png');
      await page.evaluate(() =>
        document.querySelector('[aria-label="最近一次完整导出"]')?.scrollIntoView({ block: 'center' }),
      );
      await page.screenshot({ path: screenshots.failure, fullPage: true });
      await card.locator('details > summary').click();
      assert.match(
        await card.locator('details').innerText(),
        /PROTECTION_EXPORT_TARGET_EXISTS[\s\S]*(already exists|EEXIST)/,
      );
      screenshots.diagnostic = path.join(run, label + '-02-expanded-diagnostic.png');
      await page.screenshot({ path: screenshots.diagnostic, fullPage: true });
      await card.locator('details > summary').click();
      const succeeded = await clickExport(renamed);
      assert.equal(succeeded.ok, true, succeeded.error);
      assert.equal(succeeded.data.exportResult.status, 'success');
      card = await expectReceipt(succeeded.data.exportResult);
      assert.ok((await card.innerText()).includes('最近一次完整导出已完成'));
      assert.deepEqual(succeeded.data.exportResult, JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      const preview = await complete.previewComplete({ archives: m.archives, file: renamed });
      assert.equal(preview.historicalArchives, history ? 1 : 0);
      assert.equal(hash(file), originalHash);
      assert.equal(hash(path.join(m.source, '1.sav')), sourceHash);
      screenshots.success = path.join(run, label + '-03-new-name-success.png');
      await page.evaluate(() =>
        document.querySelector('[aria-label="最近一次完整导出"]')?.scrollIntoView({ block: 'center' }),
      );
      await page.screenshot({ path: screenshots.success, fullPage: true });
      scenarios.push({
        label,
        dataRoot: m.dataRoot,
        resultFile,
        existingFile: file,
        renamed,
        originalHash,
        afterHash: hash(file),
        sourceHash,
        failure: failed,
        success: succeeded,
        screenshots,
      });
      checks.push(
        label +
          ': real IPC rejects overwrite, gives Chinese filename advice with collapsed raw diagnostic, preserves both SHA-256 values, then succeeds with a new name',
      );
      await quit();
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = error;
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(run, 'unexpected-failure.png'), fullPage: true })
        .catch(() => {});
  } finally {
    try {
      await quit();
    } catch (error) {
      if (!failure) failure = error;
    }
    const result = {
      mode,
      base,
      executablePath,
      executableSha256: hash(executablePath),
      run,
      temp,
      checks,
      scenarios,
      errors,
      passed: !failure,
      failure: failure?.stack || null,
    };
    fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify(
        {
          passed: result.passed,
          mode,
          checks: checks.length,
          report: path.join(run, 'report.json'),
          failure: result.failure,
        },
        null,
        2,
      ),
    );
    if (failure) process.exitCode = 1;
  }
})();
