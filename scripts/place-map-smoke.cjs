'use strict';
const { chooseCodexKind } = require('./ui-smoke-actions.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..'),
  { _electron: electron } = require(path.join(base, 'node_modules/playwright'));
const { Store } = require(path.join(base, 'src/core/store.cjs')),
  { syntheticSave } = require(path.join(base, 'tests/fixtures.cjs')),
  catalog = require(path.join(base, 'src/data/catalog.cjs'));
const { selectProgress } = require('./progress-settings.cjs');
const output = path.join(base, '.test-data', 'place-map-' + Date.now()),
  data = path.join(output, 'state'),
  saves = path.join(data, 'SaveGames');
fs.mkdirSync(saves, { recursive: true });
fs.writeFileSync(
  path.join(saves, '1.sav'),
  syntheticSave({
    full: true,
    inventory: [{ id: 133, count: 3 }],
    map: 'LV_25_P',
    quests: [
      { id: 5200, step: 1 },
      { id: 5201, step: 1 },
      { id: 5059, step: 1 },
    ],
  }),
);
new Store(data, catalog).setPath('savePath', saves);
let app;
const env = { ...process.env, YIJIAN_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
      timeout: 30000,
    });
    const win = await app.firstWindow();
    await win.waitForSelector('.layout');
    const errors = [];
    win.on('pageerror', (e) => errors.push(e.message));
    const snap = async (p, n) => {
      await p.screenshot({ path: path.join(output, n + '.png'), animations: 'disabled' });
    };
    await win.locator('[data-action="compact"]').first().click();
    const small = await app.waitForEvent('window');
    await small.waitForSelector('.compact-shell');
    small.on('pageerror', (e) => errors.push(e.message));
    await small.locator('.companion-tabs [data-id="database"]').click();
    await chooseCodexKind(small, '地点');
    await small.locator('.place-map-frame').waitFor();
    assert.ok(
      (await small.locator('.place-map-frame').boundingBox()).height > 100,
      'map is not collapsed by global icon styles',
    );
    await snap(small, 'companion-map');

    const marker = small.locator('.place-map-pin[aria-label="查看梧桐村"]');
    await marker.click();
    await small.locator('.drawer .place-map-frame').waitFor();
    assert.equal(await small.locator('.drawer h1').innerText(), '梧桐村');
    await snap(small, 'companion-place');
    await small.locator('.drawer [data-action="place-map-scope"]').click();
    assert.equal(await small.locator('.drawer .place-map').getAttribute('data-map-scope'), 'world');
    await snap(small, 'companion-full-map');
    await small.locator('.drawer [data-action="place-map-scope"]').click();
    const nearby = small.locator('.drawer .place-map-nearby .entity-link').first();
    await small.bringToFront();
    await nearby.focus();
    await small.locator('#entity-preview').waitFor({ state: 'visible' });
    assert.equal(await small.locator('#entity-preview .place-map').count(), 1);
    await snap(small, 'location-hover');
    await small.keyboard.press('Escape');
    await small.locator('#entity-preview').waitFor({ state: 'hidden' });
    assert.equal(await small.locator('.drawer h1').innerText(), '梧桐村');
    await small.mouse.move(8, 8);
    await nearby.hover();
    await small.locator('#entity-preview .place-map').waitFor({ state: 'visible' });
    await snap(small, 'location-pointer-hover');
    await small.keyboard.press('Escape');
    await small.locator('#entity-preview').waitFor({ state: 'hidden' });
    assert.equal(await small.locator('.drawer h1').innerText(), '梧桐村');
    await win.bringToFront();
    await win.locator('.sidebar [data-id="world"]').click();
    await win.locator('[data-action="world-kind"][data-id="places"]').click();
    await win.locator('#world-search').fill('仙人渡');
    await win.waitForTimeout(180);
    const card = win.locator('.world-place-card[data-id="place-96:LV_64_P2"]');
    await card.click();
    await win.locator('.drawer h1').waitFor();
    assert.equal(await win.locator('.drawer h1').innerText(), '仙人渡');
    await snap(win, 'main-place');
    assert.equal(await win.locator('.drawer [data-map-place="LV_64_P2"]').count(), 1);
    await win.locator('[data-action="close-overlay"]').click();
    await small.bringToFront();
    await small.locator('[data-action="close-overlay"]').click();
    await small.locator('#list-search').fill('仙人渡');
    await small.locator('.database-card[data-id="place-96:LV_64_P2"]').click();
    await small.locator('.drawer [data-action="place-map-scope"]').click();
    await small.locator('.drawer [data-action="main"]').click();
    await win.locator('.drawer [data-map-place="LV_64_P2"]').waitFor();
    assert.equal(await win.locator('.drawer h1').innerText(), '仙人渡');
    assert.equal(await win.locator('.drawer .place-map').getAttribute('data-map-scope'), 'world');
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="compact"]').first().click();
    await small.locator('.drawer .place-map[data-map-scope="world"]').waitFor();
    await small.locator('.drawer .place-map-pin[data-id="map-point:1367.43:648.71"]').click();
    await small.locator('.drawer [data-action="world-place"]').first().waitFor();
    await small.locator('.drawer [data-action="main"]').click();
    await win.locator('.drawer [data-action="world-place"]').first().waitFor();
    const destination = win.locator('.drawer [data-action="world-place"]').first();
    const destinationName = await destination.innerText();
    assert.match(destinationName, /蜃楼岛|幻林/);
    await destination.click();
    await win.locator('.drawer .place-map').waitFor();
    await win.locator('[data-action="drawer-back"]').click();
    await win.locator('.drawer [data-action="world-place"]').first().waitFor();
    await win.locator('[data-action="close-overlay"]').click();
    await win.locator('[data-action="compact"]').first().click();
    await small.locator('[data-action="close-overlay"]').click();
    await small.keyboard.press('Control+k');
    await small.locator('#global-search').fill('种类:物品 名称:金疮药');
    await small.locator('.search-result[data-id="item-133"]').click();
    const stock = small.locator('.item-usage-stock > div').first().locator('dd');
    assert.equal(await stock.innerText(), '3');
    await selectProgress(win, '@none', { reopen: false });
    await small.waitForFunction(() => document.querySelector('.item-usage-stock dd')?.textContent === '—');
    await selectProgress(win, '1.sav', { reopen: false });
    await small.waitForFunction(() => document.querySelector('.item-usage-stock dd')?.textContent === '3');
    await small.locator('[data-action="close-overlay"]').click();
    await small.keyboard.press('Control+k');
    await small.locator('#global-search').fill('卫霍');
    await small.locator('#global-results [data-action="detail"][data-id="wei-huo"]').click();
    await small.locator('.drawer [data-entity-id="name:梧桐村"]').first().click();
    await small.locator('.drawer [data-action="world-place"][data-id="place-9"]').click();
    await small.locator('.drawer summary').filter({ hasText: '关联任务与步骤' }).click();
    const savedQuest = small.locator('.drawer .world-steps .world-step').filter({
      has: small.locator('[data-id="quest-5059"]'),
    });
    assert.match(await savedQuest.innerText(), /进行中/);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify({
        errors,
        checks: [
          'compact map entry',
          'place near view',
          'world scope toggle',
          'location hover map',
          'duplicate id exact location',
          'precise scene and overlapping map choices survive cross-window reading and back',
          'open companion item updates immediately when main Settings changes progress',
          'guide namesake place choice retains fixed progress and shows the active local quest',
        ],
      }),
    );
    console.log('Place map smoke PASS:', output);
  } finally {
    await app?.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
