'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'playwright',
);
const base = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(base, '.test-data'), { recursive: true });
const data = fs.mkdtempSync(path.join(base, '.test-data', 'lifecycle-'));
const file = path.join(data, 'journal.json');
const report = { data, checks: [], errors: [] };
let app;
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    let main = await app.firstWindow();
    main.on('dialog', (d) => d.dismiss().catch(() => {}));
    main.on('pageerror', (e) => report.errors.push(e.message));
    await main.waitForSelector('.layout');
    const firstNote = '刚打完就打开小窗\n材料：精钢锭 × 9\n';
    await main.locator('#note').fill(firstNote);
    await main.locator('[data-action="compact"]').click();
    const companion = app.windows().find((w) => w !== main) || (await app.waitForEvent('window'));
    companion.on('pageerror', (e) => report.errors.push(e.message));
    await companion.waitForSelector('.compact-note');
    await companion.locator('.compact-note summary').click();
    assert.equal(await companion.locator('.compact-note p').innerText(), firstNote);
    assert.equal(JSON.parse(fs.readFileSync(file)).profiles[0].notes, firstNote);
    report.checks.push('opening companion flushes latest note and shows it');

    await main.locator('[data-action="goal-add"]').first().click();
    await main.locator('#goal-title').fill('制作长虹剑');
    await main.locator('#goal-detail').fill('精钢锭 ×9\n金锭 ×6');
    await main.locator('[data-action="goal-save"]').click();
    await companion.locator('.compact-goal summary').click();
    assert.ok((await companion.locator('.compact-goal p').innerText()).includes('金锭 ×6'));
    assert.equal(await companion.locator('.compact-note').evaluate((e) => e.open), true);
    report.checks.push('companion shows material details and preserves disclosure state on broadcast');

    // Closing the OS window bypasses the custom close button and must still flush drafts.
    const nativeCloseNote = '系统关闭前最后一句\n  不丢最后一个字。';
    await main.locator('#note').fill(nativeCloseNote);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('compact=1'))
        .close(),
    );
    if (!main.isClosed()) await main.waitForEvent('close');
    assert.equal(JSON.parse(fs.readFileSync(file)).profiles[0].notes, nativeCloseNote);
    await companion.locator('[data-action="main"]').click();
    main = app.windows().find((w) => w !== companion) || (await app.waitForEvent('window'));
    main.on('dialog', (d) => d.dismiss().catch(() => {}));
    main.on('pageerror', (e) => report.errors.push(e.message));
    await main.waitForSelector('#note');
    assert.equal(await main.locator('#note').inputValue(), nativeCloseNote);
    report.checks.push('native window close flushes pending draft and companion reopens main');

    // Simulate an actual commit failure inside the isolated Electron main process.
    await app.evaluate(async (_electron, journalFile) => {
      const nativeFs = process.getBuiltinModule('fs');
      globalThis.lifecycleOriginalRename = nativeFs.renameSync;
      nativeFs.renameSync = function (source, destination) {
        if (destination === journalFile) throw new Error('Synthetic storage write failure');
        return globalThis.lifecycleOriginalRename.call(this, source, destination);
      };
    }, file);
    const failingNote = '存储失败时仍留在编辑区的笔记';
    await main.locator('#note').fill(failingNote);
    await main.locator('[data-action="window-close"]').click();
    await main.locator('.toast.error').first().waitFor();
    assert.equal(main.isClosed(), false);
    assert.equal(await main.locator('#note').inputValue(), failingNote);
    assert.equal(JSON.parse(fs.readFileSync(file)).profiles[0].notes, nativeCloseNote);
    await app.evaluate(async () => {
      process.getBuiltinModule('fs').renameSync = globalThis.lifecycleOriginalRename;
      delete globalThis.lifecycleOriginalRename;
    });
    await main.locator('[data-action="window-close"]').click();
    if (!main.isClosed()) await main.waitForEvent('close');
    assert.equal(JSON.parse(fs.readFileSync(file)).profiles[0].notes, failingNote);
    report.checks.push('failed note commit keeps window and draft; retry closes with exact text');
    assert.deepEqual(report.errors, []);
    report.passed = true;
    fs.writeFileSync(
      path.join(base, 'test-results', 'lifecycle-report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('Window and draft lifecycle PASS:', report.checks.length, 'flows');
  } finally {
    if (app) {
      await app
        .evaluate(async () => {
          if (globalThis.lifecycleOriginalRename)
            process.getBuiltinModule('fs').renameSync = globalThis.lifecycleOriginalRename;
        })
        .catch(() => {});
      await app.close();
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
