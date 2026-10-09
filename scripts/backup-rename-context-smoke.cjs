'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { Saves } = require('../src/core/saves.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'backup-rename-context-' + Date.now());
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
const userdata = path.join(out, 'userdata'),
  source = path.join(out, 'synthetic-SaveGames'),
  temp = path.join(out, 'temp');
fs.mkdirSync(source);
fs.mkdirSync(temp);
const store = new Store(userdata, require('../src/data/catalog.cjs'));
store.setPath('savePath', source);
store.mutate({ type: 'settings', value: { autoBackup: false } });
for (let i = 0; i < 29; i++)
  fs.writeFileSync(path.join(source, i + '.sav'), syntheticSave({ full: true, seconds: 500 + i }));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sourceHashes = Object.fromEntries(
  fs.readdirSync(source).map((name) => [name, sha(fs.readFileSync(path.join(source, name)))]),
);
const saves = new Saves(path.join(userdata, 'save-backups')),
  backup = saves.capture(source, '合成副本：取消改名后继续核对');
const report = {
  startedAt: new Date().toISOString(),
  executable: process.env.YIJIAN_EXECUTABLE || 'source Electron',
  checks: [],
  errors: [],
  syntheticOnly: true,
};
let app, page;
async function openRename() {
  if (!(await page.locator('.save-drawer').count()))
    await page.locator('[data-action="backup-preview"][data-id="' + backup.id + '"]').click();
  const scroll = await page.locator('.save-drawer .drawer-body').evaluate((n) => {
    n.scrollTop = 400;
    return n.scrollTop;
  });
  assert(scroll > 100);
  await page.locator('[data-action="backup-rename"]').scrollIntoViewIfNeeded();
  const readingPosition = await page.locator('.save-drawer .drawer-body').evaluate((n) => n.scrollTop);
  await page.locator('[data-action="backup-rename"]').click();
  await page.locator('#rename-backup').fill('尚未保存的新名称');
  return readingPosition;
}
async function assertContext(scroll, label) {
  await page.locator('.save-drawer').waitFor();
  assert.equal(await page.locator('.save-drawer h1').textContent(), label);
  assert.equal(await page.locator('.save-drawer .drawer-body').evaluate((n) => n.scrollTop), scroll);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'backup-rename');
  assert.equal(saves.list().find((b) => b.id === backup.id).label, label);
}
(async () => {
  try {
    const env = { ...process.env, YIJIAN_TEST_DATA: userdata, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
      args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
      env,
      cwd: base,
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => report.errors.push(e.message));
    await page.context().setOffline(true);
    await page.locator('.layout').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.showInactive()));
    await page.locator('.nav-btn[data-id="saves"]').click();
    for (const mode of ['cancel', 'close', 'escape', 'backdrop']) {
      const scroll = await openRename();
      if (mode === 'escape') await page.keyboard.press('Escape');
      else if (mode === 'backdrop') await page.locator('[data-backdrop]').click({ position: { x: 2, y: 2 } });
      else
        await page
          .locator('.modal [data-action="close-overlay"]')
          .nth(mode === 'close' ? 0 : 1)
          .click();
      await assertContext(scroll, backup.label);
      report.checks.push(mode + ': preview, scroll, focus and unchanged label');
    }
    await page.screenshot({ path: path.join(out, 'cancel-return.png'), animations: 'disabled' });
    const scroll = await openRename(),
      label = '另一窗口已保存的合成新名称';
    const renamed = await page.evaluate(({ id, label }) => window.journal.renameBackup(id, label), {
      id: backup.id,
      label,
    });
    assert(renamed.ok, renamed.error);
    await page.keyboard.press('Escape');
    await assertContext(scroll, label);
    report.checks.push('return re-inspects the current verified backup instead of restoring a stale label');
    await openRename();
    await page.evaluate(() => {
      document.querySelector('.modal-footer [data-action="close-overlay"]').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const barrier = await page.evaluate((id) => window.journal.inspectBackup(id), backup.id);
    assert(barrier.ok, barrier.error);
    await page.locator('#global-search').waitFor();
    assert.equal(await page.locator('.save-drawer').count(), 0);
    report.checks.push('a pending preview result does not replace a newer search dialog');
    await page.keyboard.press('Escape');
    await openRename();
    const copiedFile = path.join(saves.directory(backup.id), 'files', '1.sav');
    const damaged = Buffer.from(fs.readFileSync(copiedFile));
    damaged[damaged.length - 1] ^= 1;
    fs.writeFileSync(copiedFile, damaged);
    const damagedHash = sha(damaged);
    await page.keyboard.press('Escape');
    await page
      .locator('#toasts')
      .getByText(/无法重新打开备份预览.*备份校验失败/)
      .waitFor();
    assert.equal(await page.locator('.save-drawer').count(), 0);
    assert.equal(sha(fs.readFileSync(copiedFile)), damagedHash);
    report.checks.push('a corrupt backup stays preserved and cannot return as a verified preview');
    for (const [name, hash] of Object.entries(sourceHashes))
      assert.equal(sha(fs.readFileSync(path.join(source, name))), hash, name);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('Backup rename context PASS', report.checks.length, 'checks', out);
  } catch (error) {
    report.failure = String(error.stack || error);
    throw error;
  } finally {
    if (app) await app.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results', 'backup-rename-context-result.json'),
      JSON.stringify({ ...report, evidence: out }, null, 2),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
