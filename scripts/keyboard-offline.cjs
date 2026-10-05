'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  _electron: electron,
} = require('playwright');
const base = path.resolve(__dirname, '..'),
  data = fs.mkdtempSync(path.join(base, '.test-data', 'keyboard-'));
const report = { startedAt: new Date().toISOString(), checks: [], externalRequests: [], errors: [] };
let app;
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env: { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1' },
    });
    const win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    win.on('request', (r) => {
      if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
    });
    await win.context().setOffline(true);
    await win.reload();
    await win.locator('.layout').waitFor();
    for (const page of ['checklist', 'library', 'database', 'goals', 'saves', 'settings', 'home'])
      await win.locator(`.nav-btn[data-id="${page}"]`).click();
    await win.locator('.search-trigger').focus();
    await win.keyboard.press('Enter');
    await win.locator('#global-search').fill('清灵丹');
    const count = await win.locator('.search-result').count();
    assert.ok(count > 0);
    for (let i = 0; i < count + 4; i++) {
      await win.keyboard.press('Tab');
      assert.equal(await win.evaluate(() => !!document.activeElement.closest('#overlay')), true);
    }
    for (let i = 0; i < count + 4; i++) {
      await win.keyboard.press('Shift+Tab');
      assert.equal(await win.evaluate(() => !!document.activeElement.closest('#overlay')), true);
    }
    await win.keyboard.press('Escape');
    assert.equal(await win.locator('.search-trigger').evaluate((e) => e === document.activeElement), true);
    assert.equal(await win.locator('#app').evaluate((e) => e.inert), false);
    report.checks.push('search focus stays inside modal in both directions and returns to opener');
    await win.keyboard.press('Control+k');
    await win.locator('#global-search').fill('水煮鱼');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await win.locator('.drawer').waitFor();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('水煮鱼'));
    await win.keyboard.press('Escape');
    await win.locator('[data-action="goal-add"]').first().click();
    await win.locator('#goal-title').fill('键盘创建的备忘');
    await win.keyboard.press('Enter');
    await win.locator('.goal-row').filter({ hasText: '键盘创建的备忘' }).waitFor();
    report.checks.push('offline catalog, keyboard result activation and Enter-to-save goal');
    await win.locator('[data-action="profiles"]').first().click();
    await win.locator('#profile-name').fill('输入中测试');
    await win.locator('#profile-name').dispatchEvent('compositionstart');
    await win.keyboard.press('Control+k');
    assert.equal(await win.locator('#global-search').count(), 0);
    await win.locator('#profile-name').dispatchEvent('compositionend');
    await win.keyboard.press('Escape');
    report.checks.push('IME composition does not trigger search shortcut');
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-action="help"]').click();
    assert.ok((await win.locator('.help-copy').innerText()).includes('32 MB'));
    await win.keyboard.press('Escape');
    assert.deepEqual(report.externalRequests, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    report.finishedAt = new Date().toISOString();
    console.log('Keyboard/offline acceptance PASS:', report.checks.length, 'flows; no external requests');
  } catch (e) {
    report.passed = false;
    report.failure = e.message;
    throw e;
  } finally {
    fs.writeFileSync(
      path.join(base, 'test-results', 'keyboard-offline-report.json'),
      JSON.stringify(report, null, 2),
    );
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
