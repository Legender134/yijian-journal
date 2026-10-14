'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(base, '.test-data', 'flow-arrival-'));
const data = path.join(output, 'state');
const source = path.join(data, 'SaveGames');
fs.mkdirSync(source, { recursive: true });
const file = path.join(source, '1.sav');
const writeSave = (quests = []) => {
  const bytes = syntheticSave({
    full: true,
    map: 'LV_28_P',
    quests,
    trackingQuest: 0,
    trackingMainQuest: 0,
  });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
  return bytes;
};
const original = writeSave();
const store = new Store(data, catalog);
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
const env = { ...process.env, YIJIAN_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let app;
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
    });
    const win = await app.firstWindow();
    win.on('pageerror', (error) => errors.push(error.message));
    await win.locator('.layout').waitFor();
    const choice = '[data-flow-decision="jinli-coin-before-accepting"]';
    await win.locator(choice).waitFor();
    assert.match(await win.locator(choice).innerText(), /小蝶/);
    assert.equal(await win.locator(choice + ' > .flow-choice-details').evaluate((node) => node.open), false);
    assert.doesNotMatch(await win.locator(choice).innerText(), /推荐做法|为什么：|取舍：/);
    await win.screenshot({ path: path.join(output, 'arrival-main.png'), animations: 'disabled' });
    const opened = app.waitForEvent('window');
    await win.locator('[data-action="compact"]').first().click();
    const small = await opened;
    small.on('pageerror', (error) => errors.push(error.message));
    await small.locator(choice).waitFor();
    const card = small.locator(choice);
    const details = card.locator('.flow-choice-details');
    assert.equal(await details.evaluate((node) => node.open), false);
    assert.match(await card.innerText(), /津鲤村古钱：推荐先帮\s*小蝶/);
    assert.doesNotMatch(await card.innerText(), /\.sav|SHA|Build|已保存进度/);
    await small.screenshot({ path: path.join(output, 'arrival-companion.png'), animations: 'disabled' });
    await details.locator(':scope > summary').click();
    assert.match(await details.innerText(), /武学.*陶瓷塑像/s);
    for (const id of ['quest-11127', 'quest-11129', 'item-10055'])
      assert.ok(await card.locator(`[data-entity-id="${id}"]`).count(), id + ' has a canonical entry');
    const coin = card.locator('[data-entity-id="item-10055"]').first();
    await coin.click();
    await small.locator('.drawer h1').waitFor();
    assert.match(await small.locator('.drawer h1').innerText(), /精美的古钱/);
    assert.match(await small.locator('.drawer').innerText(), /津鲤村.*小蝶/s);
    await small.keyboard.press('Escape');
    await small.locator('.drawer').waitFor({ state: 'detached' });
    assert.deepEqual(fs.readFileSync(file), original, 'reading never changes synthetic progress');
    const accepted = writeSave([
      { id: 11127, step: 1 },
      { id: 11128, step: 1 },
    ]);
    await small.locator(choice).waitFor({ state: 'detached', timeout: 20000 });
    await small.locator('[data-flow-quest="quest-11127"]').waitFor();
    assert.match(await small.locator('[data-flow-now]').innerText(), /司马相/);
    assert.deepEqual(fs.readFileSync(file), accepted, 'the recommendation does not switch the chosen branch');
    assert.deepEqual(errors, []);
    console.log(
      'Arrival guidance PASS: both windows, concise first view, linked coin detail and saved-choice retirement;',
      output,
    );
  } finally {
    await app?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
