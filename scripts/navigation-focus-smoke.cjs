'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto'),
  { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'navigation-focus-' + Date.now());
const userdata = path.join(out, 'userdata'),
  saves = path.join(out, 'synthetic-SaveGames'),
  temp = path.join(out, 'temp');
for (const dir of [userdata, saves, temp, path.join(base, 'test-results')])
  fs.mkdirSync(dir, { recursive: true });
process.env.TEMP = process.env.TMP = temp;
const save = path.join(saves, '1.sav');
fs.writeFileSync(
  save,
  syntheticSave({
    full: true,
    inventory: [{ id: 10216, count: 3 }],
    fusionRecipes: [1000],
    quests: [
      { id: 5820, step: 1 },
      { id: 5829, step: 4 },
      { id: 5830, step: 1 },
    ],
    trackingMainQuest: 5820,
    trackingQuest: 5830,
  }),
);
const settled = new Date(Date.now() - 5000);
fs.utimesSync(save, settled, settled);
const hash = () => createHash('sha256').update(fs.readFileSync(save)).digest('hex'),
  original = hash();
const store = new Store(userdata, require('../src/data/catalog.cjs'));
store.setPath('savePath', saves);
store.mutate({ type: 'settings', value: { autoBackup: false } });
store.mutate({ type: 'save-slot', value: '1.sav', mode: 'slot' });
store.mutate({ type: 'craft-set', id: 'fusion-1000', quantity: 1 });
const report = {
  startedAt: new Date().toISOString(),
  executable: process.env.YIJIAN_EXECUTABLE || 'source Electron',
  checks: [],
  errors: [],
  syntheticOnly: true,
};
let app, page, companion;
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userdata, TEMP: temp, TMP: temp };
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.showInactive()));
}
async function navigate(win, id, compact = false) {
  const scope = compact ? '.companion-tabs' : '.sidebar-nav';
  const button = win.locator(`${scope} [data-action="navigate"][data-id="${id}"]`);
  await button.focus();
  await win.keyboard.press('Enter');
  await win.waitForFunction(
    ({ scope, id }) => {
      const current = document.querySelector(`${scope} [aria-current="page"]`);
      return current?.dataset.id === id && document.activeElement === current;
    },
    { scope, id },
  );
  const state = await button.evaluate((n) => ({
    visible: n.matches(':focus-visible'),
    outline: getComputedStyle(n).outlineStyle,
    disabled: n.disabled,
  }));
  assert(state.visible && state.outline !== 'none' && !state.disabled, JSON.stringify(state));
  assert.equal(await win.locator(`${scope} [aria-current]`).count(), 1);
  await win.keyboard.press('Tab');
  assert.notEqual(await win.evaluate(() => document.activeElement.tagName), 'BODY');
  report.checks.push(`${compact ? 'compact' : 'main'} ${id}: visible focus, current page and continuing Tab`);
}
async function changeState(win) {
  const response = await win.evaluate(() =>
    window.journal.mutate({ type: 'settings', value: { spoiler: 'details' } }),
  );
  assert(response.ok, response.error);
}
(async () => {
  try {
    await launch();
    for (const id of ['world', 'materials', 'journal', 'settings']) await navigate(page, id);
    await navigate(page, 'journal');
    await page.locator('#journal-search').fill('输入中保留');
    await page.locator('#journal-search').evaluate((n) => n.setSelectionRange(2, 5));
    await changeState(page);
    await page.waitForFunction(
      () => document.activeElement.id === 'journal-search' && document.activeElement.value === '输入中保留',
    );
    assert.deepEqual(
      await page.locator('#journal-search').evaluate((n) => [n.selectionStart, n.selectionEnd]),
      [2, 5],
    );
    report.checks.push(
      'state refresh preserves focused input, text and selection without moving to navigation',
    );
    await page.keyboard.press('Control+k');
    await page.locator('#global-search').fill('清灵丹');
    await changeState(page);
    await page.waitForFunction(() => document.activeElement.id === 'global-search');
    assert.equal(await page.locator('#app').evaluate((n) => n.inert), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'journal-search');
    report.checks.push('refresh does not steal dialog focus; Escape returns to the original input');
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    companion = await created;
    companion.on('pageerror', (e) => report.errors.push(e.message));
    await companion.locator('.compact-shell').waitFor();
    for (const id of ['database', 'duels', 'saves', 'home']) await navigate(companion, id, true);
    assert.equal(await companion.locator('.companion-tabs').getAttribute('role'), 'navigation');
    await companion.locator('.companion-tabs [data-id="home"]').focus();
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').waitFor();
    await companion.keyboard.press('Escape');
    assert.equal(await companion.evaluate(() => document.activeElement.dataset.id), 'home');
    report.checks.push('compact search closes back to the current navigation button');
    await navigate(companion, 'duels', true);
    const duel = companion.locator('[data-duel="npc053-chengyu"]');
    await duel.locator('.duel-readiness-preview').click();
    await duel.locator('details > summary').first().click();
    await duel.locator(':scope > summary [data-id="item-10176"]').click();
    await companion.locator('[data-action="close-overlay"]').first().click();
    const position = await companion.locator('.compact-body').evaluate((body) => {
      body.scrollTop = Math.min(700, body.scrollHeight - body.clientHeight);
      return body.scrollTop;
    });
    assert(position > 200, 'the player is reading below a previously closed item detail');
    await companion.screenshot({ path: path.join(out, 'compact-before-tuck.png'), animations: 'disabled' });
    for (let repetition = 0; repetition < 2; repetition++) {
      await companion.locator('[data-action="companion-tuck"]').click();
      await companion.locator('#companion-edge').waitFor({ state: 'visible' });
      await companion.locator('#companion-edge').click();
      await companion.waitForFunction(
        (expected) =>
          !document.body.classList.contains('tucked') &&
          Math.abs(document.querySelector('.compact-body').scrollTop - expected) < 2,
        position,
      );
      assert.equal(
        await companion.locator('.companion-tabs [aria-current]').getAttribute('data-id'),
        'duels',
      );
      assert.equal(await duel.evaluate((node) => node.open), true);
      assert.equal(
        await duel
          .locator('details')
          .first()
          .evaluate((node) => node.open),
        true,
      );
    }
    await companion.screenshot({ path: path.join(out, 'compact-after-unfold.png'), animations: 'disabled' });
    report.checks.push(
      'tuck and unfold twice preserve the page, reading position and expanded preparation after closing an item detail',
    );
    await page.screenshot({ path: path.join(out, 'main-focus.png'), animations: 'disabled' });
    await companion.screenshot({ path: path.join(out, 'compact-focus.png'), animations: 'disabled' });
    await app.close();
    app = null;
    await launch();
    for (const id of ['world', 'materials', 'journal']) await navigate(page, id);
    assert.equal(hash(), original);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('Navigation focus PASS', report.checks.length, 'checks', out);
  } catch (error) {
    report.failure = String(error.stack || error);
    throw error;
  } finally {
    if (app) await app.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results/navigation-focus-result.json'),
      JSON.stringify({ ...report, evidence: out }, null, 2),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
