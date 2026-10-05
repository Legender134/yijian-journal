'use strict';
const { _electron: electron } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'playwright',
);
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
      { id: 5176, step: 4, finished: 1781822869 },
    ],
  }),
);
fs.writeFileSync(path.join(fakeSaves, 'JHSaveConfig.sav'), 'fake config');
fs.writeFileSync(path.join(fakeSaves, '2.sav'), syntheticSave({ full: true, seconds: 7200 }));
fs.utimesSync(path.join(fakeSaves, '2.sav'), new Date('2025-01-01'), new Date('2025-01-01'));
new Store(data, catalog).setPath('savePath', fakeSaves);
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
    assert.ok((await win.locator('.backup-row').innerText()).includes('改名后的测试副本'));
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
    await windows[1].locator('[data-action="window-close"]').click();
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
    await companion.locator('[data-action="window-close"]').click();
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
    await win.keyboard.press('Escape');
    // Compact-width and minimum-window layout checks.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await win.screenshot({ animations: 'disabled', path: path.join(results, '06-small-window.png') });
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
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
