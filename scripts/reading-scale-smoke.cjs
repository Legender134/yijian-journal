'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'reading-scale-' + Date.now());
const userdata = path.join(out, 'userdata'),
  temp = path.join(out, 'temp');
for (const dir of [userdata, temp, path.join(temp, 'node-cache'), path.join(base, 'test-results')])
  fs.mkdirSync(dir, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
process.env.NODE_COMPILE_CACHE = path.join(temp, 'node-cache');
const { _electron } = require('playwright');
const report = {
  startedAt: new Date().toISOString(),
  executable: process.env.YIJIAN_EXECUTABLE || 'source Electron',
  checks: [],
  errors: [],
  syntheticOnly: true,
};
let app, page, compact;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userdata };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.context().setOffline(true);
  await page.locator('.layout').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const w = await app.browserWindow(page);
  await w.evaluate((win) => {
    win.setBounds({ width: 980, height: 660 });
    win.showInactive();
  });
  report.processes ||= [];
  report.processes.push(await app.evaluate(() => ({ executable: process.execPath, pid: process.pid })));
}
async function settings() {
  await page.locator('.sidebar-nav [data-action="navigate"][data-id="settings"]').click();
  await page.locator('#reading-scale').waitFor();
}
async function scale(expected) {
  await page.waitForFunction(
    (value) => document.querySelector('#reading-scale')?.value === String(value),
    expected,
  );
  await page.waitForFunction((value) => window.innerWidth < 1000 / (value / 100) + 2, expected);
  const w = await app.browserWindow(page);
  assert(Math.abs((await w.evaluate((win) => win.webContents.getZoomFactor())) - expected / 100) < 0.001);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(userdata, 'journal.json'))).settings.readingScale || 100,
    expected,
  );
}
async function fits(win, selector) {
  const node = win.locator(selector).first();
  await node.scrollIntoViewIfNeeded();
  const result = await node.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: visualViewport.width,
      height: visualViewport.height,
    };
  });
  assert(
    result.left >= -0.5 &&
      result.right <= result.width + 0.5 &&
      result.top >= -0.5 &&
      result.bottom <= result.height + 0.5,
    JSON.stringify(result),
  );
}
async function noHorizontal(win) {
  const geometry = await win.evaluate(() => {
    const n = document.querySelector('.content, .compact-body');
    const edge = n.getBoundingClientRect().right;
    return {
      width: n.clientWidth,
      scroll: n.scrollWidth,
      left: n.scrollLeft,
      overflow: [...n.querySelectorAll('*')]
        .map((e) => ({
          tag: e.tagName,
          id: e.id,
          cls: e.className,
          parent: e.parentElement.className,
          text: e.textContent.slice(0, 90),
          right: e.getBoundingClientRect().right,
          width: e.getBoundingClientRect().width,
        }))
        .filter((e) => e.right > edge + 1)
        .slice(0, 25),
    };
  });
  assert(geometry.scroll <= geometry.width + 1 && geometry.left <= 1, JSON.stringify(geometry));
}
async function capture(win, name) {
  const w = await app.browserWindow(win),
    file = path.join(out, name);
  const png = await w.evaluate(async (window) =>
    (await window.webContents.capturePage()).toPNG().toString('base64'),
  );
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  report.geometry ||= [];
  report.geometry.push({
    name,
    geometry: await win.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      body: document.body.getBoundingClientRect().toJSON(),
      scroll: document.body.scrollWidth,
      content: document.querySelector('.content, .compact-body')?.getBoundingClientRect().toJSON(),
      modal: document.querySelector('.modal')?.getBoundingClientRect().toJSON(),
    })),
  });
}
(async () => {
  try {
    await launch();
    await settings();
    await scale(100);
    report.checks.push('fresh offline first launch uses default 100% and discovers reading size in settings');
    for (const size of [110, 125, 150]) {
      await page.locator('#reading-scale').selectOption(String(size));
      await scale(size);
      await fits(page, '#reading-scale');
      await fits(page, '[data-action="reading-scale-reset"]');
      await noHorizontal(page);
    }
    await capture(page, 'main-150.png');
    report.checks.push(
      'each supported size changes actual zoom, persists atomically and keeps settings controls reachable at 980x660',
    );
    await page.locator('[data-action="reading-scale-reset"]').click();
    await scale(100);
    await page.keyboard.press('Control+=');
    await scale(110);
    await page.keyboard.press('Control+Shift+Equal');
    await scale(125);
    await page.keyboard.press('Control+-');
    await scale(110);
    await page.keyboard.press('Control+0');
    await scale(100);
    report.checks.push('equals, shifted plus, minus and reset keyboard shortcuts update saved scale');
    await page.mouse.move(600, 350);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await scale(110);
    await page.mouse.wheel(0, 120);
    await scale(110);
    report.checks.push('Ctrl+wheel enlarges while ordinary scrolling leaves the preference unchanged');
    await page.locator('#reading-scale').selectOption('150');
    await scale(150);
    await page.keyboard.press('Control+=');
    await scale(150);
    const opened = app.waitForEvent('window');
    await page.locator('[data-action="compact"]').first().click();
    compact = await opened;
    compact.on('pageerror', (e) => report.errors.push(e.message));
    await compact.locator('.compact-body').waitFor();
    await compact.emulateMedia({ reducedMotion: 'reduce' });
    const cw = await app.browserWindow(compact);
    assert(Math.abs((await cw.evaluate((win) => win.webContents.getZoomFactor())) - 1.5) < 0.001);
    const bounds = await cw.evaluate((win) => win.getBounds());
    assert(bounds.width >= 650 && bounds.height >= 600, JSON.stringify(bounds));
    await fits(compact, '[data-action="search"]');
    await compact.keyboard.press('Control+k');
    await compact.locator('#global-search').fill('白芷');
    await compact.locator('[data-action="database-detail"]').first().waitFor();
    await fits(compact, '#global-search');
    await capture(compact, 'compact-search-150.png');
    await compact.keyboard.press('Escape');
    await compact.keyboard.press('Control+0');
    await scale(100);
    assert(Math.abs((await cw.evaluate((win) => win.webContents.getZoomFactor())) - 1) < 0.001);
    report.checks.push(
      'small window inherits scale, enlarges within display, searches offline and resets both windows',
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.getTitle().includes('随行'))
        .show(),
    );
    await page.locator('.sidebar-nav [data-id="goals"]').click();
    await page.locator('[data-action="goal-add"]').first().click();
    await page.locator('#goal-title').fill('放大时保留未完成目标');
    await page.locator('#goal-detail').fill('阅读缩放不得关闭编辑器或覆盖文字。');
    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await page.waitForFunction(() => innerWidth < 700);
    assert.equal(await page.locator('#goal-title').inputValue(), '放大时保留未完成目标');
    await fits(page, '[data-action="goal-save"]');
    await capture(page, 'editor-150.png');
    await page.keyboard.press('Escape');
    await settings();
    await scale(150);
    report.checks.push(
      'scaling in an open intent editor preserves exact text and reachable confirmation controls',
    );
    for (const route of [
      'home',
      'checklist',
      'library',
      'database',
      'world',
      'materials',
      'goals',
      'saves',
      'journey',
      'journal',
    ]) {
      await page.locator(`.sidebar-nav [data-action="navigate"][data-id="${route}"]`).click();
      await page.waitForFunction(
        (id) => document.querySelector('.sidebar-nav [aria-current="page"]')?.dataset.id === id,
        route,
      );
      await noHorizontal(page);
    }
    await settings();
    report.checks.push('every main navigation page remains free of horizontal content clipping at 150%');
    await app.close();
    app = null;
    await launch();
    await settings();
    await scale(150);
    await page.locator('[data-action="intent-drafts"]').first().click();
    await page.locator('[data-action="intent-draft-resume"]').first().click();
    assert.equal(await page.locator('#goal-title').inputValue(), '放大时保留未完成目标');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await settings();
    await page.locator('[data-action="reading-scale-reset"]').click();
    await scale(100);
    assert.deepEqual(report.errors, []);
    report.checks.push(
      'cold restart retains reading size and unfinished writing; explicit reset restores default',
    );
    report.passed = true;
    console.log('Reading size PASS', report.checks.length, 'checks', out);
  } catch (error) {
    report.failure = String(error.stack || error);
    throw error;
  } finally {
    if (app) await app.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results/reading-scale-result.json'),
      JSON.stringify({ ...report, evidence: out }, null, 2),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
