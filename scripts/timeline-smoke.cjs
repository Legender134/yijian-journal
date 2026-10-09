'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  _electron,
} = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { Timeline } = require('../src/core/timeline.cjs'),
  { Saves, sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs'),
  catalog = require('../src/data/catalog.cjs');
const index = require('../src/data/game-index.json');
const base = path.resolve(__dirname, '..'),
  data = fs.mkdtempSync(path.join(base, '.test-data', 'timeline-ui-'));
const source = path.join(data, '76561190000000000', 'SaveGames');
fs.mkdirSync(source, { recursive: true });
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: true } });
const now = Date.now(),
  timeline = new Timeline(path.join(data, 'game-timeline'));
timeline.configure(source, false, 10);
for (const [i, age] of [3700, 1805, 605, 305, 125, 65, 55, 45, 35, 25, 15, 0].entries()) {
  const bytes = syntheticSave({ full: true, seconds: 1000 + i, inventory: [{ id: 1003, count: 2 }] });
  fs.writeFileSync(path.join(source, '29.sav'), bytes);
  timeline.record(bytes, i === 0 ? 'manual' : 'auto', now - age * 1000);
}
timeline.configure(source, true, 10);
const before = sha(fs.readFileSync(path.join(source, '29.sav'))),
  report = { checks: [], colors: [], errors: [], externalRequests: [] };
const expected = {
  白: 'rgb(255, 255, 255)',
  绿: 'rgb(133, 228, 106)',
  蓝: 'rgb(109, 166, 216)',
  金: 'rgb(255, 237, 0)',
  暗金: 'rgb(220, 154, 0)',
  红: 'rgb(239, 90, 90)',
};
let app;
(async () => {
  try {
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env: { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1', YIJIAN_TEST_AUTO_FAST: '1' },
    });
    const win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    win.on('request', (r) => {
      if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
    });
    await win.locator('.layout').waitFor();
    await win.locator('.nav-btn[data-id="saves"]').click();
    assert.equal(await win.locator('[data-action="timeline-target"]').count(), 11);
    assert.equal(await win.locator('.timeline-node').count(), 1);
    assert.equal(await win.locator('.timeline-node [data-action="timeline-preview"]').count(), 1);
    for (const size of [
      [980, 660],
      [1340, 880],
      [1600, 1000],
    ]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size);
      const overflow = await win.evaluate(() => {
        const e = document.querySelector('.content');
        return e.scrollWidth > e.clientWidth + 1;
      });
      assert.equal(overflow, false);
      await win.screenshot({ path: path.join(base, 'test-results', `timeline-${size[0]}.png`) });
    }
    await win.locator('.timeline-node [data-action="timeline-preview"]').last().click();
    assert.ok((await win.locator('.drawer').innerText()).includes('副本校验通过'));
    assert.equal(await win.locator('[data-action="timeline-load"]').isDisabled(), true);
    const blockedLoad = await win.evaluate(
      (id) => window.journal.timelineLoad(id),
      await win.locator('[data-action="timeline-load"]').getAttribute('data-id'),
    );
    assert.match(blockedLoad.error, /测试环境不执行游戏读档/);
    await win.screenshot({ path: path.join(base, 'test-results', 'timeline-preview.png') });
    await win.locator('[data-action="close-overlay"]').first().click();
    const released = await win.evaluate(() => window.journal.timelineRelease());
    assert.equal(released.ok, true);
    assert.equal(released.data.released, false, 'closing the drawer already released its lease');
    const blocks = await win.evaluate(async () => {
      const api = window.journal;
      return await Promise.all([
        api.timelineSave(),
        api.timelineConfigure({ enabled: true, interval: 10 }),
        api.bridgeInstall(),
        api.bridgeDisable(),
        api.timelineLoad('../x'),
      ]);
    });
    assert.ok(blocks.every((r) => !r.ok && r.error.includes('测试环境')));
    report.checks.push('11 real nodes, preview, 3 sizes, native actions blocked under isolation');
    await win.locator('.nav-btn[data-id="database"]').click();
    for (const [quality, color] of Object.entries(expected)) {
      const e = index.entries.find((e) => e.kind === '物品' && e.quality === quality);
      await win.locator('#list-search').fill(e.name);
      const card = win.locator(`.database-card[data-id="${e.id}"]`);
      await card.waitFor();
      assert.equal(await card.locator('h3 .quality-text').evaluate((e) => getComputedStyle(e).color), color);
      assert.equal(
        await card.locator('.game-picture').evaluate((e) => getComputedStyle(e).borderTopColor),
        color,
      );
      await card.click();
      assert.equal(
        await win.locator('.drawer h1 .quality-text').evaluate((e) => getComputedStyle(e).color),
        color,
      );
      report.colors.push({ quality, color, name: e.name });
      await win.locator('[data-action="close-overlay"]').first().click();
    }
    await win.locator('#list-search').fill('白光剑');
    await win.screenshot({ path: path.join(base, 'test-results', 'quality-colored-items.png') });
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('卫霍');
    assert.equal(await win.locator('.database-card h3 .quality-text').count(), 0);
    assert.equal(sha(fs.readFileSync(path.join(source, '29.sav'))), before);
    const backups = new Saves(path.join(data, 'save-backups'));
    assert.equal(backups.list().length, 1, 'native waiting retains one full automatic copy');
    assert.equal(sha(backups.verify(backups.list()[0].id).buffers.get('29.sav')), before);
    const health = (await win.evaluate(() => window.journal.health())).data;
    assert.equal(health.timeline.enabled, true);
    assert.equal(health.timeline.connected, false);
    assert.equal(health.backupStatus, 'watching');
    report.checks.push(
      'preview lease releases on close; disconnected native timeline retains a verified full backup without changing slot 29',
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
    console.log(
      'Timeline/quality UI acceptance PASS:',
      report.colors.length,
      'colors, 11 nodes, native isolation',
    );
  } catch (e) {
    report.passed = false;
    report.failure = e.message;
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(base, 'test-results', 'timeline-ui-report.json'),
      JSON.stringify(report, null, 2),
    );
    if (app) await app.close();
  }
})();
