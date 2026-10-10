'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs'),
  { Saves } = require('../src/core/saves.cjs'),
  { Activity } = require('../src/core/activity.cjs');
const { syntheticSave } = require('../tests/fixtures.cjs');
const base = path.resolve(__dirname, '..'),
  out = path.join(base, '.test-data', 'backup-rename-context-' + Date.now());
assert.equal(process.cwd(), base, 'Run the synthetic regression from its own candidate directory');
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
const extra = '77.sav';
fs.writeFileSync(path.join(source, extra), syntheticSave({ full: true, seconds: 7777 }));
sourceHashes[extra] = sha(fs.readFileSync(path.join(source, extra)));
const report = {
  startedAt: new Date().toISOString(),
  executable: process.env.YIJIAN_EXECUTABLE || 'source Electron',
  checks: [],
  errors: [],
  syntheticOnly: true,
};
let app, page;
async function launch() {
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
}
function assertSource(expected = sourceHashes) {
  assert.deepEqual(fs.readdirSync(source).sort(), Object.keys(expected).sort());
  for (const [name, hash] of Object.entries(expected))
    assert.equal(sha(fs.readFileSync(path.join(source, name))), hash, name);
}
async function openPreview() {
  await page.locator('.backup-row [data-action="backup-preview"][data-id="' + backup.id + '"]').click();
}
async function assertInvalid(message) {
  await page.waitForFunction(() => {
    const drawer = document.querySelector('.save-drawer'),
      restore = drawer?.querySelector('[data-action="restore"]');
    return (
      drawer?.dataset.backupPreviewState === 'invalid' ||
      (restore && !restore.disabled && document.querySelector('#toasts .toast.error'))
    );
  });
  const drawer = page.locator('.save-drawer');
  assert.doesNotMatch(await drawer.innerText(), /校验已通过|完全一致/);
  assert.equal(await drawer.locator('[data-action="restore"]').count(), 0);
  assert.match(await drawer.innerText(), message);
  assert.equal(await drawer.getAttribute('data-backup-preview-state'), 'invalid');
  assert.equal(await drawer.locator('[data-action="backup-preview"]').count(), 1);
  assertSource();
}
async function retryPreview() {
  await page.locator('.save-drawer [data-action="backup-preview"]').click();
  await page.locator('.save-drawer [data-action="restore"]').waitFor();
  assert.equal(await page.locator('.save-drawer').getAttribute('data-backup-preview-state'), 'verified');
}
async function nativeGate() {
  await app.evaluate(({ dialog }) => {
    global.restorePrompts = 0;
    global.finishRestorePrompt = null;
    dialog.showMessageBox = () => {
      global.restorePrompts++;
      return new Promise((resolve) => {
        global.finishRestorePrompt = resolve;
      });
    };
  });
  await page.locator('[data-action="restore"]').click();
  await page.locator('[data-backup-preview-state="restoring"]').waitFor();
  assert.equal(await page.locator('.save-drawer [data-action="restore"]').count(), 0);
  assert.doesNotMatch(await page.locator('.save-drawer').innerText(), /校验已通过|完全一致/);
  await app.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!global.finishRestorePrompt) {
      if (Date.now() > deadline) throw Error('Synthetic native confirmation did not open');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  assert.equal(await app.evaluate(() => global.restorePrompts), 1);
}
async function openRename() {
  if (!(await page.locator('.save-drawer').count()))
    await page.locator('[data-action="backup-preview"][data-id="' + backup.id + '"]').click();
  await page.locator('.save-drawer [data-action="backup-rename"]').waitFor();
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
    await launch();
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
    const original = fs.readFileSync(copiedFile),
      damaged = Buffer.from(original);
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
    assertSource();

    fs.writeFileSync(copiedFile, original);
    await openPreview();
    await page.locator('.save-drawer [data-action="restore"]').waitFor();
    fs.writeFileSync(copiedFile, damaged);
    await page.locator('[data-action="restore"]').click();
    await assertInvalid(/恢复未完成.*备份校验失败/);
    assert.equal(sha(fs.readFileSync(copiedFile)), damagedHash);
    assert.match(saves.list().find((b) => b.id === backup.id).verificationError, /校验失败/);
    const events = new Activity(userdata).get().events;
    assert(events.some((event) => event.level === 'error' && /校验失败/.test(event.message)));
    assert(!events.some((event) => event.level === 'success' && /已恢复/.test(event.message)));
    await page.screenshot({ path: path.join(out, 'restore-invalid.png'), animations: 'disabled' });
    await page.locator('.save-drawer [data-action="backup-preview"]').click();
    await assertInvalid(/无法校验这份副本.*备份校验失败/);
    assert.equal(sha(fs.readFileSync(copiedFile)), damagedHash);
    report.checks.push(
      'corruption after green preview revokes restore and old comparison; retry still rejects and preserves every target plus extra slot',
    );

    await app.close();
    app = null;
    await launch();
    assert.match(saves.list().find((b) => b.id === backup.id).verificationError, /校验失败/);
    assert(new Activity(userdata).get().events.some((event) => /校验失败/.test(event.message)));
    await openPreview();
    await assertInvalid(/无法校验这份副本.*备份校验失败/);
    report.checks.push(
      'known failure and preserved corrupt bytes survive cold restart; reopening cannot reuse green preview',
    );

    fs.writeFileSync(copiedFile, original);
    await retryPreview();
    assert.equal(saves.list().find((b) => b.id === backup.id).verificationError || '', '');
    await nativeGate();
    fs.writeFileSync(copiedFile, damaged);
    await app.evaluate(() => global.finishRestorePrompt({ response: 1 }));
    await assertInvalid(/恢复未完成.*备份校验失败/);
    assert.equal(saves.list().find((b) => b.id === backup.id).verificationError || '', '');
    assert.equal(sha(fs.readFileSync(copiedFile)), damagedHash);
    report.checks.push(
      'corruption during native confirmation invalidates preview even without a list verificationError; no target bytes change',
    );

    fs.writeFileSync(copiedFile, original);
    await retryPreview();
    const beforeCancel = new Activity(userdata).get().events;
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    await page.locator('[data-action="restore"]').click();
    await assertInvalid(/已取消恢复.*旧预览已失效/);
    assert.deepEqual(new Activity(userdata).get().events, beforeCancel);
    assert.equal(saves.list().filter((b) => b.kind === 'safety').length, 0);
    report.checks.push(
      'native cancellation revokes the snapshot without save writes, safety copies or false success receipts',
    );

    await retryPreview();
    await nativeGate();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.locator('#global-search').waitFor();
    await app.evaluate(() => global.finishRestorePrompt({ response: 0 }));
    await page.evaluate(() => window.journal.refresh());
    assert.equal(await page.locator('.save-drawer').count(), 0);
    assert.equal(await page.locator('#global-search').count(), 1);
    assertSource();
    report.checks.push('a deferred native cancellation leaves the newer search overlay open');
    await page.keyboard.press('Escape');

    fs.writeFileSync(path.join(source, '1.sav'), syntheticSave({ full: true, seconds: 9999 }));
    const beforeRestore = Object.fromEntries(
      fs.readdirSync(source).map((name) => [name, sha(fs.readFileSync(path.join(source, name)))]),
    );
    await openPreview();
    await page.locator('.save-drawer [data-action="restore"]').waitFor();
    assert.match(await page.locator('.save-drawer').innerText(), /将覆盖/);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await page.locator('[data-action="restore"]').click();
    await page.locator('.save-drawer').waitFor({ state: 'hidden' });
    assertSource();
    const safety = saves.list().find((b) => b.kind === 'safety');
    assert(safety, 'Successful restore must create a safety copy');
    const verifiedSafety = saves.verify(safety.id);
    assert.deepEqual(
      Object.fromEntries([...verifiedSafety.buffers].map(([name, buffer]) => [name, sha(buffer)])),
      beforeRestore,
    );
    const receipt = new Activity(userdata)
      .get()
      .events.find((event) => event.level === 'success' && /已恢复/.test(event.message));
    assert(receipt);
    assert(receipt.message.includes(safety.id));
    assert(receipt.message.includes(source));
    report.checks.push(
      'only fresh successful inspect restores eligibility; confirmed restore verifies current-progress safety bytes and preserves extra slot',
    );
    report.safetyId = safety.id;
    await app.close();
    app = null;
    await launch();
    assert(
      new Activity(userdata)
        .get()
        .events.some((event) => event.at === receipt.at && event.message === receipt.message),
    );
    assert.match(await page.locator('#app').innerText(), new RegExp(safety.id));
    assertSource();
    assert.deepEqual(
      Object.fromEntries([...saves.verify(safety.id).buffers].map(([name, buffer]) => [name, sha(buffer)])),
      beforeRestore,
    );
    report.checks.push(
      'successful restore receipt, original target bytes and verified safety copy survive cold restart',
    );
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
