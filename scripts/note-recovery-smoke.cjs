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
const original = '\n合成随手记原文\n\n第二行 <script>literal</script>\n  尾部  ';
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
  const temp = path.join(data, 'temp');
  fs.mkdirSync(temp, { recursive: true });
  const env = { ...process.env, YIJIAN_TEST_DATA: userData, TEMP: temp, TMP: temp };
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((win) => win.showInactive()),
  );
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
async function savedUndo(editor, value) {
  const acknowledged = () =>
    editor.waitForFunction(() =>
      ['已保存到本机', '只存在这台电脑 · 自动保存'].includes(
        document.querySelector('#note-status')?.textContent,
      ),
    );
  await editor.locator('#note').focus();
  await editor.keyboard.press('Control+End');
  await editor.evaluate(() => {
    window.noteUndoProbe = document.querySelector('#note');
  });
  await editor.keyboard.type('Z');
  await waitNote(value + 'Z');
  await acknowledged();
  assert.equal(await editor.evaluate(() => window.noteUndoProbe === document.querySelector('#note')), true);
  await editor.keyboard.press('Control+z');
  await waitNote(value);
  await acknowledged();
  await editor.keyboard.press('Control+Shift+z');
  await waitNote(value + 'Z');
  await acknowledged();
  const update = await page.evaluate(() =>
    window.journal.mutate({ type: 'goal-add', title: '撤销验证的独立安排' }),
  );
  assert(update.ok, update.error);
  await editor.waitForFunction(() => document.querySelector('#note') === window.noteUndoProbe);
  await editor.keyboard.press('Control+z');
  await waitNote(value);
  await acknowledged();
}
async function waitHistory(...bodies) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const p = await current();
    if (bodies.every((body) => p.noteRevisions?.some((row) => row.body === body))) return p;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Rapid clear full text must remain recoverable, including unsaved input');
}
async function rapidClear() {
  const suffix = ' · 刚新增去碗子山路线';
  await page.locator('#note').focus();
  await page.keyboard.press('Control+End');
  await page.evaluate(() => {
    globalThis.noteClearInputs = [];
    document.querySelector('#note').addEventListener('input', (event) => {
      globalThis.noteClearInputs.push({ at: performance.now(), value: event.target.value });
    });
  });
  await page.keyboard.type(suffix);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  const inputs = await page.evaluate(() => globalThis.noteClearInputs);
  const previous = inputs.at(-2),
    cleared = inputs.at(-1);
  assert.equal(previous.value, original + suffix);
  assert.equal(cleared.value, '');
  assert(cleared.at - previous.at < 700, 'Clear must precede the normal autosave debounce');
  await waitNote('');
  await waitHistory(original + suffix, original);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#note').inputValue(), original + suffix);
  await waitNote(original + suffix);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await page.locator('#note').inputValue(), '');
  await waitNote('');
  await quit();
  await launch();
  const p = await waitHistory(original + suffix);
  assert.equal(p.notes, '');
  await page.locator('[data-action="note-history"]').click();
  const row = page.locator(
    '[data-note-revision="' + p.noteRevisions.find((row) => row.body === original + suffix).id + '"]',
  );
  await row.locator('summary').click();
  await row.locator('[data-action="note-restore-preview"]').click();
  assert.equal(await page.locator('[data-note-restore-preview] > p').textContent(), original + suffix);
  await page.locator('[data-action="note-restore-confirm"]').click();
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#note').inputValue(), original + suffix);
  checks.push('真实键盘在700ms自动保存前清空新增全文，原生撤销/重做有效，冷启动后可预览和恢复完整未落盘文字');
  await page.locator('#note').fill(original);
  await waitNote(original);
}
async function pendingClearChecks(companion) {
  const first = '  第一轮尚未自动保存\n<script>literal</script>  ';
  const second = '\n第二轮尚未自动保存\n';
  const remote = '另一窗口已保存的新正文';
  await app.evaluate(({ ipcMain }) => {
    const channel = 'journal:mutate',
      original = ipcMain._invokeHandlers.get(channel);
    globalThis.noteClearGate = { original, held: false, release: null, commands: [] };
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, command) => {
      if (command.type === 'note') {
        globalThis.noteClearGate.commands.push(structuredClone(command));
        if (!globalThis.noteClearGate.held) {
          globalThis.noteClearGate.held = true;
          await new Promise((resolve) => {
            globalThis.noteClearGate.release = resolve;
          });
        }
      }
      return original(event, command);
    });
  });
  try {
    await page.locator('#note').fill(first);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.evaluate(() => !!globalThis.noteClearGate.release)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(await app.evaluate(() => !!globalThis.noteClearGate.release));
    await companion.locator('#note').fill(remote);
    await waitNote(remote);
    await page.locator('#note').fill(second);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.locator('#note').fill('最后继续输入的正文');
    await app.evaluate(() => globalThis.noteClearGate.release());
    await waitNote('最后继续输入的正文');
    const p = await waitHistory(first, second, remote);
    assert(
      p.noteRevisions.findIndex((row) => row.body === second) <
        p.noteRevisions.findIndex((row) => row.body === first),
    );
    checks.push(
      '第一轮清空回执延后时再次输入/清空并续写，旧回执不消费新草稿；双窗口较新正文与两份清空全文均保留',
    );
  } finally {
    await app.evaluate(({ ipcMain }) => {
      globalThis.noteClearGate.release?.();
      ipcMain.removeHandler('journal:mutate');
      ipcMain.handle('journal:mutate', globalThis.noteClearGate.original);
    });
  }
  await page.locator('#note').fill(original);
  await waitNote(original);
  const before = fs.readFileSync(path.join(userData, 'journal.json'));
  await app.evaluate((_electron, directory) => {
    const filesystem = process.getBuiltinModule('node:fs');
    const journal = process.getBuiltinModule('node:path').join(directory, 'journal.json');
    globalThis.noteClearRename = filesystem.renameSync;
    filesystem.renameSync = function (from, to) {
      if (to === journal) throw Error('synthetic note clear replacement refused');
      return globalThis.noteClearRename.call(this, from, to);
    };
  }, userData);
  try {
    for (const body of [first + ' failed', second + ' failed']) {
      await page.locator('#note').fill(body);
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await page
        .locator('#note-status')
        .getByText(/保存失败/)
        .waitFor();
      assert.deepEqual(fs.readFileSync(path.join(userData, 'journal.json')), before);
    }
  } finally {
    await app.evaluate(() => {
      process.getBuiltinModule('node:fs').renameSync = globalThis.noteClearRename;
    });
  }
  await page.locator('[data-action="note-history"]').click();
  const p = await waitHistory(first + ' failed', second + ' failed');
  assert.equal(p.notes, '');
  assert.equal(await page.locator('#note').inputValue(), '');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('两次原子写入故意失败时磁盘原件不变，重试找回旧内容后两份未保存全文与空正文一起持久保存');
  await page.locator('#note').fill(original);
  await waitNote(original);
}
(async () => {
  try {
    await launch();
    assert.equal(await page.locator('#note').inputValue(), original);
    await rapidClear();
    await savedUndo(page, original);
    checks.push('主窗自动保存及其他安排刷新后，原生撤销和重做仍有效，撤销后的文字继续持久保存');
    const created = app.waitForEvent('window');
    await page.locator('.topbar [data-action="compact"]').click();
    const companion = await created;
    companion.on('pageerror', (error) => errors.push(error.message));
    await companion.locator('.compact-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((win) => win.showInactive()),
    );
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill('种类:笔记 合成随手记原文');
    await companion.locator('.search-result[data-action="search-note"]').click();
    await companion.locator('#note').waitFor();
    await savedUndo(companion, original);
    assert.equal(await page.locator('#note').inputValue(), original);
    checks.push('小窗自动保存后仍能原生撤销和重做，跨窗口刷新保留编辑器且主窗得到同一已保存正文');
    await pendingClearChecks(companion);
    await page.locator('#note').fill('');
    await waitNote('');
    await companion.waitForFunction(() => document.querySelector('#note')?.value === '');
    checks.push('另一窗口明确改写随手记时同步新正文，不用旧焦点文字覆盖已保存内容');
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
