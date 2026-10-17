'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const { openMainPage } = require('./ui-smoke-actions.cjs');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'backup-availability-ui-' + Date.now());
const data = path.join(out, 'userdata'),
  source = path.join(out, 'synthetic-SaveGames'),
  root = path.join(data, 'save-backups');
fs.mkdirSync(source, { recursive: true });
const file = path.join(source, '1.sav'),
  original = syntheticSave({ full: true, seconds: 1234, inventory: [{ id: 1002, count: 1 }] });
fs.writeFileSync(file, original);
const old = new Date(Date.now() - 10000);
fs.utimesSync(file, old, old);
const store = new Store(data, require('../src/data/catalog.cjs'));
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false, checkUpdatesOnStart: false } });
fs.writeFileSync(root, 'synthetic occupied backup path');
let app, main, compact;
const errors = [],
  checks = [];
function move(from, to) {
  for (const value of [from, to]) {
    const relative = path.relative(out, path.resolve(value));
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'Move stays inside this synthetic fixture',
    );
  }
  fs.renameSync(from, to);
}
async function environment() {
  const value = await main.evaluate(() => window.journal.bootstrap());
  assert(value.ok, value.error);
  return value.data.environment;
}
async function waitEnvironment(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await environment();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Expected backup state was not reached');
}
async function capture(page, name) {
  const win = await app.browserWindow(page);
  const bytes = await win.evaluate(async (w) =>
    (await w.webContents.capturePage()).toPNG().toString('base64'),
  );
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(bytes, 'base64'));
  await win.dispose();
}
async function unavailable(page) {
  await page.locator('section[aria-label="备份目录暂不可用"]').waitFor();
  const text = await page.locator('body').innerText();
  assert.match(text, /数量待核对/);
  assert.doesNotMatch(text, /还没有备份|暂无副本|完整存档副本 · 0/);
  assert.equal(await page.locator('[data-action="backup-cleanup-selected"]').count(), 0);
}
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require('electron'), args: [base], cwd: base, env });
    app.on('window', (page) => page.on('pageerror', (e) => errors.push(e.message)));
    app.context().setDefaultTimeout(15000);
    main = await app.firstWindow();
    main.on('pageerror', (e) => errors.push(e.message));
    await main.locator('.layout').waitFor();
    let current = await environment();
    assert(current.backupInventoryError && current.health.backupUnavailable);
    assert.equal(current.health.lastBackup, null);
    assert.equal(current.health.protection.ready, false);
    await openMainPage(main, 'saves');
    await unavailable(main);
    await capture(main, '01-main-unavailable');
    assert.equal(fs.readFileSync(root, 'utf8'), 'synthetic occupied backup path');
    checks.push(
      'Unavailable backup storage at startup opens the app, preserves its path and presents unknown counts',
    );
    await openMainPage(main, 'database');
    await main.locator('#list-search').fill('纯钢剑');
    await main.locator('.codex-results [data-id="item-1002"]').click();
    await main.locator('.drawer h1').filter({ hasText: '纯钢剑' }).waitFor();
    await main.locator('[data-action="close-overlay"]').first().click();
    await openMainPage(main, 'saves');
    checks.push('Codex and saved-progress queries remain usable while backup storage is unavailable');
    const opened = app.waitForEvent('window');
    await main.locator('[data-action="compact"]').first().click();
    compact = await opened;
    await compact.locator('.companion-tabs [data-id="saves"]').click();
    await unavailable(compact);
    await capture(compact, '02-companion-unavailable');
    const blocked = await main.evaluate(() => window.journal.backup('must stay blocked'));
    assert.equal(blocked.ok, false);
    assert.equal(fs.readFileSync(root, 'utf8'), 'synthetic occupied backup path');
    move(root, path.join(out, 'retained-occupied-path'));
    fs.mkdirSync(root);
    await compact.locator('[data-action="backup-recheck"]').click();
    await waitEnvironment((e) => !e.backupInventoryError);
    await main.locator('section[aria-label="备份目录暂不可用"]').waitFor({ state: 'detached' });
    await main.locator('[data-action="auto-backup"]').first().click();
    current = await waitEnvironment((e) => e.backups.length === 1 && e.health.lastBackup && !e.autoError);
    const backupId = current.backups[0].id;
    assert.equal(current.health.lastBackup.id, backupId);
    await capture(compact, '03-reconnected');
    checks.push(
      'Retry updates both windows and resumes verified automatic protection after the directory is repaired',
    );
    const retained = path.join(out, 'retained-backups');
    move(root, retained);
    fs.writeFileSync(root, 'synthetic second unavailable path');
    await compact.locator('[data-action="backup-recheck"]').click();
    await unavailable(compact);
    current = await environment();
    assert.equal(current.health.lastBackup, null);
    assert.equal(current.health.protection.ready, false);
    assert.equal(fs.readFileSync(path.join(retained, backupId, 'files', '1.sav')).compare(original), 0);
    move(root, path.join(out, 'retained-second-occupied-path'));
    move(retained, root);
    await main.locator('[data-action="backup-recheck"]').click();
    current = await waitEnvironment((e) => !e.backupInventoryError && !e.autoError && e.health.lastBackup);
    assert.equal(current.backups.length, 1);
    assert.equal(current.health.lastBackup.id, backupId);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(errors, []);
    checks.push(
      'A later disconnect clears stale protection, reconnection reverifies the retained copy without duplicates or game writes',
    );
  } catch (error) {
    errors.push(error.stack);
    process.exitCode = 1;
    console.error(error);
  } finally {
    if (app && errors.length) await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    if (app) await app.close().catch(() => {});
    const result = {
      status: errors.length ? 'FAIL' : 'PASS',
      checks,
      errors,
      out,
      sourceUnchanged: fs.readFileSync(file).equals(original),
    };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
})();
