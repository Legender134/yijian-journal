'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { _electron } = require('playwright');
const base = path.resolve(__dirname, '..');
const data = path.join(base, '.test-data', 'journal-drafts-ui-' + Date.now());
const userData = path.join(data, 'userdata');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(path.join(base, 'test-results'), { recursive: true });
let app, page;
const checks = [],
  errors = [];
async function launch() {
  const env = { ...process.env, YIJIAN_TEST_DATA: userData, YIJIAN_TEST_TRAY: '1' };
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
async function profile() {
  const result = await page.evaluate(() => window.journal.bootstrap());
  assert(result.ok, result.error);
  return result.data.state.profiles.find((p) => p.id === result.data.state.activeProfileId);
}
async function saved(title, body) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const draft = (await profile()).journalDrafts?.find((row) => row.title === title && row.body === body);
    if (draft) return draft;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw Error('draft did not persist: ' + title);
}
async function journal() {
  await page.locator('.nav-btn[data-id="journal"]').click();
}
async function write(title, body) {
  await page.locator('[data-action="journal-entry-new"]').click();
  await page.locator('#journal-title').fill(title);
  await page.locator('#journal-body').fill(body);
}
async function resume(id) {
  await page.locator('[data-action="journal-draft-resume"][data-id="' + id + '"]').click();
}
async function quit() {
  await Promise.all([page.waitForEvent('close'), page.evaluate(() => window.journal.window('quit'))]);
  await app.close().catch(() => {});
  app = null;
}
(async () => {
  try {
    await launch();
    await journal();
    await write('搜索途中未完成的记录', '\n\n先记录了正文，稍后还要查资料。\n  原样空白  ');
    await page.locator('#journal-time').fill('');
    await page.locator('#journal-tags').fill('朋友，朋友，，还没写完');
    await page.locator('[data-action="close-overlay"]').click();
    const closed = await saved('搜索途中未完成的记录', '\n\n先记录了正文，稍后还要查资料。\n  原样空白  ');
    await page.waitForFunction((id) => {
      const row = document.querySelector('[data-journal-draft-id="' + id + '"]');
      return row?.textContent.includes('已暂存在本机') && !row.textContent.includes('尚未成功保存');
    }, closed.id);
    checks.push('马上暂存并关闭后，保存成功回执直接更新草稿列表，无需切换页面');
    await resume(closed.id);
    await page.keyboard.press('Control+k');
    await page.locator('#global-search').waitFor();
    await page.keyboard.press('Escape');
    const first = await saved('搜索途中未完成的记录', '\n\n先记录了正文，稍后还要查资料。\n  原样空白  ');
    assert.equal(first.localTime, '');
    assert.equal(first.tags, '朋友，朋友，，还没写完');
    await journal();
    await resume(first.id);
    assert.equal(await page.locator('#journal-body').inputValue(), first.body);
    assert.equal(await page.locator('#journal-time').inputValue(), '');
    assert.equal(await page.locator('#journal-tags').inputValue(), first.tags);
    assert.equal((await profile()).journalEntries.length, 0);
    checks.push('Ctrl+K 查资料保留不完整的标题正文、空时间和未完成标签，正式记录不增生');
    await page.locator('#journal-title').fill('关闭窗口前的最新编辑');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForFunction(() => !document.querySelector('#journal-entry-form'));
    await page.evaluate(() => window.journal.window('main'));
    const second = await saved('关闭窗口前的最新编辑', first.body);
    assert.equal(second.id, first.id);
    await journal();
    await resume(second.id);
    assert.equal(await page.locator('#journal-title').inputValue(), second.title);
    checks.push('系统关闭到托盘先暂存，重开主窗口可继续同一份草稿');
    await page.locator('#journal-body').fill('\n\n退出前刚刚输入，没有等待自动保存。\n  原样空白  ');
    await quit();
    await launch();
    await page.locator('[data-action="journal-drafts"]').first().click();
    const restarted = (await profile()).journalDrafts.find((draft) => draft.id === first.id);
    assert.equal(restarted.body, '\n\n退出前刚刚输入，没有等待自动保存。\n  原样空白  ');
    await resume(first.id);
    assert.equal(await page.locator('#journal-body').inputValue(), restarted.body);
    await page.locator('#journal-time').fill('2026-10-09T10:30');
    await page.locator('#journal-tags').fill('探索，朋友');
    await page.locator('[data-action="journal-entry-save"]').click();
    await page.waitForFunction(() => !document.querySelector('#journal-entry-form'));
    assert.equal((await profile()).journalDrafts.length, 0);
    assert.equal((await profile()).journalEntries.length, 1);
    assert.equal((await profile()).journalEntries[0].body, restarted.body);
    checks.push('明确退出与重启恢复最后编辑，正式保存一次且只消耗自己的草稿');
    const original = (await profile()).journalEntries[0];
    await page
      .locator('[data-action="journal-entry-open"][data-id="' + original.id + '"]')
      .first()
      .click();
    await page.locator('[data-action="journal-entry-edit"]').click();
    await page.locator('#journal-body').fill('不能覆盖另一个窗口的新记录');
    const edit = await saved(original.title, '不能覆盖另一个窗口的新记录');
    await app.evaluate((_electron, stamp) => {
      globalThis.draftOriginalDate = Date;
      globalThis.Date = class extends globalThis.draftOriginalDate {
        constructor(...args) {
          super(...(args.length ? args : [stamp]));
        }
      };
    }, original.updatedAt);
    let changed;
    try {
      changed = await page.evaluate(
        ({ id, expectedEntry }) =>
          window.journal.mutate({
            expectedEntry,
            type: 'journal-entry-update',
            id,
            title: '其他窗口修改',
            body: '应当保留的正式正文',
            occurredAt: '2026-10-09T02:30:00.000Z',
            tags: [],
            links: [],
            snapshotMode: 'none',
          }),
        { id: original.id, expectedEntry: original },
      );
    } finally {
      await app.evaluate(() => {
        globalThis.Date = globalThis.draftOriginalDate;
        delete globalThis.draftOriginalDate;
      });
    }
    assert(changed.ok, changed.error);
    assert.ok(Date.parse((await profile()).journalEntries[0].updatedAt) > Date.parse(original.updatedAt));
    await page.locator('[data-action="journal-entry-save"]').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('原记录已被修改')),
    );
    assert.equal((await profile()).journalEntries[0].body, '应当保留的正式正文');
    assert.equal(
      (await profile()).journalDrafts.find((draft) => draft.id === edit.id).body,
      '不能覆盖另一个窗口的新记录',
    );
    await page.locator('[data-action="journal-draft-copy"]').click();
    await page.locator('#journal-draft-status').waitFor();
    const copyId = await page.locator('#journal-entry-form').getAttribute('data-draft-id');
    assert.notEqual(copyId, edit.id);
    await page.locator('[data-action="journal-entry-save"]').click();
    await page.waitForFunction(() => !document.querySelector('#journal-entry-form'));
    assert.equal((await profile()).journalEntries.length, 2);
    assert.equal(
      (await profile()).journalEntries.find((entry) => entry.id === original.id).body,
      '应当保留的正式正文',
    );
    checks.push('同一毫秒的独立修改仍拒绝旧草稿覆盖；明确另存新记录保留原件和原草稿');
    await page.evaluate(() => window.journal.compact());
    const companion =
      app.windows().find((window) => window.url().includes('compact')) || (await app.waitForEvent('window'));
    companion.on('pageerror', (error) => errors.push(error.message));
    await companion.locator('.compact-shell').waitFor();
    await companion.keyboard.press('Control+k');
    await companion.locator('#global-search').fill('其他窗口修改');
    await companion.locator('[data-action="journal-entry-open"][data-id="' + original.id + '"]').click();
    await companion.locator('[data-action="close-overlay"]').click();
    await write('主窗口独立草稿', '主窗口内容');
    await companion.locator('[data-action="journal-entry-new"]').click();
    await companion.locator('#journal-title').fill('随行窗独立草稿');
    await companion.locator('#journal-body').fill('随行窗内容');
    const mainDraft = await saved('主窗口独立草稿', '主窗口内容');
    const companionDraft = await saved('随行窗独立草稿', '随行窗内容');
    assert.notEqual(mainDraft.id, companionDraft.id);
    await page.locator('[data-action="close-overlay"]').click();
    await companion.locator('[data-action="close-overlay"]').click();
    await resume(mainDraft.id);
    await companion.locator('[data-action="journal-draft-resume"][data-id="' + mainDraft.id + '"]').click();
    await page.locator('#journal-body').fill('主窗口已确认的新编辑');
    await saved('主窗口独立草稿', '主窗口已确认的新编辑');
    await companion.locator('#journal-body').fill('另一个窗口未覆盖的编辑');
    await companion.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('另一个窗口变化')),
    );
    assert.equal(
      (await profile()).journalDrafts.find((draft) => draft.id === mainDraft.id).body,
      '主窗口已确认的新编辑',
    );
    await companion.locator('[data-action="journal-draft-copy"]').click();
    const resolvedCopy = await saved('主窗口独立草稿', '另一个窗口未覆盖的编辑');
    assert.notEqual(resolvedCopy.id, mainDraft.id);
    await companion.locator('[data-action="close-overlay"]').click();
    await page.locator('[data-action="close-overlay"]').click();
    checks.push('两个真实窗口独立草稿互不覆盖，同一草稿版本冲突保留各自正文并可明确另存');
    await app.evaluate(
      (_electron, { file }) => {
        const filesystem = process.getBuiltinModule('node:fs');
        globalThis.draftOriginalRename = filesystem.renameSync;
        filesystem.renameSync = (source, target) => {
          if (target === file)
            throw Object.assign(Error('synthetic draft disk unavailable'), { code: 'EIO' });
          return globalThis.draftOriginalRename(source, target);
        };
      },
      { file: path.join(userData, 'journal.json') },
    );
    await write('暂存失败也不能丢字', '磁盘错误时必须留在窗口并可找回。');
    await page.evaluate(() => window.journal.window('quit'));
    await page.getByRole('heading', { name: '仍有记录草稿未保存' }).waitFor();
    assert.equal(await page.evaluate(() => window.journal.health().then((r) => r.data.quitting)), false);
    await page.locator('[data-action="journal-drafts"]').last().click();
    const failed = await page
      .locator('[data-journal-draft-id]')
      .filter({ hasText: '暂存失败也不能丢字' })
      .getAttribute('data-journal-draft-id');
    await resume(failed);
    assert.equal(await page.locator('#journal-body').inputValue(), '磁盘错误时必须留在窗口并可找回。');
    await app.evaluate(() => {
      process.getBuiltinModule('node:fs').renameSync = globalThis.draftOriginalRename;
      delete globalThis.draftOriginalRename;
    });
    await page.locator('#journal-body').fill('磁盘恢复后继续写，原文字仍在。');
    await saved('暂存失败也不能丢字', '磁盘恢复后继续写，原文字仍在。');
    await page.locator('[data-action="close-overlay"]').click();
    checks.push('实际写盘 EIO 拒绝退出，替换成提示框后正文仍可找回，恢复写盘后可继续暂存');
    assert.deepEqual(errors, []);
  } catch (error) {
    errors.push(error.stack);
    process.exitCode = 1;
    console.error(error);
  } finally {
    if (app) {
      await app
        .evaluate(() => {
          if (globalThis.draftOriginalRename)
            process.getBuiltinModule('node:fs').renameSync = globalThis.draftOriginalRename;
          if (globalThis.draftOriginalDate) globalThis.Date = globalThis.draftOriginalDate;
        })
        .catch(() => {});
      await app.close().catch(() => {});
    }
    const report = { status: errors.length ? 'FAIL' : 'PASS', checks, errors, data };
    fs.writeFileSync(path.join(data, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(base, 'test-results', 'journal-drafts-ui-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
})();
