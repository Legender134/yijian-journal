'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  _electron,
} = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { Timeline } = require('../src/core/timeline.cjs'),
  { sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs'),
  catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..'),
  data = fs.mkdtempSync(path.join(base, '.test-data', 'timeline-upgrade-'));
const source = path.join(data, '76561190000000000', 'SaveGames');
fs.mkdirSync(source, { recursive: true });
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: true } });
const timeline = new Timeline(path.join(data, 'game-timeline'));
timeline.configure(source, false, 10);
const now = Date.now();
let first;
for (let i = 0; i < 25; i++) {
  const r = timeline.record(
    syntheticSave({
      full: true,
      seconds: 100 + i,
      money: 10 + i,
      team: [0],
      inventory: [{ id: 1003, count: 1 }],
      quests: [{ id: 5200, step: 1 }],
    }),
    'manual',
    now - 10000000 + i * 1000,
  );
  timeline.updateNode(r.id, {
    label: i === 0 ? '最早节点' : '节点 ' + i,
    note: i === 0 ? '剧情选择前' : '备注',
  });
  if (i === 0) first = r;
}
const protection = timeline.record(syntheticSave({ full: true, seconds: 500 }), 'before-load', now - 20000);
const latest = syntheticSave({
  full: true,
  seconds: 600,
  money: 90,
  team: [0, 10047],
  inventory: [{ id: 1003, count: 4 }],
  quests: [{ id: 5200, step: 4 }],
});
fs.writeFileSync(path.join(source, '29.sav'), latest);
timeline.record(latest, 'auto', now);
timeline.configure(source, true, 10);
const before = sha(latest),
  report = { checks: [], errors: [], externalRequests: [] };
let app, child;
(async () => {
  try {
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env: { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_TRAY: '1' },
    });
    child = app.process();
    const win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    win.on('request', (r) => {
      if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
    });
    await win.locator('.layout').waitFor();
    assert.ok((await win.locator('.save-health').first().innerText()).includes('等待游戏连接'));
    await win.locator('.nav-btn[data-id="saves"]').click();
    assert.equal(await win.locator('[data-action="timeline-target"]').count(), 11);
    assert.ok(
      (await win.locator('.target-picker .unavailable').count()) >= 9,
      'old bookmarks cannot impersonate recent targets',
    );
    assert.equal(await win.locator('.history-row').count(), 20);
    await win.locator('.history-pagination [data-action="timeline-page"]').last().click();
    assert.equal(await win.locator('.history-row').count(), 7);
    await win.locator('#timeline-search').fill('最早节点');
    assert.equal(await win.locator('.history-row').count(), 1);
    await win.locator('.history-row [data-action="timeline-preview"]').click();
    assert.ok((await win.locator('.timeline-differences').innerText()).includes('-80'));
    assert.ok((await win.locator('.timeline-differences').innerText()).includes('已完成 → 进行中'));
    await win.locator('.timeline-differences').scrollIntoViewIfNeeded();
    assert.equal(
      await win.locator('.timeline-differences .quality-text').evaluate((e) => getComputedStyle(e).color),
      'rgb(255, 255, 255)',
      'comparison item names preserve actual game quality colors',
    );
    await win.screenshot({ path: path.join(base, 'test-results', 'timeline-upgrade-differences.png') });
    await win.locator('#timeline-label').fill('<测试节点>');
    await win.locator('#timeline-note').fill('新的备注');
    await win.locator('[data-action="timeline-edit-save"]').first().click();
    await win.locator('.drawer h1').filter({ hasText: '<测试节点>' }).waitFor();
    assert.equal(await win.locator('.drawer h1').innerText(), '<测试节点>');
    await win.locator('[data-action="timeline-bookmark"]').click();
    await win.locator('[data-action="timeline-bookmark"]').filter({ hasText: '收藏此节点' }).waitFor();
    await win.locator('[data-action="timeline-bookmark"]').click();
    await win.locator('[data-action="timeline-bookmark"]').filter({ hasText: '取消收藏' }).waitFor();
    await win.screenshot({ path: path.join(base, 'test-results', 'timeline-upgrade-preview.png') });
    await win.locator('[data-action="close-overlay"]').first().click();
    await win.locator('#timeline-search').fill('新的备注');
    assert.equal(await win.locator('.history-row').count(), 1);
    await win.locator('#timeline-filter').selectOption('bookmarks');
    assert.equal(await win.locator('.history-row').count(), 1);
    await win.locator('.timeline-return:not(.latest-reliable) [data-action="timeline-preview"]').click();
    assert.equal(await win.locator('[data-action="timeline-load"]').getAttribute('data-id'), protection.id);
    await win.locator('[data-action="close-overlay"]').first().click();
    report.checks.push(
      '27 retained nodes, paging past 12, search, rename escaping, bookmark toggle, saved-progress differences, pre-load return',
    );
    await win.locator('.nav-btn[data-id="settings"]').click();
    assert.ok((await win.locator('.content').innerText()).includes('已暂停 · 时间线正在接管'));
    await win.locator('#shortcut-save').fill('Ctrl+Alt+J');
    await win.locator('[data-action="shortcuts-save"]').click();
    await win.locator('.toast').filter({ hasText: '已用于随行小窗' }).waitFor();
    await win.locator('#shortcut-save').fill('Ctrl+Alt+Shift+Q');
    await win.locator('#shortcut-history').fill('');
    await win.locator('[data-action="shortcuts-save"]').click();
    await win.locator('.toast').filter({ hasText: '快捷键设置已保存' }).waitFor();
    const settings = JSON.parse(fs.readFileSync(path.join(data, 'journal.json'))).settings;
    assert.deepEqual(settings.shortcuts, { save: 'Control+Alt+Shift+Q', history: '' });
    await win.locator('.nav-btn[data-id="home"]').click();
    await win.locator('#note').fill('托盘退出前的笔记');
    await win.locator('[data-action="window-close"]').click();
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
    assert.equal((await win.evaluate(() => window.journal.health())).data.background, true);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.show();
      w.webContents.send('journal:action', { action: 'history' });
    });
    await win.locator('.timeline-history').waitFor();
    for (const size of [
      [980, 660],
      [1340, 880],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
        size,
      );
      assert.equal(
        await win.evaluate(
          () =>
            document.querySelector('.content').scrollWidth >
            document.querySelector('.content').clientWidth + 1,
        ),
        false,
      );
      await win.screenshot({ path: path.join(base, 'test-results', 'timeline-upgrade-' + size[0] + '.png') });
    }
    assert.equal(sha(fs.readFileSync(path.join(source, '29.sav'))), before);
    assert.equal(new Timeline(timeline.root).inspect(first.id).record.note, '新的备注');
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-action="window-quit"]').click();
    await new Promise((resolve, reject) => {
      const p = child;
      if (p.exitCode !== null) return resolve();
      const timeout = setTimeout(() => reject(Error('Normal quit timed out')), 10000);
      p.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(data, 'journal.json'))).profiles[0].notes,
      '托盘退出前的笔记',
    );
    assert.equal(new Timeline(timeline.root).data.enabled, true);
    report.checks.push(
      'tray close stays alive; history action reopens; valid shortcuts persist; normal quit flushes notes and preserves enabled state; no native mutations',
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
    console.log('Timeline upgrade UI PASS');
  } catch (e) {
    report.passed = false;
    report.failure = e.stack;
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(base, 'test-results', 'timeline-upgrade-ui.json'),
      JSON.stringify(report, null, 2),
    );
    if (app && child?.exitCode === null) await app.close();
  }
})();
