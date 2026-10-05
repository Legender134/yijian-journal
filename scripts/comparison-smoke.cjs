'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  _electron,
} = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { sha } = require('../src/core/saves.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const index = require('../src/data/game-index.json'),
  catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..'),
  data = fs.mkdtempSync(path.join(base, '.test-data', 'comparison-')),
  source = path.join(data, 'SaveGames');
fs.mkdirSync(source);
const extras = index.entries
  .filter((e) => e.kind === '物品' && ![10226, 10220, 10525].includes(e.gameId))
  .slice(0, 72);
fs.writeFileSync(
  path.join(source, '1.sav'),
  syntheticSave({
    full: true,
    money: 100,
    seconds: 3600,
    inventory: [
      { id: 10226, count: 2 },
      { id: 10220, count: 8 },
      ...extras.map((e) => ({ id: e.gameId, count: 1 })),
    ],
    quests: [
      { id: 5200, step: 1 },
      { id: 5201, step: 0 },
    ],
    team: [0, 10047],
    fusionRecipes: [1002],
    cookingRecipes: [],
  }),
);
fs.writeFileSync(
  path.join(source, '2.sav'),
  syntheticSave({
    full: true,
    money: 350,
    seconds: 5445,
    inventory: [
      { id: 10226, count: 7 },
      { id: 10525, count: 5 },
      ...extras.map((e) => ({ id: e.gameId, count: 2 })),
    ],
    quests: [
      { id: 5200, step: 4 },
      { id: 5201, step: 1 },
    ],
    team: [0, 987654321],
    fusionRecipes: [1002, 1003],
    cookingRecipes: [100],
  }),
);
fs.writeFileSync(path.join(source, '3.sav'), syntheticSave());
const originals = fs.readdirSync(source).map((name) => ({
  name,
  hash: sha(fs.readFileSync(path.join(source, name))),
  mtime: fs.statSync(path.join(source, name), { bigint: true }).mtimeNs.toString(),
}));
new Store(data, catalog).setPath('savePath', source);
const report = { startedAt: new Date().toISOString(), checks: [], errors: [] };
let app;
(async () => {
  try {
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env: { ...process.env, YIJIAN_TEST_DATA: data },
    });
    const win = await app.firstWindow();
    win.on('pageerror', (e) => report.errors.push(e.message));
    await win.locator('.layout').waitFor();
    report.version = (await win.evaluate(() => window.journal.bootstrap())).data.version;
    await win.locator('.nav-btn[data-id="saves"]').click();
    await win.locator('[data-action="save-compare"]').click();
    await win.locator('#compare-left').selectOption('1.sav');
    await win.locator('#compare-right').selectOption('2.sav');
    await win.locator('[data-action="compare-run"]').click();
    await win.locator('#compare-status').filter({ hasText: '已完成只读对比' }).waitFor();
    assert.ok((await win.locator('.compare-summary').innerText()).includes('+250 文'));
    assert.ok((await win.locator('.compare-summary').innerText()).includes('45 秒'));
    const answer = await win.evaluate(() => window.journal.compareSaves('1.sav', '2.sav'));
    assert.equal(answer.ok, true);
    assert.equal(answer.data.inventory.changes.length, 75);
    assert.equal(answer.data.quests.changes.length, 2);
    report.checks.push('real IPC and visible signed quantities, money, time and task differences');
    await win.locator('[data-action="compare-filter"][data-id="less"]').click();
    assert.equal(await win.locator('.compare-item').count(), 1);
    assert.ok((await win.locator('.compare-item').innerText()).includes('-8'));
    await win.locator('[data-action="compare-filter"][data-id="all"]').click();
    await win.locator('#compare-inventory-search').fill(extras.at(-1).name);
    assert.ok(
      await win.locator(`[data-action="database-detail"][data-id="item-${extras.at(-1).gameId}"]`).count(),
    );
    await win.locator('#compare-inventory-search').fill('精钢锭');
    await win.locator('[data-action="database-detail"][data-id="item-10226"]').click();
    await win.locator('.drawer h1').filter({ hasText: '精钢锭' }).waitFor();
    await win.locator('[data-action="drawer-back"]').click();
    assert.equal(await win.locator('#compare-inventory-search').inputValue(), '精钢锭');
    assert.ok((await win.locator('.compare-item').innerText()).includes('+5'));
    await win.screenshot({
      path: path.join(base, 'test-results', '12-comparison.png'),
      animations: 'disabled',
    });
    report.checks.push('quantity filters, search beyond first60rows and link-back preserve result and query');
    await win.locator('.compare-quests > summary').click();
    await win.locator('#compare-quest-search').fill('武当求助');
    assert.ok((await win.locator('#compare-quest-results').innerText()).includes('已完成'));
    await win.locator('.save-quests > summary').filter({ hasText: '队伍成员差异' }).click();
    assert.ok((await win.locator('#compare-team-results').innerText()).includes('角色 #987654321'));
    await win.locator('.save-quests > summary').filter({ hasText: '已学配方差异' }).click();
    assert.ok((await win.locator('.compare-recipe-family').last().innerText()).includes('水煮肉片'));
    report.checks.push('task search, unknown team identity and learned-recipe differences');
    await win.locator('[data-action="compare-swap"]').click();
    await win.locator('#compare-status').filter({ hasText: '已完成只读对比' }).waitFor();
    assert.equal(await win.locator('#compare-left').inputValue(), '2.sav');
    assert.ok((await win.locator('.compare-summary').innerText()).includes('-250 文'));
    assert.ok((await win.locator('.compare-item').innerText()).includes('-5'));
    report.checks.push('swapping left/right reverses signed differences');
    await win.locator('#compare-right').selectOption('3.sav');
    assert.equal(await win.locator('.compare-summary').count(), 0);
    await win.locator('[data-action="compare-run"]').click();
    await win.locator('#compare-status').filter({ hasText: '已完成只读对比' }).waitFor();
    assert.ok((await win.locator('#compare-inventory-results').innerText()).includes('未能读取'));
    report.checks.push('selection changes discard obsolete result; partial format is not counted as zero');
    for (const name of ['../1.sav', 'JHSaveConfig.sav', '99.sav'])
      assert.equal(
        (await win.evaluate((name) => window.journal.compareSaves(name, '1.sav'), name)).ok,
        false,
      );
    await win.locator('#compare-left').selectOption('1.sav');
    await win.locator('#compare-right').selectOption('1.sav');
    await win.locator('[data-action="compare-run"]').click();
    await win.locator('#compare-status').filter({ hasText: '已完成只读对比' }).waitFor();
    assert.equal(await win.locator('.compare-item').count(), 0);
    report.checks.push('invalid IPC filenames refused and identical slot comparison is empty');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 660));
    const bounds = await win.locator('.comparison-drawer').evaluate((e) => ({
      right: e.getBoundingClientRect().right,
      bottom: e.getBoundingClientRect().bottom,
      w: innerWidth,
      h: innerHeight,
      scrollWidth: e.scrollWidth,
      clientWidth: e.clientWidth,
    }));
    assert.ok(
      bounds.right <= bounds.w + 1 &&
        bounds.bottom <= bounds.h + 1 &&
        bounds.scrollWidth <= bounds.clientWidth + 1,
    );
    await win.keyboard.press('Escape');
    assert.equal(await win.locator('.comparison-drawer').count(), 0);
    assert.equal(await win.locator('#app').evaluate((e) => e.inert), false);
    report.checks.push('minimum window fit and Escape restores normal page interaction');
    for (const f of originals) {
      assert.equal(sha(fs.readFileSync(path.join(source, f.name))), f.hash);
      assert.equal(fs.statSync(path.join(source, f.name), { bigint: true }).mtimeNs.toString(), f.mtime);
    }
    await win.locator('[data-action="save-compare"]').click();
    await win.locator('#compare-left').selectOption('2.sav');
    await win.locator('#compare-right').selectOption('1.sav');
    fs.unlinkSync(path.join(source, '2.sav'));
    await win.locator('[data-action="compare-run"]').click();
    await win.locator('#compare-status').filter({ hasText: '比较未完成' }).waitFor();
    assert.ok((await win.locator('#comparison-result').innerText()).includes('已不存在'));
    await win.locator('[data-action="compare-refresh"]').click();
    assert.equal(await win.locator('#compare-left option[value="2.sav"]').count(), 0);
    report.checks.push('deleted synthetic slot produces an explicit error and refresh removes stale choices');
    await app.evaluate(
      ({ ipcMain }, { source, root, modulePath }) => {
        const load = process.getBuiltinModule('node:module').createRequire(modulePath);
        const { Saves } = load(modulePath);
        const reader = new Saves(root);
        ipcMain.removeHandler('journal:compare-saves');
        ipcMain.handle('journal:compare-saves', async (_event, left, right) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { ok: true, data: reader.compare(source, left, right) };
        });
      },
      {
        source,
        root: path.join(data, 'late-test-backups'),
        modulePath: path.join(base, 'src', 'core', 'saves.cjs'),
      },
    );
    await win.locator('[data-action="compare-run"]').click();
    await win.keyboard.press('Escape');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await win.locator('.comparison-drawer').count(), 0);
    assert.equal(await win.locator('#app').evaluate((e) => e.inert), false);
    report.checks.push('late IPC result after Escape cannot reopen a closed comparison');
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('Comparison smoke PASS:', report.checks.length, 'flows');
  } catch (e) {
    report.passed = false;
    report.failure = e.stack;
    throw e;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(base, 'test-results', 'comparison-smoke-report.json'),
      JSON.stringify(report, null, 2),
    );
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
