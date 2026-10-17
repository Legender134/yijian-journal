'use strict';
const { chooseCodexKind } = require('./ui-smoke-actions.cjs');
// Public screenshots use reproducible example progress, never personal saves.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const sharp = require('sharp');
const { Store } = require('../src/core/store.cjs');
const { Saves } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.test-data/showcase-' + Date.now()));
if (fs.existsSync(output)) throw Error('Choose a new output directory');
const data = path.join(output, 'state');
const source = path.join(data, '76561190000000000/SaveGames');
fs.mkdirSync(source, { recursive: true });
const attributes = { 1: 100, 2: 100, 3: 50, 4: 50, 5: 15, 44: 100, 27: 1, 48: 1, 61: 1, 63: 1, 65: 1, 67: 1 };
const npc = (id, extra = {}) => ({ id, attributes, map: 'LV_25_P', friendliness: [[0, 70]], ...extra });
const bytes = syntheticSave({
  full: true,
  map: 'LV_25_P',
  inventory: [
    { id: 10262, count: 0 },
    { id: 10263, count: 1 },
  ],
  quests: [5200, 5201, 11077, 11078].map((id) => ({ id, step: 1 })),
  trackingQuest: 11078,
  trackingMainQuest: 5200,
  npcs: [
    { id: 0, attributes, skills: [{ id: 850, level: 1 }] },
    npc(10016, {
      attributes: { ...attributes, 65: 3 },
      skills: [{ id: 100, level: 10 }],
      inventory: [{ id: 100034, count: 1 }],
    }),
    npc(10047, { inventory: [{ id: 100073, count: 1 }] }),
    npc(10038),
  ],
});
fs.writeFileSync(path.join(source, '1.sav'), bytes);
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false, checkUpdatesOnStart: false } });
const saves = new Saves(path.join(data, 'save-backups'));
saves.capture(source, '拜师前 · 留一份退路');
const env = { ...process.env, YIJIAN_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [],
  images = [];
async function shot(page, name, selector) {
  await page.mouse.move(4, 4);
  await page.evaluate(() => document.fonts.ready);
  await (selector ? page.locator(selector) : page).screenshot({
    path: path.join(output, name + '.png'),
    animations: 'disabled',
    scale: 'css',
  });
  await sharp(path.join(output, name + '.png'))
    .webp({ quality: 91 })
    .toFile(path.join(output, name + '.webp'));
  images.push(name);
}
async function size(page, width, height) {
  const window = await app.browserWindow(page);
  await window.evaluate(
    (win, bounds) => {
      win.setBounds(bounds);
      win.webContents.setZoomFactor(1);
    },
    { width, height },
  );
  await window.dispose();
}
(async () => {
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [root, '--force-device-scale-factor=1'],
      env,
    });
    const main = await app.firstWindow();
    main.on('pageerror', (e) => errors.push(e.message));
    await main.locator('.layout').waitFor();
    await size(main, 1360, 900);
    await main.locator('[data-flow]').waitFor();
    await shot(main, 'overview');
    const opening = app.waitForEvent('window');
    await main.locator('[data-action="compact"]').first().click();
    const small = await opening;
    small.on('pageerror', (e) => errors.push(e.message));
    await small.locator('.compact-shell').waitFor();
    await size(small, 480, 820);
    await small.locator('[data-flow-now]').waitFor();
    await shot(small, 'companion-flow');
    const risk = small.locator('.flow-risk-window').first();
    if (await risk.count()) {
      await risk.locator(':scope > summary').click();
      await shot(small, 'companion-flow-detail');
    }
    await small.locator('.companion-tabs [data-id="duels"]').click();
    await small.locator('[data-npc-progress-card="10016"]').waitFor();
    await shot(small, 'companion-duels');
    await small.locator('[data-action="npc-progress-tab"][data-id="learning"]').click();
    await small.locator('[data-npc-progress-card="10016"] > summary').click();
    await shot(small, 'companion-learning');
    await small
      .locator('[data-npc-progress-card="10016"] [data-action="database-detail"][data-id="npc-10016"]')
      .first()
      .click();
    await small.locator('#overlay .drawer').waitFor();
    await shot(small, 'companion-person');
    await small.locator('#overlay [data-action="close-overlay"]').first().click();
    await small.locator('.companion-tabs [data-id="database"]').click();
    await chooseCodexKind(small, '地点');
    await small.locator('.place-map-pin[aria-label="查看梧桐村"]').click();
    await small.locator('.drawer .place-map-frame').waitFor();
    await shot(small, 'companion-map');
    await small.locator('#overlay [data-action="close-overlay"]').first().click();
    await small.locator('.companion-tabs [data-id="saves"]').click();
    await small.locator('[data-persist-detail="compact-backups"]').waitFor();
    const backups = small.locator('[data-persist-detail="compact-backups"]');
    if (!(await backups.evaluate((el) => el.open))) await backups.locator(':scope > summary').click();
    await shot(small, 'companion-saves');
    await main.locator('.nav-btn[data-id="database"]').click();
    await chooseCodexKind(main, '物品');
    const search = main.locator('#list-search');
    await search.fill('一转血气丹');
    await main.locator('[data-action="database-detail"][data-id="item-100"]').first().click();
    await main.locator('#overlay .drawer').waitFor();
    await shot(main, 'item-detail', '#overlay .drawer');
    await main.locator('#overlay [data-action="close-overlay"]').first().click();
    await main.locator('.nav-btn[data-id="world"]').click();
    await main.locator('#world-search').fill('养生秘术');
    await main.locator('.world-quest-card[data-id="quest-11077"]').click();
    await shot(main, 'quest-detail', '#overlay .drawer');
    assert.deepEqual(errors, []);
    assert.deepEqual(fs.readFileSync(path.join(source, '1.sav')), bytes);
    fs.writeFileSync(
      path.join(output, 'capture.json'),
      JSON.stringify(
        {
          version: require('../package.json').version,
          context: 'Actual app UI, isolated example progress; no real game attachment or personal saves.',
          images,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ output, images }));
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
