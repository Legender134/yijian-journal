'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  _electron,
} = require('playwright');
const base = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(base, '.test-data', 'viewport-'));
const report = { startedAt: new Date().toISOString(), layouts: [], errors: [] };
let app;
(async () => {
  try {
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env: { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1' },
    });
    const win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    await win.locator('.layout').waitFor();
    for (const size of [
      [980, 660],
      [1340, 853],
      [1340, 880],
    ]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size);
      for (const page of [
        'home',
        'checklist',
        'library',
        'database',
        'world',
        'materials',
        'goals',
        'saves',
        'settings',
      ]) {
        await win.locator(`.nav-btn[data-id="${page}"]`).click();
        const layout = await win.evaluate(() => {
          const box = (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, height: r.height };
          };
          const content = document.querySelector('.content');
          return {
            viewport: innerHeight,
            sidebar: box('.sidebar'),
            profile: box('.profile-box'),
            content: box('.content'),
            scrollHeight: content.scrollHeight,
            clientHeight: content.clientHeight,
            scrollWidth: content.scrollWidth,
            clientWidth: content.clientWidth,
          };
        });
        report.layouts.push({ page, size, ...layout });
      }
    }
    const failures = report.layouts.filter(
      (x) =>
        x.sidebar.bottom > x.viewport + 1 ||
        x.profile.bottom > x.viewport + 1 ||
        x.content.bottom > x.viewport + 1 ||
        x.scrollWidth > x.clientWidth + 1,
    );
    report.failures = failures;
    assert.deepEqual(failures, [], 'Navigation or content extends below the visible viewport');
    await win.locator('.content').hover();
    await win.mouse.wheel(0, 1200);
    await win.waitForFunction(() => document.querySelector('.content').scrollTop > 100, { timeout: 5000 });
    await win.locator('.profile-box [data-action="profiles"]').click();
    await win.locator('#profile-select').waitFor();
    await win.keyboard.press('Escape');
    report.wheelScrollAndProfileEntry = true;
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('Viewport acceptance PASS:', report.layouts.length, 'page/size combinations');
  } catch (e) {
    report.passed = false;
    report.failure = e.message;
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(base, 'test-results', 'viewport-audit.json'), JSON.stringify(report, null, 2));
    if (app) await app.close();
  }
})();
