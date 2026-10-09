'use strict';
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.join(__dirname, '..'),
  data = path.join(base, '.test-data', `smoke-${Date.now()}`),
  results = path.join(base, 'test-results');
fs.mkdirSync(results, { recursive: true });
fs.mkdirSync(data, { recursive: true });
const fakeSaves = path.join(data, 'fixture-SaveGames');
fs.mkdirSync(fakeSaves);
fs.writeFileSync(
  path.join(fakeSaves, '1.sav'),
  syntheticSave({
    full: true,
    inventory: [
      { id: 10226, count: 3 },
      { id: 10525, count: 2 },
      { id: 10529, count: 3 },
    ],
    quests: [
      { id: 5200, step: 1 },
      { id: 5201, step: 1 },
      { id: 11077, step: 1 },
      { id: 5176, step: 4, finished: 1781822869 },
    ],
  }),
);
fs.writeFileSync(path.join(fakeSaves, 'JHSaveConfig.sav'), 'fake config');
fs.writeFileSync(path.join(fakeSaves, '2.sav'), syntheticSave({ full: true, seconds: 7200 }));
fs.utimesSync(path.join(fakeSaves, '2.sav'), new Date('2025-01-01'), new Date('2025-01-01'));
new Store(data, catalog).setPath('savePath', fakeSaves);
const originalSave = fs.readFileSync(path.join(fakeSaves, '1.sav'));
const errors = [];
let app;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
    timeout: 30000,
  });
}
async function attach() {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.layout');
  return win;
}
(async () => {
  try {
    app = await launch();
    let win = await attach();
    assert.equal(await win.locator('.start-panel').count(), 1);
    assert.equal(await win.locator('.start-panel details').evaluate((el) => el.open), false);
    assert.equal(await win.locator('[data-persist-detail="home-stage"]').evaluate((el) => el.open), false);
    await win.locator('.start-panel summary').click();
    await win.locator('[data-action="refresh"]').click();
    assert.equal(await win.locator('.start-panel details').evaluate((el) => el.open), true);
    await win.locator('.start-panel summary').click();
    const firstUse = await win.evaluate(async () => (await window.journal.bootstrap()).data);
    assert.equal(firstUse.state.settings.autoBackup, true);
    assert.equal(firstUse.state.profiles[0].referenceMode, 'latest');
    assert.equal(firstUse.environment.timeline.enabled, false);
    const deniedStart = await win.evaluate(() => window.journal.startAssistance());
    assert.equal(deniedStart.ok, false);
    assert.match(deniedStart.error, /测试环境/);
    await win.waitForFunction(() =>
      document.querySelector('.home-protection')?.textContent.includes('1 份完整保护副本'),
    );
    const automatic = (await win.evaluate(async () => (await window.journal.refresh()).data.backups)).find(
      (b) => b.kind === 'auto',
    );
    assert.ok(automatic);
    await win.waitForFunction(() =>
      document.querySelector('.save-health')?.textContent.includes('完整备份守护中'),
    );
    assert.match(await win.locator('.save-health').first().getAttribute('title'), /游戏内自动存档尚未开启/);
    assert.deepEqual(fs.readFileSync(path.join(fakeSaves, '1.sav')), originalSave);
    assert.deepEqual(
      fs.readFileSync(path.join(data, 'save-backups', automatic.id, 'files', '1.sav')),
      originalSave,
    );
    await win.screenshot({ animations: 'disabled', path: path.join(results, '01-home.png') });
    await win.locator('[data-action="save-slot"]').click();
    await win.locator('#save-slot-select').selectOption('2.sav');
    await win.locator('[data-action="save-slot-save"]').click();
    assert.equal(await win.evaluate(async () => (await window.journal.refresh()).data.recent.name), '2.sav');
    assert.ok((await win.locator('.hero').innerText()).includes('2 时 0 分'));
    fs.renameSync(path.join(fakeSaves, '2.sav'), path.join(data, 'held-2.sav'));
    await win.locator('[data-action="refresh"]').click();
    assert.ok((await win.locator('.content').innerText()).includes('不会自动改用其他槽位'));
    assert.equal(await win.evaluate(async () => (await window.journal.refresh()).data.recent), null);
    fs.renameSync(path.join(data, 'held-2.sav'), path.join(fakeSaves, '2.sav'));
    await win.locator('[data-action="refresh"]').click();
    await win.locator('[data-action="save-slot"]').click();
    await win.locator('#save-slot-select').selectOption('@latest');
    await win.locator('[data-action="save-slot-save"]').click();
    await win.locator('[data-action="save-quest-jump"][data-id="5200"]').first().click();
    assert.equal(await win.locator('.save-recorded-quests').evaluate((e) => e.open), true);
    assert.equal(await win.locator('[data-quest-id="5200"] details').evaluate((e) => e.open), true);
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#note').fill('测试随手记：下次去青木舫。');
    await win.waitForTimeout(1000);
    await win.locator('[data-action="goal-add"]').first().click();
    await win.locator('#goal-title').fill('测试目标 <script>你好</script>');
    await win.locator('#goal-detail').fill('目标说明 & 特殊字符');
    await win.locator('[data-action="goal-save"]').click();
    await win.locator('.nav-btn[data-id="checklist"]').click();
    assert.equal(await win.locator('.entry-row').count(), catalog.entries.filter((e) => e.checklist).length);
    assert.equal(await win.locator('[data-action="filter"].active').getAttribute('data-id'), 'all');
    assert.equal(await win.locator('.stage-step.active').count(), 0);
    await win.locator('[data-action="filter"][data-id="current"]').click();
    await win.locator('#stage-select').waitFor();
    await win.keyboard.press('Escape');
    await win.locator('[data-action="check"]').first().click();
    await win.locator('.nav-btn[data-id="library"]').click();
    await win.locator('#list-search').fill('上官虹');
    await win.locator('.entry-card').first().click();
    assert.equal(await win.locator('.spoiler-box').count(), 1);
    await win.locator('[data-action="reveal"]').click();
    assert.ok((await win.locator('.steps li').count()) > 0);
    await win.locator('.drawer-actions [data-action="favorite"]').click();
    await win.waitForTimeout(250);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '02-detail.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('.nav-btn[data-id="goals"]').click();
    await win.locator('[data-action="entry-goal"]').first().click();
    await win.locator('.nav-btn[data-id="database"]').click();
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('清灵丹');
    await win.locator('[data-action="database-kind"][data-id="武学"]').click();
    assert.equal(await win.locator('.database-card').count(), 0);
    await win.locator('[data-action="database-reset"]').click();
    assert.equal(await win.locator('#list-search').inputValue(), '');
    assert.equal(await win.locator('#list-search').evaluate((e) => e === document.activeElement), true);
    assert.ok(await win.locator('.database-card').count());
    await win.locator('[data-action="database-kind"][data-id="物品"]').click();
    await win.locator('#list-search').fill('铁矿石');
    await win.locator('.database-card[data-id="item-10201"]').click();
    assert.ok((await win.locator('.drawer').innerText()).includes('梧桐村'));
    await win.locator('[data-action="database-goal"]').click();
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('下品清灵丹丹方');
    await win.locator('.database-card[data-id="item-100304"]').click();
    await win.locator('.item-teaches [data-id="alchemy-104"]').click();
    assert.ok((await win.locator('.recipe-learning').innerText()).includes('下品清灵丹丹方'));
    await win.locator('.recipe-learning [data-id="item-100304"]').click();
    await win.locator('.item-sellers summary').click();
    assert.ok((await win.locator('.item-sellers').innerText()).includes('元济'));
    await win.locator('.item-sellers [data-id="npc-5056"]').click();
    await win.locator('.shop-stock summary').click();
    await win.locator('.shop-stock [data-id="item-100304"]').click();
    assert.ok((await win.locator('.item-teaches').innerText()).includes('下品清灵丹'));
    await win.screenshot({ animations: 'disabled', path: path.join(results, '10-recipe-learning.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="database-kind"][data-id="配方"]').click();
    await win.locator('#list-search').fill('长虹剑精良图纸');
    await win.locator('.database-card').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('3,396'));
    await win.locator('#recipe-materials [data-id="item-10226"]').click();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('精钢锭'));
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.match(await win.locator('.reference-freshness').innerText(), /新存档同步/);
    await win.locator('[data-action="recipe-goal"]').click();
    await win.waitForTimeout(250);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '07-recipe.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('#list-search').fill('水煮鱼');
    await win.locator('.database-card[data-id="cooking-102"]').click();
    await win.locator('#recipe-quantity').fill('3');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('已有 5 · 还缺 1'));
    await win.locator('.ingredient-options summary').click();
    assert.ok((await win.locator('.ingredient-options').innerText()).includes('鲤鱼'));
    await win.locator('#recipe-save').selectOption('');
    assert.equal(await win.locator('#recipe-materials .material-owned').count(), 0);
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await win.locator('#recipe-save').selectOption('1.sav');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('已有 5 · 还缺 1'));
    const fishResult = (
      await win.evaluate(async () =>
        (await window.journal.bootstrap()).data.gameIndex.entries.find((e) => e.id === 'cooking-102'),
      )
    ).results[0];
    await win.locator(`.drawer [data-action="database-detail"][data-id="item-${fishResult.id}"]`).click();
    await win.locator('.item-produced [data-id="cooking-102"]').click();
    assert.equal(await win.locator('.recipe-learning').count(), 1);
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    await win.screenshot({ animations: 'disabled', path: path.join(results, '09-cooking.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('上官虹');
    await win.locator('.database-card').first().click();
    assert.ok((await win.locator('.drawer').innerText()).includes('茶具'));
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('.nav-btn[data-id="saves"]').click();
    assert.equal(await win.locator('[data-persist-detail="unused-timeline"]').evaluate((e) => e.open), false);
    await win.locator('[data-persist-detail="unused-timeline"] > summary').click();
    await win.locator('[data-action="refresh"]').click();
    assert.equal(await win.locator('[data-persist-detail="unused-timeline"]').evaluate((e) => e.open), true);
    await win.locator('[data-persist-detail="unused-timeline"] > summary').click();
    await win.locator('[data-action="backup"]').first().click();
    await win.locator('#backup-label').fill('测试备份');
    await win.locator('[data-action="backup-confirm"]').click();
    await win.waitForSelector('.backup-row');
    await win.locator('[data-action="verify"]').first().click();
    await win.screenshot({ animations: 'disabled', path: path.join(results, '03-saves.png') });
    await win.locator('[data-action="backup-preview"]').first().click();
    await win.locator('.comparison-grid').waitFor();
    assert.ok((await win.locator('.drawer').innerText()).includes('完全一致'));
    await win.locator('[data-action="backup-rename"]').click();
    await win.locator('#rename-backup').fill('改名后的测试副本');
    await win.locator('[data-action="backup-rename-save"]').click();
    assert.equal(await win.locator('.backup-row').filter({ hasText: '改名后的测试副本' }).count(), 1);
    await win.locator('[data-action="save-detail"]').first().click();
    await win.locator('.save-drawer').waitFor();
    assert.ok((await win.locator('.save-drawer').innerText()).includes('卫霍'));
    await win.locator('.save-quests summary').first().click();
    assert.ok((await win.locator('.save-drawer').innerText()).includes('武当求助'));
    await win.locator('.save-quests > summary').filter({ hasText: '这份存档的任务记录' }).click();
    await win.locator('[data-action="save-quest-goal"]').first().click();
    await win.locator('[data-action="save-quest-filter"][data-id="done"]').click();
    assert.ok((await win.locator('#save-quest-results').innerText()).includes('狂风寨救人'));
    await win.locator('.save-quests > summary').filter({ hasText: '物品记录' }).click();
    await win.locator('#save-inventory-search').fill('精钢');
    assert.ok((await win.locator('#save-inventory-results').innerText()).includes('× 3'));
    await win.waitForTimeout(250);
    await win.screenshot({ animations: 'disabled', path: path.join(results, '08-save-recap.png') });
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('.nav-btn[data-id="settings"]').click();
    await win.locator('[data-action="help"]').click();
    assert.ok((await win.locator('.help-copy').innerText()).includes('读取范围'));
    await win.locator('[data-action="close-overlay"]').click();
    await win.screenshot({ animations: 'disabled', path: path.join(results, '04-settings.png') });
    await win.locator('[data-action="compact"]').first().click();
    await win.waitForTimeout(500);
    const windows = app.windows();
    assert.equal(windows.length, 2);
    await windows[1].waitForSelector('.compact-shell');
    await windows[1].screenshot({ animations: 'disabled', path: path.join(results, '05-compact.png') });
    const quick = windows[1];
    quick.on('pageerror', (e) => errors.push(e.message));
    await quick.locator('[data-action="search"]').click();
    await quick.locator('#global-search').fill('司马铃');
    await quick.locator('.search-result').first().click();
    await quick.locator('.drawer').waitFor();
    assert.ok((await quick.locator('.drawer h1').innerText()).includes('司马铃'));
    await quick.screenshot({ animations: 'disabled', path: path.join(results, '05-compact-search.png') });
    await quick.keyboard.press('Escape');
    assert.equal(await quick.locator('.drawer').count(), 0);
    await quick.locator('.companion-tabs [data-action="navigate"][data-id="saves"]').click();
    await quick.locator('.timeline-card').first().waitFor();
    await quick.screenshot({ animations: 'disabled', path: path.join(results, '05-compact-history.png') });
    await quick.locator('[data-action="navigate"][data-id="home"]').click();
    const automaticTasks = await quick.evaluate(
      async () => (await window.journal.companionSnapshot()).data.quests,
    );
    assert.ok(automaticTasks.length);
    assert.equal(automaticTasks[0].id, 11077);
    assert.equal(
      await quick.locator('.compact-goal [data-action="save-quest-jump"]').first().getAttribute('data-id'),
      '11077',
    );
    await quick.locator('.compact-goal [data-action="save-quest-jump"]').first().click();
    await quick.locator('.save-recorded-quests').waitFor();
    await quick.locator('[data-action="close-overlay"]').click();
    // Renderer presentation under a synthetic passive-mode event; controller focus/input
    // and native identity boundaries are separately tested without any game access.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact=1'));
      w.setBounds({ ...w.getBounds(), width: 320, height: 112 });
      w.webContents.send('journal:companion', { mode: 'hint', visible: true });
    });
    await quick.locator('.hint-shell').waitFor();
    await quick.waitForFunction(() => innerWidth <= 321 && innerHeight <= 113);
    assert((await quick.locator('.hint-line').count()) <= 2);
    assert.equal(
      await quick.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    await quick.screenshot({ animations: 'disabled', path: path.join(results, '05-passive-hints.png') });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('compact=1'));
      w.setBounds({ ...w.getBounds(), width: 460, height: 660 });
      w.webContents.send('journal:companion', { mode: 'expanded', visible: true });
    });
    await quick.locator('.compact-shell').waitFor();
    await quick.waitForFunction(() => innerWidth >= 450 && innerHeight >= 640);
    await quick.locator('[data-action="companion-collapse"]').click();
    assert.equal(
      await quick.evaluate(async () => (await window.journal.companionSnapshot()).data.mode),
      'hint',
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('compact=1'))
          .isVisible(),
      ),
      false,
    );
    // The companion stays useful when the full window was closed first.
    await win.locator('[data-action="compact"]').first().click();
    await win.waitForTimeout(300);
    const companion = app.windows().find((w) => w !== win);
    await companion.waitForSelector('.compact-shell');
    await win.locator('[data-action="window-close"]').click();
    await companion.locator('[data-action="main"]').click();
    win = app.windows().find((w) => w !== companion);
    if (!win) win = await app.waitForEvent('window');
    await win.waitForSelector('.layout');
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('compact=1'))
          .isVisible(),
      ),
      false,
    );
    await win.locator('[data-action="profiles"]').first().click();
    await win.locator('#profile-name').fill('测试二周目');
    await win.locator('[data-action="profile-create"]').click();
    await win.locator('.nav-btn[data-id="home"]').click();
    assert.equal(await win.locator('#note').inputValue(), '');
    await win.locator('[data-action="profiles"]').first().click();
    await win.locator('#profile-select').selectOption({ label: '我的江湖' });
    await win.locator('[data-action="profile-switch"]').click();
    assert.equal(await win.locator('#note').inputValue(), '测试随手记：下次去青木舫。');
    await app.close();
    app = await launch();
    win = await attach();
    assert.equal(await win.locator('#note').inputValue(), '测试随手记：下次去青木舫。');
    await win.locator('.nav-btn[data-id="goals"]').click();
    assert.ok(
      (await win.locator('.goal-row').allInnerTexts()).some((s) => s.includes('<script>你好</script>')),
    );
    assert.ok((await win.locator('.goal-row').allInnerTexts()).some((s) => s.includes('精钢锭 ×9')));
    const recipeGoal = win.locator('.goal-row').filter({ hasText: '精钢锭 ×9' });
    const oldGoal = await recipeGoal.innerText();
    // A saved material note stays a snapshot; reopening uses current inventory.
    fs.writeFileSync(
      path.join(fakeSaves, '1.sav'),
      syntheticSave({ full: true, inventory: [{ id: 10226, count: 99 }] }),
    );
    const stableInventoryAt = new Date(Date.now() - 5000);
    fs.utimesSync(path.join(fakeSaves, '1.sav'), stableInventoryAt, stableInventoryAt);
    await recipeGoal.locator('[data-action="goal-source"]').click();
    assert.equal(await win.locator('#recipe-quantity').inputValue(), '3');
    assert.equal(await win.locator('#recipe-save').inputValue(), '@latest');
    assert.ok((await win.locator('#recipe-materials').innerText()).includes('已有 99'));
    await win.locator('[data-action="close-overlay"]').click();
    assert.equal(await recipeGoal.innerText(), oldGoal);
    await win
      .locator('.goal-row')
      .filter({ hasText: '寻找铁矿石' })
      .locator('[data-action="goal-source"]')
      .click();
    assert.equal(await win.locator('.drawer h1').innerText(), '铁矿石');
    await win.locator('[data-action="close-overlay"]').click();
    const guideGoal = win
      .locator('.goal-row')
      .filter({ hasText: '上官虹' })
      .filter({ has: win.locator('[data-action="goal-source"]') });
    await guideGoal.locator('[data-action="goal-source"]').click();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('上官虹'));
    await win.locator('[data-action="close-overlay"]').click();
    assert.equal(await win.locator('script:not([src])').count(), 0);
    await win.keyboard.press('Control+k');
    await win.locator('#global-search').fill('司马铃');
    assert.ok((await win.locator('.search-result').count()) > 0);
    await win.keyboard.press('ArrowDown');
    assert.equal(
      await win
        .locator('.search-result')
        .first()
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await win.keyboard.press('ArrowUp');
    assert.equal(await win.locator('#global-search').evaluate((e) => e === document.activeElement), true);
    await win.keyboard.press('Enter');
    await win.locator('.drawer').waitFor();
    assert.ok((await win.locator('.drawer h1').innerText()).includes('司马铃'));
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#global-search').inputValue(), '司马铃');
    assert.equal(
      await win
        .locator('.search-result')
        .first()
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await win.keyboard.press('Enter');
    await win.locator('.drawer').waitFor();
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+k');
    assert.equal(await win.locator('#global-search').inputValue(), '司马铃');
    await win.keyboard.press('Escape');
    // Compact-width and minimum-window layout checks.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await win.screenshot({ animations: 'disabled', path: path.join(results, '06-small-window.png') });
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await win.locator('.nav-btn[data-id="home"]').click();
    // Supply a supported-game display fixture; native IPC remains blocked by the isolated test mode.
    const launchDisplay = (await win.evaluate(() => window.journal.bootstrap())).data;
    launchDisplay.environment.game = { installed: true, build: launchDisplay.gameIndex.build };
    launchDisplay.environment.timeline.pathIssue =
      '存档目录包含原生组件不支持的路径格式，查询和完整自动备份可继续使用';
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.waitForSelector('.start-panel');
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'launch');
    assert.equal(await win.locator('.start-panel [data-action="start-assistance"]').count(), 0);
    await win.locator('.start-panel summary').click();
    assert.match(
      await win.locator('.start-panel details').innerText(),
      /不支持的路径格式.*查询和完整自动备份可继续使用/,
    );
    launchDisplay.environment.timeline.pathIssue = '';
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.waitForSelector('.start-panel');
    assert.equal(
      await win.locator('.start-panel .btn.primary').getAttribute('data-action'),
      'start-assistance',
    );
    launchDisplay.state = (
      await win.evaluate(() =>
        window.journal.mutate({
          type: 'settings',
          value: { offerAutoSaveOnStart: false },
        }),
      )
    ).data;
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.waitForSelector('.start-panel');
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'launch');
    assert.match(await win.locator('.start-panel').innerText(), /开始游戏会直接启动/);
    await win.locator('.start-panel summary').click();
    assert.equal(await win.locator('.start-panel details [data-action="start-assistance"]').count(), 1);
    // Exercise the one-click setup's failure presentation without allowing game access.
    await win.locator('.start-panel .btn.primary').evaluate((el) => {
      el.dataset.action = 'start-assistance';
    });
    await win.locator('.start-panel .btn.primary').click();
    await win.waitForFunction(() =>
      document.querySelector('.start-panel h2')?.textContent.includes('自动存档暂未准备好'),
    );
    assert.match(await win.locator('.start-panel').innerText(), /测试环境/);
    await win.locator('[data-action="refresh"]').click();
    assert.match(await win.locator('.start-panel h2').innerText(), /自动存档暂未准备好/);
    assert.equal(await win.locator('.start-panel [data-action="launch"]').count(), 1);
    // A stale machine-specific path must offer reconnection without hiding queries.
    launchDisplay.state.settings.savePath = path.join(data, 'previous-computer', 'SaveGames');
    launchDisplay.environment.saves = {
      path: launchDisplay.state.settings.savePath,
      files: [],
      total: 0,
      error: '模拟旧目录不可用',
    };
    launchDisplay.environment.timeline.error = '';
    launchDisplay.environment.timeline.pending = false;
    launchDisplay.environment.timeline.busy = false;
    launchDisplay.environment.recovery = null;
    launchDisplay.environment.detected = [];
    await app.evaluate(({ ipcMain, dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.locator('.start-panel').waitFor();
    assert.match(await win.locator('.start-panel h2').innerText(), /先前的存档目录暂不可用/);
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'choose-saves');
    assert.equal(await win.locator('.start-panel details').evaluate((el) => el.open), false);
    const storedBeforeCancel = fs.readFileSync(path.join(data, 'journal.json'));
    await win.locator('.start-panel .btn.primary').click();
    assert.deepEqual(fs.readFileSync(path.join(data, 'journal.json')), storedBeforeCancel);
    const candidate = path.join(data, '76561190000000000', 'SaveGames');
    launchDisplay.environment.detected = [candidate];
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
      ipcMain.removeHandler('journal:use-detected-saves');
      ipcMain.handle('journal:use-detected-saves', (_event, value) => {
        globalThis.syntheticReconnectSelection = value;
        return { ok: true, data: { state: fixture.state, environment: fixture.environment } };
      });
    }, launchDisplay);
    await win.reload();
    await win.locator('.start-panel').waitFor();
    assert.equal(
      await win.locator('.start-panel .btn.primary').getAttribute('data-action'),
      'reconnect-detected',
    );
    await win.locator('.start-panel .btn.primary').click();
    assert.equal(await app.evaluate(() => globalThis.syntheticReconnectSelection), candidate);
    launchDisplay.environment.timeline.pending = true;
    launchDisplay.environment.health.protection = { warning: true, reason: '模拟中断记录' };
    await app.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('journal:bootstrap');
      ipcMain.handle('journal:bootstrap', () => ({ ok: true, data: fixture }));
    }, launchDisplay);
    await win.reload();
    await win.locator('.start-panel').waitFor();
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-action'), 'navigate');
    assert.equal(await win.locator('.start-panel .btn.primary').getAttribute('data-id'), 'saves');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(results, 'smoke-report.json'),
      JSON.stringify(
        {
          passed: true,
          data,
          checks: [
            'navigation',
            'checklist',
            'notes persistence',
            'goals and escaping',
            'favorites',
            'spoiler reveal',
            'snapshot and verification',
            'separate profiles',
            'restart',
            'compact window',
            'global search',
            'minimum size',
            'recipe navigation preserves quantity',
            'interchangeable cooking materials and stock reference',
            'native quest records and inventory search',
            'keyboard result navigation',
            'preferred save selection and missing-slot refusal to fall back',
            'goal references reopen after restart and re-read inventory without changing the saved note',
          ],
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log('Electron smoke PASS; isolated data:', data);
  } finally {
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
