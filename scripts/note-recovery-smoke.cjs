'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
const base = path.resolve(__dirname, '..');
const data = path.join(base, '.test-data', 'note-recovery-ui-' + Date.now());
const userData = path.join(data, 'userdata');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
const store = new Store(userData, catalog);
store.mutate({ type: 'save-slot', mode: 'none', value: '' });
const original = '合成随手记原文\n\n第二行 <script>literal</script>\n  尾部  ';
store.mutate({ type: 'note', value: original });
let app, page;
const checks = [],
  errors = [];
async function current() {
  const result = await page.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.state.profiles.find((p) => p.id === result.data.state.activeProfileId);
}
async function waitNote(value) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await current()).notes === value) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Note did not reach the expected saved value');
}
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: process.env.YIJIAN_EXECUTABLE || require('electron'),
    args: process.env.YIJIAN_EXECUTABLE ? [] : [base],
    cwd: base,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.layout').waitFor();
}
async function quit() {
  await Promise.all([page.waitForEvent('close'), page.evaluate(() => window.journal.window('quit'))]);
  await app.close().catch(() => {});
  app = null;
}
async function preview(id) {
  if (!(await page.locator('[data-note-history]').count()))
    await page.locator('[data-action="note-history"]').click();
  const row = page.locator('[data-note-revision="' + id + '"]');
  if (!(await row.evaluate((node) => node.open))) await row.locator('summary').click();
  await row.locator('[data-action="note-restore-preview"]').click();
  assert.equal(await page.locator('[data-note-restore-preview] > p').textContent(), original);
}
(async () => {
  try {
    await launch();
    assert.equal(await page.locator('#note').inputValue(), original);
    await page.locator('#note').fill('');
    await waitNote('');
    const old = (await current()).noteRevisions.find((row) => row.body === original);
    assert(old);
    await page.locator('.nav-btn[data-id="journal"]').click();
    await preview(old.id);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await current()).notes, '');
    checks.push('清空自动保存后换页仍能预览完整旧内容，取消不改正文');
    await quit();
    await launch();
    assert.equal(await page.locator('#note').inputValue(), '');
    await preview(old.id);
    await page.screenshot({ path: path.join(data, 'note-restore-preview.png'), animations: 'disabled' });
    await page.locator('[data-action="note-restore-confirm"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#note').inputValue(), original);
    checks.push('真实退出重启后可从空白随手记找回原文，保留换行和文字转义');
    await page.locator('#note').fill('后来的合成文字');
    await waitNote('后来的合成文字');
    await preview(old.id);
    const changed = await page.evaluate(() =>
      window.journal.mutate({ type: 'note', value: '预览后新保存的合成文字' }),
    );
    assert(changed.ok, changed.error);
    await page.locator('[data-action="note-restore-confirm"]').click();
    await page
      .locator('#toasts')
      .getByText(/随手记或旧内容已变化/)
      .waitFor();
    assert.equal((await current()).notes, '预览后新保存的合成文字');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await preview(old.id);
    await page.locator('[data-action="note-restore-confirm"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.equal((await current()).notes, original);
    assert((await current()).noteRevisions.some((row) => row.body === '预览后新保存的合成文字'));
    checks.push('预览后的新文字拒绝被旧确认覆盖；重新预览恢复时先保留当前文字');
    await page.screenshot({ path: path.join(data, 'note-restored.png'), animations: 'disabled' });
    const long = 'x'.repeat(20000);
    await page.locator('#note').fill(long);
    await waitNote(long);
    await page.locator('#note').fill('');
    await waitNote('');
    const longRow = (await current()).noteRevisions.find((row) => row.body === long);
    assert(longRow);
    const win = await app.browserWindow(page);
    await win.evaluate((win) => win.setSize(900, 650));
    await win.dispose();
    await page.locator('[data-action="note-history"]').click();
    const full = page.locator('[data-note-revision="' + longRow.id + '"]');
    await full.locator('summary').click();
    for (const cancel of ['button', 'close', 'escape', 'backdrop']) {
      const restore = full.locator('[data-action="note-restore-preview"]');
      await restore.scrollIntoViewIfNeeded();
      const scroll = await page.locator('.modal').evaluate((node) => node.scrollTop);
      assert(scroll > 100, 'Long note history must actually scroll');
      await restore.click();
      await page.locator('[data-note-restore-preview]').waitFor();
      if (cancel === 'button') await page.getByRole('button', { name: '取消', exact: true }).click();
      if (cancel === 'close') await page.getByRole('button', { name: '关闭', exact: true }).click();
      if (cancel === 'escape') await page.keyboard.press('Escape');
      if (cancel === 'backdrop') await page.locator('.overlay-backdrop').click({ position: { x: 2, y: 2 } });
      await page.locator('[data-note-history]').waitFor();
      assert.equal(await full.evaluate((node) => node.open), true);
      assert(Math.abs((await page.locator('.modal').evaluate((node) => node.scrollTop)) - scroll) < 3);
      assert.equal(await restore.evaluate((node) => node === document.activeElement), true);
      assert.equal((await current()).notes, '');
    }
    checks.push('四种取消方式均回到刚才展开的旧内容，保留阅读位置和键盘焦点且不改正文');
    await full.locator('[data-action="note-restore-preview"]').click();
    const geometry = await page.locator('[data-note-restore-preview]').evaluate((el) => ({
      scroll: document.documentElement.scrollWidth,
      viewport: innerWidth,
      paragraph: el.querySelector('p').textContent.length,
    }));
    assert.equal(geometry.paragraph, 20000);
    assert(geometry.scroll <= geometry.viewport + 1);
    await page.locator('[data-action="note-restore-confirm"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#note').inputValue(), long);
    checks.push('两万字无空格旧内容在较小窗口内可预览和确认，恢复全文且不产生横向溢出');
    assert.deepEqual(errors, []);
    await quit();
    console.log(checks.map((s) => 'PASS ' + s).join('\n'));
  } catch (error) {
    errors.push(error.stack || error.message);
    process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {});
    console.error(error.stack);
  } finally {
    if (app) await app.close().catch(() => {});
    const result = {
      status: errors.length ? 'FAIL' : 'PASS',
      checks,
      errors,
      data,
      executionMode: process.env.YIJIAN_EXECUTABLE ? 'packaged' : 'source',
      executable: process.env.YIJIAN_EXECUTABLE || null,
    };
    fs.writeFileSync(path.join(data, 'report.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results', 'note-recovery-ui-result.json'),
      JSON.stringify(result, null, 2),
    );
  }
})();
