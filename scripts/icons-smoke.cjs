'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const {
  _electron,
} = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(base, '.test-data', 'pictures-'));
const source = path.join(data, 'SaveGames');
fs.mkdirSync(source);
const save = path.join(source, '1.sav');
fs.writeFileSync(
  save,
  syntheticSave({
    full: true,
    inventory: [
      { id: 1003, count: 2 },
      { id: 10226, count: 3 },
    ],
  }),
);
const before = sha(fs.readFileSync(save));
new Store(data, catalog).setPath('savePath', source);
const report = { startedAt: new Date().toISOString(), checks: [], errors: [], externalRequests: [] };
let app, win;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: data, YIJIAN_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    env,
  });
  win = await app.firstWindow();
  win.on('pageerror', (e) => report.errors.push(e.message));
  win.on('request', (r) => {
    if (/^https?:/.test(r.url())) report.externalRequests.push(r.url());
  });
  await win.locator('.layout').waitFor();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
}
const nav = (name) => win.locator(`.nav-btn[data-id="${name}"]`).click();
async function loaded(selector) {
  await win.locator(selector).first().waitFor();
  // Off-screen cards are intentionally lazy; eagerly load them in this check.
  await win.locator(selector).evaluateAll((images) =>
    images.forEach((i) => {
      i.loading = 'eager';
    }),
  );
  await win.waitForFunction(
    (selector) => [...document.querySelectorAll(selector)].every((i) => i.complete && i.naturalWidth > 0),
    selector,
  );
}
async function shot(name) {
  await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.capturePage());
  await win.waitForTimeout(200);
  const encoded = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayAwake: true }))
      .toPNG()
      .toString('base64'),
  );
  fs.writeFileSync(path.join(base, 'test-results', name + '.png'), Buffer.from(encoded, 'base64'));
}
(async () => {
  try {
    await launch();
    const bootstrap = (await win.evaluate(() => window.journal.bootstrap())).data;
    report.version = bootstrap.version;
    const images = [...new Set(Object.values(bootstrap.gameIndex.images))];
    const bad = [];
    for (let offset = 0; offset < images.length; offset += 50) {
      const result = await win.evaluate(
        async (files) =>
          Promise.all(
            files.map(
              (file) =>
                new Promise((resolve) => {
                  const picture = new Image();
                  picture.onload = () =>
                    resolve({ file, width: picture.naturalWidth, height: picture.naturalHeight });
                  picture.onerror = () => resolve({ file, width: 0, height: 0 });
                  picture.src = `../assets/game/${file}`;
                }),
            ),
          ),
        images.slice(offset, offset + 50),
      );
      bad.push(...result.filter((i) => !i.width || !i.height || i.width > 192 || i.height > 192));
    }
    assert.deepEqual(bad, []);
    report.assetCount = images.length;
    report.checks.push('every referenced local PNG decodes inside the sandboxed renderer, offline');
    assert.ok((await win.locator('.backup-auto-status').innerText()).includes('未开启'));
    await win.locator('.backup-auto-status [data-action="navigate"]').click();
    await win.locator('[data-action="auto-backup"]').click();
    await nav('home');
    assert.ok((await win.locator('.backup-auto-status').innerText()).includes('正在检查变化'));
    assert.ok((await win.locator('.backup-auto-status').innerText()).includes('完整备份'));
    assert.ok((await win.locator('.backup-auto-status').innerText()).includes('时间线中管理'));
    await app.close();
    app = null;
    await launch();
    assert.ok((await win.locator('.backup-auto-status').innerText()).includes('正在检查变化'));
    await nav('saves');
    await win.locator('[data-action="auto-backup"]').click();
    assert.equal(
      (await win.evaluate(() => window.journal.bootstrap())).data.state.settings.autoBackup,
      false,
    );
    report.checks.push(
      'automatic backup switch persists across restart and home displays the actual setting',
    );
    await nav('database');
    await win.locator('#list-search').fill('白光剑');
    await loaded('.database-card .game-image');
    await shot('20-item-pictures');
    await win.locator('.database-card[data-id="item-1003"]').click();
    await loaded('.game-detail-title .game-image');
    assert.equal(await win.locator('.game-detail-title h1').innerText(), '白光剑');
    await win.keyboard.press('Escape');
    await win.locator('[data-action="database-kind"][data-id="武学"]').click();
    await win.locator('#list-search').fill('');
    await loaded('.database-card .game-image');
    await shot('21-skill-pictures');
    await win.locator('[data-action="database-kind"][data-id="人物"]').click();
    await win.locator('#list-search').fill('卫霍');
    await loaded('.database-card .game-image');
    await win.locator('.database-card[data-id="npc-10047"]').click();
    await win.locator('#person-save').selectOption('1.sav');
    await loaded('.person-gifts .game-image');
    assert.ok((await win.locator('.person-gifts').innerText()).includes('2 件'));
    await shot('22-person-pictures');
    await win.locator('.person-gifts [data-id="item-1003"]').click();
    await loaded('.game-detail-title .game-image');
    await win.locator('[data-action="drawer-back"]').click();
    await loaded('.game-detail-title .game-image');
    assert.equal(await win.locator('.game-detail-title h1').innerText(), '卫霍');
    await win.keyboard.press('Escape');
    report.checks.push(
      'item, skill and NPC cards/details use their own images; gift quantities and drawer history retained',
    );
    await nav('materials');
    await win.locator('#craft-search').fill('长虹剑精良图纸');
    await loaded('.craft-suggestions .game-image');
    await win.locator('[data-action="craft-add"][data-id="fusion-1002"]').click();
    await win.locator('.craft-line').waitFor();
    await win.locator('[data-action="craft-calculate"]').click();
    await win.locator('.craft-totals').waitFor();
    await loaded('.craft-line .game-image');
    await loaded('.craft-materials .game-image');
    await shot('23-material-pictures');
    report.checks.push(
      'recipe results and allocated materials carry pictures, shared-stock results remain usable',
    );
    await nav('saves');
    await win.locator('[data-action="save-detail"][data-id="1.sav"]').click();
    await win
      .locator('details')
      .filter({ has: win.locator('#save-inventory-results') })
      .locator('summary')
      .click();
    await loaded('#save-inventory-results .game-image');
    await win.keyboard.press('Escape');
    await nav('library');
    await win.locator('#list-search').fill('卫霍');
    await loaded('.entry-avatar .game-image');
    await win.keyboard.press('Control+k');
    await win.locator('#global-search').fill('卫霍');
    await loaded('.search-result .game-image');
    await win.keyboard.press('Escape');
    report.checks.push('saved inventory, guide portraits and global search retain text and display artwork');
    await nav('database');
    await win.locator('[data-action="database-kind"][data-id="物品"]').click();
    await win.locator('#list-search').fill('四品武器图册');
    assert.equal(await win.locator('.database-card .image-unavailable').count(), 1);
    await win.locator('#list-search').fill('白光剑');
    await loaded('.database-card .game-image');
    await win
      .locator('.database-card .game-image')
      .first()
      .evaluate((img) => {
        img.src = '../assets/game/missing-test.png';
      });
    await win.locator('.database-card .image-unavailable').first().waitFor();
    assert.ok(await win.locator('.database-card .image-unavailable .image-fallback').first().isVisible());
    assert.ok((await win.locator('.database-card').first().innerText()).includes('白光剑'));
    report.checks.push(
      'missing original artwork and failed images show category icons without losing names or controls',
    );
    assert.equal(sha(fs.readFileSync(save)), before);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(base, 'test-results/icons-smoke-report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log('Pictures smoke PASS:', images.length, 'images;', report.checks.length, 'flows');
  } finally {
    await app?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
